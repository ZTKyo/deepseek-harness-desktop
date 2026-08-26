# Harness Master Roadmap — CURRENT STATUS

> 唯一执行状态入口。由 Master Orchestrator 维护；重启后从此文件 + Notion Phase 状态恢复执行位置。
> 仓库：ZTKyo/deepseek-harness-desktop ｜ 本文件：docs/roadmap/CURRENT_STATUS.md

## 总览

| Phase | 名称 | 状态 | Waiting For | 报告路径 |
|---|---|---|---|---|
| 01 | SAVE / Source of Truth Consolidation | `VERIFIED` | —（APPROVED） | docs/roadmap/reports/PHASE_01_SOURCE_OF_TRUTH/REPORT_R4.md |
| 02 | SIMPLIFY / Architecture Consolidation + Reliability P2 | `VERIFIED` | —（APPROVED，R1–R11 全部闭环） | docs/roadmap/reports/PHASE_02_SIMPLIFY/REPORT_R11.md |
| 02-SH | **Security-Hardening Gate**（P2 前置 gate） | `AWAITING_REVIEW` | EXTERNAL_REVIEW（Round 7 = CHANGES_REQUIRED，SH-R8 修复中） | docs/roadmap/reports/PHASE_02_SECURITY_HARDENING/REPORT_SH_R7.md |
| 03 | AUTONOMY / Task Autonomy | 未开始 | P2.5 完成（若存在） | — |
| 04 | LEARN / Autonomous Learning | 未开始 | — | — |
| 05 | RESTORE / Disaster Recovery | 未开始 | — | — |
| 06 | ALWAYS-ON / VPS Runtime | 未开始 | — | — |

## Authority 声明

- **代码真源 = GitHub verified main / tag**（ZTKyo/deepseek-harness-desktop）
- **Runtime = deployed truth**；冲突按 commit/history/Golden/语义/测试裁决
- 详见 `AI_CONTEXT.md`（冲突裁决原则）

## Phase 02 执行上下文（Phase 02 VERIFIED — Security-Hardening AWAITING_REVIEW / SH-R8）

- **Reviewer Verdict：Phase 02 APPROVED / VERIFIED**（R1–R11 闭环）
- **Security-Hardening External Review Round 7：CHANGES_REQUIRED**（restore-owner 跨 restart 独立性 / A5 baseline-aware / CURRENT_STATUS post-merge truth）
- **当前 Security-Hardening 状态：AWAITING_REVIEW**（Final Verdict=IMPLEMENTATION_COMPLETE，VERIFIED 只能由 Reviewer APPROVED 后 backfill）
- **已完成轮次**：SH-R1（实现主体，PR #32）、SH-R2（4 项，PR #33，main `70932de`/`a06e7b0`）、**SH-R3（3 项，PR #34，main `1959b5b`/`92c6774`）**、**SH-R4（3 项，PR #35，main `c9f18f9`/`585e5e8`）**、**SH-R5（3 项，PR #36，main `e1a90326`/`18c6136`）**、**SH-R6（3 项，PR #37，main `ec91d26b`/`74f894d`）**、**SH-R7（3 项，PR #38，main `52176a77`/`4b1f9dd`）**
- **修复分支**：`fix/shardening-r8`（SH-R8 修复中）
- **禁止**：rotate/delete secret（除非授权）、进入 P2.5 / Phase 03

### 路线顺序（Security-Hardening APPROVED 后）
1. **Security-Hardening AWAITING_REVIEW**（当前）→ Reviewer APPROVED → VERIFIED backfill
2. **P2.5**（若存在）
3. **Phase 03**（AUTONOMY）

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

- 当前阶段：**Security-Hardening Gate**（External Review Round 7 = CHANGES_REQUIRED；SH-R8 修复中）
- **状态：AWAITING_REVIEW**（Final Verdict=IMPLEMENTATION_COMPLETE，见 REPORT_SH_R4.md；VERIFIED 只能由 Reviewer APPROVED 后 backfill）
- Final Verdict：Phase 02 = **APPROVED / VERIFIED**（见 REPORT_R11.md）；Security-Hardening = **IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**（见 REPORT_SH_R6.md）
- 等待：Reviewer 确认 Security-Hardening APPROVED → VERIFIED backfill → P2.5（若存在）→ Phase 03
- 路线顺序：P2 VERIFIED ✅ → Security-Hardening AWAITING_REVIEW（SH-R8 修复中）→ Reviewer APPROVED → P2.5 → P3

## 恢复指令

