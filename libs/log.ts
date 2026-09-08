// Logging: every line carries [mm:ss] elapsed time so you can tell it's still alive.
import { QUIET } from "../config";
import { redactSecrets } from "./redact";

const START_TS = Date.now();

export function elapsed(): string {
  const s = Math.floor((Date.now() - START_TS) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/** A second destination for every log line, e.g. the run's own run.log. */
export type LogSink = (line: string) => void;

let sink: LogSink | undefined;
// Lines emitted before a sink was attached. The run directory is only created after intake
// has fetched the PR — which is exactly where the interesting early failures happen (auth,
// proxy, config warnings), so those lines must not be lost to the terminal alone. Bounded:
// a run whose sink is never attached must not grow a list forever.
const pending: string[] = [];
const MAX_PENDING = 2000;

/** Attaches a sink and replays everything logged before it existed. */
export function attachLogSink(fn: LogSink): void {
  sink = fn;
  const backlog = pending.splice(0, pending.length);
  for (const line of backlog) fn(line);
}

export function detachLogSink(): void {
  sink = undefined;
}

/**
 * The one place a log line is written. Redaction happens HERE, once, rather than at a
 * hundred call sites: a gateway's error body may echo the key it rejected, and the sink
 * (run.log, attached to a directory people put in bug reports) must never see the raw text
 * — a redaction applied only on the way to the terminal would protect the wrong egress.
 */
function emit(line: string, toStderr = false): void {
  const clean = redactSecrets(line);
  if (toStderr) console.error(clean);
  else console.log(clean);
  if (sink) sink(clean);
  else if (pending.length < MAX_PENDING) pending.push(clean);
}

export function log(msg: string) {
  emit(`[${elapsed()}] ${msg}`);
}

export function logVerbose(msg: string) {
  if (!QUIET) emit(`[${elapsed()}] ${msg}`);
}

export function banner(title: string) {
  emit(`\n[${elapsed()}] ========== ${title} ==========`);
}

export function die(msg: string): never {
  emit(`[${elapsed()}] FATAL: ${msg}`, true);
  process.exit(1);
}


// Heartbeat every 15s during long ops so it doesn't look hung.
export function startHeartbeat(label: string): () => void {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    emit(`[${elapsed()}] ${label} still running (waited ${ticks * 15}s)`);
  }, 15_000);
  return () => clearInterval(timer);
}
