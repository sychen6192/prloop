// Minimal command runner for external CLIs (az, git, the static-analysis tools); the
// pipeline itself never shells out for anything it needs to be correct.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { logVerbose } from "./log";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

// ─── Child process environment ───────────────────────────────────────────────
//
// The static tools run inside a checkout of the PR's SOURCE branch and execute that branch's
// code: an eslint config, a Maven plugin, a pre-commit hook are all programs the PR author
// wrote, and they used to inherit prloop's full environment — PRR_ADO_PAT, PRR_LLM_API_KEY,
// SYSTEM_ACCESSTOKEN. One `.eslintrc.js` that reads process.env and posts it somewhere is
// a credential exfiltration by anyone who can open a PR.
//
// A deny-list of secret-shaped NAMES, not an allow-list of known-good ones: Maven, Gradle
// and npm legitimately need arbitrary variables (JAVA_HOME, M2_HOME, npm_config_*, proxies,
// CA paths), and an allow-list would break a different build on every machine.
export const SECRET_ENV_NAME =
  /(^|_)(PAT|TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY)$|SYSTEM_ACCESSTOKEN|^PRR_(ADO_PAT|LLM_API_KEY)$/i;

/** `base` without every variable whose name looks like a credential. */
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (!SECRET_ENV_NAME.test(name)) out[name] = value;
  }
  return out;
}

/**
 * `cwd` matters more than it looks: a linter driven by its working directory (tsc takes no
 * file arguments at all) runs against whatever directory it is launched in. Without this,
 * static analysis type-checked prloop itself and every finding was then dropped by the
 * diff filter for having paths that matched nothing — a silent zero, not an error.
 */
export function run(
  cmd: string,
  args: string[],
  timeoutMs = 60_000,
  cwd?: string,
): Promise<ExecResult> {
  // Through planSpawn, not execFile directly. Every static-analysis tool in the TypeScript
  // profile is `npx`, which on Windows is npx.cmd — a shim current Node refuses to spawn
  // (CVE-2024-27980), so the whole gate died with EINVAL there. No-op on POSIX.
  const plan = planSpawn(cmd, args);
  if (plan.error) return Promise.resolve({ stdout: "", stderr: plan.error, code: 1 });
  return new Promise((resolve) => {
    execFile(plan.file, plan.args, {
      cwd,
      env: scrubbedEnv(),
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === "number"
        ? ((err as unknown as { code: number }).code)
        : err
          ? 1
          : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
    });
  });
}

export async function commandExists(cmd: string): Promise<boolean> {
  // On Windows resolve exactly the way planSpawn will. `where` alone reports the
  // extensionless bash shim as a hit, so doctor would pass while the real spawn fails —
  // the worst possible split, because the preflight vouches for a broken setup.
  if (process.platform === "win32") return resolveWindowsCommand(cmd) !== undefined;
  const res = await run("which", [cmd], 10_000);
  return res.code === 0 && res.stdout.trim() !== "";
}

// ─── Windows process spawning ────────────────────────────────────────────────
//
// Three distinct failures hide behind "spawn <tool> failed" on Windows, and each needs a
// different fix. All three are invisible on Linux/macOS.
//
// 1. ENOENT — an npm-installed CLI is `foo.cmd` (plus `foo.ps1`, and often an
//    extensionless bash shim). Node's spawn does NOT apply PATHEXT, so bare `foo` is not
//    found; and if the extensionless bash shim IS on PATH, Windows cannot execute it.
// 2. EINVAL — the obvious fix, spawning `foo.cmd` directly, has been an error since Node
//    18.20.2 / 20.12.2 / 21.7.3 (the CVE-2024-27980 batch-file-injection fix). A .cmd must
//    go through a shell.
// 3. E2BIG / ENAMETOOLONG / silent truncation — the command line is capped at 32767 chars
//    for CreateProcess and 8191 through cmd.exe. Linux allows ~2MB, so passing a prompt as
//    an argument works everywhere except the platform the user is on.

const WINDOWS_ARGV_LIMIT = 32_767;
const CMD_EXE_ARGV_LIMIT = 8_191;

