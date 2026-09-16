// A throwaway checkout of the exact commit under review, cut from a clone the operator
// already has.
//
// What this replaces: fetch, switch branch, point PRR_WORKDIR at it, run, switch back. That
// loop is not just tedious, it is wrong in a way nothing tells you about — `git checkout
// <branch>` lands on whatever the branch points at NOW, and the moment the author pushes
// again that is no longer the iteration under review. gates/static.ts compares every file
// against the iteration's bytes and skips the ones that differ, so a checkout one commit
// ahead does not fail the run; it quietly analyses fewer files and prints one warning.
//
// Detached at a SHA, so there is nothing to be out of date with. A worktree rather than a
// clone because it shares the object store (cheap), leaves the operator's own working copy
// untouched, and several can exist at once — which is the point when the input is a list of
// PRs rather than one.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WORKTREE_SETUP_CMD, WORKTREE_SETUP_TIMEOUT_MS } from "../config";
import { log, logVerbose } from "../libs/log";
import { run } from "../libs/shell";

export interface PreparedWorktree {
  dir: string;
  /** Removes the worktree. Safe to call twice; never throws. */
  cleanup: () => Promise<void>;
}

/**
 * How PRR_WORKTREE_SETUP_CMD is handed to a shell.
 *
 * Through a shell at all, because what belongs in that knob is the project's own install
 * line ("npm ci", "uv sync", "mvn -q -DskipTests install") and those are shell strings, not
 * argv — and through the platform's own shell, because `sh` is not on a Windows box and the
 * whole point of the knob is that it runs unattended.
 *
 * NOT a login shell. `sh -lc` re-sources /etc/profile and ~/.profile before running the
 * command, and a profile is exactly where an operator exports OPENAI_API_KEY, GITHUB_TOKEN
 * or AZURE_DEVOPS_EXT_PAT. run() hands every child scrubbedEnv() (libs/shell.ts), so the
 * login shell was putting back every name the scrub had just dropped — and then handing
 * them to the reviewed branch's own build script, which is a program the PR author wrote.
 * The linters never had this hole: gates/static.ts spawns their binary directly, no shell.
 * cmd.exe /d /s /c reads no profile, so Windows was never affected and does not change.
 *
 * The cost is real and is the reason `-l` was there: the command now inherits prloop's own
 * PATH and nothing else, exactly as the linters do. A toolchain that exists only inside
 * ~/.profile (nvm, pyenv, sdkman) is invisible to it. In practice prloop is itself started
 * through node, so the PATH that launched it already carries node and npm — the case that
 * breaks is a cron or systemd unit with a minimal PATH and an absolute node, where a
 * non-node toolchain lived only in the profile. Those operators export PATH in the
 * environment prloop starts from, which they already have to do for the linters.
 *
 * Pure, so the selftest can pin the flags for both platforms without a shell. Asserting on
 * the returned argv rather than grepping this file for "-lc" is deliberate: the argv catches
 * a reinstated `-l` however it is spelled.
 */
export function planSetupShell(cmd: string, platform: NodeJS.Platform): { file: string; args: string[] } {
  return platform === "win32"
    ? { file: "cmd.exe", args: ["/d", "/s", "/c", cmd] }
    : { file: "sh", args: ["-c", cmd] };
}

/** Why no worktree could be prepared, worded for the static gate's skippedReason. */
export interface WorktreeFailure {
  error: string;
}

export function isWorktreeFailure(r: PreparedWorktree | WorktreeFailure): r is WorktreeFailure {
  return "error" in r;
}

const GIT_TIMEOUT_MS = 10 * 60 * 1000;

async function git(repo: string, args: string[], timeoutMs = GIT_TIMEOUT_MS) {
  return run("git", ["-C", repo, ...args], timeoutMs);
}

/**
 * Cuts a worktree for `commit` out of `repo`.
 *
 * Never throws: a review whose static gate could not get a checkout is a review with one
 * gate skipped and the reason named, not a crashed run. Every failure returns a sentence a
 * reader can act on.
 */
