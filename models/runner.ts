// Model runner: one OpenAI-compatible adapter covering LiteLLM proxy, vLLM and Ollama.
// The core imports this interface only — swapping runtimes never touches pipeline code
// (design principle: runtime adapter).
import {
  LLM_API_FLAVOR,
  LLM_API_KEY,
  LLM_BASE_URL,
  extraBodyFor,
  LLM_MAX_TOKENS,
  LLM_STALL_TIMEOUT_MS,
  LLM_STREAM,
  LLM_STRUCTURED_OUTPUT,
  LLM_TEMPERATURE,
  LLM_CONCURRENCY,
  LLM_RETRIES,
  LLM_TIMEOUT_MS,
  RUNNER_KIND,
  reasoningFor,
  temperatureFor,
  type ApiFlavor,
  type ReasoningLevel,
  type Temperature,
} from "../config";
import { recordCall } from "../libs/artifacts";
import { Semaphore } from "../libs/limit";
import { log, logVerbose } from "../libs/log";
import { USER_AGENT, dispatcherFor } from "../libs/proxy";
import { redactSecrets } from "../libs/redact";
import type { ChatRequest, ChatResponse, ModelRunner } from "../libs/types";
import { inlineSchema } from "./schemas";

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
  // A proxy URL with credentials can ride along inside undici's messages.
  return redactSecrets(parts.length > 0 ? parts.join(" ← ") : String(e));
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/**
 * Usage as ChatResponse spells it, or nothing when the endpoint reported none.
 *
 * Spread rather than assigned so an absent count stays ABSENT: a `promptTokens: undefined`
 * key reaches calls.jsonl as an explicit "no counts", which is a different claim from a
 * backend that never sends usage at all.
 */
