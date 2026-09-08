// Skeptic gate: every anchored finding is handed to a different model family that tries to
// refute it. This is where precision comes from — the finder runs in coverage mode and is
// expected to over-report, so something downstream has to do the killing.
//
// Findings are verified in parallel; a skeptic that fails to answer leaves its finding
// alive (fail-open here, because a dead verifier must not silently delete real bugs — the
// consensus rule downstream still requires corroboration before publishing).
import {
  MAX_SKEPTIC_FINDINGS,
  SKEPTIC_CONTEXT_LINES,
  SKEPTIC_MAX_TOKENS,
  SKEPTIC_MODELS,
  SKEPTIC_ROUNDS,
  SKEPTIC_TIMEOUT_MS,
  severityRank,
} from "../config";
import { parseJsonObject } from "../libs/json";
import { log, logVerbose } from "../libs/log";
import { SEVERITIES, type Severity } from "../config";
import type { AnchoredFinding, FileDiff, ModelRunner } from "../libs/types";
import { VERDICT_SCHEMA } from "../models/schemas";
import { SKEPTIC_SYSTEM, buildSkepticPrompt } from "../prompts/skeptic";

export interface Verdict {
  refuted: boolean;
  reason: string;
  confidence: number;
  suggestedSeverity?: Severity;
  model: string;
  error?: string;
}

export interface SkepticOutcome {
  finding: AnchoredFinding;
  verdicts: Verdict[];
  // Majority of answering skeptics refuted it.
  killed: boolean;
  // What the skeptics were shown — the audit trail for debugging a wrong refutation.
  prompt?: string;
}

const VALID_SEVERITY = new Set<string>(SEVERITIES);

export function parseVerdict(raw: string, model: string): Verdict {
  const parsed = parseJsonObject<Record<string, unknown>>(raw);
  if (!parsed.ok) {
    // Fail open: an unparseable verdict is not evidence that the finding is wrong.
    return { refuted: false, reason: "", confidence: 0, model, error: parsed.error };
  }
  const o = parsed.value;
  // A parseable object that never says refuted true/false is not a verdict. Counting it as
  // an answer would let garbage output both survive the kill vote AND satisfy the
  // "cleared by a skeptic" corroboration gate downstream.
  if (typeof o["refuted"] !== "boolean") {
    return { refuted: false, reason: "", confidence: 0, model, error: "no refuted field in verdict" };
  }
  const sev = typeof o["suggested_severity"] === "string" ? o["suggested_severity"].toLowerCase() : "";
  let confidence = Number(o["confidence"]);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  return {
    refuted: o["refuted"] === true,
    reason: typeof o["reason"] === "string" ? o["reason"] : "",
    confidence: Math.min(1, Math.max(0, confidence)),
    suggestedSeverity: VALID_SEVERITY.has(sev) ? (sev as Severity) : undefined,
    model,
  };
}

async function verifyOne(runner: ModelRunner, prompt: string, model: string): Promise<Verdict> {
  const res = await runner.chat({
    model,
    system: SKEPTIC_SYSTEM,
    user: prompt,
    schema: VERDICT_SCHEMA,
    schemaName: "verdict",
    maxTokens: SKEPTIC_MAX_TOKENS,
    timeoutMs: SKEPTIC_TIMEOUT_MS,
  });
  if (res.error) {
    // The runner names the global budget knob; this call has its own. And a truncated
    // verdict's partial text is the only clue to WHAT overran (a thorough reason, or
    // thinking billed as content) — log its head instead of discarding it.
    const error = res.error.replace("raise PRR_LLM_MAX_TOKENS", "raise PRR_SKEPTIC_MAX_TOKENS");
    const head = res.text.trim().replace(/\s+/g, " ").slice(0, 200);
    logVerbose(`skeptic ${model} call failed: ${error}${head ? ` — partial output: ${head}` : ""}`);
    return { refuted: false, reason: "", confidence: 0, model, error };
  }
  return parseVerdict(res.text, model);
}

