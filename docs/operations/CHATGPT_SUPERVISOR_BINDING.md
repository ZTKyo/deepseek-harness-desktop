# CHATGPT_SUPERVISOR_BINDING.md

P2.75 TX-B —— ChatGPT Client Binding R1 交付报告。
**状态：READY_FOR_CHATGPT_HUMAN_GATE**（adapter 侧事务已完成并验证；OpenAI 官方连接机制
已核验（§7）＝Secure MCP Tunnel 首选；下一步是用户手动创建 Platform tunnel +
ChatGPT 开发者模式 App，之后按 §6 执行真实 E2E）。

本文不含任何 secret（token 以 `<...>` 占位）。

## 1. 架构

```
ChatGPT (Custom Connector, MCP client)
   │  HTTPS  (公网入口方案见 §5，仅在用户操作时段临时存在)
   ▼
supervisor-mcp-adapter  (独立进程, 127.0.0.1:8091, MCP 2025-06-18 Streamable HTTP)
   │  HTTP + Bearer BRIDGE_TOKEN (仅回环)
   ▼
supervisor-bridge v0.2.2  (127.0.0.1:3080 /supervisor/*)
   ▼
supervisor-bridge-core.mjs  (唯一校验权威 + 幂等权威)
```

- **纯适配层**：adapter 不做第二套校验、不缓存 mutation 状态；未传字段保持 undefined
  交由 bridge 取默认（如 cancel 缺省 pause）。
- **端口纪律**：8091 仅本回合新启用（启动前已确认占用为空）；3080（dsh web）与
  8090（既有 supervisor 手桥）不复用、不重启、不改代码。
- **kill-switch**：adapter 是独立 node 进程，一键关闭（不触碰 3080）：
  `powershell -ExecutionPolicy Bypass -File supervisor-mcp-adapter\stop-adapter.ps1`
  （幂等：8091 无监听时直接退出；仅按 8091 端口定位进程，绝不误伤 3080/8090）。

## 2. 工具面（9 = 5 READ + 4 MUTATION，与 bridge 1:1）

| MCP 工具 | bridge | 只读 | replay-safety（adapter 原样保留） |
|---|---|---|---|
| `supervisor_health` | GET /supervisor/health | ✅ hint | — |
| `supervisor_get_state` | POST /supervisor/get_state | ✅ hint | — |
| `supervisor_get_goal` | POST /supervisor/get_goal | ✅ hint | `session_id` |
| `supervisor_get_evidence` | POST /supervisor/get_evidence | ✅ hint | `session_id`, `max_messages` |
| `supervisor_get_snapshot` | POST /supervisor/get_snapshot | ✅ hint | `session_id` |
| `supervisor_dispatch_goal` | POST /supervisor/dispatch_goal | ⬜ | `idempotency_key`, `objective`, `acceptance_criteria[]`, `max_goal_rounds`, `session_label` |
| `supervisor_send_correction` | POST /supervisor/send_correction | ⬜ | `command_id`, `session_id`, `generation`, `text`, `mode` |
| `supervisor_cancel_goal` | POST /supervisor/cancel_goal | ⬜ | `session_id`, `command_id`, `action`, `reason` |
| `supervisor_review_goal` | POST /supervisor/review_goal | ⬜ | `session_id`, `command_id`, `verdict`, `notes` |

5 个 READ 在 tools/list 带 `readOnlyHint: true`；4 个 MUTATION 无 hint（authority 描述写明
幂等键必需性）。MCP 参数命名沿用 bridge 的 snake_case 对外投影（`idempotency_key` 等），
由 adapter 映射为 bridge 内部 camelCase。

## 3. 已验证证据（本回合实测）

| 验证 | 结果 |
|---|---|
| `node server-test.mjs`（mock bridge 进程内自测） | **37 PASS / 0 FAIL**：initialize→2025-06-18、notifications/initialized→202、tools/list=9、readOnlyHint=5、schema 全 object、5 READ + 4 MUTATION 全链路字段映射、unknown tool→-32602+可用清单、bridge 停机→isError+bridge_unreachable、GET /mcp→405、healthz、resources/list 空、无鉴权 401、错误 bearer 401、正确 bearer 200、双 token 分离（入口自动生成+独立文件、上游只认 BRIDGE_TOKEN、子进程 sep 验证） |
| 真实 bridge v0.2.2 只读冒烟 | healthz `bridge:"ok"`；tools/list=9；`supervisor_get_state` 返回真实 sessions；`supervisor_get_snapshot` 正常；幽灵 session → `isError:true, error:invalid_session_id`（bridge 404 原样映射，无副作用） |
| 端口纪律 | 8091 启动前空闲实测；冒烟后进程已清理、8091 已释放 |
| sealed code 未触碰 | diff 仅新增 `supervisor-mcp-adapter/`；3080/8090/Guardian/router/core 零改动 |

