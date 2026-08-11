// Offline self-test. Anchoring is the piece that decides whether comments land on the right
// line, so it gets the most coverage here — these assertions are the regression net for the
// class of bug that motivated the whole project.
import { splitLines } from "../ado/blobs";
import { anchorFinding as anchorWithIndex } from "../anchoring/locate";
import { FileIndex, normalizePath } from "../libs/fileindex";
import { parsePrUrl, prBase } from "../ado/client";
import { buildHunks, diffLines, renderUnifiedDiff } from "../libs/diff";
import { parseJsonObject } from "../libs/json";
import { detectLanguage, isNoiseFile, isReviewable } from "../libs/lang";
import { buildDiffPayload } from "../libs/payload";
import { htmlToText } from "../libs/html";
import { globToRegExp, loadRules, selectRules } from "../libs/rules";
import { finalize } from "../gates/aggregate";
import { bypassesProxy, redactProxy } from "../libs/proxy";
import { parseVerdict as parseVerdictForTest } from "../gates/skeptic";
import { environmentFailure, filterToChangedLines, matchesReviewedContent, projectDirsFor, rekeyToolFindings } from "../gates/static";
import { renderFindingComment } from "../publish/format";
import { parseToolOutput } from "../profiles/parsers";
import { selectProfiles, filesForProfile, PROFILES } from "../profiles";
import { lastReviewedIteration, findStaleThreads, collectDismissals, iterationMarker } from "../publish/lifecycle";
import { postedPositions } from "../publish/publish";
import {
  dismissedCategoryHints,
  dismissedFingerprints,
  learningsPath,
  loadDismissals,
  recordDismissals,
} from "../libs/learnings";
import { triageAndConvert } from "../gates/static";
import type { ToolFinding } from "../profiles/types";
import type { PrRef } from "../libs/types";
import type { ToolSpec } from "../profiles/types";
import type { AnchoredFinding, FileDiff, RawFinding } from "../libs/types";
import { SEEDED_FILES, EXPECTED_ANCHORS } from "../fixtures/seeded-pr";
import { buildTriagePrompt } from "../prompts/triage";
import { load, sourcePaths } from "../libs/tls";
import { Semaphore } from "../libs/limit";
import { describeBadCompletion, isTransientModelError } from "../models/runner";
import { explainSpawnError, planSpawn, planKill, killTree } from "../libs/shell";
import { spawn as spawnChild } from "node:child_process";
import { buildInvocation } from "../models/opencode";
import { anchorAndDedupe } from "../gates/aggregate";
import type { FinderOutput } from "../gates/finder";
import { FINDINGS_SCHEMA, REQUIREMENT_SCHEMA, TRIAGE_SCHEMA, VERDICT_SCHEMA } from "../models/schemas";
import { PRLOOP_ROOT } from "../config";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  [OK]   ${name}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq<T>(name: string, actual: T, expected: T) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `expected ${e}, got ${a}`);
}

function section(t: string) {
  console.log(`\n${t}`);
}

// --- blob line splitting ---
// The production anchorFinding takes a FileIndex; fixtures here carry bare FileDiff
// arrays, so this wrapper builds the index at the call site.
const anchorFinding = (finding: RawFinding, files: FileDiff[]) =>
  anchorWithIndex(finding, new FileIndex(files));

section("blob line splitting (CRLF / BOM / trailing newline)");
eq("LF three lines", splitLines(Buffer.from("a\nb\nc")), ["a", "b", "c"]);
eq("trailing newline makes no ghost line", splitLines(Buffer.from("a\nb\n")), ["a", "b"]);
eq("CRLF keeps \\r", splitLines(Buffer.from("a\r\nb\r\n")), ["a\r", "b\r"]);
eq("BOM stripped", splitLines(Buffer.from("﻿a\nb")), ["a", "b"]);
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
  const { hunks, changedRightLines } = buildHunks(left, right, diffLines(left, right));
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
  const { hunks, changedRightLines } = buildHunks(left, right, diffLines(left, right));
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
  const { hunks, changedRightLines } = buildHunks(bigLeft, bigRight, diffLines(bigLeft, bigRight));
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
}

// --- anchoring ---
section("quote anchoring (core)");

function mkFile(path: string, rightLines: string[], changed: number[]): FileDiff {
  const leftLines = rightLines.filter((_, i) => !changed.includes(i + 1));
  const edits = diffLines(leftLines, rightLines);
  const { hunks, changedRightLines } = buildHunks(leftLines, rightLines, edits);
  return {
    path,
    changeType: "edit",
    hunks,
    rightLines,
    leftLines,
    changedRightLines: changedRightLines.size ? changedRightLines : new Set(changed),
    binary: false,
    truncated: false,
    language: detectLanguage(path),
  };
}

