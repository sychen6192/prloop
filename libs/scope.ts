// The declaration a change sits in — its function, method or class — named after the `@@` of
// the hunk header, where `git diff` puts it.
//
// A finder sees six lines above a change and three below (PRR_HUNK_CONTEXT_BEFORE/AFTER), so a
// change in the middle of a forty-line method arrived without the method's name, its
// parameters or its class: `total += line.price` with nothing to say whose total, or that
// `line` is a parameter a caller can pass as null. PR-Agent puts the enclosing signature in
// every hunk header for this reason.
//
// Regexes over the file's own lines, per language, plus indentation: no parser and no new
// dependency. Walking up from the change, the first line indented LESS than everything
// passed so far that reads as a declaration is the scope; a less-indented line that does not
// (an `if`, a `for`) narrows the search and the walk goes on, so a change inside an `if`
// inside a method names the method. A wrong answer here is a misleading hint in a header,
// never a location — anchoring reads the quote, not this — so the rules prefer naming nothing
// to naming a sibling.
import type { FileDiff, Hunk } from "./types";

interface ScopeRules {
  /** A declaration, tested against the line with its indentation removed. */
  decl: RegExp;
  /** C-family: also `Type name(args) {`, a signature with no keyword in front of it. */
  signatures?: boolean;
}

const C_MODIFIERS = String.raw`(?:(?:export|default|declare|public|private|protected|internal|static|final|abstract|sealed|override|virtual|async|partial|readonly|unsafe|extern|inline|constexpr|explicit|friend|synchronized|native|strictfp)\s+)*`;
const C_FAMILY: ScopeRules = {
  decl: new RegExp(
    String.raw`^${C_MODIFIERS}(?:class|interface|enum|struct|record|namespace|module|trait|function|type\s+[\w$]+\s*(?:<[^>]*>)?\s*=)\b`,
  ),
  signatures: true,
};