## 4. 错误映射

bridge `ok:false` / HTTP≥400 → MCP `tools/call` 结果 `isError:true`，结构化错误体原样透传
（如 `invalid_session_id`、`idempotency_conflict(409)`、bridge 自身 503 文案）。bridge 进程
不可达 → `bridge_unreachable`。JSON-RPC 层错误仅用于协议级问题（unknown tool → -32602）。

## 5. 认证与网络边界

- **双 token 分离**：ChatGPT→adapter 入口 token（`MCP_TOKEN`/`MCP_TOKEN_FILE`）与
  adapter→bridge 上游 token（`BRIDGE_TOKEN`/`BRIDGE_TOKEN_FILE`）互不复用。入口默认
  `~/.dsh/supervisor-mcp/token`（缺失自动生成 64-hex 并写盘，0600）；上游默认
  `~/.dsh/supervisor-bridge/token`（复用 bridge 既有凭据）。两者文件分离，env 覆盖各自
  独立生效。
- 入口鉴权常量时间比较，缺失/错误 → 401；`MCP_REQUIRE_AUTH=0` 仅供本机测试。
- **3080 不暴露公网**：所有公网可达性集中在 adapter 一侧（且默认仅回环）；远程入口方案
  与生命周期见 §5.1。

### 5.1 公网入口（ChatGPT 必需，短暂启用）

**官方首选方案（2026-08-29 核验，见 §7）：OpenAI Secure MCP Tunnel + tunnel-client。**

ChatGPT 开发者模式 App 连接私有 MCP 服务器有两个官方路径（developers.openai.com
`/api/docs/guides/secure-mcp-tunnels`）：

1. **Secure MCP Tunnel（推荐，本机唯一可行）**：本机跑 `tunnel-client`（openai/tunnel-client，
   outbound HTTPS 长轮询 `api.openai.com:443 /v1/tunnel/*`），由 **OpenAI 托管隧道端点**承接
   ChatGPT 的 MCP 请求，再转发回本机私有 MCP 服务器。**不需要公网入口、不开放入站端口、
   MCP 服务器地址永不公开** —— 完美适配本机 CGNAT 双 NAT 无 IPv6 拓扑（路由器无公网 IP，
   任何端口映射/公网 VPS 转发都绕不开）。
2. 公网 HTTPS MCP 端点（public plugin 提交路径）：要求稳定公网可达端点 —— 本机不具备，
   排除。

**前提（E2E 前必须备齐，见 §7.2）**：
- Platform 组织 tunnel 权限（Tunnels Read + Manage 建隧道 / Read + Use 运行 tunnel-client）；
- 目标 ChatGPT workspace 的 **developer mode 权限**（Enterprise/Edu 需 workspace admin 授予，
  用户再在 **Settings → Security and login** 开启；个人账号路径见官方 developer-mode 文章
  [12584461](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta)）；
- tunnel 需同时关联「所属 Platform 组织 + 目标 ChatGPT workspace」（只关联组织不会出现在
  ChatGPT 列表，见 §7.4）；
- tunnel-client 长驻运行时保持存活（app discovery 与 MCP 调用都依赖它）；绑定用
  `runtimes connect`，日常起停与鉴权配置用 canonical profile + `run --profile`（connect 会
  重写 profile，鉴权不能依赖 connect 传参/env）；`runtimes status <alias> --json` 可自检
  （run 模式下 runtime_state=stopped 属托管元数据缺失，以 healthz/readyz/daemon log 为准）。

**执行顺序（用户在场时一次性完成）**：
1. 用户打开 https://platform.openai.com/settings/organization/tunnels 创建 tunnel，
   拿到 `tunnel_id` + runtime API key；
2. 本机 `tunnel-client runtimes connect --alias <name> --tunnel-id <id>
   --runtime-api-key "file:<runtime-key 文件，0600 不入仓库>"
   --mcp-server-url http://127.0.0.1:8091/mcp`（adapter 为 Streamable HTTP 服务器，
   必须用 `--mcp-server-url`，非 stdio）；随后把 MCP 鉴权写进 canonical profile 并用
   `run --profile` 起长驻（Authorization 经 `mcp.extra_headers` 的 file:/ 引用承载，
   token 不落 config 明文，见 §7.5 与 RUNBOOK「tunnel-client 连本地 MCP」）；
3. 用户打开 https://chatgpt.com/plugins → 创建开发者模式 App → Connection 选 **Tunnel** →
   选择/粘贴 tunnel_id；
