// Anchoring: quotes resolved to lines against raw blob bytes, and the diff those lines come
// from. The class of bug that motivated the project — a comment on the wrong line — so this
// is the densest net. Run it after touching libs/diff.ts, libs/fileindex.ts or
// anchoring/locate.ts: npx tsx scripts/selftest.ts anchoring
import { splitLines } from "../../libs/text";
import { FileIndex, normalizePath } from "../../libs/fileindex";
import { buildHunks, diffLines, renderUnifiedDiff } from "../../libs/diff";
import { log } from "../../libs/log";
import { matchesReviewedContent, projectDirsFor, rekeyToolFindings } from "../../gates/static";
import { findStaleThreads } from "../../publish/lifecycle";
import type { FileDiff } from "../../libs/types";
import { SEEDED_FILES, EXPECTED_ANCHORS } from "../../fixtures/seeded-pr";
import { buildTriagePrompt } from "../../prompts/triage";
import { load } from "../../libs/tls";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../../libs/shell";
import { check, eq, section, skip } from "./harness";
import { anchorFinding, mkFile, mkFinding } from "./fixtures";

// --- blob line splitting ---

section("blob line splitting (CRLF / BOM / trailing newline)");
eq("LF three lines", splitLines(Buffer.from("a\nb\nc")), ["a", "b", "c"]);
eq("trailing newline makes no ghost line", splitLines(Buffer.from("a\nb\n")), ["a", "b"]);
eq("CRLF keeps \\r", splitLines(Buffer.from("a\r\nb\r\n")), ["a\r", "b\r"]);
eq("BOM stripped", splitLines(Buffer.from("\uFEFFa\nb")), ["a", "b"]);
eq("empty file", splitLines(Buffer.from("")), []);
eq("single line, no newline", splitLines(Buffer.from("only")), ["only"]);

// --- diff ---
section("diff and hunk line numbers");
{
  const left = ["a", "b", "c", "d", "e"];
  const right = ["a", "b", "X", "d", "e"];
  const edits = diffLines(left, right);
  const { hunks, changedRightLines, changedLeftLines } = buildHunks(left, right, edits);
  eq("single-line replace -> 1 hunk", hunks.length, 1);
  eq("right changed lines = line 3", [...changedRightLines], [3]);
  eq("left deleted lines = line 3", [...changedLeftLines], [3]);
  const h = hunks[0]!;
  check("hunk covers the whole small file", h.rightStart === 1 && h.rightStart + h.rightCount - 1 === 5);
}
{
  // Line numbers must stay correct after an insertion shifts everything below it.
  const left = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"];
  const right = [...left.slice(0, 5), "NEW", ...left.slice(5)];
  const { changedRightLines } = buildHunks(left, right, diffLines(left, right));
  eq("inserted line is right line 6", [...changedRightLines], [6]);
}
{
  const left: string[] = [];
  const right = ["a", "b"];
  const { hunks, changedRightLines, changedLeftLines } = buildHunks(left, right, diffLines(left, right));
  eq("new file: both lines changed", [...changedRightLines], [1, 2]);
  check("new file has a hunk", hunks.length === 1);
}
{
  const same = ["x", "y"];
  const { hunks } = buildHunks(same, same, diffLines(same, same));
  eq("no change -> no hunk", hunks.length, 0);
}
{
  const left = ["b", "c"];
  const right = ["a", "b", "c"];
  const { hunks, changedRightLines, changedLeftLines } = buildHunks(left, right, diffLines(left, right));
  eq("insert at top: rightStart=1", hunks[0]?.rightStart, 1);
  eq("insert at top: leftStart=1", hunks[0]?.leftStart, 1);
  eq("insert at top: changed line = 1", [...changedRightLines], [1]);
}
{
  // Scattered edits in a long file: this is where an off-by-one in hunk headers would
  // silently misplace every downstream comment.
  const bigLeft = Array.from({ length: 200 }, (_, i) => `line${i + 1}();`);
  const bigRight = [...bigLeft];
  bigRight[9] = "CHANGED10();";
  bigRight.splice(100, 0, "INSERTED();");
  bigRight[180] = "CHANGED181();";
  const { hunks, changedRightLines, changedLeftLines } = buildHunks(bigLeft, bigRight, diffLines(bigLeft, bigRight));
  eq("three scattered edits -> 3 hunks", hunks.length, 3);
  eq("changed line numbers correct", [...changedRightLines].sort((a, b) => a - b), [10, 101, 181]);
  // The strongest assertion available: a hunk's declared span must match the real file.
  for (const h of hunks) {
    const bodyRight = h.body
      .split("\n")
      .filter((l) => l.startsWith(" ") || l.startsWith("+"))
      .map((l) => l.slice(1));
    const actual = bigRight.slice(h.rightStart - 1, h.rightStart - 1 + h.rightCount);
    check(
      `hunk@${h.rightStart} declared range matches actual file content`,
      JSON.stringify(bodyRight) === JSON.stringify(actual),
    );
  }
}
{
  const left = ["a", "b"];
  const right = ["a", "B", "c"];
  const rendered = renderUnifiedDiff("/f.ts", buildHunks(left, right, diffLines(left, right)).hunks);
  check("unified diff has @@ header", rendered.includes("@@ -"));
  check("unified diff has +/- lines", rendered.includes("+B") && rendered.includes("-b"));
  // The shape production passes: intake strips the leading slash, and `--- a${path}` then
  // rendered `--- asrc/pay.ts` into every prompt.
  const hunks = buildHunks(left, right, diffLines(left, right)).hunks;
  const header = (r: string) => r.split("\n").slice(0, 2);
  eq("a canonical path gets git's side prefixes", header(renderUnifiedDiff("src/pay.ts", hunks)), ["--- a/src/pay.ts", "+++ b/src/pay.ts"]);
  eq("...and a slash-prefixed one the same, not a double slash", header(renderUnifiedDiff("/src/pay.ts", hunks)), ["--- a/src/pay.ts", "+++ b/src/pay.ts"]);
  eq("a rename names its old path on the left", header(renderUnifiedDiff("src/billing/pay.ts", hunks, "src/pay.ts")), ["--- a/src/pay.ts", "+++ b/src/billing/pay.ts"]);

  // A model that copies the header into `file` must still anchor when the basename alone is
  // ambiguous — which is exactly when the basename tier gives up.
  const twins = new FileIndex([mkFile("api/index.ts", ["x"], [1]), mkFile("web/index.ts", ["y"], [1])]);
  eq("a path copied from the header resolves", twins.resolve("b/web/index.ts").fd?.path, "web/index.ts");
  eq("...from either side", twins.resolve("a/api/index.ts").fd?.path, "api/index.ts");
  const realA = new FileIndex([mkFile("a/src/x.ts", ["x"], [1]), mkFile("src/x.ts", ["y"], [1])]);
  eq("a real top-level a/ directory still wins", realA.resolve("a/src/x.ts").fd?.path, "a/src/x.ts");
}

