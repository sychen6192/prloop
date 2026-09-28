// Local intake: build the same ReviewContext from a git working tree instead of Azure DevOps.
//
// Exists for two reasons: reviewing a branch before opening a PR, and — more importantly —
// being able to exercise the diff and anchoring path against real repositories without
// needing ADO credentials. It reuses libs/diff.ts wholesale, so what it validates is the
// same code that runs in production, not a parallel implementation.
import { FileIndex } from "../libs/fileindex";
import { detectLanguage, isNoiseFile, isReviewable } from "../libs/lang";
import { buildHunks, diffLines } from "../libs/diff";
import { splitLines } from "../libs/text";
import { log, logVerbose } from "../libs/log";
import { run } from "../libs/shell";
import type { ChangeType, FileDiff, PrInfo } from "../libs/types";
import type { ReviewContext, SkippedFile } from "../libs/context";

async function git(repo: string, args: string[]): Promise<string> {
  const res = await run("git", ["-C", repo, ...args], 120_000);
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.trim()}`);
  return res.stdout;
}

/**
 * File content at a ref.
 *
 * The reason this returns a reason and not just lines: every non-zero git exit used to
 * collapse into "empty", i.e. "the path does not exist at this ref" — the expected answer
 * for an added or deleted file. A file too large for the output cap (libs/shell.ts kills the
 * child past 8 MB) therefore came back as absent, was diffed as wholly added, and the run
 * reported a clean review of a file nobody had read. The ADO intake names that case
 * `too large` and orchestrator.ts counts it into coverageGaps; collapsing failure into
 * absence is exactly what CLAUDE.md's "failures are named precisely" rule is about.
 */
async function showFile(
  repo: string,
  ref: string,
  filePath: string,
): Promise<{ lines: string[] } | { failure: string }> {
  const res = await run("git", ["-C", repo, "show", `${ref}:${filePath}`], 120_000);
  if (res.code === 0) return { lines: splitLines(Buffer.from(res.stdout, "utf8")) };
  if (res.timedOut) return { failure: "git show timed out" };
  // The output cap. Same wording as ado/blobs.ts uses, because the same thing happened and
  // orchestrator.ts recognises this exact string.
  if (/produced more than \d+ characters/.test(res.stderr)) return { failure: "too large" };
  // git's own words for "not at this ref", which is not a failure at all.
  if (/does not exist in|exists on disk, but not in|unknown revision or path/.test(res.stderr)) {
    return { lines: [] };
  }
  return { failure: `git show failed: ${res.stderr.trim().split("\n")[0] ?? `exit ${res.code}`}` };
}

function mapStatus(code: string): ChangeType {
  const c = code[0];
  if (c === "A") return "add";
  if (c === "D") return "delete";
  if (c === "R") return "rename";
  if (c === "M") return "edit";
  return "other";
}

export interface LocalIntakeOptions {
  repo: string;
  base: string;
  head: string;
}

export async function buildLocalReviewContext(opts: LocalIntakeOptions): Promise<ReviewContext> {
  // Three-dot: compare against the merge base, which is what a PR diff actually shows.
  const raw = await git(opts.repo, [
    "diff",
    "--name-status",
    "--find-renames",
    `${opts.base}...${opts.head}`,
  ]);

  const entries = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      // A rename line is "R096\told\tnew": the trail matters, because fileindex follows
      // originalPath to keep a thread created on the old name attached to the file.
      const parts = l.split("\t");
      const status = parts[0] ?? "";
      const path = parts[parts.length - 1] ?? "";
      const originalPath = status.startsWith("R") && parts.length >= 3 ? parts[1] : undefined;
      return { status, path, ...(originalPath === undefined ? {} : { originalPath }) };
    })
    .filter((e) => e.path);

  const skipped: SkippedFile[] = [];
  const files: FileDiff[] = [];

  for (const e of entries) {
    const changeType = mapStatus(e.status);
    if (isNoiseFile(e.path)) {
      skipped.push({ path: e.path, reason: "generated/lock/vendor" });
      continue;
    }
    if (!isReviewable(e.path)) {
      skipped.push({ path: e.path, reason: `non-code (${detectLanguage(e.path)})` });
      continue;
    }
    if (changeType === "delete") {
      skipped.push({ path: e.path, reason: "deleted" });
      continue;
    }

    // A rename reads its left side from the OLD path; at the base ref the new one does not
    // exist yet, and reading it there produced an empty left side — a rename diffed as a
    // wholly new file.
    const [right, left] = await Promise.all([
      showFile(opts.repo, opts.head, e.path),
      showFile(opts.repo, opts.base, e.originalPath ?? e.path),
    ]);
    const failure = "failure" in right ? right.failure : "failure" in left ? left.failure : undefined;
    if (failure !== undefined) {
      skipped.push({ path: e.path, reason: failure });
      continue;
    }
    const rightLines = (right as { lines: string[] }).lines;
    const leftLines = (left as { lines: string[] }).lines;
    const { hunks, changedRightLines, changedLeftLines } = buildHunks(
      leftLines,
      rightLines,
      diffLines(leftLines, rightLines),
    );
    if (hunks.length === 0) {
      skipped.push({ path: e.path, reason: "no textual change" });
      continue;
    }
    // Canonical path shape, same as the ADO intake produces after normalization: no
    // leading slash, forward separators. git already reports exactly that.
    files.push({
      path: e.path,
      ...(e.originalPath === undefined ? {} : { originalPath: e.originalPath }),
      changeType,
      hunks,
      rightLines,
      leftLines,
      changedRightLines,
      changedLeftLines,
      binary: false,
      truncated: false,
      language: detectLanguage(e.path),
    });
    logVerbose(`  ${e.path}: ${hunks.length} hunks, ${changedRightLines.size} changed lines`);
  }

  const subject = (await git(opts.repo, ["log", "-1", "--format=%s", opts.head])).trim();
  const body = (await git(opts.repo, ["log", "-1", "--format=%b", opts.head])).trim();
  const pr: PrInfo = {
    title: subject,
    description: body,
    sourceBranch: opts.head,
    targetBranch: opts.base,
    createdBy: (await git(opts.repo, ["log", "-1", "--format=%an", opts.head])).trim(),
    status: "local",
  };

  log(`Local diff: ${opts.base}...${opts.head}, ${files.length} files under review, ${skipped.length} skipped`);

  // Real commits, not empty strings. orchestrator.ts fetches the repository's convention
  // files at ctx.iteration.targetRefCommit and hands ctx.iteration.sourceRefCommit to the
  // static gate; a sentinel there satisfies the type and then silently means "no
  // conventions" and "no source commit". prId 0 and the empty baseUrl stay sentinels — there
  // is no PR — and every ADO call is gated on having one before it runs.
  const iteration = {
    id: 1,
    sourceRefCommit: (await git(opts.repo, ["rev-parse", opts.head])).trim(),
    targetRefCommit: (await git(opts.repo, ["rev-parse", opts.base])).trim(),
    commonRefCommit: (await git(opts.repo, ["merge-base", opts.base, opts.head])).trim(),
    createdDate: "",
  };
  return {
    ref: { baseUrl: "", org: "local", project: "local", repoId: opts.repo, prId: 0 },
    pr,
    iterations: [iteration],
    iteration,
    compareTo: 0,
    files,
    skipped,
    changeTrackingIds: new Map(),
    fileIndex: new FileIndex(files),
  };
}
