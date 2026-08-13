// Requirement gate: does this change actually do what the linked work item asked for?
//
// Runs before and independently of the code axis. Failures here are non-fatal by design —
// plenty of PRs legitimately have no linked work item, and a review that refuses to run
// because Boards hygiene is imperfect gets switched off.
import { createHash } from "node:crypto";
import { MAX_EXTRAS, MAX_INLINE_REQ_COMMENTS, REQ_MODEL, SKEPTIC_MODELS } from "../config";
import { getLinkedRequirements } from "../ado/workitems";
import { anchorFinding } from "../anchoring/locate";
import { extractCriteria, type CriterionRef } from "../libs/criteria";
import { normalizePath, type FileIndex } from "../libs/fileindex";
import { parseJsonObject } from "../libs/json";
import { buildDiffPayload } from "../libs/payload";
import { log } from "../libs/log";
import { parseVerdict, type Verdict } from "./skeptic";
import { VERDICT_SCHEMA } from "../models/schemas";
import { REQ_SKEPTIC_SYSTEM, buildReqSkepticPrompt } from "../prompts/skeptic";
import type {
  AnchoredFinding,
  CriterionCheck,
  ExtraChange,
  FileDiff,
  ModelRunner,
  PrInfo,
  PrRef,
  RawFinding,
  ReqVerdict,
  RequirementResult,
} from "../libs/types";
import { REQ_VERDICTS } from "../libs/types";
import { REQUIREMENT_SCHEMA } from "../models/schemas";
import { REQUIREMENT_SYSTEM, buildRequirementPrompt } from "../prompts/requirement";

const VALID_VERDICT = new Set<string>(REQ_VERDICTS);

/**
 * Binds the model's verdicts back onto the pipeline's own criterion list. Exported for
 * the selftest.
 *
 * Three properties fix the axis's dominant flakiness (a moving denominator):
 * - Verdicts attach by id; the criterion TEXT always comes from the work item, never from
 *   the model — an invented criterion has no id and is dropped (counted, never judged).
 * - Output is in ref order, one entry per ref: the denominator is identical every run.
 * - A criterion the model skipped is surfaced as not-verifiable ("not judged"), because a
 *   silently vanished criterion reads as a clean pass.
 */
