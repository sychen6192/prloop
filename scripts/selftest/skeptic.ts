// Verification: three answers, votes in which only the right answer counts, rounds, model
// families, and the deliberate asymmetries — the skeptic only lowers, and fails open.
import { FileIndex } from "../../libs/fileindex";
import { finalize, fingerprint } from "../../gates/aggregate";
import { attachLogSink, detachLogSink } from "../../libs/log";
import {
  applyVerdicts,
  modelFamily,
  parseVerdict as parseVerdictForTest,
  runSkeptic,
  skepticRoster,
  votedSeverity,
  type SkepticOutcome,
  type Verdict,
} from "../../gates/skeptic";
import { renderFindingComment } from "../../publish/format";
import type { AnchoredFinding, ChatRequest } from "../../libs/types";
import { load } from "../../libs/tls";
import {
  FINDINGS_SCHEMA,
  REQ_DISPUTE_SCHEMA,
  REQUIREMENT_SCHEMA,
  TRIAGE_SCHEMA,
  VERDICT_SCHEMA,
} from "../../models/schemas";
import { type Severity } from "../../config";
import * as path from "node:path";
import { run } from "../../libs/shell";
import { declares, namesIn, relatedContext } from "../../gates/lookup";
import * as fs from "node:fs";
import * as os from "node:os";
import { check, eq, section, skip } from "./harness";
import { mkFile, EMPTY_CANDIDATES } from "./fixtures";

// --- adversarial verification ---
section("skeptic verdict parsing (fail-open)");
{
  const v = parseVerdictForTest(
    '{"verdict":"refuted","reason":"this is try-with-resources, it closes automatically","confidence":0.9,"evidence_quote":"try (var in = open()) {"}',
    "test-model",
    "try (var in = open()) {\n  in.read();\n}",
  );
  check("explicit refutation", v.verdict === "refuted" && v.confidence === 0.9);
}
{
  const v = parseVerdictForTest('{"verdict":"holds","reason":"","confidence":0.7}', "test-model");
  check("not refuted", v.verdict === "holds");
}
{
  // A broken verifier must not be able to delete findings.
  const v = parseVerdictForTest("model broke, this is not JSON", "test-model");
  check("unparseable -> fail-open (not refuted)", v.verdict !== "refuted");
  check("unparseable records the error", v.error !== undefined);
}
{
  const v = parseVerdictForTest('{"verdict":"holds","reason":"impact overstated","confidence":0.8,"suggested_severity":"low"}', "test-model");
  eq("accepts severity downgrade suggestion", v.suggestedSeverity, "low");
}
{
  const v = parseVerdictForTest('{"verdict":"holds","reason":"x","confidence":0.5,"suggested_severity":"catastrophic"}', "test-model");
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
    ["req_dispute", REQ_DISPUTE_SCHEMA],
    ["triage", TRIAGE_SCHEMA],
  ] as const) {
    const missing = walk(schema, name);
    check(`${name} schema is strict-mode compliant`, missing.length === 0, missing.join(", "));
  }

  // Backends enforce different JSON Schema subsets, and a value constraint they don't
  // support is a hard HTTP 400 that takes a whole finder down (seen live: Bedrock's
  // structured output rejecting minimum/maximum on a number). None of these were ever
  // load-bearing — ranges are clamped and lists capped in code — so the schemas describe
  // shape only. This walker keeps it that way.
  const CONSTRAINTS = new Set([
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "format",
  ]);
  const constraints = (node: unknown, path: string): string[] => {
    if (typeof node !== "object" || node === null) return [];
    const out: string[] = [];
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (CONSTRAINTS.has(k)) out.push(`${path}.${k}`);
      out.push(...constraints(v, `${path}.${k}`));
    }
    return out;
  };
  for (const [name, schema] of [
    ["findings", FINDINGS_SCHEMA],
    ["requirement", REQUIREMENT_SCHEMA],
    ["verdict", VERDICT_SCHEMA],
    ["req_dispute", REQ_DISPUTE_SCHEMA],
    ["triage", TRIAGE_SCHEMA],
  ] as const) {
    const found = constraints(schema, name);
    check(`${name} schema carries no value constraints (backend dialects differ)`, found.length === 0, found.join(", "));
  }
}

