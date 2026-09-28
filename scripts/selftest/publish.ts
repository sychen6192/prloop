// What reaches the pull request: comment rendering, the thread lifecycle, position dedupe,
// the summary's honesty about what was posted, and review.html.
import { FileIndex } from "../../libs/fileindex";
import { fingerprint } from "../../gates/aggregate";
import { openRunDir } from "../../libs/artifacts";
import { renderSummary } from "../../publish/format";
import { hunkRows, renderReviewHtml } from "../../publish/reviewhtml";
import { renderFindingComment } from "../../publish/format";
import { lastReviewedIteration, findStaleThreads, collectDismissals } from "../../publish/lifecycle";
import { iterationMarker } from "../../publish/markers";
import { postedPositions } from "../../publish/publish";
import type { AnchoredFinding } from "../../libs/types";
import { coveredByThread } from "../../publish/publish";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../../libs/shell";
import { check, eq, section } from "./harness";
import { mkFile } from "./fixtures";

// suggested_fix is contracted to be paste-ready code, so how it is fenced is part of the
// contract, not cosmetics.
section("suggested fix rendering");
{
  const base = {
    category: "correctness", severity: "high" as const, confidence: 0.9,
    file: "/src/pay.py", quote: "x", claim: "c", side: "right" as const,
    sources: ["m"], fingerprint: "abc123",
    anchor: { side: "right" as const, startLine: 1, endLine: 1, startOffset: 1, endOffset: 2 },
  };
  const out = renderFindingComment({ ...base, suggested_fix: "    db.commit()\n    flush()" });
  check("fence carries the file's language", out.includes("```python"));
  check("first line keeps its indentation", out.includes("\n    db.commit()"));
  check("second line keeps its indentation", out.includes("\n    flush()"));

  const padded = renderFindingComment({ ...base, suggested_fix: "\n\n    a()\n\n" });
  check("surrounding blank lines are dropped", padded.includes("```python\n    a()\n```"));

  const unknown = renderFindingComment({ ...base, file: "/x/build.zig", suggested_fix: "all:" });
  check("an unknown language gets a bare fence", unknown.includes("```\nall:"));

  check("no fix means no section", !renderFindingComment(base).includes("Suggested fix"));

  // Only the summary used to be redacted. An inline comment quotes the model's claim,
  // evidence and fix verbatim, and those quote configuration and error text as readily.
  const leaky = renderFindingComment({
    ...base,
    claim: "The client sends Authorization: Bearer abcdefgh12345678 to every host",
    evidence: "proxy is http://bob:hunter2@proxy.corp:8080",
    suggested_fix: 'const key = "sk-live0123456789abcdef";',
  });
  check("a bearer token in a claim is redacted", !leaky.includes("abcdefgh12345678") && leaky.includes("Bearer [REDACTED]"), leaky);
  check("...URL credentials in the evidence too", !leaky.includes("hunter2"), leaky);
  check("...and a key in the suggested fix", !leaky.includes("sk-live0123456789abcdef"), leaky);
}

