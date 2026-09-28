// Offline end-to-end net: one pull request reviewed twice — a full review of its first push,
// then `--since auto` on the next — through the real intake, gates, anchoring, publishing and
// HTTP model transport, against a fake Azure DevOps and a fake model endpoint.
//
// Every other net drives one module, and until this one the only test that ran runReview at
// all covered the merged-PR skip. A defect that lives between stages — in what one stage
// hands the next — passed all of them: each module did what its own net asked, and nothing
// ever asked the question a pull request asks, which is what ends up on it.
//
// The model endpoint answers like a careful reviewer that can only see its prompt: it reports
// a defect when the defect's line is in the diff it was shown, and calls a criterion
// satisfied when the implementing line is. So what the fake says depends on what each stage
// was actually handed, which is the thing under test.
//
// Its own file, and the servers start before the imports: config reads every PRR_* setting
// once at import time, and the fakes' ports only exist at run time.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fakeAdo, type ChangePage } from "./fakes/ado";
import { completion, fakeOpenAI, httpError, type RecordedCall, type Responder } from "./fakes/openai";

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

/** A review logs its way through; keep that out of the assertion stream, but keep it. */
async function capture<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = real;
  }
}

// ─── The pull request ────────────────────────────────────────────────────────

// Push 1 adds both files. Push 2 fixes the refund bug and adds a function with a new one.
const PAY_1 = `export const MAX_RETRIES = 3;

export async function charge(amountCents: number, send: (cents: number) => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (await send(amountCents)) return true;
  }
  return false;
}

export function refund(amountCents: number, feeCents: number): number {
  return amountCents + feeCents;
}
`;
const PAY_2 = `export const MAX_RETRIES = 3;

export async function charge(amountCents: number, send: (cents: number) => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (await send(amountCents)) return true;
  }
  return false;
}

export function refund(amountCents: number, feeCents: number): number {
  return amountCents - feeCents;
}

export function splitEvenly(totalCents: number, parts: number): number {
  return totalCents / parts;
}
`;
const EXPORT_1 = `export function toCsv(rows: string[][]): string {
  const header = "id,amount";
  return [header, ...rows.map((r) => r.join(","))].join("\\n");
}
`;
const BLOB = { pay1: "a1a1a1", pay2: "a2a2a2", export1: "e1e1e1" } as const;

const entry = (path: string, objectId: string, changeTrackingId: number, originalObjectId?: string) => ({
  changeTrackingId,
  changeType: originalObjectId ? "edit" : "add",
  item: { path, objectId, ...(originalObjectId ? { originalObjectId } : {}) },
});

/** What ADO answers for each push against each base: the whole PR, or one push's worth. */
function changesFor(iteration: number, compareTo: number): ChangePage[] {
  if (iteration === 1) return [{ changeEntries: [entry("/src/pay.ts", BLOB.pay1, 1), entry("/src/export.ts", BLOB.export1, 2)] }];
  if (compareTo === 1) return [{ changeEntries: [entry("/src/pay.ts", BLOB.pay2, 1, BLOB.pay1)] }];
  return [{ changeEntries: [entry("/src/pay.ts", BLOB.pay2, 1), entry("/src/export.ts", BLOB.export1, 2)] }];
}

const iteration = (id: number) => ({
  id,
  sourceRefCommit: { commitId: `src${id}` },
  targetRefCommit: { commitId: "tgt" },
  commonRefCommit: { commitId: "base" },
  createdDate: `2026-09-0${id}T00:00:00Z`,
});

const BOT = "e2e0e2e0-0000-4000-8000-000000000001";

// ─── The model: a careful reviewer that can only see its prompt ─────────────

/** Whether a prompt shows `code` as a line of the new code: added or context, never deleted. */
const shows = (prompt: string, code: string) =>
  prompt.split("\n").some((l) => /^[+ ]/.test(l) && l.slice(1).trim() === code);

interface Defect {
  by: string[];
  file: string;
  quote: string;
  claim: string;
  category: string;
  severity: string;
  /** A hallucination: reported whatever the prompt shows, on a line that exists nowhere. */
  always?: boolean;
}

