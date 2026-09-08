// dsh-remote-agent — remote agent bridge for DeepSeek Harness.
//
// Two model-facing tools (remote_agent, remote_dsh) that run work on a remote
// server through an SSH or HTTP transport. Key features:
//
// - Background jobs: run_in_background registers the remote run with ctx.jobs
//   (job_output reads incremental output, job_kill cancels).
// - Cancellation propagation: the remote command runs under a POSIX wrapper
//   (setsid + watchdog + job marker) so killing the local ssh client or a
//   second "kill" ssh invocation terminates the remote process group.
// - Named endpoint presets (config.endpoints) with full SSH options
//   (port, identity file, proxy jump, connect timeout, host-key policy).
// - DSH-to-DSH session continuity: remote session id discovery
//   (sessions dir scan), resume via session-log context injection
//   (this DSH version's headless profile cannot resume server-side), and
//   fetch_session to pull the remote log back for local import_dsh.
// - Output spill: content beyond maxOutputBytes is written to local files and
//   reported through spillPath instead of being silently lost.
// - Permission boundary: permission_mode is capped by the endpoint's
//   maxPermissionMode; HTTP transport supports bearer-token auth.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { TOOL_ABORTED, defineTool } from "@deepseek-ai/dsh-tools";

const name = "dsh-remote-agent";
// settings (dsh-base) powers the web Settings → Plugins endpoint card; it is
// a hard inject so the namespace registers before the first describe, and
// every shipped profile (web, headless) provides it through dsh-base.
const inject = ["tools", "systemPrompt", "settings"];

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const PERMISSION_MODES = ["read-only", "workspace-write", "danger-full-access"];
const PERMISSION_RANK = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };

const SSH_SCHEMA = z.object({
  port: z.number().min(1).max(65535).description("Remote SSH port (ssh -p)."),
  identityFile: z.string().description("Private key file (ssh -i)."),
  proxyJump: z.string().description("Jump host for indirect connections (ssh -J)."),
  connectTimeout: z.number().min(1).max(3600).default(10).description("SSH ConnectTimeout in seconds."),
  strictHostKeyChecking: z.union(["yes", "no", "accept-new"]).default("accept-new"),
  batchMode: z.boolean().default(true).description("Fail instead of prompting for a password (ssh BatchMode).")
});

const PERMISSION_SCHEMA = z.union(PERMISSION_MODES);

const ENDPOINT_SCHEMA = z.object({
  transport: z.union(["ssh", "http"]).description("Transport override for this endpoint."),
  host: z.string().description("SSH target for this endpoint."),
  cwd: z.string().description("Remote working directory."),
  profile: z.string().description("Remote DSH profile (remote_dsh)."),
  agentCommand: z.string().description("Remote agent CLI prefix (remote_agent)."),
  dshCommand: z.string().description("Remote dsh binary (remote_dsh)."),
  httpUrl: z.string().description("HTTP endpoint URL."),
  httpToken: z.string().role("secret").description("Bearer token for HTTP transport."),
  ssh: SSH_SCHEMA,
  remoteShell: z.union(["auto", "posix", "cmd", "powershell"]).description("Remote shell dialect for this endpoint (Windows remotes: cmd or powershell)."),
  maxPermissionMode: PERMISSION_SCHEMA.description("Hard cap on remote permission_mode for this endpoint."),
  timeoutSeconds: z.number().min(1),
  maxOutputBytes: z.number().min(1024),
  sessionsRoot: z.string().description("Remote DSH sessions directory (absolute path on the remote host).")
});

const Config = z.object({
  transport: z.union(["ssh", "http"]).default("ssh"),
  defaultHost: z.string().default(""),
  agentCommand: z.string().default("dsh --profile headless"),
  dshCommand: z.string().default("dsh"),
  defaultProfile: z.string().default("headless"),
  defaultCwd: z.string().default(""),
  sshCommand: z.string().default("ssh"),
  ssh: SSH_SCHEMA,
  remoteShell: z.union(["auto", "posix", "cmd", "powershell"]).default("auto").description("Remote shell dialect for ssh transport: posix (Linux/macOS/WSL), cmd or powershell (Windows remotes). auto = posix."),
  httpUrl: z.string().default(""),
  httpToken: z.string().default(""),
  timeoutSeconds: z.number().min(1).default(600),
  maxOutputBytes: z.number().min(1024).default(2 * 1024 * 1024),
  maxSpillBytes: z.number().min(1024).default(64 * 1024 * 1024),
  spillDir: z.string().default("").description("Local directory for spilled output (default: <tmp>/dsh-remote-agent)."),
  endpoints: z.dict(ENDPOINT_SCHEMA).default({}),
  enableRunInBackground: z.boolean().default(true),
  sshWrapper: z.boolean().default(true).description("Wrap remote commands for process-group cancellation (requires a POSIX remote shell)."),
  discoverSessions: z.boolean().default(true),
  rememberSessions: z.boolean().default(true),
  sessionsRoot: z.string().default("").description("Remote DSH sessions directory; default ${DSH_HOME:-$HOME/.dsh}/sessions."),
  fetchTailBytes: z.number().min(1024).default(512 * 1024),
  resumeContextBytes: z.number().min(1024).default(256 * 1024),
  defaultPermissionMode: PERMISSION_SCHEMA.default("workspace-write"),
  maxPermissionMode: PERMISSION_SCHEMA.default("danger-full-access")
});

/**
 * Settings-surface namespace (`ctx.settings`, rendered by the web UI's
 * Settings → Plugins page as a schema-driven form card): the user-editable
 * subset of the plugin config. The composition config is the `base` layer and
 * UI edits persist to `$DSH_HOME/settings.yaml` and hot-apply here.
 */
const SETTINGS_SCHEMA = z.object({
  transport: z.union(["ssh", "http"]).default("ssh").description("默认传输方式：ssh 或 http"),
  defaultHost: z.string().default("").description("默认 SSH 目标，例如 user@server"),
  remoteShell: z.union(["auto", "posix", "cmd", "powershell"]).default("auto").description("远程 shell 方言：Linux/macOS 用 posix，Windows 远程用 cmd 或 powershell"),
  httpUrl: z.string().default("").description("HTTP 模式的服务端地址，例如 http://server:8765/run"),
  httpToken: z.string().default("").role("secret").description("HTTP Bearer token（与远端 --token 一致）"),
  timeoutSeconds: z.number().min(1).default(600).description("前台超时（秒）"),
  maxOutputBytes: z.number().min(1024).default(2 * 1024 * 1024).description("stdout/stderr 内存上限（字节），超出部分落盘 spill 文件"),
  defaultPermissionMode: PERMISSION_SCHEMA.default("workspace-write").description("remote_dsh 的默认权限模式"),
  maxPermissionMode: PERMISSION_SCHEMA.default("danger-full-access").description("权限模式全局上限；端点可单独收紧"),
  endpoints: z.dict(ENDPOINT_SCHEMA).default({}).description("命名端点预设：聊天里用 endpoint: \"名称\" 一键调用")
});

/** Project the composition config onto the settings-namespace `base` layer. */
function settingsBaseOf(config) {
  return {
    transport: config.transport ?? "ssh",
    defaultHost: config.defaultHost ?? "",
    remoteShell: config.remoteShell ?? "auto",
    httpUrl: config.httpUrl ?? "",
    httpToken: config.httpToken ?? "",
    timeoutSeconds: config.timeoutSeconds ?? 600,
    maxOutputBytes: config.maxOutputBytes ?? 2 * 1024 * 1024,
    defaultPermissionMode: config.defaultPermissionMode ?? "workspace-write",
    maxPermissionMode: config.maxPermissionMode ?? "danger-full-access",
    endpoints: config.endpoints ?? {}
  };
}

// ---------------------------------------------------------------------------
// Output schema (background | foreground, mirroring dsh-tool-bash)
// ---------------------------------------------------------------------------

