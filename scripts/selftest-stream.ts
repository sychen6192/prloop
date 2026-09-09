// Offline self-test for the model transport: SSE stream assembly and the failure taxonomy
// around it. Streaming exists so gateways with idle timeouts can't 504 a long generation
// (a buffered completion is silent until the model finishes); these assertions pin the
// parser and the ways a stream can end. Kept separate from selftest.ts — that file is the
// anchoring regression net — so each net can grow without inflating the other.
// Wired into `npm run check` alongside it.
import {
  OpenAICompatRunner,
  SseAccumulator,
  backoffMs,
  buildChatBody,
  describeStreamedCompletion,
  isStreamingRejection,
  isTransientModelError,
  parseRetryAfter,
  reasoningFields,
  resolveFlavor,
  streamStallMessage,
  thinkingBudget,
  type BodyShape,
} from "../models/runner";
import {
  parseExtraBody,
  parseReasoning,
  parseReasoningByModel,
  parseTemperature,
  parseTemperatureByModel,
  resolveExtraBody,
} from "../config";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  [OK]   ${name}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq<T>(name: string, actual: T, expected: T) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `expected ${e}, got ${a}`);
}

function section(t: string) {
  console.log(`\n${t}`);
}

section("SSE stream assembly (streaming keeps gateways from 504ing long generations)");
{
  const chunk = (delta: object, finish?: string) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;

  // The normal case, chunk boundaries falling wherever the network cut them: content
  // assembled in order, finish_reason captured, usage taken from the final stats chunk.
  const acc = new SseAccumulator();
  acc.feed('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n');
  acc.feed(chunk({ content: '{"findings"' }));
  const split = chunk({ content: ":[]}" });
  acc.feed(split.slice(0, 15)); // a data line split mid-JSON across two reads must reassemble
  acc.feed(split.slice(15));
  acc.feed(chunk({}, "stop"));
  // The final usage chunk with stream_options.include_usage: empty delta, counts alongside.
  acc.feed('data: {"choices":[{"index":0,"delta":{}}],"usage":{"prompt_tokens":15,"completion_tokens":346,"total_tokens":361}}\n\n');
  acc.feed("data: [DONE]\n\n");
  acc.end();
  eq("content assembled across chunks", acc.content, '{"findings":[]}');
  eq("finish_reason captured", acc.finishReason, "stop");
  eq("usage prompt tokens captured", acc.usage?.prompt_tokens, 15);
  eq("usage completion tokens captured", acc.usage?.completion_tokens, 346);
  check("[DONE] seen", acc.done);
  eq("no bad lines on a clean stream", acc.badLines, 0);
  check("a clean stream passes", describeStreamedCompletion(acc, 8192) === undefined);

  // CRLF framing and `: keep-alive` comment lines — proxies add both.
  const crlf = new SseAccumulator();
  crlf.feed(': keep-alive\r\n\r\ndata: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\r\n\r\n');
  crlf.feed("data: [DONE]\r\n\r\n");
  crlf.end();
  eq("CRLF framing parses", crlf.content, "hi");
  check("comment lines are ignored", crlf.done && crlf.badLines === 0);

  // Reasoning deltas (vLLM: reasoning_content, LiteLLM: reasoning) are counted, not output.
  const think = new SseAccumulator();
  think.feed('data: {"choices":[{"delta":{"reasoning_content":"hmm..."}}]}\n\n');
  think.feed('data: {"choices":[{"delta":{"reasoning":"more"}}]}\n\n');
  think.feed('data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  think.end();
  eq("reasoning chars counted", think.reasoningChars, 10);
  eq("reasoning never leaks into content", think.content, "x");

  // One mangled line must not kill a minutes-long generation.
  const mangled = new SseAccumulator();
  mangled.feed("data: {broken json\n\n");
  mangled.feed('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  mangled.end();
  eq("mangled line skipped, stream continues", mangled.content, "ok");
  eq("...but counted", mangled.badLines, 1);
  check("...and sampled for the log", (mangled.badSample ?? "").includes("broken"));

  // In-band error event (how LiteLLM reports a mid-generation backend failure).
  const errd = new SseAccumulator();
  errd.feed('data: {"error":{"message":"upstream connector error"}}\n\n');
  errd.end();
  eq("error event captured", errd.streamError, "upstream connector error");
  eq("error event fails the completion", describeStreamedCompletion(errd, 8192), "upstream connector error");
}

section("streamed completion taxonomy: cut streams fail, a missing [DONE] alone does not");
{
  const mk = (lines: string) => {
    const a = new SseAccumulator();
    a.feed(lines);
    a.end();
    return a;
  };

  // Connection cut mid-generation: the content cannot be trusted complete, so it fails —
  // transiently, so the generic retry gives it a second attempt.
  const cut = mk('data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n');
  const cutMsg = describeStreamedCompletion(cut, 8192) ?? "";
  check("no finish_reason and no [DONE] fails", cutMsg.includes("stream cut"));
  check("a cut stream is transient (retried)", isTransientModelError(cutMsg));

  // Some proxies swallow the [DONE] sentinel; a finish_reason already proves completion.
  const noDone = mk('data: {"choices":[{"delta":{"content":"whole"},"finish_reason":"stop"}]}\n\n');
  check("missing [DONE] with finish_reason passes", describeStreamedCompletion(noDone, 8192) === undefined);

  // Shape checks are shared with the buffered path: truncation is still truncation.
  const trunc = mk('data: {"choices":[{"delta":{"content":"{\\"find"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');
  check("streamed truncation reported as truncation", (describeStreamedCompletion(trunc, 8192) ?? "").includes("truncated"));

  const nothing = mk("data: [DONE]\n\n");
  check("empty streamed response is named", (describeStreamedCompletion(nothing, 8192) ?? "").includes("empty"));

  // The buffered fallback fires only when a 4xx names streaming as the problem — the
  // request shape was refused, not the generation.
  check("400 naming stream_options falls back", isStreamingRejection('HTTP 400: {"error":{"message":"stream_options is not supported"}}'));
  check("a schema 400 does not", !isStreamingRejection("HTTP 400: Invalid schema for response_format"));
  check("a 5xx does not (already transient)", !isStreamingRejection("HTTP 500: stream backend crashed"));
  check("a timeout does not", !isStreamingRejection("timeout (900s)"));
}

section("request body assembly: PRR_LLM_EXTRA_BODY adds engine knobs, never breaks the shape");
{
  // The motivating case: switching Qwen3 thinking off at the engine rides along untouched.
  const body = buildChatBody({ model: "m", system: "s", user: "u" }, true, {
    chat_template_kwargs: { enable_thinking: false },
  });
  eq("extra params ride along", JSON.stringify(body["chat_template_kwargs"]), '{"enable_thinking":false}');
  eq("stream still requested", body["stream"], true);
  eq("usage still requested", JSON.stringify(body["stream_options"]), '{"include_usage":true}');

  // Core fields cannot be clobbered: everything prloop manages has its own PRR_ knob, so a
  // conflict is always a mistake — resolved in favour of the pipeline.
  const hostile = buildChatBody({ model: "m", system: "s", user: "u", maxTokens: 111 }, false, {
    model: "evil",
    messages: [],
    stream: true,
    max_tokens: 9,
  });
  eq("model wins over extra body", hostile["model"], "m");
  eq("max_tokens wins over extra body", hostile["max_tokens"], 111);
  eq("stream wins over extra body", hostile["stream"], false);
  check("messages win over extra body", Array.isArray(hostile["messages"]) && (hostile["messages"] as unknown[]).length === 2);

  // No knob set → exactly the old request shape.
  const plain = buildChatBody({ model: "m", system: "s", user: "u" }, false, undefined);
  check("absent knob adds nothing", !("chat_template_kwargs" in plain));
  check("no stream_options when buffered", !("stream_options" in plain));

  // Guided decoding still attaches alongside the extra body.
  const withSchema = buildChatBody(
    { model: "m", system: "s", user: "u", schema: { type: "object" }, schemaName: "findings" },
    true,
    { chat_template_kwargs: { enable_thinking: false } },
  );
  check("response_format present with schema", JSON.stringify(withSchema["response_format"]).includes('"findings"'));
}

section("schema delivery: enforced by the backend, or inlined into the prompt — never neither");
{
  const req = { model: "m", system: "s", user: "review this", schema: { type: "object", required: ["findings"] }, schemaName: "findings" };
  const enforced = buildChatBody(req, false, undefined, true);
  const enforcedUser = (enforced["messages"] as Array<{ content: string }>)[1]!.content;
  check("structured on: response_format carries the schema", JSON.stringify(enforced["response_format"]).includes('"findings"'));
  eq("structured on: prompt untouched", enforcedUser, "review this");

  // PRR_LLM_STRUCTURED=0 (or a backend that cannot enforce): the schema rides in the prompt.
  // Seen live without this: Claude invented field names and every finding was dropped.
  const inlined = buildChatBody(req, false, undefined, false);
  const inlinedUser = (inlined["messages"] as Array<{ content: string }>)[1]!.content;
  check("structured off: no response_format", !("response_format" in inlined));
  check("structured off: schema text in the prompt", inlinedUser.includes('"findings"') && inlinedUser.includes("JSON Schema"));
  check("structured off: original prompt kept", inlinedUser.startsWith("review this"));
  eq("no schema, structured off: prompt untouched", (buildChatBody({ model: "m", system: "s", user: "u" }, false, undefined, false)["messages"] as Array<{ content: string }>)[1]!.content, "u");
}

section("PRR_LLM_EXTRA_BODY parsing fails fast at startup, not as HTTP 400 mid-run");
{
  eq("unset stays unset", parseExtraBody(undefined), undefined);
  eq("blank stays unset", parseExtraBody("   "), undefined);
  eq("an object parses", JSON.stringify(parseExtraBody('{"top_k":20}')), '{"top_k":20}');

  const throws = (raw: string) => {
    try {
      parseExtraBody(raw);
      return false;
    } catch {
      return true;
    }
  };
  check("malformed JSON throws", throws("{oops"));
  check("an array throws (must be an object)", throws("[1,2]"));
  check("a bare string throws", throws('"enable_thinking=false"'));
}

section("per-model extra body: the mixed fleet's switchboard");
{
  const off = { chat_template_kwargs: { enable_thinking: false } };
  eq("no map falls back to the global", resolveExtraBody("coder", undefined, off), off);
  eq("unlisted model falls back to the global", resolveExtraBody("coder-flash", { coder: {} }, off), off);
  eq("listed model wins over the global", JSON.stringify(resolveExtraBody("coder", { coder: { top_k: 20 } }, off)), '{"top_k":20}');
  eq("empty entry means send none (thinking back on)", JSON.stringify(resolveExtraBody("coder", { coder: {} }, off)), "{}");
  check("empty entry adds nothing to the request", !("chat_template_kwargs" in buildChatBody({ model: "coder", system: "s", user: "u" }, true, resolveExtraBody("coder", { coder: {} }, off))));
  check("fallback still disables thinking on the wire", JSON.stringify(buildChatBody({ model: "coder-flash", system: "s", user: "u" }, true, resolveExtraBody("coder-flash", { coder: {} }, off))).includes('"enable_thinking":false'));
}

section("reasoning: one intent, four dialects — the wrong spelling is a 400 on every call");
{
  const body = (model: string, shape: BodyShape, extra?: Record<string, unknown>) =>
    buildChatBody({ model, system: "s", user: "u", maxTokens: 8192 }, false, extra, true, shape);

  // OpenAI dialect. `none` OMITS the field: reasoning_effort:"none" is a recent value some
  // servers 400 on, and an absent field already means "whatever this model does normally".
  eq("openai low", body("m", { flavor: "openai", reasoning: "low" })["reasoning_effort"], "low");
  eq("openai medium", body("m", { flavor: "openai", reasoning: "medium" })["reasoning_effort"], "medium");
  eq("openai high", body("m", { flavor: "openai", reasoning: "high" })["reasoning_effort"], "high");
  check("openai none omits the field", !("reasoning_effort" in body("m", { flavor: "openai", reasoning: "none" })));
  check("unset sends nothing at all (the backend's own default)", !("reasoning_effort" in body("m", { flavor: "openai" })));
  eq("unset really is nothing, not a level", JSON.stringify(reasoningFields(undefined, "anthropic", 8192)), "{}");

  // Anthropic: a token budget scaled off max_tokens, and the API demands it stay under it.
  eq("anthropic medium is an enabled budget", JSON.stringify(body("m", { flavor: "anthropic", reasoning: "medium" })["thinking"]), '{"type":"enabled","budget_tokens":4096}');
  eq("anthropic low budget", thinkingBudget("low", 8192), 2048);
  eq("anthropic high budget", thinkingBudget("high", 8192), 6144);
  check("the budget always leaves answer room", thinkingBudget("high", 2048) < 2048 && thinkingBudget("high", 1024) < 1024);
  check("anthropic none sends no thinking key", !("thinking" in body("m", { flavor: "anthropic", reasoning: "none" })));

  // Qwen and Ollama take a boolean, so there `none` is a real value and IS sent — switching
  // thinking off at the engine is the whole reason those two have a knob.
  eq("qwen high enables thinking", JSON.stringify(body("m", { flavor: "qwen", reasoning: "high" })["chat_template_kwargs"]), '{"enable_thinking":true}');
  eq("qwen none disables it", JSON.stringify(body("m", { flavor: "qwen", reasoning: "none" })["chat_template_kwargs"]), '{"enable_thinking":false}');
  eq("ollama medium", body("m", { flavor: "ollama", reasoning: "medium" })["think"], true);
  eq("ollama none", body("m", { flavor: "ollama", reasoning: "none" })["think"], false);

  // Precedence: the escape hatch still wins, because it exists for what this cannot say.
  eq(
    "an explicit extra body overrides the translated field",
    JSON.stringify(body("m", { flavor: "qwen", reasoning: "high" }, { chat_template_kwargs: { enable_thinking: false } })["chat_template_kwargs"]),
    '{"enable_thinking":false}',
  );
  check("prloop's own fields still win over both", body("m", { flavor: "openai", reasoning: "low" }, { model: "evil" })["model"] === "m");
}

section("auto flavor: one base URL, several vendors behind it (a LiteLLM proxy)");
{
  eq("claude → anthropic", resolveFlavor("auto", "claude-sonnet-4"), "anthropic");
  eq("an anthropic-prefixed alias → anthropic", resolveFlavor("auto", "us.anthropic.claude-3-5"), "anthropic");
  eq("qwen → qwen", resolveFlavor("auto", "qwen3-coder"), "qwen");
  eq("gpt → openai", resolveFlavor("auto", "gpt-4o"), "openai");
  eq("o3 → openai", resolveFlavor("auto", "o3-mini"), "openai");
  eq("an unrecognised house name → openai", resolveFlavor("auto", "reviewer-v2"), "openai");
  eq("an explicit flavor is never second-guessed", resolveFlavor("ollama", "claude-sonnet"), "ollama");
  check(
    "auto reads the model NAME: a claude alias gets thinking, not reasoning_effort",
    "thinking" in buildChatBody({ model: "claude-x", system: "s", user: "u" }, false, undefined, true, { reasoning: "low" }),
  );
}

section("temperature: the field a backend may reject, and prloop used to force");
{
  const mk = (perCall: number | undefined, shape: BodyShape, extra?: Record<string, unknown>) =>
    buildChatBody(
      { model: "m", system: "s", user: "u", ...(perCall === undefined ? {} : { temperature: perCall }) },
      false,
      extra,
      true,
      shape,
    );
  const temp = (perCall: number | undefined, shape: BodyShape, extra?: Record<string, unknown>) => mk(perCall, shape, extra)["temperature"];

  eq("the configured value is sent", temp(undefined, { temperature: 0.2 }), 0.2);
  eq("a per-call value wins over it (the requirement gate asks for 0)", temp(0, { temperature: 0.2 }), 0);
  check("the none sentinel omits the field entirely", !("temperature" in mk(undefined, { temperature: "none" })));
  check("...even against a per-call value: what is rejected is the FIELD", !("temperature" in mk(0, { temperature: "none" })));
  eq("an explicit extra-body temperature wins over the default", temp(undefined, { temperature: 0.2 }, { temperature: 0.9 }), 0.9);
  eq("...and over a per-call one", temp(0, { temperature: 0.2 }, { temperature: 0.9 }), 0.9);

  // Anthropic extended thinking accepts exactly 1 and 400s on anything else — including the
  // 0 the requirement gate used to send unconditionally.
  eq("anthropic + thinking forces 1", temp(0, { flavor: "anthropic", reasoning: "medium", temperature: 0.2 }), 1);
  eq("...with thinking off, nothing is forced", temp(undefined, { flavor: "anthropic", reasoning: "none", temperature: 0.2 }), 0.2);
  eq("...and with no reasoning configured either", temp(undefined, { flavor: "anthropic", temperature: 0.2 }), 0.2);
  eq("...the extra body still wins over the forced 1", temp(0, { flavor: "anthropic", reasoning: "medium", temperature: 0.2 }, { temperature: 0.7 }), 0.7);
  check("...and none still omits (a model that rejects the field outright)", !("temperature" in mk(0, { flavor: "anthropic", reasoning: "high", temperature: "none" })));
  eq("no thinking forced on another dialect", temp(0, { flavor: "openai", reasoning: "high", temperature: 0.2 }), 0);
}

section("PRR_REASONING / PRR_LLM_TEMPERATURE parse at startup, never as a 400 mid-run");
{
  const threw = (fn: () => unknown) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  eq("unset means unset", parseReasoning(undefined), undefined);
  eq("blank means unset", parseReasoning("   "), undefined);
  eq("a level parses, case-insensitively", parseReasoning("HIGH"), "high");
  eq("none is a level, not an absence", parseReasoning("none"), "none");
  check("an unknown level throws", threw(() => parseReasoning("maximum")));
  eq("per-model levels parse", JSON.stringify(parseReasoningByModel('{"a":"none","b":"high"}')), '{"a":"none","b":"high"}');
  check("a bad level inside the map throws", threw(() => parseReasoningByModel('{"a":"lots"}')));
  check("a non-string level throws", threw(() => parseReasoningByModel('{"a":3}')));

  eq("blank temperature keeps the default", parseTemperature("", 0.2), 0.2);
  eq("a number parses", parseTemperature("0.7", 0.2), 0.7);
  eq("the sentinel parses", parseTemperature("none", 0.2), "none");
  eq("...case-insensitively", parseTemperature("None", 0.2), "none");
  check("garbage throws instead of becoming NaN", threw(() => parseTemperature("warm", 0.2)));
  eq("per-model temperatures parse, both forms", JSON.stringify(parseTemperatureByModel('{"a":"none","b":0.5}')), '{"a":"none","b":0.5}');
  check("a bad per-model temperature throws", threw(() => parseTemperatureByModel('{"a":true}')));
}

section("stream stall detection: a dead engine costs two minutes, not fifteen");
{
  eq("the message names the silence and what had arrived", streamStallMessage(120_000, 512), "stream stalled after 120s (512 chars received)");
  check("a stall is transient, so the existing retry handles it", isTransientModelError(streamStallMessage(120_000, 0)));
  check("...and is not mistaken for a streaming rejection (no buffered fallback)", !isStreamingRejection(streamStallMessage(120_000, 0)));

  // End to end against a server that sends one chunk and then goes silent without closing
  // the socket — the failure the per-call deadline cannot see until the full 900s are gone.
  const server = http.createServer((req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    // ...and nothing more, ever.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await new OpenAICompatRunner(`http://127.0.0.1:${port}/v1`, "k", 300).chat({
      model: "m",
      system: "s",
      user: "u",
    });
    check("a stalled stream fails as a stall", (res.error ?? "").startsWith("stream stalled after"), res.error);
    check("...reporting what had arrived before the silence", (res.error ?? "").includes("(2 chars received)"), res.error);
    eq("...and returns no text (a transport failure, like a cut stream)", res.text, "");
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

section("retry discipline: jittered backoff, and Retry-After when the endpoint sent one");
{
  eq("delta-seconds form", parseRetryAfter("30"), 30_000);
  eq("zero is a real answer, not an absent header", parseRetryAfter("0"), 0);
  eq("no header", parseRetryAfter(null), undefined);
  eq("garbage is undefined, never NaN", parseRetryAfter("soon"), undefined);
  const now = Date.parse("2026-01-01T00:00:00Z");
  eq("HTTP-date form", parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now), 30_000);
  eq("a date already past is now, never a negative wait", parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now + 5000), 0);

  // Full jitter over an exponential window: a fleet that failed together used to retry in
  // lockstep, which is the burst the 429 was asking them to stop.
  eq("first window is 2s", backoffMs(0, undefined, () => 1), 2000);
  eq("...jittered", backoffMs(0, undefined, () => 0.5), 1000);
  eq("...and can be immediate", backoffMs(0, undefined, () => 0), 0);
  eq("the window doubles", backoffMs(1, undefined, () => 1), 4000);
  eq("...and is capped at 60s", backoffMs(20, undefined, () => 1), 60_000);
  check(
    "every draw stays inside the window",
    [0, 0.1, 0.5, 0.9, 1].every((r) => {
      const ms = backoffMs(2, undefined, () => r);
      return ms >= 0 && ms <= 8000;
    }),
  );
  eq("Retry-After wins when it asks for longer", backoffMs(0, 30_000, () => 1), 30_000);
  eq("...but never shortens the backoff", backoffMs(5, 1000, () => 1), 60_000);
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
