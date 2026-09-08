// End-to-end test of the settings UI surface: boots a second web instance,
// verifies the client bundle is served, the "remote-agent" namespace appears
// in settings.describe, a mutate roundtrip persists + hot-applies, and
// invalid values are rejected.
import { spawn, execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const PORT = 3099;
const BASE = `http://127.0.0.1:${PORT}`;
const SETTINGS_FILE = join(process.env.DSH_HOME ?? join(os.homedir(), ".dsh"), "settings.yaml");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (ok) console.log("ok  ", label);
  else { failures += 1; console.log("FAIL", label, detail); }
};

// Reclaim the port from any earlier orphaned test instance.
try {
  execSync(`powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force } }"`, { stdio: "ignore" });
} catch { /* best effort */ }

const DSH_BIN = process.env.DSH_BIN ?? "C:/Users/Administrator/AppData/Roaming/npm/dsh.cmd";
const boot = spawn(`"${DSH_BIN}" --profile web --port ${PORT} --no-open`, {
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env }
});
let bootLog = "";
boot.stdout.on("data", (c) => { bootLog += c.toString("utf8"); });
boot.stderr.on("data", (c) => { bootLog += c.toString("utf8"); });

const waitFor = async (fn, timeoutMs, label) => {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) {
      check(label, false, "timeout");
      return false;
    }
    await new Promise((d) => setTimeout(d, 300));
  }
};

const rpc = async (method, payload) => {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: `smoke-${Date.now()}-${Math.random()}`, method, payload })
  });
  return res.json();
};

try {
  const up = await waitFor(async () => {
    try {
      const res = await fetch(`${BASE}/`);
      return res.ok;
    } catch {
      return false;
    }
  }, 60000, "second web instance boots");
  if (!up) {
    console.log("--- boot log tail ---\n" + bootLog.slice(-4000));
    process.exit(1);
  }

  // The /api endpoint interceptors mount a beat after the SPA responds;
  // wait until the settings RPC itself answers with a real envelope.
  const rpcUp = await waitFor(async () => {
    try {
      const probe = await rpc("settings.describe", {});
      return probe && probe.type === "server-response";
    } catch {
      return false;
    }
  }, 60000, "settings RPC channel answers");
  if (!rpcUp) {
    console.log("--- boot log tail ---\n" + bootLog.slice(-4000));
    process.exit(1);
  }

  // 1. client bundle served
  const bundle = await fetch(`${BASE}/plugins/dsh-remote-agent/client.js`);
  const bundleText = await bundle.text();
  check("client bundle served (200)", bundle.status === 200, String(bundle.status));
  check("client bundle registers the plugin card", bundleText.includes("settings.plugin.item") && bundleText.includes("dsh-remote-agent"), "");

  // 2. namespace in settings.describe
  const describe1 = await rpc("settings.describe", {});
  check("settings.describe ok", describe1?.result?.ok === true, JSON.stringify(describe1));
  const ns = describe1?.result?.value?.namespaces?.find((n) => n.ns === "remote-agent");
  check("remote-agent namespace served", ns !== undefined, "");
  if (ns) {
    check("namespace has schema", typeof ns.schema === "object", "");
    check("namespace schema has endpoints", ns.schema?.refs?.[String(ns.schema?.uid)]?.dict?.endpoints !== undefined, "");
    check("namespace value has endpoints dict", ns.value?.endpoints !== undefined && typeof ns.value.endpoints === "object", JSON.stringify(ns.value));
    check("httpToken redacted (secret)", !JSON.stringify(ns).includes("SUPERSECRET"), "");
    console.log("     revision:", ns.revision, "| applies:", ns.applies);
  }

  // 3. mutate roundtrip: add an endpoint + change a global
  const rev = ns?.revision;
  const mutate = await rpc("settings.mutate", {
    ns: "remote-agent",
    ...(typeof rev === "number" ? { expectedRevision: rev } : {}),
    ops: [
      { op: "set", path: ["endpoints"], value: { smoke: { transport: "ssh", host: "test@127.0.0.1", cwd: "C:/tmp", remoteShell: "cmd", ssh: { port: 2222, strictHostKeyChecking: "accept-new" }, maxPermissionMode: "workspace-write", httpToken: "SUPERSECRET" } } },
      { op: "set", path: ["maxPermissionMode"], value: "workspace-write" }
    ]
  });
  check("settings.mutate ok", mutate?.result?.ok === true, JSON.stringify(mutate));

  // 4. persisted to settings.yaml
  const file = existsSync(SETTINGS_FILE) ? readFileSync(SETTINGS_FILE, "utf8") : "";
  check("settings.yaml has remote-agent section", file.includes("remote-agent:") && file.includes("smoke:"), SETTINGS_FILE);
  check("settings.yaml has the endpoint host", file.includes("test@127.0.0.1"), "");

  // 5. hot-applied: describe reflects the write without any restart
  const describe2 = await rpc("settings.describe", {});
  const ns2 = describe2?.result?.value?.namespaces?.find((n) => n.ns === "remote-agent");
  check("write hot-applied (endpoint visible)", ns2?.value?.endpoints?.smoke?.host === "test@127.0.0.1", JSON.stringify(ns2?.value?.endpoints ?? null));
  check("write hot-applied (maxPermissionMode)", ns2?.value?.maxPermissionMode === "workspace-write", String(ns2?.value?.maxPermissionMode));
  check("revision advanced", typeof ns2?.revision === "number" && ns2.revision > (typeof rev === "number" ? rev : 0), `rev ${rev} → ${ns2?.revision}`);

  // 6. invalid value rejected by host validation
  const bad = await rpc("settings.mutate", {
    ns: "remote-agent",
    ops: [{ op: "set", path: ["maxPermissionMode"], value: "root-everything" }]
  });
  check("invalid value rejected", bad?.result?.ok === false, JSON.stringify(bad));

  // 7. cleanup: restore the pre-test state
  const cleanup = await rpc("settings.mutate", {
    ns: "remote-agent",
    ops: [
      { op: "set", path: ["endpoints"], value: {} },
      { op: "unset", path: ["maxPermissionMode"] }
    ]
  });
  check("cleanup mutate ok", cleanup?.result?.ok === true, JSON.stringify(cleanup));
} finally {
  // Kill the whole booted tree (shell:true spawns a cmd wrapper; the node
  // server is its grandchild, so taskkill the tree), then reclaim the port.
  try {
    spawn("taskkill", ["/pid", String(boot.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } catch { /* already gone */ }
  try {
    execSync(`powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force } }"`, { stdio: "ignore" });
  } catch { /* best effort */ }
  await new Promise((d) => setTimeout(d, 1000));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
