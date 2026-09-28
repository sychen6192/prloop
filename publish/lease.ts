// The per-PR run lease: "somebody is already reviewing this pull request".
//
// The failure it exists for is the README's own cron loop. A tick that runs long and the
// next tick overlap on one PR, and both of them read the thread list before either has
// posted anything — so both see the same `seen` fingerprints, and both post every finding.
// Worse, on a PR with no summary yet both create one, and `--since auto` resumes from the
// first marker ADO returns: from then on the resume point is pinned to whichever copy that
// is, forever. The same happens whenever a person runs prloop on their laptop against a PR
// the pipeline is reviewing.
//
// A lock file cannot address it. libs/learnings.ts already states the constraint this tool
// works under — a laptop and a cron box do not share RUNS_DIR — and that is precisely the
// pair that collides. So the lease is state on the PR, the same rule publish/lifecycle.ts
// follows for the resume point: a timestamped marker inside prloop's own sticky summary.
//
// What this IS NOT: a mutex. Azure DevOps offers no compare-and-swap on a comment body, so
// two runs that read, write and read back in perfect lockstep can both proceed. The claim
// below does write and then read back, which costs one GET and makes that window small, but
// it cannot close it. What the lease does close is the case that actually happens in
// production, where one run has been holding the PR for minutes before the other starts.
//
// Two deliberate limits, both of which trade the rare failure for the worse one:
//
//   - **No summary on the PR, no lease.** Claiming would mean CREATING the sticky summary
//     before the review that fills it, and two first runs racing would then leave two
//     summary threads — the wedge above, caused by the thing meant to prevent it. A PR with
//     no summary has never been published to, so there is no resume point to pin and no
//     comment to duplicate; the worst an overlap costs there is duplicate inline threads on
//     a PR nobody has reviewed yet, which is what happens today anyway.
//   - **Fails open.** A lease that cannot be read or written does not stop the review.
//     Refusing to review is the more expensive mistake, and a run that truly cannot reach
//     the PR is going to fail at publish and say so.
import { randomBytes } from "node:crypto";
import { RUN_LEASE_MS } from "../config";
import { isSelfIdentity, selfIdentityId } from "../ado/identity";
import { listThreads, updateComment, type Thread } from "../ado/threads";
import { log, logVerbose } from "../libs/log";
import { readMarkers, runMarker, setRunMarker } from "./markers";
import type { PrRef } from "../libs/types";

/**
 * This process, as it appears on the wire. Random rather than derived from the host: the one
 * question the id has to answer is "is this marker mine", and a hostname would answer it
 * wrongly for two runs on the same cron box while also publishing the operator's
 * infrastructure into a comment. The id is logged locally and lands in result.json, which is
 * how a stuck lease is traced back to the run that left it.
 */
const RUN_ID = randomBytes(4).toString("hex");

export const runId = (): string => RUN_ID;

/** Set only by a claim that succeeded, so releasing can be a no-op that costs no request. */
let held = false;

export interface LeaseDecision {
  /** False only when another run demonstrably holds this PR right now. */
  acquired: boolean;
  /** Why not, worded for the log and for result.json. Absent when acquired. */
  reason?: string;
}

/** prloop's own sticky summary — ours, marked as the summary, and written by our identity. */
function ownSummary(threads: Thread[], selfId?: string): { threadId: number; commentId: number; body: string } | undefined {
  for (const t of threads) {
    for (const c of t.comments ?? []) {
      if (c.isDeleted) continue;
      const m = readMarkers(c.content);
      if (!m.ours || !m.summary) continue;
      // Identity, exactly as lastReviewedIteration requires it and for the same consequence:
      // a marker anyone who can comment on the PR may type would otherwise be a way to make
      // prloop never review it again, and a review that silently does not happen is the one
      // failure class this tool cannot recover from on its own.
      if (!isSelfIdentity(c.author?.id, selfId)) continue;
      return { threadId: t.id, commentId: c.id, body: c.content ?? "" };
    }
  }
  return undefined;
}

/**
 * Whether a marker describes a run still in flight.
 *
 * The absolute value is not a typo. The timestamp is another machine's clock, and a marker
 * from the future is far more likely to be a live run on a box whose clock is a minute
 * ahead than anything else — reading it as "long expired" would hand the PR to two runs at
 * once, which is the whole point of the lease. It costs a bound: gross skew can hold a PR
 * for twice the window rather than forever, which is why the taken-over case says so.
 */
export function leaseIsLive(startedAt: number, now: number, windowMs: number): boolean {
  return Math.abs(now - startedAt) < windowMs;
}