// --- anchoring ---
section("quote anchoring (core)");

{
  const f = mkFile("/src/app.ts", [
    "function run() {",
    "  const x = compute();",
    "  return x / divisor;",
    "}",
  ], [3]);
  const r = anchorFinding(mkFinding({ quote: "  return x / divisor;" }), [f]);
  eq("exact quote -> line 3", r.anchor?.startLine, 3);
  eq("anchored on right side", r.anchor?.side, "right");
  eq("startOffset is 1", r.anchor?.startOffset, 1);
  check("endOffset covers the whole line", (r.anchor?.endOffset ?? 0) > 1);
}
{
  // The model reformatted the indentation — tier-2 matching must still find it.
  const f = mkFile("/src/app.ts", ["function run() {", "    const x = compute();", "}"], [2]);
  const r = anchorFinding(mkFinding({ quote: "const x = compute();" }), [f]);
  eq("different indentation still locates", r.anchor?.startLine, 2);
}
{
  const f = mkFile("/src/app.ts", ["a();", "b();", "a();"], [1, 2, 3]);
  const r = anchorFinding(mkFinding({ quote: "a();" }), [f]);
  eq("duplicate quote, no context -> ambiguous verdict", r.failure, "quote-ambiguous");
  check("ambiguous returns no anchor (never guess a line)", r.anchor === undefined);
}
{
  const f = mkFile("/src/app.ts", ["a();", "b();", "a();", "c();"], [1, 2, 3, 4]);
  const r = anchorFinding(
    mkFinding({ quote: "a();", context_after: "c();" }),
    [f],
  );
  eq("context_after disambiguates -> line 3", r.anchor?.startLine, 3);
}
{
  const f = mkFile("/src/app.ts", ["a();", "b();", "a();", "c();"], [1, 2, 3, 4]);
  const r = anchorFinding(mkFinding({ quote: "a();", context_before: "b();" }), [f]);
  eq("context_before disambiguates -> line 3", r.anchor?.startLine, 3);
}
{
  const f = mkFile("/src/app.ts", ["one();", "two();"], [1]);
  const r = anchorFinding(mkFinding({ quote: "nonexistent();" }), [f]);
  eq("quote not found -> fail-closed", r.failure, "quote-not-found");
}
{
  const f = mkFile("/src/app.ts", ["a();"], [1]);
  const r = anchorFinding(mkFinding({ file: "/other/file.ts", quote: "a();" }), [f]);
  eq("file not in diff", r.failure, "file-not-in-diff");
}
{
  // A finding about untouched code far from any hunk is not this PR's business.
  const rightLines = Array.from({ length: 60 }, (_, i) => `line${i + 1}();`);
  const leftLines = [...rightLines];
  leftLines[0] = "old();";
  const edits = diffLines(leftLines, rightLines);
  const { hunks, changedRightLines, changedLeftLines } = buildHunks(leftLines, rightLines, edits);
  const f: FileDiff = {
    path: "/src/app.ts",
    changeType: "edit",
    hunks,
    rightLines,
    leftLines,
    changedRightLines,
    changedLeftLines,
    binary: false,
    truncated: false,
    language: "typescript",
  };
  const r = anchorFinding(mkFinding({ quote: "line50();" }), [f]);
  eq("outside changed region -> rejected", r.failure, "outside-changed-lines");
}
{
  const f = mkFile("/src/app.ts", ["if (a) {", "  doThing();", "}"], [1, 2, 3]);
  const r = anchorFinding(mkFinding({ quote: "if (a) {\n  doThing();" }), [f]);
  eq("multi-line quote start line", r.anchor?.startLine, 1);
  eq("multi-line quote end line", r.anchor?.endLine, 2);
}
{
  // CRLF content vs a quote the model echoed without the \r.
  const f = mkFile("/src/app.ts", ["a();\r", "target();\r", "b();\r"], [2]);
  const r = anchorFinding(mkFinding({ quote: "target();" }), [f]);
  eq("CRLF file still locates", r.anchor?.startLine, 2);
}
{
  const f = mkFile("/src/deep/nested/app.ts", ["x();"], [1]);
  const idx = new FileIndex([f]);
  check("path suffix match", idx.resolve("deep/nested/app.ts").fd?.path === "/src/deep/nested/app.ts");
  check("basename match", idx.resolve("app.ts").fd?.path === "/src/deep/nested/app.ts");
  eq("missing file reports not-found", idx.resolve("nope.ts").failure, "not-found");
}
{
  const a = mkFile("/src/a.ts", ["x();"], [1]);
  const b = mkFile("/lib/a.ts", ["x();"], [1]);
  eq("same-name files are ambiguous, no guessing", new FileIndex([a, b]).resolve("a.ts").failure, "ambiguous");
}
{
  // The scenario that motivated the whole project: an identical line exists both in
  // untouched code and in the new code. Naive matching takes the first hit and the comment
  // lands on the wrong function.
  const rightLines = ["import x;", "", "def helper():", "    return 1", "", "def main():", "    return 1"];
  const leftLines = ["import x;", "", "def helper():", "    return 1"];
  const { hunks, changedRightLines, changedLeftLines } = buildHunks(leftLines, rightLines, diffLines(leftLines, rightLines));
  const f: FileDiff = {
    path: "/src/m.py",
    changeType: "edit",
    hunks,
    rightLines,
    leftLines,
    changedRightLines,
    changedLeftLines,
    binary: false,
    truncated: false,
    language: "python",
  };
  const r = anchorFinding(
    mkFinding({ file: "/src/m.py", quote: "    return 1", context_before: "def main():" }),
    [f],
  );
  eq("duplicate line anchors to the change (line 7, not line 4)", r.anchor?.startLine, 7);
}

