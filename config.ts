// Central config (SSOT: every threshold, endpoint and param is defined only here).
// Loads the tool's own .env without overriding existing env vars.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// prloop's own dir (independent of cwd).
export const PRLOOP_ROOT = __dirname;

// --- Minimal .env loader (PRLOOP_ROOT/.env; never overrides existing env vars) ---
(function loadDotEnv() {
  const p = path.join(PRLOOP_ROOT, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i <= 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
})();


// Numeric env vars fail fast on garbage. `Number("ten")` is NaN, and NaN silently
// disables whatever it configures: a NaN comment cap slices zero comments, a NaN
// skeptic-rounds spawns zero verifiers, and nothing ever says why. Exiting with the
// variable's name beats both.
export function numEnv(name: string, def: number, min = 0): number {
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
export const AZ_BIN = process.env.PRR_AZ_BIN ?? "az";
// CA bundle(s) to trust, for networks with TLS interception. Comma-separated; a root and
// its intermediate often arrive as separate files. Loaded by libs/tls.ts and attached to
// the undici dispatcher at runtime, so it applies to every entry point regardless of how
// the process was started (see the note there on why NODE_EXTRA_CA_CERTS is not enough).
export const CA_CERTS = process.env.PRR_CA_CERTS ?? "";
// Normally left empty: the collection base is derived from the PR URL, which is the only
// thing that works across cloud, visualstudio.com and on-prem (virtual directory +
// collection). Set this only when the API host differs from the browser host.
export const ADO_BASE_URL = process.env.PRR_ADO_BASE_URL ?? "";
export const ADO_API_VERSION = process.env.PRR_ADO_API_VERSION ?? "7.1";
export const ADO_TIMEOUT_MS = numEnv("PRR_ADO_TIMEOUT_MS", 60_000, 1000);
export const ADO_MAX_RETRIES = numEnv("PRR_ADO_MAX_RETRIES", 3, 1);
// Blob fetches in flight at once during intake (ADO rate-limits aggressive parallelism).
export const ADO_CONCURRENCY = numEnv("PRR_ADO_CONCURRENCY", 6, 1);

// --- Runner ---
// openai   = direct HTTP to an OpenAI-compatible endpoint. Supports engine-level guided
//            decoding (vLLM/xgrammar), which is what makes weak models emit valid JSON.
// opencode = drive models through the opencode CLI, inheriting its provider config.
//            NOTE: response_format is not passed through, so schemas are prompt-level only.
export const RUNNER_KIND = enumEnv("PRR_RUNNER", "openai", ["openai", "opencode"] as const);
export const OPENCODE_BIN = process.env.PRR_OPENCODE_BIN ?? "opencode";
// The agent definition prloop drives. Installed by `npm run setup`; must have every tool
// disabled — the review context is fully injected, and there is no local checkout to read.
export const OPENCODE_AGENT = process.env.PRR_OPENCODE_AGENT ?? "prloop-reviewer";
// 0 = drop --format json (fallback for opencode builds without JSONL events; loses tracing).
export const OPENCODE_JSON_EVENTS = process.env.PRR_OPENCODE_JSON !== "0";
// Wall-clock timeout for one opencode session.
export const AGENT_TIMEOUT_MS = numEnv("PRR_AGENT_TIMEOUT_MS", 15 * 60 * 1000, 1000);

// --- Model access (OpenAI-compatible: LiteLLM proxy, vLLM, Ollama /v1) ---
export const LLM_BASE_URL = process.env.PRR_LLM_BASE_URL ?? "http://localhost:4000/v1";
export const LLM_API_KEY = process.env.PRR_LLM_API_KEY ?? "dummy";
export const LLM_TIMEOUT_MS = numEnv("PRR_LLM_TIMEOUT_MS", 900_000, 1000);
// Model calls in flight at once, across every stage. The skeptic fans out over every
// anchored finding, so an uncapped run can put dozens of requests on a self-hosted endpoint
// simultaneously; they then queue in the engine while their own timeouts run down. 0 = no cap.
export const LLM_CONCURRENCY = numEnv("PRR_LLM_CONCURRENCY", 6);
// Extra attempts for a model call that failed for a TRANSIENT reason (timeout, socket
// error, 429, 5xx). Inference is a read-only operation, so a retry is always safe. A 4xx
// schema or auth rejection is deterministic and is never retried. 0 disables.
// Without this, one flaky verifier call silently deletes an inline comment: its finding
// stays single-source, fails the corroboration gate, and drops to the summary.
export const LLM_RETRIES = numEnv("PRR_LLM_RETRIES", 1);
// M1 runs a single finder; M3 turns this into a comma-separated heterogeneous fleet.
export const FINDER_MODELS = (process.env.PRR_FINDER_MODELS ?? "qwen3-coder")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Requirement axis model. Defaults to the first finder model; set separately when you want
// a stronger model on requirements (long acceptance criteria stress weak models).
export const REQ_MODEL = process.env.PRR_REQ_MODEL ?? FINDER_MODELS[0] ?? "";
export const LLM_TEMPERATURE = numEnv("PRR_LLM_TEMPERATURE", 0.2);
export const LLM_MAX_TOKENS = numEnv("PRR_LLM_MAX_TOKENS", 8192, 256);
// 0 = don't send response_format (for backends whose schema support is broken).
export const LLM_STRUCTURED_OUTPUT = process.env.PRR_LLM_STRUCTURED !== "0";
// Streamed (SSE) completions, on by default. A buffered completion sends ZERO bytes until
// the model finishes, and on a long generation that multi-minute silence outlives the idle
// timeout of whatever sits between prloop and the engine (nginx in front of vLLM, a
// LiteLLM proxy, a corporate gateway) — the hop gives up with a 504 long before
// PRR_LLM_TIMEOUT_MS ever fires. Streaming keeps bytes flowing from the first token, so no
// intermediary sees an idle connection; the response is still assembled and returned
// whole. 0 = buffered requests (the old behaviour), for backends whose SSE is broken.
export const LLM_STREAM = process.env.PRR_LLM_STREAM !== "0";
/**
 * Parses PRR_LLM_EXTRA_BODY: a JSON object merged into every model request body, for
 * engine-specific knobs prloop has no first-class flag for. Exported for tests; the const
 * below turns a parse failure into a startup fatal, because the alternative is a
 * mysterious HTTP 400 on every single model call mid-run.
 */
export function parseExtraBody(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed: unknown = JSON.parse(raw); // throws on malformed JSON
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('must be a JSON object, e.g. {"chat_template_kwargs":{"enable_thinking":false}}');
  }
  return parsed as Record<string, unknown>;
}
// The motivating case: a Qwen3-family finder on vLLM burning its entire token budget on
// chain of thought — {"chat_template_kwargs":{"enable_thinking":false}} switches thinking
// off at the engine. Applies to EVERY call (finder, skeptic, requirement, triage alike);
// per-model behaviour belongs in the endpoint's own per-alias config (LiteLLM extra_body).
// On a key conflict prloop's own fields always win — every field prloop manages already
// has its own PRR_ knob, so a collision is always a mistake.
export const LLM_EXTRA_BODY: Record<string, unknown> | undefined = (() => {
  try {
    return parseExtraBody(process.env.PRR_LLM_EXTRA_BODY);
  } catch (e) {
    console.error(`FATAL: PRR_LLM_EXTRA_BODY ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
})();

// --- Diff / token budget (PR-Agent style deterministic compression) ---
export const MAX_DIFF_CHARS = numEnv("PRR_MAX_DIFF_CHARS", 240_000, 1000);
// Extra context lines around each hunk. Asymmetric on purpose: preceding context
// carries more meaning for review than trailing context.
export const HUNK_CONTEXT_BEFORE = numEnv("PRR_HUNK_CONTEXT_BEFORE", 6);
export const HUNK_CONTEXT_AFTER = numEnv("PRR_HUNK_CONTEXT_AFTER", 3);
// Files bigger than this are diffed but never sent whole.
export const MAX_FILE_BYTES = numEnv("PRR_MAX_FILE_BYTES", 2_000_000, 1);

// --- Adversarial verification (M3) ---
// Skeptics should be a DIFFERENT model family from the finders. Same-family verifiers share
// the finders' blind spots, so they confirm the errors that matter most.
export const SKEPTIC_MODELS = (process.env.PRR_SKEPTIC_MODELS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Verifiers per finding. 1 is a single gate; 3 gives a majority vote worth the name.
export const SKEPTIC_ROUNDS = numEnv("PRR_SKEPTIC_ROUNDS", 1);
// Source lines shown around the finding. Small on purpose: models degrade with unlimited
// context, and a skeptic that needs the whole file is guessing.
export const SKEPTIC_CONTEXT_LINES = numEnv("PRR_SKEPTIC_CONTEXT_LINES", 25);
// Skeptic calls are small and numerous, so they get a much tighter deadline than a finder
// reading a whole diff. Kept separate because a skeptic timeout fails open: one slow verifier
// must not hold the run for the full finder timeout and then wave the finding through anyway.
export const SKEPTIC_TIMEOUT_MS = numEnv("PRR_SKEPTIC_TIMEOUT_MS", 180_000, 1000);
// Ceiling on findings sent to the skeptic per run. The fan-out is findings × rounds and
// was previously unbounded — a pathological PR anchoring 200 findings issued 200
// verification calls. The worst (highest-severity) findings get verified first; the
// overflow is logged, never silently dropped.
export const MAX_SKEPTIC_FINDINGS = numEnv("PRR_MAX_SKEPTIC_FINDINGS", 30, 1);
// Findings need corroboration to be published: either N finders found it independently, or
// a skeptic actively cleared it. A lone unverified finding stays in the summary instead.
export const MIN_CONSENSUS_SOURCES = numEnv("PRR_MIN_CONSENSUS_SOURCES", 2, 1);
// 0 = publish single-source findings that no skeptic examined (looser, noisier).
export const REQUIRE_CORROBORATION = process.env.PRR_REQUIRE_CORROBORATION !== "0";

// --- Static analysis (M4) ---
// A checkout of the PR's source branch. Linters need files on disk; without this the
// static gate skips. In an Azure pipeline this is the agent's own checkout.
export const WORKDIR = process.env.PRR_WORKDIR ?? "";
export const SKIP_STATIC = process.env.PRR_SKIP_STATIC === "1";
export const STATIC_TIMEOUT_MS = numEnv("PRR_STATIC_TIMEOUT_MS", 5 * 60 * 1000, 1000);
// Model that judges high-false-positive tool findings. Unset = those findings are dropped
// rather than posted unjudged.
export const TRIAGE_MODEL = process.env.PRR_TRIAGE_MODEL ?? "";
export const TRIAGE_CONTEXT_LINES = numEnv("PRR_TRIAGE_CONTEXT_LINES", 12);
// Ceiling on one triage call. A PR that trips 200 lint rules has a lint config problem,
// not a review problem.
export const MAX_TRIAGE_ITEMS = numEnv("PRR_MAX_TRIAGE_ITEMS", 40, 1);

// --- Review axes ---
// 1 = skip the requirement axis entirely.
export const SKIP_REQUIREMENT = process.env.PRR_SKIP_REQUIREMENT === "1";
// 1 = treat a PR with no linked work item as a failure rather than a warning.
export const REQUIRE_WORK_ITEM = process.env.PRR_REQUIRE_WORK_ITEM === "1";

// --- Noise control: exclusions and learnings (M6) ---
// Finding categories dropped from the code axis entirely, before any model verification
// spends tokens on them (claude-code-security-review ships the same knob as its false-
// positive exclusion list). Counted and named in the summary, never silently discarded.
// Applies to finder and static-tool findings; the requirement axis has its own switch
// (PRR_SKIP_REQUIREMENT). Read lazily so tests (and late env changes) see the live value.
export const excludedCategories = (): string[] =>
  (process.env.PRR_EXCLUDE_CATEGORIES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
// 0 = ignore recorded human dismissals when deciding what to publish.
export const LEARN_FROM_DISMISSALS = process.env.PRR_LEARN_FROM_DISMISSALS !== "0";
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
export const isDryRun = (): boolean => process.env.PRR_DRY_RUN === "1";
// 1 = also post a PR status (needs a branch policy to actually gate merges).
export const POST_STATUS = process.env.PRR_POST_STATUS === "1";
export const STATUS_GENRE = process.env.PRR_STATUS_GENRE ?? "prloop";
export const STATUS_NAME = process.env.PRR_STATUS_NAME ?? "ai-review";

export const QUIET = process.env.PRR_QUIET === "1";

// Marker embedded in every comment we author, so re-runs can find and update
// our own threads instead of duplicating them.
export const BOT_MARKER = "<!-- prloop -->";

// Artifacts root.
export const RUNS_DIR = process.env.PRR_RUNS_DIR ?? path.join(PRLOOP_ROOT, "runs");

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
