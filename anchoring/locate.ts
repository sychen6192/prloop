// Quote-based re-anchoring.
//
// Models never emit line numbers (their schema has no such field). They quote the source
// line; we find that quote in the blob bytes of the iteration under review and compute the
// coordinates ourselves. When the quote can't be located unambiguously we fail closed and
// degrade the finding into the summary comment — we never guess a line.
//
// This is what makes comments land on the right line, and it doubles as a hallucination
// filter: a quote that doesn't exist in the file means the finding was invented.
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

// Three tiers, tried in order. Earlier tiers are stricter; we stop at the first tier that
// finds any candidate, so loose matching never overrides an exact hit.
const NORMALIZERS: Array<(s: string) => string> = [
  (s) => stripCr(s).replace(/\s+$/, ""),
  (s) => stripCr(s).trim(),
  (s) => stripCr(s).replace(/\s+/g, " ").trim(),
];

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

/** Scores a candidate by how well the surrounding lines match the model's stated context. */
function contextScore(
  lines: string[],
  cand: Candidate,
  before: string[],
  after: string[],
  normalize: (s: string) => string,
): number {
  let score = 0;
  for (let k = 0; k < before.length; k++) {
    const want = normalize(before[before.length - 1 - k]!);
    if (want === "") continue;
    const idx = cand.startLine - 2 - k; // 0-based index of the line above
    if (idx >= 0 && normalize(lines[idx] ?? "") === want) score++;
  }
  for (let k = 0; k < after.length; k++) {
    const want = normalize(after[k]!);
    if (want === "") continue;
    const idx = cand.endLine + k; // 0-based index of the line below
    if (idx < lines.length && normalize(lines[idx] ?? "") === want) score++;
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

function touchesChangedLine(file: FileDiff, cand: Candidate): boolean {
  for (let l = cand.startLine; l <= cand.endLine; l++) {
    if (file.changedRightLines.has(l)) return true;
  }
  return false;
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

  const needle = quoteLines(finding.quote ?? "");
  if (needle.length === 0) {
    return { file, failure: "quote-not-found", detail: "finding carries no quote" };
  }

  const before = quoteLines(finding.context_before ?? "");
  const after = quoteLines(finding.context_after ?? "");

  // A candidate accepted at a strict tier whose model-provided context scores zero. Kept
  // as a fallback while looser tiers get a chance to produce a context-confirmed match:
  // a model that reformats the line it quotes (stripped indentation, say) can hit a
  // different-but-textually-exact line at tier 1 while the intended line only matches at
  // tier 2 — and only the context can tell those apart.
  let contradicted: { cand: Candidate; normalize: (s: string) => string } | undefined;

  for (const normalize of NORMALIZERS) {
    const cands = findWindows(lines, needle, normalize);
    if (cands.length === 0) continue;

    let pool = cands;
    if (pool.length > 1) {
      // 1) the model's own context is the strongest disambiguator
      const scored = pool.map((c) => ({ c, s: contextScore(lines, c, before, after, normalize) }));
      const best = Math.max(...scored.map((x) => x.s));
      if (best > 0) pool = scored.filter((x) => x.s === best).map((x) => x.c);
    }
    if (pool.length > 1 && side === "right") {
      // 2) prefer a candidate that sits on a line this PR actually touched
      const onChanged = pool.filter((c) => touchesChangedLine(file, c));
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

    const hasContext = before.length > 0 || after.length > 0;
    if (hasContext && contextScore(lines, pool[0]!, before, after, normalize) === 0) {
      if (!contradicted) contradicted = { cand: pool[0]!, normalize };
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

    const lastLine = stripCr(lines[cand.endLine - 1] ?? "");
    return {
      file,
      anchor: {
        side,
        startLine: cand.startLine,
        endLine: cand.endLine,
        // ADO's docs say offsets start at 0 but its own examples use 1, and 0/missing
        // offsets are implicated in the UI breakage of azure-devops-mcp #793.
        // Always send both ends, always 1-based.
        startOffset: 1,
        endOffset: Math.max(lastLine.length + 1, 1),
      },
    };
  }

  // No tier produced a context-confirmed match; fall back to the exact-but-unconfirmed
  // candidate rather than degrading — the model's context lines may simply have been
  // reworded, and the quote itself did match uniquely.
  if (contradicted) {
    const { cand } = contradicted;
    if (!inAnyHunk(file, cand, side)) {
      return {
        file,
        failure: "outside-changed-lines",
        detail: `quote located at ${file.path}:${cand.startLine}, outside this change`,
      };
    }
    const lastLine = stripCr(lines[cand.endLine - 1] ?? "");
    return {
      file,
      anchor: {
        side,
        startLine: cand.startLine,
        endLine: cand.endLine,
        startOffset: 1,
        endOffset: Math.max(lastLine.length + 1, 1),
      },
    };
  }

  return {
    file,
    failure: "quote-not-found",
    detail: `quote not found in ${file.path}: "${(finding.quote ?? "").slice(0, 80)}"`,
  };
}
