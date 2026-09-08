// THE real thing: the plugin's production code path driving a REAL remote DSH
// headless session over a genuine sshd (Ubuntu in WSL, key auth, DSH 0.1.2-rc.1
// installed). Verifies: remote agent session runs + answers, session-id
// discovery matches the persisted session on the remote, session-log fetch,
// and resume (log-tail context injection into a follow-up session).
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import os from "node:os";

const LIB = process.argv[2] ??
  "C:/Users/Administrator/.dsh/profiles/web/node_modules/dsh-remote-agent/lib/index.js";
const KEY = join(os.tmpdir(), "dsr-ssh-test", "id_ed25519");
const SSH = { port: 2222, identityFile: KEY, connectTimeout: 10, strictHostKeyChecking: "accept-new", batchMode: true };
const HOST = "root@localhost";

const { internals } = await import(pathToFileURL(LIB).href);

let failures = 0;
const check = (label, ok, detail = "") => {
  if (ok) console.log("ok  ", label);
  else { failures += 1; console.log("FAIL", label, detail); }
};

async function wsl(command) {
  return new Promise((done) => {
    const p = spawn("wsl.exe", ["-d", "Ubuntu-22.04", "-u", "root", "-e", "bash", "-c", command], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (c) => { out += c.toString("utf8"); });
    p.stderr.on("data", (c) => { out += c.toString("utf8"); });
    p.on("close", () => done(out.trim()));
  });
}

function runDsh({ prompt, discover = true, timeoutMs = 300000 }) {
  const inner = internals.buildDshRemoteCommand({
    dshCommand: "dsh",
    profile: "headless",
    permissionMode: "workspace-write",
    prompt,
    cwd: "/root"
  });
  const script = internals.buildSshScript({
    innerCommand: inner,
    discover,
    sessionsRootExpr: "${DSH_HOME:-$HOME/.dsh}/sessions",
    sshWrapper: true
  });
  return {
    script,
    handle: internals.startSshProcess({
      sshBin: "ssh", host: HOST, ssh: SSH, script,
      timeoutMs, signal: undefined,
      maxOutputBytes: 256 * 1024, maxSpillBytes: 256 * 1024,
      spillDir: join(os.tmpdir(), "dsh-remote-agent")
    })
  };
}

// 1. real remote DSH session via the plugin -----------------------------------
let firstSessionId = null;
{
  const { handle } = runDsh({ prompt: "记住这个暗号「黄瓜999」，然后用一句话确认你记住了。" });
  const result = await handle.promise;
  check("remote dsh session completed", result.ok === true, JSON.stringify({ exitCode: result.exitCode, timedOut: result.timedOut, aborted: result.aborted }));
  const streams = handle.getStreams();
  check("remote answer captured", streams.stdout.text.includes("黄瓜999") || streams.stdout.text.length > 20, JSON.stringify(streams.stdout.text).slice(0, 300));
  const markers = handle.getMarkers();
  check("session id discovered", /^session-[0-9a-f-]+$/.test(markers.SESSION_ID ?? ""), JSON.stringify(markers));
  firstSessionId = markers.SESSION_ID ?? null;
  if (firstSessionId !== null) {
    const exists = await wsl(`ls /root/.dsh/sessions/*/${firstSessionId}/session.jsonl.zstd >/dev/null 2>&1 && echo yes || echo no`);
    check("discovered id matches the persisted remote session", exists === "yes", `id=${firstSessionId}`);
    const remoteLog = await wsl(`ls /root/.dsh/sessions | head -n 5`);
    console.log("     remote sessions root projects:", JSON.stringify(remoteLog));
  }
}

// 2. fetch_session: pull the real remote log back ------------------------------
{
  const resolvedCall = {
    sessionsRootExpr: "${DSH_HOME:-$HOME/.dsh}/sessions",
    host: HOST, ssh: SSH, spillDir: join(os.tmpdir(), "dsh-remote-agent")
  };
  const fetched = await internals.startSshProcess({
    sshBin: "ssh", host: HOST, ssh: SSH,
    script: internals.buildFetchSessionScript(resolvedCall.sessionsRootExpr, firstSessionId, 4096, "tail"),
    timeoutMs: 60000, signal: undefined,
    maxOutputBytes: 64 * 1024, maxSpillBytes: 64 * 1024,
    spillDir: resolvedCall.spillDir
  });
  const fetchResult = await fetched.promise;
  const logTail = fetched.getStreams().stdout.text;
  check("fetch_session returns the real session log", fetchResult.ok === true && logTail.includes("黄瓜999"), JSON.stringify(logTail).slice(0, 300));
}

// 3. TRUE resume: fetch the real log tail, inject it as context (exactly what
// the plugin's resume_session does), and run a follow-up whose prompt does NOT
// contain the code word — the answer must recover it from the injected tail.
{
  const resolvedCall = {
    sessionsRootExpr: "${DSH_HOME:-$HOME/.dsh}/sessions",
    host: HOST, ssh: SSH, spillDir: join(os.tmpdir(), "dsh-remote-agent")
  };
  const fetched = await internals.startSshProcess({
    sshBin: "ssh", host: HOST, ssh: SSH,
    script: internals.buildFetchSessionScript(resolvedCall.sessionsRootExpr, firstSessionId, 8192, "tail"),
    timeoutMs: 60000, signal: undefined,
    maxOutputBytes: 64 * 1024, maxSpillBytes: 64 * 1024,
    spillDir: resolvedCall.spillDir
  });
  const fetchResult = await fetched.promise;
  const tail = fetched.getStreams().stdout.text;
  check("resume pre-fetch ok", fetchResult.ok === true && tail.length > 0, JSON.stringify(tail).slice(0, 200));

  const resumePrompt = `你是上一个远程会话的延续。上一会话的日志尾部如下（JSONL）：\n\n<<<SESSION-LOG-TAIL>>>\n${tail}\n<<<END-SESSION-LOG-TAIL>>>\n\n请从上面的日志里找出上一会话要求记住的暗号，并用一句话回答：暗号是（？）。`;
  const { handle } = runDsh({ prompt: resumePrompt, discover: true });
  const result = await handle.promise;
  check("resumed session completed", result.ok === true, JSON.stringify({ exitCode: result.exitCode, timedOut: result.timedOut }));
  const text = handle.getStreams().stdout.text;
  check("resumed session recovered the code word from injected context", text.includes("黄瓜999"), JSON.stringify(text).slice(0, 400));
}

console.log(failures === 0 ? "\nALL PASS — 远程会话链路实证完成" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
