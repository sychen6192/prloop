// What a review needs from the service that hosts the pull request: the one seam between the
// pipeline and Azure DevOps.
//
// orchestrator.ts, the requirement axis and three publish/ modules used to import ado/
// directly. The seams that grew around that one at a time — an intake here, a conventions
// reader there, a reader of the fingerprints already posted, a work-item reader — were four
// optional parameters with four Azure DevOps defaults: nothing said what a host owes the
// pipeline, and a local review still reached ADO wherever nobody had added a parameter yet.
// This is the whole list, in one place. ado/host.ts implements it against the REST API;
// git/host.ts against a working tree, with no discussion at all.
//
// The thread shapes below are Azure DevOps's, and on purpose: it is the one host that
// writes, and the lifecycle reads its statuses (fixed, wontFix, byDesign) as what a reviewer
// did with a comment and its right/left spans as where a comment sits. A second host maps its
// own threads onto them. The hidden markers inside comment bodies are the host-independent
// part, and their bytes are publish/markers.ts's alone — a host stores a body and hands it
// back unchanged, and must never rewrite one.
import { BOT_IDENTITY_IDS } from "../config";
import type { IntakeOptions, ReviewContext } from "./context";
import type { ConventionDoc } from "./conventions";
import type { Anchor, PrInfo, PrRef, WorkItem } from "./types";

export interface ThreadComment {
  id: number;
  content?: string;
  commentType?: string;
  isDeleted?: boolean;
  author?: { displayName?: string; id?: string };
  // Who liked the comment. The one positive signal ADO records that costs a reader a single
  // click; absent on servers that do not return it.
  usersLiked?: Array<{ id?: string }>;
}

export interface Thread {
  id: number;
  status?: string;
  comments?: ThreadComment[];
  // Where the thread sits. `filePath` as the host reports it — ADO's carries a leading
  // slash — and resolved through the FileIndex by every reader, never compared raw.
  threadContext?: {
    filePath?: string;
    rightFileStart?: { line?: number; offset?: number };
    rightFileEnd?: { line?: number; offset?: number };
    leftFileStart?: { line?: number; offset?: number };
    leftFileEnd?: { line?: number; offset?: number };
  };
  isDeleted?: boolean;
}

export type ThreadStatus = "active" | "fixed" | "wontFix" | "closed" | "byDesign" | "pending";

export interface CreateThreadInput {
  content: string;
  status?: ThreadStatus;
  // Omit for a PR-level (non-file) comment.
  filePath?: string;
  anchor?: Anchor;
  changeTrackingId?: number;
  iterationId?: number;
  firstComparingIteration?: number;
}

/** The merge-gate status a review reports. */
export type StatusState = "notSet" | "pending" | "succeeded" | "failed" | "error" | "notApplicable";

/** The acceptance criteria a change is judged against. */
export interface LinkedRequirements {
  items: WorkItem[];
  // Parents pulled in because the directly-linked item had no criteria of its own.
  inheritedFrom: number[];
}

/**
 * One pull request, as the service that hosts it answers for it.
 *
 * Reads may throw; every caller decides what a failed read costs (a failed conventions read
 * costs the finders their context, a failed thread read makes publish() write nothing). A
 * write the host refused throws an Error carrying the HTTP `status` when there was one:
 * publish() reads a 4xx as a refusal that will not change on the next run (refusalStatus).
 */
export interface ReviewHost {
  /** The pull request this host answers for; runs/ and the learning stores file under it. */
  readonly ref: PrRef;

  // ── What to review ──

  /**
   * The change, as a ReviewContext (libs/context.ts states what one guarantees). compareTo 0
   * is the whole pull request; above 0, only what changed since that iteration.
   */
  intake(compareTo: number, opts?: IntakeOptions): Promise<ReviewContext>;
  /**
   * Every path the WHOLE pull request adds, edits or renames to (deletions left out), canonical,
   * with nothing read. For a stage that must know whether the change touches something before it
   * pays to read it: an incremental run's context lists one push, not the pull request.
   */
  changedPaths(): Promise<string[]>;
  /**
   * Why this pull request can take no writes at all, worded for the log, or undefined when
   * it can. The host's to say, because the vocabulary of pull request states is its own.
   */
  terminal(pr: PrInfo): string | undefined;
  /**
   * The repository's own instruction documents at `commit`, for a change touching
   * `changedPaths` (the scoped ones apply to some files only).
   */
  conventions(commit: string, changedPaths: readonly string[]): Promise<ConventionDoc[]>;
  /** What the change was asked to do: the pull request's linked work items, or their kin. */
  requirements(): Promise<LinkedRequirements>;

  // ── What has been said on it, and saying more ──

  /** Every comment thread on the pull request, deleted ones left out. */
  threads(): Promise<Thread[]>;
  /**
   * The identity prloop writes as, lower-cased, or undefined when the host cannot say —
   * which isSelfIdentity then reads as "trust the markers alone".
   */
  selfId(): Promise<string | undefined>;
  createThread(input: CreateThreadInput): Promise<Thread>;
  /** Replaces a comment's whole body: how the sticky summary stays one comment across runs. */
  updateComment(threadId: number, commentId: number, content: string): Promise<void>;
  setThreadStatus(threadId: number, status: ThreadStatus): Promise<void>;
  postStatus(state: StatusState, description: string, opts?: { iterationId?: number; targetUrl?: string }): Promise<void>;
}

/**
 * Whether `authorId` is prloop.
 *
 * `extra` exists for the one case the identity check would otherwise break: prloop's
 * credential legitimately changes. The documented path onto a pipeline is to trial it from
 * a laptop PAT and then move to the build service account, and the threads the laptop left
 * are genuinely prloop's even though a different identity wrote them. Without a way to say
 * so, the first pipeline run would re-review every PR from scratch and stop harvesting the
 * dismissals recorded against those threads.
 *
 * With no self identity to compare against, everything with a marker counts — the degraded
 * mode ado/identity.ts warns about.
 */
export function isSelfIdentity(
  authorId: string | undefined,
  selfId: string | undefined,
  extra: readonly string[] = BOT_IDENTITY_IDS,
): boolean {
  if (selfId === undefined) return true;
  const id = authorId?.trim().toLowerCase();
  if (!id) return false;
  return id === selfId || extra.includes(id);
}

/** The HTTP status a host's write was refused with, when the error carries one. */
export function refusalStatus(e: unknown): number | undefined {
  const status = e instanceof Error ? (e as Error & { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : undefined;
}
