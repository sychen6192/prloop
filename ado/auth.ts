// Authentication. Two modes, because plenty of orgs don't hand out PATs:
//   pat   — Basic auth with a personal access token (or a pipeline's $(System.AccessToken))
//   azcli — Bearer token minted by `az account get-access-token`, i.e. whoever ran `az login`
// "auto" prefers a PAT when one is configured and falls back to the az CLI.
import { ADO_AUTH_MODE, ADO_PAT, AZ_BIN } from "../config";
import { logVerbose } from "../libs/log";
import { commandExists, run } from "../libs/shell";

// Azure DevOps' first-party application ID. Tokens must be scoped to it, not to the ARM
// resource, or every request comes back 203 with a sign-in page.
const ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

/**
 * The PAT scopes prloop actually needs, in the words the ADO PAT screen uses.
 *
 * Work Items (Read) is not optional and used to be missing from every message and document:
 * the requirement axis reads the linked work item, so a Code-only PAT sails through intake
 * and then fails on the one stage the operator cannot see into. One constant, quoted by the
 * README and .env.example too, so the four places cannot drift apart again.
 */
export const AUTH_SCOPE_HINT = "Code (Read & Write) + Work Items (Read)";

interface CachedToken {
  token: string;
  expiresAtMs: number;
}
let cached: CachedToken | undefined;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

// Whether `az` is on PATH, asked once. authHeader() runs on EVERY request, so in `auto` mode
// without a PAT this spawned a `which az` per ADO call — hundreds during intake at
// PRR_ADO_CONCURRENCY=6, each one a process. The answer cannot change mid-run.
// The promise itself is cached, so concurrent first callers share one probe.
let azProbe: Promise<boolean> | undefined;

/** `probe` is injectable for the selftest; production always uses commandExists. */
export function azOnPath(probe: () => Promise<boolean> = () => commandExists(AZ_BIN)): Promise<boolean> {
  azProbe ??= probe();
  return azProbe;
}

interface AzTokenResponse {
  accessToken?: string;
  expiresOn?: string;
  expires_on?: number;
}

async function getAzToken(): Promise<string> {
  // Refresh a minute early so a long run never dies mid-flight on an expiring token.
  if (cached && cached.expiresAtMs > Date.now() + 60_000) return cached.token;

  const res = await run(AZ_BIN, [
    "account",
    "get-access-token",
    "--resource",
    ADO_RESOURCE_ID,
    "-o",
    "json",
  ]);
  if (res.code !== 0) {
    const hint = /az login|not logged in|AADSTS/i.test(res.stderr)
      ? "Run az login first."
      : `az exited non-zero: ${res.stderr.trim().slice(0, 300)}`;
    throw new AuthError(`Failed to get token via az CLI. ${hint}`);
  }

  let parsed: AzTokenResponse;
  try {
    parsed = JSON.parse(res.stdout) as AzTokenResponse;
  } catch {
    throw new AuthError(`Cannot parse az output: ${res.stdout.slice(0, 300)}`);
  }
  if (!parsed.accessToken) {
    throw new AuthError("No accessToken in az output");
  }

  // expires_on is epoch seconds; expiresOn is a local-time string whose format has varied
  // across az versions. Fall back to a conservative 30 minutes rather than trusting a parse.
  let expiresAtMs = Date.now() + 30 * 60_000;
  if (typeof parsed.expires_on === "number" && Number.isFinite(parsed.expires_on)) {
    expiresAtMs = parsed.expires_on * 1000;
  } else if (parsed.expiresOn) {
    const t = Date.parse(parsed.expiresOn);
    if (Number.isFinite(t)) expiresAtMs = t;
  }

  cached = { token: parsed.accessToken, expiresAtMs };
  logVerbose(`Got token via az CLI, valid until ${new Date(expiresAtMs).toISOString()}`);
  return parsed.accessToken;
}

export async function authHeader(): Promise<string> {
  const mode = ADO_AUTH_MODE;

  if (mode === "pat") {
    if (!ADO_PAT) {
      throw new AuthError("PRR_AUTH_MODE=pat but PRR_ADO_PAT is not set");
    }
    return `Basic ${Buffer.from(`:${ADO_PAT}`).toString("base64")}`;
  }

  if (mode === "azcli") {
    return `Bearer ${await getAzToken()}`;
  }

  // auto
  if (ADO_PAT) return `Basic ${Buffer.from(`:${ADO_PAT}`).toString("base64")}`;
  if (await azOnPath()) return `Bearer ${await getAzToken()}`;
  throw new AuthError(
    "No usable auth: PRR_ADO_PAT unset and no az CLI on PATH. " +
      `Set a PAT with ${AUTH_SCOPE_HINT}, or install the az CLI and run az login.`,
  );
}

/** Which mode auto-detection would land on. Used by doctor to report the effective setup. */
export async function describeAuthMode(): Promise<string> {
  if (ADO_AUTH_MODE === "pat") return ADO_PAT ? "pat (PAT set)" : "pat (PAT missing)";
  if (ADO_AUTH_MODE === "azcli") {
    return (await azOnPath()) ? "azcli (az available)" : "azcli (az not found)";
  }
  if (ADO_PAT) return "auto → pat (PRR_ADO_PAT detected)";
  if (await azOnPath()) return "auto → azcli (no PAT, az CLI detected)";
  return "auto → no usable auth";
}
