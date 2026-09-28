// Measurement: calibration against what humans did, run stamps, golden-set evaluation, and
// benchmarks scored the way they score themselves.
import { finalize, fingerprint } from "../../gates/aggregate";
import { applyVerdicts } from "../../gates/skeptic";
import { EXPECTED_ANCHORS, SEEDED_DEFECTS } from "../../fixtures/seeded-pr";
import { calibrate, groupReasons, type Bucket, type CalibrationFinding } from "../calibrate";
import {
  evaluateRun,
  totalsOf,
  STAGES,
  type EvaluatedFinding,
  type GoldenSet,
  type Stage,
} from "../evaluate";
import {
  candidatesOf,
  compareScores,
  fromAacr,
  fromMartian,
  matchRun,
  nearby,
  onLines,
  sampleSuite,
  suiteHash,
  summarize,
  type Candidate,
  type CaseSeries,
  type Reference,
  type ScoreFile,
} from "../bench";
import { stampHashes, stampLabel } from "../../libs/stamp";
import * as path from "node:path";
import { run } from "../../libs/shell";
import { check, eq, section } from "./harness";

section("calibration: joining what we published to what humans rejected");
{
  const f = (fingerprint: string, category: string, confidence: number, sources: string[], published: boolean) =>
    ({ fingerprint, category, confidence, sources, published });
  const report = calibrate({
    findings: [
      // The same finding from two runs of the same PR: counted once, published if it was
      // ever published — otherwise a PR reviewed ten times weighs ten times as much.
      f("a", "correctness", 0.95, ["m1", "m2"], false),
      f("a", "correctness", 0.95, ["m1", "m2"], true),
      f("b", "security", 0.8, ["m1"], true),
      f("c", "maintainability", 0.4, ["m2"], true),
      f("d", "correctness", 0.95, ["m1"], false),
      f("", "correctness", 0.9, ["m1"], true),
    ],
    verdicts: [
      { model: "sk1", verdict: "refuted", error: false },
      { model: "sk1", verdict: "holds", error: false },
      { model: "sk1", verdict: "insufficient-context", error: false },
      { model: "sk1", verdict: "", error: true },
      { model: "sk2", verdict: "holds", error: false },
    ],
    dismissed: new Set(["a", "c", "zzz"]),
  });
  eq("findings are counted once per fingerprint", report.findings, 4);
  // A fingerprint-less record is not a finding: it cannot be joined to a dismissal, and
  // counting it would inflate the denominator every rate below is measured against.
  eq("published in any run counts as published, fingerprint-less records excluded", report.published, 3);
  eq("dismissed findings counted", report.dismissed, 2);
  eq("published-then-dismissed is the false-positive number", report.publishedDismissed, 2);
  eq("a dismissal whose run was pruned is named, not silently dropped", report.orphanDismissals, 1);

  const conf = new Map(report.byConfidence.map((b) => [b.key, b]));
  eq("confidence buckets are in descending order", report.byConfidence.map((b) => b.key), ["0.9-1.0", "0.7-0.9", "<0.5"]);
  eq("the top bucket holds both 0.95 findings", conf.get("0.9-1.0")?.findings, 2);
  eq("...only one of which was ever published", conf.get("0.9-1.0")?.published, 1);
  eq("...and the rate is dismissed over PUBLISHED, not over found", conf.get("0.9-1.0")?.rate, 1);
  eq("an undismissed bucket rates zero", conf.get("0.7-0.9")?.rate, 0);

  const cat = new Map(report.byCategory.map((b) => [b.key, b]));
  eq("category rolls up across runs", cat.get("correctness")?.findings, 2);
  eq("...with its own rate", cat.get("maintainability")?.rate, 1);

  const finder = new Map(report.byFinder.map((b) => [b.key, b]));
  eq("a shared finding counts for both finders", [finder.get("m1")?.findings, finder.get("m2")?.findings], [3, 2]);
  eq("...and so does its dismissal", finder.get("m1")?.dismissed, 1);

  const sk = new Map(report.skeptics.map((v) => [v.model, v]));
  eq("errored calls are not answers", sk.get("sk1")?.answered, 3);
  eq("...they are counted as errors", sk.get("sk1")?.errors, 1);
  eq("kill rate is over answers", sk.get("sk1")?.killRate, 1 / 3);
  eq("so is the could-not-check rate", sk.get("sk1")?.uncheckedRate, 1 / 3);
  eq("a verifier that never killed anything reads zero", sk.get("sk2")?.killRate, 0);

  const empty = calibrate({ findings: [], verdicts: [], dismissed: new Set() });
  eq("an empty store divides by nothing", [empty.findings, empty.published, empty.publishedDismissed], [0, 0, 0]);
  eq("...and reports no buckets", [empty.byConfidence.length, empty.byCategory.length, empty.skeptics.length], [0, 0, 0]);
  eq("...and nothing was killed either", empty.killed, 0);

  // A refuted finding reaches neither inline, belowBar nor degraded — applyVerdicts drops it
  // before finalize runs — so it appears in NO findings.json and has to be carried in from
  // skeptic.json, or the finder that produced it looks identical to one that produced
  // nothing for the verifier to throw away.
  const killedReport = calibrate({
    findings: [f("survivor", "correctness", 0.9, ["m1"], true)],
    verdicts: [],
    outcomes: [
      { fingerprint: "ghost", category: "security", confidence: 0.6, sources: ["m2"], killed: true },
      { fingerprint: "survivor", category: "correctness", confidence: 0.9, sources: ["m1"], killed: false },
      // Written before the row carried a finding's identity: its verdicts still count, but
      // it can be attributed to no finder and no category, which is the honest answer.
      { killed: true },
    ],
    dismissed: new Set(),
  });
  eq("a refuted finding joins the population it was missing from", killedReport.findings, 2);
  eq("...and is counted as killed", killedReport.killed, 1);
  eq("...without ever counting as published", killedReport.published, 1);
  const kCat = new Map(killedReport.byCategory.map((b) => [b.key, b]));
  eq("the kill lands in its own category", [kCat.get("security")?.findings, kCat.get("security")?.killed], [1, 1]);
  eq("...and not in the survivor's", kCat.get("correctness")?.killed, 0);
  const kFinder = new Map(killedReport.byFinder.map((b) => [b.key, b]));
  eq("the finder whose output was refuted is named", [kFinder.get("m2")?.findings, kFinder.get("m2")?.killed], [1, 1]);
  eq("...and the one whose output survived is not blamed", kFinder.get("m1")?.killed, 0);

  // PROPOSAL §12's north star. Precision estimated as one minus the dismissal rate counts
  // every comment nobody answered as a success, which on a review bot is most of them.
  const acted = calibrate({
    findings: [
      f("fixed1", "correctness", 0.9, ["m1"], true),
      f("fixed2", "security", 0.8, ["m1"], true),
      f("auto1", "reliability", 0.8, ["m2"], true),
      f("ignored", "performance", 0.6, ["m2"], true),
    ],
    verdicts: [],
    actedOn: { fixed: new Set(["fixed1", "fixed2"]), autoClosed: new Set(["auto1"]) },
    dismissed: new Set(),
  });
  eq("a human's fix is the implementation rate's numerator", acted.actedOn, 2);
  // prloop's auto-close sets the same status a person does, so folding it in would let the
  // tool's own inference inflate its own score.
  eq("...and prloop's own auto-close is counted beside it, never inside it", acted.autoClosed, 1);
  const aCat = new Map(acted.byCategory.map((b) => [b.key, b]));
  eq("the fix lands in the finding's own category", aCat.get("security")?.actedOn, 1);
  eq("...and a comment nobody answered counts as nothing", aCat.get("performance")?.actedOn, 0);
  const aFinder = new Map(acted.byFinder.map((b) => [b.key, b]));
  eq("per finder, how much of its output was acted on", [aFinder.get("m1")?.actedOn, aFinder.get("m2")?.actedOn], [2, 0]);

  // A dismissal rate says how often prloop is wrong; only the reviewer's words say in what
  // way, and until now the only thing kept about a dismissal was that it happened.
  const withReasons = calibrate({
    findings: [f("a", "performance", 0.8, ["m1"], true)],
    verdicts: [],
    dismissed: new Set(["a"]),
    dismissalReasons: ["This is a test fixture.", "this is a test fixture", "  This is a test fixture  ", "Intentional, see ADR-7"],
    reasonlessDismissals: 6,
  });
  eq(
    "the same objection typed three ways is one reason",
    withReasons.reasons,
    [{ reason: "This is a test fixture.", count: 3 }, { reason: "Intentional, see ADR-7", count: 1 }],
  );
  eq("...and the reviewers who said nothing are counted too", withReasons.reasonless, 6);
  // Case and trailing punctuation only. Anything cleverer merges two different reasons and
  // reports a consensus nobody expressed.
  eq(
    "two different objections stay two",
    groupReasons(["wrong line", "wrong file"]).map((r) => r.count),
    [1, 1],
  );
  eq("blank replies are not a reason", groupReasons(["   ", ""]), []);
  eq("nothing recorded is an empty list, not a zero row", calibrate({ findings: [], verdicts: [], dismissed: new Set() }).reasons, []);

  // "Did the prompt change help?" needs the runs before and after it kept apart. They were
  // pooled into one rate — the average of the thing and what it was compared against.
  const byStamp = calibrate({
    findings: [
      { fingerprint: "s1", category: "correctness", confidence: 0.8, sources: ["m"], published: true, stamp: "old" },
      { fingerprint: "s2", category: "correctness", confidence: 0.8, sources: ["m"], published: true, stamp: "new" },
      { fingerprint: "s3", category: "correctness", confidence: 0.8, sources: ["m"], published: true, stamp: "new" },
      // The same finding again under the new prompt: it was first produced under the old one.
      { fingerprint: "s1", category: "correctness", confidence: 0.8, sources: ["m"], published: true, stamp: "new" },
    ],
    verdicts: [],
    dismissed: new Set(["s1"]),
  });
  eq("findings are grouped by the configuration that produced them",
    byStamp.byStamp.map((b) => [b.key, b.findings, b.dismissed]), [["new", 2, 0], ["old", 1, 1]]);

  // What the comments LED to. Dismissals alone count every comment nobody answered as a
  // success; the ledger also knows the ones the code changed under, and the ones walked past.
  const pubs = (n: number, over: Partial<CalibrationFinding>) =>
    Array.from({ length: n }, (_, i): CalibrationFinding => ({
      fingerprint: `${over.rule ?? over.category ?? "x"}-${over.severity ?? ""}-${i}`,
      category: "maintainability", confidence: 0.8, sources: ["m"], published: true, repo: "o/p/r", ...over,
    }));
  const noisy = pubs(12, { category: "maintainability", severity: "low" });
  const useful = pubs(10, { category: "correctness", severity: "high" });
  const lint = pubs(10, { category: "maintainability", severity: "low", rule: "ruff:SIM102", sources: ["ruff"] });
  const ledger = calibrate({
    findings: [...noisy, ...useful, ...lint],
    verdicts: [],
    dismissed: new Set([...noisy.slice(0, 5), ...lint.slice(0, 2)].map((f) => f.fingerprint)),
    actedOn: {
      fixed: new Set(useful.slice(0, 5).map((f) => f.fingerprint)),
      autoClosed: new Set([...useful.slice(5, 8), ...noisy.slice(5, 6)].map((f) => f.fingerprint)),
      ignored: new Set([...noisy.slice(6), ...lint.slice(2)].map((f) => f.fingerprint)),
      liked: new Set(useful.slice(0, 2).map((f) => f.fingerprint)),
    },
  });
  const row = (b: Bucket[], key: string) => b.find((x) => x.key === key);
  eq("a category's addressed rate counts fixes and code changed under the comment",
    row(ledger.byCategory, "correctness")?.addressedRate, 0.8);
  eq("...and the ones walked past at merge are counted, not read as silence",
    [row(ledger.byCategory, "maintainability")?.ignored, row(ledger.byCategory, "maintainability")?.liked], [14, 0]);
  eq("likes are counted where they fell", row(ledger.byCategory, "correctness")?.liked, 2);
  eq("a tool's rule has its own row", row(ledger.byRule, "ruff:SIM102")?.published, 10);
  eq("the headline addressed count", ledger.addressed, 9);
  eq("a category and a rule nobody acts on are proposed for demotion — in their own repository",
    ledger.proposals.map((p) => [p.repo, p.subject, p.kind]).sort(),
    [["o/p/r", "maintainability", "category"], ["o/p/r", "ruff:SIM102", "rule"]]);
  check("...as a suggestion naming the setting, never applied",
    ledger.proposals.some((p) => p.suggestion.includes("PRR_EXCLUDE_CATEGORIES=maintainability")));
  check("a category people act on is not proposed", !ledger.proposals.some((p) => p.subject === "correctness"));
  check("severity ordered as expected raises no caution", ledger.inverted === undefined);
  const inverted = calibrate({
    findings: [...pubs(10, { category: "a", severity: "low" }), ...pubs(10, { category: "b", severity: "critical" })],
    verdicts: [],
    dismissed: new Set(),
    actedOn: { fixed: new Set(pubs(10, { category: "a", severity: "low" }).map((f) => f.fingerprint)), autoClosed: new Set() },
  });
  check("low-severity comments addressed more than critical ones raise the compliance caution",
    (inverted.inverted ?? "").includes("partly compliance"), inverted.inverted);
  eq("too few comments propose nothing", calibrate({ findings: pubs(3, { category: "z" }), verdicts: [], dismissed: new Set() }).proposals, []);
}

