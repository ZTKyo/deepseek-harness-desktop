# Harness Master Roadmap — CURRENT STATUS

> 唯一执行状态入口。由 Master Orchestrator 维护；重启后从此文件 + Notion Phase 状态恢复执行位置。
> 仓库：ZTKyo/deepseek-harness-desktop ｜ 本文件：docs/roadmap/CURRENT_STATUS.md

## 总览

| Phase | 名称 | 状态 | Waiting For | 报告路径 |
|---|---|---|---|---|
| 01 | SAVE / Source of Truth Consolidation | `VERIFIED` | —（APPROVED） | docs/roadmap/reports/PHASE_01_SOURCE_OF_TRUTH/REPORT_R4.md |
| 02 | SIMPLIFY / Architecture Consolidation + Reliability P2 | `AWAITING_REVIEW` | EXTERNAL_REVIEW | docs/roadmap/reports/PHASE_02_SIMPLIFY/REPORT_R8.md |
| 03 | AUTONOMY / Task Autonomy | 未开始 | — | — |
| 04 | LEARN / Autonomous Learning | 未开始 | — | — |
| 05 | RESTORE / Disaster Recovery | 未开始 | — | — |
| 06 | ALWAYS-ON / VPS Runtime | 未开始 | — | — |

## Authority 声明

- **代码真源 = GitHub verified main / tag**（ZTKyo/deepseek-harness-desktop）
- **Runtime = deployed truth**；冲突按 commit/history/Golden/语义/测试裁决
- 详见 `AI_CONTEXT.md`（冲突裁决原则）

## Phase 02 执行上下文（R8 修复中 — R7 + PR24 partial closure）

- **Reviewer Round 7 + Post-PR24 Follow-up Verdict：CHANGES_REQUIRED**（2026-08-24）
- **修复分支**: `fix/phase02-review-r8`（R8 进行中）
- 前置：PR #23（**6 commits**，merged）；PR #24（R7 adversarial audit，4 真实缺陷，merged main=e64e57e9）

### R8 剩余 blocker（进行中）
- R8-1 generation：serverGeneration = childPid+startedAt（per-boot 变、plugin reload 不变）；禁 entryHash/Date.now fallback（已修）
- R8-2 resumeAfterCtClean：单一恢复尾（仅成功才 RUNNING；失败 durable due-state）+ T11 fault test（已修）
- R8-3 live capacity probe：EC boot 探测 ctx.llm.resolveModelInfo 真实容量（已实现，待重启验证）
- R8-4 attestation：含 runtime-capacity-adapter + 严格 3-way FAIL（已实现 r8-attestation-check）
- R8-5：-Reason 传 worker / 清 stale finally / 文档计数修正（已修）

### R7 已确认保留（禁止重做）
- Guardian exact restart + boot grace + budget gate（真实 b94659f... COMMITTED）
- LastGood required-set/canonicalSetId；legacy migration；schema2 no-migrate
- completion 0.6/0.2/32768；async capacity 契约（PR #24 关闭）

### R6 判定更新
- RestartAndWait exact terminal：真实 PASS（保留）
- legacy NEEDS_VERIFICATION → RESUME-OK（保留）
- **有效 compaction 配置**：active preset thresholdRatio=0.6 / retainRatio=0.2 / maxTokens=32768（真实读取）
- **3-way attestation**：source==deployed==loaded（loaded-release.json 真实闭环）
- **Guardian-triggered restart**：attempt b94659f... COMMITTED（18:24）+ boot grace 救回健康服务器（13:54 同场景曾误标 FAILED）
- Post-restart task recovery：**真实 PASS**（legacy migration → RESUME-OK，goal rounds 0→4）

