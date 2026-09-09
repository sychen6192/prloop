// The CLI's argument grammar, as a pure function.
//
// It lived inline in loop.ts's main(), where nothing could reach it: importing loop.ts runs
// main(), so the only way to test `prloop --since 3 <URL>` was to spawn a process and read
// its output. The grammar has one genuinely subtle rule in it — the positional scan must
// skip --since's VALUE, or `prloop --since 3 <URL>` parses "3" as the PR URL and dies on a
// nonsense URL — and that rule is exactly the kind that gets broken by an unrelated edit.
//
// Nothing here exits or prints. Which mistakes are fatal, and how loudly, stays in main():
// --help is a request (stdout, 0), a bad argument is an error (stderr, non-zero), and that
// difference is a CLI decision, not a parsing one.
import { wantsConfigDump } from "./configreport";

export interface CliArgs {
  /** The PR URL, or undefined when none was given (which main() treats as a usage error). */
  url?: string;
  /** --since: an iteration number, "auto" to resume from the last reviewed one, or unset. */
  since?: number | "auto";
  dryRun: boolean;
  /** --config, or PRR_SHOW_CONFIG when the caller passed it in. */
  showConfig: boolean;
  help: boolean;
  /** A malformed argument, worded for the user. Set instead of exiting. */
  error?: string;
}

export function parseArgs(argv: readonly string[], showConfigEnv = false): CliArgs {
  const sinceIdx = argv.indexOf("--since");
  let since: number | "auto" | undefined;
  let error: string | undefined;
  if (sinceIdx >= 0) {
    const raw = argv[sinceIdx + 1];
    if (raw === "auto") {
      since = "auto";
    } else {
      // Number(undefined) is NaN, so `--since` as the last argument lands here too rather
      // than silently reviewing the whole PR.
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        error = `--since takes a non-negative integer or "auto", got: ${raw}`;
      } else {
        since = n;
      }
    }
  }

  // The positional scan skips --since's value: "3" and "auto" do not start with "-", so
  // without this `prloop --since 3 <URL>` takes "3" for the PR URL.
  const url = argv.find((a, i) => !a.startsWith("-") && (sinceIdx < 0 || i !== sinceIdx + 1));

  return {
    ...(url !== undefined ? { url } : {}),
    ...(since !== undefined ? { since } : {}),
    dryRun: argv.includes("--dry-run"),
    showConfig: wantsConfigDump(argv, showConfigEnv),
    help: argv.includes("-h") || argv.includes("--help"),
    ...(error !== undefined ? { error } : {}),
  };
}
