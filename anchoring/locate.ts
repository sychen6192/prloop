// Quote-based re-anchoring.
//
// Models never emit line numbers (their schema has no such field). They quote the source
// line; we find that quote in the blob bytes of the iteration under review and compute the
// coordinates ourselves. When the quote can't be located unambiguously we fail closed and
// degrade the finding into the summary comment — we never guess a line.
//
// This is what makes comments land on the right line, and it doubles as a hallucination
// filter: a quote that doesn't exist in the file means the finding was invented.
//
// Everything after the first exact attempt is RECOVERY, not leniency. An audit of degraded
// findings showed the same handful of reshapings again and again — the model kept the
// diff's `+`/`-` column, pasted a line-number gutter, elided the middle of a block with
// "...", typed curly quotes, or quoted a block whose first line alone was verbatim — and
// each cost a real defect its inline comment. Every recovery path below still ends at the
// same gate: one located, unambiguous, inside-the-change span, or a named failure. The
// failure taxonomy does not grow; only the number of quotes that reach an anchor does.
import type { FileIndex } from "../libs/fileindex";
import type { Anchor, AnchorFailure, FileDiff, RawFinding } from "../libs/types";

export interface AnchorResult {
  anchor?: Anchor;
  failure?: AnchorFailure;
  // Human-readable detail for the degraded-findings section of the summary.
  detail?: string;
  file?: FileDiff;
}

/** Strips a trailing CR so CRLF files compare equal to what the model echoed back. */
function stripCr(s: string): string {
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}

/**
 * Folds the characters a model substitutes while "tidying" a quote: NFKC collapses the
 * full-width punctuation that comes back with CJK sources, and the explicit maps cover the
 * typographic quotes and dashes a chat-tuned model types where the file has ASCII. None of
 * those bytes are in the blob, so the quote misses by a character nobody can see in the diff.
 *
 * Written as escapes, never as the characters themselves: a raw curly quote in this source
 * is invisible in a diff and one normalising editor away from becoming an ASCII one, which
 * would turn the fold into a silent no-op.
 */
function foldUnicode(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2007\u202F]/g, " ");
}

interface Tier {
  normalize: (s: string) => string;
  /**
   * Tiers that can invent a match. Folding characters together makes lines equal that are
   * not equal in the file, so a hit here is only accepted when the model's own stated
   * context confirms it — looser matching must widen recall, never manufacture ambiguity.
   */
  needsContext?: true;
}

// Tried in order. Earlier tiers are stricter; we stop at the first tier that finds any
// candidate, so loose matching never overrides an exact hit.
const TIERS: readonly Tier[] = [
  { normalize: (s) => stripCr(s).replace(/\s+$/, "") },
  { normalize: (s) => stripCr(s).trim() },
  { normalize: (s) => stripCr(s).replace(/\s+/g, " ").trim() },
  { normalize: (s) => foldUnicode(stripCr(s)).replace(/\s+/g, " ").trim(), needsContext: true },
];

// Context is scored at the loosest tier, always — see contextScore.
const LOOSEST = TIERS[TIERS.length - 1]!.normalize;

function quoteLines(quote: string): string[] {
  return quote
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l, i, arr) => !(l.trim() === "" && (i === 0 || i === arr.length - 1)));
}

interface Candidate {
  startLine: number; // 1-based
  endLine: number; // 1-based
}

/** Locates a needle in a haystack. The same shape for a plain and an elided quote. */
type Matcher = (haystack: string[], normalize: (s: string) => string) => Candidate[];

