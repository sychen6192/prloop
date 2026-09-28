// Reviewer rules: glob selection, and what the shipped packs may and may not ask for.
import { detectLanguage, isReviewable } from "../../libs/lang";
import { globToRegExp, loadRules, ruleHeadings, selectRules } from "../../libs/rules";
import { CONVENTION_PATHS, frontMatter, gatherConventions, type ConventionReader } from "../../libs/conventions";
import { load } from "../../libs/tls";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { check, eq, section } from "./harness";
import { spec } from "./fixtures";

// --- rule globs ---
section("rule glob matching");
check("** matches any depth", globToRegExp("**/*.py").test("src/a/b/c.py"));
check("**/ matches zero directories", globToRegExp("**/*.py").test("c.py"));
check("wrong extension does not match", !globToRegExp("**/*.py").test("src/a.java"));
check("{a,b} branch", globToRegExp("**/*.{tsx,jsx}").test("app/page.tsx"));
check("{a,b} other branch", globToRegExp("**/*.{tsx,jsx}").test("app/page.jsx"));
check("{a,b} rejects a third option", !globToRegExp("**/*.{tsx,jsx}").test("app/page.ts"));
check("* does not cross directories", !globToRegExp("src/*.ts").test("src/deep/a.ts"));
check("directory prefix", globToRegExp("services/payment/**").test("services/payment/api/x.java"));
check("global **/*", globToRegExp("**/*").test("anything/at/all.md"));

