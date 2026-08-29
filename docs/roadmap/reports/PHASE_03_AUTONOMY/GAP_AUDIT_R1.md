# P3 AUTONOMY R1 — 只读 Gap Audit + 基线/Authority 映射

- 生成时间：2026-08-30
- 任务来源：ChatGPT Supervisor 经绑定链真实下发（receipt key `p3_autonomy_r1_20260830`，supervisorGoalId `sg-b734914c-c8d9-5909-879c-28fd96073be0`，sessionId 与本会话一致，controlState=RUNNING）
- 性质：只读审计，未修改任何文件
- 前置 Gate（由 Supervisor 核验）：P2.5 CONTEXT MEMORY / P2.6 RETRY SEMANTICS / P2.75 SUPERVISOR / ChatGPT Client Binding E2E = VERIFIED（E2E 回执 `chatgpt_binding_e2e_20260830_a1` controlState=VERIFIED、reviewState=PASS 在账本中可查）

## 0 基线（审计时刻快照）

| 项 | 值 |
|---|---|
| Repo | `deepseek-harness-desktop` main @ `e2c8f2d`，工作树干净 |
| 部署一致性 | `tests/reliability/compare-deployed-hash.mjs` → **ALL MATCH**（deployed == repo） |
| EC 部署面 | `~/.dsh/profiles/web/execution-continuity.mjs` 87,952B（08-29 00:54） |
| Bridge 部署面 | supervisor-bridge{,-core,-test}.mjs（08-29 16:36，R1.2 收口版） |
| EC 状态存储 | `%LOCALAPPDATA%\DSHHarness\state\execution-intents.json`（IntentStore，原子写，schemaVersion 2） |
| 会话/Goal | Official Session（`~/.dsh/sessions`，durable events）+ Official Goal（id/revision/phase/roundsStarted/blocked） |

## 1 Authority 映射（既有权威面，R1 不新增 Authority）

| Authority | 载体 | 职责 | R1 是否触碰 |
|---|---|---|---|
| Official Session/Goal | dsh core（dsh-session-persistence-jsonl / dsh-goal） | **唯一任务事实源**：session events、goal.id/revision/phase/rounds | 只读消费 + 既有 API |
| Execution Continuity (EC) | `execution-continuity.mjs` + IntentStore | **恢复唯一权威**：状态机、预算、boot scan、WAIT-GATE、completion truth 接入 | ✅ 扩展（唯一写入者不变，schema v2→v3） |
| completion-truth-core | `completion-truth-core.mjs` | deterministic 副作用重放判定（clean/completed/needs_verification） | 复用，不动 |
| Supervisor Bridge（sealed） | supervisor-bridge{,-core}.mjs + receipts.json | 外部控制面：dispatch idempotency、acceptanceCriteria 账本、review/correction/cancel | 不动 |
| Router / Model Registry | openrouter-router + model-registry | 模型唯一权威 | 不动 |
| Guardian + goal-recovery | 工作区 `DSH-Client\*.ps1/.mjs` | 进程级自愈（无写入重启、goal 重武装） | 不动（见 §5 边界） |
| ChatGPT Supervisor | 外部（经 bridge 绑定链） | 外部监督：dispatch/review/verdict | R1 完成后仅 AWAITING_REVIEW |

## 2 逐项 Gap Audit（对照 Goal 合同的审计清单）

| # | 合同项 | 现状与证据 | 判定 | R1 动作 |
|---|---|---|---|---|
| 1 | 原始 Goal/Task identity | Official goal `{id, revision, generation}`；EC intent 持有 `goalId/goalIdObserved/goalRevisionObserved/goalRoundsObserved`（liveness 状态机同源读取） | ✅ 已有 | 无 |
| 2 | Session persistence | dsh-session-persistence-jsonl，events durable；EC/bridge 均从 session 事实读取 | ✅ 已有 | 无 |
| 3 | Goal phase | goal.phase=active/blocked、roundsStarted、maxGoalRounds（get_goal 实测） | ✅ 已有 | 无 |
| 4 | WAITING_USER / pending question | `hasPendingQuestion()`（倒扫 ask_user_question 无 tool/result）+ `checkUserWaitGate()` fail-closed 接入**所有**恢复入口（P1-A fix 2026-08-23）；测试 `tests/continuity/verify-waiting-user-gate.mjs` | ✅ 已有 | 无（回归保护） |
| 5 | resume/reconnect replay | EC boot scan（listRecoverable）+ timer（listDue）+ goal liveness 有界复查（cap 6）+ CT-gated recovery；测试 crashsafe/faultinjection/r5-addendum | ✅ 已有 | 无 |
| 6 | recovery intent | IntentStore 原子写 schemaVersion 2；setState 归一化（SH-R6/R7 不变量：RECOVERABLE 与 autoResume=false 不共存） | ✅ 已有 | 无 |
| 7 | checkpoint / verified milestone | **全链路无任何"已验证里程碑/最后验证检查点"持久化字段** | ❌ 缺失 | 新增 `autonomy.*` 字段 + 工具面 |
| 8 | acceptance criteria | bridge receipt 账本持有（`validateDispatch` 上限 12 条 ≤500 字符；review criteriaResults → `latestAcceptance`），但 `goal.create` 只传 objective，**native goal/EC 均无**；重启后 executor 只能从 objective 文本重推 | ⚠️ 部分 | EC 侧 write-once 持久化 + 恢复读回（事实源仍是 Official Goal objective，EC 存派生持久化） |
| 9 | last progress | intent 有 `lastActivity` 时间戳；无"已验证进度"语义 | ⚠️ 部分 | `lastProgressAt` + `verifiedMilestones` |
| 10 | next action / current step | 无对应字段 | ❌ 缺失 | `currentStep` / `remainingSteps` |
| 11 | recovery budget | `retryCount/fallbackCount/contextRecoveryCount/autoResumeCycles(+budgetGeneration)/resumeRetryCount(cap 8)/livenessUnknownCount(cap 6)` + 指数退避 + 断路器 + P2.6 分类（同 signature 计数预算） | ✅ 已有 | 无 |
| 12 | completion truth / evidence | `evaluateCompletion(events)` deterministic（executor claim≠完成事实；副作用未决 → fail-closed）；`verificationKind`（UNRESOLVED_SIDE_EFFECT 永久 / EVIDENCE_DEFER 暂态）；bridge evidence bundle（acceptance totals） | ✅ 已有（副作用面完备） | 增补**验收级** verify() 记录层（证据分级合同化），不重复实现重放判定 |
| 13 | verified-progress 恢复注入 | 恢复提示仅两条通用文案（restart/中断），**不含任何持久化进度事实** | ❌ 缺失 | resume 消息附 `buildResumeProgressLine(autonomy)` |

