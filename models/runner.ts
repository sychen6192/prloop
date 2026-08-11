// Model runner: one OpenAI-compatible adapter covering LiteLLM proxy, vLLM and Ollama.
// The core imports this interface only — swapping runtimes never touches pipeline code
// (design principle: runtime adapter).
import {
  LLM_API_KEY,
  LLM_BASE_URL,
  LLM_EXTRA_BODY,
  LLM_MAX_TOKENS,
  LLM_STREAM,
  LLM_STRUCTURED_OUTPUT,
  LLM_TEMPERATURE,
  LLM_CONCURRENCY,
  LLM_RETRIES,
  LLM_TIMEOUT_MS,
  RUNNER_KIND,
} from "../config";
import { Semaphore } from "../libs/limit";
import { logVerbose } from "../libs/log";
import { USER_AGENT, dispatcherFor } from "../libs/proxy";
import type { ChatRequest, ChatResponse, ModelRunner } from "../libs/types";

interface OpenAIChoice {
  // `reasoning` (LiteLLM/OpenRouter) / `reasoning_content` (vLLM) is where thinking models
  // put their chain of thought; the answer stays in `content`. It is never used as output,
  // only to explain where the token budget went.
  message?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null };
  finish_reason?: string;
}
/**
 * "TypeError: fetch failed" is undici hiding the real error in `cause` (often two levels
 * deep). Surfacing the code chain is the difference between a diagnosable log line and a
 * shrug — a production failure at exactly 301s only became explainable once the cause
 * (UND_ERR_HEADERS_TIMEOUT) was visible.
 */
export function describeFetchError(e: unknown, timeoutMs: number): string {
  if (e instanceof Error && e.name === "AbortError") {
    return `timeout (${Math.round(timeoutMs / 1000)}s)`;
  }
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur instanceof Error; depth++) {
    const code = (cur as NodeJS.ErrnoException).code;
    parts.push(code ? `${cur.message} [${code}]` : cur.message);
    cur = cur.cause;
  }
  return parts.length > 0 ? parts.join(" ← ") : String(e);
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: OpenAIUsage;
  error?: { message?: string };
}

// ─── Streaming (SSE) ─────────────────────────────────────────────────────────
// Why stream at all: a buffered completion sends ZERO bytes until the model finishes, and
// on a long generation that multi-minute silence outlives the idle timeout of whatever
// sits between prloop and the engine — nginx in front of vLLM, a LiteLLM proxy, a
// corporate gateway — which gives up with a 504 long before PRR_LLM_TIMEOUT_MS. Retrying
// then waits out the same silence and dies the same way. Streaming keeps bytes flowing
// from the first token, so no hop ever sees an idle connection. The response is still
// assembled and returned whole; nothing downstream sees a delta.

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  // Present on the final chunk with stream_options.include_usage; `null` on the others.
  usage?: OpenAIUsage | null;
  // LiteLLM reports a mid-stream backend failure as an in-band error event.
  error?: { message?: string };
}

/**
 * Incremental parser for an OpenAI-compatible SSE stream.
 *
 * Line-based on purpose: every OpenAI-compatible backend emits one complete JSON chunk per
 * `data:` line, so full SSE event framing (multi-line data, event/id fields) would be
 * machinery for a case that never occurs. feed() takes raw text as it arrives — network
 * reads may split a line anywhere, including mid-JSON — and end() flushes a trailing
 * unterminated line at EOF.
 */
export class SseAccumulator {
  /** Assembled answer text from every delta, in arrival order. */
  content = "";
  /** Chain-of-thought length seen so far (chars). Only the length is kept: reasoning is
   *  never output, it only explains where the token budget went. */
  reasoningChars = 0;
  finishReason: string | undefined;
  usage: OpenAIUsage | undefined;
  /** `data: [DONE]` arrived. */
  done = false;
  /** In-band error event, when the backend reported one mid-stream. */
  streamError: string | undefined;
  /** data: lines that were not valid JSON — counted and sampled, never fatal on their own. */
  badLines = 0;
  badSample: string | undefined;

  private buf = "";