// The finder schema makes `side` a required enum, so a model given no reason to prefer one
// guesses. A guessed "left" on an added file matched against an empty left side used to
// degrade every finding on every new file in the PR.
{
  const rightLines = ["test('login', () => {", "  expect(1).toBe(1);", "});"];
  const added: FileDiff = {
    path: "/playwright/tests/login.spec.ts",
    changeType: "add",
    hunks: buildHunks([], rightLines, diffLines([], rightLines)).hunks,
    rightLines,
    leftLines: [],
    changedRightLines: new Set([1, 2, 3]),
    changedLeftLines: new Set(),
    binary: false,
    truncated: false,
    language: "typescript",
  };
  const r = anchorFinding(
    mkFinding({ file: "/playwright/tests/login.spec.ts", side: "left", quote: "  expect(1).toBe(1);" }),
    [added],
  );
  eq("guessed side:left on an added file still anchors", r.anchor?.startLine, 2);
  eq("...and is corrected to the right side", r.anchor?.side, "right");

  const miss = anchorFinding(
    mkFinding({ file: "/playwright/tests/login.spec.ts", side: "left", quote: "nowhere();" }),
    [added],
  );
  eq("a quote on neither side is still quote-not-found", miss.failure, "quote-not-found");
  check("empty side is not misreported as a missing file", miss.failure !== "file-not-in-diff");
}
{
  // The fallback must not become an escape hatch for the diff_context filter: a quote that
  // located cleanly but outside the change stays rejected, never retried into an anchor.
  const rightLines = Array.from({ length: 60 }, (_, i) => `line${i + 1}();`);
  const leftLines = [...rightLines];
  leftLines[0] = "old();";
  const { hunks, changedRightLines, changedLeftLines } = buildHunks(leftLines, rightLines, diffLines(leftLines, rightLines));
  const f: FileDiff = {
    path: "/src/app.ts",
    changeType: "edit",
    hunks,
    rightLines,
    leftLines,
    changedRightLines,
    changedLeftLines,
    binary: false,
    truncated: false,
    language: "typescript",
  };
  const r = anchorFinding(mkFinding({ quote: "line50();" }), [f]);
  eq("outside-changed-lines is not retried on the other side", r.failure, "outside-changed-lines");
  check("...and produces no anchor", r.anchor === undefined);
}
{
  // A real left-side finding: the quote is a line this change deleted, so it exists only on
  // the left. The stated side is honoured on the first attempt, no fallback involved.
  const leftLines = ["setup();", "  if (!user) return;", "run();"];
  const rightLines = ["setup();", "run();"];
  const { hunks, changedRightLines, changedLeftLines } = buildHunks(leftLines, rightLines, diffLines(leftLines, rightLines));
  const f: FileDiff = {
    path: "/src/guard.ts",
    changeType: "edit",
    hunks,
    rightLines,
    leftLines,
    changedRightLines,
    changedLeftLines,
    binary: false,
    truncated: false,
    language: "typescript",
  };
  const r = anchorFinding(
    mkFinding({ file: "/src/guard.ts", side: "left", quote: "  if (!user) return;" }),
    [f],
  );
  eq("a deleted line anchors on the left", r.anchor?.startLine, 2);
  eq("...and stays on the left side", r.anchor?.side, "left");
}
{
  // Left-side recovery used to be weaker than right-side recovery for one reason: FileDiff
  // carried changedRightLines and nothing else, so the two rules that rest on "is this a
  // line the PR touched" could not be asked on the left. buildHunks had computed
  // changedLeftLines all along; it just never reached the type. These two assertions are
  // what that costs, from both directions.
  const mkLeft = (leftLines: string[], rightLines: string[], path: string): FileDiff => {
    const { hunks, changedRightLines, changedLeftLines } = buildHunks(leftLines, rightLines, diffLines(leftLines, rightLines));
    return {
      path, changeType: "edit", hunks, rightLines, leftLines,
      changedRightLines, changedLeftLines, binary: false, truncated: false, language: "typescript",
    };
  };

  // 1) Disambiguation. The quote occurs twice on the left, both inside the hunk, and the
  //    model gave no context. Only one of them is a line this change deleted.
  const dup = mkLeft(
    ["a();", "  flush();", "b();", "  flush();", "c();"],
    ["a();", "  flush();", "b();", "c();"],
    "/src/dup.ts",
  );
  const picked = anchorFinding(mkFinding({ file: "/src/dup.ts", side: "left", quote: "  flush();" }), [dup]);
  eq("a repeated left-side quote resolves to the deleted occurrence", picked.anchor?.startLine, 4);
  eq("...on the left", picked.anchor?.side, "left");

  // 2) First-line recovery. The model quotes a deleted block and paraphrases its body, so
  //    nothing matches whole — but the opening line is verbatim, unique, and deleted.
  const block = mkLeft(
    ["import x;", "", "function old(a) {", "  return a + 1;", "}", "", "function keep() {", "  return 2;", "}"],
    ["import x;", "", "function keep() {", "  return 2;", "}"],
    "/src/block.ts",
  );
  const head = anchorFinding(
    mkFinding({ file: "/src/block.ts", side: "left", quote: "function old(a) {\n  return a * 2;\n}" }),
    [block],
  );
  eq("a drifted left-side block falls back to its first line", head.anchor?.startLine, 3);
  eq("...still on the left", head.anchor?.side, "left");

  // The bargain the fallback rests on is unchanged: unique AND changed. A first line that
  // is common stays a guess, and a guess is the one thing this module refuses to make.
  const common = mkLeft(
    ["try {", "  a();", "} catch {}", "try {", "  b();", "} catch {}"],
    ["try {", "  a();", "} catch {}"],
    "/src/common.ts",
  );
  eq(
    "a non-unique first line is still not evidence",
    anchorFinding(mkFinding({ file: "/src/common.ts", side: "left", quote: "try {\n  z();\n} catch {}" }), [common]).anchor,
    undefined,
  );
}

