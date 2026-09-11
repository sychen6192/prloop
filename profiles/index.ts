// Language profiles. Adding a language is adding an entry here — the pipeline itself has
// no per-language branches.
import type { Profile } from "./types";

const python: Profile = {
  language: "python",
  extensions: [".py", ".pyi"],
  tools: [
    {
      // Ruff subsumes flake8/bugbear/pyupgrade and is fast enough to run on every PR.
      // Its own rules are style-adjacent, so they're triage, not fact.
      name: "ruff",
      bin: "ruff",
      args: (files) => ["check", "--output-format=json", "--force-exclude", ...files],
      format: "ruff-json",
      tier: "triage",
      allowNonZeroExit: true,
    },
    {
      // Type errors are facts: mypy doesn't guess.
      name: "mypy",
      bin: "mypy",
      args: (files) => ["--output=json", "--no-error-summary", "--hide-error-context", ...files],
      format: "mypy-json",
      tier: "fact",
      allowNonZeroExit: true,
      // The same guard tsc has, and for the same reason: run against a checkout whose
      // dependencies were never installed, mypy reports one of these per third-party import
      // and then every type that came from those modules degrades to Any or to an error.
      // This tier is posted inline with no model in the loop, so without this the PR gets a
      // wall of fact-tier comments about the reviewer's environment.
      //
      // Deliberately NOT import-untyped ("module is installed, but missing library stubs").
      // That one means the dependency IS there and simply ships no types — a real and
      // common project condition, not a broken checkout. Discarding the run on it would
      // suppress genuine type errors in every project that has one untyped dependency.
      environmentRules: [
        "import-not-found", // Cannot find implementation or library stub for module named 'x'
        "import", // the umbrella code older mypy emits for the same failure
      ],
      // Which specific code a given mypy version attaches is not something a rule list can
      // predict — mypy 1.5 split `import` into subcodes — so match the message family too.
      environmentMessages:
        /^(Cannot find implementation or library stub|Library stubs not installed|Source file found twice under different module names)/,
    },
    {
      // Bandit is the high-recall/high-FP member of the set — exactly the profile that
      // benefits from LLM triage rather than direct posting.
      name: "bandit",
      bin: "bandit",
      args: (files) => ["-f", "sarif", "-q", ...files],
      format: "sarif",
      tier: "triage",
      allowNonZeroExit: true,
    },
  ],
  // Formatting and import order are the formatter's job, never a review comment.
  ignoreRules: ["E501", "W291", "W293", "E302", "E303", "I001", "COM812", "Q000"],
};

const java: Profile = {
  language: "java",
  extensions: [".java"],
  tools: [
    {
      name: "pmd",
      bin: "pmd",
      args: (files) => ["check", "-f", "xml", "-R", "rulesets/java/quickstart.xml", "-d", ...files],
      format: "checkstyle-xml",
      tier: "triage",
      allowNonZeroExit: true,
    },
    {
      // SpotBugs works on bytecode, so it only runs when the module has been built.
      // Skipping is correct here: running it on stale classes reports fixed bugs.
      name: "spotbugs",
      bin: "spotbugs",
      args: () => ["-textui", "-xml:withMessages", "-low", "target/classes"],
      format: "spotbugs-xml",
      tier: "triage",
      requires: "target/classes",
      allowNonZeroExit: true,
    },
    {
      name: "checkstyle",
      bin: "checkstyle",
      args: (files) => ["-f", "xml", "-c", "/google_checks.xml", ...files],
      format: "checkstyle-xml",
      tier: "suppress",
      allowNonZeroExit: true,
    },

    // Maven fallbacks, used only when the standalone binary above is absent. Neither PMD nor
    // SpotBugs ships a distribution that can be fetched through a Maven repository — only
    // the plugins are there — so on a locked-down machine where nothing can be installed but
    // the corporate mirror is reachable, this is the only way either analyser runs at all.
    // Plugin versions are pinned: an unpinned `mvn pmd:pmd` resolves whatever the mirror
    // happens to carry, and the CLI shape has changed across major versions.
    {
      name: "pmd",
      bin: "mvn",
      // The ruleset CANNOT be set here. maven-pmd-plugin declares `rulesets` with no
      // `property`, so it is pom.xml-only and a review tool has no business editing that.
      // This variant therefore analyses maven-pmd-plugin-default.xml, which is narrower than
      // the quickstart set the standalone variant uses. Fewer findings, not wrong ones.
      args: () => ["-B", "org.apache.maven.plugins:maven-pmd-plugin:3.28.0:pmd"],
      format: "checkstyle-xml",
      tier: "triage",
      requires: "pom.xml",
      // An aggregator owns no sources. canGenerateReportInternal returns false for
      // packaging=pom, so the goal writes nothing and still exits 0 — running there produces
      // a "produced no report" skip that looks like a crash and is not one.
      skipProjectWhen: /<packaging>\s*pom\s*<\/packaging>/,
      outputFile: "target/pmd.xml",
      allowNonZeroExit: true,
    },
    {
      name: "spotbugs",
      bin: "mvn",
      // threshold/effort DO have user properties, so this variant is equivalent to the
      // standalone `-low` invocation rather than a reduced one.
      args: () => [
        "-B",
        "com.github.spotbugs:spotbugs-maven-plugin:4.9.3.0:spotbugs",
        "-Dspotbugs.threshold=Low",
        "-Dspotbugs.effort=Max",
      ],
      format: "spotbugs-xml",
      tier: "triage",
      // Same marker as the standalone variant: the goal analyses bytecode and does not
      // compile, so an unbuilt module has nothing to look at.
      requires: "target/classes",
      outputFile: "target/spotbugsXml.xml",
      allowNonZeroExit: true,
    },
  ],
};

