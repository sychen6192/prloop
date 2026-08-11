// Local intake: build the same ReviewContext from a git working tree instead of Azure DevOps.
//
// Exists for two reasons: reviewing a branch before opening a PR, and — more importantly —
// being able to exercise the diff and anchoring path against real repositories without
// needing ADO credentials. It reuses libs/diff.ts wholesale, so what it validates is the
// same code that runs in production, not a parallel implementation.
import { FileIndex } from "../libs/fileindex";
import { detectLanguage, isNoiseFile, isReviewable } from "../libs/lang";
import { buildHunks, diffLines } from "../libs/diff";
import { splitLines } from "../ado/blobs";
import { log, logVerbose } from "../libs/log";
import { run } from "../libs/shell";
import type { ChangeType, FileDiff, PrInfo } from "../libs/types";
import type { ReviewContext } from "../ado/intake";

async function git(repo: string, args: string[]): Promise<string> {
  const res = await run("git", ["-C", repo, ...args], 120_000);
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.trim()}`);
  return res.stdout;
}

/** File content at a ref, or empty when the path doesn't exist there (added/deleted). */
async function showFile(repo: string, ref: string, filePath: string): Promise<string[]> {
  const res = await run("git", ["-C", repo, "show", `${ref}:${filePath}`], 120_000);
  if (res.code !== 0) return [];
  return splitLines(Buffer.from(res.stdout, "utf8"));
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
      const parts = l.split("\t");
      return { status: parts[0] ?? "", path: parts[parts.length - 1] ?? "" };
    })
    .filter((e) => e.path);

  const skipped: Array<{ path: string; reason: string }> = [];
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

    const [rightLines, leftLines] = await Promise.all([
      showFile(opts.repo, opts.head, e.path),
      showFile(opts.repo, opts.base, e.path),
    ]);
    const { hunks, changedRightLines } = buildHunks(
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
      changeType,
      hunks,
      rightLines,
      leftLines,
      changedRightLines,
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

  const iteration = { id: 1, sourceRefCommit: "", targetRefCommit: "", commonRefCommit: "", createdDate: "" };
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