section("FileIndex: one resolver for foreign paths");
{
  const f = mkFile("src/App.ts", ["x();"], [1]);
  const g = mkFile("src/lib/util.ts", ["y();"], [1]);
  const idx = new FileIndex([f, g]);
  eq("exact", idx.resolve("src/App.ts").fd?.path, "src/App.ts");
  eq("leading slash and backslashes normalize away", idx.resolve("\\src\\App.ts").fd?.path, "src/App.ts");
  eq("case-insensitive unique", idx.resolve("src/app.ts").fd?.path, "src/App.ts");
  eq("suffix", idx.resolve("lib/util.ts").fd?.path, "src/lib/util.ts");
  eq("basename", idx.resolve("util.ts").fd?.path, "src/lib/util.ts");
  check("ambiguity detail names the tier", (() => {
    const two = new FileIndex([mkFile("a/x.ts", ["a();"], [1]), mkFile("b/x.ts", ["b();"], [1])]);
    const r = two.resolve("x.ts");
    return r.failure === "ambiguous" && r.detail.includes("2 changed files");
  })());
  eq("normalizePath is the one owner of the canonical rule", normalizePath("\\a\\b.ts"), "a/b.ts");
}
{
  // A renamed file cited by its old path.
  const f = { ...mkFile("src/new-name.ts", ["x();"], [1]), originalPath: "src/old-name.ts" };
  eq("originalPath tier", new FileIndex([f]).resolve("src/old-name.ts").fd?.path, "src/new-name.ts");
}
{
  // resolveTool: the prefixed exact hit wins when the tool's coordinates line up.
  const a = mkFile("svc/src/Main.java", ["a();"], [1]);
  eq("prefixed exact hit", new FileIndex([a]).resolveTool("svc", "src/Main.java").fd?.path, "svc/src/Main.java");
}
{
  // A bare filename from a project-scoped tool must not cross into another module: with
  // app/util.ts unchanged, "util.ts" reported from app/ must NOT resolve to web/util.ts.
  const web = mkFile("web/util.ts", ["w();"], [1]);
  const idx = new FileIndex([web]);
  eq("bare filename with a prefix does not cross projects", idx.resolveTool("app", "util.ts").failure, "not-found");
  eq("...but a multi-segment source-root path still falls back", idx.resolveTool("app", "web/util.ts").fd?.path, "web/util.ts");
  eq("...and at the workdir root the full ladder applies", idx.resolveTool("", "util.ts").fd?.path, "web/util.ts");
}
{
  // An ambiguous FILE degrades under its own failure name — "file not in this change"
  // would be actively false for a path that matched twice.
  const a = mkFile("a/x.ts", ["a();"], [1]);
  const b = mkFile("b/x.ts", ["b();"], [1]);
  const r = anchorFinding(mkFinding({ file: "x.ts", quote: "a();" }), [a, b]);
  eq("ambiguous file maps to file-ambiguous", r.failure, "file-ambiguous");
  check("...and carries the ambiguity detail", (r.detail ?? "").includes("2 changed files"));
}
{
  // Rename trail for stale-thread resolution: a thread on the old path finds the renamed
  // file, so its staleness is judged against the file's current content.
  const renamed = { ...mkFile("src/new.ts", ["x();"], [1]), originalPath: "src/old.ts" };
  const t = {
    id: 7, status: "active",
    comments: [{ id: 1, content: "<!-- prloop -->issue" }],
    threadContext: { filePath: "/src/old.ts", rightFileStart: { line: 99, offset: 1 } },
  };
  eq("a thread on the pre-rename path is judged against the renamed file",
    findStaleThreads([t], new FileIndex([renamed])).length, 1);
}
{
  // Regression: a re-keyed tool finding reaches the triage prompt with real content.
  // Before the FileIndex, the suffix-resolved finding kept the tool's own path string and
  // the prompt's exact-only lookup fell back to "(no matching file content found)" — the
  // triage model judged with no code in front of it.
  const fd = mkFile("svc/src/main/java/com/acme/Svc.java", ["a();", "b();"], [2]);
  const rekeyed = rekeyToolFindings(
    [{ tool: "spotbugs", tier: "triage" as const, ruleId: "NP", message: "m", file: "com/acme/Svc.java", line: 2, severity: "high" as const }],
    "svc",
    new FileIndex([fd]),
  );
  const items = rekeyed.kept.map((f, i) => ({
    index: i, tool: f.tool, ruleId: f.ruleId, message: f.message, file: f.file, line: f.line, severity: f.severity,
  }));
  const prompt = buildTriagePrompt(items, new FileIndex([fd]), 3);
  check("triage prompt carries the real snippet", prompt.includes("b();"));
  check("...not the no-content fallback", !prompt.includes("no matching file content found"));
}