export function resolveJudgments(
  rawItems: unknown[],
  refs: CriterionRef[],
): { criteria: CriterionCheck[]; unknownIds: number; unjudged: number } {
  const byId = new Map(refs.map((r) => [r.id, r]));
  const judged = new Map<string, CriterionCheck>();
  let unknownIds = 0;
  for (const v of rawItems) {
    if (typeof v !== "object" || v === null) continue;
    const o = v as Record<string, unknown>;
    // Tolerate the bracketed/prefixed spellings weak models produce: "[4711-AC2]", "#4711-AC2".
    const id =
      typeof o["criterionId"] === "string" ? o["criterionId"].trim().replace(/^[#[\s]+|[\]\s]+$/g, "") : "";
    const ref = byId.get(id);
    if (!ref) {
      unknownIds++;
      continue;
    }
    const raw = typeof o["verdict"] === "string" ? o["verdict"].toLowerCase() : "";
    // An unrecognised verdict must not silently become "satisfied".
    const verdict: ReqVerdict = VALID_VERDICT.has(raw) ? (raw as ReqVerdict) : "not-verifiable";
    const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
    judged.set(ref.id, {
      workItemId: ref.workItemId,
      criterion: ref.text,
      verdict,
      note: str("note") ?? "",
      quote: str("quote"),
      file: str("file"),
    });
  }
  let unjudged = 0;
  const criteria = refs.map((r) => {
    const j = judged.get(r.id);
    if (j) return j;
    unjudged++;
    return {
      workItemId: r.workItemId,
      criterion: r.text,
      verdict: "not-verifiable" as ReqVerdict,
      note: "not judged: the model returned no verdict for this criterion",
    };
  });
  return { criteria, unknownIds, unjudged };
}

function validateExtra(v: unknown): ExtraChange | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const claim = typeof o["claim"] === "string" ? o["claim"].trim() : "";
  const file = typeof o["file"] === "string" ? o["file"].trim() : "";
  if (!claim || !file) return undefined;
  return { claim, file, quote: typeof o["quote"] === "string" ? o["quote"] : undefined };
}

export interface RequirementGateInput {
  ref: PrRef;
  pr: PrInfo;
  files: FileDiff[];
  runner: ModelRunner;
}

export async function runRequirementGate(
  input: RequirementGateInput,
): Promise<{ result: RequirementResult; prompt?: string; raw?: string }> {
  let linked;
  try {
    linked = await getLinkedRequirements(input.ref);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`[WARN] Failed to fetch work items: ${msg}`);
    return { result: { workItems: [], criteria: [], extras: [], error: msg } };
  }

  if (linked.items.length === 0) {
    log("PR has no linked work item; skipping the requirement axis");
    return {
      result: { workItems: [], criteria: [], extras: [], skipped: "PR has no linked work item" },
    };
  }

  const withSpec = linked.items.filter((w) => w.acceptanceCriteria || w.description);
  if (withSpec.length === 0) {
    log("Linked work items have no acceptance criteria or description; skipping the requirement axis");
    return {
      result: {
        workItems: linked.items,
        criteria: [],
        extras: [],
        skipped: "Linked work items have no acceptance criteria or description to check against",
      },
    };
  }

  log(`requirement axis: checking ${withSpec.length} work items (${withSpec.map((w) => `#${w.id}`).join(", ")})`);

  // The unit of judgment is fixed HERE, before any model runs: same work items → same
  // criterion list → same denominator every run (see libs/criteria.ts for why).
  const refs = withSpec.flatMap(extractCriteria);
  const prompt = buildRequirementPrompt({
    pr: input.pr,
    workItems: withSpec,
    files: input.files,
    criteria: refs,
    maxExtras: MAX_EXTRAS,
  });
  const res = await input.runner.chat({
    model: REQ_MODEL,
    system: REQUIREMENT_SYSTEM,
    user: prompt,
    schema: REQUIREMENT_SCHEMA,
    schemaName: "requirements",
    // Judgment, not generation: rerunning the same PR should give the same verdicts, and
    // sampling noise here turns directly into flapping accusations.
    temperature: 0,
  });

  if (res.error) {
    log(`[FAIL] requirement axis model call failed: ${res.error}`);
    return {
      result: { workItems: withSpec, criteria: [], extras: [], error: res.error },
      prompt,
    };
  }

  const parsed = parseJsonObject<{ criteria?: unknown; extras?: unknown }>(res.text);
  if (!parsed.ok) {
    log(`[FAIL] requirement axis output unparseable: ${parsed.error}`);
    return {
      result: { workItems: withSpec, criteria: [], extras: [], error: parsed.error },
      prompt,
      raw: res.text,
    };
  }

  const resolved = resolveJudgments(
    Array.isArray(parsed.value.criteria) ? parsed.value.criteria : [],
    refs,
  );
  const criteria = resolved.criteria;
  if (resolved.unknownIds > 0 || resolved.unjudged > 0) {
    log(
      `[WARN] requirement axis: ${resolved.unknownIds} verdicts on invented criterion ids dropped, ` +
        `${resolved.unjudged} listed criteria left unjudged (marked not-verifiable)`,
    );
  }
  const extras = (Array.isArray(parsed.value.extras) ? parsed.value.extras : [])
    .map(validateExtra)
    .filter((e): e is ExtraChange => e !== undefined)
    // Deterministic cap on top of the schema's static ceiling; the prompt asked for the
    // most significant first, so slicing keeps the ranked head.
    .slice(0, MAX_EXTRAS);

  await disputeAccusations(input, criteria);

  const counts = new Map<string, number>();
  for (const c of criteria) counts.set(c.verdict, (counts.get(c.verdict) ?? 0) + 1);
  log(
    `requirement axis: ${criteria.length} criteria (` +
      [...counts.entries()].map(([k, v]) => `${k} ${v}`).join(", ") +
      `), ${extras.length} out-of-scope changes`,
  );

  return { result: { workItems: withSpec, criteria, extras }, prompt, raw: res.text };
}

/**
 * Adversarial pass over the axis's accusations. This axis was the one model opinion in the
 * pipeline that published with no downstream filter, and its worst outputs accuse the
 * author: "missing" and "misunderstood". Both are refutable claims about the diff, so a
 * skeptic (different family, cold start, kill mandate) gets one attempt at each.
 *
 * One round, first skeptic model only — deliberately narrower than the code axis's
 * majority vote: every call here re-reads the finder-sized diff payload, so rounds are
 * priced like extra finders, not like 25-line verdicts. "partial" and "satisfied" are not
 * verified: partial names its own gap with a quote, satisfied is anchored downstream.
 *
 * Same asymmetries as the code skeptic: fails open (an unanswered challenge changes
 * nothing), and a refutation never flips a verdict to satisfied — it demotes it to
 * not-verifiable with the refuter's evidence in the note, taking the accusation out of
 * the unmet count while keeping the disagreement visible in the summary.
 */
async function disputeAccusations(input: RequirementGateInput, criteria: CriterionCheck[]): Promise<void> {
  const model = SKEPTIC_MODELS[0];
  if (!model) return; // no skeptic configured = no verification runs, same as the code axis
  const accused = criteria.filter((c) => c.verdict === "missing" || c.verdict === "misunderstood");
  if (accused.length === 0) return;

  const payload = buildDiffPayload(input.files).text;
  const verdicts = await Promise.all(
    accused.map(async (c): Promise<Verdict> => {
      const res = await input.runner.chat({
        model,
        system: REQ_SKEPTIC_SYSTEM,
        user: buildReqSkepticPrompt(c.criterion, c.verdict, c.note, payload),
        schema: VERDICT_SCHEMA,
        schemaName: "verdict",
        temperature: 0,
      });
      if (res.error) return { refuted: false, reason: "", confidence: 0, model, error: res.error };
      return parseVerdict(res.text, model);
    }),
  );
  const disputed = applyReqSkepticVerdicts(accused, verdicts);
  if (disputed > 0) {
    log(`requirement skeptic: ${disputed} of ${accused.length} accusations disputed → not-verifiable (model ${model})`);
  }
}

/**
 * Applies refutations onto accusation verdicts, in place. Exported for the selftest.
 * Refuted → not-verifiable (never satisfied: the skeptic found counter-evidence, it did
 * not perform the requirement review); errors and non-refutations leave the verdict alone.
 */
export function applyReqSkepticVerdicts(accused: CriterionCheck[], verdicts: Verdict[]): number {
  let disputed = 0;
  for (let i = 0; i < accused.length; i++) {
    const c = accused[i];
    const v = verdicts[i];
    if (!c || !v || v.error || !v.refuted) continue;
    c.note = `Disputed by verification (${v.model}): ${v.reason}${c.note ? ` — original note: ${c.note}` : ""}`;
    c.verdict = "not-verifiable";
    disputed++;
  }
  return disputed;
}

/** Verdicts that mean the PR does not yet do what was asked. */
export function unmetCriteria(result: RequirementResult): CriterionCheck[] {
  return result.criteria.filter(
    (c) => c.verdict === "missing" || c.verdict === "partial" || c.verdict === "misunderstood",
  );
}

/**
 * Requirement findings that can carry an inline comment: an unmet criterion or a scope-creep
 * change that pointed at concrete code. Anchored through the same quote pipeline as code
 * findings — a requirement comment on the wrong line is no better than a code one.
 */
export function toRequirementFindings(
  result: RequirementResult,
  index: FileIndex,
): AnchoredFinding[] {
  const candidates: RawFinding[] = [];

  for (const c of unmetCriteria(result)) {
    if (!c.quote || !c.file) continue; // "missing" usually has no code to point at
    candidates.push({
      category: "req-mismatch",
      // Wrong-direction work is worse than incomplete work: it looks done.
      severity: c.verdict === "misunderstood" ? "high" : "medium",
      confidence: 0.7,
      file: c.file,
      quote: c.quote,
      side: "right",
      claim: `${c.verdict === "partial" ? "Acceptance criterion only partially met" : "Implementation does not match the acceptance criterion"}: ${c.criterion}`,
      evidence: c.note,
    });
  }

  for (const e of result.extras) {
    if (!e.quote) continue;
    candidates.push({
      category: "req-mismatch",
      severity: "low",
      confidence: 0.6,
      file: e.file,
      quote: e.quote,
      side: "right",
      claim: `Out of scope: no acceptance criterion covers this change: ${e.claim}`,
      evidence: "Out-of-scope changes are not necessarily wrong, but a human should confirm they were intentional.",
    });
  }

  const out: AnchoredFinding[] = [];
  for (const f of candidates) {
    const res = anchorFinding(f, index);
    if (!res.anchor) continue; // fail closed: it still shows up in the summary table
    const file = res.file?.path ?? normalizePath(f.file);
    out.push({
      ...f,
      file,
      sources: ["requirement"],
      fingerprint: createHash("sha1")
        // Hashes the RESOLVED path, like the code-axis fingerprint (aggregate.ts): the
        // model's path spelling must not change the identity of the same finding between
        // runs.
        .update(`req ${file.toLowerCase()} ${f.quote.replace(/\s+/g, " ").trim()}`)
        .digest("hex")
        .slice(0, 12),
      anchor: res.anchor,
    });
  }
  return out.slice(0, MAX_INLINE_REQ_COMMENTS);
}
