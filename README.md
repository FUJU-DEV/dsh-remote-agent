# dsh-remote-agent

> **English summary** — A [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) plugin that lets a DSH agent drive work on remote machines over SSH or HTTP. `remote_dsh` boots a **complete DSH agent session on the remote** (its own model, tools, and persisted session log), then discovers the remote session id, supports context resume, and can pull the remote log back for local `import_dsh`. Background jobs integrate with DSH's native `job_output`/`job_kill`, cancellation propagates to the remote process group, a graphical endpoint manager ships in Web → Settings → Plugins (hot-applied to `settings.yaml`), and Windows remotes are supported (`remoteShell: cmd|powershell` or the zero-dependency HTTP server). 33 kB, MIT, zero runtime dependencies beyond DSH itself.

DeepSeek Harness（DSH）插件：让主 DSH Agent 通过 SSH 或 HTTP 调用部署在服务器上的副 Agent。**每次 `remote_dsh` 调用 = 在远端拉起一个完整的 DSH Agent 会话**（远端独立模型推理、独立工具、会话落盘），SSH 只是传输管道。当两边都是 DSH 时，额外提供会话发现、上下文续跑与会话日志回传。

## 架构（默认 C/S，无需额外服务）

```text
┌────────────────────────── 你的电脑（主控） ──────────────────────────┐
│  DSH 进程（Node host）        浏览器（Client，http://127.0.0.1:3080）  │
│  ├─ 插件 host 端：工具注册      ├─ 聊天界面（对话驱动调用）              │
│  │  · remote_agent / remote_dsh ├─ 设置 → 插件 → dsh-remote-agent 卡片 │
│  │  · 后台 Job（对接 DSH jobs） │  （client bundle，随 web 实例自动下发）│
│  │  · settings namespace       └──────────────┬───────────────────────┘
│  └──────────────┬────────────────── 内建 /api RPC（仅本机回环，远程浏览器只读）
└─────────────────┼────────────────────────────────────────────────────────┘
                  │ SSH（密钥/跳板机）或 HTTP（Bearer token）—— 唯一的跨机部分
   ┌──────────────▼──────────────────────────────┐
   │ 远程服务器（被控）                              │
   │  · dsh --profile headless '<prompt>'         │ ← 完整 DSH agent 会话
   │    （远端模型推理、远端工具、会话落盘 ~/.dsh/sessions）│
   │  · 或 HTTP 模式：npx dsh-remote-agent-server │
   └─────────────────────────────────────────────┘
```

- 本机不需要任何额外服务；插件 host/client 两半都随 DSH 自身运行。
- 两端都装 DSH + 本插件即为对称互控（P2P），无中心服务器。

## 功能

- 注册模型工具 `remote_agent`（任意 CLI agent：`claude -p`、`opencode run`、`dsh --profile headless` …）
- 注册模型工具 `remote_dsh`（远端也是 DSH 时使用；**真·远程会话**）
- **后台 Job 化**：`run_in_background: true` 立即返回 job id，用 DSH 原生 `job_output` 增量读输出、`job_kill` 取消
- **取消传播**：远程命令跑在 POSIX wrapper（`setsid` 进程组 + stdin watchdog + 任务标记）里，取消会通过二次 SSH 发 `SIGTERM→SIGKILL` 到远程进程组，不留孤儿进程
- **图形化端点管理页**：Web → 设置 → 插件 → dsh-remote-agent（schema 驱动表单，写入 `settings.yaml` 热生效，密钥字段脱敏）
- **端点预设**：`endpoint: "prod"` 一键解析 host/cwd/profile/密钥/权限上限
- **SSH 补全**：`port`、`identity_file`、`proxy_jump`、`connect_timeout`、`strict_host_key_checking`、`BatchMode`
- **会话连续**（DSH↔DSH）：自动发现远程 session id；`resume_session: "last"`/显式 id 取回上次日志尾部注入上下文续跑；`fetch_session: "tail"` 拉回日志供本地 `import_dsh`
- **结构化结果**：`exitReason`/`sessionId`/`signal`/`timedOut` 等字段，不用从 stdout 里猜
- **大输出落盘**：超过 `maxOutputBytes` 写本地 spill 文件并报告 `spillPath`
- **权限边界**：`permission_mode` 被端点 `maxPermissionMode` 封顶，越界直接拒绝；HTTP Bearer token
- **Windows 远程**：`remoteShell: cmd|powershell` 命令方言 + 零依赖 HTTP 服务端（临时 .cmd 执行 + `taskkill /T /F` 杀进程树）
- **HTTP 服务端参考实现**：`server/remote-agent-server.mjs`（也有 npm bin：`npx dsh-remote-agent-server`）

