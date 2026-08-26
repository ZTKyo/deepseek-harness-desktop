# P2.5 CONTEXT MEMORY — R1 只读 Audit（定稿）

> Phase：02.5 CONTEXT MEMORY / Observational Memory（Minimal V1）
> 分支：`fix/context-memory-r1`（基线 = main `1346511e`）
> 取证方式：只读。主 agent 定点取证 + 3 个后台审计 worker（Router 链 / EC+offload / DSH 包）。
> 标记：**VERIFIED**（代码/配置直接取证）｜INFERRED（合理推断，标注）

## 0. 真源对齐（2026-08-26）

| 真源 | 状态 |
|---|---|
| GitHub main | `1346511e`（本地 checkout 与 origin/main 一致；分支 `fix/context-memory-r1` 已建，无领先提交） |
| CURRENT_STATUS.md | P2-SH = VERIFIED（Round 9 APPROVED，PR #40）；下一执行位置 = P2.5 |
| Notion 02.5 页 | Minimal V1 = Recent Window / Observation / Reflection / Recall / Provider-switch activation |
| Reviewer 99 最新段 | 允许开始 P2.5 R1 audit/implementation；P3 禁止；完成后停 AWAITING_REVIEW |

## 1. Official Session 数据结构与读取路径 — VERIFIED

- 存储：`~/.dsh/sessions/<workspace-slug>/<sessionId>/session.jsonl.zstd`（append-only JSONL、zstd 压缩）。物理读写由官方 dsh-session-persistence 管。
- 运行时访问（插件唯一合法路径）：`ctx.sessions.get(sessionId)` 或 `agent.session`：
  - `session.events[seq]`（append-only 全量事件）、`session.surface.nodes`（模型可见投影的 seq 序列）
  - `session.append(type, data, opts)` 唯一写入 API
- 生态红线核查（W-C）：现有插件均不直接读写 session 文件；唯一会话写入者走 `session.append`。

## 2. 模型收到 history 的构造位置 — VERIFIED（源码级）

调用链（`@deepseek-ai/dsh-agent-loop/lib/index.js`）：
1. 每 step 前 `preStep()` 触发 `dispatch.waterfall("agent/pre-step", {messages: claimed, turn, step, signal}, default)`；
   默认 decision = `{kind:'enter', messages:[...claimed, runtimeContext]}`（L501-508）。
2. decision.messages 逐条 `session.append("user/message", …, {surfaceOp:'append'})` 落 log（L554）。
3. `step()` 内 **history = `session.deriveMessages()`** —— 对 live surface 折叠 `deriveEventMessage`（L613）。
4. `buildRequest(...)` → `llm.stream(request)` 发往 provider。

**surface 投影规则**（`@deepseek-ai/dsh-session/lib/types/surface.js`，全部 VERIFIED）：
- 仅三类事件模型可见：`user/message`、`assistant/message`、`tool/result`。
- `deriveMessages` 折叠规则：user/message 原样、assistant/message 空内容跳过、tool/result 原样。
- 替换协议：`append(type, data, {surfaceOp:{op:'replace',start,end}, sourceEventSeqs:[...]})`
  - 新节点占据被替换区间的**位置**（splice 语义）→ 顺序正确
  - `sourceEventSeqs` 必须**覆盖全部被替换节点**且引用更早 seq（assertProvenance 强制）
  - `tool/result` 替换仅限单节点且只许改 content（assertToolResultRewrite）；**`user/message` 多节点范围替换无额外限制**
  - 每次 positional replace 使 `surface.replaceGeneration += 1`
- shadow-price 先例：替换前 append `compaction/prune {shadowedRange, shadowedSeqs, shadowedTokenCount}`（非 surface 事件，不带 surfaceOp）。

## 3. 官方注入通道（每轮上下文决定权）— VERIFIED

