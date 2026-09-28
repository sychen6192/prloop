// Configuration, the CLI and intake edges: .env parsing, the settings SSOT, entry points,
// ADO parser edges, runs/ retention and artifacts, and the local intake.
import { buildLocalReviewContext } from "../../git/intake";
import { parsePrUrl, prBase } from "../../ado/client";
import { attachLogSink, detachLogSink, log } from "../../libs/log";
import {
  buildResultSummary,
  detachCallSink,
  formatCallRecord,
  openRunDir,
  recordCall,
} from "../../libs/artifacts";
import { matchesReviewedContent } from "../../gates/static";
import { parseToolOutput } from "../../profiles/parsers";
import type { ToolSpec } from "../../profiles/types";
import type { FileDiff } from "../../libs/types";
import { load } from "../../libs/tls";
import { coverageGaps } from "../../orchestrator";
import { calibrate } from "../calibrate";
import {
  KNOWN_KEYS,
  PRLOOP_ROOT,
  applyDotEnv,
  configReport,
  defaultOf,
  envAny,
  findShadowed,
  parseDotEnv,
  unknownKeys,
} from "../../config";
import {
  configSnapshot,
  configWarnings,
  displayValue,
  renderConfigTable,
  truncateValue,
  wantsConfigDump,
} from "../../libs/configreport";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { run } from "../../libs/shell";
import { selectForPruning } from "../../libs/artifacts";
import { bucketWorkdirFile, classifyWorkdirContent, classifyWorkdirFile } from "../../gates/static";
import { AdoError, AdoTooLargeError, diagnose, exceedsMaxBytes } from "../../ado/client";
import { AUTH_SCOPE_HINT, azOnPath } from "../../ado/auth";
import { isFileMissing } from "../../ado/conventions";
import { check, eq, section, skip } from "./harness";

// --- URL parsing ---
section("PR URL parsing");
{
  const r = parsePrUrl("https://dev.azure.com/myorg/MyProject/_git/my-repo/pullrequest/1234");
  eq("org", r.org, "myorg");
  eq("project", r.project, "MyProject");
  eq("repo", r.repoId, "my-repo");
  eq("prId", r.prId, 1234);
}
{
  const r = parsePrUrl("https://dev.azure.com/org/Proj%20With%20Space/_git/repo/pullrequest/7");
  eq("URL-encoded project name", r.project, "Proj With Space");
}
{
  // The API base must come from the URL, not be rebuilt from a configured host — that is
  // what broke on-prem: the virtual directory was dropped and the collection was mistaken
  // for the org, producing a request to an entirely different server.
  const cloud = parsePrUrl("https://dev.azure.com/myorg/MyProject/_git/my-repo/pullrequest/1234");
  eq("cloud API base", cloud.baseUrl, "https://dev.azure.com/myorg");

  const onpremPrefix = parsePrUrl(
    "https://tfs.corp.local/tfs/DefaultCollection/MyProject/_git/my-repo/pullrequest/42",
  );
  eq("on-prem with virtual dir: API base keeps /tfs", onpremPrefix.baseUrl, "https://tfs.corp.local/tfs/DefaultCollection");
  eq("on-prem with virtual dir: collection", onpremPrefix.org, "DefaultCollection");
  eq("on-prem with virtual dir: project", onpremPrefix.project, "MyProject");
  eq("on-prem with virtual dir: repo", onpremPrefix.repoId, "my-repo");
  eq("on-prem with virtual dir: PR id", onpremPrefix.prId, 42);

  const onpremPlain = parsePrUrl("https://ado.corp.local/DefaultCollection/Proj/_git/repo/pullrequest/9");
  eq("on-prem without virtual dir", onpremPlain.baseUrl, "https://ado.corp.local/DefaultCollection");

  const onpremDeep = parsePrUrl("https://srv.corp.local/tfs/apps/TeamCollection/Proj/_git/repo/pullrequest/3");
  eq("on-prem nested virtual dirs", onpremDeep.baseUrl, "https://srv.corp.local/tfs/apps/TeamCollection");

  const port = parsePrUrl("https://tfs.corp.local:8443/tfs/Coll/Proj/_git/repo/pullrequest/5");
  eq("on-prem custom port kept", port.baseUrl, "https://tfs.corp.local:8443/tfs/Coll");

  const vsts = parsePrUrl("https://myorg.visualstudio.com/MyProject/_git/repo/pullrequest/8");
  eq("visualstudio.com: collection in hostname, empty path", vsts.baseUrl, "https://myorg.visualstudio.com");
  eq("visualstudio.com: project", vsts.project, "MyProject");
}
{
  // The composed REST path is what actually gets requested; assert it end to end.
  const r = parsePrUrl("https://tfs.corp.local/tfs/DefaultCollection/MyProject/_git/my-repo/pullrequest/42");
  eq(
    "on-prem composed PR API URL",
    prBase(r),
    "https://tfs.corp.local/tfs/DefaultCollection/MyProject/_apis/git/repositories/my-repo/pullRequests/42",
  );
}
{
  let threw = false;
  try {
    parsePrUrl("https://dev.azure.com/org/proj/_git/repo");
  } catch {
    threw = true;
  }
  check("missing pullrequest segment throws", threw);
}

