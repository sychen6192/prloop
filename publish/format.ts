// Comment rendering. Every comment carries hidden markers so re-runs can recognise their
// own threads: the bot marker identifies authorship, the fingerprint identifies the issue.
import { MAX_INLINE_COMMENTS, MIN_INLINE_SEVERITY, excludedCategories } from "../config";
import { defuseHtmlComments, findingMarkers, summaryMarkers, type SpanMark } from "./markers";
import { UNKNOWN_FILE_TYPE, detectLanguage } from "../libs/lang";
import { redactSecrets } from "../libs/redact";
import type { AnchoredFinding, ReqVerdict, RequirementResult } from "../libs/types";
import type { AggregateResult } from "../gates/aggregate";
import type { CategoryHint } from "../libs/learnings";
import type { ThreadTally, WatermarkDecision } from "./lifecycle";
import type { ReviewContext } from "../ado/intake";
import type { StaticResult } from "../gates/static";
import { sanitizeToolMessage } from "../prompts/untrusted";

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

function whyNotCommented(f: AnchoredFinding): string {
  if (f.suppressedBy === "silenced") {
    return `the line carries \`${f.silencedBy ?? "a suppression marker"}\`, a check its author already silenced there`;
  }
  return SUPPRESSED_LABEL[f.suppressedBy ?? ""] ?? "below the reporting threshold";
}

// Enough to see what broke and where; the rest is one file away in the run directory.
const BROKE_SHOWN = 20;

const FAILURE_LABEL: Record<string, string> = {
  "quote-not-found": "quoted code not found in the file",
  "quote-ambiguous": "quoted code appears more than once, location ambiguous",
  "file-not-in-diff": "file not in this change",
  "file-ambiguous": "path matches more than one changed file, refusing to guess which",
  "outside-changed-lines": "outside the changed region",
};

// ADO's markdown renderer drops the disclosure widget if the <summary> tag spans more than
// one line, so the whole opening tag has to be emitted as a single string.
const detailsOpen = (title: string) => `<details><summary>${title}</summary>`;

/**
 * A backtick fence longer than any backtick run inside `code`, so nothing in it can close
 * the block. A fix carrying ``` of its own — a markdown file, a template literal — ended a
 * fixed three-backtick block early, and everything after rendered as markdown, live markup
 * included, in a comment prloop signed.
 */
