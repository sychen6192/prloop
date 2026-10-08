// OpenSpec (openspec/changes/<id>/{proposal,design,tasks}.md and specs/<cap>/spec.md) is
// how a growing number of teams write down a change before they make it. Those files say
// what the author intends to build. Read as diff by the requirement axis, they were also
// read as proof that it was built: a ticked "- [x] 1.2 Lock the account after five failed
// codes" in tasks.md anchored as evidence and closed a criterion the code never met.
//
// The spec deltas are also the one place such a team states, requirement by requirement and
// with scenarios, what the change is meant to do — so they are judged too, as advisory
// requirements of their own (gates/requirement.ts). Same philosophy as libs/criteria.ts: the
// pipeline fixes the unit of judgment HERE, deterministically, and the model only judges it.
import type { CriterionRef } from "./criteria";
import { fileKind } from "./lang";
import type { FileDiff, OpenSpecDeltaInfo, SpecOrigin } from "./types";

/**
 * A changed text file under a directory named openspec/ (monorepos nest it): a proposal,
 * design, task list or spec. It says what the author intends to build, never that it was
 * built. Lower-case only, as the OpenSpec CLI writes it; a code file under openspec/ stays code.
 */
export function isOpenSpecDoc(path: string): boolean {
  return /(?:^|\/)openspec\//.test(path) && fileKind(path) === "text";
}

// Prompt-budget caps, not settings: the spec is context for one requirement-sized call, and
// an author's 40-requirement delta must not crowd the code it is judged against out of it.
export const OPENSPEC_LIMITS = {
  requirements: 20,
  requirementChars: 1500,
  totalChars: 16_000,
  problemsPerDelta: 5,
  nameChars: 200,
} as const;

export type OpenSpecLimits = { readonly [K in keyof typeof OPENSPEC_LIMITS]: number };

const SPEC_DELTA = /^(?:.*\/)?openspec\/changes\/([^/]+)\/specs\/(.+)\/spec\.md$/;

/** An active change's spec delta: not the baseline openspec/specs/**, not an archived change. */
export function specDeltaOf(path: string): { change: string; capability: string } | undefined {
  const m = SPEC_DELTA.exec(path);
  // An archived change was delivered already; its deltas are history, not this PR's intent.
  if (!m || m[1] === "archive") return undefined;
  return { change: m[1]!, capability: m[2]! };
}

export interface SpecScenario {
  name: string;
  steps: string[];
}

export interface SpecRequirement {
  op: "ADDED" | "MODIFIED";
  // 1-based among this file's ADDED and MODIFIED requirements, touched or not, so an id stays
  // the same when the requirements around it are skipped as unchanged.
  ordinal: number;
  name: string;
  statement: string;
  scenarios: SpecScenario[];
  // 1-based right-side lines of the heading and of the block's last line.
  line: number;
  endLine: number;
  // Some line in [line, endLine] is in changedRightLines.
  touched: boolean;
  // The requirement as one line, at most requirementChars plus " (truncated)".
  text: string;
}

export interface ParsedDelta {
  path: string;
  change: string;
  capability: string;
  requirements: SpecRequirement[];
  removed: string[];
  renamed: Array<{ from: string; to?: string }>;
  // Capped at problemsPerDelta, then "and N more".
  problems: string[];
}

const SECTION = /^(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements$/i;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const REQUIREMENT = /^Requirement:\s*(.*)$/i;
const SCENARIO = /^Scenario:\s*(.*)$/i;
const RENAME = /^\s*[-*+]?\s*(?:\*\*)?(FROM|TO)(?:\*\*)?\s*:\s*(.*)$/i;
const BULLET = /^\s*[-*+]\s+/;

const collapse = (s: string) => s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
const cap = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)} (truncated)` : s);
const end = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/**
 * The lines with every HTML comment blanked in place, a comment may span lines. Blanked, not
 * removed, so line numbers stay aligned with changedRightLines. A comment is invisible in every
 * rendering of the file, so nothing in one is a requirement — and `<!-- prloop:… -->` is
 * prloop's own marker syntax, which must never reach a prompt or the summary from here.
 */
function blankComments(lines: readonly string[]): string[] {
  let inComment = false;
  return lines.map((raw, i) => {
    // trimEnd also takes the \r that splitLines keeps on a CRLF file.
    let rest = (i === 0 ? raw.replace(/^\uFEFF/, "") : raw).trimEnd();
    let out = "";
    while (rest.length > 0) {
      if (inComment) {
        const close = rest.indexOf("-->");
        if (close < 0) break;
        rest = rest.slice(close + 3);
        inComment = false;
        continue;
      }
      const open = rest.indexOf("<!--");
      if (open < 0) {
        out += rest;
        break;
      }
      out += rest.slice(0, open);
      rest = rest.slice(open + 4);
      inComment = true;
    }
    return out;
  });
}

interface OpenRequirement {
  op: "ADDED" | "MODIFIED";
  ordinal: number;
  name: string;
  statement: string[];
  scenarios: SpecScenario[];
  line: number;
  last: number;
}

/**
 * One spec delta, parsed into the requirements it adds or modifies. A deterministic line
 * machine over OpenSpec's own grammar — `## ADDED|MODIFIED|REMOVED|RENAMED Requirements`,
 * `### Requirement:`, `#### Scenario:` — and nothing else: anything it cannot read becomes a
 * named problem rather than a guessed requirement. Precondition: specDeltaOf(f.path) is
 * defined. Pure; no model.
 */