重启后：读取本文件 → 读取 Notion「02｜SIMPLIFY」页面 → 从未完成步骤继续。
当前执行位置：**Security-Hardening SH-R8 修复中（External Review Round 7 = CHANGES_REQUIRED）；Reviewer APPROVED 前禁止进入 P2.5 / Phase 03。**

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
- 2026-08-24：Phase 02 R7 adversarial audit（PR #24，4 真实缺陷关闭）；Round 7 + Post-PR24 Follow-up = CHANGES_REQUIRED。
- 2026-08-24：Phase 02 R8 完成（5 blocker + Runtime Interruption Addendum 关闭；wired=true source=runtime 真实），PR #25 + PR #26 merged。
- 2026-08-24：Phase 02 Reviewer Round 8 = CHANGES_REQUIRED（stale due / production-path T12 / provider switch / unattended restart）。
- 2026-08-25：Phase 02 R9 完成（4 项 + MINOR 关闭；长会话 provider switch + 无人为输入 restart 真实 gate 通过），PR #27 merged（main=f3336eb8）。
- 2026-08-25：Phase 02 Reviewer Round 9 = CHANGES_REQUIRED（budget once-per-boot / exact CommandCode→OpenCode / evidence file / REPORT_R9 编码 + CURRENT_STATUS truth）。
- 2026-08-25：Phase 02 R10 完成（4 项关闭；R9 evidence 补提交；REPORT_R9 编码修复），状态置 AWAITING_REVIEW。
- 2026-08-25：Phase 02 Reviewer Round 10 = CHANGES_REQUIRED（R11 收口：budget-epoch production-path test + canonical status truth）。
- 2026-08-25：Phase 02 R11 完成（T16 真实 budget-epoch production-path 6 项 + CURRENT_STATUS canonical truth），状态置 AWAITING_REVIEW。
- 2026-08-25：Phase 02 **Reviewer Verdict = APPROVED / VERIFIED**（R1–R11 全部闭环）；状态更新为 P2 VERIFIED。
- 2026-08-25：进入 **Security-Hardening Gate**（纯文档状态回填，不修改 P2 生产代码）；Security-Hardening 完成前禁止 P2.5 / Phase 03。
- 2026-08-25：Security-Hardening Gate 实现完成（IMPLEMENTATION_COMPLETE；当时误标 VERIFIED，SH-R2 已更正；crash recovery 后完成：NOTION_TOKEN 迁移到 env 注入方案、ACL/command-line/redaction/backup 盘点、secret-scan 回归、冷启动验证；5/5 checklist 闭环，见 REPORT_SH_FINAL.md）。Reviewer 确认前禁止 P2.5 / Phase 03。
- 2026-08-25：**Security-Hardening External Review Round 1 = CHANGES_REQUIRED**（状态回退 / icacls 证据 / CI 接入 / preflight 四项）；SH-R2 完成后保持 `AWAITING_REVIEW`（见 REPORT_SH_R2.md）。
- 2026-08-25：**SH-R2 完成（4/4）**：状态回退 AWAITING_REVIEW、真实 DACL 收紧、secret-scan 双层 CI + fixture、credential preflight/safe-degrade（PR #33，main `70932de`，回填 `a06e7b0`）；agentrouter/claude-opus-5 runtime ctx=1M 实测。
- 2026-08-25：**Security-Hardening External Review Round 2 = CHANGES_REQUIRED**（真实 cold-start gate / mock 豁免整行 bypass / YAML fail-closed）。
- 2026-08-25：**SH-R3 完成（3/3）**：真实三阶段 cold-start negative gate + fragment 级豁免 + YAML fail-closed（PR #34，main `1959b5b`，回填 `92c6774`；latest report=REPORT_SH_R3）。
- 2026-08-25：**Security-Hardening External Review Round 3 = CHANGES_REQUIRED**（gate 脚本可重复性 Byte-exact rollback / probe 结构化 / CURRENT_STATUS truth）；SH-R4 最小收口进行中（分支 `fix/shardening-r4`）。
- 2026-08-26：**Security-Hardening External Review Round 5 = CHANGES_REQUIRED**（EC 状态不变量 / cold-start 隔离 credential / CURRENT_STATUS final backfill）；**SH-R6 完成**：EC setState 不变量（recoverable state 禁 autoResume=false）+ T17 race 回归 9/9 + 真实 restart 验收（active progress / completed terminal）+ cold-start kill 注入（控制器 restore owner，SHA/DACL 恢复 + Notion 恢复加载）+/CURRENT_STATUS final backfill（分支 `fix/shardening-r6`；latest report=REPORT_SH_R6）。
