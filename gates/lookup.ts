// One hop of context for a skeptic that could not check a finding, chosen by code.
//
// "insufficient-context" is an honest answer and the pipeline treats it as one: it neither
// kills nor clears. But most of those answers name the same missing piece — "I would need
// to see where `price` is set", "whether any caller passes null" — and that piece is usually
// one lookup away: the definition of a name on the accused line, or a few of its callers.
// scripts/calibrate.ts reports the unchecked rate per skeptic; this is what lowers it.
//
// The pipeline chooses what to show, never the model (CLAUDE.md: models are consulted at
// fixed points and never decide control flow). Names come from the accused lines; their
// definitions and callers are found first in the PR's changed files, already in memory,
// then — when there is a repository to search — with `git grep -w` at the commit under
// review, which needs no worktree. The caps are Kodus's: four callers per name, fifteen
// files, six thousand characters. What is found is fenced as the repository's text, because
// it is: a comment in a caller is as able to address the model as the diff is.
import { normalizePath } from "../libs/fileindex";
import { run } from "../libs/shell";
import { splitLines } from "../libs/text";
import type { FileDiff } from "../libs/types";
import { fenceUntrusted } from "../prompts/untrusted";

export interface LookupSource {
  /** The PR's changed files, searched first: already in memory. */
  files: readonly FileDiff[];
  /** A repository holding the commit under review, searched with `git grep` when set. */
  repo?: { dir: string; commit: string };
}

export interface Related {
  /** The names looked up, in the order they were chosen. */
  names: string[];
  /** Fenced, ready to append to a skeptic prompt. */
  text: string;
  /** The source lines shown, bare, so a refutation may quote them as evidence. */
  lines: string[];
  /** Distinct files the context came from. */
  files: number;
}

export const MAX_NAMES = 5;
export const MAX_CALLERS_PER_NAME = 4;
export const MAX_FILES = 15;
export const MAX_CHARS = 6000;
/** Lines of a definition shown: its first line and what follows, up to the end of its block. */
const DEFINITION_LINES = 12;
const GREP_TIMEOUT_MS = 20_000;

// Names that are never worth a lookup: keywords, and the few types every language has.
const KEYWORDS = new Set(
  (
    "abstract and as assert async await break case catch class const continue def default del delete do elif else " +
    "enum except export extends false final finally fn for from func function go if impl implements import in " +
    "instanceof interface is lambda let match mod new nil none not null of or override package pass private " +
    "protected pub public raise readonly return self static struct super switch this throw throws trait true try " +
    "type typeof undefined union unsafe use using val var void when where while with yield int long short byte " +
    "char float double boolean bool string str number any object list dict map set len print println console log"
  ).split(" "),
);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CONTROL = /^\s*(?:return|await|new|yield|throw|if|else|elif|while|for|case|when|assert|print|not|and|or)\b/;

/**
 * The names on the accused lines worth looking up: called functions first, then types, then
 * the rest, each once. A name the line merely mentions in a string is still a name — the
 * lookup that finds nothing costs one scan of memory.
 */
export function namesIn(lines: readonly string[]): string[] {
  const called: string[] = [];
  const types: string[] = [];
  const other: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    for (const m of line.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const name = m[0];
      if (name.length < 3 || KEYWORDS.has(name.toLowerCase()) || seen.has(name)) continue;
      seen.add(name);
      const after = line.slice((m.index ?? 0) + name.length);
      if (/^\s*\(/.test(after)) called.push(name);
      else if (/^[A-Z][a-z]/.test(name)) types.push(name);
      else other.push(name);
    }
  }
  return [...called, ...types, ...other].slice(0, MAX_NAMES);
}

