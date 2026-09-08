// Finder stage: run the finder model(s) over the diff and return validated raw findings.
//
// M1 runs one model. The signature is already plural because M3 turns this into a
// heterogeneous fleet running in parallel — the only thing that changes is the fan-out,
// not the parsing or validation.
import {
  FINDER_CATEGORIES,
  FINDER_MODELS,
  FINDER_PROMPT_SUFFIX_BY_MODEL,
  FINDER_SEED,
  SEVERITIES,
  severityRank,
  type Severity,
} from "../config";
import { arrayField, parseJsonObject } from "../libs/json";
import { log } from "../libs/log";
import { newRunSeed, seedFor } from "../libs/prng";
import { loadRules, renderRules, ruleHeadings, selectRules, type Rule } from "../libs/rules";
import type { ModelRunner, RawFinding } from "../libs/types";
import { FINDINGS_SCHEMA } from "../models/schemas";
import { buildFinderPrompt, finderSystemFor, type FinderPromptInput, type RuleHeadingGroup } from "../prompts/finder";

export interface FinderOutput {
  model: string;
  findings: RawFinding[];
  error?: string;
  rejected: number;
  raw: string;
  // This finder's file-order seed and the exact prompt it received (the orchestrator saves
  // both): every finder reads the files in its own order, so the shared finder-prompt.md
  // — finder 0's — cannot explain what finder 2 saw. Absent on outputs built offline.
  seed?: number;
  prompt?: string;
}

const VALID_SEVERITY = new Set<string>(SEVERITIES);
const VALID_CATEGORY = new Set<string>(FINDER_CATEGORIES);

// The 12 smell names, as rules/_base.md spells them. Hard-coded rather than parsed from the
// loaded file so that a PRR_RULES_DIR without the baseline still recognises them (the
// system prompt names them as the canonical citation); the selftest pins this list to the
// `**Name** —` bullets in _base.md, so the two cannot drift apart unnoticed.
export const BASE_SMELLS = [
  "Mysterious Name",
  "Duplicated Code",
  "Feature Envy",
  "Data Clumps",
  "Primitive Obsession",
  "Repeated Switches",
  "Shotgun Surgery",
  "Divergent Change",
  "Speculative Generality",
  "Message Chains",
  "Middle Man",
  "Refused Bequest",
] as const;

