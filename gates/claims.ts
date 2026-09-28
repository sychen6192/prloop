// Claims a search can settle, settled by a search before a skeptic spends a call on them.
//
// A model that sees a diff cannot see the rest of the repository, and the commonest thing it
// gets wrong because of that is a fact about it: "X is never used" when a file it was not
// shown calls X, "X is not defined" when the file imports it, "the config file this reads
// does not exist" when it does. The skeptic cannot settle those either — it sees 25 lines —
// so they came back "insufficient-context" or, worse, "holds". Kodus has its finders declare
// a claimKind and settles it with one ripgrep; so does this, with one asymmetry: Kodus drops
// a finding whose lookup cannot run, and here that keeps it. Only a POSITIVE contradiction —
// the use, the definition, the file, found — drops a finding, and the evidence goes into
// skeptic.json as the refutation of a verifier named `claim-check`, where calibrate and the
// replay already read refutations.
import { enclosingScope } from "../libs/scope";
import type { FileIndex } from "../libs/fileindex";
import { normalizePath } from "../libs/fileindex";
import { log, logVerbose } from "../libs/log";
import { run } from "../libs/shell";
import type { AnchoredFinding } from "../libs/types";
import { codeOf, declares, grepRepo, imports, type LookupSource } from "./lookup";
import type { SkepticOutcome } from "./skeptic";

/** The verifier name a contradiction is recorded under. */
export const CLAIM_CHECKER = "claim-check";

export interface Contradiction {
  finding: AnchoredFinding;
  /** What the search found, in one sentence. */
  evidence: string;
  /** The line that contradicts the claim, as it is in the file. */
  quote: string;
}

// Languages where every file of a directory shares one namespace, so a definition in a
// sibling file answers "X is not defined" without an import.
const PACKAGE_SCOPED = new Set(["java", "go", "kotlin", "scala", "csharp", "fsharp", "vbnet", "swift", "dart"]);
// A scope that holds members rather than statements: a use of one of its members may be
// anywhere in the repository. Anything else that encloses a declaration is a function body.
const TYPE_SCOPE = /^(?:[\w@]+\s+)*?(?:class|interface|struct|enum|record|object|module|namespace|impl|trait|protocol|extension|type)\b/;
const GIT_TIMEOUT_MS = 20_000;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (line: string, name: string) => new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`).test(codeOf(line));
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const clip = (s: string) => {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > 160 ? `${t.slice(0, 160)}…` : t;
};

/** Where a function body that starts at `line` (1-based) ends: the next line indented no deeper. */
function bodyEnd(lines: readonly string[], line: number): number {
  const indent = (s: string) => s.length - s.trimStart().length;
  const base = indent(lines[line - 1] ?? "");
  for (let i = line; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l.trim() !== "" && indent(l) <= base) return i + 1;
  }
  return lines.length;
}

/** The PR's files, and — when there is a repository — the files at the commit that mention `name`. */
async function textsFor(source: LookupSource, name: string, near: string): Promise<Map<string, readonly string[]>> {
  const map = new Map<string, readonly string[]>();
  for (const f of source.files) map.set(normalizePath(f.path), f.rightLines);
  if (!source.repo) return map;
  const found = await grepRepo(source.repo, [name], near, new Set(map.keys()));
  for (const [p, lines] of found) map.set(normalizePath(p), lines);
  return map;
}

async function checkUnused(f: AnchoredFinding, name: string, index: FileIndex, source: LookupSource): Promise<Contradiction | undefined> {
  const file = index.exact(f.file);
  if (!file) return undefined;
  const accused = normalizePath(file.path);
  const lines = file.rightLines;
  // The declaration the claim is about: on the accused lines, else the nearest one above
  // them, else the first — a file may declare a local and a member of the same name.
  const from = f.anchor?.startLine ?? 1;
  const to = f.anchor?.endLine ?? from;
  const decls = lines.flatMap((l, i) => (declares(l, name) ? [i + 1] : []));
  const declLine = decls.find((n) => n >= from && n <= to) ?? [...decls].reverse().find((n) => n < from) ?? decls[0] ?? 0;
  // A local — declared inside a function body — can only be used inside that body; searching
  // the repository for its name would find every other variable that happens to share it.
  const scope = declLine > 0 ? enclosingScope(lines, declLine, file.language) : undefined;
  if (scope && !TYPE_SCOPE.test(scope.text)) {
    const end = bodyEnd(lines, scope.line);
    for (let i = scope.line; i < end; i++) {
      if (i + 1 === declLine) continue;
      const l = lines[i] ?? "";
      if (mentions(l, name) && !declares(l, name)) {
        return { finding: f, evidence: `\`${name}\` is used at ${accused}:${i + 1}, in the same function`, quote: l };
      }
    }
    return undefined;
  }
  const texts = await textsFor(source, name, accused);
  // An import of it elsewhere is a reference, and it would break if the name went away; a
  // line that uses it is better evidence, so an import is only the fallback.
  let imported: Contradiction | undefined;
  for (const [p, body] of texts) {
    for (let i = 0; i < body.length; i++) {
      const l = body[i] ?? "";
      if (!mentions(l, name) || declares(l, name)) continue;
      if (imports(l, name)) {
        if (p !== accused) imported ??= { finding: f, evidence: `\`${name}\` is imported at ${p}:${i + 1}`, quote: l };
        continue;
      }
      return { finding: f, evidence: `\`${name}\` is used at ${p}:${i + 1}`, quote: l };
    }
  }
  return imported;
}