/** Whether a line declares `name`: a function, a type, a field, a variable, an attribute. */
export function declares(line: string, name: string): boolean {
  if (CONTROL.test(line)) return false;
  const n = escape(name);
  const code = line.replace(/\s*(?:\/\/|#).*$/, "");
  return (
    // function foo / def foo / class Foo / val foo / let foo …
    new RegExp(`\\b(?:function|def|fn|func|fun|sub|class|interface|struct|enum|trait|record|type|module|object|val|var|let|const|final)\\s+(?:[\\w$<>,*&]+\\s+)?${n}\\b`).test(code) ||
    // Type foo(…) — a C-family signature, not a call statement
    (new RegExp(`^\\s*(?:[\\w$<>\\[\\],.?*&]+\\s+)+${n}\\s*\\(`).test(code) && !/;\s*$/.test(code)) ||
    // Type foo; / Type foo = … — a field or a typed local
    new RegExp(`^\\s*(?:[\\w$<>\\[\\],.?]+\\s+)+${n}\\s*(?:=(?!=)|;|,)`).test(code) ||
    // foo: Type (TypeScript members), this.foo = / self.foo = (attributes set in a constructor)
    new RegExp(`^\\s*(?:(?:private|public|protected|readonly|static|declare|abstract)\\s+)*${n}\\s*[?!]?\\s*:(?!:)`).test(code) ||
    new RegExp(`\\b(?:this|self)\\.${n}\\s*=(?!=)`).test(code) ||
    // const foo = … at the start of a line
    new RegExp(`^\\s*(?:export\\s+)?(?:(?:const|let|var|static|final)\\s+)+${n}\\s*(?::[^=]+)?=(?!=)`).test(code)
  );
}

const calls = (line: string, name: string) => new RegExp(`(?<![\\w$])${escape(name)}\\s*\\(`).test(line);

interface Hit {
  path: string;
  /** 1-based. */
  line: number;
  kind: "definition" | "call";
  name: string;
}

/** Where a definition's block ends: the first later line indented no deeper than it, closer included. */
function blockEnd(lines: readonly string[], start: number): number {
  const indent = (s: string) => s.length - s.trimStart().length;
  const base = indent(lines[start - 1] ?? "");
  for (let i = start; i < Math.min(lines.length, start - 1 + DEFINITION_LINES); i++) {
    const l = lines[i] ?? "";
    if (l.trim() === "") continue;
    if (indent(l) <= base) return /^\s*[}\])]/.test(l) || /^\s*end\b/.test(l) ? i + 1 : i;
  }
  return Math.min(lines.length, start - 1 + DEFINITION_LINES);
}

function hitsIn(path: string, lines: readonly string[], names: readonly string[]): Hit[] {
  const out: Hit[] = [];
  lines.forEach((text, i) => {
    for (const name of names) {
      if (!text.includes(name)) continue;
      if (declares(text, name)) out.push({ path, line: i + 1, kind: "definition", name });
      else if (calls(text, name)) out.push({ path, line: i + 1, kind: "call", name });
    }
  });
  return out;
}

/** Files `git grep` may hand over for reading, before the output caps pick what is shown. */
const MAX_CANDIDATE_FILES = 40;

/**
 * The repository's files that mention a name, read at the commit. `-l`, so a name used ten
 * thousand times costs ten thousand short lines rather than every matching line; then the
 * files most likely to DEFINE it first — its name in the file's name, the accused file's
 * directory — because git's own order is alphabetical, and alphabetical is not relevance.
 */
async function grepRepo(
  repo: { dir: string; commit: string },
  names: readonly string[],
  near: string,
  skip: ReadonlySet<string>,
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  const has = await run("git", ["-C", repo.dir, "cat-file", "-e", `${repo.commit}^{commit}`], GREP_TIMEOUT_MS);
  if (has.code !== 0) return found;
  const args = ["-C", repo.dir, "grep", "-l", "-F", "-w", "-I", ...names.flatMap((n) => ["-e", n]), repo.commit];
  const res = await run("git", args, GREP_TIMEOUT_MS);
  // 1 is "no match", not a failure; anything else, and a partial answer, is left alone.
  if (res.code !== 0) return found;
  const dir = near.includes("/") ? near.slice(0, near.lastIndexOf("/") + 1) : "";
  const rank = (p: string) => {
    const base = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
    if (names.some((n) => base.includes(n.toLowerCase()))) return 0;
    return dir && p.startsWith(dir) ? 1 : 2;
  };
  const paths = res.stdout
    .split("\n")
    .filter((l) => l.startsWith(`${repo.commit}:`))
    .map((l) => l.slice(repo.commit.length + 1))
    .filter((p) => p && !skip.has(normalizePath(p)))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .slice(0, MAX_CANDIDATE_FILES)
    .map((x) => x.p);
  for (const path of paths) {
    const show = await run("git", ["-C", repo.dir, "show", `${repo.commit}:${path}`], GREP_TIMEOUT_MS);
    if (show.code === 0) found.set(path, splitLines(Buffer.from(show.stdout)));
  }
  return found;
}

