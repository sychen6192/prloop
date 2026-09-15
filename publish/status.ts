// What a finished review is worth, in the two currencies that leave the process: the exit
// code CI reads, and the branch-policy status that gates the merge.
//
// They used to be computed in different files from different inputs, and they disagreed in
// exactly the case that matters. publish() decided the status from unmet criteria and
// critical/high findings alone, so a run whose finder fleet died posted
// `succeeded — Reviewed 12 files, no blockers in requirements or code`, while the same run
// exited 3 and logged "Review incomplete". A branch policy cannot see an exit code. PROPOSAL
// §10 rejected the bot vote specifically in favour of this status, which makes it the one
// artifact that decides whether an unverified PR can merge — and it was the one saying the
// PR was fine.
//
// One function, so there is no second opinion to drift. Both callers derive from its result
// rather than re-deciding: orchestrator.exitCodeFor returns `.exitCode`, publish() posts
// `.state` and `.description`.
import type { StatusState } from "../ado/statuses";

export interface ReviewOutcome {
  /** 0 clean · 2 blocking findings · 3 the review did not fully run. */
  exitCode: 0 | 2 | 3;
  state: StatusState;
  /** Worded for a reviewer looking at a red check, and budgeted for ADO's 400-char cut. */
  description: string;
}

/**
 * Blocking findings outrank incompleteness when both are true: "we found a critical bug" is
 * the stronger statement, and the incomplete stages are named in the summary and the log
 * either way. Same order as the exit code has always used, so nothing about `2` changes.
 */
export function reviewOutcome(input: {
  /** Acceptance criteria the requirement axis reports as unmet. */
  unmet: number;
  /** Inline code findings at critical or high severity. */
  highRisk: number;
  /** Every reason this review is incomplete, in the order the run recorded them. */
  incomplete: readonly string[];
  /** Only for the clean description. */
  filesReviewed: number;
}): ReviewOutcome {
  const n = input.incomplete.length;
  // Either axis can fail the check, and the description names which — a single "3 issues"
  // would hide that the real problem is a requirement nobody implemented.
  const reasons: string[] = [];
  if (input.unmet > 0) reasons.push(`${input.unmet} unmet acceptance criteria`);
  if (input.highRisk > 0) reasons.push(`${input.highRisk} high-risk code issues`);

  if (reasons.length > 0) {
    return {
      exitCode: 2,
      state: "failed",
      // The COUNT of incomplete reasons, never their text: a relayed gateway body runs to
      // 500 characters on its own (models/runner.ts) and redaction expands rather than
      // shrinks, so pasting one here would push itself past ADO's cut and take the blocking
      // reasons with it.
      description:
        reasons.join(", ") + (n > 0 ? ` — review also incomplete (${n} reason${n === 1 ? "" : "s"})` : ""),
    };
  }

  if (n > 0) {
    return {
      exitCode: 3,
      state: "error",
      // The count goes in the PREFIX, where ADO's 400-char truncation cannot reach it. Put
      // at the end as a "(+N more)" tail it would be the first thing deleted, and precisely
      // on the reason type that is routinely long.
      description: `Review incomplete (${n} reason${n === 1 ? "" : "s"}): ${(input.incomplete[0] ?? "").slice(0, 300)}`,
    };
  }

  return {
    exitCode: 0,
    state: "succeeded",
    description: `Reviewed ${input.filesReviewed} files, no blockers in requirements or code`,
  };
}