## 3 结论：R1 最小增量 = 4 个改动面（无新增常驻服务/DB/Authority）

1. **A（状态）**：新增纯模块 `plugins/autonomy-state-core.mjs` + EC IntentStore schema v3（`autonomy` 子对象：acceptanceCriteria(写一次)、criteriaEvidence、verifiedMilestones、currentStep、remainingSteps、lastProgressAt、lastVerifiedCheckpoint、verificationState、lastErrorClass）；迁移幂等（v1/v2 → v3 只增不清）。
2. **B（verify() 职责，Task Autonomy 内）**：EC 注册 3 个 agent 工具 `autonomy_report` / `autonomy_verify` / `autonomy_state`（`ctx.tools.register(defineTool(...))`，secret-gate 先例；会话作用域取 `exec.agent.session.id`，dsh-tool-ask-user 先例）。不建独立常驻 Auditor。
3. **C（恢复注入）**：EC resume 消息组合函数 `composeResumeMessage(reason, autonomy)` 附加持久化进度行（"从 last verified state 续跑，不重做已验证里程碑"）。
4. **D（Policy 层）**：`~/.dsh/AGENTS.md` + 工作区 `AGENTS.md` 写入 Unattended Decision Policy（可逆+可推断+有推荐+有 checkpoint → 自动执行→验证→记录；仅六类真实边界才提问）。**P1-A 不变量不动**：真实 question/requested 出现后仍阻断自动恢复，减问只发生在提问生成前的 policy 层。

## 4 已有能力复用清单（禁止重建）

- 重放判定：completion-truth-core（不重复实现）
- 测试基建：EC crashsafe / faultinjection / r5-addendum、verify-waiting-user-gate、test-completion-truth、verify-multitask-recovery、verify-r2-restart-recovery（隔离实例 kill+restart 模式，E2E 直接复用其 harness 模式）、compare-deployed-hash（部署一致性验证）
- 工具注册模式：secret-gate.mjs `defineTool`；会话作用域：`exec.agent`（官方 dsh-tool-ask-user）
- 隔离实例：`tests/context-memory/gate7/make-isolated-home.mjs`、`tests/supervisor/run-supervisor-ci-e2e.mjs`
- 部署：事务性部署 + `.bak` 备份 + 受控延迟重启（`restart-dsh-server-delayed.ps1`）+ EC 自带 `EC_DISABLED=true` 快速回退开关

## 5 R1 明确不做（边界）

- 不动 supervisor-bridge / router / guardian / goal-recovery（goal-recovery 恢复消息增强列为 R1.5 候选，理由：guardian 路径的进度注入非合同必须，且 goal-recovery 在工作区脚本层、EC 才是恢复权威）
- 不建第二状态文件 / Task DB / Task Engine / 常驻 Auditor；不启用 Question Gate Plugin
- 不改 P1-A 行为；不自动回答用户问题
- 不进 Phase 04；完成后仅 AWAITING_REVIEW

## 6 风险与回滚

- EC 是生产恢复权威：schema v3 迁移必须幂等且兼容既有 v1/v2 数据；回归门槛 = crashsafe + faultinjection + r5-addendum + waiting-user-gate + completion-truth + multitask 全绿。
- 回滚链：git 分支（p3-autonomy-r1）→ 部署面 `.bak` 副本 → 单文件回退 → 极端情况 `EC_DISABLED=true`（插件零 hook 注册，Host 照常启动）。
- 部署需一次受控重启：按服务中断预告纪律提前告知用户。
