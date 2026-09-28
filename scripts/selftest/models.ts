// Model transport edges: the opencode runner, spawning and killing processes, naming a
// failure precisely, and the concurrency cap. The HTTP runner has its own net
// (selftest-runner.ts).
import type { ChatRequest } from "../../libs/types";
import { Semaphore } from "../../libs/limit";
import { badCompletion, describeBadCompletion, isTransient } from "../../models/runner";
import { explainSpawnError, planSpawn, planKill, killTree } from "../../libs/shell";
import { spawn as spawnChild } from "node:child_process";
import {
  DEFAULT_AGENT_FALLBACK,
  buildInvocation,
  reviewerAgentConfig,
  runFailure,
  traceEvent,
  type Acc,
} from "../../models/opencode";
import { PRLOOP_ROOT } from "../../config";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { run } from "../../libs/shell";
import { check, eq, section, skip } from "./harness";

section("Windows process spawning");
{
  // planSpawn is platform-parameterised so these run on any host.
  const posix = planSpawn("opencode", ["run", "--agent", "x", "a prompt"], "linux");
  eq("posix passes the command through untouched", posix.file, "opencode");
  check("posix needs no verbatim-args flag", posix.windowsVerbatimArguments === undefined);
  check("posix has no length objection", posix.error === undefined);

  // The command line limit is the failure that only appears on the user's platform: Linux
  // allows ~2MB, cmd.exe allows 8191. A review prompt carrying a diff is far over.
  const huge = planSpawn("C:\\tools\\opencode.exe", ["run", "x".repeat(40_000)], "win32");
  check("oversized command line is refused, not spawned", huge.error !== undefined);
  check("...and says what to do instead", (huge.error ?? "").includes("stdin"));

  // A .cmd shim gets the lower cmd.exe limit, and must say so — 12k chars fits Windows
  // but not cmd.exe, which is exactly the confusing middle case.
  const shim = planSpawn("C:\\tools\\opencode.cmd", ["run", "x".repeat(12_000)], "win32");
  check("shim applies the stricter cmd.exe limit", (shim.error ?? "").includes("8191"));

  // Every spawn errno needs its own explanation: they have different fixes and the old
  // message blamed a missing install for all of them.
  const ex = (code: string) => explainSpawnError(Object.assign(new Error("x"), { code }), "opencode");
  check("ENOENT blames PATH", ex("ENOENT").includes("not found"));
  check("EINVAL names the .cmd rule", ex("EINVAL").includes("cmd.exe"));
  check("E2BIG names the length", ex("E2BIG").includes("too long"));
  check("ENAMETOOLONG names the length", ex("ENAMETOOLONG").includes("too long"));
  check("EACCES names permissions", ex("EACCES").includes("executable"));
  check("unknown code still reports something", ex("EWEIRD").includes("failed to start"));
}