const STREAM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string", required: true },
    truncated: { type: "boolean", required: true },
    spillPath: { type: "string" }
  }
};

const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: "string", required: true, const: "background" },
  jobId: { type: "string", required: true }
};

const FOREGROUND_OUTPUT_PROPERTIES = {
  kind: { type: "string", required: true, const: "foreground" },
  ok: { type: "boolean", required: true },
  transport: { type: "string", required: true, enum: ["ssh", "http"] },
  endpoint: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
  command: { type: "string", required: true },
  exitCode: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
  signal: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
  timedOut: { type: "boolean", required: true },
  aborted: { type: "boolean", required: true },
  timeoutMs: { type: "number", required: true },
  exitReason: { type: "string", required: true },
  sessionId: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
  fetchedSession: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
  stdout: { type: "object", additionalProperties: false, required: true, properties: STREAM_SCHEMA.properties },
  stderr: { type: "object", additionalProperties: false, required: true, properties: STREAM_SCHEMA.properties }
};

const OUTPUT_SCHEMA = {
  oneOf: [{
    type: "object",
    additionalProperties: false,
    properties: BACKGROUND_OUTPUT_PROPERTIES
  }, {
    type: "object",
    additionalProperties: false,
    properties: FOREGROUND_OUTPUT_PROPERTIES
  }]
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function shSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/** PowerShell single-quoted literal (escape a quote by doubling it). */
function psSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/** cmd.exe double-quoted literal: double inner quotes, double percents. */
function cmdQuote(value) {
  return '"' + String(value).replace(/"/g, '""').replace(/%/g, "%%") + '"';
}

function abortToolError() {
  const error = new HarnessError("tool call aborted", TOOL_ABORTED);
  error.name = "AbortError";
  return error;
}

function validateSessionId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id === "." || id === "..") return null;
  return id;
}

function exitReasonOf(result) {
  if (result.cancelled || result.aborted) return "aborted";
  if (result.timedOut) return "timeout";
  if (result.spawnError !== undefined || result.networkError !== undefined) return "transport-error";
  if (result.signal !== null && result.signal !== undefined) return "signal";
  return result.exitCode === 0 ? "completed" : "nonzero-exit";
}

/** Render merged stdout/stderr with spill notices (model-facing body). */
function renderStreams(stdout, stderr) {
  let text = stdout.text;
  const err = stderr.text;
  if (err.length > 0) text += (text.length > 0 && !text.endsWith("\n") ? "\n" : "") + "[stderr]\n" + err;
  const notices = [];
  if (stdout.truncated || stderr.truncated) {
    const paths = [stdout.spillPath, stderr.spillPath].filter((p) => p !== undefined);
    notices.push(`[output truncated; full output: ${paths.length > 0 ? paths.join(", ") : "(unavailable)"}]`);
  }
  if (notices.length > 0) text += (text.length > 0 && !text.endsWith("\n") ? "\n" : "") + notices.join("\n");
  return text;
}

function stripTrailingMarkers(text) {
  const lines = text.split("\n");
  const marker = /^\[(exit code|killed by signal|timed out|aborted|output truncated).*$/;
  while (lines.length > 0 && marker.test(lines[lines.length - 1] ?? "")) lines.pop();
  return lines.join("\n");
}

function renderOutput(_args, value) {
  if (value.kind === "background") {
    return [{ type: "text", text: `started background job ${value.jobId}` }];
  }
  const parts = [];
  parts.push(`[remote via ${value.transport}${value.endpoint !== null ? ` · endpoint ${value.endpoint}` : ""}]`);
  const command = value.command.length > 2000 ? value.command.slice(0, 2000) + "…[command truncated]" : value.command;
  parts.push(`command: ${command}`);
  if (value.sessionId !== null) parts.push(`session id: ${value.sessionId}`);
  if (value.timedOut) parts.push(`[timed out after ${Math.round(value.timeoutMs / 1000)}s]`);
  if (value.signal !== null) parts.push(`[killed by signal: ${value.signal}]`);
  if (value.exitCode !== null) parts.push(`[exit code: ${value.exitCode}]`);
  const body = renderStreams(value.stdout, value.stderr);
  if (body.length > 0) parts.push(body);
  if (value.fetchedSession !== null) parts.push("[fetched session log]\n" + value.fetchedSession.replace(/\n+$/, ""));
  return [{ type: "text", text: parts.join("\n") }];
}

// ---------------------------------------------------------------------------
// Remote command builders
// ---------------------------------------------------------------------------

function buildRemoteAgentCommand(agentCommand, prompt, cwd, shell = "posix") {
  if (shell === "cmd") {
    let command = "";
    if (cwd) command += `cd /d ${cmdQuote(cwd)} && `;
    command += `${agentCommand} ${cmdQuote(prompt)}`;
    return command;
  }
  if (shell === "powershell") {
    let command = "";
    if (cwd) command += `Set-Location -LiteralPath ${psSingleQuote(cwd)}; `;
    command += `${agentCommand} ${psSingleQuote(prompt)}`;
    return command;
  }
  let command = "";
  if (cwd) command += `cd ${shSingleQuote(cwd)} && `;
  command += `${agentCommand} ${shSingleQuote(prompt)}`;
  return command;
}

function buildDshRemoteCommand({ dshCommand, profile, patch, permissionMode, env, prompt, cwd, shell = "posix" }) {
  if (shell === "cmd") {
    const parts = [];
    if (cwd) parts.push(`cd /d ${cmdQuote(cwd)} && `);
    const envParts = [`set "DSH_PERMISSION_MODE=${permissionMode}"`];
    if (env && typeof env === "object") {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          envParts.push(`set "${key}=${String(value).replace(/"/g, '""').replace(/%/g, "%%")}"`);
        }
      }
    }
    parts.push(envParts.join("&& ") + "&& ");
    parts.push(dshCommand);
    parts.push(` --profile ${cmdQuote(profile)}`);
    if (patch) parts.push(` --patch ${cmdQuote(patch)}`);
    parts.push(` ${cmdQuote(prompt)}`);
    return parts.join("");
  }
  if (shell === "powershell") {
    const parts = [];
    if (cwd) parts.push(`Set-Location -LiteralPath ${psSingleQuote(cwd)}; `);
    const envParts = [`$env:DSH_PERMISSION_MODE=${psSingleQuote(permissionMode)}`];
    if (env && typeof env === "object") {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          envParts.push(`$env:${key}=${psSingleQuote(String(value))}`);
        }
      }
    }
    parts.push(envParts.join("; ") + "; ");
    parts.push(dshCommand);
    parts.push(` --profile ${psSingleQuote(profile)}`);
    if (patch) parts.push(` --patch ${psSingleQuote(patch)}`);
    parts.push(` ${psSingleQuote(prompt)}`);
    return parts.join("");
  }
  const parts = [];
  if (cwd) parts.push(`cd ${shSingleQuote(cwd)} && `);
  const envParts = [`DSH_PERMISSION_MODE=${shSingleQuote(permissionMode)}`];
  if (env && typeof env === "object") {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        envParts.push(`${key}=${shSingleQuote(String(value))}`);
      }
    }
  }
  parts.push(envParts.join(" ") + " ");
  parts.push(dshCommand);
  parts.push(` --profile ${shSingleQuote(profile)}`);
  if (patch) parts.push(` --patch ${shSingleQuote(patch)}`);
  parts.push(` ${shSingleQuote(prompt)}`);
  return parts.join("");
}

