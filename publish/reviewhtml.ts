// The run on one screen: the diff, with every finding sitting on the line it is about.
//
// Beside format.ts because it is the same job — rendering findings for a person — aimed at a
// different surface. format.ts writes markdown for the pull request; this writes a file into
// runs/ for whoever is looking at why the run said what it said.
//
// It exists because two things were impossible without it. `--dry-run` computed a whole
// review and then printed a list of `file:line — claim` lines, so checking whether a finding
// was right meant opening the file, finding the line, and reconstructing what the model had
// actually been shown; it was a preflight you could not read. And auditing a golden set
// (scripts/evaluate.ts) means judging dozens of findings against a diff by hand, which is
// the same problem multiplied.
//
// Self-contained on purpose: one file, inline CSS, no script and no network reference. It is
// opened with a file:// URL on a build agent as often as on a laptop, and a report that needs
// anything else is a report that does not open. Collapsing is <details>, not JavaScript.
//
// Written while ctx.files is still in memory (orchestrator.ts). context.json records per-file
// hunk and changed-line COUNTS, not the lines, so nothing on disk can reconstruct this after
// the run — and the artifact goes out through RunDir.save, which is what puts it through
// redactSecrets like every other egress.
import { detectLanguage } from "../libs/lang";
import type { AggregateResult } from "../gates/aggregate";
import type { ReviewContext } from "../ado/intake";
import type { AnchoredFinding, FileDiff, Hunk, ReqVerdict, RequirementResult } from "../libs/types";

const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;