// Tool findings skip quote anchoring entirely, so a PRR_WORKDIR checkout that disagrees
// with the reviewed iteration puts every static comment on the wrong line, silently. This
// content check is the only thing standing between that and a published comment.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-workdir-"));
  const reviewed = ["def run():", "    return compute()", ""];

  fs.writeFileSync(path.join(dir, "same.py"), "def run():\n    return compute()\n\n");
  check("identical checkout is accepted", matchesReviewedContent(path.join(dir, "same.py"), reviewed));

  // core.autocrlf rewrites line endings on checkout; that is not a content difference and
  // must not disable static analysis on every file for every Windows user.
  fs.writeFileSync(path.join(dir, "crlf.py"), "def run():\r\n    return compute()\r\n\r\n");
  check("CRLF-only difference is still a match", matchesReviewedContent(path.join(dir, "crlf.py"), reviewed));

  // One edited line is the dangerous case: same length, so line numbers still resolve and
  // the finding looks perfectly plausible while pointing at code that no longer exists.
  fs.writeFileSync(path.join(dir, "edited.py"), "def run():\n    return cached()\n\n");
  check("a one-line difference is rejected", !matchesReviewedContent(path.join(dir, "edited.py"), reviewed));

  fs.writeFileSync(path.join(dir, "longer.py"), "def run():\n    log()\n    return compute()\n\n");
  check("an added line is rejected", !matchesReviewedContent(path.join(dir, "longer.py"), reviewed));

  check("a missing file is rejected", !matchesReviewedContent(path.join(dir, "gone.py"), reviewed));
  fs.rmSync(dir, { recursive: true, force: true });
}

// tsc takes no file arguments — it is driven entirely by its working directory. Resolving
// which project a target belongs to is what decides whether the repo's only fact-tier tool
// runs at all, or silently checks the wrong tree.
{
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prloop-proj-")));
  const mk = (p: string) => {
    fs.mkdirSync(path.join(root, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), "{}");
  };
  const tsc = {
    name: "tsc", bin: "npx", args: () => [], format: "tsc-text" as const,
    tier: "fact" as const, requires: "tsconfig.json",
  };

  mk("playwright/tsconfig.json");
  const nested = projectDirsFor(tsc, ["playwright/tests/a.spec.ts", "playwright/tests/b.spec.ts"], root);
  eq("a subdirectory project resolves to one dir", nested.length, 1);
  eq("...the dir holding tsconfig.json", nested[0]?.dir, path.join(root, "playwright"));
  eq("...carrying both of its files", nested[0]?.files.length, 2);

  // Two projects in one change set must not collapse into whichever is found first.
  mk("api/tsconfig.json");
  eq("two projects produce two runs",
    projectDirsFor(tsc, ["playwright/tests/a.spec.ts", "api/src/h.ts"], root).length, 2);

  // Nearest ancestor, not outermost: a root config must not swallow a nested project.
  mk("tsconfig.json");
  eq("the nearest tsconfig wins over the root one",
    projectDirsFor(tsc, ["playwright/tests/a.spec.ts"], root)[0]?.dir, path.join(root, "playwright"));
  eq("a file with no nearer config falls back to the root",
    projectDirsFor(tsc, ["loose.ts"], root)[0]?.dir, root);

  eq("an unfindable marker yields no runs, not a wrong-dir run",
    projectDirsFor({ ...tsc, requires: "nope.json" }, ["playwright/tests/a.spec.ts"], root).length, 0);

  const noMarker = projectDirsFor({ ...tsc, requires: undefined }, ["a.ts"], root);
  eq("a tool with no marker runs once", noMarker.length, 1);
  eq("...at the workdir itself", noMarker[0]?.dir, root);

  // A Maven aggregator matches the marker but owns no sources: maven-pmd-plugin's
  // canGenerateReportInternal returns false for packaging=pom, so it writes nothing and
  // still exits 0 — surfacing as a "produced no report" skip that reads like a crash.
  const agg = { ...tsc, requires: "pom.xml", skipProjectWhen: /<packaging>\s*pom\s*<\/packaging>/ };
  fs.mkdirSync(path.join(root, "core/src"), { recursive: true });
  fs.writeFileSync(path.join(root, "pom.xml"), "<project><packaging>pom</packaging></project>");
  fs.writeFileSync(path.join(root, "core/pom.xml"), "<project><packaging>jar</packaging></project>");
  eq("a file inside a module resolves to the module",
    path.basename(projectDirsFor(agg, ["core/src/A.java"], root)[0]?.dir ?? ""), "core");
  eq("a file under the aggregator alone resolves to nothing",
    projectDirsFor(agg, ["tools/H.java"], root).length, 0);
  // Without the guard the same lookup selects the aggregator — the reported failure.
  eq("...which the plain marker check would have selected",
    projectDirsFor({ ...agg, skipProjectWhen: undefined }, ["tools/H.java"], root)[0]?.dir, root);
  fs.rmSync(root, { recursive: true, force: true });
}

