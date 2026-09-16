// Deterministic diff budgeting, after PR-Agent's compression strategy: prefer files with
// real additions, fit the budget, and name-list the overflow rather than truncating
// mid-hunk. Two things differ from PR-Agent, both because of what went wrong here:
//
//  - Order is by added lines, not language prevalence (see `orderByValue` below).
//  - The budget can be counted in TOKENS against the model's context window, not only in
//    characters of the diff (see `estimateTokens`). Characters of the diff were never the
//    quantity that overruns.
import { log } from "./log";
import { LLM_MAX_TOKENS, MAX_DIFF_CHARS, contextTokensFor } from "../config";
import { renderUnifiedDiff } from "./diff";
import { isTestPath } from "./lang";
import { mulberry32, shuffle } from "./prng";
import type { FileDiff } from "./types";

export interface DiffPayload {
  text: string;
  // In the order the files appear in `text`.
  includedFiles: string[];
  omittedFiles: string[];
  // Which ceiling the selection ran into, for the log line and the summary. Undefined when
  // nothing was omitted. "Over budget" is not actionable until you know WHICH budget:
  // raising PRR_MAX_DIFF_CHARS does nothing when the model's context window is what bound.
  bound?: "chars" | "tokens";
}

// Role names, delimiters and the framing tokens a chat template adds around one message.
const MESSAGE_OVERHEAD_TOKENS = 8;

/**
 * What a piece of a chat request costs a context window, near enough to budget with.
 *
 * An ESTIMATE, deliberately dependency-free — a real tokenizer means shipping a vocabulary
 * per model family, and this number only ever decides how much diff to send. Two regimes,
 * because they differ by nearly 3x: BPE vocabularies cut English source into roughly 3.5
 * characters per token, while CJK and full-width text costs about one token per character
 * (more for rare ideographs). Stated margin: within about ±20% of a real tokenizer on
 * source code. Every part rounds UP, because underestimating does not raise an error — the
 * backend silently truncates the prompt and the quotes stop matching the file.
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let rest = 0;
  for (const ch of text) {
    if (isWide(ch.codePointAt(0)!)) wide++;
    else rest++;
  }
  return Math.ceil(rest / 3.5) + wide + MESSAGE_OVERHEAD_TOKENS;
}

/** CJK, kana, hangul and full-width forms: about one token per character, not 3.5. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) || // hangul jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, symbols and punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // kana, hangul compat, CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // full-width forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // supplementary ideographic planes
  );
}

// A window that leaves less than this for the diff is misconfigured — the fixed parts alone
// (system prompt + rules + conventions + schema) do not fit. Flooring here keeps the run
// going with a truthful log line instead of sending an empty diff, which would read
// downstream as "the finder found nothing".
export const MIN_DIFF_TOKENS = 2000;

/** Everything that shares the model's context window with the diff. */
export interface ContextBudget {
  // The model this payload is for; its entry in PRR_CONTEXT_TOKENS_BY_MODEL wins over the
  // global PRR_CONTEXT_TOKENS. Omitted = the global.
  model?: string;
  // System prompt, rules, conventions, PR description, inlined JSON schema — the parts of
  // the request whose size the diff cannot change. The caller owns this: only it knows
  // what it is about to wrap around the payload.
  fixed?: string;
  // Tokens reserved for the completion. Defaults to the global output budget.
  outputTokens?: number;
  // Test seam: the context window, bypassing config.
  contextTokens?: number;
}

/**
 * Tokens left for the diff once the output budget and the fixed parts of the prompt are
 * paid for. 0 = no token budget applies (the knob is off), and only the char ceiling binds.
 */
export function diffTokenBudget(ctx: ContextBudget | undefined): number {
  if (!ctx) return 0;
  const window = ctx.contextTokens ?? contextTokensFor(ctx.model ?? "");
  if (window <= 0) return 0;
  const output = ctx.outputTokens ?? LLM_MAX_TOKENS;
  return Math.max(window - output - estimateTokens(ctx.fixed ?? ""), MIN_DIFF_TOKENS);
}

function addedLineCount(f: FileDiff): number {
  return f.changedRightLines.size;
}

/**
 * Order by how much NEW code a file carries, biggest first, tests last.
 *
 * It used to be language prevalence, after PR-Agent — and on a real PR that dropped the one
 * file that most needed reading: a 3000-line Java service was omitted while three 20-line
 * TypeScript files stayed in, because TypeScript was the repo's majority language.
 * Prevalence is a census of the repo, not a measure of this change. Tests sort last for the
 * same reason: a generated 900-line test file must not evict the service it exercises. Ties
 * break on path, so the order is total and reproducible.
 */
function orderByValue(files: FileDiff[]): FileDiff[] {
  return [...files].sort((a, b) => {
    const ta = isTestPath(a.path) ? 1 : 0;
    const tb = isTestPath(b.path) ? 1 : 0;
    if (ta !== tb) return ta - tb;
    const aa = addedLineCount(a);
    const ab = addedLineCount(b);
    if (aa !== ab) return ab - aa;
    return a.path.localeCompare(b.path);
  });
}

function renderFile(f: FileDiff): string {
  return `### ${f.path}${f.originalPath && f.originalPath !== f.path ? ` (renamed from ${f.originalPath})` : ""} [${f.changeType}, ${f.language}]\n\`\`\`diff\n${renderUnifiedDiff(f.path, f.hunks)}\n\`\`\``;
}