section("skeptic verdict semantics");
{
  const empty = parseVerdictForTest("{}", "m");
  check("a verdict with no verdict field is an error, not an answer", empty.error !== undefined);
  const good = parseVerdictForTest('{"verdict": "holds", "reason": "holds", "confidence": 0.8, "suggested_severity": null}', "m");
  check("null suggested_severity parses", good.error === undefined && good.suggestedSeverity === undefined);
}

section("skeptic severity vote: a downgrade takes the median, not one dissenting voice");
{
  const vote = (s?: Severity, error?: string): Verdict =>
    ({ verdict: "holds", reason: "", confidence: 0.8, model: "s", suggestedSeverity: s, ...(error ? { error } : {}) });
  const outcome = (severity: Severity, verdicts: Verdict[]): SkepticOutcome => ({
    finding: {
      category: "correctness", severity, confidence: 0.8, file: "/a.ts", quote: "x();", claim: "c",
      sources: ["m1"], fingerprint: "f",
      anchor: { side: "right", startLine: 1, endLine: 1, startOffset: 1, endOffset: 5 },
    },
    verdicts,
    killed: false,
  });
  const after = (severity: Severity, verdicts: Verdict[]) => applyVerdicts([outcome(severity, verdicts)])[0]?.severity;

  // Killing a finding takes a majority; lowering it used to take one voice.
  eq("3 rounds, one low: the finder's rating stands", after("high", [vote("low"), vote(), vote()]), "high");
  eq("3 rounds, two low: the median lowers it", after("high", [vote("low"), vote("low"), vote()]), "low");
  eq("3 rounds, low/medium/none: the median is medium", after("high", [vote("low"), vote("medium"), vote()]), "medium");
  eq("1 round low: a single verifier is the whole vote", after("high", [vote("low")]), "low");
  eq("a suggestion above the current severity never raises it", after("medium", [vote("critical")]), "medium");
  eq("2 rounds split: a tie never downgrades", after("high", [vote("low"), vote()]), "high");
  eq("errored verdicts do not vote", after("high", [vote("low"), vote("low", "timeout (180s)"), vote()]), "high");
  eq("no votes keeps the rating", votedSeverity("high", []), "high");
}

// --- Phase 3G: verification quality ---------------------------------------------------
// The audit that motivated all of this: "not refuted" was counted as a clearing, so a
// verifier that could not see the code the claim was about published single-source
// findings as verified; "refuted only with evidence" was prompt text with nothing
// enforcing it; and three rounds over two models manufactured a majority out of one
// opinion.