- time-context / system-prompt runtime-context 的官方做法：pre-step waterfall 中 `await next()` 后向
  `decision.messages` 追加 `createUserMessage({content:[{type:'text',text}], source:{kind:'plugin', plugin, form:'snapshot', sections:[{name,text}]}})`
  （dsh-time-context L363-393，`{prepend:true}`）。
- `RuntimeContextProjection`（agent-loop L26-83）：官方自己维护"每 section 单一 retained 快照"语义——旧快照被替换后不再可见。
- 结论：P2.5 的 Observation 注入完全有官方同构先例；快照式单活节点是官方语义。

## 4. Official compaction-basic 真实行为 — VERIFIED

- 双触发（dsh-compaction-basic L780-828）：
  1. `agent/pre-step` → `compactIfNeeded(agent,"pressure")`（thresholdRatio=0.6 × tokenMeter 压力）
  2. `agent/request-error` 且 code=CONTEXT_WINDOW_EXCEEDED → compact + `{kind:"retry"}`（maxOverflowRetries 上限）
- 压缩实现：shadow 大区间 surface nodes + 经 `ctx.llm.stream()` 直调摘要（复用会话前缀保 KV cache）。
- 生效实例由 autonomous 预设挂载（`~/.dsh/.agent-presets/autonomous/agent.cordis.yml` L423-454）：
  thresholdRatio 0.6 / retainRatio 0.2 / maxTokens 32768；tokenMeter 在 HOST 平面按 Session fold。
- 边界先例：EC 不手调 compactNow（P2 R4 Step 5 收口，verify-compaction-scope C2 断言 0 次调用）。

## 5. Router / provider-switch 路径 — VERIFIED（W-B）

- 决策与应用：`openrouter-router.mjs:384`（agent/request waterfall 内 await next() 后改写最终 `{provider,model}`）；
  真·跨 provider 切换在 :252-256（opencode 空响应×2 → 强制 OpenRouter）；commandcode-router.mjs:229 孪生实现。
- 最外层合法性门：model-selection-guard.mjs:58-73（resolveModelInfo 验证，非法→回退 settings 默认）。
- **无路由外发事件**（全树仅 ec/recovery-requirement 一个 emit，且是 EC→Router 方向）。
- 可观测信号排序：(1) 自装 `agent/request` post-next() 观察者（对比前后 route，agent-inspector.mjs:141-156 同款，生产验证）；(2) 动态 import agent-inspector readRouting；(3) HTTP endpoint 轮询。diagnostics 日志默认关闭。
- **激活判据（避免 auto 误报）**：provider 变化，或 model 变化且请求为具体模型（deriveRequestedMode :179-188；auto→具体的常规重写不算切换）。
- Router 状态：内存 Map per sid，dispose 即清；持久层只有 settings.yaml agent-default-model。

### 挂载坑（guard v2 教训，matters）

- host 平面直接 `ctx.on("agent/request")` 可能收不到（dispatch 只收集 scope 链内 hooks——guard v1 失败教训，
  guard.mjs:7-13）；v2 修复 = 监听全局 `agent/created` → 向 `agent.ctx` 注册 per-agent observer（guard.mjs:79-85）。
- 但 openrouter-router（同为 patch insert）直接注册成功（:234）——两种路径都有生产先例。
- **P2.5 采用双保险**：直接注册 + agent/created 兜底，WeakSet 去重（重复观察幂等无害）。

## 6. Execution Continuity 边界 — VERIFIED（W-C）

- EC 职责域：执行意图持久化（`%LOCALAPPDATA%\DSHHarness\state\execution-intents.json` 原子写）、10 类错误分类、
  预算/退避/断路器、WAITING_USER gate、Completion Truth 门、goal liveness、loopback 恢复执行器。
- **EC 已不手调 compactNow**；DEGRADED 仅是诊断标记。
- goal 接口：读 `ctx.goals.get(agent)` / RPC `goal.resume{ref:{id,revision}}` + `session.prompt mode:queue`；
  订阅 `goal/changed`。P2.5 不需要也不得另建 goal 状态。