/** One request's worth of files off the front of `ordered`, and what did not fit. */
function pack(
  ordered: readonly FileDiff[],
  budget: number,
  tokenBudget: number,
): { selected: Array<{ path: string; rendered: string }>; rest: FileDiff[]; bound?: "chars" | "tokens" } {
  const selected: Array<{ path: string; rendered: string }> = [];
  const rest: FileDiff[] = [];
  let usedChars = 0;
  let usedTokens = 0;
  let bound: "chars" | "tokens" | undefined;

  for (const f of ordered) {
    const rendered = renderFile(f);
    const tokens = tokenBudget > 0 ? estimateTokens(rendered) : 0;
    const overChars = usedChars + rendered.length > budget;
    const overTokens = tokenBudget > 0 && usedTokens + tokens > tokenBudget;
    if ((overChars || overTokens) && selected.length > 0) {
      rest.push(f);
      // Which one bound FIRST is the actionable fact; a later file can exceed both.
      if (!bound) bound = overTokens ? "tokens" : "chars";
      continue;
    }
    // The first file is always included so the payload is never empty — but a single
    // giant file can then blow far past the budget, and a backend that truncates the
    // prompt corrupts the very quotes anchoring depends on. Say so out loud.
    if (selected.length === 0 && (rendered.length > budget || (tokenBudget > 0 && tokens > tokenBudget))) {
      log(
        `[WARN] ${f.path} alone renders ${rendered.length} chars (~${estimateTokens(rendered)} tokens) against a ` +
          `${budget} char / ${tokenBudget > 0 ? `${tokenBudget} token` : "unlimited token"} budget; ` +
          `sent anyway — if the backend truncates, anchoring will degrade`,
      );
    }
    selected.push({ path: f.path, rendered });
    usedChars += rendered.length;
    usedTokens += tokens;
  }
  return { selected, rest, ...(bound === undefined ? {} : { bound }) };
}

/**
 * Selection is by budget and never depends on `seed`; the seed only permutes the order in
 * which the SELECTED files are rendered. The two steps are kept apart on purpose: a
 * per-finder shuffle must never change what a finder sees, or "two finders agreed" could
 * mean "two finders were shown the same subset". No seed = selection order.
 *
 * `budget` is the char ceiling (PRR_MAX_DIFF_CHARS). `ctx` adds the model's context window
 * as a second, token-denominated ceiling; whichever binds first decides. Omit it and the
 * behaviour is exactly the char-only one this function has always had.
 */
export function buildDiffPayload(
  files: FileDiff[],
  budget = MAX_DIFF_CHARS,
  seed?: number,
  ctx?: ContextBudget,
): DiffPayload {
  return buildDiffPayloads(files, budget, seed, ctx, 1)[0]!;
}

/**
 * The same selection, continued into further requests instead of stopping at the first one.
 *
 * A diff that does not fit is not a smaller diff: the files past the budget were dropped
 * from every finder's context and reported as a coverage gap, so on a large PR the tool
 * exited 3 and told you the part most likely to contain the defect had not been read. The
 * only honest way to read it was to pay for another request.
 *
 * So the packing loop simply keeps going: chunk 2 is what chunk 1 could not hold, packed
 * against the same budget, up to `maxChunks`. `maxChunks` of 1 is the behaviour above, byte
 * for byte, which is why the default knob value leaves every existing run untouched.
 *
 * Three properties the callers depend on:
 *
 *  - **The split does not depend on the seed.** Packing runs over `orderByValue` alone, so
 *    every finder gets the same chunk boundaries and the seed still only permutes the order
 *    WITHIN a chunk. Two finders that agree agreed about the same file in the same chunk.
 *  - **Every chunk reports the same omissions**, which are the files that fit in NO chunk.
 *    That is what a coverage gap has always meant, and it must not come to mean "files the
 *    other request is carrying".
 *  - **Chunks are not context.** Each is its own request with its own model; nothing here
 *    pretends the model saw the previous one. The prompt says which part it is holding
 *    (prompts/finder.ts) so it does not reason about files it cannot see.
 */
export function buildDiffPayloads(
  files: FileDiff[],
  budget = MAX_DIFF_CHARS,
  seed?: number,
  ctx?: ContextBudget,
  maxChunks = 1,
): DiffPayload[] {
  const tokenBudget = diffTokenBudget(ctx);
  const chunks: Array<Array<{ path: string; rendered: string }>> = [];
  let rest = orderByValue(files);
  let bound: "chars" | "tokens" | undefined;

  while (chunks.length < Math.max(1, maxChunks)) {
    const packed = pack(rest, budget, tokenBudget);
    chunks.push(packed.selected);
    bound ??= packed.bound;
    rest = packed.rest;
    // An empty first chunk means there were no files at all; anything else is done.
    if (rest.length === 0) break;
  }

  const omittedFiles = rest.map((f) => f.path);
  const note =
    omittedFiles.length > 0
      ? `\n\n### Changed files omitted for size (${omittedFiles.length})\n${omittedFiles.map((p) => `- ${p}`).join("\n")}`
      : "";

  return chunks.map((selected) => {
    const shown = seed === undefined ? selected : shuffle(selected, mulberry32(seed));
    return {
      text: shown.map((s) => s.rendered).join("\n\n") + note,
      includedFiles: shown.map((s) => s.path),
      omittedFiles,
      ...(bound === undefined ? {} : { bound }),
    };
  });
}
