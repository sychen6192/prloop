// Triage prompt: an LLM judging whether a high-false-positive tool finding is real.
//
// This is the best-evidenced hybrid pattern in the research — Semgrep 560 false positives
// down to 64, CodeQL's false-discovery rate improved by triaging alerts in context. The
// tool supplies recall (it never forgets a pattern); the model supplies the context the
// pattern matcher can't see: whether the tainted value is actually attacker-controlled,
// whether an earlier guard makes the path unreachable, whether the API is used correctly.
//
// Note the asymmetry with the skeptic: there the default is "refute", here the default is
// "drop". A tool finding nobody can justify is noise, and noise is what gets bots muted.
import { normalizePath } from "../libs/fileindex";
import type { FileDiff } from "../libs/types";

export const TRIAGE_SYSTEM = `You are deciding whether issues reported by static analysis tools deserve a developer's attention.

These tools (bandit, SpotBugs, PMD, eslint, and so on) work by rule matching: they see
patterns, not context. That gives them a high false-positive rate. Your job is to supply the
context judgment.

## Criteria

For each item, decide whether it is a **real and report-worthy** problem:

- \`keep: true\` — in this code's actual context, the problem has real impact.
- \`keep: false\` — any of the following holds:
  - the triggering path is in fact unreachable (a preceding check, a type constraint, or a
    guarantee from the caller)
  - the data source is not externally controlled (hardcoded constants, internal config, test
    data)
  - the rule misreads the language or framework semantics
  - it is pure style or convention preference with no effect on correctness or security
  - it is the conventional practice given what this file is for (e.g. assert in a test file,
    subprocess in a script)

## Severity

Tool-assigned severity usually has no context. Re-assign it by actual impact:

- critical: data loss, exploitable security hole, outage
- high: functionality breaks with no workaround
- medium: functionality breaks but a workaround exists, or it fails only on a specific path
- low: everything else

## Important

- Be conservative. **If unsure, keep: false.** The cost of a false positive is that
  developers stop reading the comments — far worse than missing one low-severity issue.
- reason must state your specific basis for the call. Do not restate the tool's message.
- Judge only the items given to you. Do not add problems of your own.`;

export interface TriageItem {
  index: number;
  tool: string;
  ruleId: string;
  message: string;
  file: string;
  line: number;
  severity: string;
}

export function buildTriagePrompt(items: TriageItem[], files: FileDiff[], contextLines: number): string {
  // Tool findings arrive re-keyed onto the diff's own paths (gates/static.ts), so this is
  // an exact lookup, not a resolution step.
  const byPath = new Map<string, FileDiff>();
  for (const f of files) byPath.set(normalizePath(f.path), f);

  const blocks = items.map((it) => {
    const fd = byPath.get(normalizePath(it.file));
    let snippet = "(no matching file content found)";
    if (fd) {
      const from = Math.max(1, it.line - contextLines);
      const to = Math.min(fd.rightLines.length, it.line + contextLines);
      const lines: string[] = [];
      for (let l = from; l <= to; l++) {
        const marker = l === it.line ? ">" : " ";
        const changed = fd.changedRightLines.has(l) ? "+" : " ";
        lines.push(`${marker}${changed} ${String(l).padStart(4)} | ${fd.rightLines[l - 1] ?? ""}`);
      }
      snippet = lines.join("\n");
    }
    return `### [${it.index}] ${it.tool} ${it.ruleId}

- File: \`${it.file}\`:${it.line}
- Tool message: ${it.message}
- Tool-assigned severity: ${it.severity}

\`\`\`
${snippet}
\`\`\``;
  });

  return `## Tool reports awaiting judgment (${items.length} total)

Line prefixes: \`>\` = the line the tool points at, \`+\` = a line changed by this PR.

${blocks.join("\n\n")}

## Your output

Emit JSON per the schema. The index of each entry in the results array must match the numbers
above, and every item must get a verdict.`;
}
