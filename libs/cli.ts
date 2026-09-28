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
  /** --batch: a file of PR URLs, one per line. Mutually exclusive with a URL argument. */
  batch?: string;
  dryRun: boolean;
  /** --config, or PRR_SHOW_CONFIG when the caller passed it in. */
  showConfig: boolean;
  help: boolean;
  /** A malformed argument, worded for the user. Set instead of exiting. */
  error?: string;
}

/** Options that take a value; their value must never be mistaken for the positional URL. */
const VALUED = ["--since", "--batch"] as const;

export function parseArgs(argv: readonly string[], showConfigEnv = false): CliArgs {
  const sinceIdx = argv.indexOf("--since");
  const batchIdx = argv.indexOf("--batch");
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

  const batch = batchIdx >= 0 ? argv[batchIdx + 1] : undefined;
  if (batchIdx >= 0 && (batch === undefined || batch.startsWith("-"))) {
    error ??= `--batch takes a file of pull request URLs, one per line, got: ${batch ?? "(nothing)"}`;
  }

  // The positional scan skips the VALUE of every valued option: "3", "auto" and a file path
  // do not start with "-", so without this `prloop --since 3 <URL>` takes "3" for the PR URL
  // and `prloop --batch prs.txt` takes prs.txt for it.
  const valueAt = new Set(VALUED.map((o) => argv.indexOf(o)).filter((i) => i >= 0).map((i) => i + 1));
  const url = argv.find((a, i) => !a.startsWith("-") && !valueAt.has(i));

  // Both would mean reviewing one PR and a list of them in the same process, and the more
  // likely reading of `prloop <URL> --batch prs.txt` is a mistake, not an instruction.
  if (url !== undefined && batch !== undefined) {
    error ??= "--batch reviews a list of pull requests; do not also pass a URL";
  }

  return {
    ...(url !== undefined ? { url } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(batch !== undefined && !batch.startsWith("-") ? { batch } : {}),
    dryRun: argv.includes("--dry-run"),
    showConfig: wantsConfigDump(argv, showConfigEnv),
    help: argv.includes("-h") || argv.includes("--help"),
    ...(error !== undefined ? { error } : {}),
  };
}