section("run stamp: what produced a run, as hashes a report can group by");
{
  const base = {
    promptSources: "prompts/finder.ts\nexport const X = 1;",
    rules: [{ name: "_base.md", body: "# Base" }, { name: "java.md", body: "# Java" }],
    models: { finders: ["a", "b"], skeptics: ["c"] },
    settings: [{ name: "PRR_MIN_INLINE_SEVERITY", value: "medium" }, { name: "PRR_MAX_DIFF_CHARS", value: "240000" }],
  };
  const h = stampHashes(base);
  check("every hash is 12 hex", Object.values(h).every((x) => /^[0-9a-f]{12}$/.test(x)), JSON.stringify(h));
  eq("the same inputs give the same stamp", stampHashes(base), h);
  eq("rule and setting order do not matter",
    stampHashes({ ...base, rules: [...base.rules].reverse(), settings: [...base.settings].reverse() }), h);
  const edited = stampHashes({ ...base, promptSources: `${base.promptSources} ` });
  check("a one-byte prompt edit changes the prompts hash", edited.prompts !== h.prompts);
  eq("...and nothing else", [edited.rules, edited.models, edited.config], [h.rules, h.models, h.config]);
  check("a setting change moves only the config hash",
    stampHashes({ ...base, settings: [{ name: "PRR_MIN_INLINE_SEVERITY", value: "high" }, base.settings[1]!] }).config !== h.config);
  eq("a label names the commit and a prefix of each hash",
    stampLabel({ commit: "0123456789abcdef", dirty: true, hashes: { prompts: "aaaaaa111111", rules: "bbbbbb222222", models: "cccccc333333", config: "dddddd444444" } }),
    "0123456+ p:aaaaaa r:bbbbbb m:cccccc c:dddddd");
  eq("a run from before the stamp says so", stampLabel(undefined), "(unstamped)");
}

