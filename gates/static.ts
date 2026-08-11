// Static-analysis gate.
//
// Requires a working tree: linters need files on disk, and prloop otherwise reads blobs
// straight from Azure DevOps. Point PRR_WORKDIR at a checkout of the source branch — in a
// pipeline that's just the agent's checkout. Without one this gate skips loudly rather than
// pretending it ran.
//
// Everything a tool reports is filtered to the PR's changed lines first (reviewdog's
// diff-filter): a pre-existing warning on an untouched line is not this PR's business, and
// posting it is the fastest way to get a review bot switched off.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MAX_TRIAGE_ITEMS,
  SEVERITIES,
  STATIC_TIMEOUT_MS,
  TRIAGE_CONTEXT_LINES,
  TRIAGE_MODEL,
  WORKDIR,
  excludedCategories,
  severityRank,
  type Severity,
} from "../config";
import { splitLines } from "../ado/blobs";
import { normalizePath, type FileIndex } from "../libs/fileindex";
import { parseJsonObject } from "../libs/json";
import { log, logVerbose } from "../libs/log";
import { commandExists, run } from "../libs/shell";
import { filesForProfile, selectProfiles } from "../profiles";
import { parseToolOutput } from "../profiles/parsers";
import type { Profile, ToolFinding, ToolSpec } from "../profiles/types";
import type { AnchoredFinding, FileDiff, ModelRunner } from "../libs/types";
import { TRIAGE_SCHEMA } from "../models/schemas";
import { TRIAGE_SYSTEM, buildTriagePrompt, type TriageItem } from "../prompts/triage";

export interface StaticResult {
  // Authoritative findings, ready to post without a model in the loop.
  facts: ToolFinding[];
  // High-false-positive findings awaiting LLM triage.
  needsTriage: ToolFinding[];
  // Style noise: counted, never commented.
  suppressedCount: number;
  ranTools: string[];
  skipped: Array<{ tool: string; reason: string }>;
  skippedReason?: string;
  // Changed files whose on-disk content is not the content under review, so no tool ran on
  // them. Reported, never analysed: their line numbers would not be this PR's line numbers.
  staleFiles: string[];
  // Tool findings whose reported path could not be resolved to any changed file. Counted
  // apart from the diff filter's `dropped`: "outside the changed region" and "path did not
  // resolve" are different facts, and only the second points at a coordinate problem.
  unresolved: number;
}

const EMPTY: StaticResult = {
  facts: [],
  needsTriage: [],
  suppressedCount: 0,
  ranTools: [],
  skipped: [],
  staleFiles: [],
  unresolved: 0,
};

/**
 * Whether the file on disk is byte-for-byte the content under review.
 *
 * Tool findings bypass quote anchoring — they carry line numbers straight from the linter,
 * and those numbers are then filtered against changedRightLines computed from ADO blobs. A
 * linter does not hallucinate a location, but it reports the location in the file IT read;
 * if PRR_WORKDIR sits on a different commit (behind the PR head, uncommitted edits, the
 * target branch) the two coordinate systems silently disagree and every tool comment lands
 * on the wrong line. This is the only guard on the one path that has no anchoring.
 *
 * Trailing CR is stripped on both sides: core.autocrlf checkouts differ from the blob in
 * line endings alone, which is not a content difference.
 */
export function matchesReviewedContent(absPath: string, rightLines: string[]): boolean {
  let onDisk: string[];
  try {
    onDisk = splitLines(fs.readFileSync(absPath));
  } catch {
    return false;
  }
  if (onDisk.length !== rightLines.length) return false;
  const bare = (s: string) => (s.endsWith("\r") ? s.slice(0, -1) : s);
  return onDisk.every((l, i) => bare(l) === bare(rightLines[i] ?? ""));
}

/**
 * Re-keys tool findings onto the diff's own paths, via the FileIndex (see CONTEXT.md).
 *
 * Not every tool reports a path rooted where the diff is: SpotBugs analyses bytecode and
 * reports the source path relative to the SOURCE ROOT ("com/acme/Foo.java") while the diff
 * says "src/main/java/com/acme/Foo.java", and a tool run in a Maven submodule reports
 * relative to that module. Resolution happens here, once, at the point the foreign path
 * enters the pipeline — every later lookup (diff filter, triage prompt, conversion) is an
 * exact hit on the re-keyed path. The previous shape resolved by suffix here but pushed
 * the finding with the tool's own string, which the exact-only lookups downstream then
 * silently dropped.
 */