/** Resolves a bare command name to a real file on Windows, honouring PATHEXT. */
export function resolveWindowsCommand(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts = (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = (env["PATH"] ?? "").split(";").filter(Boolean);

  const candidates = path.isAbsolute(cmd) || cmd.includes("\\") || cmd.includes("/") ? [cmd] : dirs.map((d) => path.join(d, cmd));
  for (const base of candidates) {
    // An explicit extension wins; otherwise try each PATHEXT entry, in order.
    if (path.extname(base) && fs.existsSync(base)) return base;
    for (const ext of exts) {
      const withExt = base + ext.toLowerCase();
      if (fs.existsSync(withExt)) return withExt;
    }
  }
  return undefined;
}

/**
 * Quotes one argument for cmd.exe, which needs two layers: CommandLineToArgvW quoting so the
 * child parses it as one argument, then `^`-escaping so cmd.exe does not interpret the
 * metacharacters itself.
 */
function quoteForCmd(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(/[()%!^"<>&|]/g, "^$&");
}

export interface SpawnPlan {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
  /** Set when the command line is too long for this platform to carry. */
  error?: string;
}

/**
 * Turns (command, args) into something spawn() can actually run on this platform.
 *
 * Returns an `error` rather than throwing when the command line cannot fit: that failure
 * needs to reach the user as "this argument is too long for Windows", not as a spawn errno.
 */
export function planSpawn(cmd: string, args: string[], platform: string = process.platform): SpawnPlan {
  if (platform !== "win32") return { file: cmd, args };

  const resolved = resolveWindowsCommand(cmd) ?? cmd;
  const isShim = /\.(cmd|bat)$/i.test(resolved);
  const limit = isShim ? CMD_EXE_ARGV_LIMIT : WINDOWS_ARGV_LIMIT;
  const length = [resolved, ...args].reduce((n, a) => n + a.length + 3, 0);
  if (length > limit) {
    return {
      file: resolved,
      args,
      error:
        `command line is ${length} chars but ${isShim ? "cmd.exe" : "Windows"} allows ${limit}. ` +
        (isShim
          ? "This is a .cmd shim, so it must go through cmd.exe and gets the lower 8191 limit. "
          : "") +
        "Pass large input over stdin or via a file instead of as an argument",
    };
  }
  if (!isShim) return { file: resolved, args };

  // A .cmd/.bat cannot be spawned directly on current Node; route it through cmd.exe.
  const line = [resolved, ...args].map(quoteForCmd).join(" ");
  return {
    file: process.env["ComSpec"] ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

// ─── Killing a process tree ──────────────────────────────────────────────────
//
// `child.kill()` signals ONE process — the one we spawned. That is the wrong target whenever
// the thing doing the work is a grandchild, which on Windows it always is: an npm-installed
// `opencode.cmd` has to be run through cmd.exe (see planSpawn), so our child is the cmd.exe
// wrapper and opencode is its child. Killing the wrapper leaves opencode running, still
// holding the inherited stdout/stderr pipe handles — and Node's 'close' event waits for those
// pipes to close, so the run hangs forever instead of ending. The escalation to SIGKILL then
// targets a pid that is already a corpse and silently does nothing.
//
// Two platforms, two mechanisms:
//
// - Windows has no signals at all. Node maps every signal to TerminateProcess, so SIGTERM and
//   SIGKILL are the same hard kill and a graceful-then-forceful escalation is meaningless.
//   `taskkill /T` is the only way to reach the whole tree.
// - POSIX can signal a process group, but only if the child leads one — hence `detached: true`
//   at spawn time (DETACH_CHILDREN below). Signalling a negative pid reaches the group.

export type KillPlan =
  | { via: "taskkill"; file: string; args: string[] }
  | { via: "signal"; target: number; signal: NodeJS.Signals };

/** Pure: how to kill `pid` and its descendants on this platform. Split out so it is testable. */
export function planKill(
  pid: number,
  signal: NodeJS.Signals,
  platform: string = process.platform,
): KillPlan {
  if (platform === "win32") {
    // /T = tree, /F = force. Without /F taskkill sends WM_CLOSE, which a console process
    // never receives, so there is no gentler variant worth trying first.
    return { via: "taskkill", file: "taskkill", args: ["/pid", String(pid), "/T", "/F"] };
  }
  return { via: "signal", target: -pid, signal }; // negative pid = the process group
}

/** True on POSIX: the child must lead its own process group for planKill's group signal. */
export const DETACH_CHILDREN = process.platform !== "win32";

/** Kills `child` and everything it spawned. Never throws — the caller is already on a sad path. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const plan = planKill(pid, signal);

  if (plan.via === "taskkill") {
    try {
      spawn(plan.file, plan.args, { stdio: "ignore", windowsHide: true }).unref();
      return;
    } catch (err) {
      logVerbose(`taskkill failed to start, falling back to killing the child only: ${String(err)}`);
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
      return;
    }
  }

  try {
    process.kill(plan.target, plan.signal);
  } catch (err) {
    // ESRCH just means the group is already gone. Anything else (e.g. the child was not
    // detached after all) is worth a direct-child fallback rather than a silent no-op.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }
}

// `detached: true` puts the child in its own process group, which is what makes the group kill
// above work — but it also means a Ctrl-C at the terminal no longer reaches it, because the
// shell only signals its own foreground group. Without the registry below, interrupting the
// tool would leave opencode running and holding the GPU. Windows needs none of this: children
// are not detached there, and a console Ctrl-C already goes to every process on the console.
const liveChildren = new Set<ChildProcess>();
let shutdownHooked = false;

/** Registers `child` so an interrupted run still takes its process tree down with it. */
export function trackForShutdown(child: ChildProcess): void {
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  if (shutdownHooked) return;
  shutdownHooked = true;

  const killAll = () => {
    for (const c of liveChildren) killTree(c, "SIGKILL");
    liveChildren.clear();
  };
  // 'exit' handlers must be synchronous; process.kill is, so the POSIX path is safe here.
  process.on("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      killAll();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}

/** Turns a spawn errno into the cause, rather than guessing one cause for all of them. */
export function explainSpawnError(err: NodeJS.ErrnoException, cmd: string): string {
  switch (err.code) {
    case "ENOENT":
      return `${cmd} not found on PATH${process.platform === "win32" ? " (looked for .cmd/.exe via PATHEXT too)" : ""}`;
    case "EINVAL":
      return `${cmd} could not be started: Node refuses to spawn a .bat/.cmd directly (CVE-2024-27980 fix); it must go through cmd.exe`;
    case "E2BIG":
    case "ENAMETOOLONG":
      return `${cmd} could not be started: the command line is too long for this platform. Pass large input over stdin or a file`;
    case "EACCES":
      return `${cmd} is not executable (permissions)`;
    default:
      return `${cmd} failed to start: ${err.message}`;
  }
}