section("rule selection");
{
  const rules = [
    { name: "_base.md", applyTo: ["**/*"], body: "base" },
    { name: "java.md", applyTo: ["**/*.java"], body: "java" },
    { name: "python.md", applyTo: ["**/*.py"], body: "python" },
  ];
  const picked = selectRules(rules, ["/src/Main.java", "/README.md"]);
  eq("loads only relevant language rules", picked.map((r) => r.name).sort(), ["_base.md", "java.md"]);
  check("unchanged language rules not loaded", !picked.some((r) => r.name === "python.md"));
  const none = selectRules(rules, []);
  eq("no changed files -> no rules loaded", none.length, 0);
}
{
  // The shipped baseline must actually parse and apply everywhere.
  const base = loadRules().find((r) => r.name === "_base.md");
  check("built-in _base.md loads", base !== undefined);
  if (base) {
    eq("_base.md applyTo is global", base.applyTo, ["**/*"]);
    check("_base.md body has Fowler smells", base.body.includes("Feature Envy"));
    check("_base.md frontmatter stripped", !base.body.startsWith("---"));
  }
}
{
  // PRR_RULES_DIR is added to the shipped rules. As a replacement, a team that wrote its own
  // C# pack lost the base smells and every language pack with it, and nothing said so.
  const team = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-rules-"));
  try {
    fs.writeFileSync(path.join(team, "csharp.md"), '---\napplyTo: "**/*.cs"\n---\n# C# rules\n');
    fs.mkdirSync(path.join(team, "api"));
    fs.writeFileSync(path.join(team, "api", "controllers.md"), '---\napplyTo: "**/Controllers/*.cs"\n---\n# Controllers\n');
    const merged = loadRules(team);
    const names = (paths: string[]) => selectRules(merged, paths).map((r) => r.name).sort();
    eq("a team's C# pack is added to the base smells, not swapped for them",
      names(["src/Api/Controllers/Orders.cs"]), ["_base.md", "api/controllers.md", "csharp.md"]);
    check("...and the shipped language packs are all still there", merged.some((r) => r.name === "java.md"));
    // A same-named file is how a team opts out of, or rewrites, a shipped pack.
    fs.writeFileSync(path.join(team, "_base.md"), '---\napplyTo: "**/*"\n---\n# Our baseline\n');
    const replaced = loadRules(team).filter((r) => r.name === "_base.md");
    eq("a team file named like a shipped one replaces it", replaced.map((r) => r.body), ["# Our baseline"]);
    eq("unset, the shipped rules alone", loadRules("").map((r) => r.name).sort(), loadRules().map((r) => r.name).sort());
  } finally {
    fs.rmSync(team, { recursive: true, force: true });
  }
}
{
  // The shipped TS/Node/Playwright packs, selected against a monorepo layout. These pin the
  // additive-by-extension strategy: a backend .ts file gets the TS packs and nothing React.
  const shipped = loadRules();
  const names = (paths: string[]) => selectRules(shipped, paths).map((r) => r.name).sort();
  eq("backend ts", names(["/apps/api/src/user.ts"]), ["_base.md", "node-server.md", "typescript.md"]);
  eq("unit test does not load playwright", names(["/apps/api/src/user.test.ts"]), ["_base.md", "node-server.md", "typescript.md"]);
  eq("e2e spec loads playwright", names(["/apps/web/src/login.spec.ts"]), ["_base.md", "node-server.md", "playwright.md", "typescript.md"]);
  eq("app route handler gets ts and next", names(["/apps/web/app/route.ts"]), ["_base.md", "nextjs.md", "node-server.md", "typescript.md"]);
  eq("tsx page gets next only", names(["/apps/web/app/page.tsx"]), ["_base.md", "nextjs.md"]);
  // `**/app/**` must not swallow the `apps/` directory prefix.
  check("apps/ prefix does not match **/app/**", !names(["/apps/api/src/user.ts"]).includes("nextjs.md"));
  // ...nor any non-JS file that merely lives under a directory called app/ or pages/, which
  // is the standard Flask and FastAPI layout.
  check("a python file under app/ gets no react rules", !names(["/svc/app/handlers.py"]).includes("nextjs.md"));
  check("a java file under pages/ gets no react rules", !names(["/svc/pages/Render.java"]).includes("nextjs.md"));
  eq("a route handler under app/ still gets next", names(["/web/app/api/route.ts"]).includes("nextjs.md"), true);
  eq("mts detected as typescript", detectLanguage("/src/x.mts"), "typescript");
  check("mts is reviewable", isReviewable("/src/x.mts"));

  // Python. The profile has always claimed .pyi, but the pack's glob did not, so stub files
  // reached the finder with only the cross-language baseline attached.
  eq("py loads the python pack", names(["/svc/app/handlers.py"]), ["_base.md", "python.md"]);
  eq("pyi stubs load it too", names(["/svc/app/types.pyi"]), ["_base.md", "python.md"]);
  check("pyi is reviewable", isReviewable("/svc/app/types.pyi"));
  check("python does not pull in js packs", !names(["/svc/app/handlers.py"]).includes("typescript.md"));

  const py = shipped.find((r) => r.name === "python.md")!;
  // The pack used to open with a list of ruff codes "already reported — do not report
  // again": false (ruff runs with its E/F default set, and the finder never sees tool
  // output anyway) and declared to win over the system prompt, so mutable defaults,
  // closure capture and blocking-in-async were deleted from the finder's job. Gone.
  for (const code of ["B006", "RUF012", "B023", "ASYNC2xx", "DTZ005"]) {
    check(`python pack no longer hands ${code} to ruff`, !py.body.includes(code));
  }
  // The notes that a gap is NOT in ruff's default set stay: they tell the finder to look.
  for (const code of ["RUF006", "B904", "PLW1641"]) {
    check(`python pack still flags ${code} as not default`, py.body.includes(code));
  }
}

section("rules: no pack hands a defect class to a linter");
{
  // The audit behind Phase 1B: every language pack opened with "the linter already
  // reports these, do not report them again" — a false premise (ruff runs with its E/F
  // default set, the static gate is off without PRR_WORKDIR, and the finder never sees
  // tool output anyway) declared to WIN over the system prompt. The most common defect
  // classes were deleted from the finder's job by its own rules. Regression net.
  const shipped = loadRules();
  check("shipped packs load", shipped.length >= 7);
  const suppression = /must not be reported again|must never be reported|already reported|do not report (them|those|any of these)/i;
  for (const r of shipped) {
    check(`${r.name} carries no linter-suppression framing`, !suppression.test(r.body), (suppression.exec(r.body) ?? [""])[0]);
  }
  const neutral = "prloop dedupes tool and model findings downstream";
  for (const name of ["_base.md", "python.md", "typescript.md", "java.md", "nextjs.md"]) {
    const body = shipped.find((r) => r.name === name)?.body ?? "";
    check(`${name} states the dedupe contract instead`, body.includes(neutral));
  }
  // Naming is scoped, not banned: conventions never; a misdescriptive name is a cited smell.
  const base = shipped.find((r) => r.name === "_base.md")!.body;
  check("_base.md: naming conventions are never reported", /naming \*\*conventions\*\*[^.]*never reported/i.test(base));
  check("_base.md: a misdescriptive name is a reportable Mysterious Name", /misdescribes what the\s+code does[\s\S]{0,200}"Mysterious Name"/.test(base));
}

