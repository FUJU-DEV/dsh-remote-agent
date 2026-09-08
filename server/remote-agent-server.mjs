#!/usr/bin/env node
// dsh-remote-agent-server — zero-dependency reference HTTP endpoint for the
// dsh-remote-agent plugin's http transport.
//
// Contract (all JSON):
//   POST /run     { prompt, cwd?, agent_command?, profile?, resume_session?,
//                   patch?, permission_mode?, env?, timeout_ms?, fetch_session? }
//         →        { run_id, stdout, stderr, exit_code, timed_out, signal,
//                    session_id, session_log? }
//   POST /cancel  { run_id }   (also accepted as POST /run { cancel: true, run_id })
//   GET  /health  → { ok: true }
//
// Auth: DSH_REMOTE_TOKEN env or --token <t> enables
//       `Authorization: Bearer <t>` on every request.
//
// Usage:
//   node server/remote-agent-server.mjs [--port 8765] [--token <t>]
//       [--max-output 2097152] [--sessions-root <dir>] [--dsh-command dsh]
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
}
const PORT = Number(flag("--port", process.env.DSH_REMOTE_PORT ?? "8765"));
const TOKEN = flag("--token", process.env.DSH_REMOTE_TOKEN ?? "") || null;
const MAX_OUTPUT = Number(flag("--max-output", process.env.DSH_REMOTE_MAX_OUTPUT ?? String(2 * 1024 * 1024)));
const DSH_COMMAND = flag("--dsh-command", "dsh");
const SESSIONS_ROOT = flag("--sessions-root", "") || join(process.env.DSH_HOME ?? join(os.homedir(), ".dsh"), "sessions");

if (!Number.isFinite(PORT) || PORT <= 0 || PORT > 65535) {
  console.error("invalid --port");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const shq = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";

/** cmd.exe-safe escaping: double inner quotes and percents. */
const cmdesc = (value) => String(value).replace(/"/g, '""').replace(/%/g, "%%");
const cmdq = (value) => `"${cmdesc(value)}"`;

function buildCommand(body) {
  const { prompt, cwd, agent_command, profile, patch, permission_mode, env } = body;
  const dshLike = profile !== undefined || permission_mode !== undefined || patch !== undefined || agent_command === undefined;
  if (IS_WIN) {    const parts = [];
    if (cwd) parts.push(`cd /d ${cmdq(cwd)} && `);
    const envParts = [];
    if (permission_mode) envParts.push(`set "DSH_PERMISSION_MODE=${cmdesc(permission_mode)}"`);
    if (env && typeof env === "object") {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          envParts.push(`set "${key}=${cmdesc(String(value))}"`);
        }
      }
    }
    if (envParts.length > 0) parts.push(envParts.join("&& ") + "&& ");
    if (dshLike) {
      parts.push(DSH_COMMAND);
      parts.push(` --profile ${cmdq(profile ?? "headless")}`);
      if (patch) parts.push(` --patch ${cmdq(patch)}`);
    } else {
      parts.push(agent_command ?? "dsh --profile headless");
    }
    parts.push(` ${cmdq(prompt)}`);
    return parts.join("");
  }
  const parts = [];
  if (cwd) parts.push(`cd ${shq(cwd)} && `);
  const envParts = [];
  if (permission_mode) envParts.push(`DSH_PERMISSION_MODE=${shq(permission_mode)}`);
  if (env && typeof env === "object") {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        envParts.push(`${key}=${shq(String(value))}`);
      }
    }
  }
  if (envParts.length > 0) parts.push(envParts.join(" ") + " ");
  if (dshLike) {
    parts.push(DSH_COMMAND);
    parts.push(` --profile ${shq(profile ?? "headless")}`);
    if (patch) parts.push(` --patch ${shq(patch)}`);
  } else {
    parts.push(agent_command ?? "dsh --profile headless");
  }
  parts.push(` ${shq(prompt)}`);
  return parts.join("");
}

