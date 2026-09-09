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

/**
 * Balanced JSON regions in `raw`, in document order, each starting at a `{` or `[`.
 *
 * Every candidate, not just the first, because the first bracket in a model's answer is
 * very often not the answer. Two live cases from a single run: the requirement prompt
 * numbers its criteria `[4711-AC1]`, and a skeptic explaining a refutation quoted the regex
 * `[a-zA-Z]`. Each sat in a sentence BEFORE the JSON, each was extracted and parsed instead
 * of it, and each failed a whole stage over a reply that had a perfectly good object two
 * lines further down. The caller tries candidates until one parses.
 *
 * Capped: scanning a region is O(region), and a reply that is mostly prose full of brackets
 * must not become an O(n^2) walk. Ten is far past any real preamble.
 */
function* balancedCandidates(raw: string, limit = 10): Generator<string> {
  let found = 0;
  for (let i = 0; i < raw.length && found < limit; i++) {
    const open = raw[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let j = i; j < raw.length; j++) {
      const c = raw[j]!;
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
        if (depth === 0) {
          found++;
          yield raw.slice(i, j + 1);
          break;
        }
      }
    }
  }
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

/**
 * The array under `key` of a parsed object, or undefined when there is none — a top-level
 * array, a scalar, or an object keyed some other way. Callers treat undefined as an error,
 * never as an empty list: "the model listed nothing" and "the model answered in a shape we
 * did not ask for" look identical once both become `[]`, and only the first is a clean
 * result.
 */
export function arrayField(value: unknown, key: string): unknown[] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = (value as Record<string, unknown>)[key];
  return Array.isArray(v) ? v : undefined;
}

/**
 * Every COMPLETE object inside the `"<field>": [ … ]` array of a possibly-truncated
 * response, in order; the trailing partial one is ignored.
 *
 * Why: a response cut at max_tokens has no complete top-level object, so the balanced
 * scanner above finds nothing and every finding the model DID finish — often a dozen of
 * them, fully formed, before the cut — is thrown away with the fragment. This is the
 * partial recovery for that case, not a parser: the caller still reports the call as
 * failed (see gates/finder.ts), because a truncated response is a truncated response.
 *
 * The same control-character repair runs first (models hand-write real newlines into
 * multi-line values), and an item that still will not parse is skipped rather than fatal.
 */
export function salvageArrayItems(text: string, field: string): unknown[] {
  const raw = escapeControlCharsInStrings(text);
  // First occurrence of the key: a model that repeats it inside a string value would fool
  // this, but the alternative is parsing what by definition does not parse.
  const key = raw.indexOf(`"${field}"`);
  if (key < 0) return [];
  const open = raw.indexOf("[", key + field.length + 2);
  if (open < 0) return [];

  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escaped = false;
  for (let i = open + 1; i < raw.length; i++) {
    const c = raw[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const item = tryParse<unknown>(raw.slice(start, i + 1));
        if (item.ok) out.push(item.value);
        start = -1;
      }
    } else if (c === "]" && depth === 0) {
      break; // the array closed: everything after it belongs to something else
    }
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

  let lastError: string | undefined;
  for (const candidate of balancedCandidates(repaired)) {
    const r = tryParse<T>(candidate);
    if (r.ok) return r;
    lastError ??= r.error;
  }
  return { ok: false, error: lastError ?? "no complete JSON object found in output" };
}

function tryParse<T>(s: string): ParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(s) as T };
  } catch (e) {
    return { ok: false, error: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
