# P2.75 SUPERVISOR — DESIGN R1（Supervisor Bridge 最小控制面）

> Phase 02.75 SUPERVISOR / ChatGPT → Harness Control Plane · R1 设计定稿
> 日期：2026-08-29 · 分支：`p275-r1-supervisor-bridge`
> 硬前置：Phase 02.6 外部 VERIFIED ✅（已满足）

## 1. 目标与非目标

**目标**：给 ChatGPT（本机 OpenAI.Codex 桌面宿主，经其 shell/exec 工具）一个**最小控制面**，
能对 Harness 做只读观测与受限变更，全部走 Harness 既有权威，不引入第二套系统。

**接口面（与目标书一致）**：
- 只读：`health` / `get_state` / `get_goal` / `get_evidence` / `get_snapshot`
- 变更：`dispatch_goal` / `send_correction` / `cancel_goal`

**非目标（红线）**：
- 禁 shell/write_file 等直接权威暴露（控制面**只有**上述 8 个动作，无任意命令通道）。
- 禁第二 Task/Goal/Router/Recovery/Memory Authority：所有变更最终落到宿主既有
  `session.*` / `goal.*` RPC（与 GUI 同一权威）；EC（execution-continuity）仍是恢复权威，
  本桥不重复其职责。
- 禁 P3（AUTONOMY）提前实现：本桥不做自主决策，只是翻译层 + 回执账本。
- 禁触碰 Web Remote Access 独立任务（另一会话 goal-4b8a9a4a，Cloudflare 入口）。

## 2. 架构（thin plugin/adapter）

```
ChatGPT (Codex.exe shell/curl)
   │  HTTP POST http://127.0.0.1:3080/supervisor/<verb>
   │  Authorization: Bearer <token>   ← token 文件 ~/.dsh/supervisor-bridge/token
   ▼
supervisor-bridge.mjs（宿主 Cordis 插件，注册在 3080 同一 webServer）
   │  ① Bearer 常量时间校验  ② core 纯函数校验/状态机  ③ receipts 原子落盘
   │  ④ 回环 fetch → http://127.0.0.1:3080/api/<session.*|goal.*>（与 GUI 同一 RPC 权威）
   ▼
宿主既有 session/goal 服务（唯一权威）→ goal 投影（session.list / history tail）
```

- 载体：宿主插件（`ctx.webServer.register({kind:'exact', path:'/supervisor/<verb>'})`），
  与 agent-inspector / secret-gate / ask-telegram 同款机制，**零 Harness 核心修改**。
- 回环 RPC：node fetch 到自身 `/api/*`，wire 形如
  `{type:'client-request', rpcId, method, payload}`（已实测可用；方法契约 =
  `@deepseek-ai/dsh-host-apiproxy/lib/types/api` 的 sessions.d.ts / goals.d.ts）。
- 纯函数核心 `supervisor-bridge-core.mjs`：校验、idempotencyKey→sessionId 派生、
  纠偏计数上限、回执状态迁移、响应裁剪。可脱离服务器单测。

## 3. 端点契约

统一：`POST /supervisor/<verb>`（`health` 额外支持 GET）；请求/响应 JSON；
鉴权：所有端点要求 `Authorization: Bearer <token>`；失败 401（不回显原因细节）。
错误体：`{ok:false, error:<code>}`；HTTP 码：400 校验失败 / 401 未授权 /
404 未知会话 / 409 冲突（如纠偏超限 corrections_exhausted）/ 502 上游 RPC 失败。

| verb | 请求 | 行为 | 响应要点 |
|---|---|---|---|
| `health` | — | 存活与版本 | `{ok, plugin, version, now}` |
| `get_state` | `{}` | session.list 投影裁剪 | `{sessions:[{sessionId,name,running,hasGoal,goalPhase,roundsStarted,updatedAt}]}` |
| `get_goal` | `{sessionId}` | 该会话 goal 投影 | `{goal, phase, roundsStarted, maxGoalRounds, activation}` 或 `{goal:null}` |
| `get_evidence` | `{sessionId, maxMessages?=50}` | session.history 事件（原样，剔除媒体字节） | `{events, hasMore}` |
| `get_snapshot` | `{}` | 聚合：state + goals + receipts 摘要 | `{host, sessions, goals, receipts}` |
| `dispatch_goal` | `{idempotencyKey, objective, maxGoalRounds?, initialInstruction?}` | 幂等派发（见 §4） | `{receipt, sessionId, goalRef, dispatched:bool}` |
| `send_correction` | `{sessionId, text, mode?='steer'}` | 纠偏注入（见 §5） | `{accepted, correctionsUsed, correctionsLeft}` |
| `cancel_goal` | `{sessionId, action?='pause'\|'complete'\|'clear'}` | goal.pause/complete/clear + session.cancel | `{ref, cancelled:true}` |

## 4. dispatch_goal 幂等语义（idempotencyKey 持久 receipts）

1. `sessionId = UUIDv5(NAMESPACE, idempotencyKey)` —— 同 key 永远同会话。
2. Receipts 账本：`~/.dsh/supervisor-bridge/receipts.json`（原子写：tmp + rename；
   每条 `{key, sessionId, goalRef, objective, createdAt, corrections, correctionsLeft, status, history[]}`）。
