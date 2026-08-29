# supervisor-mcp-adapter

P2.75 TX-B —— **ChatGPT Client Binding**：把 DSH supervisor-bridge（控制平面）以 1:1 语义
暴露为 MCP（Model Context Protocol）server，供 ChatGPT（Custom MCP App / custom connector）
扫描与调用 9 个 supervisor 工具。

```
ChatGPT ──MCP(Streamable HTTP)──► supervisor-mcp-adapter :8091 ──HTTP+Bearer──► supervisor-bridge (v0.2.2 @ 127.0.0.1:3080)
                                        │ 纯适配层：不做第二套校验、不缓存 mutation 状态
                                        ▼
                              supervisor-bridge-core（唯一校验权威 + 幂等权威）
```

设计铁律：

- **纯适配层**：入参校验与幂等权威 100% 在 `plugins/supervisor-bridge-core.mjs`；
  adapter 只做 JSON 形状映射（snake_case → bridge camelCase）与错误透传（bridge 4xx/5xx
  → MCP `isError: true` + 结构化错误体）。
- **stateless**：不缓存任何 mutation 状态；重放安全完全依赖 bridge 侧
  `idempotency_key` / `command_id` 幂等（R1/R1.1/R1.2 已封板）。
- **双 token 分离**：入口鉴权（ChatGPT → adapter）与上游鉴权（adapter → bridge）是
  两个独立凭据，互不复用。
- **不落盘、不打印 token**：日志只含方法/工具名与状态。

## 快速开始

```powershell
# 1) 入口 token（ChatGPT → adapter）：任选其一
#    a. 显式：$env:MCP_TOKEN = "<≥32字符随机串>"
#    b. 文件：默认 ~/.dsh/supervisor-mcp/token（独立于 bridge token；缺失自动生成 64-hex 并写盘）
#    上游 token（adapter → bridge）默认 ~/.dsh/supervisor-bridge/token，与入口分离
# 2) 启动
$env:PORT = "8091"; $env:HOST = "127.0.0.1"
$env:BRIDGE_BASE = "http://127.0.0.1:3080"
node supervisor-mcp-adapter\server.mjs
# 3) 自检
Invoke-RestMethod http://127.0.0.1:8091/healthz
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8091` / `127.0.0.1` | 监听地址（默认仅回环） |
| `BRIDGE_BASE` | `http://127.0.0.1:3080` | supervisor-bridge 地址 |
| `BRIDGE_TOKEN` / `BRIDGE_TOKEN_FILE` | `~/.dsh/supervisor-bridge/token` | adapter→bridge 上游鉴权 |
| `MCP_TOKEN` / `MCP_TOKEN_FILE` | `~/.dsh/supervisor-mcp/token`（缺失自动生成 64-hex） | ChatGPT→adapter 入口鉴权（与上游分离，不复用 bridge token） |
| `MCP_REQUIRE_AUTH` | `1` | `0` 关闭入口鉴权（仅限本机测试） |

## 工具（9，与 bridge 端点 1:1）

| 工具 | bridge | 只读 | 说明 |
|---|---|---|---|
| `supervisor_health` | `GET /supervisor/health` | ✅ | 控制平面活性 + 版本指纹 |
| `supervisor_get_state` | `POST /supervisor/get_state` | ✅ | 全部 harness sessions 概览 |
| `supervisor_get_goal` | `POST /supervisor/get_goal` | ✅ | 单 session 目标投影 + generation |
| `supervisor_get_evidence` | `POST /supervisor/get_evidence` | ✅ | 近期历史 + 审查证据束 |
| `supervisor_get_snapshot` | `POST /supervisor/get_snapshot` | ✅ | 元数据快照（无原始文本） |
| `supervisor_dispatch_goal` | `POST /supervisor/dispatch_goal` | ⬜ 幂等 | 创建受监督目标（idempotency_key） |
| `supervisor_send_correction` | `POST /supervisor/send_correction` | ⬜ 幂等 | 纠偏（command_id + generation） |
| `supervisor_cancel_goal` | `POST /supervisor/cancel_goal` | ⬜ 幂等/破坏性 | pause/complete/clear |
| `supervisor_review_goal` | `POST /supervisor/review_goal` | ⬜ 幂等 | PASS/FAIL 终审 |

