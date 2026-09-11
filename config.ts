// Central config (SSOT: every threshold, endpoint and param is defined only here).
// Loads the tool's own .env without overriding existing env vars, and records where each
// value came from — see the provenance block for the four bugs that cost.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// prloop's own dir (independent of cwd).
export const PRLOOP_ROOT = __dirname;

export const DOTENV_PATH = path.join(PRLOOP_ROOT, ".env");

// --- Known-key registry ---------------------------------------------------------------
// Every PRR_* knob prloop reads, in ONE list, so that four questions have one answer:
// which settings exist (`prloop --config`), is this name real (the typo warning at
// startup), is it a secret (redaction at every egress), and is it documented (the selftest
// checks .env.example and the README table against this list). A knob read anywhere else
// is invisible to all four — which is why the five that used to be read in libs/proxy.ts
// and libs/rules.ts are declared here and imported from there.
export type ConfigKind = "string" | "number" | "bool" | "json" | "csv";

export interface ConfigKey {
  name: string;
  kind: ConfigKind;
  /** Grouping for the --config table; mirrors the sections in .env.example. */
  section: string;
  /** Never printed, logged or written to runs/ — shown as [REDACTED]. */
  secret?: true;
  /** Diagnostic-only; exempt from the .env.example / README documentation check. */
  internal?: true;
  description: string;
}

const S_ADO = "Azure DevOps";
const S_MODEL = "Model endpoint";
const S_RUNNER = "Runner";
const S_FINDER = "Finder";
const S_BUDGET = "Diff / token budget";
const S_SKEPTIC = "Adversarial verification";
const S_STATIC = "Static analysis";
const S_REQ = "Requirement axis";
const S_NOISE = "Noise control";
const S_PUBLISH = "Publishing";
const S_NET = "Corporate network";
const S_DIAG = "Diagnostics";