3. 命中已有 receipt → **不重派**，直接返回既有 receipt + 实时投影状态（`dispatched:false`）。
   ——这就是幂等：网络重试/进程重启后同 key 不会产生第二会话、第二 goal。
4. 未命中 → `session.create {sessionId}`（宿主幂等：同 id + 同 cwd 返回同一会话；
   即使 receipt 文件丢失，宿主层仍兜底幂等）→ `goal.create {sessionId, objective, maxGoalRounds}`
   → 可选 `session.prompt {mode:'queue'}` 投递 initialInstruction → 写 receipt。
5. **rebind**：receipt 只记身份（key/sessionId/goalRef），**运行态永远以宿主投影为准**
   （读时推导 status: active/paused/complete/cleared/absent）。宿主重启后 receipts 持久，
   同 key 查询直接重绑到宿主真实 goal 投影——桥不保存任何会"漂移"的运行态副本。

## 5. 有界纠偏循环（max 3）

- 每 receipt 维护 `corrections`；`send_correction` 前检查：`corrections >= 3` →
  HTTP 409 `corrections_exhausted`（响应带 correctionsUsed=3）。
- 上限 3 写死为 core 常量 `MAX_CORRECTIONS = 3`（测试矩阵 T12/T13 断言）。
- 纠偏通过 `session.prompt {mode:'steer'}`（默认，注入正在运行的回合；`mode:'queue'` 可选）。
- 计数落盘在**响应成功后**持久化（崩溃安全：宁可少计不可多放行）。

## 6. 安全

- Bearer token：首次加载时 `crypto.randomBytes(32).toString('hex')` 生成，写入
  `~/.dsh/supervisor-bridge/token`（0600 语义：仅当前用户目录）；不进 git、不进日志、
  不进聊天。消费方（ChatGPT/Codex shell）从该文件读取。
- 常量时间比较（`crypto.timingSafeEqual`）。
- 无 CORS 放宽：不加任何跨源头（调用方是服务端 shell，非浏览器）。
- 响应最小化：`get_state/snapshot` 不含会话内容，只有元数据；`get_evidence` 才返回事件，
  且剔除二进制/媒体字段。
- `token` 与 `receipts` 均在 `~/.dsh/supervisor-bridge/`（自管数据目录），不碰
  `sessions/**`、`storages/**`（文件红线）。

## 7. 测试矩阵（T1–T18）

**受控（plugins/supervisor-bridge-test.mjs，纯 node，无服务器）**：
- T1 key 校验（格式/长度）　T2 objective 校验　T3 maxGoalRounds 边界
- T4 UUIDv5 确定性（同 key 同 id；异 key 异 id）　T5 receipt 状态迁移合法表
- T6 纠偏上限状态机（0→3 通过，第 4 次 reject）　T7 响应裁剪（state 无内容泄漏）
- T8 token 常量时间校验（正确/错误/缺失）　T9 receipts 原子写（tmp+rename 模拟中断恢复）
- T10 dispatch 请求构造（create→goal→prompt 顺序与参数）　T11 cancel action 白名单
- T12 evidence 裁剪（媒体字段剔除）　T13 correctionsLeft 计算　T14 rebind 读时推导

**REAL/CONTROLLED E2E（tests/supervisor/verify-supervisor-real-e2e.mjs，本机对活体 3080）**：
- T15 dispatch REAL：真实派发一次性测试会话 + goal 投影断言（armed）
- T16 幂等 REAL：同 key 二次 dispatch → 同 sessionId、无第二 goal
- T17 纠偏 REAL：send_correction ×3 → 第 4 次 409
- T18 cancel REAL：pause → 投影 disarm；cleanup（clear + receipts 清理 + 会话留存证据）

## 8. 部署与回归

- 事务化部署：复用 `dsh-plugin-transaction.ps1` → `~/.dsh/profiles/web/`；
  `plugins/cordis.patch.yml` 与 live `cordis.patch.yml` 同步注册 `supervisor-bridge`。
- CI L3 active 列表加入 `supervisor-bridge.mjs`（无凭据可启动：token 自动生成）。
- 回归：P2.5 context-memory 测试 + P2.6 continuity 测试全量（136 基线不回退）。
- 报告：`docs/roadmap/reports/PHASE_02_75_SUPERVISOR/REPORT_R1.md`；
  CURRENT_STATUS 02.75 → IMPLEMENTATION_COMPLETE / AWAITING_EXTERNAL_REVIEW ROUND 1。

## 9. 与既有系统的边界（禁第二权威自查表）

| 职责 | 权威 | 本桥动作 |
|---|---|---|
| Goal 生命周期/续跑 | 宿主 goal.* + EC | 仅翻译 HTTP→goal.*（create/pause/complete/clear） |
| 崩溃恢复/重启 | EC + guardian + goal-recovery.mjs | 不参与；rebind 只读宿主投影 |
| 会话存储 | ~/.dsh/sessions|storages | 不读写文件 |
| 记忆 | 工作区记忆文件 | 不建第二记忆 |
| 密钥 | secret-gate / credentials | 桥只自管 bridge token（非用户密钥） |
