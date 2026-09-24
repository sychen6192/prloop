// OpencodeRunner: drive models through the opencode CLI instead of raw HTTP.
//
// Why this exists: the team already runs opencode, so provider credentials, model aliases
// and proxy setup live there. Going through it means prloop inherits that configuration
// instead of duplicating it.
//
// One consequence is load-bearing and must not be forgotten: **opencode does not pass
// `response_format` through to the engine**, so guided decoding (vLLM/xgrammar) is not
// available on this path. Schema conformity drops from "enforced at the token layer" to
// "asked for in the prompt". We compensate by injecting the schema as text (schemas.ts,
// inlineSchema) — and by nothing else: a parse failure is NOT retried, here or anywhere.
// models/runner.ts wraps this runner in withRetries like any other, but
// isTransientModelError returns false for parse-shaped failures on purpose, because asking
// the same model the same question again is not a fix for an answer it was capable of
// giving wrongly. So a weak model complies less reliably here than on the openai path, and
// a non-conforming answer costs the whole call. Prefer the openai runner when the endpoint
// supports guided decoding.
import { run } from "../libs/shell";
import {
  AGENT_TIMEOUT_MS,
  OPENCODE_AGENT,
  OPENCODE_BIN,
  OPENCODE_JSON_EVENTS,
  PRLOOP_ROOT,
} from "../config";
import { log, logVerbose, startHeartbeat } from "../libs/log";
import { inlineSchema } from "./schemas";
import type { ChatRequest, ChatResponse, ModelRunner } from "../libs/types";

export interface Acc {
  text: string;
  lastText: string;
  // Token usage, summed over the run's steps. The CLI reports it per step-finish and every
  // step re-sends the context, so summing is what the provider billed — the same rule
  // models/runner.ts applies across retry attempts. Without this the opencode path reported
  // zeros, and a run's token total silently depended on which runner it used.
  inputTokens?: number;
  outputTokens?: number;
  // The last in-band error event's message: the CLI's own account of why a run produced
  // nothing (provider auth, rate limit), which its exit code alone does not carry.
  lastError?: string;
}

/** First `message` string in an error event, wherever this CLI version nested it. */
function errorMessage(node: unknown, depth = 0): string | undefined {
  if (typeof node !== "object" || node === null || depth > 4) return undefined;
  const o = node as Record<string, unknown>;
  if (typeof o["message"] === "string" && o["message"].trim()) return o["message"].trim();
  for (const v of Object.values(o)) {
    const m = errorMessage(v, depth + 1);
    if (m) return m;
  }
  return undefined;
}

/**
 * The error a finished opencode run reports, or undefined for a completion the caller's
 * parse should judge. Exported for the selftest.
 *
 * A timed-out or crashed run used to resolve `{ text, model }` with no error at all, so the
 * failure surfaced two stages later as "output unparseable" or "model returned an empty
 * string" — deterministic-looking failures the transient retry deliberately never fires
 * on. Naming the real cause here is what lets the retry, and the operator, act on it.
 * `text` still travels alongside: the artifacts want the partial output, and the caller's
 * parse is fail-closed regardless.
 */
export function runFailure(run: {
  timedOut: boolean;
  timeoutMs: number;
  code: number | null;
  signal: string | null;
  lastError?: string;
  text: string;
}): string | undefined {
  const detail = run.lastError ? `: ${run.lastError}` : "";
  if (run.timedOut) return `timeout (${run.timeoutMs}ms)${detail}`;
  // The CLI produced an answer; a non-zero exit next to real output (a warning treated as
  // fatal at shutdown, say) is for the schema parse to judge, not for this to discard.
  if (run.text.trim()) return undefined;
  if (run.code !== null && run.code !== 0) return `opencode exited ${run.code}${detail}`;
  if (run.signal) return `opencode killed by ${run.signal}${detail}`;
  return run.lastError;
}