export async function runSkeptic(
  runner: ModelRunner,
  findings: AnchoredFinding[],
  files: FileDiff[],
): Promise<SkepticOutcome[]> {
  if (findings.length === 0 || SKEPTIC_MODELS.length === 0) {
    return findings.map((f) => ({ finding: f, verdicts: [], killed: false }));
  }

  // Fan-out ceiling: findings × rounds calls, worst findings first. The overflow passes
  // through unverified (and the corroboration rule downstream keeps single-source
  // unverified findings out of inline comments) — logged, never silently dropped.
  let toVerify = findings;
  let overflow: AnchoredFinding[] = [];
  if (findings.length > MAX_SKEPTIC_FINDINGS) {
    const ranked = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    toVerify = ranked.slice(0, MAX_SKEPTIC_FINDINGS);
    overflow = ranked.slice(MAX_SKEPTIC_FINDINGS);
    log(
      `[WARN] skeptic fan-out capped: verifying the ${MAX_SKEPTIC_FINDINGS} highest-severity ` +
        `of ${findings.length} findings (${overflow.length} pass through unverified; ` +
        `raise PRR_MAX_SKEPTIC_FINDINGS to verify more)`,
    );
  }

  // One verifier per round per finding; rounds cycle through the configured models so a
  // 3-round setup with 2 models still gets cross-family coverage.
  const jobs: Array<Promise<SkepticOutcome>> = toVerify.map(async (finding) => {
    const file = files.find((f) => f.path === finding.file);
    if (!file || !finding.anchor) return { finding, verdicts: [], killed: false };

    const prompt = buildSkepticPrompt({
      claim: finding.claim,
      category: finding.category,
      severity: finding.severity,
      file,
      side: finding.anchor.side,
      startLine: finding.anchor.startLine,
      endLine: finding.anchor.endLine,
      contextLines: SKEPTIC_CONTEXT_LINES,
    });
    const models = Array.from(
      { length: SKEPTIC_ROUNDS },
      (_, i) => SKEPTIC_MODELS[i % SKEPTIC_MODELS.length]!,
    );
    const verdicts = await Promise.all(models.map((m) => verifyOne(runner, prompt, m)));

    // Only skeptics that actually answered get a vote.
    const answered = verdicts.filter((v) => !v.error);
    const refutedCount = answered.filter((v) => v.refuted).length;
    const killed = answered.length > 0 && refutedCount * 2 > answered.length;

    return { finding, verdicts, killed, prompt };
  });

  const outcomes = [
    ...(await Promise.all(jobs)),
    ...overflow.map((f) => ({ finding: f, verdicts: [], killed: false })),
  ];
  const killed = outcomes.filter((o) => o.killed).length;
  // A finding every one of whose verifiers errored was NOT verified. Reporting it inside
  // "verified N" is a lie that costs the reader the one fact they need: an unverified
  // single-source finding cannot be published, so a dead verifier silently deletes a comment.
  const unverified = outcomes.filter((o) => o.verdicts.length > 0 && o.verdicts.every((v) => v.error));
  log(
    `skeptic: verified ${outcomes.length - unverified.length}, refuted ${killed}, ` +
      `kept ${outcomes.length - killed}` +
      ` (${SKEPTIC_ROUNDS} rounds each, models ${SKEPTIC_MODELS.join(", ")})`,
  );
  if (unverified.length > 0) {
    log(
      `[WARN] ${unverified.length} findings could not be verified — every verifier call failed. ` +
        `Single-source findings among them cannot be published. First error: ` +
        `${unverified[0]!.verdicts.find((v) => v.error)?.error?.slice(0, 200) ?? ""}`,
    );
  }
  for (const o of outcomes) {
    if (!o.killed) continue;
    // Collapse first, truncate second. A model's reason is prose with paragraph breaks, and
    // slicing it while the newlines are still in there emitted lines with no [mm:ss] prefix
    // in the middle of the log, which reads as the run having crashed.
    const why = (o.verdicts.find((v) => v.refuted)?.reason ?? "").replace(/\s+/g, " ").trim();
    logVerbose(`  refuted: ${o.finding.file}:${o.finding.anchor?.startLine} — ${why.slice(0, 120)}`);
  }
  return outcomes;
}

/**
 * Applies surviving verdicts back onto findings: a skeptic that accepts a finding but argues
 * the severity was inflated gets to lower it (never raise it — the finder owns the ceiling,
 * and letting a verifier escalate reintroduces the agreeableness it exists to counter).
 */
export function applyVerdicts(outcomes: SkepticOutcome[]): AnchoredFinding[] {
  const survivors: AnchoredFinding[] = [];
  for (const o of outcomes) {
    if (o.killed) continue;
    const f = o.finding;
    const answered = o.verdicts.filter((v) => !v.error);
    // "Cleared" = examined and NOT refuted. A refuting minority vote kept the finding
    // alive (fail-open), but it must not double as the corroboration that publishes it.
    f.skepticVerdicts = answered.filter((v) => !v.refuted).length;
    f.skepticRefuted = answered.filter((v) => v.refuted).length;

    const downgrades = answered
      .map((v) => v.suggestedSeverity)
      .filter((s): s is Severity => s !== undefined && severityRank(s) > severityRank(f.severity));
    if (downgrades.length > 0) {
      const mildest = downgrades.reduce((a, b) => (severityRank(a) > severityRank(b) ? a : b));
      logVerbose(`  severity downgraded: ${f.file}:${f.anchor?.startLine} ${f.severity} → ${mildest}`);
      f.severity = mildest;
    }
    survivors.push(f);
  }
  return survivors;
}