export const KNOWN_KEYS: readonly ConfigKey[] = [
  { name: "PRR_ADO_PAT", kind: "string", section: S_ADO, secret: true, description: "PAT with Code (Read & Write); empty = az login" },
  { name: "PRR_AUTH_MODE", kind: "string", section: S_ADO, description: "auto | pat | azcli" },
  { name: "PRR_AZ_BIN", kind: "string", section: S_ADO, description: "az CLI executable, when it is not on PATH" },
  { name: "PRR_ADO_BASE_URL", kind: "string", section: S_ADO, description: "only when the API host differs from the browser host" },
  { name: "PRR_ADO_API_VERSION", kind: "string", section: S_ADO, description: "on-prem: 2019=5.0, 2020=6.0, 2022=7.0" },
  { name: "PRR_ADO_TIMEOUT_MS", kind: "number", section: S_ADO, description: "per-request deadline for ADO REST calls" },
  { name: "PRR_ADO_MAX_RETRIES", kind: "number", section: S_ADO, description: "attempts for a transient ADO failure" },
  { name: "PRR_ADO_CONCURRENCY", kind: "number", section: S_ADO, description: "parallel blob fetches during intake" },

  { name: "PRR_LLM_BASE_URL", kind: "string", section: S_MODEL, description: "OpenAI-compatible endpoint (LiteLLM / vLLM / Ollama)" },
  { name: "PRR_LLM_API_KEY", kind: "string", section: S_MODEL, secret: true, description: "key for that endpoint" },
  { name: "PRR_FINDER_MODELS", kind: "csv", section: S_MODEL, description: "code-axis fleet; different families is the point" },
  { name: "PRR_REQ_MODEL", kind: "string", section: S_MODEL, description: "requirement axis model (default: first finder)" },
  { name: "PRR_LLM_TIMEOUT_MS", kind: "number", section: S_MODEL, description: "deadline for one model call" },
  { name: "PRR_LLM_CONCURRENCY", kind: "number", section: S_MODEL, description: "in-flight model calls across all stages; 0 = no cap" },
  { name: "PRR_LLM_RETRIES", kind: "number", section: S_MODEL, description: "retries on transient model failures (never on 4xx)" },
  { name: "PRR_LLM_TEMPERATURE", kind: "string", section: S_MODEL, description: "sampling temperature, or none to omit the field" },
  { name: "PRR_LLM_TEMPERATURE_BY_MODEL", kind: "json", section: S_MODEL, description: "JSON model -> temperature (number or \"none\")" },
  { name: "PRR_LLM_MAX_TOKENS", kind: "number", section: S_MODEL, description: "output budget; thinking models need 16384+" },
  { name: "PRR_REASONING", kind: "string", section: S_MODEL, description: "none | low | medium | high; unset = backend default" },
  { name: "PRR_REASONING_BY_MODEL", kind: "json", section: S_MODEL, description: "JSON model -> reasoning level for that model" },
  { name: "PRR_LLM_API_FLAVOR", kind: "string", section: S_MODEL, description: "auto | openai | anthropic | qwen | ollama" },
  { name: "PRR_LLM_STALL_TIMEOUT_MS", kind: "number", section: S_MODEL, description: "abort a stream gone silent this long; 0 = off" },
  { name: "PRR_LLM_STRUCTURED", kind: "bool", section: S_MODEL, description: "0 = do not send response_format" },
  { name: "PRR_LLM_STREAM", kind: "bool", section: S_MODEL, description: "0 = buffered completions (a gateway may 504 them)" },
  { name: "PRR_LLM_EXTRA_BODY", kind: "json", section: S_MODEL, description: "JSON merged into every model request body" },
  { name: "PRR_LLM_EXTRA_BODY_BY_MODEL", kind: "json", section: S_MODEL, description: "per-model override of the above ({} = send none)" },

  { name: "PRR_RUNNER", kind: "string", section: S_RUNNER, description: "openai | opencode" },
  { name: "PRR_OPENCODE_BIN", kind: "string", section: S_RUNNER, description: "opencode executable" },
  { name: "PRR_OPENCODE_AGENT", kind: "string", section: S_RUNNER, description: "opencode agent definition to drive" },
  { name: "PRR_OPENCODE_JSON", kind: "bool", section: S_RUNNER, description: "0 = drop --format json (loses tracing)" },
  { name: "PRR_AGENT_TIMEOUT_MS", kind: "number", section: S_RUNNER, description: "wall clock for one opencode session" },

  { name: "PRR_FINDER_PROMPT_SUFFIX_BY_MODEL", kind: "json", section: S_FINDER, description: "JSON model -> stance text for that finder's prompt" },
  { name: "PRR_FINDER_SEED", kind: "number", section: S_FINDER, description: "file-order shuffle seed; unset = fresh per run" },
  { name: "PRR_RULES_DIR", kind: "string", section: S_FINDER, description: "reviewer rules dir (default: the tool's own rules/)" },

  { name: "PRR_MAX_DIFF_CHARS", kind: "number", section: S_BUDGET, description: "ceiling on the diff sent to a finder" },
  { name: "PRR_CONTEXT_TOKENS", kind: "number", section: S_BUDGET, description: "model context window; 0 = char ceiling only" },
  { name: "PRR_CONTEXT_TOKENS_BY_MODEL", kind: "json", section: S_BUDGET, description: "JSON model -> that model's context window" },
  { name: "PRR_HUNK_CONTEXT_BEFORE", kind: "number", section: S_BUDGET, description: "context lines kept before each hunk" },
  { name: "PRR_HUNK_CONTEXT_AFTER", kind: "number", section: S_BUDGET, description: "context lines kept after each hunk" },
  { name: "PRR_MAX_FILE_BYTES", kind: "number", section: S_BUDGET, description: "files larger than this are diffed, never sent whole" },
  { name: "PRR_STRICT_COVERAGE", kind: "bool", section: S_BUDGET, description: "0 = files nobody read no longer make the run incomplete" },

  { name: "PRR_SKEPTIC_MODELS", kind: "csv", section: S_SKEPTIC, description: "verifiers; empty = no verification runs" },
  { name: "PRR_SKEPTIC_ROUNDS", kind: "number", section: S_SKEPTIC, description: "verifiers per finding; capped at the distinct model count" },
  { name: "PRR_SKEPTIC_CONTEXT_LINES", kind: "number", section: S_SKEPTIC, description: "source lines shown around the finding" },
  { name: "PRR_SKEPTIC_TIMEOUT_MS", kind: "number", section: S_SKEPTIC, description: "deadline per verdict (tighter than a finder's)" },
  { name: "PRR_SKEPTIC_MAX_TOKENS", kind: "number", section: S_SKEPTIC, description: "output budget per verdict" },
  { name: "PRR_MAX_SKEPTIC_FINDINGS", kind: "number", section: S_SKEPTIC, description: "fan-out ceiling; worst findings verified first" },
  { name: "PRR_MIN_CONSENSUS_SOURCES", kind: "number", section: S_SKEPTIC, description: "independent finders needed to publish unverified" },
  { name: "PRR_REQUIRE_CORROBORATION", kind: "bool", section: S_SKEPTIC, description: "0 = publish single-source unverified findings" },

  { name: "PRR_WORKDIR", kind: "string", section: S_STATIC, description: "checkout of the PR source branch; unset = gate skips" },
  { name: "PRR_WORKTREE_REPO", kind: "string", section: S_STATIC, description: "clone to cut a throwaway worktree from" },
  { name: "PRR_WORKTREE_SETUP_CMD", kind: "string", section: S_STATIC, description: "install command run in a fresh worktree" },
  { name: "PRR_WORKTREE_SETUP_TIMEOUT_MS", kind: "number", section: S_STATIC, description: "deadline for the worktree install command" },
  { name: "PRR_SKIP_STATIC", kind: "bool", section: S_STATIC, description: "1 = skip static analysis entirely" },
  { name: "PRR_STATIC_TIMEOUT_MS", kind: "number", section: S_STATIC, description: "deadline for one linter invocation" },
  { name: "PRR_TRIAGE_MODEL", kind: "string", section: S_STATIC, description: "judges high-FP tools; unset = those are dropped" },
  { name: "PRR_TRIAGE_CONTEXT_LINES", kind: "number", section: S_STATIC, description: "source lines shown to the triage model" },
  { name: "PRR_MAX_TRIAGE_ITEMS", kind: "number", section: S_STATIC, description: "ceiling on tool findings sent to triage" },

  { name: "PRR_SKIP_REQUIREMENT", kind: "bool", section: S_REQ, description: "1 = skip the requirement axis" },
  { name: "PRR_MAX_EXTRAS", kind: "number", section: S_REQ, description: "cap on reported out-of-scope changes" },

  { name: "PRR_EXCLUDE_CATEGORIES", kind: "csv", section: S_NOISE, description: "finding categories never reported" },
  { name: "PRR_LEARN_FROM_DISMISSALS", kind: "bool", section: S_NOISE, description: "0 = re-post findings a human dismissed" },
  { name: "PRR_DISMISSAL_HINT_THRESHOLD", kind: "number", section: S_NOISE, description: "dismissals before the summary suggests excluding" },

  { name: "PRR_MAX_INLINE_COMMENTS", kind: "number", section: S_PUBLISH, description: "code-axis inline comment budget" },
  { name: "PRR_MAX_INLINE_REQ_COMMENTS", kind: "number", section: S_PUBLISH, description: "requirement-axis inline comment budget" },
  { name: "PRR_MIN_INLINE_SEVERITY", kind: "string", section: S_PUBLISH, description: "critical | high | medium | low; below = summary only" },
  { name: "PRR_DRY_RUN", kind: "bool", section: S_PUBLISH, description: "1 = compute everything, post nothing" },
  { name: "PRR_POST_STATUS", kind: "bool", section: S_PUBLISH, description: "1 = also post a PR status" },
  { name: "PRR_STATUS_GENRE", kind: "string", section: S_PUBLISH, description: "genre of that status" },
  { name: "PRR_STATUS_NAME", kind: "string", section: S_PUBLISH, description: "name of that status" },

  { name: "PRR_CA_CERTS", kind: "csv", section: S_NET, description: "CA bundle(s) to trust on a TLS-intercepting network" },
  { name: "PRR_HTTPS_PROXY", kind: "string", section: S_NET, description: "overrides HTTPS_PROXY from the shell" },
  { name: "PRR_HTTP_PROXY", kind: "string", section: S_NET, description: "overrides HTTP_PROXY from the shell" },
  { name: "PRR_NO_PROXY", kind: "csv", section: S_NET, description: "hosts that bypass the proxy (overrides NO_PROXY)" },
  { name: "PRR_USER_AGENT", kind: "string", section: S_NET, description: "User-Agent, for proxies that filter CONNECT by it" },

  { name: "PRR_QUIET", kind: "bool", section: S_DIAG, description: "1 = drop the verbose log lines" },
  { name: "PRR_RUNS_DIR", kind: "string", section: S_DIAG, description: "artifacts root (default: the tool's own runs/)" },
  { name: "PRR_RUNS_KEEP", kind: "number", section: S_DIAG, description: "iteration dirs kept per PR; 0 = keep every one" },
  { name: "PRR_RUNS_MAX_AGE_DAYS", kind: "number", section: S_DIAG, description: "also delete iteration dirs older than N days; 0 = off" },
  { name: "PRR_SHOW_CONFIG", kind: "bool", section: S_DIAG, description: "1 = print this table and exit, same as --config" },
];

const BY_NAME = new Map(KNOWN_KEYS.map((k) => [k.name, k]));

export function knownKey(name: string): ConfigKey | undefined {
  return BY_NAME.get(name);
}

/** Whether a value must be replaced by [REDACTED] before it is printed or saved. */
export function isSecret(name: string): boolean {
  return BY_NAME.get(name)?.secret === true;
}

// --- .env loader and provenance ---------------------------------------------------------
// .env NEVER overrides a variable already exported in the shell. That is deliberate (CI
// injects real values and must win), but it is also the single footgun that cost four
// debugging sessions in one month: a stale `export PRR_LLM_MAX_TOKENS=32768` in a shell
// profile silently beat the file, the same mechanism resurrected thinking via
// PRR_LLM_EXTRA_BODY, and a model name looked "ignored". Nothing in a normal run said which
// value won or where it came from. So the loader now records that, and loop.ts, doctor.ts
// and every run's config.json report it.
export type ConfigSource = "shell" | ".env" | "default";