section("skeptic verdict: three answers, and a refutation must carry evidence");
{
  const snippet = "public void close() {\n  stream.close();\n}";
  const v = (json: string, snip?: string) => parseVerdictForTest(json, "skeptic-a", snip);

  eq(
    "insufficient-context is a first-class answer",
    v('{"verdict":"insufficient-context","reason":"the caller is not shown","confidence":0.4}').verdict,
    "insufficient-context",
  );
  eq("holds parses", v('{"verdict":"holds","reason":"checked it","confidence":0.6}').verdict, "holds");
  eq(
    "refuted with evidence from the snippet stands",
    v('{"verdict":"refuted","reason":"it is closed","confidence":0.9,"evidence_quote":"stream.close();"}', snippet).verdict,
    "refuted",
  );

  // A backend that ignores the enum still speaks the old shape; mapping it beats reading
  // a whole run's verification as garbage.
  eq(
    "a stale backend's refuted:true still refutes",
    v('{"refuted":true,"reason":"r","evidence_quote":"stream.close();"}', snippet).verdict,
    "refuted",
  );
  eq("a stale backend's refuted:false maps to holds", v('{"refuted":false,"reason":"r"}', snippet).verdict, "holds");

  const bare = v('{"verdict":"refuted","reason":"it closes automatically","confidence":0.9,"evidence_quote":null}', snippet);
  eq("a refutation with no evidence_quote is downgraded", bare.verdict, "insufficient-context");
  check("...and the downgrade says why", (bare.downgraded ?? "").includes("evidence_quote"));

  const invented = v(
    '{"verdict":"refuted","reason":"r","confidence":0.9,"evidence_quote":"try (var s = open()) { }"}',
    snippet,
  );
  eq("evidence that is not in the snippet shown is downgraded", invented.verdict, "insufficient-context");
  eq("...it neither kills nor clears", invented.verdict === "refuted" || invented.verdict === "holds", false);

  const respaced = v(
    '{"verdict":"refuted","reason":"r","confidence":0.9,"evidence_quote":"stream.close();"}',
    "public void close() {\n\t\tstream.close();\n}",
  );
  eq("evidence is matched with the anchoring tiers' whitespace tolerance", respaced.verdict, "refuted");
  eq("...and the quote is kept for the audit trail", respaced.evidenceQuote, "stream.close();");

  eq(
    "a quote copied with the snippet's own gutter still matches",
    v('{"verdict":"refuted","reason":"r","confidence":0.9,"evidence_quote":">+   12 | stream.close();"}', snippet).verdict,
    "refuted",
  );

  // The requirement axis shows its skeptic the whole diff and asks for the quote in prose,
  // so it declares no snippet and nothing is enforced against one.
  eq("with no snippet declared, the answer is taken as given", v('{"verdict":"refuted","reason":"r"}').verdict, "refuted");
}