const RULES: Record<string, ScopeRules> = {
  java: C_FAMILY,
  csharp: C_FAMILY,
  razor: C_FAMILY,
  c: C_FAMILY,
  cpp: C_FAMILY,
  objectivec: C_FAMILY,
  typescript: C_FAMILY,
  tsx: C_FAMILY,
  javascript: C_FAMILY,
  jsx: C_FAMILY,
  vue: C_FAMILY,
  svelte: C_FAMILY,
  dart: C_FAMILY,
  groovy: { decl: new RegExp(`${C_FAMILY.decl.source}|^def\\b`), signatures: true },
  python: { decl: /^(?:async\s+)?(?:def|class)\b/ },
  ruby: { decl: /^(?:def|class|module)\b/ },
  go: { decl: /^(?:func|type)\b/ },
  rust: {
    decl: /^(?:(?:pub(?:\([^)]*\))?|async|unsafe|const|default|extern(?:\s+"[^"]*")?)\s+)*(?:fn|impl|struct|enum|trait|mod|union)\b|^macro_rules!/,
  },
  php: { decl: /^(?:(?:abstract|final|public|private|protected|static|readonly)\s+)*(?:function|class|interface|trait|enum)\b/ },
  kotlin: {
    decl: /^(?:(?:public|private|protected|internal|open|abstract|override|final|data|sealed|inline|suspend|operator|infix|enum|annotation|companion|inner|value|tailrec|external)\s+)*(?:fun|class|object|interface|constructor|init)\b/,
  },
  swift: {
    decl: /^(?:(?:public|private|fileprivate|internal|open|static|final|override|mutating|convenience|required|class|@\w+)\s+)*(?:func|class|struct|enum|protocol|extension|init|deinit|actor)\b/,
  },
  scala: { decl: /^(?:(?:override|private|protected|final|sealed|abstract|implicit|lazy|case)\s+)*(?:def|class|object|trait)\b/ },
  fsharp: { decl: /^(?:let|member|type|module|and)\b/ },
  vbnet: {
    decl: /^(?:(?:Public|Private|Protected|Friend|Shared|Overrides|Overridable|MustOverride|Async|Partial|NotInheritable|MustInherit)\s+)*(?:Sub|Function|Class|Module|Structure|Interface|Property|Enum|Namespace)\b/i,
  },
  perl: { decl: /^(?:sub|package)\b/ },
  lua: { decl: /^(?:local\s+)?function\b/ },
  r: { decl: /<-\s*function\s*\(/ },
  shell: { decl: /^(?:function\s+[\w.:-]+|[\w.:-]+\s*\(\s*\))/ },
  powershell: { decl: /^(?:function|filter|class)\b/i },
  sql: { decl: /^create\s+(?:or\s+(?:replace|alter)\s+)?(?:function|procedure|proc|view|trigger|table|package)\b/i },
  hcl: { decl: /^(?:resource|data|module|variable|output|locals|provider|terraform)\b/ },
  protobuf: { decl: /^(?:message|service|enum|rpc|oneof)\b/ },
  graphql: { decl: /^(?:type|input|enum|interface|union|query|mutation|subscription|fragment|schema|extend)\b/ },
  makefile: { decl: /^[\w./%$()-]+\s*::?(?!=)/ },
};

// A statement that opens a block without declaring anything. Checked before the signature
// shape, which `if (x) {` and `foo(bar)` also have.
const NOT_A_SIGNATURE =
  /^(?:}\s*)?(?:if|else|for|foreach|while|do|switch|case|catch|try|finally|return|throw|new|await|yield|using|lock|synchronized(?=\s*\()|with|when|match|select|elif|except|loop|unless|until|defer|go|assert|print|echo)\b/;
// `Type name(args) {`, `name(args) {`, `Class::name(`, `name(` opening a parameter list — a
// name at the start or after whitespace-separated type tokens, never after a dot, so
// `obj.call(` is not one.
const SIGNATURE = /^(?:[\w$<>[\]?,.*&:~]+\s+)*?[A-Za-z_$~][\w$]*(?:::~?[A-Za-z_$][\w$]*)*\s*(?:<[^>()]*>)?\s*\(/;
// `const f = async (a) => {`, `handler = function () {`, a field holding a lambda.
const ASSIGNED_FUNCTION =
  /^(?:export\s+)?(?:(?:const|let|var|static|readonly|private|public|protected)\s+)*[\w$.]+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\(.*=>|[\w$]+\s*=>|\($)/;
// A callback body is a scope worth naming too: `describe("parser", () => {`, `app.get("/", (req, res) => {`.
const CALLBACK = /(?:=>|\bfunction\b)[^{}]*\{$/;

// Lines that are neither code at this level nor a declaration: they neither end the search
// nor narrow it. A lone `{` is the brace of an Allman-style declaration on the line above.
const SKIPPABLE = /^(?:$|\{$|\/\/|\/\*|\*|#|--|'|<!--)/;

const MAX_SCOPE_CHARS = 90;

function indentOf(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width++;
    else if (ch === "\t") width += 4;
    else break;
  }
  return width;
}

function isDeclaration(text: string, rules: ScopeRules): boolean {
  if (rules.decl.test(text)) return true;
  if (!rules.signatures) return false;
  const code = text.replace(/\s*\/\/.*$/, "");
  if (ASSIGNED_FUNCTION.test(code) || CALLBACK.test(code)) return true;
  if (NOT_A_SIGNATURE.test(code) || code.endsWith(";") || code.startsWith("@") || code.startsWith("[")) return false;
  const m = SIGNATURE.exec(code);
  // An assignment before the parenthesis is a call whose result is kept, not a declaration.
  return m !== null && !code.slice(0, m[0].length).includes("=");
}

/**
 * The declaration enclosing `lines[line - 1]` (1-based), as the trimmed text of its first
 * line, or undefined when there is none or the language has no rules here.
 */
export function enclosingScope(lines: readonly string[], line: number, language: string): { line: number; text: string } | undefined {
  const rules = RULES[language];
  if (!rules || line < 1 || line > lines.length) return undefined;
  // A blank changed line has no indentation of its own: take the next line that has some.
  let from = line - 1;
  while (from < lines.length && (lines[from] ?? "").trim() === "") from++;
  let threshold = from < lines.length ? indentOf(lines[from]!) : Number.POSITIVE_INFINITY;
  for (let i = Math.min(line, lines.length) - 2; i >= 0; i--) {
    const raw = lines[i]!;
    const text = raw.trim();
    if (SKIPPABLE.test(text)) continue;
    const indent = indentOf(raw);
    if (indent >= threshold) continue;
    if (isDeclaration(text, rules)) {
      const flat = text.replace(/\s+/g, " ");
      return { line: i + 1, text: flat.length > MAX_SCOPE_CHARS ? `${flat.slice(0, MAX_SCOPE_CHARS)}…` : flat };
    }
    threshold = indent;
    if (threshold === 0) return undefined;
  }
  return undefined;
}

/** Where a hunk's first change is: the new side's line, or the old side's for a pure deletion. */
function firstChange(h: Hunk): { side: "right" | "left"; line: number } | undefined {
  let left = h.leftStart;
  let right = h.rightStart;
  let firstDeleted: number | undefined;
  for (const l of h.body.split("\n")) {
    if (l.startsWith("+")) return { side: "right", line: right };
    if (l.startsWith("-")) {
      firstDeleted ??= left;
      left++;
    } else {
      left++;
      right++;
    }
  }
  return firstDeleted === undefined ? undefined : { side: "left", line: firstDeleted };
}

/**
 * The scope to name in a hunk's header: the declaration enclosing its first change, when that
 * declaration is above the lines the hunk shows. One the hunk already shows needs no name.
 */
export function hunkScope(f: FileDiff, h: Hunk): string | undefined {
  const at = firstChange(h);
  if (!at) return undefined;
  const lines = at.side === "right" ? f.rightLines : f.leftLines;
  const scope = enclosingScope(lines, at.line, f.language);
  const shownFrom = at.side === "right" ? h.rightStart : h.leftStart;
  return scope && scope.line < shownFrom ? scope.text : undefined;
}