// Parses one JSONL event. The real event kind lives in part.type (hyphenated); the outer
// ev.type is an unreliable envelope label. Accepts both hyphen and underscore forms.
export function traceEvent(line: string, prefix: string, acc: Acc): void {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line);
  } catch {
    return; // non-JSON diagnostic noise
  }
  const part = (ev["part"] ?? {}) as Record<string, unknown>;
  const kind = String(part["type"] ?? ev["type"] ?? "").replace(/_/g, "-");

  if (kind === "text") {
    const t = String(part["text"] ?? "");
    if (!t) return;
    acc.text += t;
    // Models often emit the final JSON as the last complete text part; keep it as a fallback
    // in case the accumulated stream is polluted by preamble.
    acc.lastText = t;
    const oneLine = t.replace(/\s+/g, " ").trim();
    if (oneLine) logVerbose(`${prefix} ${oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine}`);
  } else if (kind === "step-finish") {
    const tokens = (part["tokens"] ?? {}) as Record<string, unknown>;
    const add = (v: unknown, was: number | undefined): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? (was ?? 0) + v : was;
    acc.inputTokens = add(tokens["input"], acc.inputTokens);
    acc.outputTokens = add(tokens["output"], acc.outputTokens);
    if (tokens["output"] !== undefined) {
      logVerbose(`${prefix} -- step finished (output tokens=${String(tokens["output"])})`);
    }
  } else if (kind === "error") {
    acc.lastError = errorMessage(ev) ?? JSON.stringify(ev).slice(0, 300);
    logVerbose(`${prefix} [WARN] ${JSON.stringify(ev).slice(0, 300)}`);
  }
}


/**
 * Builds the argv for one `opencode run`. The prompt is deliberately NOT in it — the caller
 * writes it to the child's stdin.
 *
 * `opencode run` reads stdin to EOF whenever stdin is not a TTY and uses it as the message
 * (appended after the positional message, if any). Passing no positional message therefore
 * makes the piped text the entire prompt.
 *
 * That is the only route that survives a review prompt carrying a diff. Two earlier attempts
 * did not:
 *
 * - Positional argument: an npm-installed `opencode.cmd` must be spawned through cmd.exe
 *   (Node refuses to spawn .cmd directly since the CVE-2024-27980 fix), and cmd.exe re-parses
 *   the command line, shredding a prompt full of quotes, newlines and JSON. It is capped at
 *   8191 chars besides, and a diff prompt runs to six figures. opencode also re-quotes
 *   positional messages itself, corrupting any prompt containing a double quote even on POSIX.
 * - `--file <tmp>/prompt.md <instruction>`: opencode declares --file as a yargs array option,
 *   so it greedily swallows every following positional. The instruction was parsed as a
 *   second file path, giving `File not found: <the instruction text>`.
 *
 * stdin has no length limit and never passes through a shell, so this needs no
 * platform-specific branch at all.
 */
export function buildInvocation(
  model: string,
  opts: { jsonEvents: boolean; agent: string },
): string[] {
  const args = ["run", "--agent", opts.agent];
  if (model) args.push("--model", model);
  if (opts.jsonEvents) args.push("--format", "json");
  return args;
}

