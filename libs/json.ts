// Fail-closed JSON extraction from model output.
// Weak models wrap JSON in prose or fences even under a schema constraint; we recover what
// we safely can and reject the rest rather than letting malformed findings through.

export interface ParseOk<T> {
  ok: true;
  value: T;
}
export interface ParseFail {
  ok: false;
  error: string;
}
export type ParseResult<T> = ParseOk<T> | ParseFail;

/** Finds the first balanced JSON object/array in a string, ignoring braces inside strings. */
function extractBalanced(raw: string): string | undefined {
  const startIdx = (() => {
    const o = raw.indexOf("{");
    const a = raw.indexOf("[");
    if (o < 0) return a;
    if (a < 0) return o;
    return Math.min(o, a);
  })();
  if (startIdx < 0) return undefined;

  const open = raw[startIdx]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let escaped = false;

  for (let i = startIdx; i < raw.length; i++) {
    const c = raw[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return raw.slice(startIdx, i + 1);
    }
  }
  return undefined;
}

/**
 * Escapes raw control characters that sit INSIDE string literals — a literal newline or
 * tab where JSON demands `\\n` / `\\t`. Lossless: outside strings nothing changes, and
 * inside one a raw newline can only ever have meant the escape (the grammar has no other
 * reading), so the parsed value is exactly what the model wrote.
 *
 * Why this exists: without engine-level guided decoding (PRR_LLM_STRUCTURED=0, or a
 * backend that cannot enforce a schema) a model hand-writing JSON puts real newlines into
 * multi-line `quote` and `suggested_fix` values. Seen live on Claude through a gateway:
 * "Bad control character in string literal at position 1848" — one character cost the
 * finder its entire output. Exported for the selftest.
 */
export function escapeControlCharsInStrings(s: string): string {
  let out = "";
  let inStr = false;
  let escaped = false;
  for (const c of s) {
    if (inStr) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inStr = false;
      } else {
        const code = c.charCodeAt(0);
        if (code < 0x20) {
          out +=
            c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t" : c === "\b" ? "\\b" : c === "\f" ? "\\f"
              : `\\u${code.toString(16).padStart(4, "0")}`;
          continue;
        }
      }
    } else if (c === '"') {
      inStr = true;
    }
    out += c;
  }
  return out;
}

export function parseJsonObject<T = unknown>(raw: string): ParseResult<T> {
  if (!raw || raw.trim() === "") return { ok: false, error: "model returned an empty string" };

  const cleaned = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    // Reasoning models sometimes emit a think block before the answer.
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();

  const direct = tryParse<T>(cleaned);
  if (direct.ok) return direct;

  // Strictly more accepting, never less: on valid JSON the repair is the identity.
  const repaired = escapeControlCharsInStrings(cleaned);
  const repairedDirect = tryParse<T>(repaired);
  if (repairedDirect.ok) return repairedDirect;

  const balanced = extractBalanced(repaired);
  if (!balanced) return { ok: false, error: "no complete JSON object found in output" };
  return tryParse<T>(balanced);
}

function tryParse<T>(s: string): ParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(s) as T };
  } catch (e) {
    return { ok: false, error: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
