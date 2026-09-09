// Raw connectivity probe. Answers "why is my request failing" by showing everything the
// normal code path hides: where each setting actually came from, the exact URL, the raw
// HTTP status and the server's own error message.
//
// doctor tells you whether things work. probe tells you why they don't.
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import * as tls from "node:tls";
import { ADO_API_VERSION, ADO_PAT, DOTENV_PATH, PRLOOP_ROOT, entryFor } from "../config";
import { describeEntry } from "../libs/configreport";
import { authHeader, describeAuthMode } from "../ado/auth";
import { parsePrUrl, prBase } from "../ado/client";
import { HTTPS_PROXY, HTTP_PROXY, USER_AGENT, bypassesProxy, dispatcherFor, proxySummary, redactProxy } from "../libs/proxy";
import { commandExists, run } from "../libs/shell";
import { AZ_BIN } from "../config";

// api-versions worth trying, newest first. Cloud speaks 7.1; on-prem tops out lower
// depending on the server release.
const CANDIDATE_VERSIONS = ["7.1", "7.0", "6.0", "5.1", "5.0"];

function line(label: string, value: string) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

/**
 * Config provenance. The .env loader deliberately never overrides an existing environment
 * variable, so a stale `export` in a shell profile silently wins over the file — which is
 * invisible unless you look for it. The bookkeeping is config.ts's (it is the only place
 * that can tell a shell export from a value it set itself); this just prints it.
 */
function reportProvenance(keys: string[]) {
  if (!fs.existsSync(DOTENV_PATH)) console.log(`  (${DOTENV_PATH} not found)`);
  for (const k of keys) line(k, describeEntry(entryFor(k)));
}

