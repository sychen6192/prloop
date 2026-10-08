// The requirement axis: criteria the pipeline owns, evidence that has to anchor, scope,
// the prompt, and the batched dispute pass.
import { FileIndex } from "../../libs/fileindex";
import { htmlToText } from "../../libs/html";
import { renderConventions } from "../../libs/rules";
import { log } from "../../libs/log";
import { renderSummary } from "../../publish/format";
import { buildRequirementPrompt } from "../../prompts/requirement";
import { validateFinding } from "../../gates/finder";
import {
  applyReqSkepticVerdicts,
  resolveDisputeVerdicts,
  demoteUnseenMissing,
  resolveJudgments,
  runRequirementGate,
  toRequirementFindings,
  unmetCriteria,
  verifySatisfiedEvidence,
  type RequirementGateInput,
} from "../../gates/requirement";
import { exitCodeFor } from "../../orchestrator";
import { REQUIREMENT_SYSTEM } from "../../prompts/requirement";
import { buildReqDisputePrompt } from "../../prompts/skeptic";
import { extractCriteria, splitCriteria } from "../../libs/criteria";
import type { AggregateResult } from "../../gates/aggregate";
import type {
  ChatRequest,
  CriterionCheck,
  ModelRunner,
  ReqVerdict,
  RequirementResult,
  WorkItem,
} from "../../libs/types";
import * as path from "node:path";
import { run } from "../../libs/shell";
import { capture, check, eq, section } from "./harness";
import { mkFile, spec } from "./fixtures";

// --- work item HTML ---
section("Work Item HTML to plain text");
eq("<li> becomes a bullet", htmlToText("<ul><li>criterion one</li><li>criterion two</li></ul>"), "- criterion one\n- criterion two");
eq("<br> is a newline", htmlToText("a<br/>b"), "a\nb");
eq("entities decoded", htmlToText("&lt;tag&gt; &amp; &quot;q&quot;&nbsp;x"), '<tag> & "q" x');
eq("numeric entities", htmlToText("&#65;&#66;"), "AB");
eq("script removed", htmlToText("<p>keep</p><script>evil()</script>"), "keep");
eq("empty input", htmlToText(undefined), "");
check("<p> splits paragraphs", htmlToText("<p>one</p><p>two</p>").split("\n").length === 2);
// The criterion splitter reads top-level markers as units and INDENTED ones as
// continuations, so flattening "1./2./3." into three identical bullets and un-indenting
// sub-bullets changed the denominator with the shape of the author's HTML.
eq("<ol> keeps its numbering", htmlToText("<ol><li>first</li><li>second</li><li>third</li></ol>"), "1. first\n2. second\n3. third");
eq("each list numbers from one", htmlToText("<ol><li>a</li></ol><ol><li>b</li></ol>"), "1. a\n\n1. b");
eq(
  "a nested list is indented by depth",
  htmlToText("<ul><li>outer<ul><li>inner</li></ul></li><li>next</li></ul>"),
  "- outer\n\n  - inner\n\n- next",
);
eq(
  "...so the splitter attaches the sub-bullet to its parent",
  splitCriteria(htmlToText("<ul><li>outer<ul><li>inner</li></ul></li><li>next</li></ul>")),
  ["outer inner", "next"],
);
eq("an image leaves a placeholder, not a hole", htmlToText('<li>looks like <img src="a.png" alt="the dialog"></li>'), "- looks like [image: the dialog]");
eq("...even with no alt text", htmlToText("<p><img src='a.png'></p>"), "[image]");

