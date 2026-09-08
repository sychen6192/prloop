// A fake OpenAI-compatible chat/completions endpoint, so the REAL transport code
// (models/runner.ts) can be driven over a real socket instead of behind a stubbed fetch.
//
// Everything interesting about that module happens between the request and the response —
// a retry that must fire, one that must not, a buffered fallback that must stick for the
// rest of the run, usage that must survive a failed attempt. None of it is reachable from
// the pure helpers, and all of it has broken in production.
//
// Behaviour is scripted per request rather than per route: the taxonomy under test is
// "what the endpoint answered THIS time", and a run is a sequence of answers.
import type * as http from "node:http";
import { listen, readBody, type FakeServer } from "./server";

export interface RecordedCall {
  /** Parsed request body — the assembled chat body, which is half of what is asserted. */
  body: Record<string, unknown>;
  authorization: string;
  userAgent: string;
  /** Arrival time, so a test can measure the gap a Retry-After was supposed to create. */
  at: number;
}

export type Responder = (res: http.ServerResponse, call: RecordedCall) => void;

export interface FakeOpenAI extends FakeServer {
  /** What OpenAICompatRunner takes as its baseUrl; it appends /chat/completions itself. */
  baseUrl: string;
  calls: RecordedCall[];
  /** Answers for the next requests, in order. An unscripted request is answered loudly. */
  script(...responders: Responder[]): void;
  reset(): void;
}

export async function fakeOpenAI(): Promise<FakeOpenAI> {
  const calls: RecordedCall[] = [];
  let queue: Responder[] = [];

  const server = await listen((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* a malformed body is itself worth recording as {} */
      }
      const call: RecordedCall = {
        body,
        authorization: req.headers["authorization"] ?? "",
        userAgent: req.headers["user-agent"] ?? "",
        at: Date.now(),
      };
      calls.push(call);
      const next = queue.shift();
      if (!next) {
        // Never a plausible answer: an unscripted request means the code under test made a
        // call the test did not expect, and that must fail the test rather than pass it.
        res.writeHead(599, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `fake endpoint: unscripted request #${calls.length}` } }));
        return;
      }
      next(res, call);
    })();
  });

  return {
    ...server,
    baseUrl: `${server.origin}/v1`,
    calls,
    script: (...responders: Responder[]) => {
      queue = [...responders];
    },
    reset: () => {
      calls.length = 0;
      queue = [];
    },
  };
}

// ─── Responders ──────────────────────────────────────────────────────────────

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

/** An ordinary buffered completion. */
export function completion(content: string, usage?: Usage, finishReason = "stop"): Responder {
  return (res) => {
    const body = JSON.stringify({
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    });
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  };
}

/** A rejected request: the status is what the retry taxonomy keys off. */
export function httpError(status: number, body: string, headers: Record<string, string> = {}): Responder {
  return (res) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(body);
  };
}

const dataLine = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

/** One content delta, in the shape every OpenAI-compatible backend emits. */
export const sseDelta = (content: string, finishReason: string | null = null) =>
  dataLine({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] });

/** The stats-only final chunk that stream_options.include_usage asks for. */
export const sseUsage = (usage: Usage) => dataLine({ choices: [], usage });

export const SSE_DONE = "data: [DONE]\n\n";

/**
 * A streamed answer, written line by line.
 *
 * `end: false` leaves the response open forever — a stalled engine that never closed its
 * socket, which is the failure the stall timer and the per-call deadline both exist for.
 */
export function sse(lines: string[], opts: { end?: boolean } = {}): Responder {
  return (res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    for (const line of lines) res.write(line);
    if (opts.end !== false) res.end();
  };
}