async function checkUndefined(f: AnchoredFinding, name: string, index: FileIndex, source: LookupSource): Promise<Contradiction | undefined> {
  const file = index.exact(f.file);
  if (!file) return undefined;
  const accused = normalizePath(file.path);
  const own = file.rightLines;
  for (let i = 0; i < own.length; i++) {
    const l = own[i] ?? "";
    if (declares(l, name)) return { finding: f, evidence: `\`${name}\` is defined at ${accused}:${i + 1}`, quote: l };
    if (imports(l, name)) return { finding: f, evidence: `\`${name}\` is imported at ${accused}:${i + 1}`, quote: l };
  }
  // A sibling file of the same package defines it for the whole package, import or not.
  if (!PACKAGE_SCOPED.has(file.language)) return undefined;
  const dir = dirOf(accused);
  const texts = await textsFor(source, name, accused);
  for (const [p, body] of texts) {
    if (p === accused || dirOf(p) !== dir) continue;
    for (let i = 0; i < body.length; i++) {
      const l = body[i] ?? "";
      // Top-level or member declarations only: a local in a sibling file is not in scope here.
      if ((l.length - l.trimStart().length) <= 4 && declares(l, name)) {
        return { finding: f, evidence: `\`${name}\` is defined in the same package at ${p}:${i + 1}`, quote: l };
      }
    }
  }
  return undefined;
}

async function checkMissingFile(f: AnchoredFinding, target: string, index: FileIndex, source: LookupSource): Promise<Contradiction | undefined> {
  const file = index.exact(f.file);
  if (!file) return undefined;
  const accused = normalizePath(file.path);
  const dir = dirOf(accused);
  const join = (a: string, b: string) => {
    const parts = (a ? `${a}/${b}` : b).split("/");
    const out: string[] = [];
    for (const p of parts) {
      if (p === "" || p === ".") continue;
      if (p === "..") out.pop();
      else out.push(p);
    }
    return out.join("/");
  };
  const candidates = [...new Set([normalizePath(target), join(dir, target)])].filter(Boolean);
  for (const c of candidates) {
    if (source.files.some((x) => normalizePath(x.path) === c)) {
      return { finding: f, evidence: `\`${target}\` exists: ${c} is part of this change`, quote: c };
    }
  }
  if (!source.repo) return undefined;
  for (const c of candidates) {
    const res = await run("git", ["-C", source.repo.dir, "cat-file", "-e", `${source.repo.commit}:${c}`], GIT_TIMEOUT_MS);
    if (res.code === 0) return { finding: f, evidence: `\`${target}\` exists at the commit under review: ${c}`, quote: c };
  }
  return undefined;
}

async function checkDuplicate(f: AnchoredFinding, name: string, source: LookupSource): Promise<Contradiction | undefined> {
  // Only a search of everything can say something appears once; without the repository the
  // second definition may simply be in a file nobody looked at.
  if (!source.repo) return undefined;
  const has = await run("git", ["-C", source.repo.dir, "cat-file", "-e", `${source.repo.commit}^{commit}`], GIT_TIMEOUT_MS);
  if (has.code !== 0) return undefined;
  const res = await run("git", ["-C", source.repo.dir, "grep", "-c", "-F", "-w", "-e", name, source.repo.commit], GIT_TIMEOUT_MS);
  // 1 is "no match": the name is nowhere, which settles nothing about the finding.
  if (res.code !== 0) return undefined;
  const counts = res.stdout
    .split("\n")
    .map((l) => Number(l.slice(l.lastIndexOf(":") + 1)))
    .filter((n) => Number.isFinite(n) && n > 0);
  const total = counts.reduce((a, b) => a + b, 0);
  return total === 1
    ? { finding: f, evidence: `\`${name}\` appears exactly once in the repository at the commit under review`, quote: f.quote }
    : undefined;
}

/**
 * Settles every finding that declares a checkable claim. Returns the contradicted ones; the
 * rest — confirmed, unsettled, or unchecked because a lookup failed — go on to the skeptic
 * as they would have.
 */
export async function checkClaims(findings: readonly AnchoredFinding[], index: FileIndex, source: LookupSource): Promise<Contradiction[]> {
  const out: Contradiction[] = [];
  let checked = 0;
  for (const f of findings) {
    if (!f.claim_kind || !f.claim_subject) continue;
    checked++;
    let found: Contradiction | undefined;
    try {
      switch (f.claim_kind) {
        case "unused":
          found = await checkUnused(f, f.claim_subject, index, source);
          break;
        case "undefined":
          found = await checkUndefined(f, f.claim_subject, index, source);
          break;
        case "missing-file":
          found = await checkMissingFile(f, f.claim_subject, index, source);
          break;
        case "duplicate":
          found = await checkDuplicate(f, f.claim_subject, source);
          break;
      }
    } catch (e) {
      logVerbose(`claims: could not check ${f.file}:${f.anchor?.startLine} (${e instanceof Error ? e.message : String(e)}); kept`);
    }
    if (found) {
      out.push({ ...found, quote: clip(found.quote) });
      logVerbose(`  contradicted: ${f.file}:${f.anchor?.startLine} "${clip(f.claim)}" — ${found.evidence}`);
    }
  }
  if (checked > 0) {
    log(`claims: ${checked} checkable claim${checked === 1 ? "" : "s"} looked up, ${out.length} contradicted by the code and dropped before verification`);
  }
  return out;
}

/** A contradiction as a verifier's outcome: refuted, with the line that proves it. */
export function contradictionOutcome(c: Contradiction): SkepticOutcome {
  return {
    finding: c.finding,
    verdicts: [
      {
        verdict: "refuted",
        reason: c.evidence,
        evidenceQuote: c.quote,
        confidence: 1,
        model: CLAIM_CHECKER,
      },
    ],
    killed: true,
  };
}