  feed(text: string): void {
    this.buf += text;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.line(line);
    }
  }

  /** Flush a trailing unterminated line at EOF. */
  end(): void {
    if (this.buf.length > 0) {
      this.line(this.buf);
      this.buf = "";
    }
  }

  private line(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // Blank separators, `: keep-alive` comments and non-data SSE fields are not ours.
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      this.done = true;
      return;
    }
    if (!payload) return;
    let chunk: OpenAIStreamChunk;
    try {
      chunk = JSON.parse(payload) as OpenAIStreamChunk;
    } catch {
      // One mangled line must not kill a minutes-long generation; count it and let the
      // end-of-stream checks decide whether anything real was lost.
      this.badLines += 1;
      this.badSample ??= payload.slice(0, 160);
      return;
    }
    if (chunk.error?.message) {
      this.streamError = chunk.error.message;
      return;
    }
    const choice = chunk.choices?.[0];
    if (typeof choice?.delta?.content === "string") this.content += choice.delta.content;
    const reasoning = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
    if (typeof reasoning === "string") this.reasoningChars += reasoning.length;
    if (choice?.finish_reason) this.finishReason = choice.finish_reason;
    // With stream_options.include_usage the counts ride the last chunk, whose choices are
    // empty (vLLM) or carry an empty delta (some proxies); intermediate chunks say null.
    if (chunk.usage) this.usage = chunk.usage;
  }
}

/**
 * Failure taxonomy for a stream that has ended, or undefined if the completion is usable.
 *
 * A stream with no [DONE] *and* no finish_reason was cut mid-generation (endpoint restart,
 * a proxy idle-kill): whatever content arrived cannot be trusted complete, so it fails —
 * and transiently, the generic retry gives the cut a second attempt. A missing [DONE]
 * alone is tolerated: some proxies swallow the sentinel, but a finish_reason already
 * proves the generation completed. Everything else shares the buffered path's shape
 * checks, so truncation and empty responses read identically in both modes.
 */
export function describeStreamedCompletion(acc: SseAccumulator, maxTokens: number): string | undefined {
  if (acc.streamError !== undefined) return acc.streamError;
  if (!acc.done && acc.finishReason === undefined) {
    return `stream cut after ${acc.content.length} chars (no finish_reason arrived)`;
  }
  return describeCompletionShape(acc.content, acc.reasoningChars, acc.finishReason, maxTokens);
}

/**
 * A 4xx whose body names streaming: the request SHAPE was refused (streaming disabled on
 * the gateway, `stream_options` unknown to an old server) — not the generation itself, and
 * not a transient fault. Only then is an immediate buffered retry worth anything; a 429 or
 * an auth failure would fail identically in either mode and stays with the normal retry
 * taxonomy.
 */
export function isStreamingRejection(error: string): boolean {
  return /^HTTP 4\d\d/.test(error) && /stream/i.test(error);
}

/**
 * Assembles the chat/completions request body.
 *
 * `extra` (PRR_LLM_EXTRA_BODY) is spread FIRST, so prloop's own fields always win on a key
 * conflict: the knob exists to add engine-specific params — the motivating case is Qwen3's
 * chat_template_kwargs.enable_thinking=false to stop a finder burning its whole budget on
 * chain of thought — never to change the request shape the pipeline depends on. Everything
 * prloop sets here already has its own PRR_ knob, so a collision is always a mistake.
 */
export function buildChatBody(
  req: ChatRequest,
  stream: boolean,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...extra,
    model: req.model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    temperature: req.temperature ?? LLM_TEMPERATURE,
    max_tokens: req.maxTokens ?? LLM_MAX_TOKENS,
    stream,
  };
  // Without this the stream carries no token counts. vLLM, LiteLLM and Ollama all honour
  // it; a backend that rejects it as unknown trips the buffered fallback in chat().
  if (stream) body["stream_options"] = { include_usage: true };
  if (req.schema && LLM_STRUCTURED_OUTPUT) {
    body["response_format"] = {
      type: "json_schema",
      json_schema: { name: req.schemaName ?? "output", schema: req.schema, strict: true },
    };
  }
  return body;
}

export class OpenAICompatRunner implements ModelRunner {
  // Set after a backend rejects the streaming request shape itself; the rest of the run
  // goes buffered rather than paying a failed round trip on every call.
  private buffered = false;

  constructor(
    private readonly baseUrl: string = LLM_BASE_URL,
    private readonly apiKey: string = LLM_API_KEY,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const wantStream = LLM_STREAM && !this.buffered;
    const res = await this.request(req, wantStream);
    if (wantStream && res.error !== undefined && isStreamingRejection(res.error)) {
      this.buffered = true;
      logVerbose(
        `${req.model}: backend rejected streaming (${res.error.slice(0, 120)}); buffered mode for the rest of this run`,
      );
      return this.request(req, false);
    }
    return res;
  }

