// End-to-end test of the remote wrapper script, executed under WSL bash:
//  1. group kill: JOB marker → run the kill script → wrapper exits 143,
//     no `sleep 30` survivor.
//  2. stdin watchdog: close stdin → wrapper exits by itself and the remote
//     group is gone (this is what happens when the local ssh client dies).
// Requires WSL with bash + setsid (default on Ubuntu).
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const INSTALLED_LIB = process.argv[2] ??
  "C:/Users/Administrator/.dsh/profiles/web/node_modules/dsh-remote-agent/lib/index.js";
const { internals } = await import(pathToFileURL(resolve(INSTALLED_LIB)).href);

let failures = 0;
const check = (label, ok, detail = "") => {
  if (ok) console.log(`ok   ${label}`);
  else {
    failures += 1;
    console.log(`FAIL ${label} ${detail}`);
  }
};

const sessionsRootExpr = '${DSH_HOME:-$HOME/.dsh}/sessions';
const script = internals.buildSshScript({
  innerCommand: "sleep 30",
  discover: true,
  sessionsRootExpr,
  sshWrapper: true
});

function waitForMarker(run, timeoutMs) {
  return new Promise((resolveMarker) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const match = /^__DSH_REMOTE__JOB=(\d+) (\S+)$/m.exec(run.stdout);
      if (match) {
        clearInterval(timer);
        resolveMarker({ pid: match[1], mode: match[2] });
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolveMarker(null);
      }
    }, 100);
  });
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function survivors() {
  const out = await new Promise((done) => {
    const p = spawn("wsl.exe", ["-e", "sh", "-c", "pgrep -f 'sleep 30' || true"], { stdio: ["ignore", "pipe", "ignore"] });
    let text = "";
    p.stdout.on("data", (c) => { text += c.toString("utf8"); });
    p.on("close", () => done(text.trim()));
  });
  return out;
}

// 1. group kill via the kill script ------------------------------------------
{
  // live-run helper
  const live = () => {
    const child = spawn("wsl.exe", ["-e", "sh", "-c", script], { stdio: ["pipe", "pipe", "pipe"] });
    const state = { child, stdout: "", stderr: "", exited: false, code: null };
    child.stdout.on("data", (c) => { state.stdout += c.toString("utf8"); });
    child.stderr.on("data", (c) => { state.stderr += c.toString("utf8"); });
    child.on("close", (code) => { state.exited = true; state.code = code; });
    return state;
  };

  const state = live();
  const marker = await waitForMarker(state, 15000);
  check("wrapper emitted JOB marker", marker !== null, state.stderr);
  if (marker !== null) {
    check("wrapper marker mode is group", marker.mode, "group");
    const killScript = internals.buildKillScript(marker.pid, marker.mode);
    spawn("wsl.exe", ["-e", "sh", "-c", killScript], { stdio: "ignore" });
    await sleep(4000);
    check("wrapper exited after group kill", state.exited, `code=${state.code} stderr=${state.stderr}`);
    check("wrapper exit code is 143 (SIGTERM)", state.code, 143);
    const alive = await survivors();
    check("no remote sleep survives group kill", alive, "");
  }
  try {
    state.child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

// 2. stdin watchdog: closing stdin must terminate the remote group -----------
{
  const child = spawn("wsl.exe", ["-e", "sh", "-c", script], { stdio: ["pipe", "pipe", "pipe"] });
  const state = { stdout: "", stderr: "", exited: false, code: null };
  child.stdout.on("data", (c) => { state.stdout += c.toString("utf8"); });
  child.stderr.on("data", (c) => { state.stderr += c.toString("utf8"); });
  child.on("close", (code) => { state.exited = true; state.code = code; });
  const marker = await waitForMarker(state, 15000);
  check("watchdog run emitted JOB marker", marker !== null, state.stderr);
  child.stdin.end(); // simulate ssh client death
  await sleep(4000);
  check("wrapper exited after stdin EOF", state.exited, `code=${state.code}`);
  check("wrapper watchdog exit code 143", state.code, 143);
  const alive = await survivors();
  check("no remote sleep survives stdin EOF", alive, "");
  if (!state.exited) child.kill("SIGKILL");
}

// 3. normal completion + session discovery -----------------------------------
{
  const fakeId = `session-fake-${Date.now()}`;
  const discoverScript = internals.buildSshScript({
    innerCommand: `rm -rf /tmp/dsr-test-sessions; mkdir -p /tmp/dsr-test-sessions/--proj--/${fakeId}; sleep 0.3`,
    discover: true,
    sessionsRootExpr: "/tmp/dsr-test-sessions",
    sshWrapper: true
  });
  const out = await new Promise((done) => {
    // stdin must stay open like a real ssh channel ("pipe", never ended);
    // with stdin closed at spawn the watchdog correctly kills the job at once.
    const p = spawn("wsl.exe", ["-e", "sh", "-c", discoverScript], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
    p.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    p.on("close", (code) => done({ code, stdout, stderr }));
  });
  check("normal completion exits 0", out.code === 0, `code=${out.code}`);
  check("normal completion emits JOB marker", /^__DSH_REMOTE__JOB=\d+ group$/m.test(out.stdout), JSON.stringify(out.stdout));
  check("normal completion discovers session id", new RegExp(`^__DSH_REMOTE__SESSION_ID=${fakeId}$`, "m").test(out.stdout), JSON.stringify(out.stdout));
  check("marker lines are the only output", out.stdout.split("\n").filter(Boolean).length === 2, JSON.stringify(out.stdout));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
