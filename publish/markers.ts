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
import { createHash } from "node:crypto";
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
const SPAN_RE = /<!-- prloop:span=(\d+)\.([0-9a-f]{12}) -->/;
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

/**
 * The code a comment was about: how many lines, and a hash of their text. What lets a later
 * run find that code again by CONTENT, wherever it has moved, instead of trusting the line
 * number the thread was posted on.
 *
 * Positions alone were wrong both ways. Lines inserted above a comment moved its code down,
 * and the old position then "covered" whatever new code landed there, suppressing a real
 * finding; lines deleted above it could put the old position past the end of the file,
 * which read as "the code is gone" and closed a live thread as fixed. ADO can track a
 * thread's position to a later iteration, but what it returns for code that was deleted is
 * undocumented, and this does not need it.
 */
export interface SpanMark {
  lines: number;
  hash: string;
}

/**
 * The span mark of some lines. Whitespace inside a line is collapsed and each line trimmed,
 * so a re-indent or a reformat is the same code, while any change to a token is not.
 */
export function spanMark(lines: readonly string[]): SpanMark {
  const text = lines.map((l) => l.replace(/\s+/g, " ").trim()).join("\n");
  return { lines: lines.length, hash: createHash("sha1").update(text).digest("hex").slice(0, 12) };
}

/** Markers for an inline finding comment: authorship, issue identity, category, the code. */
export function findingMarkers(f: { fingerprint: string; category: string }, span?: SpanMark): string {
  return (
    `${BOT_MARKER}<!-- prloop:fp=${f.fingerprint} --><!-- prloop:cat=${f.category} -->` +
    (span ? `<!-- prloop:span=${span.lines}.${span.hash} -->` : "")
  );
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

/**
 * Makes every HTML comment opener in `text` inert, for text prloop did not write on its way
 * into a comment body: acceptance criteria, the model's claims and notes, a gateway's error.
 *
 * Two failures, one cause. A quoted `<!-- prloop:… -->` is this protocol's own syntax inside a
 * comment prloop signs, and the readers above can only be as careful as the bytes they are
 * given. And any HTML comment in quoted text hides its own content from the humans reading
 * the PR, while a bare opener at the start of a line — a claim or a note — begins an HTML
 * block that nothing closes, which a browser reads as a comment running to the end of the
 * body: everything prloop wrote after it disappears from view.
 *
 * Broken rather than removed: the text stays readable, which matters when the criterion is
 * about HTML. A zero-width space rather than an entity: `&lt;` renders as `<` in prose but
 * literally inside a code span, and quoted paths and code sit in both.
 */
export function defuseHtmlComments(text: string): string {
  return text.replaceAll("<!--", "<!\u200B--");
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
  /** The code the comment was about; absent on comments written before the marker. */
  span?: SpanMark;
  /** The iteration recorded by the run that wrote this comment. */
  iteration?: number;
  /** A run that had this PR in hand when it wrote this comment (publish/lease.ts). */
  run?: { startedAt: number; id: string };
}

const NONE: CommentMarkers = { ours: false, summary: false, fingerprints: [] };

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

/**
 * The run of markers at the very end of the body — where publish() has always appended the
 * iteration marker and the lease appends its own, and the only place either is read from.
 *
 * Both used to be read from anywhere in the body, on the argument that their readers' guards
 * (written by prloop, and the summary) made position irrelevant. They did not, because the
 * summary is prloop's own comment and it quotes text prloop did not write: acceptance
 * criteria, the model's notes and claims. libs/html.ts decodes entities after stripping tags,
 * so a work item whose criterion read `&lt;!-- prloop:iteration=5 --&gt;` arrived as a live
 * marker inside a comment that passes both guards, ahead of the real one — and a forged
 * "already reviewed" iteration is a push `--since auto` never reviews. The end of the body is
 * out of quoted text's reach: every summary closes on prloop's own footer line, and the
 * markers come after it.
 */
const TRAILING_MARKERS = /(?:<!-- prloop(?::[^>]*)? -->\s*)+$/;

/** Reads the protocol out of a comment body. Undefined and empty bodies read as "not ours". */
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
  const span = SPAN_RE.exec(head);
  const tail = TRAILING_MARKERS.exec(body)?.[0] ?? "";
  const iter = ITERATION_RE.exec(tail)?.[1];
  const run = RUN_RE.exec(tail);
  return {
    ours: true,
    summary: head.includes(SUMMARY_MARKER),
    ...(fingerprints[0] === undefined ? {} : { fingerprint: fingerprints[0] }),
    fingerprints,
    ...(cat !== undefined && CATEGORIES.has(cat) ? { category: cat as FindingCategory } : {}),
    ...(span?.[1] === undefined || span[2] === undefined || Number(span[1]) < 1 ? {} : { span: { lines: Number(span[1]), hash: span[2] } }),
    ...(iter === undefined ? {} : { iteration: Number(iter) }),
    ...(run?.[1] === undefined || run[2] === undefined ? {} : { run: { startedAt: Number(run[1]), id: run[2] } }),
  };
}
