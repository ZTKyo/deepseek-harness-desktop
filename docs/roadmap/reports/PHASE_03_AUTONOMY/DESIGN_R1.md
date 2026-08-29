# P3 AUTONOMY R1 — 最小增量实现设计（DESIGN）

- 生成时间：2026-08-30
- **状态：IMPLEMENTED（2026-08-30 实现落盘 + 回归 20 套件全绿，验证证据见 R1_VERIFICATION.md；实现提交 466abc9）**
- 上游：`GAP_AUDIT_R1.md`（13 项合同核对结论）
- 原则：Official Session/Goal 保持唯一事实源；EC metadata 仅补必要字段；零新增常驻服务/DB/Authority；P1-A 不变量不动。

## 1 状态字段（EC IntentStore schemaVersion 2 → 3）

`it.autonomy`（嵌套子对象，缺省时由迁移补齐，整体随 IntentStore 同一原子写持久化）：

| 字段 | 类型 / 上限 | 语义 | 写入路径 |
|---|---|---|---|
| `acceptanceCriteria` | `string[] \| null`，≤12 条、每条 ≤500 字符（与 bridge `MAX_ACCEPTANCE_ITEMS` 对齐） | 本任务的验收标准（从 Goal objective/receipt 提炼；事实源仍是 Official Goal） | **write-once**：非空后拒绝覆盖（只能整体重置为 null 的显式 reset 不提供） |
| `criteriaEvidence` | `Array<{ index, status: 'PASS'\|'FAIL'\|'UNVERIFIED', evidenceClass, evidence ≤300, at }>` ≤12 | 每条验收标准的证据记录（Executor Claim ≠ Verified Result 的落点） | `autonomy_verify` |
| `verifiedMilestones` | `Array<{ at, step ≤300, evidenceClass, evidence ≤300 }>` ≤50（FIFO 淘汰最旧） | 已验证里程碑（append-only on PASS） | `autonomy_verify` |
| `currentStep` | `string ≤300 \| null` | 当前执行步骤（next action） | `autonomy_report` |
| `remainingSteps` | `string[] ≤12 \| null` | 剩余步骤（必要时） | `autonomy_report` |
| `lastProgressAt` | `number \| null` | 最后一次真实进度汇报时间 | report/verify 自动盖 |
| `lastVerifiedCheckpoint` | `string ≤500 \| null` | 最后验证检查点（恢复续跑锚点） | `autonomy_verify` PASS 时 |
| `verificationState` | `'UNVERIFIED'\|'PARTIAL'\|'VERIFIED'\|'FAILED' \| null` | 验收总体判定（派生，不手写） | verify 派生 |
| `lastErrorClass` | `string ≤100 \| null` | 最近错误签名（category/normalizedSignature），供同签名预算参考 | report/verify 附带 |

`evidenceClass` 枚举（合同证据优先级，从高到低）：`system_api > file_hash > git > browser_state > screenshot > ai_judgment`。仅作记录与展示，判定纪律由 policy 层 + 工具描述约束。

迁移规则（`ensure()`）：`if (!it.autonomy) it.autonomy = emptyAutonomy(); it.schemaVersion = 3;` —— 只增不清，v1/v2 旧字段原样保留；重复调用幂等。

## 2 纯模块 `plugins/autonomy-state-core.mjs`（无外部依赖，可单测）

```
export const AUTONOMY_SCHEMA_VERSION = 3;
export const MAX_ACCEPTANCE_ITEMS = 12;      // 与 supervisor-bridge-core 对齐
export const MAX_MILESTONES = 50;
export const EVIDENCE_CLASSES = [...];
export function emptyAutonomy()
export function sanitizeAutonomy(raw, existing) -> { ok, value, errors[] }  // caps/trim/enum/write-once
export function upsertCriterionResult(list, entry) -> { ok, value, errors[] }
export function deriveVerificationState(criteria, evidence) -> 'VERIFIED'|'PARTIAL'|'FAILED'|'UNVERIFIED'|null
export function buildResumeProgressLine(autonomy) -> string|null           // 恢复注入行
```

- `deriveVerificationState`：全部 criteria 有 PASS 证据 → VERIFIED；任一 FAIL → FAILED；部分 PASS → PARTIAL；无 criteria → null（UNVERIFIED 不阻塞既有状态机）。
- `buildResumeProgressLine` 输出形如：`Verified progress: step "X"; milestones verified: 3 (last "Y"); acceptance 2/4 PASS; last verified checkpoint: "Z". Continue from the last verified state; do not redo verified milestones.` 空状态 → null（不注入，行为与现状一致）。

## 3 EC 插件改动（execution-continuity.mjs，唯一写入者）

