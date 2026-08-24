# PHASE02_R7_ADVERSARIAL_AUDIT.md — 对抗性自审证据

> Phase 02 R7 对抗性自审（adversarial self-audit）— 2026-08-24
> 原则：不把"接口存在 / 单测 PASS / 报告声称完成"当完成标准。每个修复从生产入口沿
> 真实调用链反向追踪，主动构造反例。特别检查 sync/async API 契约、identity 语义、
> 状态机 terminal/due-state、restart 后持久化状态。

---

## 发现 1（真实缺陷，已修）：Guardian stale-session restart 绕过预算 gate

- **生产入口**：guardian 主循环 L608 → `Restart-Server`（直接）→ 无 `Test-DshRestartAllowed`
- **反例**：restart budget 耗尽（circuit open）时，stale-session restart 仍会执行——违反
  "预算 gate 是唯一重启策略入口"（Phase 02 架构核心）
- **修复**：L608 改走 `Invoke-BudgetedRestart`（含预算 gate）
- **验证**：source 级确认 L612 `if (Invoke-BudgetedRestart (...))`；RestartBudget/FinalDrill PASS

## 发现 2（设计权衡，记录不修）：Guardian 主循环同步阻塞

- **生产入口**：主循环单线程 while → `Invoke-BudgetedRestart` → `Start-Process -Wait`
  （RestartAndWait 含 30s stable + 180s timeout）
- **反例**：阻塞期间 crash/stuck 检测停摆
- **裁决**：keep-awake 由独立 60s timer 兜底（L115-130）；RestartAndWait 必须同步等 exact
  terminal（Reviewer 要求语义）；服务本身在重启中，新崩溃=重启失败已由 worker 处理 →
  **设计权衡，不引入异步 supervisor（违背"不新增 daemon"）**

## 发现 3（真实缺陷，已修）：ctGatedRecovery 未重置 liveness 基线 → resume 失败死循环

- **生产入口**：liveness cap 超限 → `ctGatedRecovery` → RUNNING + goal.resume
- **反例**：goal.resume 失败（goalRef null / API 错）→ 状态回 RUNNING → 下轮又无进展
  → grace → cap → CT → 无限循环，且 `livenessUnknownCount` 未重置持续增长
- **修复**：ctGatedRecovery clean 分支重置 `goalObservedAt=now`、`livenessUnknownCount=0`、
  `lastResumeAt=now`；resume 后刷新 `goalRoundsObserved`（防"resume 后仍判无进展"）
- **验证**：r5-addendum 31/31 PASS

## 发现 4（真实缺陷，已修）：capacity resolver sync/async 契约断裂 — 官方 resolveModelInfo 是 async

- **生产入口**：router needLargerContext → `capacityResolver.resolve()` → `runtimeResolve`
  → 官方 `dsh-llm` `async resolveModelInfo(provider, model)`
- **反例**：adapter 的 runtimeResolve 是同步函数，`info = runtime.resolveModelInfo(...)` 拿到
  **Promise** → `info.context` 永远 undefined → 永久 null → **fail-closed（安全但永不接线，
  即"wiring"静默失效）**。这正是 Reviewer 质疑的"接口存在但生产没接通"的真实形态
- **修复**：
  - `capacity-resolver.resolve()` 改 **async**（await runtimeResolve；同步 resolver 兼容）
  - `runtime-capacity-adapter` runtimeResolve 改 **async**（await 官方 Promise）
  - router/commandcode needLargerContext 分支 `await capacityResolver.resolve(...)`
- **验证**：test-capacity-resolver 6/6（含 T1b 同步兼容）；test-runtime-capacity-adapter 13/13
  （含 **T1b async 反例**：async resolveModelInfo awaited → window 888000）；bridge 14/14；
  官方 dsh-llm 源码确认 `async resolveModelInfo` + `normalizeModelInfo` 返回 `context.contextWindow`

## 发现 5（真实缺陷，已修）：Guardian canonicalPtr 硬编码 LOCALAPPDATA — DSH_STATE_ROOT 注入下错乱

- **生产入口**：Guardian Restore-LastGoodConfig → canonicalSetId 校验 → 读 canonical pointer
- **反例**：`Get-VerifiedLastGoodDir` 支持 `DSH_STATE_ROOT` 注入（隔离测试），但 Guardian 校验
  读的是硬编码 `%LOCALAPPDATA%\DSHHarness\verified-lastgood\current` → 注入模式下 mirror 在
  隔离 root 而 canonical pointer 读真实 root → 恒不等 → **restore 永远拒绝（隔离测试破坏）**
- **修复**：Guardian 复用 `Get-VerifiedLastGoodDir`（注入感知）
- **验证**：StageB C7（canonicalSetId == pointer / stale 拒绝 / pre-R7 拒绝）PASS

## 未发现缺陷（记录验证）

- **R6-2 状态机 due-state**：timer 覆盖 WAITING_PROVIDER/WAITING_NETWORK/RECOVERY_QUEUED
  （L266-267 nextRetryAt 到期）— RECOVERY_QUEUED 是 due-state ✅；goal-missing 分支有
  bounded cap → CT-gated（不 one-shot dead-end）✅；CT 在 resumeViaApi 跑两次（L614 +
  ctGatedRecovery 内）是冗余非缺陷（幂等安全）
- **R6-4 loaded manifest 语义**：harness 插件从 profile 目录加载（dsh-app-boot baseUrl =
  profile dir）→ manifest 记录的磁盘哈希 = 实际加载源 ✅；manifest 写 tmp+rename 原子 ✅
- **R6-5 $versionName**：Save 内 L142 定义（Split-Path $versioned -Leaf）→ canonicalSetId
  正确 ✅
- **持久化**：IntentStore setState 内部 persist（tmp+rename 原子，L237-243）；attempt ledger
  真实 COMMITTED 持久化（attempt b94659f）✅

## 结论

发现并修复 4 个真实缺陷（budget 绕过 / liveness 死循环 / sync-async 契约断裂 /
注入路径不一致）；1 个设计权衡记录。全量回归绿（node 全 PASS + ps1 全 PASS）。