参数在 MCP 侧用 snake_case（`idempotency_key` / `command_id` / `session_id` /
`max_messages`…），adapter 负责映射为 bridge 的 camelCase；未传字段保持 undefined
（由 bridge 应用默认值），adapter 不注入默认。

## 安全模型

- **入口**：`Authorization: Bearer <MCP_TOKEN>`，timingSafeEqual 常量时间比较；
  失败 401 + `WWW-Authenticate`。`MCP_REQUIRE_AUTH=0` 才允许无鉴权（默认强制开）。
- **上游**：所有 bridge 调用带 `Authorization: Bearer <bridge token>`（与
  supervisor-bridge 现有鉴权一致）。
- **默认仅回环**：`HOST=127.0.0.1`。远程接入（如手机/外网 → ChatGPT → adapter）需要
  额外的隧道/反代层，不要直接改 HOST 暴露公网。
- bridge 返回的 `ok:false` / HTTP≥400 一律映射为 MCP `isError:true` 结果（不是 JSON-RPC
  error），ChatGPT 侧可读性更好。

## 自测

```powershell
node supervisor-mcp-adapter\server-test.mjs
# 37 项断言：MCP 握手/notifications/202、tools/list 9+readOnlyHint=5、
# 5 READ + 4 MUTATION 全链路映射、bridge down→isError、GET /mcp→405、
# healthz、resources/list 空、鉴权 401/正确 bearer 200、
# 双 token 分离（入口 token 自动生成/独立文件、上游走 BRIDGE_TOKEN）
```

真实 bridge 冒烟（只读，无副作用）：

```powershell
$env:PORT="8091"; $env:BRIDGE_BASE="http://127.0.0.1:3080"; $env:MCP_TOKEN="<token>"
node supervisor-mcp-adapter\server.mjs
# healthz → bridge:"ok"；tools/list → 9；tools/call supervisor_get_state → 真实 sessions
```

## 已知边界

- 传输仅支持 client→server 请求（无 server-initiated SSE/通知）；`GET /mcp` → 405，
  `DELETE /mcp` → 204（stateless 无会话可终止）。
- 真实 `dispatch_goal` 会创建真实 harness session 并消耗真实模型回合——端到端 mutation
  冒烟请自备一次性 idempotency_key 并在验证后 `cancel_goal` 清理。

## ChatGPT 绑定

**连接方式（2026-08-29 官方机制核验，developers.openai.com Secure MCP Tunnel 指南）**：
ChatGPT 开发者模式 App → 私有 MCP 的官方首选路径 = **Secure MCP Tunnel**——本机跑
`tunnel-client`（openai/tunnel-client，outbound HTTPS 长轮询 `api.openai.com:443 /v1/tunnel/*`）
把 OpenAI 托管隧道端点收到的 MCP JSON-RPC 转发到本机 adapter（Streamable HTTP，
`--mcp-server-url http://127.0.0.1:8091/mcp`，非 stdio）。
**无需公网入口、不开放入站端口、MCP 地址保持私有**，完全适配本机 CGNAT/无公网 IP 拓扑。

```bash
# 1) 先拉起 adapter（独立进程，8091；kill-switch 见 docs/operations/CHATGPT_SUPERVISOR_BINDING.md §1）
node supervisor-mcp-adapter/server.mjs
# 2) tunnel-client attach 既有 tunnel（官方推荐：runtimes connect 托管长驻运行时 → HTTP 端点）
tunnel-client runtimes connect \
  --alias p275-supervisor \
  --tunnel-id "<tunnel_id>" \
  --runtime-api-key "env:OPENAI_TUNNEL_API_KEY" \   # 经 secret 面板注入 ~/.dsh/.credentials.yaml，不入仓库
  --mcp-server-url "http://127.0.0.1:8091/mcp"
# 3) 自检（--json 暴露 process_running/healthy/ready 三字段）
tunnel-client runtimes status p275-supervisor --json
# 4) 停止：tunnel-client runtimes stop p275-supervisor（隧道资源在 OpenAI 侧，随时复用）
```

前提（详见 docs/operations/CHATGPT_SUPERVISOR_BINDING.md §7）：Platform tunnel 权限
（Tunnels Read+Manage 建隧道 / Read+Use 运行+选用）、ChatGPT developer mode（独立 workspace
权限，Enterprise/Edu 需 admin 授予 + Settings→Security and login 开启）、隧道必须关联目标
ChatGPT workspace 才在列表可见。E2E 计划见该报告 §6。