const REQ_LABEL: Record<ReqVerdict, string> = {
  satisfied: "satisfied",
  missing: "not implemented",
  partial: "partial",
  misunderstood: "wrong direction",
  "not-this-pr": "another PR's scope",
  "not-verifiable": "not verifiable from code",
};

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/** Everything written into the document goes through this. A diff is full of `<` and `&`. */
function esc(s: string | undefined): string {
  return (s ?? "").replace(/[&<>"]/g, (c) => ESCAPES[c] ?? c);
}

/** Why a finding is in the report but was never commented on. */
const WHY_NOT_POSTED: Record<string, string> = {
  severity: "below the inline severity threshold",
  cap: "over the per-run comment cap",
  "no-corroboration": "single model, unverified",
  dismissed: "matches a finding a reviewer previously dismissed",
};

const FAILURE_LABEL: Record<string, string> = {
  "quote-not-found": "the quoted code is not in the file",
  "quote-ambiguous": "the quoted code appears more than once",
  "file-not-in-diff": "the file is not in this change",
  "file-ambiguous": "the path matches more than one changed file",
  "outside-changed-lines": "the quote is outside the changed region",
};

/** One row of a rendered hunk, carrying the file line numbers a finding anchors to. */
interface DiffRow {
  kind: "add" | "del" | "ctx" | "meta";
  left?: number;
  right?: number;
  text: string;
}

/**
 * A hunk body back into numbered rows.
 *
 * The line numbers are the whole point: a finding's anchor is a right-side file line, and
 * without walking the prefixes there is nothing to hang it on. Kept here rather than reusing
 * the anchoring code because that answers the opposite question (text → line), and a second
 * consumer of it would be a reason for it to grow a mode.
 */
export function hunkRows(h: Hunk): DiffRow[] {
  const rows: DiffRow[] = [
    { kind: "meta", text: `@@ -${h.leftStart},${h.leftCount} +${h.rightStart},${h.rightCount} @@` },
  ];
  let left = h.leftStart;
  let right = h.rightStart;
  for (const line of h.body.split("\n")) {
    if (line.startsWith("+")) rows.push({ kind: "add", right: right++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", left: left++, text: line.slice(1) });
    // A body ends with a trailing newline on most tools, which splits into one empty string.
    // Rendered as a context line it becomes a blank row numbered one PAST the end of the
    // hunk — a line that does not exist, which a finding anchored there would attach to. A
    // blank line in the source arrives as " ", never "", so nothing real is skipped here.
    else if (line === "") continue;
    else rows.push({ kind: "ctx", left: left++, right: right++, text: line.slice(1) });
  }
  return rows;
}

function severityChip(s: string): string {
  return `<span class="sev sev-${esc(s)}">${esc(s)}</span>`;
}

/** What happened to this finding, said plainly, because that is the question being asked. */
function verdictLine(f: AnchoredFinding): string {
  const bits: string[] = [];
  bits.push(f.sources.length > 1 ? `${f.sources.length} finders agreed (${f.sources.join(", ")})` : (f.sources[0] ?? "unknown source"));
  bits.push(`confidence ${Math.round(f.confidence * 100)}%`);
  if (f.skepticVerdicts) {
    bits.push(
      f.skepticRefuted
        ? `${f.skepticVerdicts} verifiers, ${f.skepticRefuted} dissenting`
        : `cleared by ${f.skepticVerdicts} verifiers`,
    );
  }
  if (f.suppressedBy) bits.push(`not commented: ${WHY_NOT_POSTED[f.suppressedBy] ?? f.suppressedBy}`);
  return bits.join(" · ");
}

function findingCard(f: AnchoredFinding, axis: "code" | "requirement"): string {
  const parts = [
    `<div class="finding${f.suppressedBy ? " muted" : ""}">`,
    `<div class="fhead">${severityChip(f.severity)}<span class="cat">${esc(f.category)}</span>` +
      (axis === "requirement" ? `<span class="cat axis">requirement axis</span>` : "") +
      `</div>`,
    `<div class="claim">${esc(f.claim)}</div>`,
  ];
  if (f.evidence) parts.push(`<div class="evidence">${esc(f.evidence)}</div>`);
  if (f.suggested_fix) {
    parts.push(`<pre class="fix"><code>${esc(f.suggested_fix.replace(/\s+$/, ""))}</code></pre>`);
  }
  parts.push(`<div class="meta">${esc(verdictLine(f))}</div>`, "</div>");
  return parts.join("\n");
}

function renderFile(file: FileDiff, findings: AnchoredFinding[], axisOf: (f: AnchoredFinding) => "code" | "requirement"): string {
  // Right-side lines carry almost every finding; a left-side one is anchored in the deleted
  // text and is keyed separately so it does not land on an unrelated new line.
  const onRight = new Map<number, AnchoredFinding[]>();
  const onLeft = new Map<number, AnchoredFinding[]>();
  for (const f of findings) {
    const a = f.anchor;
    if (!a) continue;
    const into = a.side === "left" ? onLeft : onRight;
    into.set(a.startLine, [...(into.get(a.startLine) ?? []), f]);
  }

  const rows: string[] = [];
  for (const h of file.hunks) {
    for (const r of hunkRows(h)) {
      if (r.kind === "meta") {
        rows.push(`<tr class="meta"><td class="ln"></td><td class="ln"></td><td class="code">${esc(r.text)}</td></tr>`);
        continue;
      }
      rows.push(
        `<tr class="${r.kind}"><td class="ln">${r.left ?? ""}</td><td class="ln">${r.right ?? ""}</td>` +
          `<td class="code">${esc(r.text) || "&nbsp;"}</td></tr>`,
      );
      const here = [...(r.right === undefined ? [] : onRight.get(r.right) ?? []), ...(r.left === undefined ? [] : onLeft.get(r.left) ?? [])];
      for (const f of here) {
        rows.push(`<tr class="inline"><td colspan="3">${findingCard(f, axisOf(f))}</td></tr>`);
      }
    }
  }

  const n = findings.length;
  const badge = n > 0 ? `<span class="badge">${n} finding${n === 1 ? "" : "s"}</span>` : "";
  // Open when there is something to look at, so a 60-file PR does not have to be clicked
  // through to find the three files anything was said about.
  return [
    `<details class="file"${n > 0 ? " open" : ""}>`,
    `<summary><code>${esc(file.path)}</code> <span class="tag">${esc(file.changeType)}</span> <span class="tag">${esc(detectLanguage(file.path))}</span>${badge}</summary>`,
    `<table class="diff">${rows.join("\n")}</table>`,
    "</details>",
  ].join("\n");
}

function renderRequirements(req: RequirementResult | undefined): string {
  if (!req || req.criteria.length === 0) {
    return `<p class="empty">${esc(req?.skipped ?? req?.error ?? "no acceptance criteria to check against")}</p>`;
  }
  const rows = req.criteria.map(
    (c) =>
      `<tr><td class="verdict v-${esc(c.verdict)}">${esc(REQ_LABEL[c.verdict])}</td>` +
      `<td>${esc(c.criterion)}</td><td>${esc(c.note)}${c.file ? ` <code>${esc(c.file)}</code>` : ""}</td></tr>`,
  );
  return `<table class="req"><tr><th>verdict</th><th>criterion</th><th>note</th></tr>${rows.join("\n")}</table>`;
}

export interface ReviewHtmlInput {
  ctx: ReviewContext;
  agg: AggregateResult;
  /** The requirement axis's own findings, anchored like the code axis's. */
  reqFindings: AnchoredFinding[];
  req?: RequirementResult;
  durationSec: number;
  /** Said at the top, because a dry run's report describes comments that were never posted. */
  dryRun: boolean;
}

export function renderReviewHtml(input: ReviewHtmlInput): string {
  const { ctx, agg } = input;
  const axisOf = new Set(input.reqFindings.map((f) => f.fingerprint));
  // belowBar included and marked, never dropped: "why did prloop not comment on this" is the
  // question this file is most often opened to answer, and a finding that is missing from it
  // is indistinguishable from one the finders never produced.
  const anchored = [...input.reqFindings, ...agg.inline, ...agg.belowBar].filter((f) => f.anchor);
  const byFile = new Map<string, AnchoredFinding[]>();
  for (const f of anchored) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  for (const list of byFile.values()) {
    list.sort((a, b) => (a.anchor?.startLine ?? 0) - (b.anchor?.startLine ?? 0));
  }

  const counts = SEVERITY_ORDER.map((s) => [s, agg.inline.filter((f) => f.severity === s).length] as const).filter(
    ([, n]) => n > 0,
  );
  const scope =
    ctx.compareTo > 0
      ? `iteration ${ctx.compareTo} → ${ctx.iteration.id} (incremental)`
      : `iteration ${ctx.iteration.id} (full PR)`;

  const files = ctx.files
    // Files with findings first: the report is read top-down and the reason it was opened
    // should not be forty screens down.
    .slice()
    .sort((a, b) => (byFile.get(b.path)?.length ?? 0) - (byFile.get(a.path)?.length ?? 0) || a.path.localeCompare(b.path))
    .map((f) => renderFile(f, byFile.get(f.path) ?? [], (x) => (axisOf.has(x.fingerprint) ? "requirement" : "code")));

  const degraded = agg.degraded.map(
    (f) =>
      `<li>${severityChip(f.severity)} <code>${esc(f.file)}</code> — ${esc(f.claim)}` +
      `<div class="meta">${esc(FAILURE_LABEL[f.anchorFailure ?? ""] ?? f.anchorFailure ?? "unknown reason")}` +
      `${f.quote ? ` · quoted: <code>${esc(f.quote.split("\n")[0] ?? "")}</code>` : ""}</div></li>`,
  );

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>prloop review — ${esc(ctx.ref.repoId)} !${ctx.ref.prId}</title>
<style>
:root { color-scheme: light dark; --bg:#fff; --fg:#1b1f23; --dim:#6a737d; --line:#e1e4e8;
  --add:#e6ffed; --del:#ffeef0; --card:#f6f8fa; --accent:#0366d6; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#c9d1d9; --dim:#8b949e;
  --line:#30363d; --add:#0d2f1a; --del:#3a1418; --card:#161b22; --accent:#58a6ff; } }
* { box-sizing: border-box; }
body { margin:0; padding:24px; background:var(--bg); color:var(--fg);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:16px; margin:32px 0 8px; }
code, pre, .code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; }
.sub { color:var(--dim); margin:0 0 16px; }
.banner { background:var(--card); border:1px solid var(--line); border-radius:6px; padding:8px 12px; margin-bottom:16px; }
.file { border:1px solid var(--line); border-radius:6px; margin-bottom:12px; overflow:hidden; }
.file > summary { padding:8px 12px; background:var(--card); cursor:pointer; }
.tag, .badge { color:var(--dim); font-size:11px; border:1px solid var(--line); border-radius:10px; padding:1px 6px; margin-left:6px; }
.badge { color:var(--bg); background:var(--accent); border-color:var(--accent); }
table.diff { border-collapse:collapse; width:100%; }
table.diff td { padding:0 8px; vertical-align:top; white-space:pre-wrap; word-break:break-word; }
td.ln { width:1%; text-align:right; color:var(--dim); user-select:none; font-family:ui-monospace,monospace; font-size:11px; }
tr.add td.code { background:var(--add); } tr.del td.code { background:var(--del); }
tr.meta td { color:var(--dim); background:var(--card); }
.finding { border-left:3px solid var(--accent); background:var(--card); margin:6px 0; padding:8px 12px; border-radius:0 6px 6px 0; }
.finding.muted { border-left-color:var(--dim); opacity:.75; }
.fhead { margin-bottom:4px; }
.claim { font-weight:600; } .evidence { margin-top:4px; }
.meta { color:var(--dim); font-size:12px; margin-top:4px; }
pre.fix { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px; overflow:auto; margin:6px 0 0; }
.sev { font-size:11px; border-radius:10px; padding:1px 8px; color:#fff; }
.sev-critical { background:#cb2431; } .sev-high { background:#d9822b; }
.sev-medium { background:#b08800; } .sev-low { background:#6a737d; }
.cat { color:var(--dim); font-size:12px; margin-left:8px; }
table.req { border-collapse:collapse; width:100%; }
table.req th, table.req td { border:1px solid var(--line); padding:6px 8px; text-align:left; vertical-align:top; }
.v-missing, .v-misunderstood { color:#cb2431; } .v-partial { color:#b08800; } .v-satisfied { color:#22863a; }
ul.degraded { padding-left:18px; } ul.degraded li { margin-bottom:8px; }
.empty { color:var(--dim); }
</style></head>
<body>
<h1>${esc(ctx.ref.org)}/${esc(ctx.ref.project)}/${esc(ctx.ref.repoId)} !${ctx.ref.prId}</h1>
<p class="sub">${esc(ctx.pr.title)}</p>
<div class="banner">${esc(scope)} · ${ctx.files.length} files · ${input.durationSec}s · ${agg.inline.length} commented${
    counts.length > 0 ? ` (${counts.map(([s, n]) => `${n} ${s}`).join(", ")})` : ""
  }${agg.belowBar.length > 0 ? ` · ${agg.belowBar.length} below the bar` : ""}${
    agg.degraded.length > 0 ? ` · ${agg.degraded.length} unanchored` : ""
  }${input.dryRun ? " · <strong>dry run: nothing was posted</strong>" : ""}</div>

<h2>Requirement check</h2>
${renderRequirements(input.req)}

<h2>The change</h2>
${files.join("\n")}
${
  degraded.length > 0
    ? `<h2>Findings with no locatable line (${degraded.length})</h2>
<p class="sub">Never commented: a guessed line is worse than a miss.</p>
<ul class="degraded">${degraded.join("\n")}</ul>`
    : ""
}
</body></html>`;
}