function usageOf(usage: OpenAIUsage | undefined): Pick<ChatResponse, "promptTokens" | "completionTokens"> {
  return {
    ...(usage?.prompt_tokens !== undefined ? { promptTokens: usage.prompt_tokens } : {}),
    ...(usage?.completion_tokens !== undefined ? { completionTokens: usage.completion_tokens } : {}),
  };
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
 * The message a stalled stream fails with. Distinct from the deadline's `timeout (900s)`
 * on purpose: the fix is different (an engine that died mid-generation, not a budget that
 * is too small), and the char count says whether anything was generated before the silence.
 * Transient by isTransientModelError, so the ordinary retry handles it — the point of the
 * stall timer is to REACH that retry in two minutes instead of fifteen. Pure, for the test.
 */
export function streamStallMessage(stallMs: number, chars: number): string {
  return `stream stalled after ${Math.round(stallMs / 1000)}s (${chars} chars received)`;
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

// ─── Reasoning ───────────────────────────────────────────────────────────────
// One intent (PRR_REASONING), four incompatible spellings. Getting the spelling wrong is a
// hard 400 on every call of a run, so the translation lives in one pure place with the
// failures that motivated each branch written down next to it.

/**
 * Which dialect a model speaks. `auto` reads it off the model name because one base URL
 * (a LiteLLM proxy) commonly fronts several vendors at once — there is no single right
 * answer for the endpoint, only for each model on it. gpt-*, o1/o3/o4 and every unrecognised
 * name land on the OpenAI dialect: it is the lingua franca of OpenAI-compatible gateways,
 * so it is also the safest guess.
 */
export function resolveFlavor(flavor: ApiFlavor, model: string): Exclude<ApiFlavor, "auto"> {
  if (flavor !== "auto") return flavor;
  const m = model.toLowerCase();
  if (m.includes("claude") || m.includes("anthropic")) return "anthropic";
  if (m.includes("qwen")) return "qwen";
  return "openai";
}

/**
 * Anthropic's thinking budget for a level. The API requires 1024 <= budget_tokens <
 * max_tokens, and the budget is spent from the SAME pot as the answer — so the shares stay
 * well under the ceiling and the cap keeps answer room even when PRR_LLM_MAX_TOKENS is
 * small. A budget at or above max_tokens is a 400, not a longer think.
 */
export function thinkingBudget(level: Exclude<ReasoningLevel, "none">, maxTokens: number): number {
  const share = level === "low" ? 0.25 : level === "medium" ? 0.5 : 0.75;
  return Math.min(Math.max(1024, Math.floor(maxTokens * share)), maxTokens - 1);
}

/**
 * The reasoning fields for one request. Pure, and the only place a level becomes a field.
 *
 * `none` on the OpenAI dialect OMITS the field rather than sending `reasoning_effort:
 * "none"`: that value is recent, some servers 400 on it, and an absent field already means
 * "whatever this model does normally" everywhere. Anthropic gets no `thinking` key for
 * `none` (its default is off). Qwen and Ollama take a boolean, so there `none` is a real
 * value and is sent — switching thinking OFF at the engine is the whole reason that knob
 * exists on those two.
 */
export function reasoningFields(
  level: ReasoningLevel | undefined,
  flavor: Exclude<ApiFlavor, "auto">,
  maxTokens: number,
): Record<string, unknown> {
  if (level === undefined) return {}; // unset = leave the backend's own default alone
  switch (flavor) {
    case "anthropic":
      return level === "none"
        ? {}
        : { thinking: { type: "enabled", budget_tokens: thinkingBudget(level, maxTokens) } };
    case "qwen":
      return { chat_template_kwargs: { enable_thinking: level !== "none" } };
    case "ollama":
      return { think: level !== "none" };
    default:
      return level === "none" ? {} : { reasoning_effort: level };
  }
}

/**
 * True when this request must not carry an ordinary temperature: Anthropic extended
 * thinking accepts exactly 1 and 400s on anything else — including the 0 the requirement
 * gate asks for, which prloop used to send unconditionally.
 */
export function thinkingForcesTemperature(
  level: ReasoningLevel | undefined,
  flavor: Exclude<ApiFlavor, "auto">,
): boolean {
  return flavor === "anthropic" && level !== undefined && level !== "none";
}

/** Per-model request shaping, resolved from config by the caller so this stays pure. */
export interface BodyShape {
  /** Reasoning level for this model (config.reasoningFor); undefined = send nothing. */
  reasoning?: ReasoningLevel;
  /** Backend dialect; `auto` (the default) infers it from the model name. */
  flavor?: ApiFlavor;
  /** Temperature policy for this model (config.temperatureFor); "none" omits the field. */
  temperature?: Temperature;
}

/**
 * Assembles the chat/completions request body.
 *
 * Precedence, in one place: explicit PRR_LLM_EXTRA_BODY > per-model reasoning > global
 * reasoning. The extra body is spread AFTER the reasoning fields (it is the escape hatch,
 * so it must be able to say something this vocabulary cannot) and BEFORE prloop's own
 * fields, which still win on a conflict — everything prloop sets below has its own PRR_
 * knob, so a collision there is always a mistake.
 *
 * `temperature` is the one exception: it defers to an explicit extra-body value, because
 * it is also the one field a backend may reject outright (newer Anthropic models, OpenAI
 * reasoning models), and prloop overwriting it left no way to change or remove it.
 */
export function buildChatBody(
  req: ChatRequest,
  stream: boolean,
  extra?: Record<string, unknown>,
  // Whether the backend enforces the schema (response_format). When it does not, the
  // schema goes into the prompt text instead — a prompt saying "per the schema" must never
  // reach a model that was shown no schema. Parameterised for the selftest.
  structured: boolean = LLM_STRUCTURED_OUTPUT,
  shape: BodyShape = {},
): Record<string, unknown> {
  const maxTokens = req.maxTokens ?? LLM_MAX_TOKENS;
  const flavor = resolveFlavor(shape.flavor ?? "auto", req.model);
  const body: Record<string, unknown> = {
    ...reasoningFields(shape.reasoning, flavor, maxTokens),
    ...extra,
    model: req.model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: structured ? req.user : inlineSchema(req) },
    ],
    max_tokens: maxTokens,
    stream,
  };
  if (!(extra && "temperature" in extra)) {
    const configured = shape.temperature ?? LLM_TEMPERATURE;
    const t =
      configured === "none"
        ? "none"
        : thinkingForcesTemperature(shape.reasoning, flavor)
          ? 1
          : (req.temperature ?? configured);
    if (t !== "none") body["temperature"] = t;
  }
  // Without this the stream carries no token counts. vLLM, LiteLLM and Ollama all honour
  // it; a backend that rejects it as unknown trips the buffered fallback in chat().
  if (stream) body["stream_options"] = { include_usage: true };
  if (req.schema && structured) {
    body["response_format"] = {
      type: "json_schema",
      json_schema: { name: req.schemaName ?? "output", schema: req.schema, strict: true },
    };
  }
  return body;
}

