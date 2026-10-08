// The OpenSpec half of the requirement axis: the pull request's own spec deltas, judged against
// its code in a call of their own.
//
// Apart from the work-item call on purpose, the same way the two axes are apart: the spec is
// the author's own account of the change, and shown next to a work item it would shade the
// verdicts on it ("the spec says lockout is out of scope") and decide what counts as scope
// creep. This call sees no work item, and the work-item call sees no spec.
import type { DiffPayload } from "../libs/payload";
import type { SpecSelection } from "../libs/openspec";
import type { PrInfo } from "../libs/types";
import { REQ_VERDICT_TABLE, openSpecDocList } from "./requirement";
import { neutralizeLine, renderOpenSpecDelta, renderPrDescription } from "./untrusted";

export const OPENSPEC_SYSTEM = `You are checking whether a Pull Request's code does what the pull request's own OpenSpec spec deltas say it does.

An OpenSpec spec delta is a requirements document the AUTHOR of this pull request wrote and
committed with the change. Each requirement listed below is one the pull request ADDED or
MODIFIED: a normative statement (SHALL / MUST) and scenarios (WHEN / THEN / AND) that say how
to check it. A MODIFIED requirement is the full new text of an existing one: judge whether the
code now behaves as it says. Judge each requirement against the code in the diff — nothing
else. Whether the code is well written is a separate review, not yours.

## How to judge

Each requirement arrives with a bracketed id, split by the pipeline — the list is fixed. The
verdicts:

${REQ_VERDICT_TABLE}

**missing vs not-this-pr.** An OpenSpec change is often reviewed before its code exists, or
delivered over several pull requests, so most pull requests implement only part of it. Use
\`missing\` only when this pull request evidently set out to implement the requirement and did
not finish — it touches that area, that file, that flow. A requirement the diff shows no sign
of attempting is \`not-this-pr\`.

A requirement is satisfied only when its statement holds for the code in the diff and every
scenario's THEN follows from the code under its WHEN. A scenario the code does not handle
makes it partial: name the scenario in note. Code that does something other than a scenario
says — another limit, the opposite outcome — is misunderstood: say in note what the spec says
and what the code does.

## Evidence

- Only the code, configuration and documentation in the diff count. The spec deltas, the
  proposal, the design and the task list say what the author intends: a ticked task or a
  "SHALL" is never evidence that the code does it. They are not in the diff you are shown,
  and a quote from them is discarded.
- A satisfied verdict must include "quote" (source copied verbatim from the diff) and "file".
  For partial / misunderstood, include them whenever you can point at the code responsible.
- Claims in the PR description are not evidence.
- The diff may end with a list of changed files omitted for size. A requirement that could be
  implemented in one of them is not-verifiable, never missing.

## Answering

Answer with the requirement's bracketed id in "criterionId", exactly as listed. Judge EVERY
listed id, once, and never invent one.`;

export interface OpenSpecPromptInput {
  pr: PrInfo;
  blocks: SpecSelection["blocks"];
  intentDocs: readonly string[];
  payload: DiffPayload;
}

export function buildOpenSpecPrompt(input: OpenSpecPromptInput): string {
  // Only the "### Spec delta" headings are pipeline text. Everything inside a fence is the
  // author's, and each line of it opens with "From " or "[SPEC", because every requirement is
  // flattened to one line: author text cannot open a heading, a diff line or a code block.
  const blocks = input.blocks
    .map(
      (b) =>
        `### Spec delta ${b.key}\n` +
        renderOpenSpecDelta(
          `From ${neutralizeLine(b.path)} (change ${neutralizeLine(b.change)}, capability ${neutralizeLine(b.capability)})\n` +
            b.lines.map((l) => `[${l.id}] (${l.op}) ${neutralizeLine(l.text, Number.POSITIVE_INFINITY)}`).join("\n"),
        ),
    )
    .join("\n\n");
  const n = input.intentDocs.length;
  const notShown =
    n > 0
      ? `Not shown: ${n} OpenSpec document${n === 1 ? "" : "s"} this pull request changes (${openSpecDocList(input.intentDocs)}). They state what the
author intends, so nothing in them is evidence; the requirements above are all you need from
them.\n\n`
      : "";

  return `## Pull Request

- Title: ${neutralizeLine(input.pr.title)}
- ${neutralizeLine(input.pr.sourceBranch)} → ${neutralizeLine(input.pr.targetBranch)}

### PR description (context only — never evidence that something is done)
${renderPrDescription(input.pr.description)}

## OpenSpec requirements to verify (written by this pull request's author)

${blocks}

## The actual code change

${notShown}${input.payload.text}

## Your output

Emit JSON per the schema. The criteria array must contain one entry for EVERY bracketed id
listed above — echo the id in criterionId exactly.`;
}