section("comment lifecycle");
{
  const threads = [
    { id: 1, status: "closed", comments: [{ id: 1, content: `<!-- prloop --><!-- prloop:summary -->x\n${iterationMarker(7)}` }] },
  ];
  eq("reads last reviewed iteration from summary", lastReviewedIteration(threads), 7);
  eq("no marker -> undefined", lastReviewedIteration([{ id: 2, comments: [{ id: 1, content: "unrelated comment" }] }]), undefined);
}
{
  const f = mkFile("/src/a.ts", ["x();", "y();"], [1]);
  const ours = (line: number, status: string) => ({
    id: line, status,
    comments: [{ id: 1, content: "<!-- prloop --><!-- prloop:fp=abc123 -->issue" }],
    threadContext: { filePath: "/src/a.ts", rightFileStart: { line, offset: 1 } },
  });
  const idx = new FileIndex([f]);
  eq("line past end of file -> stale", findStaleThreads([ours(99, "active")], idx).length, 1);
  eq("line still in range -> leave it alone", findStaleThreads([ours(1, "active")], idx).length, 0);
  eq("closed thread is skipped", findStaleThreads([ours(99, "fixed")], idx).length, 0);
  // Someone else's comment must never be touched.
  const foreign = { id: 5, status: "active", comments: [{ id: 1, content: "a teammate's comment" }],
    threadContext: { filePath: "/src/a.ts", rightFileStart: { line: 99, offset: 1 } } };
  eq("comments not from this tool are skipped", findStaleThreads([foreign], idx).length, 0);
}
{
  const dismissed = [
    { id: 1, status: "wontFix", comments: [{ id: 1, content: "<!-- prloop --><!-- prloop:fp=deadbeef -->won't fix" }],
      threadContext: { filePath: "/src/a.ts" } },
    { id: 2, status: "active", comments: [{ id: 1, content: "<!-- prloop --><!-- prloop:fp=aaaa -->still open" }] },
    // "Closed" in the ADO UI routinely means "handled", not "wrong finding" — it must NOT
    // become a permanent cross-PR suppression.
    { id: 3, status: "closed", comments: [{ id: 1, content: "<!-- prloop --><!-- prloop:fp=bbbb -->fixed, closing" }],
      threadContext: { filePath: "/src/a.ts" } },
  ];
  const d = collectDismissals(dismissed);
  eq("collects only wontFix/byDesign threads", d.length, 1);
  eq("records the fingerprint", d[0]?.fingerprint, "deadbeef");
  eq("a closed (handled) thread is not a dismissal", d.find((x) => x.fingerprint === "bbbb"), undefined);
}

section("position dedupe covers dismissed threads");
{
  const mkT = (status: string, content = "<!-- prloop -->issue") => ({
    id: 1,
    status,
    comments: [{ id: 1, content }],
    threadContext: { filePath: "/src/a.ts", rightFileStart: { line: 3, offset: 1 }, rightFileEnd: { line: 3, offset: 5 } },
  });
  const noFiles = new FileIndex([]);
  eq("active thread occupies its lines", postedPositions([mkT("active")], noFiles).length, 1);
  eq("wontFix thread still occupies its lines", postedPositions([mkT("wontFix")], noFiles).length, 1);
  eq("byDesign thread still occupies its lines", postedPositions([mkT("byDesign")], noFiles).length, 1);
  eq("fixed thread frees its lines (code changed)", postedPositions([mkT("fixed")], noFiles).length, 0);
  eq("someone else's thread never counts", postedPositions([mkT("active", "a teammate's comment")], noFiles).length, 0);

  // Rename trail: a thread created on the old path still occupies the renamed file's
  // lines, so a re-run cannot re-post the same finding onto the new name.
  const renamed = { ...mkFile("src/new.ts", ["x();", "y();", "z();"], [3]), originalPath: "src/old.ts" };
  const onOldName = {
    id: 9, status: "active",
    comments: [{ id: 1, content: "<!-- prloop -->issue" }],
    threadContext: { filePath: "/src/old.ts", rightFileStart: { line: 3, offset: 1 }, rightFileEnd: { line: 3, offset: 5 } },
  };
  eq("a thread on the pre-rename path re-keys onto the renamed file",
    postedPositions([onOldName], new FileIndex([renamed]))[0]?.file, "src/new.ts");
}

