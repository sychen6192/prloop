// Comment rendering. Every comment carries hidden markers so re-runs can recognise their
// own threads: the bot marker identifies authorship, the fingerprint identifies the issue.
import { BOT_MARKER, MAX_INLINE_COMMENTS, MIN_INLINE_SEVERITY, excludedCategories } from "../config";
import { detectLanguage } from "../libs/lang";
import type { AnchoredFinding, ReqVerdict, RequirementResult } from "../libs/types";
import type { AggregateResult } from "../gates/aggregate";
import type { CategoryHint } from "../libs/learnings";
import type { ReviewContext } from "../ado/intake";
import type { StaticResult } from "../gates/static";

export const SUMMARY_MARKER = "<!-- prloop:summary -->";
export const fpMarker = (fp: string) => `<!-- prloop:fp=${fp} -->`;
// Lets a dismissal be attributed to a category later without re-deriving it from prose —
// the raw material for "the team keeps dismissing category X" hints.
export const catMarker = (cat: string) => `<!-- prloop:cat=${cat} -->`;

const SEVERITY_LABEL: Record<string, string> = {
  critical: "🔴 Critical",
  high: "🟠 High",
  medium: "🟡 Medium",
  low: "⚪ Low",
};

const CATEGORY_LABEL: Record<string, string> = {
  correctness: "🎯 Correctness",
  concurrency: "🔀 Concurrency",
  security: "🔒 Security",
  reliability: "🩺 Reliability",
  "data-integrity": "🗄️ Data integrity",
  performance: "🚀 Performance",
  maintainability: "📐 Maintainability",
  "leftover-code": "🧹 Leftover code",
  "req-mismatch": "📋 Unmet requirement",
};

// Why a finding never became an inline comment. Stated explicitly so a suppressed finding
// never reads as "nothing else was found".
const SUPPRESSED_LABEL: Record<string, string> = {
  severity: `below the ${MIN_INLINE_SEVERITY} comment threshold`,
  cap: `over the ${MAX_INLINE_COMMENTS}-per-run cap`,
  "no-corroboration": "single model, unverified - no corroboration",
  dismissed: "matches a finding a reviewer previously dismissed (wontFix/byDesign)",
};

const FAILURE_LABEL: Record<string, string> = {
  "quote-not-found": "quoted code not found in the file",
  "quote-ambiguous": "quoted code appears more than once, location ambiguous",
  "file-not-in-diff": "file not in this change",
  "outside-changed-lines": "outside the changed region",
};

// ADO's markdown renderer drops the disclosure widget if the <summary> tag spans more than
// one line, so the whole opening tag has to be emitted as a single string.
const detailsOpen = (title: string) => `<details><summary>${title}</summary>`;

export function renderFindingComment(f: AnchoredFinding): string {
  const parts: string[] = [
    `${BOT_MARKER}${fpMarker(f.fingerprint)}${catMarker(f.category)}`,
    `**${SEVERITY_LABEL[f.severity] ?? f.severity}** · ${CATEGORY_LABEL[f.category] ?? f.category}`,
    "",
    f.claim,
  ];
  if (f.evidence) parts.push("", f.evidence);
  if (f.suggested_fix) {
    // Tag the fence with the file's language: the field is contracted to be code, and an
    // untagged block renders it as flat grey text right where a reviewer is comparing it
    // against the highlighted source above.
    const lang = detectLanguage(f.file);
    // Drop surrounding blank lines, never leading indentation: trim() flattened the first
    // line against the left margin while every line below kept its indent, so a fix that is
    // contracted to be paste-ready arrived misaligned.
    const body = f.suggested_fix.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "");
    parts.push("", "**Suggested fix**", "", `\`\`\`${lang === "other" ? "" : lang}`, body, "```");
  }
  const conf = Math.round(f.confidence * 100);
  const bits: string[] = [`confidence ${conf}%`];
  bits.push(f.sources.length > 1 ? `found independently by ${f.sources.length} models` : f.sources[0] ?? "");
  if (f.skepticVerdicts) {
    bits.push(
      f.skepticRefuted
        ? `${f.skepticVerdicts} rounds of adversarial verification (${f.skepticRefuted} dissenting)`
        : `passed ${f.skepticVerdicts} rounds of adversarial verification`,
    );
  }
  parts.push("", `<sub>${bits.filter(Boolean).join(" | ")}</sub>`);
  return parts.join("\n");
}

export interface SummaryInput {
  ctx: ReviewContext;
  agg: AggregateResult;
  req?: RequirementResult;
  finderErrors: Array<{ model: string; error: string }>;
  omittedFiles: string[];
  appliedRules: string[];
  staticResult?: StaticResult;
  // "The team keeps dismissing category X" — surfaced as a config suggestion, never applied.
  dismissalHints?: CategoryHint[];
  durationSec: number;
  runDir: string;
}

