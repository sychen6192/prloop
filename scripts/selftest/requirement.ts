// The requirement axis: criteria the pipeline owns, evidence that has to anchor, scope,
// the prompt, and the batched dispute pass.
import { FileIndex } from "../../libs/fileindex";
import { htmlToText } from "../../libs/html";
import { renderConventions } from "../../libs/rules";
import { log } from "../../libs/log";
import { renderSummary } from "../../publish/format";
import { buildRequirementPrompt, openSpecDocList } from "../../prompts/requirement";
import { isOpenSpecDoc } from "../../libs/openspec";
import { validateFinding } from "../../gates/finder";
import {
  OPENSPEC_NOT_EVIDENCE_NOTE,
  accuses,
  advisoryUnmet,
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
  FileDiff,
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

// --- the gate end to end, over a stub runner ---
// Answers by schemaName; every request is recorded, so a section can ask what was sent.
const calls: ChatRequest[] = [];
const stub = (answers: Record<string, (r: ChatRequest) => string | { error: string }>): ModelRunner => ({
  chat: async (r) => {
    calls.push(r);
    const a = answers[r.schemaName ?? ""]?.(r) ?? "";
    return typeof a === "string" ? { model: r.model, text: a } : { model: r.model, text: "", error: a.error };
  },
});
const gatePr = { title: "OTP expiry", description: "", sourceBranch: "s", targetBranch: "m", createdBy: "a", status: "active" };
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
const gate = (
  runner: ModelRunner,
  item = wi("- Expired codes are rejected"),
  extra: Partial<RequirementGateInput> = {},
  files: FileDiff[] = [otp],
) =>
  capture(() =>
    runRequirementGate({
      pr: gatePr,
      runner,
      diff: async () => ({ files }),
      requirements: async () => ({ items: [item], inheritedFrom: [] }),
      ...extra,
    }),
  );
const judged = (verdict: string, quote: string | null = null, file: string | null = null) =>
  JSON.stringify({ criteria: [{ criterionId: "7-AC1", verdict, note: "n", quote, file }], extras: [] });

section("requirement gate: an answer it cannot bind fails, never passes");
{
  // A gateway that accepts response_format without enforcing it hands back parseable JSON in
  // some other shape. The axis read that as "every criterion not judged": nothing unmet,
  // exit 0, and a headline saying every criterion was implemented.

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

section("OpenSpec documents: named to the model, never shown, never evidence");
{
  const tasks = mkFile(
    "openspec/changes/x/tasks.md",
    ["## 1. Tasks", "- [x] 1.1 Reject expired codes", "- [x] 1.2 Lock the account after five failed codes"],
    [1, 2, 3],
  );
  check("isOpenSpecDoc: a task list is intent", isOpenSpecDoc("openspec/changes/x/tasks.md") && isOpenSpecDoc("/svc/openspec/specs/a/spec.md"));
  check(
    "...code under openspec/, a doc named openspec.md, and another casing are not",
    !isOpenSpecDoc("openspec/tools/gen.ts") && !isOpenSpecDoc("docs/openspec.md") && !isOpenSpecDoc("OpenSpec/changes/x/tasks.md"),
  );

  // The motivating failure: the model quoted the ticked task and the quote anchored, because
  // tasks.md was in the diff the evidence index was built from.
  calls.length = 0;
  const ticked = (
    await gate(
      stub({ requirements: () => judged("satisfied", "- [x] 1.2 Lock the account after five failed codes", "openspec/changes/x/tasks.md") }),
      wi("- Lock the account after five failed codes"),
      {},
      [otp, tasks],
    )
  ).value.result;
  eq("a satisfied verdict quoting tasks.md is taken back", ticked.criteria[0]?.verdict, "not-verifiable");
  check("...with the note saying why", (ticked.criteria[0]?.note ?? "").startsWith(OPENSPEC_NOT_EVIDENCE_NOTE), ticked.criteria[0]?.note);
  const p = calls.find((c) => c.schemaName === "requirements")?.user ?? "";
  check(
    "the prompt names the task list but never shows it",
    p.includes("Not shown: 1 OpenSpec document this pull request changes (openspec/changes/x/tasks.md)") && !p.includes("- [x] 1.2"),
    p.slice(p.indexOf("## The actual code change"), p.indexOf("## The actual code change") + 400),
  );
  check("...and still shows the code", p.includes("src/otp.ts"));

  const control = (
    await gate(stub({ requirements: () => judged("satisfied", "if (now - issuedAt > 5 * 60_000) return false;", "src/otp.ts") }), undefined, {}, [
      otp,
      tasks,
    ])
  ).value.result;
  eq("control: a quote from the code stays satisfied", control.criteria[0]?.verdict, "satisfied");

  // Packed into the payload, an oversized design.md was "omitted for size", and its omission
  // then took a real "missing" back (demoteUnseenMissing): the model could not have seen it.
  const design = mkFile(
    "openspec/changes/x/design.md",
    Array.from({ length: 6000 }, (_, i) => `Design line ${String(i).padStart(5, "0")} ${"x".repeat(30)}`),
    Array.from({ length: 6000 }, (_, i) => i + 1),
  );
  const missing = (await gate(stub({ requirements: () => judged("missing") }), undefined, {}, [otp, design])).value.result;
  eq("an oversized design.md no longer takes a missing back", missing.criteria[0]?.verdict, "missing");

  calls.length = 0;
  await gate(stub({ requirements: () => judged("missing"), req_dispute: () => '{"verdicts":[]}' }), undefined, { disputeModel: "sk" }, [
    otp,
    tasks,
  ]);
  const dispute = calls.find((c) => c.schemaName === "req_dispute");
  check(
    "the dispute is shown code only",
    dispute !== undefined && dispute.user.includes("src/otp.ts") && !dispute.user.includes("openspec/changes/x/tasks.md"),
  );

  calls.length = 0;
  const proposalOnly = (await gate(stub({}), undefined, {}, [tasks])).value.result;
  eq(
    "only OpenSpec documents changed: skipped, no model call",
    [proposalOnly.skipped, calls.length],
    ["only OpenSpec documents changed: there is no code or configuration yet to judge the criteria against", 0],
  );

  const input = { pr: gatePr, workItems: [wi("- Expired codes are rejected")], files: [otp], criteria: extractCriteria(wi("- Expired codes are rejected")), maxExtras: 5 };
  check(
    "no OpenSpec documents: the prompt is unchanged",
    buildRequirementPrompt(input) === buildRequirementPrompt({ ...input, intentDocs: [] }) && !buildRequirementPrompt(input).includes("OpenSpec"),
  );
  eq(
    "a long list names ten and counts the rest",
    openSpecDocList(Array.from({ length: 12 }, (_, i) => `openspec/changes/c${i}/tasks.md`)).endsWith("openspec/changes/c9/tasks.md, and 2 more"),
    true,
  );
}

section("requirement gate: the pull request's own OpenSpec change, judged apart and never blocking");
{
  const delta = mkFile(
    "openspec/changes/add-otp/specs/auth/spec.md",
    [
      "## ADDED Requirements",
      "",
      "### Requirement: Code expiry",
      "The system SHALL reject a one-time code older than five minutes.",
      "",
      "#### Scenario: Expired code",
      "- **WHEN** a code issued six minutes ago is entered",
      "- **THEN** verification fails",
      "",
      "### Requirement: Lockout",
      "The system SHALL lock the account after five failed codes.",
      "",
      "### Requirement: Audit",
      "The system SHALL record every failed code in the audit log.",
      "",
      "## REMOVED Requirements",
      "",
      "### Requirement: Password-only login",
      "**Reason**: replaced by one-time codes",
    ],
    Array.from({ length: 19 }, (_, i) => i + 1),
  );
  const tasks = mkFile("openspec/changes/add-otp/tasks.md", ["- [x] 1.1 Reject expired codes"], [1]);
  const spec = (verdict: string, id = "SPEC1-R1", quote: string | null = null, file: string | null = null) =>
    JSON.stringify({ criteria: [{ criterionId: id, verdict, note: "n", quote, file }] });
  let diffCalls = 0;
  const run = (o: {
    items?: WorkItem[];
    files?: FileDiff[];
    unread?: Array<{ path: string; reason: string }>;
    specDeltaPaths?: () => Promise<string[]>;
    answers: Record<string, (r: ChatRequest) => string | { error: string }>;
  }) => {
    calls.length = 0;
    diffCalls = 0;
    return capture(() =>
      runRequirementGate({
        pr: gatePr,
        runner: stub(o.answers),
        diff: async () => {
          diffCalls++;
          return { files: o.files ?? [otp, delta], unread: o.unread ?? [] };
        },
        requirements: async () => ({ items: o.items ?? [], inheritedFrom: [] }),
        ...(o.specDeltaPaths ? { specDeltaPaths: o.specDeltaPaths } : {}),
      }),
    );
  };
  const noWorkItem = { workItems: [], criteria: [], extras: [], skipped: "PR has no linked work item" };

  const g1 = await run({ answers: {} });
  eq("no work item and no discovery: today's skip", g1.value.result, noWorkItem);
  eq("...and the diff is never read", diffCalls, 0);
  const g2 = await run({ answers: {}, specDeltaPaths: async () => ["src/otp.ts"] });
  eq("no spec delta in the listing: the same skip, nothing read", [g2.value.result, diffCalls], [noWorkItem, 0]);

  const g3 = (await run({ answers: { openspec: () => spec("missing") }, specDeltaPaths: async () => [delta.path] })).value;
  eq("no work item, a spec delta: one OpenSpec call and no work-item call", calls.map((c) => c.schemaName), ["openspec"]);
  eq("...the work-item result is still today's skip", g3.result.skipped, "PR has no linked work item");
  eq("...the spec is judged", [g3.result.openspec?.criteria[0]?.verdict, g3.result.openspec?.criteria[0]?.spec.capability], ["missing", "auth"]);
  eq("...and an unmet spec requirement is never unmet for the status", [unmetCriteria(g3.result).length, advisoryUnmet(g3.result.openspec).length], [0, 1]);
  check("...its prompt is saved apart", g3.specPrompt?.includes("[SPEC1-R1] (ADDED) Code expiry:") === true && g3.prompt === undefined);

  await run({
    items: [wi("- Expired codes are rejected")],
    answers: { requirements: () => judged("satisfied", "if (now - issuedAt > 5 * 60_000) return false;", "src/otp.ts"), openspec: () => spec("satisfied") },
  });
  const reqCall = calls.find((c) => c.schemaName === "requirements")?.user ?? "";
  const specCall = calls.find((c) => c.schemaName === "openspec")?.user ?? "";
  eq("a work item and a spec delta: two calls", calls.map((c) => c.schemaName).sort(), ["openspec", "requirements"]);
  check("the work-item call never sees the spec", !reqCall.includes("[SPEC1-") && !reqCall.includes("Code expiry"));
  check("...and the OpenSpec call never sees the work item", !specCall.includes("[7-AC") && !specCall.includes("Expired codes are rejected"));
  check("...it sees the spec, fenced", specCall.includes("<openspec-delta>") && specCall.includes("[SPEC1-R1] (ADDED) Code expiry:"));
  check("...and not the REMOVED requirement, which has nothing to judge", !specCall.includes("Password-only login"));

  const g5 = (
    await run({
      items: [wi("- Expired codes are rejected")],
      answers: { requirements: () => judged("missing"), openspec: () => ({ error: "timeout" }) },
    })
  ).value.result;
  eq("a failed OpenSpec call is not the axis's failure", [g5.error, g5.openspec?.error, g5.criteria[0]?.verdict], [undefined, "timeout", "missing"]);

  const g6 = (await run({ answers: { openspec: () => "[]" }, specDeltaPaths: async () => [delta.path] })).value.result;
  eq("a wrong-shape OpenSpec answer is its own error", [g6.openspec?.error, g6.error], ["response has no criteria array", undefined]);

  const g7 = (
    await run({
      answers: { openspec: () => spec("satisfied", "SPEC1-R1", "The system SHALL reject a one-time code older than five minutes.", delta.path) },
      specDeltaPaths: async () => [delta.path],
    })
  ).value.result;
  eq("a spec requirement is never satisfied by quoting itself", g7.openspec?.criteria[0]?.verdict, "not-verifiable");
  check("...and says why", (g7.openspec?.criteria[0]?.note ?? "").startsWith(OPENSPEC_NOT_EVIDENCE_NOTE));

  const g8 = (await run({ answers: {}, files: [delta, tasks], specDeltaPaths: async () => [delta.path] })).value.result;
  check(
    "a proposal with no code yet is described, not judged",
    (g8.openspec?.skipped ?? "").startsWith("this pull request changes only OpenSpec documents") && calls.length === 0 && g8.openspec?.deltas.length === 1,
    JSON.stringify(g8.openspec),
  );

  const g9 = await run({
    answers: {},
    specDeltaPaths: async () => {
      throw new Error("HTTP 503");
    },
  });
  eq("a listing that fails costs nothing but a warning", [g9.value.result, diffCalls], [noWorkItem, 0]);
  check("...which says so", g9.lines.some((l) => l.includes("[WARN] OpenSpec: could not list")));

  const g10 = (
    await run({
      items: [wi("- Expired codes are rejected")],
      files: [otp],
      unread: [{ path: delta.path, reason: "too large (not code)" }],
      answers: { requirements: () => judged("satisfied", "if (now - issuedAt > 5 * 60_000) return false;", "src/otp.ts") },
    })
  ).value.result;
  eq("a delta too large to read is named", g10.openspec?.unread, [{ path: delta.path, reason: "too large (not code)" }]);
  eq(
    "...and the skip says it was not read, not that nothing changed",
    g10.openspec?.skipped,
    "1 spec delta could not be read, and no ADDED or MODIFIED requirement this pull request changed was found in the rest",
  );

  // The read happens for the advisory half alone when no work item has criteria: its failure
  // must stay advisory, where skipping used to cost nothing.
  calls.length = 0;
  const failedRead = await capture(() =>
    runRequirementGate({
      pr: gatePr,
      runner: stub({}),
      diff: async () => {
        throw new Error("HTTP 503 reading blob");
      },
      requirements: async () => ({ items: [], inheritedFrom: [] }),
      specDeltaPaths: async () => [delta.path],
    }),
  );
  eq(
    "a whole-PR read that fails for the spec alone is the spec's failure",
    [failedRead.value.result.skipped, failedRead.value.result.error, failedRead.value.result.openspec?.error],
    ["PR has no linked work item", undefined, "HTTP 503 reading blob"],
  );
  const withItems = await capture(() =>
    runRequirementGate({
      pr: gatePr,
      runner: stub({}),
      diff: async () => {
        throw new Error("HTTP 503 reading blob");
      },
      requirements: async () => ({ items: [wi("- Expired codes are rejected")], inheritedFrom: [] }),
    }).then(
      () => "resolved",
      (e: Error) => e.message,
    ),
  );
  eq("...while with work items it is still the axis's, as it always was", withItems.value, "HTTP 503 reading blob");

  const renamed = await run({ answers: {}, files: [otp], unread: [{ path: delta.path, reason: "no textual change" }], specDeltaPaths: async () => [delta.path] });
  eq("a delta that was only renamed leaves today's skip", renamed.value.result, noWorkItem);
  check("...and the log says that, not that a spec is being judged", renamed.lines.some((l) => l.includes("PR has no linked work item; skipping")));

  const crashed = (
    await run({
      items: [wi("- Expired codes are rejected")],
      answers: {
        requirements: () => judged("missing"),
        openspec: () => {
          throw new Error("boom");
        },
      },
    })
  ).value.result;
  eq(
    "an OpenSpec half that throws keeps the work items' verdicts, and fails only itself",
    [crashed.error, crashed.criteria[0]?.verdict, crashed.openspec?.error],
    [undefined, "missing", "boom"],
  );

  const r: RequirementResult = {
    workItems: [],
    criteria: (["satisfied", "missing", "partial", "misunderstood", "not-this-pr", "not-verifiable"] as const).map((verdict) => ({ workItemId: 1, criterion: verdict, verdict, note: "" })),
    extras: [],
  };
  eq("accuses is the unmet predicate", unmetCriteria(r).length, r.criteria.filter(accuses).length);
}