section("publish honesty: the summary reports what actually reached the PR");
{
  const mk = (fp: string, claim: string): AnchoredFinding => ({
    category: "correctness", severity: "high", confidence: 0.8, file: "src/a.ts", quote: "x();",
    claim, sources: ["m1"], fingerprint: fp,
    anchor: { side: "right", startLine: 3, endLine: 3, startOffset: 1, endOffset: 5 },
  });
  const inline = [mk("fp1", "one"), mk("fp2", "two"), mk("fp3", "three")];
  const ctx = {
    ref: { baseUrl: "https://dev.azure.com/o", org: "o", project: "p", repoId: "r", prId: 1 },
    pr: { title: "t", description: "", sourceBranch: "s", targetBranch: "m", createdBy: "a", status: "active" },
    iterations: [],
    iteration: { id: 1, sourceRefCommit: "", targetRefCommit: "", commonRefCommit: "", createdDate: "" },
    compareTo: 0, files: [], skipped: [], changeTrackingIds: new Map(),
  } as unknown as Parameters<typeof renderSummary>[0]["ctx"];
  const base = {
    ctx,
    agg: { inline, belowBar: [], degraded: [], stats: { raw: 3, afterDedupe: 3, anchored: 3, survived: 3, refuted: 0, inline: 3, byFailure: {}, excluded: 0, dismissed: 0 } },
    finderErrors: [], omittedFiles: [], appliedRules: [], durationSec: 1, runDir: "",
  };

  // The summary was rendered BEFORE the posting loop, so it claimed every finding had been
  // "commented on the relevant lines" — including the ones that then failed to post.
  const honest = renderSummary({
    ...base,
    posted: [inline[0]!],
    alreadyPosted: [inline[1]!],
    failed: [{ finding: inline[2]!, error: "TF401232: thread context is not valid." }],
  });
  check("the headline counts what was posted", honest.includes("Found **3** issues worth attention (1 commented on the relevant lines"));
  check("...names what an earlier run already covered", honest.includes("1 already commented by an earlier run"));
  check("...and does not hide the one that failed", honest.includes("**1 could not be posted**"));
  check("the row for the failed finding says why", honest.includes("_(no comment: TF401232: thread context is not valid.)_"));
  check("the row for the deduped finding says so", honest.includes("_(already commented)_"));
  check("the failure is named in the run notes too", honest.includes("Comment on src/a.ts:3 could not be posted: TF401232"));

  const allPosted = renderSummary({ ...base, posted: inline, alreadyPosted: [], failed: [] });
  eq("nothing to qualify keeps the plain claim", allPosted.includes("Found **3** issues worth attention, commented on the relevant lines."), true);
  const noPosting = renderSummary(base);
  eq("a run that posted nothing makes no claim about posting", noPosting.includes("_(no comment"), false);
  check("...and still reports what it found", noPosting.includes("Found **3** issues worth attention"));
}

section("position dedupe stays inside one axis");
{
  // The one place the "two blind axes, separate budgets" invariant leaked: a requirement
  // thread on lines 10-12 marked a new critical CODE finding on line 11 as already posted.
  const mkT = (cat: string | undefined, line: number) => ({
    id: 1, status: "active",
    comments: [{ id: 1, content: `<!-- prloop -->${cat ? `<!-- prloop:cat=${cat} -->` : ""}issue` }],
    threadContext: { filePath: "/src/a.ts", rightFileStart: { line, offset: 1 }, rightFileEnd: { line: line + 2, offset: 5 } },
  });
  const idx = new FileIndex([]);
  const reqThread = postedPositions([mkT("req-mismatch", 10)], idx);
  const codeThread = postedPositions([mkT("security", 10)], idx);
  const legacyThread = postedPositions([mkT(undefined, 10)], idx);
  eq("a requirement thread is tagged as one", reqThread[0]?.axis, "requirement");
  eq("any finder category is the code axis", codeThread[0]?.axis, "code");
  eq("a thread from before the marker has no axis", legacyThread[0]?.axis, undefined);

  const mkF = (category: string): AnchoredFinding => ({
    category, severity: "critical", confidence: 0.9, file: "src/a.ts", quote: "x();", claim: "c",
    sources: ["m1"], fingerprint: "fp1",
    anchor: { side: "right", startLine: 11, endLine: 11, startOffset: 1, endOffset: 5 },
  });
  eq("a requirement thread no longer swallows a code finding", coveredByThread(mkF("security"), reqThread), false);
  eq("a code thread no longer swallows a requirement verdict", coveredByThread(mkF("req-mismatch"), codeThread), false);
  eq("same axis still dedupes (that is the point of it)", coveredByThread(mkF("correctness"), codeThread), true);
  eq("...on the requirement side too", coveredByThread(mkF("req-mismatch"), reqThread), true);
  eq("an unlabelled thread still blocks both axes", coveredByThread(mkF("req-mismatch"), legacyThread), true);
  eq("...and the code axis as well", coveredByThread(mkF("correctness"), legacyThread), true);
  const elsewhere = postedPositions([mkT("security", 40)], idx);
  eq("a thread on other lines covers nothing here", coveredByThread(mkF("correctness"), elsewhere), false);
}

