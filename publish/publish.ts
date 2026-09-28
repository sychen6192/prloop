// Publishing: one sticky summary edited in place, plus inline threads for findings that
// anchored. Re-runs recognise their own threads by fingerprint and never post the same
// issue twice (the "re-review amnesia" failure mode).
import { LEARN_FROM_DISMISSALS, POST_STATUS, isDryRun } from "../config";
import { normalizePath, type FileIndex } from "../libs/fileindex";
import { isSelfIdentity, refusalStatus, type ReviewHost, type StatusState, type Thread } from "../libs/host";
import { reviewOutcome } from "./status";
import { unmetCriteria } from "../gates/requirement";
import { recordDismissals } from "../libs/learnings";
import { recordOutcomes } from "../libs/outcomes";
import { log } from "../libs/log";
import { collectDismissals, collectFinalOutcomes, collectOutcomes, findStaleThreads, locateSpan, resolveStaleThreads, tallyThreads, watermarkFor } from "./lifecycle";
import { iterationMarker, readMarkers, spanMark, type SpanMark } from "./markers";
import { leaseTakenOver, type LeaseHandle } from "./lease";
import type { AnchoredFinding } from "../libs/types";
import type { DismissalRecord, OutcomeRecord, StaleThread, ThreadTally, ToolEvidence, WatermarkDecision } from "./lifecycle";
import { renderFindingComment, renderSummary, type SummaryInput } from "./format";

export interface PublishResult {
  summaryThreadId?: number;
  posted: AnchoredFinding[];
  alreadyPosted: AnchoredFinding[];
  // `status` is the host's, when it gave one. A 4xx is final (ado/client.ts does not retry
  // below 500), which is what tells the watermark decision apart from a transport blip.
  failed: Array<{ finding: AnchoredFinding; error: string; status?: number }>;
  // Our own threads auto-closed because the code they pointed at changed.
  resolved: number;
  // Where every comment prloop has left on this PR now stands. Absent on a dry run and when
  // the thread list could not be read — neither of which is the same as "all zero".
  threads?: ThreadTally;
  // Findings a human closed as wontFix/byDesign — raw material for future exclusion rules.
  dismissals: DismissalRecord[];
  // Findings the author acted on: fixed by a human, or auto-closed because the code went
  // away. Measurement only — nothing here ever suppresses a finding.
  outcomes: OutcomeRecord[];
  /**
   * What this run left on the PR as the `--since auto` resume point. Absent on a dry run,
   * which takes no decision at all — "held: false" there would read as "advanced it", and
   * the two are not the same answer.
   */
  watermark?: WatermarkDecision;
  /**
   * Publish-side reasons this review is incomplete: comments ADO refused, a summary that
   * never landed, a status that never landed. The ONE producer of these — the orchestrator
   * appends them to its own list rather than working them out a second time from this
   * object, because two places deriving the same list is how the status and the exit code
   * came to disagree in the first place.
   *
   * A status that failed to post is appended AFTER the status decision was taken, so the
   * returned list can be one longer than what the status saw. That is the point: the gate
   * on the PR is then stale, and only the exit code can say so.
   */
  gaps: string[];
  /** The branch-policy status this run decided on. Absent when PRR_POST_STATUS is off. */
  status?: StatusState;
}

/**
 * The sticky summary to edit, preferring one prloop itself wrote.
 *
 * Preference rather than a requirement, and the fallback is the point. A forged summary
 * comment stops being the one prloop reads its own resume point out of, which is what the
 * preference buys. But requiring identity outright would make a pipeline run ignore the
 * summary a laptop run posted and open a second one beside it — and a duplicate summary is
 * the failure this function has always existed to prevent. So when prloop has no summary of
 * its own on the PR, it edits whichever one carries the marker, exactly as before.
 */
