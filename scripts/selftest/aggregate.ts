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