section("skeptic votes: only refuted kills, only holds clears, a tie does neither");
{
  const file = mkFile("/src/a.ts", ["export function read(x: Buf) {", "  return x.data.length;", "}"], [2]);
  const finding = (): AnchoredFinding => ({
    category: "correctness",
    severity: "high",
    confidence: 0.8,
    file: "/src/a.ts",
    quote: "  return x.data.length;",
    claim: "x.data may be undefined here",
    sources: ["finder-a"],
    fingerprint: "f1",
    anchor: { side: "right", startLine: 2, endLine: 2, startOffset: 1, endOffset: 24 },
  });
  const REFUTE = '{"verdict":"refuted","reason":"guarded upstream","confidence":0.9,"evidence_quote":"return x.data.length;"}';
  const HOLDS = '{"verdict":"holds","reason":"checked, it stands","confidence":0.8}';
  const UNKNOWN = '{"verdict":"insufficient-context","reason":"the callers are in another file","confidence":0.5}';
  const scripted = (byModel: Record<string, string>) => ({
    chat: async (req: ChatRequest) => ({ model: req.model, text: byModel[req.model] ?? "" }),
  });
  const verify = async (byModel: Record<string, string>, findings = [finding()]) =>
    runSkeptic(scripted(byModel), findings, new FileIndex([file]), {
      models: Object.keys(byModel),
      rounds: Object.keys(byModel).length,
      finders: ["finder-a"],
    });

  const killedOut = await verify({ alpha: REFUTE, beta: REFUTE, gamma: HOLDS });
  eq("3 rounds, 2 evidenced refutations: killed", killedOut[0]?.killed, true);
  eq("...and a killed finding never reaches the survivors", applyVerdicts(killedOut).length, 0);

  const clearedOut = await verify({ alpha: HOLDS, beta: HOLDS, gamma: REFUTE });
  eq("2 holds against 1 refutation: survives", clearedOut[0]?.killed, false);
  const cleared = applyVerdicts(clearedOut)[0]!;
  eq("...counted as 2 clearings", cleared.skepticVerdicts, 2);
  eq("...and 1 dissent", cleared.skepticRefuted, 1);
  eq("...and it publishes on that clearing alone", finalize(EMPTY_CANDIDATES, [cleared]).inline.length, 1);

  const tiedOut = await verify({ alpha: HOLDS, beta: REFUTE });
  eq("an even split does not kill", tiedOut[0]?.killed, false);
  const tied = applyVerdicts(tiedOut)[0]!;
  // The bug this closes: the same split both survived the kill vote and satisfied the
  // corroboration gate, so a finding one verifier called wrong was published as verified.
  eq("...and clears nothing", finalize(EMPTY_CANDIDATES, [tied]).inline.length, 0);

  const unknownOut = await verify({ alpha: UNKNOWN, beta: UNKNOWN, gamma: UNKNOWN });
  eq("verifiers that could not check it do not kill", unknownOut[0]?.killed, false);
  const unchecked = applyVerdicts(unknownOut)[0]!;
  eq("...they clear nothing", unchecked.skepticVerdicts, 0);
  eq("...they refute nothing", unchecked.skepticRefuted, 0);
  eq("...and they are counted as unchecked", unchecked.skepticUnchecked, 3);
  eq(
    "a single-source finding nobody could check stays out of inline comments",
    finalize(EMPTY_CANDIDATES, [unchecked]).inline.length,
    0,
  );

  // An unevidenced refutation must not kill: end to end, not just in the parser.
  const unevidenced = await verify({
    alpha: '{"verdict":"refuted","reason":"trust me","confidence":0.9,"evidence_quote":null}',
    beta: '{"verdict":"refuted","reason":"trust me too","confidence":0.9,"evidence_quote":"lines the model never saw"}',
  });
  eq("two refutations with no usable evidence do not kill", unevidenced[0]?.killed, false);
  eq("...they are recorded as unchecked", applyVerdicts(unevidenced)[0]?.skepticUnchecked, 2);

  // The skeptic sees the hunk as well as the window, so a claim about the change itself is
  // answerable instead of automatically "insufficient-context".
  const prompts: string[] = [];
  await runSkeptic(
    { chat: async (req: ChatRequest) => (prompts.push(req.user), { model: req.model, text: HOLDS }) },
    [finding()],
    new FileIndex([file]),
    { models: ["alpha"], rounds: 1, finders: ["finder-a"] },
  );
  check("the skeptic is shown the hunk, both sides", (prompts[0] ?? "").includes("both sides of this hunk"));
  check("...alongside the ±context window", (prompts[0] ?? "").includes("export function read(x: Buf) {"));
}

section("skeptic rounds: a model may not vote twice");
{
  const { roster, capped } = skepticRoster(["a", "b"], 3);
  eq("3 rounds over 2 models is capped to 2 verifiers", roster, ["a", "b"]);
  eq("...and the shortfall is reported", capped, 1);
  eq("duplicates in the config collapse", skepticRoster(["a", "a", "b"], 3).roster, ["a", "b"]);
  eq("fewer rounds than models takes a prefix", skepticRoster(["a", "b", "c"], 2).roster, ["a", "b"]);
  eq("rounds within the roster are not capped", skepticRoster(["a", "b"], 2).capped, 0);

  const file = mkFile("/src/b.ts", ["const a = 1;", "const b = a + 1;", "export { b };"], [2]);
  const f = (fp: string): AnchoredFinding => ({
    category: "correctness", severity: "high", confidence: 0.8, file: "/src/b.ts",
    quote: "const b = a + 1;", claim: "off by one", sources: ["finder-a"], fingerprint: fp,
    anchor: { side: "right", startLine: 2, endLine: 2, startOffset: 1, endOffset: 16 },
  });
  const lines: string[] = [];
  attachLogSink((l) => lines.push(l));
  const out = await runSkeptic(
    { chat: async (req: ChatRequest) => ({ model: req.model, text: '{"verdict":"holds","reason":"","confidence":0.7}' }) },
    [f("f1"), f("f2")],
    new FileIndex([file]),
    { models: ["alpha", "beta"], rounds: 3, finders: ["finder-a"] },
  );
  detachLogSink();
  eq("a capped run issues one call per distinct model", out[0]?.verdicts.length, 2);
  eq("...and no model votes twice", [...new Set(out[0]!.verdicts.map((v) => v.model))].length, 2);
  eq(
    "the cap is logged once per run, not once per finding",
    lines.filter((l) => l.includes("skeptic rounds capped")).length,
    1,
  );
}