- P2.5 重叠判定：与 EC 几乎不重叠（EC 只在错误恢复决策介入）；只要不碰 request-error retry、不发
  ec/recovery-requirement、不手调 compactNow，即零冲突。

## 7. 可复用持久化点 — VERIFIED

- 插件自管 state 先例：EC IntentStore（tmp+rename 原子写 JSON）于 `%LOCALAPPDATA%\DSHHarness\state\`。
- P2.5 store 选址：`%LOCALAPPDATA%\DSHHarness\state\context-memory\<sessionId>.json`
  （schemaVersion + sessionId + sourceRefs + sections + watermark + route 历史）。
- 部署备份约定：`~/.dsh/profiles/web/_backup-<name>-<ts>.<ext>`。
- dsh-context-budget.mjs（仓库根）：离线字符估算诊断脚本，无 authority 重叠（防第二系统检查通过）。

## 8. 插件形态与 Kill-switch 惯例 — VERIFIED

- 标准形态：`export const name` + `export function apply(ctx, config)`；无 group 成员特殊接口（offload 就是普通插件）。
- 挂载位：autonomous 预设 compaction 组行序即监听序（offload 行在 compaction-basic 前 = "先裁剪再测压"，注释原文）。
  P2.5 行插在 offload 之后、compaction-basic 之前（pre-compaction 位）。
- Kill-switch：EC 双通道范式（env `CM_DISABLED=true` + config `enabled:false`），apply() 第一行短路。
- 测试约定：`tests/<area>/verify-*.mjs`，mock ctx + `_test` 导出，fail→exit 1。

## 9. 关键设计裁定（基于以上证据）

1. **机制选型**：Notion 要求"更早、更持续地减少每轮重复历史"+ Token A/B 降本 ⇒ 必须做 surface 选择
   （deriveMessages 只折叠 surface，纯附加注入只会增 token）。附加注入仅用于 Observation 快照块本身。
   W-C 建议的"只附加不替换"无法满足验收标准 2（Token A/B），不予采纳；其边界律中"绝不 replace 当前会话表面"
   收窄为"绝不 replace Recent Window 内及之后的节点；绝不触碰压缩配置域/重试决策域"。
2. **替换内容**：Recent Window 之前的完整对话区段 → 单个 `user/message` Observation 快照节点
   （多节点 user/message 替换 VERIFIED 合法）；Observation 增长时对新范围再次 replace（旧快照节点一并 supersede）。
   表面恒只有一个活 Observation 节点 = bounded。
3. **Recent Window**：末尾 N 个 surface 节点永不投影（默认 40，可配）。
4. **激活条件**：(a) Router 已发生切换（观察者判定，含 auto 判据修正）⇒ 立即激活；(b) surface 估算 token 超
   activationThreshold（默认 50000，低于 compaction 0.6 压力线）⇒ 持续投影。未激活时只增量维护 store 不改表面。
5. **Recall**：每个替换节点的 sourceEventSeqs 官方回源 + store 内 refs（sessionId,seq）记录五类证据定位。
6. **fail-open**：一切异常→跳过本轮投影放行原始 surface；store 损坏→从 raw log 确定性重建；重建失败→空投影运行。
7. **绝对不碰**：compactNow/threshold 配置、request-error retry 决策、ec/recovery-requirement、路由决策、goal 状态。

## 10. 开放问题清零

| 问题 | 结论 |
|---|---|
| 是否存在不改 log 的 per-request 变换？ | decision.messages 会落 log；可持续减 token 的唯一通道是 surface 选择（§9.1） |
| Router 切换可观测信号？ | 无外发事件；用 agent/request post-next() 观察者（§5） |
| EC 生产 stateDir？ | `%LOCALAPPDATA%\DSHHarness\state\`；无任何插件直写 session 文件（§6/§7） |