section("review.html: the diff and the findings on one screen");
{
  // --dry-run computed a whole review and then printed `file:line — claim` lines, so
  // checking whether a finding was right meant opening the file, finding the line, and
  // reconstructing what the model had actually been shown. Auditing a golden set is the
  // same problem multiplied by fifty.
  const right = [
    "function total(items) {",
    "  let sum = 0;",
    "  for (const i of items) sum += i.price;",
    "  return sum;",
    "}",
  ];
  const file = mkFile("src/total.ts", right, [3]);

  // The numbering is the whole point: an anchor is a right-side file line, and without
  // walking the +/-/space prefixes there is nothing to hang a finding on.
  const rows = hunkRows({ leftStart: 1, leftCount: 2, rightStart: 1, rightCount: 3, body: " a\n-b\n+c\n+d\n" });
  eq("a hunk header is a row of its own", rows[0]?.kind, "meta");
  eq(
    "context, deletion and addition each advance the right side correctly",
    rows.slice(1).map((r) => [r.kind, r.left ?? null, r.right ?? null]),
    [["ctx", 1, 1], ["del", 2, null], ["add", null, 2], ["add", null, 3]],
  );
  // A body that ends with a newline splits into a trailing empty string. Rendered as a
  // context line it becomes a blank row numbered one PAST the end of the hunk — a line that
  // does not exist, which a finding anchored there would then attach to. (A blank line in
  // the source is " ", never "", so nothing real is lost by skipping it.)
  eq("a trailing newline is not a line", rows.length, 5);
  eq("...and no row claims a line past the end of the hunk", Math.max(...rows.map((r) => r.right ?? 0)), 3);

  const mk = (over: Partial<AnchoredFinding>): AnchoredFinding => ({
    category: "correctness",
    severity: "high",
    confidence: 0.8,
    file: "src/total.ts",
    quote: "sum += i.price",
    claim: "Adds price without checking quantity.",
    sources: ["m1"],
    fingerprint: "abc123abc123",
    anchor: { side: "right", startLine: 3, endLine: 3, startOffset: 1, endOffset: 40 },
    ...over,
  });
  const ctx = {
    ref: { baseUrl: "", org: "contoso", project: "Shop", repoId: "api", prId: 9 },
    pr: { title: "Fix totals", description: "", sourceBranch: "f", targetBranch: "m", createdBy: "A", status: "active" },
    iteration: { id: 3, sourceRefCommit: "s", targetRefCommit: "t", commonRefCommit: "b", createdDate: "" },
    compareTo: 0,
    files: [file],
    skipped: [],
    iterations: [],
    changeTrackingIds: new Map<string, number>(),
    fileIndex: new FileIndex([file]),
  } as unknown as Parameters<typeof renderReviewHtml>[0]["ctx"];

  const commented = mk({});
  const below = mk({ fingerprint: "def456def456", severity: "low", claim: "Name could be clearer.", suppressedBy: "severity" });
  const lost = mk({
    fingerprint: "999999999999",
    anchor: undefined,
    anchorFailure: "quote-not-found",
    claim: "Race on the shared counter.",
  });
  const html = renderReviewHtml({
    ctx,
    agg: {
      inline: [commented],
      belowBar: [below],
      degraded: [lost],
      stats: { raw: 3, afterDedupe: 3, anchored: 2, survived: 2, refuted: 0, inline: 1, byFailure: {}, excluded: 0, dismissed: 0 },
    },
    reqFindings: [],
    durationSec: 12,
    dryRun: true,
  });

  // Self-contained, because it is opened with a file:// URL on a build agent as often as on
  // a laptop, and a report that needs anything else is a report that does not open.
  check("no script of any kind", !/<script/i.test(html), "");
  check("...and nothing fetched from the network", !/(src|href)\s*=\s*["']?(https?:|\/\/)/i.test(html), "");

  const lineRow = html.indexOf('<td class="ln">3</td>');
  const claim = html.indexOf("Adds price without checking quantity.");
  check("a commented finding sits under the line it is about", lineRow >= 0 && claim > lineRow, `${lineRow} ${claim}`);
  check("...and says what agreed with it", html.includes("confidence 80%"), "");

  // "Why did prloop not comment on this" is the question the file is most often opened to
  // answer, and a finding missing from it is indistinguishable from one never produced.
  check("a finding below the bar is shown too", html.includes("Name could be clearer."), "");
  check("...and says why it was not commented", html.includes("below the inline severity threshold"), "");

  // Never on a line, because there is no line: the whole anchoring rule is that a guessed
  // line is worse than a miss, and the report must not undo it.
  check("a finding that did not anchor gets its own list", html.includes("no locatable line"), "");
  check("...naming the reason", html.includes("the quoted code is not in the file"), "");
  const diffEnd = html.indexOf("<h2>Findings with no locatable line");
  check("...and appears nowhere in the diff", html.indexOf("Race on the shared counter.") > diffEnd, "");

  check("a dry run says nothing was posted", html.includes("dry run: nothing was posted"), "");

  // A diff is full of `<` and `&`, and a claim is model-written text.
  const hostile = renderReviewHtml({
    ctx,
    agg: {
      inline: [mk({ claim: "<script>alert(1)</script> & more" })],
      belowBar: [],
      degraded: [],
      stats: { raw: 1, afterDedupe: 1, anchored: 1, survived: 1, refuted: 0, inline: 1, byFailure: {}, excluded: 0, dismissed: 0 },
    },
    reqFindings: [],
    durationSec: 1,
    dryRun: false,
  });
  check("a model-written claim cannot inject markup", !/<script/i.test(hostile) && hostile.includes("&lt;script&gt;alert(1)"), "");

  // The source under review is the other half: a TSX file is mostly angle brackets, and a
  // diff line rendered raw would close the table it is sitting in.
  const tsx = mkFile("src/page.tsx", ["export default () => {", "  return <Summary a={1} />;", "}"], [2]);
  const markup = renderReviewHtml({
    ctx: { ...ctx, files: [tsx], fileIndex: new FileIndex([tsx]) },
    agg: { inline: [], belowBar: [], degraded: [], stats: { raw: 0, afterDedupe: 0, anchored: 0, survived: 0, refuted: 0, inline: 0, byFailure: {}, excluded: 0, dismissed: 0 } },
    reqFindings: [],
    durationSec: 1,
    dryRun: false,
  });
  check("...and neither can the source under review", markup.includes("&lt;Summary a={1} /&gt;") && !markup.includes("<Summary"), "");

  // The artifact goes out through RunDir.save, which is the egress that redacts. A report
  // quoting a line that holds a key would otherwise publish it into the directory people
  // attach to bug reports.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-html-"));
  try {
    const leaky = mkFile("src/cfg.ts", ["const key = 'sk-live-abcdefghijklmnop';"], [1]);
    openRunDir(tmp).save(
      "review.html",
      renderReviewHtml({
        ctx: { ...ctx, files: [leaky], fileIndex: new FileIndex([leaky]) },
        agg: { inline: [], belowBar: [], degraded: [], stats: { raw: 0, afterDedupe: 0, anchored: 0, survived: 0, refuted: 0, inline: 0, byFailure: {}, excluded: 0, dismissed: 0 } },
        reqFindings: [],
        durationSec: 1,
        dryRun: false,
      }),
    );
    const written = fs.readFileSync(path.join(tmp, "review.html"), "utf8");
    check("a credential in the diff never reaches the file", !written.includes("sk-live-abcdefghijklmnop") && written.includes("[REDACTED]"), "");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
