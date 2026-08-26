# Harness Master Roadmap — CURRENT STATUS

> 唯一执行状态入口。由 Master Orchestrator 维护；重启后从此文件 + Notion Phase 状态恢复执行位置。
> 仓库：ZTKyo/deepseek-harness-desktop ｜ 本文件：docs/roadmap/CURRENT_STATUS.md

## 总览

| Phase | 名称 | 状态 | Waiting For | 报告路径 |
|---|---|---|---|---|
| 01 | SAVE / Source of Truth Consolidation | `VERIFIED` | —（APPROVED） | docs/roadmap/reports/PHASE_01_SOURCE_OF_TRUTH/REPORT_R4.md |
| 02 | SIMPLIFY / Architecture Consolidation + Reliability P2 | `VERIFIED` | —（APPROVED，R1–R11 全部闭环） | docs/roadmap/reports/PHASE_02_SIMPLIFY/REPORT_R11.md |
| 02-SH | **Security-Hardening Gate**（P2 前置 gate） | `VERIFIED` | —（APPROVED Round 9） | docs/roadmap/reports/PHASE_02_SECURITY_HARDENING/REPORT_SH_R9.md |
| 02.5 | CONTEXT MEMORY / Session Continuity | `REVIEW_FIXES_COMPLETE`（R2 完成，REAL restart 已验） | PR #42 merge + SHA backfill → VERIFIED | docs/roadmap/reports/PHASE_02_5_CONTEXT_MEMORY/REPORT_R2.md |
| 03 | AUTONOMY / Task Autonomy | 未开始 | P2.5 完成（若存在） | — |
| 04 | LEARN / Autonomous Learning | 未开始 | — | — |
| 05 | RESTORE / Disaster Recovery | 未开始 | — | — |
| 06 | ALWAYS-ON / VPS Runtime | 未开始 | — | — |

## Authority 声明

- **代码真源 = GitHub verified main / tag**（ZTKyo/deepseek-harness-desktop）
- **Runtime = deployed truth**；冲突按 commit/history/Golden/语义/测试裁决
- 详见 `AI_CONTEXT.md`（冲突裁决原则）

## 当前执行位置

Security-Hardening Gate = **VERIFIED**（外部审核 Round 9 = APPROVED，PR #40 merged）。
下一个执行位置 = **P2.5 CONTEXT MEMORY**（Session Continuity）。

- P2.5 必须保持：Official Session = Truth、Official Goal = Task Truth、Execution Continuity = Recovery Authority、Router = Model/Provider Authority；Context Memory 不得成为第二 Task/Goal/Recovery/Router Authority。
- P2.5 完成后 → Phase 03（AUTONOMY）。

## Phase 02.5 CONTEXT MEMORY 当前状态

- **状态：IMPLEMENTATION_COMPLETE / REVIEW_FIXES_COMPLETE**（R2，2026-08-27；REAL restart 证据已补齐，
  待 PR #42 merge + SHA backfill 后置 VERIFIED）
- **latest report**：`docs/roadmap/reports/PHASE_02_5_CONTEXT_MEMORY/REPORT_R2.md`
- **PR**：PR #42（`fix/context-memory-r2`，10 commits，MERGEABLE）；R1 = PR #41（已 MERGED）
- **实现**：`plugins/context-memory{,-core}.mjs`（Recent Window / Observation / Reflection / Recall / Provider-switch activation）
- **验证**：R1 53/53 → R2 修复轮 **61 PASS**；R2-3 REAL restart **8 PASS / 0 FAIL**（01:37 真实重启，
  新 PID 13876，store watermark 483517→486785，guardian 0 QUARANTINED）；R2-6 REAL Recall 17 PASS；
  install-plugin 原子写 + 自动 hash 发现 15 PASS；guardian !!js regression 8 PASS
- **边界**：未进入 P3；未触碰 Security-Hardening；观察者角色（只决定模型看到什么，绝不决定路由/重试/压缩/goal）

## Phase 02 Security-Hardening 最终状态

- **Final Verdict：IMPLEMENTATION_COMPLETE → APPROVED / VERIFIED**（外部审核 Round 9，2026-08-26）
- **latest report**：`docs/roadmap/reports/PHASE_02_SECURITY_HARDENING/REPORT_SH_R9.md`
- **Merge history**：
  - PR #32（SH-R1 主体），PR #33（SH-R2），PR #34（SH-R3），PR #35（SH-R4）
  - PR #36（SH-R5），PR #37（SH-R6），PR #38（SH-R7），PR #39（SH-R8）
  - **PR #40（SH-R9，merge 5ba4363d，backfill df195923）** — 最终，**APPROVED**
- CI：Level 1/2/3 历史全绿；SH-R9 实测：Static 53s、Reliability 1m27s、boot smoke 4m8s
- Real runtime gate：16/16 全 PASS（credential source coherence、fail-closed A5、isolated source、canonical UNCHANGED）
- EC invariant：setState recoverable state 始终 autoResume=true（T18 adversarial 18/18，套件 90/90）
- 不再有 SH-R10 或后续轮次；不再需要进一步外审

