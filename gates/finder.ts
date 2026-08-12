// Finder stage: run the finder model(s) over the diff and return validated raw findings.
//
// M1 runs one model. The signature is already plural because M3 turns this into a
// heterogeneous fleet running in parallel — the only thing that changes is the fan-out,
// not the parsing or validation.
import { FINDER_MODELS, FINDING_CATEGORIES, SEVERITIES, severityRank, type Severity } from "../config";
import { parseJsonObject } from "../libs/json";
import { log } from "../libs/log";
import { loadRules, renderRules, selectRules } from "../libs/rules";
import type { ModelRunner, RawFinding } from "../libs/types";
import { FINDINGS_SCHEMA } from "../models/schemas";
import { FINDER_SYSTEM, buildFinderPrompt, type FinderPromptInput } from "../prompts/finder";

export interface FinderOutput {
  model: string;
  findings: RawFinding[];
  error?: string;
  rejected: number;
  raw: string;
}

const VALID_SEVERITY = new Set<string>(SEVERITIES);
const VALID_CATEGORY = new Set<string>(FINDING_CATEGORIES);

/** Field-by-field validation. A finding missing its quote is unanchorable, so it's dropped. */
export function validateFinding(v: unknown): RawFinding | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;

  const file = typeof o["file"] === "string" ? o["file"].trim() : "";
  const quote = typeof o["quote"] === "string" ? o["quote"] : "";
  const claim = typeof o["claim"] === "string" ? o["claim"].trim() : "";
  if (!file || !quote.trim() || !claim) return undefined;

  const severityRaw = typeof o["severity"] === "string" ? o["severity"].toLowerCase() : "";
  const severity: Severity = VALID_SEVERITY.has(severityRaw) ? (severityRaw as Severity) : "medium";

  let confidence = Number(o["confidence"]);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.min(1, Math.max(0, confidence));

  const side = o["side"] === "left" ? "left" : "right";
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);

  // An out-of-enum category is a labelling slip, not a reason to drop a real finding;
  // severity and quote are what actually gate publication.
  const rawCategory = (str("category") ?? "").toLowerCase();
  const category = VALID_CATEGORY.has(rawCategory) ? rawCategory : "correctness";

  // The rules' citation contract, enforced structurally rather than by asking nicely:
  // a maintainability finding is a judgment call by definition, and one that names no
  // smell or project rule is a hypothesis — it may still appear in the summary, but it
  // cannot spend an inline-comment slot, so it is capped below the default inline bar.
  // Findings in behavioral categories cite their own broken behavior via quote+evidence.
  const cites = str("cites")?.trim() || undefined;
  const cappedSeverity: Severity =
    category === "maintainability" && !cites && severityRank(severity) < severityRank("low")
      ? "low"
      : severity;

  return {
    category,
    severity: cappedSeverity,
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
  };
}

async function runOne(
  runner: ModelRunner,
  model: string,
  prompt: string,
): Promise<FinderOutput> {
  const res = await runner.chat({
    model,
    system: FINDER_SYSTEM,
    user: prompt,
    schema: FINDINGS_SCHEMA,
    schemaName: "findings",
  });

  if (res.error) {
    log(`[FAIL] finder ${model} call failed: ${res.error}`);
    return { model, findings: [], error: res.error, rejected: 0, raw: "" };
  }

  const parsed = parseJsonObject<{ findings?: unknown }>(res.text);
  if (!parsed.ok) {
    // Fail closed: an unparseable response yields no findings rather than guessed ones.
    log(`[FAIL] finder ${model} output unparseable: ${parsed.error}`);
    return { model, findings: [], error: parsed.error, rejected: 0, raw: res.text };
  }

  const arr = Array.isArray(parsed.value?.findings) ? (parsed.value.findings as unknown[]) : [];
  const findings: RawFinding[] = [];
  let rejected = 0;
  for (const item of arr) {
    const f = validateFinding(item);
    if (f) findings.push(f);
    else rejected++;
  }
  log(
    `finder ${model}: ${findings.length} findings` +
      (rejected > 0 ? ` (${rejected} dropped for incomplete fields)` : ""),
  );
  return { model, findings, rejected, raw: res.text };
}

export async function runFinders(
  runner: ModelRunner,
  input: FinderPromptInput,
  models: string[] = FINDER_MODELS,
): Promise<{ outputs: FinderOutput[]; prompt: string; omitted: string[]; rules: string[] }> {
  const selected = selectRules(loadRules(), input.files.map((f) => f.path));
  const { text: prompt, omitted } = buildFinderPrompt({
    ...input,
    rules: renderRules(selected),
  });
  if (omitted.length > 0) {
    log(`[WARN] diff over budget; ${omitted.length} files left out of the finder context`);
  }
  // Parallel across models; each is an independent opinion (M3 relies on that independence).
  const outputs = await Promise.all(models.map((m) => runOne(runner, m, prompt)));
  return { outputs, prompt, omitted, rules: selected.map((r) => r.name) };
}
