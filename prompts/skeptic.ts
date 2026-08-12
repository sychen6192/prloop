// Skeptic prompt: adversarial verification of a single finding.
//
// Two properties make this work, and both are easy to lose by accident:
//
// 1. **Cold start.** The skeptic never sees the finder's reasoning — only the claim and the
//    code. Sharing the reasoning produces anchoring: the verifier follows the finder's
//    argument instead of re-deriving it, and rubber-stamps plausible-but-wrong findings.
// 2. **Kill mandate.** The task is to *refute*, not to assess. A verifier asked "is this
//    right?" agrees; a verifier asked "prove this wrong" actually checks. Consensus among
//    agreeable verifiers is not verification.
import type { FileDiff } from "../libs/types";

export const SKEPTIC_SYSTEM = `Your task is to **refute** a code review accusation.

You are not assessing whether the accusation is good. You are trying to prove it wrong. Your
default position is "this accusation is flawed", unless you inspect the code and can find no
grounds to refute it.

## What to check

Ask yourself, in order:

1. **Are the facts right?** Does the code behavior the accusation describes match the code
   you see? Does the accusation assume something about a function's behavior that this code
   does not show?
2. **Is that path actually reachable?** What preconditions does the alleged problem need?
   Do those preconditions hold in this code's calling context, or are they blocked by an
   upstream check?
3. **Does it misread the language or framework semantics?** For example, claiming some
   construct throws when the language does not; or claiming a resource is not closed when the
   syntax itself guarantees closing.
4. **Is the severity inflated?** The problem may be real but its impact overstated (e.g.
   calling something that only affects log formatting "data loss"). Here the accusation
   stands, but severity should be lowered.

## Verdict

- \`refuted: true\` — you can state exactly where the accusation is wrong. Give the concrete
  reasoning in reason.
- \`refuted: false\` — you tried in earnest and found no grounds to refute it; the accusation
  appears to hold.

**Do not answer refuted: true just because you are unsure.** No grounds to refute means
false. Your confidence expresses how sure you are of this verdict of yours.

If you think the accusation holds but the severity is wrong, propose the level you consider
correct via \`suggested_severity\`.

You see only the accusation and the relevant code. You do not see the original reviewer's
reasoning — that is deliberate. Judge for yourself; do not try to reconstruct their thinking.`;

export interface SkepticPromptInput {
  claim: string;
  category: string;
  severity: string;
  file: FileDiff;
  // The anchor's coordinates live on this side; showing the other side's lines would have
  // the skeptic judging code the claim is not about (and refuting it for that reason).
  side: "right" | "left";
  startLine: number;
  endLine: number;
  contextLines: number;
}

// ─── Requirement-verdict skeptic ─────────────────────────────────────────────
// The requirement axis was the one model opinion in the pipeline published with no
// downstream filter, and its worst outputs are accusations: "missing" (you didn't build
// this) and "misunderstood" (you built the wrong thing) — told to an author who may have
// done neither. Both are refutable claims about the diff, so they get the same adversarial
// treatment as code findings: a different model family, cold start, kill mandate.
export const REQ_SKEPTIC_SYSTEM = `Your task is to **refute** a review verdict which claims a Pull Request fails an acceptance criterion.

You are not re-reviewing the PR. You are trying to prove this one verdict wrong by finding
concrete evidence in the diff that the criterion WAS addressed.

- Verdict "missing" is refuted by pointing at code in the diff that implements the
  criterion (quote it in reason).
- Verdict "misunderstood" is refuted by showing the implementation does match the
  criterion's actual intent (explain the match concretely).

\`refuted: true\` only with concrete evidence — quote the code. If you search honestly and
find none, answer \`refuted: false\`; do not refute out of politeness. The author's claims in
the PR description are not evidence either way. Set suggested_severity to null.`;

export function buildReqSkepticPrompt(
  criterion: string,
  verdict: string,
  note: string,
  diffPayload: string,
): string {
  return `## The verdict under challenge

- Acceptance criterion: ${criterion}
- Verdict: ${verdict}
- Reviewer's note: ${note || "(none)"}

## The full change (unified diff)

${diffPayload}

## Your task

Try to refute the verdict: search the diff for evidence that this criterion was in fact
addressed. Emit JSON per the schema.`;
}

export function buildSkepticPrompt(input: SkepticPromptInput): string {
  const { file, side, startLine, endLine, contextLines } = input;
  const lines = side === "right" ? file.rightLines : file.leftLines;
  const from = Math.max(1, startLine - contextLines);
  const to = Math.min(lines.length, endLine + contextLines);

  const snippet: string[] = [];
  for (let l = from; l <= to; l++) {
    const marker = l >= startLine && l <= endLine ? ">" : " ";
    // "Changed by this PR" only exists as a concept on the right side.
    const changed = side === "right" && file.changedRightLines.has(l) ? "+" : " ";
    snippet.push(`${marker}${changed} ${String(l).padStart(4)} | ${lines[l - 1] ?? ""}`);
  }

  const sideNote =
    side === "left"
      ? "\n\nNOTE: the accusation is about code REMOVED by this PR; the snippet shows the file BEFORE the change."
      : "";

  return `## The alleged problem

- Category: ${input.category}
- Claimed severity: ${input.severity}
- Accusation: ${input.claim}

## Relevant code

File: \`${file.path}\` (language: ${file.language})

Line prefixes: \`>\` = the line the accusation points at${side === "right" ? ", \`+\` = a line changed by this PR" : ""}.${sideNote}

\`\`\`
${snippet.join("\n")}
\`\`\`

## Your task

Try to refute the accusation above. Emit your verdict as JSON per the schema.`;
}