/**
 * The context for one accused span: definitions of the names on it and a few callers, from the
 * PR's files and then the repository, rendered and fenced. Undefined when nothing was found,
 * or when anything went wrong — a failed lookup changes nothing about the verdict it serves.
 */
export async function relatedContext(
  source: LookupSource,
  file: FileDiff,
  span: { side: "right" | "left"; startLine: number; endLine: number },
  // Lines around the span the skeptic already sees; a hit inside them adds nothing.
  shownRadius: number,
): Promise<Related | undefined> {
  try {
    const own = span.side === "right" ? file.rightLines : file.leftLines;
    const names = namesIn(own.slice(span.startLine - 1, span.endLine));
    if (names.length === 0) return undefined;
    const texts = new Map<string, readonly string[]>();
    for (const f of source.files) texts.set(normalizePath(f.path), f.rightLines);
    // The accused file on the side the skeptic reads, whatever the in-memory map says.
    texts.set(normalizePath(file.path), own);
    if (source.repo) {
      const repoFiles = await grepRepo(source.repo, names, normalizePath(file.path), new Set(texts.keys()));
      for (const [p, lines] of repoFiles) texts.set(normalizePath(p), lines);
    }
    const accused = normalizePath(file.path);
    const visible = (h: Hit) =>
      h.path === accused && h.line >= span.startLine - shownRadius && h.line <= span.endLine + shownRadius;
    const hits = [...texts.entries()].flatMap(([p, lines]) => hitsIn(p, lines, names)).filter((h) => !visible(h));
    // Definitions before callers, the PR's own files before the rest of the repository.
    const inPr = new Set(source.files.map((f) => normalizePath(f.path)));
    hits.sort(
      (a, b) =>
        (a.kind === "definition" ? 0 : 1) - (b.kind === "definition" ? 0 : 1) ||
        (inPr.has(a.path) ? 0 : 1) - (inPr.has(b.path) ? 0 : 1) ||
        names.indexOf(a.name) - names.indexOf(b.name),
    );

    const callers = new Map<string, number>();
    const files = new Set<string>();
    const blocks: string[] = [];
    const shown: string[] = [];
    const covered = new Map<string, Array<[number, number]>>();
    let chars = 0;
    for (const h of hits) {
      if (h.kind === "call") {
        if ((callers.get(h.name) ?? 0) >= MAX_CALLERS_PER_NAME) continue;
      }
      if (!files.has(h.path) && files.size >= MAX_FILES) continue;
      const lines = texts.get(h.path) ?? [];
      const from = h.kind === "definition" ? h.line : Math.max(1, h.line - 1);
      const to = h.kind === "definition" ? blockEnd(lines, h.line) : Math.min(lines.length, h.line + 1);
      const ranges = covered.get(h.path) ?? [];
      if (ranges.some(([a, b]) => from >= a && to <= b)) continue;
      const body: string[] = [];
      for (let l = from; l <= to; l++) body.push(`${String(l).padStart(5)} | ${lines[l - 1] ?? ""}`);
      const block = `### ${h.kind === "definition" ? "definition" : "a call"} of \`${h.name}\` — ${h.path}:${h.line}\n\`\`\`\n${body.join("\n")}\n\`\`\``;
      if (chars + block.length > MAX_CHARS) continue;
      chars += block.length;
      blocks.push(block);
      for (let l = from; l <= to; l++) shown.push(lines[l - 1] ?? "");
      ranges.push([from, to]);
      covered.set(h.path, ranges);
      files.add(h.path);
      if (h.kind === "call") callers.set(h.name, (callers.get(h.name) ?? 0) + 1);
    }
    if (blocks.length === 0) return undefined;
    const text =
      `## Code elsewhere, looked up by the pipeline for ${names.map((n) => `\`${n}\``).join(", ")}\n\n` +
      fenceUntrusted("related-code", "the reviewed repository", blocks.join("\n\n"));
    return { names, text, lines: shown, files: files.size };
  } catch {
    return undefined;
  }
}