function findSummaryThread(
  threads: Thread[],
  selfId?: string,
): { thread: Thread; commentId: number } | undefined {
  let fallback: { thread: Thread; commentId: number } | undefined;
  for (const t of threads) {
    for (const c of t.comments ?? []) {
      if (c.isDeleted || !readMarkers(c.content).summary) continue;
      if (isSelfIdentity(c.author?.id, selfId)) return { thread: t, commentId: c.id };
      fallback ??= { thread: t, commentId: c.id };
    }
  }
  return fallback;
}

export interface PostedPosition {
  file: string;
  start: number;
  end: number;
  // Which axis the thread belongs to, read from the comment's category marker. Undefined
  // on threads posted before the marker existed — those still block both axes, because a
  // duplicate comment is the failure this dedupe exists to prevent and an unlabelled
  // thread gives no basis to decide it is safe.
  axis?: "requirement" | "code";
}

/** The requirement axis owns exactly one category; everything else is the code axis. */
const axisOf = (category: string) => (category === "req-mismatch" ? "requirement" : "code");

/**
 * Positions of our own inline threads, for cross-run dedupe by location.
 *
 * The fingerprint is a hash of the model's free-text quote, and models do not reproduce
 * quotes byte-for-byte across runs — one extra quoted line or a different category label
 * makes a "new" fingerprint for the same issue on the same code. A prloop thread already
 * sitting on those lines is the stronger signal: whatever we would say there, we have
 * already said.
 *
 * Said BY THE SAME AXIS, that is. This was the one place the "two blind axes, separate
 * budgets" invariant leaked: a requirement thread from a prior run on lines 10-12 silently
 * swallowed a new critical code finding on line 11, and a code thread swallowed the
 * requirement verdict on the same lines. The two axes never see each other's output
 * anywhere else in the pipeline; they must not delete each other's comments here.
 *
 * Human-dismissed threads (wontFix/byDesign/closed) count too: a rephrased finding on
 * lines a reviewer already said no to is the same conversation reopened. Only "fixed" is
 * left out — the code there changed, and a fresh finding on the new code may be real.
 */
export function postedPositions(threads: Thread[], index: FileIndex): PostedPosition[] {
  const out: PostedPosition[] = [];
  for (const t of threads) {
    if (t.status === "fixed") continue;
    const ctx = t.threadContext;
    if (!ctx?.filePath || !ctx.rightFileStart?.line) continue;
    const ourComment = t.comments?.find((c) => !c.isDeleted && readMarkers(c.content).ours);
    if (!ourComment) continue;
    const m = readMarkers(ourComment.content);
    // Thread paths come back from ADO in its own shape and may cite a pre-rename path;
    // resolve through the index so a thread on the old name still occupies the renamed
    // file's lines. A thread on a file outside this iteration keeps its normalized path
    // — it cannot collide with a finding, which is always on a changed file.
    const fd = index.resolvePrior(ctx.filePath);
    let start = ctx.rightFileStart.line;
    let end = ctx.rightFileEnd?.line ?? start;
    // Where its code is NOW, when the comment recorded it: the posted line is where that code
    // was, and code moves. Code that is gone occupies nothing — a finding on the new code
    // there is a new finding, not this one again.
    if (m.span && fd) {
      const at = locateSpan(fd.rightLines, m.span, start);
      if (at === undefined) continue;
      start = at;
      end = at + m.span.lines - 1;
    }
    out.push({
      file: fd?.path ?? normalizePath(ctx.filePath),
      start,
      end,
      ...(m.category ? { axis: axisOf(m.category) } : {}),
    });
  }
  return out;
}

/** The lines a right-side finding is anchored to, as the file has them: what a fix replaces. */
function anchoredLines(f: AnchoredFinding, index: FileIndex): string[] | undefined {
  const a = f.anchor;
  if (!a || a.side !== "right") return undefined;
  const lines = index.exact(f.file)?.rightLines.slice(a.startLine - 1, a.endLine) ?? [];
  return lines.length > 0 ? lines : undefined;
}