section("real PR anchoring (seeded-defect range)");
{
  const seeded: FileDiff[] = SEEDED_FILES.map((f) => {
    const leftLines = splitLines(Buffer.from(f.base, "utf8"));
    const rightLines = splitLines(Buffer.from(f.head, "utf8"));
    const { hunks, changedRightLines, changedLeftLines } = buildHunks(leftLines, rightLines, diffLines(leftLines, rightLines));
    return {
      path: f.path,
      changeType: "edit" as const,
      hunks,
      rightLines,
      leftLines,
      changedRightLines,
      changedLeftLines,
      binary: false,
      truncated: false,
      language: f.language,
    };
  });

  for (const e of EXPECTED_ANCHORS) {
    const r = anchorFinding(
      mkFinding({
        file: e.file,
        quote: e.quote,
        context_before: e.contextBefore,
        context_after: e.contextAfter,
      }),
      seeded,
    );
    if (typeof e.expect === "number") {
      eq(e.name, r.anchor?.startLine, e.expect);
    } else {
      eq(e.name, r.failure, e.expect);
      check(`${e.name} (must not return an anchor)`, r.anchor === undefined);
    }
  }
}

section("anchoring: blank-elastic multi-line quotes");
{
  // Model quotes a small function keeping its interior blank line; the file has the same
  // two statements adjacent elsewhere. The true (blank-separated) location must win.
  const f = mkFile("/src/mod.py", [
    "cleanup()",        // 1  — adjacent duplicate
    "close()",          // 2
    "def shutdown():",  // 3
    "    cleanup()",    // 4
    "",                 // 5
    "    close()",      // 6
  ], [4, 5, 6]);
  const r = anchorFinding(mkFinding({ file: "/src/mod.py", quote: "    cleanup()\n\n    close()" }), [f]);
  eq("verbatim quote across a blank line anchors at its true location", r.anchor?.startLine, 4);
  eq("window spans through the blank line", r.anchor?.endLine, 6);

  // The same quote WITHOUT the blank line must still find the blank-separated original.
  const g = mkFile("/src/only.py", [
    "def shutdown():",
    "    cleanup()",
    "",
    "    close()",
  ], [2, 3, 4]);
  const r2 = anchorFinding(mkFinding({ file: "/src/only.py", quote: "    cleanup()\n    close()" }), [g]);
  eq("blankless quote of blank-separated code still anchors", r2.anchor?.startLine, 2);
  eq("...and its end covers the real last line", r2.anchor?.endLine, 4);
}

section("anchoring: hunk gate uses the whole span");
{
  // A quote that STARTS above the hunk but contains the changed line must not be rejected
  // as outside-changed-lines: the changed code is inside the quoted span.
  const lines = [
    "function f() {",   // 1
    "  a();",           // 2
    "  b();",           // 3
    "  c();",           // 4
    "  d();",           // 5
    "  e();",           // 6
    "  f();",           // 7
    "  g();",           // 8
    "  h();",           // 9
    "  fixed();",       // 10 ← the actual change
    "}",                // 11
  ];
  const f: FileDiff = {
    path: "/src/span.ts", changeType: "edit", binary: false, truncated: false,
    language: "typescript", rightLines: lines, leftLines: lines.slice(0, 9).concat(["  old();", "}"]),
    changedRightLines: new Set([10]),
    changedLeftLines: new Set(),
    hunks: [{ leftStart: 4, leftCount: 8, rightStart: 4, rightCount: 8, body: "" }],
  };
  const r = anchorFinding(mkFinding({ file: "/src/span.ts", quote: lines.slice(0, 11).join("\n") }), [f]);
  eq("span containing the hunk is accepted even though it starts above it", r.anchor?.startLine, 1);
}

