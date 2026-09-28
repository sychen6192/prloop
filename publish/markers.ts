// The hidden-comment protocol: the HTML comments prloop embeds in every comment it
// authors, and reads back on the next run to recognise its own threads.
//
// One module because the grammar has to agree in two directions and it did not have an
// owner. It was five constants across config.ts, format.ts and lifecycle.ts, read back by
// four regexes in publish.ts and lifecycle.ts — with `fp=` and `cat=` each written out
// twice, by hand, in files that never import each other.
//
// The reader's `cat=([a-z-]+)` was the dangerous half: nothing tied that character class to
// FINDING_CATEGORIES, so a category outside it would have parsed as "no category", which
// postedPositions turns into `axis: undefined` — read downstream as "blocks both axes",
// the requirement-thread-swallows-a-code-finding leak publish.ts:57-62 exists to prevent.
// Silent, and invisible to the regression net, because the fixtures were built with the
// writer. So the reader now derives from the category list instead of guessing at its
// shape, and the selftest asserts against literal bytes rather than against the writer.
//
// The bytes are a wire format already sitting on live PRs. Order and spacing are fixed:
// changing them orphans every thread a previous run left behind.
import { FINDING_CATEGORIES, type FindingCategory } from "../config";

/** Identifies authorship. On every comment prloop writes, first thing in the body. */
export const BOT_MARKER = "<!-- prloop -->";
/** Identifies the one sticky summary comment, so a re-run updates it instead of adding one. */
export const SUMMARY_MARKER = "<!-- prloop:summary -->";

// Captured loosely, then validated — the opposite of a character class that has to be kept
// in step with a list it cannot see. An unrecognised value reads as absent, which is the
// conservative answer at every call site.
const FP_RE = /<!-- prloop:fp=([^\s>]+) -->/g;
const CAT_RE = /<!-- prloop:cat=([^\s>]+) -->/;
const ITERATION_RE = /<!-- prloop:iteration=(\d+) -->/;
// One source, two compilations: the strip below has to match the read above byte for byte,
// and two hand-written copies of a marker pattern is the exact drift this module was
// extracted to end.
const RUN_PATTERN = String.raw`<!-- prloop:run=(\d+)\.([0-9a-f]{8}) -->`;
const RUN_RE = new RegExp(RUN_PATTERN);
const RUN_RE_ALL = new RegExp(RUN_PATTERN, "g");

// gates/aggregate.ts hashes a fingerprint to 12 hex characters. Validated by shape rather
// than imported, so the publish side does not depend on the gates; selftest-publish.ts
// feeds a real fingerprint() through this pattern so the two cannot drift apart in silence.
const FP_SHAPE = /^[0-9a-f]{6,64}$/;

const CATEGORIES: ReadonlySet<string> = new Set(FINDING_CATEGORIES);

/** Markers for an inline finding comment: authorship, issue identity, category. */
export function findingMarkers(f: { fingerprint: string; category: string }): string {
  return `${BOT_MARKER}<!-- prloop:fp=${f.fingerprint} --><!-- prloop:cat=${f.category} -->`;
}

/** Markers for the sticky summary comment. */
export function summaryMarkers(): string {
  return `${BOT_MARKER}${SUMMARY_MARKER}`;
}

/**
 * The iteration this run reviewed, appended to the summary. This is the tool's only
 * cross-run state, and it lives in the PR rather than on disk so a pipeline agent, a laptop
 * and a cron box all read the same answer.
 */
export function iterationMarker(id: number): string {
  return `<!-- prloop:iteration=${id} -->`;
}

/**
 * "A run is working on this pull request right now", written into the summary for the length
 * of a run and taken back out by the summary the run publishes (publish/lease.ts).
 *
 * The start time is the holder's, and the READER applies its own PRR_RUN_LEASE_MS to it, so
 * turning the lease off is a local decision rather than something a previous run's bytes
 * decided for you. The id is what tells another machine's live run apart from the corpse of
 * one of your own that crashed — the two are otherwise identical on the wire.
 */
export function runMarker(startedAtMs: number, id: string): string {
  return `<!-- prloop:run=${startedAtMs}.${id} -->`;
}

