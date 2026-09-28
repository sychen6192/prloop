// The finder stage: model output parsed fail-closed, the diff budget and what it leaves
// unread, each finder's order, stance and knobs, and the shape of the prompt itself.
import { arrayField, escapeControlCharsInStrings, parseJsonObject, salvageArrayItems } from "../../libs/json";
import { detectLanguage, fileKind, isNoiseFile, isReviewable } from "../../libs/lang";
import { buildDiffPayload, buildDiffPayloads } from "../../libs/payload";
import { loadRules, renderRules, ruleHeadings, selectRules } from "../../libs/rules";
import { fingerprint } from "../../gates/aggregate";
import type { AnchoredFinding, ChatRequest, FileDiff } from "../../libs/types";
import {
  BASE_SMELLS,
  checkFinding,
  citeIsKnown,
  knownCitesFor,
  normalizeCite,
  runFinders,
  validateFinding,
} from "../../gates/finder";
import {
  FINDER_SYSTEM,
  buildFinderPrompt,
  buildFinderPrompts,
  finderSystemFor,
  renderRecap,
} from "../../prompts/finder";
import { mergeChunkOutputs } from "../../gates/finder";
import { mulberry32, seedFor, shuffle } from "../../libs/prng";
import { coverageGaps } from "../../orchestrator";
import { rankForVerification } from "../../gates/skeptic";
import { FINDINGS_SCHEMA } from "../../models/schemas";
import {
  FINDER_CATEGORIES,
  PRLOOP_ROOT,
  parseFinderPromptSuffixes,
  parseFinderSeed,
  type Severity,
} from "../../config";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { run } from "../../libs/shell";
import { MIN_DIFF_TOKENS, diffTokenBudget, estimateTokens } from "../../libs/payload";
import { isTestPath } from "../../libs/lang";
import { MAX_DIFF_CHARS, parseContextTokensByModel } from "../../config";
import { buildHunks, diffLines, renderUnifiedDiff } from "../../libs/diff";
import { enclosingScope, hunkScope } from "../../libs/scope";
import { check, eq, section, skip } from "./harness";
import { mkFile } from "./fixtures";

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
  // Hand-written JSON (no guided decoding) with a real newline and tab inside a string —
  // the multi-line quote / suggested_fix case. The repair must yield exactly the characters
  // the model wrote, so anchoring still matches the source byte for byte.
  const r = parseJsonObject<{ quote: string; fix: string }>('{"quote":"if (x) {\n\treturn;","fix":"a\r\nb"}');
  check("raw newline/tab inside a string is repaired", r.ok, r.ok ? "" : r.error);
  check("...to the characters the model wrote", r.ok && r.value.quote === "if (x) {\n\treturn;" && r.value.fix === "a\r\nb");
}
{
  const r = parseJsonObject<{ a: string; b: string }>('{"a":"already\\nescaped","b":"quote \\" then\nnewline"}');
  check("escaped sequences are left alone, raw ones after an escape still repaired", r.ok && r.value.a === "already\nescaped" && r.value.b === 'quote " then\nnewline');
}
{
  const r = parseJsonObject<{ a: number }>('prose first\n{\n  "a": 1\n}\n');
  check("newlines outside strings untouched, balancing still works", r.ok && r.value.a === 1);
  check("valid JSON survives the repair unchanged", escapeControlCharsInStrings('{"a":"b\\n","c":[1,2]}') === '{"a":"b\\n","c":[1,2]}');
}
{
  // The first bracket in a reply is very often not the answer. Both of these failed a whole
  // stage on one real run: the requirement prompt numbers its criteria "[4711-AC1]", and a
  // skeptic quoted the regex "[a-zA-Z]" while explaining a refutation — each in a sentence
  // BEFORE the JSON, each extracted and parsed instead of it.
  const withId = parseJsonObject<{ criteria: unknown[] }>(
    'Looking at [4711-AC1], the diff implements it.\n{"criteria":[{"criterionId":"4711-AC1"}],"extras":[]}',
  );
  check("a bracketed id in a preamble does not shadow the object", withId.ok, withId.ok ? "" : withId.error);
  const withRegex = parseJsonObject<{ verdict: string }>(
    'The pattern [a-zA-Z]+ already guards it.\n{"verdict":"refuted","reason":"x"}',
  );
  check("a quoted regex in a preamble does not either", withRegex.ok && withRegex.value.verdict === "refuted");
  // A genuine top-level array still parses, and prose brackets before it do not win.
  const arr = parseJsonObject<number[]>("see [note] below\n[1,2,3]");
  check("a real top-level array is still found", arr.ok && Array.isArray(arr.value) && arr.value.length === 3);
  // Nothing parseable anywhere still fails, and reports a parse error rather than a silence.
  const none = parseJsonObject("[a] [b] [c] no json here");
  check("still fails when no candidate parses", !none.ok);
}

{
  const r = parseJsonObject("not JSON at all");
  check("non-JSON -> failure, not a throw", !r.ok);
}
{
  const r = parseJsonObject("");
  check("empty string -> failure", !r.ok);
}

section("finder: an answer without a findings array is an error, not a clean PR");
{
  eq("arrayField reads the named array", arrayField({ findings: [1] }, "findings"), [1]);
  eq("a top-level array is not the field", arrayField([1], "findings"), undefined);
  eq("a missing key is not an empty list", arrayField({ items: [] }, "findings"), undefined);
  eq("a non-array value is not a list", arrayField({ findings: "none" }, "findings"), undefined);

  // End to end through the finder stage with a fake runner: these shapes used to come back
  // as "0 findings" with no error — indistinguishable from a clean PR.
  const files = [mkFile("/src/a.ts", ["x();"], [1])];
  const pr = { title: "t", description: "", sourceBranch: "s", targetBranch: "t", createdBy: "a", status: "active" };
  const input = { pr, files, iterationId: 1, compareTo: 0 };
  const answering = (text: string) => ({ chat: async () => ({ text, model: "m" }) });
  eq("a top-level array is an error", (await runFinders(answering("[]"), input, ["m"])).outputs[0]?.error, "response has no findings array");
  eq("a list under another key is an error", (await runFinders(answering('{"items":[]}'), input, ["m"])).outputs[0]?.error, "response has no findings array");
  const clean = (await runFinders(answering('{"findings":[]}'), input, ["m"])).outputs[0];
  check("an explicit empty findings array is a clean result", clean?.error === undefined && clean?.findings.length === 0);
}

