# Harness Master Roadmap — CURRENT STATUS

> 唯一执行状态入口。由 Master Orchestrator 维护；重启后从此文件 + Notion Phase 状态恢复执行位置。
> 仓库：ZTKyo/deepseek-harness-desktop ｜ 本文件：docs/roadmap/CURRENT_STATUS.md

## 总览

| Phase | 名称 | 状态 | Waiting For | 报告路径 |
|---|---|---|---|---|
| 01 | SAVE / Source of Truth Consolidation | `VERIFIED` | —（APPROVED） | docs/roadmap/reports/PHASE_01_SOURCE_OF_TRUTH/REPORT_R4.md |
| 02 | SIMPLIFY / Architecture Consolidation + Reliability P2 | `AWAITING_REVIEW` | EXTERNAL_REVIEW | docs/roadmap/reports/PHASE_02_SIMPLIFY/REPORT_R3.md |
| 03 | AUTONOMY / Task Autonomy | 未开始 | — | — |
| 04 | LEARN / Autonomous Learning | 未开始 | — | — |
| 05 | RESTORE / Disaster Recovery | 未开始 | — | — |
| 06 | ALWAYS-ON / VPS Runtime | 未开始 | — | — |

## Authority 声明

- **代码真源 = GitHub verified main / tag**（ZTKyo/deepseek-harness-desktop）
- **Runtime = deployed truth**；冲突按 commit/history/Golden/语义/测试裁决
- 详见 `AI_CONTEXT.md`（冲突裁决原则）

## Phase 02 执行上下文（R3 修复完成）

- **Reviewer Round 2 Verdict：CHANGES_REQUIRED**（2026-08-24）
- **修复分支**: `fix/phase02-review-r3`（PR #17）
- **Base Commit**: `64071dac`（R2 报告 merge）

### 6 BLOCKING 关闭（真实代码/consumer/runtime evidence）
- BLOCKING-1: EC 完全移除模型选择（modelCandidates/findCompatibleFallback 删除；agent/request pass-through；只记录 recovery REQUIREMENT）
- BLOCKING-2: goal-recovery 自主 engine 删除（8 函数）；只留 --check + --session executor；自主路径 fail-closed
- BLOCKING-3: Router CAPABILITY/Vision 从 registry 派生；测试 import 真实 consumer（21/21）
- BLOCKING-4: resumeRetryCount bounded（cap 8 → FAILED_FATAL）
- BLOCKING-5: completion-truth-core 纯模块（生产+测试共用 import；fail-closed 11/11）
- BLOCKING-6: claude-opus-5/4-8 contextWindow 200000 → **1000000**（官方 1M）；compaction threshold = 800000

### P2-0 / stable-window 保留
- 第三次真实重启 timeline：stop → client_ready(2s) → stable 30s → COMMIT_READY → budget reset（23:43）
- Register-DshRestartSuccess 改为 strict（无 candidate 不 reset）

### 运行时证据
- settings.yaml agentrouter-anthropic claude-opus-5/4-8 = 1000000（YAML VALID）
- pi-ai resolveModelInfo: contextWindow = entry.contextWindow ?? base ?? 262144 → 返回 1000000
- compaction threshold = 1000000 × 0.8 = 800000（thresholdRatio 默认 0.8）
- 修复既有 YAML 坏缩进（5 处）

## 当前执行位置

- 当前阶段：Phase 02 — SIMPLIFY（Reviewer Round 2 修复完成）
- **状态：AWAITING_REVIEW**（Waiting For=EXTERNAL_REVIEW）
- Final Verdict：IMPLEMENTATION_COMPLETE（见 REPORT_R3.md §15）
- 等待：99｜Reviewer Feedback 中 Reviewer Verdict=APPROVED 后才可进入 Phase 03

## 恢复指令

重启后：读取本文件 → 读取 Notion「02｜SIMPLIFY」页面 → 从未完成步骤继续。
当前执行位置：Phase 02 R3 修复完成，等待外部审核。

## 变更日志

- 2026-08-23：创建本文件；Phase 01 VERIFIED；Phase 02 开始（P2-0 最先）。
- 2026-08-23：Phase 02 R1 完成（P2-0 + Audit + REPORT_R1）。
- 2026-08-23：Phase 02 R2 修复（6 BLOCKING 初版）+ REPORT_R2。
- 2026-08-24：Phase 02 Reviewer Round 2 = CHANGES_REQUIRED（R2 只做表面迁移）。
- 2026-08-24：Phase 02 R3 修复完成（真实移除决策权 + 真实 consumer + Opus 5 context 真相），
  状态置 AWAITING_REVIEW。