/** The span mark of the lines a right-side finding is anchored to, for its comment. */
function spanOf(f: AnchoredFinding, index: FileIndex): SpanMark | undefined {
  const a = f.anchor;
  if (!a || a.side !== "right") return undefined;
  const lines = index.exact(f.file)?.rightLines.slice(a.startLine - 1, a.endLine) ?? [];
  return lines.length > 0 ? spanMark(lines) : undefined;
}

/**
 * Whether an existing thread already covers this finding's lines. Exported for the
 * selftest — the rule it encodes (same file, overlapping lines, SAME AXIS) is the one that
 * used to delete a critical code finding because a requirement thread sat on the line.
 *
 * Right side only: left-side context isn't tracked here, and left-anchored comments are rare.
 */
export function coveredByThread(f: AnchoredFinding, positions: PostedPosition[]): boolean {
  const a = f.anchor;
  if (!a || a.side !== "right") return false;
  return positions.some(
    (p) =>
      p.file === f.file &&
      (p.axis === undefined || p.axis === axisOf(f.category)) &&
      a.startLine <= p.end &&
      a.endLine >= p.start,
  );
}

/**
 * Every fingerprint prloop has already said on this PR, so a re-run does not say it twice.
 *
 * Markers alone, deliberately. A forged `fp=` here buys one suppressed comment on one PR,
 * and it has to guess a 12-hex hash of a quote the model has not produced yet. Requiring
 * authorship would cost much more than that: prloop's credential is not the same on a
 * laptop, in a pipeline and under `az login`, and a run that did not recognise the other
 * identity's comments would post every finding again. Duplicate comments are the failure
 * this function exists to prevent.
 */
function postedFingerprints(threads: Thread[]): Set<string> {
  const out = new Set<string>();
  for (const t of threads) {
    for (const c of t.comments ?? []) {
      if (c.isDeleted) continue;
      for (const fp of readMarkers(c.content).fingerprints) out.add(fp);
    }
  }
  return out;
}

/** Every fingerprint already on the pull request, read on its own for the skeptic's filter. */
export async function postedFingerprintsOnPr(host: ReviewHost): Promise<Set<string>> {
  return postedFingerprints(await host.threads());
}

/**
 * Reads what humans did to prloop's comments and records it. No writes of any kind.
 *
 * Split out of publish() for the one case where reading is all prloop may do: a pull request
 * that has merged refuses every thread write, so there is no review to post — but the window
 * right after a merge is when people work through a bot's comments in bulk, and that is the
 * richest the dismissal and outcome stores ever get. Returning early without this would trade
 * the whole harvest for the model budget it was meant to save.
 */
export async function harvestClosedThreads(host: ReviewHost): Promise<{ dismissals: number; outcomes: number }> {
  const [threads, selfId] = await Promise.all([host.threads(), host.selfId()]);
  const dismissals = collectDismissals(threads, selfId);
  // The fixes first: the store keeps the first record per finding, and a comment fixed
  // before the merge must not be filed as ignored because it is also past the merge.
  const outcomes = [...collectOutcomes(threads, selfId), ...collectFinalOutcomes(threads, selfId)];
  return {
    dismissals: LEARN_FROM_DISMISSALS ? recordDismissals(host.ref, dismissals) : 0,
    outcomes: recordOutcomes(host.ref, outcomes),
  };
}