/** Citation text and rule headings compared on the same footing: case, emphasis, spacing. */
export function normalizeCite(s: string): string {
  return s.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

const DEFAULT_KNOWN_CITES: ReadonlySet<string> = new Set(BASE_SMELLS.map(normalizeCite));

/**
 * The citations a maintainability finding may rest on for this PR: the 12 smells, plus
 * every heading of every rule selected for it, plus the headings of the repo's own
 * convention docs when those were injected. Normalised (see normalizeCite).
 */
export function knownCitesFor(selected: Rule[], conventions?: string): Set<string> {
  const out = new Set<string>(DEFAULT_KNOWN_CITES);
  for (const r of selected) for (const h of ruleHeadings(r.body)) out.add(normalizeCite(h));
  if (conventions) for (const h of ruleHeadings(conventions)) out.add(normalizeCite(h));
  out.delete("");
  return out;
}

/** True when the citation contains (case-insensitively) a known smell name or rule heading. */
export function citeIsKnown(cites: string, known: ReadonlySet<string>): boolean {
  const c = normalizeCite(cites);
  if (!c) return false;
  for (const k of known) if (c.includes(k)) return true;
  return false;
}

export type FindingCheck =
  | { finding: RawFinding; rejected?: undefined }
  | { finding?: undefined; rejected: string };

/**
 * Field-by-field validation; the rejection names the field at fault, because "dropped for
 * incomplete fields" once sent a whole debugging session into the prompt when the actual
 * problem was a made-up severity.
 *
 * Severity and category are the two fields that decide publication, and they used to be
 * the two fields where garbage was rewarded: an unknown severity became "medium" — the
 * inline bar — and an unknown category became "correctness", the category with no caps.
 * A model that cannot fill an enum listed in its own schema did not read the schema; that
 * finding is dropped (and counted), never promoted.
 */
export function checkFinding(v: unknown, knownCites: ReadonlySet<string> = DEFAULT_KNOWN_CITES): FindingCheck {
  if (typeof v !== "object" || v === null) return { rejected: "not an object" };
  const o = v as Record<string, unknown>;

  const file = typeof o["file"] === "string" ? o["file"].trim() : "";
  const quote = typeof o["quote"] === "string" ? o["quote"] : "";
  const claim = typeof o["claim"] === "string" ? o["claim"].trim() : "";
  const missing = [!file && "file", !quote.trim() && "quote", !claim && "claim"].filter(Boolean);
  if (missing.length > 0) {
    return { rejected: `incomplete fields (missing ${missing.join(", ")}; need file, quote, claim)` };
  }

  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  const shown = (k: string) => JSON.stringify(o[k] ?? null);

  const severityRaw = str("severity")?.trim().toLowerCase() ?? "";
  if (!VALID_SEVERITY.has(severityRaw)) {
    return { rejected: `severity ${shown("severity")} is not one of ${SEVERITIES.join(", ")}` };
  }
  let severity = severityRaw as Severity;

  const category = str("category")?.trim().toLowerCase() ?? "";
  if (!VALID_CATEGORY.has(category)) {
    // req-mismatch lands here too: it is the requirement axis's category, and a code-axis
    // finding claiming it would be a requirement judgment made without the requirements.
    return { rejected: `category ${shown("category")} is not one of ${FINDER_CATEGORIES.join(", ")}` };
  }

  let confidence = Number(o["confidence"]);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.min(1, Math.max(0, confidence));

  const side = o["side"] === "left" ? "left" : "right";

  // The rules' citation contract, enforced structurally rather than by asking nicely.
  // A maintainability finding is a judgment call by definition and never exceeds medium
  // (_base.md promises it; until this cap a cited smell at "critical" passed straight
  // through). One that names no smell and no rule this PR loaded is a hypothesis — it may
  // still appear in the summary, but it cannot spend an inline-comment slot, so it is
  // capped below the default inline bar. An unrecognised citation is kept on the finding
  // (the artifacts should show what the model claimed) but counts as none. Findings in
  // behavioral categories cite their own broken behavior via quote+evidence.
  const cites = str("cites")?.trim() || undefined;
  if (category === "maintainability") {
    const cap: Severity = cites && citeIsKnown(cites, knownCites) ? "medium" : "low";
    if (severityRank(severity) < severityRank(cap)) severity = cap;
  }

  return {
    finding: {
      category,
      severity,
      confidence,
      file,
      quote,
      context_before: str("context_before"),
      context_after: str("context_after"),
      side,
      claim,
      evidence: str("evidence"),
      suggested_fix: str("suggested_fix"),
      boundary_owner: o["boundary_owner"] === "external" ? "external" : "current",
      cites,
    },
  };
}

/** checkFinding without the reason: the finding, or undefined when it was dropped. */
export function validateFinding(v: unknown, knownCites?: ReadonlySet<string>): RawFinding | undefined {
  return checkFinding(v, knownCites).finding;
}

async function runOne(
  runner: ModelRunner,
  model: string,
  system: string,
  prompt: string,
  seed: number,
  knownCites: ReadonlySet<string>,
): Promise<FinderOutput> {
  const res = await runner.chat({
    model,
    system,
    user: prompt,
    schema: FINDINGS_SCHEMA,
    schemaName: "findings",
  });

  if (res.error) {
    log(`[FAIL] finder ${model} call failed: ${res.error}`);
    return { model, findings: [], error: res.error, rejected: 0, raw: "", seed, prompt };
  }

  const parsed = parseJsonObject<{ findings?: unknown }>(res.text);
  if (!parsed.ok) {
    // Fail closed: an unparseable response yields no findings rather than guessed ones.
    log(`[FAIL] finder ${model} output unparseable: ${parsed.error}`);
    return { model, findings: [], error: parsed.error, rejected: 0, raw: res.text, seed, prompt };
  }

  const arr = arrayField(parsed.value, "findings");
  if (!arr) {
    // Parseable, but not the shape asked for — a top-level array, or the list under some
    // other key. That used to read as "0 findings", the same result as a clean PR, with no
    // error to say the model never answered the question. Fail closed, and say why.
    log(`[FAIL] finder ${model} response has no findings array`);
    return { model, findings: [], error: "response has no findings array", rejected: 0, raw: res.text, seed, prompt };
  }
  const findings: RawFinding[] = [];
  let rejected = 0;
  // Why each drop happened, tallied, plus the keys of the first dropped item. "4 dropped"
  // alone is a mystery; "3× severity \"urgent\" is not one of …; had: line, snippet,
  // description" says at once whether the model never saw the schema or ignored one enum.
  const reasons = new Map<string, number>();
  let droppedKeys: string | undefined;
  for (const item of arr) {
    const res = checkFinding(item, knownCites);
    if (res.finding) findings.push(res.finding);
    else {
      rejected++;
      reasons.set(res.rejected, (reasons.get(res.rejected) ?? 0) + 1);
      if (droppedKeys === undefined && typeof item === "object" && item !== null) {
        droppedKeys = Object.keys(item).join(", ") || "(no keys)";
      }
    }
  }
  log(
    `finder ${model}: ${findings.length} findings` +
      (rejected > 0
        ? ` (${rejected} dropped: ${[...reasons].map(([r, n]) => `${n}× ${r}`).join("; ")}; first dropped had: ${droppedKeys ?? "(not an object)"})`
        : ""),
  );
  return { model, findings, rejected, raw: res.text, seed, prompt };
}

export interface FinderRunOptions {
  // Run seed for the per-finder file-order shuffle. Defaults to PRR_FINDER_SEED, else a
  // fresh random seed; tests pass one to get a reproducible prompt.
  seed?: number;
  // Per-model system-prompt suffixes. Defaults to PRR_FINDER_PROMPT_SUFFIX_BY_MODEL.
  promptSuffixes?: Record<string, string>;
}

export async function runFinders(
  runner: ModelRunner,
  input: FinderPromptInput,
  models: string[] = FINDER_MODELS,
  opts: FinderRunOptions = {},
): Promise<{ outputs: FinderOutput[]; prompt: string; omitted: string[]; rules: string[]; seed?: number }> {
  const selected = selectRules(loadRules(), input.files.map((f) => f.path));
  const rules = renderRules(selected);
  const headings: RuleHeadingGroup[] = selected.map((r) => ({ name: r.name, headings: ruleHeadings(r.body) }));
  const knownCites = knownCitesFor(selected, input.conventions);
  const suffixes = opts.promptSuffixes ?? FINDER_PROMPT_SUFFIX_BY_MODEL;

  // Selection is decided once, by budget, and is identical for every finder; only the
  // order of the included files differs per finder (libs/prng.ts says why). The run seed
  // is logged so a result can be replayed with PRR_FINDER_SEED.
  const runSeed = opts.seed ?? FINDER_SEED ?? newRunSeed();
  const promptFor = (i: number) =>
    buildFinderPrompt({ ...input, rules, ruleHeadings: headings, seed: seedFor(runSeed, i) });
  const prompts = models.map((_, i) => promptFor(i));
  const first = prompts[0] ?? promptFor(0);
  const omitted = first.omitted;
  if (omitted.length > 0) {
    log(`[WARN] diff over budget; ${omitted.length} files left out of the finder context`);
  }
  log(`finder file order: run seed ${runSeed}${models.length > 1 ? `, one permutation per finder` : ""}`);

  // Parallel across models; each is an independent opinion (M3 relies on that independence).
  const outputs = await Promise.all(
    models.map((m, i) =>
      runOne(runner, m, finderSystemFor(m, suffixes), prompts[i]!.text, seedFor(runSeed, i), knownCites),
    ),
  );
  return { outputs, prompt: first.text, omitted, rules: selected.map((r) => r.name), seed: runSeed };
}
