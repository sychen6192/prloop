// Offline self-test for publishing: the step that WRITES to the pull request.
//
// publish() is the only module in the pipeline whose mistakes are visible to everyone on the
// PR, and until now every one of its pure helpers was covered and none of its side effects
// were. The failures it has to keep out are all shaped the same way — a comment that should
// not have been written, or one that should have been and was not:
//   - a second summary thread, which breaks `--since auto` (it trusts the first marker it finds)
//   - the same finding posted again on the next push (the "re-review amnesia" failure)
//   - a code finding deleted because a REQUIREMENT thread happened to sit on its lines
//   - a run that could not post its comments reporting itself as clean
//   - a dry run that writes anything at all
// None of those can be seen from the return value alone; they are facts about the requests.
// So a fake ADO answers on a real socket and the assertions read its request log.
//
// Its own file, and the server starts before the imports: config reads PRR_ADO_BASE_URL and
// PRR_ADO_PAT once at import time, and the fake's port only exists at run time.
import { fakeAdo, type FakeAdoState, type FakeThread } from "./fakes/ado";
import type { AnchoredFinding, FileDiff } from "../libs/types";
import type { ReviewContext } from "../ado/intake";
import type { SummaryInput } from "../publish/format";

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

/** publish() logs its way through; keep that out of the assertion stream, but keep it. */
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

