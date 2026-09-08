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

- \`verdict: "refuted"\` — you can state exactly where the accusation is wrong. Give the
  concrete reasoning in reason, and copy the line(s) that prove it, verbatim from the code
  above, into \`evidence_quote\`. A refutation with no quote from the shown code is discarded.
- \`verdict: "holds"\` — you could see everything the accusation is about, tried in earnest,
  and found no grounds to refute it.
- \`verdict: "insufficient-context"\` — the accusation turns on code you were NOT shown:
  another file, the callers of this function, a line this PR deleted, a runtime
  configuration, behavior of a library whose source is not here. Say in reason what you
  would have needed to see.

"insufficient-context" is a real, expected answer, not a cop-out — say it whenever checking
the claim would take code that is not in front of you. Guessing in either direction is worse
than admitting the limit: a finding you cannot check is neither killed nor confirmed by you.

**Do not answer "refuted" just because you are unsure.** No grounds to refute means
"holds"; nothing to look at means "insufficient-context". Your confidence expresses how sure
you are of this verdict of yours.

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

\`verdict: "refuted"\` only with concrete evidence — quote the implementing code in
\`evidence_quote\` as well as in reason. If you search honestly and find none, answer
\`verdict: "holds"\`; do not refute out of politeness. Answer \`verdict:
"insufficient-context"\` when judging the criterion would need code the diff does not show.
The author's claims in the PR description are not evidence either way. Set
suggested_severity to null.`;

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

export interface SkepticPrompt {
  prompt: string;
  // Exactly the source text the skeptic was shown, gutters and diff markers stripped. The
  // gate matches a refutation's evidence_quote against this: "refuted only with concrete
  // evidence" was prompt text with nothing enforcing it, and the check needs to know what
  // "shown" means without re-deriving the window.
  snippet: string;
}

export function buildSkepticPrompt(input: SkepticPromptInput): SkepticPrompt {
  const { file, side, startLine, endLine, contextLines } = input;
  const lines = side === "right" ? file.rightLines : file.leftLines;
  const from = Math.max(1, startLine - contextLines);
  const to = Math.min(lines.length, endLine + contextLines);

  const snippet: string[] = [];
  const shown: string[] = [];
  for (let l = from; l <= to; l++) {
    const marker = l >= startLine && l <= endLine ? ">" : " ";
    // "Changed by this PR" only exists as a concept on the right side.
    const changed = side === "right" && file.changedRightLines.has(l) ? "+" : " ";
    snippet.push(`${marker}${changed} ${String(l).padStart(4)} | ${lines[l - 1] ?? ""}`);
    shown.push(lines[l - 1] ?? "");
  }

  // The window shows ONE side. A claim about a line this PR deleted, or about the change
  // itself rather than the resulting file, was uncheckable from it — and an uncheckable
  // claim now comes back "insufficient-context", which clears nothing. The hunk carries
  // both sides, so the third answer stays a judgment about the claim instead of an
  // artifact of the window size.
  const hunk = file.hunks.find((h) =>
    side === "right"
      ? startLine <= h.rightStart + h.rightCount - 1 && endLine >= h.rightStart
      : startLine <= h.leftStart + h.leftCount - 1 && endLine >= h.leftStart,
  );
  const hunkBlock = hunk
    ? `\n\n## The change itself (both sides of this hunk)\n\n\`\`\`diff\n${hunk.body}\n\`\`\``
    : "";
  if (hunk) {
    // Diff markers are not part of the source; a model copying an evidence line verbatim
    // may or may not keep the leading +/-/space, so the corpus holds the bare text.
    for (const l of hunk.body.split("\n")) shown.push(l.replace(/^[+\- ]/, ""));
  }

  const sideNote =
    side === "left"
      ? "\n\nNOTE: the accusation is about code REMOVED by this PR; the snippet shows the file BEFORE the change."
      : "";

  const prompt = `## The alleged problem

- Category: ${input.category}
- Claimed severity: ${input.severity}
- Accusation: ${input.claim}

## Relevant code

File: \`${file.path}\` (language: ${file.language})

Line prefixes: \`>\` = the line the accusation points at${side === "right" ? ", \`+\` = a line changed by this PR" : ""}.${sideNote}

\`\`\`
${snippet.join("\n")}
\`\`\`${hunkBlock}

## Your task

Try to refute the accusation above. If the accusation turns on code that is not shown here,
answer "insufficient-context" rather than guessing. Emit your verdict as JSON per the schema.`;

  return { prompt, snippet: shown.join("\n") };
}
