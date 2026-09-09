// Preflight. Every check that can fail at 3am should fail here instead, with the fix in
// the message. Run `doctor <PR URL> --smoke` before the first real run.
import {
  ADO_AUTH_MODE,
  ADO_PAT,
  AZ_BIN,
  FINDER_MODELS,
  KNOWN_KEYS,
  LLM_BASE_URL,
  LLM_CONCURRENCY,
  MAX_INLINE_COMMENTS,
  ADO_API_VERSION,
  MIN_INLINE_SEVERITY,
  OPENCODE_AGENT,
  SKIP_STATIC,
  TRIAGE_MODEL,
  WORKDIR,
  OPENCODE_BIN,
  REQUIRE_CORROBORATION,
  RUNNER_KIND,
  SKEPTIC_MODELS,
  SKEPTIC_ROUNDS,
} from "../config";
import { adoGet, parsePrUrl, prBase } from "../ado/client";
import { describeAuthMode } from "../ado/auth";
import { CA_SOURCES, caSummary } from "../libs/tls";
import { existsSync } from "node:fs";
import { commandExists, run } from "../libs/shell";
import { proxySummary } from "../libs/proxy";
import { configWarnings } from "../libs/configreport";
import { PROFILES } from "../profiles";
import { createRunner } from "../models/runner";
import { FINDINGS_SCHEMA } from "../models/schemas";
import { parseJsonObject } from "../libs/json";

let warnings = 0;
let errors = 0;

