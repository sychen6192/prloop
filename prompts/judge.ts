// Judge prompt: does a comment prloop made describe the same issue as a benchmark's reference
// comment? Used only by scripts/bench.ts to score reviews — never by a review, so it is left
// out of the run stamp's prompt hash (libs/stamp.ts): editing it changes what a score says
// about a review, not what the review said.
//
// Where a benchmark gives a location (AACR-Bench: a path and a line range) the judge is the
// secondary signal, asked only about the comments on those lines. Where it gives none
// (Martian's golden comments are text) it is the only one, and sees every comment the run
// made. Either way it is asked about a batch — one reference, all of its candidates — because
// asking pair by pair costs a call per pair, and the Martian set alone would need thousands.
//
// Judges disagree with each other by several points of recall, and with developers by more
// (the Beko follow-up measured 0.44–0.62 agreement with fixed/wontFix labels), so a judged
// score is comparable only with scores made under the same judge model AND this prompt.
// bench records both and refuses to compare across them.
import { fenceUntrusted, neutralizeLine } from "./untrusted";

export const JUDGE_SYSTEM = `You compare code review comments.

You are given one reference comment — an issue a reviewer confirmed in a pull request — and a
numbered list of candidate comments another reviewer made on the same pull request. Decide
which candidates identify the SAME underlying issue as the reference.

- Different wording is fine. What must match is the problem: the same defect, risk or
  omission, in the same code.
- A candidate about the same code but a different problem is not a match.
- A candidate that only describes what the code does, or asks a question without naming the
  problem, is not a match.
- Several candidates can match, and so can none. Do not pick the closest one when none is
  the same issue.`;

/** The longest candidate claim shown: a claim is one or two sentences, and a judge needs no more. */
const CLAIM_MAX_CHARS = 600;

export interface JudgeReference {
  text: string;
  file?: string;
  lines?: [number, number];
}

export interface JudgeCandidate {
  file: string;
  line?: number;
  claim: string;
}

/**
 * The user prompt. Both halves are text prloop did not write — a benchmark's annotation and a
 * model's claims — so both are fenced, and a claim is flattened to one line, because a claim
 * carrying "[3]" after a line break would forge a candidate of its own.
 */
export function buildJudgePrompt(reference: JudgeReference, candidates: readonly JudgeCandidate[]): string {
  const span = reference.lines
    ? `:${reference.lines[0]}${reference.lines[1] !== reference.lines[0] ? `-${reference.lines[1]}` : ""}`
    : "";
  const where = reference.file ? ` on ${neutralizeLine(reference.file)}${span}` : "";
  const list = candidates
    .map((c, i) => `[${i + 1}] ${neutralizeLine(c.file)}${c.line === undefined ? "" : `:${c.line}`} — ${neutralizeLine(c.claim, CLAIM_MAX_CHARS)}`)
    .join("\n");
  return [
    `## The reference comment${where}`,
    "",
    fenceUntrusted("reference-comment", "the benchmark", reference.text.trim()),
    "",
    "## The candidate comments",
    "",
    fenceUntrusted("candidate-comments", "the reviewer being scored", list),
    "",
    `Which of the candidates [1]–[${candidates.length}] identify the same underlying issue as the reference comment?`,
    "Answer with their numbers in `same_issue`, or an empty list when none do.",
  ].join("\n");
}