### 关键修复（R6 → R7 保留）
- **① legacy NEEDS_VERIFICATION migration**：旧代码写的 "events unavailable" NEEDS_VERIFICATION 不再永久卡死——boot 时精确 legacy 签名才重跑 Completion Truth（clean→可恢复 / evidence unavailable→bounded defer / 真实 unresolved→保持 fail-closed）
- **② goal-scoped liveness → CT-gated recovery（R7）**：anti-double-kick 需 current generation + target Goal identity/revision + Goal progress evidence；zombie/no-progress 超 grace 后进入 CT-gated recovery（clean→resume / evidence unavailable→bounded defer / unresolved→NEEDS_VERIFICATION），不再死端 FAILED_FATAL；goal projection 缺失也走 bounded recheck
- **③ generation 非空 fail-closed + 真实 per-boot generation（R8）**：restart worker dot-source dsh-generation.ps1；serverGeneration = runtime ledger childPid+startedAt（per-boot 变、plugin reload 不变）；禁 entryHash/Date.now fallback
- **④ LastGood atomic + required-set + canonical restore（R7）**：versioned set + pointer 原子替换；required set 缺一不可；Guardian mirror 带 canonicalSetId 且必须等于 current pointer（mirror 只能 derived cache）
- **⑤ Capacity truth（R8）**：live ctx.llm.resolveModelInfo 真实接线（wired=true source=runtime，1M 真实容量）；registry hint 只作 fallback
- **⑥ Loaded release manifest（R7→R8）**：EC boot 写 loaded-release.json（真 per-boot generation + 8 插件 sha256）；r8-attestation-check 严格 3-way（mismatch FAIL）

## 当前执行位置

- 当前阶段：Phase 02 — SIMPLIFY（Round 7 + Post-PR24 Follow-up 修复完成，R8 已提交）
- **状态：AWAITING_REVIEW**（Waiting For=EXTERNAL_REVIEW）
- Final Verdict：IMPLEMENTATION_COMPLETE（见 REPORT_R8.md）
- 等待：99｜Reviewer Feedback 中 Reviewer Verdict=APPROVED 后才可进入 Phase 03

## 恢复指令

重启后：读取本文件 → 读取 Notion「02｜SIMPLIFY」页面 → 从未完成步骤继续。
当前执行位置：Phase 02 R8 修复完成，等待外部审核。

## 变更日志

- 2026-08-23：创建本文件；Phase 01 VERIFIED；Phase 02 开始（P2-0 最先）。
- 2026-08-23：Phase 02 R1/R2 完成（初版 + 6 BLOCKING 修复）。
- 2026-08-24：Phase 02 R3 完成（真实 authority + Opus 真相）。
- 2026-08-24：Phase 02 Reviewer Round 3 = CHANGES_REQUIRED（bridge 未接通 + Codex C1-C7）。
- 2026-08-24：Phase 02 R4 完成（11 Step + C1-C7 关闭）。
- 2026-08-24：Phase 02 Reviewer Round 4 = CHANGES_REQUIRED（5 BLOCKING + Runtime Interruption Addendum + Refinement）。
- 2026-08-24：Phase 02 R5 完成（5 BLOCKING + Addendum + Refinement 关闭；post-restart recovery 真实 PASS），状态置 AWAITING_REVIEW。
- 2026-08-24：Phase 02 Reviewer Round 5 = CHANGES_REQUIRED（6 BLOCKING：Test Isolation / Process Authority / LastGood required-set / Liveness / Capacity / CI-preset）。
- 2026-08-24：Phase 02 R6 完成（6 BLOCKING 关闭；preset 0.6/0.2/32768 真实读取），PR #22 merged（main=02fa12e5）。
- 2026-08-24：Phase 02 Reviewer Round 6 = CHANGES_REQUIRED（Guardian handoff / zombie→CT-gated / capacity runtime / loaded manifest / mirror canonical / 内部一致）。
- 2026-08-24：Phase 02 R7 完成（6 问题关闭；Guardian-triggered restart COMMITTED + 3-way ALL-MATCH），状态置 AWAITING_REVIEW。
