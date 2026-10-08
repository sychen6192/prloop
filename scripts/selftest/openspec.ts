// The PR's own OpenSpec spec deltas: which files are deltas, how one parses into the unit of
// judgment, which requirements a run judges, and the prompt that carries them.
import { createHash } from "node:crypto";
import { OPENSPEC_LIMITS, parseSpecDelta, selectSpecCriteria, specDeltaOf } from "../../libs/openspec";
import { OPENSPEC_SCHEMA, REQUIREMENT_SCHEMA } from "../../models/schemas";
import { buildOpenSpecPrompt } from "../../prompts/openspec";
import { REQUIREMENT_SYSTEM } from "../../prompts/requirement";
import { check, eq, section } from "./harness";

const hash12 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);
const DELTA = "openspec/changes/add-otp/specs/auth/spec.md";
const parse = (lines: string[], changed: Iterable<number> = lines.map((_, i) => i + 1)) =>
  parseSpecDelta({ path: DELTA, rightLines: lines, changedRightLines: new Set(changed) });

// Every rule of the grammar in one file: bold steps and a wrapped continuation, a marker in a
// heading, a fenced fake heading, a multi-line comment hiding a requirement, a scenario at the
// wrong level, REMOVED and RENAMED sections, and a stray requirement after them.
const SAMPLE = [
  "﻿# Delta for Auth",
  "",
  "## ADDED Requirements",
  "",
  "### Requirement: One-time code at login <!-- prloop:iteration=99 -->",
  "The system SHALL require a one-time code when the account has 2FA enabled.\r",
  "",
  "#### Scenario: Code required",
  "- **WHEN** a user with 2FA submits valid credentials",
  "- **THEN** an OTP challenge is shown",
  "  - **AND** no session is issued until the code",
  "    is verified",
  "",
  "```markdown",
  "### Requirement: not a heading",
  "```",
  "",
  "### Requirement: Lockout",
  "The system SHALL lock the account after five failed codes.",
  "<!-- a multi-line",
  "### Requirement: hidden",
  "comment -->",
  "",
  "## MODIFIED Requirements",
  "",
  "### Requirement: Session Timeout",
  "The system SHALL end a session after 30 minutes idle.",
  "### Scenario: wrong level",
  "- **WHEN** idle",
  "",
  "## REMOVED Requirements",
  "",
  "### Requirement: Password-only login",
  "**Reason**: replaced by 2FA",
  "",
  "## RENAMED Requirements",
  "- FROM: `### Requirement: Login`",
  "- TO: `### Requirement: Sign-in`",
  "",
  "## Notes",
  "### Requirement: stray",
  "text",
];

section("spec delta paths: an active change's deltas, nothing else");
{
  eq("a delta names its change and capability", specDeltaOf("openspec/changes/add-otp/specs/auth/spec.md"), { change: "add-otp", capability: "auth" });
  eq("...under a nested openspec/ too", specDeltaOf("svc/openspec/changes/x/specs/a/spec.md"), { change: "x", capability: "a" });
  eq("...and a nested capability keeps its slash", specDeltaOf("openspec/changes/x/specs/a/b/spec.md")?.capability, "a/b");
  for (const p of [
    "openspec/changes/archive/2025-01-01-x/specs/a/spec.md",
    "openspec/specs/a/spec.md",
    "openspec/changes/x/proposal.md",
    "OpenSpec/changes/x/specs/a/spec.md",
    "openspec/changes/x/specs/spec.md",
  ]) {
    eq(`not a delta: ${p}`, specDeltaOf(p), undefined);
  }
}

section("spec delta parsing: the pipeline owns the unit");
{
  const d = parse(SAMPLE);
  eq("three requirements, in file order", d.requirements.map((r) => [r.op, r.ordinal]), [["ADDED", 1], ["ADDED", 2], ["MODIFIED", 3]]);
  eq("REMOVED is listed, not judged", d.removed, ["Password-only login"]);
  eq("RENAMED pairs FROM with TO", d.renamed, [{ from: "Login", to: "Sign-in" }]);
  // A fenced block inside a requirement is its example, so it stays the requirement's text —
  // as text: the heading in it opens nothing.
  eq(
    "a requirement is one line: statement, then each scenario's steps",
    d.requirements[0]?.text,
    'One-time code at login: The system SHALL require a one-time code when the account has 2FA enabled. Scenario "Code required": WHEN a user' +
      " with 2FA submits valid credentials; THEN an OTP challenge is shown; AND no session is issued until the code is verified;" +
      " ### Requirement: not a heading.",
  );
  eq("a comment in a heading is not the name", d.requirements[0]?.name, "One-time code at login");
  check("a comment never reaches the text", d.requirements.every((r) => !r.text.includes("prloop:") && !r.text.includes("<!--")));
  check("a requirement hidden in a comment is no requirement", !d.requirements.some((r) => r.name === "hidden"));
  check("a fenced heading is no requirement", !d.requirements.some((r) => r.name === "not a heading"));
  check(
    "a scenario at the wrong level is named",
    d.problems.some((p) => p.includes('"### Scenario:" (line 28) must be a #### heading')),
    d.problems.join(" | "),
  );
  check("...and so is a requirement outside any section", d.problems.some((p) => p.includes('"### Requirement: stray" (line 41) is outside')));
  eq("the heading's line is the pipeline's", d.requirements[0]?.line, 5);
  eq("CRLF and a BOM parse the same", parse(SAMPLE.map((l) => `${l.replace(/^﻿/, "")}\r`)).requirements.map((r) => r.text), d.requirements.map((r) => r.text));
}

