// Publishing: one sticky summary edited in place, plus inline threads for findings that
// anchored. Re-runs recognise their own threads by fingerprint and never post the same
// issue twice (the "re-review amnesia" failure mode).
import { LEARN_FROM_DISMISSALS, POST_STATUS, isDryRun } from "../config";
import { normalizePath, type FileIndex } from "../libs/fileindex";
import { AdoError } from "../ado/client";
import { isSelfIdentity, selfIdentityId } from "../ado/identity";
import { createThread, listThreads, updateComment, type Thread } from "../ado/threads";
import { postStatus, type StatusState } from "../ado/statuses";
import { reviewOutcome } from "./status";
import { unmetCriteria } from "../gates/requirement";
import { recordDismissals } from "../libs/learnings";
import { recordOutcomes } from "../libs/outcomes";
import { log } from "../libs/log";
import { collectDismissals, collectOutcomes, findStaleThreads, resolveStaleThreads, watermarkFor } from "./lifecycle";
import { iterationMarker, readMarkers } from "./markers";
import type { AnchoredFinding, PrRef } from "../libs/types";
import type { DismissalRecord, OutcomeRecord, StaleThread, WatermarkDecision } from "./lifecycle";
import { renderFindingComment, renderSummary, type SummaryInput } from "./format";

export interface PublishResult {
  summaryThreadId?: number;
  posted: AnchoredFinding[];
  alreadyPosted: AnchoredFinding[];
  // `status` is ADO's, when it gave one. A 4xx is final (ado/client.ts does not retry below
  // 500), which is what tells the watermark decision apart from a transport blip.
  failed: Array<{ finding: AnchoredFinding; error: string; status?: number }>;
  // Our own threads auto-closed because the code they pointed at changed.
  resolved: number;
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
    const cat = readMarkers(ourComment.content).category;
    out.push({
      // Thread paths come back from ADO in its own shape and may cite a pre-rename path;
      // resolve through the index so a thread on the old name still occupies the renamed
      // file's lines. A thread on a file outside this iteration keeps its normalized path
      // — it cannot collide with a finding, which is always on a changed file.
      file: index.resolvePrior(ctx.filePath)?.path ?? normalizePath(ctx.filePath),
      start: ctx.rightFileStart.line,
      end: ctx.rightFileEnd?.line ?? ctx.rightFileStart.line,
      ...(cat ? { axis: axisOf(cat) } : {}),
    });
  }
  return out;
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

export async function publish(
  ref: PrRef,
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

  // Asked once, alongside the thread list it qualifies: which comments on this PR prloop
  // actually wrote. Everything below still trusts the markers alone; only the two readers
  // whose forging is unrecoverable consult this (publish/lifecycle.ts).
  const [threads, selfId] = await Promise.all([listThreads(ref), selfIdentityId(ref)]);
  const seen = postedFingerprints(threads);
  const { ctx } = summaryInput;

  // Close our own threads whose code has since changed, before adding new ones — otherwise
  // a PR accumulates stale comments the author already addressed.
  const closed = await resolveStaleThreads(ref, findStaleThreads(threads, ctx.fileIndex));
  result.resolved = closed.length;
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
      })),
  ];
  if (result.outcomes.length > 0) {
    const newly = recordOutcomes(ref, result.outcomes);
    if (newly > 0) log(`Recorded ${newly} findings the author acted on (scripts/calibrate.ts reports the rate)`);
  }
  if (result.dismissals.length > 0 && LEARN_FROM_DISMISSALS) {
    // Persist into the per-repo learnings store: the next run (on this PR or any other)
    // suppresses findings matching these fingerprints instead of re-litigating them.
    const newly = recordDismissals(ref, result.dismissals);
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
      await createThread(ref, {
        content: renderFindingComment(f),
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
      const status = e instanceof AdoError ? e.status : undefined;
      result.failed.push({ finding: f, error: msg, ...(status === undefined ? {} : { status }) });
    }
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
    })}\n` + (watermark.record === undefined ? "" : iterationMarker(watermark.record));

  try {
    if (existing) {
      await updateComment(ref, existing.thread.id, existing.commentId, summaryBody);
      result.summaryThreadId = existing.thread.id;
      log(`Updated summary comment (thread ${existing.thread.id})`);
    } else {
      // Closed, not active: the summary is informational and should never trip a
      // "comment resolution required" policy.
      const t = await createThread(ref, { content: summaryBody, status: "closed" });
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

  if (POST_STATUS) {
    const outcome = reviewOutcome({
      unmet: summaryInput.req ? unmetCriteria(summaryInput.req).length : 0,
      highRisk: axes.code.filter((f) => f.severity === "critical" || f.severity === "high").length,
      incomplete: [...known.incomplete, ...result.gaps],
      filesReviewed: ctx.files.length,
    });
    result.status = outcome.state;
    try {
      await postStatus(ref, outcome.state, outcome.description, { iterationId: ctx.iteration.id });
      log(`Reported PR status: ${outcome.state} (${outcome.description})`);
    } catch (e) {
      log(`[FAIL] PR status report failed: ${e instanceof Error ? e.message : String(e)}`);
      // Named, not just logged. The gate on the PR now shows whatever an earlier run left
      // there — on a re-run of the same iteration, quite possibly a green one — and the
      // exit code is the only thing left that can say the check was never updated.
      result.gaps.push("PR status failed to post");
    }
  }

  return result;
}