section("two-axis wiring: citations, conventions, requirement skeptic");
{
  // Citation teeth: an uncited maintainability finding is a hypothesis — capped to low so
  // it can never spend an inline slot; cited or behavioral findings keep their severity.
  const base = { severity: "high", confidence: 0.9, file: "/a.ts", quote: "x()", claim: "c", side: "right" };
  const uncited = validateFinding({ ...base, category: "maintainability" });
  eq("uncited maintainability capped to low", uncited?.severity, "low");
  const cited = validateFinding({ ...base, category: "maintainability", cites: "Feature Envy" });
  eq("cited maintainability is capped to medium (a smell is a judgment call)", cited?.severity, "medium");
  eq("...and carries the citation", cited?.cites, "Feature Envy");
  const behavioral = validateFinding({ ...base, category: "correctness" });
  eq("behavioral finding needs no citation", behavioral?.severity, "high");

  // Conventions rendering: repo docs get in, the prompt budget holds, absent means empty.
  eq("no convention docs renders nothing", renderConventions([]), "");
  const conv = renderConventions([{ path: "/CONTRIBUTING.md", text: "Use tabs." }]);
  check("doc content present under its path", conv.includes("### /CONTRIBUTING.md") && conv.includes("Use tabs."));
  check("override contract stated", conv.includes("override"));
  const big = renderConventions([
    { path: "/a.md", text: "x".repeat(10_000) },
    { path: "/b.md", text: "y".repeat(10_000) },
    { path: "/c.md", text: "z".repeat(10_000) },
  ]);
  check("per-file cap applies", big.includes("(truncated"));
  // Shared, not first come first served: the third long document is cut like the other two
  // rather than dropped whole.
  check("every document gets a share of the budget", big.includes("### /c.md") && !big.includes("omitted"));
  const four = renderConventions(["a", "b", "c", "d"].map((c) => ({ path: `/${c}.md`, text: c.repeat(7_000) })));
  check("...an even one: the last of four long documents is not left the scraps", four.includes("d".repeat(3_500)), four.slice(-300));
  check("total stays bounded", big.length < 18_000);
  const shortAndLong = renderConventions([
    { path: "/short.md", text: "Short and whole." },
    { path: "/long.md", text: "w".repeat(7_000) },
  ]);
  check("a short document costs only its length", shortAndLong.includes("Short and whole."));
  check("...and a long one still stops at the per-file cap", shortAndLong.includes("(truncated — read /long.md"));
  const many = renderConventions(Array.from({ length: 14 }, (_, i) => ({ path: `/d${i}.md`, text: `doc ${i}` })));
  check("past twelve documents the rest are named, not read", many.includes("(/d12.md omitted") && many.includes("(/d13.md omitted") && !many.includes("doc 12"));
  const scoped = renderConventions([{ path: "/src/api/AGENTS.md", text: "API rules.", scope: "files under src/api/" }]);
  check("a scoped document says what it applies to", scoped.includes("### /src/api/AGENTS.md\n\nApplies to: files under src/api/\n\nAPI rules."), scoped);
  check("...and the block says the narrower scope wins", scoped.includes("the one scoped more narrowly to it wins"));

  // Requirement skeptic: a refuted accusation demotes to not-verifiable (never satisfied),
  // keeps the refuter's evidence, and errors/non-refutations change nothing (fail open).
  const mk = (verdict: ReqVerdict): CriterionCheck => ({ workItemId: 1, criterion: "must audit", verdict, note: "n" });
  const cs = [mk("missing"), mk("misunderstood"), mk("missing")];
  const disputed = applyReqSkepticVerdicts(cs, [
    { verdict: "refuted", reason: "AuditLog.write added in diff", confidence: 0.9, model: "arch" },
    { verdict: "holds", reason: "", confidence: 0.8, model: "arch" },
    { verdict: "refuted", reason: "", confidence: 0, model: "arch", error: "timeout (900s)" },
  ]);
  eq("only the clean refutation counts", disputed, 1);
  eq("refuted missing becomes not-verifiable", cs[0]!.verdict, "not-verifiable");
  check("...with the evidence in the note", cs[0]!.note.includes("AuditLog.write") && cs[0]!.note.includes("original note: n"));
  eq("unrefuted verdict stands", cs[1]!.verdict, "misunderstood");
  eq("errored verifier changes nothing (fail open)", cs[2]!.verdict, "missing");
}