/**
 * POSIX wrapper that runs the inner command in its own session (setsid when
 * available), prints a `__DSH_REMOTE__JOB=<pid> <mode>` marker line, and
 * installs a stdin watchdog: when the ssh channel dies (local client killed),
 * the watchdog terminates the remote process group. The wrapper body ends with
 * `wait "$__dsr_pid"` so the caller can capture $? immediately after.
 *
 * Two POSIX gotchas handled here:
 *  - async lists get their stdin redirected from /dev/null, so the watchdog
 *    reads the ORIGINAL stdin through a preserved fd (`exec 9<&0` … `<&9`);
 *  - the watchdog is forked AFTER the job is registered so it inherits
 *    __dsr_pid (variables never sync into an already-running subshell); pipe
 *    EOF is sticky, so an EOF that already happened is still seen on its
 *    first read. __dsr_kill also skips the TERM/KILL ladder when the group is
 *    already gone, so the EXIT trap on normal completion pays no sleep cost.
 */
const WRAPPER_LINES = [
  "exec 9<&0",
  "__dsr_pid=",
  "__dsr_mode=pid",
  "__dsr_kill() {",
  "  __dsr_tries=0",
  "  while [ -z \"$__dsr_pid\" ] && [ \"$__dsr_tries\" -lt 50 ]; do",
  "    __dsr_tries=$((__dsr_tries + 1))",
  "    sleep 0.2",
  "  done",
  "  if [ -n \"$__dsr_pid\" ]; then",
  "    if [ \"$__dsr_mode\" = group ]; then",
  "      if kill -0 -\"$__dsr_pid\" 2>/dev/null; then",
  "        kill -TERM -\"$__dsr_pid\" 2>/dev/null",
  "        sleep 1",
  "        kill -KILL -\"$__dsr_pid\" 2>/dev/null",
  "      fi",
  "    else",
  "      if kill -0 \"$__dsr_pid\" 2>/dev/null; then",
  "        kill -TERM \"$__dsr_pid\" 2>/dev/null",
  "        sleep 1",
  "        kill -KILL \"$__dsr_pid\" 2>/dev/null",
  "      fi",
  "    fi",
  "  fi",
  "}",
  "__dsr_watchdog() {",
  "  while IFS= read -r __dsr_line || [ -n \"$__dsr_line\" ]; do :; done <&9",
  "  __dsr_kill",
  "}",
  "if command -v setsid >/dev/null 2>&1; then",
  "  __dsr_mode=group",
  "  setsid sh -c \"$__dsr_cmd\" </dev/null &",
  "  __dsr_pid=$!",
  "else",
  "  sh -c \"$__dsr_cmd\" </dev/null &",
  "  __dsr_pid=$!",
  "fi",
  "printf '__DSH_REMOTE__JOB=%s %s\\n' \"$__dsr_pid\" \"$__dsr_mode\"",
  "trap '__dsr_kill' HUP INT TERM",
  "trap '__dsr_kill' EXIT",
  "__dsr_watchdog &",
  "__dsr_wd_pid=$!",
  "wait \"$__dsr_pid\""
];

/**
 * Full remote script for one SSH run: optional session-list snapshot → wrapper
 * → capture exit code → optional session discovery (before/after directory
 * diff — immune to coarse filesystem mtime granularity and to concurrent
 * sessions that predate the run) → exit. All plugin metadata is emitted on
 * `__DSH_REMOTE__*` marker lines that the client strips from the output.
 */
function buildSshScript({ innerCommand, discover, sessionsRootExpr, sshWrapper }) {
  if (!sshWrapper) return innerCommand;
  const lines = [];
  if (discover) {
    lines.push(`__dsr_sroot=${sessionsRootExpr}`);
    lines.push('__dsr_before="${TMPDIR:-/tmp}/.dsh-remote-before.$$"');
    lines.push('__dsr_after="${TMPDIR:-/tmp}/.dsh-remote-after.$$"');
    lines.push('find "$__dsr_sroot" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | sort > "$__dsr_before"');
  }
  lines.push(`__dsr_cmd=${shSingleQuote(innerCommand)}`);
  lines.push(...WRAPPER_LINES);
  lines.push("__dsr_code=$?");
  lines.push('kill "$__dsr_wd_pid" 2>/dev/null');
  lines.push('wait "$__dsr_wd_pid" 2>/dev/null');
  if (discover) {
    lines.push('find "$__dsr_sroot" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | sort > "$__dsr_after"');
    lines.push('__dsr_sid=$(comm -13 "$__dsr_before" "$__dsr_after" 2>/dev/null | head -n 1 | sed \'s#.*/##; s#/$##\')');
    lines.push('if [ -n "$__dsr_sid" ]; then printf \'__DSH_REMOTE__SESSION_ID=%s\\n\' "$__dsr_sid"; fi');
    lines.push('rm -f "$__dsr_before" "$__dsr_after" 2>/dev/null');
  }
  lines.push('exit "$__dsr_code"');
  return lines.join("\n");
}

/** Second-ssh kill script used by cancel: terminate the remote process group. */
function buildKillScript(pid, mode) {
  const lines = [
    `__dsr_pid=${shSingleQuote(String(pid))}`,
    `__dsr_mode=${shSingleQuote(mode === "group" ? "group" : "pid")}`,
    "if [ -n \"$__dsr_pid\" ]; then",
    "  if [ \"$__dsr_mode\" = group ]; then",
    "    kill -TERM -\"$__dsr_pid\" 2>/dev/null",
    "    sleep 1",
    "    kill -KILL -\"$__dsr_pid\" 2>/dev/null",
    "  else",
    "    kill -TERM \"$__dsr_pid\" 2>/dev/null",
    "    sleep 1",
    "    kill -KILL \"$__dsr_pid\" 2>/dev/null",
    "  fi",
    "fi",
    "exit 0"
  ];
  return lines.join("\n");
}

/** Fetch (a slice of) a remote DSH session log by session id. */
function buildFetchSessionScript(sessionsRootExpr, id, bytes, mode) {
  const pipe = mode === "full" ? `head -c ${bytes}` : `tail -c ${bytes}`;
  return [
    `__dsr_sroot=${sessionsRootExpr}`,
    `__dsr_dir=$(find "$__dsr_sroot" -mindepth 2 -maxdepth 2 -type d -name ${shSingleQuote(id)} 2>/dev/null | head -n 1)`,
    `if [ -z "$__dsr_dir" ]; then echo "session ${id} not found under $__dsr_sroot" >&2; exit 1; fi`,
    `__dsr_file="$__dsr_dir/session.jsonl.zstd"`,
    `if [ -f "$__dsr_file" ]; then`,
    `  if command -v zstd >/dev/null 2>&1; then zstd -dc "$__dsr_file" 2>/dev/null | ${pipe};`,
    `  else echo "remote zstd binary is missing; cannot decompress $__dsr_file (install zstd on the remote)" >&2; exit 1; fi;`,
    `elif [ -f "$__dsr_dir/session.jsonl" ]; then ${pipe} "$__dsr_dir/session.jsonl";`,
    `else echo "no session log in $__dsr_dir" >&2; exit 1; fi`
  ].join("\n");
}

/** ssh argument vector for one call. */
function buildSshArgs(host, ssh) {
  const args = [];
  if (ssh.port !== undefined) args.push("-p", String(ssh.port));
  if (ssh.identityFile) args.push("-i", ssh.identityFile);
  if (ssh.proxyJump) args.push("-J", ssh.proxyJump);
  args.push("-o", `ConnectTimeout=${ssh.connectTimeout ?? 10}`);
  args.push("-o", `StrictHostKeyChecking=${ssh.strictHostKeyChecking ?? "accept-new"}`);
  if (ssh.batchMode !== false) args.push("-o", "BatchMode=yes");
  args.push(host);
  return args;
}

// ---------------------------------------------------------------------------
// Output capture: marker stripping, byte caps, spill
// ---------------------------------------------------------------------------

