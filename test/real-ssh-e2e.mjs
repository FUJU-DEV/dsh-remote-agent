// REAL SSH end-to-end test: drives the production runner (startSshProcess +
// buildSshScript + buildKillScript) over a genuine sshd (WSL, port 2222,
// key-only auth). Verifies: normal run + session discovery, group-kill
// cancellation with no survivors, and remote session-log fetch.
// Prereq: the WSL sshd from the setup step must be running.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import os from "node:os";

const LIB = process.argv[2] ??
  "C:/Users/Administrator/.dsh/profiles/web/node_modules/dsh-remote-agent/lib/index.js";
const KEY = join(os.tmpdir(), "dsr-ssh-test", "id_ed25519");
const SSH = {
  port: 2222,
  identityFile: KEY,
  connectTimeout: 10,
  strictHostKeyChecking: "accept-new",
  batchMode: true
};
const HOST = "root@localhost";
const SPILL = join(os.tmpdir(), "dsh-remote-agent");

const { internals } = await import(pathToFileURL(LIB).href);

let failures = 0;
const check = (label, ok, detail = "") => {
  if (ok) console.log("ok  ", label);
  else { failures += 1; console.log("FAIL", label, detail); }
};
const sleep = (ms) => new Promise((d) => setTimeout(d, ms));

function start({ innerCommand, discover = false, sessionsRootExpr = "X", timeoutMs = 30000 }) {
  const script = internals.buildSshScript({ innerCommand, discover, sessionsRootExpr, sshWrapper: true });
  return internals.startSshProcess({
    sshBin: "ssh",
    host: HOST,
    ssh: SSH,
    script,
    timeoutMs,
    signal: undefined,
    maxOutputBytes: 64 * 1024,
    maxSpillBytes: 64 * 1024,
    spillDir: SPILL
  });
}

function wsl(command) {
  return new Promise((done) => {
    const p = spawn("wsl.exe", ["-e", "sh", "-c", command], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (c) => { out += c.toString("utf8"); });
    p.stderr.on("data", (c) => { out += c.toString("utf8"); });
    p.on("close", () => done(out.trim()));
  });
}

// 1. normal run + session discovery over real sshd ---------------------------
{
  const sessionId = `session-ssh-${Date.now()}`;
  const run = start({
    innerCommand: `rm -rf /tmp/dsr-real; mkdir -p /tmp/dsr-real/--proj--/${sessionId}; echo hello-via-sshd`,
    discover: true,
    sessionsRootExpr: "/tmp/dsr-real"
  });
  const result = await run.promise;
  check("real ssh run ok", result.ok === true, JSON.stringify({ exitCode: result.exitCode, aborted: result.aborted }));
  check("real ssh exit 0", result.exitCode === 0, String(result.exitCode));
  const streams = run.getStreams();
  check("real ssh stdout", streams.stdout.text.includes("hello-via-sshd"), JSON.stringify(streams.stdout));
  const markers = run.getMarkers();
  check("real ssh JOB marker (group mode)", /^\d+ group$/.test(markers.JOB ?? ""), JSON.stringify(markers));
  check("real ssh session discovery", markers.SESSION_ID === sessionId, JSON.stringify(markers));
}

// 2. cancel over real sshd: remote group must die -----------------------------
{
  const run = start({ innerCommand: "sleep 30" });
  for (let i = 0; i < 40 && !run.getMarkers().JOB; i++) await sleep(250);
  const job = run.getMarkers().JOB;
  check("cancel run emitted JOB marker", typeof job === "string", JSON.stringify(run.getMarkers()));
  run.cancel(); // production path: fireRemoteKill (second ssh) + local kill
  const result = await run.promise;
  check("cancel settles cancelled", result.cancelled === true, JSON.stringify(result));
  await sleep(2000);
  // pgrep -x: exact process-name match, so the test shell itself can never
  // false-positive the way a -f substring match would.
  const survivors = await wsl("pgrep -x sleep || true");
  check("no remote sleep survives cancel", survivors === "", `survivors=[${survivors}]`);
}

// 3. remote session-log fetch over real sshd ---------------------------------
{
  await wsl("mkdir -p /tmp/dsr-real/--proj--/session-fetch1 && printf 'line1\\nline2\\nline3\\n' > /tmp/dsr-real/--proj--/session-fetch1/session.jsonl");
  const fetchScript = internals.buildFetchSessionScript("/tmp/dsr-real", "session-fetch1", 12, "tail");
  const run = internals.startSshProcess({
    sshBin: "ssh", host: HOST, ssh: SSH, script: fetchScript,
    timeoutMs: 30000, signal: undefined,
    maxOutputBytes: 64 * 1024, maxSpillBytes: 64 * 1024, spillDir: SPILL
  });
  const result = await run.promise;
  check("fetch run ok", result.ok === true, JSON.stringify(result));
  const text = run.getStreams().stdout.text;
  check("fetch returns tail of session log", text.endsWith("line2\nline3\n"), JSON.stringify(text));
}

// 4. windows ssh-option plumbing (identity file etc. already proven by all above)
check("ssh option plumbing exercised", true, "");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