section("requirement criteria: the pipeline owns the denominator, not the model");
{
  // Deterministic splitting: list items are the units, sub-bullets and continuations
  // attach upward, framing prose is dropped, and no list structure = one criterion.
  eq("dash list splits", splitCriteria("The following must hold:\n- audit log written\n- retry on 5xx\n- alerts fire"), ["audit log written", "retry on 5xx", "alerts fire"]);
  eq("numbered list splits", splitCriteria("1. first thing\n2) second thing"), ["first thing", "second thing"]);
  eq("indented sub-bullet attaches to its parent", splitCriteria("- outer rule\n  - covers weekends\n- other rule"), ["outer rule covers weekends", "other rule"]);
  eq("continuation prose attaches", splitCriteria("- rule spanning\n  two lines\n- next"), ["rule spanning two lines", "next"]);
  eq("prose with no markers is ONE criterion", splitCriteria("Just make login work again."), ["Just make login work again."]);
  eq("empty field yields none", splitCriteria("  \n "), []);

  // Stable ids per work item; description is the fallback source.
  const refs = extractCriteria({ id: 4711, acceptanceCriteria: "- a\n- b", description: "ignored" });
  eq("ids are stable and sequential", refs.map((r) => r.id), ["4711-AC1", "4711-AC2"]);
  eq("description used when AC empty", extractCriteria({ id: 9, acceptanceCriteria: "", description: "fix the leak" })[0]?.id, "9-AC1");

  // Verdicts bind by id: text always comes from the work item, invented ids are dropped,
  // skipped criteria surface instead of vanishing, output is in ref order every run.
  const out = resolveJudgments(
    [
      { criterionId: "[4711-AC2]", verdict: "missing", note: "n2", quote: null, file: null },
      { criterionId: "4711-AC9", verdict: "missing", note: "invented", quote: null, file: null },
      { criterionId: "4711-AC1", verdict: "SATISFIED", note: "", quote: "x()", file: "/a.ts" },
    ],
    refs,
  );
  eq("one entry per listed criterion, in ref order", out.criteria.map((c) => c.criterion), ["a", "b"]);
  eq("bracketed id spelling tolerated", out.criteria[1]?.verdict, "missing");
  eq("verdict case normalized", out.criteria[0]?.verdict, "satisfied");
  eq("invented id counted and dropped", out.unknownIds, 1);
  eq("nothing unjudged here", out.unjudged, 0);
  const skipped = resolveJudgments([], refs);
  eq("skipped criteria surface as not-verifiable", skipped.criteria.map((c) => c.verdict), ["not-verifiable", "not-verifiable"]);
  eq("...and are counted", skipped.unjudged, 2);
  check("...with an honest note", (skipped.criteria[0]?.note ?? "").includes("not judged"));
  eq("the pipeline's own id rides along, for the dispute pass to address", out.criteria[0]?.id, "4711-AC1");

  // A model that answers the same id twice used to have its LAST word win silently, so a
  // repeat could close a criterion it had just called missing.
  const dup = resolveJudgments(
    [
      { criterionId: "4711-AC1", verdict: "missing", note: "no code", quote: null, file: null },
      { criterionId: "4711-ac1", verdict: "satisfied", note: "on reflection", quote: "x()", file: "/a.ts" },
      { criterionId: "4711-AC2", verdict: "partial", note: "half", quote: null, file: null },
      { criterionId: "4711-AC2", verdict: "misunderstood", note: "wrong way", quote: null, file: null },
    ],
    refs,
  );
  eq("a duplicate never softens the verdict", dup.criteria[0]?.verdict, "missing");
  eq("...and does not carry over the softer note", dup.criteria[0]?.note, "no code");
  eq("a duplicate may harden it", dup.criteria[1]?.verdict, "misunderstood");
  eq("...and both duplicates are counted, not swallowed", dup.duplicates, 2);
  const folded = resolveJudgments([{ criterionId: "4711-ac2", verdict: "missing", note: "", quote: null, file: null }], refs);
  eq("ids are case-folded, not dropped as invented", folded.criteria[1]?.verdict, "missing");
  eq("...so nothing counts as an invented id", folded.unknownIds, 0);
}