## 安装

**npm 安装（推荐）**

```powershell
dsh plugin --profile web add dsh-remote-agent   # 1. 注册依赖 + bundle
dsh plugin --profile web install                # 2. 从 npm 拉取安装
# 3. 重启 DSH：关掉正在跑的 dsh web，重新执行 dsh web
```

**从 GitHub 源码安装**（开发者 / 尝鲜未发布版本 / 想改源码调试）

```powershell
# 1. 克隆到 DSH 插件目录（与 profiles 平级；DSH 主目录默认是 C:\Users\<你>\.dsh）
git clone https://github.com/FUJU-DEV/dsh-remote-agent "$env:USERPROFILE\.dsh\plugins\dsh-remote-agent"

# 2. 注册进 web profile（file: 路径相对 profile 目录，上溯两级就是 plugins）
dsh plugin --profile web add "file:../../plugins/dsh-remote-agent"

# 3. 安装（把插件复制进 profiles\web\node_modules）
dsh plugin --profile web install

# 4. 重启 DSH 生效
```

```bash
# Linux / macOS 等价写法（路径同理）
git clone https://github.com/FUJU-DEV/dsh-remote-agent ~/.dsh/plugins/dsh-remote-agent
dsh plugin --profile web add "file:../../plugins/dsh-remote-agent"
dsh plugin --profile web install
```

> **源码安装必读**
> - `file:` 依赖会复制出**独立副本**：改完源码后要么重跑 `dsh plugin --profile web install`，要么手动把 `lib\`、`package.json`、`cordis.patch.yml`、`server\` 复制到 `profiles\web\node_modules\dsh-remote-agent\`；任何改动都要重启 DSH 才生效。
> - 锁定版本：克隆后 `git checkout <tag>`（如 `git checkout v0.2.0`）再执行第 2–4 步；更新源码在克隆目录 `git pull` 后重跑第 3 步。
> - 换其他 profile（tui 等）：把命令里的 `web` 换成对应 profile 名即可。
> - 纯客户端功能（设置卡片）随包内 `lib\client.js` 自动下发，无需额外安装。

## 快速上手

插件没有独立程序：它是聊天驱动的模型工具，工具调用显示为终端卡片，后台任务出现在 jobs 列表并带 kill 按钮。

```text
# 一次性调用（前台，等结果）
"用 remote_agent，host=user@server，把 /var/log/nginx 里的 5xx 错误汇总给我"
"在 prod 上跑：检查磁盘占用"              # 配置了 endpoints 后
# 长任务（后台，立刻返回 job id）
"在 gpu-box 上后台跑训练脚本，跑完告诉我"  # run_in_background: true
job_output(job_id: "remote-3")           # 增量读输出，可多次
job_kill(job_id: "remote-3")             # 终止（传播到远程进程组）
# 续跑上一个远程会话（DSH↔DSH）
remote_dsh(endpoint: "prod", resume_session: "last", prompt: "继续修复")
```

**连接前提（远程机）**

1. 装好 DSH，确认 `dsh --profile headless "测试"` 能跑通（**最常见坑**：远端没配模型凭证）
2. SSH：开 sshd + 免密（`ssh-keygen` → 公钥追加到远端 `~/.ssh/authorized_keys`）；Windows 管理员账户注意 `administrators_authorized_keys` 及其 ACL
3. 需要 `fetch_session` 时远端装 `zstd`
4. 本机插件配置里加 `endpoints`（或用设置页），重启 DSH，然后聊天调用

HTTP 模式（不想开 SSH / 跨平台最省事）：远端 `npx dsh-remote-agent-server --port 8765 --token <口令>`，本机配 `transport: http` + `httpUrl` + `httpToken`。

## 图形化端点管理页

重启 DSH 后打开 **Web 界面 → 设置 → 插件 → dsh-remote-agent**：

- **端点预设**：添加/编辑/删除命名端点（host、传输、cwd、profile、远程 shell、SSH 端口/私钥/跳板机/超时、HTTP 地址与 token、权限上限、超时、输出上限）
- **全局默认**：默认传输、defaultHost、remoteShell、httpUrl/httpToken、超时、输出上限、默认权限与权限上限
- 保存即写入 `$DSH_HOME/settings.yaml` **热生效**，无需重启；`httpToken` 按密钥处理（RPC 全程脱敏）
- `cordis.patch.yml` 定义的端点带"YAML 定义"标记：界面可覆盖、不可删除（删除需改 YAML）

## 配置参考（cordis.patch.yml）

```yaml
- id: remote-agent
  name: dsh-remote-agent
  config:
    transport: ssh                    # ssh | http
    sshCommand: ssh
    remoteShell: auto                 # auto(=posix) | posix | cmd | powershell（Windows 远程用 cmd）
    ssh:
      connectTimeout: 10              # 秒
      strictHostKeyChecking: accept-new   # yes | no | accept-new
      batchMode: true                 # 免密/agent 环境建议 true
      # port: 2222
      # identityFile: /home/me/.ssh/deploy_key
      # proxyJump: jump@bastion
    timeoutSeconds: 600               # 前台超时；后台 Job 无超时
    maxOutputBytes: 2097152           # 超过则落盘 spill 文件
    maxSpillBytes: 67108864
    spillDir: ""                      # 空 = <tmp>/dsh-remote-agent
    enableRunInBackground: true
    sshWrapper: true                  # POSIX 进程组 wrapper；远程是 Windows 时无效（自动跳过）
    discoverSessions: true            # remote_dsh 自动发现远程 session id
    rememberSessions: true            # 记住每端点最近 session（resume_session: "last"）
    sessionsRoot: ""                  # 远程 sessions 目录，空 = ${DSH_HOME:-$HOME/.dsh}/sessions
    fetchTailBytes: 524288
    resumeContextBytes: 262144
    defaultPermissionMode: workspace-write
    maxPermissionMode: danger-full-access   # 全局上限；端点可单独收紧
    # httpUrl: http://server:8765/run
    # httpToken: "change-me"
    endpoints:
      prod:
        host: deploy@10.0.0.5
        cwd: /srv/app
        profile: headless
        ssh: { port: 2222, identityFile: /home/me/.ssh/deploy_key }
        maxPermissionMode: workspace-write   # prod 不允许 danger-full-access
      gpu-box:
        host: root@192.168.1.20
        cwd: /data/work
        timeoutSeconds: 1800