section("anchoring: context-contradicted exact singleton");
{
  // Line 2 (intended, indented, changed) vs line 6 (identical text at col 0, unchanged).
  // The model strips the indentation, so tier 1 uniquely hits the WRONG line 6; the
  // provided context only fits line 2, which tier 2 can see. Context must win.
  const f = mkFile("/src/ctx.ts", [
    "function inner() {",  // 1
    "  return null;",      // 2 ← intended
    "}",                   // 3
    "function outer() {",  // 4
    "  run();",            // 5
    "return null;",        // 6 — exact match for the unindented quote
    "}",                   // 7
  ], [2, 6]);
  const r = anchorFinding(
    mkFinding({
      file: "/src/ctx.ts",
      quote: "return null;",
      context_before: "function inner() {",
    }),
    [f],
  );
  // both 2 and 6 have "}" after; only 2 has the matching before-context
  eq("looser tier with confirming context beats the exact-but-contradicted hit", r.anchor?.startLine, 2);

  // Same setup but context matches the exact hit → tier 1 result stands.
  const r2 = anchorFinding(
    mkFinding({ file: "/src/ctx.ts", quote: "return null;", context_before: "  run();" }),
    [f],
  );
  eq("exact hit with confirming context is kept", r2.anchor?.startLine, 6);
}