export async function publish(
  host: ReviewHost,
  axes: { requirement: AnchoredFinding[]; code: AnchoredFinding[] },
  summaryInput: SummaryInput,
  /**
   * What the orchestrator already knows, as two lists that answer two different questions.
   * A fourth argument rather than fields on SummaryInput: the publish-time fields there are
   * filled in BY publish and are optional for the renderers that never publish (demo,
   * local-review), whereas these are inputs to decisions, not rendering facts. Defaulted so
   * those callers stay untouched.
   */
  known: {
    /** Reasons the push itself went unreviewed. Decides the `--since auto` resume point. */
    unreviewed: readonly string[];
    /** Every reason this review is incomplete so far. Decides the branch-policy status. */
    incomplete: readonly string[];
    /** What the static tools established; decides whether a tool's comment may close. */
    toolEvidence?: ToolEvidence;
    /** The run lease this run holds, if it took one: checked once more before anything is written. */
    lease?: LeaseHandle;
  } = { unreviewed: [], incomplete: [] },
): Promise<PublishResult> {
  const result: PublishResult = { posted: [], alreadyPosted: [], failed: [], resolved: 0, dismissals: [], outcomes: [], gaps: [] };

  // Requirement findings go first so that if anything below fails, the message that
  // survived is the one about the PR not doing what was asked.
  const findings = [...axes.requirement, ...axes.code];

  if (isDryRun()) {
    log(
      `[DRY RUN] Not publishing. Would create ${findings.length} inline comments` +
        ` (requirement axis ${axes.requirement.length}, code axis ${axes.code.length}) + 1 summary`,
    );
    for (const f of findings) {
      log(`  ${f.severity} ${f.file}:${f.anchor?.startLine} — ${f.claim}`);
    }
    // Deliberately NOT result.posted — a dry run posts nothing, and the exit summary
    // must not read "Posted N".
    return result;
  }

  const { ctx } = summaryInput;

  // Hoisted, because it has to run on both paths below: the branch-policy check needs no
  // thread list, and a run that could not read the PR is exactly the one whose gate must not
  // stay green.
  const reportStatus = async (): Promise<void> => {
    if (!POST_STATUS) return;
    const outcome = reviewOutcome({
      unmet: summaryInput.req ? unmetCriteria(summaryInput.req).length : 0,
      highRisk: axes.code.filter((f) => f.severity === "critical" || f.severity === "high").length,
      incomplete: [...known.incomplete, ...result.gaps],
      filesReviewed: ctx.files.length,
    });
    result.status = outcome.state;
    try {
      await host.postStatus(outcome.state, outcome.description, { iterationId: ctx.iteration.id });
      log(`Reported PR status: ${outcome.state} (${outcome.description})`);
    } catch (e) {
      log(`[FAIL] PR status report failed: ${e instanceof Error ? e.message : String(e)}`);
      // Named, not just logged. The gate on the PR now shows whatever an earlier run left
      // there — on a re-run of the same iteration, quite possibly a green one — and the
      // exit code is the only thing left that can say the check was never updated.
      result.gaps.push("PR status failed to post");
    }
  };

  // Asked once, alongside the thread list it qualifies: which comments on this PR prloop
  // actually wrote. Everything below still trusts the markers alone; only the two readers
  // whose forging is unrecoverable consult this (publish/lifecycle.ts).
  //
  // Guarded, and the degrade is to write NOTHING. Every dedupe prloop has runs off this list
  // — the fingerprints already said, the lines already commented on, which comment is the
  // sticky summary, what resume point it carries — so posting without it would double every
  // comment and open a second summary thread, which breaks `--since auto` permanently
  // (it resumes from the first marker it finds). Unguarded, a transient 5xx here threw out
  // of runReview after every model call had been paid for, and loop.ts died with exit 1
  // before publish.json or result.json were written: the run directory then held findings
  // and nothing saying the run had ended, indistinguishable a week later from one that was
  // killed. Now the findings are reported as unpostable, the run exits 3, and the artifacts
  // land.
  let threads: Thread[];
  let selfId: string | undefined;
  try {
    [threads, selfId] = await Promise.all([host.threads(), host.selfId()]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`[FAIL] Could not read the PR's existing comments: ${msg}`);
    log("Posting nothing: without them every comment would be a duplicate and the summary a second one");
    for (const f of findings) result.failed.push({ finding: f, error: `not attempted: ${msg}` });
    // One precise reason rather than the generic pair below it: "N comments failed to post"
    // and "summary comment failed to post" would both be true and neither would say why.
    result.gaps.push(`could not read the PR's comment threads: ${msg}`);
    await reportStatus();
    return result;
  }
  // The lease, once more, now that nothing has been written yet: a review that outlived it
  // and was taken over stands down here rather than posting beside the run that took over.
  const lost = leaseTakenOver(threads, selfId, known.lease);
  if (lost) {
    log(`[WARN] ${lost} — posting nothing, so the two reviews do not interleave`);
    for (const f of findings) result.failed.push({ finding: f, error: `not posted: ${lost}` });
    result.gaps.push(lost);
    return result;
  }
  const seen = postedFingerprints(threads);

  // Close our own threads whose code has since changed, before adding new ones — otherwise
  // a PR accumulates stale comments the author already addressed.
  const closed = await resolveStaleThreads(host, findStaleThreads(threads, ctx.fileIndex, known.toolEvidence));
  result.resolved = closed.length;
  // From the same pre-close snapshot as the outcomes below, so a thread this run has just
  // closed is still `active` in it and cannot also be booked as a reviewer's fix.
  result.threads = tallyThreads(threads, closed.length);
  result.dismissals = collectDismissals(threads, selfId);

  // The positive half of the record, and the only evidence prloop has ever collected that a
  // comment was worth posting: PROPOSAL §12 names implementation rate as the online north
  // star, and precision estimated as one minus the dismissal rate counts every comment
  // nobody answered as a success. Read from the pre-close snapshot, so the threads this run
  // has just auto-closed are still `active` in it and cannot be booked as a human's fix.
  // Its own store, never dismissals.jsonl: everything in that file gets suppressed on every
  // future PR, and a finding somebody fixed is the last thing to stop reporting.
  result.outcomes = [
    ...collectOutcomes(threads, selfId),
    ...closed
      .filter((c): c is StaleThread & { fingerprint: string } => c.fingerprint !== undefined)
      .map((c) => ({
        fingerprint: c.fingerprint,
        file: c.file,
        ...(c.category ? { category: c.category } : {}),
        outcome: "auto-closed" as const,
        ...(c.likes === undefined ? {} : { likes: c.likes }),
      })),
  ];
  if (result.outcomes.length > 0) {
    const newly = recordOutcomes(host.ref, result.outcomes);
    if (newly > 0) log(`Recorded ${newly} findings the author acted on (scripts/calibrate.ts reports the rate)`);
  }
  if (result.dismissals.length > 0 && LEARN_FROM_DISMISSALS) {
    // Persist into the per-repo learnings store: the next run (on this PR or any other)
    // suppresses findings matching these fingerprints instead of re-litigating them.
    const newly = recordDismissals(host.ref, result.dismissals);
    log(
      `Found ${result.dismissals.length} comments dismissed by a human` +
        (newly > 0 ? ` (${newly} newly recorded — future runs will not repeat them)` : " (all already recorded)"),
    );
  }

  const positions = postedPositions(threads, ctx.fileIndex);
  for (const f of findings) {
    if (seen.has(f.fingerprint)) {
      result.alreadyPosted.push(f);
      continue;
    }
    if (!f.anchor) continue; // defensive: aggregate already filtered these out
    // Location dedupe: an active prloop thread from THIS axis already covers these lines.
    if (coveredByThread(f, positions)) {
      result.alreadyPosted.push(f);
      continue;
    }
    try {
      await host.createThread({
        content: renderFindingComment(f, spanOf(f, ctx.fileIndex), anchoredLines(f, ctx.fileIndex)),
        status: "active",
        filePath: f.file,
        anchor: f.anchor,
        changeTrackingId: f.changeTrackingId ?? ctx.changeTrackingIds.get(f.file),
        iterationId: ctx.iteration.id,
        firstComparingIteration: ctx.compareTo > 0 ? ctx.compareTo : 1,
      });
      result.posted.push(f);
      seen.add(f.fingerprint);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`[FAIL] Could not create comment ${f.file}:${f.anchor.startLine}: ${msg}`);
      // The status is kept, not just stringified: whether this rejection can ever succeed
      // again is what decides if the run may advance the resume point (watermarkFor).
      const status = refusalStatus(e);
      result.failed.push({ finding: f, error: msg, ...(status === undefined ? {} : { status }) });
    }
  }

  // A lane (gates/aggregate.ts, laneOf) decides where a NEW comment would go, and cannot
  // unsay one an earlier run left — typically in the push that wrote the line, which this push
  // did not touch. Such a finding is reported as already commented, never as not commented.
  for (const f of summaryInput.agg.belowBar) {
    if (f.suppressedBy !== "pre-existing" && f.suppressedBy !== "silenced") continue;
    if (seen.has(f.fingerprint) || coveredByThread(f, positions)) result.alreadyPosted.push(f);
  }

  if (result.alreadyPosted.length > 0) {
    log(`${result.alreadyPosted.length} findings already commented, skipped`);
  }

  // Found before the body is built, because the resume point we may have to keep is the one
  // inside the very comment this run is about to overwrite. lastReviewedIteration() scans
  // every thread by a different predicate and can land on a different comment, which on a PR
  // with two summary threads would copy one thread's watermark into the other's body and
  // leave the PR carrying two different answers.
  const existing = findSummaryThread(threads, selfId);
  const prior = existing
    ? readMarkers(existing.thread.comments?.find((c) => c.id === existing.commentId)?.content).iteration
    : undefined;
  // A 4xx will be refused identically next run, so it must not hold the watermark; anything
  // without a status, a 5xx or a 429 might land next time.
  const transientPostFailures = result.failed.filter(
    (f) => f.status === undefined || f.status >= 500 || f.status === 429,
  ).length;
  const watermark = watermarkFor({
    unreviewed: known.unreviewed,
    transientPostFailures,
    omittedForSize: summaryInput.omittedFiles.length,
    current: ctx.iteration.id,
    ...(prior === undefined ? {} : { prior }),
  });
  result.watermark = watermark;
  if (watermark.held) {
    log(
      `[WARN] Not advancing the --since auto resume point past iteration ${ctx.iteration.id}: ${watermark.reason}` +
        (watermark.record === undefined
          ? " — no earlier resume point was recorded, so the next run reviews the whole PR"
          : ` — it stays at iteration ${watermark.record}`),
    );
  }

  // Rendered here, not before the loop: the summary asserts what reached the PR, and the
  // loop above is the only thing that knows. Rendering it first published "commented on the
  // relevant lines" for findings that had just failed to post or were already covered.
  const summaryBody =
    `${renderSummary({
      ...summaryInput,
      posted: result.posted,
      alreadyPosted: result.alreadyPosted,
      failed: result.failed,
      watermark,
      ...(result.threads === undefined ? {} : { threads: result.threads }),
      ...(prior === undefined ? {} : { sinceIteration: prior }),
    })}\n` + (watermark.record === undefined ? "" : iterationMarker(watermark.record));

  try {
    if (existing) {
      await host.updateComment(existing.thread.id, existing.commentId, summaryBody);
      result.summaryThreadId = existing.thread.id;
      log(`Updated summary comment (thread ${existing.thread.id})`);
    } else {
      // Closed, not active: the summary is informational and should never trip a
      // "comment resolution required" policy.
      const t = await host.createThread({ content: summaryBody, status: "closed" });
      result.summaryThreadId = t.id;
      log(`Created summary comment (thread ${t.id})`);
    }
  } catch (e) {
    log(`[FAIL] Summary comment failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Computed here, once, and returned: a run that computed findings and could not post them
  // is not a clean PR, and neither is one whose summary never landed. Outside the
  // POST_STATUS branch on purpose — the exit code needs these whether or not a status is
  // configured.
  if (result.failed.length > 0) {
    result.gaps.push(`${result.failed.length} comments failed to post`);
  }
  if (result.summaryThreadId === undefined) {
    result.gaps.push("summary comment failed to post");
  }

  await reportStatus();

  return result;
}
