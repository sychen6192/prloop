// Builders the selftest modules share: a FileDiff from lines, a finding with defaults, a
// tool spec, an empty candidate set, and anchoring over bare FileDiff arrays.
import { anchorFinding as anchorWithIndex } from "../../anchoring/locate";
import { FileIndex } from "../../libs/fileindex";
import { buildHunks, diffLines } from "../../libs/diff";
import { detectLanguage } from "../../libs/lang";
import type { ToolSpec } from "../../profiles/types";
import type { FileDiff, RawFinding } from "../../libs/types";

// The production anchorFinding takes a FileIndex; fixtures here carry bare FileDiff
// arrays, so this wrapper builds the index at the call site.
export const anchorFinding = (finding: RawFinding, files: FileDiff[]) =>
  anchorWithIndex(finding, new FileIndex(files));

export function mkFile(path: string, rightLines: string[], changed: number[]): FileDiff {
  const leftLines = rightLines.filter((_, i) => !changed.includes(i + 1));
  const edits = diffLines(leftLines, rightLines);
  const { hunks, changedRightLines, changedLeftLines } = buildHunks(leftLines, rightLines, edits);
  return {
    path,
    changeType: "edit",
    hunks,
    rightLines,
    leftLines,
    changedRightLines: changedRightLines.size ? changedRightLines : new Set(changed),
    changedLeftLines: new Set(),
    binary: false,
    truncated: false,
    language: detectLanguage(path),
  };
}

export function mkFinding(over: Partial<RawFinding>): RawFinding {
  return {
    category: "logic",
    severity: "high",
    confidence: 0.8,
    file: "/src/app.ts",
    quote: "",
    claim: "test",
    side: "right",
    ...over,
  };
}

export const spec = (format: string): ToolSpec =>
  ({ name: "t", bin: "t", args: () => [], format, tier: "triage" }) as ToolSpec;

// finalize() takes the anchoring stage's output; these sections only exercise the
// corroboration rule, so they hand it an empty candidate set.
export const EMPTY_CANDIDATES = { merged: [], degraded: [], rawCount: 0, byFailure: {}, excluded: 0 };
