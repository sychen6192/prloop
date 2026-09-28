// Aggregation: dedupe that keeps disagreeing claims apart, what a merge may borrow, tool
// findings joining the code axis, category exclusions and the dismissal store.
import { FileIndex } from "../../libs/fileindex";
import { finalize, findingsAgree, fingerprint, mergeToolFindings } from "../../gates/aggregate";
import { log } from "../../libs/log";
import { renderFindingComment } from "../../publish/format";
import { collectDismissals } from "../../publish/lifecycle";
import {
  dismissedCategoryHints,
  dismissedFingerprints,
  learningsPath,
  loadDismissals,
  recordDismissals,
} from "../../libs/learnings";
import { triageAndConvert } from "../../gates/static";
import type { ToolFinding } from "../../profiles/types";
import type { PrRef } from "../../libs/types";
import type { AnchoredFinding, RawFinding } from "../../libs/types";
import { load } from "../../libs/tls";
import { anchorAndDedupe } from "../../gates/aggregate";
import type { FinderOutput } from "../../gates/finder";
import { calibrate } from "../calibrate";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_INLINE_COMMENTS } from "../../config";
import { buildHunks, diffLines } from "../../libs/diff";
import { suppressionMarker } from "../../libs/suppression";
import { describeTier, riskTier, type TierSettings } from "../../libs/tier";
import { markEarlierPushes } from "../../gates/aggregate";
import type { FileDiff } from "../../libs/types";
import { check, eq, section } from "./harness";
import { mkFile, mkFinding } from "./fixtures";

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
  eq("a converted tool finding carries its tier", res.findings[0]?.tier, "fact");
  // A field, not a phrase in the evidence: calibrate reports how often each rule is acted on.
  eq("...and its rule, as tool:rule", res.findings[0]?.rule, "mypy:R1");
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

