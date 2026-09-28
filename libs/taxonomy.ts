// The review's own vocabulary: how bad a finding is, and what kind of problem it is. Not
// configuration — nothing here is a setting — so it lives apart from config.ts, which reads
// knobs, and every stage that grades or files a finding imports it from here.

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

// Finding categories. Aligned with the taxonomy commercial reviewers converged on
// (CodeRabbit's six content categories), plus three we keep separate on purpose:
//   concurrency    — folded into "reliability" elsewhere, but it's the dominant defect
//                    class in the Java codebases this tool targets, and it needs its own
//                    review lens rather than being diluted into general reliability
//   leftover-code  — debug prints, commented-out blocks, stray TODOs. Only Graphite names
//                    this, and it's consistently one of the highest-acceptance finding types
//   req-mismatch   — reserved for M2: the change doesn't satisfy the linked work item
export const FINDING_CATEGORIES = [
  "correctness",
  "concurrency",
  "security",
  "reliability",
  "data-integrity",
  "performance",
  "maintainability",
  "leftover-code",
  "req-mismatch",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

// What the code-axis finder may emit: everything except req-mismatch, which only the
// requirement axis produces (gates/requirement.ts builds those findings itself, with the
// acceptance criteria in hand). Offering it in the finder's schema invited the code axis to
// guess at requirements it never saw — and the prompt then promised "nine" categories while
// its table listed eight. Schema enum, validator and prompt all derive from this list.
export const FINDER_CATEGORIES = FINDING_CATEGORIES.filter(
  (c): c is Exclude<FindingCategory, "req-mismatch"> => c !== "req-mismatch",
);
export type FinderCategory = (typeof FINDER_CATEGORIES)[number];