  private async request(req: ChatRequest, stream: boolean): Promise<ChatResponse> {
    const body = buildChatBody(req, stream, LLM_EXTRA_BODY);
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const ctrl = new AbortController();
    const timeoutMs = req.timeoutMs ?? LLM_TIMEOUT_MS;
    // Started here, after the concurrency slot was acquired: time spent queued behind other
    // calls must not count against this request's own deadline. One deadline covers the
    // whole call in both modes — headers, first token and the last stream chunk alike.
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        // An internal model endpoint usually must NOT go through the external proxy;
        // list its host in NO_PROXY and dispatcherFor returns undefined for it.
        dispatcher: dispatcherFor(url),
      } as RequestInit);
      if (!res.ok) {
        const text = await res.text();
        return { text: "", model: req.model, error: `HTTP ${res.status}: ${text.slice(0, 500)}` };
      }
      // A backend that ignores `stream` answers with a plain JSON completion; trust the
      // content type over what was asked for.
      const ctype = res.headers.get("content-type") ?? "";
      if (stream && ctype.includes("text/event-stream")) {
        return await this.consumeStream(res, req, started);
      }
      return this.parseBuffered(await res.text(), req, started);
    } catch (e) {
      return { text: "", model: req.model, error: describeFetchError(e, timeoutMs) };
    } finally {
      clearTimeout(timer);
    }
  }

  private parseBuffered(text: string, req: ChatRequest, started: number): ChatResponse {
    let parsed: OpenAIResponse;
    try {
      parsed = JSON.parse(text) as OpenAIResponse;
    } catch {
      return { text: "", model: req.model, error: `response is not JSON: ${text.slice(0, 500)}` };
    }
    if (parsed.error?.message) {
      return { text: "", model: req.model, error: parsed.error.message };
    }
    const choice = parsed.choices?.[0];
    const content = choice?.message?.content ?? "";
    const reasoned = (choice?.message?.reasoning ?? choice?.message?.reasoning_content ?? "").length;

    const bad = describeBadCompletion(choice, req.maxTokens ?? LLM_MAX_TOKENS);
    if (bad) return { text: content, model: req.model, error: bad };
    return this.accept(req, started, content, reasoned, parsed.usage, false);
  }

  private async consumeStream(res: Response, req: ChatRequest, started: number): Promise<ChatResponse> {
    const acc = new SseAccumulator();
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      try {
        for (;;) {
          // The per-call deadline aborts the fetch, which rejects this read; the caller's
          // catch turns it into the same timeout error as the buffered path.
          const { done, value } = await reader.read();
          if (done) break;
          acc.feed(decoder.decode(value, { stream: true }));
        }
      } finally {
        reader.releaseLock();
      }
      acc.feed(decoder.decode());
      acc.end();
    }
    if (acc.badLines > 0) {
      logVerbose(`${req.model}: skipped ${acc.badLines} unparseable SSE line(s), first: ${acc.badSample ?? ""}`);
    }
    const bad = describeStreamedCompletion(acc, req.maxTokens ?? LLM_MAX_TOKENS);
    if (bad) {
      // Transport-class failures (in-band error, cut stream) return no text, like every
      // other transport failure; shape-class failures (truncation) keep the partial
      // content, like the buffered path.
      const transport = acc.streamError !== undefined || (!acc.done && acc.finishReason === undefined);
      return { text: transport ? "" : acc.content, model: req.model, error: bad };
    }
    return this.accept(req, started, acc.content, acc.reasoningChars, acc.usage, true);
  }

  private accept(
    req: ChatRequest,
    started: number,
    content: string,
    reasonedChars: number,
    usage: OpenAIUsage | undefined,
    streamed: boolean,
  ): ChatResponse {
    const secs = Math.round((Date.now() - started) / 1000);
    logVerbose(
      `${req.model} replied ${content.length} chars, ${secs}s${streamed ? " (streamed)" : ""}` +
        (reasonedChars > 0 ? ` (+${reasonedChars} chars reasoning)` : "") +
        (usage ? ` (in ${usage.prompt_tokens ?? "?"} / out ${usage.completion_tokens ?? "?"} tokens)` : ""),
    );
    return {
      text: content,
      model: req.model,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
    };
  }
}

/** Shape checks shared by the buffered and streamed paths. */
function describeCompletionShape(
  content: string,
  reasonedChars: number,
  finishReason: string | undefined,
  maxTokens: number,
): string | undefined {
  const reasoningNote =
    reasonedChars > 0 ? `. The model emitted ${reasonedChars} chars of reasoning, billed to the same budget` : "";

  if (finishReason === "length") {
    return `response truncated at the token limit (${maxTokens}); raise PRR_LLM_MAX_TOKENS${reasoningNote}`;
  }
  if (!content.trim()) {
    return reasonedChars > 0
      ? `model returned only reasoning (${reasonedChars} chars) and no answer; raise PRR_LLM_MAX_TOKENS`
      : "model returned an empty response";
  }
  return undefined;
}