async function rawGet(url: string, header: string): Promise<void> {
  console.log(`\n  GET ${url}`);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { Authorization: header, Accept: "application/json", "User-Agent": USER_AGENT },
      // Without this the request bypasses the proxy entirely and fails with ECONNREFUSED,
      // which looks like a network problem rather than a missing dispatcher.
      dispatcher: dispatcherFor(url),
    } as RequestInit);
    const ms = Date.now() - started;
    const ctype = res.headers.get("content-type") ?? "";
    line("HTTP status", `${res.status} ${res.statusText}   (${ms}ms)`);
    line("content-type", ctype);

    const body = await res.text();
    if (res.status === 203 || ctype.includes("text/html")) {
      console.log(
        "  → Got a sign-in page, not JSON. Auth was rejected: PAT invalid, expired, " +
          "or missing scope (needs Code (Read & Write) + Work Items (Read)).",
      );
      return;
    }
    // ADO puts the real reason in a JSON `message` field; show it verbatim rather than
    // truncating it into an exception.
    try {
      const j = JSON.parse(body) as Record<string, unknown>;
      if (typeof j["message"] === "string") {
        console.log(`  server message: ${j["message"]}`);
      } else if (typeof j["title"] === "string") {
        console.log(`  ${String(j["title"])} | status ${String(j["status"] ?? "")}`);
      } else {
        const keys = Object.keys(j).slice(0, 8).join(", ");
        console.log(`  response JSON fields: ${keys}`);
      }
    } catch {
      console.log(`  first 300 chars of response: ${body.slice(0, 300)}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { cause?: { code?: string } })?.cause?.code ?? "";
    line("connection failed", `${msg}${code ? ` (${code})` : ""}`);
  }
}

/**
 * TLS handshake, probed separately from HTTP.
 *
 * Node ships its own CA bundle and does NOT consult the operating system trust store, so a
 * corporate TLS-interception proxy that every browser accepts will still fail here. The
 * second connection (verification disabled) exists purely to read back the certificate the
 * server actually presented, which names the interceptor — that is the piece of information
 * that turns "handshake failed" into "install this CA".
 */
interface TlsResult {
  ok: boolean;
  err?: string;
  code?: string;
  chain: string[];
  issuer: string;
  der: Buffer[];
}

/**
 * How to enable --use-system-ca on the running Node, which differs by version:
 * it exists from 22.15 / 23.5, but only became permissible inside NODE_OPTIONS later —
 * and NODE_OPTIONS is the only route that survives an `npx tsx` invocation.
 */
function systemCaAdvice(): string {
  const [maj = 0, min = 0] = process.versions.node.split(".").map(Number);
  const hasFlag = maj > 23 || (maj === 23 && min >= 5) || (maj === 22 && min >= 15);
  if (!hasFlag) {
    return `this Node has no --use-system-ca (needs 22.15+ / 23.5+); use NODE_EXTRA_CA_CERTS instead`;
  }
  if (maj >= 24) {
    return `export NODE_OPTIONS=--use-system-ca   then run as usual (Node 24+ allows it in NODE_OPTIONS)`;
  }
  return (
    "node --use-system-ca ... (this version rejects it in NODE_OPTIONS, " +
    "so it's awkward with npx/tsx; prefer NODE_EXTRA_CA_CERTS)"
  );
}

/** DER → PEM. Node hands back raw certificate bytes; NODE_EXTRA_CA_CERTS wants PEM text. */
function derToPem(der: Buffer): string {
  const b64 = der.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

async function probeTls(host: string, port: number, exportCaTo?: string): Promise<void> {
  console.log("\n=== 4. TLS handshake ===");

  const proxy = bypassesProxy(host) ? "" : HTTPS_PROXY || HTTP_PROXY;
  if (proxy) {
    line("via proxy", redactProxy(proxy));
  } else {
    line("connection", "direct (no proxy set, or host is in NO_PROXY)");
  }

  // With a proxy in play the handshake has to run inside a CONNECT tunnel; testing a direct
  // socket would report the firewall's refusal and wrongly blame the certificate.
  const openSocket = (): Promise<{ sock?: net.Socket; err?: string; code?: string }> =>
    new Promise((resolve) => {
      if (!proxy) {
        const s = net.connect({ host, port, timeout: 15_000 });
        s.once("connect", () => resolve({ sock: s }));
        s.once("error", (e: NodeJS.ErrnoException) => resolve({ err: e.message, code: e.code }));
        s.once("timeout", () => {
          s.destroy();
          resolve({ err: "TCP connect timeout (15s)" });
        });
        return;
      }
      const pu = new URL(proxy);
      const s = net.connect({
        host: pu.hostname,
        port: Number(pu.port || (pu.protocol === "https:" ? 443 : 80)),
        timeout: 15_000,
      });
      s.once("error", (e: NodeJS.ErrnoException) => resolve({ err: `cannot reach proxy: ${e.message}`, code: e.code }));
      s.once("timeout", () => {
        s.destroy();
        resolve({ err: "proxy connect timeout (15s)" });
      });
      s.once("connect", () => {
        const auth = pu.username
          ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(pu.username)}:${decodeURIComponent(pu.password)}`).toString("base64")}\r\n`
          : "";
        s.write(
          `CONNECT ${host}:${port} HTTP/1.1\r\n` +
            `Host: ${host}:${port}\r\n` +
            `User-Agent: ${USER_AGENT}\r\n` +
            `Proxy-Connection: Keep-Alive\r\n${auth}\r\n`,
        );
        s.once("data", (buf: Buffer) => {
          const head = buf.toString("utf8").split("\r\n")[0] ?? "";
          if (/ 200 /.test(head)) resolve({ sock: s });
          else {
            s.destroy();
            // A refusal here is network policy, not TLS and not credentials: the proxy
            // decided before any certificate or token was ever exchanged.
            const code = /\s(\d{3})\s/.exec(head)?.[1] ?? "";
            let why = "";
            if (code === "403") {
              why =
                `proxy refused (User-Agent sent was "${USER_AGENT}"). ` +
                "If git reaches the same host, the proxy is likely filtering on User-Agent; " +
                "section 4b finds which string gets through, then set PRR_USER_AGENT to match";
            } else if (code === "407") {
              why = "proxy requires auth. Set HTTPS_PROXY as http://user:pass@host:port";
            } else if (code === "502" || code === "504") {
              why = "proxy cannot reach the target host";
            }
            resolve({ err: `proxy refused CONNECT: ${head}${why ? `\n     → ${why}` : ""}` });
          }
        });
      });
    });

  const connect = async (rejectUnauthorized: boolean) => {
    const opened = await openSocket();
    if (!opened.sock) {
      return { ok: false, err: opened.err, code: opened.code, chain: [], issuer: "", der: [] };
    }
    return new Promise<TlsResult>((resolve) => {
      const socket = tls.connect(
        { socket: opened.sock, servername: host, rejectUnauthorized, timeout: 15_000 },
        () => {
          const cert = socket.getPeerCertificate(true) as tls.DetailedPeerCertificate | undefined;
          const chain: string[] = [];
          const der: Buffer[] = [];
          let node = cert;
          const seen = new Set<string>();
          while (node && node.subject) {
            const asText = (v: unknown): string =>
              Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : "";
            const cn = asText(node.subject.CN) || asText(node.subject.O) || "(no CN)";
            const iss = asText(node.issuer?.CN) || asText(node.issuer?.O) || "?";
            const key = `${cn}|${iss}`;
            if (seen.has(key)) break;
            seen.add(key);
            chain.push(`${cn}   ← issuer: ${iss}`);
            if (node.raw) der.push(node.raw);
            node = node.issuerCertificate === node ? undefined : node.issuerCertificate;
          }
          // Subject/issuer fields can come back as arrays when a DN repeats an attribute.
          const flat = (v: string | string[] | undefined): string =>
            Array.isArray(v) ? v.join(", ") : (v ?? "");
          const issuer = flat(cert?.issuer?.CN) || flat(cert?.issuer?.O);
          socket.end();
          resolve({ ok: true, chain, issuer, der });
        },
      );
      socket.on("error", (e: NodeJS.ErrnoException) => {
        resolve({ ok: false, err: e.message, code: e.code, chain: [], issuer: "", der: [] });
      });
      socket.on("timeout", () => {
        socket.destroy();
        resolve({ ok: false, err: "TLS handshake timeout (15s)", chain: [], issuer: "", der: [] });
      });
    });
  };

  line("target", `${host}:${port}`);
  const strict = await connect(true);

  if (strict.ok) {
    line("cert verification", "✅ passed");
    for (const c of strict.chain) console.log(`     ${c}`);
    console.log("  → TLS is fine; the failure is elsewhere.");
    return;
  }

  line("cert verification", `❌ failed: ${strict.err}${strict.code ? ` (${strict.code})` : ""}`);

  // Read the presented certificate anyway; its issuer identifies the interceptor.
  const loose = await connect(false);
  if (!loose.ok) {
    console.log(`  Cannot establish TCP/TLS at all: ${loose.err}`);
    if (proxy) {
      console.log("  → Tried via proxy, still unreachable.");
      if (/403/.test(loose.err ?? "")) {
        console.log("");
        console.log("  When the proxy refuses, the best clue is how your git gets through --");
        console.log("  if you can push/pull from Azure Repos, a working route exists:");
        console.log("     git config --global --get https.proxy    # differs from HTTPS_PROXY? use it");
        console.log("     If git has no proxy but works, go direct:");
        console.log(`     export NO_PROXY=${host},localhost,127.0.0.1`);
      }
    } else {
      console.log(
        "  → Not a certificate problem, the network is unreachable. If this machine can only " +
          "reach the internet through a corporate proxy, set HTTPS_PROXY (Node's built-in fetch " +
          "ignores it, prloop does not).",
      );
    }
    return;
  }

  console.log("  Certificate chain the server actually presented:");
  for (const c of loose.chain) console.log(`     ${c}`);

  console.log("");

  // The certificates the server presented are exactly what needs trusting; writing them out
  // here removes the usual "go ask IT for the CA file" round trip.
  // Only the authorities are useful here. When the server sends just the leaf — common with
  // an intercepting proxy — there is nothing to export: trusting a leaf would work until the
  // certificate rotates and hides the real fix, which is to trust the issuing CA.
  const authorities = loose.der.slice(1);
  if (authorities.length > 0) {
    const target = exportCaTo ?? path.join(PRLOOP_ROOT, "corporate-ca.pem");
    fs.writeFileSync(target, authorities.map(derToPem).join(""));
    console.log(`  Wrote the issuing authorities to: ${target} (${authorities.length} certs)`);
    console.log("");
    console.log("  Next — put it in .env (applies to every prloop entry point):");
    console.log(`     PRR_CA_CERTS=${target}`);
    console.log("");
    console.log("  ⚠️ These came off this connection; for real use, get the corporate root CA from IT.");
    console.log("");
  } else if (loose.der.length > 0) {
    const issuer = loose.chain[0]?.split("← issuer: ")[1]?.trim() ?? "(unknown)";
    console.log(`  ⚠️ The server sent only its leaf certificate, not the CA that signed it, so there is nothing to export.`);
    console.log(`     The issuer is "${issuer}" -- that CA is what you need, not the leaf.`);
    console.log("     (Trusting the leaf breaks on rotation and hides the real problem.)");
    console.log("");
    console.log(`  How to get it: ${systemCaAdvice()}`);
    console.log("     Or ask IT for that CA's .pem / .crt.");
    console.log("");
    console.log("  To check whether it is already in the system trust store:");
    console.log(`     awk '/BEGIN/{c=""} {c=c $0 RS} /END/{print c | "openssl x509 -noout -subject"; close("openssl x509 -noout -subject")}' \\`);
    console.log(`       /etc/ssl/certs/ca-certificates.crt | grep -i "${issuer.split(".")[0] || "corp"}"`);
    console.log("");
  }
  if (/CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(strict.code ?? strict.err ?? "")) {
    console.log("  → Signed by a CA Node does not trust. The last issuer in the chain above is the CA intercepting you.");
    console.log("     If it is not a public CA (Microsoft / DigiCert etc.), your company runs TLS interception.");
    console.log("");
    console.log("  Fix: point prloop at that CA's cert file (Node ignores the OS trust store)");
    console.log("     .env:  PRR_CA_CERTS=/path/to/corporate-ca.pem");
    console.log("");
    console.log("  Alternatives:");
    console.log(`     • Use the system trust store (your Node is v${process.versions.node}):`);
    console.log(`       ${systemCaAdvice()}`);
    for (const candidate of ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"]) {
      if (fs.existsSync(candidate)) {
        console.log(`     • System CA bundle exists, try: PRR_CA_CERTS=${candidate}`);
      }
    }
    console.log("     • Ask IT for the corporate root CA as .pem / .crt");
    console.log(
      `     • Export it yourself: openssl s_client -showcerts -servername ${host} -connect ${host}:${port} </dev/null \\`,
    );
    console.log("         | openssl x509 -outform PEM > corporate-ca.pem   (take the last cert in the chain)");
    console.log("     • Common location on Linux: /etc/ssl/certs/ca-certificates.crt");
    console.log("");
    console.log(`  Confirmation only, never keep it: NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx scripts/probe.ts '<PR URL>'`);
    console.log("     If that works, it is definitely the certificate. But it disables all cert");
    console.log("     verification -- any man-in-the-middle is accepted. Switch to PRR_CA_CERTS right after.");
  }
}

// Azure DevOps' first-party application id. A token minted for any other resource is
// accepted by the CLI but rejected by the API, which surfaces as a sign-in page rather
// than a clear error.
const ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

/**
 * Same request, issued by the az CLI instead of Node.
 *
 * The az CLI is Python and has its own proxy and certificate configuration, so this
 * separates two failure classes that otherwise look identical: az succeeding while Node
 * fails means the account and permissions are fine and the problem is Node's TLS or proxy
 * setup; both failing points at credentials, permissions or the network itself.
 */
async function probeViaAz(url: string): Promise<void> {
  console.log("\n=== 7. Same API via az CLI (control group) ===");

  if (!(await commandExists(AZ_BIN))) {
    line("az CLI", "not installed, skipping");
    return;
  }
  const acct = await run(AZ_BIN, ["account", "show", "--query", "user.name", "-o", "tsv"], 60_000);
  if (acct.code !== 0) {
    line("az login status", "not logged in");
    console.log("  → Run az login, then retry.");
    return;
  }
  line("az identity", acct.stdout.trim());

  const tok = await run(
    AZ_BIN,
    ["account", "get-access-token", "--resource", ADO_RESOURCE_ID, "--query", "expiresOn", "-o", "tsv"],
    120_000,
  );
  if (tok.code !== 0) {
    line("get ADO token", `failed: ${tok.stderr.trim().slice(0, 200)}`);
    return;
  }
  line("ADO token expires", tok.stdout.trim());

  const res = await run(
    AZ_BIN,
    ["rest", "--method", "get", "--resource", ADO_RESOURCE_ID, "--url", url, "--query", "title", "-o", "tsv"],
    120_000,
  );
  if (res.code === 0) {
    line("az read PR", `✅ success: ${res.stdout.trim().slice(0, 80)}`);
    console.log("");
    console.log("  → az works but prloop does not: account and permissions are fine, the problem is on Node's side:");
    console.log("     certificates (NODE_OPTIONS=--use-system-ca or NODE_EXTRA_CA_CERTS) or proxy.");
    console.log("     az is Python and uses REQUESTS_CA_BUNDLE, a different trust source than Node.");
  } else {
    const err = (res.stderr || res.stdout).trim();
    line("az read PR", `❌ failed`);
    console.log(`  ${err.slice(0, 400)}`);
    console.log("");
    console.log("  → az fails too, so the problem is not Node but the account, permissions or the network.");
    if (/certificate|SSL|CERTIFICATE_VERIFY/i.test(err)) {
      console.log("     Looks like a certificate problem. az reads REQUESTS_CA_BUNDLE.");
    }
    if (/403|Forbidden|does not have permission/i.test(err)) {
      console.log("     403: authenticated but no access to this repo.");
    }
    if (/404|TF401019|does not exist/i.test(err)) {
      console.log("     404: wrong PR id, repo name or project name.");
    }
  }
}

/**
 * Probes which CONNECT header shapes the proxy accepts.
 *
 * When git succeeds and everything else is refused, the deciding factor is some header the
 * proxy inspects — but which one is not knowable from the outside. Rather than guessing one
 * variant at a time, send several and report what comes back; the answer then configures
 * the client instead of another round of speculation.
 */
async function probeConnectVariants(host: string, port: number): Promise<void> {
  const proxy = bypassesProxy(host) ? "" : HTTPS_PROXY || HTTP_PROXY;
  if (!proxy) return;

  console.log("\n=== 4b. Which CONNECT headers the proxy accepts ===");

  const variants: Array<{ name: string; headers: string[] }> = [
    { name: "no extra headers", headers: [] },
    { name: "User-Agent only", headers: [`User-Agent: ${USER_AGENT}`] },
    {
      name: "git-style (User-Agent: git/2.34.1)",
      headers: ["User-Agent: git/2.34.1", "Proxy-Connection: Keep-Alive"],
    },
    {
      name: "undici-style (Host w/o port, close)",
      headers: [`User-Agent: ${USER_AGENT}`, "Connection: close"],
      },
    {
      name: "browser-style",
      headers: [
        "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Proxy-Connection: Keep-Alive",
      ],
    },
  ];

  const pu = new URL(proxy);
  for (const v of variants) {
    const hostHeader = v.name.includes("Host w/o port") ? host : `${host}:${port}`;
    const status = await new Promise<string>((resolve) => {
      const s = net.connect(
        { host: pu.hostname, port: Number(pu.port || 80), timeout: 12_000 },
        () => {
          s.write(
            `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${hostHeader}\r\n` +
              v.headers.map((h) => `${h}\r\n`).join("") +
              "\r\n",
          );
        },
      );
      s.once("data", (buf: Buffer) => {
        s.destroy();
        resolve((buf.toString("utf8").split("\r\n")[0] ?? "").trim());
      });
      s.once("error", (e: NodeJS.ErrnoException) => resolve(`connection error: ${e.message}`));
      s.once("timeout", () => {
        s.destroy();
        resolve("timeout");
      });
    });
    const ok = / 200 /.test(status);
    console.log(`  ${ok ? "✅" : "❌"} ${v.name.padEnd(36)} → ${status}`);
  }
  console.log("");
  console.log("  Any ✅? Report what differs (or set PRR_USER_AGENT to that variant's UA).");
  console.log("  All ❌ means the proxy blocks on source IP, TLS fingerprint or a destination allowlist, not headers.");
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: tsx scripts/probe.ts '<PR URL>'");
    process.exit(1);
  }

  console.log("\n=== 1. Config values and their sources ===");
  reportProvenance([
    "PRR_ADO_PAT",
    "PRR_AUTH_MODE",
    "PRR_ADO_BASE_URL",
    "PRR_ADO_API_VERSION",
    "PRR_LLM_BASE_URL",
    "HTTPS_PROXY",
    "NODE_EXTRA_CA_CERTS",
  ]);
  line("effective api-version", ADO_API_VERSION);
  line("proxy config", proxySummary());
  line("User-Agent", USER_AGENT);
  if (!HTTPS_PROXY && !HTTP_PROXY) {
    console.log("  (On a network that only reaches the internet through a proxy, leaving this unset fails outright)");
  }
  if (!/^\d+\.\d+$/.test(ADO_API_VERSION)) {
    console.log(
      `  ⚠️  "${ADO_API_VERSION}" is malformed. ADO accepts only x.y (e.g. 7.1, 6.0); ` +
        "without the decimal point the server rejects it.",
    );
  }

  console.log("\n=== 2. URL parsing ===");
  const ref = parsePrUrl(url);
  line("collection / org", ref.org);
  line("project", ref.project);
  line("repository", ref.repoId);
  line("PR id", String(ref.prId));
  line("API base", ref.baseUrl);
  if (ref.baseUrl.includes("dev.azure.com")) {
    console.log("  → Azure DevOps Services (cloud). The default api-version 7.1 is fine.");
  } else {
    console.log("  → On-prem Server. api-version must match the server release (2019→5.0, 2020→6.0, 2022→7.0).");
  }

  console.log("\n=== 3. Authentication ===");
  line("mode", await describeAuthMode());
  let header: string;
  try {
    header = await authHeader();
    line("Authorization", `${header.split(" ")[0]} ... (length ${header.length})`);
    if (ADO_PAT && /\s/.test(ADO_PAT)) {
      console.log("  ⚠️  PAT contains whitespace, usually a newline or space picked up when copying.");
    }
  } catch (e) {
    line("auth failed", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const exportIdx = process.argv.indexOf("--export-ca");
  const exportCaTo = exportIdx > 0 ? process.argv[exportIdx + 1] : undefined;
  await probeTls(new URL(ref.baseUrl).hostname, Number(new URL(ref.baseUrl).port || 443), exportCaTo);

  await probeConnectVariants(new URL(ref.baseUrl).hostname, Number(new URL(ref.baseUrl).port || 443));

  console.log("\n=== 5. One real request with the current config ===");
  await rawGet(`${prBase(ref)}?api-version=${ADO_API_VERSION}`, header);

  console.log("\n=== 6. Testing each api-version to find what this server accepts ===");
  const working: string[] = [];
  for (const v of CANDIDATE_VERSIONS) {
    try {
      const url = `${prBase(ref)}?api-version=${v}`;
      const res = await fetch(url, {
        headers: { Authorization: header, Accept: "application/json", "User-Agent": USER_AGENT },
        dispatcher: dispatcherFor(url),
      } as RequestInit);
      const ok = res.ok && (res.headers.get("content-type") ?? "").includes("json");
      console.log(`  api-version=${v.padEnd(4)} → ${res.status} ${res.statusText}${ok ? "  ✅" : ""}`);
      if (ok) working.push(v);
    } catch (e) {
      console.log(`  api-version=${v.padEnd(4)} → connection failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await probeViaAz(`${prBase(ref)}?api-version=${ADO_API_VERSION}`);

  // curl uses the system trust store and honours the proxy variables, so reproducing the
  // same request with it isolates Node from everything else in one step.
  console.log("\n=== 8. Reproduce the same request with curl (isolates Node) ===");
  console.log("  Copy and run this; it uses the system CA and HTTPS_PROXY, unrelated to Node's trust source:");
  console.log("");
  console.log(`    curl -sS -u ":$PRR_ADO_PAT" \\`);
  console.log(`      "${prBase(ref)}?api-version=${ADO_API_VERSION}" | head -c 300`);
  console.log("");
  console.log("  JSON back = PAT valid and network reachable → the problem is Node (certificates or proxy)");
  console.log("  HTML back = PAT invalid or scope insufficient (ADO sends 203 + a sign-in page instead of 401)");

  console.log("\n=== Conclusion ===");
  if (working.length > 0) {
    console.log(`  This server accepts: ${working.join(", ")}`);
    if (!working.includes(ADO_API_VERSION)) {
      console.log(`  You have "${ADO_API_VERSION}" set, which is not in that list.`);
      console.log(`  → Set PRR_ADO_API_VERSION in .env to ${working[0]}, or delete the line to use the default.`);
      console.log(`  → If editing .env has no effect, check for an exported PRR_ADO_API_VERSION in your shell (see section 1).`);
    } else {
      console.log("  api-version is fine. If prloop still fails, the problem is a later stage (model or posting).");
    }
  } else {
    console.log("  Every api-version failed -- the version is not the problem, auth or the network is.");
    console.log("  Read section 4: sign-in page = PAT invalid or scope insufficient;");
    console.log("  404 = wrong PR id or repo name; connection failed = DNS/certificates/proxy.");
  }
  console.log();
}

main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