/**
 * Replaces (or, with an empty marker, removes) the run marker in a comment body, leaving
 * every other byte alone.
 *
 * Alone matters: claiming the lease rewrites the sticky summary of a PR a human is reading,
 * and a claim that re-rendered the body would churn the visible comment twice per run —
 * and would have to reproduce a summary written by a version of prloop that is not this one.
 */
export function setRunMarker(body: string, marker: string): string {
  return body.replace(RUN_RE_ALL, "") + marker;
}

/** Everything the protocol carries, read out of one comment body. */
export interface CommentMarkers {
  /** Written by prloop. Threads without this are somebody else's and are never touched. */
  ours: boolean;
  /** The sticky summary comment. */
  summary: boolean;
  /** First fingerprint in the body; absent on the summary, which carries none. */
  fingerprint?: string;
  /** Every fingerprint in the body, for cross-run dedupe over a whole thread. */
  fingerprints: string[];
  /** Absent when the marker is missing OR names a category this build does not know. */
  category?: FindingCategory;
  /** The iteration recorded by the run that wrote this comment. */
  iteration?: number;
  /** A run that had this PR in hand when it wrote this comment (publish/lease.ts). */
  run?: { startedAt: number; id: string };
}

const NONE: CommentMarkers = { ours: false, summary: false, fingerprints: [] };

/** Reads the protocol out of a comment body. Undefined and empty bodies read as "not ours". */
/**
 * The run of markers at the very start of the body — the only place identity, fingerprint
 * and category are ever written (findingMarkers and summaryMarkers both emit them first,
 * and always have).
 *
 * Reading them from anywhere in the body was a hole of prloop's own making rather than an
 * attacker's: renderFindingComment embeds the model's `claim`, `evidence` and
 * `suggested_fix` verbatim, so a finding that quotes a source line containing
 * `<!-- prloop:summary -->` turned an inline thread into the summary thread on the next
 * run, and an echoed `fp=` suppressed a different finding. Restricting to the leading run
 * costs nothing on a live PR, because that is where every marker prloop has ever written
 * already sits.
 */
const LEADING_MARKERS = /^(?:\s*<!-- prloop(?::[^>]*)? -->)+/;

export function readMarkers(body: string | undefined): CommentMarkers {
  if (!body) return NONE;
  const head = LEADING_MARKERS.exec(body)?.[0] ?? "";
  if (!head.includes(BOT_MARKER)) return NONE;
  const fingerprints: string[] = [];
  for (const m of head.matchAll(FP_RE)) {
    const fp = m[1];
    if (fp && FP_SHAPE.test(fp)) fingerprints.push(fp);
  }
  const cat = CAT_RE.exec(head)?.[1];
  // Read from the WHOLE body, unlike everything above it: publish() appends the iteration
  // marker after the rendered summary, and those bytes are already on live pull requests —
  // markers.ts's own rule is that changing where they sit orphans every thread a previous
  // run left behind. The guard against a forged or model-echoed iteration is not position
  // but the pair of conditions its only reader applies: the comment must be OURS and the
  // SUMMARY, both decided from the leading run above (publish/lifecycle.ts).
  const iter = ITERATION_RE.exec(body)?.[1];
  // Same whole-body read, and for the same reason: the lease marker is appended after the
  // rendered summary, so that a claim never has to re-render a body it did not write. Its
  // reader applies the identical pair of guards (ours, and the summary), plus the identity
  // check — a forged lease is a review that silently never happens.
  const run = RUN_RE.exec(body);
  return {
    ours: true,
    summary: head.includes(SUMMARY_MARKER),
    ...(fingerprints[0] === undefined ? {} : { fingerprint: fingerprints[0] }),
    fingerprints,
    ...(cat !== undefined && CATEGORIES.has(cat) ? { category: cat as FindingCategory } : {}),
    ...(iter === undefined ? {} : { iteration: Number(iter) }),
    ...(run?.[1] === undefined || run[2] === undefined ? {} : { run: { startedAt: Number(run[1]), id: run[2] } }),
  };
}