section("rules: java.md concurrency and @Transactional in rule → bad → good → why form");
{
  const java = loadRules().find((r) => r.name === "java.md")!;
  eq("applyTo frontmatter intact", java.applyTo, ["**/*.java"]);
  const sectionOf = (title: string) => {
    const i = java.body.indexOf(`\n## ${title}`);
    const j = java.body.indexOf("\n## ", i + 1);
    return i < 0 ? "" : java.body.slice(i, j < 0 ? undefined : j);
  };
  for (const title of ["Concurrency", "Spring `@Transactional`"]) {
    const s = sectionOf(title);
    const rules = (s.match(/^### /gm) ?? []).length;
    // \r?\n throughout: .gitattributes pins the checkout to LF, and these assertions are
    // about whether a rule carries a snippet at all — not about which byte ends the fence
    // line. Depending on the latter is how a Windows runner came to report "0 bad, 0 good"
    // about a file nobody had touched.
    const bad = (s.match(/```java\r?\n\/\/ bad/g) ?? []).length;
    const good = (s.match(/```java\r?\n\/\/ good/g) ?? []).length;
    const why = (s.match(/^Why: /gm) ?? []).length;
    check(
      `${title}: every rule has a bad snippet, a good snippet and a why`,
      rules >= 6 && bad === rules && good === rules && why === rules,
      `${rules} rules, ${bad} bad, ${good} good, ${why} why`,
    );
    const lengths = [...s.matchAll(/```java\r?\n([\s\S]*?)```/g)].map((m) => m[1]!.trim().split(/\r?\n/).length);
    check(`${title}: snippets stay short (3-6 lines)`, lengths.length > 0 && lengths.every((n) => n >= 3 && n <= 6), lengths.join(","));
  }
  const stream = sectionOf("Stream");
  check("other sections stay prose", stream.includes("- **Reusing a consumed stream**") && !stream.includes("```java"));
  // The rule names are headings — citable, and listed in the prompt recap — while a
  // comment inside a fence is not one.
  const heads = ruleHeadings(java.body);
  check("rule names are headings", heads.includes("Self-invocation") && heads.includes("Compound operations on a volatile field"));
  check("fenced code contributes no headings", !heads.some((h) => /^(bad|good)\b/.test(h)));
}

section("repository instructions: every file teams write for their tools, each in its own scope");
{
  // A repository as a map of path -> text; directories are whatever the paths imply.
  const repoOf = (files: Record<string, string>, broken: string[] = []) => {
    const calls: string[] = [];
    const reader: ConventionReader = {
      async read(p) {
        calls.push(`read ${p}`);
        if (broken.includes(p)) throw new Error("HTTP 401");
        return files[p];
      },
      async list(dir, deep) {
        calls.push(`list ${dir}`);
        const prefix = `${dir}/`;
        return Object.keys(files).filter((p) => p.startsWith(prefix) && (deep || !p.slice(prefix.length).includes("/")));
      },
    };
    return { reader, calls };
  };
  const files: Record<string, string> = {
    "/CLAUDE.md": "Root rules.",
    "/AGENTS.md": "   \n",
    "/.github/copilot-instructions.md": "Copilot, everywhere.",
    "/.github/instructions/api.instructions.md": '---\napplyTo: "src/api/**"\n---\nAPI handlers validate input.',
    "/.github/instructions/py.instructions.md": '---\napplyTo: "**/*.py"\n---\nPython only.',
    "/.github/instructions/none.instructions.md": "No applyTo, so attached by hand only.",
    "/.github/instructions/chat.instructions.md": '---\napplyTo: "**"\nexcludeAgent: "code-review"\n---\nFor the coding agent.',
    "/.azuredevops/instructions/db.instructions.md": "---\napplyTo: src/db/**, src/api/**\n---\nQueries are parameterised.",
    "/.cursor/rules/always.mdc": "---\ndescription: house style\nalwaysApply: true\n---\nAlways applied.",
    "/.cursor/rules/ts.mdc": "---\nglobs: *.ts\nalwaysApply: false\n---\nTypeScript, at any depth.",
    "/.cursor/rules/manual.mdc": "---\ndescription: only when asked\n---\nAgent-requested.",
    "/.cursor/rules/web/listed.mdc": "---\nglobs:\n  - web/**\n  - src/api/*.ts\n---\nA YAML list of globs.",
    "/src/CLAUDE.md": "Everything under src.",
    "/src/api/AGENTS.md": "The API package.",
    "/lib/CLAUDE.md": "Nothing under lib changed.",
  };
  const { reader, calls } = repoOf(files);
  const { docs, failures } = await gatherConventions(reader, ["src/api/users.ts", "/src/api/orders.ts"]);
  const byPath = new Map(docs.map((d) => [d.path, d]));
  eq(
    "every document that applies, from the whole repository to the narrowest scope",
    docs.map((d) => d.path),
    [
      "/CLAUDE.md",
      "/.github/copilot-instructions.md",
      "/.cursor/rules/always.mdc",
      "/.github/instructions/api.instructions.md",
      "/.azuredevops/instructions/db.instructions.md",
      "/.cursor/rules/ts.mdc",
      "/.cursor/rules/web/listed.mdc",
      "/src/CLAUDE.md",
      "/src/api/AGENTS.md",
    ],
  );
  eq("an instructions file carries its applyTo as its scope", byPath.get("/.github/instructions/api.instructions.md")?.scope, "src/api/**");
  eq("...and its body without the front matter", byPath.get("/.github/instructions/api.instructions.md")?.text.trim(), "API handlers validate input.");
  eq("an always-applied Cursor rule is repository-wide", byPath.get("/.cursor/rules/always.mdc")?.scope, undefined);
  eq("a nested AGENTS.md governs the files beneath it", byPath.get("/src/api/AGENTS.md")?.scope, "files under src/api/");
  check("an instructions file for files the change did not touch is left out", !byPath.has("/.github/instructions/py.instructions.md"));
  check("...and one with no applyTo, which Copilot attaches only by hand", !byPath.has("/.github/instructions/none.instructions.md"));
  check("...and one that opts out of code review", !byPath.has("/.github/instructions/chat.instructions.md"));
  check("...and a Cursor rule an agent would have to choose", !byPath.has("/.cursor/rules/manual.mdc"));
  check("...and the CLAUDE.md of a directory nothing changed in", !byPath.has("/lib/CLAUDE.md"));
  check("a blank root document is no document", !byPath.has("/AGENTS.md"));
  eq("nothing failed", failures, []);
  check("the nested files are looked for in the changed files' directories only", !calls.includes("list /lib"), calls.join(" | "));

  const rootOnly = repoOf(files);
  const none = await gatherConventions(rootOnly.reader, []);
  eq("with no changed files only the root documents are read", none.docs.map((d) => d.path), ["/CLAUDE.md", "/.github/copilot-instructions.md"]);
  check("...and no directory is listed", !rootOnly.calls.some((c) => c.startsWith("list")), rootOnly.calls.join(" | "));
  eq("...each root path tried once", rootOnly.calls.length, CONVENTION_PATHS.length);

  // A failure is named and the rest still arrive: one unreadable file does not cost the others.
  const flaky = repoOf(files, ["/src/api/AGENTS.md"]);
  const partial = await gatherConventions(flaky.reader, ["src/api/users.ts"]);
  eq("a file that cannot be read is named", partial.failures.map((f) => f.split(":")[0]), ["/src/api/AGENTS.md"]);
  check("...and the others are still read", partial.docs.some((d) => d.path === "/src/CLAUDE.md"));

  const fm = frontMatter("---\napplyTo: a\nglobs:\n  - x/**\n  - y.ts\n---\nbody");
  eq("front matter reads scalars and lists", [fm.fields["applyTo"], fm.fields["globs"], fm.body], ["a", "x/**,y.ts", "body"]);
  eq("no front matter leaves the text whole", frontMatter("# Title\n---\n").body, "# Title\n---\n");
}