export async function prepareWorktree(
  repo: string,
  commit: string,
  prId: number,
): Promise<PreparedWorktree | WorktreeFailure> {
  if (!fs.existsSync(repo)) return { error: `PRR_WORKTREE_REPO does not exist: ${repo}` };
  const isRepo = await git(repo, ["rev-parse", "--git-dir"], 60_000);
  if (isRepo.code !== 0) {
    return { error: `PRR_WORKTREE_REPO is not a git repository: ${repo}` };
  }
  if (!commit) {
    return { error: "the iteration has no source commit to check out (local intake, or an ADO response without one)" };
  }

  // Fetch before looking: on the run that matters the PR was pushed minutes ago, so the
  // commit is exactly what the clone does not have yet. Best effort — a clone that already
  // has it (or an offline box reviewing an older iteration) should still work.
  const fetched = await git(repo, ["fetch", "--quiet", "origin"]);
  if (fetched.code !== 0) {
    logVerbose(`worktree: git fetch failed, trying the commit anyway: ${fetched.stderr.trim().slice(0, 200)}`);
  }

  // Asking for the commit by name is the only reliable check. `git fetch origin <sha>`
  // needs uploadpack.allowReachableSHA1InWant on the server, which Azure DevOps does not
  // promise, so the fetch above is the plain one and this decides whether it worked.
  const has = await git(repo, ["cat-file", "-e", `${commit}^{commit}`], 60_000);
  if (has.code !== 0) {
    return {
      error:
        `commit ${commit.slice(0, 12)} is not in ${repo} after fetching origin — the source branch may not be ` +
        `pushed to this remote, or the clone is a partial/shallow one`,
    };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `prloop-wt-${prId}-${commit.slice(0, 8)}-`));
  // mkdtemp made it; `git worktree add` insists on creating the directory itself.
  fs.rmdirSync(dir);
  const added = await git(repo, ["worktree", "add", "--detach", "--quiet", dir, commit]);
  if (added.code !== 0) {
    return { error: `git worktree add failed: ${added.stderr.trim().slice(0, 300)}` };
  }
  log(`worktree: ${dir} at ${commit.slice(0, 12)}`);

  let removed = false;
  const cleanup = async () => {
    if (removed) return;
    removed = true;
    // --force because the setup command and the linters both write into the tree, and a
    // worktree git considers dirty is one it refuses to remove. `prune` catches the case
    // where the directory is already gone and only the administrative entry is left, which
    // would otherwise accumulate in the clone forever.
    const res = await git(repo, ["worktree", "remove", "--force", dir], 120_000);
    if (res.code !== 0) {
      logVerbose(`worktree: remove failed (${res.stderr.trim().slice(0, 200)}); pruning`);
      fs.rmSync(dir, { recursive: true, force: true });
      await git(repo, ["worktree", "prune"], 60_000);
    }
    logVerbose(`worktree: removed ${dir}`);
  };

  if (WORKTREE_SETUP_CMD) {
    log(`worktree: running PRR_WORKTREE_SETUP_CMD`);
    const { file, args } = planSetupShell(WORKTREE_SETUP_CMD, process.platform);
    const setup = await run(file, args, WORKTREE_SETUP_TIMEOUT_MS, dir);
    if (setup.code !== 0) {
      // Not fatal, and not silent. The fact-tier tools name an uninstalled tree themselves
      // (environmentRules) and discard their own findings; the other tools are unaffected.
      log(
        `[WARN] worktree: setup command ${setup.timedOut ? `timed out after ${WORKTREE_SETUP_TIMEOUT_MS}ms` : `failed (exit ${setup.code})`}` +
          `; linters run against an uninstalled tree: ${setup.stderr.trim().slice(0, 200)}`,
      );
    }
  }

  return { dir, cleanup };
}