section("aggregate: overlap is not agreement");
{
  const lines = [
    "function tally(items) {",     // 1
    "  let total = 0;",            // 2
    "  for (const it of items) {", // 3
    "    counter += it.n;",        // 4
    "    total += it.n;",          // 5
    "  }",                         // 6
    "  log(total);",               // 7
    "  return counter;",           // 8
    "}",                           // 9
    "export { tally };",           // 10
  ];
  const file = mkFile("/src/tally.ts", lines, lines.map((_, i) => i + 1));
  const idx = new FileIndex([file]);
  const out = (model: string, quote: string, claim: string): FinderOutput => ({
    model,
    findings: [mkFinding({ file: "/src/tally.ts", quote, claim })],
    rejected: 0,
    raw: "",
  });
  const eightLines = lines.slice(0, 8).join("\n");

  // The defect: an 8-line "race" and a 1-line "unused variable" in the same category share
  // a line, merged, and the second model was recorded as having found the race — which the
  // consensus gate then published as two independent sightings.
  const busy = anchorAndDedupe(
    [
      out("a", eightLines, "shared counter incremented without a lock, races under load"),
      out("b", "    counter += it.n;", "unused variable total is never read"),
    ],
    idx,
  );
  // And then the second claim was folded into the first and never reported at all. Two
  // claims about one line are two findings: each is verified, gated and posted on its own.
  eq("overlapping findings with different claims stay two findings", busy.merged.length, 2);
  eq("...each with only its own source", busy.merged.map((f) => f.sources), [["a"], ["b"]]);
  eq("...each naming the other as overlapping, not corroborating", busy.merged.map((f) => f.overlapping), [["b"], ["a"]]);
  check("...and each keeping its own claim", busy.merged.some((f) => f.claim.includes("races")) && busy.merged.some((f) => f.claim.includes("unused")));
  check("the comment names the overlap without counting it",
    renderFindingComment(busy.merged[0]!).includes("b flagged these lines with a different claim"));

  // Two tight spans sharing a changed line used to agree by position alone. Pointing at the
  // same new code is not saying the same thing about it.
  const tight = anchorAndDedupe(
    [
      out("a", "    counter += it.n;\n    total += it.n;", "counter is not atomic"),
      out("b", "    total += it.n;\n  }", "total accumulates floats and drifts"),
    ],
    idx,
  );
  eq("tight spans on a changed line with different claims are two findings", tight.merged.map((f) => f.sources.length), [1, 1]);

  // The motivating case, whole: the same quoted line, a low "unused variable" and a critical
  // "SQL injection". It became ONE critical "unused variable" credited to both models, and
  // the injection claim was gone.
  const sqlLines = ["function find(db, name) {", "  const q = \"SELECT * FROM users WHERE name = '\" + name + \"'\";", "  return db.query(q);", "}"];
  const sqlFile = mkFile("/src/find.ts", sqlLines, [1, 2, 3, 4]);
  const both = anchorAndDedupe(
    [
      { model: "a", rejected: 0, raw: "", findings: [mkFinding({ file: "/src/find.ts", quote: sqlLines[1]!, category: "leftover-code", severity: "low", claim: "unused variable q is assigned and never read" })] },
      { model: "b", rejected: 0, raw: "", findings: [mkFinding({ file: "/src/find.ts", quote: sqlLines[1]!, category: "security", severity: "critical", claim: "SQL injection: name is concatenated into the query" })] },
    ],
    new FileIndex([sqlFile]),
  );
  const injection = both.merged.find((f) => f.category === "security");
  eq("the injection survives as its own finding", injection?.claim, "SQL injection: name is concatenated into the query");
  eq("...at its own severity", injection?.severity, "critical");
  eq("...found by one model, not two", injection?.sources, ["b"]);
  eq("the unused variable keeps its own severity, not the injection's", both.merged.find((f) => f.category === "leftover-code")?.severity, "low");

  // Different quotes and spans, but claims with enough vocabulary in common.
  const similar = anchorAndDedupe(
    [
      out("a", eightLines, "shared counter incremented without a lock"),
      out("b", "    counter += it.n;", "counter incremented without lock, concurrent callers race"),
    ],
    idx,
  );
  eq("similar claims (token Jaccard) agree", similar.merged[0]?.sources.length, 2);
  check("...and nothing is left as merely overlapping", similar.merged[0]?.overlapping === undefined);

  // The predicate itself, on the pieces.
  const af = (over: Partial<AnchoredFinding>): AnchoredFinding => ({
    category: "correctness", severity: "high", confidence: 0.8, file: "/src/tally.ts", quote: "q",
    claim: "c", sources: ["m"], fingerprint: "f",
    anchor: { side: "right", startLine: 1, endLine: 1, startOffset: 1, endOffset: 2 },
    ...over,
  });
  const at = (startLine: number, endLine: number) => ({ side: "right" as const, startLine, endLine, startOffset: 1, endOffset: 2 });
  check("the same quote classified alike agrees, however it is worded", findingsAgree(af({ claim: "x" }), af({ claim: "y" })));
  check("...and so do two labels model families use for the same broken behaviour",
    findingsAgree(af({ category: "concurrency", claim: "x" }), af({ category: "correctness", claim: "y" })));
  check("the same quote as a different kind of problem does not",
    !findingsAgree(af({ category: "leftover-code", claim: "unused variable" }), af({ category: "security", claim: "SQL injection" })));
  check("a long span never agrees by position alone",
    !findingsAgree(af({ quote: "a", claim: "one thing", anchor: at(1, 8) }), af({ quote: "b", claim: "another matter" })));
  check("...nor does a tight one",
    !findingsAgree(af({ quote: "a", claim: "one thing", anchor: at(2, 3) }), af({ quote: "b", claim: "another matter", anchor: at(3, 4) })));
  check("shared vocabulary below the threshold does not agree",
    !findingsAgree(af({ quote: "a", claim: "null deref when cache misses" }), af({ quote: "b", claim: "cache key collision when tenant ids clash" })));
}