const REQ_LABEL: Record<ReqVerdict, string> = {
  satisfied: "✅ Satisfied",
  missing: "❌ Not implemented",
  partial: "⚠️ Partial",
  misunderstood: "🔄 Wrong direction",
  "not-verifiable": "❓ Not verifiable from code",
};

// The requirement axis gets its own block above the code axis, with its own verdict.
// Deliberately not merged into the findings table: a shared ranking lets code findings
// bury "this requirement was never implemented" (PROPOSAL §6.1).
function renderRequirementSection(req: RequirementResult | undefined): string[] {
  const lines: string[] = ["### 📋 Requirement check", ""];

  if (!req || req.skipped) {
    lines.push(`_${req?.skipped ?? "not run"}_`, "");
    return lines;
  }
  if (req.error) {
    lines.push(`_Requirement check did not complete: ${req.error}_`, "");
    return lines;
  }
  if (req.criteria.length === 0) {
    lines.push("_No acceptance criteria to check against_", "");
    return lines;
  }

  const unmet = req.criteria.filter(
    (c) => c.verdict === "missing" || c.verdict === "partial" || c.verdict === "misunderstood",
  );
  const wiList = req.workItems.map((w) => `#${w.id}`).join(", ");
  lines.push(
    unmet.length === 0
      ? `✅ **All ${req.criteria.length} acceptance criteria for ${wiList} are implemented.**`
      : `⚠️ **${unmet.length}/${req.criteria.length} acceptance criteria for ${wiList} are unmet.**`,
    "",
    "| Status | Acceptance criterion | Note |",
    "| --- | --- | --- |",
  );
  for (const c of req.criteria) {
    const loc = c.file ? ` (\`${c.file}\`)` : "";
    lines.push(
      `| ${REQ_LABEL[c.verdict]} | ${escapeCell(c.criterion)} | ${escapeCell(c.note)}${loc} |`,
    );
  }
  lines.push("");

  if (req.extras.length > 0) {
    lines.push(
      detailsOpen(`Out-of-scope changes (${req.extras.length}) - not necessarily wrong, but worth confirming they are intentional`),
      "",
    );
    for (const e of req.extras) lines.push(`- \`${e.file}\` — ${e.claim}`);
    lines.push("", "</details>", "");
  }
  return lines;
}