function mkFinding(over: Partial<RawFinding>): RawFinding {
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
  const { hunks, changedRightLines } = buildHunks(leftLines, rightLines, edits);
  const f: FileDiff = {
    path: "/src/app.ts",
    changeType: "edit",
    hunks,
    rightLines,
    leftLines,
    changedRightLines,
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
  const { hunks, changedRightLines } = buildHunks(leftLines, rightLines, diffLines(leftLines, rightLines));
  const f: FileDiff = {
    path: "/src/m.py",
    changeType: "edit",
    hunks,
    rightLines,
    leftLines,
    changedRightLines,
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
  const { hunks, changedRightLines } = buildHunks(leftLines, rightLines, diffLines(leftLines, rightLines));
  const f: FileDiff = {
    path: "/src/app.ts",
    changeType: "edit",
    hunks,
    rightLines,
    leftLines,
    changedRightLines,
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
  const { hunks, changedRightLines } = buildHunks(leftLines, rightLines, diffLines(leftLines, rightLines));
  const f: FileDiff = {
    path: "/src/guard.ts",
    changeType: "edit",
    hunks,
    rightLines,
    leftLines,
    changedRightLines,
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

// --- URL parsing ---
section("PR URL parsing");
{
  const r = parsePrUrl("https://dev.azure.com/myorg/MyProject/_git/my-repo/pullrequest/1234");
  eq("org", r.org, "myorg");
  eq("project", r.project, "MyProject");
  eq("repo", r.repoId, "my-repo");
  eq("prId", r.prId, 1234);
}
{
  const r = parsePrUrl("https://dev.azure.com/org/Proj%20With%20Space/_git/repo/pullrequest/7");
  eq("URL-encoded project name", r.project, "Proj With Space");
}
{
  // The API base must come from the URL, not be rebuilt from a configured host — that is
  // what broke on-prem: the virtual directory was dropped and the collection was mistaken
  // for the org, producing a request to an entirely different server.
  const cloud = parsePrUrl("https://dev.azure.com/myorg/MyProject/_git/my-repo/pullrequest/1234");
  eq("cloud API base", cloud.baseUrl, "https://dev.azure.com/myorg");

  const onpremPrefix = parsePrUrl(
    "https://tfs.corp.local/tfs/DefaultCollection/MyProject/_git/my-repo/pullrequest/42",
  );
  eq("on-prem with virtual dir: API base keeps /tfs", onpremPrefix.baseUrl, "https://tfs.corp.local/tfs/DefaultCollection");
  eq("on-prem with virtual dir: collection", onpremPrefix.org, "DefaultCollection");
  eq("on-prem with virtual dir: project", onpremPrefix.project, "MyProject");
  eq("on-prem with virtual dir: repo", onpremPrefix.repoId, "my-repo");
  eq("on-prem with virtual dir: PR id", onpremPrefix.prId, 42);

  const onpremPlain = parsePrUrl("https://ado.corp.local/DefaultCollection/Proj/_git/repo/pullrequest/9");
  eq("on-prem without virtual dir", onpremPlain.baseUrl, "https://ado.corp.local/DefaultCollection");

  const onpremDeep = parsePrUrl("https://srv.corp.local/tfs/apps/TeamCollection/Proj/_git/repo/pullrequest/3");
  eq("on-prem nested virtual dirs", onpremDeep.baseUrl, "https://srv.corp.local/tfs/apps/TeamCollection");

  const port = parsePrUrl("https://tfs.corp.local:8443/tfs/Coll/Proj/_git/repo/pullrequest/5");
  eq("on-prem custom port kept", port.baseUrl, "https://tfs.corp.local:8443/tfs/Coll");

  const vsts = parsePrUrl("https://myorg.visualstudio.com/MyProject/_git/repo/pullrequest/8");
  eq("visualstudio.com: collection in hostname, empty path", vsts.baseUrl, "https://myorg.visualstudio.com");
  eq("visualstudio.com: project", vsts.project, "MyProject");
}
{
  // The composed REST path is what actually gets requested; assert it end to end.
  const r = parsePrUrl("https://tfs.corp.local/tfs/DefaultCollection/MyProject/_git/my-repo/pullrequest/42");
  eq(
    "on-prem composed PR API URL",
    prBase(r),
    "https://tfs.corp.local/tfs/DefaultCollection/MyProject/_apis/git/repositories/my-repo/pullRequests/42",
  );
}
{
  let threw = false;
  try {
    parsePrUrl("https://dev.azure.com/org/proj/_git/repo");
  } catch {
    threw = true;
  }
  check("missing pullrequest segment throws", threw);
}

// --- JSON parsing ---
section("model output parsing (fail-closed)");
{
  const r = parseJsonObject<{ findings: unknown[] }>('{"findings":[]}');
  check("plain JSON", r.ok && Array.isArray(r.value.findings));
}
{
  const r = parseJsonObject<{ a: number }>('```json\n{"a":1}\n```');
  check("markdown fence", r.ok && r.value.a === 1);
}
{
  const r = parseJsonObject<{ a: number }>('<think>reasoning</think>\n{"a":2}');
  check("think block prefix", r.ok && r.value.a === 2);
}
{
  const r = parseJsonObject<{ a: string }>('some prose\n{"a":"has } brace"}\ntrailer');
  check("braces inside strings do not break balancing", r.ok && r.value.a === "has } brace");
}
{
  const r = parseJsonObject("not JSON at all");
  check("non-JSON -> failure, not a throw", !r.ok);
}
{
  const r = parseJsonObject("");
  check("empty string -> failure", !r.ok);
}

// --- language / noise ---
section("language detection and noise filtering");
eq("python", detectLanguage("/src/a.py"), "python");
eq("java", detectLanguage("/src/A.java"), "java");
eq("tsx", detectLanguage("/app/page.tsx"), "tsx");
check("lockfile is noise", isNoiseFile("/package-lock.json"));
check(".next output is noise", isNoiseFile("/apps/web/.next/static/x.js"));
check("ordinary ts is reviewable", isReviewable("/src/a.ts"));
check("markdown is not reviewed", !isReviewable("/README.md"));

// --- payload budget ---
section("diff budget");
{
  const files = [
    mkFile("/a.ts", ["a1();", "a2();"], [1, 2]),
    mkFile("/b.py", ["b1()", "b2()"], [1, 2]),
  ];
  const p = buildDiffPayload(files, 100_000);
  eq("budget is enough, everything included", p.includedFiles.length, 2);
  check("payload contains filenames", p.text.includes("/a.ts") && p.text.includes("/b.py"));
}
{
  const files = [
    mkFile("/a.ts", ["a1();"], [1]),
    mkFile("/b.ts", ["b1();"], [1]),
  ];
  const p = buildDiffPayload(files, 200);
  check("over budget still keeps at least one file", p.includedFiles.length >= 1);
  check("skipped files are recorded", p.includedFiles.length + p.omittedFiles.length === 2);
  if (p.omittedFiles.length > 0) check("skip list appears in payload", p.text.includes("omitted"));
}

// --- work item HTML ---
section("Work Item HTML to plain text");
eq("<li> becomes a bullet", htmlToText("<ul><li>criterion one</li><li>criterion two</li></ul>"), "- criterion one\n- criterion two");
eq("<br> is a newline", htmlToText("a<br/>b"), "a\nb");
eq("entities decoded", htmlToText("&lt;tag&gt; &amp; &quot;q&quot;&nbsp;x"), '<tag> & "q" x');
eq("numeric entities", htmlToText("&#65;&#66;"), "AB");
eq("script removed", htmlToText("<p>keep</p><script>evil()</script>"), "keep");
eq("empty input", htmlToText(undefined), "");
check("<p> splits paragraphs", htmlToText("<p>one</p><p>two</p>").split("\n").length === 2);

// --- rule globs ---
section("rule glob matching");
check("** matches any depth", globToRegExp("**/*.py").test("src/a/b/c.py"));
check("**/ matches zero directories", globToRegExp("**/*.py").test("c.py"));
check("wrong extension does not match", !globToRegExp("**/*.py").test("src/a.java"));
check("{a,b} branch", globToRegExp("**/*.{tsx,jsx}").test("app/page.tsx"));
check("{a,b} other branch", globToRegExp("**/*.{tsx,jsx}").test("app/page.jsx"));
check("{a,b} rejects a third option", !globToRegExp("**/*.{tsx,jsx}").test("app/page.ts"));
check("* does not cross directories", !globToRegExp("src/*.ts").test("src/deep/a.ts"));
check("directory prefix", globToRegExp("services/payment/**").test("services/payment/api/x.java"));
check("global **/*", globToRegExp("**/*").test("anything/at/all.md"));

section("rule selection");
{
  const rules = [
    { name: "_base.md", applyTo: ["**/*"], body: "base" },
    { name: "java.md", applyTo: ["**/*.java"], body: "java" },
    { name: "python.md", applyTo: ["**/*.py"], body: "python" },
  ];
  const picked = selectRules(rules, ["/src/Main.java", "/README.md"]);
  eq("loads only relevant language rules", picked.map((r) => r.name).sort(), ["_base.md", "java.md"]);
  check("unchanged language rules not loaded", !picked.some((r) => r.name === "python.md"));
  const none = selectRules(rules, []);
  eq("no changed files -> no rules loaded", none.length, 0);
}
{
  // The shipped baseline must actually parse and apply everywhere.
  const base = loadRules().find((r) => r.name === "_base.md");
  check("built-in _base.md loads", base !== undefined);
  if (base) {
    eq("_base.md applyTo is global", base.applyTo, ["**/*"]);
    check("_base.md body has Fowler smells", base.body.includes("Feature Envy"));
    check("_base.md frontmatter stripped", !base.body.startsWith("---"));
  }
}
{
  // The shipped TS/Node/Playwright packs, selected against a monorepo layout. These pin the
  // additive-by-extension strategy: a backend .ts file gets the TS packs and nothing React.
  const shipped = loadRules();
  const names = (paths: string[]) => selectRules(shipped, paths).map((r) => r.name).sort();
  eq("backend ts", names(["/apps/api/src/user.ts"]), ["_base.md", "node-server.md", "typescript.md"]);
  eq("unit test does not load playwright", names(["/apps/api/src/user.test.ts"]), ["_base.md", "node-server.md", "typescript.md"]);
  eq("e2e spec loads playwright", names(["/apps/web/src/login.spec.ts"]), ["_base.md", "node-server.md", "playwright.md", "typescript.md"]);
  eq("app route handler gets ts and next", names(["/apps/web/app/route.ts"]), ["_base.md", "nextjs.md", "node-server.md", "typescript.md"]);
  eq("tsx page gets next only", names(["/apps/web/app/page.tsx"]), ["_base.md", "nextjs.md"]);
  // `**/app/**` must not swallow the `apps/` directory prefix.
  check("apps/ prefix does not match **/app/**", !names(["/apps/api/src/user.ts"]).includes("nextjs.md"));
  // ...nor any non-JS file that merely lives under a directory called app/ or pages/, which
  // is the standard Flask and FastAPI layout.
  check("a python file under app/ gets no react rules", !names(["/svc/app/handlers.py"]).includes("nextjs.md"));
  check("a java file under pages/ gets no react rules", !names(["/svc/pages/Render.java"]).includes("nextjs.md"));
  eq("a route handler under app/ still gets next", names(["/web/app/api/route.ts"]).includes("nextjs.md"), true);
  eq("mts detected as typescript", detectLanguage("/src/x.mts"), "typescript");
  check("mts is reviewable", isReviewable("/src/x.mts"));

  // Python. The profile has always claimed .pyi, but the pack's glob did not, so stub files
  // reached the finder with only the cross-language baseline attached.
  eq("py loads the python pack", names(["/svc/app/handlers.py"]), ["_base.md", "python.md"]);
  eq("pyi stubs load it too", names(["/svc/app/types.pyi"]), ["_base.md", "python.md"]);
  check("pyi is reviewable", isReviewable("/svc/app/types.pyi"));
  check("python does not pull in js packs", !names(["/svc/app/handlers.py"]).includes("typescript.md"));

  const py = shipped.find((r) => r.name === "python.md")!;
  // The pack's whole premise is not restating tool output; these are ruff defaults.
  for (const code of ["B006", "RUF012", "B023", "ASYNC2xx", "DTZ005"]) {
    check(`python pack names ${code} as already covered`, py.body.includes(code));
  }
  // ...and these are the gaps it exists to fill, so it must say they are NOT default.
  for (const code of ["RUF006", "B904", "PLW1641"]) {
    check(`python pack flags ${code} as not default`, py.body.includes(code));
  }
}

// --- adversarial verification ---
section("skeptic verdict parsing (fail-open)");
{
  const v = parseVerdictForTest('{"refuted":true,"reason":"this is try-with-resources, it closes automatically","confidence":0.9}', "test-model");
  check("explicit refutation", v.refuted && v.confidence === 0.9);
}
{
  const v = parseVerdictForTest('{"refuted":false,"reason":"","confidence":0.7}', "test-model");
  check("not refuted", !v.refuted);
}
{
  // A broken verifier must not be able to delete findings.
  const v = parseVerdictForTest("model broke, this is not JSON", "test-model");
  check("unparseable -> fail-open (not refuted)", !v.refuted);
  check("unparseable records the error", v.error !== undefined);
}
{
  const v = parseVerdictForTest('{"refuted":false,"reason":"impact overstated","confidence":0.8,"suggested_severity":"low"}', "test-model");
  eq("accepts severity downgrade suggestion", v.suggestedSeverity, "low");
}
{
  const v = parseVerdictForTest('{"refuted":false,"reason":"x","confidence":0.5,"suggested_severity":"catastrophic"}', "test-model");
  check("invalid severity ignored", v.suggestedSeverity === undefined);
}

section("consensus adjudication");
{
  const mk = (over: Partial<AnchoredFinding>): AnchoredFinding => ({
    category: "correctness",
    severity: "high",
    confidence: 0.8,
    file: "/a.ts",
    quote: "x();",
    claim: "c",
    sources: ["m1"],
    fingerprint: "f",
    anchor: { side: "right", startLine: 1, endLine: 1, startOffset: 1, endOffset: 5 },
    ...over,
  });
  const empty = { merged: [], degraded: [], rawCount: 0, byFailure: {}, excluded: 0 };

  const single = finalize(empty, [mk({ sources: ["m1"] })]);
  eq("single model, unverified -> no inline comment", single.inline.length, 0);
  eq("still listed in summary", single.belowBar.length, 1);
  eq("reason recorded", single.belowBar[0]?.suppressedBy, "no-corroboration");

  const twoModels = finalize(empty, [mk({ sources: ["m1", "m2"] })]);
  eq("two models found it independently -> inline", twoModels.inline.length, 1);

  const verified = finalize(empty, [mk({ sources: ["m1"], skepticVerdicts: 1 })]);
  eq("single model but passed adversarial verification -> inline", verified.inline.length, 1);

  const lowSev = finalize(empty, [mk({ sources: ["m1", "m2"], severity: "low" })]);
  eq("below threshold -> no inline", lowSev.inline.length, 0);
  eq("reason is severity", lowSev.belowBar[0]?.suppressedBy, "severity");
}

// --- static analysis ---
section("tool output parsing");
const spec = (format: string): ToolSpec =>
  ({ name: "t", bin: "t", args: () => [], format, tier: "triage" }) as ToolSpec;

{
  const sarif = JSON.stringify({
    runs: [{
      tool: { driver: { name: "bandit", rules: [{ id: "B602", helpUri: "https://x" }] } },
      results: [{
        ruleId: "B602",
        level: "note",
        message: { text: "subprocess with shell=True" },
        locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.py" }, region: { startLine: 12 } } }],
        properties: { "security-severity": "9.8" },
      }],
    }],
  });
  const f = parseToolOutput(sarif, spec("sarif"), "/w")[0];
  eq("SARIF rule id", f?.ruleId, "B602");
  eq("SARIF line number", f?.line, 12);
  // A rule can be level:note while describing a critical vulnerability.
  eq("security-severity overrides level", f?.severity, "critical");
  eq("SARIF helpUri", f?.helpUri, "https://x");
}
{
  const ruff = JSON.stringify([
    { code: "B006", message: "mutable default", filename: "/w/src/a.py", location: { row: 3 } },
    { code: "S602", message: "shell", filename: "/w/src/a.py", location: { row: 9 } },
  ]);
  const fs2 = parseToolOutput(ruff, spec("ruff-json"), "/w");
  eq("ruff two entries", fs2.length, 2);
  eq("workdir prefix stripped", fs2[0]?.file, "src/a.py");
  eq("S prefix treated as security (high)", fs2[1]?.severity, "high");
}
{
  const eslint = JSON.stringify([
    { filePath: "/w/app/p.tsx", messages: [{ ruleId: "no-eval", severity: 2, message: "eval", line: 4 }] },
  ]);
  const f = parseToolOutput(eslint, spec("eslint-json"), "/w")[0];
  eq("eslint rule", f?.ruleId, "no-eval");
  eq("eslint severity 2 -> high", f?.severity, "high");
}
{
  const xml = `<?xml version="1.0"?><checkstyle><file name="/w/src/A.java">` +
    `<error line="7" severity="error" message="Avoid &quot;x&quot; here" source="com.puppycrawl.tools.checkstyle.MagicNumberCheck"/>` +
    `</file></checkstyle>`;
  const f = parseToolOutput(xml, spec("checkstyle-xml"), "/w")[0];
  eq("checkstyle line number", f?.line, 7);
  eq("rule id is the last segment", f?.ruleId, "MagicNumberCheck");
  check("XML entities decoded", (f?.message ?? "").includes('"x"'));
}
{
  // &amp; must be decoded LAST, or "&amp;lt;" wrongly becomes "<" instead of "&lt;".
  const xml = `<?xml version="1.0"?><checkstyle><file name="/w/A.java">` +
    `<error line="1" severity="error" message="a &amp;lt; b" source="X"/></file></checkstyle>`;
  const f = parseToolOutput(xml, spec("checkstyle-xml"), "/w")[0];
  eq("&amp; decoded last, no double decoding", f?.message, "a &lt; b");
}
{
  const mypy = '{"file":"src/a.py","line":5,"severity":"error","message":"bad type","code":"arg-type"}\n' +
               '{"file":"src/a.py","line":6,"severity":"note","message":"context"}';
  const fs3 = parseToolOutput(mypy, spec("mypy-json"), "/w");
  eq("mypy keeps only error", fs3.length, 1);
  eq("mypy type error treated as high", fs3[0]?.severity, "high");
}
{
  const tsc = "src/a.ts(12,5): error TS2345: Argument of type 'x'.\nirrelevant line";
  const f = parseToolOutput(tsc, spec("tsc-text"), "/w")[0];
  eq("tsc rule", f?.ruleId, "TS2345");
  eq("tsc line number", f?.line, 12);
}
{
  // Verbatim from SpotBugs' own sample output (spotbugs/src/sampleXml). The shape matters:
  // one BugInstance carries THREE SourceLines — the class span, the method span, and the
  // bug's own location. Taking the wrong one points the finding at line 98 of a 3000-line
  // class, which then "touches" any diff at all.
  const sb = `<BugCollection version="2.0.3">
  <BugInstance type="SF_SWITCH_NO_DEFAULT" priority="2" abbrev="SF" category="STYLE">
    <ShortMessage>Switch statement found where default case is missing</ShortMessage>
    <LongMessage>Switch statement found in OpcodeStack.pushByIntMath where default case is missing</LongMessage>
    <Class classname="edu.umd.cs.findbugs.OpcodeStack">
      <SourceLine classname="edu.umd.cs.findbugs.OpcodeStack" start="98" end="3193" sourcefile="OpcodeStack.java" sourcepath="edu/umd/cs/findbugs/OpcodeStack.java"/>
    </Class>
    <Method classname="edu.umd.cs.findbugs.OpcodeStack" name="pushByIntMath" isStatic="false">
      <SourceLine classname="edu.umd.cs.findbugs.OpcodeStack" start="2803" end="2938" sourcefile="OpcodeStack.java" sourcepath="edu/umd/cs/findbugs/OpcodeStack.java"/>
    </Method>
    <SourceLine classname="edu.umd.cs.findbugs.OpcodeStack" start="2821" end="2861" sourcefile="OpcodeStack.java" sourcepath="edu/umd/cs/findbugs/OpcodeStack.java"/>
  </BugInstance>
  <BugInstance type="NP_NULL_ON_SOME_PATH" priority="1" abbrev="NP" category="CORRECTNESS">
    <LongMessage>Possible null pointer dereference</LongMessage>
    <SourceLine classname="com.acme.Svc" start="41" end="41" sourcefile="Svc.java" sourcepath="com/acme/Svc.java"/>
  </BugInstance>
  <BugInstance type="UG_SYNC_SET_UNSYNC_GET" priority="2" abbrev="UG" category="MT_CORRECTNESS">
    <Class classname="com.acme.Holder">
      <SourceLine classname="com.acme.Holder" start="10" end="90" sourcefile="Holder.java" sourcepath="com/acme/Holder.java"/>
    </Class>
  </BugInstance>
</BugCollection>`;
  const f = parseToolOutput(sb, spec("spotbugs-xml"), "/w");
  eq("a class-only BugInstance is skipped, never guessed at the class line", f.length, 2);
  eq("the bug's own SourceLine wins over the class span", f[0]?.line, 2821);
  eq("...and its end line", f[0]?.endLine, 2861);
  eq("rule id is the bug type", f[0]?.ruleId, "SF_SWITCH_NO_DEFAULT");
  check("LongMessage preferred over ShortMessage", (f[0]?.message ?? "").startsWith("Switch statement found in"));
  // SpotBugs priority runs the other way to every severity word mapSeverity knows.
  eq("priority 2 is medium", f[0]?.severity, "medium");
  eq("priority 1 is high", f[1]?.severity, "high");
  eq("path is the source path", f[1]?.file, "com/acme/Svc.java");
}
{
  // SpotBugs reports paths relative to the source root; the diff calls the same file
  // src/main/java/... . Resolution happens once, at entry (rekeyToolFindings): the finding
  // is re-keyed onto the diff's own path, so the diff filter and every later lookup hit
  // exactly instead of silently missing.
  const fd = mkFile("svc/src/main/java/com/acme/Svc.java", ["a();", "b();"], [2]);
  const finding = {
    tool: "spotbugs", tier: "triage" as const, ruleId: "NP", message: "m",
    file: "com/acme/Svc.java", line: 2, severity: "high" as const,
  };
  const rekeyed = rekeyToolFindings([finding], "", new FileIndex([fd]));
  eq("a source-root-relative path resolves by suffix", rekeyed.kept.length, 1);
  eq("...and is re-keyed onto the diff's own path", rekeyed.kept[0]?.file, "svc/src/main/java/com/acme/Svc.java");
  eq("...so the diff filter hits exactly", filterToChangedLines(rekeyed.kept, new FileIndex([fd])).kept.length, 1);

  // The Maven-submodule composition: the tool ran in svc/, so the blindly-prefixed path
  // "svc/com/acme/Svc.java" matches nothing — but the raw path still resolves by suffix.
  // The previous shape (prefix first, then suffix on the prefixed string) could never
  // match this case.
  const sub = rekeyToolFindings([finding], "svc", new FileIndex([fd]));
  eq("a submodule-prefixed source-root path still resolves", sub.kept.length, 1);
  eq("...onto the diff path", sub.kept[0]?.file, "svc/src/main/java/com/acme/Svc.java");

  // ...but only when unambiguous. Two modules sharing a package must not silently pick one.
  const twin = mkFile("api/src/main/java/com/acme/Svc.java", ["a();", "b();"], [2]);
  const amb = rekeyToolFindings([finding], "", new FileIndex([fd, twin]));
  eq("an ambiguous suffix is dropped, not guessed", amb.kept.length, 0);
  eq("...and counted as unresolved, not merely dropped", amb.misses.length, 1);

  // The filter itself no longer resolves: an un-rekeyed suffix-shaped path is a miss.
  eq("filterToChangedLines alone drops a suffix-shaped path",
    filterToChangedLines([finding], new FileIndex([fd])).kept.length, 0);
}
{
  // PMD's xml renderer speaks the checkstyle dialect but names its attributes beginline and
  // endline. The old `line="` pattern had no word boundary, so it matched INSIDE beginline —
  // the right answer, but only because PMD happens to emit beginline first. XML does not
  // guarantee attribute order.
  const pmd = `<pmd version="7.23.0"><file name="src/A.java">
    <violation beginline="12" endline="14" rule="UnusedLocalVariable" priority="3">msg</violation>
  </file></pmd>`;
  const f = parseToolOutput(pmd, spec("checkstyle-xml"), "/w")[0];
  eq("PMD violation uses beginline", f?.line, 12);
  eq("...and endline", f?.endLine, 14);
  eq("PMD rule attribute is the rule id", f?.ruleId, "UnusedLocalVariable");

  const reversed = `<pmd><file name="src/A.java">
    <violation endline="14" beginline="12" rule="R" priority="3">m</violation>
  </file></pmd>`;
  eq("attribute order does not change the line",
    parseToolOutput(reversed, spec("checkstyle-xml"), "/w")[0]?.line, 12);

  const cs = `<checkstyle><file name="src/A.java">
    <error line="7" severity="error" source="com.puppycrawl.tools.checkstyle.NeedBracesCheck" message="m"/>
  </file></checkstyle>`;
  eq("checkstyle still uses plain line", parseToolOutput(cs, spec("checkstyle-xml"), "/w")[0]?.line, 7);
}
{
  // A tool may be declared more than once — one job, several ways to invoke it. Declaration
  // order is preference order, and only the first available variant runs.
  const java = PROFILES.find((p) => p.language === "java")!;
  const pmdVariants = java.tools.filter((t) => t.name === "pmd");
  eq("pmd has a standalone and a maven variant", pmdVariants.length, 2);
  eq("standalone is preferred", pmdVariants[0]?.bin, "pmd");
  eq("maven is the fallback", pmdVariants[1]?.bin, "mvn");
  eq("the maven variant reads a file, not stdout", pmdVariants[1]?.outputFile, "target/pmd.xml");
  check("the standalone variant reads stdout", pmdVariants[0]?.outputFile === undefined);

  const sbVariants = java.tools.filter((t) => t.name === "spotbugs");
  eq("spotbugs likewise", sbVariants.length, 2);
  eq("...and its maven report path", sbVariants[1]?.outputFile, "target/spotbugsXml.xml");
  // Both variants must agree on when there is anything to analyse at all.
  eq("both spotbugs variants need a built module", sbVariants[0]?.requires, sbVariants[1]?.requires);
}
check("empty output does not blow up", parseToolOutput("", spec("sarif"), "/w").length === 0);
check("broken output does not blow up", parseToolOutput("{{{not json", spec("sarif"), "/w").length === 0);

section("diff filtering of static findings");
{
  const f = mkFile("/src/a.py", ["a()", "b()", "c()"], [2]);
  const mk = (line: number) => ({
    tool: "ruff", tier: "triage" as const, ruleId: "X", message: "m",
    file: "src/a.py", line, severity: "medium" as const,
  });
  const r = filterToChangedLines([mk(1), mk(2), mk(3)], new FileIndex([f]));
  eq("keeps only findings on changed lines", r.kept.length, 1);
  eq("the kept one is line 2", r.kept[0]?.line, 2);
  eq("the rest are dropped", r.dropped, 2);

  const other = filterToChangedLines([{ ...mk(2), file: "other/z.py" }], new FileIndex([f]));
  eq("files outside the diff are always dropped", other.kept.length, 0);
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

// A checkout without its dependencies installed makes tsc report one error per import plus
// a lib cascade — all fact-tier, all posted inline with no model in the loop.
section("broken toolchain detection");
{
  const raw = [
    `tests/login.spec.ts(1,30): error TS2307: Cannot find module '@playwright/test' or its corresponding type declarations.`,
    `tests/login.spec.ts(4,3): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node?`,
    `tests/login.spec.ts(7,1): error TS2705: An async function or method in ES5 requires the Promise constructor.`,
    `tests/login.spec.ts(9,7): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`,
  ].join("\n");
  const tsProfile = selectProfiles(["a.ts"])[0]!;
  const tsc = tsProfile.tools.find((t) => t.name === "tsc")!;
  const parsed = parseToolOutput(raw, tsc, "/w");
  eq("all four errors parse", parsed.length, 4);

  const why = environmentFailure(tsc, parsed, "playwright");
  check("a broken toolchain is detected", why !== undefined);
  check("...naming the directory", why!.includes("playwright"));
  check(
    "...and the distinct codes",
    why!.includes("TS2307") && why!.includes("TS2580") && why!.includes("TS2705"),
  );
  // The genuine type error goes too: with imports unresolved it is an artefact, not a defect.
  check("...discarding the whole run, not just the env errors", why!.includes("all 4"));

  const healthy = parsed.filter((f) => f.ruleId === "TS2345");
  check("a healthy run is left alone", environmentFailure(tsc, healthy, ".") === undefined);

  // TS2792 is the same failure as TS2307 under different module settings, and which one you
  // get is not predictable from a rule list. An end-to-end run against a real uninstalled
  // subproject emitted this one, and the first version of the code list — assembled from the
  // TS2307 wording — let the entire run through.
  const variant = [
    `tests/a.ts(1,25): error TS2792: Cannot find module '@playwright/test'. Did you mean to set the 'moduleResolution' option to 'nodenext'?`,
    `tests/a.ts(5,7): error TS2322: Type 'string' is not assignable to type 'number'.`,
  ].join("\n");
  const vWhy = environmentFailure(tsc, parseToolOutput(variant, tsc, "/w"), "playwright");
  check("the TS2792 wording of cannot-find-module also trips", vWhy !== undefined);
  check("...taking the genuine type error down with it", vWhy!.includes("all 2"));

  // The message backstop has to survive a code the list has never seen.
  const unlisted = parseToolOutput(
    `tests/a.ts(1,1): error TS9999: Cannot find module 'x' or its corresponding type declarations.`,
    tsc, "/w",
  );
  check("an unlisted code still trips on the message", environmentFailure(tsc, unlisted, ".") !== undefined);

  // ...but a bare "Cannot find name" must NOT: that is also a genuine undeclared identifier,
  // and discarding the run on it would suppress a real defect.
  const undeclared = parseToolOutput(`tests/a.ts(3,1): error TS2304: Cannot find name 'usrName'.`, tsc, "/w");
  check(
    "an undeclared identifier stays a finding, not an environment failure",
    environmentFailure(tsc, undeclared, ".") === undefined,
  );

  const eslint = tsProfile.tools.find((t) => t.name === "eslint")!;
  check("a tool with no environment rules never trips", environmentFailure(eslint, parsed, ".") === undefined);
}

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

  const unknown = renderFindingComment({ ...base, file: "/x/Makefile", suggested_fix: "all:" });
  check("an unknown language gets a bare fence", unknown.includes("```\nall:"));

  check("no fix means no section", !renderFindingComment(base).includes("Suggested fix"));
}

section("language profile selection");
{
  const ps = selectProfiles(["src/a.py", "README.md"]);
  eq("only python selected", ps.map((p) => p.language), ["python"]);
  eq("files of other languages are not passed to the tool", filesForProfile(ps[0]!, ["src/a.py", "README.md"]), ["src/a.py"]);
  eq("mixed languages select two profiles", selectProfiles(["A.java", "p.tsx"]).length, 2);
  eq("no matching language -> empty", selectProfiles(["README.md"]).length, 0);
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

// --- noise control: exclusions and learnings (M6) ---
section("excluded categories (PRR_EXCLUDE_CATEGORIES)");
{
  const f = mkFile("/src/app.ts", ["slowLoop();", "bug();"], [1, 2]);
  const out = [{
    model: "m1",
    rejected: 0,
    raw: "",
    findings: [
      mkFinding({ category: "performance", quote: "slowLoop();" }),
      mkFinding({ category: "correctness", quote: "bug();" }),
    ],
  }];
  process.env["PRR_EXCLUDE_CATEGORIES"] = "performance";
  const c = anchorAndDedupe(out, new FileIndex([f]));
  eq("excluded category dropped before anchoring", c.merged.length, 1);
  eq("drop is counted, never silent", c.excluded, 1);
  eq("the surviving finding is the non-excluded one", c.merged[0]?.category, "correctness");

  delete process.env["PRR_EXCLUDE_CATEGORIES"];
  const c2 = anchorAndDedupe(out, new FileIndex([f]));
  eq("unset -> nothing excluded", c2.merged.length, 2);
}
{
  // Tool findings obey the same exclusion: a category the config turned off is off for
  // linters too, in the same place their category is assigned.
  const f = mkFile("/src/a.py", ["x = eval(y)", "z = f(1)"], [1, 2]);
  const tool = (t: string, line: number): ToolFinding =>
    ({ tool: t, tier: "fact", ruleId: "R1", message: "m", file: "src/a.py", line, severity: "high" });
  const staticResult = {
    facts: [tool("bandit", 1), tool("mypy", 2)],
    needsTriage: [],
    suppressedCount: 0,
    ranTools: ["bandit", "mypy"],
    skipped: [],
    staleFiles: [],
    unresolved: 0,
  };
  const dummyRunner = { chat: async () => ({ text: "", model: "none" }) };
  process.env["PRR_EXCLUDE_CATEGORIES"] = "security";
  const res = await triageAndConvert(dummyRunner, staticResult, new FileIndex([f]));
  eq("bandit (security) finding excluded", res.findings.length, 1);
  eq("tool exclusion is counted", res.excluded, 1);
  eq("mypy (correctness) finding kept", res.findings[0]?.category, "correctness");
  delete process.env["PRR_EXCLUDE_CATEGORIES"];
}

section("dismissal suppression (learnings)");
{
  const mk = (over: Partial<AnchoredFinding>): AnchoredFinding => ({
    category: "correctness",
    severity: "high",
    confidence: 0.8,
    file: "/a.ts",
    quote: "x();",
    claim: "c",
    sources: ["m1", "m2"],
    fingerprint: "fp1",
    anchor: { side: "right", startLine: 1, endLine: 1, startOffset: 1, endOffset: 5 },
    ...over,
  });
  const empty = { merged: [], degraded: [], rawCount: 0, byFailure: {}, excluded: 0 };

  // Corroboration cannot re-open what a reviewer closed: two models + a passed skeptic
  // round would normally guarantee an inline comment.
  const res = finalize(empty, [mk({ skepticVerdicts: 1 })], new Set(["fp1"]));
  eq("dismissed finding never goes inline", res.inline.length, 0);
  eq("still visible in the summary", res.belowBar.length, 1);
  eq("with its suppression reason", res.belowBar[0]?.suppressedBy, "dismissed");
  eq("counted in stats", res.stats.dismissed, 1);

  const other = finalize(empty, [mk({})], new Set(["unrelated"]));
  eq("non-matching fingerprint unaffected", other.inline.length, 1);
}
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-learnings-"));
  const ref: PrRef = { baseUrl: "https://dev.azure.com/o", org: "o", project: "p", repoId: "r", prId: 7 };
  const rec = { fingerprint: "abc123", file: "/a.ts", claim: "c", category: "performance", resolvedAs: "wontFix" };

  eq("missing store -> empty", loadDismissals(ref, root).length, 0);
  eq("first dismissal recorded", recordDismissals(ref, [rec], root), 1);
  eq("same fingerprint never recorded twice", recordDismissals(ref, [rec], root), 0);
  recordDismissals(ref, [{ ...rec, fingerprint: "def456" }], root);

  const all = loadDismissals(ref, root);
  eq("both records load", all.map((d) => d.fingerprint).sort(), ["abc123", "def456"]);
  eq("the PR that dismissed it is stamped", all[0]?.prId, 7);
  check("fingerprint set matches", dismissedFingerprints(ref, root).has("abc123"));

  // A corrupt line loses one record, never the store.
  fs.appendFileSync(learningsPath(ref, root), "not json at all\n");
  eq("corrupt line skipped on load", loadDismissals(ref, root).length, 2);

  fs.rmSync(root, { recursive: true, force: true });
}
{
  const mkD = (category: string | undefined, i: number) =>
    ({ fingerprint: `f${i}`, file: "/a", claim: "", category, resolvedAs: "wontFix", prId: 1, recordedAt: "" });
  const stored = [mkD("performance", 1), mkD("performance", 2), mkD("performance", 3), mkD("security", 4)];
  const hints = dismissedCategoryHints(stored, [], 3);
  eq("category at the threshold is hinted", hints.map((h) => h.category), ["performance"]);
  eq("hint carries the count", hints[0]?.count, 3);
  eq("already-excluded categories are not re-hinted", dismissedCategoryHints(stored, ["performance"], 3).length, 0);
  eq("legacy records without a category never hint", dismissedCategoryHints([mkD(undefined, 9)], [], 1).length, 0);
}
{
  const t = {
    id: 3,
    status: "byDesign",
    comments: [{ id: 1, content: "<!-- prloop --><!-- prloop:fp=beef12 --><!-- prloop:cat=performance -->slow loop" }],
    threadContext: { filePath: "/a.ts" },
  };
  eq("category parsed from the comment marker", collectDismissals([t])[0]?.category, "performance");
  const legacy = { ...t, comments: [{ id: 1, content: "<!-- prloop --><!-- prloop:fp=beef12 -->slow loop" }] };
  eq("legacy comment without marker -> no category", collectDismissals([legacy])[0]?.category, undefined);
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

// --- realistic seeded PR ---
// Toy fixtures prove the algorithm runs; this proves it lands on the right line in code
// that looks like real code. Every expectation below was verified against `grep -n` on the
// actual repository these files came from.
section("real PR anchoring (seeded-defect range)");
{
  const seeded: FileDiff[] = SEEDED_FILES.map((f) => {
    const leftLines = splitLines(Buffer.from(f.base, "utf8"));
    const rightLines = splitLines(Buffer.from(f.head, "utf8"));
    const { hunks, changedRightLines } = buildHunks(leftLines, rightLines, diffLines(leftLines, rightLines));
    return {
      path: f.path,
      changeType: "edit" as const,
      hunks,
      rightLines,
      leftLines,
      changedRightLines,
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

section("NO_PROXY matching rules");
{
  // Exercises the real matcher, not a copy of it — the second argument exists so this can
  // be tested without the module-level value captured at import.
  const no = (list: string, host: string) => bypassesProxy(host, list);
  check("exact host match", no("internal.corp", "internal.corp"));
  check("subdomain match", no("corp", "ai.internal.corp"));
  check("leading-dot form matches", no(".corp", "ai.internal.corp"));
  check("wildcard prefix matches", no("*.corp", "ai.internal.corp"));
  check("unrelated host does not match", !no("internal.corp", "dev.azure.com"));
  check("partial string must not match", !no("corp", "notcorp.com"));
  check("bare * bypasses everything", no("*", "anything.example"));
  check("comma-separated list", no("a.com, internal.corp ,b.com", "x.internal.corp"));
  check("empty NO_PROXY bypasses nothing", !no("", "dev.azure.com"));
  check("case-insensitive", no("INTERNAL.CORP", "ai.Internal.Corp"));
}
{
  // .env cannot overwrite an existing environment variable, so on a machine that already
  // exports HTTPS_PROXY the file's value would silently do nothing. The PRR_ names exist
  // to make .env a reliable override; assert that precedence holds.
  const pick = (env: Record<string, string | undefined>, ...names: string[]) => {
    for (const n of names) {
      const v = env[n] ?? env[n.toLowerCase()] ?? env[n.toUpperCase()];
      if (v && v.trim()) return v.trim();
    }
    return "";
  };
  const order = ["PRR_HTTPS_PROXY", "HTTPS_PROXY", "https_proxy"];
  eq(
    "PRR_ variant wins over shell HTTPS_PROXY",
    pick({ PRR_HTTPS_PROXY: "http://a", HTTPS_PROXY: "http://b" }, ...order),
    "http://a",
  );
  eq("no PRR_ -> falls back to conventional name", pick({ HTTPS_PROXY: "http://b" }, ...order), "http://b");
  eq("lowercase is also read", pick({ https_proxy: "http://c" }, ...order), "http://c");
  eq("all empty -> empty string", pick({}, ...order), "");
}
{
  // curl-style host:port entries must match on port, and mismatched port must not bypass.
  eq("host:port entry matches host+port", bypassesProxy("localhost", "localhost:4000", "4000"), true);
  eq("host:port entry rejects other port", bypassesProxy("localhost", "localhost:4000", "8080"), false);
  eq("plain host entry ignores port", bypassesProxy("localhost", "localhost", "4000"), true);
  eq("host:port without port info does not match", bypassesProxy("localhost", "localhost:4000"), false);
}

section("proxy display redaction");
{
  // Normalising through URL() drops a default port, which reads as lost configuration.
  eq("default port must be kept", redactProxy("http://192.0.2.10:80"), "http://192.0.2.10:80");
  eq("non-default port kept", redactProxy("http://192.0.2.10:8080"), "http://192.0.2.10:8080");
  eq("https 443 kept", redactProxy("https://p.corp:443"), "https://p.corp:443");
  eq("no extra trailing slash", redactProxy("http://p.corp"), "http://p.corp");
  eq("password redacted", redactProxy("http://user:secret@p.corp:80"), "http://user:***@p.corp:80");
  eq("username-only is redacted too", redactProxy("http://tok@p.corp:3128"), "http://tok:***@p.corp:3128");
  check("raw password never appears", !redactProxy("http://u:hunter2@p.corp").includes("hunter2"));
}

section("extra CA trust");
{
  const LEAF = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-ca-"));
  const one = path.join(dir, "one.pem");
  const two = path.join(dir, "two.pem");
  const der = path.join(dir, "raw.cer");
  fs.writeFileSync(one, LEAF);
  fs.writeFileSync(two, LEAF + LEAF);
  fs.writeFileSync(der, Buffer.from([0x30, 0x82, 0x01, 0x0a]));

  eq("comma-separated paths are split", sourcePaths(`${one},${two}`, "").length, 2);
  eq("duplicate path appears once", sourcePaths(one, one).length, 1);
  eq("NODE_EXTRA_CA_CERTS is also honoured", sourcePaths("", one)[0]?.from, "NODE_EXTRA_CA_CERTS");
  eq("empty config -> no sources", sourcePaths("", "").length, 0);

  // A bundle holds many certs; loading only the first would trust the wrong half of a chain.
  eq("every PEM block in a bundle is loaded", load([{ path: two, from: "PRR_CA_CERTS" }]).pems.length, 2);
  eq("two files combine", load(sourcePaths(`${one},${two}`, "")).pems.length, 3);

  // A DER export and a typo'd path both look exactly like "no CA configured" at the socket,
  // so they have to surface as errors rather than being silently skipped.
  const derLoad = load([{ path: der, from: "PRR_CA_CERTS" }]);
  eq("DER file yields no certs", derLoad.pems.length, 0);
  check("DER file is reported as an error", (derLoad.sources[0]?.error ?? "").includes("DER"));
  check("missing file is reported", load([{ path: path.join(dir, "nope.pem"), from: "PRR_CA_CERTS" }]).sources[0]?.error !== undefined);

  fs.rmSync(dir, { recursive: true, force: true });
}

section("dispatcher carries the CA on every path");
{
  // The regression this guards: PRR_CA_CERTS used to be applied only by exporting
  // NODE_EXTRA_CA_CERTS from bin/prloop, so it did nothing under `npm run doctor` — and even
  // there, dispatcherFor() returned undefined when no proxy was set, dropping the CA anyway.
  // Needs a fresh process, because the trust store is read once at module load.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-disp-"));
  const pem = path.join(dir, "ca.pem");
  fs.writeFileSync(pem, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
  const probe = path.join(dir, "probe.ts");
  const proxyMod = pathToFileURL(path.join(PRLOOP_ROOT, "libs/proxy.ts")).href;
  fs.writeFileSync(
    probe,
    `import { dispatcherFor } from ${JSON.stringify(proxyMod)};\n` +
      `console.log(JSON.stringify({\n` +
      `  direct: dispatcherFor("https://dev.azure.com/x") !== undefined,\n` +
      `  bypassed: dispatcherFor("http://localhost:4000/v1") !== undefined,\n` +
      `}));\n`,
  );
  // Not `spawnSync("npx", ...)`: on Windows that is npx.cmd, which Node refuses to spawn
  // directly (CVE-2024-27980) — spawnSync returns EINVAL with stdout/stderr undefined.
  // Running the tsx CLI's JS entry with the current node binary needs no shell anywhere.
  const tsxCli = path.join(PRLOOP_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const res = spawnSync(process.execPath, [tsxCli, probe], {
    encoding: "utf8",
    env: { ...process.env, PRR_CA_CERTS: pem, PRR_HTTPS_PROXY: "", PRR_NO_PROXY: "localhost", HTTPS_PROXY: "", https_proxy: "", PRR_QUIET: "1" },
  });
  const out = parseJsonObject<{ direct?: boolean; bypassed?: boolean }>(res.stdout ?? "");
  check("probe process ran", out.ok, (res.error ? String(res.error) : (res.stderr ?? "")).slice(0, 400));
  if (out.ok) {
    check("CA is applied with no proxy configured", out.value.direct === true);
    check("CA is applied to NO_PROXY hosts too", out.value.bypassed === true);
  }
  fs.rmSync(dir, { recursive: true, force: true });
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

section("aggregate: dedupe pools and ranking");
{
  const file = mkFile("/src/x.ts", ["const a = 1;", "use(a);"], [1, 2]);
  const mk = (model: string, over: Partial<RawFinding>): FinderOutput => ({
    model,
    findings: [mkFinding({ file: "/src/x.ts", quote: "const a = 1;", ...over })],
    rejected: 0,
    raw: "",
  });
  // Anchor-failed duplicate (bad quote) from model A, anchored from model B, same claim.
  const cands = anchorAndDedupe(
    [mk("a", { quote: "const a = 999;" }), mk("b", {})],
    new FileIndex([file]),
  );
  eq("anchored finding survives with its anchor intact", cands.merged.length, 1);
  eq("anchor-failed twin stays in degraded, not merged in", cands.degraded.length, 1);
  eq("anchor-failed twin did not corroborate", cands.merged[0]?.sources.length, 1);

  // Same line, same quote, different category → must merge (label instability).
  const cands2 = anchorAndDedupe(
    [mk("a", { category: "concurrency" }), mk("b", { category: "correctness" })],
    new FileIndex([file]),
  );
  eq("same quote with differing category labels merges", cands2.merged.length, 1);
  eq("...and counts both sources", cands2.merged[0]?.sources.length, 2);
}

section("strict-mode schema invariant");
{
  // OpenAI-strict json_schema: `required` must list every key in properties, at every
  // level. A violation is a hard HTTP 400 from OpenAI-validating backends (seen live).
  const walk = (node: unknown, path: string): string[] => {
    if (typeof node !== "object" || node === null) return [];
    const o = node as Record<string, unknown>;
    const bad: string[] = [];
    if (o["type"] === "object" && typeof o["properties"] === "object" && o["properties"] !== null) {
      const keys = Object.keys(o["properties"] as object);
      const req = Array.isArray(o["required"]) ? (o["required"] as string[]) : [];
      for (const k of keys) if (!req.includes(k)) bad.push(`${path}.${k}`);
    }
    for (const [k, v] of Object.entries(o)) bad.push(...walk(v, `${path}.${k}`));
    return bad;
  };
  for (const [name, schema] of [
    ["findings", FINDINGS_SCHEMA],
    ["requirement", REQUIREMENT_SCHEMA],
    ["verdict", VERDICT_SCHEMA],
    ["triage", TRIAGE_SCHEMA],
  ] as const) {
    const missing = walk(schema, name);
    check(`${name} schema is strict-mode compliant`, missing.length === 0, missing.join(", "));
  }
}

section("skeptic verdict semantics");
{
  const empty = parseVerdictForTest("{}", "m");
  check("a verdict without a refuted field is an error, not an answer", empty.error !== undefined);
  const good = parseVerdictForTest('{"refuted": false, "reason": "holds", "confidence": 0.8, "suggested_severity": null}', "m");
  check("null suggested_severity parses", good.error === undefined && good.suggestedSeverity === undefined);
}

section("Windows process spawning");
{
  // planSpawn is platform-parameterised so these run on any host.
  const posix = planSpawn("opencode", ["run", "--agent", "x", "a prompt"], "linux");
  eq("posix passes the command through untouched", posix.file, "opencode");
  check("posix needs no verbatim-args flag", posix.windowsVerbatimArguments === undefined);
  check("posix has no length objection", posix.error === undefined);

  // The command line limit is the failure that only appears on the user's platform: Linux
  // allows ~2MB, cmd.exe allows 8191. A review prompt carrying a diff is far over.
  const huge = planSpawn("C:\\tools\\opencode.exe", ["run", "x".repeat(40_000)], "win32");
  check("oversized command line is refused, not spawned", huge.error !== undefined);
  check("...and says what to do instead", (huge.error ?? "").includes("stdin"));

  // A .cmd shim gets the lower cmd.exe limit, and must say so — 12k chars fits Windows
  // but not cmd.exe, which is exactly the confusing middle case.
  const shim = planSpawn("C:\\tools\\opencode.cmd", ["run", "x".repeat(12_000)], "win32");
  check("shim applies the stricter cmd.exe limit", (shim.error ?? "").includes("8191"));

  // Every spawn errno needs its own explanation: they have different fixes and the old
  // message blamed a missing install for all of them.
  const ex = (code: string) => explainSpawnError(Object.assign(new Error("x"), { code }), "opencode");
  check("ENOENT blames PATH", ex("ENOENT").includes("not found"));
  check("EINVAL names the .cmd rule", ex("EINVAL").includes("cmd.exe"));
  check("E2BIG names the length", ex("E2BIG").includes("too long"));
  check("ENAMETOOLONG names the length", ex("ENAMETOOLONG").includes("too long"));
  check("EACCES names permissions", ex("EACCES").includes("executable"));
  check("unknown code still reports something", ex("EWEIRD").includes("failed to start"));
}

section("killing the process tree on timeout");
{
  // Windows has no signals: Node maps them all to TerminateProcess, so the only way to reach
  // the tree is taskkill, and there is no gentler first attempt to make.
  const win = planKill(4242, "SIGTERM", "win32");
  check("win32 uses taskkill with the tree and force flags",
    win.via === "taskkill" && win.args.join(" ") === "/pid 4242 /T /F");
  eq("win32 SIGKILL is the same plan as SIGTERM",
    JSON.stringify(planKill(4242, "SIGKILL", "win32")), JSON.stringify(win));

  // POSIX signals the process group — a negative pid — not the single process we hold.
  const posixTerm = planKill(4242, "SIGTERM", "linux");
  check("posix targets the process group, not the lone child",
    posixTerm.via === "signal" && posixTerm.target === -4242 && posixTerm.signal === "SIGTERM");
  const posixKill = planKill(4242, "SIGKILL", "linux");
  check("posix keeps the escalated signal", posixKill.via === "signal" && posixKill.signal === "SIGKILL");

  // The regression end to end: a wrapper with a longer-lived child, the shape cmd.exe +
  // opencode makes on Windows. child.kill() would leave the grandchild running.
  if (process.platform !== "win32") {
    const wrapper = spawnChild("sh", ["-c", "sleep 30 & echo $!; wait"], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true, // what the runner now does; the group signal depends on it
    });
    const grandchild = await new Promise<number>((res) => {
      wrapper.stdout.setEncoding("utf8");
      wrapper.stdout.once("data", (d: string) => res(Number(d.trim())));
    });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    check("precondition: the grandchild is running", alive(grandchild));
    killTree(wrapper, "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    check("killTree reaps the grandchild too", !alive(grandchild));
    check("killTree reaps the wrapper", wrapper.exitCode !== null || wrapper.signalCode !== null);
    check("killTree on an already-dead process does not throw", (() => {
      try {
        killTree(wrapper, "SIGKILL");
        return true;
      } catch {
        return false;
      }
    })());
  }
}

section("opencode invocation: prompt delivery");
{
  // The prompt is delivered on the child's stdin, so argv carries flags only. Nothing about
  // the prompt may appear there: cmd.exe re-parses the command line on Windows, and it is
  // capped at 8191 chars, while a review prompt carrying a diff runs to six figures.
  const opts = { jsonEvents: true, agent: "prloop-reviewer" };
  const args = buildInvocation("m", opts);
  eq("argv is flags only, no positional prompt", args, ["run", "--agent", "prloop-reviewer", "--model", "m", "--format", "json"]);
  check("no --file", !args.includes("--file"));
  eq("agent flag is always present", args[1], "--agent");
  check("json format requested when configured", args.includes("--format") && args.includes("json"));

  const noModel = buildInvocation("", { ...opts, jsonEvents: false });
  eq("no --model when empty, no --format when disabled", noModel, ["run", "--agent", "prloop-reviewer"]);

  // Whatever the prompt looks like, a flags-only argv cannot hit the cmd.exe limit.
  check("flags-only argv is always within the cmd.exe limit", planSpawn("opencode.cmd", args, "win32").error === undefined);
}

section("unusable completions are named, not left to the JSON parser");
{
  const ok = { message: { content: '{"findings":[]}' }, finish_reason: "stop" };
  check("a good completion passes", describeBadCompletion(ok, 8192) === undefined);

  // Thinking models bill chain of thought to the same budget, so this is the common
  // failure on a self-hosted reasoning model, not an edge case.
  const cut = { message: { content: '{"findings":[{"file"', reasoning: "x".repeat(9000) }, finish_reason: "length" };
  const cutMsg = describeBadCompletion(cut, 8192) ?? "";
  check("truncation is reported as truncation", cutMsg.includes("truncated"));
  check("...names the knob to turn", cutMsg.includes("PRR_LLM_MAX_TOKENS"));
  check("...and blames the reasoning budget when there was reasoning", cutMsg.includes("reasoning"));

  const allThought = { message: { content: "", reasoning: "x".repeat(500) }, finish_reason: "stop" };
  check("reasoning-only response is named", (describeBadCompletion(allThought, 8192) ?? "").includes("only reasoning"));

  const empty = { message: { content: "" }, finish_reason: "stop" };
  check("plain empty response is named", (describeBadCompletion(empty, 8192) ?? "").includes("empty"));
  check("missing choice is named", describeBadCompletion(undefined, 8192) !== undefined);
}

section("transient vs deterministic model failures");
{
  // Retrying a schema/auth rejection just burns endpoint time; retrying a timeout is free
  // recall. The live failure that motivated this was an HTTP 400 (never retry) sitting next
  // to timeouts (always retry) in the same run.
  check("timeout retries", isTransientModelError("timeout (180s)"));
  check("socket error retries", isTransientModelError("TypeError: fetch failed [UND_ERR_SOCKET]"));
  check("500 retries", isTransientModelError("HTTP 500: upstream unavailable"));
  check("502 retries", isTransientModelError("HTTP 502: bad gateway"));
  check("429 retries", isTransientModelError("HTTP 429: rate limited"));
  check("408 retries", isTransientModelError("HTTP 408: request timeout"));
  check("400 does NOT retry", !isTransientModelError("HTTP 400: Invalid schema for response_format"));
  check("401 does NOT retry", !isTransientModelError("HTTP 401: unauthorized"));
  check("404 does NOT retry", !isTransientModelError("HTTP 404: model not found"));
  // Deterministic bad completions: the retry would burn a second full-length call to
  // reproduce the identical failure.
  check("token-limit truncation does NOT retry", !isTransientModelError("response truncated at the token limit (8192); raise PRR_LLM_MAX_TOKENS"));
  check("empty response does NOT retry", !isTransientModelError("model returned an empty response"));
  check("reasoning-only response does NOT retry", !isTransientModelError("model returned only reasoning (5000 chars) and no answer; raise PRR_LLM_MAX_TOKENS"));
  check("non-JSON body does NOT retry", !isTransientModelError("response is not JSON: <html>"));
}

section("model call concurrency cap");
{
  const sem = new Semaphore(3);
  let peak = 0;
  let running = 0;
  const task = () =>
    sem.run(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    });
  await Promise.all(Array.from({ length: 20 }, task));
  eq("never exceeds the limit", peak, 3);
  eq("every slot is returned", sem.inFlight, 0);
  eq("nothing left queued", sem.waiting, 0);

  // A stage that throws must not leak its slot, or a few failures deadlock the whole run.
  const s2 = new Semaphore(1);
  await Promise.allSettled([
    s2.run(async () => {
      throw new Error("boom");
    }),
  ]);
  eq("a throwing call releases its slot", s2.inFlight, 0);
  let ran = false;
  await s2.run(async () => {
    ran = true;
  });
  check("the semaphore still works after a throw", ran);

  // 0 disables the cap rather than blocking forever.
  const s3 = new Semaphore(0);
  eq("limit 0 means unlimited", await s3.run(async () => 42), 42);
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