section("requirement axis: a satisfied verdict must anchor its evidence");
{
  // "satisfied" closes a criterion, and it was the one verdict nothing checked: an invented
  // (or absent) evidence quote still counted as implemented.
  const f = mkFile("/src/audit.ts", ["export function write(e) {", "  auditLog.append(e);", "}"], [1, 2, 3]);
  const idx = new FileIndex([f]);
  const mk = (over: Partial<CriterionCheck>): CriterionCheck =>
    ({ workItemId: 1, criterion: "writes an audit entry", verdict: "satisfied", note: "n", ...over });
  const cs = [
    mk({ quote: "  auditLog.append(e);", file: "/src/audit.ts" }),
    mk({ quote: "  metrics.increment(e);", file: "/src/audit.ts" }),
    mk({}),
    mk({ quote: "  auditLog.append(e);", file: "/src/other.ts" }),
    mk({ verdict: "missing", quote: "nowhere();", file: "/src/audit.ts", note: "no audit call" }),
  ];
  eq("the unanchorable satisfied verdicts are demoted", verifySatisfiedEvidence(cs, idx), 3);
  eq("a quote that locates in the diff keeps the verdict", cs[0]!.verdict, "satisfied");
  eq("a quote absent from the diff demotes to not-verifiable", cs[1]!.verdict, "not-verifiable");
  check("...saying why, with the original note kept",
    cs[1]!.note.startsWith("claimed satisfied, but the evidence quote was not found in the diff") && cs[1]!.note.endsWith("original note: n"));
  eq("no quote at all demotes", cs[2]!.verdict, "not-verifiable");
  eq("a quote in a file outside the change demotes", cs[3]!.verdict, "not-verifiable");
  eq("other verdicts are not touched", cs[4]!.verdict, "missing");
  eq("...nor their notes", cs[4]!.note, "no audit call");
}

section("requirement axis: \"missing\" is only a finding about a diff read in full");
{
  // With files left out for size, the implementation may be in one of them, and a "missing"
  // that fails the status would rest on code nobody looked at.
  const mk = (verdict: CriterionCheck["verdict"]): CriterionCheck =>
    ({ workItemId: 1, criterion: "exports a CSV", verdict, note: "n" });
  const cs = [mk("missing"), mk("partial"), mk("misunderstood"), mk("satisfied"), mk("not-this-pr")];
  eq("nothing changes when every file was shown", demoteUnseenMissing(cs, []), 0);
  eq("...not even the accusation", cs[0]!.verdict, "missing");
  const omitted = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];
  eq("with files omitted, only \"missing\" is taken back", demoteUnseenMissing(cs, omitted), 1);
  eq("...to not-verifiable, out of the unmet count", cs[0]!.verdict, "not-verifiable");
  check("...naming the files, capped, and keeping the model's note",
    cs[0]!.note.includes("6 changed files were too large to show (src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts and 1 more)") &&
      cs[0]!.note.endsWith("original note: n"), cs[0]!.note);
  eq("\"partial\" and \"misunderstood\" point at code that was shown, so they stand",
    cs.slice(1, 3).map((c) => c.verdict), ["partial", "misunderstood"]);
  eq("...and the rest are untouched", cs.slice(3).map((c) => c.verdict), ["satisfied", "not-this-pr"]);
}