section("golden-set evaluation: which stage lost the defect, not just that one was lost");
{
  const at = (file: string, start: number, over: Partial<EvaluatedFinding> = {}): EvaluatedFinding => ({
    file,
    start,
    end: start,
    sources: ["m1"],
    ...over,
  });
  const golden: GoldenSet = {
    defects: [
      { file: "src/a.ts", lines: [10, 10], note: "reported" },
      { file: "src/a.ts", lines: [20, 20], note: "capped" },
      { file: "src/a.ts", lines: [30, 30], note: "single finder" },
      { file: "src/b.ts", lines: [40, 40], note: "skeptic killed it" },
      { file: "src/c.ts", lines: [50, 50], note: "quote would not anchor" },
      { file: "src/d.ts", lines: [60, 60], note: "nobody said anything" },
    ],
    mustNotFlag: [{ file: "src/e.ts", lines: [1, 99], note: "reviewed clean" }],
  };
  const e = evaluateRun(golden, {
    inline: [
      at("src/a.ts", 10, { sources: ["m1", "m2"] }),
      // Inside a region a reviewer declared clean: a measured mistake, not a guess.
      at("src/e.ts", 7),
      // Matches neither a defect nor a clean region — unknown, and must not be counted
      // against precision, because the golden set does not claim to be exhaustive.
      at("src/z.ts", 3),
    ],
    belowBar: [
      at("src/a.ts", 20, { suppressedBy: "cap" }),
      at("src/a.ts", 30, { suppressedBy: "no-corroboration" }),
    ],
    // A degraded finding has no line at all — that is what makes it degraded — so it can
    // only be matched on the file.
    degraded: [{ file: "src/c.ts", sources: ["m1"], anchorFailure: "quote-ambiguous" }],
    refuted: [at("src/b.ts", 40, { sources: ["m2"] })],
  });
  const stages = new Map(e.outcomes.map((o) => [o.defect.note, o.stage]));
  eq("a defect that reached a comment is a hit", stages.get("reported"), "inline");
  eq("...one cut by the cap names the cap", stages.get("capped"), "cap");
  eq("...one held for want of a second finder names corroboration", stages.get("single finder"), "no-corroboration");
  eq("...one the skeptic killed is not 'not found'", stages.get("skeptic killed it"), "refuted");
  eq("...one whose quote would not anchor blames anchoring", stages.get("quote would not anchor"), "anchor-failed");
  eq("...and only silence is not-found", stages.get("nobody said anything"), "not-found");
  eq("recall counts comments, not attempts", e.hits, 1);
  eq("but five of six were seen by something", e.found, 4);

  // Precision's denominator is the honest part. A comment matching no known defect is not
  // evidence of a false positive unless a reviewer said that region was clean.
  eq("a comment in a declared-clean region is a false positive", e.falsePositives.length, 1);
  eq("...and one nobody has ruled on is unattributed, not wrong", e.unattributed.length, 1);

  // Furthest stage wins: the kill is a fact about one finding, not about the defect.
  const both = evaluateRun(
    { defects: [{ file: "src/a.ts", lines: [10, 10], note: "x" }] },
    { inline: [at("src/a.ts", 10)], belowBar: [], degraded: [], refuted: [at("src/a.ts", 10, { sources: ["m2"] })] },
  );
  eq("a defect one finder found and another had refuted still counts as reported", both.outcomes[0]?.stage, "inline");

  // Paths come from a golden file a human typed; findings.json stores them canonically.
  const slashed = evaluateRun(
    { defects: [{ file: "/src/a.ts", lines: [10, 10], note: "x" }] },
    { inline: [at("src/a.ts", 10)], belowBar: [], degraded: [], refuted: [] },
  );
  eq("a leading slash in the golden file does not lose the match", slashed.outcomes[0]?.stage, "inline");

  const t = totalsOf([e]);
  eq("every stage is a row, even at zero", Object.keys(t.byStage).length, STAGES.length);
  const mixed = totalsOf([{ ...e, stamp: "p:old" }, { ...e, stamp: "p:new" }]);
  eq("runs scored under two configurations are kept apart", [...mixed.byStamp.keys()].sort(), ["p:new", "p:old"]);
  eq("totals carry the defect count", t.defects, 6);
  eq("both finders on one defect are both credited", [t.byFinder.get("m1"), t.byFinder.get("m2")], [4, 2]);

  // The fixture is the golden set that ships with the repo; it must stay in step with the
  // anchoring vectors it is derived from rather than drifting into a hand-written copy.
  eq("the seeded PR ships eight known defects", SEEDED_DEFECTS.length, 8);
  check(
    "...every one of them naming a line the anchoring net also pins",
    SEEDED_DEFECTS.every((d) =>
      EXPECTED_ANCHORS.some((a) => a.file === d.file && a.expect === d.lines[0] && a.defect === true),
    ),
  );
  check(
    "...and none of the anchoring boundary cases among them",
    !SEEDED_DEFECTS.some((d) => d.note.includes("->")),
    SEEDED_DEFECTS.map((d) => d.note).join(" | "),
  );
}