section("anchoring: the reshapings a model applies to a quote (recovery, still fail-closed)");
{
  // (a) The model quoted the DIFF, `+` column and all. Raw first, always: these characters
  // are ordinary source text too.
  const plus = mkFile("/src/timer.ts", ["function run() {", "  const t = setTimeout(fn, 0);", "}"], [2]);
  const r = anchorFinding(mkFinding({ file: "/src/timer.ts", quote: "+  const t = setTimeout(fn, 0);" }), [plus]);
  eq("a quote that kept the diff's + column still anchors", r.anchor?.startLine, 2);

  const doc = mkFile("/docs/example.md", [
    "```diff",         // 1
    "+  const x = 1;", // 2 ← the quote, which really does start with '+'
    "```",             // 3
    "  const x = 1;",  // 4
  ], [1, 2, 3, 4]);
  const rawFirst = anchorFinding(mkFinding({ file: "/docs/example.md", quote: "+  const x = 1;" }), [doc]);
  eq("raw first: a line that really starts with + is not re-read as a diff prefix", rawFirst.anchor?.startLine, 2);

  // A mixed +/- excerpt is two file versions at once. Stripping either side would anchor a
  // deleted line onto the new file, so nothing is stripped and the finding degrades.
  const mixed = mkFile("/src/mix.ts", ["const timeout = 30;"], [1]);
  const rMixed = anchorFinding(
    mkFinding({ file: "/src/mix.ts", quote: "-const timeout = 5;\n+const timeout = 30;" }),
    [mixed],
  );
  eq("a mixed +/- excerpt is not silently half-stripped", rMixed.failure, "quote-not-found");
}
{
  // (b) "..." on a line of its own means "these lines, then a gap, then these".
  const f = mkFile("/src/svc.py", [
    "def handler(req):",          // 1
    "    conn = pool.get()",      // 2
    "    rows = conn.query(req)", // 3
    "    for r in rows:",         // 4
    "        emit(r)",            // 5
    "    return rows",            // 6  — conn is never returned to the pool
  ], [1, 2, 3, 4, 5, 6]);
  const r = anchorFinding(
    mkFinding({ file: "/src/svc.py", quote: "    conn = pool.get()\n    ...\n    return rows" }),
    [f],
  );
  eq("an elided quote matches its segments in order", r.anchor?.startLine, 2);
  eq("...and the span reaches the last segment", r.anchor?.endLine, 6);

  // The gap is bounded: an elision must never staple two unrelated regions together. Line 1
  // is unique but untouched, so the last-resort path declines it too and this stays failed.
  const far = mkFile("/src/far.py", [
    "    conn = pool.get()",
    ...Array.from({ length: 40 }, (_, i) => `    step${i}()`),
    "    return rows",
  ], [42]);
  const rFar = anchorFinding(
    mkFinding({ file: "/src/far.py", quote: "    conn = pool.get()\n    ...\n    return rows" }),
    [far],
  );
  eq("segments further apart than the bound are not one quote", rFar.failure, "quote-not-found");
}
{
  // (c) The model quoted a block and reflowed its body; only the opening line survived.
  const f = mkFile("/src/api.ts", [
    "export async function transfer(from: string, to: string, amount: number) {", // 1
    "  const a = await load(from);",                                              // 2
    "  a.balance -= amount;",                                                     // 3
    "  await save(a);",                                                           // 4
    "}",                                                                          // 5
  ], [1, 2, 3, 4, 5]);
  const r = anchorFinding(
    mkFinding({
      file: "/src/api.ts",
      quote:
        "export async function transfer(from: string, to: string, amount: number) {\n" +
        "  const a = await load(from); a.balance -= amount; await save(a);",
    }),
    [f],
  );
  eq("a unique first line rescues a quote whose body drifted", r.anchor?.startLine, 1);

  const dup = mkFile("/src/dup.ts", [
    "try {", "  first();", "} catch {}", "try {", "  second();", "} catch {}",
  ], [1, 2, 3, 4, 5, 6]);
  const rDup = anchorFinding(mkFinding({ file: "/src/dup.ts", quote: "try {\n  somethingElse();" }), [dup]);
  eq("a common first line stays failed rather than guessing", rDup.failure, "quote-not-found");
  check("...and returns no anchor", rDup.anchor === undefined);

  // The other half of the bargain: unique is not enough when the line is untouched code.
  const untouched = mkFile("/src/audit.ts", [
    "function audit(entry: Entry) {", // 1 — unique, but not a line this PR changed
    "  log(entry);",                  // 2
    "  persist(entry);",              // 3 ← the change
    "}",                              // 4
  ], [3]);
  const rUn = anchorFinding(
    mkFinding({ file: "/src/audit.ts", quote: "function audit(entry: Entry) {\n  log(entry); persist(entry);" }),
    [untouched],
  );
  eq("a unique first line on untouched code is not evidence either", rUn.failure, "quote-not-found");
}
{
  // (d) The model retyped ASCII punctuation as typographic punctuation. Folding is the
  // loosest thing this module does, so it only counts when the context confirms it.
  const f = mkFile("/src/i18n.ts", [
    "function greet(name: string) {",
    "  return t('hello', { name });",
    "}",
  ], [1, 2, 3]);
  const smart = "  return t(‘hello’, { name });"; // curly single quotes
  const r = anchorFinding(
    mkFinding({ file: "/src/i18n.ts", quote: smart, context_before: "function greet(name: string) {" }),
    [f],
  );
  eq("curly quotes fold to ASCII when the context confirms the line", r.anchor?.startLine, 2);
  const unconfirmed = anchorFinding(mkFinding({ file: "/src/i18n.ts", quote: smart }), [f]);
  eq("...and a folded match with nothing to confirm it stays failed", unconfirmed.failure, "quote-not-found");
  check("...with no anchor", unconfirmed.anchor === undefined);

  // NFKC also width-folds the full-width punctuation that comes back with CJK sources.
  const wide = mkFile("/src/msg.ts", ["const msg = t('save failed');", "export default msg;"], [1, 2]);
  const rWide = anchorFinding(
    mkFinding({
      file: "/src/msg.ts",
      quote: "const msg = t（'save failed'）;", // full-width parentheses
      context_after: "export default msg;",
    }),
    [wide],
  );
  eq("full-width punctuation folds too, with confirming context", rWide.anchor?.startLine, 1);
}
{
  // (e) The model copied a line-number gutter out of a code viewer.
  const f = mkFile("/src/db.ts", ["const rows = await q(sql);", "  return rows;"], [1, 2]);
  eq(
    "a copied line-number gutter is stripped (viewer spelling)",
    anchorFinding(mkFinding({ file: "/src/db.ts", quote: "12 | const rows = await q(sql);" }), [f]).anchor?.startLine,
    1,
  );
  eq(
    "...and the grep -n spelling",
    anchorFinding(mkFinding({ file: "/src/db.ts", quote: "12: const rows = await q(sql);" }), [f]).anchor?.startLine,
    1,
  );
  // Raw first again: a port mapping is not a gutter, and its number is part of the code.
  const yaml = mkFile("/deploy/ports.yaml", ["ports:", "  8080: backend"], [1, 2]);
  eq(
    "a YAML mapping keeps the number the gutter rule would have eaten",
    anchorFinding(mkFinding({ file: "/deploy/ports.yaml", quote: "  8080: backend" }), [yaml]).anchor?.startLine,
    2,
  );
}
{
  // (f) Context is scored at the LOOSEST tier, always. The quote is exact at tier 1 in two
  // places and only the context separates them — but the model re-indented that context
  // line, so scoring it at the quote's own tier gave both candidates 0 and the finding was
  // ruled ambiguous although the answer was one normalisation away.
  const f = mkFile("/src/tx.ts", [
    "async function debit() {",  // 1
    "      await save(acct);",   // 2 — deeply indented in the file
    "  await commit();",         // 3 ← intended
    "}",                         // 4
    "async function credit() {", // 5
    "  await log(acct);",        // 6
    "  await commit();",         // 7 — identical to line 3 at every tier
    "}",                         // 8
  ], [1, 2, 3, 4, 5, 6, 7, 8]);
  const r = anchorFinding(
    mkFinding({ file: "/src/tx.ts", quote: "  await commit();", context_before: "await save(acct);" }),
    [f],
  );
  eq("re-indented context still disambiguates a tier-1 duplicate", r.anchor?.startLine, 3);
  // Context still cannot CREATE an anchor: it only chooses between candidates the quote found.
  const invented = anchorFinding(
    mkFinding({ file: "/src/tx.ts", quote: "  await rollback();", context_before: "await save(acct);" }),
    [f],
  );
  eq("a quote that is not in the file is not rescued by its context", invented.failure, "quote-not-found");
}
{
  // The recovery paths must not move a single existing expectation. Same fixture as "real PR
  // anchoring" above, re-asserted here as one line so a regression in any path above fails
  // in the section that caused it.
  const seeded: FileDiff[] = SEEDED_FILES.map((f) => {
    const leftLines = splitLines(Buffer.from(f.base, "utf8"));
    const rightLines = splitLines(Buffer.from(f.head, "utf8"));
    const { hunks, changedRightLines, changedLeftLines } = buildHunks(leftLines, rightLines, diffLines(leftLines, rightLines));
    return {
      path: f.path,
      changeType: "edit" as const,
      hunks,
      rightLines,
      leftLines,
      changedRightLines,
      changedLeftLines,
      binary: false,
      truncated: false,
      language: f.language,
    };
  });
  const moved = EXPECTED_ANCHORS.filter((e) => {
    const r = anchorFinding(
      mkFinding({ file: e.file, quote: e.quote, context_before: e.contextBefore, context_after: e.contextAfter }),
      seeded,
    );
    return typeof e.expect === "number"
      ? r.anchor?.startLine !== e.expect
      : r.failure !== e.expect || r.anchor !== undefined;
  }).map((e) => e.name);
  eq("every seeded-PR expectation still holds exactly", moved, []);
  check("...over the whole fixture, not an empty list", EXPECTED_ANCHORS.length >= 13, `${EXPECTED_ANCHORS.length}`);
}
