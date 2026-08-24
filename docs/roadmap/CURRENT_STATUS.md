# Harness Master Roadmap — CURRENT STATUS

> 唯一执行状态入口。由 Master Orchestrator 维护；重启后从此文件 + Notion Phase 状态恢复执行位置。
> 仓库：ZTKyo/deepseek-harness-desktop ｜ 本文件：docs/roadmap/CURRENT_STATUS.md

## 总览

| Phase | 名称 | 状态 | Waiting For | 报告路径 |
|---|---|---|---|---|
| 01 | SAVE / Source of Truth Consolidation | `VERIFIED` | —（APPROVED） | docs/roadmap/reports/PHASE_01_SOURCE_OF_TRUTH/REPORT_R4.md |
| 02 | SIMPLIFY / Architecture Consolidation + Reliability P2 | `AWAITING_REVIEW` | EXTERNAL_REVIEW | docs/roadmap/reports/PHASE_02_SIMPLIFY/REPORT_R6.md |
| 03 | AUTONOMY / Task Autonomy | 未开始 | — | — |
| 04 | LEARN / Autonomous Learning | 未开始 | — | — |
| 05 | RESTORE / Disaster Recovery | 未开始 | — | — |
| 06 | ALWAYS-ON / VPS Runtime | 未开始 | — | — |

## Authority 声明

- **代码真源 = GitHub verified main / tag**（ZTKyo/deepseek-harness-desktop）
- **Runtime = deployed truth**；冲突按 commit/history/Golden/语义/测试裁决
- 详见 `AI_CONTEXT.md`（冲突裁决原则）

## Phase 02 执行上下文（R6 修复完成）

- **Reviewer Round 5 Verdict：CHANGES_REQUIRED**（2026-08-24）
- **修复分支**: `fix/phase02-review-r6`（PR #22，8 commits）

### 6 BLOCKING 全部完成
- B1 Test Isolation（StageE TxRoot + StageC 真 pre/post + 0-delta）
- B2 Process Authority（Guardian 复用 exact attempt + BOOT_FAILED journal/rollback + boot grace）
- B3 LastGood required-set（full-set 检查 + cardinality + 禁 legacy copy）
- B4 Liveness state machine（grace/recheck + generation identity + schema2 no-migrate）
- B5 Capacity truth（可注入 exact route resolver，runtime 权威）
- B6 preset config truth + loaded attestation + CI Level2 状态机测试

### R5 判定更新
- RestartAndWait exact terminal：真实 PASS（保留）
- legacy NEEDS_VERIFICATION → RESUME-OK（保留）
- **有效 compaction 配置**：active preset thresholdRatio=0.6 / retainRatio=0.2 / maxTokens=32768（真实读取，修正 0.8/0.16）
- **source==deployed 7/7 MATCH**；loaded attestation 诚实 flag
- Post-restart task recovery：**真实 PASS**（legacy migration → RESUME-OK，goal rounds 0→4）

### 关键修复（R5）
- **① legacy NEEDS_VERIFICATION migration**：旧代码写的 "events unavailable" NEEDS_VERIFICATION 不再永久卡死——boot 时精确 legacy 签名才重跑 Completion Truth（clean→可恢复 / evidence unavailable→bounded defer / 真实 unresolved→保持 fail-closed）
- **② goal-scoped liveness**：anti-double-kick 需 current generation + target Goal identity/revision + Goal progress evidence（roundsStarted）；session 活动不算 Goal liveness
- **③ generation 非空 fail-closed**：restart worker dot-source dsh-generation.ps1（原缺失→''），取不到不 commit
- **④ LastGood atomic**：versioned set + current pointer（原子替换，无缺失窗口）；restore 只走 pointer→hash 校验
- **⑤ Router/CommandCode capacity 比较**：needLargerContext 用 exact contextWindow 比较（严格更大才切）；单 owner 消费

## 当前执行位置

- 当前阶段：Phase 02 — SIMPLIFY（Reviewer Round 4 修复完成）
- **状态：AWAITING_REVIEW**（Waiting For=EXTERNAL_REVIEW）
- Final Verdict：IMPLEMENTATION_COMPLETE（见 REPORT_R5.md §17）
- 等待：99｜Reviewer Feedback 中 Reviewer Verdict=APPROVED 后才可进入 Phase 03

## 恢复指令

重启后：读取本文件 → 读取 Notion「02｜SIMPLIFY」页面 → 从未完成步骤继续。
当前执行位置：Phase 02 R5 修复完成，等待外部审核。

## 变更日志

- 2026-08-23：创建本文件；Phase 01 VERIFIED；Phase 02 开始（P2-0 最先）。
- 2026-08-23：Phase 02 R1/R2 完成（初版 + 6 BLOCKING 修复）。
- 2026-08-24：Phase 02 R3 完成（真实 authority + Opus 真相）。
- 2026-08-24：Phase 02 Reviewer Round 3 = CHANGES_REQUIRED（bridge 未接通 + Codex C1-C7）。
- 2026-08-24：Phase 02 R4 完成（11 Step + C1-C7 关闭）。
- 2026-08-24：Phase 02 Reviewer Round 4 = CHANGES_REQUIRED（5 BLOCKING + Runtime Interruption Addendum + Refinement）。
- 2026-08-24：Phase 02 R5 完成（5 BLOCKING + Addendum + Refinement 关闭；post-restart recovery 真实 PASS），状态置 AWAITING_REVIEW。
