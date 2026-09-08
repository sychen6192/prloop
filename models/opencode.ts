// OpencodeRunner: drive models through the opencode CLI instead of raw HTTP.
//
// Why this exists: the team already runs opencode, so provider credentials, model aliases
// and proxy setup live there. Going through it means prloop inherits that configuration
// instead of duplicating it.
//
// One consequence is load-bearing and must not be forgotten: **opencode does not pass
// `response_format` through to the engine**, so guided decoding (vLLM/xgrammar) is not
// available on this path. Schema conformity drops from "enforced at the token layer" to
// "asked for in the prompt". We compensate by injecting the schema as text and retrying
// once on a parse failure — but a weak model will still comply less reliably here than on
// the openai path. Prefer the openai runner when the endpoint supports guided decoding.
import { spawn } from "node:child_process";
import {
  DETACH_CHILDREN,
  explainSpawnError,
  killTree,
  planSpawn,
  trackForShutdown,
} from "../libs/shell";

// After the child exits, how long to wait for its stdio pipes to close before finishing anyway.
const EXIT_DRAIN_MS = 2_000;
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

function runOnce(label: string, model: string, prompt: string): Promise<ChatResponse> {
  return new Promise((resolve) => {
    log(`[${label}] opencode session started (model=${model || "(agent default)"})`);
    const stopHeartbeat = startHeartbeat(`[${label}]`);
    const started = Date.now();

    const args = buildInvocation(model, {
      jsonEvents: OPENCODE_JSON_EVENTS,
      agent: OPENCODE_AGENT,
    });
    logVerbose(`[${label}] prompt (${prompt.length} chars) passed via stdin`);

    // Windows also needs the command resolved through PATHEXT, and .cmd shims routed via
    // cmd.exe — Node refuses to spawn them directly since the CVE-2024-27980 fix.
    const plan = planSpawn(OPENCODE_BIN, args);
    if (plan.error) {
      log(`[${label}] [FAIL] ${plan.error}`);
      stopHeartbeat();
      resolve({ text: "", model, error: plan.error });
      return;
    }

    // opencode brings its own provider auth; prloop's ADO token and LLM key have no
    // business in a third-party CLI's environment.
    const childEnv = { ...process.env };
    delete childEnv["PRR_ADO_PAT"];
    delete childEnv["SYSTEM_ACCESSTOKEN"];
    delete childEnv["PRR_LLM_API_KEY"];

    const child = spawn(plan.file, plan.args, {
      cwd: PRLOOP_ROOT,
      env: childEnv,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX only: makes the child a process-group leader so a timeout can kill the whole
      // tree, not just the process we happen to hold. See libs/shell.ts.
      detached: DETACH_CHILDREN,
    });
    trackForShutdown(child);

    // opencode blocks on reading stdin to EOF before it prompts the model, so this has to be
    // written and closed unconditionally — a piped-but-never-closed stdin hangs the run.
    // EPIPE is expected if the child dies first (bad flag, missing auth); the close handler
    // reports that, so swallow it here rather than let it surface as an unhandled error.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt, "utf8");

    const acc: Acc = { text: "", lastText: "" };
    let rawStdout = "";
    let stdoutBuf = "";
    let spawnError: string | undefined;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      rawStdout += chunk;
      stdoutBuf += chunk;
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? ""; // keep the partial line for the next chunk
      for (const line of lines) if (line.trim()) traceEvent(line, `[${label}]`, acc);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.trim().split("\n")) if (line.trim()) logVerbose(`[${label}] ${line}`);
    });

    // Timeout: kill the whole process tree. The old code signalled only the process we
    // spawned, which on Windows is the cmd.exe wrapper rather than opencode itself.
    let timedOut = false;
    let killEscalation: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      log(
        `[${label}] timed out after ${AGENT_TIMEOUT_MS}ms, killing the opencode process tree ` +
          `(raise PRR_AGENT_TIMEOUT_MS for slower models)`,
      );
      killTree(child, "SIGTERM");
      // Only POSIX has anything to escalate to: on Windows taskkill /F was already a hard
      // kill, and repeating it would just log a second failure against a dead pid.
      if (DETACH_CHILDREN) {
        killEscalation = setTimeout(() => {
          logVerbose(`[${label}] process tree still alive, sending SIGKILL`);
          killTree(child, "SIGKILL");
        }, 10_000);
      }
    }, AGENT_TIMEOUT_MS);

    // How the child ended, for the failure message. Recorded from whichever of 'exit' and
    // 'close' fires first; both carry the same pair.
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    const recordExit = (code: number | null, signal: NodeJS.Signals | null) => {
      exitCode = code;
      exitSignal = signal;
    };

    let finished = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killEscalation) clearTimeout(killEscalation);
      if (drainTimer) clearTimeout(drainTimer);
      stopHeartbeat();
      if (stdoutBuf.trim()) traceEvent(stdoutBuf, `[${label}]`, acc); // flush partial line

      const secs = Math.round((Date.now() - started) / 1000);
      const text = OPENCODE_JSON_EVENTS ? (acc.text.trim() ? acc.text : acc.lastText) : rawStdout;
      if (spawnError) {
        resolve({ text: "", model, error: spawnError });
        return;
      }
      // A killed or crashed run is not a completed one: it resolves WITH an error (so the
      // transient retry can fire and the stage is reported as failed) and still hands back
      // what arrived, for the artifacts.
      const error = runFailure({
        timedOut,
        timeoutMs: AGENT_TIMEOUT_MS,
        code: exitCode,
        signal: exitSignal,
        lastError: acc.lastError,
        text,
      });
      log(
        timedOut
          ? `[${label}] timed out (elapsed ${secs}s, ${text.length} chars kept)`
          : error
            ? `[${label}] [FAIL] ${error} (elapsed ${secs}s)`
            : `[${label}] done (elapsed ${secs}s, ${text.length} chars)`,
      );
      resolve(error === undefined ? { text, model } : { text, model, error });
    };

    // 'close' waits for the stdio pipes to close as well as for the process to exit, so any
    // survivor holding an inherited pipe keeps it from ever firing — that is what turned a
    // Windows timeout into a permanent hang. 'exit' always fires; let the pipes drain briefly,
    // then finish regardless. finish() is idempotent, so the usual ordering ('close' first,
    // promptly) is unaffected.
    child.on("exit", (code, signal) => {
      recordExit(code, signal);
      drainTimer = setTimeout(() => {
        logVerbose(`[${label}] process exited but its output pipes are still open; not waiting`);
        finish();
      }, EXIT_DRAIN_MS);
    });
    child.on("close", (code, signal) => {
      recordExit(code, signal);
      finish();
    });
    child.on("error", (err) => {
      // The old message blamed a missing install for every errno, which is wrong for the
      // two failures that actually bite on Windows (EINVAL on a .cmd, and an oversized
      // command line) and sends people to reinstall a CLI that is already there.
      spawnError = `${explainSpawnError(err, OPENCODE_BIN)} — install the opencode CLI, or set PRR_OPENCODE_BIN`;
      logVerbose(`[${label}] ${spawnError}`);
      finish();
    });
  });
}

export class OpencodeRunner implements ModelRunner {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    // opencode has no separate system-message channel here; the role contract lives in the
    // agent .md and everything task-specific is injected into the prompt — "injection over
    // discovery", because a loop cannot depend on probabilistic skill loading.
    const prompt = `${req.system}\n\n---\n\n${inlineSchema(req)}`;
    const label = req.schemaName ?? "opencode";
    return runOnce(label, req.model, prompt);
  }
}
