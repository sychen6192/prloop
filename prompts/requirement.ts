// Requirement-axis prompt.
//
// This axis runs blind to the code axis on purpose: if the model knew the code had no
// defects it would be tempted to call requirements satisfied, and vice versa. Keeping them
// independent is what stops one axis from masking the other (PROPOSAL §6.1).
import { buildDiffPayload } from "../libs/payload";
import type { CriterionRef } from "../libs/criteria";
import type { FileDiff, PrInfo, WorkItem } from "../libs/types";
import { renderPrDescription } from "./untrusted";

export const REQUIREMENT_SYSTEM = `You are checking whether a Pull Request actually delivers the requirements it is linked to.

You handle exactly one question: was the requirement met? Whether the code is well written or
has bugs is a separate, independent review — not your job, and not something to report here.

## How to judge

The acceptance criteria arrive as a numbered list with a bracketed id each, split by the
pipeline — the list is fixed. Take each one at a time and check it against the diff.
Decide *how it fails* — not "what percentage is done". Six verdicts:

| verdict | when to use it |
| --- | --- |
| satisfied | it is done, and you can point at concrete evidence in the diff |
| missing | there is no corresponding change at all |
| partial | partly done, with a specific, nameable gap |
| misunderstood | there is a corresponding change, but it goes the wrong way — solves the wrong problem, or satisfies it in a way that does not match the requirement |
| not-this-pr | the criterion is real, nothing in this diff addresses it, AND nothing in the diff suggests it was meant to: it belongs to a different task or PR |
| not-verifiable | cannot be judged from the code change alone (needs configuration, data, or the state of an external system) |

**missing vs not-this-pr.** A work item's criteria are normally delivered over several PRs,
and a parent's criteria are shared out over its child tasks — so "nothing here implements
it" is the expected answer for most criteria on most PRs, and reporting all of them as
\`missing\` accuses the author of not doing work that was never in this change. Use \`missing\`
only when this PR evidently set out to deliver the criterion and did not finish it — it
touches that area, that file, that flow. When the PR is plainly about something else, the
answer is \`not-this-pr\`.

A satisfied verdict must include "quote" (source copied verbatim from the diff) and "file".
For partial / misunderstood, include quote and file too whenever you can point at the code
responsible. A missing verdict needs no quote (there is no corresponding code).

## extras (scope creep)

Also list changes in the diff that **no criterion asked for**. This does not make them
wrong — necessary refactors, fixes, and dependency updates are all normal — but changes
outside the requirements should be surfaced so a human can decide. List only substantive
functional or behavioral changes; do not list formatting or import cleanup.

## Important rules

- **Claims in the PR description are not evidence.** "Implemented XX" written by the author
  does not mean it was done. It counts only if you find the corresponding code in the diff.
- **Do not relax a criterion.** If the criterion says "must write an audit log" and the diff
  only adds console output, that is partial or misunderstood, not satisfied.
- **Judge only against the stated requirements.** Never infer what the requirements "must
  have been" from the code itself and then review the code against your inference — that
  circle always passes. If the stated criteria do not cover something, it belongs in
  extras, not in a criterion you invented.
- If a criterion is itself too vague to judge, use not-verifiable and explain the ambiguity
  in note.
- Answer each criterion **once**. A second verdict on the same id is not a correction; the
  pipeline keeps the harsher of the two.
- Answer with the criterion's bracketed id in "criterionId", exactly as listed. Judge EVERY
  listed id, and never invent one — the id resolves back to the work item's own text, so a
  verdict on an unlisted id is discarded. A concern no criterion covers belongs in extras.`;