```

端点字段全集：`transport / host / cwd / profile / agentCommand / dshCommand / httpUrl / httpToken(secret) / ssh{port, identityFile, proxyJump, connectTimeout, strictHostKeyChecking, batchMode} / remoteShell / maxPermissionMode / timeoutSeconds / maxOutputBytes / sessionsRoot`。层级覆盖顺序：**调用参数 > 端点 > 全局配置**。

## 工具参数参考

**remote_agent**（任意远端 CLI agent）

| 参数 | 说明 |
| --- | --- |
| `prompt`* | 完整自包含任务 |
| `endpoint` | 命名端点（配置了就用它，别传散参数） |
| `host` / `cwd` / `agent_command` | SSH 目标 / 远端工作目录 / agent CLI（默认 `dsh --profile headless`） |
| `transport` | `ssh` \| `http` 覆盖 |
| `port` / `identity_file` / `proxy_jump` / `connect_timeout` / `strict_host_key_checking` | SSH 选项 |
| `run_in_background` | true = 后台 Job（job_output / job_kill） |
| `timeout_seconds` / `max_output_bytes` | 超时 / 输出上限 |

**remote_dsh**（远端 DSH）＝ 上表全部，另有：

| 参数 | 说明 |
| --- | --- |
| `profile` | 远端 DSH profile（默认 headless） |
| `permission_mode` | `read-only` \| `workspace-write` \| `danger-full-access`，被端点 maxPermissionMode 封顶 |
| `env` | 远端环境变量对象 |
| `patch` | 远端 `--patch` 覆盖文件路径 |
| `resume_session` | 会话 id 或 `"last"`（取回上次日志尾部注入上下文；当前 DSH headless 无服务端 --resume） |
| `fetch_session` | `none` \| `tail` \| `full`：把本次会话日志拉回（可 `import_dsh` 本地续接） |

**结果字段**（前台）：`kind / ok / transport / endpoint / command / exitCode / signal / timedOut / aborted / timeoutMs / exitReason(completed|nonzero-exit|signal|timeout|aborted|transport-error) / sessionId / fetchedSession / stdout{text,truncated,spillPath} / stderr{…}`。后台：`kind:"background" / jobId`。非零退出是"报告"不是"抛错"；只有传输/基础设施错误抛错。

## Windows ↔ Windows

| 能力 | posix（Linux/macOS/WSL） | cmd / powershell（Windows 远程） |
| --- | --- | --- |
| 前台 / 后台 Job | ✅ | ✅ |
| 取消传播到远程进程树 | ✅ setsid 进程组 + watchdog | ⚠️ 只杀本地 ssh 客户端（Win32-OpenSSH 断开时终止会话，尽力而为） |
| 会话发现 / resume / fetch | ✅ | ❌ 需要 POSIX 工具链（清晰报错提示） |
| 权限边界、spill、端点预设、结构化结果 | ✅ | ✅ |

推荐顺序：**HTTP 模式**（远端 `npx dsh-remote-agent-server --token ...`，服务端已适配 Windows）→ **SSH + `remoteShell: cmd`**（`cd /d` + `set "VAR=x"&&` 方言）→ **SSH + WSL**（远端 sshd 默认 shell 设为 WSL bash，获得完整功能）。

## HTTP 模式

```bash
# 远端（Windows 用 cmd/powershell 同理；Linux 需要 bash）
npx dsh-remote-agent-server --port 8765 --token change-me
```

本机配置：`httpUrl: http://server:8765/run`、`httpToken: change-me`、`transport: http`。契约（POST JSON）：