section("requirement scope: a criterion this PR never owed is not a failure");
{
  // The false-"missing" class. A work item's criteria are delivered over several PRs, and a
  // parent PBI's criteria arrive whole in a child task's PR — so "missing" was the
  // structurally guaranteed verdict, and the axis accused the author of not doing work that
  // was never in this change. not-this-pr says that, and says it without failing the PR.
  const wi: WorkItem = {
    id: 12043, title: "Partial refunds", type: "Product Backlog Item", state: "Active",
    description: "", acceptanceCriteria: "", specSource: "acceptance-criteria", url: "",
  };
  const mk = (verdict: ReqVerdict, criterion: string): CriterionCheck =>
    ({ workItemId: 12043, criterion, verdict, note: "n", quote: "  refund(order, amount)", file: "/src/refund.ts" });
  const req: RequirementResult = {
    workItems: [wi],
    criteria: [mk("satisfied", "refund an amount"), mk("not-this-pr", "email the customer"), mk("missing", "cap at the total")],
    extras: [],
  };
  eq("not-this-pr is not an unmet criterion", unmetCriteria(req).map((c) => c.criterion), ["cap at the total"]);
  eq(
    "...so a PR whose only open criteria are another PR's never trips exit code 2",
    unmetCriteria({ ...req, criteria: [mk("not-this-pr", "a"), mk("not-this-pr", "b"), mk("satisfied", "c")] }).length,
    0,
  );
  const f = mkFile("/src/refund.ts", ["export function refund(order, amount) {", "  refund(order, amount)", "}"], [1, 2, 3]);
  eq(
    "...and it never becomes an inline accusation, quote or no quote",
    toRequirementFindings({ ...req, criteria: [mk("not-this-pr", "email the customer")] }, new FileIndex([f])).length,
    0,
  );

  // Rendered, though: scope information a reader needs, kept out of the denominator.
  const summaryCtx = {
    ref: { baseUrl: "https://dev.azure.com/o", org: "o", project: "p", repoId: "r", prId: 1 },
    pr: { title: "t", description: "", sourceBranch: "s", targetBranch: "m", createdBy: "a", status: "active" },
    iterations: [],
    iteration: { id: 1, sourceRefCommit: "", targetRefCommit: "", commonRefCommit: "", createdDate: "" },
    compareTo: 0,
    files: [],
    skipped: [],
    changeTrackingIds: new Map(),
  } as unknown as Parameters<typeof renderSummary>[0]["ctx"];
  const rendered = renderSummary({
    ctx: summaryCtx,
    agg: { inline: [], belowBar: [], degraded: [], stats: { raw: 0, afterDedupe: 0, anchored: 0, survived: 0, refuted: 0, inline: 0, byFailure: {}, excluded: 0, dismissed: 0 } },
    req,
    finderErrors: [], omittedFiles: [], appliedRules: [], durationSec: 1, runDir: "",
  });
  check("the scoped-out criterion is still in the table", rendered.includes("Another PR's scope") && rendered.includes("email the customer"));
  check("the denominator drops it", rendered.includes("1/2 acceptance criteria for #12043 in this PR's scope are unmet"));
  check("...and says where it went", rendered.includes("1 further criterion belongs to another task or PR"));
  const clean = renderSummary({
    ctx: summaryCtx,
    agg: { inline: [], belowBar: [], degraded: [], stats: { raw: 0, afterDedupe: 0, anchored: 0, survived: 0, refuted: 0, inline: 0, byFailure: {}, excluded: 0, dismissed: 0 } },
    req: { ...req, criteria: [mk("satisfied", "a"), mk("satisfied", "b")] },
    finderErrors: [], omittedFiles: [], appliedRules: [], durationSec: 1, runDir: "",
  });
  check("nothing scoped out keeps the stronger claim", clean.includes("All 2 acceptance criteria for #12043 are implemented"));
}

section("requirement prompt: inherited criteria and the Bug question");
{
  const pr = { title: "t", description: "", sourceBranch: "s", targetBranch: "m", createdBy: "a", status: "active" };
  const files = [mkFile("/src/a.ts", ["const a = 1;"], [1])];
  const wi = (over: Partial<WorkItem>): WorkItem => ({
    id: 1, title: "t", type: "Task", state: "Active", description: "",
    acceptanceCriteria: "", specSource: "acceptance-criteria", url: "", ...over,
  });
  check("the verdict table offers the scope verdict", REQUIREMENT_SYSTEM.includes("| not-this-pr |"));
  check("...and says when to prefer it over missing", REQUIREMENT_SYSTEM.includes("missing vs not-this-pr"));

  // inheritedFrom was computed by ado/workitems.ts and consumed nowhere: the model saw a
  // whole PBI's criteria with no hint that this PR is one task under it.
  const inherited = buildRequirementPrompt({
    pr,
    workItems: [wi({ id: 12043, type: "Product Backlog Item" })],
    files,
    criteria: [{ id: "12043-AC1", workItemId: 12043, text: "email the customer" }],
    maxExtras: 3,
    inheritedFrom: [12043],
    linkedIds: [12050, 12043],
  });
  check("the parent is named as the parent", inherited.includes("PARENT work item #12043"));
  check("...and the task the PR is actually linked to", inherited.includes("this PR is linked to #12050"));
  check("...with the sibling rule spelled out", inherited.includes("not-this-pr"));
  const own = buildRequirementPrompt({
    pr, workItems: [wi({ id: 7 })], files,
    criteria: [{ id: "7-AC1", workItemId: 7, text: "cap the refund" }],
    maxExtras: 3, inheritedFrom: [], linkedIds: [7],
  });
  check("a PR judged against its own work item gets no inheritance framing", !own.includes("PARENT work item"));
  eq("the criterion ids are untouched by any of it", own.includes("[7-AC1] cap the refund"), true);

  // A Bug states its spec as reproduction steps. Judged as acceptance criteria, a correct
  // fix is "missing" on every one of them — it implements none of them, it stops them.
  const bug = buildRequirementPrompt({
    pr,
    workItems: [wi({ id: 99, type: "Bug", specSource: "repro-steps" })],
    files,
    criteria: [{ id: "99-AC1", workItemId: 99, text: "click Refund twice; the order is refunded twice" }],
    maxExtras: 3,
  });
  check("repro steps are labelled as repro steps", bug.includes("Reproduction steps to judge"));
  check("...and asked the fix question, not the implementation question", bug.includes("does this diff plausibly stop the described behavior from happening?"));
  const fromDesc = buildRequirementPrompt({
    pr, workItems: [wi({ id: 5, specSource: "description" })], files,
    criteria: [{ id: "5-AC1", workItemId: 5, text: "make login work" }], maxExtras: 3,
  });
  check("a description-sourced spec says so", fromDesc.includes("taken from the description"));
  check("...and does not ask the Bug question", !fromDesc.includes("plausibly stop the described behavior"));
}

