// Client-bundle execution smoke test (node-side browser simulation):
// materializes lib/client.js through a fake window.__ModuleLoader__ with a
// minimal React + primitives shim, then drives apply(ctx) against a fake
// slots/settingsScope context and renders the card once — proving the bundle
// executes, registers the right slot key, and produces the expected tree.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CLIENT_BUNDLE = process.argv[2] ??
  "C:/Users/Administrator/.dsh/plugins/dsh-remote-agent/lib/client.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (ok) console.log("ok  ", label);
  else { failures += 1; console.log("FAIL", label, detail); }
};

// --- minimal react shim (single-render capable) -----------------------------
let hookIndex = 0;
const hookState = [];
let pendingEffects = [];
function resetHooks() {
  hookIndex = 0;
  pendingEffects = [];
}
const fakeReact = {
  Fragment: "Fragment",
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.length === 1 ? children[0] : children };
  },
  useState(init) {
    const slot = hookIndex++;
    if (!(slot in hookState)) hookState[slot] = init;
    return [hookState[slot], (next) => {
      hookState[slot] = typeof next === "function" ? next(hookState[slot]) : next;
    }];
  },
  useEffect(fn) {
    hookIndex++;
    pendingEffects.push(fn);
  },
  useMemo(fn) {
    hookIndex++;
    return fn();
  },
  useSyncExternalStore(_subscribe, get) {
    hookIndex++;
    return get();
  }
};

// --- load the bundle through a fake module loader ---------------------------
const registration = { id: null, factory: null };
const fakeWindow = {
  __ModuleLoader__: {
    load(reg) {
      registration.id = reg.id;
      registration.factory = reg.factory;
    }
  }
};
new Function("window", readFileSync(resolve(CLIENT_BUNDLE), "utf8"))(fakeWindow);
check("bundle registers under id dsh-remote-agent", registration.id === "dsh-remote-agent", String(registration.id));

const fakeRequire = (spec) => {
  if (spec === "react") return fakeReact;
  if (spec === "@deepseek-ai/dsh-client-ui-primitives") return {};
  throw new Error(`unexpected require: ${spec}`);
};
const exports = registration.factory(fakeRequire);
check("factory exports apply + inject", typeof exports.apply === "function" && Array.isArray(exports.inject), "");
check("inject declares slots + settingsScope", exports.inject.includes("slots") && exports.inject.includes("settingsScope"), JSON.stringify(exports.inject));

// --- drive apply(ctx) --------------------------------------------------------
const slotCalls = [];
const snapshot = {
  status: "ready",
  writable: true,
  mode: "host",
  value: {
    transport: "ssh",
    defaultHost: "def@box",
    remoteShell: "auto",
    httpUrl: "",
    httpToken: "",
    timeoutSeconds: 600,
    maxOutputBytes: 2097152,
    defaultPermissionMode: "workspace-write",
    maxPermissionMode: "danger-full-access",
    endpoints: {
      prod: { transport: "ssh", host: "deploy@10.0.0.5", maxPermissionMode: "workspace-write", ssh: { port: 22, connectTimeout: 10, strictHostKeyChecking: "accept-new" } }
    }
  },
  base: { endpoints: { prod: { transport: "ssh", host: "deploy@10.0.0.5" } } },
  user: {},
  revision: 1
};
const fakeScope = {
  subscribe: () => () => {},
  getSnapshot: () => snapshot,
  set: async () => {},
  unset: async () => {}
};
const fakeCtx = {
  settingsScope: { bind: (spec) => {
    check("scope binds namespace remote-agent", spec.namespace === "remote-agent", JSON.stringify(spec));
    return fakeScope;
  } },
  slots: {
    inject(name, factory) {
      slotCalls.push(name);
      return factory();
    },
    register(options, Component) {
      slotCalls.push({ options, Component });
      return () => {};
    }
  }
};
exports.apply(fakeCtx);
check("slot injected: settings.plugin.item", slotCalls.includes("settings.plugin.item"), JSON.stringify(slotCalls.map((c) => typeof c === "string" ? c : c.options)));
const registered = slotCalls.find((c) => typeof c === "object");
check("card registered with key remote-agent", registered?.options?.key === "remote-agent", JSON.stringify(registered?.options));

// --- render the card once (mount effect + one follow-up render) -------------
// The registered slot occupant is a wrapper arrow component; hooks only run
// when its element tree is expanded, so render through the component types.
function renderElement(element) {
  if (element === null || element === undefined || typeof element.type !== "function") return element;
  return renderElement(element.type({ ...(element.props ?? {}) }));
}
resetHooks();
renderElement(registered.Component({}));
for (const effect of pendingEffects) effect(); // mount effect sets the draft
resetHooks();
const tree = renderElement(registered.Component({}));

function collectText(node, out) {
  if (node === null || node === undefined) return;
  if (typeof node === "string") { out.push(node); return; }
  if (Array.isArray(node)) { node.forEach((n) => collectText(n, out)); return; }
  if (typeof node.type === "function") {
    const props = { ...(node.props ?? {}) };
    if (node.children !== undefined && !("children" in props)) props.children = node.children;
    collectText(node.type(props), out);
    return;
  }
  collectText(node.props?.children, out);
  if (node.children) collectText(node.children, out);
}
const text = [];
collectText(tree, text);
const joined = text.join(" | ");
console.log("     rendered texts:", joined.slice(0, 400));
check("renders 端点预设 heading", joined.includes("端点预设"), "");
check("renders endpoint prod row", joined.includes("prod") && joined.includes("deploy@10.0.0.5"), "");
check("renders YAML 定义 badge for patch-backed endpoint", joined.includes("YAML 定义"), "");
check("renders 添加端点 button", joined.includes("＋ 添加端点"), "");
check("renders 全局默认 section", joined.includes("全局默认") && joined.includes("权限上限 maxPermissionMode"), "");
check("renders save button", joined.includes("已是最新"), "");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
