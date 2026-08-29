# CHATGPT_SUPERVISOR_BINDING.md

P2.75 TX-B —— ChatGPT Client Binding R1 交付报告。
**状态：READY_FOR_CHATGPT_HUMAN_GATE**（adapter 侧事务已完成并验证；下一步是用户手动
创建 ChatGPT Custom Connector，之后按 §6 执行真实 E2E）。

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

  ```powershell
  Stop-Process -Id (Get-NetTCPConnection -LocalPort 8091 -State Listen).OwningProcess
  ```

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
| `node server-test.mjs`（mock bridge 进程内自测） | **31 PASS / 0 FAIL**：initialize→2025-06-18、notifications/initialized→202、tools/list=9、readOnlyHint=5、schema 全 object、5 READ + 4 MUTATION 全链路字段映射、unknown tool→-32602+可用清单、bridge 停机→isError+bridge_unreachable、GET /mcp→405、healthz、resources/list 空、无鉴权 401、错误 bearer 401、正确 bearer 200 |
| 真实 bridge v0.2.2 只读冒烟 | healthz `bridge:"ok"`；tools/list=9；`supervisor_get_state` 返回真实 sessions；`supervisor_get_snapshot` 正常；幽灵 session → `isError:true, error:invalid_session_id`（bridge 404 原样映射，无副作用） |
| 端口纪律 | 8091 启动前空闲实测；冒烟后进程已清理、8091 已释放 |
| sealed code 未触碰 | diff 仅新增 `supervisor-mcp-adapter/`；3080/8090/Guardian/router/core 零改动 |

## 4. 错误映射

bridge `ok:false` / HTTP≥400 → MCP `tools/call` 结果 `isError:true`，结构化错误体原样透传
（如 `invalid_session_id`、`idempotency_conflict(409)`、bridge 自身 503 文案）。bridge 进程
不可达 → `bridge_unreachable`。JSON-RPC 层错误仅用于协议级问题（unknown tool → -32602）。

## 5. 认证与网络边界

- **双 token 分离**：ChatGPT→adapter 入口 token（`MCP_TOKEN`/`MCP_TOKEN_FILE`）与
  adapter→bridge 上游 token（`BRIDGE_TOKEN`/`BRIDGE_TOKEN_FILE`）互不复用；默认均回落
  `~/.dsh/supervisor-bridge/token`（本机零配置；分离仅改环境变量即可）。
- 入口鉴权常量时间比较，缺失/错误 → 401；`MCP_REQUIRE_AUTH=0` 仅供本机测试。
- **3080 不暴露公网**：所有公网可达性集中在 adapter 一侧（且默认仅回环）；远程入口方案
  与生命周期见 §5.1。

### 5.1 公网入口（ChatGPT 必需，短暂启用）

ChatGPT Custom Connector 要求公网 HTTPS URL。选型与参数以官方文档核验结论为准（§7），
原则：临时隧道（如 cloudflared quick tunnel）只在用户执行 E2E 时拉起，结束即关；
不打开路由器端口映射、不长期暴露。

## 6. ChatGPT-originated E2E 计划（App 创建后逐项执行，任一 FAIL → P3 不启动）

| # | 场景 | 通过判据 |
|---|---|---|
| 1 | READ：ChatGPT 内调用 `supervisor_get_state` / `supervisor_get_goal` | 返回真实数据，与 3080 直查一致 |
| 2 | 控制性 dispatch：ChatGPT 发 `supervisor_dispatch_goal`（一次性目标+简单验收） | bridge 收到同形 payload，session 创建，幂等键生效 |
| 3 | 幂等重放 + 409：同 `idempotency_key` 重发；再换 key 撞 `command_id` | 第一次返回原结果，冲突场景 `isError` + 409 原文 |
| 4 | `supervisor_review_goal` → VERIFIED | 状态投影 VERIFIED，回执落库 |
| 5 | 新会话 rebind：ChatGPT 新对话重新扫描工具 | 9/9 工具可发现，READ 正常 |

## 7. OpenAI 官方机制核验（Custom MCP App / Tunnel / 认证）

<!-- 待研究结论落地后填写：官方入口路径、开发者模式开关、no-auth/OAuth 选项、
     localhost 隧道方案与安全注意事项、发布/审核要求。占位不影响已验证部分。 -->

## 8. P3 硬门禁（本报告即门禁声明）

- 当前仅允许：**READY_FOR_CHATGPT_HUMAN_GATE**（用户手动建 App → §6 E2E）。
- E2E 全过前**禁止**启动 P3 实现；P3 首个 Goal 必须由真实 ChatGPT 经
  `supervisor_dispatch_goal` 下发；P3 Goal template 已备不执行。
