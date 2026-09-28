// Which of the reviewed repository's own instruction files apply to a change, whatever reads
// them: Azure DevOps (ado/conventions.ts) or a local clone (git/intake.ts).
//
// Six fixed root files used to be the whole list, while teams write their instructions for
// the tools they already run: `.github/copilot-instructions.md` and path-scoped
// `*.instructions.md` for Copilot, `.cursor/rules/*.mdc` for Cursor, and an `AGENTS.md` or
// `CLAUDE.md` in the directory a package lives in. A team that had written its standards once,
// for Copilot, had them ignored here. Each kind is read the way its own tool reads it, scope
// included: an instructions file applies to the files its `applyTo` matches, a Cursor rule
// when it always applies or its `globs` match, and a nested `AGENTS.md` to the files beneath
// it — as the Anthropic review plugin scopes `CLAUDE.md`. A file whose scope matches nothing
// the change touched is not read into the prompt at all.
import { normalizePath } from "./fileindex";
import { globToRegExp, parseGlobList } from "./rules";

/** Documents that apply to the whole repository, read in this order. */
export const CONVENTION_PATHS = [
  "/CONTRIBUTING.md",
  "/CODING_STANDARDS.md",
  "/docs/CONTRIBUTING.md",
  "/docs/CODING_STANDARDS.md",
  "/CLAUDE.md",
  "/AGENTS.md",
  "/.github/copilot-instructions.md",
  "/.cursorrules",
] as const;

// Directories of instruction files that each carry their own scope in front matter.
const SCOPED_DIRS = [
  { dir: "/.github/instructions", suffix: ".instructions.md", kind: "copilot" },
  { dir: "/.azuredevops/instructions", suffix: ".instructions.md", kind: "copilot" },
  { dir: "/.cursor/rules", suffix: ".mdc", kind: "cursor" },
] as const;
// Read beside the changed files, in every directory above one up to the root.
const NESTED_NAMES = ["AGENTS.md", "CLAUDE.md"];
// A pull request across a monorepo has many directories; the shallowest cover the most files.
const MAX_NESTED_DIRS = 30;
// Every scoped file has to be read to learn its scope, so a directory of hundreds is capped.
const MAX_SCOPED_FILES = 50;

export interface ConventionDoc {
  path: string;
  text: string;
  /** The files it governs, when that is not the whole repository, worded for the reader. */
  scope?: string;
}

/** How a host reads the repository at the commit whose instructions bind the change. */
export interface ConventionReader {
  /** The file's text, or undefined when there is none. A real failure throws. */
  read(path: string): Promise<string | undefined>;
  /** The files under `dir`, at every depth when `deep`, or [] when there is no such directory. */
  list(dir: string, deep: boolean): Promise<string[]>;
}

/** `key: value` front matter, with `key:` followed by `- item` lines read as a list. */
export function frontMatter(raw: string): { fields: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!m?.[1]) return { fields: {}, body: raw };
  const fields: Record<string, string> = {};
  let listKey: string | undefined;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item && listKey) {
      fields[listKey] = [fields[listKey], item[1]!.trim()].filter(Boolean).join(",");
      continue;
    }
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    listKey = kv[1]!;
    fields[listKey] = kv[2]!.trim();
  }
  return { fields, body: raw.slice(m[0].length) };
}

/**
 * Whether any changed path matches one of `globs`. A glob with no `/` in it matches a file's
 * name at any depth, as `.gitignore` and `.editorconfig` read it: `*.py` in a Cursor rule means
 * the Python files, not only the ones at the root.
 */
