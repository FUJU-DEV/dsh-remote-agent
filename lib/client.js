// dsh-remote-agent — browser half: the endpoint-management card in the Web
// Settings → Plugins page. This file is a hand-authored client bundle in the
// DSH module-loader factory form (no build step): it registers one keyed
// occupant of the `settings.plugin.item` slot for the "remote-agent" settings
// namespace, reads the live value through `ctx.settingsScope`, and writes
// staged edits back through the built-in settings RPC (persisted to
// $DSH_HOME/settings.yaml by the host and hot-applied to the tools).
window.__ModuleLoader__.load({
	id: "dsh-remote-agent",
	factory: (require) => {
		var module = { exports: {} };
		var React = require("react");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		var useSyncExternalStore = React.useSyncExternalStore;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useMemo = React.useMemo;
		var Fragment = React.Fragment;

		// ------------------------------------------------------------------
		// Tiny inline style helpers over the shipped theme tokens.
		// ------------------------------------------------------------------
		var token = {
			bg: "var(--dsw-alias-bg-base)",
			card: "var(--dsw-alias-bg-container)",
			label: "var(--dsw-alias-label-primary)",
			dim: "var(--dsw-alias-label-tertiary)",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderL1: "1px solid var(--dsw-alias-border-l1)",
			accent: "var(--dsw-alias-state-business-primary)",
			error: "var(--dsw-alias-state-error-primary)",
			hover: "var(--dsw-alias-interactive-bg-hover)"
		};
		function box(extra) {
			var style = {
				boxSizing: "border-box",
				color: token.label,
				background: token.bg,
				borderRadius: 6,
				border: token.border,
				fontSize: 13,
				lineHeight: "20px",
				fontFamily: "inherit",
				outline: "none"
			};
			if (extra) for (var key in extra) style[key] = extra[key];
			return style;
		}

		function Field(props) {
			return React.createElement("label", {
				style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }
			},
				React.createElement("span", { style: { color: token.dim, fontSize: 12 } }, props.label),
				props.children
			);
		}
		function Input(props) {
			return React.createElement("input", {
				value: props.value,
				placeholder: props.placeholder,
				type: props.type ?? "text",
				onChange: (event) => props.onChange(event.target.value),
				style: box({ padding: "4px 8px", width: props.width ?? "100%", ...(props.invalid ? { borderColor: token.error } : {}) })
			});
		}
		function Select(props) {
			return React.createElement("select", {
				value: props.value ?? "",
				onChange: (event) => props.onChange(event.target.value),
				style: box({ padding: "4px 6px", width: props.width ?? "100%" })
			}, (props.options ?? []).map((option) => React.createElement("option", {
				key: String(option.value), value: option.value
			}, option.label)));
		}
		function Button(props) {
			return React.createElement("button", {
				type: "button",
				disabled: props.disabled === true,
				onClick: props.onClick,
				style: box({
					padding: "4px 12px",
					cursor: props.disabled ? "default" : "pointer",
					opacity: props.disabled ? 0.5 : 1,
					border: "none",
					background: props.primary ? token.accent : "transparent",
					color: props.primary ? "#fff" : token.label,
					...(props.primary ? {} : { border: token.borderL1 }),
					...(props.danger ? { color: token.error } : {})
				})
			}, props.children);
		}
		function Badge(props) {
			return React.createElement("span", {
				style: {
					fontSize: 11,
					lineHeight: "16px",
					padding: "0 6px",
					borderRadius: 999,
					border: token.borderL1,
					color: token.dim,
					background: "transparent",
					flex: "none"
				}
			}, props.children);
		}

		// ------------------------------------------------------------------
		// Endpoint record editor (inline form for one endpoint).
		// ------------------------------------------------------------------
		var TRANSPORTS = [
			{ value: "ssh", label: "ssh" },
			{ value: "http", label: "http" }
		];
		var SHELLS = [
			{ value: "auto", label: "auto（按 posix 处理）" },
			{ value: "posix", label: "posix（Linux/macOS/WSL）" },
			{ value: "cmd", label: "cmd（Windows 远程）" },
			{ value: "powershell", label: "powershell（Windows 远程）" }
		];
		var PERMISSIONS = [
			{ value: "read-only", label: "read-only" },
			{ value: "workspace-write", label: "workspace-write" },
			{ value: "danger-full-access", label: "danger-full-access" }
		];
		var HOST_KEYS = [
			{ value: "yes", label: "yes" },
			{ value: "no", label: "no" },
			{ value: "accept-new", label: "accept-new" }
		];

		function emptyEndpoint() {
			return {
				transport: "ssh",
				host: "",
				cwd: "",
				profile: "headless",
				remoteShell: "auto",
				ssh: { port: 22, connectTimeout: 10, strictHostKeyChecking: "accept-new" },
				maxPermissionMode: "danger-full-access",
				httpUrl: "",
				httpToken: ""
			};
		}

		function endpointOf(value, name) {
			var ep = value && typeof value === "object" ? value : {};
			var ssh = ep.ssh && typeof ep.ssh === "object" ? ep.ssh : {};
			var merged = {
				transport: ep.transport ?? "ssh",
				host: ep.host ?? "",
				cwd: ep.cwd ?? "",
				profile: ep.profile ?? "headless",
				agentCommand: ep.agentCommand ?? "",
				remoteShell: ep.remoteShell ?? "auto",
				ssh: {
					port: ssh.port ?? 22,
					identityFile: ssh.identityFile ?? "",
					proxyJump: ssh.proxyJump ?? "",
					connectTimeout: ssh.connectTimeout ?? 10,
					strictHostKeyChecking: ssh.strictHostKeyChecking ?? "accept-new"
				},
				httpUrl: ep.httpUrl ?? "",
				httpToken: ep.httpToken ?? "",
				maxPermissionMode: ep.maxPermissionMode ?? "danger-full-access",
				timeoutSeconds: ep.timeoutSeconds ?? 600,
				maxOutputBytes: ep.maxOutputBytes ?? 2097152
			};
			return merged;
		}

		/** Validate one endpoint draft; returns an error string or null. */
		function validateEndpoint(name, ep) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(name)) return "端点名只能包含字母、数字、点、下划线和连字符";
			if (ep.transport === "ssh" && ep.host.trim() === "") return "ssh 端点需要 host（如 user@server）";
			if (ep.transport === "http" && ep.httpUrl.trim() === "") return "http 端点需要 httpUrl";
			var port = Number(ep.ssh.port);
			if (!Number.isFinite(port) || port < 1 || port > 65535) return "ssh.port 必须是 1-65535 的整数";
			var ct = Number(ep.ssh.connectTimeout);
			if (!Number.isFinite(ct) || ct < 1 || ct > 3600) return "ssh.connectTimeout 必须是 1-3600 的秒数";
			if (ep.timeoutSeconds !== undefined && (!Number.isFinite(Number(ep.timeoutSeconds)) || Number(ep.timeoutSeconds) < 1)) return "timeoutSeconds 必须大于 0";
			return null;
		}

		function EndpointEditor(props) {
			var ep = props.value;
			var set = (key, value) => props.onChange({ ...ep, [key]: value });
			var setSsh = (key, value) => set("ssh", { ...ep.ssh, [key]: value });
			var isSsh = ep.transport === "ssh";
			var isHttp = ep.transport === "http";
			return React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, padding: 12, border: token.border, borderRadius: 8, background: token.card } },
				React.createElement(Field, { label: "传输 transport" },
					React.createElement(Select, { value: ep.transport, options: TRANSPORTS, onChange: (v) => set("transport", v) })),
				React.createElement(Field, { label: isSsh ? "SSH 目标 host" : "HTTP 地址 httpUrl" },
					isSsh
						? React.createElement(Input, { value: ep.host, placeholder: "user@server", onChange: (v) => set("host", v) })
						: React.createElement(Input, { value: ep.httpUrl, placeholder: "http://server:8765/run", onChange: (v) => set("httpUrl", v) })),
				React.createElement(Field, { label: "远程工作目录 cwd" },
					React.createElement(Input, { value: ep.cwd, placeholder: "/srv/app 或 D:\\projects", onChange: (v) => set("cwd", v) })),
				React.createElement(Field, { label: "DSH profile（remote_dsh）" },
					React.createElement(Input, { value: ep.profile, placeholder: "headless", onChange: (v) => set("profile", v) })),
				React.createElement(Field, { label: "远程 shell remoteShell" },
					React.createElement(Select, { value: ep.remoteShell, options: SHELLS, onChange: (v) => set("remoteShell", v) })),
				React.createElement(Field, { label: "权限上限 maxPermissionMode" },
					React.createElement(Select, { value: ep.maxPermissionMode, options: PERMISSIONS, onChange: (v) => set("maxPermissionMode", v) })),
				React.createElement(Field, { label: "ssh 端口 ssh.port" },
					React.createElement(Input, { type: "number", value: String(ep.ssh.port ?? 22), onChange: (v) => setSsh("port", v === "" ? "" : Number(v)) })),
				React.createElement(Field, { label: "私钥 ssh.identityFile" },
					React.createElement(Input, { value: ep.ssh.identityFile ?? "", placeholder: "C:\\Users\\me\\.ssh\\id_ed25519", onChange: (v) => setSsh("identityFile", v) })),
				React.createElement(Field, { label: "跳板机 ssh.proxyJump" },
					React.createElement(Input, { value: ep.ssh.proxyJump ?? "", placeholder: "jump@bastion", onChange: (v) => setSsh("proxyJump", v) })),
				React.createElement(Field, { label: "连接超时 ssh.connectTimeout（秒）" },
					React.createElement(Input, { type: "number", value: String(ep.ssh.connectTimeout ?? 10), onChange: (v) => setSsh("connectTimeout", v === "" ? "" : Number(v)) })),
				React.createElement(Field, { label: "主机密钥策略 ssh.strictHostKeyChecking" },
					React.createElement(Select, { value: ep.ssh.strictHostKeyChecking, options: HOST_KEYS, onChange: (v) => setSsh("strictHostKeyChecking", v) })),
				React.createElement(Field, { label: "超时 timeoutSeconds（秒）" },
					React.createElement(Input, { type: "number", value: String(ep.timeoutSeconds ?? 600), onChange: (v) => set("timeoutSeconds", v === "" ? undefined : Number(v)) })),
				isHttp && React.createElement(Field, { label: "HTTP token httpToken" },
					React.createElement(Input, { type: "password", value: ep.httpToken ?? "", placeholder: "与远端 --token 一致", onChange: (v) => set("httpToken", v) })),
				React.createElement("div", { style: { gridColumn: "1 / -1", display: "flex", gap: 8, justifyContent: "flex-end" } },
					React.createElement(Button, { onClick: props.onCancel, disabled: props.pending }, "取消"),
					React.createElement(Button, { primary: true, onClick: props.onSave, disabled: props.pending }, props.pending ? "保存中…" : "保存端点"))
			);
		}

		// ------------------------------------------------------------------
		// The card: endpoint list + global fields, staged edits, single save.
		// ------------------------------------------------------------------
		function RemoteAgentCard(props) {
			var scope = props.scope;
			var snapshot = useSyncExternalStore(
				(callback) => scope.subscribe(callback),
				() => scope.getSnapshot()
			);
			var ready = snapshot.status === "ready";
			var value = ready && snapshot.value && typeof snapshot.value === "object" ? snapshot.value : null;
			var base = snapshot.base && typeof snapshot.base === "object" ? snapshot.base : null;
			var writable = snapshot.writable === true;
			var mode = snapshot.mode;

			// Draft of the whole user-editable document (endpoints + globals).
			var [draft, setDraft] = useState(null);
			var [pending, setPending] = useState(false);
			var [error, setError] = useState(null);
			var [editing, setEditing] = useState(null); // endpoint name being edited (or "new")

			useEffect(() => {
				if (ready && value !== null) {
					setDraft({
						endpoints: { ...(value.endpoints ?? {}) },
						transport: value.transport,
						defaultHost: value.defaultHost ?? "",
						remoteShell: value.remoteShell ?? "auto",
						httpUrl: value.httpUrl ?? "",
						httpToken: value.httpToken ?? "",
						timeoutSeconds: value.timeoutSeconds ?? 600,
						maxOutputBytes: value.maxOutputBytes ?? 2097152,
						defaultPermissionMode: value.defaultPermissionMode ?? "workspace-write",
						maxPermissionMode: value.maxPermissionMode ?? "danger-full-access"
					});
					setEditing(null);
				}
			}, [ready, value]);

			var changed = useMemo(() => {
				if (draft === null || value === null) return [];
				var list = [];
				if (JSON.stringify(draft.endpoints) !== JSON.stringify(value.endpoints ?? {})) list.push("endpoints");
				if (draft.transport !== value.transport) list.push("transport");
				if (draft.defaultHost !== (value.defaultHost ?? "")) list.push("defaultHost");
				if (draft.remoteShell !== (value.remoteShell ?? "auto")) list.push("remoteShell");
				if (draft.httpUrl !== (value.httpUrl ?? "")) list.push("httpUrl");
				if (draft.httpToken !== (value.httpToken ?? "")) list.push("httpToken");
				if (Number(draft.timeoutSeconds) !== Number(value.timeoutSeconds ?? 600)) list.push("timeoutSeconds");
				if (Number(draft.maxOutputBytes) !== Number(value.maxOutputBytes ?? 2097152)) list.push("maxOutputBytes");
				if (draft.defaultPermissionMode !== (value.defaultPermissionMode ?? "workspace-write")) list.push("defaultPermissionMode");
				if (draft.maxPermissionMode !== (value.maxPermissionMode ?? "danger-full-access")) list.push("maxPermissionMode");
				return list;
			}, [draft, value]);

			var save = async () => {
				if (draft === null || changed.length === 0) return;
				setPending(true);
				setError(null);
				try {
					for (var field of changed) {
						await scope.set(field, field === "endpoints"
							? Object.fromEntries(Object.entries(draft.endpoints).map(([name, ep]) => [name, endpointOf(ep, name)]))
							: draft[field]);
					}
				} catch (saveError) {
					setError(saveError instanceof Error ? saveError.message : String(saveError));
				} finally {
					setPending(false);
				}
			};

			if (snapshot.status === "loading" || (snapshot.status === "ready" && draft === null)) {
				return React.createElement("div", { style: { color: token.dim, fontSize: 13, padding: "4px 0" } }, "加载中…");
			}
			if (snapshot.status !== "ready" || value === null) {
				return React.createElement("div", { style: { color: token.dim, fontSize: 13, padding: "4px 0" } }, "该部署未提供 remote-agent 配置面。");
			}

			var patchBacked = base && base.endpoints && typeof base.endpoints === "object" ? base.endpoints : {};
			var endpointNames = Object.keys(draft.endpoints);

			var globalFields = React.createElement(Fragment, {},
				React.createElement("h4", { style: { margin: "14px 0 6px", fontSize: 13, fontWeight: 600, color: token.label } }, "全局默认"),
				React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 } },
					React.createElement(Field, { label: "默认传输 transport" },
						React.createElement(Select, { value: draft.transport, options: TRANSPORTS, onChange: (v) => setDraft({ ...draft, transport: v }) })),
					React.createElement(Field, { label: "默认 SSH 目标 defaultHost" },
						React.createElement(Input, { value: draft.defaultHost, placeholder: "user@server", onChange: (v) => setDraft({ ...draft, defaultHost: v }) })),
					React.createElement(Field, { label: "远程 shell remoteShell" },
						React.createElement(Select, { value: draft.remoteShell, options: SHELLS, onChange: (v) => setDraft({ ...draft, remoteShell: v }) })),
					React.createElement(Field, { label: "HTTP 地址 httpUrl" },
						React.createElement(Input, { value: draft.httpUrl, placeholder: "http://server:8765/run", onChange: (v) => setDraft({ ...draft, httpUrl: v }) })),
					React.createElement(Field, { label: "HTTP token httpToken" },
						React.createElement(Input, { type: "password", value: draft.httpToken, onChange: (v) => setDraft({ ...draft, httpToken: v }) })),
					React.createElement(Field, { label: "前台超时 timeoutSeconds（秒）" },
						React.createElement(Input, { type: "number", value: String(draft.timeoutSeconds), onChange: (v) => setDraft({ ...draft, timeoutSeconds: v === "" ? 600 : Number(v) }) })),
					React.createElement(Field, { label: "输出上限 maxOutputBytes（字节）" },
						React.createElement(Input, { type: "number", value: String(draft.maxOutputBytes), onChange: (v) => setDraft({ ...draft, maxOutputBytes: v === "" ? 2097152 : Number(v) }) })),
					React.createElement(Field, { label: "默认权限 defaultPermissionMode" },
						React.createElement(Select, { value: draft.defaultPermissionMode, options: PERMISSIONS, onChange: (v) => setDraft({ ...draft, defaultPermissionMode: v }) })),
					React.createElement(Field, { label: "权限上限 maxPermissionMode" },
						React.createElement(Select, { value: draft.maxPermissionMode, options: PERMISSIONS, onChange: (v) => setDraft({ ...draft, maxPermissionMode: v }) }))
				)
			);

			var endpointRows = endpointNames.length === 0
				? React.createElement("p", { style: { color: token.dim, fontSize: 13, margin: "8px 0" } }, "还没有端点。点击「添加端点」配置第一台远程机器。")
				: endpointNames.map((name) => {
					var ep = draft.endpoints[name];
					var fromPatch = Object.prototype.hasOwnProperty.call(patchBacked, name);
					var editingThis = editing === name;
					return React.createElement("div", {
						key: name,
						style: { border: token.border, borderRadius: 8, marginBottom: 8, overflow: "hidden" }
					},
						React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: token.card } },
							React.createElement("span", { style: { fontWeight: 600, color: token.label } }, name),
							React.createElement(Badge, {}, ep.transport),
							React.createElement(Badge, {}, ep.host || ep.httpUrl || "—"),
							React.createElement(Badge, {}, "权限上限 " + (ep.maxPermissionMode ?? "—")),
							fromPatch && React.createElement(Badge, {}, "YAML 定义"),
							React.createElement("div", { style: { flex: 1 } }),
							React.createElement(Button, { onClick: () => setEditing(editingThis ? null : name), disabled: pending }, editingThis ? "收起" : "编辑"),
							React.createElement(Button, {
								danger: true,
								disabled: pending || fromPatch,
								onClick: () => {
									var next = { ...draft.endpoints };
									delete next[name];
									setDraft({ ...draft, endpoints: next });
								},
								title: fromPatch ? "该端点定义在 cordis.patch.yml，请在 YAML 里删除" : "删除端点"
							}, "删除")
						),
						editingThis && React.createElement(EndpointEditor, {
							value: ep,
							pending,
							onChange: (next) => setDraft({ ...draft, endpoints: { ...draft.endpoints, [name]: next } }),
							onCancel: () => setEditing(null),
							onSave: () => {
								var problem = validateEndpoint(name, ep);
								if (problem !== null) { setError(problem); return; }
								setEditing(null);
							}
						})
					);
				});

			var newEditor = editing === "new" && React.createElement(EndpointEditor, {
				value: draft.__new ?? emptyEndpoint(),
				pending,
				onChange: (next) => setDraft({ ...draft, __new: next }),
				onCancel: () => setEditing(null),
				onSave: () => {
					var ep = draft.__new ?? emptyEndpoint();
					var name = draft.__newName ?? "";
					var problem = validateEndpoint(name, ep);
					if (problem !== null) { setError(problem); return; }
					if (Object.prototype.hasOwnProperty.call(draft.endpoints, name)) { setError("端点 " + name + " 已存在"); return; }
					setDraft({ ...draft, endpoints: { ...draft.endpoints, [name]: endpointOf(ep, name) }, __new: undefined, __newName: undefined });
					setEditing(null);
				}
			});

			return React.createElement("div", { style: { padding: "2px 0 8px", color: token.label } },
				React.createElement("h4", { style: { margin: "0 0 6px", fontSize: 13, fontWeight: 600 } }, "端点预设"),
				endpointRows,
				editing === "new" && React.createElement(Field, { label: "端点名称（聊天里用 endpoint: \"名称\" 调用）" },
					React.createElement(Input, { value: draft.__newName ?? "", placeholder: "prod", onChange: (v) => setDraft({ ...draft, __newName: v }) })),
				editing === "new" && React.createElement("div", { style: { height: 8 } }),
				newEditor,
				editing !== "new" && React.createElement(Button, { onClick: () => setEditing("new"), disabled: pending || !writable }, "＋ 添加端点"),
				globalFields,
				error !== null && React.createElement("p", { role: "alert", style: { color: token.error, fontSize: 12, margin: "10px 0 0" } }, error),
				React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 14 } },
					React.createElement(Button, { primary: true, onClick: save, disabled: pending || changed.length === 0 || !writable }, pending ? "保存中…" : (changed.length === 0 ? "已是最新" : "保存（" + changed.length + " 项改动）")),
					!writable && React.createElement("span", { style: { color: token.dim, fontSize: 12 } }, mode === "memory" ? "远端浏览器：配置只读" : "配置只读"),
					React.createElement("span", { style: { color: token.dim, fontSize: 12 } }, "保存即写入 settings.yaml 并热生效，无需重启")
				)
			);
		}

		function apply(ctx) {
			var scope = ctx.settingsScope.bind({ namespace: "remote-agent" });
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: "remote-agent"
			}, (props) => React.createElement(RemoteAgentCard, { scope, ...props })));
		}

		module.exports = {
			apply,
			inject: ["slots", "settingsScope"]
		};
		return module.exports;
	}
});