section("tool merges: only a fact-tier tool may raise severity");
{
  const line1 = { side: "right" as const, startLine: 1, endLine: 1, startOffset: 1, endOffset: 5 };
  const model = (): AnchoredFinding => ({
    category: "correctness", severity: "low", confidence: 0.6, file: "src/a.ts", quote: "x();",
    claim: "x may be undefined here", sources: ["m1"], fingerprint: "f1", skepticVerdicts: 1, anchor: line1,
  });
  const tool = (tier: "fact" | "triage", over: Partial<AnchoredFinding> = {}): AnchoredFinding => ({
    category: "correctness", severity: "high", confidence: tier === "fact" ? 1 : 0.8, file: "src/a.ts",
    quote: "x();", claim: "'x' is possibly undefined", sources: [tier === "fact" ? "tsc" : "eslint"],
    fingerprint: "t1", skepticVerdicts: 1, skepticRefuted: 0, tier, anchor: line1, ...over,
  });

  // The skeptic just argued this finding down to low; eslint rating an error-level rule
  // "high" is policy, not evidence, and must not undo that.
  const triage = mergeToolFindings([model()], [tool("triage")]);
  eq("an agreeing triage-tier tool merges", triage.length, 1);
  eq("...corroborates", triage[0]?.sources, ["m1", "eslint"]);
  eq("...but cannot re-escalate", triage[0]?.severity, "low");

  const fact = mergeToolFindings([model()], [tool("fact")]);
  eq("a fact-tier tool raises", fact[0]?.severity, "high");

  // A tool that overlaps with a different message saw a different problem: it stays a
  // finding of its own instead of corroborating a claim it never made.
  const other = mergeToolFindings(
    [{ ...model(), quote: "x();\ny();", claim: "loop never terminates", anchor: { ...line1, endLine: 2 }, skepticVerdicts: 0 }],
    [tool("fact", { claim: "Argument of type 'string' is not assignable to parameter of type 'number'" })],
  );
  eq("a disagreeing tool finding is kept separately", other.length, 2);
  eq("...and the model finding stays single-source", other[0]?.sources, ["m1"]);
  eq("...uncleared by the tool's sighting", other[0]?.skepticVerdicts, 0);

  // Two tight spans on a line this PR changed used to merge by position alone — which made
  // a tsc error "corroborate" a model claim about something else on the same line.
  const spanA = { ...model(), quote: "a();", claim: "one thing", anchor: { ...line1, startLine: 4, endLine: 4 } };
  const spanB = { ...tool("fact"), quote: "b();", claim: "another matter", anchor: { ...line1, startLine: 4, endLine: 4 } };
  eq("a tool finding on the same line with a different claim stays separate", mergeToolFindings([spanA], [spanB]).length, 2);
}

section("fingerprint stability: separators pinned byte-for-byte");
{
  // Recorded from the module BEFORE the raw U+0000 bytes in the template literal were
  // rewritten as escapes. The fingerprint is the identity embedded in every posted comment
  // and in dismissals.jsonl: a changed hash would orphan every existing thread and forget
  // every dismissal.
  const sample = mkFinding({ category: "correctness", file: "/src/Foo/X.ts", quote: "const A = 1;" });
  eq("pinned fingerprint of the sample finding", fingerprint(sample), "c848ab6f5911");
  eq("pinned fingerprint of an anchor-failed sample", fingerprint({ ...sample, quote: "nope();" }), "cbca6f1ccbee");
  // The same hashes through the pipeline path (anchorAndDedupe re-keys the file first).
  const file = mkFile("/src/Foo/X.ts", ["const A = 1;", "use(A);"], [1, 2]);
  const out = anchorAndDedupe(
    [{ model: "m", findings: [sample, { ...sample, quote: "nope();" }], rejected: 0, raw: "" }],
    new FileIndex([file]),
  );
  eq("pipeline path yields the pinned hash", out.merged[0]?.fingerprint, "c848ab6f5911");
  eq("...and for the degraded finding", out.degraded[0]?.fingerprint, "cbca6f1ccbee");
  // Whitespace and case never change identity; the category does.
  eq("whitespace and case are normalised", fingerprint({ ...sample, quote: "  CONST   a = 1;  " }), "c848ab6f5911");
  check("category is part of the identity", fingerprint({ ...sample, category: "security" }) !== "c848ab6f5911");
}

