// Requirement gate: does this change actually do what the linked work item asked for?
//
// Runs before and independently of the code axis. Failures here are non-fatal by design —
// plenty of PRs legitimately have no linked work item, and a review that refuses to run
// because Boards hygiene is imperfect gets switched off.
import { createHash } from "node:crypto";
import { MAX_INLINE_REQ_COMMENTS, REQ_MODEL } from "../config";
import { getLinkedRequirements } from "../ado/workitems";
import { anchorFinding } from "../anchoring/locate";
import { normalizePath, type FileIndex } from "../libs/fileindex";
import { parseJsonObject } from "../libs/json";
import { log } from "../libs/log";
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

function validateCriterion(v: unknown): CriterionCheck | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const criterion = typeof o["criterion"] === "string" ? o["criterion"].trim() : "";
  if (!criterion) return undefined;

  const raw = typeof o["verdict"] === "string" ? o["verdict"].toLowerCase() : "";
  // An unrecognised verdict must not silently become "satisfied".
  const verdict: ReqVerdict = VALID_VERDICT.has(raw) ? (raw as ReqVerdict) : "not-verifiable";
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);

  return {
    workItemId: Number(o["workItemId"]) || 0,
    criterion,
    verdict,
    note: str("note") ?? "",
    quote: str("quote"),
    file: str("file"),
  };
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

  const prompt = buildRequirementPrompt({ pr: input.pr, workItems: withSpec, files: input.files });
  const res = await input.runner.chat({
    model: REQ_MODEL,
    system: REQUIREMENT_SYSTEM,
    user: prompt,
    schema: REQUIREMENT_SCHEMA,
    schemaName: "requirements",
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

  const criteria = (Array.isArray(parsed.value.criteria) ? parsed.value.criteria : [])
    .map(validateCriterion)
    .filter((c): c is CriterionCheck => c !== undefined);
  const extras = (Array.isArray(parsed.value.extras) ? parsed.value.extras : [])
    .map(validateExtra)
    .filter((e): e is ExtraChange => e !== undefined);

  const counts = new Map<string, number>();
  for (const c of criteria) counts.set(c.verdict, (counts.get(c.verdict) ?? 0) + 1);
  log(
    `requirement axis: ${criteria.length} criteria (` +
      [...counts.entries()].map(([k, v]) => `${k} ${v}`).join(", ") +
      `), ${extras.length} out-of-scope changes`,
  );

  return { result: { workItems: withSpec, criteria, extras }, prompt, raw: res.text };
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