/** Strip `__DSH_REMOTE__KEY=value` marker lines; collect their values. */
class MarkerParser {
  constructor() {
    this.buffer = "";
    this.markers = {};
  }
  feed(text) {
    this.buffer += text;
    let out = "";
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const match = /^__DSH_REMOTE__([A-Z_]+)=(.*)$/.exec(line);
      if (match) this.markers[match[1]] = match[2];
      else out += line + "\n";
    }
    return out;
  }
  flush() {
    const out = this.buffer;
    this.buffer = "";
    return out;
  }
}

/**
 * In-memory capped stream with local spill: text beyond maxBytes goes to a
 * spill file (bounded by maxSpillBytes) and is reported via snapshot().
 */
class StreamAccumulator {
  constructor(maxBytes, spillDir, spillLabel, maxSpillBytes) {
    this.maxBytes = maxBytes;
    this.maxSpillBytes = maxSpillBytes;
    this.spillDir = spillDir;
    this.spillLabel = spillLabel;
    this.text = "";
    this.bytes = 0;
    this.truncated = false;
    this.spillTruncated = false;
    this.lossy = false;
    this.unread = "";
    this.spillPath = undefined;
    this.spillFd = undefined;
    this.spillBytes = 0;
  }
  _ensureSpill() {
    if (this.spillFd !== undefined) return;
    mkdirSync(this.spillDir, { recursive: true });
    this.spillPath = join(this.spillDir, `remote-${Date.now()}-${randomBytes(4).toString("hex")}-${this.spillLabel}.log`);
    this.spillFd = openSync(this.spillPath, "a");
  }
  _spill(text) {
    if (this.spillTruncated) return;
    const buffer = Buffer.from(text, "utf8");
    if (this.spillBytes + buffer.byteLength > this.maxSpillBytes) {
      const allowed = Math.max(0, this.maxSpillBytes - this.spillBytes);
      if (allowed > 0) writeSync(this.spillFd, buffer, 0, allowed);
      this.spillTruncated = true;
      this.spillBytes = this.maxSpillBytes;
    } else {
      writeSync(this.spillFd, buffer);
      this.spillBytes += buffer.byteLength;
    }
  }
  push(text) {
    this.unread += text;
    const size = Buffer.byteLength(text, "utf8");
    if (this.truncated) {
      this._spill(text);
      return;
    }
    if (this.bytes + size <= this.maxBytes) {
      this.text += text;
      this.bytes += size;
      return;
    }
    const keepBytes = Math.max(0, this.maxBytes - this.bytes);
    this.text += keepBytes > 0 ? text.slice(0, keepBytes) : "";
    this.bytes = this.maxBytes;
    this.truncated = true;
    this.lossy = true;
    this._ensureSpill();
    this._spill(text.slice(keepBytes));
  }
  readDelta() {
    const delta = this.unread;
    this.unread = "";
    return delta;
  }
  snapshot() {
    return {
      text: this.text,
      truncated: this.truncated,
      ...(this.spillPath !== undefined ? { spillPath: this.spillPath } : {})
    };
  }
  finish() {
    if (this.spillFd !== undefined) {
      try {
        closeSync(this.spillFd);
      } catch {
        // closing a best-effort spill file must never break the result
      }
      this.spillFd = undefined;
    }
    return this.snapshot();
  }
}

// ---------------------------------------------------------------------------
// SSH transport runner
// ---------------------------------------------------------------------------

/**
 * Start one remote run over SSH. Returns a handle with:
 *  - promise        → { ok, spawnError?, exitCode, signal, timedOut, aborted, cancelled }
 *  - cancel(reason) → remote group kill (when the pid marker arrived) + local kill
 *  - readDelta()    → new output since last read (jobs contract)
 *  - getMarkers()   → parsed __DSH_REMOTE__* values
 *  - getStreams()   → { stdout, stderr } snapshots
 */
function startSshProcess({ sshBin, host, ssh, script, timeoutMs, signal, maxOutputBytes, maxSpillBytes, spillDir }) {
  const sshArgs = buildSshArgs(host, ssh);
  const controller = new AbortController();
  const stdoutAcc = new StreamAccumulator(maxOutputBytes, spillDir, "stdout", maxSpillBytes);
  const stderrAcc = new StreamAccumulator(maxOutputBytes, spillDir, "stderr", maxSpillBytes);
  const stdoutParser = new MarkerParser();
  const stderrParser = new MarkerParser();
  let child;
  let timedOut = false;
  let aborted = false;
  let cancelled = false;
  let settled = false;

  const onAbort = () => {
    aborted = true;
    controller.abort(signal?.reason ?? new Error("remote aborted"));
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  let timer;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("remote run timed out"));
    }, timeoutMs);
  }

  const promise = new Promise((resolve) => {
    try {
      // stdin must stay OPEN: the remote watchdog kills the remote group the
      // moment stdin hits EOF, which is exactly how cancellation propagates.
      child = spawn(sshBin, [...sshArgs, script], {
        stdio: ["pipe", "pipe", "pipe"],
        signal: controller.signal,
        windowsHide: true
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settled = true;
      resolve({ ok: false, spawnError: error, exitCode: null, signal: null, timedOut, aborted, cancelled });
      return;
    }
    child.stdout?.on("data", (chunk) => stdoutAcc.push(stdoutParser.feed(chunk.toString("utf8"))));
    child.stderr?.on("data", (chunk) => stderrAcc.push(stderrParser.feed(chunk.toString("utf8"))));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ok: false, spawnError: error, exitCode: null, signal: null, timedOut, aborted, cancelled });
    });
    child.on("close", (code, sig) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      stdoutAcc.push(stdoutParser.flush());
      stderrAcc.push(stderrParser.flush());
      stdoutAcc.finish();
      stderrAcc.finish();
      resolve({
        ok: code === 0 && !timedOut && !aborted && !cancelled,
        spawnError: undefined,
        exitCode: code,
        signal: sig,
        timedOut,
        aborted,
        cancelled
      });
    });
  });

  const fireRemoteKill = () => {
    const job = stdoutParser.markers.JOB ?? stderrParser.markers.JOB;
    if (typeof job !== "string") return;
    const parts = job.trim().split(/\s+/);
    const pid = parts[0];
    if (!pid) return;
    const mode = parts[1] === "group" ? "group" : "pid";
    try {
      const killer = spawn(sshBin, [...sshArgs, buildKillScript(pid, mode)], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.unref?.();
    } catch {
      // remote cleanup is best-effort; the stdin watchdog is the backstop
    }
  };

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    fireRemoteKill();
    try {
      controller.abort(new Error("cancelled"));
    } catch {
      // already aborted
    }
  };

  const readDelta = () => {
    const out = stdoutAcc.readDelta();
    const err = stderrAcc.readDelta();
    let text = out;
    if (err.length > 0) text += (text.length > 0 && !text.endsWith("\n") ? "\n" : "") + "[stderr]\n" + err;
    const notices = [];
    if (stdoutAcc.lossy || stderrAcc.lossy) {
      const paths = [stdoutAcc.spillPath, stderrAcc.spillPath].filter((p) => p !== undefined);
      notices.push(`[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(", ") : "(unavailable)"}]`);
    }
    if (notices.length > 0) text += (text.length > 0 && !text.endsWith("\n") ? "\n" : "") + notices.join("\n");
    return text;
  };

  return {
    promise,
    cancel,
    readDelta,
    getMarkers: () => ({ ...stdoutParser.markers, ...stderrParser.markers }),
    getStreams: () => ({ stdout: stdoutAcc.snapshot(), stderr: stderrAcc.snapshot() })
  };
}

// ---------------------------------------------------------------------------
// HTTP transport runner
// ---------------------------------------------------------------------------

/**
 * One HTTP run against the remote-agent server contract:
 *   POST {prompt, cwd, agent_command, timeout_ms, ...} →
 *   { run_id, stdout, stderr, exit_code, timed_out, signal, session_id, session_log }
 * Cancel: POST {cancel: true, run_id} to the same URL (or a configured
 * httpCancelUrl) plus an abort of the in-flight request.
 */
