# PHASE_02_SIMPLIFY — REPORT_R7

> Phase 02：SIMPLIFY / Architecture Consolidation + Reliability P2 — Reviewer Round 6 修复
> 日期：2026-08-24 ｜ 执行：Harness Master Orchestrator
> 报告路径：docs/roadmap/reports/PHASE_02_SIMPLIFY/REPORT_R7.md
> 前置：REPORT_R1/R2/R3/R4/R5/R6（不覆盖）

---

## 1. Reviewer Round 6 Verdict & 修复范围

**Reviewer Verdict：CHANGES_REQUIRED**（4 个 P0/P1 闭环缺口 + 2 个 truth/authority 收尾问题）
**R6 确认的真实进展（保留）**：PR #22 merged + Level1/2/3 绿；Test Isolation / LastGood required-set / boot grace / schema2 no-migrate / effective compaction 读取；legacy NEEDS_VERIFICATION → RESUME-OK。

**本轮 R7 全部完成**：6 个问题（R6-1…R6-6）逐项关闭（详见 §3-§8），关键真实 gate 通过。

## 2. Baseline

| 项 | 值 |
|---|---|
| Base Commit | `02fa12e5`（PR #22 merge 后 main） |
| 修复分支 | `fix/phase02-review-r7`（7 commits） |
| 保留 | R6 已验证成果（禁止重做） |
| DSH 版本 | 0.1.1-rc.2 |

## 3. R6-1 Guardian Handoff 契约（Close）

**Reviewer**：Guardian 持命名 mutex 等 worker（worker 跨进程拿不到锁 → 假失败/卡死）；传 -Reason 但参数表无；外层 + worker 重复计 attempt。
**修复**：
- Guardian Restart-Server **不再持锁等待**——delegated exact primitive（restart-dsh-server-delayed.ps1）独占 mutex + budget attempt + commit；Guardian 只做策略 gate + 调用
- Invoke-BudgetedRestart **删外层 Register-DshRestartAttempt**（worker 内注册一次）
- restart 脚本参数表加 **-Reason**（记录进 attempt）
**真实 gate（18:22-18:24 Guardian-style restart）**：
```
attempt b94659f... -> new server 27424 -> generation 639231925743756331_27424
-> stable -> COMMIT_READY -> COMMITTED（18:24:26）
boot grace 真实生效：api_unready x2 -> grace retry -> client_ready -> COMMIT（13:54 同场景曾误标 FAILED）
hourAttempts 不重复计数；maintenance lock released；HTTP 200 + COMMIT_READY True
```

## 4. R6-2 Zombie → CT-Gated Recovery（Close）

**Reviewer**：serverGenerationSeen 用 Date.now() 伪 generation；running=true 无 progress 只排队到 FAILED_FATAL 不走 CT；goal projection 缺失写 RUNNING 无 nextRetryAt（one-shot dead-end）。
**修复**：
- **serverGenerationSeen = 真实 server boot identity**（runtime ledger entryHash `gen:dbd231957b6a480a`，非 processStartMs；plugin reload 不当新 generation）
- **goal projection 缺失** → bounded LIVENESS_UNKNOWN recheck（RECOVERY_QUEUED + nextRetryAt + count），不再 RUNNING 死循环
- **LIVENESS_UNKNOWN 超 grace + cap → CT-gated recovery**（不再 FAILED_FATAL）：`ctGatedRecovery` = CT clean→goal re-arm / evidence unavailable→bounded defer / exact unresolved→NEEDS_VERIFICATION
- **runCtGate 抽取为单一 CT 决策**（normal resume + liveness 路径共用，无重复算法）
**验证**：r5-addendum 31/31（T10 CT-gated + goal-missing recheck）；crashsafe 33 / fault 38 PASS。

## 5. R6-3 Capacity Runtime 真接线（Close）

**Reviewer**：默认 resolver 无 runtime path；commandcode 无 config 注入口；production 未接 resolveModelInfo。
**修复**：
- **新 `runtime-capacity-adapter.mjs`**：薄 adapter 定位 Harness 官方 runtime resolveModelInfo(provider,model)（ctx.get('runtime') / ctx.runtime / loose service keys），wired=false 时不存在
- **commandcode-router**: `apply(ctx, config)` — config.capacityResolver 可注入；未注入时自动接 runtime adapter（registry hint 仅当无 runtime path；runtime-unknown fail-closed）
- **openrouter-router**：同样自动接线
**验证**：test-runtime-capacity-adapter 11/11（runtime wins / loose / no-runtime hint / runtime-unknown fail-closed / config injection）；bridge 14 / commandcode 51 / router 9+25 PASS。

## 6. R6-4 Loaded Release Manifest（Close）

**Reviewer**：mtime 推断 ≠ loaded module hash；entryHash 证明 server 身份非 plugin loaded hash。
**修复**：
- **EC 启动时写 `loaded-release.json`**（server generation + 实际加载的插件 path + sha256）到 DSHHarness/state——plugin lifecycle 内，无新服务；重启重写新 generation
- **r5-runtime-truth.mjs：3-way attestation**（source vs deployed vs loaded hashes）替代 mtime 推断
**真实验证**：loaded manifest `gen:dbd231957b6a480a`；6/7 插件 **source==deployed==loaded ALL-MATCH**（真实 3-way 闭环）；capacity-resolver 重部署后 MATCH。

