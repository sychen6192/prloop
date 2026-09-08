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

// The log is an egress (terminal, CI log, pipeline artifacts): every line is scrubbed here,
// once, rather than trusting each of a hundred call sites to remember that a gateway's
// error body may echo the key it rejected.
export function log(msg: string) {
  console.log(`[${elapsed()}] ${redactSecrets(msg)}`);
}

export function logVerbose(msg: string) {
  if (!QUIET) console.log(`[${elapsed()}] ${redactSecrets(msg)}`);
}

export function banner(title: string) {
  console.log(`\n[${elapsed()}] ========== ${title} ==========`);
}

export function die(msg: string): never {
  console.error(`[${elapsed()}] FATAL: ${redactSecrets(msg)}`);
  process.exit(1);
}


// Heartbeat every 15s during long ops so it doesn't look hung.
export function startHeartbeat(label: string): () => void {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    console.log(`[${elapsed()}] ${label} still running (waited ${ticks * 15}s)`);
  }, 15_000);
  return () => clearInterval(timer);
}
