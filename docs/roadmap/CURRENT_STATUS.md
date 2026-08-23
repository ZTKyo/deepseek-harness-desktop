# Harness Master Roadmap — CURRENT STATUS

> 唯一执行状态入口。由 Master Orchestrator 维护；重启后从此文件 + Notion Phase 状态恢复执行位置。
> 仓库：ZTKyo/deepseek-harness-desktop ｜ 本文件：docs/roadmap/CURRENT_STATUS.md

## 总览

| Phase | 名称 | 状态 | Waiting For | 报告路径 |
|---|---|---|---|---|
| 01 | SAVE / Source of Truth Consolidation | `VERIFIED` | —（APPROVED） | docs/roadmap/reports/PHASE_01_SOURCE_OF_TRUTH/REPORT_R4.md |
| 02 | SIMPLIFY / Architecture Consolidation + Reliability P2 | `READY`（执行中） | EXTERNAL_REVIEW | docs/roadmap/reports/PHASE_02_SIMPLIFY/REPORT_R1.md |
| 03 | AUTONOMY / Task Autonomy | 未开始 | — | — |
| 04 | LEARN / Autonomous Learning | 未开始 | — | — |
| 05 | RESTORE / Disaster Recovery | 未开始 | — | — |
| 06 | ALWAYS-ON / VPS Runtime | 未开始 | — | — |

## Authority 声明

- **代码真源 = GitHub verified main / tag**（ZTKyo/deepseek-harness-desktop）
- **Runtime = deployed truth**（只描述部署，不证明“更新/更正确”）；冲突按 commit/history/Golden/语义/测试裁决
- 详见 `AI_CONTEXT.md`（冲突裁决原则）

## Phase 01 状态（VERIFIED）

- **Reviewer Verdict：APPROVED**（2026-08-23，Round 4）
- **Stable Golden（Promoted）**：`PHASE01_CANONICAL_GOLDEN_R3`（tag `phase01-save-r3`，
  已审核稳定基线；见 STABLE_GOLDEN.md）
- **Rejected History**：R1（phase01-save-complete）、R2（phase01-save-r2）保留不删
- **Known Issue（移交 Phase 02）**：`P2-0 / HIGH: Automatic Restart Ownership & Worker Survival`
  （AUTOMATIC_RESTART=FAILED，MANUAL_RELAUNCH_RECOVERY=PASS）
- 最终 main：`edd3254c`（Phase 01 全部 PR 合并）

## Phase 02 执行上下文

- **Current Phase：02 SIMPLIFY**
- **必须最先执行：P2-0 Automatic Restart Ownership & Worker Survival**（Reviewer 明确要求）
- 目标：Agent 内发起 restart → old server 退出 → restart worker 存活 → maintenance lock 释放 →
  new server 自动启动 → client_ready + COMMIT_READY → 原任务自动恢复，全程不得要求人工双击 Desktop；
  不新增独立 Restart Supervisor，与现有 Process Authority / Restart Budget / EC 收口
- **禁止进入 Phase 03**；完成后生成 `docs/roadmap/reports/PHASE_02_SIMPLIFY/REPORT_R1.md`，
  停在 AWAITING_REVIEW

## 恢复指令

重启后：读取本文件 → 读取 Notion「02｜SIMPLIFY」页面 → 从未完成步骤继续。
当前执行位置：Phase 02 开始，P2-0 最先。

## 变更日志

- 2026-08-23：创建本文件（Phase 01 首次运行）。
- 2026-08-23：R1-R4 修复完成，Phase 01 停 AWAITING_REVIEW。
- 2026-08-23：**Phase 01 = VERIFIED（APPROVED）**；Promote R3 Golden 为 Stable；
  进入 Phase 02，P2-0 最先执行。