function startHttpRequest({ url, token, payload, timeoutMs, signal, maxOutputBytes, maxSpillBytes, spillDir }) {
  const controller = new AbortController();
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  let timedOut = false;
  let aborted = false;
  let cancelled = false;
  let runId;

  const onAbort = () => {
    aborted = true;
    controller.abort(signal?.reason ?? new Error("remote aborted"));
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  let timer;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("remote run timed out"));
    }, timeoutMs);
  }

  const post = (body) => fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: controller.signal
  });

  const promise = (async () => {
    try {
      const res = await post(payload);
      const raw = await res.text();
      let data = {};
      try {
        data = JSON.parse(raw);
      } catch {
        data = { stdout: raw, stderr: "", exit_code: res.ok ? 0 : 1 };
      }
      if (typeof data.run_id === "string") runId = data.run_id;
      const stdoutText = typeof data.stdout === "string" ? data.stdout : "";
      const stderrText = typeof data.stderr === "string" ? data.stderr : "";
      const exitCode = typeof data.exit_code === "number" ? data.exit_code : res.ok ? 0 : 1;
      const signalName = typeof data.signal === "string" ? data.signal : null;
      const timedOutRemote = data.timed_out === true;
      const sessionId = validateSessionId(data.session_id);
      const fetchedSession = typeof data.session_log === "string" && data.session_log.length > 0 ? data.session_log : null;
      const stdoutAcc = new StreamAccumulator(maxOutputBytes, spillDir, "stdout", maxSpillBytes);
      const stderrAcc = new StreamAccumulator(maxOutputBytes, spillDir, "stderr", maxSpillBytes);
      stdoutAcc.push(stdoutText);
      stderrAcc.push(stderrText);
      stdoutAcc.finish();
      stderrAcc.finish();
      return {
        ok: res.ok && exitCode === 0 && !timedOut && !timedOutRemote && !aborted && !cancelled,
        spawnError: undefined,
        networkError: undefined,
        exitCode,
        signal: signalName,
        timedOut: timedOut || timedOutRemote,
        aborted,
        cancelled,
        sessionId,
        fetchedSession,
        streams: { stdout: stdoutAcc.snapshot(), stderr: stderrAcc.snapshot() }
      };
    } catch (error) {
      return {
        ok: false,
        spawnError: undefined,
        networkError: error instanceof Error ? error.message : String(error),
        exitCode: null,
        signal: null,
        timedOut,
        aborted,
        cancelled,
        sessionId: null,
        fetchedSession: null,
        streams: {
          stdout: { text: "", truncated: false },
          stderr: { text: error instanceof Error ? error.message : String(error), truncated: false }
        }
      };
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  })();

  let settledText = null;
  let settledRead = false;
  promise.then((result) => {
    settledText = renderStreams(result.streams.stdout, result.streams.stderr);
  }).catch(() => {});

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    try {
      controller.abort(new Error("cancelled"));
    } catch {
      // already aborted
    }
    if (runId !== undefined) {
      post({ cancel: true, run_id: runId }).catch(() => {});
    }
  };

  const readDelta = () => {
    if (settledText !== null && !settledRead) {
      settledRead = true;
      return settledText;
    }
    return "";
  };

  return { promise, cancel, readDelta, getRunId: () => runId };
}

// ---------------------------------------------------------------------------
// Call resolution (endpoint presets + defaults + ssh merge)
// ---------------------------------------------------------------------------

function resolveCall(config, args, toolName) {
  const endpoints = config.endpoints ?? {};
  const endpointName = args.endpoint ?? null;
  const ep = endpointName !== null ? endpoints[endpointName] : undefined;
  if (endpointName !== null && ep === undefined) {
    const available = Object.keys(endpoints);
    throw new Error(`${toolName}: unknown endpoint ${JSON.stringify(endpointName)}${available.length > 0
      ? `; available endpoints: ${available.map((n) => JSON.stringify(n)).join(", ")}`
      : "; no endpoints are configured (add endpoints to the plugin config or pass host= directly)"}`);
  }
  const pick = (key, fallback) => {
    if (args[key] !== undefined && args[key] !== null) return args[key];
    if (ep !== undefined && ep[key] !== undefined) return ep[key];
    return fallback;
  };
  const ssh = {
    port: args.port ?? ep?.ssh?.port ?? config.ssh?.port ?? undefined,
    identityFile: args.identity_file ?? ep?.ssh?.identityFile ?? config.ssh?.identityFile ?? undefined,
    proxyJump: args.proxy_jump ?? ep?.ssh?.proxyJump ?? config.ssh?.proxyJump ?? undefined,
    connectTimeout: args.connect_timeout ?? ep?.ssh?.connectTimeout ?? config.ssh?.connectTimeout ?? 10,
    strictHostKeyChecking: args.strict_host_key_checking ?? ep?.ssh?.strictHostKeyChecking ?? config.ssh?.strictHostKeyChecking ?? "accept-new",
    batchMode: ep?.ssh?.batchMode ?? config.ssh?.batchMode ?? true
  };
  const timeoutSeconds = pick("timeoutSeconds", config.timeoutSeconds ?? 600);
  const timeoutMs = Math.max(1, (args.timeout_seconds ?? timeoutSeconds) * 1000);
  const sessionsRootExpr = (config.sessionsRoot ?? "").length > 0
    ? shSingleQuote(config.sessionsRoot)
    : "${DSH_HOME:-$HOME/.dsh}/sessions";
  const rawShell = pick("remoteShell", config.remoteShell ?? "auto");
  const remoteShell = rawShell === "cmd" || rawShell === "powershell" ? rawShell : "posix";
  return {
    endpointName,
    transport: pick("transport", config.transport ?? "ssh"),
    host: pick("host", config.defaultHost ?? ""),
    cwd: pick("cwd", config.defaultCwd ?? ""),
    ssh,
    remoteShell,
    timeoutMs,
    maxOutputBytes: args.max_output_bytes ?? pick("maxOutputBytes", config.maxOutputBytes ?? 2 * 1024 * 1024),
    maxSpillBytes: config.maxSpillBytes ?? 64 * 1024 * 1024,
    spillDir: (config.spillDir ?? "").length > 0 ? config.spillDir : join(tmpdir(), "dsh-remote-agent"),
    httpUrl: pick("httpUrl", config.httpUrl ?? ""),
    httpToken: pick("httpToken", config.httpToken ?? ""),
    agentCommand: pick("agentCommand", config.agentCommand ?? "dsh --profile headless"),
    dshCommand: pick("dshCommand", config.dshCommand ?? "dsh"),
    profile: pick("profile", config.defaultProfile ?? "headless"),
    permissionMode: args.permission_mode ?? config.defaultPermissionMode ?? "workspace-write",
    maxPermissionMode: ep?.maxPermissionMode ?? config.maxPermissionMode ?? "danger-full-access",
    sessionsRootExpr
  };
}

/** Fetch a remote DSH session log over SSH (used by resume + fetch_session). */
async function fetchSessionOverSsh(resolvedCall, config, id, bytes, mode) {
  const script = buildFetchSessionScript(resolvedCall.sessionsRootExpr, id, bytes, mode);
  const run = startSshProcess({
    sshBin: config.sshCommand,
    host: resolvedCall.host,
    ssh: resolvedCall.ssh,
    script,
    timeoutMs: 60_000,
    signal: undefined,
    maxOutputBytes: Math.max(bytes, 1024),
    maxSpillBytes: config.maxSpillBytes ?? 64 * 1024 * 1024,
    spillDir: resolvedCall.spillDir
  });
  const result = await run.promise;
  if (!result.ok) return null;
  return run.getStreams().stdout.text;
}