1. `inject` 增加 `"tools"`（web host 平面真实服务，secret-gate 先例）。
2. `ensure()` 迁移（§1 规则）。
3. 新增内部 mutator `applyAutonomyPatch(sessionId, patch)`：走 `sanitizeAutonomy` → `Object.assign(it.autonomy, value)` → `store.persist()`；失败不抛出恢复链路（fail-soft，工具层返回错误）。
4. 注册 3 个 agent 工具（`ctx.tools.register(defineTool({...}))`，会话作用域取 `exec.agent?.session?.id`，无 agent 上下文则报错）：
   - `autonomy_report`：入参 `{ currentStep?, remainingSteps?, acceptanceCriteria?, lastErrorClass? }`；写 `currentStep/remainingSteps/lastProgressAt`；`acceptanceCriteria` write-once。
   - `autonomy_verify`：入参 `{ criterionIndex?, status: 'PASS'|'FAIL', evidenceClass, evidence, milestoneStep?, checkpoint? }`；PASS+`milestoneStep` → append 里程碑 + 更新 `lastVerifiedCheckpoint`；`criterionIndex` → upsert criteriaEvidence；派生 `verificationState`。
   - `autonomy_state`：只读返回 `{ state, goalId, autonomy }`（模型切换/恢复后读回已验证进度）。
5. 恢复消息：`const message = composeResumeMessage(reason, it.autonomy)`；导出 `composeResumeMessage(reason, autonomy)`（内含 `buildResumeProgressLine`，供测试与复用）。WAIT-GATE、CT、liveness、预算等恢复链路**零改动**。

## 4 Policy 层（不碰代码的决策纪律）

- `~/.dsh/AGENTS.md`「任务收资协议」追加 **P3 Unattended Decision Policy**：可环境推断 + 可逆 + 有推荐方案 + 有 checkpoint 的普通技术选择 → 自动选最低风险方案 → execute → verify → 记录（不 ask_user_question）；仅六类真实边界提问（用户意图缺失 / 不可逆删除 / 唯一重要数据覆盖 / 重大安全权限边界 / 未知凭据 / 两种结果业务含义完全不同且环境无法判断）。
- 明示 P1-A 不变量：提问生成前的 policy 层减问；真实 question/requested 出现后继续阻断自动恢复（EC WAIT-GATE 不动）。
- 工作区 `AGENTS.md` 同步同一段落（工作区覆盖全局，两处一致）。

## 5 测试（deterministic verification，逐改动执行）

| 套件 | 覆盖 |
|---|---|
| 新增 `tests/autonomy/test-autonomy-state-core.mjs` | emptyAutonomy/sanitize（caps、write-once、enum）、criteriaEvidence upsert、deriveVerificationState 四态、buildResumeProgressLine 有/无状态 |
| 新增 `tests/autonomy/test-ec-autonomy-integration.mjs` | 临时 stateDir 的 IntentStore：v2→v3 迁移幂等；3 个工具经 fake `ctx.tools` + fake `exec.agent` 全链路（含 write-once 拒绝、验证派生、持久化重启读回）；`composeResumeMessage` 注入断言；WAIT-GATE 行为不受影响 |
| 回归（必须全绿） | execution-continuity-crashsafe-test / faultinjection / test-r5-addendum-ec / verify-waiting-user-gate / test-completion-truth / verify-multitask-recovery |

## 6 真实 Runtime E2E（隔离 DSH_HOME 实例，复用 verify-r2-restart-recovery 模式）

| # | 证据 | 步骤概要 |
|---|---|---|
| E1 | **自主决策** | 派发含"二选一可逆选择"任务 → 断言：无 ask_user_question 事件 + autonomy_report 记录决策 + verify PASS |
| E2 | **恢复** | 中途 `kill` 服务（已存 1 个 verified milestone + 副作用文件写入）→ 重启 → 断言：intent autonomy 持久读回、resume 消息含 checkpoint 行、completion truth 防副作用重放（文件单次写入） |
| E3 | **完成验证** | 构造 false completion（无证据 claim）→ 断言 verificationState≠VERIFIED 且不 COMPLETED；补齐证据 PASS → VERIFIED |
| E4（可选） | Desktop 关闭/重开 pending question 保留 | 已有 verify-haspendingquestion-real 覆盖，E2E 有余力再跑 |

## 7 部署与回滚

- 事务性部署：`autonomy-state-core.mjs` + `execution-continuity.mjs` → `~/.dsh/profiles/web/`；先写 `.bak-p3r1-<ts>` 副本；`compare-deployed-hash.mjs` ALL MATCH。
- 受控延迟重启（`restart-dsh-server-delayed.ps1`），**动手前向用户预告一次服务中断**。
- 回滚链：git 分支 `p3-autonomy-r1` → 部署面 `.bak` 单文件回退 → 极端情况 `EC_DISABLED=true`。

## 8 R1 明确不做

见 GAP_AUDIT_R1.md §5（bridge/router/guardian/goal-recovery 不动；无第二状态源；无 Question Gate Plugin；P1-A 不改；不进 Phase 04）。
