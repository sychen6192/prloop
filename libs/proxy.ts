// Corporate proxy support.
//
// Node's built-in fetch ignores HTTP_PROXY / HTTPS_PROXY entirely — unlike curl, git and
// pip, which all read them. On a network whose only egress is a proxy, that shows up as a
// bare ECONNREFUSED with no hint that a proxy was ever involved, which is a genuinely hard
// failure to diagnose from the outside.
//
// So we read the standard variables ourselves and hand fetch an explicit dispatcher.
import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import { HTTP_PROXY, HTTPS_PROXY, NO_PROXY, USER_AGENT_OVERRIDE } from "../config";
import { logVerbose } from "./log";
import { caBundle, caSummary } from "./tls";

// The values themselves are read in config.ts (every PRR_ knob is declared there once, so
// that provenance, the typo check and --config all see it); they are re-exported here
// because this is where proxying is implemented and where callers look for them.
export { HTTP_PROXY, HTTPS_PROXY, NO_PROXY };

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Derived from package.json so the UA can never drift from the released version again.
const pkgVersion = (() => {
  try {
    const p = fileURLToPath(new URL("../package.json", import.meta.url));
    return (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
/**
 * User-Agent sent on both ordinary requests and the proxy CONNECT. The default identifies
 * this tool honestly; PRR_USER_AGENT is the escape hatch for a proxy that filters CONNECT
 * by User-Agent (see the note on the config const).
 */
export const USER_AGENT = USER_AGENT_OVERRIDE || `prloop/${pkgVersion}`;

/**
 * Standard NO_PROXY semantics: comma-separated hosts, a leading dot or bare suffix matches
 * subdomains, and `*` disables proxying entirely. Internal endpoints (a self-hosted model
 * server, say) almost always need to bypass the proxy that fronts external traffic.
 */
export function bypassesProxy(host: string, noProxy: string = NO_PROXY, port?: string): boolean {
  if (!noProxy) return false;
  const h = host.toLowerCase();
  for (const raw of noProxy.split(",")) {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) continue;
    // A bare "*" disables proxying entirely. It has to be checked before the wildcard
    // prefix is stripped, or it reduces to an empty entry and is silently ignored.
    if (trimmed === "*") return true;
    let entry = trimmed.replace(/^\*/, "");
    if (!entry) continue;
    // curl-style host:port entry: the port must match too (an unknown port matches nothing).
    // Without this, NO_PROXY=localhost:4000 — the obvious way to exempt a local model
    // endpoint — silently matches nothing and the traffic still goes to the proxy.
    const m = /^(.*):(\d+)$/.exec(entry);
    if (m) {
      if (port === undefined || m[2] !== port) continue;
      entry = m[1]!;
      if (!entry) continue;
    }
    const suffix = entry.startsWith(".") ? entry : `.${entry}`;
    if (h === entry || h.endsWith(suffix)) return true;
  }
  return false;
}

const CA = caBundle();

// undici's own timers are DISABLED on every dispatcher we hand out. Its defaults
// (headersTimeout / bodyTimeout = 300s) sit underneath our per-request AbortController
// timers and fire first: a reasoning model that takes >5 min before the first byte dies
// with a bare "TypeError: fetch failed" long before our 900s deadline. Diagnosed from a
// production run that failed at exactly 301s. Timeouts are our timers' job alone.
const NO_UNDICI_TIMEOUTS = { headersTimeout: 0, bodyTimeout: 0 } as const;

/**
 * Dispatcher for unproxied connections. Always created — even with no extra CA it exists
 * to override undici's 300s default timeouts (see above). Also installed globally, so a
 * `fetch()` that forgets to pass a dispatcher still gets both the CA and the timeout fix.
 */
const directAgent: Dispatcher = new Agent({
  ...NO_UNDICI_TIMEOUTS,
  ...(CA ? { connect: { ca: CA } } : {}),
});
setGlobalDispatcher(directAgent);
if (CA) logVerbose(`Extra CA trust: ${caSummary()}`);

const cache = new Map<string, Dispatcher | undefined>();

/** The dispatcher fetch should use for a URL. Never undefined: even the direct path must
 * override undici's default 300s header/body timeouts. */
export function dispatcherFor(url: string): Dispatcher | undefined {
  let host: string;
  let port: string;
  let isHttps: boolean;
  try {
    const u = new URL(url);
    host = u.hostname;
    isHttps = u.protocol === "https:";
    port = u.port || (isHttps ? "443" : "80");
  } catch {
    return directAgent;
  }
  // Bypassing the proxy still needs the CA: an internal endpoint reached directly is
  // exactly the kind of host whose certificate the corporate root signed.
  if (bypassesProxy(host, NO_PROXY, port)) return directAgent;

  const proxy = isHttps ? HTTPS_PROXY || HTTP_PROXY : HTTP_PROXY || HTTPS_PROXY;
  if (!proxy) return directAgent;

  if (!cache.has(proxy)) {
    try {
      cache.set(
        proxy,
        new ProxyAgent({
          uri: proxy,
          ...NO_UNDICI_TIMEOUTS,
          // Headers here ride on the CONNECT request itself, which is where the filtering
          // happens — setting a User-Agent only on the tunnelled request would be too late.
          headers: { "user-agent": USER_AGENT },
          // requestTls is the tunnelled connection to the origin — the one a TLS-intercepting
          // proxy re-signs, so this is where the corporate CA is actually needed. proxyTls
          // only matters for an https:// proxy URL, which is rare but costs nothing to cover.
          ...(CA ? { requestTls: { ca: CA }, proxyTls: { ca: CA } } : {}),
        }),
      );
      logVerbose(`Using proxy: ${redactProxy(proxy)}`);
    } catch (e) {
      logVerbose(`Unparsable proxy config (${redactProxy(proxy)}): ${e instanceof Error ? e.message : String(e)}`);
      cache.set(proxy, undefined);
    }
  }
  return cache.get(proxy) ?? directAgent;
}

/**
 * Hides credentials in a proxy URL while leaving everything else byte-for-byte intact.
 *
 * Round-tripping through `new URL()` would normalise the value — notably dropping a default
 * port, so `http://host:80` prints as `http://host/`. That reads as "my configured port
 * vanished" and sends people looking for a bug in their own settings, so the redaction is
 * done by string surgery on the credentials alone.
 */
export function redactProxy(p: string): string {
  return p.replace(/\/\/([^/@]+)@/, (_m, creds: string) => {
    const [user] = creds.split(":");
    return `//${user ? `${user}:***` : "***"}@`;
  });
}

export function proxySummary(): string {
  const parts: string[] = [];
  if (HTTPS_PROXY) parts.push(`HTTPS_PROXY=${redactProxy(HTTPS_PROXY)}`);
  if (HTTP_PROXY) parts.push(`HTTP_PROXY=${redactProxy(HTTP_PROXY)}`);
  if (NO_PROXY) parts.push(`NO_PROXY=${NO_PROXY}`);
  return parts.length ? parts.join(" | ") : "(not set, connecting directly)";
}