const ado = await fakeAdo();
try {
  process.env["PRR_ADO_BASE_URL"] = ado.origin;
  process.env["PRR_ADO_PAT"] = "test-pat";
  process.env["PRR_NO_PROXY"] = "127.0.0.1";
  process.env["PRR_POST_STATUS"] = "1";
  // The dismissal store writes JSONL under runs/; a selftest must not touch the operator's.
  process.env["PRR_LEARN_FROM_DISMISSALS"] = "0";
  process.env["PRR_QUIET"] = "1";

  const { parsePrUrl } = await import("../ado/client");
  const { publish } = await import("../publish/publish");
  const { SUMMARY_MARKER, fpMarker, catMarker } = await import("../publish/format");
  const { BOT_MARKER } = await import("../config");
  const { FileIndex } = await import("../libs/fileindex");

  const ref = parsePrUrl("https://dev.azure.com/contoso/Shop/_git/shop-api/pullrequest/4821");

  const mkFile = (path: string, lines: number): FileDiff => ({
    path,
    changeType: "edit",
    hunks: [{ rightStart: 1, rightCount: lines, leftStart: 1, leftCount: lines, body: "" }],
    rightLines: Array.from({ length: lines }, (_, i) => `line ${i + 1}`),
    leftLines: [],
    changedRightLines: new Set(Array.from({ length: lines }, (_, i) => i + 1)),
    binary: false,
    truncated: false,
    language: "typescript",
  });

  const files = [mkFile("src/app.ts", 40), mkFile("src/pay.ts", 40)];
  const ctx = {
    ref,
    pr: { title: "PR", description: "", sourceBranch: "feature", targetBranch: "main", createdBy: "Alice", status: "active" },
    iterations: [],
    iteration: { id: 3, sourceRefCommit: "src3", targetRefCommit: "tgt3", commonRefCommit: "base3", createdDate: "" },
    compareTo: 0,
    files,
    skipped: [],
    changeTrackingIds: new Map<string, number>([["src/app.ts", 11], ["src/pay.ts", 12]]),
    fileIndex: new FileIndex(files),
  } as ReviewContext;

  const finding = (over: Partial<AnchoredFinding> & { fingerprint: string }): AnchoredFinding => ({
    category: "correctness",
    severity: "high",
    confidence: 0.8,
    file: "src/app.ts",
    quote: "line 11",
    claim: "Off-by-one in the retry loop.",
    sources: ["qwen3-coder"],
    anchor: { side: "right", startLine: 11, endLine: 11, startOffset: 1, endOffset: 8 },
    ...over,
  });

  const summaryInput = (over: Partial<SummaryInput> = {}): SummaryInput => ({
    ctx,
    agg: {
      inline: [],
      belowBar: [],
      degraded: [],
      stats: { raw: 0, afterDedupe: 0, anchored: 0, survived: 0, refuted: 0, inline: 0, byFailure: {}, excluded: 0, dismissed: 0 },
    },
    finderErrors: [],
    omittedFiles: [],
    appliedRules: [],
    durationSec: 12,
    runDir: "",
    ...over,
  });

  /** A prloop comment as a previous run would have left it on the PR. */
  const ourComment = (id: number, body: string, fp?: string, cat?: string) => ({
    id,
    content: `${BOT_MARKER}${fp ? fpMarker(fp) : ""}${cat ? catMarker(cat) : ""}\n${body}`,
  });

  const setState = (partial: Partial<FakeAdoState>) => {
    Object.assign(ado.state, { threads: [], rejectThreadPost: undefined, ...partial });
    ado.reset();
  };

  const threadPosts = () => ado.matching("POST", /\/threads$/);
  const commentPatches = () => ado.matching("PATCH", /\/threads\/\d+\/comments\/\d+$/);
  const contentOf = (r: { body?: Record<string, unknown> }) =>
    String(((r.body?.["comments"] as Array<{ content?: string }> | undefined) ?? [])[0]?.content ?? "");

  section("the sticky summary: edited in place, because a second one breaks --since auto");
  {
    // `--since auto` resumes from the iteration marker in the FIRST summary it finds. A
    // duplicate summary thread therefore does not just look untidy — it pins the resume
    // point to whichever copy ADO returns first, forever.
    const existing: FakeThread = {
      id: 4001,
      status: "closed",
      comments: [{ id: 77, content: `${BOT_MARKER}${SUMMARY_MARKER}\n## previous run\n<!-- prloop:iteration=2 -->` }],
    };
    setState({ threads: [existing] });
    const { value: result } = await capture(() => publish(ref, { requirement: [], code: [] }, summaryInput()));

    eq("the existing summary comment is PATCHed", commentPatches().length, 1);
    eq("...and no new thread is created for it", threadPosts().length, 0);
    eq("...and it stays the same thread", result.summaryThreadId, 4001);
    const patched = String(commentPatches()[0]?.body?.["content"] ?? "");
    check("the edit carries this iteration's marker forward", patched.includes("<!-- prloop:iteration=3 -->"), patched.slice(0, 80));
    check("...and is still recognisable as the summary", patched.includes(SUMMARY_MARKER));

    // First run on a PR: there is nothing to edit, so one thread is created — closed, so it
    // never trips a "comment resolution required" policy.
    setState({ threads: [] });
    const { value: fresh } = await capture(() => publish(ref, { requirement: [], code: [] }, summaryInput()));
    eq("with no prior summary, exactly one thread is posted", threadPosts().length, 1);
    eq("...as a closed thread, not an active one", threadPosts()[0]?.body?.["status"], "closed");
    check("...and the id comes back for the caller", typeof fresh.summaryThreadId === "number");
    eq("...with nothing patched", commentPatches().length, 0);
  }

  section("re-review amnesia: a finding already on the PR is not posted twice");
  {
    // The fingerprint is the identity of an issue across pushes. A run that re-posts what an
    // earlier run already said is the single most-cited reason teams switch a review bot off.
    const seen = finding({ fingerprint: "aaaa1111" });
    setState({
      threads: [
        {
          id: 4100,
          status: "active",
          comments: [ourComment(81, "Off-by-one in the retry loop.", "aaaa1111", "correctness")],
          threadContext: { filePath: "/src/pay.ts", rightFileStart: { line: 30 }, rightFileEnd: { line: 30 } },
        },
      ],
    });
    const { value: result } = await capture(() =>
      publish(ref, { requirement: [], code: [seen] }, summaryInput({ agg: summaryInput().agg })),
    );
    eq("the finding is reported as already posted", result.alreadyPosted.map((f) => f.fingerprint), ["aaaa1111"]);
    eq("...and nothing new is posted for it", result.posted.length, 0);
    // The only POST is the summary — the finding cost zero writes.
    eq("...so the only thread POST is the summary itself", threadPosts().length, 1);
    check("...and that one is the summary", contentOf(threadPosts()[0]!).includes(SUMMARY_MARKER));
  }

  section("position dedupe is scoped to one axis: the two axes must not delete each other");
  {
    // Models do not reproduce a quote byte-for-byte across runs, so a rephrased finding on
    // the same lines gets a new fingerprint. An existing thread on those lines is the
    // stronger signal — but only if OUR axis is the one that put it there. This leaked once:
    // a requirement thread on lines 10-12 silently swallowed a new critical code finding on
    // line 11, which is the "two blind axes" invariant being broken at the last step.
    const priorCodeThread: FakeThread = {
      id: 4200,
      status: "active",
      comments: [ourComment(91, "Same lines, said differently last time.", "old-fp-1", "correctness")],
      threadContext: { filePath: "/src/app.ts", rightFileStart: { line: 10 }, rightFileEnd: { line: 12 } },
    };
    const codeAgain = finding({ fingerprint: "bbbb2222", claim: "A rephrasing of the same problem." });
    const requirementHere = finding({
      fingerprint: "cccc3333",
      category: "req-mismatch",
      claim: "Acceptance criterion 2 is not implemented here.",
    });

    setState({ threads: [priorCodeThread] });
    const { value: result } = await capture(() =>
      publish(ref, { requirement: [requirementHere], code: [codeAgain] }, summaryInput()),
    );
    eq("a same-axis finding on covered lines is suppressed", result.alreadyPosted.map((f) => f.fingerprint), ["bbbb2222"]);
    eq("...while the OTHER axis still gets its comment", result.posted.map((f) => f.fingerprint), ["cccc3333"]);
    const posted = threadPosts().filter((r) => !contentOf(r).includes(SUMMARY_MARKER));
    eq("...as exactly one inline thread", posted.length, 1);
    check("...carrying the requirement category marker", contentOf(posted[0]!).includes(catMarker("req-mismatch")));

    // And the shape of that write, which is where "comments on the wrong line" is won:
    // both ends of the span, the iteration context, and the change tracking id ADO needs
    // for the thread to survive the next push.
    const ctxSent = posted[0]?.body?.["threadContext"] as Record<string, unknown> | undefined;
    eq("the thread names the file with ADO's leading slash", ctxSent?.["filePath"], "/src/app.ts");
    eq("...with a start position", JSON.stringify(ctxSent?.["rightFileStart"]), '{"line":11,"offset":1}');
    check("...and an end position (a half-specified span breaks the ADO UI)", ctxSent?.["rightFileEnd"] !== undefined);
    const prCtx = posted[0]?.body?.["pullRequestThreadContext"] as Record<string, unknown> | undefined;
    eq("...and the change tracking id from intake", prCtx?.["changeTrackingId"], 11);
    eq("...pinned to the iteration under review", JSON.stringify(prCtx?.["iterationContext"]), '{"firstComparingIteration":1,"secondComparingIteration":3}');
  }

  section("a comment that could not be posted is never reported as a clean review");
  {
    // The failure this pins: a run whose thread POSTs were all rejected still edited a
    // summary that said "commented on the relevant lines", and exited 0. The finding has to
    // reach `failed`, the summary has to say so, and the summary itself must still post —
    // it is the only thing left telling anyone the review happened.
    const doomed = finding({ fingerprint: "dddd4444" });
    setState({
      threads: [],
      rejectThreadPost: (body) => {
        const comments = (body["comments"] as Array<{ content?: string }> | undefined) ?? [];
        return (comments[0]?.content ?? "").includes(fpMarker("dddd4444")) ? 500 : undefined;
      },
    });
    const { value: result, lines } = await capture(() =>
      publish(ref, { requirement: [], code: [doomed] }, summaryInput({ agg: { ...summaryInput().agg, inline: [doomed] } })),
    );
    eq("the rejected finding lands in failed[]", result.failed.map((x) => x.finding.fingerprint), ["dddd4444"]);
    eq("...and not in posted[]", result.posted.length, 0);
    check("...with the API's own reason kept", (result.failed[0]?.error ?? "").includes("500"), result.failed[0]?.error);
    check("...and named in the log", lines.some((l) => l.includes("[FAIL]") && l.includes("src/app.ts:11")), lines.join(" | "));
    check("the summary still posts", result.summaryThreadId !== undefined);
    const summary = threadPosts().find((r) => contentOf(r).includes(SUMMARY_MARKER));
    check("...and admits the comment never landed", (contentOf(summary ?? {})).includes("could not be posted"), contentOf(summary ?? {}));
  }

  section("stale threads: our own comments close when the code under them is gone");
  {
    // The mirror image of re-review amnesia. A thread ADO re-anchored past the end of the
    // file points at code that no longer exists; leaving it open makes the author close a
    // pile of obsolete comments by hand, which is the other way a review bot gets switched off.
    setState({
      threads: [
        {
          id: 4300,
          status: "active",
          comments: [ourComment(95, "This line is gone now.", "eeee5555", "correctness")],
          threadContext: { filePath: "/src/app.ts", rightFileStart: { line: 400 }, rightFileEnd: { line: 400 } },
        },
      ],
    });
    const { value: result } = await capture(() => publish(ref, { requirement: [], code: [] }, summaryInput()));
    eq("the stale thread is resolved", result.resolved, 1);
    const patched = ado.matching("PATCH", /\/threads\/4300$/);
    eq("...by one PATCH on the thread", patched.length, 1);
    eq("...setting it to fixed, not deleting it", patched[0]?.body?.["status"], "fixed");
  }

  section("PR status: either axis can fail the check, and the reason says which");
  {
    // A single "3 issues" status would hide that the real problem is an unimplemented
    // requirement — the finding the whole requirement axis exists to surface.
    const risky = finding({ fingerprint: "ffff6666", severity: "critical" });
    setState({ threads: [] });
    await capture(() =>
      publish(ref, { requirement: [], code: [risky] }, summaryInput({ agg: { ...summaryInput().agg, inline: [risky] } })),
    );
    const status = ado.matching("POST", /\/statuses$/);
    eq("a status is posted", status.length, 1);
    eq("...as failed", status[0]?.body?.["state"], "failed");
    check("...naming the high-risk code issues", String(status[0]?.body?.["description"]).includes("high-risk code issues"));

    setState({ threads: [] });
    await capture(() => publish(ref, { requirement: [], code: [] }, summaryInput()));
    const clean = ado.matching("POST", /\/statuses$/);
    eq("a clean run reports succeeded", clean[0]?.body?.["state"], "succeeded");
  }

  section("PRR_DRY_RUN: computes everything, writes nothing at all");
  {
    // Not "posts no comments" — issues no REQUESTS. A dry run that still read threads, or
    // still resolved a stale one, is not a dry run, and it is the mode people use to try the
    // tool against someone else's PR for the first time.
    setState({ threads: [] });
    process.env["PRR_DRY_RUN"] = "1";
    try {
      const f = finding({ fingerprint: "9999aaaa" });
      const { value: result } = await capture(() =>
        publish(ref, { requirement: [], code: [f] }, summaryInput({ agg: { ...summaryInput().agg, inline: [f] } })),
      );
      eq("no request of any kind reaches ADO", ado.requests.length, 0);
      eq("...and nothing is claimed as posted", result.posted.length, 0);
      eq("...nor as already posted", result.alreadyPosted.length, 0);
      eq("...and there is no summary thread to point at", result.summaryThreadId, undefined);
    } finally {
      delete process.env["PRR_DRY_RUN"];
    }
  }
} finally {
  await ado.close();
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