const nextjs: Profile = {
  language: "typescript",
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  tools: [
    {
      // Type errors are facts. tsc is project-wide, so its findings get diff-filtered
      // like everything else rather than being limited to the changed files up front.
      name: "tsc",
      bin: "npx",
      // --locale en pins the diagnostic text. Without it the messages follow the machine's
      // locale, and environmentMessages below matches on that text.
      args: () => ["tsc", "--noEmit", "--pretty", "false", "--locale", "en"],
      format: "tsc-text",
      tier: "fact",
      allowNonZeroExit: true,
      requires: "tsconfig.json",
      // Every one of these means "this checkout was never installed / configured", not
      // "this PR is wrong". Without dependencies on disk tsc reports one per import, plus
      // a cascade of lib errors once an unresolvable `extends` drops it back to the ES5
      // defaults — hundreds of high-severity fact-tier comments about the environment.
      environmentRules: [
        "TS2307", // Cannot find module 'x' or its corresponding type declarations
        "TS2792", // Cannot find module 'x'. Did you mean to set 'moduleResolution'…
        "TS2503", // Cannot find namespace 'NodeJS' — needs @types/node
        "TS2688", // Cannot find type definition file for 'x'
        "TS7016", // Could not find a declaration file for module 'x'
        "TS2580", // Cannot find name 'process' — needs @types/node
        "TS2591", // Cannot find name 'Buffer' — needs @types/node
        "TS2583", // Cannot find name 'Set' — change the target library
        "TS2584", // Cannot find name 'document' — change the target library
        "TS2318", // Cannot find global type 'x'
        "TS2468", // Cannot find global value 'Promise'
        "TS2705", // async in ES5 requires the Promise constructor
        "TS6053", // File 'x' not found — usually an unresolvable tsconfig `extends`
        "TS5083", // Cannot read file 'x'
      ],
      // TS2307 and TS2792 are the same failure under different config, and which one you get
      // is not something a rule list can predict — a list built from one repo's output
      // misses the other. Match the message family too. Deliberately NOT matching the bare
      // "Cannot find name 'x'" (TS2304): that also fires for a genuine undeclared
      // identifier, and discarding the run on it would suppress a real defect. The specific
      // @types/lib variants above cover the environment side of that message.
      environmentMessages:
        /^(Cannot find module|Cannot find namespace|Cannot find type definition file|Could not find a declaration file|Cannot find lib definition|File '.*' not found|Cannot read file)/,
    },
    {
      name: "eslint",
      bin: "npx",
      args: (files) => ["eslint", "--format", "json", "--no-color", ...files],
      format: "eslint-json",
      tier: "triage",
      allowNonZeroExit: true,
    },
  ],
  // Formatting rules — Prettier/Biome own these.
  ignoreRules: [
    "prettier/prettier",
    "indent",
    "quotes",
    "semi",
    "comma-dangle",
    "max-len",
    "object-curly-spacing",
  ],
};

export const PROFILES: Profile[] = [python, java, nextjs];

/** Profiles whose extensions appear among the changed files. */
export function selectProfiles(changedPaths: string[]): Profile[] {
  const exts = new Set(
    changedPaths.map((p) => {
      const i = p.lastIndexOf(".");
      return i < 0 ? "" : p.slice(i).toLowerCase();
    }),
  );
  return PROFILES.filter((p) => p.extensions.some((e) => exts.has(e)));
}

export function filesForProfile(profile: Profile, changedPaths: string[]): string[] {
  return changedPaths.filter((p) => profile.extensions.some((e) => p.toLowerCase().endsWith(e)));
}
