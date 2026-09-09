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
}

const NONE: CommentMarkers = { ours: false, summary: false, fingerprints: [] };

/** Reads the protocol out of a comment body. Undefined and empty bodies read as "not ours". */
export function readMarkers(body: string | undefined): CommentMarkers {
  if (!body) return NONE;
  const fingerprints: string[] = [];
  for (const m of body.matchAll(FP_RE)) {
    const fp = m[1];
    if (fp && FP_SHAPE.test(fp)) fingerprints.push(fp);
  }
  const cat = CAT_RE.exec(body)?.[1];
  const iter = ITERATION_RE.exec(body)?.[1];
  return {
    ours: body.includes(BOT_MARKER),
    summary: body.includes(SUMMARY_MARKER),
    ...(fingerprints[0] === undefined ? {} : { fingerprint: fingerprints[0] }),
    fingerprints,
    ...(cat !== undefined && CATEGORIES.has(cat) ? { category: cat as FindingCategory } : {}),
    ...(iter === undefined ? {} : { iteration: Number(iter) }),
  };
}
