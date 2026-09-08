// Fake HTTP servers for the offline selftests.
//
// These are TEST INFRASTRUCTURE, not a dependency: node:http and plain objects only, so the
// "undici is the only runtime dependency" rule keeps holding. They exist because the modules
// that talk to the outside world — models/runner.ts, publish/, ado/ — had every pure helper
// covered and every side-effecting path untested, which is exactly where a retry that never
// fires, a duplicated summary comment or a dropped second page of changes hides.
//
// Two rules every fake here obeys, because breaking either turns a regression net into a
// source of flakes:
//   - port 0, never a fixed port. Two suites (or two CI matrix cells) run at once, and a
//     hard-coded port makes them fight over it — or worse, quietly talk to a leftover
//     process from the last run.
//   - close() calls closeAllConnections() before close(). A keep-alive socket that fetch
//     left open holds the event loop, and the selftest then hangs at 100% pass instead of
//     exiting — a green run nobody ever sees.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeServer {
  /** The port the OS assigned. Never chosen by us. */
  port: number;
  /** `http://127.0.0.1:<port>` — no trailing slash, ready to concatenate. */
  origin: string;
  close(): Promise<void>;
}

/** Starts `handler` on an ephemeral port on the loopback interface. */
export async function listen(handler: http.RequestListener): Promise<FakeServer> {
  const server = http.createServer((req, res) => {
    // A test that aborts a request mid-body (the deadline tests do) makes the server side
    // emit ECONNRESET. Unhandled, that is an uncaught exception that kills the whole run.
    req.on("error", () => {});
    res.on("error", () => {});
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The full request body as text. */
export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (buf += c));
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}