function codeFence(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** The static-analysis tool behind a finding, or undefined for a model's. */
export function toolOf(f: AnchoredFinding): string | undefined {
  return f.tier === undefined ? undefined : f.rule?.split(":")[0] || f.sources[0];
}

export function renderFindingComment(f: AnchoredFinding, span?: SpanMark): string {
  const parts: string[] = [
    `**${SEVERITY_LABEL[f.severity] ?? f.severity}** · ${CATEGORY_LABEL[f.category] ?? f.category}`,
    "",
    f.claim,
  ];
  if (f.evidence) parts.push("", f.evidence);
  let fix: string[] = [];
  if (f.suggested_fix) {
    // Tag the fence with the file's language: the field is contracted to be code, and an
    // untagged block renders it as flat grey text right where a reviewer is comparing it
    // against the highlighted source above.
    const lang = detectLanguage(f.file);
    // Drop surrounding blank lines, never leading indentation: trim() flattened the first
    // line against the left margin while every line below kept its indent, so a fix that is
    // contracted to be paste-ready arrived misaligned.
    const body = f.suggested_fix.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "");
    const fence = codeFence(body);
    fix = ["", "**Suggested fix**", "", `${fence}${lang === "other" ? "" : lang}`, body, fence];
  }
  const conf = Math.round(f.confidence * 100);
  const bits: string[] = [`confidence ${conf}%`];
  bits.push(f.sources.length > 1 ? `found independently by ${f.sources.length} models` : f.sources[0] ?? "");
  // Named so the reader knows the line was busy, worded so it cannot be read as agreement.
  if (f.overlapping?.length) {
    bits.push(`${f.overlapping.join(", ")} flagged these lines with a different claim (not counted as corroboration)`);
  }
  // Only a critical finding is posted from either lane (gates/aggregate.ts, laneOf), and its
  // reader should know why a comment sits where it does.
  if (f.untouched && !toolOf(f)) bits.push("on lines this change did not touch - it may predate the change");
  if (f.silencedBy && !toolOf(f)) bits.push(`posted although the line carries ${f.silencedBy}, as it is critical`);
  if (f.skepticVerdicts) {
    // The qualifiers are the point. "Passed verification" reads as a stronger check than it
    // is when the verifier is the finder's own model family (shared blind spots), or when
    // some verifiers answered that they could not check the claim at all.
    const caveats = [
      f.skepticRefuted ? `${f.skepticRefuted} dissenting` : "",
      f.skepticUnchecked ? `${f.skepticUnchecked} could not check it` : "",
      f.skepticSameFamily ? "same model family as the finder, so a weaker check" : "",
    ].filter(Boolean);
    bits.push(
      caveats.length === 0
        ? `passed ${f.skepticVerdicts} rounds of adversarial verification`
        : `cleared by ${f.skepticVerdicts} of its verifiers (${caveats.join("; ")})`,
    );
  }
  const footer = `<sub>${bits.filter(Boolean).join(" | ")}</sub>`;
  // The prose is defused and the fix is not: inside a fence nothing can close, an HTML
  // comment is literal text, and a fix is contracted to be pasted as it stands.
  //
  // Redacted as a whole, like the summary: only the summary used to be, and an inline
  // comment carries the model's claim, evidence and fix verbatim — text that quotes
  // configuration and error output as readily as the summary's run notes do.
  return redactSecrets(
    [findingMarkers({ ...f, ...(toolOf(f) ? { tool: toolOf(f) } : {}) }, span), defuseHtmlComments(parts.join("\n")), ...fix, "", defuseHtmlComments(footer)].join("\n"),
  );
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
  // What the posting loop actually did, filled in by publish() AFTER it ran. The summary
  // used to be rendered before posting and claimed every inline finding had been
  // "commented on the relevant lines" — including the ones that then failed to post, or
  // that a thread from an earlier run already covered. Absent (dry run, local-review,
  // demo) means "no posting happened", and the summary makes no claim about it.
  posted?: AnchoredFinding[];
  alreadyPosted?: AnchoredFinding[];
  failed?: Array<{ finding: AnchoredFinding; error: string }>;
  // What publish() decided about the `--since auto` resume point. Absent means no decision
  // was taken (dry run, local-review, demo), which is not the same as "it advanced".
  watermark?: WatermarkDecision;
  // Where prloop's earlier comments on this PR now stand, and the iteration the last run
  // recorded. Both absent when nothing was published (dry run, local-review, demo).
  threads?: ThreadTally;
  sinceIteration?: number;
  durationSec: number;
  runDir: string;
}

const REQ_LABEL: Record<ReqVerdict, string> = {
  satisfied: "✅ Satisfied",
  missing: "❌ Not implemented",
  partial: "⚠️ Partial",
  misunderstood: "🔄 Wrong direction",
  // Scope, not a failure — worded so nobody reads it as an accusation and nobody mistakes
  // it for a pass either.
  "not-this-pr": "↗️ Another PR's scope",
  "not-verifiable": "❓ Not verifiable from code",
};