section("config: .env parsing (the two bugs that made a correct line configure the wrong thing)");
{
  const parsed = parseDotEnv(
    [
      "# a comment line",
      "",
      "PRR_LLM_MAX_TOKENS=16384",
      "export PRR_QUIET=1",
      "PRR_FINDER_MODELS=a,b # two models, not one called 'b # note'",
      "PRR_STATUS_NAME=\"ai review # 2\"",
      "PRR_STATUS_GENRE='quoted'   # trailing comment after the quotes",
      "PRR_ADO_PAT=abc#notacomment",
      "PRR_LLM_MAX_TOKENS=99",
      "no equals sign here",
      "=novalue",
    ].join("\n"),
  );
  eq("a plain assignment", parsed.get("PRR_LLM_MAX_TOKENS"), "16384");
  eq("`export FOO=bar`, pasted from a shell profile, assigns FOO", parsed.get("PRR_QUIET"), "1");
  eq("an unquoted trailing comment is a comment, not part of the value", parsed.get("PRR_FINDER_MODELS"), "a,b");
  eq("a # inside quotes is part of the value", parsed.get("PRR_STATUS_NAME"), "ai review # 2");
  eq("a comment after a quoted value is still stripped", parsed.get("PRR_STATUS_GENRE"), "quoted");
  eq("a # with no space before it is part of the value", parsed.get("PRR_ADO_PAT"), "abc#notacomment");
  eq("the first occurrence wins (bin/prloop's head -1 agrees)", parsed.get("PRR_LLM_MAX_TOKENS"), "16384");
  check("a line with no = is skipped", !parsed.has("no equals sign here"));
  check("a line with no key is skipped", parsed.size === 6, `${parsed.size} keys`);
}
{
  // Precedence is unchanged and load-bearing: CI exports the real values and must win.
  const env: NodeJS.ProcessEnv = { PRR_QUIET: "1" };
  applyDotEnv(new Map([["PRR_QUIET", "0"], ["PRR_MAX_EXTRAS", "9"]]), env);
  eq("an exported variable survives the file", env["PRR_QUIET"], "1");
  eq("...and the file fills in what the shell did not set", env["PRR_MAX_EXTRAS"], "9");
}
{
  // The footgun itself: .env edited, shell still winning, nothing said so.
  const file = new Map([["PRR_LLM_MAX_TOKENS", "16384"], ["PRR_QUIET", "1"], ["PRR_MAX_EXTRAS", "5"]]);
  const shell = new Map([["PRR_LLM_MAX_TOKENS", "32768"], ["PRR_QUIET", "1"]]);
  const shadowed = findShadowed(file, shell);
  eq("only a DIFFERING shell value shadows", shadowed.map((e) => e.name), ["PRR_LLM_MAX_TOKENS"]);
  eq("the shell value is the effective one", shadowed[0]?.value, "32768");
  eq("...and .env's value is kept for the message", shadowed[0]?.fileValue, "16384");
  eq("a key only the shell sets is not a shadow", findShadowed(new Map(), shell).length, 0);
}
{
  eq("the proxy names keep their precedence", envAny(["PRR_HTTPS_PROXY", "HTTPS_PROXY", "https_proxy"], { PRR_HTTPS_PROXY: "http://a", HTTPS_PROXY: "http://b" }), "http://a");
  eq("...falling back to the conventional name", envAny(["PRR_HTTPS_PROXY", "HTTPS_PROXY"], { HTTPS_PROXY: "http://b" }), "http://b");
  eq("...and the lowercase spelling", envAny(["PRR_HTTPS_PROXY", "HTTPS_PROXY"], { https_proxy: "http://c" }), "http://c");
  eq("nothing set is the empty string", envAny(["PRR_HTTPS_PROXY", "HTTPS_PROXY"], {}), "");
}

