# AGENTS.md — Execution Economy v1 (Adaptive Execution Discipline)

> 本文件由 `dsh-agent-instructions` 自动加载。优先级：低于用户直接指令，高于默认行为。
> 目的：让低风险任务快做、高风险任务深做；减少重复、错误验证路径、无意义等待、Scope 膨胀。

---

## 1. CLASSIFY — 任务开始时分类（一次，30 秒内）

- **FAST**：加/删一个已有 Provider 的模型、改低风险 setting、查状态、改 endpoint、小配置变更。
  特征：改动面小、可快速 rollback、DoD 明确、无数据迁移、无架构变化。
  目标 3–5 分钟；Soft Budget 5 分钟；**Hard Replan 10 分钟**。
- **NORMAL**：小 bug 修复、插件安装、新 Provider 初次接入、小功能。目标 5–20 分钟。
- **DEEP**：Reliability 改造、数据迁移、大版本升级、Router 架构、安全相关。允许 checkpoint/branch/research/regression。

**FAST 不得自行升级成 DEEP**。除非有明确证据（如"现有架构无法表达该操作"），
否则不得因"以后这样更漂亮"扩大范围。确需升级必须记录 `ESCALATION_REASON`。

## 2. LOCK DOD — 开始前定最小 DoD

例如模型接入的 DoD = (1) provider/model 确认 (2) 临时注册存在 (3) 一次最小请求成功
(4) 原主力不变 (5) 用户可试。

执行任何动作前快速判断：**这直接推进 DoD 吗？** YES→执行；NO→FOLLOW_UP/SKIP。
发现"Router 可优化 / Registry 可统一 / UI 可更漂亮"一律不进当前任务。

## 3. MACHINE-FIRST VERIFY — 验证优先级（强制）

统一顺序（越靠前优先级越高）：

1. Internal API / RPC（如 settings.describe / llm.models / session.list）
2. Runtime Registry / Config / Settings 状态
3. 直接协议 probe（短 timeout）
4. Logs
5. DOM / machine-readable UI
6. Screenshot + Vision（**最后手段**）

第 1–5 层能证明结果时，**禁止**用 Screenshot/Vision 作为主验证。
GUI 只负责"用户界面最终显示正常"，不负责"后端是否注册成功"。

**Vision/Screenshot 限制**：FAST 任务默认 0 次 Vision。仅当 (A) 任务本身是视觉检查
或 (B) 所有 machine-readable 验证均不可用时允许，且默认最多 1 次。
第一次 Vision 若 slow/uncertain/timeout，**禁止重复同一截图路线，必须 replan**。

## 4. TWO-STRIKE REPLAN — 同一路线最多失败 2 次

- Attempt #1 失败 → 用新信息调整。
- Attempt #2 本质相同失败 → **PATH CLOSED，必须 REPLAN**。
- 第 3 次尝试必须改变至少一个重要变量：API / endpoint / credential / timeout /
  protocol / model id / 验证方法 / 路线 / 实现假设。

REPLAN 只记短记录（不写长反思）：

```
FAILED ASSUMPTION: ...
NEW EVIDENCE: ...
NEW PLAN: ...
CHANGED VARIABLE: ...
```

## 5. WALL-CLOCK BUDGET — FAST 时间预算

- 0–5 分钟：正常执行。
- 5 分钟：执行一次轻检查 `WHY_AM_I_STILL_RUNNING`（仅 6 字段）：
  `Elapsed / DoD completed / Current blocker / Last new evidence / Failed path count / Next action`
- **>10 分钟（FAST）**：禁止安静继续。必须：(1) 确认原 DoD (2) 找 TOP blocker
  (3) 检查 Scope 是否膨胀 (4) 检查是否在等过长 timeout (5) 检查 Human Shortcut (6) 换路线。
  若已变 NORMAL，记录 `FAST_ESCALATED_TO_NORMAL`（须有证据）。

## 6. Probe Timeout 与 Production Timeout 分离

- 生产 Agent request：维持现有合理长 timeout（不动全局配置）。
- **Provider/Model Fast Probe**：connection/status probe **5–10 秒**；
  minimal generation first response **20–30 秒**；最多 **1 次 retry**。
- 禁止为"验证模型能否工作"单次等待 300 秒。Provider 确实慢则报告 `PROBE_TIMEOUT` 换证据路径。
- 禁止粗暴把全局模型请求 timeout 改短。

## 7. HUMAN LEVERAGE — 只在值得时问

默认 AUTONOMOUS。仅当满足 **Human 动作 < 约 30 秒** 且 **Agent 自主绕路 > 约 5 分钟** 才 ASK HUMAN。
典型：OAuth、CAPTCHA、登录、付款、用户独占决策、用户手中信息。
不因"是否检查配置/是否重试 API/是否读日志/是否 rollback 可逆修改"打扰用户。
用户不在线且存在安全 Autonomous fallback → 继续；否则 `WAITING_FOR_USER`。
（不实现复杂 User Presence 检测。）

## 8. STOP — DoD 达成立即停

DoD 达成 → 立即 STOP。不"顺便优化"、不"再重构一下"、不"再截图确认一次"、不"再 benchmark"。
额外发现写入 FOLLOW_UPS 然后结束。

---

## Execution Telemetry（轻量，可选）

记录：taskClass / startedAt / finishedAt / wallClock / DoD / toolCalls / retryCount /
replanCount / visionCalls / longWaitCount / humanQuestions / finalState。
不记录 chain-of-thought，不建详细 reasoning 日志。

## 本工作区既有规则

本文件与 ~/.dsh/AGENTS.md、工作区既有规则并存；冲突时以更具体者为准。
Reliability v1 的安全能力（Process Identity / COMMIT_READY / Last Good / Transaction /
Safe Mode / Restart Budget / Guardian）为不可破坏基线。