4. 执行 §6 E2E 1–5；完毕关 `tunnel-client` 即可（tunnel 是 OpenAI 托管资源，随时可复用，
   无持续暴露）。

备选（不推荐，仅在用户无 Platform 组织/无 Tunnel 权限时）：
- 临时公网隧道（cloudflared quick tunnel 等）包一层 HTTPS 转发到 8091 —— 仅 E2E 时段拉起、
  结束即关、不开放路由器端口映射；但 ChatGPT 侧无法走官方 Tunnel 连接选项时需用
  public HTTPS MCP endpoint 路径（§7 明确仅支持公网可达端点，且无官方隧道时每次都要重拉
  cloudflared URL 并在 App 里改，体验差、安全面更大）。

## 6. ChatGPT-originated E2E 计划（App 创建后逐项执行，任一 FAIL → P3 不启动）

| # | 场景 | 通过判据 |
|---|---|---|
| 1 | READ：ChatGPT 内调用 `supervisor_get_state` / `supervisor_get_goal` | 返回真实数据，与 3080 直查一致 |
| 2 | 控制性 dispatch：ChatGPT 发 `supervisor_dispatch_goal`（一次性目标+简单验收） | bridge 收到同形 payload，session 创建，幂等键生效 |
| 3 | 幂等重放 + 409：同 `idempotency_key` 重发；再换 key 撞 `command_id` | 第一次返回原结果，冲突场景 `isError` + 409 原文 |
| 4 | `supervisor_review_goal` → VERIFIED | 状态投影 VERIFIED，回执落库 |
| 5 | 新会话 rebind：ChatGPT 新对话重新扫描工具 | 9/9 工具可发现，READ 正常 |

## 7. OpenAI 官方机制核验（2026-08-29 已核实，来源=developers.openai.com 官方文档）

**结论先行：ChatGPT（开发者模式）→ 私有 MCP 的官方一等公民路径 = Secure MCP Tunnel。
本机 CGNAT/无公网 IP 环境完全可用；无需 cloudflared/端口映射/VPS 转发。**

### 7.1 官方文档

- Secure MCP Tunnel 指南：https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
  （Markdown：同 URL 追加 `.md`）
- 通用 MCP 概念：https://developers.openai.com/api/docs/guides/tools-connectors-mcp
- tunnel-client 发布：https://github.com/openai/tunnel-client/releases/latest
- 开发者模式 Help Center：https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta
  （"Developer mode apps and full MCP connectors in ChatGPT (beta)"；help.openai.com 有
  Cloudflare 挑战，浏览器带真实 UA 可读）
- RBAC：https://developers.openai.com/api/docs/guides/rbac

### 7.2 机制（官方原文要点）

- `tunnel-client` 在**能触达私有 MCP 服务器的网络内部**运行：出站 HTTPS 长轮询
  `api.openai.com:443 /v1/tunnel/*`（配了 control-plane mTLS 时走
  `mtls.api.openai.com:443`），把 OpenAI 侧排队的 MCP JSON-RPC 请求转发到本机 MCP 服务器，
  响应经同一隧道回传。**MCP 服务器不需要公网监听器**；支持流式 SSE 转发。
- 前提三件套：`tunnel_id`（Platform tunnel settings）+ runtime API key（给 tunnel-client）+
  本机可经 stdio 或 HTTP 触达的 MCP 服务器。
- 权限分离：创建/编辑隧道 = Tunnels **Read+Manage**；运行 tunnel-client / 创建 App 时选隧道 =
  Tunnels **Read+Use**（组织级，非项目级，最多 30 分钟传播）；**ChatGPT developer mode 是
  独立的 workspace 权限**（Enterprise/Edu 由 workspace admin 授予，用户再在
  Settings → Security and login 开启）。
- 隧道可关联多个 Platform 组织 / ChatGPT workspace：**必须把目标 ChatGPT workspace 也加进
  关联**，否则隧道不出现在 ChatGPT 列表（Troubleshooting 明确列出此坑）。
- `tunnel-client` 暴露 `/healthz`、`/readyz`、`/metrics` 与 loopback-only 管理 UI `/ui`；
  `tunnel-client runtimes status <alias> --json` 自检（暴露 process_running/healthy/ready）。
  不健康/未连接时隧道请求失败。
- 企业能力：出站代理、自定义 CA 包、control-plane 客户端证书、MCP 侧 mTLS。
- 日志边界：隧道传输不在 ChatGPT Compliance Platform app events 内；隧道元数据变更走
  Platform Audit logs（`tunnel.created/updated/deleted`）；App 级合规日志（invocation、
  `APP_AUTH_LOG`）照常。
- OAuth：OAuth discovery 可走隧道；授权服务器本身不自动隧道化，若授权服务器公网与
  tunnel-client 宿主机都不可达，OAuth 流程仍会失败。
