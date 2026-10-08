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
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeAdo, type ChangePage } from "./fakes/ado";
import { completion, fakeOpenAI, httpError, type RecordedCall, type Responder } from "./fakes/openai";
import { capture, check, eq, report, section, skip } from "./selftest/harness";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  /** A claim a search of the code can settle (gates/claims.ts). */
  checkable?: { kind: string; subject: string };
  /** Seen only in a prompt this matches: a finding one review makes and an earlier one missed. */
  when?: (prompt: string) => boolean;
}

const PAY = "src/pay.ts";
const INVOICE = "src/Billing/Invoice.cs";
const DEFECTS: Defect[] = [
  { by: ["finder-a", "finder-b"], file: PAY, quote: "return amountCents + feeCents;", category: "correctness", severity: "high", claim: "refund() adds the fee to the amount instead of subtracting it" },
  { by: ["finder-a", "finder-b"], file: PAY, quote: "if (await send(amountCents)) return true;", category: "reliability", severity: "medium", claim: "An exception thrown by send() ends the retry loop instead of counting as a failed attempt" },
  { by: ["finder-a"], file: PAY, quote: "const total = amountCents * 100;", category: "correctness", severity: "high", claim: "Converts cents to cents a second time", always: true },
  { by: ["finder-b"], file: PAY, quote: "for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {", category: "correctness", severity: "medium", claim: "The retry loop never terminates while send() keeps failing" },
  { by: ["finder-a", "finder-b"], file: PAY, quote: "return totalCents / parts;", category: "correctness", severity: "medium", claim: "splitEvenly() returns fractional cents; floor it and hand out the remainder" },
  // The retry loop three lines down uses it: the claim checker settles this before any skeptic.
  { by: ["finder-a"], file: PAY, quote: "export const MAX_RETRIES = 3;", category: "correctness", severity: "medium", claim: "MAX_RETRIES is never used", checkable: { kind: "unused", subject: "MAX_RETRIES" } },
  { by: ["finder-a", "finder-b"], file: INVOICE, quote: "public decimal Total => Lines.Sum(l => l.Price);", category: "correctness", severity: "high", claim: "Total ignores each line's quantity" },
  // Push 1's code, noticed only once push 2 is under review: the earlier review missed it.
  { by: ["finder-a", "finder-b"], file: PAY, quote: "return false;", category: "reliability", severity: "medium", claim: "charge() returns the same false for a declined card and an unreachable gateway", when: (p) => p.includes("splitEvenly") },
];

/** The line that implements each acceptance criterion, and the file it lives in. */
const EVIDENCE: Record<string, { file: string; quote: string }> = {
  "4711-AC1": { file: "src/pay.ts", quote: "for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {" },
  "4711-AC2": { file: "src/export.ts", quote: 'const header = "id,amount";' },
  "4712-AC1": { file: "appsettings.json", quote: '"InvoiceDueDays": 30' },
  "4712-AC2": { file: INVOICE, quote: "public DateTime DueDate => IssuedOn.AddDays(_options.InvoiceDueDays);" },
  "4713-AC1": { file: "docs/retry.md", quote: "A failed charge is retried three times before the order is cancelled." },
  // The one work item a local review's --criteria file becomes.
  "1-AC1": { file: "src/pay.ts", quote: "export function splitEvenly(totalCents: number, parts: number): number {" },
};