section("aggregate: a disagreeing source lends neither its fix nor its evidence");
{
  const lines = [
    "function tally(items) {",
    "  let total = 0;",
    "  for (const it of items) {",
    "    counter += it.n;",
    "    total += it.n;",
    "  }",
    "  log(total);",
    "  return counter;",
  ];
  const file = mkFile("/src/tally.ts", lines, lines.map((_, i) => i + 1));
  const idx = new FileIndex([file]);
  const out = (model: string, quote: string, claim: string, extra: Partial<RawFinding> = {}): FinderOutput => ({
    model,
    findings: [mkFinding({ file: "/src/tally.ts", quote, claim, ...extra })],
    rejected: 0,
    raw: "",
  });
  const disagree = anchorAndDedupe(
    [
      out("a", lines.join("\n"), "shared counter incremented without a lock, races under load"),
      out("b", "    counter += it.n;", "unused variable total is never read", { evidence: "total is written but never read", suggested_fix: "// drop total" }),
    ],
    idx,
  );
  eq("the disagreeing source is recorded as overlapping", disagree.merged[0]?.overlapping, ["b"]);
  check("...but its suggested fix is not borrowed", disagree.merged[0]?.suggested_fix === undefined, disagree.merged[0]?.suggested_fix);
  check("...nor its evidence", disagree.merged[0]?.evidence === undefined, disagree.merged[0]?.evidence);
  const agree = anchorAndDedupe(
    [
      out("a", "    counter += it.n;\n    total += it.n;", "counter is not atomic"),
      out("b", "    total += it.n;\n  }", "counter increment is not atomic under concurrent callers", { evidence: "two callers interleave", suggested_fix: "counter.incrementAndGet();" }),
    ],
    idx,
  );
  eq("an agreeing source still fills a missing fix", agree.merged[0]?.suggested_fix, "counter.incrementAndGet();");
  eq("...and missing evidence", agree.merged[0]?.evidence, "two callers interleave");
}

section("suppression markers: on the line, or on the comment lines just above it");
{
  const at = (lines: string[], line: number, end = line) => suppressionMarker(lines, line, end);
  eq("a marker after the code on the line", at(["const x: any = y; // eslint-disable-line"], 1), "eslint-disable");
  eq("# noqa, in either case", at(["import os  # NOQA: F401"], 1), "# noqa");
  eq("a marker line above, written for the line below", at(["// eslint-disable-next-line no-explicit-any", "const x: any = y;"], 2), "eslint-disable");
  eq("an annotation above, through a stack of them", at(['@SuppressWarnings("unchecked")', "@Override", "public List<T> items() {"], 3), "@SuppressWarnings");
  eq("a C# attribute above", at(['[SuppressMessage("Design", "CA1031")]', "catch (Exception) { }"], 2), "SuppressMessage");
  eq("@ts-ignore above", at(["// @ts-ignore", "foo.bar = 1;"], 2), "@ts-ignore");
  eq("Go's //nolint", at(["x, _ := f() //nolint:errcheck"], 1), "//nolint");
  eq("Rust's allow attribute", at(["#[allow(dead_code)]", "fn unused() {}"], 2), "#[allow]");
  eq("a marker on any line of a longer span", at(["a = 1", "b = eval(s)  # nosec", "c = 3"], 1, 3), "# nosec");
  eq("a marker after code on the line above is that line's own", at(["x = f()  # noqa: E501", "y = g()"], 2), undefined);
  eq("a blank line ends the search", at(["// eslint-disable-next-line", "", "const x = y;"], 3), undefined);
  eq("three comment lines up is within reach", at(["// NOSONAR", "// a", "// b", "run();"], 4), "NOSONAR");
  eq("...four is not", at(["// NOSONAR", "// a", "// b", "// c", "run();"], 5), undefined);
  eq("a name that merely contains one is not a marker", at(["const nolinter = noqaSetting;"], 1), undefined);
  eq("a line starting with a dereference is code, not a comment", at(["*p = 1; // NOLINT", "q();"], 2), undefined);
  eq("a clean line has none", at(["return total / parts;"], 1), undefined);
}