section("config: startup warnings and the --config table");
{
  process.env["PRR_TYPPO_MAX_TOKENS"] = "16384";
  check("a misspelled setting is reported", unknownKeys().includes("PRR_TYPPO_MAX_TOKENS"));
  const warnings = configWarnings();
  check(
    "...with a message that names it as a typo",
    warnings.some((w) => w.message === "unknown setting PRR_TYPPO_MAX_TOKENS (not a prloop setting — check for a typo)"),
  );
  delete process.env["PRR_TYPPO_MAX_TOKENS"];
  check("a real setting is not reported as unknown", !unknownKeys().includes("PRR_LLM_MAX_TOKENS"));
}
{
  // A PAT reaches the log, the table and runs/config.json only as a placeholder.
  process.env["PRR_ADO_PAT"] = "ghp_averyrealisticlookingtoken0123";
  const table = renderConfigTable();
  check("a secret never reaches the config table", !table.includes("ghp_averyrealisticlookingtoken0123"));
  check("...it shows as [REDACTED]", /PRR_ADO_PAT\s+\[REDACTED\]/.test(table));
  const snapshot = configSnapshot();
  const pat = snapshot.entries.find((e) => e.name === "PRR_ADO_PAT");
  eq("...and config.json saves the placeholder, not the token", pat?.value, "[REDACTED]");
  eq("...next to the source, which is the point of saving it", pat?.source, "shell");
  delete process.env["PRR_ADO_PAT"];
  eq("an unset secret is blank, not [REDACTED]", displayValue("PRR_ADO_PAT", ""), "");
  eq("a non-secret value is shown as it is", displayValue("PRR_MAX_EXTRAS", "7"), "7");
}
{
  // config.json is written through the same redacting artifact writer as everything else in
  // runs/; the point of the file is that it is safe to attach to a bug report.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prr-config-"));
  process.env["PRR_ADO_PAT"] = "ghp_averyrealisticlookingtoken0123";
  openRunDir(dir).saveJson("config.json", configSnapshot());
  const saved = fs.readFileSync(path.join(dir, "config.json"), "utf8");
  delete process.env["PRR_ADO_PAT"];
  check("the run's config.json holds no secret", !saved.includes("ghp_averyrealisticlookingtoken0123"));
  const reloaded = JSON.parse(saved) as { entries: Array<{ name: string }> };
  eq("...and one entry per registry key", reloaded.entries.length, KNOWN_KEYS.length);
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  eq("a long value is cut to a loggable length", truncateValue("x".repeat(60)), `${"x".repeat(40)}…`);
  eq("a short one is left alone", truncateValue("qwen3-coder"), "qwen3-coder");
  check("a credential in a value is scrubbed before it is cut", !truncateValue("Bearer sk-abcdefghijklmnop").includes("sk-abcdefghijklmnop"));
}
{
  check("--config asks for the table", wantsConfigDump(["--config"], false));
  check("PRR_SHOW_CONFIG=1 asks for it too", wantsConfigDump([], true));
  check("a normal run does not", !wantsConfigDump(["https://dev.azure.com/o/p/_git/r/pullrequest/1", "--dry-run"], false));
  check("every registry key has a row", configReport().length === KNOWN_KEYS.length);
  const table = renderConfigTable();
  check("the table names the knob that started all this", /PRR_LLM_MAX_TOKENS\s+8192\s+default/.test(table));
  check("...and every other one", KNOWN_KEYS.every((k) => table.includes(k.name)));
}

