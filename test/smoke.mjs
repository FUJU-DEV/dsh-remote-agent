// Smoke test for dsh-remote-agent: exercises the pure builders, the marker
// parser, the spill accumulator, config/endpoint resolution, and a live HTTP
// roundtrip against a local mock server. Run AFTER copying lib/index.js into
// the installed profile copy (deps resolve from there):
//
//   node test/smoke.mjs [path-to-installed-lib/index.js]
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const INSTALLED_LIB = process.argv[2] ??
  "C:/Users/Administrator/.dsh/profiles/web/node_modules/dsh-remote-agent/lib/index.js";

const { internals } = await import(pathToFileURL(resolve(INSTALLED_LIB)).href);

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}\n     expected: ${e}\n     actual:   ${a}`);
  }
}

// 1. ssh argument vector -----------------------------------------------------
{
  const args = internals.buildSshArgs("user@host", {
    port: 2222,
    identityFile: "/k/id",
    proxyJump: "jump@bastion",
    connectTimeout: 7,
    strictHostKeyChecking: "no",
    batchMode: false
  });
  check("ssh args", args, [
    "-p", "2222",
    "-i", "/k/id",
    "-J", "jump@bastion",
    "-o", "ConnectTimeout=7",
    "-o", "StrictHostKeyChecking=no",
    "user@host"
  ]);
  const defaults = internals.buildSshArgs("h", {});
  check("ssh defaults", defaults, ["-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "h"]);
}

// 2. command builders ---------------------------------------------------------
{
  const cmd = internals.buildDshRemoteCommand({
    dshCommand: "dsh",
    profile: "headless",
    patch: "/tmp/x.yml",
    permissionMode: "workspace-write",
    env: { FOO: "bar baz", N: 42 },
    prompt: "say 'hi'",
    cwd: "/srv/app"
  });
  check("dsh command", cmd,
    `cd '/srv/app' && DSH_PERMISSION_MODE='workspace-write' FOO='bar baz' N='42' dsh --profile 'headless' --patch '/tmp/x.yml' 'say '\\''hi'\\'''`);
  check("agent command", internals.buildRemoteAgentCommand("claude -p", "do it", "/w"),
    `cd '/w' && claude -p 'do it'`);
}

// 2b. windows shell dialects ---------------------------------------------------
{
  const cmd = internals.buildDshRemoteCommand({
    dshCommand: "dsh",
    profile: "headless",
    patch: "C:\\tmp\\x.yml",
    permissionMode: "workspace-write",
    env: { FOO: "bar 100%" },
    prompt: 'say "hi" 50%',
    cwd: "D:\\work dir",
    shell: "cmd"
  });
  check("cmd dsh command", cmd,
    'cd /d "D:\\work dir" && set "DSH_PERMISSION_MODE=workspace-write"&& set "FOO=bar 100%%"&& dsh --profile "headless" --patch "C:\\tmp\\x.yml" "say ""hi"" 50%%"');
  const ps = internals.buildDshRemoteCommand({
    dshCommand: "dsh",
    profile: "headless",
    patch: null,
    permissionMode: "read-only",
    env: { A: "it's" },
    prompt: "it's a test",
    cwd: "C:\\w",
    shell: "powershell"
  });
  check("powershell dsh command", ps,
    "Set-Location -LiteralPath 'C:\\w'; $env:DSH_PERMISSION_MODE='read-only'; $env:A='it''s'; dsh --profile 'headless' 'it''s a test'");
  check("cmd agent command", internals.buildRemoteAgentCommand("claude -p", 'a "b" %c%', "C:\\x", "cmd"),
    'cd /d "C:\\x" && claude -p "a ""b"" %%c%%"');
  check("cmd quote helper", internals.cmdQuote('50% "x"'), '"50%% ""x"""');
  check("ps quote helper", internals.psSingleQuote("it's"), "'it''s'");
}

// 3. wrapper script -----------------------------------------------------------
{
  const script = internals.buildSshScript({
    innerCommand: "cd '/x' && dsh --profile 'headless' 'task'",
    discover: true,
    sessionsRootExpr: "${DSH_HOME:-$HOME/.dsh}/sessions",
    sshWrapper: true
  });
  for (const needle of [
    "setsid sh -c",
    "__DSH_REMOTE__JOB=%s %s",
    "__DSH_REMOTE__SESSION_ID=%s",
    "find \"$__dsr_sroot\" -mindepth 2 -maxdepth 2",
    "kill -TERM -\"$__dsr_pid\"",
    "wait \"$__dsr_pid\"",
    "exit \"$__dsr_code\"",
    "__dsr_cmd='cd '\\''/x'\\'' && dsh --profile '\\''headless'\\'' '\\''task'\\'''"
  ]) {
    if (!script.includes(needle)) {
      failures += 1;
      console.log(`FAIL wrapper script missing: ${needle}`);
    } else {
      console.log(`ok   wrapper contains: ${needle}`);
    }
  }
  check("wrapper disabled → plain command", internals.buildSshScript({
    innerCommand: "plain",
    discover: false,
    sessionsRootExpr: "X",
    sshWrapper: false
  }), "plain");
}

// 4. kill + fetch scripts ------------------------------------------------------
{
  const kill = internals.buildKillScript("12345", "group");
  check("kill script group form", kill.includes('kill -TERM -"$__dsr_pid"'), true);
  const fetch = internals.buildFetchSessionScript("${DSH_HOME:-$HOME/.dsh}/sessions", "session-abc", 4096, "tail");
  check("fetch script tail", fetch.includes("tail -c 4096"), true);
  check("fetch script zstd fallback", fetch.includes("zstd -dc"), true);
  check("fetch script no-binary-garbage on missing zstd", fetch.includes("remote zstd binary is missing"), true);
}

// 5. marker parser ------------------------------------------------------------
{
  const parser = new internals.MarkerParser();
  let out = parser.feed("__DSH_REMOTE__JOB=123 group\nhello ");
  out += parser.feed("world\n__DSH_REMOTE__SESSION_ID=session-42\nnext");
  out += parser.flush();
  check("marker output", out, "hello world\nnext");
  check("marker values", { ...parser.markers }, { JOB: "123 group", SESSION_ID: "session-42" });
}

// 6. stream accumulator -------------------------------------------------------
{
  const spillDir = mkdtempSync(join(tmpdir(), "dsh-remote-smoke-"));
  const acc = new internals.StreamAccumulator(10, spillDir, "stdout", 100);
  acc.push("01234");
  acc.push("56789");
  acc.push("abcdef");
  const snap = acc.snapshot();
  check("accumulator head", snap.text, "0123456789");
  check("accumulator truncated", snap.truncated, true);
  check("accumulator spill exists", snap.spillPath !== undefined, true);
  check("accumulator delta", acc.readDelta(), "0123456789abcdef");
  acc.finish();
  const spilled = readFileSync(snap.spillPath, "utf8");
  check("accumulator spill content", spilled, "abcdef");
  rmSync(spillDir, { recursive: true, force: true });
}

// 7. endpoint resolution --------------------------------------------------------
{
  const config = {
    transport: "ssh",
    defaultHost: "def@default",
    ssh: { connectTimeout: 10, strictHostKeyChecking: "accept-new", batchMode: true },
    endpoints: {
      prod: { host: "deploy@10.0.0.5", cwd: "/srv/app", ssh: { port: 2222 }, maxPermissionMode: "workspace-write" }
    },
    timeoutSeconds: 600,
    maxOutputBytes: 2048
  };
  const call = internals.resolveCall(config, { endpoint: "prod", connect_timeout: 3 }, "remote_dsh");
  check("endpoint host", call.host, "deploy@10.0.0.5");
  check("endpoint cwd", call.cwd, "/srv/app");
  check("endpoint ssh port", call.ssh.port, 2222);
  check("endpoint connect_timeout override", call.ssh.connectTimeout, 3);
  check("endpoint maxPermissionMode", call.maxPermissionMode, "workspace-write");
  check("endpoint remoteShell default posix", call.remoteShell, "posix");
  const winConfig = {
    ...config,
    remoteShell: "cmd",
    endpoints: {
      ...config.endpoints,
      w: { host: "win@box", remoteShell: "powershell" }
    }
  };
  const winCall = internals.resolveCall(winConfig, { endpoint: "w" }, "remote_dsh");
  check("endpoint remoteShell override", winCall.remoteShell, "powershell");
  const cmdCall = internals.resolveCall(winConfig, { host: "other@box" }, "remote_dsh");
  check("global remoteShell cmd", cmdCall.remoteShell, "cmd");
  let threw = null;
  try {
    internals.resolveCall(config, { endpoint: "nope" }, "remote_dsh");
  } catch (error) {
    threw = error.message;
  }
  check("unknown endpoint throws", typeof threw === "string" && threw.includes("unknown endpoint"), true);
}

// 8. session id validation ------------------------------------------------------
{
  check("valid session id", internals.validateSessionId("session-abc-123"), "session-abc-123");
  check("invalid session id", internals.validateSessionId("../etc"), null);
  check("missing session id", internals.validateSessionId(undefined), null);
}

// 9. live HTTP roundtrip ---------------------------------------------------------
{
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (body.cancel === true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ cancelled: true }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        run_id: "run-1",
        stdout: "final answer\n",
        stderr: "",
        exit_code: 0,
        session_id: "session-http-1"
      }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/run`;

  const run = internals.startHttpRequest({
    url,
    token: null,
    payload: { prompt: "hi", timeout_ms: 5000 },
    timeoutMs: 5000,
    signal: undefined,
    maxOutputBytes: 1024,
    maxSpillBytes: 1024,
    spillDir: join(tmpdir(), "dsh-remote-agent")
  });
  const result = await run.promise;
  check("http ok", result.ok, true);
  check("http exit code", result.exitCode, 0);
  check("http session id", result.sessionId, "session-http-1");
  check("http stdout", result.streams.stdout.text, "final answer\n");

  // cancel path: slow response, cancel mid-flight
  const slow = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (body.cancel === true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ cancelled: true }));
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ run_id: "run-2", stdout: "late", exit_code: 0 }));
      }, 3000);
    });
  });
  await new Promise((done) => slow.listen(0, "127.0.0.1", done));
  const slowUrl = `http://127.0.0.1:${slow.address().port}`;
  const slowRun = internals.startHttpRequest({
    url: slowUrl,
    token: null,
    payload: { prompt: "slow" },
    timeoutMs: undefined,
    signal: undefined,
    maxOutputBytes: 1024,
    maxSpillBytes: 1024,
    spillDir: join(tmpdir(), "dsh-remote-agent")
  });
  slowRun.promise.then((r) => {
    check("http cancel settles cancelled", r.cancelled, true);
    server.close();
    slow.close();
  }).catch(() => {});
  setTimeout(() => slowRun.cancel(), 200);
  await new Promise((done) => setTimeout(done, 500));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