/** Said once per model, not once per call: a 40-call run must not repeat it 40 times. */
const noted = new Set<string>();
function noteOnce(key: string, msg: string): void {
  if (noted.has(key)) return;
  noted.add(key);
  log(msg);
}

export class OpenAICompatRunner implements ModelRunner {
  // Set after a backend rejects the streaming request shape itself; the rest of the run
  // goes buffered rather than paying a failed round trip on every call.
  private buffered = false;

  constructor(
    private readonly baseUrl: string = LLM_BASE_URL,
    private readonly apiKey: string = LLM_API_KEY,
    // Parameterised for the selftest, which drives a deliberately stalled local server.
    private readonly stallMs: number = LLM_STALL_TIMEOUT_MS,
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
    const reasoning = reasoningFor(req.model);
    const flavor = resolveFlavor(LLM_API_FLAVOR, req.model);
    const temperature = temperatureFor(req.model);
    if (thinkingForcesTemperature(reasoning, flavor)) {
      noteOnce(
        req.model,
        `${req.model}: ${reasoning} reasoning on an Anthropic-dialect model — extended thinking accepts only ` +
          `temperature 1, so ${temperature === "none" ? "no temperature is sent" : "1 is sent"} and the ` +
          `configured value does not apply to this model`,
      );
    }
    const body = buildChatBody(req, stream, extraBodyFor(req.model), LLM_STRUCTURED_OUTPUT, {
      reasoning,
      flavor: LLM_API_FLAVOR,
      temperature,
    });
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
        // A 429/503 usually says when to come back. Discarding it meant the backoff below
        // guessed — and typically retried straight back into the same closed window.
        const retryAfterMs =
          res.status === 429 || res.status === 503 ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
        // Some gateways echo the presented key inside a 401 body; this string reaches the
        // log, runs/, and the PR summary.
        return {
          text: "",
          model: req.model,
          error: redactSecrets(`HTTP ${res.status}: ${text.slice(0, 500)}`),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        };
      }
      // A backend that ignores `stream` answers with a plain JSON completion; trust the
      // content type over what was asked for.
      const ctype = res.headers.get("content-type") ?? "";
      if (stream && ctype.includes("text/event-stream")) {
        return await this.consumeStream(res, req, started, () => ctrl.abort());
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
    // The usage rides along even on the failure: this response ARRIVED, so the endpoint
    // billed for it — and a completion truncated at the token limit is the most expensive
    // failure there is. Dropping its counts made the one call that spent a full budget the
    // one call that looked free, and withRetries' summation had nothing to sum.
    if (bad) return { text: content, model: req.model, error: bad, ...usageOf(parsed.usage) };
    return this.accept(req, started, content, reasoned, parsed.usage, false);
  }