export function renderSummary(input: SummaryInput): string {
  const { ctx, agg } = input;
  const lines: string[] = [
    `${BOT_MARKER}${SUMMARY_MARKER}`,
    `## 🔍 prloop automated review`,
    "",
  ];

  const scope =
    ctx.compareTo > 0
      ? `iteration ${ctx.compareTo} → ${ctx.iteration.id} (incremental)`
      : `iteration ${ctx.iteration.id} (full PR)`;
  lines.push(
    `Scope: ${scope} | ${ctx.files.length} files changed | ${input.durationSec}s`,
    "",
  );

  lines.push(...renderRequirementSection(input.req));

  lines.push("### 🔍 Code check", "");

  // The no-comment path is a feature: silence on a clean PR is what makes the noisy runs
  // worth reading.
  if (agg.inline.length === 0 && agg.belowBar.length === 0 && agg.degraded.length === 0) {
    lines.push("✅ **No issues found.**", "");
  } else if (agg.inline.length === 0) {
    lines.push("✅ **No issues above the reporting threshold.**", "");
  } else {
    lines.push(`Found **${agg.inline.length}** issues worth attention, commented on the relevant lines.`, "");
    const bySeverity = new Map<string, number>();
    for (const f of agg.inline) bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
    const order = ["critical", "high", "medium", "low"];
    const counts = order
      .filter((s) => bySeverity.has(s))
      .map((s) => `${SEVERITY_LABEL[s]} ${bySeverity.get(s)}`)
      .join(" | ");
    if (counts) lines.push(counts, "");
    lines.push("| Severity | File | Issue |", "| --- | --- | --- |");
    for (const f of agg.inline) {
      const loc = f.anchor ? `${f.file}:${f.anchor.startLine}` : f.file;
      lines.push(`| ${SEVERITY_LABEL[f.severity] ?? f.severity} | \`${loc}\` | ${escapeCell(f.claim)} |`);
    }
    lines.push("");
  }

  if (agg.belowBar.length > 0) {
    lines.push(detailsOpen(`Other findings, not commented (${agg.belowBar.length})`), "");
    for (const f of agg.belowBar) {
      const loc = f.anchor ? `${f.file}:${f.anchor.startLine}` : f.file;
      lines.push(`- **${f.severity}** \`${loc}\` — ${f.claim}`, `  <sub>${SUPPRESSED_LABEL[f.suppressedBy ?? ""] ?? "below the reporting threshold"}</sub>`);
    }
    lines.push("", "</details>", "");
  }

  // Degraded findings are surfaced rather than dropped, but never posted inline: the whole
  // point is that we don't guess a line when the quote didn't locate.
  if (agg.degraded.length > 0) {
    lines.push(
      detailsOpen(`Findings with no locatable line (${agg.degraded.length}) - not posted, to avoid landing on the wrong line`),
      "",
    );
    for (const f of agg.degraded) {
      const why = FAILURE_LABEL[f.anchorFailure ?? ""] ?? f.anchorFailure ?? "unknown reason";
      lines.push(`- **${f.severity}** \`${f.file}\` — ${f.claim}`, `  <sub>${why}</sub>`);
    }
    lines.push("", "</details>", "");
  }

  const notes: string[] = [];
  if (input.omittedFiles.length > 0) {
    notes.push(`Diff size limit: ${input.omittedFiles.length} files left out of this analysis: ${input.omittedFiles.slice(0, 10).join(", ")}${input.omittedFiles.length > 10 ? " and more" : ""}`);
  }
  if (ctx.skipped.length > 0) {
    notes.push(`Skipped ${ctx.skipped.length} non-code/generated files`);
  }
  if (input.appliedRules.length > 0) {
    notes.push(`Review rules applied: ${input.appliedRules.join(", ")}`);
  }
  const sr = input.staticResult;
  if (sr?.skippedReason) {
    notes.push(`Static analysis not run: ${sr.skippedReason}`);
  } else if (sr && sr.ranTools.length > 0) {
    notes.push(
      `Static analysis tools: ${sr.ranTools.join(", ")}` +
        (sr.suppressedCount > 0 ? ` (${sr.suppressedCount} style issues not commented, left to the linter)` : ""),
    );
    for (const s of sr.skipped) notes.push(`Skipped tool ${s.tool}: ${s.reason}`);
  }
  if (sr && sr.unresolved > 0 && !sr.skippedReason) {
    notes.push(
      `${sr.unresolved} tool findings had paths that resolved to no changed file, so they were not commented`,
    );
  }
  if (sr && sr.staleFiles.length > 0 && !sr.skippedReason) {
    notes.push(
      `Static analysis skipped ${sr.staleFiles.length} files: the PRR_WORKDIR checkout of them ` +
        `differs from the code under review, so any line number a tool reported would be wrong`,
    );
  }
  for (const e of input.finderErrors) {
    notes.push(`Model ${e.model} produced no result: ${e.error}`);
  }
  if (agg.stats.excluded > 0) {
    notes.push(
      `${agg.stats.excluded} findings dropped, category excluded by config (PRR_EXCLUDE_CATEGORIES=${excludedCategories().join(",")})`,
    );
  }
  for (const h of input.dismissalHints ?? []) {
    notes.push(
      `Reviewers have dismissed ${h.count} ${h.category} findings in this repo — if that category ` +
        `is not wanted here, set PRR_EXCLUDE_CATEGORIES=${h.category} to stop reporting it`,
    );
  }
  if (agg.stats.raw > 0) {
    // stats.refuted, not anchored - survived: survived includes merged tool findings, so
    // the subtraction went negative on exactly the runs with static analysis enabled and
    // silently hid the refutation count.
    notes.push(
      `raw findings ${agg.stats.raw} → deduped ${agg.stats.afterDedupe} → anchored ${agg.stats.anchored}` +
        (agg.stats.refuted > 0
          ? ` → ${agg.stats.refuted} refuted by adversarial verification, ${agg.stats.survived} survived`
          : ""),
    );
  }
  // The per-reason breakdown, not just the count. "10 findings were not posted" is not
  // actionable on its own; "10, all quote-not-found" points straight at the finder prompt.
  const failures = Object.entries(agg.stats.byFailure).sort((a, b) => b[1] - a[1]);
  if (failures.length > 0) {
    notes.push(
      `Anchoring failures: ${failures.map(([k, v]) => `${FAILURE_LABEL[k] ?? k} ${v}`).join(", ")}`,
    );
  }
  if (notes.length > 0) {
    lines.push(detailsOpen("Run notes"), "");
    for (const n of notes) lines.push(`- ${n}`);
    lines.push("", "</details>", "");
  }

  lines.push(`<sub>prloop · this comment updates on every push</sub>`);
  return lines.join("\n");
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}