- Advanced：allowlisted HTTP callouts（内嵌 Harpoon MCP server，按 label 暴露受限 HTTP 目标，
  非通用代理）。

### 7.3 对本项目的影响（官方路径 vs 原占位方案）

| 维度 | Secure MCP Tunnel（官方首选） | cloudflared quick tunnel（原备选） |
|---|---|---|
| 公网入口 | 无（outbound-only） | 有（公开 URL） |
| MCP 地址隐私 | 保持私有 | 公网可探测 |
| CGNAT 适配 | ✅ 完全适配（纯出站） | ✅ 可用但每次 URL 变化 |
| ChatGPT 连接方式 | 官方 Tunnel 选项，App 内选择/粘贴 tunnel_id | 普通 HTTPS endpoint 手动填 URL |
| 安全面 | 最小（OpenAI 托管端点 + 双向鉴权） | 较大（公网可触达 8091 侧） |
| 持续成本 | 无（隧道复用，仅运行时占进程） | 每次 E2E 重拉 |

**决策：E2E 首选 Secure MCP Tunnel；cloudflared 仅当用户无 Platform tunnel 权限时兜底。**

### 7.4 用户操作清单（E2E 前需要用户做，全部非技术）

1. 打开 https://platform.openai.com/settings/organization/tunnels（若报 "Tunnels access
   required" 找组织 owner/RBAC admin 授权 Read+Manage；本机账号 = 个人 Platform 组织）。
2. 创建 tunnel → 记下 `tunnel_id`，下载/获取 runtime API key（经安全面板入
   `~/.dsh/.credentials.yaml`，不落文档）。
3. 把目标 ChatGPT workspace 加入 tunnel 关联（若个人账号与 ChatGPT 同账号，确认已关联）。
4. 确认账号有 ChatGPT developer mode：Enterprise/Edu 找 workspace admin 开权限 → 自己在
   **Settings → Security and login** 开启；个人账号按官方文章确认可用性。
5. 在 https://chatgpt.com/plugins 创建开发者模式 App：Connection 选 **Tunnel** → 选择隧道。
6. 通知本机运行 `tunnel-client runtimes connect`（本回合已完成命令模板，届时 1 条命令拉起）。

### 7.5 本机落地模板（无 secret）

```bash
# 1) tunnel-client 二进制（release 最新版或 Platform settings 下载；本机已解压于
#    DSH-Client\_tools\tunnel-client\extracted\tunnel-client.exe）
# 2) 先拉起 adapter（独立进程，8091；kill-switch=stop-adapter.ps1，见 §1）
node supervisor-mcp-adapter/server.mjs
# 3) attach 既有 tunnel（一次性绑定；connect 会重写 profile，MCP 鉴权不在此步配置）
tunnel-client runtimes connect \
  --alias p275-supervisor \
  --tunnel-id "<tunnel_id>" \
  --runtime-api-key "file:<runtime-key 文件，0600 不入仓库>" \
  --mcp-server-url "http://127.0.0.1:8091/mcp"
# 3b) canonical 鉴权（token 经 file:/ 引用承载，不落 config 明文；本机已配置生效）：
#     profile YAML（%APPDATA%\tunnel-client\p275-supervisor.yaml）中
#       control_plane.api_key: "file:<runtime-key 文件>"
#       mcp.extra_headers: { Authorization: "file:<bearer-header 文件，内容=Bearer <token>>" }
#     长驻运行（run 只读 profile，不会被 connect 重写覆盖）：
tunnel-client run --profile p275-supervisor
# 4) 验证运行时健康（--json 暴露 process_running/healthy/ready 三字段；run 模式下
#    runtime_state=stopped 属托管元数据缺失，以 healthz/readyz 为准——readyz 文本含
#    "requires auth" 说明 Authorization 没传进去）
tunnel-client runtimes status p275-supervisor --json
# 5) 停止：tunnel-client runtimes stop p275-supervisor（隧道资源在 OpenAI 侧，随时复用）
# 6) 关闭 adapter：powershell -ExecutionPolicy Bypass -File supervisor-mcp-adapter\stop-adapter.ps1
```

> 注：tunnel-client 当前以二进制分发（release 页 + Platform settings 下载）；若未来提供
> npm 包则以官方指引为准。

## 8. P3 硬门禁（本报告即门禁声明）

- 当前仅允许：**READY_FOR_CHATGPT_HUMAN_GATE**（用户手动建 App → §6 E2E）。
- E2E 全过前**禁止**启动 P3 实现；P3 首个 Goal 必须由真实 ChatGPT 经
  `supervisor_dispatch_goal` 下发；P3 Goal template 已备不执行。