function findWindows(haystack: string[], needle: string[], normalize: (s: string) => string): Candidate[] {
  // Blank lines are elastic on both sides: the needle's blanks are dropped, and blank
  // haystack lines may sit between consecutive needle lines. Models quoting a small
  // function routinely keep OR drop its interior blank lines — requiring adjacency made
  // the verbatim-with-blank quote unfindable at its true location, which then either
  // degraded a perfectly-quoted finding or, worse, matched a blankless duplicate elsewhere.
  const n = needle.map(normalize).filter((l) => l !== "");
  if (n.length === 0) return [];
  const hay = haystack.map(normalize);
  const out: Candidate[] = [];

  for (let i = 0; i < hay.length; i++) {
    if (hay[i] !== n[0]) continue;
    let k = i;
    let ok = true;
    for (let j = 1; j < n.length; j++) {
      let next = k + 1;
      while (next < hay.length && hay[next] === "") next++;
      if (next >= hay.length || hay[next] !== n[j]) {
        ok = false;
        break;
      }
      k = next;
    }
    if (ok) out.push({ startLine: i + 1, endLine: k + 1 });
  }
  return out;
}

// --- quote reshapings the model applies before we ever see the text -------------------

/**
 * The model quoted the DIFF instead of the source, keeping the `+`, `-` or context space
 * in column one. Only a uniform prefix is stripped: a needle mixing `+` and `-` lines is an
 * excerpt of two different file versions, and picking a side would anchor a removed line
 * onto the new file. Returns undefined when there is nothing to strip.
 *
 * The raw needle is always tried FIRST, because these characters are also ordinary source
 * text: a YAML list (`- item`), a markdown bullet, or a diff quoted inside a fenced block
 * are literally what the file contains, and stripping their first column would turn a
 * correct quote into a miss.
 */
function stripDiffPrefix(needle: string[]): string[] | undefined {
  const meaningful = needle.filter((l) => l.trim() !== "");
  if (meaningful.length === 0) return undefined;
  const c = meaningful[0]![0];
  if (c !== "+" && c !== "-" && c !== " ") return undefined;
  if (!meaningful.every((l) => l[0] === c)) return undefined;
  return needle.map((l) => (l.startsWith(c) ? l.slice(1) : l));
}

// `  15 | code` (ripgrep, GitHub's blob view) and `15: code` (grep -n, most IDEs).
const GUTTER = /^\s*\d+\s*[|:]\s?/;

/**
 * The model copied a line-number gutter along with the code. Every non-blank line has to
 * carry one before we strip: a single `8080: backend` line is a YAML mapping, not a gutter,
 * and this only runs after the raw needle already failed to match anything.
 */
function stripGutter(needle: string[]): string[] | undefined {
  const meaningful = needle.filter((l) => l.trim() !== "");
  if (meaningful.length === 0 || !meaningful.every((l) => GUTTER.test(l))) return undefined;
  return needle.map((l) => (l.trim() === "" ? l : l.replace(GUTTER, "")));
}

