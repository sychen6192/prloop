// Offline self-test for the claims documentation makes about the code and about CI.
//
// The motivating failure is not a crash: it is a README that said the requirement axis costs
// one model call after a second one was added, an orchestrator header that said models are
// called "at exactly one point" when there were five call sites, and a troubleshooting page
// pinning a User-Agent version that had moved on. Every one of them was true when written and
// nothing failed when it stopped being true — so a reader trusted the doc over the code.
//
// Only claims a machine can actually settle live here: a symbol used but never defined, a
// version pinned in two places that must agree, a path that no longer exists. Judgement about
// whether prose is *well* written is not testable and is not attempted.
//
// Kept separate from selftest.ts (the anchoring net) and selftest-stream.ts (the transport
// net) so each can grow without inflating the others. Wired into `npm run check` after both.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  [OK]   ${name}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const readme = read("README.md");
const workflow = read(".github/workflows/check.yml");
const pkg = JSON.parse(read("package.json")) as { engines?: { node?: string }; scripts?: Record<string, string> };

console.log("\nREADME architecture diagram");
{
  // The diagram's right-hand column is arithmetic — "1 + A", "M×R + T" — and it is only
  // readable if the legend underneath defines every letter it uses. Both halves have been
  // edited independently (a stage was added to the diagram, the legend was not touched), and
  // an undefined symbol is the exact shape that mistake takes.
  const block = /## Architecture[\s\S]*?```\n([\s\S]*?)```\n\n([\s\S]*?)\n\n/.exec(readme);
  check("the diagram and its legend are both still there", block !== null);
  if (block) {
    const [, diagram, legend] = block as unknown as [string, string, string];
    // Column 3 holds the cost; the prose columns to its left are full of ordinary capitals.
    const symbols = new Set<string>();
    for (const line of diagram.split("\n")) {
      const cost = line.slice(78).trim();
      for (const m of cost.matchAll(/\b([A-Z])\b/g)) symbols.add(m[1]!);
    }
    check("the cost column uses symbols at all", symbols.size > 0, [...symbols].join(","));
    for (const sym of [...symbols].sort()) {
      check(`\`${sym}\` is defined in the legend`, legend.includes(`\`${sym}\` =`));
    }
  }
}

console.log("\nStated versions match the ones that ship");
{
  // "contributors get the same Node as CI" is only true while .node-version is one of the
  // versions the matrix actually runs.
  const pinned = read(".node-version").trim();
  const matrix = /^\s*node:\s*\[([^\]]*)\]/m.exec(workflow);
  check("the check workflow has a node matrix", matrix !== null);
  const versions = (matrix?.[1] ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  check(`.node-version (${pinned}) is one the CI matrix runs`, versions.includes(pinned), versions.join(","));

  // engines.node is a promise to whoever runs `npm ci` on the floor version. An untested
  // floor is a promise nobody checked: undici's dispatcher is handed to Node's own fetch,
  // and that seam moves between majors.
  const floor = /(\d+)/.exec(pkg.engines?.node ?? "")?.[1];
  check("package.json declares a Node floor", floor !== undefined, pkg.engines?.node);
  if (floor) check(`the declared floor (${floor}) is in the CI matrix`, versions.includes(floor), versions.join(","));

  // The User-Agent is built from package.json at startup (libs/proxy.ts). A doc that spells
  // out a version number is wrong the moment the version moves, and it is read by someone
  // debugging a proxy that filters on exactly that string.
  const trouble = read("docs/troubleshooting.md");
  const hardcoded = /prloop\/\d/.exec(trouble);
  check("no doc pins a literal prloop/<number> User-Agent", hardcoded === null, hardcoded?.[0]);
  check("libs/proxy.ts still derives it from the package version", read("libs/proxy.ts").includes("`prloop/${pkgVersion}`"));
}

console.log("\nEntry points the selftests cannot reach");
{
  // Nothing else in `npm run check` starts the CLI: the selftests import modules. --help and
  // --config are documented as exiting 0 with no credentials and no endpoint, which makes
  // them the cheapest proof that loop.ts still starts at all.
  for (const flag of ["--help", "--config"]) {
    check(`CI smoke-tests \`prloop ${flag}\``, workflow.includes(`npm run prloop -- ${flag}`));
  }
  check("README still documents --config as the settings dump", readme.includes("prloop --config"));
}

console.log("\nPaths documents point at");
{
  // docs/superpowers/specs/ was renamed to docs/design/; a stale link in a doc is silent.
  for (const f of ["README.md", "CLAUDE.md", "CONTRIBUTING.md", "PROPOSAL.md", "docs/troubleshooting.md"]) {
    check(`${f} does not reference the retired docs/superpowers/ path`, !read(f).includes("docs/superpowers"));
  }
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