```jsonc
// 请求（remote_dsh 额外带 profile/permission_mode/env/fetch_session 等）
{ "prompt": "...", "cwd": "/srv/app", "agent_command": "dsh --profile headless", "timeout_ms": 600000 }
// 响应
{ "run_id": "…", "stdout": "…", "stderr": "…", "exit_code": 0, "timed_out": false,
  "signal": null, "session_id": "session-…", "session_log": "…?" }
// 取消：客户端中止请求（服务端检测到断开即杀进程树）；也支持
{ "cancel": true, "run_id": "…" }
```

服务端 flag：`--port`、`--token`（DSH_REMOTE_TOKEN 亦可）、`--max-output`、`--sessions-root`、`--dsh-command`。

## 测试

本仓库的验证分两个进程，均已跑通并留档。

### 测试进程一：自动化测试套件（无需远程机）

| 文件 | 覆盖 | 前提 |
| --- | --- | --- |
| `test/smoke.mjs`（47 项） | SSH 参数/命令构建（posix+cmd+powershell 方言）、wrapper/kill/fetch 脚本生成、marker 解析、spill 落盘、端点合并、**HTTP 契约真实往返**（含取消） | 只需 node 22 + `npm install` |
| `test/client-bundle-smoke.mjs`（13 项） | 浏览器 client bundle 在 node 内模拟执行：ModuleLoader 注册、slot 注册 key、设置卡片真实渲染（端点行/徽标/按钮/全局表单/保存钮） | 同上 |
| `test/wrapper-e2e.mjs`（13 项） | wrapper 脚本在**真实 POSIX sh（busybox ash）**里执行：进程组 kill→exit 143 无幸存、stdin EOF watchdog→kill、正常完成+会话发现 | WSL（或任意 sh/setsid） |
| `test/settings-ui-e2e.mjs`（17 项） | 起**第二个真实 web 实例**（端口 3099）：client bundle 下发、namespace 出现在 settings.describe、mutate→settings.yaml→**热生效**、revision 推进、非法值拒绝、密钥脱敏 | `dsh` 在 PATH；会短暂占用 3099 |

```powershell
npm install                 # 自动装上 peerDependencies
node --check lib/index.js && node --check lib/client.js && node --check server/remote-agent-server.mjs
node test/smoke.mjs lib/index.js
node test/client-bundle-smoke.mjs lib/client.js
node test/wrapper-e2e.mjs        # 需要 WSL
node test/settings-ui-e2e.mjs    # 会起第二个 web 实例并自清理
```

> GitHub Actions（`.github/workflows/test.yml`）跑前两项 + 语法检查；WSL/真实实例类在本机手动跑。

### 测试进程二：真实环境端到端验证（本机沙盒 → 真实远程会话）

这是"真·远程会话"的完整实证流程（本文档作者在本机跑通全绿；你可在自己的机器上复现）。沙盒远端选 **WSL Ubuntu**（⚠️ **不要用 docker-desktop 发行版**，其根分区仅 136 MB）：

```bash
# ① Ubuntu 里装环境（Node 22 + DSH + sshd + zstd）
wsl -d Ubuntu-22.04 -u root -e bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
npm i -g @deepseek-ai/dsh --no-audit --no-fund
apt-get install -y openssh-server zstd
# ② 密钥登录（本机 Windows 侧生成，公钥写进 Ubuntu）
ssh-keygen -t ed25519 -N "" -f "$env:TEMP\dsr-ssh-test\id_ed25519"   # PowerShell：-N ''（空口令）
#   把 id_ed25519.pub 追加到 Ubuntu /root/.ssh/authorized_keys（chmod 600）
#   改 /etc/ssh/sshd_config：PermitRootLogin yes、PasswordAuthentication no
/usr/sbin/sshd -p 2222     # 启动
# ③ 复制 DSH 凭证（模型 API key；不要打印内容）
#   本机 ~/.dsh/.credentials.yaml → Ubuntu /root/.dsh/.credentials.yaml（chmod 600）
# ④ 远端自检（会消耗一点 API token）
cd /tmp && dsh --profile headless "用一句话回答：远端 DSH 已就绪。"   # → 正常回答且 exit 0
```