section("salvage: a response cut at the token limit still holds complete findings");
{
  const files = [mkFile("/src/a.ts", ["x();", "y();", "z();"], [1, 2, 3])];
  const pr = { title: "t", description: "", sourceBranch: "s", targetBranch: "t", createdBy: "a", status: "active" };
  const input = { pr, files, iterationId: 1, compareTo: 0 };

  // The scanner. Everything complete before the cut is returned; the fragment is not.
  const cut =
    '{"findings":[{"file":"/src/a.ts","claim":"one"},{"file":"/src/b.ts","claim":"two"},{"file":"/src/c.ts","claim":"thr';
  eq("two complete objects and one cut short → two", salvageArrayItems(cut, "findings").length, 2);
  eq("...in order, whole", JSON.stringify(salvageArrayItems(cut, "findings")[1]), '{"file":"/src/b.ts","claim":"two"}');

  // Braces and quotes inside VALUES must not be counted as structure — the reason this is a
  // scanner and not a regex.
  const tricky = '{"findings":[{"quote":"if (x) { y(); } // \\"}\\"","nested":{"a":[1,2]}},{"quote":"partial';
  eq("braces, quotes and escapes inside values are not structure", salvageArrayItems(tricky, "findings").length, 1);
  eq("...and the nested value survives whole", JSON.stringify((salvageArrayItems(tricky, "findings")[0] as { nested: unknown }).nested), '{"a":[1,2]}');

  eq("no such field → nothing", salvageArrayItems('{"items":[{"a":1}]}', "findings"), []);
  eq("not JSON at all → nothing", salvageArrayItems("the model apologised", "findings"), []);
  eq("an empty array → nothing", salvageArrayItems('{"findings":[]}', "findings"), []);
  eq("a complete response salvages everything in it", salvageArrayItems('{"findings":[{"a":1},{"b":2}]}', "findings").length, 2);
  // A raw newline inside a value (a model hand-writing JSON) is repaired first, as it is
  // for the ordinary parse.
  eq("raw control characters inside values are repaired", salvageArrayItems('{"findings":[{"claim":"line\nbreak"}]}', "findings").length, 1);

  // Through the finder stage: the recovery is partial, and the call is still a failure.
  const finding = (q: string) =>
    `{"file":"/src/a.ts","quote":"${q}","claim":"boom","severity":"high","category":"correctness","confidence":0.9}`;
  const truncatedText = `{"findings":[${finding("x();")},${finding("y();")},{"file":"/src/a.ts","quote":"z`;
  const truncated = {
    chat: async () => ({
      text: truncatedText,
      model: "m",
      error: "response truncated at the token limit (8192); raise PRR_LLM_MAX_TOKENS",
    }),
  };
  const salvaged = (await runFinders(truncated, input, ["m"])).outputs[0];
  eq("a truncated finder call still yields its complete findings", salvaged?.findings.length, 2);
  check("...but the call remains a failure, so the run stays incomplete", (salvaged?.error ?? "").includes("truncated"));
  eq("...and the partial text is kept for runs/", salvaged?.raw, truncatedText);

  // Only failures with usable text are salvaged: a transport error has none, and asking
  // would be inventing findings.
  const dead = { chat: async () => ({ text: "", model: "m", error: "timeout (900s)" }) };
  eq("a transport failure salvages nothing", (await runFinders(dead, input, ["m"])).outputs[0]?.findings.length, 0);
  eq("...and still records the empty text", (await runFinders(dead, input, ["m"])).outputs[0]?.raw, "");

  // Prose around a valid array: the ordinary parse recovers it, and the salvage path never
  // runs — a complete response must be unaffected by any of this.
  const wrapped = { chat: async () => ({ text: `Here you go:\n\`\`\`json\n{"findings":[${finding("x();")}]}\n\`\`\`` , model: "m" }) };
  const ok = (await runFinders(wrapped, input, ["m"])).outputs[0];
  check("a complete response parses normally, with no error", ok?.error === undefined && ok?.findings.length === 1);
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
// The languages a nine-entry list left out, C# first: a PR written in one of them had "no
// reviewable code changes", skipped the requirement axis too, and went green as reviewed.
for (const [file, lang] of [
  ["src/Billing/Invoice.cs", "csharp"], ["cmd/api/main.go", "go"], ["src/lib.rs", "rust"],
  ["web/index.php", "php"], ["engine/core.cpp", "cpp"], ["infra/main.tf", "hcl"],
  ["deploy/Dockerfile", "dockerfile"], ["Dockerfile.prod", "dockerfile"], ["CMakeLists.txt", "cmake"],
  ["Makefile", "makefile"], ["Jenkinsfile", "groovy"], ["Views/Home/Index.cshtml", "razor"],
] as const) {
  eq(`${file} is ${lang}`, detectLanguage(file), lang);
  check(`...and the code axis reviews it`, isReviewable(file));
}
// Non-code text a requirement is often delivered in: read by the requirement axis only.
for (const file of ["appsettings.json", "azure-pipelines.yml", "docs/retry.md", "App.config", "Service.csproj"]) {
  eq(`${file} is text, not code`, fileKind(file), "text");
}
eq("a name is matched before the extension", fileKind("CMakeLists.txt"), "code");
eq("an unlisted type is unknown, never guessed", fileKind("build.zig"), "unknown");
eq("...as is a file with no extension and no known name", fileKind("LICENSE"), "unknown");
check("noise stays out of review whatever its type", !isReviewable("dist/app.js"));

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

section("coverage: files the finder never saw make the review incomplete");
{
  // Both were logged and named in the summary while the run still exited 0.
  const skipped = [
    { path: "/big.ts", reason: "too large" },
    { path: "/logo.png", reason: "binary" },
    { path: "/package-lock.json", reason: "generated/lock/vendor" },
  ];
  const gaps = coverageGaps(["/a.ts", "/b.ts"], skipped, true);
  eq("omitted and oversized files are both reported", gaps.length, 2);
  check("finder-context omission names the count and the knob",
    gaps[0]!.startsWith("2 files omitted from the finder context") && gaps[0]!.includes("PRR_MAX_DIFF_CHARS"));
  eq("intake skips count only too-large files, never binaries or lockfiles", gaps[1], "1 files skipped by intake as too large");
  eq("nothing unread -> no gap", coverageGaps([], [{ path: "/logo.png", reason: "binary" }], true), []);
  eq("PRR_STRICT_COVERAGE=0 reports none", coverageGaps(["/a.ts"], skipped, false), []);
}

section("measurability: the fields that cost tokens, the order that spends the budget");
{
  // boundary_owner: required, undescribed, never mentioned in the prompt, read by nothing —
  // a coin flip under guided decoding, paid for on every finding.
  check("gone from the finder schema", !JSON.stringify(FINDINGS_SCHEMA).includes("boundary_owner"));
  const f = validateFinding({ category: "correctness", severity: "high", confidence: 0.9, file: "/a.ts", quote: "x()", claim: "c", side: "right", boundary_owner: "external" });
  check("...and the validator no longer carries it through", f !== undefined && !("boundary_owner" in f));
  check("...nor does the finder prompt mention it", !FINDER_SYSTEM.includes("boundary_owner"));

  // Fan-out ranking: severity, then confidence. The tiebreak used to be arrival order —
  // which model answered first — deciding which findings got verified at all.
  const mk = (severity: Severity, confidence: number, claim: string): AnchoredFinding => ({
    category: "correctness", severity, confidence, file: "src/a.ts", quote: "x();", claim,
    sources: ["m1"], fingerprint: claim,
    anchor: { side: "right", startLine: 1, endLine: 1, startOffset: 1, endOffset: 5 },
  });
  const ranked = rankForVerification([
    mk("high", 0.3, "high-weak"),
    mk("critical", 0.4, "crit-weak"),
    mk("high", 0.9, "high-strong"),
    mk("critical", 0.95, "crit-strong"),
    mk("low", 1, "low-certain"),
  ]);
  eq(
    "severity first, then the finder's own confidence",
    ranked.map((r) => r.claim),
    ["crit-strong", "crit-weak", "high-strong", "high-weak", "low-certain"],
  );
  eq("ranking never mutates the caller's array", rankForVerification([mk("low", 0.1, "a")]).length, 1);
}

section("finder validation: the gating fields are dropped on garbage, never promoted");
{
  const base = { severity: "high", confidence: 0.9, file: "/a.ts", quote: "x()", claim: "c", side: "right", category: "correctness" };
  // c. req-mismatch is the requirement axis's category (gates/requirement.ts builds those
  // findings directly, never through validateFinding); the finder cannot claim it.
  check("finder enum has eight categories", FINDER_CATEGORIES.length === 8 && !(FINDER_CATEGORIES as readonly string[]).includes("req-mismatch"));
  const schemaEnum = FINDINGS_SCHEMA.properties.findings.items.properties.category.enum as readonly string[];
  eq("schema enum is the finder enum", [...schemaEnum], [...FINDER_CATEGORIES]);
  eq("validateFinding rejects req-mismatch", validateFinding({ ...base, category: "req-mismatch" }), undefined);
  check("prompt says eight, not nine", FINDER_SYSTEM.includes("pick one of eight") && !/\bnine\b/.test(FINDER_SYSTEM));
  const tableRows = FINDER_SYSTEM.split("\n").filter((l) => /^\| [a-z][a-z-]* \|/.test(l) && !l.startsWith("| category")).length;
  eq("category table lists exactly the finder enum", tableRows, FINDER_CATEGORIES.length);
  for (const c of FINDER_CATEGORIES) check(`table names ${c}`, FINDER_SYSTEM.includes(`| ${c} |`));

  // d. An invalid severity used to become "medium" (the inline bar) and an invalid
  // category "correctness": garbage in exactly the fields that decide publication was the
  // most publishable finding in the batch. Dropped now, and the reason names the field.
  eq("invalid severity is dropped", validateFinding({ ...base, severity: "urgent" }), undefined);
  check("...and the rejection names the field", (checkFinding({ ...base, severity: "urgent" }).rejected ?? "").startsWith('severity "urgent"'));
  eq("missing severity is dropped", validateFinding({ ...base, severity: undefined }), undefined);
  eq("invalid category is dropped", validateFinding({ ...base, category: "style" }), undefined);
  check("...naming the field", (checkFinding({ ...base, category: "style" }).rejected ?? "").startsWith('category "style"'));
  eq("case is normalised, not rejected", validateFinding({ ...base, severity: "Medium", category: "Correctness" })?.severity, "medium");
  check("incomplete fields still name what is missing", (checkFinding({ ...base, quote: "  " }).rejected ?? "").includes("missing quote"));
  eq("a non-object is named as such", checkFinding("nope").rejected, "not an object");
  check("the quote/file/claim requirement is unchanged", validateFinding(base) !== undefined);

  // e. Maintainability never exceeds medium, cited or not: _base.md promised it and only
  // the prompt enforced it, so a cited smell at "critical" sailed through to inline.
  const smell = (severity: string, cites?: string) =>
    validateFinding({ ...base, category: "maintainability", severity, cites })?.severity;
  eq("cited critical smell → medium", smell("critical", "Feature Envy"), "medium");
  eq("cited high smell → medium", smell("high", "Feature Envy"), "medium");
  eq("cited medium smell stays medium", smell("medium", "Feature Envy"), "medium");
  eq("cited low smell stays low", smell("low", "Feature Envy"), "low");
  eq("uncited high smell → low", smell("high"), "low");
  eq("uncited medium smell → low", smell("medium"), "low");
  eq("behavioral critical is untouched", validateFinding({ ...base, severity: "critical" })?.severity, "critical");
}

section("finder citations: a cite must name a smell or a loaded rule heading");
{
  // f. `cites` accepted any non-empty string, so "SOLID" or "best practice" bought a
  // maintainability finding the medium severity that reaches an inline comment.
  const shipped = loadRules();
  const base = shipped.find((r) => r.name === "_base.md")!;
  const bullets = [...base.body.matchAll(/^- \*\*([^*]+)\*\* —/gm)].map((m) => m[1]!.trim());
  eq("BASE_SMELLS matches the 12 bullets in _base.md", [...BASE_SMELLS], bullets);

  const java = shipped.find((r) => r.name === "java.md")!;
  const heads = ruleHeadings(java.body);
  check("headings are extracted at every level", heads.includes("Java review rules") && heads.includes("Concurrency") && heads.includes("Self-invocation"));
  check("markdown emphasis is stripped from headings", heads.includes("Spring @Transactional"));
  eq("fenced '# lines' are not headings", ruleHeadings("# Real\n```py\n# not a heading\n```\n## Also real ##"), ["Real", "Also real"]);

  const known = knownCitesFor([base, java]);
  check("known cites carry the smells", known.has("feature envy") && known.has("mysterious name"));
  check("...and the selected rules' headings", known.has("self-invocation") && known.has("spring @transactional"));
  check("a smell name in any case is known", citeIsKnown("feature envy", known) && citeIsKnown("FEATURE ENVY (Refactoring ch. 3)", known));
  check("a rule heading with markdown noise is known", citeIsKnown("Spring `@Transactional` › Self-invocation", known));
  check("an unrelated citation is not", !citeIsKnown("SOLID", known) && !citeIsKnown("best practice", known) && !citeIsKnown("", known));
  check("a heading of a rule NOT selected for this PR is not known", !citeIsKnown("Server Action security (highest priority)", known));
  check("the repo's own convention headings count", citeIsKnown("no default exports", knownCitesFor([base], "## No default exports\n\nUse named exports.")));

  const raw = { severity: "high", confidence: 0.9, file: "/A.java", quote: "x()", claim: "c", side: "right", category: "maintainability" };
  const mk = (cites: string, k?: ReadonlySet<string>) => validateFinding({ ...raw, cites }, k);
  eq("a known heading cite keeps medium", mk("Self-invocation", known)?.severity, "medium");
  const unknown = mk("SOLID", known);
  eq("an unknown cite is treated as uncited: capped to low", unknown?.severity, "low");
  eq("...but stays on the finding for the artifacts", unknown?.cites, "SOLID");
  eq("with only the smells known, a rule heading is not enough", mk("Self-invocation", new Set(BASE_SMELLS.map(normalizeCite)))?.severity, "low");
  eq("the default known set is the smells", mk("Middle Man")?.severity, "medium");
}

section("seeded PRNG (libs/prng.ts)");
{
  const a = mulberry32(123);
  const b = mulberry32(123);
  eq("same seed, same sequence", [a(), a(), a()], [b(), b(), b()]);
  check("a neighbouring seed diverges", mulberry32(123)() !== mulberry32(124)());
  const vals = Array.from({ length: 1000 }, mulberry32(9));
  check("values stay in [0, 1)", vals.every((v) => v >= 0 && v < 1));
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const sh = shuffle(items, mulberry32(5));
  eq("shuffle is a permutation", [...sh].sort((x, y) => x - y), items);
  eq("...that does not mutate the input", items, [1, 2, 3, 4, 5, 6, 7, 8]);
  eq("...and is reproducible", shuffle(items, mulberry32(5)), sh);
  check("seedFor spreads finder indexes", new Set([0, 1, 2, 3].map((i) => seedFor(42, i))).size === 4);
  check("seedFor stays a 32-bit unsigned value", [0, 1, 2].every((i) => Number.isInteger(seedFor(2 ** 32 - 1, i)) && seedFor(2 ** 32 - 1, i) >= 0 && seedFor(2 ** 32 - 1, i) < 2 ** 32));
}

section("diff budget: a per-finder order is a permutation of one fixed selection");
{
  // PROPOSAL §5.2 promised each finder a randomised file order and it was never built:
  // every finder got the identical prompt, so consensus partly measured shared position
  // bias. The shuffle must never touch WHAT is selected — only the sequence.
  const files = ["a", "b", "c", "d", "e"].map((n) => mkFile(`/${n}.ts`, [`${n}1();`, `${n}2();`], [1, 2]));
  const paths = (p: { includedFiles: string[] }) => p.includedFiles;
  eq("no seed keeps the deterministic selection order", paths(buildDiffPayload(files, 100_000)), files.map((f) => f.path));
  const s1 = buildDiffPayload(files, 100_000, 1);
  const s1again = buildDiffPayload(files, 100_000, 1);
  eq("same seed, same order", paths(s1), paths(s1again));
  eq("...and the same text", s1.text, s1again.text);
  const s2 = buildDiffPayload(files, 100_000, 2);
  check("different seeds, different order", paths(s1).join() !== paths(s2).join());
  check("seeds really permute", new Set([1, 2, 3, 4, 5, 6].map((s) => paths(buildDiffPayload(files, 100_000, s)).join())).size > 1);
  eq("the set of files is identical", [...paths(s1)].sort(), [...paths(s2)].sort());
  const positions = paths(s1).map((p) => s1.text.indexOf(`### ${p} `));
  check("the text lists the files in the shuffled order", positions.every((pos, i) => pos >= 0 && (i === 0 || pos > positions[i - 1]!)));
  // Tight budget: the selection and the omitted list never depend on the seed.
  const tight = [1, 2, 3].map((s) => buildDiffPayload(files, 200, s));
  check("tight budget really omitted something", tight[0]!.omittedFiles.length > 0 && tight[0]!.includedFiles.length > 1);
  check("selection is seed-independent", tight.every((t) => [...t.includedFiles].sort().join() === [...tight[0]!.includedFiles].sort().join()));
  check("omitted list is seed-independent", tight.every((t) => t.omittedFiles.join() === tight[0]!.omittedFiles.join()));
  eq("...and identical to the unseeded selection", buildDiffPayload(files, 200).omittedFiles, tight[0]!.omittedFiles);
}

section("finder knobs: PRR_FINDER_PROMPT_SUFFIX_BY_MODEL and PRR_FINDER_SEED");
{
  const throws = (fn: () => unknown) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  eq("unset suffix map is undefined", parseFinderPromptSuffixes(undefined), undefined);
  eq("blank suffix map is undefined", parseFinderPromptSuffixes("  "), undefined);
  eq("a model → text map parses", parseFinderPromptSuffixes('{"qwen":"Name the condition."}'), { qwen: "Name the condition." });
  check("malformed JSON is fatal", throws(() => parseFinderPromptSuffixes("{oops")));
  check("an array is fatal", throws(() => parseFinderPromptSuffixes('["x"]')));
  check("a non-string value is fatal", throws(() => parseFinderPromptSuffixes('{"qwen":{"text":"x"}}')));
  eq("the suffix is appended for its model only", finderSystemFor("qwen", { qwen: "Stance." }), `${FINDER_SYSTEM}\n\nStance.`);
  eq("other models get the base prompt", finderSystemFor("claude", { qwen: "Stance." }), FINDER_SYSTEM);
  eq("a blank suffix is no suffix", finderSystemFor("qwen", { qwen: "  " }), FINDER_SYSTEM);
  eq("no map, base prompt", finderSystemFor("qwen", undefined), FINDER_SYSTEM);

  eq("unset seed is undefined (random per run)", parseFinderSeed(undefined), undefined);
  eq("seed parses", parseFinderSeed("42"), 42);
  check("a non-integer seed is fatal", throws(() => parseFinderSeed("4.2")) && throws(() => parseFinderSeed("x")) && throws(() => parseFinderSeed("-1")));

  // Through the environment, in a fresh process: config reads both at import time.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-finder-env-"));
  const probe = path.join(dir, "probe.ts");
  const cfg = pathToFileURL(path.join(PRLOOP_ROOT, "config.ts")).href;
  fs.writeFileSync(
    probe,
    `import { FINDER_SEED, FINDER_PROMPT_SUFFIX_BY_MODEL } from ${JSON.stringify(cfg)};\n` +
      `console.log(JSON.stringify({ seed: FINDER_SEED, suffixes: FINDER_PROMPT_SUFFIX_BY_MODEL }));\n`,
  );
  const tsxCli = path.join(PRLOOP_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const res = spawnSync(process.execPath, [tsxCli, probe], {
    encoding: "utf8",
    env: { ...process.env, PRR_FINDER_SEED: "4711", PRR_FINDER_PROMPT_SUFFIX_BY_MODEL: '{"m":"Stance."}', PRR_QUIET: "1" },
  });
  const out = parseJsonObject<{ seed?: number; suffixes?: Record<string, string> }>(res.stdout ?? "");
  check("probe process ran", out.ok, (res.error ? String(res.error) : (res.stderr ?? "")).slice(0, 400));
  if (out.ok) {
    eq("PRR_FINDER_SEED is honoured", out.value.seed, 4711);
    eq("PRR_FINDER_PROMPT_SUFFIX_BY_MODEL is honoured", out.value.suffixes, { m: "Stance." });
  }
  const bad = spawnSync(process.execPath, [tsxCli, probe], {
    encoding: "utf8",
    env: { ...process.env, PRR_FINDER_SEED: "soon", PRR_QUIET: "1" },
  });
  check("a bad PRR_FINDER_SEED is a startup fatal naming the variable", bad.status === 1 && (bad.stderr ?? "").includes("PRR_FINDER_SEED"));
  fs.rmSync(dir, { recursive: true, force: true });
}

section("finder coverage: what NO finder saw, not what finder 0 missed");
{
  // The diff is budgeted per finder — buildDiffPayload weighs it against that model's
  // context window (PRR_CONTEXT_TOKENS_BY_MODEL) and that model's system prompt — so a
  // mixed fleet does not see the same files. runFinders used to report finder 0's omission
  // list as the run's, which made the coverage gate depend on which model happened to be
  // listed first: PRR_FINDER_MODELS=small,big called four files unreviewed that `big` read
  // in full, and PRR_FINDER_MODELS=big,small called the run complete.
  //
  // Config is read at import time, so this runs in a fresh process per the pattern above.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-coverage-"));
  const probe = path.join(dir, "probe.mts");
  const finderMod = pathToFileURL(path.join(PRLOOP_ROOT, "gates", "finder.ts")).href;
  const tsxCli = path.join(PRLOOP_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  fs.writeFileSync(
    probe,
    `import { runFinders } from ${JSON.stringify(finderMod)};\n` +
      `const body = (n) => Array.from({ length: 120 }, (_, i) => \`+  const \${n}\${i} = compute(\${i});\`).join("\\n");\n` +
      `const mk = (n) => ({ path: \`src/\${n}.ts\`, changeType: "edit",\n` +
      `  hunks: [{ rightStart: 1, rightCount: 120, leftStart: 1, leftCount: 0, body: body(n) }],\n` +
      `  rightLines: [], leftLines: [], changedRightLines: new Set([1]),\n` +
      `  binary: false, truncated: false, language: "typescript" });\n` +
      `const files = ["a","b","c","d","e","f"].map(mk);\n` +
      `const pr = { title: "t", description: "", sourceBranch: "s", targetBranch: "t", createdBy: "a", status: "active" };\n` +
      `const runner = { chat: async (r) => ({ model: r.model, text: '{"findings":[]}' }) };\n` +
      `const out = await runFinders(runner, { pr, files, iterationId: 1, compareTo: 0 }, process.env.ORDER.split(","));\n` +
      `console.log(JSON.stringify({ aggregate: out.omitted,\n` +
      `  perFinder: out.outputs.map((o) => ({ model: o.model, omitted: o.omitted, bound: o.bound })) }));\n`,
  );
  // "big" is cut off by the char ceiling and loses one file; "small" is cut off by its
  // context window and loses four. Only src/f.ts is missed by both.
  const runProbe = (order: string) => {
    const r = spawnSync(process.execPath, [tsxCli, probe], {
      encoding: "utf8",
      env: {
        ...process.env,
        ORDER: order,
        PRR_QUIET: "1",
        PRR_MAX_DIFF_CHARS: "20000",
        PRR_CONTEXT_TOKENS_BY_MODEL: '{"big":1000000,"small":1}',
      },
    });
    return parseJsonObject<{
      aggregate: string[];
      perFinder: Array<{ model: string; omitted: string[]; bound?: string }>;
    }>((r.stdout ?? "").trim().split("\n").pop() ?? "");
  };

  const fwd = runProbe("big,small");
  const rev = runProbe("small,big");
  check("coverage probe ran", fwd.ok && rev.ok);
  if (fwd.ok && rev.ok) {
    eq("only the file no finder saw counts as a coverage gap", fwd.value.aggregate, ["src/f.ts"]);
    eq("...and the answer does not depend on which finder is listed first", rev.value.aggregate, fwd.value.aggregate);

    const big = fwd.value.perFinder.find((o) => o.model === "big");
    const small = fwd.value.perFinder.find((o) => o.model === "small");
    eq("the char-bound finder carries its own omission list", big?.omitted, ["src/f.ts"]);
    eq("...naming the ceiling that cut it off", big?.bound, "chars");
    eq("the small-window finder lost more", small?.omitted, ["src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"]);
    eq("...and names the other ceiling", small?.bound, "tokens");
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

section("finder stage: per-model stance, seeded file order, drop accounting");
{
  const files = ["a", "b", "c", "d", "e"].map((n) => mkFile(`/src/${n}.ts`, [`${n}();`], [1]));
  const pr = { title: "t", description: "", sourceBranch: "s", targetBranch: "t", createdBy: "a", status: "active" };
  const input = { pr, files, iterationId: 1, compareTo: 0 };
  const seen: ChatRequest[] = [];
  // "Async correctness" is a heading of typescript.md, which the .ts paths select.
  const finding = { category: "maintainability", severity: "high", confidence: 0.9, file: "/src/a.ts", quote: "a();", claim: "c", side: "right", cites: "Async correctness" };
  const runner = {
    chat: async (req: ChatRequest) => {
      seen.push(req);
      return { text: JSON.stringify({ findings: [finding, { ...finding, category: "style" }, { ...finding, severity: "urgent" }] }), model: req.model };
    },
  };
  const run1 = await runFinders(runner, input, ["alpha", "beta"], { seed: 7, promptSuffixes: { beta: "Name the failing condition." } });
  eq("the run seed is reported", run1.seed, 7);
  eq("each finder carries its own seed", run1.outputs.map((o) => o.seed), [seedFor(7, 0), seedFor(7, 1)]);
  // 12b. The stance lands on the named model only.
  eq("alpha gets the plain system prompt", seen[0]!.system, FINDER_SYSTEM);
  check("beta gets the base prompt plus its suffix", seen[1]!.system.startsWith(FINDER_SYSTEM) && seen[1]!.system.endsWith("Name the failing condition."));
  // 12c. Same files, different order; finder 0's prompt is the shared one.
  const order = (text: string) => [...text.matchAll(/^### (\/src\/\w+\.ts) /gm)].map((m) => m[1]);
  const o0 = order(run1.outputs[0]!.prompt!);
  const o1 = order(run1.outputs[1]!.prompt!);
  const all = files.map((f) => f.path).sort();
  eq("both finders see all five files", [[...o0].sort(), [...o1].sort()], [all, all]);
  check("...in different orders", o0.join() !== o1.join());
  eq("finder 0's prompt is the shared prompt", run1.prompt, run1.outputs[0]!.prompt);
  eq("both prompts carry the recap", run1.outputs.map((o) => o.prompt!.includes("## Recap")), [true, true]);
  const run2 = await runFinders(runner, input, ["alpha", "beta"], { seed: 7 });
  eq("the same seed replays the same prompts", run2.outputs.map((o) => o.prompt), run1.outputs.map((o) => o.prompt));
  const run3 = await runFinders(runner, input, ["alpha"], { seed: 8 });
  check("a different run seed gives a different order", order(run3.outputs[0]!.prompt!).join() !== o0.join());
  // 11d/11f through the stage: the style category and the urgent severity are dropped and
  // counted; the cite of a heading from a rule selected for this PR keeps medium.
  const out = run1.outputs[0]!;
  eq("garbage findings are counted as rejected", out.rejected, 2);
  eq("the valid one survives", out.findings.length, 1);
  eq("...at medium, citing a heading of a rule selected for this PR", out.findings[0]!.severity, "medium");
  eq("no error: a partial drop is not a failed call", out.error, undefined);
}

section("finder prompt: coverage stance, recap after the diff, worked examples");
{
  // 12a. The closing line used to call an empty array "entirely acceptable and a common
  // outcome" — permission to self-censor, in bold, as the last thing the model read.
  check("empty-array permission is gone", !/entirely acceptable|common outcome/i.test(FINDER_SYSTEM));
  check("empty is correct only after every hunk was examined", /empty findings array is correct only after every hunk/i.test(FINDER_SYSTEM));
  check("the verification stage removes weak findings, not the finder", /verification stage removes them; the finder does not/i.test(FINDER_SYSTEM));
  // 11a/11b. Duplicated logic is a smell (≤ medium), not a high-tier defect; naming is scoped.
  const chain = FINDER_SYSTEM.slice(FINDER_SYSTEM.indexOf("## severity"), FINDER_SYSTEM.indexOf("## Important rules"));
  check("duplicated logic is out of the high tier", chain.length > 0 && !/duplicated logic/i.test(chain));
  check("maintainability is capped at medium in the chain", /Maintainability findings never exceed medium/.test(chain));
  check(
    "naming conventions never; a misdescriptive name is a cited Mysterious Name",
    /naming CONVENTIONS[\s\S]{0,120}never findings[\s\S]{0,60}misdescribes[\s\S]{0,160}"Mysterious Name"/.test(FINDER_SYSTEM),
  );
  // 13b. One worked finding, one anti-example.
  check("worked example present", FINDER_SYSTEM.includes("## Worked example") && /suggested_fix: ".*throw new RefundFailed/.test(FINDER_SYSTEM) && FINDER_SYSTEM.includes("cites: null"));
  check("anti-example present", FINDER_SYSTEM.includes("## Not a finding") && FINDER_SYSTEM.includes("calcTotal"));

  // 13a. The recap sits after the diff and before the output instruction, and carries the
  // eight categories, the chain, and the headings of the rules selected for this PR.
  const files = [mkFile("/src/A.java", ["x();"], [1])];
  const pr = { title: "t", description: "", sourceBranch: "s", targetBranch: "t", createdBy: "a", status: "active" };
  const selected = selectRules(loadRules(), ["/src/A.java"]);
  const { text } = buildFinderPrompt({
    pr,
    files,
    iterationId: 1,
    compareTo: 0,
    rules: renderRules(selected),
    ruleHeadings: selected.map((r) => ({ name: r.name, headings: ruleHeadings(r.body) })),
  });
  const diffAt = text.indexOf("## The change (unified diff)");
  const recapAt = text.indexOf("## Recap");
  const outAt = text.indexOf("## Your output");
  check("recap follows the diff and precedes the output instruction", diffAt >= 0 && recapAt > diffAt && outAt > recapAt);
  check("the quoted code sits above the recap", text.indexOf("x();") > diffAt && text.indexOf("x();") < recapAt);
  const recap = text.slice(recapAt, outAt);
  for (const c of FINDER_CATEGORIES) check(`recap names ${c}`, recap.includes(c));
  check("recap has the severity chain, one line per step", ["→ critical", "→ high", "→ medium", "→ low"].every((s) => recap.split("\n").some((l) => l.includes(s))));
  check("recap lists the selected rule headings", recap.includes("- java.md: ") && recap.includes("Self-invocation") && recap.includes("- _base.md: "));
  check("recap does not list rules that were not selected", !recap.includes("python.md"));
  check("recap without rules says so", renderRecap([]).includes("No project rules were loaded"));
}

section("payload budget: tokens, not just characters");
{
  const near = (name: string, actual: number, want: number, tol = 0.2) =>
    check(`${name} (want ~${Math.round(want)}, got ${actual})`, Math.abs(actual - want) <= want * tol);

  // 1. estimateTokens. Two regimes because they differ by nearly 3x, and PRR_MAX_DIFF_CHARS
  //    could not tell them apart: 240k characters is ~69k tokens of TypeScript and ~240k
  //    tokens of Japanese.
  const ascii = "const refundTotal = order.items.reduce((a, b) => a + b.price, 0);\n".repeat(40);
  const cjk = "支払処理に失敗しました".repeat(40); // ja: "payment processing failed"
  near("ASCII source is about 3.5 characters per token", estimateTokens(ascii), ascii.length / 3.5);
  near("CJK is about one token per character", estimateTokens(cjk), cjk.length);
  near("mixed text is counted per character class", estimateTokens(ascii + cjk), ascii.length / 3.5 + cjk.length);
  check(
    "the same character count costs far more in CJK than in ASCII",
    estimateTokens(cjk) > 2.5 * estimateTokens("a".repeat(cjk.length)),
    `${estimateTokens(cjk)} vs ${estimateTokens("a".repeat(cjk.length))}`,
  );
  check("the estimate includes per-message framing", estimateTokens("") > 0);

  // 2. The budget arithmetic: the diff gets what the output budget and the fixed parts of
  //    the prompt leave. The fixed parts are what PRR_MAX_DIFF_CHARS never counted.
  const fixed = "a".repeat(35_000); // system prompt + rules + conventions + schema, roughly
  eq("no context given at all means no token budget", diffTokenBudget(undefined), 0);
  eq("a zero window means no token budget (the knob is off)", diffTokenBudget({ fixed, contextTokens: 0 }), 0);
  eq(
    "the diff gets the window minus the output budget minus the fixed parts",
    diffTokenBudget({ contextTokens: 128_000, outputTokens: 16_384, fixed }),
    128_000 - 16_384 - estimateTokens(fixed),
  );
  eq(
    "a window the fixed parts already fill floors instead of going negative",
    diffTokenBudget({ contextTokens: 8_000, outputTokens: 8_192, fixed }),
    MIN_DIFF_TOKENS,
  );

  // 3. Ordering: by added lines, tests last, whatever the language census says. The bug this
  //    replaces: prevalence ordering dropped a 3000-line Java file first because three
  //    20-line TypeScript files made TypeScript the majority language.
  const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `  ${tag}${i}(compute(${i}));`);
  const all = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  const svc = mkFile("/src/main/java/shop/InventoryService.java", lines(60, "svc"), all(60));
  const tests = mkFile("/src/test/java/shop/InventoryServiceTest.java", lines(90, "t"), all(90));
  const small = ["a", "b", "c"].map((n) => mkFile(`/app/${n}.ts`, lines(5, n), all(5)));
  const spread = [...small, tests, svc];
  check("a test path is recognised across the layouts we support",
    isTestPath("/src/test/java/shop/InventoryServiceTest.java") &&
      isTestPath("/app/checkout/page.test.tsx") &&
      isTestPath("/tests/test_refund.py") &&
      !isTestPath("/src/main/java/shop/InventoryService.java") &&
      !isTestPath("/app/latest/page.tsx"));
  eq(
    "biggest change first, tests last, whatever the language census says",
    buildDiffPayload(spread, 1_000_000).includedFiles,
    [
      "/src/main/java/shop/InventoryService.java",
      "/app/a.ts",
      "/app/b.ts",
      "/app/c.ts",
      "/src/test/java/shop/InventoryServiceTest.java",
    ],
  );
  const justSvc = buildDiffPayload([svc], 1_000_000).text.length;
  const tight = buildDiffPayload(spread, justSvc + 100);
  check("a tight budget keeps the biggest change", tight.includedFiles.includes(svc.path));
  check("...and sheds the test file", tight.omittedFiles.includes(tests.path));
  eq("...naming the ceiling that bound", tight.bound, "chars");
  check("the omitted files are still named in the payload the model reads", tight.text.includes(tests.path));

  // 4. Both ceilings, and which one bound. The token budget floors at MIN_DIFF_TOKENS, so
  //    these files are sized to run into it.
  const wide = ["a", "b", "c", "d", "e"].map((n) =>
    mkFile(`/src/${n}.ts`, Array.from({ length: 40 }, (_, i) => `  const ${n}${i} = compute(${i}, "${n}");`), all(40)),
  );
  const byTokens = buildDiffPayload(wide, 1_000_000, undefined, { contextTokens: 1, outputTokens: 0 });
  check("a token budget omits files a huge char ceiling would have kept", byTokens.omittedFiles.length > 0);
  eq("...and says the tokens bound", byTokens.bound, "tokens");
  const byChars = buildDiffPayload(wide, 3_000, undefined, { contextTokens: 200_000, outputTokens: 0 });
  eq("the char ceiling still binds when it is the smaller of the two", byChars.bound, "chars");
  check(
    "...and the smaller ceiling really is the one that decided",
    byChars.includedFiles.length < byTokens.includedFiles.length,
  );

  // 5. The seed contract is unchanged under a token budget: same selection, different order.
  const seeded = [1, 2, 3].map((s) => buildDiffPayload(wide, 1_000_000, s, { contextTokens: 1, outputTokens: 0 }));
  check(
    "a token-bound selection is identical across seeds",
    seeded.every((p) => [...p.includedFiles].sort().join() === [...seeded[0]!.includedFiles].sort().join()),
  );
  check(
    "...and identical to the unseeded one",
    [...seeded[0]!.includedFiles].sort().join() === [...byTokens.includedFiles].sort().join(),
  );
  check("...while the order still differs", new Set(seeded.map((p) => p.includedFiles.join())).size > 1);

  // 6. Unset knob = exactly today's behaviour. PRR_CONTEXT_TOKENS is 0 in this process, so a
  //    caller passing fixed parts and an output budget must still get the char-only payload.
  const charOnly = buildDiffPayload(wide, 3_000);
  const withFixed = buildDiffPayload(wide, 3_000, undefined, { fixed: "x".repeat(100_000), outputTokens: 8_192 });
  eq("no window configured: byte-for-byte the char-only payload", withFixed.text, charOnly.text);
  eq("...the same selection", withFixed.includedFiles, charOnly.includedFiles);
  eq("...and the same omissions", withFixed.omittedFiles, charOnly.omittedFiles);

  // 7. The knob itself.
  const throwsWith = (fn: () => unknown) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  eq("unset context map is undefined", parseContextTokensByModel(undefined), undefined);
  eq("blank context map is undefined", parseContextTokensByModel("  "), undefined);
  eq("a model -> tokens map parses", parseContextTokensByModel('{"qwen3-coder":131072}'), { "qwen3-coder": 131072 });
  check("malformed JSON is fatal", throwsWith(() => parseContextTokensByModel("{oops")));
  check("an array is fatal", throwsWith(() => parseContextTokensByModel("[131072]")));
  check("a non-numeric window is fatal", throwsWith(() => parseContextTokensByModel('{"m":"128k"}')));
  check("a negative window is fatal", throwsWith(() => parseContextTokensByModel('{"m":-1}')));
}

section("over-budget diffs: read the rest instead of reporting it unread");
{
  // A diff that does not fit is not a smaller diff. Everything past the budget was dropped
  // from every finder's context and reported as a coverage gap, so on a large PR the tool
  // exited 3 and told you the part most likely to hold the defect had not been read.
  const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `  ${tag}${i}(compute(${i}));`);
  const all = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  const four = ["a", "b", "c", "d"].map((n, i) => mkFile(`/src/${n}.ts`, lines(40 - i * 5, n), all(40 - i * 5)));
  const oneFits = buildDiffPayload([four[0]!], 1_000_000).text.length;

  // The promise the default knob value makes: one chunk is the old function, byte for byte.
  const legacy = buildDiffPayload(four, oneFits + 50);
  const asChunks = buildDiffPayloads(four, oneFits + 50, undefined, undefined, 1);
  eq("one chunk is exactly what the single-payload builder returns", asChunks.length, 1);
  eq("...with the same text", asChunks[0]!.text, legacy.text);
  eq("...the same selection", asChunks[0]!.includedFiles, legacy.includedFiles);
  eq("...and the same omissions", asChunks[0]!.omittedFiles, legacy.omittedFiles);

  const two = buildDiffPayloads(four, oneFits + 50, undefined, undefined, 2);
  const many = buildDiffPayloads(four, oneFits + 50, undefined, undefined, 10);
  eq("a second request picks up where the first stopped", two.length, 2);
  eq("...reading the file the budget had dropped", two[1]!.includedFiles, [legacy.omittedFiles[0]]);
  check("enough requests read the whole diff", many.map((c) => c.includedFiles).flat().length === four.length, JSON.stringify(many.map((c) => c.includedFiles)));
  eq("...and then nothing is omitted", many[0]!.omittedFiles, []);

  // Chunks partition: a file read twice is a finding reported twice, and a file read by
  // nobody is the gap this whole thing exists to close.
  const seen = many.flatMap((c) => c.includedFiles);
  eq("no file lands in two chunks", seen.length, new Set(seen).size);
  eq("...and every changed file lands in one", [...seen].sort(), four.map((f) => f.path).sort());

  // "Omitted" must keep meaning "nobody read it" and must never come to mean "the next
  // request has it" — the coverage gate (PRR_STRICT_COVERAGE) is decided off this list.
  eq("every chunk reports the same omissions", two.map((c) => c.omittedFiles.join()), [two[0]!.omittedFiles.join(), two[0]!.omittedFiles.join()]);
  eq("...which are the files no chunk carried", two[0]!.omittedFiles, four.slice(2).map((f) => f.path));
  check("...and the model is told about them", two[1]!.text.includes("omitted for size"), two[1]!.text.slice(-200));

  // The seed contract, extended. It permutes order WITHIN a chunk and must never decide
  // which chunk a file is in: two finders that agreed have to have agreed about the same
  // file, and a chunk boundary that moved per finder would make that unknowable.
  const seeds = [1, 2, 3, 4].map((sd) => buildDiffPayloads(four, oneFits + 50, sd, undefined, 3));
  check(
    "the split never depends on the seed",
    seeds.every((c) => c.map((x) => [...x.includedFiles].sort().join()).join("|") === seeds[0]!.map((x) => [...x.includedFiles].sort().join()).join("|")),
    JSON.stringify(seeds.map((c) => c.map((x) => x.includedFiles))),
  );

  // The prompt has to say which part it is holding. Without it the finder reads a partial
  // diff as the whole PR: the system prompt asks it to examine every hunk before returning
  // an empty array, and rule 5 tells it to report only issues about this change.
  const pr = { title: "t", description: "", sourceBranch: "f", targetBranch: "m", createdBy: "A", status: "active" };
  const promptInput = { pr, files: four, iterationId: 1, compareTo: 0 };
  const single = buildFinderPrompts(promptInput, 1);
  eq("one request says nothing about parts", single.chunks[0]!.includes("part 1"), false);
  eq("...and is what the single-prompt builder returns", single.chunks[0], buildFinderPrompt(promptInput).text);

  // Big enough to actually cross PRR_MAX_DIFF_CHARS, since the prompt builder budgets
  // against config rather than an argument — the split has to be provoked the way a real PR
  // provokes it. Built as a literal rather than through mkFile: diffing 40k generated lines
  // is minutes of work for a net CLAUDE.md says runs before every commit.
  const huge = (name: string, chars: number): FileDiff => {
    const n = Math.ceil(chars / 22);
    const rightLines = Array.from({ length: n }, (_, i) => `  ${name}${i}(compute(${i}));`);
    return {
      path: `/src/${name}.ts`,
      changeType: "edit",
      hunks: [{ rightStart: 1, rightCount: n, leftStart: 1, leftCount: 0, body: rightLines.map((l) => `+${l}`).join("\n") }],
      rightLines,
      leftLines: [],
      changedRightLines: new Set(Array.from({ length: n }, (_, i) => i + 1)),
      changedLeftLines: new Set(),
      binary: false,
      truncated: false,
      language: "typescript",
    };
  };
  const overBudget = ["p", "q", "r"].map((n) => huge(n, MAX_DIFF_CHARS));
  const oneShot = buildFinderPrompts({ pr, files: overBudget, iterationId: 1, compareTo: 0 }, 1);
  eq("an over-budget diff reads one file and calls the rest a coverage gap", oneShot.omitted.length, 2);
  const split = buildFinderPrompts({ pr, files: overBudget, iterationId: 1, compareTo: 0 }, 3);
  eq("...until it is allowed a request per part", split.chunks.length, 3);
  eq("...and then nothing is a gap", split.omitted, []);
  check("a split request says which part it is", split.chunks[1]!.includes("you are reviewing part 2"), split.chunks[1]!.slice(0, 600));
  check("...and that the other parts hold different files", split.chunks[1]!.includes("do not report anything about a file you cannot see here"));
  check("...before the diff, not after it", split.chunks[1]!.indexOf("reviewing part 2") < split.chunks[1]!.indexOf("## The change"));
  // After the rules, though: everything ahead of the notice is then the same in every part,
  // which is what a server's prefix cache can reuse.
  const ruled = buildFinderPrompts({ pr, files: overBudget, iterationId: 1, compareTo: 0, rules: "## Money\n\nAmounts are integer cents." }, 3);
  const shared = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return i;
  };
  check(
    "the parts share their whole start, rules included",
    shared(ruled.chunks[0]!, ruled.chunks[1]!) > ruled.chunks[0]!.indexOf("Amounts are integer cents."),
    ruled.chunks[1]!.slice(0, 900),
  );
  check("...and each part actually carries a different file", split.chunks[0]!.includes("/src/p.ts") && !split.chunks[0]!.includes("### /src/q.ts"), "");
}

section("chunked finder output: three requests are still one opinion");
{
  // Every count downstream reads an output as a MODEL — `sources` is [out.model], the
  // consensus warning counts distinct models, and the orchestrator compares its failure
  // count against outputs.length. Three chunks reported as three outputs would have claimed
  // three finders where one was configured.
  const part = (over: Partial<import("../../gates/finder").FinderOutput> = {}) => ({
    model: "qwen3-coder",
    findings: [],
    rejected: 0,
    raw: "{}",
    seed: 7,
    prompt: "p",
    ...over,
  });
  const raw = (claim: string) => ({
    category: "correctness" as const,
    severity: "high" as const,
    confidence: 0.8,
    file: "/src/a.ts",
    quote: "x",
    side: "right" as const,
    claim,
  });

  eq("one part is passed through untouched", mergeChunkOutputs([part()]), part());
  const merged = mergeChunkOutputs([
    part({ findings: [raw("one")], rejected: 1 }),
    part({ findings: [raw("two")], rejected: 2 }),
  ]);
  eq("findings from every part are kept", merged.findings.map((f) => f.claim), ["one", "two"]);
  eq("...as one model", merged.model, "qwen3-coder");
  eq("...with the drops summed", merged.rejected, 3);
  eq("...and the request count recorded", merged.chunks, 2);
  check("the saved prompt keeps its parts in order and labelled", (merged.prompt ?? "").includes("part 1/2") && (merged.prompt ?? "").includes("part 2/2"), merged.prompt);

  // A chunk that failed is a part of the diff nobody read, so the whole opinion is an error
  // — that is what holds the --since auto resume point over the push it did not cover.
  const partial = mergeChunkOutputs([part(), part({ error: "read ECONNRESET" }), part()]);
  check("a failed part makes the finder an error", (partial.error ?? "").includes("part 2/3: read ECONNRESET"), partial.error);
  eq("...and a run where every part answered is not", mergeChunkOutputs([part(), part()]).error, undefined);
}

section("what a finder sees around a change: the declaration it sits in, and a short file whole");
{
  // Six lines above a change and three below arrived without the method's name, its
  // parameters or its class. The header now names the enclosing declaration, as git does.
  const at = (src: string, marker: string, language: string) => {
    const lines = src.split("\n");
    return enclosingScope(lines, lines.findIndex((l) => l.includes(marker)) + 1, language)?.text;
  };
  const java = [
    "public class Invoices {",
    "    private final Repo repo;",
    "",
    "    public void first() {",
    "        a();",
    "    }",
    "",
    "    @Transactional",
    "    public BigDecimal total(List<Line> lines,",
    "            Currency currency) {",
    "        BigDecimal sum = BigDecimal.ZERO;",
    "        for (Line line : lines) {",
    "            if (line.active()) {",
    "// debug output, flush left",
    "                sum = sum.add(line.price());",
    "            }",
    "        }",
    "        return sum;",
    "    }",
    "}",
  ].join("\n");
  eq("a change deep in a method names the method, not the if or the for", at(java, "sum.add", "java"), "public BigDecimal total(List<Line> lines,");
  eq("...and not the sibling method above it", at(java, "return sum", "java"), "public BigDecimal total(List<Line> lines,");
  eq("a change on a method's own signature names its class", at(java, "public void first()", "java"), "public class Invoices {");
  eq("a field names its class", at(java, "private final Repo", "java"), "public class Invoices {");

  const csharp = ["namespace Billing", "{", "    public class Invoice", "    {", "        public decimal Total()", "        {", "            return Lines.Sum(l => l.Price);", "        }", "    }", "}"].join("\n");
  eq("Allman braces: the lone { is skipped, the signature above it is the scope", at(csharp, "Lines.Sum", "csharp"), "public decimal Total()");

  const python = ["class Cart:", "    def total(self):", "        if self.items:", "            return sum(i.price for i in self.items)", "        return 0", "", "TAX = 0.2"].join("\n");
  eq("Python: the def, through the if", at(python, "return sum", "python"), "def total(self):");
  eq("...and module-level code after a function has no scope, not the function above it", at(python, "TAX = 0.2", "python"), undefined);

  const go = ["func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {", "\tif r == nil {", "\t\treturn", "\t}", "\ts.count++", "}"].join("\n");
  eq("Go, indented with tabs", at(go, "s.count++", "go"), "func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {");

  const ts = [
    "export const handler = async (event: Event) => {",
    "  const result = compute(",
    "    event.body,",
    "  );",
    "  this.client.send(",
    "    result,",
    "  );",
    "};",
    "describe(\"parser\", () => {",
    "  it(\"reads a line\", () => {",
    "    expect(parse(\"x\")).toBe(1);",
    "  });",
    "});",
  ].join("\n");
  eq("an assigned arrow function is a declaration", at(ts, "event.body", "typescript"), "export const handler = async (event: Event) => {");
  eq("...a member call spanning lines is not", at(ts, "    result,", "typescript"), "export const handler = async (event: Event) => {");
  eq("a callback block names the test it is in", at(ts, "expect(parse", "typescript"), "it(\"reads a line\", () => {");
  eq("C++: an out-of-class definition", at(["void Parser::reset() const {", "    pos_ = 0;", "}"].join("\n"), "pos_ = 0", "cpp"), "void Parser::reset() const {");
  eq("a synchronized block is a statement, a synchronized method a declaration",
    [at(["class A {", "    synchronized void run() {", "        synchronized (lock) {", "            go();", "        }", "    }", "}"].join("\n"), "go();", "java")],
    ["synchronized void run() {"]);
  eq("...and a void method with no modifier in front", at(["class A {", "    void run() {", "        go();", "    }", "}"].join("\n"), "go();", "java"), "void run() {");
  eq("a language with no rules names nothing", at(python, "return sum", "cobol"), undefined);
  const long = `    public static Map<String, List<Map<String, Integer>>> aggregateEverythingByRegion(${"String a, ".repeat(8)}String z) {`;
  check("a long signature is cut, and says so", (at(["class A {", long, "        x();", "    }", "}"].join("\n"), "x();", "java") ?? "").endsWith("…"));

  // The header, and only when the declaration is out of sight.
  const edit = (path: string, left: string[], right: string[], language = "java"): FileDiff => {
    const { hunks, changedRightLines, changedLeftLines } = buildHunks(left, right, diffLines(left, right));
    return { path, changeType: "edit", hunks, rightLines: right, leftLines: left, changedRightLines, changedLeftLines, binary: false, truncated: false, language };
  };
  const bodyLines = (n: number) => Array.from({ length: n }, (_, i) => `        int v${i} = ${i};`);
  const leftJava = ["public class Big {", "    public void run() {", ...bodyLines(30), "    }", "}"];
  const rightJava = [...leftJava];
  rightJava[25] = "        int v23 = 23 * 2;";
  const far = edit("src/Big.java", leftJava, rightJava);
  eq("a hunk far into a method names the method in its header", hunkScope(far, far.hunks[0]!), "public void run() {");
  check("...after the closing @@, as git writes it", renderUnifiedDiff(far.path, far.hunks, undefined, (h) => hunkScope(far, h)).includes("@@ public void run() {"));
  const nearTop = [...leftJava];
  nearTop[3] = "        int v1 = 1 * 2;";
  const near = edit("src/Big.java", leftJava, nearTop);
  eq("...and a hunk that shows the declaration itself needs no name", hunkScope(near, near.hunks[0]!), undefined);
  const deleted = leftJava.filter((_, i) => i !== 25);
  const del = edit("src/Big.java", leftJava, deleted);
  eq("a pure deletion is placed by the side it deleted from", hunkScope(del, del.hunks[0]!), "public void run() {");

  // Whole files: only with room left after selection, never at another file's expense.
  const shortFile = edit("src/Short.java", ["class S {", ...bodyLines(20), "    void a() {}", "}"], ["class S {", ...bodyLines(20), "    void a() { b(); }", "}"]);
  const roomy = buildDiffPayloads([shortFile], 100_000, undefined, undefined, 1, 300)[0]!;
  check("a short file with room to spare is shown whole", roomy.text.includes("### src/Short.java [edit, java, whole file]") && roomy.text.includes("int v0 = 0;"), roomy.text.slice(0, 300));
  eq("...and listed as such", roomy.wholeFiles, ["src/Short.java"]);
  eq("...as one hunk from the first line", roomy.text.match(/@@ -1,\d+ \+1,\d+ @@/g)?.length, 1);
  const capped = buildDiffPayloads([shortFile], 100_000, undefined, undefined, 1, 10)[0]!;
  eq("a file over the line limit keeps its hunks", capped.wholeFiles, []);
  eq("the requirement axis's payload never takes whole files", buildDiffPayload([shortFile], 100_000).wholeFiles, []);
  const added: FileDiff = { ...edit("src/New.java", [], ["class N {", "}"]), changeType: "add" };
  eq("an added file is not called whole: its hunks already are", buildDiffPayloads([added], 100_000, undefined, undefined, 1, 300)[0]!.wholeFiles, []);
  // Budget room for both files' hunks and no more: showing the first whole first would have
  // pushed the second out of the request.
  const other = edit("src/Other.java", ["class O {", ...bodyLines(20), "    int x;", "}"], ["class O {", ...bodyLines(20), "    int x = 1;", "}"]);
  const hunksOnly = buildDiffPayloads([shortFile, other], 100_000, undefined, undefined, 1, 0)[0]!;
  const tight = buildDiffPayloads([shortFile, other], hunksOnly.text.length + 20, undefined, undefined, 1, 300)[0]!;
  eq("with no room to spare, both files still go, as hunks", [tight.includedFiles.slice().sort(), tight.wholeFiles], [["src/Other.java", "src/Short.java"], []]);
}
