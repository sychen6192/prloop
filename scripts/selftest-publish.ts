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
  const { BOT_MARKER, SUMMARY_MARKER, findingMarkers, summaryMarkers, iterationMarker, readMarkers } =
    await import("../publish/markers");
  const { watermarkFor } = await import("../publish/lifecycle");
  const { exitCodeFor } = await import("../orchestrator");
  const { FINDING_CATEGORIES } = await import("../config");
  const { fingerprint } = await import("../gates/aggregate");
  const { FileIndex } = await import("../libs/fileindex");

  const ref = parsePrUrl("https://dev.azure.com/contoso/Shop/_git/shop-api/pullrequest/4821");

  const mkFile = (path: string, lines: number): FileDiff => ({
    path,
    changeType: "edit",
    hunks: [{ rightStart: 1, rightCount: lines, leftStart: 1, leftCount: lines, body: "" }],
    rightLines: Array.from({ length: lines }, (_, i) => `line ${i + 1}`),
    leftLines: [],
    changedRightLines: new Set(Array.from({ length: lines }, (_, i) => i + 1)),
    changedLeftLines: new Set(),
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
    // Written out literally, never with findingMarkers(): a fixture built from the writer
    // agrees with the reader even when the two are wrong together, which is exactly how the
    // hand-copied `cat=([a-z-]+)` stayed green.
    content:
      `${BOT_MARKER}` +
      `${fp ? `<!-- prloop:fp=${fp} -->` : ""}` +
      `${cat ? `<!-- prloop:cat=${cat} -->` : ""}\n${body}`,
  });

  const setState = (partial: Partial<FakeAdoState>) => {
    Object.assign(ado.state, { threads: [], rejectThreadPost: undefined, rejectStatusPost: undefined, ...partial });
    ado.reset();
  };

  /** publish()'s fourth argument: what the orchestrator already knew, as two lists. */
  const known = (unreviewed: string[] = [], incomplete: string[] = unreviewed) => ({ unreviewed, incomplete });

  const threadPosts = () => ado.matching("POST", /\/threads$/);
  const statusPosts = () => ado.matching("POST", /\/statuses$/);
  const statusOf = (r?: { body?: Record<string, unknown> }) => String(r?.body?.["state"] ?? "<none>");
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
    check(
      "...carrying the requirement category marker",
      contentOf(posted[0]!).includes("<!-- prloop:cat=req-mismatch -->"),
    );

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
        return (comments[0]?.content ?? "").includes("<!-- prloop:fp=dddd4444 -->") ? 500 : undefined;
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

  section("marker protocol: the bytes on the wire, and the reader that has to agree with them");
  {
    // Pinned literally. These strings sit in comments on live PRs; a run that stops writing
    // exactly them orphans every thread an earlier run left behind, and the failure looks
    // like "prloop posted everything twice".
    eq(
      "a finding comment's markers",
      findingMarkers({ fingerprint: "c848ab6f5911", category: "correctness" }),
      "<!-- prloop --><!-- prloop:fp=c848ab6f5911 --><!-- prloop:cat=correctness -->",
    );
    eq("the summary's markers", summaryMarkers(), "<!-- prloop --><!-- prloop:summary -->");
    eq("the iteration marker", iterationMarker(7), "<!-- prloop:iteration=7 -->");

    // Read back off hand-written bytes, not off the writer's output.
    const m = readMarkers(
      "<!-- prloop --><!-- prloop:fp=c848ab6f5911 --><!-- prloop:cat=leftover-code -->\nA claim.",
    );
    check("ours", m.ours);
    check("...and not the summary", !m.summary);
    eq("...fingerprint", m.fingerprint, "c848ab6f5911");
    eq("...category", m.category, "leftover-code");
    eq("...iteration is absent", m.iteration, undefined);

    const sum = readMarkers("<!-- prloop --><!-- prloop:summary -->\n## r\n<!-- prloop:iteration=12 -->");
    check("the summary is recognised", sum.ours && sum.summary);
    eq("...and carries the iteration", sum.iteration, 12);
    eq("...but no fingerprint", sum.fingerprint, undefined);

    // The assertion the old hand-copied `cat=([a-z-]+)` could not make. A category outside
    // that class read as "no category", which postedPositions turns into axis: undefined —
    // "blocks both axes" — and a requirement thread swallows a critical code finding again.
    for (const cat of FINDING_CATEGORIES) {
      eq(
        `every category survives the round trip: ${cat}`,
        readMarkers(findingMarkers({ fingerprint: "abc123def456", category: cat })).category,
        cat,
      );
    }
    eq(
      "a category this build does not know reads as absent, never as a bad guess",
      readMarkers("<!-- prloop --><!-- prloop:cat=invented-by-a-model -->").category,
      undefined,
    );

    // The fingerprint shape lives in gates/aggregate.ts; the reader validates it by pattern
    // rather than importing it, so this is what stops the two drifting apart.
    const real = fingerprint({
      file: "src/app.ts",
      category: "correctness",
      severity: "high",
      confidence: 0.9,
      quote: "const a = 1;",
      claim: "c",
      side: "right",
    } as Parameters<typeof fingerprint>[0]);
    eq("a real fingerprint round-trips", readMarkers(findingMarkers({ fingerprint: real, category: "correctness" })).fingerprint, real);
    eq(
      "a malformed fingerprint reads as absent",
      readMarkers("<!-- prloop --><!-- prloop:fp=not-a-hash -->").fingerprint,
      undefined,
    );

    eq("a comment that is not ours reads as nothing", readMarkers("Looks good to me!").ours, false);
    eq("...as does an empty body", readMarkers(undefined).ours, false);
    eq("...with no fingerprints to dedupe against", readMarkers(undefined).fingerprints, []);
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

  section("PR status: the merge gate must not go green on a review that did not run");
  {
    // The failure: the status was decided from unmet criteria and high-risk findings alone,
    // so a run whose finder fleet died posted `succeeded — no blockers` while the same run
    // exited 3. A branch policy cannot see an exit code, and PROPOSAL §10 picked this status
    // over a bot vote precisely because it is what gates the merge.
    //
    // The assertion is on the byte that reached the wire, compared against the exit code the
    // CLI would return over the SAME list. Comparing the decision object with itself would
    // hold for every input, including a swapped one.
    const rows: Array<{ name: string; incomplete: string[]; inline: AnchoredFinding[]; state: string; exit: 0 | 2 | 3 }> = [
      { name: "a clean, complete run", incomplete: [], inline: [], state: "succeeded", exit: 0 },
      {
        name: "a run whose finder stage died and found nothing",
        incomplete: ["finder stage (endpoint unreachable)"],
        inline: [],
        state: "error",
        exit: 3,
      },
      {
        name: "a run with a blocking finding",
        incomplete: [],
        inline: [finding({ fingerprint: "bbbb1111", severity: "critical" })],
        state: "failed",
        exit: 2,
      },
      {
        name: "a run that is both blocking and incomplete",
        incomplete: ["skeptic stage (boom)"],
        inline: [finding({ fingerprint: "bbbb2222", severity: "critical" })],
        state: "failed",
        exit: 2,
      },
    ];
    for (const r of rows) {
      setState({ threads: [] });
      await capture(() =>
        publish(
          ref,
          { requirement: [], code: r.inline },
          summaryInput({ agg: { ...summaryInput().agg, inline: r.inline } }),
          known([], r.incomplete),
        ),
      );
      eq(`${r.name} posts ${r.state}`, statusOf(statusPosts()[0]), r.state);
      // Literal expected pairs, not a lookup through the same table the code uses: swap two
      // branches in reviewOutcome and this fails, where a self-comparison would not.
      eq(
        `...and the exit code agrees (${r.exit})`,
        exitCodeFor({
          agg: { ...summaryInput().agg, inline: r.inline },
          incomplete: r.incomplete,
        } as Parameters<typeof exitCodeFor>[0]),
        r.exit,
      );
    }

    // Both true: the blocking reasons lead, because they are what a reviewer acts on, but
    // the incompleteness must still be visible.
    const bothDesc = String(statusPosts()[0]?.body?.["description"] ?? "");
    check("a blocking-and-incomplete run still admits it is incomplete", bothDesc.includes("also incomplete"), bothDesc);

    // ADO cuts the description at 400 characters, and a relayed gateway body runs past that
    // on its own — so the count lives in the prefix, where truncation cannot reach it.
    setState({ threads: [] });
    await capture(() =>
      publish(ref, { requirement: [], code: [] }, summaryInput(), known([], [`HTTP 500: ${"x".repeat(900)}`, "and another"])),
    );
    const longDesc = String(statusPosts()[0]?.body?.["description"] ?? "");
    check("a 900-char reason does not delete the reason count", longDesc.startsWith("Review incomplete (2 reasons):"), longDesc.slice(0, 60));
    check("...and what ADO stores is still within its 400-char cut", longDesc.length <= 400, String(longDesc.length));

    // publish() is the one producer of the publish-side reasons; the orchestrator appends
    // them rather than working them out again from the result, which is how the two lists
    // came to disagree.
    setState({
      threads: [],
      rejectThreadPost: (body) => {
        const comments = (body["comments"] as Array<{ content?: string }> | undefined) ?? [];
        return (comments[0]?.content ?? "").includes("<!-- prloop:fp=cccc3333 -->") ? 500 : undefined;
      },
    });
    const doomed = finding({ fingerprint: "cccc3333", severity: "medium" });
    const { value: refused } = await capture(() =>
      publish(ref, { requirement: [], code: [doomed] }, summaryInput({ agg: { ...summaryInput().agg, inline: [doomed] } }), known()),
    );
    eq("a comment ADO refused is named once, by publish", refused.gaps, ["1 comments failed to post"]);
    eq("...and turns the gate red even with nothing blocking", refused.status, "error");

    // The status POST itself failing is a named failure, not a log line: the gate on the PR
    // now shows whatever an earlier run left, and only the exit code can say otherwise.
    setState({ threads: [], rejectStatusPost: 503 });
    const { value: noStatus } = await capture(() => publish(ref, { requirement: [], code: [] }, summaryInput(), known()));
    check(
      "a status that could not be posted is reported as incompleteness",
      noStatus.gaps.includes("PR status failed to post"),
      JSON.stringify(noStatus.gaps),
    );
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
      // "held: false" would read as "it advanced the resume point". A dry run takes no
      // decision at all, and publish.json records the difference.
      eq("...and no watermark decision was taken", result.watermark, undefined);
    } finally {
      delete process.env["PRR_DRY_RUN"];
    }
  }

  section("the --since auto resume point: a push nothing reviewed must not be stepped over");
  {
    // The decision itself, before any wire. Everything here is a rule that cost a real
    // failure to learn, so each case says which one.
    const wm = (over: Partial<Parameters<typeof watermarkFor>[0]> = {}) =>
      watermarkFor({ unreviewed: [], transientPostFailures: 0, omittedForSize: 0, current: 7, prior: 4, ...over });

    eq("a complete run records the iteration it reviewed", wm(), { record: 7, held: false });
    eq(
      "a run whose review-producing stage died keeps the old resume point",
      wm({ unreviewed: ["finder stage (boom)"] }),
      { record: 4, held: true, reason: "finder stage (boom)" },
    );
    // No marker at all, rather than a fabricated one: the next --since auto run then finds
    // nothing and reviews the whole PR, which is the safe direction.
    eq(
      "...and writes no marker when there was none to keep",
      wm({ unreviewed: ["finder stage (boom)"], prior: undefined }),
      { held: true, reason: "finder stage (boom)" },
    );
    // ado/client.ts does not retry below 500, so a 4xx is refused identically next run:
    // holding on it would pin the watermark on this iteration forever.
    eq("a 5xx on a comment holds it", wm({ transientPostFailures: 1 }), {
      record: 4,
      held: true,
      reason: "1 comment ADO could not accept",
    });
    eq("...but a 4xx does not, because it will be refused again", wm({ transientPostFailures: 0 }), {
      record: 7,
      held: false,
    });
    // The bound. Holding widens the next compare range, which eventually trips the diff
    // budget and drops files from every finder's context — so a run that has already lost
    // files to size advances, and says why.
    const bounded = wm({ unreviewed: ["skeptic stage (boom)"], omittedForSize: 3 });
    eq("a run already over the diff budget advances anyway", bounded.record, 7);
    eq("...without claiming it was held", bounded.held, false);
    check("...and says why it was let through", (bounded.reason ?? "").includes("would review less"), bounded.reason);

    // On the wire. The marker bytes are what --since auto reads back, so the assertion is
    // about the body that reached ADO, not about the decision object.
    const summaryWith = (iteration: number): FakeThread => ({
      id: 4100,
      status: "closed",
      comments: [{ id: 91, content: `${BOT_MARKER}${SUMMARY_MARKER}\n## previous run\n<!-- prloop:iteration=${iteration} -->` }],
    });

    setState({ threads: [summaryWith(2)] });
    const { value: held } = await capture(() =>
      publish(ref, { requirement: [], code: [] }, summaryInput(), known(["finder stage (endpoint unreachable)"])),
    );
    const heldBody = String(commentPatches()[0]?.body?.["content"] ?? "");
    check("a held run leaves the old marker on the PR", heldBody.includes("<!-- prloop:iteration=2 -->"), heldBody.slice(-120));
    check("...and does not write this iteration's", !heldBody.includes("<!-- prloop:iteration=3 -->"), heldBody.slice(-120));
    eq("...and reports the hold to the caller", held.watermark?.held, true);
    check(
      "...and tells the reader on the PR that the next run re-reviews this push",
      heldBody.includes("resume point stays at iteration 2"),
      heldBody.slice(0, 400),
    );

    setState({ threads: [summaryWith(2)] });
    const { value: clean } = await capture(() => publish(ref, { requirement: [], code: [] }, summaryInput(), known()));
    check(
      "a complete run still carries the marker forward",
      String(commentPatches()[0]?.body?.["content"] ?? "").includes("<!-- prloop:iteration=3 -->"),
    );
    eq("...and says it was not held", clean.watermark, { record: 3, held: false });

    // First run on the PR, and it died: no marker is written at all, so the next run sees
    // no resume point and reviews everything rather than starting after an unread push.
    setState({ threads: [] });
    await capture(() => publish(ref, { requirement: [], code: [] }, summaryInput(), known(["finder stage (endpoint unreachable)"])));
    const created = contentOf(threadPosts().find((r) => contentOf(r).includes(SUMMARY_MARKER)) ?? {});
    check("a first run that died records no resume point", !/<!-- prloop:iteration=\d+ -->/.test(created), created.slice(-120));
    check("...and says the next run reviews the whole PR", created.includes("reviews the whole PR"), created.slice(0, 400));

    // A comment ADO refused with 500 might land next time, so the push is re-reviewed.
    setState({
      threads: [summaryWith(2)],
      rejectThreadPost: (body) => {
        const comments = (body["comments"] as Array<{ content?: string }> | undefined) ?? [];
        return (comments[0]?.content ?? "").includes("<!-- prloop:fp=aaaa5555 -->") ? 500 : undefined;
      },
    });
    const doomed = finding({ fingerprint: "aaaa5555" });
    const { value: refused } = await capture(() =>
      publish(ref, { requirement: [], code: [doomed] }, summaryInput({ agg: { ...summaryInput().agg, inline: [doomed] } }), known()),
    );
    eq("a 5xx on a comment is kept with its status", refused.failed[0]?.status, 500);
    eq("...and holds the resume point, because the retry can succeed", refused.watermark?.held, true);

    // The same rejection as a 400: permanent, so it must not wedge the watermark.
    setState({
      threads: [summaryWith(2)],
      rejectThreadPost: (body) => {
        const comments = (body["comments"] as Array<{ content?: string }> | undefined) ?? [];
        return (comments[0]?.content ?? "").includes("<!-- prloop:fp=aaaa5555 -->") ? 400 : undefined;
      },
    });
    const { value: rejected } = await capture(() =>
      publish(ref, { requirement: [], code: [doomed] }, summaryInput({ agg: { ...summaryInput().agg, inline: [doomed] } }), known()),
    );
    eq("a 4xx on a comment is kept with its status", rejected.failed[0]?.status, 400);
    eq("...and does not hold the resume point", rejected.watermark, { record: 3, held: false });
  }
} finally {
  await ado.close();
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
