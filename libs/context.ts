// What every gate downstream reads, and what a provider that builds it owes them.
//
// This type used to live inside ado/intake.ts, one of the two modules that produce it, and
// git/intake.ts imported it from there. A seam owned by one of its sides states nothing:
// there was no place to write down what a provider must guarantee, and the two providers had
// already drifted apart on three fields — the rename trail, the difference between "this file
// is absent at that ref" and "we could not read it", and the sentinels local mode fills the
// ADO-shaped fields with.
//
// The contract is in the field comments below. It is short on purpose: a provider that cannot
// meet one of these has to say so through `skipped`, never by leaving a field looking valid.
import type { FileIndex } from "./fileindex";
import type { FileDiff, Iteration, PrInfo, PrRef } from "./types";

/** A file the provider saw and deliberately did not hand over, and why. */
export interface SkippedFile {
  path: string;
  /**
   * Free text, with two values load-bearing across every provider:
   * - `"too large"` — orchestrator.ts counts these into coverageGaps, so a file nobody could
   *   read makes the run incomplete rather than passing as a clean review.
   * - `"binary"` — deliberately not counted: nothing in it was reviewable anyway.
   * Everything else is for the summary only.
   */
  reason: string;
}

export interface ReviewContext {
  ref: PrRef;
  pr: PrInfo;
  iterations: Iteration[];
  // The iteration being reviewed (always the latest). A provider with no real iteration
  // numbering still supplies one, because it is the key every artifact and the sticky
  // summary's marker are filed under.
  iteration: Iteration;
  // 0 = full PR; >0 = incremental review since that iteration (M5).
  compareTo: number;
  /**
   * Every file to review, with real line indexes computed from the bytes of THIS iteration.
   *
   * The guarantees anchoring rests on, which a provider must not fudge:
   * - `rightLines` / `leftLines` are the exact content, split the way a diff viewer counts
   *   (libs/text.ts). Never a local checkout's version, whose line endings may differ.
   * - `changedRightLines` / `changedLeftLines` are complete for the file.
   * - `path` is canonical: no leading slash, forward separators.
   * - `originalPath` is set on every rename. libs/fileindex.ts follows it to keep a thread
   *   created on the old name attached, and libs/payload.ts renders it; a provider that
   *   reports changeType "rename" without it silently breaks both.
   */
  files: FileDiff[];
  // Changed files the provider did not hand over. A file it FAILED to read belongs here with
  // a reason naming the failure — never omitted, and never passed off as an empty file, which
  // diffs as wholly added and reads downstream as a clean review of code nobody saw.
  skipped: SkippedFile[];
  // ADO's per-file change-tracking ids, needed to attach a thread that survives the next
  // push. Empty from a provider that has no equivalent; publish degrades, it does not break.
  changeTrackingIds: Map<string, number>;
  // Built once, from `files`; the single resolver for foreign path strings (see CONTEXT.md).
  fileIndex: FileIndex;
}

/**
 * What the orchestrator needs from an intake: a PrRef in, a ReviewContext out.
 *
 * Two adapters satisfy it — ado/intake.ts against the REST API, git/intake.ts against a
 * working tree — which is what makes this a real seam rather than a hypothetical one.
 */
export type IntakeProvider = (ref: PrRef) => Promise<ReviewContext>;
