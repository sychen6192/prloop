// Artifacts: every stage's input and output lands on disk. State lives in files, not in
// model context — that's what makes a run reproducible and auditable after the fact
// (design principle: state in artifacts, not context).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNS_DIR } from "../config";
import { attachLogSink } from "./log";
import { redactSecrets } from "./redact";
import type { PrRef } from "./types";

export interface RunDir {
  dir: string;
  save(name: string, content: string): void;
  saveJson(name: string, value: unknown): void;
}

// The released version, for result.json. Read once, the same way libs/proxy.ts reads it for
// the User-Agent — kept local rather than imported from there so writing an artifact does
// not pull in the whole proxy/undici stack.
export const PRLOOP_VERSION = (() => {
  try {
    const p = fileURLToPath(new URL("../package.json", import.meta.url));
    return (JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

// ─── Model call log ──────────────────────────────────────────────────────────
// One line per model ATTEMPT, written by models/runner.ts. It cannot reach a run directory
// directly — createRunner() runs before intake knows which directory this run gets — so the
// runner calls recordCall() unconditionally and this hook decides where it goes. Default:
// nowhere, which is what keeps the runner usable in tests and one-off scripts.

export interface CallRecord {
  ts: string;
  /** Which stage asked: the request's schema name (findings / verdict / triage / …). */
  stage: string;
  model: string;
  /** 0 for the first try, 1+ for retries — a run whose every call retried is a sick endpoint. */
  attempt: number;
  ms: number;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
}

export type CallSink = (record: CallRecord) => void;

let callSink: CallSink | undefined;

/** Records one model attempt, if anything is listening. A no-op by default. */
export function recordCall(record: CallRecord): void {
  callSink?.(record);
}

export function attachCallSink(fn: CallSink): void {
  callSink = fn;
}

export function detachCallSink(): void {
  callSink = undefined;
}

/** One calls.jsonl line. Pure, and redacted like every other artifact. */
export function formatCallRecord(record: CallRecord): string {
  return redactSecrets(JSON.stringify(record));
}

// ─── Run summary ─────────────────────────────────────────────────────────────

export interface ResultSummaryInput {
  exitCode: number;
  incomplete: readonly string[];
  counts: { raw: number; anchored: number; survived: number; inline: number; degraded: number };
  tokens: { calls: number; promptTokens: number; completionTokens: number };
  durationSec: number;
}

/**
 * What runs/<...>/result.json holds: the whole outcome of a run in one file, so "what did
 * that run actually do" is answerable without replaying the log or opening five artifacts.
 * The exit code is in it because that is the fact CI acted on, and the version because a
 * result from an older prloop must be readable as such. Pure, for the selftest.
 */
export function buildResultSummary(input: ResultSummaryInput): Record<string, unknown> {
  return {
    exitCode: input.exitCode,
    incomplete: [...input.incomplete],
    counts: { ...input.counts },
    tokens: { ...input.tokens },
    durationSec: input.durationSec,
    version: PRLOOP_VERSION,
  };
}

/**
 * A writer for one run directory. Split from createRunDir so the selftest can point it at
 * a temp dir instead of the real runs/ tree.
 *
 * `tee` sends the run's log lines and model-call records into the directory too. Off by
 * default: a caller that merely wants to write a file into an existing run (loop.ts writing
 * result.json at the end) must not re-open the log sink it already has.
 */
export function openRunDir(dir: string, tee = false): RunDir {
  fs.mkdirSync(dir, { recursive: true });
  // Best-effort: a full disk or read-only runs/ must not kill a review that has already
  // paid for its model calls — the artifacts are an audit trail, not the product.
  //
  // Redacted on the way out: raw model responses and stage verdicts carry gateway error
  // bodies verbatim, and runs/ is exactly the directory people attach to bug reports.
  const write = (name: string, content: string) => {
    try {
      fs.writeFileSync(path.join(dir, name), redactSecrets(content));
    } catch (e) {
      console.error(`[WARN] could not write artifact ${name}: ${e instanceof Error ? e.message : e}`);
    }
  };
  if (tee) {
    // A log line the terminal scrolled away is gone; runs/ is where a run is diagnosed a
    // week later, and until now it held every artifact EXCEPT the narration tying them
    // together. Appended line by line so a crashed run still has everything up to the crash.
    attachLogSink(appender(path.join(dir, "run.log"), (line) => `${line}\n`));
    attachCallSink(appender(path.join(dir, "calls.jsonl"), (r: CallRecord) => `${formatCallRecord(r)}\n`));
  }
  return {
    dir,
    save(name, content) {
      write(name, content);
    },
    saveJson(name, value) {
      write(name, JSON.stringify(value, (_k, v) => (v instanceof Set ? [...v] : v), 2));
    },
  };
}

/**
 * An append-per-item writer that gives up permanently after the first failure: a read-only
 * runs/ would otherwise print a warning for every log line for the rest of the run, drowning
 * the very output it failed to save.
 */
function appender<T>(file: string, render: (item: T) => string): (item: T) => void {
  let broken = false;
  return (item) => {
    if (broken) return;
    try {
      fs.appendFileSync(file, render(item));
    } catch (e) {
      broken = true;
      console.error(`[WARN] could not write ${path.basename(file)}: ${e instanceof Error ? e.message : e}`);
    }
  };
}

export function createRunDir(ref: PrRef, iterationId: number): RunDir {
  return openRunDir(
    path.join(
      RUNS_DIR,
      safe(ref.org),
      safe(ref.project),
      safe(ref.repoId),
      `pr-${ref.prId}`,
      `iter-${iterationId}-${timestamp()}`,
    ),
    true,
  );
}