export interface ConfigEntry {
  name: string;
  source: ConfigSource;
  /** The value prloop will actually read. */
  value: string;
  /** What .env said — present only when a shell export shadowed it. */
  fileValue?: string;
}

/**
 * Parses one .env file into key → value. Exported for tests; the loader below applies it.
 *
 * Two rules learned from real files. `export FOO=bar`, pasted straight out of a shell
 * profile, assigns FOO — not a variable named "export FOO", which is what it used to do
 * (silently, since an unknown name configures nothing). And in an unquoted value a trailing
 * ` # comment` is a comment: `PRR_FINDER_MODELS=a,b # note` configures two models, not one
 * named "b # note" that every model call then 404s on. A `#` with no space before it is
 * part of the value (passwords contain them), and inside quotes everything is literal.
 * The FIRST occurrence of a key wins, which is also what bin/prloop's `head -1` does — the
 * two must not disagree about which line configured the CA bundle.
 */
export function parseDotEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    let s = line.trim();
    if (!s || s.startsWith("#")) continue;
    if (s.startsWith("export ")) s = s.slice("export ".length).trim();
    const i = s.indexOf("=");
    if (i <= 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    const quoted = /^(['"])([\s\S]*)\1\s*(?:#.*)?$/.exec(v);
    if (quoted) v = quoted[2] ?? "";
    else v = v.replace(/\s+#.*$/, "").trim();
    if (!out.has(k)) out.set(k, v);
  }
  return out;
}

/** Applies the file's values, never overwriting one the shell already set. Pure, for tests. */
export function applyDotEnv(values: ReadonlyMap<string, string>, env: NodeJS.ProcessEnv): void {
  for (const [k, v] of values) if (env[k] === undefined) env[k] = v;
}

/** Keys .env sets that an exported shell variable already decided. Pure, for tests. */
export function findShadowed(
  fileValues: ReadonlyMap<string, string>,
  shellValues: ReadonlyMap<string, string>,
): ConfigEntry[] {
  const out: ConfigEntry[] = [];
  for (const [name, fileValue] of fileValues) {
    const shell = shellValues.get(name);
    // Same value on both sides is not a conflict: nothing was lost, so nothing to report.
    if (shell === undefined || shell === fileValue) continue;
    out.push({ name, source: "shell", value: shell, fileValue });
  }
  return out;
}

const FILE_VALUES = new Map<string, string>();
const SHELL_VALUES = new Map<string, string>();

(function loadDotEnv() {
  if (fs.existsSync(DOTENV_PATH)) {
    for (const [k, v] of parseDotEnv(fs.readFileSync(DOTENV_PATH, "utf8"))) FILE_VALUES.set(k, v);
  }
  // The snapshot must be taken BEFORE the file is applied: afterwards nothing distinguishes
  // a value the shell exported from one this loader just set, and that distinction is the
  // whole question a provenance report answers.
  const interesting = new Set([
    ...FILE_VALUES.keys(),
    ...Object.keys(process.env).filter((n) => n.startsWith("PRR_")),
  ]);
  for (const k of interesting) {
    const v = process.env[k];
    if (v !== undefined) SHELL_VALUES.set(k, v);
  }
  applyDotEnv(FILE_VALUES, process.env);
})();

/** Where one variable's effective value came from. Works for any name, registry or not. */
export function entryFor(name: string): ConfigEntry {
  const fileValue = FILE_VALUES.get(name);
  const shell = SHELL_VALUES.get(name);
  const live = process.env[name];
  // Source comes from the load-time snapshot, never from comparing values now: a shell
  // export that happens to agree with .env still came from the shell. A variable that only
  // appears later (the CLI exports PRR_DRY_RUN for --dry-run) is an environment value too.
  const source: ConfigSource =
    shell !== undefined ? "shell" : fileValue !== undefined ? ".env" : live !== undefined ? "shell" : "default";
  const shadowed = source === "shell" && fileValue !== undefined && fileValue !== live;
  return { name, source, value: live ?? "", ...(shadowed ? { fileValue } : {}) };
}

/** Every registry key with its effective value and where it came from. */
export function configReport(): ConfigEntry[] {
  return KNOWN_KEYS.map((k) => entryFor(k.name));
}

/** Keys .env tried to set that an exported shell variable shadowed. */
export function shadowedKeys(): ConfigEntry[] {
  return findShadowed(FILE_VALUES, SHELL_VALUES);
}

/**
 * PRR_* names in the environment or .env that prloop does not read. Almost always a typo:
 * the misspelling configures nothing and, before this, said nothing either.
 */
export function unknownKeys(): string[] {
  const out = new Set<string>();
  for (const n of [...FILE_VALUES.keys(), ...Object.keys(process.env)]) {
    if (n.startsWith("PRR_") && !BY_NAME.has(n)) out.add(n);
  }
  return [...out].sort();
}

/**
 * First non-empty value among `names`, each also tried in its lower- and upper-case
 * spelling (the conventional proxy variables come both ways).
 */
export function envAny(names: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  for (const n of names) {
    const v = env[n] ?? env[n.toLowerCase()] ?? env[n.toUpperCase()];
    if (v && v.trim()) return v.trim();
  }
  return "";
}

// --- Readers -----------------------------------------------------------------------------
// Every reader records the built-in default it was given. A --config row that says "default"
// without saying WHICH value that is answers half the question, and a hand-written second
// list of defaults would drift the first time one changed — so the readers are the source.
const DEFAULTS = new Map<string, string>();

/** The built-in default for a knob nothing set, when the reader recorded one. */
export function defaultOf(name: string): string | undefined {
  return DEFAULTS.get(name);
}

/** A string knob. */
export function strEnv(name: string, def: string): string {
  DEFAULTS.set(name, def);
  return process.env[name] ?? def;
}

/** A knob that is OFF unless explicitly set to 1. */
export function flagEnv(name: string): boolean {
  DEFAULTS.set(name, "0");
  return process.env[name] === "1";
}

/** A knob that is ON unless explicitly set to 0 (any other value, blank included, is on). */
export function switchEnv(name: string): boolean {
  DEFAULTS.set(name, "1");
  return process.env[name] !== "0";
}

// Numeric env vars fail fast on garbage. `Number("ten")` is NaN, and NaN silently
// disables whatever it configures: a NaN comment cap slices zero comments, a NaN
// skeptic-rounds spawns zero verifiers, and nothing ever says why. Exiting with the
// variable's name beats both.
export function numEnv(name: string, def: number, min = 0): number {
  DEFAULTS.set(name, String(def));
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    console.error(`FATAL: ${name}=${raw} is not a valid number (must be >= ${min})`);
    process.exit(1);
  }
  return n;
}

export function enumEnv<T extends string>(name: string, def: T, allowed: readonly T[]): T {
  DEFAULTS.set(name, def);
  const raw = (process.env[name] ?? def) as T;
  if (!allowed.includes(raw)) {
    console.error(`FATAL: ${name}=${raw} is not one of: ${allowed.join(", ")}`);
    process.exit(1);
  }
  return raw;
}

// --- Azure DevOps ---
// PAT with vso.code_write (threads) + vso.work (work items). In a pipeline you can
// instead pass $(System.AccessToken); both go into the same Basic auth header.
export const ADO_PAT = process.env.PRR_ADO_PAT ?? process.env.SYSTEM_ACCESSTOKEN ?? "";
// auto = use a PAT if configured, otherwise mint a token via the az CLI.
export const ADO_AUTH_MODE = enumEnv("PRR_AUTH_MODE", "auto", ["auto", "pat", "azcli"] as const);
export const AZ_BIN = strEnv("PRR_AZ_BIN", "az");
// Normally left empty: the collection base is derived from the PR URL, which is the only
// thing that works across cloud, visualstudio.com and on-prem (virtual directory +
// collection). Set this only when the API host differs from the browser host.
export const ADO_BASE_URL = strEnv("PRR_ADO_BASE_URL", "");
export const ADO_API_VERSION = strEnv("PRR_ADO_API_VERSION", "7.1");
export const ADO_TIMEOUT_MS = numEnv("PRR_ADO_TIMEOUT_MS", 60_000, 1000);
// TOTAL attempts per ADO request, not extra ones: 3 = the first try plus 2 retries, and 1
// disables retrying. The opposite of PRR_LLM_RETRIES, which counts EXTRA attempts — both
// published knobs, so the names stay and the semantics are spelled out in both places.
export const ADO_MAX_RETRIES = numEnv("PRR_ADO_MAX_RETRIES", 3, 1);
// Blob fetches in flight at once during intake (ADO rate-limits aggressive parallelism).
export const ADO_CONCURRENCY = numEnv("PRR_ADO_CONCURRENCY", 6, 1);

// --- Corporate network ---
// CA bundle(s) to trust, for networks with TLS interception. Comma-separated; a root and
// its intermediate often arrive as separate files. Loaded by libs/tls.ts and attached to
// the undici dispatcher at runtime, so it applies to every entry point regardless of how
// the process was started (see the note there on why NODE_EXTRA_CA_CERTS is not enough).
export const CA_CERTS = strEnv("PRR_CA_CERTS", "");
// Proxy settings, read here rather than in libs/proxy.ts so that the registry above covers
// them: a knob read outside this file has no provenance, no typo check and no --config row.
//
// The PRR_-prefixed value wins over the conventional one. The .env loader never overwrites
// an existing environment variable, so on a machine that already exports HTTPS_PROXY —
// which is most corporate machines — writing it in .env has no effect and no error. Giving
// prloop its own names makes .env a reliable place to override the inherited setting,
// rather than a file whose contents silently do nothing.
export const HTTPS_PROXY = envAny(["PRR_HTTPS_PROXY", "HTTPS_PROXY", "https_proxy"]);
export const HTTP_PROXY = envAny(["PRR_HTTP_PROXY", "HTTP_PROXY", "http_proxy"]);
export const NO_PROXY = envAny(["PRR_NO_PROXY", "NO_PROXY", "no_proxy"]);
// Some corporate proxies filter CONNECT by User-Agent — allowing browsers and git while
// refusing anything unfamiliar with a 403 — and on such a network this is the escape hatch
// (e.g. the exact string your git sends). Empty = libs/proxy.ts builds prloop's own honest
// UA from the package version; a policy workaround is for the operator to choose.
export const USER_AGENT_OVERRIDE = strEnv("PRR_USER_AGENT", "");

// --- Runner ---
// openai   = direct HTTP to an OpenAI-compatible endpoint. Supports engine-level guided
//            decoding (vLLM/xgrammar), which is what makes weak models emit valid JSON.
// opencode = drive models through the opencode CLI, inheriting its provider config.
//            NOTE: response_format is not passed through, so schemas are prompt-level only.
export const RUNNER_KIND = enumEnv("PRR_RUNNER", "openai", ["openai", "opencode"] as const);
export const OPENCODE_BIN = strEnv("PRR_OPENCODE_BIN", "opencode");
// The agent definition prloop drives. Installed by `npm run setup`; must have every tool
// disabled — the review context is fully injected, and there is no local checkout to read.
export const OPENCODE_AGENT = strEnv("PRR_OPENCODE_AGENT", "prloop-reviewer");
// 0 = drop --format json (fallback for opencode builds without JSONL events; loses tracing).
export const OPENCODE_JSON_EVENTS = switchEnv("PRR_OPENCODE_JSON");
// Wall-clock timeout for one opencode session.
export const AGENT_TIMEOUT_MS = numEnv("PRR_AGENT_TIMEOUT_MS", 15 * 60 * 1000, 1000);

// --- Model access (OpenAI-compatible: LiteLLM proxy, vLLM, Ollama /v1) ---
export const LLM_BASE_URL = strEnv("PRR_LLM_BASE_URL", "http://localhost:4000/v1");
export const LLM_API_KEY = strEnv("PRR_LLM_API_KEY", "dummy");
export const LLM_TIMEOUT_MS = numEnv("PRR_LLM_TIMEOUT_MS", 900_000, 1000);
// Silence a streamed response may go before the call is abandoned. The per-call deadline
// above covers the WHOLE call, so an engine that dies without closing the socket costs the
// full 900s — and the retry costs another 900s. Bytes arriving reset this timer, so a slow
// generation is never cut; only a dead one is. 0 = disabled (rely on the deadline alone).
export const LLM_STALL_TIMEOUT_MS = numEnv("PRR_LLM_STALL_TIMEOUT_MS", 120_000, 0);
// Model calls in flight at once, across every stage. The skeptic fans out over every
// anchored finding, so an uncapped run can put dozens of requests on a self-hosted endpoint
// simultaneously; they then queue in the engine while their own timeouts run down. 0 = no cap.
export const LLM_CONCURRENCY = numEnv("PRR_LLM_CONCURRENCY", 6);
// EXTRA attempts on top of the first for a model call that failed for a TRANSIENT reason
// (timeout, socket error, 429, 5xx): 1 = up to two calls in total, 0 disables retrying.
// Note the asymmetry with PRR_ADO_MAX_RETRIES, which counts TOTAL attempts.
// Inference is a read-only operation, so a retry is always safe. A 4xx schema or auth
// rejection is deterministic and is never retried.
// Without this, one flaky verifier call silently deletes an inline comment: its finding
// stays single-source, fails the corroboration gate, and drops to the summary.
export const LLM_RETRIES = numEnv("PRR_LLM_RETRIES", 1);
// M1 runs a single finder; M3 turns this into a comma-separated heterogeneous fleet.
export const FINDER_MODELS = strEnv("PRR_FINDER_MODELS", "qwen3-coder")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Requirement axis model. Defaults to the first finder model; set separately when you want
// a stronger model on requirements (long acceptance criteria stress weak models).
export const REQ_MODEL = strEnv("PRR_REQ_MODEL", FINDER_MODELS[0] ?? "");
/**
 * Sampling temperature, or the sentinel "none" meaning "do not send the field at all".
 *
 * The sentinel exists because `temperature` is not universally accepted any more: newer
 * Anthropic models reject it outright, OpenAI's reasoning models reject it, and Anthropic
 * extended thinking demands exactly 1. Before this, prloop always sent one (0.2, or a
 * hard-coded 0 in the requirement gate) and its own fields overwrote PRR_LLM_EXTRA_BODY —
 * so on those backends every single call was a 400 with no way to configure the field away.
 * Exported for tests; throws on garbage so it fails at startup, not per call.
 */
export type Temperature = number | "none";

export function parseTemperature(raw: string | undefined, def: Temperature): Temperature {
  const s = (raw ?? "").trim();
  if (s === "") return def;
  if (s.toLowerCase() === "none") return "none";
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${raw} is not a number or "none"`);
  return n;
}

export function parseTemperatureByModel(raw: string | undefined): Record<string, Temperature> | undefined {
  const parsed = parseObjectEnv(raw, '{"claude-sonnet":"none","qwen3-coder":0.2}');
  if (parsed === undefined) return undefined;
  const out: Record<string, Temperature> = {};
  for (const [model, v] of Object.entries(parsed)) {
    if (typeof v === "number") {
      if (!Number.isFinite(v) || v < 0) throw new Error(`entry "${model}" must be a non-negative number or "none"`);
      out[model] = v;
    } else if (typeof v === "string" && v.trim().toLowerCase() === "none") {
      out[model] = "none";
    } else {
      throw new Error(`entry "${model}" must be a number or "none"`);
    }
  }
  return out;
}

export const LLM_TEMPERATURE: Temperature = (() => {
  try {
    return parseTemperature(strEnv("PRR_LLM_TEMPERATURE", "0.2"), 0.2);
  } catch (e) {
    console.error(`FATAL: PRR_LLM_TEMPERATURE ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
})();