section("lanes: lines the change did not touch, and a check the author silenced");
{
  // Line 4 is the change; everything else was there before it.
  const lines = ["const a = load();", "const b = a.x;", "// eslint-disable-next-line", "const c: any = b;", "save(c);"];
  const file = mkFile("/src/lanes.ts", lines, [4]);
  const out = (quote: string, over: Partial<RawFinding> = {}): FinderOutput => ({
    model: "m1",
    findings: [mkFinding({ file: "/src/lanes.ts", quote, category: "correctness", claim: `about ${quote}`, ...over })],
    rejected: 0,
    raw: "",
  });
  const c = anchorAndDedupe([out("const b = a.x;"), out("const c: any = b;"), out("save(c);")], new FileIndex([file]));
  const by = (q: string) => c.merged.find((f) => f.quote === q);
  eq("a finding on an unchanged line is marked untouched", by("const b = a.x;")?.untouched, true);
  eq("...one on the changed line is not", by("const c: any = b;")?.untouched, undefined);
  eq("...and the marker above the changed line is named", by("const c: any = b;")?.silencedBy, "eslint-disable");
  eq("...but not for the line after it", by("save(c);")?.silencedBy, undefined);

  // A pure removal leaves no line of its own in the new file: the lines on either side of it
  // are where a finding about it can point.
  const left = ["function f(x) {", "  if (x == null) return;", "  x.go();", "  done();", "}"];
  const right = ["function f(x) {", "  x.go();", "  done();", "}"];
  const removed: FileDiff = {
    path: "src/f.js", changeType: "edit", rightLines: right, leftLines: left,
    ...buildHunks(left, right, diffLines(left, right)),
    binary: false, truncated: false, language: "javascript",
  };
  const r = anchorAndDedupe(
    [{ model: "m1", rejected: 0, raw: "", findings: [
      mkFinding({ file: "src/f.js", quote: "  x.go();", claim: "x can be null now that the check is gone" }),
      mkFinding({ file: "src/f.js", quote: "  done();", claim: "done() runs twice" }),
    ] }],
    new FileIndex([removed]),
  );
  eq("the line below a removal counts as the change", r.merged.find((f) => f.quote === "  x.go();")?.untouched, undefined);
  eq("...the line after that does not", r.merged.find((f) => f.quote === "  done();")?.untouched, true);
  const swapLeft = ["a();", "b();", "c();"];
  const swapRight = ["a();", "B();", "c();"];
  const swapped: FileDiff = {
    path: "src/g.js", changeType: "edit", rightLines: swapRight, leftLines: swapLeft,
    ...buildHunks(swapLeft, swapRight, diffLines(swapLeft, swapRight)),
    binary: false, truncated: false, language: "javascript",
  };
  const s2 = anchorAndDedupe([{ model: "m1", rejected: 0, raw: "", findings: [mkFinding({ file: "src/g.js", quote: "a();" })] }], new FileIndex([swapped]));
  eq("a replaced line has its own new line, so its neighbours stay untouched", s2.merged[0]?.untouched, true);

  // A marker on a line the change removed silences nothing that is still there.
  const gone: FileDiff = {
    path: "src/h.py", changeType: "edit", rightLines: ["y = 2"], leftLines: ["x = f()  # noqa", "y = 2"],
    ...buildHunks(["x = f()  # noqa", "y = 2"], ["y = 2"], diffLines(["x = f()  # noqa", "y = 2"], ["y = 2"])),
    binary: false, truncated: false, language: "python",
  };
  const g = anchorAndDedupe([{ model: "m1", rejected: 0, raw: "", findings: [mkFinding({ file: "src/h.py", quote: "x = f()  # noqa", side: "left" })] }], new FileIndex([gone]));
  eq("a left-side finding is on the change", g.merged[0]?.untouched, undefined);
  eq("...and its removed marker silences nothing", g.merged[0]?.silencedBy, undefined);

  const mk = (over: Partial<AnchoredFinding>): AnchoredFinding => ({
    category: "correctness", severity: "high", confidence: 0.8, file: "src/a.ts", quote: "x();", claim: "c",
    sources: ["m1", "m2"], fingerprint: `fp${Math.random()}`,
    anchor: { side: "right", startLine: 2, endLine: 2, startOffset: 1, endOffset: 5 },
    ...over,
  });
  const empty = { merged: [], degraded: [], rawCount: 0, byFailure: {}, excluded: 0 };
  const res = finalize(empty, [
    mk({ claim: "old code", untouched: true }),
    mk({ claim: "silenced", silencedBy: "# noqa" }),
    mk({ claim: "both", untouched: true, silencedBy: "# noqa" }),
    mk({ claim: "critical old code", severity: "critical", untouched: true }),
    mk({ claim: "critical silenced", severity: "critical", silencedBy: "# noqa" }),
    mk({ claim: "low old code", severity: "low", untouched: true }),
    mk({ claim: "unverified old code", sources: ["m1"], untouched: true }),
    // A tool's sighting is its own clearing, as triageAndConvert records it.
    mk({ claim: "tool", tier: "fact", sources: ["tsc"], skepticVerdicts: 1, untouched: true, silencedBy: "# noqa" }),
    mk({ claim: "new code" }),
  ]);
  const why = (claim: string) =>
    res.inline.some((f) => f.claim === claim) ? "inline" : res.belowBar.find((f) => f.claim === claim)?.suppressedBy;
  eq("a finding on untouched lines is listed as pre-existing", why("old code"), "pre-existing");
  eq("a finding under a suppression marker is listed as silenced", why("silenced"), "silenced");
  eq("...which outranks untouched: someone decided about that line", why("both"), "silenced");
  eq("a critical finding is posted from untouched lines", why("critical old code"), "inline");
  eq("...and past a marker", why("critical silenced"), "inline");
  eq("severity is judged first: a low finding stays below the bar", why("low old code"), "severity");
  eq("...and corroboration before that", why("unverified old code"), "no-corroboration");
  eq("a tool finding never enters a lane", why("tool"), "inline");
  eq("a finding on the change is posted", why("new code"), "inline");

  // The lanes are not the cap: a laned finding takes no inline slot, and a critical one let
  // through takes one like any other. Here the high "pre" would outrank every medium.
  const full = finalize(empty, [
    mk({ claim: "critical past a marker", severity: "critical", silencedBy: "# noqa" }),
    mk({ claim: "pre", untouched: true }),
    ...Array.from({ length: MAX_INLINE_COMMENTS }, (_, i) => mk({ claim: `n${i}`, severity: "medium" })),
  ]);
  eq("the cap fills with what is posted", full.inline.length, MAX_INLINE_COMMENTS);
  eq("...the critical one first", full.inline[0]?.claim, "critical past a marker");
  eq("...so only the overflow is capped: a laned finding took no slot", full.belowBar.filter((f) => f.suppressedBy === "cap").length, 1);
  eq("...and the laned one is filed under its lane", full.belowBar.find((f) => f.claim === "pre")?.suppressedBy, "pre-existing");

  // A tool that reports the line in spite of its marker shows the marker was about something else.
  const model = mk({ claim: "x may be undefined here", sources: ["m1"], skepticVerdicts: 1, silencedBy: "# noqa" });
  const tool = mk({ claim: "'x' is possibly undefined", sources: ["tsc"], tier: "fact" });
  const merged = mergeToolFindings([model], [tool]);
  eq("an agreeing tool merges in", merged.length, 1);
  eq("...and lifts the marker's silence", merged[0]?.silencedBy, undefined);
}

