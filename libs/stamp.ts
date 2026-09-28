// What produced a run: which prloop, which prompts, which rules, which models, which settings.
//
// result.json carried the package version and nothing else, and the version has said 0.1.0
// since the first commit. So "did the prompt change help?" had no answer: two weeks of runs
// before and after an edit to prompts/finder.ts were indistinguishable on disk, and
// scripts/calibrate.ts pooled them into one dismissal rate — the average of the thing being
// compared with the thing it was being compared against.
//
// Hashes rather than copies: the prompts and rules are already in every run's prompt files,
// and what a report needs is only whether two runs used the same ones.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FINDER_MODELS,
  KNOWN_KEYS,
  PRLOOP_ROOT,
  REQ_MODEL,
  SKEPTIC_MODELS,
  SKEPTIC_ROUNDS,
  TRIAGE_MODEL,
  configReport,
} from "../config";
import { loadRules } from "./rules";
import { run } from "./shell";
import { PRLOOP_VERSION } from "./artifacts";

export interface RunStamp {
  version: string;
  /** prloop's own commit, when it runs from a git checkout. */
  commit?: string;
  /** Uncommitted changes to tracked files in that checkout: the commit is not the whole story. */
  dirty?: boolean;
  /** 12-hex content hashes; equal hashes mean the same prompts, rules, fleet and settings. */
  hashes: { prompts: string; rules: string; models: string; config: string };
}

const hash12 = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);

/** The files every prompt is built from, and the opencode agent's own instructions. */
function promptSources(root: string): string {
  const parts: string[] = [];
  for (const dir of ["prompts", "agents"]) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith(".ts") || n.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const n of names) parts.push(`${dir}/${n}\n${fs.readFileSync(path.join(root, dir, n), "utf8")}`);
  }
  return parts.join("\n\u0000\n");
}

// The settings that change what a review says. Connection, network and diagnostics knobs do
// not, and hashing them would split identical reviews into different groups because one ran
// on a laptop and one in a pipeline.
const NOT_REVIEW_SETTINGS = new Set(["Azure DevOps", "Corporate network", "Diagnostics"]);

/** Content hashes of what shapes a review. Pure over its inputs, for the selftest. */
export function stampHashes(input: {
  promptSources: string;
  rules: ReadonlyArray<{ name: string; body: string }>;
  models: unknown;
  settings: ReadonlyArray<{ name: string; value: string }>;
}): RunStamp["hashes"] {
  return {
    prompts: hash12(input.promptSources),
    rules: hash12(
      [...input.rules]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => `${r.name}\n${r.body}`)
        .join("\n\u0000\n"),
    ),
    models: hash12(JSON.stringify(input.models)),
    config: hash12(
      [...input.settings]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => `${s.name}=${s.value}`)
        .join("\n"),
    ),
  };
}

let cached: Promise<RunStamp> | undefined;

/** This process's stamp, computed once: nothing it hashes changes while a process runs. */
export function runStamp(): Promise<RunStamp> {
  cached ??= (async () => {
    const key = new Map(KNOWN_KEYS.map((k) => [k.name, k]));
    const settings = configReport()
      .filter((e) => !key.get(e.name)?.secret && !NOT_REVIEW_SETTINGS.has(key.get(e.name)?.section ?? ""))
      .map((e) => ({ name: e.name, value: e.value }));
    const hashes = stampHashes({
      promptSources: promptSources(PRLOOP_ROOT),
      rules: loadRules(),
      models: { finders: FINDER_MODELS, skeptics: SKEPTIC_MODELS, rounds: SKEPTIC_ROUNDS, req: REQ_MODEL, triage: TRIAGE_MODEL },
      settings,
    });
    // Best effort, and bounded: a stamp without a commit is still a stamp, and a checkout
    // that is not a git repository (a copied tree, an unpacked tarball) is a normal way to run.
    const head = await run("git", ["-C", PRLOOP_ROOT, "rev-parse", "HEAD"], 10_000).catch(() => undefined);
    const commit = head && head.code === 0 ? head.stdout.trim() : undefined;
    const status = commit
      ? await run("git", ["-C", PRLOOP_ROOT, "status", "--porcelain", "--untracked-files=no"], 10_000).catch(() => undefined)
      : undefined;
    return {
      version: PRLOOP_VERSION,
      ...(commit ? { commit } : {}),
      ...(status && status.code === 0 ? { dirty: status.stdout.trim() !== "" } : {}),
      hashes,
    };
  })();
  return cached;
}

/** A short, stable label for grouping runs in a report: commit plus the four hashes. */
export function stampLabel(stamp: Partial<RunStamp> | undefined): string {
  if (!stamp?.hashes) return "(unstamped)";
  const h = stamp.hashes;
  const commit = stamp.commit ? `${stamp.commit.slice(0, 7)}${stamp.dirty ? "+" : ""} ` : "";
  return `${commit}p:${h.prompts.slice(0, 6)} r:${h.rules.slice(0, 6)} m:${h.models.slice(0, 6)} c:${h.config.slice(0, 6)}`;
}
