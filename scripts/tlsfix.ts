// Finds a TLS configuration that works, by trying them all.
//
// In an intercepted-TLS environment the failure is always the same message but the remedy
// differs: sometimes the corporate root is in the system bundle, sometimes only an
// intermediate is missing, sometimes the bundle lives somewhere only Python was told about.
// Guessing one at a time is slow, so this connects once per candidate and reports which
// ones succeed — then prints the exact line to put in a shell profile.
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as tls from "node:tls";
import { parsePrUrl } from "../ado/client";
import { HTTPS_PROXY, HTTP_PROXY, USER_AGENT, bypassesProxy, dispatcherFor, fetch } from "../libs/proxy";
import { PRLOOP_ROOT } from "../config";

interface Candidate {
  name: string;
  /** undefined = Node's built-in list only. */
  caFile?: string;
  exportLine?: string;
}

function gatherCandidates(): Candidate[] {
  // Named for what it actually exercises: no extra `ca`, so the process inherits whatever
  // NODE_EXTRA_CA_CERTS is already set to. Calling it "built-in only" misleads when the
  // variable is set.
  const current = process.env["NODE_EXTRA_CA_CERTS"];
  const out: Candidate[] = [
    {
      name: current
        ? `Current env (NODE_EXTRA_CA_CERTS=${current})`
        : "Node built-in list (no extra certificates set)",
    },
  ];
  const seen = new Set<string>();

  const add = (file: string, label: string) => {
    if (!file || seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    out.push({
      name: `${label}: ${file}`,
      caFile: file,
      exportLine: `PRR_CA_CERTS=${file}`,
    });
  };

  for (const [env, label] of [
    ["PRR_CA_CERTS", "Configured in .env"],
    ["REQUESTS_CA_BUNDLE", "CA bundle used by Python/az"],
    ["SSL_CERT_FILE", "SSL_CERT_FILE"],
    ["CURL_CA_BUNDLE", "CA bundle used by curl"],
    ["NODE_EXTRA_CA_CERTS", "Currently set"],
  ] as const) {
    add(process.env[env] ?? "", label);
  }
  for (const p of [
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/ca-bundle.pem",
  ]) {
    add(p, "System CA bundle");
  }
  return out;
}

/** Opens a raw socket to the host, tunnelling through the proxy when one is configured. */
function openSocket(host: string, port: number): Promise<net.Socket> {
  const proxy = bypassesProxy(host) ? "" : HTTPS_PROXY || HTTP_PROXY;
  return new Promise((resolve, reject) => {
    if (!proxy) {
      const s = net.connect({ host, port, timeout: 15_000 });
      s.once("connect", () => resolve(s));
      s.once("error", reject);
      s.once("timeout", () => {
        s.destroy();
        reject(new Error("TCP timeout"));
      });
      return;
    }
    const pu = new URL(proxy);
    const s = net.connect({ host: pu.hostname, port: Number(pu.port || 80), timeout: 15_000 });
    s.once("error", reject);
    s.once("timeout", () => {
      s.destroy();
      reject(new Error("proxy timeout"));
    });
    s.once("connect", () => {
      const auth = pu.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(pu.username)}:${decodeURIComponent(pu.password)}`).toString("base64")}\r\n`
        : "";
      s.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n` +
          `User-Agent: ${USER_AGENT}\r\nProxy-Connection: Keep-Alive\r\n${auth}\r\n`,
      );
      s.once("data", (buf: Buffer) => {
        const head = (buf.toString("utf8").split("\r\n")[0] ?? "").trim();
        if (/ 200 /.test(head)) resolve(s);
        else {
          s.destroy();
          reject(new Error(`proxy refused CONNECT: ${head}`));
        }
      });
    });
  });
}

async function tryCandidate(host: string, port: number, c: Candidate): Promise<string> {
  let sock: net.Socket;
  try {
    sock = await openSocket(host, port);
  } catch (e) {
    return `Connection failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  return new Promise<string>((resolve) => {
    const opts: tls.ConnectionOptions = { socket: sock, servername: host, timeout: 20_000 };
    if (c.caFile) {
      try {
        // NODE_EXTRA_CA_CERTS *appends* to the built-in roots, whereas the `ca` option
        // *replaces* them. Testing with the file alone would discard every public CA and
        // report a false failure for any bundle that is missing one — so reproduce the
        // append semantics explicitly.
        opts.ca = [...tls.rootCertificates, fs.readFileSync(c.caFile, "utf8")];
      } catch (e) {
        resolve(`Cannot read certificate file: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    const t = tls.connect(opts, () => {
      const ok = t.authorized;
      const err = t.authorizationError;
      t.destroy();
      resolve(ok ? "OK" : `Verification failed: ${String(err)}`);
    });
    t.once("error", (e: NodeJS.ErrnoException) => resolve(`Verification failed: ${e.message}`));
    t.once("timeout", () => {
      t.destroy();
      resolve("TLS timeout");
    });
  });
}

/**
 * Fetches the issuing certificate named by the leaf's Authority Information Access
 * extension, and writes a bundle that can complete the chain.
 *
 * An intercepting proxy commonly presents only the re-signed leaf, leaving the intermediate
 * that signed it absent from both the handshake and the system store. Browsers paper over
 * this by following the AIA "CA Issuers" URL; Node and OpenSSL do not, which is exactly why
 * the same connection succeeds in a browser and fails here. Doing the fetch ourselves turns
 * an IT request into a local fix.
 */
async function chaseAia(host: string, port: number): Promise<string | undefined> {
  const sock = await openSocket(host, port).catch(() => undefined);
  if (!sock) return undefined;

  const info = await new Promise<Record<string, string[]> | undefined>((resolve) => {
    const t = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false }, () => {
      const cert = t.getPeerCertificate(true) as tls.DetailedPeerCertificate & {
        infoAccess?: Record<string, string[]>;
      };
      t.destroy();
      resolve(cert?.infoAccess);
    });
    t.once("error", () => resolve(undefined));
  });

  const urls = info?.["CA Issuers - URI"] ?? [];
  if (urls.length === 0) {
    console.log("  Certificate has no AIA (CA Issuers) field; cannot fetch the intermediate automatically.");
    return undefined;
  }

  for (const url of urls) {
    console.log(`  Downloading intermediate certificate: ${url}`);
    try {
      const res = await fetch(url, { dispatcher: dispatcherFor(url) });
      if (!res.ok) {
        console.log(`     HTTP ${res.status}, skipped`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // AIA endpoints serve DER; some serve PEM. Normalise to PEM either way.
      const text = buf.toString("utf8");
      const pem = text.includes("BEGIN CERTIFICATE")
        ? text
        : `-----BEGIN CERTIFICATE-----\n${buf.toString("base64").match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END CERTIFICATE-----\n`;
      const target = path.join(PRLOOP_ROOT, "corporate-chain.pem");
      // Append the system bundle so the file alone can complete the whole chain.
      const systemBundle = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"].find(
        (p) => fs.existsSync(p),
      );
      fs.writeFileSync(target, pem + (systemBundle ? fs.readFileSync(systemBundle, "utf8") : ""));
      console.log(`     ✅ Wrote ${target} (intermediate + system CA bundle)`);
      return target;
    } catch (e) {
      console.log(`     Download failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return undefined;
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: tsx scripts/tlsfix.ts '<PR URL>'");
    process.exit(1);
  }
  const ref = parsePrUrl(url);
  const u = new URL(ref.baseUrl);
  const host = u.hostname;
  const port = Number(u.port || 443);

  console.log(`\nTarget: ${host}:${port}`);
  const proxy = bypassesProxy(host) ? "" : HTTPS_PROXY || HTTP_PROXY;
  console.log(`Connection: ${proxy ? `via proxy ${proxy}` : "direct"}`);
  console.log(`\nTesting each certificate config:\n`);

  const candidates = gatherCandidates();
  const winners: Candidate[] = [];

  for (const c of candidates) {
    const result = await tryCandidate(host, port, c);
    const ok = result === "OK";
    if (ok) winners.push(c);
    console.log(`  ${ok ? "✅" : "❌"} ${c.name}`);
    if (!ok) console.log(`       ${result}`);
  }

  console.log("\n" + "=".repeat(70));
  if (winners.length === 0) {
    console.log("All failed — the missing piece is the intermediate certificate that signed the site cert.");
    console.log("");
    console.log("Browsers work because they follow the AIA field in the cert to download that");
    console.log("intermediate. Node and OpenSSL do not. Trying the download now:");
    console.log("");
    const chain = await chaseAia(host, port);
    if (chain) {
      const result = await tryCandidate(host, port, { name: "AIA", caFile: chain });
      console.log("");
      if (result === "OK") {
        console.log("=".repeat(70));
        console.log("✅ Works. Put this in .env:");
        console.log("");
        console.log(`     PRR_CA_CERTS=${chain}`);
        process.exit(0);
      }
      console.log(`  Still failing with the downloaded certificate: ${result}`);
    }
    console.log("");
    console.log("Ask IT for the intermediate CA that signed the proxy certificate, save it as .pem, then:");
    console.log("     .env:  PRR_CA_CERTS=/path/to/that-file.pem");
    console.log("");
    console.log("Or export it from a browser: open the site → click the padlock → certificate →");
    console.log("certification path → pick the middle one → export as Base64/PEM.");
    process.exit(1);
  }

  // If the built-in list already verifies, adding a bundle is noise — recommend nothing.
  const builtinWorks = winners.some((w) => !w.caFile);
  console.log(`${winners.length} working config(s).`);
  console.log("");
  if (builtinWorks) {
    console.log(
      process.env["NODE_EXTRA_CA_CERTS"]
        ? `  ✅ The current setting works (NODE_EXTRA_CA_CERTS=${process.env["NODE_EXTRA_CA_CERTS"]}).\n     Add it to ~/.bashrc to make it permanent.`
        : "  No certificate config needed — Node's built-in list verifies fine.",
    );
    console.log("  Certificates are fine. If prloop still fails, see probe section 5 (HTTP status).");
    console.log("");
    console.log(`     npx tsx scripts/probe.ts '${url}'`);
  } else {
    const best = winners.find((w) => w.exportLine)!;
    console.log("  Recommended:");
    console.log("");
    console.log(`     ${best.exportLine}`);
    console.log("");
    console.log("  Add that line to ~/.bashrc or ~/.zshrc to make it permanent.");
    console.log("  Or just run ./bin/prloop — it picks up other tools' CA bundles automatically.");
    console.log("");
    console.log("  Then run:");
    console.log(`     ${best.exportLine}`);
    console.log(`     npx tsx scripts/probe.ts '${url}'`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