/**
 * Reports a completion that arrived successfully but is unusable, or undefined if it's fine.
 *
 * Truncation is a different failure from bad output and needs a different fix. Left
 * unlabelled it surfaces downstream as "output unparseable", which sends people to inspect
 * the prompt or the schema when the real answer is "raise the token limit".
 *
 * Thinking models make this the common case rather than an edge case: chain of thought is
 * billed to the same budget as the answer. A measured run on a self-hosted 27B thinking
 * model spent 7842 of 8192 tokens, most of it in `reasoning` — 4% of headroom away from
 * silently returning zero findings.
 */
export function describeBadCompletion(
  choice:
    | {
        message?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null };
        finish_reason?: string;
      }
    | undefined,
  maxTokens: number,
): string | undefined {
  const msg = choice?.message;
  return describeCompletionShape(
    msg?.content ?? "",
    (msg?.reasoning ?? msg?.reasoning_content ?? "").length,
    choice?.finish_reason,
    maxTokens,
  );
}

/**
 * True for failures where the same request may well succeed on a second attempt.
 *
 * Deliberately conservative in both directions: an HTTP 4xx is the backend saying the
 * request itself is wrong (408/429 excepted — those are about timing), and a completion
 * that arrived but was unusable (truncated at the token limit, empty, non-JSON body) is
 * DETERMINISTIC — the retry burns a second full-length call to reproduce the identical
 * failure. Only network/5xx/timeout classes are worth a second attempt — a cut stream
 * lands there too.
 */
export function isTransientModelError(error: string): boolean {
  if (/^HTTP (4\d\d)/.test(error)) return /^HTTP (408|429)/.test(error);
  if (/truncated at the token limit|returned only reasoning|empty response|response is not JSON/.test(error)) {
    return false;
  }
  return true;
}

function withRetries(inner: ModelRunner, attempts: number): ModelRunner {
  if (attempts <= 0) return inner;
  return {
    async chat(req) {
      let last = await inner.chat(req);
      for (let i = 0; i < attempts && last.error && isTransientModelError(last.error); i++) {
        // Exponential backoff: an immediate retry against a 429 or a briefly-down endpoint
        // tends to collect the same answer.
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
        logVerbose(`retrying ${req.model} after transient failure: ${last.error.slice(0, 160)}`);
        last = await inner.chat(req);
      }
      return last;
    },
  };
}

// ─── Token accounting ────────────────────────────────────────────────────────
// The adapter has always parsed usage out of the response; this is the one place every
// call passes through, so totals are collected here instead of threading counters
// through four gate modules. Read at the end of a run for the summary and artifacts.
export interface TokenTotals {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}
const totals: TokenTotals = { calls: 0, promptTokens: 0, completionTokens: 0 };

export function tokenTotals(): TokenTotals {
  return { ...totals };
}

function counted(inner: ModelRunner): ModelRunner {
  return {
    async chat(req) {
      const res = await inner.chat(req);
      totals.calls += 1;
      totals.promptTokens += res.promptTokens ?? 0;
      totals.completionTokens += res.completionTokens ?? 0;
      return res;
    },
  };
}

/**
 * Caps concurrent calls across every stage at once.
 *
 * Applied here rather than at each call site so a single pool covers finders, the
 * requirement axis, the skeptic and triage — the stages overlap, and per-stage limits would
 * still let their sum swamp the endpoint.
 */
function throttled(inner: ModelRunner, limit: number): ModelRunner {
  if (limit <= 0) return inner;
  const sem = new Semaphore(limit);
  return {
    chat(req) {
      if (sem.inFlight >= limit) {
        logVerbose(`model calls at the ${limit} limit, queueing ${req.model} (${sem.waiting + 1} waiting)`);
      }
      return sem.run(() => inner.chat(req));
    },
  };
}

/**
 * Runner factory. The opencode path is imported lazily so a missing opencode install never
 * affects the default HTTP path (and vice versa).
 */
export async function createRunner(): Promise<ModelRunner> {
  const inner =
    RUNNER_KIND === "opencode"
      ? new (await import("./opencode")).OpencodeRunner()
      : new OpenAICompatRunner();
  // Throttle innermost: each retry attempt re-queues for a slot instead of one call holding
  // a slot for its whole retry sequence. Counting sits outermost: one record per logical
  // call, with the usage of whichever attempt finally answered (failed attempts carry no
  // usage data to count).
  return counted(withRetries(throttled(inner, LLM_CONCURRENCY), LLM_RETRIES));
}