const PAY = "src/pay.ts";
const INVOICE = "src/Billing/Invoice.cs";
const DEFECTS: Defect[] = [
  { by: ["finder-a", "finder-b"], file: PAY, quote: "return amountCents + feeCents;", category: "correctness", severity: "high", claim: "refund() adds the fee to the amount instead of subtracting it" },
  { by: ["finder-a", "finder-b"], file: PAY, quote: "if (await send(amountCents)) return true;", category: "reliability", severity: "medium", claim: "An exception thrown by send() ends the retry loop instead of counting as a failed attempt" },
  { by: ["finder-a"], file: PAY, quote: "const total = amountCents * 100;", category: "correctness", severity: "high", claim: "Converts cents to cents a second time", always: true },
  { by: ["finder-b"], file: PAY, quote: "for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {", category: "correctness", severity: "medium", claim: "The retry loop never terminates while send() keeps failing" },
  { by: ["finder-a", "finder-b"], file: PAY, quote: "return totalCents / parts;", category: "correctness", severity: "medium", claim: "splitEvenly() returns fractional cents; floor it and hand out the remainder" },
  { by: ["finder-a", "finder-b"], file: INVOICE, quote: "public decimal Total => Lines.Sum(l => l.Price);", category: "correctness", severity: "high", claim: "Total ignores each line's quantity" },
];

/** The line that implements each acceptance criterion, and the file it lives in. */
const EVIDENCE: Record<string, { file: string; quote: string }> = {
  "4711-AC1": { file: "src/pay.ts", quote: "for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {" },
  "4711-AC2": { file: "src/export.ts", quote: 'const header = "id,amount";' },
  "4712-AC1": { file: "appsettings.json", quote: '"InvoiceDueDays": 30' },
  "4712-AC2": { file: INVOICE, quote: "public DateTime DueDate => IssuedOn.AddDays(_options.InvoiceDueDays);" },
  "4713-AC1": { file: "docs/retry.md", quote: "A failed charge is retried three times before the order is cancelled." },
};

function finderAnswer(model: string, prompt: string): unknown {
  const findings = DEFECTS.filter((d) => d.by.includes(model) && (d.always || shows(prompt, d.quote))).map((d) => ({
    category: d.category,
    severity: d.severity,
    confidence: 0.8,
    file: d.file,
    quote: d.quote,
    context_before: null,
    context_after: null,
    side: "right",
    claim: d.claim,
    evidence: null,
    suggested_fix: null,
    cites: null,
  }));
  return { findings };
}

function skepticAnswer(prompt: string): unknown {
  // The one refutable claim: the loop's own bound is in the snippet the skeptic is shown.
  if (prompt.includes("never terminates")) {
    return {
      verdict: "refuted",
      reason: "attempt is bounded by MAX_RETRIES",
      evidence_quote: "for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {",
      confidence: 0.9,
      suggested_severity: null,
    };
  }
  return { verdict: "holds", reason: "the quoted line does what the claim says", evidence_quote: null, confidence: 0.8, suggested_severity: null };
}

function requirementAnswer(prompt: string): unknown {
  const criteria = Object.entries(EVIDENCE)
    .filter(([id]) => prompt.includes(`[${id}]`))
    .map(([criterionId, ev]) =>
      shows(prompt, ev.quote)
        ? { criterionId, verdict: "satisfied", note: "implemented", quote: ev.quote, file: ev.file }
        : { criterionId, verdict: "missing", note: "no change in the diff implements this", quote: null, file: null },
    );
  return { criteria, extras: [] };
}

function disputeAnswer(prompt: string): unknown {
  const verdicts = Object.entries(EVIDENCE)
    .filter(([id]) => prompt.includes(`[${id}]`))
    .map(([criterionId, ev]) =>
      shows(prompt, ev.quote)
        ? { criterionId, verdict: "refuted", reason: "the diff implements it", evidence_quote: ev.quote }
        : { criterionId, verdict: "holds", reason: "nothing in the diff implements it", evidence_quote: null },
    );
  return { verdicts };
}