section("risk tiers: how much review a change gets, from its size and what it touches");
{
  const change = (lines: number, files: number, path = "src/a.ts"): FileDiff[] =>
    Array.from({ length: files }, (_, i) => ({
      ...mkFile(i === 0 ? path : `src/f${i}.ts`, ["x"], []),
      changedRightLines: new Set(Array.from({ length: i === 0 ? lines - (files - 1) : 1 }, (_, n) => n + 1)),
    }));
  const on: TierSettings = {
    enabled: true, sensitive: [], finders: ["a", "b", "c"], skepticModels: ["s1", "s2", "s3"],
    skepticRounds: 3, minSeverity: "medium", requireCorroboration: true,
  };
  const off = riskTier(change(5, 1), { ...on, enabled: false });
  eq("off, every change gets everything configured", [off.name, off.finders, off.skepticRounds, off.minSeverity], ["full", ["a", "b", "c"], 3, "medium"]);

  const trivial = riskTier(change(5, 1), on);
  eq("a five-line change is trivial", trivial.name, "trivial");
  eq("...one finder, one verifier round", [trivial.finders, trivial.skepticRounds], [["a"], 1]);
  eq("...and comments one severity stricter", trivial.minSeverity, "high");
  eq("...said in one line", describeTier(trivial), "trivial (5 changed lines in 1 file): 1 finder, 1 verifier round, inline comments at high and above");
  eq("with no skeptic to corroborate one finder, two are kept", riskTier(change(5, 1), { ...on, skepticModels: [] }).finders, ["a", "b"]);
  eq("...unless corroboration is not required", riskTier(change(5, 1), { ...on, skepticModels: [], requireCorroboration: false }).finders, ["a"]);
  eq("a bar of high stays high", riskTier(change(5, 1), { ...on, minSeverity: "high" }).minSeverity, "high");
  eq("...critical stays critical", riskTier(change(5, 1), { ...on, minSeverity: "critical" }).minSeverity, "critical");
  eq("...and low becomes medium", riskTier(change(5, 1), { ...on, minSeverity: "low" }).minSeverity, "medium");

  const lite = riskTier(change(21, 1), on);
  eq("one line past trivial is lite: two finders, rounds and bar as configured", [lite.name, lite.finders, lite.skepticRounds, lite.minSeverity], ["lite", ["a", "b"], 3, "medium"]);
  eq("four files is past trivial whatever their size", riskTier(change(4, 4), on).name, "lite");
  eq("past two hundred lines is the full review", riskTier(change(201, 2), on).name, "full");
  eq("...and past fifteen files", riskTier(change(16, 16), on).name, "full");

  const auth = riskTier(change(2, 1, "src/auth/login.ts"), { ...on, sensitive: ["**/auth/**"] });
  eq("a sensitive path gets the full review however small the change", [auth.name, auth.finders.length], ["full", 3]);
  check("...and says which path did it", auth.reason.includes("src/auth/login.ts matches PRR_SENSITIVE_PATHS"), auth.reason);
  eq("a glob with no slash matches a file name at any depth", riskTier(change(2, 1, "db/migrations/001.sql"), { ...on, sensitive: ["*.sql"] }).name, "full");

  // The bar a tier sets is the bar finalize applies.
  const f = (severity: AnchoredFinding["severity"]): AnchoredFinding => ({
    category: "correctness", severity, confidence: 0.8, file: "src/a.ts", quote: "x();", claim: severity,
    sources: ["m1", "m2"], fingerprint: `fp-${severity}`, anchor: { side: "right", startLine: 1, endLine: 1, startOffset: 1, endOffset: 5 },
  });
  const empty = { merged: [], degraded: [], rawCount: 0, byFailure: {}, excluded: 0 };
  const strict = finalize(empty, [f("high"), f("medium")], new Set(), 0, "high");
  eq("a stricter bar keeps a medium finding off the lines", [strict.inline.map((x) => x.claim), strict.belowBar.map((x) => x.suppressedBy)], [["high"], ["severity"]]);
}

