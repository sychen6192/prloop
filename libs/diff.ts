// Line-level diff. ADO's iteration-changes API hands us blob SHAs and change types but
// no hunks, so we compute the diff ourselves — which is also what makes line numbers
// ours to compute rather than the model's to guess (PROPOSAL §5.1).
import { HUNK_CONTEXT_AFTER, HUNK_CONTEXT_BEFORE } from "../config";
import type { Hunk } from "./types";

export type EditType = "equal" | "del" | "ins";

export interface Edit {
  type: EditType;
  // 0-based index into the left (old) lines; undefined for insertions.
  a?: number;
  // 0-based index into the right (new) lines; undefined for deletions.
  b?: number;
}

// Myers is O(ND); D stays small for real diffs. Past this we stop paying for precision
// and fall back to whole-file replace, which is still correct, just coarser.
const MAX_D = 1500;

function myers(a: string[], b: string[]): Edit[] | null {
  const N = a.length;
  const M = b.length;
  const max = Math.min(N + M, MAX_D);
  const size = 2 * max + 1;
  const offset = max;
  let v = new Int32Array(size);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const ki = k + offset;
      if (ki < 0 || ki >= size) continue;
      let x: number;
      const left = ki - 1 >= 0 ? v[ki - 1]! : -1;
      const right = ki + 1 < size ? v[ki + 1]! : -1;
      if (k === -d || (k !== d && left < right)) x = right;
      else x = left + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      v[ki] = x;
      if (x >= N && y >= M) return backtrack(trace, a, b, offset, size);
    }
  }
  return null; // exceeded MAX_D
}

function backtrack(
  trace: Int32Array[],
  a: string[],
  b: string[],
  offset: number,
  size: number,
): Edit[] {
  const edits: Edit[] = [];
  let x = a.length;
  let y = b.length;

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const ki = k + offset;
    const left = ki - 1 >= 0 ? v[ki - 1]! : -1;
    const right = ki + 1 < size ? v[ki + 1]! : -1;
    let prevK: number;
    if (k === -d || (k !== d && left < right)) prevK = k + 1;
    else prevK = k - 1;
    const prevKi = prevK + offset;
    const prevX = prevKi >= 0 && prevKi < size ? v[prevKi]! : 0;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      edits.push({ type: "equal", a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        edits.push({ type: "ins", b: y - 1 });
        y--;
      } else {
        edits.push({ type: "del", a: x - 1 });
        x--;
      }
    }
  }
  return edits.reverse();
}

/** Full edit script between two line arrays. Falls back to replace-all on pathological diffs. */
export function diffLines(a: string[], b: string[]): Edit[] {
  // Stripping the common prefix/suffix first keeps D small on real-world edits.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }

  const head: Edit[] = [];
  for (let i = 0; i < pre; i++) head.push({ type: "equal", a: i, b: i });
  const tail: Edit[] = [];
  for (let i = 0; i < suf; i++) {
    tail.push({ type: "equal", a: a.length - suf + i, b: b.length - suf + i });
  }

  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);

  let mid: Edit[];
  if (midA.length === 0 || midB.length === 0) {
    mid = [
      ...midA.map((_, i): Edit => ({ type: "del", a: pre + i })),
      ...midB.map((_, i): Edit => ({ type: "ins", b: pre + i })),
    ];
  } else {
    const raw = myers(midA, midB);
    mid = raw
      ? raw.map((e): Edit => ({
          type: e.type,
          a: e.a === undefined ? undefined : e.a + pre,
          b: e.b === undefined ? undefined : e.b + pre,
        }))
      : [
          ...midA.map((_, i): Edit => ({ type: "del", a: pre + i })),
          ...midB.map((_, i): Edit => ({ type: "ins", b: pre + i })),
        ];
  }
  return [...head, ...mid, ...tail];
}

export interface DiffResult {
  hunks: Hunk[];
  // 1-based right-side line numbers that this change added or modified.
  changedRightLines: Set<number>;
  // 1-based left-side line numbers that this change removed.
  changedLeftLines: Set<number>;
}

/**
 * Groups an edit script into unified-diff hunks with asymmetric context. `context` overrides
 * PRR_HUNK_CONTEXT_BEFORE/AFTER; infinite context is the whole file as one hunk.
 */