section("model families: same-family verification is weak verification");
{
  const same = (a: string, b: string) => modelFamily(a) !== "" && modelFamily(a) === modelFamily(b);
  check("qwen3-coder and qwen2.5-instruct are the same family", same("qwen3-coder:30b", "qwen2.5-coder-32b"));
  check("claude and qwen are not", !same("claude-sonnet-4-5", "qwen3-coder"));
  check("gateway prefixes do not hide the family", same("bedrock/anthropic.claude-3-5-sonnet", "claude-opus-4"));
  check("devstral is a mistral", same("devstral-small", "mistral-large"));
  check("codellama is a llama", same("codellama:13b", "llama-3.3-70b"));
  // The one that must never fire: two names we do not recognise are not evidence of
  // anything, and a false "same family" warning trains people to ignore the real one.
  eq("an unknown name has no family", modelFamily("acme-reviewer-v2"), "");
  check("two unknown names are not called the same family", !same("acme-reviewer-v2", "internal-model-7"));
  check("gpt is matched last, so gpt-4o is gpt", same("openai/gpt-4o-mini", "gpt-4.1"));

  const file = mkFile("/src/c.ts", ["let n = 0;", "n += step;", "export { n };"], [2]);
  const finding: AnchoredFinding = {
    category: "correctness", severity: "high", confidence: 0.8, file: "/src/c.ts",
    quote: "n += step;", claim: "step may be NaN", sources: ["qwen3-coder"], fingerprint: "f1",
    anchor: { side: "right", startLine: 2, endLine: 2, startOffset: 1, endOffset: 10 },
  };
  const lines: string[] = [];
  attachLogSink((l) => lines.push(l));
  const out = await runSkeptic(
    { chat: async (req: ChatRequest) => ({ model: req.model, text: '{"verdict":"holds","reason":"","confidence":0.7}' }) },
    [finding],
    new FileIndex([file]),
    { models: ["qwen2.5-coder"], rounds: 1, finders: ["qwen3-coder"] },
  );
  detachLogSink();
  check(
    "a same-family fleet is warned about at runtime, naming both models",
    lines.some((l) => l.includes("[WARN]") && l.includes("qwen2.5-coder") && l.includes("qwen3-coder")),
  );
  eq("the verdict is marked same-family", out[0]?.verdicts[0]?.sameFamily, true);
  const survivor = applyVerdicts(out)[0]!;
  // Fail open: on a single-family deployment refusing these clearings would delete every
  // single-source finding. The clearing counts; the comment discloses what it was worth.
  eq("...the clearing still counts", survivor.skepticVerdicts, 1);
  eq("...and the finding still publishes", finalize(EMPTY_CANDIDATES, [survivor]).inline.length, 1);
  check("...but the comment says the check was weaker", renderFindingComment(survivor).includes("same model family"));
}