/** Routes by the stage asking — its schema — never by arrival order: the stages run concurrently. */
function reviewer(call: RecordedCall): Responder {
  const schema = String((call.body["response_format"] as { json_schema?: { name?: string } } | undefined)?.json_schema?.name ?? "");
  const messages = (call.body["messages"] as Array<{ role: string; content: string }> | undefined) ?? [];
  const prompt = messages.find((m) => m.role === "user")?.content ?? "";
  const model = String(call.body["model"] ?? "");
  const json = (v: unknown) => completion(JSON.stringify(v), { prompt_tokens: 100, completion_tokens: 20 });
  switch (schema) {
    case "findings":
      return json(finderAnswer(model, prompt));
    case "verdict":
      return json(skepticAnswer(prompt));
    case "requirements":
      return json(requirementAnswer(prompt));
    case "req_dispute":
      return json(disputeAnswer(prompt));
    default:
      return httpError(500, JSON.stringify({ error: { message: `fake reviewer: no stage called ${schema}` } }));
  }
}

// ─── The run ─────────────────────────────────────────────────────────────────

let runsDir = "";
const ado = await fakeAdo({
  pr: {
    title: "Payments: retries and CSV export",
    description: "Adds retrying to charge() and a CSV export.",
    sourceRefName: "refs/heads/feature/payments",
    targetRefName: "refs/heads/main",
    createdBy: { displayName: "Alice" },
    status: "active",
  },
  iterations: [iteration(1)],
  changesFor,
  blobs: { [BLOB.pay1]: PAY_1, [BLOB.pay2]: PAY_2, [BLOB.export1]: EXPORT_1 },
  workItemRefs: [4711],
  workItems: {
    4711: {
      id: 4711,
      fields: {
        "System.Title": "Payments hardening",
        "System.WorkItemType": "User Story",
        "System.State": "Active",
        "Microsoft.VSTS.Common.AcceptanceCriteria": "<ul><li>A failed charge is retried before giving up</li><li>The CSV export starts with a header row</li></ul>",
      },
    },
  },
  selfIdentityId: BOT,
});
const models = await fakeOpenAI();
try {
  process.env["PRR_ADO_BASE_URL"] = ado.origin;
  process.env["PRR_ADO_PAT"] = "test-pat";
  process.env["PRR_ADO_MAX_RETRIES"] = "1";
  process.env["PRR_NO_PROXY"] = "127.0.0.1";
  process.env["PRR_RUNNER"] = "openai";
  process.env["PRR_LLM_BASE_URL"] = models.baseUrl;
  process.env["PRR_LLM_API_KEY"] = "test-key";
  process.env["PRR_LLM_STREAM"] = "0";
  process.env["PRR_LLM_RETRIES"] = "0";
  process.env["PRR_FINDER_MODELS"] = "finder-a,finder-b";
  process.env["PRR_SKEPTIC_MODELS"] = "skeptic-x";
  process.env["PRR_SKEPTIC_ROUNDS"] = "1";
  process.env["PRR_REQ_MODEL"] = "req-m";
  process.env["PRR_FINDER_SEED"] = "7";
  process.env["PRR_SKIP_STATIC"] = "1";
  process.env["PRR_POST_STATUS"] = "1";
  process.env["PRR_QUIET"] = "1";
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-e2e-runs-"));
  process.env["PRR_RUNS_DIR"] = runsDir;
  models.answerBy(reviewer);

  const { parsePrUrl } = await import("../ado/client");
  const { runReview, exitCodeFor } = await import("../orchestrator");
  const { createRunner } = await import("../models/runner");
  const { resolveLastReviewedIteration } = await import("../publish/lifecycle");
  const { readMarkers } = await import("../publish/markers");

  const ref = parsePrUrl("https://dev.azure.com/contoso/Shop/_git/shop-api/pullrequest/4821");
  const runner = await createRunner();

  const threadPosts = () => ado.matching("POST", /\/threads$/);
  const inlinePosts = () => threadPosts().filter((r) => r.body?.["threadContext"] !== undefined);
  const summaryOf = () =>
    ado.state.threads.flatMap((t) => t.comments ?? []).find((c) => readMarkers(c.content).summary)?.content ?? "";
  const summaryThreads = () => ado.state.threads.filter((t) => t.comments?.some((c) => readMarkers(c.content).summary));
  const contentOf = (r: { body?: Record<string, unknown> }) =>
    String(((r.body?.["comments"] as Array<{ content?: string }> | undefined) ?? [])[0]?.content ?? "");
  const lineOf = (r: { body?: Record<string, unknown> }) =>
    (r.body?.["threadContext"] as { rightFileStart?: { line?: number } } | undefined)?.rightFileStart?.line;
  const stageCalls = (schema: string) =>
    models.calls.filter((c) => (c.body["response_format"] as { json_schema?: { name?: string } } | undefined)?.json_schema?.name === schema);
  const userPrompt = (c: RecordedCall) =>
    ((c.body["messages"] as Array<{ role: string; content: string }> | undefined) ?? []).find((m) => m.role === "user")?.content ?? "";

  section("push 1, full review: what reaches the pull request");
  {
    const { value: result } = await capture(() => runReview({ ref, runner, compareTo: 0 }));

    eq("each finder is asked once", stageCalls("findings").length, 2);
    eq("every anchored finding meets a skeptic, the hallucinated one never does", stageCalls("verdict").length, 3);
    eq("the requirement axis is asked once, with no accusation to dispute", [stageCalls("requirements").length, stageCalls("req_dispute").length], [1, 0]);

    const posted = inlinePosts();
    eq("two comments are posted: the two findings both finders made and no skeptic refuted", posted.length, 2);
    const refund = posted.find((r) => contentOf(r).includes("adds the fee"));
    eq("the refund bug lands on its own line", lineOf(refund ?? {}), 11);
    eq("...of its own file", (refund?.body?.["threadContext"] as { filePath?: string } | undefined)?.filePath, "/src/pay.ts");
    check("...as found independently by both finders", contentOf(refund ?? {}).includes("found independently by 2 models"), contentOf(refund ?? {}));
    eq("the retry finding lands on line 5", lineOf(posted.find((r) => contentOf(r).includes("ends the retry loop")) ?? {}), 5);
    check("the refuted claim is posted nowhere", !posted.some((r) => contentOf(r).includes("never terminates")));
    check("the hallucinated quote is posted nowhere inline", !posted.some((r) => contentOf(r).includes("cents to cents")));

    const summary = summaryOf();
    eq("one summary thread", summaryThreads().length, 1);
    eq("...recording push 1 as the resume point", readMarkers(summary).iteration, 1);
    check("...naming the hallucination as unlocatable rather than dropping it", summary.includes("Converts cents to cents") && summary.includes("no locatable line"), summary);
    check("...and both criteria as implemented", summary.includes("All 2 acceptance criteria for #4711 are implemented"), summary);

    const statuses = ado.matching("POST", /\/statuses$/);
    eq("one status is posted", statuses.length, 1);
    eq("...and it fails the PR over the high-severity finding", statuses[0]?.body?.["state"], "failed");
    eq("the exit code agrees with the status", exitCodeFor(result), 2);
    eq("nothing is incomplete", result.incomplete, []);
  }

  section("push 2, --since auto: only the new push is reviewed, and nothing is said twice");
  {
    ado.state.iterations = [iteration(1), iteration(2)];
    ado.reset();
    models.reset();
    models.answerBy(reviewer);
    const threadsBefore = ado.state.threads.length;

    const since = await resolveLastReviewedIteration(ref);
    eq("the resume point is read back off the PR", since, 1);
    const { value: result } = await capture(() => runReview({ ref, runner, compareTo: since ?? 0 }));

    const changeReqs = ado.matching("GET", /\/iterations\/2\/changes$/);
    check("intake asks for the changes since push 1", changeReqs.some((r) => r.query["$compareTo"] === "1"), JSON.stringify(changeReqs.map((r) => r.query)));
    const finderPrompts = stageCalls("findings").map(userPrompt);
    check("the finders see the pushed file", finderPrompts.every((p) => p.includes("src/pay.ts")));
    check("...and not the one push 2 left alone", finderPrompts.every((p) => !p.includes("src/export.ts")));

    const posted = inlinePosts();
    eq("one new comment: the bug push 2 introduced", posted.length, 1);
    eq("...on the line it introduced it", lineOf(posted[0] ?? {}), 15);
    check("...with its own claim", contentOf(posted[0] ?? {}).includes("fractional cents"), contentOf(posted[0] ?? {}));
    eq("the finding both runs made is not posted again", ado.state.threads.length - threadsBefore, 1);
    eq("...and is reported as already commented", result.publishResult?.alreadyPosted.map((f) => f.anchor?.startLine), [5]);

    eq("the summary is edited in place, never duplicated", summaryThreads().length, 1);
    eq("...and the resume point moves to push 2", readMarkers(summaryOf()).iteration, 2);
    check("...with the scope stated as incremental", summaryOf().includes("iteration 1 → 2 (incremental)"), summaryOf().slice(0, 400));

    // The requirement axis judges the pull request, not the push. Judged against push 2
    // alone, both criteria — delivered by push 1 — came back "missing", the dispute pass saw
    // the same partial diff and let the accusation stand, and the status failed the PR for
    // work it already contained.
    const reqPrompt = userPrompt(stageCalls("requirements")[0] ?? ({ body: {} } as RecordedCall));
    check("the requirement axis is shown the file push 2 left alone", reqPrompt.includes("src/export.ts"), reqPrompt.slice(0, 300));
    eq("...so both criteria are still implemented", result.req?.criteria.map((c) => c.verdict), ["satisfied", "satisfied"]);
    eq("...and there is no accusation to dispute", stageCalls("req_dispute").length, 0);
    check("the summary says so, and on what basis", summaryOf().includes("All 2 acceptance criteria for #4711 are implemented") && summaryOf().includes("Judged against the whole pull request"), summaryOf());
    const statuses = ado.matching("POST", /\/statuses$/);
    eq("a status is posted for push 2", statuses.length, 1);
    eq("...and it passes: the new finding is medium and every criterion is met", statuses[0]?.body?.["state"], "succeeded");
    eq("the exit code agrees", exitCodeFor(result), 0);

    // The whole-PR read reuses what the incremental one fetched: blobs are content-addressed.
    const blobGets = ado.matching("GET", /\/blobs\/[0-9a-f]+$/).map((r) => r.path.split("/").pop());
    eq("no blob is fetched twice in one run", blobGets.length, new Set(blobGets).size);
  }

  section("the artifacts a run leaves behind");
  {
    const prDir = path.join(runsDir, "contoso", "Shop", "shop-api", "pr-4821");
    const runs = fs.existsSync(prDir) ? fs.readdirSync(prDir).filter((d) => d.startsWith("iter-")) : [];
    eq("one run directory per push", runs.map((d) => d.split("-").slice(0, 2).join("-")).sort(), ["iter-1", "iter-2"]);
    for (const d of runs.sort()) {
      const files = fs.readdirSync(path.join(prDir, d));
      check(
        `${d.split("-").slice(0, 2).join("-")} holds the prompts, the verdicts and the review`,
        ["finder-prompt.md", "skeptic.json", "findings.json", "publish.json", "review.html"].every((f) => files.includes(f)),
        files.join(", "),
      );
    }
  }

  /** Points the fake at another pull request: one push, these files, this work item. */
  const nextPr = (title: string, files: Record<string, { blob: string; text: string }>, workItem: Record<string, unknown>) => {
    ado.state.pr = { ...ado.state.pr, title, description: "" };
    ado.state.iterations = [iteration(1)];
    const entries = Object.entries(files).map(([file, f], i) => entry(`/${file}`, f.blob, 10 + i));
    ado.state.changesFor = () => [{ changeEntries: entries }];
    ado.state.blobs = Object.fromEntries(Object.values(files).map((f) => [f.blob, f.text]));
    ado.state.workItemRefs = [Number(workItem["id"])];
    ado.state.workItems = { [Number(workItem["id"])]: workItem };
    ado.state.threads = [];
    ado.reset();
    models.reset();
    models.answerBy(reviewer);
  };
  const story = (id: number, criteria: string[]) => ({
    id,
    fields: {
      "System.Title": `Story ${id}`,
      "System.WorkItemType": "User Story",
      "System.State": "Active",
      "Microsoft.VSTS.Common.AcceptanceCriteria": `<ul>${criteria.map((c) => `<li>${c}</li>`).join("")}</ul>`,
    },
  });

  section("a C# pull request: reviewed, not waved through as \"0 files\"");
  {
    // C# was not on the list of reviewable languages. A PR written in it had "no reviewable
    // code changes": no finder read it, the requirement axis was skipped along with them
    // although it does not depend on language, and the status read `Reviewed 0 files, no
    // blockers` — green, on exactly the PRs nobody had reviewed.
    const invoice = [
      "namespace Shop.Billing;",
      "",
      "public sealed class Invoice",
      "{",
      "    private readonly BillingOptions _options;",
      "",
      "    public Invoice(BillingOptions options, DateTime issuedOn, IReadOnlyList<Line> lines)",
      "    {",
      "        _options = options;",
      "        IssuedOn = issuedOn;",
      "        Lines = lines;",
      "    }",
      "",
      "    public DateTime IssuedOn { get; }",
      "    public IReadOnlyList<Line> Lines { get; }",
      "",
      "    public DateTime DueDate => IssuedOn.AddDays(_options.InvoiceDueDays);",
      "",
      "    public decimal Total => Lines.Sum(l => l.Price);",
      "}",
      "",
    ].join("\n");
    const settings = '{\n  "Billing": {\n    "InvoiceDueDays": 30\n  }\n}\n';
    nextPr(
      "Billing: invoices with a configurable due date",
      {
        [INVOICE]: { blob: "c5c5c5", text: invoice },
        "appsettings.json": { blob: "c6c6c6", text: settings },
        "build.zig": { blob: "c7c7c7", text: "const std = @import(\"std\");\n" },
      },
      story(4712, ["The invoice due period is configurable", "An invoice's due date follows from the configured period"]),
    );
    const csRef = parsePrUrl("https://dev.azure.com/contoso/Shop/_git/shop-api/pullrequest/4822");
    const { value: result } = await capture(() => runReview({ ref: csRef, runner, compareTo: 0 }));

    const finderPrompts = stageCalls("findings").map(userPrompt);
    eq("both finders are asked", finderPrompts.length, 2);
    check("...and read the C# file, as C#", finderPrompts.every((p) => p.includes(`### ${INVOICE} [add, csharp]`)), finderPrompts[0]?.slice(0, 600));
    check("...but not the settings file, which is not code", finderPrompts.every((p) => !p.includes("appsettings.json")));
    const posted = inlinePosts();
    eq("the C# bug is posted", posted.length, 1);
    eq("...on its line", lineOf(posted[0] ?? {}), 19);

    // A criterion met in a config file is not missing because the file is not code.
    const reqPrompt = userPrompt(stageCalls("requirements")[0] ?? ({ body: {} } as RecordedCall));
    check("the requirement axis reads the settings file", reqPrompt.includes("appsettings.json"), reqPrompt.slice(0, 300));
    eq("...so both criteria are met", result.req?.criteria.map((c) => c.verdict), ["satisfied", "satisfied"]);
    check("a file type prloop does not read is named, not silently dropped", summaryOf().includes("file type unknown to prloop: build.zig"), summaryOf());
    eq("the status fails the PR over the bug it found", ado.matching("POST", /\/statuses$/)[0]?.body?.["state"], "failed");
  }

  section("a pull request with no code: the requirement axis still runs, and nobody claims a review");
  {
    const doc = "# Retries\n\nA failed charge is retried three times before the order is cancelled.\n";
    nextPr("Document the retry policy", { "docs/retry.md": { blob: "d1d1d1", text: doc } }, story(4713, ["The retry policy is documented"]));
    const docsRef = parsePrUrl("https://dev.azure.com/contoso/Shop/_git/shop-api/pullrequest/4823");
    const { value: result } = await capture(() => runReview({ ref: docsRef, runner, compareTo: 0 }));

    eq("no finder is asked about a change with no code", stageCalls("findings").length, 0);
    eq("the requirement axis still is", stageCalls("requirements").length, 1);
    eq("...and finds the criterion met in the document", result.req?.criteria.map((c) => c.verdict), ["satisfied"]);
    check("the summary says there was no code, not that the code was clean",
      summaryOf().includes("No code in this change for the code check to review") && !summaryOf().includes("No issues found"), summaryOf());
    const status = ado.matching("POST", /\/statuses$/)[0]?.body;
    eq("the status passes", status?.["state"], "succeeded");
    check("...without claiming it reviewed anything", !String(status?.["description"] ?? "").includes("Reviewed 0 files"), String(status?.["description"]));
    eq("...and the exit code agrees", exitCodeFor(result), 0);
  }
} finally {
  await ado.close();
  await models.close();
  if (runsDir) fs.rmSync(runsDir, { recursive: true, force: true });
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