export function rekeyToolFindings(
  findings: ToolFinding[],
  // Workdir-relative directory the tool ran in ("" at the root); its output coordinates
  // are relative to this, or to the tool's own idea of a source root.
  prefix: string,
  index: FileIndex,
): { kept: ToolFinding[]; misses: ToolFinding[] } {
  const kept: ToolFinding[] = [];
  const misses: ToolFinding[] = [];
  for (const f of findings) {
    const r = index.resolveTool(prefix, f.file);
    if (r.fd) kept.push({ ...f, file: r.fd.path });
    else misses.push(f);
  }
  return { kept, misses };
}

/** reviewdog's `added` filter mode: keep only findings on lines this PR changed. */
export function filterToChangedLines(
  findings: ToolFinding[],
  index: FileIndex,
): { kept: ToolFinding[]; dropped: number } {
  // Findings arrive re-keyed (rekeyToolFindings), so this is the index's exact lookup —
  // never a resolution tier.
  const kept: ToolFinding[] = [];
  let dropped = 0;
  for (const f of findings) {
    const fd = index.exact(f.file);
    if (!fd) {
      dropped++;
      continue;
    }
    const from = f.line;
    const to = f.endLine && f.endLine >= f.line ? f.endLine : f.line;
    let hit = false;
    for (let l = from; l <= to; l++) {
      if (fd.changedRightLines.has(l)) {
        hit = true;
        break;
      }
    }
    if (hit) kept.push(f);
    else dropped++;
  }
  return { kept, dropped };
}

const slash = (p: string) => p.replace(/\\/g, "/");