section("requirement dispute: one batched call, verdicts bound by id");
{
  const mk = (id: string, verdict: ReqVerdict): CriterionCheck =>
    ({ workItemId: 1, id, criterion: `c-${id}`, verdict, note: "n" });
  const accused = [mk("4711-AC1", "missing"), mk("4711-AC2", "partial"), mk("4711-AC3", "misunderstood")];

  // The whole diff used to be re-sent once per accused criterion; now one prompt lists them.
  const prompt = buildReqDisputePrompt(
    accused.map((c) => ({ id: c.id!, criterion: c.criterion, verdict: c.verdict, note: c.note })),
    "@@ -1 +1 @@\n+const a = 1;",
  );
  check("every accusation is in the one prompt", ["4711-AC1", "4711-AC2", "4711-AC3"].every((id) => prompt.includes(`[${id}]`)));
  eq("...and the diff is sent exactly once", prompt.split("const a = 1;").length, 2);

  // Answers bind by id, never by position: a model that reorders, skips or invents an id
  // would otherwise land its refutation on somebody else's criterion.
  const verdicts = resolveDisputeVerdicts(
    [
      { criterionId: "4711-AC3", verdict: "refuted", reason: "the mapper does exactly this", evidence_quote: "map()" },
      { criterionId: "[4711-ac1]", verdict: "holds", reason: "nothing implements it" },
      { criterionId: "4711-AC3", verdict: "holds", reason: "second thoughts" },
      { criterionId: "4711-AC9", verdict: "refuted", reason: "invented id" },
    ],
    accused,
    "arch",
  );
  eq("verdicts come back in accusation order", verdicts.map((v) => v.verdict), ["holds", "insufficient-context", "refuted"]);
  check("a bracketed, case-folded id still resolves", verdicts[0]!.error === undefined);
  check("an unanswered criterion is an error, so nothing changes", verdicts[1]!.error !== undefined);
  eq("a repeated id keeps the first answer", verdicts[2]!.reason, "the mapper does exactly this");

  const disputed = applyReqSkepticVerdicts(accused, verdicts);
  eq("only the refuted accusation is disputed", disputed, 1);
  eq("...demoted, never flipped to satisfied", accused[2]!.verdict, "not-verifiable");
  check("...with the counter-evidence in the note", accused[2]!.note.includes("the mapper does exactly this"));
  eq("a holds verdict leaves the accusation standing", accused[0]!.verdict, "missing");
  eq("an unanswered one is left alone too (fail open)", accused[1]!.verdict, "partial");
  eq(
    "partial is now disputable at all — it accuses too",
    accused.filter((c) => c.verdict === "partial").length,
    1,
  );
}