function ok(label: string, detail = "") {
  console.log(`  [OK]   ${label}${detail ? ` — ${detail}` : ""}`);
}
function warn(label: string, fix: string) {
  warnings++;
  console.log(`  [WARN] ${label}\n         → ${fix}`);
}
function bad(label: string, fix: string) {
  errors++;
  console.log(`  [FAIL] ${label}\n         → ${fix}`);
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith("-"));
  const smoke = args.includes("--smoke");

  console.log("\nEnvironment");
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok("Node.js", `v${process.versions.node}`);
  else bad(`Node.js v${process.versions.node} too old`, "needs v20+ (this tool uses built-in fetch)");
  // Report what actually got loaded, not what was merely configured: a path that is
  // misspelled or in DER form is the failure mode that looks identical to no CA at all.
  const broken = CA_SOURCES.filter((s) => s.error);
  const good = CA_SOURCES.filter((s) => !s.error);
  for (const s of broken) {
    bad(
      `CA certificate unusable: ${s.path} (${s.from})`,
      s.error?.includes("DER")
        ? "Convert it: openssl x509 -inform der -in <file> -out <file>.pem"
        : `Check the path is readable. ${s.error ?? ""}`,
    );
  }
  if (good.length > 0) {
    ok("Extra CA certificates", `${caSummary()} — applied to every request`);
  } else if ((process.env["NODE_OPTIONS"] ?? "").includes("use-system-ca")) {
    ok("Certificate source", "system trust store (--use-system-ca)");
  }
  ok("proxy", proxySummary());
  // The failure this catches is silent by construction: .env cannot override a variable the
  // shell already exported, so an edited setting that "does nothing" looks like a bug in
  // prloop. doctor is the tool people run when something is wrong, so it says it here too.
  const configIssues = configWarnings();
  for (const w of configIssues) warn(w.message, w.fix);
  if (configIssues.length === 0) ok("settings", `${KNOWN_KEYS.length} known, no shell/.env conflicts`);

  console.log("\nAzure DevOps auth");
  ok("Auth mode", await describeAuthMode());
  const hasAz = await commandExists(AZ_BIN);
  if (ADO_PAT) {
    ok("PAT", `set (length ${ADO_PAT.length})`);
  } else if (hasAz) {
    const acct = await run(AZ_BIN, ["account", "show", "--query", "user.name", "-o", "tsv"]);
    if (acct.code === 0 && acct.stdout.trim()) ok("az identity", acct.stdout.trim());
    else bad("az installed but not logged in", "run az login");
  } else if (ADO_AUTH_MODE === "azcli") {
    bad(`PRR_AUTH_MODE=azcli but ${AZ_BIN} not found`, "install Azure CLI, or switch to a PAT");
  } else {
    bad("No usable auth", "either set PRR_ADO_PAT, or install az CLI and run az login");
  }

  console.log("\nRunner");
  ok("runner", RUNNER_KIND);
  if (RUNNER_KIND === "opencode") {
    if (await commandExists(OPENCODE_BIN)) ok("opencode CLI", "installed");
    else bad(`${OPENCODE_BIN} not found`, "install the opencode CLI, or set PRR_OPENCODE_BIN");
    ok("agent", OPENCODE_AGENT);
    warn(
      "opencode does not pass response_format to the backend",
      "the schema is only enforced by the prompt, so weak models follow it less reliably. " +
        "If the backend supports guided decoding (vLLM/xgrammar), PRR_RUNNER=openai is more accurate",
    );
  } else {
    ok("endpoint", LLM_BASE_URL);
  }

  console.log("\nModels");
  ok("finder models", FINDER_MODELS.join(", "));
  if (FINDER_MODELS.length === 1) {
    warn(
      "Only one finder model configured",
      "cross-checking across models is the main source of accuracy. Put several models from different families in PRR_FINDER_MODELS",
    );
  }
  if (SKEPTIC_MODELS.length === 0) {
    warn(
      "No skeptic models configured; adversarial verification will not run",
      "set PRR_SKEPTIC_MODELS. With only one finder as well, every finding lacks corroboration and no inline comments get posted",
    );
  } else {
    ok("skeptic models", `${SKEPTIC_MODELS.join(", ")} (${SKEPTIC_ROUNDS} rounds each)`);
    const overlap = SKEPTIC_MODELS.filter((m) => FINDER_MODELS.includes(m));
    if (overlap.length > 0) {
      warn(
        `skeptic and finder share a model: ${overlap.join(", ")}`,
        "a same-family verifier shares the finder's blind spots and confirms exactly the bugs you most need caught. Use a different family",
      );
    }
  }
  ok("Model call concurrency", LLM_CONCURRENCY > 0 ? `${LLM_CONCURRENCY} in flight` : "unlimited");
  if (LLM_CONCURRENCY <= 0 || LLM_CONCURRENCY > 16) {
    warn(
      `PRR_LLM_CONCURRENCY=${LLM_CONCURRENCY || "unlimited"}`,
      "the skeptic issues one call per anchored finding per round, all at once. Against a " +
        "self-hosted endpoint they queue while their own timeouts run down, and a skeptic " +
        "timeout fails open — verification silently becomes a no-op. Keep it near the " +
        "endpoint's real batch size",
    );
  }
  if (!REQUIRE_CORROBORATION) {
    warn("Corroboration requirement off (PRR_REQUIRE_CORROBORATION=0)", "unverified single-model findings get posted directly; expect more false positives");
  }

  console.log("\nStatic analysis");
  if (SKIP_STATIC) {
    ok("Disabled", "PRR_SKIP_STATIC=1");
  } else if (!WORKDIR) {
    warn(
      "PRR_WORKDIR not set; static analysis will not run",
      "point it at a checkout of the PR source branch; in a pipeline that is the agent's working directory",
    );
  } else if (!existsSync(WORKDIR)) {
    bad(`PRR_WORKDIR does not exist: ${WORKDIR}`, "check the path, or clear it to disable static analysis");
  } else {
    ok("Working directory", WORKDIR);
    const tools = [...new Set(PROFILES.flatMap((p) => p.tools.map((t) => t.bin)))];
    const found: string[] = [];
    const missing: string[] = [];
    for (const t of tools) ((await commandExists(t)) ? found : missing).push(t);
    if (found.length > 0) ok("Available tools", found.join(", "));
    if (missing.length > 0) warn(`Not on PATH: ${missing.join(", ")}`, "those tools are skipped; other stages are unaffected");
    if (!TRIAGE_MODEL) {
      warn(
        "PRR_TRIAGE_MODEL not set",
        "results from high-false-positive tools (bandit / PMD / eslint) are dropped instead of commented (deliberately fail-closed). " +
          "Set it to have a model judge them",
      );
    } else {
      ok("triage model", TRIAGE_MODEL);
    }
  }

  console.log("\nPublish config");
  ok("Inline comment limit", String(MAX_INLINE_COMMENTS));
  ok("Min comment severity", MIN_INLINE_SEVERITY);

  if (url) {
    console.log("\nPR connection test");
    try {
      const ref = parsePrUrl(url);
      ok("URL parse", `collection=${ref.org} | project=${ref.project} | repo=${ref.repoId} | PR !${ref.prId}`);
      // The single most useful line when an on-prem request fails: it shows exactly what
      // the REST calls will hit, so a wrong collection or missing virtual directory is
      // visible before anything is sent.
      ok("API base", ref.baseUrl);
      ok("Actual request URL", `${prBase(ref)}?api-version=${ADO_API_VERSION}`);
      try {
        const pr = await adoGet<{ title?: string; status?: string }>(prBase(ref));
        ok("Read PR", `"${pr.title ?? ""}" status ${pr.status ?? "?"}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const hint = /api-version|Unsupported|not supported/i.test(msg)
          ? `this server does not support api-version ${ADO_API_VERSION}. On-prem: Server 2019→5.0, 2020→6.0, 2022→7.0. Set PRR_ADO_API_VERSION`
          : /certificate|TLS|DNS|timeout|refused/i.test(msg)
            ? "see the fix in the message above"
            : "check the credentials are valid, and that the API base above is the right collection URL";
        bad(`Failed to read PR: ${msg}`, hint);
      }
    } catch (e) {
      bad(`URL parse failed: ${e instanceof Error ? e.message : String(e)}`, "expected .../{org}/{project}/_git/{repo}/pullrequest/{id}");
    }
  } else {
    console.log("\nPR connection test");
    warn("No PR URL given, skipped", "run doctor <PR URL> to test the ADO connection too");
  }

  if (smoke) {
    console.log("\nLive model test (--smoke)");
    const runner = await createRunner();
    for (const model of FINDER_MODELS) {
      const res = await runner.chat({
        model,
        system: "You output only JSON matching the given schema.",
        user:
          'Return a findings array with exactly one entry: category "logic", severity "low", ' +
          'confidence 0.5, file "/a.ts", quote "x();", claim "smoke test".',
        schema: FINDINGS_SCHEMA,
        schemaName: "findings",
        maxTokens: 512,
      });
      if (res.error) {
        bad(`${model} call failed: ${res.error}`, "check PRR_LLM_BASE_URL / API key / model name");
        continue;
      }
      const parsed = parseJsonObject<{ findings?: unknown[] }>(res.text);
      if (!parsed.ok) {
        bad(
          `${model} output could not be parsed: ${parsed.error}`,
          "the backend may not support json_schema. Switch to vLLM guided decoding, or set PRR_LLM_STRUCTURED=0 and observe",
        );
      } else if (!Array.isArray(parsed.value.findings)) {
        warn(`${model} returned JSON without a findings array`, "common with weak models; accuracy drops when the schema is not enforced");
      } else {
        ok(`${model} structured output works`, `${parsed.value.findings.length} findings`);
      }
    }
  } else {
    console.log("\nLive model test");
    warn("No --smoke, skipped", "on first setup, run doctor <PR URL> --smoke to test the models once");
  }

  console.log(`\nResult: ${errors} error(s), ${warnings} warning(s)`);
  if (errors > 0) console.log("Fix the errors above before running prloop.");
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