// --- realistic seeded PR ---
// Toy fixtures prove the algorithm runs; this proves it lands on the right line in code
// that looks like real code. Every expectation below was verified against `grep -n` on the
// actual repository these files came from.
section("benchmarks: imported as they score themselves, matched one to one, held to their own noise");
{
  // AACR: source_commit is the base and target_commit the head — its own converter says so.
  const aacr = fromAacr(
    [
      {
        githubPrUrl: "https://github.com/acme/shop/pull/12",
        source_commit: "b".repeat(40),
        target_commit: "c".repeat(40),
        project_main_language: "Go",
        comments: [
          { note: "nil map write", path: "pkg/a.go", from_line: 9, to_line: 7, side: "right", category: "Code Defect" },
          { note: "no path, dropped", path: "", from_line: 1, to_line: 1 },
          { note: "deleted-side remark", path: "/pkg/a.go", from_line: 3, to_line: null, side: "left" },
        ],
      },
      { githubPrUrl: "https://gitlab.com/x/y/merge_requests/1", source_commit: "a", target_commit: "b", comments: [{ note: "n", path: "p" }] },
    ],
    "fixture",
  );
  const shop = aacr.cases[0];
  eq("AACR: one case per GitHub pull request", aacr.cases.length, 1);
  eq("...named as the benchmark's own converter names it", shop?.id, "acme__shop@ccccccc");
  eq(
    "...source_commit is the base and target_commit the head",
    [shop?.base, shop?.head, shop?.pr, shop?.repo],
    ["b".repeat(40), "c".repeat(40), 12, "https://github.com/acme/shop"],
  );
  eq("...a comment with no path is dropped, the rest keep their place in the dataset", shop?.references.map((r) => r.id), ["acme__shop@ccccccc#1", "acme__shop@ccccccc#3"]);
  eq("...a reversed range is put in order", shop?.references[0]?.lines, [7, 9]);
  eq(
    "...one line given is one line, and the leading slash goes",
    [shop?.references[1]?.file, shop?.references[1]?.lines, shop?.references[1]?.side],
    ["pkg/a.go", [3, 3], "left"],
  );

  const martian = fromMartian(
    [
      {
        name: "keycloak.json",
        entries: [
          { url: "https://github.com/keycloak/keycloak/pull/1", comments: [{ comment: "c1", severity: "High", category: "bug" }] },
          { url: "https://github.com/ai-code-review-evaluation/keycloak-x/pull/2", original_url: "https://github.com/keycloak/keycloak/pull/3", comments: [{ comment: "c2" }] },
          {
            url: "https://github.com/ai-code-review-evaluation/discourse-x/pull/4",
            original_url: `https://github.com/discourse/discourse/commit/${"d".repeat(40)}`,
            comments: [{ comment: "c3" }],
          },
          { url: "https://github.com/ai-code-review-evaluation/sentry-x/pull/5", original_url: null, comments: [{ comment: "c4" }] },
          { url: "https://github.com/keycloak/keycloak/pull/1", comments: [{ comment: "the same pull request again" }] },
        ],
      },
    ],
    "fixture",
  );
  const byId = new Map(martian.cases.map((c) => [c.id, c]));
  eq("Martian: an upstream pull request is taken as it is", [byId.get("keycloak__keycloak#1")?.pr, byId.get("keycloak__keycloak#1")?.language], [1, "Java"]);
  eq("...a re-creation of one is reviewed as its original", byId.get("keycloak__keycloak#3")?.repo, "https://github.com/keycloak/keycloak");
  eq(
    "...a re-creation of a commit reviews that commit against its parent",
    [byId.get("discourse__discourse@ddddddd")?.base, byId.get("discourse__discourse@ddddddd")?.head],
    [`${"d".repeat(40)}^`, "d".repeat(40)],
  );
  check(
    "...one with no original is left unresolved, not guessed",
    (byId.get("ai-code-review-evaluation__sentry-x#5")?.unresolved ?? "").includes("known only to GitHub's API"),
  );
  check("...two entries for one pull request stay two cases", byId.has("keycloak__keycloak#1~2"));
  eq("...and a text reference carries no location", martian.cases[0]?.references[0], { id: "keycloak__keycloak#1#1", text: "c1", category: "bug", severity: "High" });

  const sampled = sampleSuite(martian, 2, 7);
  eq("a sample is reproducible", sampled.cases.map((c) => c.id), sampleSuite(martian, 2, 7).cases.map((c) => c.id));
  check("...keeps the dataset's order", sampled.cases.map((c) => martian.cases.indexOf(c)).every((v, i, a) => i === 0 || v > a[i - 1]!));
  check("...and says it is a sample", sampled.source.includes("2 of 5 cases (seed 7)"), sampled.source);

  const pinnedCopy = { ...aacr, cases: aacr.cases.map((c) => ({ ...c, base: "e".repeat(40), resolvedBy: "x" })) };
  eq("pinning a case's commits does not change what the suite is", suiteHash(pinnedCopy), suiteHash(aacr));
  check("...changing what it should find does", suiteHash({ ...aacr, cases: aacr.cases.map((c) => ({ ...c, references: c.references.slice(1) })) }) !== suiteHash(aacr));

  // AACR's location rule: overlapping, or at most k lines apart.
  const ref = (over: Partial<Reference> = {}): Reference => ({ id: "r", text: "t", file: "src/a.ts", lines: [10, 12], ...over });
  const cand = (start: number | undefined, over: Partial<Candidate> = {}): Candidate => ({
    stage: "inline",
    file: "src/a.ts",
    ...(start === undefined ? {} : { start, end: start }),
    claim: "c",
    sources: ["m1"],
    ...over,
  });
  eq("a comment inside the range is on it", onLines(cand(11), ref(), 0), true);
  eq("...one line either side is within k = 1", [onLines(cand(13), ref(), 1), onLines(cand(9), ref(), 1)], [true, true]);
  eq("...but not within k = 0", onLines(cand(13), ref(), 0), false);
  eq("...and two lines away is not within k = 1", onLines(cand(14), ref(), 1), false);
  eq("...another file never is", onLines(cand(11, { file: "src/b.ts" }), ref(), 5), false);
  eq("...nor is a reference on deleted lines, where prloop never comments", onLines(cand(11), ref({ side: "left" }), 5), false);
  eq("...nor a finding with no line", onLines(cand(undefined, { stage: "anchor-failed" }), ref(), 5), false);
  eq("an unanchored finding is near its file's references, for the ladder only", nearby([cand(undefined, { stage: "anchor-failed" })], ref(), 1), [0]);

  // One to one, hits and misses alike.
  const refs = [ref({ id: "r1", lines: [10, 10] }), ref({ id: "r2", lines: [11, 11] }), ref({ id: "r3", lines: [40, 40] })];
  const cands: Candidate[] = [
    cand(10, { sources: ["m1", "m2"] }),
    cand(11, { stage: "severity", sources: ["m2"] }),
    cand(40, { stage: "refuted" }),
    cand(41, { stage: "cap" }),
  ];
  const outcomes = matchRun(refs, cands, (r) => nearby(cands, r, 1));
  eq("one comment near two references is credited to the first only", outcomes.map((o) => o.stage), ["inline", "severity", "cap"]);
  eq("...the second is filed under what else was near it", outcomes[1]?.sources, ["m2"]);
  eq("...and the furthest stage wins: cut by the cap outranks refuted", outcomes[2]?.stage, "cap");
  const lone = [cand(undefined, { stage: "anchor-failed" })];
  eq(
    "one unanchorable quote is one anchoring failure, not one per reference on its file",
    matchRun([ref({ id: "a" }), ref({ id: "b" })], lone, (r) => nearby(lone, r, 1)).map((o) => o.stage),
    ["anchor-failed", "not-found"],
  );
  eq(
    "every stage of a run is a candidate",
    candidatesOf({
      inline: [{ file: "a", start: 1, end: 1, sources: ["m"], claim: "x" }],
      belowBar: [{ file: "a", start: 2, end: 2, sources: ["m"], suppressedBy: "severity" }],
      degraded: [{ file: "a", sources: ["m"], anchorFailure: "quote-not-found" }],
      refuted: [{ file: "a", start: 3, end: 3, sources: ["m"] }],
    }).map((c) => c.stage),
    ["inline", "severity", "refuted", "anchor-failed"],
  );

  const series: CaseSeries[] = [
    { key: "a", refs: 4, hits: [2, 1], hitIds: [["a1", "a2"], ["a3"]], inline: [4, 4] },
    { key: "b", refs: 6, hits: [3, 3], hitIds: [["b1", "b2", "b3"], ["b1", "b2", "b3"]], inline: [5, 5] },
  ];
  const sum = summarize(series);
  eq("recall averages each case over its runs, then pools", sum.recall.toFixed(4), ((1.5 + 3) / 10).toFixed(4));
  eq("...per run", sum.perRun.map((r) => r.toFixed(2)), ["0.50", "0.40"]);
  eq("...and hit in any run", sum.anyRun.toFixed(2), "0.60");
  eq("precision is credited hits over inline comments", sum.precision.toFixed(4), (9 / 18).toFixed(4));
  // Case a scored 2 then 1 (sample variance 0.5), b did not move: 0.5 over 10 references per
  // reference, so one run's hits move by sqrt(0.05 * 10) and its recall by that over 10.
  eq("one run's sd comes from the spread between runs of the same commits", sum.sd?.toFixed(5), (Math.sqrt(0.5) / 10).toFixed(5));
  eq("...and without a repeat there is none", summarize([{ key: "a", refs: 4, hits: [2], hitIds: [["a1"]], inline: [3] }]).sd, undefined);

  const scoreOf = (hits: number[][], over: Partial<ScoreFile> = {}): ScoreFile => ({
    version: 1,
    suite: { name: "s", hash: "h" },
    primary: "line",
    k: 1,
    stamps: [],
    unscored: [],
    labels: {},
    cases: hits.map((runs, ci) => ({
      id: `c${ci}`,
      key: `c${ci}@x..y`,
      runs: runs.map((h, n) => ({
        run: n + 1,
        inline: 10,
        refuted: { total: 0, onReference: 0 },
        line: Array.from({ length: 10 }, (_, i) => ({ ref: `c${ci}r${i}`, stage: (i < h ? "inline" : "not-found") as Stage, sources: [] })),
      })),
    })),
    ...over,
  });
  const verdictOf = (r: ReturnType<typeof compareScores>) => ("refused" in r ? `refused: ${r.refused}` : r.verdict);
  const floor = scoreOf([[5, 4], [5, 6], [3, 3], [4, 5]]);
  eq("two single runs cannot be told from a re-run", verdictOf(compareScores(scoreOf([[5], [5]]), scoreOf([[4], [4]]))), "no noise estimate");
  eq("a change inside the measured noise is within it", verdictOf(compareScores(floor, scoreOf([[5], [5], [4], [4]]))), "within noise");
  const drop = compareScores(floor, scoreOf([[1], [1], [0], [1]]));
  eq("a drop past two sd of it is a regression", verdictOf(drop), "worse");
  check("...naming what the baseline found and the candidate did not", "lost" in drop && drop.lost.includes("c0r4"));
  eq("...and a rise past it an improvement", verdictOf(compareScores(floor, scoreOf([[9], [9], [9], [9]]))), "better");
  const partial = compareScores(floor, scoreOf([[5, 4], [5, 6]]));
  eq("only cases both sides scored are compared", "cases" in partial ? partial.cases : -1, 2);
  check("a different suite is refused", verdictOf(compareScores(floor, scoreOf([[1]], { suite: { name: "s", hash: "other" } }))).includes("different suites"));
  check("...and a different line tolerance", verdictOf(compareScores(floor, scoreOf([[1]], { k: 3 }))).includes("line tolerances"));
  const judgedBy = (model: string) => scoreOf([[1]], { primary: "judged", judge: { model, prompt: "p" } });
  check("...and judged scores under two judges", verdictOf(compareScores(judgedBy("a"), judgedBy("b"))).includes("judged differently"));
  check("...while one judge compares", !verdictOf(compareScores(judgedBy("a"), judgedBy("a"))).startsWith("refused"));
}
