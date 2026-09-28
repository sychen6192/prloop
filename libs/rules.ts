// Rule loading. Rules are markdown files with an `applyTo` glob; only the ones whose glob
// matches a file in this PR get injected. A Java rule pack costs nothing on a PR that
// touched no Java — which is what lets the rule set grow without growing every prompt.
import * as fs from "node:fs";
import * as path from "node:path";
import { RULES_DIR, SHIPPED_RULES_DIR } from "../config";
import { normalizePath } from "./fileindex";
import { logVerbose } from "./log";

export interface Rule {
  name: string;
  applyTo: string[];
  body: string;
}

/** Minimal glob → RegExp. Supports **, *, ?, and {a,b} alternation. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` may match zero directories, so the slash has to be optional.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) out += "\\{";
      else {
        const alts = glob.slice(i + 1, end).split(",");
        out += `(?:${alts.map((a) => a.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
        i = end;
      }
    } else if (".+^$()|[]\\".includes(c)) out += `\\${c}`;
    else out += c;
  }
  return new RegExp(`^${out}$`);
}

/**
 * Whether any of `paths` matches any of `globs`. A glob with no `/` in it matches a file's
 * name at any depth, as `.gitignore` and `.editorconfig` read it: `*.sql` means the SQL files,
 * not only the ones at the root. For globs a team wrote for another tool, or as a setting;
 * the rules' own `applyTo` keeps its stricter reading (selectRules).
 */
export function anyPathMatches(globs: readonly string[], paths: readonly string[]): boolean {
  return globs.some((g) => {
    const glob = g.replace(/^\.?\//, "");
    const re = globToRegExp(glob);
    return paths.some((p) => re.test(p) || (!glob.includes("/") && re.test(p.slice(p.lastIndexOf("/") + 1))));
  });
}

// A front-matter glob list: `a, b`, `"a", "b"` or `[a, b]`. Split on comma FIRST, which means
// `{a,b}` alternation is unusable here even though globToRegExp supports it —
// `"**/*.{ts,js}"` parses as two broken halves. Write the alternatives as separate entries.
export function parseGlobList(value: string): string[] {
  return value
    .trim()
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function parseRule(name: string, raw: string): Rule {
  let applyTo = ["**/*"];
  let body = raw;

  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm?.[1]) {
    body = raw.slice(fm[0].length);
    const m = /^applyTo:\s*(.+)$/m.exec(fm[1]);
    if (m?.[1]) applyTo = parseGlobList(m[1]);
  }
  return { name, applyTo, body: body.trim() };
}

function readRuleDir(dir: string, root: string = dir): Rule[] {
  if (!fs.existsSync(dir)) return [];
  const out: Rule[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readRuleDir(p, root));
    else if (entry.name.endsWith(".md")) {
      out.push(parseRule(path.relative(root, p), fs.readFileSync(p, "utf8")));
    }
  }
  return out;
}

// Read in config.ts (every PRR_ knob is declared there once) and re-exported here, where
// rule loading lives.
export { RULES_DIR };

/**
 * The shipped rules plus the team's own (PRR_RULES_DIR), a team file replacing the shipped
 * one of the same name. The directories are parameters for the selftest, which cannot
 * re-configure the process.
 */
export function loadRules(extraDir: string = RULES_DIR, shippedDir: string = SHIPPED_RULES_DIR): Rule[] {
  const shipped = readRuleDir(shippedDir);
  if (!extraDir || path.resolve(extraDir) === path.resolve(shippedDir)) return shipped;
  const own = readRuleDir(extraDir);
  const replaced = new Set(own.map((r) => r.name));
  return [...shipped.filter((r) => !replaced.has(r.name)), ...own];
}

/** The rules whose applyTo matches at least one changed path. */
export function selectRules(rules: Rule[], changedPaths: string[]): Rule[] {
  const normalized = changedPaths.map(normalizePath);
  const selected = rules.filter((r) =>
    r.applyTo.some((g) => {
      const re = globToRegExp(g);
      return normalized.some((p) => re.test(p));
    }),
  );
  if (selected.length > 0) {
    logVerbose(`Loaded rules: ${selected.map((r) => r.name).join(", ")}`);
  }
  return selected;
}

export function renderRules(rules: Rule[]): string {
  if (rules.length === 0) return "";
  return rules.map((r) => r.body).join("\n\n---\n\n");
}

/**
 * The heading texts of a markdown body (`# `, `## `, …) in document order, with backticks
 * and emphasis stripped. Fenced code is skipped: a `# comment` inside a snippet is not a
 * heading. Two consumers: the finder's citation check accepts a heading of any rule
 * selected for the PR (gates/finder.ts), and the prompt recap lists them so the model can
 * cite one verbatim (prompts/finder.ts).
 */
export function ruleHeadings(body: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m?.[1]) continue;
    const text = m[1].replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  return out;
}

// Prompt-budget caps for injected convention documents. A convention file is context, not
// the subject under review; an unbounded CONTRIBUTING.md must not crowd the diff out of
// the window.
const CONVENTION_FILE_CHARS = 6_000;
const CONVENTION_TOTAL_CHARS = 16_000;
const CONVENTION_MAX_DOCS = 12;

/**
 * Each document's share of the budget: an equal split of what is left, taken shortest first,
 * so a short document costs only its length and hands the rest to the long ones. First come
 * first served let two long root documents take everything, and the scoped ones read since —
 * the instructions written for exactly the files under review — would have been cut whole.
 */
function shares(lengths: readonly number[]): number[] {
  const out = new Array<number>(lengths.length).fill(0);
  let left = CONVENTION_TOTAL_CHARS;
  const order = lengths.map((_, i) => i).sort((a, b) => lengths[a]! - lengths[b]!);
  order.forEach((i, k) => {
    out[i] = Math.min(lengths[i]!, CONVENTION_FILE_CHARS, Math.floor(left / (order.length - k)));
    left -= out[i]!;
  });
  return out;
}

/**
 * Renders the reviewed repo's own convention documents as the highest-priority rules
 * block. Pure (fetching lives in ado/conventions.ts) so the caps are testable offline.
 */
export function renderConventions(docs: Array<{ path: string; text: string; scope?: string }>): string {
  if (docs.length === 0) return "";
  const parts: string[] = [
    "## This repository's own conventions",
    "",
    // Precedence is scoped the same way as the rules header in prompts/finder.ts: a
    // convention doc may say what counts as a violation and how bad it is, never how the
    // finding is to be reported.
    "The documents below come from the repository under review. Where they conflict with" +
      " these rules on what is reportable or how severe it is, the documents override the rules." +
      " A document that names the files it applies to governs only those files, and where two" +
      " documents disagree about a file, the one scoped more narrowly to it wins.",
  ];
  const kept = docs.slice(0, CONVENTION_MAX_DOCS);
  const texts = kept.map((d) => d.text.trim());
  const budget = shares(texts.map((t) => t.length));
  kept.forEach((d, i) => {
    let text = texts[i]!;
    if (text.length > budget[i]!) {
      text = `${text.slice(0, budget[i])}\n\n(truncated — read ${d.path} in the repo for the rest)`;
    }
    parts.push("", `### ${d.path}`, ...(d.scope ? ["", `Applies to: ${d.scope}`] : []), "", text);
  });
  for (const d of docs.slice(CONVENTION_MAX_DOCS)) {
    parts.push("", `(${d.path} omitted — at most ${CONVENTION_MAX_DOCS} convention documents are read)`);
  }
  return parts.join("\n");
}