async function runOnce(label: string, model: string, prompt: string, timeoutMs: number): Promise<ChatResponse> {
  log(`[${label}] opencode session started (model=${model || "(agent default)"})`);
  const stopHeartbeat = startHeartbeat(`[${label}]`);
  const started = Date.now();

  const args = buildInvocation(model, { jsonEvents: OPENCODE_JSON_EVENTS, agent: OPENCODE_AGENT });
  logVerbose(`[${label}] prompt (${prompt.length} chars) passed via stdin`);

  const acc: Acc = { text: "", lastText: "" };
  // libs/shell.ts owns the whole child-process failure taxonomy: PATHEXT and .cmd routing
  // through planSpawn, the credential-scrubbed environment, the detached group leader, the
  // 8 MB output cap, SIGTERM → SIGKILL escalation, the exit/close drain that stops a
  // grandchild holding an inherited pipe from hanging the run, and an idempotent
  // completion. This used to be a second copy of all of it — one that had dropped the
  // output cap — because run() could not write stdin or stream stdout by line. It can now.
  const res = await run(OPENCODE_BIN, args, timeoutMs, PRLOOP_ROOT, {
    // opencode blocks reading stdin to EOF before it prompts the model.
    stdin: prompt,
    onStdoutLine: (line: string) => {
      if (line.trim()) traceEvent(line, `[${label}]`, acc);
    },
    onStderrLine: (line: string) => {
      if (line.trim()) logVerbose(`[${label}] ${line}`);
    },
    // Said when it happens, not at the end: a fifteen-minute agent deadline is exactly the
    // case where a reader needs to know the run is over before the process is.
    onTimeout: () =>
      log(
        `[${label}] timed out after ${timeoutMs}ms, killing the opencode process tree ` +
          `(raise PRR_AGENT_TIMEOUT_MS for slower models)`,
      ),
    killEscalationMs: 10_000,
  });
  stopHeartbeat();

  const secs = Math.round((Date.now() - started) / 1000);
  if (res.spawnFailed) {
    // The old message blamed a missing install for every errno, which is wrong for the two
    // failures that actually bite on Windows (EINVAL on a .cmd, and an oversized command
    // line) and sends people to reinstall a CLI that is already there.
    const spawnError = `${res.stderr.trim()} — install the opencode CLI, or set PRR_OPENCODE_BIN`;
    log(`[${label}] [FAIL] ${spawnError}`);
    return { text: "", model, error: spawnError };
  }

  const text = OPENCODE_JSON_EVENTS ? (acc.text.trim() ? acc.text : acc.lastText) : res.stdout;
  // A killed or crashed run is not a completed one: it resolves WITH an error (so the
  // transient retry can fire and the stage is reported as failed) and still hands back what
  // arrived, for the artifacts.
  const error = runFailure({
    timedOut: res.timedOut === true,
    timeoutMs,
    code: res.code,
    signal: res.signal ?? null,
    lastError: acc.lastError,
    text,
  });
  log(
    res.timedOut
      ? `[${label}] timed out (elapsed ${secs}s, ${text.length} chars kept)`
      : error
        ? `[${label}] [FAIL] ${error} (elapsed ${secs}s)`
        : `[${label}] done (elapsed ${secs}s, ${text.length} chars)`,
  );
  const usage = {
    ...(acc.inputTokens === undefined ? {} : { promptTokens: acc.inputTokens }),
    ...(acc.outputTokens === undefined ? {} : { completionTokens: acc.outputTokens }),
  };
  return error === undefined ? { text, model, ...usage } : { text, model, ...usage, error };
}

// Said once per process, not per call: a fleet of finders would otherwise print the same
// line a dozen times a run, and the point is that the operator learns their setting is not
// reaching the model — once is enough for that.
const warnedUnsupported = new Set<string>();
function warnUnsupported(field: string, value: unknown, why: string): void {
  if (warnedUnsupported.has(field)) return;
  warnedUnsupported.add(field);
  log(`[WARN] ${field}=${String(value)} is not applied on the opencode runner: ${why}`);
}

export class OpencodeRunner implements ModelRunner {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    // opencode has no separate system-message channel here; the role contract lives in the
    // agent .md and everything task-specific is injected into the prompt — "injection over
    // discovery", because a loop cannot depend on probabilistic skill loading.
    const prompt = `${req.system}\n\n---\n\n${inlineSchema(req)}`;
    const label = req.schemaName ?? "opencode";

    // ChatRequest is a contract, and the two fields below are the half of it `opencode run`
    // has no argument for. Ignoring them silently is what made PRR_SKEPTIC_MAX_TOKENS and
    // the requirement axis's temperature: 0 configure nothing on this path while the type
    // said otherwise — the caller sets a field, the type accepts it, and nothing anywhere
    // says it did not arrive. Naming them is the least this adapter owes.
    if (req.temperature !== undefined) {
      warnUnsupported("temperature", req.temperature, "the opencode CLI takes no sampling arguments; it uses the model's own default");
    }
    if (req.maxTokens !== undefined) {
      warnUnsupported("maxTokens", req.maxTokens, "the opencode CLI takes no output-length argument; the agent's own limit applies");
    }
    // This one it CAN keep. The skeptic sets it because verifying one finding against 25
    // lines is nothing like reading a whole diff, and under this runner every such call was
    // getting the 15-minute agent deadline instead.
    return runOnce(label, req.model, prompt, req.timeoutMs ?? AGENT_TIMEOUT_MS);
  }
}