// Per-model override: one Anthropic model in a fleet may need the field gone while the
// rest keep sampling normally. An entry wins over the global for that model only.
export const LLM_TEMPERATURE_BY_MODEL: Record<string, Temperature> | undefined = (() => {
  try {
    return parseTemperatureByModel(strEnv("PRR_LLM_TEMPERATURE_BY_MODEL", ""));
  } catch (e) {
    console.error(`FATAL: PRR_LLM_TEMPERATURE_BY_MODEL ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
})();

/** The temperature policy for one model's calls. */
export function temperatureFor(model: string): Temperature {
  return LLM_TEMPERATURE_BY_MODEL?.[model] ?? LLM_TEMPERATURE;
}
export const LLM_MAX_TOKENS = numEnv("PRR_LLM_MAX_TOKENS", 8192, 256);
// 0 = don't send response_format (for backends whose schema support is broken).
export const LLM_STRUCTURED_OUTPUT = switchEnv("PRR_LLM_STRUCTURED");
// Streamed (SSE) completions, on by default. A buffered completion sends ZERO bytes until
// the model finishes, and on a long generation that multi-minute silence outlives the idle
// timeout of whatever sits between prloop and the engine (nginx in front of vLLM, a
// LiteLLM proxy, a corporate gateway) — the hop gives up with a 504 long before
// PRR_LLM_TIMEOUT_MS ever fires. Streaming keeps bytes flowing from the first token, so no
// intermediary sees an idle connection; the response is still assembled and returned
// whole. 0 = buffered requests (the old behaviour), for backends whose SSE is broken.
export const LLM_STREAM = switchEnv("PRR_LLM_STREAM");
/**
 * Parses PRR_LLM_EXTRA_BODY: a JSON object merged into every model request body, for
 * engine-specific knobs prloop has no first-class flag for. Exported for tests; the const
 * below turns a parse failure into a startup fatal, because the alternative is a
 * mysterious HTTP 400 on every single model call mid-run.
 */
export function parseExtraBody(raw: string | undefined): Record<string, unknown> | undefined {
  return parseObjectEnv(raw, '{"chat_template_kwargs":{"enable_thinking":false}}');
}

// Shared shape check for the JSON-object env vars: unset/blank = undefined, malformed JSON
// throws, and anything that parses but is not an object (an array, a bare string) is
// rejected with an example of the expected shape — a `[]` accepted here would surface as a
// mysterious failure on every call, not at startup where the operator is looking.
function parseObjectEnv(raw: string | undefined, example: string): Record<string, unknown> | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed: unknown = JSON.parse(raw); // throws on malformed JSON
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`must be a JSON object, e.g. ${example}`);
  }
  return parsed as Record<string, unknown>;
}
// The motivating case: a Qwen3-family finder on vLLM burning its entire token budget on
// chain of thought — {"chat_template_kwargs":{"enable_thinking":false}} switches thinking
// off at the engine. Applies to EVERY call (finder, skeptic, requirement, triage alike);
// PRR_LLM_EXTRA_BODY_BY_MODEL overrides it per model, and PRR_REASONING_BY_MODEL says the
// same thing portably — neither needs the endpoint's own per-alias config any more.
// On a key conflict prloop's own fields always win — every field prloop manages already
// has its own PRR_ knob, so a collision is always a mistake.
export const LLM_EXTRA_BODY: Record<string, unknown> | undefined = (() => {
  try {
    return parseExtraBody(strEnv("PRR_LLM_EXTRA_BODY", ""));
  } catch (e) {
    console.error(`FATAL: PRR_LLM_EXTRA_BODY ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
})();

/**
 * Resolves the extra body for one model: the per-model entry wins when present ({} means
 * "send none"), otherwise the global. Pure and exported for tests; the config consts below
 * feed it at runtime.
 */
export function resolveExtraBody(
  model: string,
  byModel: Record<string, Record<string, unknown>> | undefined,
  global: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const specific = byModel?.[model];
  return specific !== undefined ? specific : global;
}

// Per-model overrides for LLM_EXTRA_BODY: a JSON object keyed by model name, each value
// REPLACING the global for that model. The motivating shape is a mixed fleet: thinking
// disabled globally, re-enabled for the one finder whose depth is worth the runaway risk
// (an empty {} entry = send no extra body, i.e. the engine's default behaviour) and for
// the skeptic. Replacement, not merging — Qwen3's switch is binary, and merge semantics
// would make "which knob won" a puzzle.
export const LLM_EXTRA_BODY_BY_MODEL: Record<string, Record<string, unknown>> | undefined = (() => {
  try {
    const parsed = parseExtraBody(strEnv("PRR_LLM_EXTRA_BODY_BY_MODEL", ""));
    if (parsed === undefined) return undefined;
    for (const [model, body] of Object.entries(parsed)) {
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new Error(`entry "${model}" must be a JSON object (use {} to send none)`);
      }
    }
    return parsed as Record<string, Record<string, unknown>>;
  } catch (e) {
    console.error(`FATAL: PRR_LLM_EXTRA_BODY_BY_MODEL ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
})();

/** The extra body actually sent for a model's calls. */
export function extraBodyFor(model: string): Record<string, unknown> | undefined {
  return resolveExtraBody(model, LLM_EXTRA_BODY_BY_MODEL, LLM_EXTRA_BODY);
}

// --- Reasoning ---------------------------------------------------------------------
/**
 * How much thinking to ask for, as an intent rather than a backend field.
 *
 * The same intent is spelled four incompatible ways — OpenAI `reasoning_effort`, Anthropic
 * `thinking.budget_tokens`, Qwen `chat_template_kwargs.enable_thinking`, Ollama `think` —
 * and until now the only way to reach any of them was raw JSON in PRR_LLM_EXTRA_BODY.
 * Getting that wrong is an HTTP 400 on every call of the run, not a degraded review, and
 * the one shape that a mixed fleet cannot express at all is "thinking here, not there".
 * models/runner.ts owns the translation; this is the vocabulary.
 *
 * Unset (not "none") sends nothing and leaves the backend's own default alone — the
 * behaviour every prloop release so far had.
 */
export type ReasoningLevel = "none" | "low" | "medium" | "high";
export const REASONING_LEVELS = ["none", "low", "medium", "high"] as const;

/** Exported for tests. Throws on an unknown level; blank means unset. */
export function parseReasoning(raw: string | undefined): ReasoningLevel | undefined {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "") return undefined;
  if (!(REASONING_LEVELS as readonly string[]).includes(s)) {
    throw new Error(`${raw} is not one of: ${REASONING_LEVELS.join(", ")}`);
  }
  return s as ReasoningLevel;
}

export function parseReasoningByModel(raw: string | undefined): Record<string, ReasoningLevel> | undefined {
  const parsed = parseObjectEnv(raw, '{"claude-sonnet":"medium","qwen3-coder":"none"}');
  if (parsed === undefined) return undefined;
  const out: Record<string, ReasoningLevel> = {};
  for (const [model, level] of Object.entries(parsed)) {
    if (typeof level !== "string") throw new Error(`entry "${model}" must be a string`);
    const parsedLevel = parseReasoning(level);
    // "" would silently mean "the backend default" for that model, which is what LEAVING
    // THE ENTRY OUT already says; an empty string here is a typo, not an intent.
    if (parsedLevel === undefined) throw new Error(`entry "${model}" must be one of: ${REASONING_LEVELS.join(", ")}`);
    out[model] = parsedLevel;
  }
  return out;
}

export const REASONING: ReasoningLevel | undefined = (() => {
  try {
    return parseReasoning(strEnv("PRR_REASONING", ""));
  } catch (e) {
    console.error(`FATAL: PRR_REASONING ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
})();

// Per-model level, for the fleet shape the global knob cannot express: deep thinking on
// the skeptic, none on the finders that only have to quote code back. An entry wins over
// the global for that model; PRR_LLM_EXTRA_BODY still wins over both (it is the escape
// hatch for anything this vocabulary cannot say).
export const REASONING_BY_MODEL: Record<string, ReasoningLevel> | undefined = (() => {
  try {
    return parseReasoningByModel(strEnv("PRR_REASONING_BY_MODEL", ""));
  } catch (e) {
    console.error(`FATAL: PRR_REASONING_BY_MODEL ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
})();

/** The reasoning level for one model's calls; undefined = send nothing. */
export function reasoningFor(model: string): ReasoningLevel | undefined {
  return REASONING_BY_MODEL?.[model] ?? REASONING;
}

// Which dialect the endpoint speaks, for the reasoning translation above. `auto` infers it
// from the model name, which is right for a LiteLLM proxy fronting several vendors at once
// (where no single answer applies to the whole endpoint); name it explicitly when the
// aliases are house names that say nothing about the family behind them.
export type ApiFlavor = "auto" | "openai" | "anthropic" | "qwen" | "ollama";
export const LLM_API_FLAVOR = enumEnv("PRR_LLM_API_FLAVOR", "auto", [
  "auto",
  "openai",
  "anthropic",
  "qwen",
  "ollama",
] as const);

// --- Finder prompt shaping ---
/**
 * Parses PRR_FINDER_PROMPT_SUFFIX_BY_MODEL: a JSON object mapping a finder model name to
 * text appended to that finder's system prompt. Same fail-fast shape check as the extra-body
 * knobs, but the values must be strings. Exported for tests.
 */
export function parseFinderPromptSuffixes(raw: string | undefined): Record<string, string> | undefined {
  const parsed = parseObjectEnv(raw, '{"qwen3-coder":"Name the exact input or condition under which the quoted line fails."}');
  if (parsed === undefined) return undefined;
  for (const [model, text] of Object.entries(parsed)) {
    if (typeof text !== "string") throw new Error(`entry "${model}" must be a string`);
  }
  return parsed as Record<string, string>;
}
// Per-model stance text, appended to that model's finder system prompt. Model families miss
// the coverage brief in opposite directions: Claude/GPT-class finders self-censor (they
// decide a weak finding is "not worth raising" and return an empty array), Qwen-class
// finders over-report without ever naming the condition under which the code fails. One
// shared prompt cannot lean against both at once, and the correction belongs with the fleet
// configuration — next to PRR_FINDER_MODELS — not in a per-deployment fork of
// prompts/finder.ts. Unknown model names are ignored: the map is consulted, never validated
// against the fleet, so a stale entry costs nothing.
export const FINDER_PROMPT_SUFFIX_BY_MODEL: Record<string, string> | undefined = (() => {
  try {
    return parseFinderPromptSuffixes(strEnv("PRR_FINDER_PROMPT_SUFFIX_BY_MODEL", ""));
  } catch (e) {
    console.error(`FATAL: PRR_FINDER_PROMPT_SUFFIX_BY_MODEL ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
})();

/**
 * Parses PRR_FINDER_SEED: unset/blank = a fresh random seed per run; otherwise a
 * non-negative integer. Exported for tests.
 */
export function parseFinderSeed(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${raw} is not a non-negative integer`);
  return n;
}
// Run seed for the per-finder file-order shuffle (libs/prng.ts). Every finder sees the same
// set of files, each in its own order, so consensus cannot count shared position bias as
// independent agreement — which is why the default is a fresh random seed per run. The
// seed a run used is logged and saved in finder-outputs.json; set this to replay it exactly.
export const FINDER_SEED: number | undefined = (() => {
  try {
    return parseFinderSeed(strEnv("PRR_FINDER_SEED", ""));
  } catch (e) {
    console.error(`FATAL: PRR_FINDER_SEED ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
})();

// Reviewer rules (markdown with an applyTo glob) loaded by libs/rules.ts. Declared here so
// the registry covers it; rules.ts re-exports the resolved path.
export const RULES_DIR = strEnv("PRR_RULES_DIR", path.join(PRLOOP_ROOT, "rules"));

// --- Diff / token budget (PR-Agent style deterministic compression) ---
export const MAX_DIFF_CHARS = numEnv("PRR_MAX_DIFF_CHARS", 240_000, 1000);

// The model's context window, in TOKENS. 0 (the default) = off, and off is exactly what
// every release before this one did: PRR_MAX_DIFF_CHARS counts characters OF THE DIFF
// ONLY. The system prompt, the rules selected for this PR (up to ~29k chars), the reviewed
// repo's injected conventions (12k), the PR description and — on a backend with no
// response_format — the inlined JSON schema all share the window with the diff and were
// never counted; neither was the output budget. Characters are not tokens either: CJK
// costs roughly 2.7x more tokens per character than ASCII, so 240k "safe" characters can
// be 60k+ tokens. Overrun does not raise an error anyone can read — the BACKEND truncates
// the prompt, which cuts the diff mid-hunk and corrupts the very quotes anchoring depends
// on, and the run shows up as findings that mysteriously will not anchor.
export const CONTEXT_TOKENS = numEnv("PRR_CONTEXT_TOKENS", 0);

/**
 * Parses PRR_CONTEXT_TOKENS_BY_MODEL: JSON model -> context window in tokens. Exported for
 * tests; the const below turns a parse failure into a startup fatal.
 */
export function parseContextTokensByModel(raw: string | undefined): Record<string, number> | undefined {
  const parsed = parseObjectEnv(raw, '{"qwen3-coder":131072,"claude-sonnet":200000}');
  if (parsed === undefined) return undefined;
  const out: Record<string, number> = {};
  for (const [model, v] of Object.entries(parsed)) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new Error(`entry "${model}" must be a non-negative whole number of tokens`);
    }
    out[model] = v;
  }
  return out;
}

// Per-model windows: the shape the global knob cannot express. A fleet whose point is
// different model families is also a fleet of different context sizes, and budgeting all of
// them to the smallest wastes the largest — while budgeting to the largest truncates the
// smallest, silently.
export const CONTEXT_TOKENS_BY_MODEL: Record<string, number> | undefined = (() => {
  try {
    return parseContextTokensByModel(strEnv("PRR_CONTEXT_TOKENS_BY_MODEL", ""));
  } catch (e) {
    console.error(`FATAL: PRR_CONTEXT_TOKENS_BY_MODEL ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
})();

/** The context window that applies to one model's calls. 0 = no token budget, chars only. */
export function contextTokensFor(model: string): number {
  return CONTEXT_TOKENS_BY_MODEL?.[model] ?? CONTEXT_TOKENS;
}

// Extra context lines around each hunk. Asymmetric on purpose: preceding context
// carries more meaning for review than trailing context.
export const HUNK_CONTEXT_BEFORE = numEnv("PRR_HUNK_CONTEXT_BEFORE", 6);
export const HUNK_CONTEXT_AFTER = numEnv("PRR_HUNK_CONTEXT_AFTER", 3);
// Files bigger than this are diffed but never sent whole.
export const MAX_FILE_BYTES = numEnv("PRR_MAX_FILE_BYTES", 2_000_000, 1);
// Files the finder never saw make the review incomplete (exit 3): one left out of the
// finder context because the diff ran past PRR_MAX_DIFF_CHARS, or skipped by intake as
// too large to fetch, was not reviewed — and a run that read 30 of 31 files used to exit
// 0 as though it had read all 31. "Nothing found" and "never looked" are different facts;
// only one of them justifies a green gate. 0 = a partial review may still pass. Binary
// files are never counted: there is nothing in them to review.
export const STRICT_COVERAGE = switchEnv("PRR_STRICT_COVERAGE");

// --- Adversarial verification (M3) ---
// Skeptics should be a DIFFERENT model family from the finders. Same-family verifiers share
// the finders' blind spots, so they confirm the errors that matter most.
export const SKEPTIC_MODELS = strEnv("PRR_SKEPTIC_MODELS", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Verifiers per finding. 1 is a single gate; 3 gives a majority vote worth the name — but
// only over 3 DISTINCT models: the gate caps the rounds at the number of configured skeptics,
// because two samples of one model at temperature 0.2 are one opinion counted twice.
export const SKEPTIC_ROUNDS = numEnv("PRR_SKEPTIC_ROUNDS", 1);
// Source lines shown around the finding, on top of the whole hunk it sits in (the window
// shows one side; a claim about a deleted line was uncheckable from it). Small on purpose:
// models degrade with unlimited context, and a skeptic that needs the whole file is guessing
// — it answers "insufficient-context", which kills nothing and clears nothing.
export const SKEPTIC_CONTEXT_LINES = numEnv("PRR_SKEPTIC_CONTEXT_LINES", 25);
// Skeptic calls are small and numerous, so they get a much tighter deadline than a finder
// reading a whole diff. Kept separate because a skeptic timeout fails open: one slow verifier
// must not hold the run for the full finder timeout and then wave the finding through anyway.
export const SKEPTIC_TIMEOUT_MS = numEnv("PRR_SKEPTIC_TIMEOUT_MS", 180_000, 1000);
// Output budget for one verdict. Was a 2048 literal in the gate — small on purpose (a
// refutation that needs a long JSON object is usually one the model is inventing) — but
// a frontier model writing a thorough `reason`, or a gateway that bills thinking to the
// same budget, overran it, and the truncation message then pointed at PRR_LLM_MAX_TOKENS,
// which the skeptic never read. Separate knob, honest message.
export const SKEPTIC_MAX_TOKENS = numEnv("PRR_SKEPTIC_MAX_TOKENS", 4096, 256);
// Ceiling on findings sent to the skeptic per run. The fan-out is findings × rounds and
// was previously unbounded — a pathological PR anchoring 200 findings issued 200
// verification calls. The worst (highest-severity) findings get verified first; the
// overflow is logged, never silently dropped.
export const MAX_SKEPTIC_FINDINGS = numEnv("PRR_MAX_SKEPTIC_FINDINGS", 30, 1);
// Findings need corroboration to be published: either N finders found it independently, or
// a skeptic actively cleared it. A lone unverified finding stays in the summary instead.
export const MIN_CONSENSUS_SOURCES = numEnv("PRR_MIN_CONSENSUS_SOURCES", 2, 1);
// 0 = publish single-source findings that no skeptic examined (looser, noisier).
export const REQUIRE_CORROBORATION = switchEnv("PRR_REQUIRE_CORROBORATION");

// --- Static analysis (M4) ---
// A checkout of the PR's source branch. Linters need files on disk; without this the
// static gate skips. In an Azure pipeline this is the agent's own checkout.
export const WORKDIR = strEnv("PRR_WORKDIR", "");

/**
 * A clone of the reviewed repository. Set it and prloop cuts its own throwaway worktree,
 * detached at the iteration's sourceRefCommit, instead of asking for PRR_WORKDIR.
 *
 * This exists because the manual alternative is wrong more often than it looks: pulling and
 * checking out a branch by name lands on whatever the branch points at NOW, which is not the
 * iteration under review the moment the author pushes again. The static gate compares every
 * file against the iteration's bytes and skips the ones that differ (staleFiles), so a
 * checkout one commit ahead does not fail — it silently analyses less.
 *
 * A worktree rather than a checkout: it leaves the clone's own working copy alone, several
 * can exist at once (one PR list, reviewed in parallel), and it is pinned to a commit rather
 * than tracking a branch.
 */
export const WORKTREE_REPO = strEnv("PRR_WORKTREE_REPO", "");

/**
 * Run once inside a fresh worktree, before any linter. A worktree has no node_modules and no
 * venv, and the fact-tier tools (tsc, mypy) report one error per unresolvable import when
 * dependencies are missing — the failure their environmentRules exist to catch. Unset means
 * the tools run against an uninstalled tree, which for those two means their whole run is
 * discarded with that reason named.
 */
export const WORKTREE_SETUP_CMD = strEnv("PRR_WORKTREE_SETUP_CMD", "");
// An install has no business being unbounded: the case this whole feature is for is a cron
// reviewing a PR list, where one wedged `npm ci` would hold the queue until someone noticed.
export const WORKTREE_SETUP_TIMEOUT_MS = numEnv("PRR_WORKTREE_SETUP_TIMEOUT_MS", 10 * 60 * 1000, 1000);
export const SKIP_STATIC = flagEnv("PRR_SKIP_STATIC");
export const STATIC_TIMEOUT_MS = numEnv("PRR_STATIC_TIMEOUT_MS", 5 * 60 * 1000, 1000);
// Model that judges high-false-positive tool findings. Unset = those findings are dropped
// rather than posted unjudged.
export const TRIAGE_MODEL = strEnv("PRR_TRIAGE_MODEL", "");
export const TRIAGE_CONTEXT_LINES = numEnv("PRR_TRIAGE_CONTEXT_LINES", 12);
// Ceiling on one triage call. A PR that trips 200 lint rules has a lint config problem,
// not a review problem.
export const MAX_TRIAGE_ITEMS = numEnv("PRR_MAX_TRIAGE_ITEMS", 40, 1);

// --- Review axes ---
// 1 = skip the requirement axis entirely.
export const SKIP_REQUIREMENT = flagEnv("PRR_SKIP_REQUIREMENT");
// Ceiling on reported out-of-scope changes. Unbounded extras made the count a per-run
// dice roll (the same diff enumerated at different granularity); the prompt asks for the
// most significant first and the gate slices to this.
export const MAX_EXTRAS = numEnv("PRR_MAX_EXTRAS", 5, 1);

// --- Noise control: exclusions and learnings (M6) ---
// Finding categories dropped from the code axis entirely, before any model verification
// spends tokens on them (claude-code-security-review ships the same knob as its false-
// positive exclusion list). Counted and named in the summary, never silently discarded.
// Applies to finder and static-tool findings; the requirement axis has its own switch
// (PRR_SKIP_REQUIREMENT). Read lazily so tests (and late env changes) see the live value.
export const excludedCategories = (): string[] =>
  strEnv("PRR_EXCLUDE_CATEGORIES", "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
// 0 = ignore recorded human dismissals when deciding what to publish.
export const LEARN_FROM_DISMISSALS = switchEnv("PRR_LEARN_FROM_DISMISSALS");
// Once a repo accumulates this many dismissals in one category, the summary suggests
// excluding the category. A suggestion, never automatic: building exclusion rules from a
// handful of dismissals would overfit (PROPOSAL §10).
export const DISMISSAL_HINT_THRESHOLD = numEnv("PRR_DISMISSAL_HINT_THRESHOLD", 3, 1);

// --- Publishing ---
// Hard cap on inline comments per run. Noise control beats coverage (see PROPOSAL §9.11).
// The two axes get separate budgets on purpose: a shared cap lets code findings crowd out
// "this requirement wasn't implemented", which is usually the more important message.
export const MAX_INLINE_COMMENTS = numEnv("PRR_MAX_INLINE_COMMENTS", 10);
export const MAX_INLINE_REQ_COMMENTS = numEnv("PRR_MAX_INLINE_REQ_COMMENTS", 3);
// Findings below this severity never become inline comments. Validated: an unchecked
// cast let "Medium" (capital M) rank as -1 and silently filter out every comment.
export const MIN_INLINE_SEVERITY = enumEnv("PRR_MIN_INLINE_SEVERITY", "medium", [
  "critical",
  "high",
  "medium",
  "low",
] as const) as Severity;
// 1 = compute everything but post nothing (safe first run against a real PR).
// Read lazily, not captured at import time: the CLI sets this env var after config has
// already been loaded, so a const here would silently ignore --dry-run.
export const isDryRun = (): boolean => flagEnv("PRR_DRY_RUN");
// Called once here for the side effect of registering the default: --config renders the
// table before any stage has asked whether this is a dry run, and a knob missing from that
// table only because nobody read it yet would be the wrong kind of honest.
void isDryRun();
// 1 = also post a PR status (needs a branch policy to actually gate merges).
export const POST_STATUS = flagEnv("PRR_POST_STATUS");
export const STATUS_GENRE = strEnv("PRR_STATUS_GENRE", "prloop");
export const STATUS_NAME = strEnv("PRR_STATUS_NAME", "ai-review");

export const QUIET = flagEnv("PRR_QUIET");
// 1 = print the configuration table and exit, without running a review (same as --config).
// An env var as well as a flag because the case that needs it most is a pipeline, where
// adding a flag means editing YAML but adding a variable does not.
export const SHOW_CONFIG = flagEnv("PRR_SHOW_CONFIG");

// Artifacts root.
export const RUNS_DIR = strEnv("PRR_RUNS_DIR", path.join(PRLOOP_ROOT, "runs"));
// Retention for those artifacts. One run writes the whole finder prompt (up to
// PRR_MAX_DIFF_CHARS), every model's raw output and every skeptic prompt, and nothing used
// to remove any of it — a cron box reviewing the same repo daily grew without bound.
// Iteration directories per PR to keep, newest first; 0 = keep every iteration.
export const RUNS_KEEP = numEnv("PRR_RUNS_KEEP", 20, 0);
// Age ceiling for an iteration directory, in days. 0 = no age limit. Independent of
// PRR_RUNS_KEEP: either rule alone is enough to delete a directory.
export const RUNS_MAX_AGE_DAYS = numEnv("PRR_RUNS_MAX_AGE_DAYS", 0, 0);

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

// Finding categories. Aligned with the taxonomy commercial reviewers converged on
// (CodeRabbit's six content categories), plus three we keep separate on purpose:
//   concurrency    — folded into "reliability" elsewhere, but it's the dominant defect
//                    class in the Java codebases this tool targets, and it needs its own
//                    review lens rather than being diluted into general reliability
//   leftover-code  — debug prints, commented-out blocks, stray TODOs. Only Graphite names
//                    this, and it's consistently one of the highest-acceptance finding types
//   req-mismatch   — reserved for M2: the change doesn't satisfy the linked work item
export const FINDING_CATEGORIES = [
  "correctness",
  "concurrency",
  "security",
  "reliability",
  "data-integrity",
  "performance",
  "maintainability",
  "leftover-code",
  "req-mismatch",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

// What the code-axis finder may emit: everything except req-mismatch, which only the
// requirement axis produces (gates/requirement.ts builds those findings itself, with the
// acceptance criteria in hand). Offering it in the finder's schema invited the code axis to
// guess at requirements it never saw — and the prompt then promised "nine" categories while
// its table listed eight. Schema enum, validator and prompt all derive from this list.
export const FINDER_CATEGORIES = FINDING_CATEGORIES.filter(
  (c): c is Exclude<FindingCategory, "req-mismatch"> => c !== "req-mismatch",
);
export type FinderCategory = (typeof FINDER_CATEGORIES)[number];