export function parseSpecDelta(
  f: Pick<FileDiff, "path" | "rightLines" | "changedRightLines">,
  limits: OpenSpecLimits = OPENSPEC_LIMITS,
): ParsedDelta {
  const where = specDeltaOf(f.path) ?? { change: "", capability: "" };
  const out: ParsedDelta = { path: f.path, ...where, requirements: [], removed: [], renamed: [], problems: [] };
  const name = (s: string) => cap(collapse(s), limits.nameChars);
  let section: "ADDED" | "MODIFIED" | "REMOVED" | "RENAMED" | undefined;
  let sawSection = false;
  let ordinal = 0;
  let cur: OpenRequirement | undefined;
  let fence: string | undefined;

  const close = () => {
    if (!cur) return;
    const statement = collapse(cur.statement.join(" "));
    if (!statement && cur.scenarios.length === 0) {
      out.problems.push(`requirement "${cur.name}" (line ${cur.line}) is empty: not judged`);
    } else {
      let touched = false;
      for (let n = cur.line; n <= cur.last && !touched; n++) touched = f.changedRightLines.has(n);
      const scenarios = cur.scenarios.map((s) => ` Scenario "${s.name}": ${end(s.steps.join("; ") || "(no steps)")}`);
      const text = collapse(`${cur.name}:${statement ? ` ${end(statement)}` : ""}${scenarios.join("")}`);
      out.requirements.push({
        op: cur.op,
        ordinal: cur.ordinal,
        name: cur.name,
        statement,
        scenarios: cur.scenarios,
        line: cur.line,
        endLine: cur.last,
        touched,
        text: cap(text, limits.requirementChars),
      });
    }
    cur = undefined;
  };

  // A body line of the open requirement: its statement until the first scenario, then that
  // scenario's steps. An indented line with no bullet continues the step above it, which is
  // how a wrapped "- **AND** …" reads.
  const addText = (line: string, n: number) => {
    if (!cur) return;
    cur.last = n;
    const text = collapse(line.replace(BULLET, ""));
    if (!text) return;
    const scenario = cur.scenarios[cur.scenarios.length - 1];
    if (!scenario) cur.statement.push(text);
    else if (!BULLET.test(line) && /^\s/.test(line) && scenario.steps.length > 0) {
      scenario.steps[scenario.steps.length - 1] += ` ${text}`;
    } else scenario.steps.push(text);
  };

  blankComments(f.rightLines).forEach((line, i) => {
    const n = i + 1;
    const marker = FENCE.exec(line);
    // Fenced lines are never structure — a "### Requirement:" in an example block is an
    // example — but they are the requirement's text.
    if (fence !== undefined) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && line.trim() === marker[1]) fence = undefined;
      else addText(line, n);
      if (cur) cur.last = n;
      return;
    }
    if (marker) {
      fence = marker[1]!;
      if (cur) cur.last = n;
      return;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const title = (heading[2] ?? "").trim();
      if (level <= 2) {
        close();
        const m = SECTION.exec(title);
        section = m ? (m[1]!.toUpperCase() as typeof section) : undefined;
        if (m) sawSection = true;
        return;
      }
      if (level === 3) {
        close();
        const req = REQUIREMENT.exec(title);
        if (req) {
          const named = name(req[1]!);
          if (section === "ADDED" || section === "MODIFIED") {
            ordinal++;
            cur = { op: section, ordinal, name: named || "(unnamed requirement)", statement: [], scenarios: [], line: n, last: n };
            if (!named) out.problems.push(`"### Requirement:" (line ${n}) has no name`);
          } else if (section === "REMOVED") out.removed.push(named || "(unnamed requirement)");
          else if (section === undefined) {
            out.problems.push(
              `"### Requirement: ${named}" (line ${n}) is outside an ADDED, MODIFIED, REMOVED or RENAMED section: not judged`,
            );
          }
        } else if (SCENARIO.test(title)) {
          out.problems.push(`"### Scenario:" (line ${n}) must be a #### heading: its steps were not read`);
        }
        return;
      }
      if (cur) {
        const scenario = level === 4 ? SCENARIO.exec(title) : null;
        if (scenario) {
          cur.scenarios.push({ name: name(scenario[1]!) || "(unnamed scenario)", steps: [] });
          cur.last = n;
        } else addText(title, n);
      }
      return;
    }

    if (section === "RENAMED") {
      const m = RENAME.exec(line);
      if (!m) return;
      const renamed = name(m[2]!.replace(/`/g, "").replace(/^#+\s*Requirement:\s*/i, ""));
      if (m[1]!.toUpperCase() === "FROM") out.renamed.push({ from: renamed });
      else {
        const last = out.renamed[out.renamed.length - 1];
        if (last && last.to === undefined) last.to = renamed;
        else out.problems.push(`"TO: ${renamed}" (line ${n}) has no FROM before it`);
      }
      return;
    }
    addText(line, n);
  });
  close();

  if (!sawSection) out.problems.unshift("no ADDED, MODIFIED, REMOVED or RENAMED Requirements section");
  if (out.problems.length > limits.problemsPerDelta) {
    const more = out.problems.length - limits.problemsPerDelta;
    out.problems = [...out.problems.slice(0, limits.problemsPerDelta), `and ${more} more`];
  }
  return out;
}

export interface SpecSelection {
  // Id `SPEC<k>-R<ordinal>`, workItemId 0, text = the requirement's one line.
  refs: CriterionRef[];
  origins: Map<string, SpecOrigin>;
  // The deltas with at least one ref, as the prompt lists them.
  blocks: Array<{
    key: string;
    path: string;
    change: string;
    capability: string;
    lines: Array<{ id: string; op: "ADDED" | "MODIFIED"; text: string }>;
  }>;
  // Every parsed delta.
  deltas: OpenSpecDeltaInfo[];
  capped: number;
}

/**
 * The requirements to judge: those whose block this pull request changed, in path order then
 * file order, up to the limits. A requirement the PR left alone was judged when it was written
 * (or will be by the PR that implements it), and re-judging the whole capability on every
 * push would charge a typo fix for forty requirements.
 */
export function selectSpecCriteria(deltas: readonly ParsedDelta[], limits: OpenSpecLimits = OPENSPEC_LIMITS): SpecSelection {
  // A locale-independent order, so SPEC1 is the same delta on every machine.
  const sorted = [...deltas].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const out: SpecSelection = { refs: [], origins: new Map(), blocks: [], deltas: [], capped: 0 };
  let total = 0;
  sorted.forEach((d, i) => {
    const key = `SPEC${i + 1}`;
    const lines: SpecSelection["blocks"][number]["lines"] = [];
    let unchanged = 0;
    for (const r of d.requirements) {
      if (!r.touched) {
        unchanged++;
        continue;
      }
      if (out.refs.length >= limits.requirements || total + r.text.length > limits.totalChars) {
        out.capped++;
        continue;
      }
      const id = `${key}-R${r.ordinal}`;
      total += r.text.length;
      out.refs.push({ id, workItemId: 0, text: r.text });
      out.origins.set(id, {
        delta: key,
        path: d.path,
        change: d.change,
        capability: d.capability,
        op: r.op,
        name: r.name,
        scenarios: r.scenarios.length,
        line: r.line,
      });
      lines.push({ id, op: r.op, text: r.text });
    }
    if (lines.length > 0) out.blocks.push({ key, path: d.path, change: d.change, capability: d.capability, lines });
    out.deltas.push({
      key,
      path: d.path,
      change: d.change,
      capability: d.capability,
      judged: lines.length,
      unchanged,
      removed: d.removed,
      renamed: d.renamed,
      problems: d.problems,
    });
  });
  return out;
}
