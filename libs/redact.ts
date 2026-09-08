// Secret redaction at every egress: log lines, runs/ artifacts, error messages, the summary
// comment posted on the PR.
//
// The leak that motivated this: some LLM gateways echo the presented credential inside an
// auth error body ("Incorrect API key provided: sk-…"), and that body was relayed verbatim
// into the log, into runs/finder-*-raw.txt and skeptic.json, and into the PR summary
// ("Model X produced no result: HTTP 401: …") — so a mistyped key was published to everyone
// with read access to the repository. ADO error bodies and proxy URLs travel the same path.
//
// One pure function, applied where text LEAVES the process rather than where it is produced:
// producers are many (every fetch, every stage, every artifact) and a new one would silently
// miss a per-producer filter.
import { ADO_PAT, LLM_API_KEY } from "../config";

export const REDACTED = "[REDACTED]";

/**
 * Which configured credential values are worth scrubbing as literals. Short values and the
 * "dummy" default are excluded: replacing every "dummy" — or every 4-character substring
 * that happens to be someone's placeholder — would shred ordinary text, and neither is a
 * secret.
 */
export function secretValues(values: ReadonlyArray<string | undefined>): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (!v || v.length < 8 || v === "dummy" || out.includes(v)) continue;
    out.push(v);
  }
  return out;
}

const CONFIGURED = secretValues([LLM_API_KEY, ADO_PAT]);

// Each pattern keeps its own prefix, so the redacted text still says what KIND of credential
// stood there: "Authorization: Bearer [REDACTED]" is a diagnosable line, a bare "[REDACTED]"
// is not. Thresholds keep prose intact — "Basic authentication failed" has no 16-char token.
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, `Bearer ${REDACTED}`],
  [/\bBasic\s+[A-Za-z0-9+/=]{16,}/g, `Basic ${REDACTED}`],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/x-access-token:[^@\s/]+@/gi, `x-access-token:${REDACTED}@`],
  // Credentials in any URL userinfo, which is how a corporate proxy is configured:
  // PRR_HTTPS_PROXY=http://bob:hunter2@proxy.corp:8080. The value is not secret-SHAPED
  // (it is a URL) so no other pattern caught it, and `prloop --config` printed it in
  // full — the one place an operator is most likely to paste into a bug report.
  // The user half is kept: knowing WHICH account the proxy rejected is the diagnosis.
  [/\/\/([^/:@\s]+):[^@\s/]+@/g, `//$1:${REDACTED}@`],
];

/**
 * Replaces credentials in `text` with a stable placeholder. `literals` defaults to the
 * configured LLM key and ADO PAT; the parameter exists for tests, which cannot re-configure
 * the process.
 */
export function redactSecrets(text: string, literals: ReadonlyArray<string> = CONFIGURED): string {
  let out = text;
  // Literals first: a configured key that matches no pattern (a plain hex PAT, say) is still
  // the one value that must never leave the process.
  for (const s of literals) out = out.split(s).join(REDACTED);
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}