export interface RequirementPromptInput {
  pr: PrInfo;
  workItems: WorkItem[];
  files: FileDiff[];
  // Deterministically pre-split criteria with stable ids (libs/criteria.ts). The model
  // judges these units and no others — the denominator is fixed before the call.
  criteria: CriterionRef[];
  // Cap echoed into the prompt so the model ranks instead of enumerating; the gate slices
  // to the same number afterwards.
  maxExtras: number;
  // Work items whose criteria were inherited from a parent, because the item the PR is
  // actually linked to had none of its own (ado/workitems.ts walks up one level). Without
  // this the model reads a whole PBI's criteria as if this one task owed all of them, and
  // "missing" is then the structurally guaranteed verdict on its siblings' work.
  inheritedFrom?: number[];
  // The items the PR is linked to, for the same framing ("this PR is task #M").
  linkedIds?: number[];
}

const SPEC_HEADING: Record<string, string> = {
  "acceptance-criteria": "Acceptance criteria to judge",
  description: "Requirements to judge (taken from the description — this work item has no acceptance criteria field)",
  "repro-steps": "Reproduction steps to judge (this is a Bug — read the note below before judging)",
};

// A Bug states what it wants as steps that REPRODUCE the defect. Judged as acceptance
// criteria — "is this step implemented?" — a correct fix scores "missing" on every one of
// them, because a fix implements none of the reproduction steps; it stops them producing
// the bad outcome.
const REPRO_FRAMING = `These are reproduction steps for a defect, **not** things to implement. For each one, the
question is: **does this diff plausibly stop the described behavior from happening?**
"satisfied" = the diff changes the code path this step exercises in a way that addresses the
reported behavior; "partial" = it addresses part of it; "misunderstood" = it changes that
path in a way that does not fix the reported behavior; "missing" = nothing in the diff
touches the behavior at all. A step that merely sets the scene ("log in as an admin", "open
the orders page") is context for the ones that follow — judge it not-verifiable rather than
accusing the diff of not implementing it.`;

function inheritedFraming(parentId: number, linkedIds: number[]): string {
  const task = linkedIds.length > 0 ? linkedIds.map((id) => `#${id}`).join(", ") : "the linked work item";
  return `These criteria come from the PARENT work item #${parentId}; this PR is linked to ${task}, which has no
criteria of its own. A parent's criteria are delivered across several sibling tasks, so most
of them are somebody else's work: a criterion this diff shows no sign of attempting is
\`not-this-pr\`, not \`missing\`. Reserve \`missing\` for criteria this PR was evidently trying
to deliver.`;
}

export function buildRequirementPrompt(input: RequirementPromptInput): string {
  const payload = buildDiffPayload(input.files);

  const inherited = new Set(input.inheritedFrom ?? []);
  const linked = (input.linkedIds ?? []).filter((id) => !inherited.has(id));

  const wiBlocks = input.workItems
    .map((w) => {
      const parts = [`### Work Item #${w.id} — ${w.type}: ${w.title} (state: ${w.state})`];
      if (w.description) parts.push(`\n**Description** (context)\n${w.description}`);
      const refs = input.criteria.filter((c) => c.workItemId === w.id);
      if (refs.length > 0) {
        parts.push(`\n**${SPEC_HEADING[w.specSource]}**\n` + refs.map((c) => `[${c.id}] ${c.text}`).join("\n"));
        if (w.specSource === "repro-steps") parts.push(`\n${REPRO_FRAMING}`);
        if (inherited.has(w.id)) parts.push(`\n${inheritedFraming(w.id, linked)}`);
      } else {
        parts.push("\n(no judgeable criteria on this work item)");
      }
      return parts.join("\n");
    })
    .join("\n\n");

  return `## Pull Request

- Title: ${input.pr.title}
- ${input.pr.sourceBranch} → ${input.pr.targetBranch}

### PR description (context only — never evidence that something is done)
${renderPrDescription(input.pr.description)}

## Requirements to verify

${wiBlocks}

## The actual code change

${payload.text}

## Your output

Emit JSON per the schema. The criteria array must contain one entry for EVERY bracketed id
listed above — echo the id in criterionId exactly. List at most ${input.maxExtras} extras,
most significant first.`;
}