section("a second reading: what a skeptic could not check, looked up by code and asked once more");
{
  eq(
    "names on the accused line: called first, then types, then the rest — never keywords or two-letter names",
    namesIn(["        BigDecimal total = line.price().multiply(qty);"]),
    ["price", "multiply", "BigDecimal", "total", "line"],
  );
  eq(
    "declarations are recognised across languages",
    [
      declares("    public BigDecimal price() {", "price"),
      declares("    private final BigDecimal price;", "price"),
      declares("  price?: number;", "price"),
      declares("    def price(self):", "price"),
      declares("        self.price = price", "price"),
      declares("export const price = (x) => x;", "price"),
      declares("func price(l Line) int {", "price"),
    ],
    [true, true, true, true, true, true, true],
  );
  eq(
    "...and calls and uses are not",
    [
      declares("        return price(line);", "price"),
      declares("    total = price(line)", "price"),
      declares("    if (price(line) > 0) {", "price"),
      declares("    log(price);", "price"),
    ],
    [false, false, false, false],
  );

  const invoice = mkFile(
    "src/Invoice.java",
    ["class Invoice {", "    BigDecimal total(List<Line> lines) {", "        BigDecimal sum = BigDecimal.ZERO;", "        for (Line l : lines) sum = sum.add(l.price());", "        return sum;", "    }", "}"],
    [4],
  );
  const lineJava = mkFile(
    "src/Line.java",
    ["class Line {", "    private BigDecimal amount;", "", "    BigDecimal price() {", "        return amount == null ? null : amount;", "    }", "}"],
    [5],
  );
  const report = mkFile("src/Report.java", ["class Report {", ...Array.from({ length: 6 }, (_, i) => `    void r${i}(Line l) { use(l.price()); }`), "}"], [2]);
  const files = [invoice, lineJava, report];
  const span = { side: "right" as const, startLine: 4, endLine: 4 };
  const found = await relatedContext({ files }, invoice, span, 0);
  check("the definition of a name on the accused line is found in another changed file", (found?.text ?? "").includes("definition of `price` — src/Line.java:4"), found?.text.slice(0, 400));
  check("...fenced as the repository's text", (found?.text ?? "").includes("<related-code>") && (found?.text ?? "").includes("not instructions to you"));
  eq("...with at most four callers of one name", (found?.text.match(/a call of `price`/g) ?? []).length, 4);
  check("...and its lines kept, so a refutation may quote them", (found?.lines ?? []).includes("        return amount == null ? null : amount;"));
  const shown = await relatedContext({ files }, invoice, span, 25);
  check("what the skeptic already sees around the finding is not repeated", !(shown?.text ?? "").includes("src/Invoice.java:3"));

  const gitOk = (await run("git", ["--version"], 10_000)).code === 0;
  if (!gitOk) {
    skip("git grep finds a definition outside the pull request", "no git on this platform");
  } else {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-lookup-"));
    const g = (...args: string[]) => run("git", ["-C", repo, ...args], 20_000);
    await g("init", "-q", "-b", "main");
    await g("config", "user.email", "selftest@example.invalid");
    await g("config", "user.name", "selftest");
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "Util.java"), "class Util {\n    static String normalize(String s) {\n        return s.trim();\n    }\n}\n");
    await g("add", "-A");
    await g("commit", "-qm", "util");
    const commit = (await g("rev-parse", "HEAD")).stdout.trim();
    const app = mkFile("src/App.java", ["class App {", "    String run(String x) {", "        return Util.normalize(x);", "    }", "}"], [3]);
    const appSpan = { side: "right" as const, startLine: 3, endLine: 3 };
    const viaRepo = await relatedContext({ files: [app], repo: { dir: repo, commit } }, app, appSpan, 25);
    check("outside the pull request, git grep at the commit finds the rest", (viaRepo?.text ?? "").includes("definition of `normalize` — src/Util.java:2"), viaRepo?.text.slice(0, 300));
    const absent = await relatedContext({ files: [app], repo: { dir: repo, commit: "0".repeat(40) } }, app, appSpan, 25);
    eq("...and a commit the repository does not have finds nothing, and throws nothing", absent, undefined);
    fs.rmSync(repo, { recursive: true, force: true });
  }

  const finding: AnchoredFinding = {
    category: "correctness",
    severity: "high",
    confidence: 0.8,
    file: "src/Invoice.java",
    quote: "        for (Line l : lines) sum = sum.add(l.price());",
    claim: "price() can return null, and add(null) throws",
    sources: ["finder-a"],
    fingerprint: "fp-lookup",
    anchor: { side: "right", startLine: 4, endLine: 4, startOffset: 1, endOffset: 50 },
  };
  const calls: Array<{ model: string; user: string }> = [];
  const scripted = (answers: Record<string, string[]>) => ({
    chat: async (req: ChatRequest) => {
      calls.push({ model: req.model, user: req.user });
      const next = answers[req.model]?.shift() ?? "ERROR";
      return next === "ERROR" ? { model: req.model, text: "", error: "timeout (180000ms)" } : { model: req.model, text: next };
    },
  });
  const verdict = (v: string, reason: string, quote: string | null = null) =>
    JSON.stringify({ verdict: v, reason, evidence_quote: quote, confidence: 0.8, suggested_severity: null });
  const unsure = verdict("insufficient-context", "I would need to see price()");
  const holds = verdict("holds", "price() returns null when amount is unset");
  const opts = (models: string[], enabled = true, lookupFiles = files) => ({
    models,
    rounds: models.length,
    finders: ["finder-a"],
    lookup: { files: lookupFiles },
    lookupEnabled: enabled,
  });
  const index = new FileIndex(files);
  const lines: string[] = [];
  attachLogSink((l) => lines.push(l));

  let out = await runSkeptic(scripted({ alpha: [unsure, holds], beta: [holds] }), [finding], index, opts(["alpha", "beta"]));
  eq("only the verifier that could not check is asked again", calls.map((c) => c.model), ["alpha", "beta", "alpha"]);
  check("...shown the definition it said it lacked", (calls[2]?.user ?? "").includes("definition of `price` — src/Line.java:4"));
  eq("...and its second answer replaces the first", out[0]?.verdicts.map((v) => v.verdict), ["holds", "holds"]);
  eq("...marked as a second reading, keeping what the first one lacked", out[0]?.verdicts[0]?.secondLook?.first, "I would need to see price()");
  check("the second prompt is kept for the audit trail", (out[0]?.lookupPrompt ?? "").includes("<related-code>"));
  check("...and the run log says how many were read again", lines.some((l) => l.includes("read again with looked-up code")), lines.join("\n").slice(-400));

  calls.length = 0;
  out = await runSkeptic(
    scripted({ alpha: [unsure, verdict("refuted", "the null is handled before add", "        return amount == null ? null : amount;")] }),
    [finding],
    index,
    opts(["alpha"]),
  );
  eq("a refutation may quote the looked-up code: it was shown", [out[0]?.verdicts[0]?.verdict, out[0]?.verdicts[0]?.downgraded], ["refuted", undefined]);

  calls.length = 0;
  out = await runSkeptic(scripted({ alpha: [unsure, "ERROR"] }), [finding], index, opts(["alpha"]));
  eq("a second call that fails keeps the first answer (fails open)", [out[0]?.verdicts[0]?.verdict, out[0]?.verdicts[0]?.secondLook], ["insufficient-context", undefined]);

  const bare = mkFile("src/Bare.java", ["class Bare {", "    int x() { return 1 + 2; }", "}"], [2]);
  const lone: AnchoredFinding = {
    ...finding,
    file: "src/Bare.java",
    quote: "    int x() { return 1 + 2; }",
    fingerprint: "fp-bare",
    anchor: { side: "right", startLine: 2, endLine: 2, startOffset: 1, endOffset: 10 },
  };
  calls.length = 0;
  await runSkeptic(scripted({ alpha: [unsure, holds] }), [lone], new FileIndex([bare]), opts(["alpha"], true, [bare]));
  eq("a lookup that finds nothing asks nothing more", calls.length, 1);
  calls.length = 0;
  await runSkeptic(scripted({ alpha: [unsure, holds] }), [finding], index, opts(["alpha"], false));
  eq("...and PRR_SKEPTIC_LOOKUP=0 never asks again", calls.length, 1);
  detachLogSink();
}