function finderAnswer(model: string, prompt: string): unknown {
  const findings = DEFECTS.filter((d) => d.by.includes(model) && (d.always || shows(prompt, d.quote)) && (d.when?.(prompt) ?? true)).map((d) => ({
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
    claim_kind: d.checkable?.kind ?? null,
    claim_subject: d.checkable?.subject ?? null,
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

/**
 * The benchmark judge (scripts/bench.ts): a candidate is the reference's issue when both name
 * the same thing. Read out of the fences the prompt puts them in, so a candidate is judged on
 * what it says and a reference on what it says, never on the framing around them.
 */
const JUDGE_TOPICS = ["fractional", "fee", "header"];
function judgeAnswer(prompt: string): unknown {
  const reference = /<reference-comment>\n([\s\S]*?)\n<\/reference-comment>/.exec(prompt)?.[1]?.toLowerCase() ?? "";
  const list = /<candidate-comments>\n([\s\S]*?)\n<\/candidate-comments>/.exec(prompt)?.[1] ?? "";
  const topics = JUDGE_TOPICS.filter((t) => reference.includes(t));
  const same = list.split("\n").flatMap((l) => {
    const m = /^\[(\d+)\] /.exec(l);
    return m && topics.some((t) => l.toLowerCase().includes(t)) ? [Number(m[1])] : [];
  });
  return { same_issue: same, reason: same.length > 0 ? "the same problem" : "different problems" };
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
    case "judge":
      return json(judgeAnswer(prompt));
    default:
      return httpError(500, JSON.stringify({ error: { message: `fake reviewer: no stage called ${schema}` } }));
  }
}

// ─── Local repositories and scripts, for the sections that run without ADO ───

/** A throwaway repository whose `feature` branch adds splitEvenly — and its bug — to PAY_1. */
function payRepo(prefix: string): { repo: string; git: (...args: string[]) => string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.invalid");
  git("config", "user.name", "e2e");
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "pay.ts"), PAY_1);
  git("add", ".");
  git("commit", "-q", "-m", "payments");
  git("checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(repo, "src", "pay.ts"), PAY_2);
  git("commit", "-q", "-am", "split evenly");
  git("checkout", "-q", "main");
  return { repo, git };
}

/**
 * One of this repository's scripts in its own process, as a user runs it — and asynchronously,
 * because the fake endpoints answering it live in this one. A script that hangs fails the net
 * instead of stalling CI until the job's own timeout.
 */
function script(name: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "scripts", name), ...args],
      { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    const timer = setTimeout(() => child.kill(), 180_000);
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
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
  // The team's Copilot instructions for its TypeScript, and a CLAUDE.md for a directory the
  // pull request never touches.
  items: {
    "/.github/instructions/money.instructions.md": { body: '---\napplyTo: "src/**/*.ts"\n---\nAmounts are integer cents.' },
    "/docs/CLAUDE.md": { body: "Docs are British English." },
  },
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
  process.env["PRR_SAVE_REPLAY"] = "1";
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-e2e-runs-"));
  process.env["PRR_RUNS_DIR"] = runsDir;
  models.answerBy(reviewer);

  const { parsePrUrl } = await import("../ado/client");
  const { adoHost } = await import("../ado/host");
  const { runReview, exitCodeFor } = await import("../orchestrator");
  const { createRunner } = await import("../models/runner");
  const { resolveLastReviewedIteration } = await import("../publish/lifecycle");
  const { BOT_MARKER, SUMMARY_MARKER, readMarkers } = await import("../publish/markers");

  const ref = parsePrUrl("https://dev.azure.com/contoso/Shop/_git/shop-api/pullrequest/4821");
  const host = adoHost(ref);
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
  const wholePrompt = (c: RecordedCall) =>
    ((c.body["messages"] as Array<{ role: string; content: string }> | undefined) ?? []).map((m) => m.content).join("\n");

  section("push 1, full review: what reaches the pull request");
  {
    const { value: result } = await capture(() => runReview({ host, runner, compareTo: 0 }));

    eq("each finder is asked once", stageCalls("findings").length, 2);
    check(
      "...with the team's Copilot instructions for the files it reads, and their scope",
      stageCalls("findings").every((c) => wholePrompt(c).includes("Amounts are integer cents.") && wholePrompt(c).includes("Applies to: src/**/*.ts")),
      wholePrompt(stageCalls("findings")[0] ?? ({ body: {} } as RecordedCall)).slice(0, 1500),
    );
    check("...but not a directory's CLAUDE.md the change never touches", stageCalls("findings").every((c) => !wholePrompt(c).includes("British English")));
    eq(
      "every anchored finding meets a skeptic — not the hallucinated one, and not the one the code contradicts",
      stageCalls("verdict").length,
      3,
    );
    check("...no skeptic is shown the claim the code settled", stageCalls("verdict").every((c) => !userPrompt(c).includes("MAX_RETRIES is never used")));
    const skepticRows = JSON.parse(fs.readFileSync(path.join(result.runDir, "skeptic.json"), "utf8")) as Array<{
      claim: string;
      killed: boolean;
      verdicts: Array<{ model: string; reason: string }>;
    }>;
    const settled = skepticRows.find((r) => r.claim === "MAX_RETRIES is never used");
    eq(
      "...it is refuted by the claim checker, with the line that uses it",
      [settled?.killed, settled?.verdicts[0]?.model, settled?.verdicts[0]?.reason],
      [true, "claim-check", "`MAX_RETRIES` is used at src/pay.ts:4"],
    );
    eq("the requirement axis is asked once, with no accusation to dispute", [stageCalls("requirements").length, stageCalls("req_dispute").length], [1, 0]);
    // response_format alone did not reach a gateway that accepts it without enforcing it; the
    // prompt names the shape too.
    const structured = [...stageCalls("findings"), ...stageCalls("requirements"), ...stageCalls("verdict")];
    check(
      "every structured call names its answer's keys",
      structured.length > 0 && structured.every((c) => userPrompt(c).includes("whose top-level keys are exactly")),
    );

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
    check("...naming the instructions it read", summaryOf().includes("Repository instructions read: /.github/instructions/money.instructions.md"), summaryOf());
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

    const since = await resolveLastReviewedIteration(host);
    eq("the resume point is read back off the PR", since, 1);
    const { value: result } = await capture(() => runReview({ host, runner, compareTo: since ?? 0 }));

    const changeReqs = ado.matching("GET", /\/iterations\/2\/changes$/);
    check("intake asks for the changes since push 1", changeReqs.some((r) => r.query["$compareTo"] === "1"), JSON.stringify(changeReqs.map((r) => r.query)));
    const finderPrompts = stageCalls("findings").map(userPrompt);
    check("the finders see the pushed file", finderPrompts.every((p) => p.includes("src/pay.ts")));
    check("...and not the one push 2 left alone", finderPrompts.every((p) => !p.includes("src/export.ts")));
    // Sixteen lines: short enough to be shown whole, so the finders also see code the push did
    // not touch — and one of them reports the retry loop four lines above the change.
    check("...shown whole, being short", finderPrompts.every((p) => p.includes("### src/pay.ts [edit, typescript, whole file]")), finderPrompts[0]?.slice(0, 200));
    const outside = result.agg.degraded.find((f) => f.claim.includes("never terminates"));
    eq("a finding on code the push did not change is kept off the lines", outside?.anchorFailure, "outside-changed-lines");

    const posted = inlinePosts();
    eq("one new comment: the bug push 2 introduced", posted.length, 1);
    eq("...on the line it introduced it", lineOf(posted[0] ?? {}), 15);
    check("...with its own claim", contentOf(posted[0] ?? {}).includes("fractional cents"), contentOf(posted[0] ?? {}));
    eq("the finding both runs made is not posted again", ado.state.threads.length - threadsBefore, 1);
    check("...nor verified again: push 1 already did", stageCalls("verdict").every((c) => !userPrompt(c).includes("ends the retry loop")));
    check(
      "the run says how long each stage took",
      ["intake", "conventions", "static", "finders", "claims", "skeptic", "triage", "publish"].every((k) => typeof result.timings?.[k] === "number"),
      JSON.stringify(result.timings),
    );
    eq("...and is reported as already commented", result.publishResult?.alreadyPosted.map((f) => f.anchor?.startLine), [5]);
    // Line 5 is push 1's code and push 2 left it alone: a new finding there would have been
    // listed rather than commented, and this one, commented by push 1, is said to be.
    eq("...filed as on lines this push did not touch", result.agg.belowBar.find((f) => f.claim.includes("ends the retry loop"))?.suppressedBy, "pre-existing");
    // Line 7 is push 1's code too, found only now: the review of push 1 missed it.
    check(
      "a finding in code an earlier push wrote, not commented before, is previously missed",
      /Previously missed \(1\)[^<]*<\/summary>\s*- \*\*medium\*\* `src\/pay\.ts:7` — charge\(\) returns the same false/.test(summaryOf()),
      summaryOf(),
    );
    check(
      "...and listed so, with the comment an earlier run left",
      /On lines this push did not touch \(1\)[\s\S]*ends the retry loop[^\n]*_\(commented by an earlier run\)_/.test(summaryOf()),
      summaryOf(),
    );

    // Push 2 fixed the refund bug. The comment records the code it was about, and that code
    // is gone; the retry comment's code is still there, one push later and unchanged.
    const statusOf = (claim: string) =>
      ado.state.threads.find((t) => t.comments?.some((c) => (c.content ?? "").includes(claim)))?.status;
    eq("the comment on the fixed refund bug is closed", statusOf("adds the fee"), "fixed");
    eq("...the one on code still there stays open", statusOf("ends the retry loop"), "active");
    eq("...and the run counts it", result.publishResult?.resolved, 1);
    check("...and says so in the summary", summaryOf().includes("**1** closed by this run"), summaryOf());

    eq("the summary is edited in place, never duplicated", summaryThreads().length, 1);
    eq("...and the resume point moves to push 2", readMarkers(summaryOf()).iteration, 2);
    check("...with the scope stated as incremental", summaryOf().includes("iteration 1 → 2 (incremental)"), summaryOf().slice(0, 400));

    // The requirement axis judges the pull request, not the push. Judged against push 2
    // alone, both criteria — delivered by push 1 — came back "missing", the dispute pass saw
    // the same partial diff and let the accusation stand, and the status failed the PR for
    // work it already contained.
    const reqPrompt = userPrompt(stageCalls("requirements")[0] ?? ({ body: {} } as RecordedCall));
    check("the requirement axis is shown the file push 2 left alone", reqPrompt.includes("src/export.ts"), reqPrompt.slice(0, 300));
    check("a pull request with no OpenSpec documents gets no Not-shown line", !reqPrompt.includes("Not shown:"));
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
    const { replay } = await import("../libs/replay");
    for (const d of runs.sort()) {
      const files = fs.readdirSync(path.join(prDir, d));
      const iter = d.split("-").slice(0, 2).join("-");
      check(
        `${iter} holds the prompts, the verdicts and the review`,
        ["finder-prompt.md", "skeptic.json", "findings.json", "publish.json", "review.html", "stamp.json", "replay.json"].every((f) => files.includes(f)),
        files.join(", "),
      );
      // Everything after the models is deterministic TypeScript: replayed from the saved
      // answers, the run must reach the same comments without a single model call.
      const saved = JSON.parse(fs.readFileSync(path.join(prDir, d, "findings.json"), "utf8")) as { inline: Array<{ fingerprint: string }>; belowBar: Array<{ fingerprint: string }> };
      const again = replay(JSON.parse(fs.readFileSync(path.join(prDir, d, "replay.json"), "utf8")));
      eq(`${iter} replays offline to the same inline findings`, again.agg.inline.map((f) => f.fingerprint).sort(), saved.inline.map((f) => f.fingerprint).sort());
      eq(`...and the same ones below the bar`, again.agg.belowBar.map((f) => f.fingerprint).sort(), saved.belowBar.map((f) => f.fingerprint).sort());
      eq(`...with every candidate covered by a saved verdict`, again.unverified, 0);
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
    const { value: result } = await capture(() => runReview({ host: adoHost(csRef), runner, compareTo: 0 }));

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
    const { value: result } = await capture(() => runReview({ host: adoHost(docsRef), runner, compareTo: 0 }));

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

  section("an interrupted run gives the pull request back, instead of holding it for an hour");
  {
    // Ctrl-C mid-review exited at once and left the run's lease in the summary, so every run on
    // that pull request for the next PRR_RUN_LEASE_MS stood down with "run … still holds this
    // pull request" — the first thing somebody meets who stops a run to fix a setting. The CLI
    // in its own process, as a person runs it, interrupted while its models are answering.
    if (process.platform === "win32") {
      skip("an interrupted run gives the lease back", "a test cannot send Windows a Ctrl-C: child.kill is TerminateProcess, which runs no handler");
    } else {
      nextPr("Retry the refund", { "src/pay.ts": { blob: BLOB.pay1, text: PAY_1 } }, story(4714, ["A refund is retried"]));
      // A lease lives in the summary an earlier run left; a pull request with none has no lease.
      ado.state.threads = [
        {
          id: 4900,
          status: "closed",
          comments: [{ id: 990, content: `${BOT_MARKER}${SUMMARY_MARKER}\n## prloop review\n\nNothing blocking.\n<!-- prloop:iteration=1 -->`, author: { id: BOT } }],
        },
      ];
      // Every model call gets its headers and then nothing, so the run is mid-review.
      models.answerBy(() => (res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
      });
      const held = () => readMarkers(summaryOf()).run;
      const child = spawn(
        process.execPath,
        [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "loop.ts"), "https://dev.azure.com/contoso/Shop/_git/shop-api/pullrequest/4824"],
        { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      child.stderr.on("data", (c: Buffer) => (out += c.toString()));
      const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
      const deadline = Date.now() + 60_000;
      while (!(held() && models.calls.length > 0) && child.exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      check("the run takes the pull request and starts asking its models", held() !== undefined && models.calls.length > 0, out.slice(-800));
      child.kill("SIGINT");
      const killer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      const code = await exited;
      clearTimeout(killer);
      eq("Ctrl-C exits 130", code, 130);
      eq("...after giving the pull request back", held(), undefined);
      check("...and says what it is doing", out.includes("interrupted: giving the pull request back"), out.slice(-800));
      models.answerBy(reviewer);
    }
  }

  section("a local branch, reviewed end to end: real pipeline, no pull request, nothing posted");
  {
    // scripts/local-review.ts only built prompts and matched quotes; nothing reviewed a branch
    // before it became a PR, and nothing could run a benchmark's repositories through the
    // real pipeline. `review` does both, as a dry run by construction.
    const { repo, git } = payRepo("prloop-local-");
    // A CLAUDE.md beside the code, on the base branch: read from the repository's own history.
    fs.writeFileSync(path.join(repo, "src", "CLAUDE.md"), "Money is integer cents.\n");
    git("add", ".");
    git("commit", "-q", "-m", "house rules");
    const localRuns = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-local-runs-"));
    try {
      const criteria = path.join(localRuns, "criteria.md");
      fs.writeFileSync(criteria, "- Splitting a total evenly is supported\n");
      models.reset();
      models.answerBy(reviewer);
      ado.reset();
      const res = await script("local-review.ts", ["review", repo, "main", "feature", "--criteria", criteria], {
        PRR_RUNS_DIR: localRuns,
        PRR_DRY_RUN: "",
      });
      check("the local review ran", res.out.includes("Reviewed 1 files"), res.out.slice(-800));
      check("...and reported the bug the branch introduced", res.out.includes("fractional cents"), res.out.slice(-800));
      check(
        "...with the CLAUDE.md of the directory it changed, read at the base",
        stageCalls("findings").some((c) => wholePrompt(c).includes("Money is integer cents.") && wholePrompt(c).includes("Applies to: files under src/")),
      );
      eq("...judged the criteria file", stageCalls("requirements").length, 1);
      eq("...and exited clean: the finding is medium and the criterion is met", res.code, 0);
      eq("nothing was sent to Azure DevOps at all", ado.requests.length, 0);
      const review = fs.readdirSync(localRuns, { recursive: true }).map(String).find((p) => p.endsWith("review.html"));
      check("the run directory holds the review", review !== undefined);

      // The same branch under PRR_RISK_TIERS: six changed lines in one file is a trivial change.
      models.reset();
      models.answerBy(reviewer);
      const tieredRuns = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-local-tiered-"));
      try {
        const tiered = await script("local-review.ts", ["review", repo, "main", "feature"], {
          PRR_RUNS_DIR: tieredRuns,
          PRR_DRY_RUN: "",
          PRR_RISK_TIERS: "1",
        });
        eq("under risk tiers a small branch is read by one finder", stageCalls("findings").map((c) => c.body["model"]), ["finder-a"]);
        check("...and its medium finding is held to the trivial tier's bar of high", tiered.code === 0 && tiered.out.includes("Reviewed 1 files: 0 comments"), tiered.out.slice(-800));
        const contextFile = fs.readdirSync(tieredRuns, { recursive: true }).map(String).find((p) => p.endsWith("context.json"));
        const recorded = contextFile ? (JSON.parse(fs.readFileSync(path.join(tieredRuns, contextFile), "utf8")) as { tier?: { name?: string; reason?: string } }).tier : undefined;
        eq("...the tier and why recorded with the run", [recorded?.name, recorded?.reason], ["trivial", "6 changed lines in 1 file"]);
      } finally {
        fs.rmSync(tieredRuns, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(localRuns, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  section("a benchmark, end to end: run twice, score by line and by judge, compare, one configuration per directory");
  {
    // scripts/bench.ts drives local-review in child processes, pins each case to commits, and
    // scores what the runs left on disk — every step its own process here, as a user runs it.
    const { repo, git } = payRepo("prloop-bench-upstream-");
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-bench-"));
    try {
      const main = git("rev-parse", "main");
      const feature = git("rev-parse", "feature");
      // GitHub keeps a pull request's head at refs/pull/<n>/head, and so does this upstream.
      git("update-ref", "refs/pull/7/head", feature);
      const located = path.join(work, "located.json");
      const textOnly = path.join(work, "text-only.json");
      fs.writeFileSync(
        located,
        JSON.stringify({
          name: "located",
          source: "selftest",
          cases: [
            {
              id: "shop@1",
              repo,
              base: main,
              head: feature,
              references: [
                { id: "shop@1#1", text: "splitEvenly() returns fractional cents", file: "src/pay.ts", lines: [15, 15], category: "Code Defect" },
                { id: "shop@1#2", text: "refund() no longer gives the fee back", file: "src/pay.ts", lines: [11, 11], category: "Code Defect" },
                { id: "shop@1#3", text: "the old refund added the fee", file: "src/pay.ts", lines: [11, 11], side: "left", category: "Maintainability" },
              ],
            },
          ],
        }),
      );
      fs.writeFileSync(
        textOnly,
        JSON.stringify({
          name: "text-only",
          source: "selftest",
          cases: [
            {
              id: "shop#7",
              repo,
              pr: 7,
              references: [
                { id: "shop#7#1", text: "Splitting a total evenly can yield fractional cents" },
                { id: "shop#7#2", text: "The CSV export is missing its header row" },
              ],
            },
          ],
        }),
      );
      models.reset();
      models.answerBy(reviewer);
      ado.reset();
      const out = path.join(work, "out");
      const repos = path.join(work, "repos");
      const bench = (...args: string[]) => script("bench.ts", args);

      const ran = await bench("run", located, out, "--repeat", "2", "--repos", repos);
      // One comment a run: the finding on the retry loop is on code the branch did not touch.
      check("bench run reviews the case twice", ran.code === 0 && ran.out.includes("run 2/2: 1 inline comment ("), ran.out.slice(-1500));
      eq("...with both finders each time", stageCalls("findings").length, 4);
      const pinned = JSON.parse(fs.readFileSync(located, "utf8")) as { cases: Array<{ base: string; head: string; resolvedBy?: string }> };
      eq("the suite is pinned to the commits reviewed", [pinned.cases[0]?.base, pinned.cases[0]?.head, pinned.cases[0]?.resolvedBy], [main, feature, "base from the dataset"]);
      const resumed = await bench("run", located, out, "--repeat", "2", "--repos", repos);
      check("a second run of the same command resumes: nothing left to review", resumed.code === 0 && stageCalls("findings").length === 4, resumed.out.slice(-800));

      const byLine = await bench("score", located, out);
      check("score, by location", byLine.code === 0 && byLine.out.includes("Recall, on the reference's lines (±1): 33.3% of 3 references"), byLine.out.slice(-2500));
      check("...per run and in any run", byLine.out.includes("(run 1 33.3%, run 2 33.3%; hit in any run 33.3%)"), byLine.out.slice(-2500));
      check("...precision over the inline comments", byLine.out.includes("Precision: 100.0% of 2 inline comments"), byLine.out.slice(-2500));
      check("...and the noise the repeat measured", byLine.out.includes("Noise: one run's recall moves by ±0.0 pt"), byLine.out.slice(-2500));
      check("a reference on deleted lines is named, not silently unreachable", byLine.out.includes("1 reference is on deleted lines"), byLine.out.slice(-2500));
      const score = JSON.parse(fs.readFileSync(path.join(out, "score.json"), "utf8")) as {
        primary: string;
        cases: Array<{ runs: Array<{ line?: Array<{ ref: string; stage: string }> }> }>;
      };
      eq(
        "each reference is filed under the furthest stage it reached",
        score.cases[0]?.runs[0]?.line?.map((o) => o.stage),
        // The hit; a hallucinated quote on the same file that would not anchor; a deleted line.
        ["inline", "anchor-failed", "not-found"],
      );
      eq("...in both runs", score.cases[0]?.runs.length, 2);

      const judged = await bench("score", located, out, "--judge", "judge-m");
      check("the judge is a second, labelled number", judged.code === 0 && judged.out.includes("Secondary, the judge on the same candidates:"), judged.out.slice(-2500));
      check("...naming the judge", judged.out.includes("judged by judge-m (prompt "), judged.out.slice(-2500));
      eq("...asked only about what is on a reference's lines, once per distinct question", stageCalls("judge").length, 2);
      const rejudged = await bench("score", located, out, "--judge", "judge-m");
      check("re-scoring under the same judge costs no call", rejudged.out.includes("0 judge calls made") && stageCalls("judge").length === 2, rejudged.out.slice(-600));

      fs.copyFileSync(path.join(out, "score.json"), path.join(work, "baseline.json"));
      const compared = await bench("compare", path.join(work, "baseline.json"), path.join(out, "score.json"));
      check("compare: two scores of the same runs are within noise", compared.code === 0 && compared.out.includes("Within noise"), compared.out);

      const textOut = path.join(work, "text-out");
      const textRun = await bench("run", textOnly, textOut, "--repos", repos);
      const textSuite = JSON.parse(fs.readFileSync(textOnly, "utf8")) as { cases: Array<{ base?: string; head?: string; resolvedBy?: string }> };
      check("a pull request with no base is resolved from git alone", textRun.code === 0, textRun.out.slice(-1500));
      eq(
        "...its head from refs/pull/7/head and its base from the merge base",
        [textSuite.cases[0]?.head, textSuite.cases[0]?.base, textSuite.cases[0]?.resolvedBy],
        [feature, main, "head from refs/pull/7/head; base = merge base with main"],
      );
      const noJudge = await bench("score", textOnly, textOut);
      check("references with no location refuse a score without a judge", noJudge.code === 1 && noJudge.out.includes("only a judge can match them"), noJudge.out.slice(-600));
      const textScore = await bench("score", textOnly, textOut, "--judge", "judge-m");
      check("...and are scored by it", textScore.code === 0 && textScore.out.includes("Recall, the same issue, judged by judge-m"), textScore.out.slice(-2500));
      check("...one of two found", textScore.out.includes("50.0% of 2 references"), textScore.out.slice(-2500));

      const mixed = await script("bench.ts", ["run", located, out, "--repeat", "3", "--repos", repos], { PRR_MIN_INLINE_SEVERITY: "high" });
      check("a run under another configuration is refused, not averaged in", mixed.code === 1 && mixed.out.includes("the run was removed"), mixed.out.slice(-1200));
      check("...and leaves nothing behind", !fs.existsSync(path.join(out, "runs", "shop_1", "run-3")));
      eq("no step of any of it talked to Azure DevOps", ado.requests.length, 0);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }
} finally {
  await ado.close();
  await models.close();
  if (runsDir) fs.rmSync(runsDir, { recursive: true, force: true });
}

report();