然后跑真链路（插件生产代码 → ssh → 远端真 DSH 会话）：

```powershell
node test/real-ssh-e2e.mjs       # 11 项：真 sshd 传输 + 取消杀树 + 会话发现/拉取机制
node test/remote-dsh-real.mjs    #  8 项：真远程 DSH 会话（远端模型推理）→ 会话发现与落盘一致
                                 #       → fetch 真日志 → 注入上下文续跑（暗号从注入日志中找回）
```

`remote-dsh-real.mjs` 是最终验收：暗号「黄瓜999」只存在于第一次会话的日志里，续跑的新会话 prompt 不含暗号，远端模型只能从注入的日志尾部找回它——这是"远程会话连续性"的直接证明。

**真实机器的十项验收清单**（每项打勾才算通过）：

1. remote_dsh 小任务 → 返回答案 + `session id: session-…`
2. `run_in_background` → job id；`job_output` 增量可读
3. `job_kill` 后**登远端 `ps` 确认无残留进程**（最硬标准）
4. `resume_session: "last"` → 新会话引用旧上下文
5. `fetch_session: "tail"` → 本地 `import_dsh` 成功续聊
6. `permission_mode` 越界被明确拒绝
7. >2 MB 输出 → `spillPath` 且文件真实存在
8. Windows 远端：HTTP 模式跑通 + 取消后无残留
9. 设置页改 host → 不重启立即生效
10. 设置页：YAML 端点徽标 / token 脱敏 / 远端浏览器只读

**拆除沙盒**（用完不留痕迹）：`wsl -d Ubuntu-22.04 -u root -e bash -c 'pkill sshd'`、删除 `%TEMP%\dsr-ssh-test` 密钥、`ssh-keygen -R "[localhost]:2222"`；docker-desktop 发行版自始至终不要动。

## 说明与限制

- SSH 需免密（或 ssh-agent / `identityFile`）。`batchMode: true` 时密码登录快速失败而非挂起。
- `sshWrapper` 依赖远程 POSIX shell + `setsid`（缺失时退化为杀单进程）；Windows 远程走 `remoteShell: cmd|powershell` 或 HTTP 模式。
- 当前 DSH 版本 headless 无服务端 `--resume`，"续跑"= 上一会话日志尾部注入新会话上下文；上游支持后只需在 `buildDshRemoteCommand` 加回 `--resume`。
- 会话发现 = 运行前后 sessions 目录列表 diff（不依赖 mtime 精度）；同主机并发多跑时新会话可能被任一运行发现（已知竞态）。
- 远端缺 `zstd` 时 fetch 会报清晰错误，绝不把压缩二进制喂给模型。
- 设置页 RPC 仅本机回环；从其他电脑经局域网访问 UI 时设置卡片自动只读。

## 发布清单（npm + GitHub）

```powershell
npm login                                   # ① npm 账号
npm view dsh-remote-agent version           # ② 查重名；被占则改名或改 scope
# ③ 改 package.json：name / version / repository / homepage
git init && git add . && git commit -m "…"  # ④ 建 GitHub 仓库（.gitignore 已备好）
git remote add origin https://github.com/<you>/dsh-remote-agent
git push -u origin main
npm pack --dry-run                          # ⑤ 发布前检查包内容（应含 lib/ server/ cordis.patch.yml）
npm publish --access public                 # ⑥ 发布
# ⑦ 用户侧安装 = 三条命令（见"安装"）；远端被控 = npx dsh-remote-agent-server 或装 DSH
```

版本策略：peerDependencies 锁定 DSH `^0.1.1-rc.2`；DSH 大版本升级时随发新版本。

## 开发

```powershell
node --check lib/index.js && node --check lib/client.js && node --check server/remote-agent-server.mjs
node test/smoke.mjs lib/index.js
node test/client-bundle-smoke.mjs lib/client.js
dsh --profile web --dump-config     # 整树加载校验（编译插件 + Config 与 patch）
```

目录：`lib/index.js`（host：工具 + 传输 + settings namespace）、`lib/client.js`（浏览器设置卡片，手写 ModuleLoader 格式零构建）、`server/remote-agent-server.mjs`（HTTP 参考实现）、`cordis.patch.yml`（挂载行与默认配置）、`test/`（六个测试文件，见"测试"）。