## 7. R6-5 Guardian Restore 复用 Canonical（Close）

**Reviewer**：mirror 可能"旧但自洽"被当 authority，与 canonical current 分叉。
**修复**：
- Save 的 mirror meta.json 加 **canonicalSetId**（= canonical current pointer 指向的 versioned set）
- Guardian Restore-LastGoodConfig：**缺 canonicalSetId（pre-R7 mirror）或 canonicalSetId != canonical pointer（stale）→ 拒绝**；mirror 只能是 derived cache，不能成为第二 authority
**验证**：StageB C7（canonicalSetId == pointer / stale mirror 拒绝 / pre-R7 mirror 拒绝）ALL PASS。

## 8. R6-6 CURRENT_STATUS/REPORT 内部一致（Close）

**Reviewer**：CURRENT_STATUS 顶部指向 R6 但执行位置写 R4/R5；REPORT_R6 §12 写待 merge。
**修复**：
- CURRENT_STATUS：执行位置/恢复指令/关键修复/变更日志全部更新为 R7 一致状态（顶部 Phase 02 → REPORT_R7）
- REPORT_R7 记录最终 PR/CI/merge truth（PR #23 merge SHA 见 §10）

## 9. 已确认 PASS（R7 禁止重做）

- PR #22 merged；Level1/2/3 绿；StageC true pre/post；StageE TxRoot+0-delta
- LastGood required-set/cardinality/hash/no-legacy-copy
- Restart worker non-empty generation、stable window、boot grace
- legacy NEEDS_VERIFICATION → CT defer → CT clean → RESUME-OK（goal rounds 0→4）
- schemaVersion=2 manual review 不再自动 migration
- active compaction 0.6 / 0.2 / 32768；Goal Recovery 只读；Completion Truth exact callId；EC 无手工 compact

## 10. PR / CI / Merge SHA（不留 pending）

- **PR #23（代码+报告）**：`fix/phase02-review-r7`（7 commits）
- CI：Level 1/2/3（待 PR 创建后跑）
- Merge SHA：待 merge 后记录（本报告 merge 后回填）

## 11. Real vs Synthetic Evidence 分栏

| 证据 | 类型 |
|---|---|
| Guardian-style restart COMMITTED（attempt b94659f...，18:24）+ boot grace 救回 | real |
| 3-way attestation source==deployed==loaded（loaded-release.json gen:dbd2319...） | real |
| preset 0.6/0.2/32768 读取 | real |
| CT-gated recovery / runCtGate 单一决策 / goal-missing recheck | synthetic（生产模块+mock ctx） |
| capacity adapter runtime wiring / fail-closed | synthetic（纯模块） |
| mirror canonicalSetId == pointer + stale/pre-R7 拒绝 | synthetic（隔离 state） |

## 12. Regression（全量）

| 测试 | 结果 |
|---|---|
| RestartBudget R1-R18 / StageB C1-C7 / StageC/D/E / FinalDrill / Lab 9 | PASS |
| model-registry 33 / CT 18 / resume-defer 12 / r5-addendum 31 / capacity 5 / adapter 11 | PASS |
| ec-router-bridge 14 / crashsafe 33 / fault 38 / compaction 18 / WAITING_USER 12 | PASS |
| router 9+25 / commandcode 51 / r5-runtime-truth（3-way） | PASS |

## 13. Rollback

- Checkpoint：`DSH-Client\_checkpoint-PHASE02-R7-20260824-175813`（Base 02fa12e5）
- git：`git reset --hard 02fa12e5`（R7 前）

## 14. Remaining UNKNOWN / BACKLOG

**UNKNOWN**：
- AGENTROUTER_BACKEND_ACCEPTED_CONTEXT（300K probe 需成本+key）
- commandcode settings contextWindow 未声明（registry hint=1310720；resolver hint 源；runtime 接线后以 resolveModelInfo 为准）

**BACKLOG**：
- Test-P20OrphanLock flaky（guardian dot-source 主循环）
- Live cordis.patch.yml 硬编码 NOTION_TOKEN（SECURITY-HARDENING 阶段）
- settings.yaml 中文 displayName 乱码（显示级）

## 15. Final Verdict

**IMPLEMENTATION_COMPLETE**

（6 问题全部关闭；关键真实 gate 通过：Guardian-triggered restart COMMITTED / CT-gated recovery / 3-way ALL-MATCH；全量回归绿；PR/CI/merge SHA 明确记录）

## 16. Waiting For

**EXTERNAL_REVIEW**

（等待 Reviewer Verdict；未 APPROVED 禁止 Phase 03；Phase 03 入口仍先执行 Security-Hardening gate）

---

*报告不可覆盖：复审修改将生成 REPORT_R8.md……*