function matchesAny(globs: readonly string[], paths: readonly string[]): boolean {
  return globs.some((g) => {
    const glob = g.replace(/^\.?\//, "");
    const re = globToRegExp(glob);
    return paths.some((p) => re.test(p) || (!glob.includes("/") && re.test(p.slice(p.lastIndexOf("/") + 1))));
  });
}

/** A scoped instruction file, read the way its own tool reads it; undefined when it does not apply. */
function scopedDoc(path: string, raw: string, kind: "copilot" | "cursor", paths: readonly string[]): ConventionDoc | undefined {
  const { fields, body } = frontMatter(raw);
  const text = body.trim();
  if (!text) return undefined;
  if (kind === "copilot") {
    // Copilot applies an instructions file only through its applyTo, and a file may opt out
    // of code review by name.
    if (/code-review/.test(fields["excludeAgent"] ?? "")) return undefined;
    const globs = parseGlobList(fields["applyTo"] ?? "");
    return globs.length > 0 && matchesAny(globs, paths) ? { path, text, scope: globs.join(", ") } : undefined;
  }
  // Cursor: an always-applied rule, or one attached by its globs. A rule with neither is
  // requested by an agent's own judgment or by hand, and no agent here chooses.
  if (/^["']?true["']?$/i.test(fields["alwaysApply"] ?? "")) return { path, text };
  const globs = parseGlobList(fields["globs"] ?? "");
  return globs.length > 0 && matchesAny(globs, paths) ? { path, text, scope: globs.join(", ") } : undefined;
}

/** The directories above the changed files, the root excluded, shallowest first. */
function ancestorDirs(paths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

/**
 * Every instruction document that applies to a change touching `changedPaths`: the root
 * documents, the scoped ones whose scope matches a changed file, and the nested `AGENTS.md` /
 * `CLAUDE.md` above one. Ordered from the whole repository to the narrowest scope. A file that
 * cannot be read is named in `failures` and the rest are still gathered; `tried` counts what
 * was asked for. With no changed paths only the root documents are read — nothing else can
 * apply to nothing.
 */
export async function gatherConventions(
  reader: ConventionReader,
  changedPaths: readonly string[],
): Promise<{ docs: ConventionDoc[]; failures: string[]; tried: number }> {
  const paths = changedPaths.map(normalizePath);
  const failures: string[] = [];
  let tried = 0;
  const attempt = async <T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    tried++;
    try {
      return await fn();
    } catch (err) {
      failures.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  };
  const root = await Promise.all(CONVENTION_PATHS.map((p) => attempt(p, () => reader.read(p), undefined)));
  const docs: ConventionDoc[] = CONVENTION_PATHS.flatMap((p, i) => {
    const text = root[i];
    return text?.trim() ? [{ path: p, text }] : [];
  });
  if (paths.length === 0) return { docs, failures, tried };

  const scoped: ConventionDoc[] = [];
  const always: ConventionDoc[] = [];
  for (const s of SCOPED_DIRS) {
    const listed = await attempt(s.dir, () => reader.list(s.dir, true), [] as string[]);
    const files = listed.filter((p) => p.endsWith(s.suffix)).sort().slice(0, MAX_SCOPED_FILES);
    const texts = await Promise.all(files.map((p) => attempt(p, () => reader.read(p), undefined)));
    files.forEach((p, i) => {
      const raw = texts[i];
      const doc = raw === undefined ? undefined : scopedDoc(p, raw, s.kind, paths);
      if (doc) (doc.scope === undefined ? always : scoped).push(doc);
    });
  }

  const nested: ConventionDoc[] = [];
  const dirs = ancestorDirs(paths).slice(0, MAX_NESTED_DIRS);
  const listings = await Promise.all(dirs.map((d) => attempt(`/${d}`, () => reader.list(`/${d}`, false), [] as string[])));
  for (const [i, d] of dirs.entries()) {
    const present = new Set((listings[i] ?? []).map((p) => p.slice(p.lastIndexOf("/") + 1)));
    for (const name of NESTED_NAMES.filter((n) => present.has(n))) {
      const p = `/${d}/${name}`;
      const text = await attempt(p, () => reader.read(p), undefined);
      if (text?.trim()) nested.push({ path: p, text, scope: `files under ${d}/` });
    }
  }
  return { docs: [...docs, ...always, ...scoped, ...nested], failures, tried };
}