// The requirement axis gets its own block above the code axis, with its own verdict.
// Deliberately not merged into the findings table: a shared ranking lets code findings
// bury "this requirement was never implemented" (PROPOSAL §6.1).
function renderRequirementSection(req: RequirementResult | undefined, incremental: boolean): string[] {
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
  // Criteria the axis judged to belong to a different task or PR are not part of this PR's
  // denominator: counting them would restate "5/9 unmet" for work nobody in this PR owed,
  // which is the false accusation the verdict exists to retire. They stay in the table —
  // dropping them would hide that the work item asks for more than this PR delivers.
  const scoped = req.criteria.filter((c) => c.verdict === "not-this-pr");
  const inScope = req.criteria.length - scoped.length;
  const wiList = req.workItems.map((w) => `#${w.id}`).join(", ");
  // The qualifier appears only when something was actually scoped out; on a PR where every
  // criterion was judged, "all N are implemented" is the stronger and still true claim.
  const of = scoped.length > 0 ? `${wiList} in this PR's scope` : wiList;
  lines.push(
    unmet.length === 0
      ? `✅ **All ${inScope} acceptance criteria for ${of} are implemented.**`
      : `⚠️ **${unmet.length}/${inScope} acceptance criteria for ${of} are unmet.**`,
  );
  if (scoped.length > 0) {
    lines.push(
      "",
      `_${scoped.length} further ${scoped.length === 1 ? "criterion belongs" : "criteria belong"} to another task or PR ` +
        `and ${scoped.length === 1 ? "was" : "were"} not counted against this change._`,
    );
  }
  // Said on incremental runs because the scope line above names one push, and a reader
  // would otherwise take "all implemented" as a claim about that push alone.
  if (incremental) lines.push("", "_Judged against the whole pull request, not only this push._");
  lines.push("", "| Status | Acceptance criterion | Note |", "| --- | --- | --- |");
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

/**
 * Per-finding note for the summary table, saying what happened to a finding that did NOT
 * get a comment. Empty for everything else, including every finding when nothing was
 * posted (dry run) — an absent posting record is not evidence of a failed post.
 */
function postingOutcome(input: SummaryInput): (f: AnchoredFinding) => string {
  if (!input.posted) return () => "";
  const already = new Set((input.alreadyPosted ?? []).map((f) => f.fingerprint));
  const failed = new Map((input.failed ?? []).map((x) => [x.finding.fingerprint, x.error]));
  return (f) =>
    failed.has(f.fingerprint)
      ? ` _(no comment: ${escapeCell(failed.get(f.fingerprint) ?? "post failed")})_`
      : already.has(f.fingerprint)
        ? " _(already commented)_"
        : "";
}

/**
 * What has become of everything prloop said on this PR before today.
 *
 * `resolved` was computed on every run and reached nothing a human reads, so a PR carrying
 * twelve open prloop comments and one carrying twelve the author had worked through rendered
 * identically. The auto-closes are the half only prloop can report — nobody else knows a
 * thread was closed because the code under it went away — and they are dated, since the
 * resume point says exactly which push made them stale.
 *
 * Empty when there is nothing to say: a first run, or a PR where every comment is still open
 * and this run closed none, gets no line rather than a row of zeroes.
 */
function renderThreadStatus(input: SummaryInput): string[] {
  const t = input.threads;
  if (!t) return [];
  const settled = t.fixed + t.dismissed + t.closedThisRun;
  if (settled === 0) return [];
  const parts: string[] = [];
  if (t.closedThisRun > 0) {
    parts.push(
      `**${t.closedThisRun}** closed by this run — the code under them has changed` +
        (input.sinceIteration === undefined ? "" : ` since iteration ${input.sinceIteration}`),
    );
  }
  if (t.fixed > 0) parts.push(`**${t.fixed}** marked fixed by a reviewer`);
  if (t.dismissed > 0) parts.push(`**${t.dismissed}** dismissed`);
  if (t.open > 0) parts.push(`**${t.open}** still open`);
  return [`🧵 Earlier comments: ${parts.join(" · ")}`, ""];
}

/** The headline over the findings table: what was found, and what reached the code. */
function postingClaim(input: SummaryInput, inline: AnchoredFinding[]): string {
  const found = `Found **${inline.length}** issues worth attention`;
  if (!input.posted) return `${found}, commented on the relevant lines.`;
  const posted = new Set(input.posted.map((f) => f.fingerprint));
  const already = new Set((input.alreadyPosted ?? []).map((f) => f.fingerprint));
  const nowPosted = inline.filter((f) => posted.has(f.fingerprint)).length;
  const seen = inline.filter((f) => already.has(f.fingerprint)).length;
  const missed = inline.length - nowPosted - seen;
  if (missed === 0 && seen === 0) return `${found}, commented on the relevant lines.`;
  const parts = [`${nowPosted} commented on the relevant lines`];
  if (seen > 0) parts.push(`${seen} already commented by an earlier run`);
  if (missed > 0) parts.push(`**${missed} could not be posted**`);
  return `${found} (${parts.join(", ")}).`;
}

export function renderSummary(input: SummaryInput): string {
  const { ctx, agg } = input;
  const lines: string[] = [
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

  lines.push(...renderThreadStatus(input));

  lines.push(...renderRequirementSection(input.req, ctx.compareTo > 0));

  lines.push("### 🔍 Code check", "");

  // The no-comment path is a feature: silence on a clean PR is what makes the noisy runs
  // worth reading. But "no issues found" is a claim about code somebody read, and a change
  // with none in it must not make it.
  const nothingFound = agg.inline.length === 0 && agg.belowBar.length === 0 && agg.degraded.length === 0;
  const preExisting = agg.belowBar.filter((f) => f.suppressedBy === "pre-existing");
  const notCommented = agg.belowBar.filter((f) => f.suppressedBy !== "pre-existing");
  // A laned finding a live thread already carries (publish.ts): no comment from this run, one
  // from an earlier run, which the reader should not be told does not exist.
  const already = new Set((input.alreadyPosted ?? []).map((f) => f.fingerprint));
  const earlier = (f: AnchoredFinding) =>
    (f.suppressedBy === "pre-existing" || f.suppressedBy === "silenced") && already.has(f.fingerprint)
      ? " _(commented by an earlier run)_"
      : "";
  if (nothingFound && ctx.files.length === 0) {
    lines.push("_No code in this change for the code check to review._", "");
  } else if (nothingFound) {
    lines.push("✅ **No issues found.**", "");
  } else if (agg.inline.length === 0) {
    lines.push(
      preExisting.length > 0
        ? "✅ **No issues on the changed lines above the reporting threshold.**"
        : "✅ **No issues above the reporting threshold.**",
      "",
    );
  } else {
    lines.push(postingClaim(input, agg.inline), "");
    const bySeverity = new Map<string, number>();
    for (const f of agg.inline) bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
    const order = ["critical", "high", "medium", "low"];
    const counts = order
      .filter((s) => bySeverity.has(s))
      .map((s) => `${SEVERITY_LABEL[s]} ${bySeverity.get(s)}`)
      .join(" | ");
    if (counts) lines.push(counts, "");
    lines.push("| Severity | File | Issue |", "| --- | --- | --- |");
    const outcome = postingOutcome(input);
    for (const f of agg.inline) {
      const loc = f.anchor ? `${f.file}:${f.anchor.startLine}` : f.file;
      lines.push(
        `| ${SEVERITY_LABEL[f.severity] ?? f.severity} | \`${loc}\` | ${escapeCell(f.claim)}${outcome(f)} |`,
      );
    }
    lines.push("");
  }

  // Findings that earned a comment, on lines the change did not touch: most often code that
  // was there before it, worth knowing about and not the author's to answer for in this PR. On
  // an incremental run "the change" is the push, so the lines may be an earlier push's.
  if (preExisting.length > 0) {
    lines.push(
      detailsOpen(
        ctx.compareTo > 0
          ? `On lines this push did not touch (${preExisting.length}) - earlier code, no new comments`
          : `Pre-existing issues (${preExisting.length}) - on lines this change did not touch, no new comments`,
      ),
      "",
    );
    for (const f of preExisting) {
      const loc = f.anchor ? `${f.file}:${f.anchor.startLine}` : f.file;
      lines.push(`- **${f.severity}** \`${loc}\` — ${f.claim}${earlier(f)}`);
    }
    lines.push("", "</details>", "");
  }

  if (notCommented.length > 0) {
    lines.push(detailsOpen(`Other findings, not commented (${notCommented.length})`), "");
    for (const f of notCommented) {
      const loc = f.anchor ? `${f.file}:${f.anchor.startLine}` : f.file;
      const overlap = f.overlapping?.length
        ? `; ${f.overlapping.join(", ")} flagged the same lines with a different claim`
        : "";
      lines.push(`- **${f.severity}** \`${loc}\` — ${f.claim}${earlier(f)}`, `  <sub>${whyNotCommented(f)}${overlap}</sub>`);
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

  // PRR_STATIC_BASELINE: what a fact tool reports at the head and not at the merge base,
  // outside the lines this change touched — typically a caller it broke. Not inline: the
  // lines are not this PR's to comment on, and the finding is still the PR author's to fix.
  const broke = input.staticResult?.broke ?? [];
  if (broke.length > 0) {
    const tools = [...new Set(broke.map((b) => b.tool))].join(", ");
    lines.push(
      detailsOpen(`Broken outside the changed lines (${broke.length}) - new with this change, found by ${tools} against the merge base`),
      "",
    );
    for (const b of broke.slice(0, BROKE_SHOWN)) {
      lines.push(`- \`${b.file}:${b.line}\` ${b.tool}${b.ruleId ? ` ${b.ruleId}` : ""}: ${sanitizeToolMessage(b.message, 300)}`);
    }
    if (broke.length > BROKE_SHOWN) lines.push(`- … and ${broke.length - BROKE_SHOWN} more, in static.json`);
    lines.push("", "</details>", "");
  }

  const notes: string[] = [];
  if (input.omittedFiles.length > 0) {
    notes.push(`Diff size limit: ${input.omittedFiles.length} files left out of this analysis: ${input.omittedFiles.slice(0, 10).join(", ")}${input.omittedFiles.length > 10 ? " and more" : ""}`);
  }
  // Named, not counted: a file type prloop does not know may be code in a language it does
  // not review yet, and that is the one skip a reader has to be able to see.
  const unknown = ctx.skipped.filter((f) => f.reason === UNKNOWN_FILE_TYPE).map((f) => f.path);
  if (unknown.length > 0) {
    notes.push(
      `Not reviewed, file type unknown to prloop: ${unknown.slice(0, 10).join(", ")}${unknown.length > 10 ? ` and ${unknown.length - 10} more` : ""}`,
    );
  }
  const otherSkips = ctx.skipped.length - unknown.length;
  if (otherSkips > 0) {
    notes.push(`The code check skipped ${otherSkips} files that are not code, generated, deleted or binary`);
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
  // Named here as well as in the table: a requirement finding that failed to post is not in
  // the code table at all, and "we found it but you never saw it" must not be invisible.
  for (const x of input.failed ?? []) {
    const loc = x.finding.anchor ? `${x.finding.file}:${x.finding.anchor.startLine}` : x.finding.file;
    notes.push(`Comment on ${loc} could not be posted: ${x.error}`);
  }
  if (agg.stats.excluded > 0) {
    notes.push(
      `${agg.stats.excluded} findings dropped, category excluded by config (PRR_EXCLUDE_CATEGORIES=${excludedCategories().join(",")})`,
    );
  }
  // Worded from the decision, not from the list of reasons, because the two cases read
  // oppositely: with a resume point already on the PR the next run re-reviews this push,
  // and without one it reviews the whole PR. The reasons themselves are already a bullet
  // each above — repeating them here would say the same thing twice.
  const wm = input.watermark;
  if (wm?.held) {
    notes.push(
      wm.record === undefined
        ? `This push was not fully reviewed (${wm.reason}), and no resume point was recorded, so the next \`--since auto\` run reviews the whole PR`
        : `This push was not fully reviewed (${wm.reason}), so the \`--since auto\` resume point stays at iteration ${wm.record} and the next run re-reviews from there`,
    );
  } else if (wm?.reason) {
    notes.push(wm.reason);
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

  // The last line of every summary, and load-bearing: publish() and the lease append their
  // markers after it, and markers.ts reads the resume point and the lease from there alone.
  lines.push(`<sub>prloop · this comment updates on every push</sub>`);
  // The summary is posted to the PR: the run notes quote finder and requirement errors,
  // which relay gateway bodies — "Model X produced no result: HTTP 401: …" once carried the
  // rejected key to everyone who could read the repository. Defused as a whole rather than
  // field by field: nearly every line quotes something prloop did not write, and a field
  // added later is covered without anyone remembering to.
  return redactSecrets(`${summaryMarkers()}\n${defuseHtmlComments(lines.join("\n"))}`);
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}