function cap(text) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= MAX_OUTPUT) return { text, truncated: false };
  return { text: buffer.subarray(0, MAX_OUTPUT).toString("utf8"), truncated: true };
}

const projectKey = (cwd) => {
  let readable = "";
  let run = false;
  for (const ch of cwd) {
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!run) readable += "-";
      run = true;
    } else if (/^[A-Za-z0-9._~-]$/.test(ch)) {
      readable += ch;
      run = false;
    } else {
      readable += "~" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
      run = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
};

/** Newest session directory under the sessions root created after `stamp`. */
async function discoverSession(cwd, stamp) {
  try {
    const project = join(SESSIONS_ROOT, projectKey(cwd ?? ""));
    const entries = await readdir(project, { withFileTypes: true });
    let best = null;
    let bestTime = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(project, entry.name);
      const info = await stat(dir).catch(() => null);
      if (info === null) continue;
      if (info.mtimeMs >= stamp && info.mtimeMs > bestTime) {
        best = entry.name;
        bestTime = info.mtimeMs;
      }
    }
    return best;
  } catch {
    return null;
  }
}

async function readSessionLog(sessionId, cwd, fetchMode) {
  if (!sessionId) return null;
  const mode = fetchMode === "tail" ? "tail" : "full";
  const maxBytes = mode === "full" ? MAX_OUTPUT : 512 * 1024;
  try {
    const project = join(SESSIONS_ROOT, projectKey(cwd ?? ""));
    for (const name of [`${sessionId}`, `session-${sessionId.replace(/^session-/, "")}`]) {
      const dir = join(project, name);
      for (const file of ["session.jsonl.zstd", "session.jsonl"]) {
        const path = join(dir, file);
        if (!existsSync(path)) continue;
        let raw;
        if (file.endsWith(".zstd")) {
          try {
            raw = execFileSync("zstd", ["-dc", path], { maxBuffer: MAX_OUTPUT });
          } catch {
            // no zstd binary (common on Windows): report unreadable, not garbage bytes
            return null;
          }
        } else {
          raw = readFileSync(path);
        }
        const slice = mode === "tail" ? raw.subarray(Math.max(0, raw.length - maxBytes)) : raw.subarray(0, maxBytes);
        return slice.toString("utf8");
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Run registry
// ---------------------------------------------------------------------------

const runs = new Map();
const IS_WIN = process.platform === "win32";

/** Kill a run's process tree on both platforms (best effort, idempotent). */
function killTree(proc) {
  if (!proc) return;
  if (IS_WIN) {
    try {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      // already gone
    }
    return;
  }
  try {
    process.kill(-proc.pid, "SIGTERM");
    setTimeout(() => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }, 1000).unref?.();
  } catch {
    // already gone
  }
}

function startRun(body) {
  const runId = randomUUID();
  const timeoutMs = Number.isFinite(Number(body.timeout_ms)) ? Number(body.timeout_ms) : 10 * 60_000;
  const stamp = Date.now();
  const command = buildCommand(body);

  const record = {
    id: runId,
    cancelled: false,
    settled: false,
    proc: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    command
  };

  const settle = (exitCode, signal, sessionId, sessionLog) => {
    record.settled = true;
    const response = {
      run_id: runId,
      stdout: record.stdout,
      stderr: record.stderr,
      exit_code: exitCode,
      timed_out: record.timedOut,
      ...(signal ? { signal } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(sessionLog ? { session_log: sessionLog } : {}),
      ...(record.stdoutTruncated || record.stderrTruncated ? { truncated: true } : {})
    };
    runs.delete(runId);
    record.resolve(response);
  };

  const cancel = () => {
    if (record.cancelled) return;
    record.cancelled = true;
    killTree(record.proc);
  };
  record.cancel = cancel;

  record.promise = new Promise((resolve) => {
    record.resolve = resolve;
    let timer;
    let batPath = null;
    const append = (chunk, isErr) => {
      const { text, truncated } = cap(chunk.toString("utf8"));
      if (isErr) {
        if (!record.stderrTruncated) {
          record.stderrTruncated = truncated;
          record.stderr += text;
        }
      } else if (!record.stdoutTruncated) {
        record.stdoutTruncated = truncated;
        record.stdout += text;
      }
    };
    let proc;
    try {
      if (IS_WIN) {
        // Write the command to a temp .cmd: cmd.exe command-line quoting is
        // hopeless for arbitrary prompts; a batch file is bulletproof.
        batPath = join(os.tmpdir(), `dsh-remote-agent-${runId}.cmd`);
        writeFileSync(batPath, `@echo off\r\n${command}\r\nexit /b %errorlevel%\r\n`);
        proc = spawn("cmd.exe", ["/d", "/c", batPath], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        });
      } else {
        proc = spawn("bash", ["-c", command], {
          stdio: ["ignore", "pipe", "pipe"],
          detached: true // own process group → kill(-pid) reaches children
        });
      }
      record.proc = proc;
    } catch (error) {
      if (batPath !== null) try { unlinkSync(batPath); } catch { /* keep tmp */ }
      settle(127, null, null, null);
      return;
    }
    timer = setTimeout(() => {
      record.timedOut = true;
      killTree(proc);
    }, timeoutMs);
    proc.stdout.on("data", (chunk) => append(chunk, false));
    proc.stderr.on("data", (chunk) => append(chunk, true));
    proc.on("error", () => settle(127, null, null, null));
    proc.on("close", async (code, sig) => {
      clearTimeout(timer);
      if (batPath !== null) try { unlinkSync(batPath); } catch { /* keep tmp */ }
      const sessionId = await discoverSession(body.cwd, stamp);
      const sessionLog = body.fetch_session && body.fetch_session !== "none" ? await readSessionLog(sessionId, body.cwd, body.fetch_session) : null;
      settle(code ?? (sig ? 1 : 127), sig ?? null, sessionId, sessionLog);
    });
  });

  record.promise.catch(() => {});
  runs.set(runId, record);
  return record;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  const send = (status, payload) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const auth = req.headers.authorization;
  if (TOKEN !== null && auth !== `Bearer ${TOKEN}`) {
    send(401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    send(200, { ok: true });
    return;
  }
  if (req.method !== "POST") {
    send(405, { error: "method not allowed" });
    return;
  }
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size <= 64 * 1024 * 1024) chunks.push(chunk);
  });
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      send(400, { error: "invalid json body" });
      return;
    }
    if (body.cancel === true || url.pathname === "/cancel") {
      const record = runs.get(String(body.run_id ?? ""));
      if (record === undefined) {
        send(404, { error: "unknown run_id" });
        return;
      }
      record.cancelledByClient = true;
      record.cancel();
      send(200, { cancelled: true });
      return;
    }
    if (typeof body.prompt !== "string" || body.prompt.length === 0) {
      send(400, { error: "prompt is required" });
      return;
    }
    const record = startRun(body);
    // The client aborts its fetch to cancel (it cannot know run_id before the
    // synchronous response): when the response closes without being sent, the
    // client disconnected — kill the run.
    res.on("close", () => {
      if (!res.writableEnded && !record.settled) record.cancel();
    });
    record.promise.then((response) => send(200, response)).catch(() => send(500, { error: "internal error" }));
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`dsh-remote-agent-server listening on 0.0.0.0:${PORT}`);
  console.log(`  sessions root: ${SESSIONS_ROOT}`);
  console.log(`  auth: ${TOKEN !== null ? "bearer token enabled" : "DISABLED — anyone with network access can execute commands"}`);
});

process.on("SIGINT", () => {
  for (const record of runs.values()) record.cancel();
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  for (const record of runs.values()) record.cancel();
  server.close(() => process.exit(0));
});
