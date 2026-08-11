// FileIndex: the one resolver from a foreign path string — model-quoted or tool-reported —
// to a FileDiff in the change set (see CONTEXT.md).
//
// Three resolution policies used to coexist (a 5-tier one in anchoring, a 2-tier one in the
// static gate, exact-only lookups everywhere else), and the seams between them dropped
// findings: a suffix-resolved tool finding kept the tool's own path string, which the
// exact-only lookups one function later could not find. Resolution now happens once, at the
// point a foreign path enters the pipeline, and the finding is re-keyed onto the resolved
// FileDiff.path — everything downstream looks up by exact path.
//
// Every tier is unique-match-or-nothing: an ambiguous path is a refusal, never a guess.
import type { FileDiff } from "./types";

/**
 * Canonical path shape: forward slashes, no leading slash. Both intakes guarantee it for
 * FileDiff.path at construction; foreign strings (model output, tool output, ADO thread
 * contexts) are normalized here before any comparison. This function is the only owner of
 * that rule — no caller re-implements the strip.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

export type ResolveResult =
  | { fd: FileDiff; failure?: undefined; detail?: undefined }
  | { fd?: undefined; failure: "not-found" | "ambiguous"; detail: string };

export class FileIndex {
  // Precomputed canonical keys; FileDiff.path is already canonical from intake, but the
  // index normalizes its own keys so directly-constructed fixtures behave identically.
  private readonly entries: Array<{ key: string; fd: FileDiff }>;
  private readonly byPath = new Map<string, FileDiff>();

  constructor(files: FileDiff[]) {
    this.entries = files.map((fd) => ({ key: normalizePath(fd.path), fd }));
    for (const e of this.entries) this.byPath.set(e.key, e.fd);
  }

  /**
   * Resolve a foreign path. Tiers, tried in order, each accepting only a unique hit:
   * exact → case-insensitive → suffix → basename → originalPath (renames are often cited
   * by their old name). A tier with multiple hits falls through — a stricter tier's
   * ambiguity must not shadow a looser tier's unique match — and if nothing ends up
   * unique, the first ambiguity is what the failure reports.
   */
  resolve(rawPath: string): ResolveResult {
    const want = normalizePath(rawPath);
    if (!want) return { failure: "not-found", detail: "finding carries no file path" };

    const exact = this.byPath.get(want);
    if (exact) return { fd: exact };

    let ambiguous: { tier: string; count: number } | undefined;
    const unique = (hits: Array<{ key: string; fd: FileDiff }>, tier: string): FileDiff | undefined => {
      if (hits.length === 1) return hits[0]!.fd;
      if (hits.length > 1 && !ambiguous) ambiguous = { tier, count: hits.length };
      return undefined;
    };

    const lower = want.toLowerCase();
    const ci = unique(this.entries.filter((e) => e.key.toLowerCase() === lower), "case-insensitive");
    if (ci) return { fd: ci };

    // Models and bytecode-analysing tools routinely shorten a path to its last segments;
    // accept only when one changed file ends that way.
    const suffix = unique(this.entries.filter((e) => e.key.endsWith(`/${want}`)), "suffix");
    if (suffix) return { fd: suffix };

    const base = want.split("/").pop() ?? want;
    const byName = unique(
      this.entries.filter((e) => (e.key.split("/").pop() ?? "") === base),
      "basename",
    );
    if (byName) return { fd: byName };

    const byOld = unique(
      this.entries.filter((e) => e.fd.originalPath && normalizePath(e.fd.originalPath) === want),
      "original path",
    );
    if (byOld) return { fd: byOld };

    if (ambiguous) {
      return {
        failure: "ambiguous",
        detail: `path "${rawPath}" matches ${ambiguous.count} changed files (${ambiguous.tier} match); refusing to guess`,
      };
    }
    return { failure: "not-found", detail: `file "${rawPath}" is not in this change set` };
  }

  /**
   * Resolve a static tool's reported path. The tool ran in a project directory (`prefix`,
   * workdir-relative, "" at the root) and its output is relative to *something* — the
   * project dir for most linters, the source root for bytecode analysers like SpotBugs.
   * Try the prefixed form as an exact hit first (the fast path when the tool's own
   * coordinates line up), then fall back to the full tiers on the raw path, where the
   * suffix tier catches the source-root case. Blindly concatenating the prefix and then
   * suffix-matching — the previous behaviour — could never match a Maven submodule:
   * "svc" + "com/acme/Svc.java" is not a suffix of "svc/src/main/java/com/acme/Svc.java".
   */
  resolveTool(prefix: string, rawPath: string): ResolveResult {
    const p = normalizePath(prefix);
    if (p) {
      const exact = this.byPath.get(normalizePath(`${p}/${normalizePath(rawPath)}`));
      if (exact) return { fd: exact };
    }
    return this.resolve(rawPath);
  }
}