section("killing the process tree on timeout");
{
  // Windows has no signals: Node maps them all to TerminateProcess, so the only way to reach
  // the tree is taskkill, and there is no gentler first attempt to make.
  const win = planKill(4242, "SIGTERM", "win32");
  check("win32 uses taskkill with the tree and force flags",
    win.via === "taskkill" && win.args.join(" ") === "/pid 4242 /T /F");
  eq("win32 SIGKILL is the same plan as SIGTERM",
    JSON.stringify(planKill(4242, "SIGKILL", "win32")), JSON.stringify(win));

  // POSIX signals the process group — a negative pid — not the single process we hold.
  const posixTerm = planKill(4242, "SIGTERM", "linux");
  check("posix targets the process group, not the lone child",
    posixTerm.via === "signal" && posixTerm.target === -4242 && posixTerm.signal === "SIGTERM");
  const posixKill = planKill(4242, "SIGKILL", "linux");
  check("posix keeps the escalated signal", posixKill.via === "signal" && posixKill.signal === "SIGKILL");

  // The regression end to end: a wrapper with a longer-lived child, the shape cmd.exe +
  // opencode makes on Windows. child.kill() would leave the grandchild running.
  if (process.platform !== "win32") {
    const wrapper = spawnChild("sh", ["-c", "sleep 30 & echo $!; wait"], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true, // what the runner now does; the group signal depends on it
    });
    const grandchild = await new Promise<number>((res) => {
      wrapper.stdout.setEncoding("utf8");
      wrapper.stdout.once("data", (d: string) => res(Number(d.trim())));
    });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const reap = (pid: number) => {
      if (pid > 0 && alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };

    // Reaping a grandchild needs the OS to actually deliver a signal to the process GROUP,
    // and a sandboxed container may refuse to — which is an environment restriction, not a
    // bug in killTree. Probed with a raw process.kill on the group, deliberately NOT through
    // killTree: using the code under test as its own environment probe would turn a killTree
    // that stopped working into a silent skip.
    const probe = spawnChild("sh", ["-c", "sleep 30 & echo $!; wait"], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    const probeGrandchild = await new Promise<number>((res) => {
      probe.stdout.setEncoding("utf8");
      probe.stdout.once("data", (d: string) => res(Number(d.trim())));
    });
    try {
      // Guarded: process.kill(-0) would signal OUR OWN process group, i.e. the selftest.
      if (probe.pid !== undefined && probe.pid > 0) process.kill(-probe.pid, "SIGKILL");
    } catch {
      /* EPERM/ESRCH: group signals are not available here at all */
    }
    await new Promise((r) => setTimeout(r, 300));
    const groupSignalsDelivered = !alive(probeGrandchild);
    reap(probe.pid ?? 0);
    reap(probeGrandchild);

    check("precondition: the grandchild is running", alive(grandchild));
    killTree(wrapper, "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    if (groupSignalsDelivered) {
      check("killTree reaps the grandchild too", !alive(grandchild));
    } else {
      skip("killTree reaps the grandchild too", "this environment does not deliver process-group signals");
    }
    check("killTree reaps the wrapper", wrapper.exitCode !== null || wrapper.signalCode !== null);
    check("killTree on an already-dead process does not throw", (() => {
      try {
        killTree(wrapper, "SIGKILL");
        return true;
      } catch {
        return false;
      }
    })());
    // Whatever survived the group signal is ours to clean up: a leaked `sleep 30` outlives
    // the selftest and holds the container busy long after it printed its result.
    reap(grandchild);
  }
}

section("opencode invocation: prompt delivery");
{
  // The prompt is delivered on the child's stdin, so argv carries flags only. Nothing about
  // the prompt may appear there: cmd.exe re-parses the command line on Windows, and it is
  // capped at 8191 chars, while a review prompt carrying a diff runs to six figures.
  const opts = { jsonEvents: true, agent: "prloop-reviewer" };
  const args = buildInvocation("m", opts);
  eq("argv is flags only, no positional prompt", args, ["run", "--agent", "prloop-reviewer", "--model", "m", "--format", "json"]);
  check("no --file", !args.includes("--file"));
  eq("agent flag is always present", args[1], "--agent");
  check("json format requested when configured", args.includes("--format") && args.includes("json"));

  const noModel = buildInvocation("", { ...opts, jsonEvents: false });
  eq("no --model when empty, no --format when disabled", noModel, ["run", "--agent", "prloop-reviewer"]);

  // Whatever the prompt looks like, a flags-only argv cannot hit the cmd.exe limit.
  check("flags-only argv is always within the cmd.exe limit", planSpawn("opencode.cmd", args, "win32").error === undefined);
}

section("opencode: a killed or crashed run is a named failure, not an empty answer");
{
  // Both used to resolve { text, model } with no error and surface downstream as "output
  // unparseable" / "empty string" — the deterministic class the transient retry skips.
  const base = { timedOut: false, timeoutMs: 900_000, code: 0, signal: null, text: "" };
  eq("a timeout is named with the knob's value",
    runFailure({ ...base, timedOut: true, code: null, signal: "SIGTERM", text: '{"findings":[' })?.message, "timeout (900000ms)");
  check("...and the transient retry fires on it", isTransient({ errorKind: runFailure({ ...base, timedOut: true })!.kind }));
  eq("a non-zero exit with no output is named", runFailure({ ...base, code: 1 })?.message, "opencode exited 1");
  eq("...carrying the CLI's own error event",
    runFailure({ ...base, code: 1, lastError: "ProviderAuthError: no API key" })?.message, "opencode exited 1: ProviderAuthError: no API key");
  eq("an error event with a clean exit and no output is the error", runFailure({ ...base, lastError: "rate limited" }), { kind: "api", message: "rate limited" });
  eq("a signal death is named", runFailure({ ...base, code: null, signal: "SIGKILL" }), { kind: "process", message: "opencode killed by SIGKILL" });
  eq("a completed run with output has no error", runFailure({ ...base, text: '{"findings":[]}' }), undefined);
  eq("a non-zero exit next to real output is left to the parser", runFailure({ ...base, code: 1, text: '{"findings":[]}' }), undefined);
  eq("a clean, silent exit is not this layer's error (the parser names the empty answer)", runFailure(base), undefined);

  const acc: Acc = { text: "", lastText: "" };
  traceEvent('{"type":"error","error":{"name":"ProviderError","data":{"message":"401 unauthorized"}}}', "[t]", acc);
  eq("the error event's message is kept for the failure", acc.lastError, "401 unauthorized");
  traceEvent('{"type":"text","part":{"type":"text","text":"{}"}}', "[t]", acc);
  eq("...and text events leave it alone", acc.lastError, "401 unauthorized");

  // Token accounting on this path used to be zeros: the CLI reports usage per step-finish
  // and traceEvent only logged it, so tokenTotals() and result.json said a run under
  // PRR_RUNNER=opencode had cost nothing, while libs/payload.ts budgeted the diff against a
  // ceiling nothing on the path measured.
  const billed: Acc = { text: "", lastText: "" };
  eq("no step-finish yet means no claim about usage", billed.inputTokens, undefined);
  traceEvent('{"type":"step-finish","part":{"type":"step-finish","tokens":{"input":1200,"output":300}}}', "[t]", billed);
  traceEvent('{"type":"step-finish","part":{"type":"step-finish","tokens":{"input":1500,"output":90}}}', "[t]", billed);
  eq("every step is billed, so every step is counted", billed.inputTokens, 2700);
  eq("...output too", billed.outputTokens, 390);
  traceEvent('{"type":"step-finish","part":{"type":"step-finish","tokens":{"input":"lots"}}}', "[t]", billed);
  eq("a value that is not a number does not corrupt the total", billed.inputTokens, 2700);
}

section("opencode runner: a field it cannot honour is named, not dropped");
{
  // ChatRequest is a contract. The opencode CLI has no sampling or output-length argument,
  // so PRR_SKEPTIC_MAX_TOKENS and the requirement axis's temperature: 0 reached this
  // adapter, were accepted by the type and applied to nothing. The timeout it CAN keep, and
  // used to ignore: every skeptic call got the 15-minute agent deadline instead of its own.
  //
  // A fresh process, pointed at a binary that cannot spawn: config is read at import, and
  // this must never risk invoking a real opencode on the operator's machine.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-opencode-"));
  const probe = path.join(dir, "probe.mts");
  const mod = pathToFileURL(path.join(PRLOOP_ROOT, "models", "opencode.ts")).href;
  fs.writeFileSync(
    probe,
    `import { OpencodeRunner } from ${JSON.stringify(mod)};\n` +
      `const r = new OpencodeRunner();\n` +
      `const req = { model: "m", system: "s", user: "u", temperature: 0, maxTokens: 2048, timeoutMs: 1500 };\n` +
      `await r.chat(req);\n` +
      `await r.chat({ ...req, schemaName: "second-call" });\n`,
  );
  const res = spawnSync(process.execPath, [path.join(PRLOOP_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), probe], {
    encoding: "utf8",
    env: { ...process.env, PRR_OPENCODE_BIN: "prloop-no-such-binary", PRR_AGENT_TIMEOUT_MS: "900000" },
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  check("opencode probe ran", res.status === 0, out.slice(0, 400));
  eq("temperature is reported as not applied, once", out.split("temperature=0 is not applied").length - 1, 1);
  eq("maxTokens is reported as not applied, once", out.split("maxTokens=2048 is not applied").length - 1, 1);
  check("...naming the runner it does not reach", out.includes("on the opencode runner"));

  // ...and the timeout it CAN honour, against a binary that hangs. PRR_AGENT_TIMEOUT_MS is
  // 900000 here; if req.timeoutMs were still being ignored, this probe would sit for
  // fifteen minutes instead of naming 1500ms.
  if (process.platform !== "win32") {
    const hang = path.join(dir, "hang.sh");
    fs.writeFileSync(hang, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const started = Date.now();
    const t = spawnSync(process.execPath, [path.join(PRLOOP_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), probe], {
      encoding: "utf8",
      env: { ...process.env, PRR_OPENCODE_BIN: hang, PRR_AGENT_TIMEOUT_MS: "900000" },
      timeout: 60_000,
    });
    const took = Date.now() - started;
    const tout = `${t.stdout ?? ""}${t.stderr ?? ""}`;
    check("the call's own deadline is honoured, not the agent default", tout.includes("timed out after 1500ms"), tout.slice(0, 400));
    check("...and the agent default is not what fired", !tout.includes("timed out after 900000ms"));
    check("...so the call returns in seconds, not minutes", took < 40_000, `${took}ms`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

section("opencode runner: prloop's own agent, no tools, and nowhere near .env");
{
  // `opencode run --agent` falls back to the DEFAULT agent — every tool on — for a subagent,
  // and prloop's agent file declared itself one; it falls back the same way for an agent it
  // cannot find. So the agent is defined at run time, and the fallback is a tripwire.
  const cfg = reviewerAgentConfig("prloop-reviewer", "Answer in JSON.") as {
    agent: Record<string, { mode?: string; prompt?: string; permission?: Record<string, string>; tools?: Record<string, boolean> }>;
  };
  const agent = cfg.agent["prloop-reviewer"]!;
  eq("the agent is primary, so `run --agent` does not fall back past it", agent.mode, "primary");
  eq("every permission is denied, by name and by wildcard",
    Object.values(agent.permission ?? {}).every((v) => v === "deny") && agent.permission?.["*"] === "deny" && agent.permission?.["bash"] === "deny" && agent.permission?.["read"] === "deny",
    true);
  check("...and the older tools spelling says the same", Object.values(agent.tools ?? {}).every((v) => v === false));
  const own = (reviewerAgentConfig("team-agent") as { agent: Record<string, { prompt?: string; permission?: Record<string, string> }> }).agent["team-agent"]!;
  check("an operator's own agent keeps its instructions", own.prompt === undefined);
  eq("...but not its tools", own.permission?.["bash"], "deny");
  check("a fallback line is recognised", DEFAULT_AGENT_FALLBACK.test('! agent "prloop-reviewer" is a subagent, not a primary agent. Falling back to default agent'));
  check("...and turned into a refusal, whatever the run produced",
    (runFailure({ timedOut: false, timeoutMs: 1, code: 0, signal: null, text: '{"findings":[]}', killedOn: "Falling back to default agent" })?.message ?? "").includes("fell back to its default one"));

  if (process.platform !== "win32") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prloop-sandbox-"));
    try {
      // A child that announces the wrong thing and would then go on doing it for 30s.
      const loud = path.join(dir, "loud.sh");
      fs.writeFileSync(loud, "#!/bin/sh\necho 'about to use the default agent'\nsleep 30\n", { mode: 0o755 });
      const t0 = Date.now();
      const killed = await run(loud, [], 60_000, dir, { killOn: /default agent/ });
      check("a child is killed on the line it was told to watch for", killed.killedOn === "about to use the default agent", JSON.stringify(killed));
      check("...at once, not after its 30 seconds", Date.now() - t0 < 10_000, `${Date.now() - t0}ms`);
      check("...and the run reports failure", killed.code !== 0);

      // The real runner against a fake opencode that reports what it was given.
      const fake = path.join(dir, "opencode");
      fs.writeFileSync(
        fake,
        "#!/usr/bin/env node\n" +
          "const fs = require('fs');\n" +
          "fs.readFileSync(0);\n" +
          "const seen = { cwd: process.cwd(), inline: process.env.OPENCODE_CONFIG_CONTENT ?? null,\n" +
          "  project: fs.existsSync('opencode.json') ? fs.readFileSync('opencode.json', 'utf8') : null,\n" +
          "  pat: Object.values(process.env).includes('pat-that-must-not-reach-the-child'), env: fs.existsSync('.env') };\n" +
          "console.log(JSON.stringify({ type: 'text', part: { type: 'text', text: JSON.stringify(seen) } }));\n",
        { mode: 0o755 },
      );
      const probe = path.join(dir, "probe.mts");
      const mod = pathToFileURL(path.join(PRLOOP_ROOT, "models", "opencode.ts")).href;
      fs.writeFileSync(probe, `import { OpencodeRunner } from ${JSON.stringify(mod)};\nconst r = new OpencodeRunner();\nconst res = await r.chat({ model: "m", system: "s", user: "u" });\nconsole.log("SEEN " + res.text);\n`);
      const res = spawnSync(process.execPath, [path.join(PRLOOP_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), probe], {
        encoding: "utf8",
        cwd: PRLOOP_ROOT,
        env: { ...process.env, PRR_OPENCODE_BIN: fake, PRR_ADO_PAT: "pat-that-must-not-reach-the-child" },
        timeout: 60_000,
      });
      const line = `${res.stdout ?? ""}`.split("\n").find((l) => l.startsWith("SEEN ")) ?? "";
      const seen = (() => {
        try {
          return JSON.parse(line.slice(5)) as { cwd: string; inline: string | null; project: string | null; pat: boolean; env: boolean };
        } catch {
          return undefined;
        }
      })();
      check("the fake opencode ran", seen !== undefined, `${res.stdout ?? ""}${res.stderr ?? ""}`.slice(0, 400));
      if (seen) {
        check("opencode runs outside prloop's directory", path.resolve(seen.cwd) !== path.resolve(PRLOOP_ROOT), seen.cwd);
        check("...in one with no .env beside it", !seen.env);
        check("the inline config denies every tool", (seen.inline ?? "").includes('"*": "deny"'), seen.inline ?? "(none)");
        eq("...and the directory's own opencode.json says the same", seen.project, seen.inline);
        eq("the credential scrub still holds", seen.pat, false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

section("unusable completions are named, not left to the JSON parser");
{
  const ok = { message: { content: '{"findings":[]}' }, finish_reason: "stop" };
  check("a good completion passes", describeBadCompletion(ok, 8192) === undefined);

  // Thinking models bill chain of thought to the same budget, so this is the common
  // failure on a self-hosted reasoning model, not an edge case.
  const cut = { message: { content: '{"findings":[{"file"', reasoning: "x".repeat(9000) }, finish_reason: "length" };
  const cutMsg = describeBadCompletion(cut, 8192) ?? "";
  check("truncation is reported as truncation", cutMsg.includes("truncated"));
  check("...names the knob to turn", cutMsg.includes("PRR_LLM_MAX_TOKENS"));
  check("...and blames the reasoning budget when there was reasoning", cutMsg.includes("reasoning"));

  const allThought = { message: { content: "", reasoning: "x".repeat(500) }, finish_reason: "stop" };
  check("reasoning-only response is named", (describeBadCompletion(allThought, 8192) ?? "").includes("only reasoning"));

  const empty = { message: { content: "" }, finish_reason: "stop" };
  check("plain empty response is named", (describeBadCompletion(empty, 8192) ?? "").includes("empty"));
  check("missing choice is named", describeBadCompletion(undefined, 8192) !== undefined);
}

section("transient vs deterministic model failures");
{
  // Retrying a schema/auth rejection just burns endpoint time; retrying a timeout is free
  // recall. The live failure that motivated this was an HTTP 400 (never retry) sitting next
  // to timeouts (always retry) in the same run.
  // Decided on the kind the runner assigned where the failure happened, never on the words.
  check("timeout retries", isTransient({ errorKind: "timeout" }));
  check("socket error retries", isTransient({ errorKind: "transport" }));
  check("500 retries", isTransient({ errorKind: "http", status: 500 }));
  check("502 retries", isTransient({ errorKind: "http", status: 502 }));
  check("429 retries", isTransient({ errorKind: "http", status: 429 }));
  check("408 retries", isTransient({ errorKind: "http", status: 408 }));
  check("400 does NOT retry", !isTransient({ errorKind: "http", status: 400 }));
  check("401 does NOT retry", !isTransient({ errorKind: "http", status: 401 }));
  check("404 does NOT retry", !isTransient({ errorKind: "http", status: 404 }));
  // The refusals are the 4xx, not everything outside 5xx: the old message patterns only ever
  // singled out `HTTP 4xx`, and a refactor is not the place to start refusing more.
  check("a status outside 4xx and 5xx still retries", isTransient({ errorKind: "http", status: 302 }));
  check("a failure with no kind retries, as an unrecognised message always did", isTransient({}));
  // Deterministic bad completions: the retry would burn a second full-length call to
  // reproduce the identical failure.
  check("token-limit truncation does NOT retry", !isTransient({ errorKind: "truncated" }));
  check("empty response does NOT retry", !isTransient({ errorKind: "empty" }));
  check("reasoning-only response does NOT retry", !isTransient({ errorKind: "reasoning-only" }));
  check("non-JSON body does NOT retry", !isTransient({ errorKind: "not-json" }));
  // And the kinds are what the checks that find these failures assign.
  eq(
    "a truncated, a reasoning-only and an empty completion are told apart",
    [
      badCompletion({ message: { content: "{" }, finish_reason: "length" }, 8192)?.kind,
      badCompletion({ message: { content: "", reasoning: "hmm" }, finish_reason: "stop" }, 8192)?.kind,
      badCompletion({ message: { content: "" }, finish_reason: "stop" }, 8192)?.kind,
    ],
    ["truncated", "reasoning-only", "empty"],
  );
}

section("model call concurrency cap");
{
  const sem = new Semaphore(3);
  let peak = 0;
  let running = 0;
  const task = () =>
    sem.run(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    });
  await Promise.all(Array.from({ length: 20 }, task));
  eq("never exceeds the limit", peak, 3);
  eq("every slot is returned", sem.inFlight, 0);
  eq("nothing left queued", sem.waiting, 0);

  // A stage that throws must not leak its slot, or a few failures deadlock the whole run.
  const s2 = new Semaphore(1);
  await Promise.allSettled([
    s2.run(async () => {
      throw new Error("boom");
    }),
  ]);
  eq("a throwing call releases its slot", s2.inFlight, 0);
  let ran = false;
  await s2.run(async () => {
    ran = true;
  });
  check("the semaphore still works after a throw", ran);

  // 0 disables the cap rather than blocking forever.
  const s3 = new Semaphore(0);
  eq("limit 0 means unlimited", await s3.run(async () => 42), 42);
}