section("requirement gate: an answer it cannot bind fails, never passes");
{
  // A gateway that accepts response_format without enforcing it hands back parseable JSON in
  // some other shape. The axis read that as "every criterion not judged": nothing unmet,
  // exit 0, and a headline saying every criterion was implemented.
  const calls: ChatRequest[] = [];
  const stub = (answers: Record<string, (r: ChatRequest) => string | { error: string }>): ModelRunner => ({
    chat: async (r) => {
      calls.push(r);
      const a = answers[r.schemaName ?? ""]?.(r) ?? "";
      return typeof a === "string" ? { model: r.model, text: a } : { model: r.model, text: "", error: a.error };
    },
  });
  const pr = { title: "OTP expiry", description: "", sourceBranch: "s", targetBranch: "m", createdBy: "a", status: "active" };
  const wi = (acceptanceCriteria: string): WorkItem => ({
    id: 7,
    title: "OTP",
    type: "User Story",
    state: "Active",
    description: "",
    acceptanceCriteria,
    specSource: "acceptance-criteria",
    url: "",
  });
  const otp = mkFile(
    "src/otp.ts",
    ["export function verify(now: number, issuedAt: number) {", "  if (now - issuedAt > 5 * 60_000) return false;", "  return true;", "}"],
    [1, 2, 3, 4],
  );
  const gate = (runner: ModelRunner, item = wi("- Expired codes are rejected"), extra: Partial<RequirementGateInput> = {}) =>
    capture(() =>
      runRequirementGate({
        pr,
        runner,
        diff: async () => ({ files: [otp], fileIndex: new FileIndex([otp]) }),
        requirements: async () => ({ items: [item], inheritedFrom: [] }),
        ...extra,
      }),
    );

  const bare = (await gate(stub({ requirements: () => '[{"criterionId":"7-AC1","verdict":"missing"}]' }))).value.result;
  eq("a bare array is an error", bare.error, "response has no criteria array");
  eq("...and judges nothing", bare.criteria.length, 0);

  const { value: unlisted, lines: unlistedLog } = await gate(
    stub({
      requirements: () =>
        '{"criteria":[{"criterionId":"AC1","verdict":"satisfied","note":"","quote":null,"file":null}],"extras":[]}',
    }),
  );
  eq("verdicts on unlisted ids only are an error", unlisted.result.error, "response judged none of the 1 listed criteria (1 verdict on an unlisted id)");
  check("...and the log says so", unlistedLog.some((l) => l.includes("[FAIL] requirement axis response judged none")));
  eq(
    "an empty criteria list is the same non-answer",
    (await gate(stub({ requirements: () => '{"criteria":[],"extras":[]}' }))).value.result.error,
    "response judged none of the 1 listed criteria",
  );
  const bareLog = (await gate(stub({ requirements: () => "[]" }))).lines;
  check("the log line names what came back", bareLog.some((l) => l.includes("no criteria array (got a top-level array of 0)")), bareLog.join(" | "));

  const partial = (
    await gate(
      stub({
        requirements: () =>
          '{"criteria":[{"criterionId":"7-AC1","verdict":"not-verifiable","note":"n","quote":null,"file":null}],"extras":[]}',
      }),
      wi("- Expired codes are rejected\n- Codes are six digits"),
    )
  ).value.result;
  check(
    "a partial answer is still a warning, not an error",
    partial.error === undefined && partial.criteria.length === 2 && partial.criteria[1]!.note.startsWith("not judged"),
    JSON.stringify(partial.criteria.map((c) => c.note)),
  );

  calls.length = 0;
  const { value: disputed, lines } = await gate(
    stub({
      requirements: () =>
        '{"criteria":[{"criterionId":"7-AC1","verdict":"missing","note":"n","quote":null,"file":null}],"extras":[]}',
      req_dispute: () => '{"items":[]}',
    }),
    undefined,
    { disputeModel: "sk" },
  );
  check("the dispute pass ran, on the seam's model", calls.some((c) => c.schemaName === "req_dispute" && c.model === "sk"));
  eq("a dispute answer with no verdicts array leaves the accusation standing", disputed.result.criteria[0]?.verdict, "missing");
  check(
    "...and says so",
    lines.some((l) => l.includes("dispute answer has no verdicts array (got an object with keys items)")),
    lines.join(" | "),
  );

  const agg: AggregateResult = {
    inline: [],
    belowBar: [],
    degraded: [],
    stats: { raw: 0, afterDedupe: 0, anchored: 0, survived: 0, refuted: 0, inline: 0, byFailure: {}, excluded: 0, dismissed: 0 },
  };
  eq(
    "a wrong-shape answer makes the run incomplete (exit 3), not clean",
    exitCodeFor({ agg, req: bare, incomplete: [`requirement axis (${bare.error})`] }),
    3,
  );
}