section("config SSOT: registry, readers, .env.example and the README settings table");
{
  const read = (rel: string) => fs.readFileSync(path.join(PRLOOP_ROOT, rel), "utf8");
  const names = KNOWN_KEYS.map((k) => k.name);
  const known = new Set(names);
  eq("no duplicate registry entries", names.length - known.size, 0);
  check("every entry has a description", KNOWN_KEYS.every((k) => k.description.length > 0 && k.description.length <= 60));

  // 1. The registry and the readers describe the same set of knobs. A knob added to
  //    config.ts without a registry entry has no provenance, no --config row and no typo
  //    check; an entry with no reader is a setting that silently does nothing.
  const configSrc = read("config.ts");
  const readNames = new Set<string>();
  for (const m of configSrc.matchAll(/process\.env\.(PRR_[A-Z0-9_]+)/g)) readNames.add(m[1]!);
  for (const m of configSrc.matchAll(/\b(?:numEnv|enumEnv|strEnv|flagEnv|switchEnv)\("(PRR_[A-Z0-9_]+)"/g)) readNames.add(m[1]!);
  for (const m of configSrc.matchAll(/envAny\(\["(PRR_[A-Z0-9_]+)"/g)) readNames.add(m[1]!);
  eq("every knob config.ts reads is in the registry", [...readNames].filter((n) => !known.has(n)), []);
  eq("every registry key is actually read", names.filter((n) => !readNames.has(n)), []);
  const kindOf = new Map(KNOWN_KEYS.map((k) => [k.name, k.kind]));
  eq(
    "numEnv knobs are registered as numbers",
    [...configSrc.matchAll(/(?<![A-Za-z])numEnv\("(PRR_[A-Z0-9_]+)"/g)].map((m) => m[1]!).filter((n) => kindOf.get(n) !== "number"),
    [],
  );
  eq(
    "on/off knobs are registered as bools",
    [...configSrc.matchAll(/(?:flagEnv|switchEnv)\("(PRR_[A-Z0-9_]+)"/g)].map((m) => m[1]!).filter((n) => kindOf.get(n) !== "bool"),
    [],
  );

  // 2. Documented in both places, or in neither (ARCHITECTURE.md's rule; the drift it caught the
  //    first time it ran was 21 knobs missing from .env.example and 43 from the README).
  const documented = KNOWN_KEYS.filter((k) => !k.internal).map((k) => k.name);
  const declared = new Set<string>();
  for (const line of read(".env.example").split("\n")) {
    const m = /^\s*#?\s*(PRR_[A-Z0-9_]+)\s*=/.exec(line);
    if (m) declared.add(m[1]!);
  }
  eq("every knob appears in .env.example", documented.filter((n) => !declared.has(n)), []);
  eq(".env.example names no knob prloop stopped reading", [...declared].filter((n) => !known.has(n)), []);
  const rows = new Set<string>();
  for (const m of read("README.md").matchAll(/^\| `(PRR_[A-Z0-9_]+)` \|/gm)) rows.add(m[1]!);
  eq("every knob has a row in the README settings table", documented.filter((n) => !rows.has(n)), []);
  eq("the README names no knob prloop stopped reading", [...rows].filter((n) => !known.has(n)), []);

  // 3. Reading a PRR_ variable anywhere else puts it outside all of the above. Writes are
  //    fine — the CLI exports PRR_DRY_RUN for --dry-run, and tests seed values.
  const ls = spawnSync("git", ["ls-files", "-z", "--", "*.ts"], { cwd: PRLOOP_ROOT, encoding: "utf8" });
  const tracked = (ls.status === 0 ? ls.stdout.split("\0") : []).filter(Boolean);
  check("tracked TypeScript sources were listed", tracked.length > 20, `${tracked.length} files`);
  const strays: string[] = [];
  for (const rel of tracked) {
    if (rel === "config.ts") continue;
    read(rel).split("\n").forEach((line, i) => {
      if (/delete\s+process\.env/.test(line)) return;
      for (const m of line.matchAll(/process\.env(?:\.(PRR_[A-Z0-9_]+)|\["(PRR_[A-Z0-9_]+)"\])(\s*=(?!=))?/g)) {
        if (m[3] === undefined) strays.push(`${rel}:${i + 1} ${m[1] ?? m[2] ?? ""}`);
      }
    });
  }
  eq("no PRR_ setting is read outside config.ts", strays, []);
  eq("the defaults the readers recorded are the ones the table shows", defaultOf("PRR_LLM_MAX_TOKENS"), "8192");
}

section("CLI entry points");
{
  const wrapper = fs.readFileSync(path.join(PRLOOP_ROOT, "bin", "prloop"), "utf8");
  // Commentary is allowed to name the old command; the executable lines are not.
  const wrapperCode = wrapper
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  // `npx tsx` resolved from the CALLER's directory: it ran whatever tsx that project had, or
  // downloaded one mid-run — which on an air-gapped box is a hang, not an error.
  check("the wrapper runs the repo's own tsx", wrapperCode.includes("node_modules/.bin/tsx"));
  check("...and never fetches one at run time", !/npx\s+tsx/.test(wrapperCode) && wrapperCode.includes("--no-install"));
  check("...and says what to run when tsx is missing", wrapperCode.includes("npm ci"));

  // The documented install is a symlink onto PATH, and BASH_SOURCE is then the LINK's path:
  // deriving TOOL_DIR from it without resolving the link pointed the wrapper at ~/.local and
  // it died on "Cannot find module ~/.local/loop.ts". Run it through a symlink for real —
  // string-matching the resolution loop would pass on a broken one.
  {
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-link-"));
    try {
      const link = path.join(linkDir, "prloop");
      fs.symlinkSync(path.join(PRLOOP_ROOT, "bin", "prloop"), link);
      const r = spawnSync(link, ["--help"], { encoding: "utf8", timeout: 60_000 });
      if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
        skip("the wrapper works when invoked through a symlink", "no bash on this platform");
      } else {
        check("the wrapper works when invoked through a symlink", r.status === 0, `exit ${r.status}: ${(r.stderr ?? "").slice(0, 200)}`);
        check("...and prints its usage from there", (r.stdout ?? "").includes("Usage: prloop"));
      }
    } finally {
      fs.rmSync(linkDir, { recursive: true, force: true });
    }
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(PRLOOP_ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  // The only entry point that works on Windows, where bash is not a given but npm is.
  eq("npm run prloop is wired up", pkg.scripts?.["prloop"], "tsx loop.ts");

  // Not `spawnSync("npx", ...)`: on Windows that is npx.cmd, which Node refuses to spawn
  // directly (CVE-2024-27980). Running the tsx CLI with the current node needs no shell.
  // node_modules may sit above PRLOOP_ROOT (a git worktree shares its parent's install), so
  // walk up for it rather than reporting a missing install as a code failure.
  let tsxCli: string | undefined;
  for (let dir = PRLOOP_ROOT, i = 0; i < 5; i++, dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    if (fs.existsSync(candidate)) {
      tsxCli = candidate;
      break;
    }
  }
  if (tsxCli === undefined) {
    skip("--help exit status", "no installed tsx CLI found to run loop.ts with");
  } else {
    const helped = spawnSync(process.execPath, [tsxCli, path.join(PRLOOP_ROOT, "loop.ts"), "--help"], {
      encoding: "utf8",
      env: { ...process.env, PRR_QUIET: "1" },
    });
    // --help exited 1 to stderr, so every caller that checks a status code — a CI smoke test
    // included — saw asking for help as a failed run.
    eq("--help exits 0", helped.status, 0);
    check("--help prints usage to stdout", (helped.stdout ?? "").includes("Usage: prloop"));
    check("...including the OS-independent invocation", (helped.stdout ?? "").includes("npm run prloop"));
    check("--help does not print usage to stderr", !(helped.stderr ?? "").includes("Usage: prloop"));
  }
}

section("ADO and parser edges");
{
  // (a) Only a 404 means "this repo has no CONTRIBUTING.md". A 401 or a 5xx used to look
  // exactly the same, so a scope-less PAT silently emptied the conventions of every review.
  check("a 404 is a missing file", isFileMissing(new AdoError("nope", 404)));
  check("a 401 is not", !isFileMissing(new AdoError("unauthorized", 401)));
  check("a 500 is not", !isFileMissing(new AdoError("boom", 500)));
  check("a transport failure with no status is not", !isFileMissing(new AdoError("Connection failed")));
  check("a non-Ado error is not", !isFileMissing(new Error("socket hang up")));

  // (b) A parser exception used to return [], which is byte-identical to a clean tool run.
  const brokenSpec = {
    name: "pretend-linter",
    bin: "x",
    args: () => [],
    format: "no-such-format",
    tier: "triage",
  } as unknown as ToolSpec;
  const capture = <T,>(fn: () => T): { value: T; lines: string[] } => {
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    try {
      return { value: fn(), lines };
    } finally {
      console.log = realLog;
    }
  };
  const { value: parsed, lines: logged } = capture(() => parseToolOutput("some output", brokenSpec, "/w"));
  eq("a parser blowing up still returns no findings", parsed, []);
  check(
    "...but says so, with the tool's name",
    logged.some((l) => l.includes("pretend-linter") && l.includes("[WARN]")),
    logged.join(" | "),
  );

  // (c) authHeader() runs per request, so an uncached `which az` cost hundreds of processes
  // during intake at PRR_ADO_CONCURRENCY=6.
  let probes = 0;
  const countingProbe = async () => {
    probes++;
    return true;
  };
  const [a1, a2, a3] = await Promise.all([azOnPath(countingProbe), azOnPath(countingProbe), azOnPath(countingProbe)]);
  eq("az is probed once per process, not once per request", probes, 1);
  check("...and every caller gets the answer", a1 === true && a2 === true && a3 === true);

  // (d) The size limit is decided before the download now: an oversized blob used to be
  // fetched whole, twice (once per side of the diff), only to be skipped.
  check("a declared length over the limit is refused", exceedsMaxBytes("4000000", 2_000_000));
  check("a length under the limit is not", !exceedsMaxBytes("1999999", 2_000_000));
  check("exactly the limit is allowed", !exceedsMaxBytes("2000000", 2_000_000));
  check("no content-length means read and cap instead", !exceedsMaxBytes(null, 2_000_000));
  check("an unparseable content-length means read and cap instead", !exceedsMaxBytes("chunked", 2_000_000));
  check("no limit means no refusal", !exceedsMaxBytes("999999999", undefined));
  const tooLarge = new AdoTooLargeError(4_000_000, 2_000_000);
  eq("the refusal carries a status the retry loop treats as final", tooLarge.status, 413);
  check("...and is an AdoError, so callers' catch clauses still work", tooLarge instanceof AdoError);
  eq("...and reports the size that broke the limit", tooLarge.bytes, 4_000_000);

  // (e) The TLS hint pointed at NODE_EXTRA_CA_CERTS while libs/tls.ts, doctor and the README
  // all read PRR_CA_CERTS — following it changed nothing and looked like a prloop bug.
  const tlsHint = diagnose(Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }));
  check("the TLS hint names the knob prloop actually reads", tlsHint.includes("PRR_CA_CERTS"));
  check("...and points at the tool that writes it", tlsHint.includes("tlsfix"));
  check("...and no longer sends people to NODE_EXTRA_CA_CERTS", !tlsHint.includes("NODE_EXTRA_CA_CERTS"));

  // (f) Same word, opposite meaning, in two published knob names. Neither can be renamed, so
  // every place that documents them has to say which one it means.
  const readme = fs.readFileSync(path.join(PRLOOP_ROOT, "README.md"), "utf8");
  const envExample = fs.readFileSync(path.join(PRLOOP_ROOT, ".env.example"), "utf8");
  const configSrc = fs.readFileSync(path.join(PRLOOP_ROOT, "config.ts"), "utf8");
  const row = (knob: string) => readme.split("\n").find((l) => l.startsWith(`| \`${knob}\``)) ?? "";
  check("README says PRR_ADO_MAX_RETRIES counts TOTAL attempts", row("PRR_ADO_MAX_RETRIES").includes("TOTAL"));
  check("README says PRR_LLM_RETRIES counts EXTRA attempts", row("PRR_LLM_RETRIES").includes("EXTRA"));
  check(".env.example states both senses", envExample.includes("TOTAL attempts") && envExample.includes("EXTRA attempts"));
  check("the config registry states both senses", configSrc.includes("TOTAL attempts") && configSrc.includes("EXTRA attempts"));

  // (g) A file prloop could not read is not evidence about the checkout's commit.
  const reviewedLines = ["def run():", "    return compute()"];
  eq("identical content matches", classifyWorkdirContent(["def run():", "    return compute()"], reviewedLines), "match");
  eq("a CRLF-only difference still matches", classifyWorkdirContent(["def run():\r", "    return compute()\r"], reviewedLines), "match");
  eq("changed content differs", classifyWorkdirContent(["def run():", "    return cached()"], reviewedLines), "differs");
  eq("a different length differs", classifyWorkdirContent(["def run():"], reviewedLines), "differs");
  eq("an unreadable file is its own answer, not a mismatch", classifyWorkdirContent(undefined, reviewedLines), "unreadable");
  const unreadableDir = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-unreadable-"));
  eq("a path that cannot be read as a file is unreadable", classifyWorkdirFile(unreadableDir, reviewedLines), "unreadable");
  check("...and the boolean wrapper still rejects it", !matchesReviewedContent(unreadableDir, reviewedLines));
  fs.rmSync(unreadableDir, { recursive: true, force: true });
  // The bucketing the stale-checkout verdict counts on. An unreadable file used to land in
  // the stale list, so a permissions error produced "your checkout is at the wrong commit"
  // and an instruction to check out a SHA that would have changed nothing.
  const fetched = { binary: false, truncated: false, rightLines: reviewedLines };
  eq("matching content is analysed", bucketWorkdirFile(fetched, () => reviewedLines), "analyse");
  eq("differing content is stale", bucketWorkdirFile(fetched, () => ["other"]), "stale");
  eq("an unreadable file is NOT stale", bucketWorkdirFile(fetched, () => undefined), "unreadable");
  eq("a binary blob was never fetched", bucketWorkdirFile({ ...fetched, binary: true }, () => reviewedLines), "not-fetched");
  eq("an oversized blob was never fetched", bucketWorkdirFile({ ...fetched, truncated: true }, () => reviewedLines), "not-fetched");
  let reads = 0;
  bucketWorkdirFile({ ...fetched, truncated: true }, () => {
    reads++;
    return reviewedLines;
  });
  eq("a file we already know we will skip is never read from disk", reads, 0);

  // (h) The PAT scope is one string, quoted everywhere, because the requirement axis reads
  // work items and a Code-only PAT fails there with no explanation.
  eq("the scope hint names both scopes", AUTH_SCOPE_HINT, "Code (Read & Write) + Work Items (Read)");
  check("the README documents both scopes", readme.includes(AUTH_SCOPE_HINT));
  check(".env.example documents both scopes", envExample.includes(AUTH_SCOPE_HINT));

  // The new retention knobs, documented in all three places like every other knob.
  for (const knob of ["PRR_RUNS_KEEP", "PRR_RUNS_MAX_AGE_DAYS"]) {
    check(`${knob} is in the config registry`, configSrc.includes(knob));
    check(`${knob} is in .env.example`, envExample.includes(knob));
    check(`${knob} is in the README table`, row(knob) !== "");
  }
}

section("runs/ retention");
{
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 8, 8);
  const at = (name: string, ageDays: number) => ({ name, mtimeMs: now - ageDays * day });
  // Newest last on purpose: the policy must sort, not trust readdir order.
  const dirs = [
    at("iter-1-20260101-000000", 100),
    at("iter-2-20260801-000000", 40),
    at("iter-3-20260829-000000", 10),
    at("iter-4-20260907-000000", 1),
    at("iter-5-20260908-000000", 0),
  ];

  eq(
    "keeps the newest N, oldest deleted first",
    selectForPruning(dirs, { keep: 2, maxAgeDays: 0, now }),
    ["iter-3-20260829-000000", "iter-2-20260801-000000", "iter-1-20260101-000000"],
  );
  eq(
    "the age cutoff works on its own",
    selectForPruning(dirs, { keep: 0, maxAgeDays: 30, now }),
    ["iter-2-20260801-000000", "iter-1-20260101-000000"],
  );
  eq(
    "with both, either rule alone is enough",
    selectForPruning(dirs, { keep: 4, maxAgeDays: 30, now }),
    ["iter-2-20260801-000000", "iter-1-20260101-000000"],
  );
  eq("0 disables the keep count rather than deleting everything", selectForPruning(dirs, { keep: 0, maxAgeDays: 0, now }), []);

  // The two fixed directories a repeated non-review leaves behind. Neither competes with a
  // real review for the retention budget, and that is the whole reason they are named rather
  // than timestamped: a daily cron over a PR that has merged, or one failing on a revoked
  // PAT, would otherwise evict this PR's last actual review inside PRR_RUNS_KEEP ticks and
  // leave calibrate nothing to join that repo's dismissals against.
  const withNonRuns = [...dirs, at("skipped", 200), at("fatal", 200)];
  eq(
    "a skipped or fatal directory is never pruned, however old",
    selectForPruning(withNonRuns, { keep: 1, maxAgeDays: 1, now }).filter((n) => !n.startsWith("iter-")),
    [],
  );
  eq(
    "...and never counts toward the keep budget either",
    selectForPruning(withNonRuns, { keep: 2, maxAgeDays: 0, now }),
    selectForPruning(dirs, { keep: 2, maxAgeDays: 0, now }),
  );
  eq("0 disables the age limit too", selectForPruning(dirs, { keep: 0, maxAgeDays: 0, now: now + 400 * day }), []);
  eq("keeping more than exist deletes nothing", selectForPruning(dirs, { keep: 99, maxAgeDays: 0, now }), []);

  // The learnings store is the one thing under runs/ that must outlive every run: it is the
  // record of what humans rejected, and losing it re-posts findings they already dismissed.
  const withStore = [
    ...dirs,
    { name: "dismissals.jsonl", mtimeMs: now - 400 * day },
    { name: "pr-77", mtimeMs: now - 400 * day },
    { name: "notes", mtimeMs: 0 },
  ];
  const doomed = selectForPruning(withStore, { keep: 1, maxAgeDays: 1, now });
  check("the dismissals store is never selected", !doomed.includes("dismissals.jsonl"));
  check("nothing outside iter-* is ever selected", doomed.every((n) => n.startsWith("iter-")));
}

section("run artifacts: a run has to be diagnosable from its own directory alone");
{
  // The log sink is attached when the run directory is created — after intake — but the
  // interesting early failures (auth, proxy, config warnings) are logged before that, so
  // those lines must be replayed rather than left in a terminal nobody kept.
  const early = `early-line-${Date.now()}`;
  log(early);
  const lines: string[] = [];
  attachLogSink((l) => lines.push(l));
  check("lines logged before the sink existed are flushed into it", lines.some((l) => l.includes(early)));
  const later = `later-line-${Date.now()}`;
  log(later);
  check("...and later lines go straight through", lines.some((l) => l.includes(later)));
  // run.log is the file people attach to bug reports, so redaction has to happen BEFORE the
  // sink, not on the way to the terminal.
  log("HTTP 401: Bearer abcdefgh12345678");
  check("the sink only ever sees redacted text", lines.some((l) => l.includes("Bearer [REDACTED]")));
  detachLogSink();
  const seen = lines.length;
  log("after detach");
  eq("a detached sink receives nothing more", lines.length, seen);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-artifacts-"));
  try {
    // Model calls are recorded through a module-level hook: models/runner.ts is built
    // before the run directory exists, so it records unconditionally and this decides where.
    recordCall({ ts: "2026-01-01T00:00:00.000Z", stage: "findings", model: "m", attempt: 0, ms: 1 });
    check("recordCall is a no-op until a sink is installed", !fs.existsSync(path.join(dir, "calls.jsonl")));

    openRunDir(dir, true);
    log("teed into the run directory");
    recordCall({ ts: "2026-01-01T00:00:01.000Z", stage: "verdict", model: "m", attempt: 1, ms: 900, promptTokens: 12, completionTokens: 34 });
    detachLogSink();
    detachCallSink();
    check("run.log holds the run's own narration", fs.readFileSync(path.join(dir, "run.log"), "utf8").includes("teed into the run directory"));
    const jsonl = fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n");
    eq("one calls.jsonl line per model attempt", jsonl.length, 1);
    eq("...carrying stage, model, attempt and cost", jsonl[0], '{"ts":"2026-01-01T00:00:01.000Z","stage":"verdict","model":"m","attempt":1,"ms":900,"promptTokens":12,"completionTokens":34}');

    const before = fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").length;
    recordCall({ ts: "2026-01-01T00:00:02.000Z", stage: "findings", model: "m", attempt: 0, ms: 2 });
    eq("a detached call sink drops records again", fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").length, before);
  } finally {
    detachLogSink();
    detachCallSink();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  check(
    "a call record is redacted like every other artifact",
    formatCallRecord({ ts: "T", stage: "findings", model: "m", attempt: 0, ms: 5, error: "HTTP 401: Bearer abcdefgh12345678" }).includes("[REDACTED]"),
  );

  // result.json: the whole outcome in one file, including the exit code CI acted on.
  const summary = buildResultSummary({
    exitCode: 3,
    incomplete: ["finder m (timeout (900s))"],
    counts: { raw: 9, anchored: 7, survived: 5, inline: 2, degraded: 1 },
    tokens: { calls: 4, promptTokens: 100, completionTokens: 200 },
    durationSec: 42,
  });
  eq("result.json records the exit code", summary["exitCode"], 3);
  eq("...and why the run was incomplete", JSON.stringify(summary["incomplete"]), '["finder m (timeout (900s))"]');
  eq("...the counts down the funnel", JSON.stringify(summary["counts"]), '{"raw":9,"anchored":7,"survived":5,"inline":2,"degraded":1}');
  eq("...what it cost", JSON.stringify(summary["tokens"]), '{"calls":4,"promptTokens":100,"completionTokens":200}');
  eq("...how long it took", summary["durationSec"], 42);
  check("...and which prloop produced it", /^\d+\.\d+/.test(String(summary["version"])), String(summary["version"]));
  // Absent unless the run actually had one to report, so a clean result cannot be read as a
  // failure with an empty message or a skip with an empty reason.
  eq("a clean result claims no fatal", "fatal" in summary, false);
  eq("...and no skip reason", "skippedReason" in summary, false);

  // Identity: without it a result.json could only be identified by the directory path it
  // happens to sit in, so any cross-run report had to parse directory names or open two
  // more artifacts beside it.
  const ref = { baseUrl: "https://dev.azure.com/contoso", org: "contoso", project: "Shop", repoId: "api", prId: 7 };
  const identified = buildResultSummary({
    exitCode: 1,
    fatal: "AdoError: 401 Unauthorized",
    identity: {
      ref,
      iteration: 4,
      compareTo: 2,
      dryRun: false,
      startedAt: "2026-09-16T00:00:00.000Z",
      models: { finders: ["qwen3-coder", "devstral"], skeptics: ["gpt-oss"], req: "qwen3-coder" },
    },
    incomplete: [],
    counts: { raw: 0, anchored: 0, survived: 0, inline: 0, degraded: 0 },
    tokens: { calls: 0, promptTokens: 0, completionTokens: 0 },
    durationSec: 3,
  });
  eq("a fatal result says what killed it", identified["fatal"], "AdoError: 401 Unauthorized");
  const id = identified["identity"] as Record<string, unknown>;
  eq("...which pull request it was", (id["ref"] as { prId: number }).prId, 7);
  eq("...which iteration, and what it was comparing against", [id["iteration"], id["compareTo"]], [4, 2]);
  eq("...and which fleet produced it", JSON.stringify(id["models"]),
    '{"finders":["qwen3-coder","devstral"],"skeptics":["gpt-oss"],"req":"qwen3-coder"}');
}

section("local intake: the second provider at the ReviewContext seam, held to the contract");
{
  // ReviewContext used to be defined inside ado/intake.ts, and git/intake.ts imported the
  // type from there — a seam owned by one of its sides, so nothing stated what a provider
  // owes. Three fields had drifted by the time anyone looked. These are the two that a test
  // can catch; the third (empty commit sentinels) is asserted below.
  const gitOk = (await run("git", ["--version"], 10_000)).code === 0;
  if (!gitOk) {
    skip("a rename keeps its trail through the local intake", "no git on this platform");
  } else {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-localintake-"));
    const g = async (...args: string[]) => run("git", ["-C", repo, ...args], 20_000);
    await g("init", "-q", "-b", "main");
    await g("config", "user.email", "selftest@example.invalid");
    await g("config", "user.name", "selftest");
    fs.writeFileSync(path.join(repo, "old.ts"), "export function a() {\n  return 1;\n}\n");
    const keep = (second: string, seventh: string) => ["a", second, "c", "d", "e", "f", seventh, "h", ""].join("\n");
    fs.writeFileSync(path.join(repo, "keep.ts"), keep("b", "g"));
    await g("add", "-A");
    await g("commit", "-qm", "base");
    await g("checkout", "-q", "-b", "feature");
    await g("mv", "old.ts", "new.ts");
    fs.writeFileSync(path.join(repo, "new.ts"), "export function a() {\n  return 2;\n}\n");
    fs.writeFileSync(path.join(repo, "keep.ts"), keep("B", "g"));
    await g("add", "-A");
    await g("commit", "-qm", "rename");
    // The base branch moves on after the fork, in a file the branch also changed.
    await g("checkout", "-q", "main");
    fs.writeFileSync(path.join(repo, "keep.ts"), keep("b", "G"));
    await g("commit", "-qam", "main moves on");

    const ctx = await buildLocalReviewContext({ repo, base: "main", head: "feature" });
    const kept = ctx.files.find((x: FileDiff) => x.path === "keep.ts");
    eq("a change the base branch made after the fork is not shown as the branch undoing it", [...(kept?.changedRightLines ?? [])], [2]);
    eq("...because the left side is read at the merge base, as a pull request's diff is", kept?.leftLines[6], "g");
    const f = ctx.files.find((x: FileDiff) => x.path === "new.ts");
    eq("the renamed file is under review", f?.changeType, "rename");
    // libs/fileindex.ts follows originalPath to keep a thread created on the old name
    // attached, and libs/payload.ts renders "(renamed from ...)". The ADO intake set it;
    // this one declared the rename and then hid it.
    eq("...and carries the path it came from", f?.originalPath, "old.ts");
    // The left side has to be read from the OLD path: at the base ref the new one does not
    // exist, so reading it there gave an empty left side and diffed a rename as a wholly
    // new file — every line of it "added", for the finder to review from scratch.
    eq("...with its left side read from that path, not an empty one", f?.leftLines.length, 3);
    check("...so it is not diffed as wholly added", (f?.changedRightLines.size ?? 99) < 3);

    // orchestrator.ts fetches the repo's convention files at targetRefCommit and hands
    // sourceRefCommit to the static gate. Empty strings satisfied the type and then meant
    // "no conventions, no source commit" without anyone saying so.
    check("the iteration carries a real head commit", /^[0-9a-f]{40}$/.test(ctx.iteration.sourceRefCommit));
    check("...a real base commit", /^[0-9a-f]{40}$/.test(ctx.iteration.targetRefCommit));
    check("...and the merge base the three-dot diff was taken against", /^[0-9a-f]{40}$/.test(ctx.iteration.commonRefCommit));

    // A file the provider could not read is skipped with a named reason, never handed over
    // as empty — an empty left side diffs as wholly added and reads downstream as a clean
    // review of code nobody saw. `too large` is the one reason coverageGaps counts.
    const gone = await buildLocalReviewContext({ repo, base: "main", head: "no-such-ref-at-all" }).catch(
      () => undefined,
    );
    eq("an unreadable ref fails loudly rather than reviewing nothing", gone, undefined);

    fs.rmSync(repo, { recursive: true, force: true });
  }
}