section("convergence: on a later push, code an earlier push wrote is not code from before the PR");
{
  // The whole PR added lines 1-10; this push changed line 12 alone.
  const whole: FileDiff = { ...mkFile("src/a.ts", Array.from({ length: 20 }, (_, i) => `l${i + 1}`), []), changedRightLines: new Set(Array.from({ length: 10 }, (_, i) => i + 1)) };
  const at = (line: number, over: Partial<AnchoredFinding> = {}): AnchoredFinding => ({
    category: "correctness", severity: "high", confidence: 0.8, file: "src/a.ts", quote: `l${line}`, claim: `at ${line}`,
    sources: ["m1"], fingerprint: `fp${line}`, suppressedBy: "pre-existing", untouched: true,
    anchor: { side: "right", startLine: line, endLine: line, startOffset: 1, endOffset: 3 }, ...over,
  });
  const missed = at(5);
  const older = at(15);
  const left = at(6, { anchor: { side: "left", startLine: 6, endLine: 6, startOffset: 1, endOffset: 3 } });
  const posted = at(7, { suppressedBy: "cap" });
  markEarlierPushes([missed, older, left, posted], new FileIndex([whole]));
  eq("a line an earlier push wrote is the PR's own", missed.earlierPush, true);
  eq("...one no push wrote predates the PR", older.earlierPush, false);
  eq("...an old-side line is left unsplit", left.earlierPush, undefined);
  eq("...and only pre-existing findings are split", posted.earlierPush, undefined);
}