// `...`, `…`, and the same thing behind a comment marker (`// ...`, `# ...`, `<!-- ... -->`).
const ELISION = /^(?:\/\/+|#+|--|;+|\/\*|\*|<!--)?\s*(?:\.{3,}|\u2026)\s*(?:\*\/|-->)?$/;

// How far apart the pieces of an elided quote may sit. A model eliding a block means "and
// some more of the same function"; 30 lines is a generous function and a hard stop, so an
// elision can never staple together two unrelated regions of a file.
const ELISION_MAX_GAP = 30;

/**
 * Splits a quote at its elision markers. A quote containing `...` on a line of its own is
 * not a verbatim quote at all — it says "these lines, then a gap, then these" — and matched
 * whole it can only fail. Returns undefined when there is no elision to honour.
 */
function elisionSegments(needle: string[]): string[][] | undefined {
  if (!needle.some((l) => ELISION.test(l.trim()))) return undefined;
  const segs: string[][] = [];
  let cur: string[] = [];
  for (const l of needle) {
    if (ELISION.test(l.trim())) {
      if (cur.some((x) => x.trim() !== "")) segs.push(cur);
      cur = [];
    } else cur.push(l);
  }
  if (cur.some((x) => x.trim() !== "")) segs.push(cur);
  return segs.length > 0 ? segs : undefined;
}

/** Matches the segments of an elided quote in order, each within ELISION_MAX_GAP of the last. */
function findElidedWindows(haystack: string[], segs: string[][], normalize: (s: string) => string): Candidate[] {
  const perSegment = segs.map((s) => findWindows(haystack, s, normalize));
  if (perSegment.some((w) => w.length === 0)) return [];

  const out: Candidate[] = [];
  for (const start of perSegment[0]!) {
    let end = start.endLine;
    let ok = true;
    for (let s = 1; s < perSegment.length; s++) {
      // The NEAREST continuation, not every continuation. The anchor reports where the
      // quote starts, so pairing one start with several possible ends would report
      // ambiguity about a line number that was never in doubt.
      const next = perSegment[s]!.find((c) => c.startLine > end && c.startLine - end - 1 <= ELISION_MAX_GAP);
      if (!next) {
        ok = false;
        break;
      }
      end = next.endLine;
    }
    if (ok) out.push({ startLine: start.startLine, endLine: end });
  }
  return out;
}

/**
 * Scores a candidate by how well the surrounding lines match the model's stated context.
 *
 * Always at the loosest tier. Context can never create an anchor — it only chooses between
 * candidates the quote already produced — so there is nothing to protect by scoring it
 * strictly, and scoring it at the quote's own tier lost real findings: on a tier-1 duplicate
 * a context line the model had re-indented scored 0, the candidate was ruled contradicted,
 * and the finding degraded although the same context matched perfectly one tier down.
 */
function contextScore(lines: string[], cand: Candidate, before: string[], after: string[]): number {
  let score = 0;
  for (let k = 0; k < before.length; k++) {
    const want = LOOSEST(before[before.length - 1 - k]!);
    if (want === "") continue;
    const idx = cand.startLine - 2 - k; // 0-based index of the line above
    if (idx >= 0 && LOOSEST(lines[idx] ?? "") === want) score++;
  }
  for (let k = 0; k < after.length; k++) {
    const want = LOOSEST(after[k]!);
    if (want === "") continue;
    const idx = cand.endLine + k; // 0-based index of the line below
    if (idx < lines.length && LOOSEST(lines[idx] ?? "") === want) score++;
  }
  return score;
}

function inAnyHunk(file: FileDiff, cand: Candidate, side: "right" | "left"): boolean {
  // Span overlap, not just the start line: a model quoting a whole function whose changed
  // line sits near the bottom starts its quote above the hunk, and testing only startLine
  // rejected exactly the findings that most deserve to land.
  return file.hunks.some((h) => {
    const start = side === "right" ? h.rightStart : h.leftStart;
    const count = side === "right" ? h.rightCount : h.leftCount;
    const end = start + Math.max(count, 1) - 1;
    return cand.startLine <= end && cand.endLine >= start;
  });
}

function touchesChangedLine(file: FileDiff, cand: Candidate, side: "right" | "left"): boolean {
  const changed = side === "right" ? file.changedRightLines : file.changedLeftLines;
  for (let l = cand.startLine; l <= cand.endLine; l++) {
    if (changed.has(l)) return true;
  }
  return false;
}

function mkAnchor(lines: string[], cand: Candidate, side: "right" | "left"): Anchor {
  const lastLine = stripCr(lines[cand.endLine - 1] ?? "");
  return {
    side,
    startLine: cand.startLine,
    endLine: cand.endLine,
    // ADO's docs say offsets start at 0 but its own examples use 1, and 0/missing
    // offsets are implicated in the UI breakage of azure-devops-mcp #793.
    // Always send both ends, always 1-based.
    startOffset: 1,
    endOffset: Math.max(lastLine.length + 1, 1),
  };
}

export function anchorFinding(finding: RawFinding, index: FileIndex): AnchorResult {
  const res = index.resolve(finding.file);
  if (!res.fd) {
    // The two resolution failures degrade under different names: "file not in this
    // change" is a true statement only for not-found, and an ambiguous path needs the
    // summary to say so.
    return {
      failure: res.failure === "ambiguous" ? "file-ambiguous" : "file-not-in-diff",
      detail: res.detail,
    };
  }
  const file = res.fd;

  const stated: "right" | "left" = finding.side === "left" ? "left" : "right";
  const primary = anchorOnSide(finding, file, stated);
  if (primary.anchor) return primary;

  // `side` is a required enum in the finder schema with no natural default, so a model that
  // was given no reason to prefer one effectively guesses — and a guessed "left" on an added
  // file has no content to match against at all. Retry the other side rather than losing the
  // finding to a coin flip.
  //
  // Only for quote-not-found. "outside-changed-lines" and "quote-ambiguous" are real verdicts
  // about a quote we DID locate; retrying past them would smuggle in exactly the findings
  // those checks exist to stop.
  if (primary.failure === "quote-not-found") {
    const other = stated === "right" ? "left" : "right";
    const fallback = anchorOnSide(finding, file, other);
    if (fallback.anchor) return fallback;
  }
  return primary;
}

function anchorOnSide(finding: RawFinding, file: FileDiff, side: "right" | "left"): AnchorResult {
  const lines = side === "right" ? file.rightLines : file.leftLines;
  if (lines.length === 0) {
    // Not "file-not-in-diff": the file IS in the change set, the side is just empty (an add
    // has no left side, a delete no right). Reporting it as a missing file sent debugging
    // after the path resolver instead of the side.
    return {
      file,
      failure: "quote-not-found",
      detail: `file "${file.path}" has no ${side}-side content to match against`,
    };
  }

  const raw = quoteLines(finding.quote ?? "");
  if (raw.length === 0) {
    return { file, failure: "quote-not-found", detail: "finding carries no quote" };
  }

  const before = quoteLines(finding.context_before ?? "");
  const after = quoteLines(finding.context_after ?? "");

  // The needle as the model wrote it, then each reshaping we know how to undo. Order is
  // yield order, and the raw needle is always first: a recovery path must never get to
  // reinterpret text that matches the file exactly as written.
  const needles = [raw];
  const unprefixed = stripDiffPrefix(raw);
  if (unprefixed) needles.push(unprefixed);
  const ungutted = stripGutter(raw);
  if (ungutted) needles.push(ungutted);

  const attempts: Matcher[] = [];
  for (const needle of needles) {
    attempts.push((hay, normalize) => findWindows(hay, needle, normalize));
    const segs = elisionSegments(needle);
    if (segs) attempts.push((hay, normalize) => findElidedWindows(hay, segs, normalize));
  }

  for (const find of attempts) {
    const r = locate(find, file, lines, side, before, after);
    if (r.anchor) return r;
    // A quote we DID locate and then rejected is a verdict, not a miss. Reshaping the
    // needle and trying again past "ambiguous" or "outside this change" would smuggle in
    // exactly the findings those two checks exist to stop.
    if (r.failure !== "quote-not-found") return r;
  }

  const head = firstLineOnly(raw, file, lines, side);
  if (head) return head;

  // Nothing matched. The message carries the quote as the MODEL wrote it, never as a
  // recovery path reshaped it: that string is what someone reading the degraded-findings
  // list will search the file for.
  return {
    file,
    failure: "quote-not-found",
    detail: `quote not found in ${file.path}: "${(finding.quote ?? "").slice(0, 80)}"`,
  };
}

/** One matcher, walked down the tiers. Returns an anchor or the named reason it has none. */
function locate(
  find: Matcher,
  file: FileDiff,
  lines: string[],
  side: "right" | "left",
  before: string[],
  after: string[],
): AnchorResult {
  // A candidate accepted at a strict tier whose model-provided context scores zero. Kept
  // as a fallback while looser tiers get a chance to produce a context-confirmed match:
  // a model that reformats the line it quotes (stripped indentation, say) can hit a
  // different-but-textually-exact line at tier 1 while the intended line only matches at
  // tier 2 — and only the context can tell those apart.
  let contradicted: Candidate | undefined;
  const hasContext = before.length > 0 || after.length > 0;

  for (const tier of TIERS) {
    const cands = find(lines, tier.normalize);
    if (cands.length === 0) continue;

    let pool = cands;
    if (pool.length > 1) {
      // 1) the model's own context is the strongest disambiguator
      const scored = pool.map((c) => ({ c, s: contextScore(lines, c, before, after) }));
      const best = Math.max(...scored.map((x) => x.s));
      if (best > 0) pool = scored.filter((x) => x.s === best).map((x) => x.c);
    }
    if (pool.length > 1) {
      // 2) prefer a candidate that sits on a line this PR actually touched
      const onChanged = pool.filter((c) => touchesChangedLine(file, c, side));
      if (onChanged.length > 0) pool = onChanged;
    }
    if (pool.length > 1) {
      // 3) prefer a candidate inside a hunk (change + context window)
      const inHunk = pool.filter((c) => inAnyHunk(file, c, side));
      if (inHunk.length > 0) pool = inHunk;
    }

    if (pool.length !== 1) {
      return {
        file,
        failure: "quote-ambiguous",
        detail: `quote occurs ${cands.length} times in ${file.path}; context could not disambiguate`,
      };
    }

    const confirmed = contextScore(lines, pool[0]!, before, after) > 0;
    // A folding tier's hit stands only on the context. Without context there is nothing to
    // confirm it with, so the finding stays failed rather than landing on a line that
    // merely looks the same once the characters are folded together.
    if (tier.needsContext && !confirmed) continue;
    if (hasContext && !confirmed) {
      if (!contradicted) contradicted = pool[0]!;
      continue; // try a looser tier for a candidate the context actually confirms
    }

    const cand = pool[0]!;
    if (!inAnyHunk(file, cand, side)) {
      // reviewdog's diff_context filter, applied to LLM findings: an issue outside the
      // changed region is not this PR's business.
      return {
        file,
        failure: "outside-changed-lines",
        detail: `quote located at ${file.path}:${cand.startLine}, outside this change`,
      };
    }
    return { file, anchor: mkAnchor(lines, cand, side) };
  }

  // No tier produced a context-confirmed match; fall back to the exact-but-unconfirmed
  // candidate rather than degrading — the model's context lines may simply have been
  // reworded, and the quote itself did match uniquely.
  if (contradicted) {
    if (!inAnyHunk(file, contradicted, side)) {
      return {
        file,
        failure: "outside-changed-lines",
        detail: `quote located at ${file.path}:${contradicted.startLine}, outside this change`,
      };
    }
    return { file, anchor: mkAnchor(lines, contradicted, side) };
  }

  return { file, failure: "quote-not-found", detail: `quote not found in ${file.path}` };
}

/**
 * Last resort for a multi-line quote that nothing could locate whole: its first non-blank
 * line, alone.
 *
 * A model quoting a block usually copies the opening line exactly and then drifts —
 * reflows an argument list, drops a comment, paraphrases the body — so the block misses
 * while the line that names it is verbatim. Accepted ONLY when that line occurs exactly
 * once in the file AND the occurrence is a line this PR changed: a unique first line is
 * evidence, but a common one (`}`, `return;`, `try {`) would be a guess wearing a match's
 * clothes, and guessing is the one thing this module exists to prevent.
 *
 * Both sides. It used to refuse on the left, because changedRightLines was the only
 * per-line changed set a FileDiff carried and the second half of that bargain could not be
 * held up there — a limit of the type, not of the rule. anchorFinding retries the other
 * side precisely because `side` is a required enum the model often guesses, so the side a
 * finding lands on should not decide how much recovery it gets.
 */
function firstLineOnly(
  needle: string[],
  file: FileDiff,
  lines: string[],
  side: "right" | "left",
): AnchorResult | undefined {
  if (needle.length < 2) return undefined;
  const head = needle.find((l) => l.trim() !== "");
  if (head === undefined) return undefined;

  for (const tier of TIERS) {
    if (tier.needsContext) continue; // a folded match has nothing to confirm it here
    const cands = findWindows(lines, [head], tier.normalize);
    if (cands.length === 0) continue;
    if (cands.length > 1) return undefined; // not unique: evidence, or nothing
    const cand = cands[0]!;
    if (!touchesChangedLine(file, cand, side) || !inAnyHunk(file, cand, side)) return undefined;
    return { file, anchor: mkAnchor(lines, cand, side) };
  }
  return undefined;
}