### 安全收口清单（SH-R1→SH-R9 完整）
- [x] credential 加密存储 + env 注入（SH-R2）
- [x] 真实 Windows DACL/icacls 收紧（SH-R2）
- [x] secret-scan 双层 CI 接入 + 正反 fixture（SH-R2/SH-R3）
- [x] credential preflight / safe-degrade + ColdStartNegativeTest（SH-R2→SH-R8）
- [x] restart 脚本 5.1 函数顺序修复 + DSH-Client 同步（SH-R4）
- [x] EC setState recoverable state invariant（SH-R6/SH-R7）
- [x] Cold-start isolated credential source（canonical 不 mutation）（SH-R8）
- [x] A5 baseline-aware + fail-closed structured store probe（SH-R8/SH-R9）
- [x] Credential source coherence（effective path 单一解析，preflight 与 value read 同源）（SH-R9）
- [x] legacy KillInjection/restore-owner 归档（SH-R9）

### 非阻塞技术债（P2.5 后清理）
- Test-ColdStartCredentialGate.ps1 顶部旧 canonical-mutation/restore 注释 + deprecated -KillInjection 代码残留（标准 gate 不使用该路径，SH-R8/R9 的 canonical-isolation 安全性不依赖它）

## 路线（Security-Hardening APPROVED 后）
1. **Security-Hardening VERIFIED** ✅（Round 9 APPROVED）
2. **P2.5 CONTEXT MEMORY** ✅ 实施完成 + R2 修复轮完成（PR #42，REAL restart 已验证；merge 后置 VERIFIED）
3. **Phase 03**（AUTONOMY）

## 恢复指令

重启后：读取本文件 → 读取 Notion Phase 状态 → 从当前执行位置继续。
当前执行位置：**P2.5 CONTEXT MEMORY**（R2 修复轮完成 = REVIEW_FIXES_COMPLETE，REAL restart 8 PASS 已验；
剩余事项：PR #42 merge → SHA backfill → 置 VERIFIED → 进入 Phase 03）。

## 变更日志

- 2026-08-23：创建本文件；Phase 01 VERIFIED；Phase 02 开始（P2-0 最先）。
- 2026-08-23：Phase 02 R1/R2 完成（初版 + 6 BLOCKING 修复）。
- 2026-08-24：Phase 02 R3 完成（真实 authority + Opus 真相）。
- 2026-08-25：Phase 02 R4 完成（bridge 未接通 + Codex C1-C7）。
- 2026-08-25：Phase 02 R5 完成（bridge 接入 + capacity 全面接通）。
- 2026-08-25：Phase 02 R6 完成（Router single authority + generation 重跑 + real restart verification）。
- 2026-08-25：Phase 02 R7 完成（Router authority clean-up + session-list error bound + 3-way attestation + budget reset flow）。
- 2026-08-25：Phase 02 R8 完成（live capacity truth + per-boot generation + lazy-bridge single-source + 2x restart verification）。
- 2026-08-25：Phase 02 Reviewer Round 9 / R10 + final pass。
- 2026-08-25：Phase 02 R11 完成（T16 budget-epoch production-path test + CURRENT_STATUS canonical truth），状态置 AWAITING_REVIEW。
- 2026-08-25：Phase 02 **Reviewer Verdict = APPROVED / VERIFIED**（R1–R11 全部闭环）；状态更新为 P2 VERIFIED。
- 2026-08-25：进入 **Security-Hardening Gate**；实现完成（env 注入 / ACL 收紧 / secret-scan 双层 / preflight safe-degrade / 5.1 restart 修复 / isolated credential source / EC state invariant / credential source coherence / fail-closed A5 / legacy KillInjection 归档）；Round 1-9 **APPROVED**（PR #32-#40，PR #40 merge 5ba4363d，backfill df195923）。当前 **VERIFIED**（纯状态 backfill，Review Round 9 = APPROVED）。
- 2026-08-26：进入 **P2.5 CONTEXT MEMORY**；R1 实施完成（AUDIT → DESIGN → 实现 `context-memory{,-core}.mjs` → 53/53 回归 → 真实运行时验证 REAL）；提交 PR #41（`fix/context-memory-r1`），状态置 **IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**。未进入 P3，未触碰 Security-Hardening。
- 2026-08-27：P2.5 **R2 修复轮完成**（Review Round 1 CHANGES_REQUIRED → R2-1..R2-8 全部闭环）：测试入 CI（ci-level1/level3）、install-plugin 原子写 + 自动 hash 发现 + preflight 集成（15 PASS）、真实重启加载 R2 插件（01:37，restart-apply-patch 日志 COMMITTED；8 PASS / 0 FAIL；store watermark 483517→486785）、REAL Recall 17 PASS、R2-7 false-completion/context-rot 修复（61 PASS）、guardian !!js regression（8 PASS）。PR #42（`fix/context-memory-r2`，10 commits，MERGEABLE）。状态置 **REVIEW_FIXES_COMPLETE**，待 merge + SHA backfill → VERIFIED → Phase 03。