  private async consumeStream(
    res: Response,
    req: ChatRequest,
    started: number,
    abort: () => void,
  ): Promise<ChatResponse> {
    const acc = new SseAccumulator();
    // Stall detection. The per-call deadline covers the WHOLE call, so an engine that dies
    // without closing the socket costs the full PRR_LLM_TIMEOUT_MS (900s by default) — and
    // then the retry costs another one. Every chunk rearms the timer, so a slow generation
    // is never cut; only a silent one is.
    let stalled = false;
    let stallTimer: NodeJS.Timeout | undefined;
    const rearm = () => {
      if (this.stallMs <= 0) return; // 0 = disabled: the deadline is the only limit
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        abort();
      }, this.stallMs);
    };
    try {
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        try {
          rearm();
          for (;;) {
            // The per-call deadline aborts the fetch, which rejects this read; the caller's
            // catch turns it into the same timeout error as the buffered path.
            const { done, value } = await reader.read();
            if (done) break;
            rearm();
            acc.feed(decoder.decode(value, { stream: true }));
          }
        } finally {
          reader.releaseLock();
        }
        acc.feed(decoder.decode());
        acc.end();
      }
    } catch (e) {
      // Our own abort arrives as a read rejection, indistinguishable from the deadline's —
      // only this flag tells them apart, and they need different messages: one says raise
      // the timeout, the other says the engine stopped sending.
      if (!stalled) throw e;
      return { text: "", model: req.model, error: streamStallMessage(this.stallMs, acc.content.length) };
    } finally {
      // Never let the timer outlive the stream: a fire after the response was returned
      // would abort the NEXT use of this controller and blame the wrong call.
      clearTimeout(stallTimer);
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
      // Same rule as the buffered path: whatever the stats chunk had already reported was
      // billed, whether or not the stream then died.
      return { text: transport ? "" : acc.content, model: req.model, error: bad, ...usageOf(acc.usage) };
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
 * failure. Only network/5xx/timeout classes are worth a second attempt — a cut stream and
 * a stalled one land there too.
 */
/**
 * True for the one failure whose partial text is still worth reading: a completion cut at
 * the token limit, which usually holds a run of complete items before the cut (see
 * salvageArrayItems). The message is the one describeCompletionShape writes.
 */
export function isTruncation(error: string): boolean {
  return /truncated at the token limit/.test(error);
}

export function isTransientModelError(error: string): boolean {
  if (/^HTTP (4\d\d)/.test(error)) return /^HTTP (408|429)/.test(error);
  if (/truncated at the token limit|returned only reasoning|empty response|response is not JSON/.test(error)) {
    return false;
  }
  return true;
}

/**
 * `Retry-After`, in ms: delta-seconds ("30") or an HTTP-date ("Wed, 21 Oct 2015 07:28:00
 * GMT"). Both forms are in the wild — a proxy passes through whatever the vendor sent — and
 * a date already in the past means "now", never a negative wait. Garbage is undefined, so
 * the caller falls back to its own backoff. Pure, for the selftest.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  const s = (value ?? "").trim();
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const at = Date.parse(s);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/**
 * How long to wait before retry `attempt` (0-based).
 *
 * Full jitter over an exponential window, rather than the fixed 500·2^i this used to be:
 * a fleet of finders that failed together retried together, at the same instant, which is
 * exactly the burst a 429 was asking them to stop. The endpoint's own Retry-After wins when
 * it is longer — it is the one number here that is not a guess. Pure, with `rand`
 * injectable so the selftest can pin the bounds.
 */
export function backoffMs(attempt: number, retryAfterMs?: number, rand: () => number = Math.random): number {
  const cap = Math.min(2000 * 2 ** attempt, 60_000);
  return Math.max(retryAfterMs ?? 0, Math.round(rand() * cap));
}

function withRetries(inner: ModelRunner, attempts: number): ModelRunner {
  return {
    async chat(req) {
      // Every attempt is recorded (calls.jsonl) and every attempt's usage is added up: a
      // failed attempt usually reports none, but a TRUNCATED one reports a full budget's
      // worth — billing only the last attempt made a retrying run look cheaper than it was.
      let promptTokens = 0;
      let completionTokens = 0;
      let attempt = 0;
      const once = async (): Promise<ChatResponse> => {
        const startedAt = Date.now();
        const res = await inner.chat(req);
        promptTokens += res.promptTokens ?? 0;
        completionTokens += res.completionTokens ?? 0;
        recordCall({
          ts: new Date().toISOString(),
          stage: req.schemaName ?? "chat",
          model: req.model,
          attempt,
          ms: Date.now() - startedAt,
          promptTokens: res.promptTokens,
          completionTokens: res.completionTokens,
          error: res.error,
        });
        return res;
      };
      let last = await once();
      for (let i = 0; i < attempts && last.error && isTransientModelError(last.error); i++) {
        const wait = backoffMs(i, last.retryAfterMs);
        logVerbose(
          `retrying ${req.model} in ${Math.round(wait / 1000)}s after transient failure: ${last.error.slice(0, 160)}`,
        );
        await new Promise((r) => setTimeout(r, wait));
        attempt = i + 1;
        last = await once();
      }
      // The totals must show what the endpoint billed, which is every attempt.
      return attempt === 0 ? last : { ...last, promptTokens, completionTokens };
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
 * Every runner's error text is user-facing — it is logged, saved under runs/ and quoted in
 * the PR summary — and a gateway's in-band error (a JSON `error.message`, an SSE error
 * event, a non-JSON body) can echo the credential it rejected. Scrubbed once here, for
 * every runner kind, so no adapter has to remember.
 */
export function redactingErrors(inner: ModelRunner): ModelRunner {
  return {
    async chat(req) {
      const res = await inner.chat(req);
      return res.error ? { ...res, error: redactSecrets(res.error) } : res;
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
  // call, carrying the usage of every attempt it took (withRetries sums them, because the
  // endpoint billed for all of them).
  return counted(withRetries(throttled(redactingErrors(inner), LLM_CONCURRENCY), LLM_RETRIES));
}