export function buildHunks(
  a: string[],
  b: string[],
  edits: Edit[],
  context: { before: number; after: number } = { before: HUNK_CONTEXT_BEFORE, after: HUNK_CONTEXT_AFTER },
): DiffResult {
  const changedRightLines = new Set<number>();
  const changedLeftLines = new Set<number>();
  for (const e of edits) {
    if (e.type === "ins" && e.b !== undefined) changedRightLines.add(e.b + 1);
    if (e.type === "del" && e.a !== undefined) changedLeftLines.add(e.a + 1);
  }

  // Indices of edits that are actual changes, grouped when close enough to share context.
  const changeIdx: number[] = [];
  edits.forEach((e, i) => {
    if (e.type !== "equal") changeIdx.push(i);
  });
  if (changeIdx.length === 0) {
    return { hunks: [], changedRightLines, changedLeftLines };
  }

  const gap = context.before + context.after;
  const groups: Array<{ start: number; end: number }> = [];
  let gStart = changeIdx[0]!;
  let gEnd = changeIdx[0]!;
  for (let i = 1; i < changeIdx.length; i++) {
    const idx = changeIdx[i]!;
    if (idx - gEnd <= gap) gEnd = idx;
    else {
      groups.push({ start: gStart, end: gEnd });
      gStart = idx;
      gEnd = idx;
    }
  }
  groups.push({ start: gStart, end: gEnd });

  // Lines consumed on each side before edit i. Deriving the @@ header from these keeps it
  // correct even when a hunk opens with an insertion (no left-side line to read a number from).
  const leftBefore: number[] = new Array(edits.length);
  const rightBefore: number[] = new Array(edits.length);
  let lp = 0;
  let rp = 0;
  for (let i = 0; i < edits.length; i++) {
    leftBefore[i] = lp;
    rightBefore[i] = rp;
    const t = edits[i]!.type;
    if (t !== "ins") lp++;
    if (t !== "del") rp++;
  }

  const hunks: Hunk[] = [];
  for (const g of groups) {
    const from = Math.max(0, g.start - context.before);
    const to = Math.min(edits.length - 1, g.end + context.after);

    let leftCount = 0;
    let rightCount = 0;
    const body: string[] = [];

    for (let i = from; i <= to; i++) {
      const e = edits[i]!;
      if (e.type === "equal") {
        leftCount++;
        rightCount++;
        body.push(` ${b[e.b!] ?? ""}`);
      } else if (e.type === "del") {
        leftCount++;
        body.push(`-${a[e.a!] ?? ""}`);
      } else {
        rightCount++;
        body.push(`+${b[e.b!] ?? ""}`);
      }
    }
    hunks.push({
      leftStart: (leftBefore[from] ?? 0) + 1,
      leftCount,
      rightStart: (rightBefore[from] ?? 0) + 1,
      rightCount,
      body: body.join("\n"),
    });
  }
  return { hunks, changedRightLines, changedLeftLines };
}

/**
 * Renders hunks as a unified diff, with @@ headers carrying real file line numbers, and the
 * `a/` and `b/` sides git writes — the rename's old name on the left.
 *
 * The header used to be `--- a${path}`, written for paths with a leading slash. Intake strips
 * that slash, so every production prompt read `--- asrc/pay.ts`, while the selftest kept
 * passing a slash-prefixed path production never produces. A model that copied the header
 * into `file` then leaned on the basename to be resolved, and where two changed files share
 * one, anchoring failed closed: a finding lost without a word.
 */
export function renderUnifiedDiff(
  path: string,
  hunks: Hunk[],
  originalPath?: string,
  scopeOf?: (h: Hunk) => string | undefined,
): string {
  const rel = (p: string) => p.replace(/^\/+/, "");
  const out: string[] = [`--- a/${rel(originalPath ?? path)}`, `+++ b/${rel(path)}`];
  for (const h of hunks) {
    // After the closing @@, as git writes it: the declaration the hunk sits in (libs/scope.ts).
    const scope = scopeOf?.(h);
    out.push(`@@ -${h.leftStart},${h.leftCount} +${h.rightStart},${h.rightCount} @@${scope ? ` ${scope}` : ""}`);
    out.push(h.body);
  }
  return out.join("\n");
}
