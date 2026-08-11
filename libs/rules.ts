// Rule loading. Rules are markdown files with an `applyTo` glob; only the ones whose glob
// matches a file in this PR get injected. A Java rule pack costs nothing on a PR that
// touched no Java — which is what lets the rule set grow without growing every prompt.
import * as fs from "node:fs";
import * as path from "node:path";
import { PRLOOP_ROOT } from "../config";
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

function parseRule(name: string, raw: string): Rule {
  let applyTo = ["**/*"];
  let body = raw;

  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm?.[1]) {
    body = raw.slice(fm[0].length);
    const m = /^applyTo:\s*(.+)$/m.exec(fm[1]);
    if (m?.[1]) {
      // Split on comma FIRST, which means `{a,b}` alternation is unusable here even though
      // globToRegExp supports it — `"**/*.{ts,js}"` parses as two broken halves. Write the
      // alternatives as separate quoted entries instead.
      applyTo = m[1]
        .trim()
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
  }
  return { name, applyTo, body: body.trim() };
}

function readRuleDir(dir: string): Rule[] {
  if (!fs.existsSync(dir)) return [];
  const out: Rule[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readRuleDir(p));
    else if (entry.name.endsWith(".md")) {
      out.push(parseRule(path.relative(RULES_DIR, p), fs.readFileSync(p, "utf8")));
    }
  }
  return out;
}

export const RULES_DIR = process.env.PRR_RULES_DIR ?? path.join(PRLOOP_ROOT, "rules");

export function loadRules(): Rule[] {
  return readRuleDir(RULES_DIR);
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
