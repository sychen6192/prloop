// Skeptic gate: every anchored finding is handed to a different model family that tries to
// refute it. This is where precision comes from — the finder runs in coverage mode and is
// expected to over-report, so something downstream has to do the killing.
//
// Findings are verified in parallel; a skeptic that fails to answer leaves its finding
// alive (fail-open here, because a dead verifier must not silently delete real bugs — the
// consensus rule downstream still requires corroboration before publishing).
import {
  FINDER_MODELS,
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
import { SKEPTIC_VERDICTS, type AnchoredFinding, type FileDiff, type ModelRunner, type SkepticVerdictKind } from "../libs/types";
import { VERDICT_SCHEMA } from "../models/schemas";
import { SKEPTIC_SYSTEM, buildSkepticPrompt } from "../prompts/skeptic";

export interface Verdict {
  // Three answers, not two: only "refuted" kills, only "holds" clears, and
  // "insufficient-context" does neither. See SKEPTIC_VERDICTS.
  verdict: SkepticVerdictKind;
  reason: string;
  // The line(s) the refutation rests on, as the model copied them. Kept so a refutation
  // that killed a real finding can be argued with against the code it cited.
  evidenceQuote?: string;
  confidence: number;
  suggestedSeverity?: Severity;
  model: string;
  error?: string;
  // Set when a "refuted" answer was downgraded to insufficient-context, and why. Saved
  // into skeptic.json: a verifier that tries to kill findings without evidence is a
  // configuration problem, and it is invisible if the downgrade leaves no trace.
  downgraded?: string;
  // This verifier shares a model family with a configured finder, so it shares its blind
  // spots. The verdict still counts (fail open), but it is weaker than it looks.
  sameFamily?: boolean;
  // What the verifier actually said. Saved into skeptic.json, because a refutation that
  // killed a real finding — or an "unparseable verdict" — cannot be argued with from a
  // parsed verdict alone.
  raw?: string;
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
const VALID_VERDICT = new Set<string>(SKEPTIC_VERDICTS);

// Whitespace-normalised containment, the same tolerance the anchoring tiers grant a quote:
// a model that re-indents or re-wraps the line it copied is still quoting the code, and
// discarding its refutation over a space would fail closed in the one place this pipeline
// deliberately fails open. Deliberately local — anchoring resolves quotes to line numbers
// against blob bytes and has no business being pulled into a verdict parser.
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

// The snippet is rendered with a gutter (`>+   12 | code`), so "copied verbatim from the
// snippet" plausibly arrives with the gutter attached. Stripping it can only rescue a
// match that would otherwise be discarded, so it is tried second, never instead.
const stripGutter = (s: string) =>
  s
    .split("\n")
    .map((l) => l.replace(/^[>+\-\s]*\d+\s*\|\s?/, ""))
    .join("\n");

export function quoteAppearsIn(quote: string, snippet: string): boolean {
  const hay = squash(snippet);
  const needle = squash(quote);
  if (!needle) return false;
  return hay.includes(needle) || hay.includes(squash(stripGutter(quote)));
}

/**
 * Parses one verdict. Exported for the selftest.
 *
 * `snippet` is the source text the skeptic was shown; when it is given, a "refuted" answer
 * must quote it. "refuted only with concrete evidence" was prompt text with nothing
 * enforcing it, and an unevidenced refutation — a confident paragraph about code the model
 * never saw — is exactly the failure this stage exists to prevent, so it is downgraded to
 * insufficient-context: it then neither kills the finding nor clears it. Callers with no
 * bounded snippet (the requirement axis hands its skeptic the whole diff and asks for the
 * quote in prose) pass none and keep the model's answer as given.
 */
export function parseVerdict(raw: string, model: string, snippet?: string): Verdict {
  // Errored and unusable verdicts default to insufficient-context, never "holds": the
  // callers filter on `error`, but a value that reads as a clearing if that filter is ever
  // forgotten is a landmine — "nothing came back" is not "a verifier cleared it".
  const parsed = parseJsonObject<Record<string, unknown>>(raw);
  if (!parsed.ok) {
    // Fail open: an unparseable verdict is not evidence that the finding is wrong.
    return { verdict: "insufficient-context", reason: "", confidence: 0, model, error: parsed.error };
  }
  const o = parsed.value;
  // A parseable object that names no verdict is not a verdict. Counting it as an answer
  // would let garbage output both survive the kill vote AND satisfy the "cleared by a
  // skeptic" corroboration gate downstream.
  const named = typeof o["verdict"] === "string" ? o["verdict"].toLowerCase().trim() : "";
  // A backend that ignores the enum still emits the old boolean; map it rather than
  // discarding a whole run's verification because the schema moved on. Note that legacy
  // `false` maps to "holds" — the old semantics, which is the best that shape can express.
  const legacy = typeof o["refuted"] === "boolean" ? (o["refuted"] ? "refuted" : "holds") : "";
  const kind = VALID_VERDICT.has(named) ? named : legacy;
  if (!kind) {
    return { verdict: "insufficient-context", reason: "", confidence: 0, model, error: "no verdict field in the skeptic's answer" };
  }

  const sev = typeof o["suggested_severity"] === "string" ? o["suggested_severity"].toLowerCase() : "";
  let confidence = Number(o["confidence"]);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  const evidenceQuote = typeof o["evidence_quote"] === "string" ? o["evidence_quote"] : "";
  const v: Verdict = {
    verdict: kind as SkepticVerdictKind,
    reason: typeof o["reason"] === "string" ? o["reason"] : "",
    confidence: Math.min(1, Math.max(0, confidence)),
    suggestedSeverity: VALID_SEVERITY.has(sev) ? (sev as Severity) : undefined,
    model,
    ...(evidenceQuote ? { evidenceQuote } : {}),
  };

  if (v.verdict === "refuted" && snippet !== undefined) {
    const why = !evidenceQuote.trim()
      ? "refutation carried no evidence_quote"
      : !quoteAppearsIn(evidenceQuote, snippet)
        ? "evidence_quote is not in the snippet the skeptic was shown"
        : "";
    if (why) {
      v.verdict = "insufficient-context";
      v.downgraded = why;
      logVerbose(`  verdict downgraded (${model}): ${why} — ${squash(v.reason).slice(0, 120)}`);
    }
  }
  return v;
}

/**
 * The model's family, or "" when it is not one we recognise. Pure; exported for the
 * selftest.
 *
 * Cross-family verification was checked only by exact name equality, only in the doctor
 * script: `qwen3-coder` verified by `qwen2.5-coder` passed that check while sharing every
 * blind spot of the finder it was supposed to challenge — and a same-family verifier
 * confirms exactly the errors that matter most. Substring matching on purpose: names
 * arrive prefixed and suffixed by every gateway (`bedrock/anthropic.claude-3-5-sonnet`,
 * `openai/gpt-4o-mini`), and an unrecognised name yields "" so it can never be reported as
 * sharing a family with anything.
 */
export function modelFamily(name: string): string {
  const n = name.toLowerCase();
  const families: Array<[string, string[]]> = [
    ["qwen", ["qwen"]],
    ["llama", ["llama"]],
    ["claude", ["claude"]],
    ["deepseek", ["deepseek"]],
    ["gemma", ["gemma"]],
    ["mistral", ["mistral", "devstral", "codestral", "mixtral"]],
    ["glm", ["glm"]],
    ["granite", ["granite"]],
    ["phi", ["phi-", "phi3", "phi4"]],
    // Last: "gpt" is a substring of names that belong to other families (gpt-oss aside,
    // plenty of fine-tunes carry it), so a more specific family wins first.
    ["gpt", ["gpt"]],
  ];
  for (const [family, needles] of families) {
    if (needles.some((needle) => n.includes(needle))) return family;
  }
  return "";
}

/**
 * The verifiers for one finding, one per round. Exported for the selftest.
 *
 * Rounds used to cycle `models[i % n]`, so 3 rounds over 2 models gave one model two votes
 * — and two samples of the same model at temperature 0.2 are near-duplicates, not
 * independent votes, which is a majority manufactured out of one opinion. Cap the rounds at
 * the number of distinct models instead: fewer votes that are actually independent.
 */
export function skepticRoster(models: string[], rounds: number): { roster: string[]; capped: number } {
  const distinct = [...new Set(models.filter(Boolean))];
  const n = Math.min(Math.max(rounds, 0), distinct.length);
  return { roster: distinct.slice(0, n), capped: Math.max(0, rounds - distinct.length) };
}

async function verifyOne(
  runner: ModelRunner,
  prompt: string,
  snippet: string,
  model: string,
  sameFamily: boolean,
): Promise<Verdict> {
  const res = await runner.chat({
    model,
    system: SKEPTIC_SYSTEM,
    user: prompt,
    schema: VERDICT_SCHEMA,
    schemaName: "verdict",
    maxTokens: SKEPTIC_MAX_TOKENS,
    timeoutMs: SKEPTIC_TIMEOUT_MS,
  });
  const mark = sameFamily ? { sameFamily: true as const } : {};
  if (res.error) {
    // The runner names the global budget knob; this call has its own. And a truncated
    // verdict's partial text is the only clue to WHAT overran (a thorough reason, or
    // thinking billed as content) — log its head instead of discarding it.
    const error = res.error.replace("raise PRR_LLM_MAX_TOKENS", "raise PRR_SKEPTIC_MAX_TOKENS");
    const head = res.text.trim().replace(/\s+/g, " ").slice(0, 200);
    logVerbose(`skeptic ${model} call failed: ${error}${head ? ` — partial output: ${head}` : ""}`);
    return { verdict: "insufficient-context", reason: "", confidence: 0, model, error, raw: res.text, ...mark };
  }
  return { ...parseVerdict(res.text, model, snippet), raw: res.text, ...mark };
}

/**
 * Order in which findings claim the fan-out budget: severity, then the finder's own
 * confidence. Exported for the selftest.
 *
 * Severity alone left the tie broken by arrival order — which model answered first, and in
 * what order that model happened to emit its findings. Confidence was already asked of the
 * finder and spent on nothing but a sort tiebreak and a line of footer text; here it decides
 * which of twenty equally-severe findings actually gets verified, which is the difference
 * between a published finding and a summary line.
 */
export function rankForVerification(findings: AnchoredFinding[]): AnchoredFinding[] {
  return [...findings].sort((a, b) => {
    const s = severityRank(a.severity) - severityRank(b.severity);
    return s !== 0 ? s : b.confidence - a.confidence;
  });
}

export interface SkepticOptions {
  // Parameterised for the selftest, which cannot set PRR_SKEPTIC_* / PRR_FINDER_MODELS
  // after config loaded. Production passes none.
  models?: string[];
  rounds?: number;
  finders?: string[];
}

export async function runSkeptic(
  runner: ModelRunner,
  findings: AnchoredFinding[],
  files: FileDiff[],
  opts: SkepticOptions = {},
): Promise<SkepticOutcome[]> {
  const configured = opts.models ?? SKEPTIC_MODELS;
  const finders = opts.finders ?? FINDER_MODELS;
  if (findings.length === 0 || configured.length === 0) {
    return findings.map((f) => ({ finding: f, verdicts: [], killed: false }));
  }

  // Fan-out ceiling: findings × rounds calls, worst findings first. The overflow passes
  // through unverified (and the corroboration rule downstream keeps single-source
  // unverified findings out of inline comments) — logged, never silently dropped.
  let toVerify = findings;
  let overflow: AnchoredFinding[] = [];
  if (findings.length > MAX_SKEPTIC_FINDINGS) {
    const ranked = rankForVerification(findings);
    toVerify = ranked.slice(0, MAX_SKEPTIC_FINDINGS);
    overflow = ranked.slice(MAX_SKEPTIC_FINDINGS);
    log(
      `[WARN] skeptic fan-out capped: verifying the ${MAX_SKEPTIC_FINDINGS} highest-severity ` +
        `of ${findings.length} findings (${overflow.length} pass through unverified; ` +
        `raise PRR_MAX_SKEPTIC_FINDINGS to verify more)`,
    );
  }

  // One verifier per round per finding, each a DIFFERENT model — computed once per run so
  // the cap and the same-family warning are stated once, not once per finding.
  const { roster, capped } = skepticRoster(configured, opts.rounds ?? SKEPTIC_ROUNDS);
  if (capped > 0) {
    log(
      `[WARN] skeptic rounds capped to ${roster.length}: ${opts.rounds ?? SKEPTIC_ROUNDS} rounds were configured ` +
        `over ${roster.length} distinct models, and re-sampling one model is not a second opinion — ` +
        `add models to PRR_SKEPTIC_MODELS for a wider vote`,
    );
  }
  // Cross-family verification was checked only by exact name equality, only in the doctor
  // script — so a qwen finder verified by a different qwen sailed through, sharing the
  // blind spots that produce the errors most worth catching. Say so at runtime, on every
  // run that is configured that way.
  const finderFamilies = new Set(finders.map(modelFamily).filter(Boolean));
  const sharesFamily = (m: string) => {
    const fam = modelFamily(m);
    return fam !== "" && finderFamilies.has(fam);
  };
  const allSameFamily = roster.length > 0 && roster.every(sharesFamily);
  if (allSameFamily) {
    log(
      `[WARN] every skeptic shares a model family with a finder (skeptics ${roster.join(", ")}; ` +
        `finders ${finders.join(", ")}). A same-family verifier shares the finder's blind spots and ` +
        `confirms exactly the errors that matter most — verification is weakened, not absent. ` +
        `Point PRR_SKEPTIC_MODELS at a different family.`,
    );
  }

  const jobs: Array<Promise<SkepticOutcome>> = toVerify.map(async (finding) => {
    const file = files.find((f) => f.path === finding.file);
    if (!file || !finding.anchor) return { finding, verdicts: [], killed: false };

    const { prompt, snippet } = buildSkepticPrompt({
      claim: finding.claim,
      category: finding.category,
      severity: finding.severity,
      file,
      side: finding.anchor.side,
      startLine: finding.anchor.startLine,
      endLine: finding.anchor.endLine,
      contextLines: SKEPTIC_CONTEXT_LINES,
    });
    const verdicts = await Promise.all(
      roster.map((m) => verifyOne(runner, prompt, snippet, m, sharesFamily(m))),
    );

    // Only skeptics that actually answered get a vote. An "insufficient-context" answer is
    // an answer: it dilutes the majority a kill needs, which is the conservative direction.
    const answered = verdicts.filter((v) => !v.error);
    const refutedCount = answered.filter((v) => v.verdict === "refuted").length;
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
  // "Not refuted" used to mean "cleared". A finding every one of whose verifiers answered
  // "I could not check this" is neither killed nor corroborated, and that is a different
  // fact about the run than "verified" — the reader needs it to know whether the context
  // window or the model roster is what is costing them comments.
  const unchecked = outcomes.filter((o) => {
    const answered = o.verdicts.filter((v) => !v.error);
    return answered.length > 0 && answered.every((v) => v.verdict === "insufficient-context");
  });
  log(
    `skeptic: verified ${outcomes.length - unverified.length}, refuted ${killed}, ` +
      `unchecked ${unchecked.length}, kept ${outcomes.length - killed}` +
      ` (${roster.length} rounds each, models ${roster.join(", ")})`,
  );
  const downgraded = outcomes.flatMap((o) => o.verdicts.filter((v) => v.downgraded));
  if (downgraded.length > 0) {
    log(
      `[WARN] ${downgraded.length} refutations discarded for want of evidence ` +
        `(${downgraded[0]!.downgraded}) — a verifier that kills findings it cannot quote is ` +
        `guessing; check skeptic.json and the model's schema support`,
    );
  }
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
    const why = (o.verdicts.find((v) => v.verdict === "refuted")?.reason ?? "").replace(/\s+/g, " ").trim();
    logVerbose(`  refuted: ${o.finding.file}:${o.finding.anchor?.startLine} — ${why.slice(0, 120)}`);
  }
  return outcomes;
}

/**
 * The severity a finding ends up with after its verifiers voted. Exported for the selftest.
 *
 * Each answered verdict is one vote: its suggested severity, or the current severity when
 * it suggested none (accepting the finding as rated is a vote for that rating). The median
 * vote wins, and only when it is milder than the current severity — a verifier may lower,
 * never raise. Previously the mildest suggestion from ANY verdict won outright, so in a
 * three-round setup one dissenting "low" outvoted two verifiers who agreed with the finder,
 * while killing the same finding would have taken a majority. An even count takes the more
 * severe of the two middle votes, so a tie never downgrades; a single verifier is the whole
 * electorate and its suggestion stands.
 */
export function votedSeverity(current: Severity, votes: Array<Severity | undefined>): Severity {
  if (votes.length === 0) return current;
  const ranks = votes.map((v) => severityRank(v ?? current)).sort((a, b) => a - b);
  const median = ranks.length % 2 === 1 ? ranks[(ranks.length - 1) / 2]! : ranks[ranks.length / 2 - 1]!;
  return median > severityRank(current) ? SEVERITIES[median]! : current;
}

/**
 * Applies surviving verdicts back onto findings: a skeptic majority that accepts a finding
 * but argues the severity was inflated gets to lower it (never raise it — the finder owns
 * the ceiling, and letting a verifier escalate reintroduces the agreeableness it exists to
 * counter). Majority, not any single voice: see votedSeverity.
 */
export function applyVerdicts(outcomes: SkepticOutcome[]): AnchoredFinding[] {
  const survivors: AnchoredFinding[] = [];
  for (const o of outcomes) {
    if (o.killed) continue;
    const f = o.finding;
    const answered = o.verdicts.filter((v) => !v.error);
    // "Cleared" = a verifier looked at the code the claim is about and found nothing wrong
    // with it. "I could not check this" used to be counted here as well, which published
    // single-source findings on the strength of a verifier that never saw the relevant
    // code. A refuting minority vote keeps the finding alive (fail-open) but must not
    // double as the corroboration that publishes it either — hence three counters, and the
    // majority test in finalize.
    const cleared = answered.filter((v) => v.verdict === "holds");
    f.skepticVerdicts = cleared.length;
    f.skepticRefuted = answered.filter((v) => v.verdict === "refuted").length;
    f.skepticUnchecked = answered.filter((v) => v.verdict === "insufficient-context").length;
    // Disclosed, not rejected: on a single-family deployment (most of them) rejecting these
    // clearings would delete real findings, so the clearing stands and the comment says
    // what kind of check it got.
    if (cleared.length > 0 && cleared.every((v) => v.sameFamily)) f.skepticSameFamily = true;

    const voted = votedSeverity(f.severity, answered.map((v) => v.suggestedSeverity));
    if (voted !== f.severity) {
      logVerbose(
        `  severity downgraded: ${f.file}:${f.anchor?.startLine} ${f.severity} → ${voted} ` +
          `(median of ${answered.length} verdicts)`,
      );
      f.severity = voted;
    }
    survivors.push(f);
  }
  return survivors;
}
