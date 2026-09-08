// Offline self-test for the model transport's SIDE EFFECTS: what the runner does to a real
// socket, and what it does with what comes back.
//
// selftest-stream.ts pins the pure half — SSE assembly, the failure taxonomy, body shaping.
// Everything below needs an endpoint that answers badly on purpose: a retry that must fire,
// one that must not, a buffered fallback that must survive the call that triggered it, a
// deadline that must cut a silent stream, and token totals that must bill what the endpoint
// billed. Every one of those is a whole-run cost when it breaks, and none of it is reachable
// without a server.
//
// Its own file rather than more of selftest-stream.ts for a mechanical reason: createRunner()
// reads PRR_LLM_BASE_URL out of config at IMPORT time, and the fake endpoint's port only
// exists at run time. So the server starts first and the modules are imported after — which
// only works if nothing has imported config already.
import { fakeOpenAI, completion, httpError, sse, sseDelta, sseUsage, SSE_DONE } from "./fakes/openai";
// Type-only: erased at compile time, so it does not import config before the env is set.
import type { CallRecord } from "../libs/artifacts";

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

const endpoint = await fakeOpenAI();
try {
  // Set before the first import of config, which reads every knob once. The endpoint is
  // loopback, so the proxy must be bypassed or every request leaves for a CONNECT that
  // nothing answers; PRR_NO_PROXY makes that true regardless of what the machine exports.
  process.env["PRR_LLM_BASE_URL"] = endpoint.baseUrl;
  process.env["PRR_LLM_API_KEY"] = "test-key";
  process.env["PRR_NO_PROXY"] = "127.0.0.1";
  process.env["PRR_LLM_RETRIES"] = "1"; // one EXTRA attempt, whatever the default becomes
  process.env["PRR_LLM_STREAM"] = "1";
  process.env["PRR_QUIET"] = "1";

  const { OpenAICompatRunner, createRunner, tokenTotals } = await import("../models/runner");
  const { attachCallSink, detachCallSink } = await import("../libs/artifacts");

  const ask = { model: "m", system: "s", user: "u" };
  /** Token totals are a process-wide accumulator; every assertion here is on the delta. */
  const since = (before: ReturnType<typeof tokenTotals>) => {
    const now = tokenTotals();
    return {
      calls: now.calls - before.calls,
      promptTokens: now.promptTokens - before.promptTokens,
      completionTokens: now.completionTokens - before.completionTokens,
    };
  };

  section("retry discipline against a real endpoint: which failures get a second attempt");
  {
    // A 5xx is the endpoint saying "not now". Not retrying it threw away a run that would
    // have succeeded on the next call, which is the whole reason the retry layer exists.
    endpoint.reset();
    endpoint.script(httpError(500, '{"error":{"message":"upstream restarting"}}'), completion("second body"));
    const runner = await createRunner();
    const res = await runner.chat(ask);
    eq("a 500 is retried once", endpoint.calls.length, 2);
    eq("...and the SECOND body is what the caller gets", res.text, "second body");
    eq("...with no error left on the response", res.error, undefined);

    // A 4xx is the endpoint saying the request itself is wrong. Retrying it burns a second
    // full-length call to reproduce the identical rejection.
    endpoint.reset();
    endpoint.script(httpError(400, '{"error":{"message":"Invalid schema for response_format"}}'));
    const bad = await runner.chat(ask);
    eq("a 400 is never retried", endpoint.calls.length, 1);
    check("...and the status survives into the error", (bad.error ?? "").startsWith("HTTP 400"), bad.error);

    // The credential reaches the wire exactly once, in the header, and the honest UA with it.
    check("the api key rides in the Authorization header", endpoint.calls[0]?.authorization === "Bearer test-key");
    check("...and prloop identifies itself", (endpoint.calls[0]?.userAgent ?? "").startsWith("prloop/"));
  }

  section("a cut stream is transient: the retry is what a proxy idle-kill costs, not the run");
  {
    // A response that ends mid-generation with no finish_reason and no [DONE] — a gateway
    // that gave up on an idle connection. The content that arrived cannot be trusted
    // complete, so it must fail AND be retried; returning the partial answer as if it were
    // the whole one is how a truncated review reads as a clean one.
    endpoint.reset();
    endpoint.script(
      sse([sseDelta("partial ans")]),
      sse([sseDelta('{"findings":[]}', "stop"), SSE_DONE]),
    );
    const runner = await createRunner();
    const res = await runner.chat(ask);
    eq("a cut stream is retried", endpoint.calls.length, 2);
    eq("...and the complete second answer is returned", res.text, '{"findings":[]}');
    check("...with the partial first answer discarded", !res.text.includes("partial"));

    // The other shape of the same failure: the socket dies rather than the response ending.
    // Different error text (a transport error, not a shape one), same verdict — retry.
    endpoint.reset();
    endpoint.script(
      (res2) => {
        res2.writeHead(200, { "Content-Type": "text/event-stream" });
        res2.write(sseDelta("half"));
        res2.destroy();
      },
      completion("recovered"),
    );
    const dropped = await runner.chat(ask);
    eq("a dropped socket is retried too", endpoint.calls.length, 2);
    eq("...and the run continues on the second answer", dropped.text, "recovered");
  }

  section("streaming rejection: one failed round trip per RUN, not per call");
  {
    // The motivating failure: a gateway that 400s on stream_options answered every single
    // call with a rejection, and prloop paid the round trip 40 times in one run before
    // falling back each time. The flip is instance state and must outlive the call that set
    // it — driven through OpenAICompatRunner directly, because that is where the flag lives.
    endpoint.reset();
    endpoint.script(
      httpError(400, '{"error":{"message":"stream_options is not supported by this deployment"}}'),
      completion("first answer"),
      completion("second answer"),
    );
    const runner = new OpenAICompatRunner(endpoint.baseUrl, "test-key");

    const first = await runner.chat(ask);
    eq("the rejected call falls back instead of failing", first.text, "first answer");
    eq("...at the cost of exactly one extra round trip", endpoint.calls.length, 2);
    eq("the first attempt asked to stream", endpoint.calls[0]?.body["stream"], true);
    eq("the fallback attempt did not", endpoint.calls[1]?.body["stream"], false);
    check("...and dropped stream_options with it", !("stream_options" in (endpoint.calls[1]?.body ?? {})));

    const second = await runner.chat(ask);
    eq("the next call goes straight to buffered — the flip is for the rest of the run", endpoint.calls.length, 3);
    eq("...with no second rejection to pay for", second.text, "second answer");
    eq("...still buffered on the wire", endpoint.calls[2]?.body["stream"], false);

    // A 4xx that says nothing about streaming is a different problem and must NOT flip the
    // mode: the buffered retry would fail identically and hide the real rejection.
    endpoint.reset();
    endpoint.script(httpError(400, '{"error":{"message":"model not found"}}'));
    const other = new OpenAICompatRunner(endpoint.baseUrl, "test-key");
    const rejected = await other.chat(ask);
    eq("a 400 that does not name streaming is not a fallback trigger", endpoint.calls.length, 1);
    check("...and is reported as itself", (rejected.error ?? "").includes("model not found"), rejected.error);
  }

  section("the per-call deadline: the last defence when the stall timer is off");
  {
    // The stall timer (PRR_LLM_STALL_TIMEOUT_MS=0 disables it) is not the only thing
    // watching a silent stream — the deadline covers the whole call, headers and last chunk
    // alike. Without it a dead engine that never closes its socket hangs the run forever.
    // selftest-stream.ts pins the stall timer's own message; this pins what happens when
    // the deadline is the only limit left, and that the two failures are NOT named the same
    // (one says raise the budget, the other says the engine stopped sending).
    endpoint.reset();
    endpoint.script(sse([sseDelta("hi")], { end: false }));
    const runner = new OpenAICompatRunner(endpoint.baseUrl, "test-key", 0);
    const started = Date.now();
    const res = await runner.chat({ ...ask, timeoutMs: 700 });
    const took = Date.now() - started;
    eq("a stalled stream fails as a timeout when the stall timer is disabled", res.error, "timeout (1s)");
    check("...at the deadline, not at PRR_LLM_TIMEOUT_MS", took < 5000, `${took}ms`);
    eq("...and returns no text", res.text, "");
    check("...and is not mistaken for a stall (a different fix)", !(res.error ?? "").includes("stalled"));
  }

  section("Retry-After: the one number in the backoff that is not a guess");
  {
    // A 429 usually says when to come back. Ignoring it meant the jittered backoff guessed,
    // and typically retried straight back into the window the endpoint had just closed.
    endpoint.reset();
    endpoint.script(httpError(429, '{"error":{"message":"rate limited"}}', { "retry-after": "1" }), completion("after the wait"));
    const runner = await createRunner();
    const res = await runner.chat(ask);
    eq("a 429 is retried", endpoint.calls.length, 2);
    eq("...and the second answer is returned", res.text, "after the wait");
    const gap = (endpoint.calls[1]?.at ?? 0) - (endpoint.calls[0]?.at ?? 0);
    // 1s asked for; the jittered window may be longer, never shorter. The 50ms of slack is
    // timer granularity, not tolerance for ignoring the header.
    check("...no sooner than the endpoint asked for", gap >= 950, `waited ${gap}ms`);
  }

  section("token accounting: one logical call, every attempt's usage");
  {
    const runner = await createRunner();

    // A truncated completion is DETERMINISTIC, so it is not retried — and it is also the
    // most expensive kind of failure there is: the endpoint billed a full budget for it.
    // Dropping its usage made the one call that costs the most look free.
    let before = tokenTotals();
    endpoint.reset();
    endpoint.script(completion('{"findings":[{"cla', { prompt_tokens: 1200, completion_tokens: 8192 }, "length"));
    const truncated = await runner.chat(ask);
    check("a truncated completion is named as truncation", (truncated.error ?? "").includes("truncated"), truncated.error);
    eq("...counted as one call", since(before).calls, 1);
    eq("...billed for the prompt it sent", since(before).promptTokens, 1200);
    eq("...and for the budget it burned", since(before).completionTokens, 8192);

    // A retry sequence: the endpoint billed for BOTH attempts, so both must be counted,
    // while the caller still made one logical call.
    before = tokenTotals();
    const attempts: CallRecord[] = [];
    attachCallSink((r) => attempts.push(r));
    try {
      endpoint.reset();
      endpoint.script(
        // Cut mid-stream, but the usage chunk had already arrived: a real attempt, really billed.
        sse([sseDelta("half an ans"), sseUsage({ prompt_tokens: 5, completion_tokens: 50 })]),
        sse([sseDelta("whole", "stop"), sseUsage({ prompt_tokens: 5, completion_tokens: 120 }), SSE_DONE]),
      );
      const res = await runner.chat(ask);
      eq("the retry succeeds", res.text, "whole");
      eq("one logical call, however many attempts it took", since(before).calls, 1);
      eq("...but every attempt's prompt tokens", since(before).promptTokens, 10);
      eq("...and every attempt's completion tokens", since(before).completionTokens, 170);
      eq("both attempts are recorded individually", attempts.length, 2);
      eq("...numbered, so a run that retried everything is visible", attempts.map((a) => a.attempt), [0, 1]);
      check("...with the failed attempt's own error kept", (attempts[0]?.error ?? "").includes("stream cut"), attempts[0]?.error);
    } finally {
      detachCallSink();
    }
  }
} finally {
  await endpoint.close();
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
