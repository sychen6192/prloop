// Offline self-test for the model transport: SSE stream assembly and the failure taxonomy
// around it. Streaming exists so gateways with idle timeouts can't 504 a long generation
// (a buffered completion is silent until the model finishes); these assertions pin the
// parser and the ways a stream can end. Kept separate from selftest.ts — that file is the
// anchoring regression net — so each net can grow without inflating the other.
// Wired into `npm run check` alongside it.
import {
  SseAccumulator,
  buildChatBody,
  describeStreamedCompletion,
  isStreamingRejection,
  isTransientModelError,
} from "../models/runner";
import { parseExtraBody } from "../config";

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

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