const ageText = (ms: number) => `${Math.round(Math.abs(ms) / 1000)}s`;

/**
 * Takes the PR for this run, or reports that another run has it.
 *
 * Called before the review, not before the process: standing down has to be cheaper than
 * the thing it prevents, and everything expensive happens after this returns.
 */
export async function claimRunLease(ref: PrRef, now: number = Date.now()): Promise<LeaseDecision> {
  if (RUN_LEASE_MS === 0) return { acquired: true };

  let threads: Thread[];
  let selfId: string | undefined;
  try {
    [threads, selfId] = await Promise.all([listThreads(ref), selfIdentityId(ref)]);
  } catch (e) {
    log(`[WARN] could not read the run lease: ${e instanceof Error ? e.message : String(e)} — reviewing anyway`);
    return { acquired: true };
  }

  const summary = ownSummary(threads, selfId);
  if (!summary) {
    logVerbose("No prloop summary on this PR yet, so there is no run lease to take");
    return { acquired: true };
  }

  const existing = readMarkers(summary.body).run;
  if (existing && existing.id !== RUN_ID) {
    const age = now - existing.startedAt;
    if (leaseIsLive(existing.startedAt, now, RUN_LEASE_MS)) {
      return {
        acquired: false,
        reason:
          `run ${existing.id} started ${ageText(age)} ago still holds this pull request` +
          (age < 0 ? " (its clock reads ahead of ours)" : ""),
      };
    }
    // Loud, and it names the knob: a review that legitimately runs longer than the window
    // gets taken over mid-flight, and this line is the only warning an operator will get
    // before two runs post the same findings.
    log(
      `[WARN] taking over from run ${existing.id}, which started ${ageText(age)} ago and never finished. ` +
        `If reviews here take that long, raise PRR_RUN_LEASE_MS`,
    );
  }

  const marker = runMarker(now, RUN_ID);
  try {
    await updateComment(ref, summary.threadId, summary.commentId, setRunMarker(summary.body, marker));
  } catch (e) {
    log(`[WARN] could not take the run lease: ${e instanceof Error ? e.message : String(e)} — reviewing anyway`);
    return { acquired: true };
  }

  // Read back. Two runs claiming at the same instant both wrote, ADO serialised them, and
  // the body now carries exactly one id — so the one that reads its own id back proceeds and
  // the other stands down. It does not make this a mutex: a run that reads back before the
  // other one writes still sees its own id. It turns an unbounded overlap into a
  // sub-round-trip one, for the price of a GET.
  try {
    const after = ownSummary(await listThreads(ref), selfId);
    const winner = after ? readMarkers(after.body).run : undefined;
    if (winner && winner.id !== RUN_ID) {
      return { acquired: false, reason: `run ${winner.id} claimed this pull request at the same moment` };
    }
  } catch (e) {
    // The write is already on the PR; not being able to confirm it is not a reason to
    // abandon a review, only a reason to say the confirmation did not happen.
    logVerbose(`Could not confirm the run lease: ${e instanceof Error ? e.message : String(e)}`);
  }

  held = true;
  logVerbose(`Holding the run lease as ${RUN_ID}`);
  return { acquired: true };
}

/**
 * Gives the PR back, if this run still has it.
 *
 * A normal run needs nothing from this: publish() rewrites the summary from scratch, and the
 * rewritten body carries no lease marker, so the lease is released by the same request that
 * posts the review. What is left for this function is every other way a run ends — a merged
 * PR it decided not to review, a crash, a stage that threw — where the summary is never
 * rewritten and the marker would otherwise sit there until it expired.
 *
 * It asks rather than assuming, which is one GET on a run that has already made dozens, and
 * buys two things: it never strips a marker another run has since written over ours, and a
 * publish that quietly failed to update the summary still gets the lease released.
 */
export async function releaseRunLease(ref: PrRef): Promise<void> {
  if (!held) return;
  held = false;
  try {
    const summary = ownSummary(await listThreads(ref), await selfIdentityId(ref));
    if (!summary) return;
    const current = readMarkers(summary.body).run;
    if (!current || current.id !== RUN_ID) return;
    await updateComment(ref, summary.threadId, summary.commentId, setRunMarker(summary.body, ""));
    logVerbose(`Released the run lease ${RUN_ID}`);
  } catch (e) {
    // Best effort by design. A lease nobody released expires on its own, which is the
    // failure mode the window exists to bound; turning that into a failed run would redden
    // a cron over a review that actually succeeded.
    logVerbose(`Could not release the run lease: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Test seam: forget that this process holds a lease. */
export function resetLeaseState(): void {
  held = false;
}