/** File contents, or "" when unreadable — a marker we cannot read simply does not match. */
function safeRead(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/**
 * The directories a tool should actually run in, with the targets that belong to each.
 *
 * `requires` used to be checked only at the workdir root, which assumed one project per
 * repository. A Playwright suite or any monorepo keeps its tsconfig.json in a subdirectory,
 * so the repo's only fact-tier tool was skipped on exactly the repos that have the most to
 * gain from it. Resolve the marker the way the tools themselves do — nearest ancestor of
 * the file, bounded by the workdir — and run once per distinct project.
 */
export function projectDirsFor(
  spec: ToolSpec,
  files: string[],
  workdir: string,
): Array<{ dir: string; files: string[] }> {
  const root = path.resolve(workdir);
  if (!spec.requires) return [{ dir: root, files }];

  const byDir = new Map<string, string[]>();
  for (const f of files) {
    let dir = path.dirname(path.resolve(root, f));
    for (;;) {
      const marker = path.join(dir, spec.requires);
      if (fs.existsSync(marker)) {
        // A marker that disqualifies the directory is not a match — keep walking up. A file
        // sitting directly under a Maven aggregator belongs to no analysable module, and
        // stopping here would run the tool somewhere it can only produce nothing.
        if (spec.skipProjectWhen?.test(safeRead(marker))) {
          const up = path.dirname(dir);
          if (dir === root || up === dir) break;
          dir = up;
          continue;
        }
        byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
        break;
      }
      const parent = path.dirname(dir);
      if (dir === root || parent === dir) break;
      dir = parent;
    }
  }
  return [...byDir].map(([dir, dirFiles]) => ({ dir, files: dirFiles }));
}

/**
 * The skip reason when a tool's own toolchain is broken, or undefined when it is healthy.
 *
 * Discards the WHOLE run, not just the environment errors: once module resolution fails,
 * every imported type degrades to an error and the remaining "type mismatches" are artefacts
 * of the same breakage, not defects. Filtering only the obvious ones would publish that
 * garbage wearing a clean face — and tsc is fact-tier, posted inline with no model in the
 * loop to catch it.
 *
 * Checked before ignoreRules on purpose: a broken toolchain must not be suppressible by a
 * profile's ignore list.
 */
export function environmentFailure(
  spec: ToolSpec,
  findings: ToolFinding[],
  where: string,
): string | undefined {
  const envRules = new Set(spec.environmentRules ?? []);
  const envMsg = spec.environmentMessages;
  if (envRules.size === 0 && !envMsg) return undefined;
  const hits = findings.filter((f) => envRules.has(f.ruleId) || envMsg?.test(f.message));
  if (hits.length === 0) return undefined;
  const codes = [...new Set(hits.map((f) => f.ruleId))].sort().join(", ");
  return (
    `toolchain not usable in ${where} (${codes}) — discarding all ${findings.length} ` +
    `${spec.name} findings, since unresolvable imports make the rest artefacts. Usually the ` +
    `dependencies are not installed: run your install command there. First: ` +
    `${hits[0]!.message.slice(0, 120)}`
  );
}

async function runTool(
  spec: ToolSpec,
  profile: Profile,
  files: string[],
  workdir: string,
  // Where the tool runs. Its own output is relative to this, not to the workdir.
  cwd: string,
  index: FileIndex,
): Promise<{ findings: ToolFinding[]; skipped?: string; unresolved: number }> {
  // Tool arguments and tool output both live in the project's coordinate system.
  const args = spec.args(files.map((f) => slash(path.relative(cwd, path.resolve(workdir, f)))));
  logVerbose(`static: ${spec.name} (in ${slash(path.relative(workdir, cwd)) || "."}) ${args.slice(0, 6).join(" ")}…`);

  // Remove a stale report before the run. Otherwise a tool that fails to produce one leaves
  // the previous build's file in place and we parse THAT — reporting fixed bugs against new
  // code, with nothing in the output to say so.
  const reportPath = spec.outputFile ? path.resolve(cwd, spec.outputFile) : undefined;
  if (reportPath) fs.rmSync(reportPath, { force: true });

  const res = await run(spec.bin, args, STATIC_TIMEOUT_MS, cwd);

  // Linters conventionally exit non-zero when they find something; that's not a failure.
  if (res.code !== 0 && !spec.allowNonZeroExit) {
    return { findings: [], skipped: `exit code ${res.code}: ${res.stderr.slice(0, 200)}`, unresolved: 0 };
  }

  let raw: string;
  if (reportPath) {
    if (!fs.existsSync(reportPath)) {
      // Not "no findings": the tool was asked to write a report and did not. Saying so beats
      // an empty result that reads exactly like a clean build.
      return {
        findings: [],
        skipped:
          `produced no ${spec.outputFile} in ${slash(path.relative(workdir, cwd)) || "."} ` +
          `(exit ${res.code})${res.stderr.trim() ? `: ${res.stderr.trim().slice(0, 160)}` : ""}`,
        unresolved: 0,
      };
    }
    raw = fs.readFileSync(reportPath, "utf8");
  } else {
    raw = spec.readStderr ? res.stderr : res.stdout || res.stderr;
  }
  // Parse in the tool's own coordinate system, check the toolchain is usable, then re-key
  // every finding onto the diff's paths — the one point where foreign tool paths enter.
  const parsed = parseToolOutput(raw, spec, cwd);

  const broken = environmentFailure(spec, parsed, slash(path.relative(workdir, cwd)) || ".");
  if (broken) return { findings: [], skipped: broken, unresolved: 0 };

  // Ignored rules go first: a finding the profile suppresses must not be able to inflate
  // the unresolved count below — that count points readers at a coordinate problem, and
  // config-suppressed output is not one.
  const ignored = new Set(profile.ignoreRules ?? []);
  const relevant = parsed.filter((f) => !ignored.has(f.ruleId));

  const prefix = slash(path.relative(workdir, cwd));
  const { kept, misses } = rekeyToolFindings(relevant, prefix, index);
  if (misses.length > 0) {
    logVerbose(
      `  ${spec.name}: ${misses.length} findings did not resolve to any changed file ` +
        `(e.g. ${misses[0]!.file})`,
    );
  }
  return { findings: kept, unresolved: misses.length };
}

export async function runStaticGate(
  files: FileDiff[],
  // The FileIndex built at intake — tool-reported paths are resolved through it, once, at
  // the point they enter (rekeyToolFindings).
  index: FileIndex,
  // The iteration's source commit, quoted back in the stale-checkout message. Naming the
  // exact SHA is the only provider-neutral instruction available: Azure DevOps publishes
  // refs/pull/<id>/merge but no /head ref, and the merge ref is the wrong target anyway —
  // it is source merged with target, which differs from the blobs under review on every
  // file the target branch also touched.
  sourceCommit?: string,
): Promise<StaticResult> {
  if (!WORKDIR) {
    return { ...EMPTY, skippedReason: "PRR_WORKDIR not set; static analysis needs a source working directory" };
  }
  if (!fs.existsSync(WORKDIR)) {
    return { ...EMPTY, skippedReason: `PRR_WORKDIR does not exist: ${WORKDIR}` };
  }

  // Intake guarantees canonical paths on FileDiff (no leading slash, forward separators),
  // so these are used as workdir-relative paths directly.
  const changedPaths = files.map((f) => f.path);
  const profiles = selectProfiles(changedPaths);
  if (profiles.length === 0) {
    return { ...EMPTY, skippedReason: "No language profile matches the changed files" };
  }

  const all: ToolFinding[] = [];
  const ranTools: string[] = [];
  const skipped: Array<{ tool: string; reason: string }> = [];
  let unresolved = 0;

  const stale: string[] = [];
  let analysable = 0;
  // Files prloop never read (binary, or past the blob size limit). Counted apart from stale
  // ones so the two are not confused: one is the checkout's problem, the other is not.
  let unreadable = 0;

  for (const profile of profiles) {
    const targets = filesForProfile(profile, changedPaths).filter((p) => {
      const abs = path.join(WORKDIR, p);
      if (!fs.existsSync(abs)) return false;
      analysable++;
      const fd = index.exact(p);
      // No FileDiff means the profile matched something outside the change set; nothing to
      // filter it against later anyway, so leave the existing behaviour alone.
      if (!fd) return true;

      // A file prloop could not fetch has no content to compare against — rightLines is
      // empty because the blob was binary or over the size limit, NOT because the checkout
      // is stale. Calling that a content mismatch accused the user's checkout of being wrong
      // when the truth was that prloop never read the file. It is still excluded: with no
      // hunks there are no changed lines, so any finding on it would be dropped downstream
      // regardless.
      if (fd.binary || fd.truncated) {
        unreadable++;
        return false;
      }
      if (!matchesReviewedContent(abs, fd.rightLines)) {
        stale.push(p);
        return false;
      }
      return true;
    });
    if (targets.length === 0) continue;

    // Tools within a profile are independent; run them together. A tool with a project
    // marker runs once per project it resolves to, so a monorepo gets each of its projects
    // checked instead of only whichever one happens to sit at the repo root.
    // Whether the binary exists is a property of the machine, not of a project, so it is
    // decided once per tool. Left inside runTool it fired once per resolved project, and a
    // missing spotbugs on a three-module Maven build reported the same line three times —
    // scaling with the repo's module count in the summary's Run notes.
    const installed = await Promise.all(profile.tools.map((s) => commandExists(s.bin)));

    // Several specs may share a name: one job, more than one way to invoke it (a standalone
    // binary, or the same analyser as a build-tool plugin). The first variant whose binary is
    // present wins and the rest are not run — a machine with both must not report everything
    // twice. Declaration order is the preference order.
    const results = await Promise.all(
      [...new Set(profile.tools.map((t) => t.name))].flatMap((name) => {
        const i = profile.tools.findIndex((t, k) => t.name === name && installed[k]);
        if (i < 0) {
          const variants = profile.tools.filter((t) => t.name === name);
          return [
            Promise.resolve({
              spec: variants[0]!,
              findings: [] as ToolFinding[],
              skipped: `${[...new Set(variants.map((v) => v.bin))].join(" or ")} not found on PATH`,
              unresolved: 0,
            }),
          ];
        }
        const spec = profile.tools[i]!;
        const projects = projectDirsFor(spec, targets, WORKDIR);
        if (projects.length === 0) {
          return [
            Promise.resolve({
              spec,
              findings: [] as ToolFinding[],
              skipped: `no ${spec.requires} found above any changed file`,
              unresolved: 0,
            }),
          ];
        }
        return projects.map(async (p) => ({
          spec,
          ...(await runTool(spec, profile, p.files, WORKDIR, p.dir, index)),
        }));
      }),
    );
    for (const r of results) {
      if (r.skipped) {
        skipped.push({ tool: r.spec.name, reason: r.skipped });
        continue;
      }
      ranTools.push(r.spec.name);
      all.push(...r.findings);
      unresolved += r.unresolved;
    }
  }

  // Every CHECKABLE file differing means the checkout is simply not this PR — a stale branch
  // or the wrong commit. Say that once, instead of listing every file in the change. Files
  // prloop never read are excluded from the denominator: they are not evidence either way,
  // and counting them was enough to stop this verdict from ever firing on a repo that
  // happens to contain one oversized file.
  const checkable = analysable - unreadable;
  if (checkable > 0 && stale.length === checkable) {
    return {
      ...EMPTY,
      staleFiles: stale,
      skippedReason:
        `PRR_WORKDIR does not contain the code under review: all ${stale.length} checkable ` +
        `files differ from iteration content` +
        (unreadable > 0 ? ` (${unreadable} more could not be read at all)` : "") +
        `. ` +
        (sourceCommit
          ? `Run \`git checkout ${sourceCommit}\` there`
          : `Check it out at the iteration's source commit`) +
        `, or clear PRR_WORKDIR to disable static analysis`,
    };
  }

  const { kept, dropped } = filterToChangedLines(all, index);
  const facts = kept.filter((f) => f.tier === "fact");
  const needsTriage = kept.filter((f) => f.tier === "triage");
  const suppressedCount = kept.filter((f) => f.tier === "suppress").length;

  // Worst-first so a triage budget spends on the findings that matter.
  const bySeverity = (a: ToolFinding, b: ToolFinding) =>
    severityRank(a.severity) - severityRank(b.severity);
  facts.sort(bySeverity);
  needsTriage.sort(bySeverity);

  log(
    `static: ran ${ranTools.length} tools → ${all.length} findings → ${kept.length} on changed lines` +
      ` (${facts.length} facts, ${needsTriage.length} to triage, ${suppressedCount} style), ` +
      `${dropped} filtered out as outside the changed region` +
      (unresolved > 0 ? `, ${unresolved} with paths that resolved to no changed file` : ""),
  );
  for (const s of skipped) logVerbose(`  skipped ${s.tool}: ${s.reason}`);
  if (stale.length > 0) {
    log(
      `[WARN] static: ${stale.length} files skipped, PRR_WORKDIR content differs from the ` +
        `iteration under review — check out ${sourceCommit ?? "the iteration's source commit"} ` +
        `there, and check for uncommitted changes or a build step that rewrites sources ` +
        `(${stale.slice(0, 5).join(", ")}${stale.length > 5 ? ", ..." : ""})`,
    );
  }
  if (unreadable > 0) {
    logVerbose(`static: ${unreadable} files not analysed, prloop could not read them (binary or over the size limit)`);
  }

  return { facts, needsTriage, suppressedCount, ranTools, skipped, staleFiles: stale, unresolved };
}

/**
 * LLM triage of the high-false-positive tier, then conversion of everything that survives
 * into review findings. Tool findings carry real line numbers already, so they bypass the
 * quote-anchoring path entirely — a linter does not hallucinate a location.
 */
export async function triageAndConvert(
  runner: ModelRunner,
  result: StaticResult,
  index: FileIndex,
): Promise<{ findings: AnchoredFinding[]; triaged: number; dropped: number; excluded: number }> {
  const kept: ToolFinding[] = [...result.facts];
  let dropped = 0;
  let triaged = 0;

  const batch = result.needsTriage.slice(0, MAX_TRIAGE_ITEMS);
  if (batch.length < result.needsTriage.length) {
    log(
      `static triage: ${result.needsTriage.length} awaiting verdict, over the cap — only the first ${batch.length} processed` +
        ` (the rest are not commented; raise PRR_MAX_TRIAGE_ITEMS or tighten the tool rules)`,
    );
  }

  if (batch.length > 0 && TRIAGE_MODEL) {
    const items: TriageItem[] = batch.map((f, i) => ({
      index: i,
      tool: f.tool,
      ruleId: f.ruleId,
      message: f.message,
      file: f.file,
      line: f.line,
      severity: f.severity,
    }));
    const res = await runner.chat({
      model: TRIAGE_MODEL,
      system: TRIAGE_SYSTEM,
      user: buildTriagePrompt(items, index, TRIAGE_CONTEXT_LINES),
      schema: TRIAGE_SCHEMA,
      schemaName: "triage",
    });

    if (res.error) {
      // Fail closed: an un-triaged high-FP finding is noise, so it does not get posted.
      log(`[WARN] static triage failed (${res.error}); ${batch.length} findings awaiting verdict will not be commented`);
      dropped += batch.length;
    } else {
      const parsed = parseJsonObject<{ results?: unknown }>(res.text);
      if (!parsed.ok) {
        log(`[WARN] static triage output unparseable (${parsed.error}); ${batch.length} findings will not be commented`);
        dropped += batch.length;
      } else {
        const verdicts = new Map<number, { keep: boolean; reason: string; severity?: Severity }>();
        for (const r of (Array.isArray(parsed.value.results) ? parsed.value.results : []) as unknown[]) {
          if (typeof r !== "object" || r === null) continue;
          const o = r as Record<string, unknown>;
          const idx = Number(o["index"]);
          if (!Number.isInteger(idx)) continue;
          const sev = typeof o["severity"] === "string" ? o["severity"].toLowerCase() : "";
          verdicts.set(idx, {
            keep: o["keep"] === true,
            reason: typeof o["reason"] === "string" ? o["reason"] : "",
            severity: (SEVERITIES as readonly string[]).includes(sev) ? (sev as Severity) : undefined,
          });
        }
        batch.forEach((f, i) => {
          const v = verdicts.get(i);
          // No verdict means the model skipped it; treat that as "not justified".
          if (!v?.keep) {
            dropped++;
            return;
          }
          triaged++;
          // Same rule as the skeptic: a verifying model may lower severity, never raise
          // it. The tool's own rating owns the ceiling.
          const sev =
            v.severity !== undefined && severityRank(v.severity) > severityRank(f.severity)
              ? v.severity
              : f.severity;
          kept.push({ ...f, severity: sev, message: v.reason || f.message });
        });
        log(`static triage: ${batch.length} awaiting verdict → kept ${triaged}, filtered out ${batch.length - triaged}`);
      }
    }
  } else if (batch.length > 0) {
    log(`[WARN] PRR_TRIAGE_MODEL not set; ${batch.length} high-false-positive findings will not be commented`);
    dropped += batch.length;
  }

  // Same exclusion rule the model findings get in aggregate: a category the config turned
  // off is off for tools too, and the drop is counted rather than silent.
  const excludedCats = new Set(excludedCategories());
  let excluded = 0;

  const findings: AnchoredFinding[] = [];
  for (const f of kept) {
    const fd = index.exact(f.file);
    if (!fd) {
      // Impossible by construction — findings were re-keyed onto diff paths at entry
      // (rekeyToolFindings) — so a miss here is a coordinate bug worth hearing about.
      logVerbose(`static: dropping ${f.tool} finding with unmatched path ${f.file} (should be re-keyed)`);
      continue;
    }
    const category = categoryForRule(f);
    if (excludedCats.has(category)) {
      excluded++;
      continue;
    }
    const lineText = fd.rightLines[f.line - 1] ?? "";
    findings.push({
      category,
      severity: f.severity,
      confidence: f.tier === "fact" ? 1 : 0.8,
      file: fd.path,
      quote: lineText,
      side: "right",
      claim: `${f.message}`,
      evidence: `Reported by ${f.tool}${f.ruleId ? ` (rule ${f.ruleId})` : ""}${f.helpUri ? `\n${f.helpUri}` : ""}`,
      // A deterministic tool is its own corroboration: it doesn't guess, so it doesn't
      // need a second model to agree before we believe the location exists.
      sources: [f.tool],
      skepticVerdicts: 1,
      skepticRefuted: 0,
      fingerprint: createHash("sha1")
        .update(`tool ${f.tool} ${f.ruleId} ${f.file} ${lineText.trim()}`)
        .digest("hex")
        .slice(0, 12),
      anchor: {
        side: "right",
        startLine: f.line,
        endLine: f.endLine && f.endLine >= f.line ? f.endLine : f.line,
        startOffset: 1,
        endOffset: Math.max(lineText.replace(/\r$/, "").length + 1, 1),
      },
    });
  }
  if (excluded > 0) {
    log(`static: ${excluded} tool findings dropped, category excluded by config (${[...excludedCats].join(", ")})`);
  }
  return { findings, triaged, dropped, excluded };
}

// Maps a tool rule to a review category so tool findings sit in the same taxonomy as
// model findings and dedupe against them.
function categoryForRule(f: ToolFinding): string {
  const id = f.ruleId.toUpperCase();
  const msg = f.message.toLowerCase();
  if (f.tool === "bandit" || id.startsWith("S") || /injection|xss|csrf|secret|password|crypto/.test(msg)) {
    return "security";
  }
  if (f.tool === "mypy" || f.tool === "tsc") return "correctness";
  if (/thread|concurren|synchroniz|atomic|race/.test(msg)) return "concurrency";
  if (/close|leak|resource|stream/.test(msg)) return "reliability";
  if (/performance|inefficient|complexity/.test(msg)) return "performance";
  return "maintainability";
}