/** Map a settled run onto the generic jobs outcome vocabulary. */
function jobOutcomeOf(result) {
  if (result.cancelled) return { status: "killed", detail: "cancelled on request" };
  if (result.spawnError !== undefined) {
    return { status: "failed", detail: result.spawnError instanceof Error ? result.spawnError.message : String(result.spawnError) };
  }
  if (result.networkError !== undefined) return { status: "failed", detail: result.networkError };
  const parts = [`exit code: ${result.exitCode ?? "unknown"}`];
  if (result.timedOut) parts.push("timed out");
  if (result.signal !== null && result.signal !== undefined) parts.push(`signal: ${result.signal}`);
  if (result.sessionId) parts.push(`session: ${result.sessionId}`);
  return { status: "completed", detail: parts.join(", ") };
}

function foregroundValue({ transport, endpoint, command, result, markers, timeoutMs, fetchedSession }) {
  const sessionId = validateSessionId(markers?.SESSION_ID ?? result.sessionId) ?? null;
  const streams = result.streams ?? { stdout: { text: "", truncated: false }, stderr: { text: "", truncated: false } };
  return {
    kind: "foreground",
    ok: result.ok === true,
    transport,
    endpoint,
    command,
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    timedOut: result.timedOut === true,
    aborted: result.aborted === true || result.cancelled === true,
    timeoutMs,
    exitReason: exitReasonOf(result),
    sessionId,
    fetchedSession: fetchedSession ?? null,
    stdout: streams.stdout,
    stderr: streams.stderr
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const SSH_PARAMETERS = {
  endpoint: {
    type: "string",
    description: "Named endpoint preset from plugin config (configures host/cwd/profile/ssh/http and permission caps in one name). Prefer this over ad-hoc host=."
  },
  host: {
    type: "string",
    description: "SSH target, e.g. user@server. Defaults to the endpoint preset or plugin config defaultHost."
  },
  cwd: {
    type: "string",
    description: "Remote working directory to cd into before launching the agent."
  },
  transport: {
    type: "string",
    enum: ["ssh", "http"],
    description: "Override transport. Defaults to the endpoint preset or plugin config (ssh)."
  },
  port: {
    type: "integer",
    description: "Remote SSH port override."
  },
  identity_file: {
    type: "string",
    description: "Path to the private key file (ssh -i)."
  },
  proxy_jump: {
    type: "string",
    description: "Jump host for indirect connections (ssh -J)."
  },
  connect_timeout: {
    type: "number",
    description: "SSH ConnectTimeout in seconds (default from config, 10)."
  },
  strict_host_key_checking: {
    type: "string",
    enum: ["yes", "no", "accept-new"],
    description: "SSH host key policy override."
  },
  run_in_background: {
    type: "boolean",
    description: "Run in the background and return a job id immediately (collect incremental output with job_output, stop it with job_kill — cancellation propagates to the remote process). No timeout applies."
  },
  timeout_seconds: {
    type: "number",
    description: "Timeout in seconds. Defaults to plugin config timeoutSeconds (600)."
  },
  max_output_bytes: {
    type: "number",
    description: "Output byte cap for stdout/stderr. Excess output spills to a local file whose path is reported instead of being lost."
  }
};

function presentCall(args, toolName) {
  const target = args.endpoint ?? args.host ?? "remote";
  if (args.run_in_background === true) {
    return {
      card: "generic",
      kind: "execute",
      title: `${toolName} (background) → ${target}`,
      rawInput: args.prompt,
      content: [{ type: "text", text: args.prompt }]
    };
  }
  return {
    card: "terminal",
    title: `${toolName} → ${target}`,
    description: args.prompt,
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {})
  };
}

function presentResult(args, result) {
  const block = result.content.find((c) => c.type === "text");
  const text = block?.text ?? "";
  if (args.run_in_background === true || result.isError) {
    return {
      card: "generic",
      content: [{ type: "text", text: "```console\n" + text.replace(/\n+$/, "") + "\n```" }]
    };
  }
  const meta = result.meta ?? {};
  return {
    card: "terminal",
    output: stripTrailingMarkers(text),
    ...(typeof meta.exitCode === "number" ? { exitCode: meta.exitCode } : {}),
    ...(typeof meta.signal === "string" && meta.signal.length > 0 ? { signal: meta.signal } : {})
  };
}

function presentationMeta(_args, value) {
  if (value.kind === "background") return { jobId: value.jobId };
  return {
    exitCode: value.exitCode,
    signal: value.signal,
    sessionId: value.sessionId
  };
}

function guidance() {
  return `When a task must run on a remote server or in another agent harness, use remote_agent (or remote_dsh when the remote side is also DeepSeek Harness) instead of trying to run it locally. Pass a complete, self-contained prompt. Prefer named endpoint presets (endpoint=) over ad-hoc host/cwd. For long-running tasks set run_in_background: true: the call returns a job id immediately; read incremental output with job_output and stop the remote work with job_kill (cancellation propagates to the remote process group). remote_dsh reports the remote session id in its result: pass resume_session: "last" (or an explicit id) to continue that session's context, or fetch_session: "tail" to pull its session log back for local import_dsh. Non-zero remote exits are reported, not failed; only transport/infrastructure errors throw.`;
}

function apply(ctx, config = {}) {
  const baseConfig = {
    transport: config.transport ?? "ssh",
    defaultHost: config.defaultHost ?? "",
    agentCommand: config.agentCommand ?? "dsh --profile headless",
    dshCommand: config.dshCommand ?? "dsh",
    defaultProfile: config.defaultProfile ?? "headless",
    defaultCwd: config.defaultCwd ?? "",
    sshCommand: config.sshCommand ?? "ssh",
    remoteShell: config.remoteShell ?? "auto",
    ssh: {
      port: config.ssh?.port,
      identityFile: config.ssh?.identityFile,
      proxyJump: config.ssh?.proxyJump,
      connectTimeout: config.ssh?.connectTimeout ?? 10,
      strictHostKeyChecking: config.ssh?.strictHostKeyChecking ?? "accept-new",
      batchMode: config.ssh?.batchMode ?? true
    },
    httpUrl: config.httpUrl ?? "",
    httpToken: config.httpToken ?? "",
    timeoutSeconds: config.timeoutSeconds ?? 600,
    maxOutputBytes: config.maxOutputBytes ?? 2 * 1024 * 1024,
    maxSpillBytes: config.maxSpillBytes ?? 64 * 1024 * 1024,
    spillDir: config.spillDir ?? "",
    endpoints: config.endpoints ?? {},
    enableRunInBackground: config.enableRunInBackground ?? true,
    sshWrapper: config.sshWrapper ?? true,
    discoverSessions: config.discoverSessions ?? true,
    rememberSessions: config.rememberSessions ?? true,
    sessionsRoot: config.sessionsRoot ?? "",
    fetchTailBytes: config.fetchTailBytes ?? 512 * 1024,
    resumeContextBytes: config.resumeContextBytes ?? 256 * 1024,
    defaultPermissionMode: config.defaultPermissionMode ?? "workspace-write",
    maxPermissionMode: config.maxPermissionMode ?? "danger-full-access",
    env: config.env ?? {}
  };

  // Live config: the composition config overlaid by the user-settings
  // namespace ("remote-agent"), hot-updated when the web UI's Settings →
  // Plugins card writes a field. Everything below reads `live.config`.
  const live = { config: baseConfig };
  try {
    const scope = ctx.settings.register("remote-agent", SETTINGS_SCHEMA, {
      base: settingsBaseOf(config),
      applies: "live"
    });
    const applyLive = () => {
      live.config = { ...baseConfig, ...(scope.get() ?? {}) };
    };
    applyLive();
    ctx.effect(() => scope.watch(() => applyLive()), "remote-agent: live settings namespace");
  } catch (error) {
    // A corrupted stored section must never take the tools down with it.
    ctx.logger?.warn?.("dsh-remote-agent: settings namespace unavailable, UI edits disabled: " + (error instanceof Error ? error.message : String(error)));
  }

  // endpoint key → most recent remote session id (resume_session: "last")
  const lastSessions = new Map();

  ctx.systemPrompt?.section?.({
    name: "tool:remote-agent",
    order: 130,
    text: guidance()
  });

  const dispatchSsh = async ({ args, exec, resolvedCall, innerCommand, discover, toolName }) => {
    // The process-group wrapper (and session discovery/fetch) needs a POSIX
    // remote shell; cmd/powershell remotes run the plain command, and
    // cancellation there only kills the local ssh client (Win32-OpenSSH
    // terminates the session on disconnect — best effort).
    const wrapperEnabled = live.config.sshWrapper && resolvedCall.remoteShell === "posix";
    const script = buildSshScript({
      innerCommand,
      discover: discover && wrapperEnabled,
      sessionsRootExpr: resolvedCall.sessionsRootExpr,
      sshWrapper: wrapperEnabled
    });
    if (args.run_in_background === true) {
      if (!live.config.enableRunInBackground) {
        throw new Error("run_in_background is disabled for this deployment (enableRunInBackground: false)");
      }
      const jobs = ctx.get("jobs");
      if (jobs === undefined) {
        throw new Error("background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs");
      }
      if (exec.signal.aborted) throw abortToolError();
      return {
        kind: "background",
        jobId: jobs.start({
          kind: "remote",
          label: `${toolName} → ${resolvedCall.endpointName ?? resolvedCall.host ?? "remote"}: ${String(args.prompt).slice(0, 120)}`,
          ...(exec.agent ? { owner: exec.agent } : {}),
          run: () => {
            const run = startSshProcess({
              sshBin: live.config.sshCommand,
              host: resolvedCall.host,
              ssh: resolvedCall.ssh,
              script,
              timeoutMs: undefined,
              signal: undefined,
              maxOutputBytes: resolvedCall.maxOutputBytes,
              maxSpillBytes: resolvedCall.maxSpillBytes,
              spillDir: resolvedCall.spillDir
            });
            run.promise.then((result) => {
              const sessionId = validateSessionId(run.getMarkers().SESSION_ID);
              if (sessionId && live.config.rememberSessions) lastSessions.set(resolvedCall.endpointName ?? resolvedCall.host ?? "default", sessionId);
            }).catch(() => {});
            return {
              cancel: () => run.cancel(),
              done: run.promise.then((result) => jobOutcomeOf(result)),
              readOutput: () => run.readDelta()
            };
          }
        })
      };
    }
    const run = startSshProcess({
      sshBin: live.config.sshCommand,
      host: resolvedCall.host,
      ssh: resolvedCall.ssh,
      script,
      timeoutMs: resolvedCall.timeoutMs,
      signal: exec.signal,
      maxOutputBytes: resolvedCall.maxOutputBytes,
      maxSpillBytes: resolvedCall.maxSpillBytes,
      spillDir: resolvedCall.spillDir
    });
    const result = await run.promise;
    if (result.aborted && !result.cancelled) throw abortToolError();
    if (result.spawnError !== undefined) {
      throw new Error(`${toolName}: failed to launch ${live.config.sshCommand}: ${result.spawnError instanceof Error ? result.spawnError.message : String(result.spawnError)}`);
    }
    const markers = run.getMarkers();
    const sessionId = validateSessionId(markers.SESSION_ID);
    if (sessionId && live.config.rememberSessions) lastSessions.set(resolvedCall.endpointName ?? resolvedCall.host ?? "default", sessionId);
    let fetchedSession = null;
    if (args.fetch_session !== undefined && args.fetch_session !== "none" && sessionId !== null) {
      const bytes = args.fetch_session === "full" ? resolvedCall.maxOutputBytes : live.config.fetchTailBytes;
      fetchedSession = await fetchSessionOverSsh(resolvedCall, live.config, sessionId, bytes, args.fetch_session);
    }
    return foregroundValue({
      transport: "ssh",
      endpoint: resolvedCall.endpointName,
      command: script,
      result,
      markers,
      timeoutMs: resolvedCall.timeoutMs,
      fetchedSession
    });
  };

  const dispatchHttp = async ({ args, exec, resolvedCall, payload, toolName }) => {
    if (!resolvedCall.httpUrl) {
      throw new Error(`${toolName}: http transport requires httpUrl in plugin config (or the endpoint preset)`);
    }
    const run = startHttpRequest({
      url: resolvedCall.httpUrl,
      token: resolvedCall.httpToken,
      payload,
      timeoutMs: args.run_in_background === true ? undefined : resolvedCall.timeoutMs,
      signal: args.run_in_background === true ? undefined : exec.signal,
      maxOutputBytes: resolvedCall.maxOutputBytes,
      maxSpillBytes: resolvedCall.maxSpillBytes,
      spillDir: resolvedCall.spillDir
    });
    if (args.run_in_background === true) {
      if (!live.config.enableRunInBackground) {
        throw new Error("run_in_background is disabled for this deployment (enableRunInBackground: false)");
      }
      const jobs = ctx.get("jobs");
      if (jobs === undefined) {
        throw new Error("background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs");
      }
      if (exec.signal.aborted) throw abortToolError();
      return {
        kind: "background",
        jobId: jobs.start({
          kind: "remote",
          label: `${toolName} → ${resolvedCall.httpUrl}: ${String(args.prompt).slice(0, 120)}`,
          ...(exec.agent ? { owner: exec.agent } : {}),
          run: () => {
            run.promise.then((result) => {
              if (result.sessionId && live.config.rememberSessions) lastSessions.set(resolvedCall.endpointName ?? resolvedCall.host ?? "default", result.sessionId);
            }).catch(() => {});
            return {
              cancel: () => run.cancel(),
              done: run.promise.then((result) => jobOutcomeOf(result)),
              readOutput: () => run.readDelta()
            };
          }
        })
      };
    }
    const result = await run.promise;
    if (result.aborted && !result.cancelled) throw abortToolError();
    if (result.sessionId && live.config.rememberSessions) lastSessions.set(resolvedCall.endpointName ?? resolvedCall.host ?? "default", result.sessionId);
    let fetchedSession = result.fetchedSession;
    if (args.fetch_session !== undefined && args.fetch_session !== "none" && fetchedSession === null && result.sessionId) {
      result.streams.stderr = {
        ...result.streams.stderr,
        text: result.streams.stderr.text + "\n[fetch_session over HTTP needs server support; this server did not return session_log]"
      };
    }
    return foregroundValue({
      transport: "http",
      endpoint: resolvedCall.endpointName,
      command: resolvedCall.httpUrl,
      result,
      markers: {},
      timeoutMs: resolvedCall.timeoutMs,
      fetchedSession
    });
  };

  ctx.tools.register(defineTool({
    name: "remote_agent",
    description: "Call another agent harness on a remote machine and return its final output. SSH transport runs `<agent_command> '<prompt>'` in the remote working directory (default `dsh --profile headless '<prompt>'`; override with agent_command, e.g. `claude -p` or `opencode run`). HTTP transport POSTs a JSON body to the configured httpUrl and expects `{ stdout, stderr, exit_code }` or plain text. Prefer named endpoint presets (endpoint=) over ad-hoc host/cwd. For long-running tasks set run_in_background: true — the call returns a job id immediately; read incremental output with job_output and stop the remote work with job_kill (cancellation propagates to the remote process group). Output beyond max_output_bytes spills to a local file whose path is reported instead of being lost. Non-zero exits are reported, not failed; only transport/infrastructure errors throw.",
    parameters: {
      prompt: {
        type: "string",
        required: true,
        description: "Complete, self-contained task for the remote agent, in the remote agent's preferred language."
      },
      agent_command: {
        type: "string",
        description: "Remote agent CLI prefix, e.g. `dsh --profile headless`, `claude -p`, `opencode run`. Defaults to the endpoint preset or plugin config."
      },
      ...SSH_PARAMETERS
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderOutput,
      presentationMeta
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const resolvedCall = resolveCall(live.config, args, "remote_agent");
      if (resolvedCall.transport === "ssh") {
        if (!resolvedCall.host) throw new Error("remote_agent: ssh transport requires a host (pass host= or endpoint=, or set defaultHost in plugin config)");
        const innerCommand = buildRemoteAgentCommand(resolvedCall.agentCommand, args.prompt, resolvedCall.cwd, resolvedCall.remoteShell);
        return dispatchSsh({ args, exec, resolvedCall, innerCommand, discover: false, toolName: "remote_agent" });
      }
      const payload = {
        prompt: args.prompt,
        ...(resolvedCall.cwd ? { cwd: resolvedCall.cwd } : {}),
        agent_command: resolvedCall.agentCommand,
        timeout_ms: resolvedCall.timeoutMs
      };
      return dispatchHttp({ args, exec, resolvedCall, payload, toolName: "remote_agent" });
    },
    presentCall: (args) => presentCall(args, "remote_agent"),
    presentResult
  }));

  ctx.tools.register(defineTool({
    name: "remote_dsh",
    description: "Call a remote DeepSeek Harness (DSH) agent and return its final output. SSH transport builds `dsh --profile <profile> [--patch <patch>] '<prompt>'` in the remote working directory (default profile: headless) with DSH_PERMISSION_MODE set from permission_mode, capped by the endpoint's maxPermissionMode. HTTP transport POSTs a DSH-shaped JSON body to the configured httpUrl. Every completed run reports the remote session id: pass resume_session: \"last\" (or an explicit session id) to continue that session's context — the plugin fetches the previous session's log tail and injects it as context, because this DSH version's headless profile cannot resume server-side — or fetch_session: \"tail\" to pull the finished session's log back for local import_dsh. Set run_in_background: true for long tasks: the call returns a job id immediately; read output with job_output and stop the remote process with job_kill. Non-zero exits are reported, not failed; only transport/infrastructure errors throw.",
    parameters: {
      prompt: {
        type: "string",
        required: true,
        description: "Complete, self-contained task for the remote DSH agent."
      },
      profile: {
        type: "string",
        description: "Remote DSH profile to boot. Defaults to the endpoint preset or plugin config defaultProfile (headless)."
      },
      resume_session: {
        type: "string",
        description: "Remote session id to continue, or \"last\" for the most recent session on this endpoint. The previous session's log tail is injected as context into a fresh run."
      },
      fetch_session: {
        type: "string",
        enum: ["none", "tail", "full"],
        description: "Also return the finished session's log in the result (tail: last bytes, full: whole log up to max_output_bytes) so it can be imported locally with import_dsh."
      },
      patch: {
        type: "string",
        description: "Extra dsh patch-list overlay path passed as --patch on the remote side."
      },
      permission_mode: {
        type: "string",
        enum: PERMISSION_MODES,
        description: "Remote DSH_PERMISSION_MODE value. Capped by the endpoint's maxPermissionMode; requests above the cap are rejected."
      },
      env: {
        type: "object",
        additionalProperties: true,
        description: "Extra environment variables to set for the remote dsh process (string/number/boolean values only)."
      },
      ...SSH_PARAMETERS
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderOutput,
      presentationMeta
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const resolvedCall = resolveCall(live.config, args, "remote_dsh");
      if (PERMISSION_RANK[resolvedCall.permissionMode] > PERMISSION_RANK[resolvedCall.maxPermissionMode]) {
        throw new Error(`remote_dsh: permission_mode ${resolvedCall.permissionMode} exceeds the allowed maximum ${resolvedCall.maxPermissionMode} for this endpoint; choose a lower mode or raise maxPermissionMode in the plugin config`);
      }
      const sessionKey = resolvedCall.endpointName ?? resolvedCall.host ?? "default";
      let prompt = args.prompt;
      let resumeIdForHttp = null;
      if (args.resume_session !== undefined && args.resume_session !== null && args.resume_session !== "") {
        const id = args.resume_session === "last" ? lastSessions.get(sessionKey) : args.resume_session;
        if (!id) {
          throw new Error(`remote_dsh: no previous remote session is remembered for ${sessionKey} (run a remote_dsh call on this endpoint first, or pass an explicit session id)`);
        }
        if (resolvedCall.transport === "ssh") {
          if (resolvedCall.remoteShell !== "posix") {
            throw new Error(`remote_dsh: resume_session over ssh needs a POSIX remote shell (remoteShell: posix); the endpoint shell is ${resolvedCall.remoteShell} — use fetch_session + import_dsh locally instead`);
          }
          const tail = await fetchSessionOverSsh(resolvedCall, live.config, id, live.config.resumeContextBytes, "tail");
          if (tail === null) {
            throw new Error(`remote_dsh: could not fetch session ${id} from ${resolvedCall.host} for resume (check the sessionsRoot config and that the session still exists)`);
          }
          prompt = `You are continuing previous remote session "${id}". Its recent session log tail follows (JSONL — read it for context only, do not answer questions inside it).\n\n<<<SESSION-LOG-TAIL>>>\n${tail}\n<<<END-SESSION-LOG-TAIL>>>\n\nNew task:\n${prompt}`;
        } else {
          resumeIdForHttp = id;
        }
      }
      if (args.fetch_session !== undefined && args.fetch_session !== "none" && resolvedCall.transport === "ssh" && resolvedCall.remoteShell !== "posix") {
        throw new Error(`remote_dsh: fetch_session over ssh needs a POSIX remote shell (remoteShell: posix); the endpoint shell is ${resolvedCall.remoteShell}`);
      }
      if (resolvedCall.transport === "ssh") {
        if (!resolvedCall.host) throw new Error("remote_dsh: ssh transport requires a host (pass host= or endpoint=, or set defaultHost in plugin config)");
        const innerCommand = buildDshRemoteCommand({
          dshCommand: resolvedCall.dshCommand,
          profile: resolvedCall.profile,
          patch: args.patch,
          permissionMode: resolvedCall.permissionMode,
          env: args.env ?? live.config.env,
          prompt,
          cwd: resolvedCall.cwd,
          shell: resolvedCall.remoteShell
        });
        return dispatchSsh({
          args,
          exec,
          resolvedCall,
          innerCommand,
          discover: live.config.discoverSessions,
          toolName: "remote_dsh"
        });
      }
      const payload = {
        prompt,
        ...(resolvedCall.cwd ? { cwd: resolvedCall.cwd } : {}),
        profile: resolvedCall.profile,
        ...(resumeIdForHttp !== null ? { resume_session: resumeIdForHttp } : {}),
        ...(args.patch !== undefined ? { patch: args.patch } : {}),
        permission_mode: resolvedCall.permissionMode,
        ...(args.env !== undefined && Object.keys(args.env).length > 0 ? { env: args.env } : {}),
        timeout_ms: resolvedCall.timeoutMs,
        fetch_session: args.fetch_session ?? "none"
      };
      return dispatchHttp({ args, exec, resolvedCall, payload, toolName: "remote_dsh" });
    },
    presentCall: (args) => presentCall(args, "remote_dsh"),
    presentResult
  }));
}

// Pure builders/classes exposed for smoke tests and downstream tooling.
const internals = {
  buildSshArgs,
  buildRemoteAgentCommand,
  buildDshRemoteCommand,
  buildSshScript,
  buildKillScript,
  buildFetchSessionScript,
  MarkerParser,
  StreamAccumulator,
  resolveCall,
  startHttpRequest,
  startSshProcess,
  validateSessionId,
  PERMISSION_RANK,
  shSingleQuote,
  psSingleQuote,
  cmdQuote,
  SETTINGS_SCHEMA,
  settingsBaseOf
};

export { Config, apply, inject, name, internals };