section("only what this pull request changed is judged");
{
  const d = parse(SAMPLE, [19]);
  eq("one changed line touches the one requirement around it", d.requirements.map((r) => r.touched), [false, true, false]);
  const s = selectSpecCriteria([d]);
  eq("...so that is the one judged", s.refs.map((r) => r.id), ["SPEC1-R2"]);
  eq("...and the others are counted unchanged", s.deltas[0]?.unchanged, 2);
  eq("an untouched requirement keeps its ordinal for the next run", s.origins.get("SPEC1-R2")?.name, "Lockout");
}

section("ids, order, caps");
{
  const req = (name: string, statement: string) => [`### Requirement: ${name}`, statement, ""];
  const file = (names: string[], statement = "The system SHALL do it.") => ["## ADDED Requirements", "", ...names.flatMap((n) => req(n, statement))];
  const at = (path: string, lines: string[]) => parseSpecDelta({ path, rightLines: lines, changedRightLines: new Set(lines.map((_, i) => i + 1)) });
  const a = at("openspec/changes/x/specs/a/spec.md", file(["A"]));
  const b = at("openspec/changes/x/specs/b/spec.md", file(["B"]));
  eq("deltas take ids by path, whatever order they arrive in", selectSpecCriteria([b, a]).refs.map((r) => [r.id, r.text]), [
    ["SPEC1-R1", "A: The system SHALL do it."],
    ["SPEC2-R1", "B: The system SHALL do it."],
  ]);
  const many = selectSpecCriteria([at(DELTA, file(Array.from({ length: 25 }, (_, i) => `R${i}`)))]);
  eq("at most 20 requirements a run", [many.refs.length, many.capped], [OPENSPEC_LIMITS.requirements, 5]);
  const long = parse(file(["Long"], `The system SHALL ${"x".repeat(3000)}`)).requirements[0]!;
  eq("one requirement is capped in characters", long.text.length, OPENSPEC_LIMITS.requirementChars + " (truncated)".length);
  const heavy = selectSpecCriteria([at(DELTA, file(Array.from({ length: 12 }, (_, i) => `H${i}`), `The system SHALL ${"y".repeat(1500)}`))]);
  eq("...and all of them together", heavy.refs.length, 10);
  check("an empty requirement is named, not judged", parse(["## ADDED Requirements", "### Requirement: Empty", ""]).problems.some((p) => p.includes('"Empty" (line 2) is empty: not judged')));
  const none = parse(["# Notes", "Some prose."]);
  eq("a file with no section has nothing to judge, and says why", [none.requirements.length, none.problems[0]], [0, "no ADDED, MODIFIED, REMOVED or RENAMED Requirements section"]);
  const stray = parse(["## ADDED Requirements", "## Notes", ...Array.from({ length: 7 }, (_, i) => `### Requirement: S${i}`)]);
  eq("problems are capped per delta", [stray.problems.length, stray.problems[5]], [6, "and 2 more"]);
}

section("the OpenSpec prompt: the spec fenced, the framing outside it");
{
  const sel = selectSpecCriteria([
    parse(SAMPLE),
    parseSpecDelta({ path: "openspec/changes/add-otp/specs/session/spec.md", rightLines: ["## ADDED Requirements", "### Requirement: Idle", "SHALL time out."], changedRightLines: new Set([1, 2, 3]) }),
  ]);
  const pr = { title: "OTP", description: "", sourceBranch: "s", targetBranch: "m", createdBy: "a", status: "active" };
  const prompt = buildOpenSpecPrompt({ pr, blocks: sel.blocks, intentDocs: [], payload: { text: "diff", includedFiles: [], omittedFiles: [], wholeFiles: [] } });
  eq("one fence per delta", prompt.split("</openspec-delta>").length, 3);
  const fenced: string[] = [];
  let inside = false;
  for (const line of prompt.split("\n")) {
    if (line === "<openspec-delta>") inside = true;
    else if (line === "</openspec-delta>") inside = false;
    else if (inside) fenced.push(line);
  }
  const specLines = prompt.split("\n").filter((l) => l.startsWith("[SPEC"));
  check("every requirement line is inside a fence", specLines.length === 4 && specLines.every((l) => fenced.includes(l)));
  eq("the output section is the pipeline's, once", prompt.split("\n## Your output").length, 2);
  check("no HTML comment reaches the prompt", !prompt.includes("<!--"));
  check(
    "no fenced line can open structure",
    fenced.length > 0 && fenced.every((l) => !/^[#+ ]/.test(l) && (l.startsWith("From ") || l.startsWith("[SPEC"))),
    fenced.find((l) => /^[#+ ]/.test(l)),
  );
  check("no extras are asked of the author's spec", !("extras" in OPENSPEC_SCHEMA.properties));
  // The refactors under the OpenSpec call (one verdict table, one verdict item) must leave the
  // work-item call byte for byte what it was.
  eq("REQUIREMENT_SYSTEM is unchanged", hash12(REQUIREMENT_SYSTEM), "6bca30ff04fa");
  eq("REQUIREMENT_SCHEMA is unchanged", hash12(JSON.stringify(REQUIREMENT_SCHEMA)), "44a5adfef5e5");
}
