# PHASE_01_SOURCE_OF_TRUTH — REPORT_R2

> Phase 01：SAVE / Source of Truth Consolidation — Reviewer Round 1 修复
> 日期：2026-08-23 ｜ 执行：Harness Master Orchestrator
> 报告路径：docs/roadmap/reports/PHASE_01_SOURCE_OF_TRUTH/REPORT_R2.md
> 前置：REPORT_R1.md（不覆盖；本报告为 R2 复审修改）

---

## 1. Reviewer Verdict & 修复范围

**Reviewer Verdict：CHANGES_REQUIRED**（Round 1）
**根因**：R1 把"Live 当前正在用"错误等同于"Live 一定更新/更正确"，用较旧 Live 脚本覆盖了
Reliability v1 已验证源码，造成能力回退。

**修复原则**（本报告全程遵守）：
1. Runtime = deployed truth（只描述部署）；GitHub verified commit/tag = canonical code truth。
2. 漂移时按 commit/history/Golden/语义/测试裁决，不盲目 Live wins 或 Git wins。
3. 已通过 Reliability 验证的不变量，除非更强证据 + 全量回归，不得被较旧副本覆盖。
4. 禁止 force push / rewrite history；禁止整体 reset 回 eec17de（保留 Phase 01 正确成果）。
5. 全部修复只在分支 `fix/phase01-review-r2`，经 PR → CI → merge，禁止直接写 main。

## 2. Baseline

| 项 | 值 |
|---|---|
| Base Commit（R2 起点） | `b0f7d2358f9103b2e136a98a103f49feaf3150b4`（main HEAD） |
| Reliability 语义基线 | `eec17de5eaafe27e9bca03e596a99fdcbcb88027`（仅作对照，未整体回滚） |
| 修复分支 | `fix/phase01-review-r2` |
| Result Commit | `4867557`（待 PR merge 后进入 main） |
| DSH 版本 | 0.1.1-rc.2 |
| Checkpoint | `DSH-Client/_checkpoint-PHASE01-R2-20260823-142809` |

## 3. Reviewer Findings Closure（逐项）

### BLOCKING-1｜Reliability v1 被意外回滚 —— ✅ 已关闭

反向回退审计（main vs eec17de 逐文件 diff）确认 8 个文件被 R1 误覆盖，已全部恢复为
Reliability v1 语义（保留 Phase 01 正确新增不受影响）：

| 文件 | R1 回退内容 | R2 修复 |
|---|---|---|
| dsh-guardian.ps1 | Check-ConfigSafety 把 YAML valid 直接 promote 到 guardian-lastgood；硬编码 D:\C盘迁移 npx 路径 | 恢复 "RESTORE MIRROR ONLY" authority：syntax valid 不 promote；路径改回动态探测 |
| dsh-verified-lastgood.ps1 | 丢失 Test-VerifiedLastGoodGate（完整 COMMIT_READY gate），回退 api_ready/client_ready 浅检查 | 恢复全量 COMMIT_READY gate（identity + host.describe + session.list + events + renderer + light probe + stable window） |
| dsh-transaction.ps1 | Transaction 2.0 状态机（328 行 → 58 行简化） | 恢复 PREPARE→CHECKPOINT→APPLY→BOOT→VERIFY→STABILIZE→COMMIT + ROLLBACK/RESTART/VERIFY_RECOVERY/ESCALATE_TO_SAFE_MODE + journal/finalState |
| dsh-safe-mode.ps1 | True Safe Mode（196 行 → 53 行简化，丢 checkpoint/boot-mode/VerifySafe/RETURNED_TO_SAFE） | 恢复 Transaction-shaped enter/exit、safe-profile 隔离、boot-mode 接线 |
| dsh-launcher.js | 删除 DSH_BOOT_MODE/profileArgs（Safe/Experimental 隔离 profile 接线） | 恢复 boot-mode → --profile <mode> 接线；**保留** --no-open / trusted-host（Live 必要行为） |
| start-dsh-server.ps1 | 删除 dsh-boot-mode 引用 + Get-DshBootMode 接线；硬编码 npx 路径 | 恢复 boot-mode 读取与传递；路径改回动态探测 |
| dsh-diagnostics.ps1 | dsh --version 未保护（PS 5.1 无 dsh 时终止性错误） | 恢复 try/catch 保护 |
| dsh-healthcheck.ps1 | 同上 | 恢复 try/catch 保护 |

**验证**：Stage B（LastGoodAuthority）完整版 PASS，含 C2 "guardian no longer promotes
syntax-valid" + C3b "live promote gate=COMMIT_READY"；Stage C（Transaction 2.0）PASS。

### BLOCKING-2｜R1 测试覆盖不足导致假绿 —— ✅ 已关闭

本次完整执行 tests/reliability/ 全部验收项（详见 §6），Stage B/C/D/E + CommitReadiness +
FinalDrill + Lab L1 + restart budget 全部真实执行 PASS。"relevant tests PASS" 成立。

### BLOCKING-3｜绕过 branch→PR→CI→merge 治理 —— ✅ 已关闭

R2 全部修复在分支 `fix/phase01-review-r2`，通过 PR → required checks → merge 进入 main
（见 §7）。禁止直接写 main 已遵守。

### CURRENT-4｜精确重复源码 —— ✅ 已关闭

- 消费者确认：`goal-recovery.mjs`（guardian 从根目录 `Join-Path $root` 调用）与
  `dsh-event-notify.mjs`（DSH-Harness-PS.ps1 + sidecar 从根目录启动）**都不是 Cordis plugin**
  （cordis.patch.yml 不加载），真实消费者在**仓库根目录**。
- 修复：删除 `plugins/goal-recovery.mjs`、`plugins/dsh-event-notify.mjs` 完整副本；
  根目录保留唯一完整实现。plugins/README 更新（说明非 plugin 独立脚本的 canonical 位置在根）。
- 其余 plugins/ 文件确认非重复（core 被 plugin import、test 为回归、client.js 为注入目标）。

### CURRENT-5｜Source of Truth 规则歧义 —— ✅ 已关闭

- AI_CONTEXT.md：删除"Live 优先"，改为"冲突裁决原则"（Runtime=deployed truth；
  GitHub verified=canonical；按 commit/history/Golden/语义/测试裁决）；标注
  Stable Golden / Candidate Golden / REJECTED_CANDIDATE 分层。
- CURRENT_STATUS.md：明确 `_release-staging/` 是 working checkout 不是 Authority；
  代码真源 = GitHub verified main/tag。
- R1 Golden `PHASE01_CANONICAL_GOLDEN` / tag `phase01-save-complete` 标记
  **REJECTED_CANDIDATE**（REJECTED_CANDIDATE.md，保留历史不 rewrite）。

### CURRENT-6｜临时远端分支 —— ✅ 已关闭

- `sync/audit-20260823` 确认仅含 WorkBuddy/审计临时内容（.workbuddy/memory、completion_evidence），
  无唯一需保留内容 → 已删除远端 + fetch --prune。
- 保留含独有 commit 的：`execution-economy-v1`、`feature/ox-alpha-multi-relay-fallback`。

## 4. Step 6 部署对齐（canonical → deployment）

- 8 个可靠性文件 + `dsh-boot-mode.ps1` + `dsh-safe-profile.ps1` + `dsh-clean-reclaim.ps1`
  + `dsh-commit-readiness.ps1` 已部署到 DSH-Client（此前 boot-mode/safe-profile/commit-readiness
  从未部署，属"孤立能力"），逐文件 hash/内容验证一致。
- 备份：`DSH-Client/_backup-phase01-r2-deploy-20260823-144145`。
- **注意**：guardian 进程（PID 4988）运行中，脚本替换在下次 guardian 重启时生效
  （当前进程不受影响）；notify sidecar 同样。

## 5. 实际修改文件

- **恢复（12）**：dsh-guardian.ps1、dsh-verified-lastgood.ps1、dsh-transaction.ps1、
  dsh-safe-mode.ps1、dsh-launcher.js、start-dsh-server.ps1、dsh-diagnostics.ps1、
  dsh-healthcheck.ps1、dsh-readiness.ps1、dsh-restart-budget.ps1、dsh-process-identity.ps1、
  dsh-clean-reclaim.ps1（全部恢复 eec17de 语义/BOM）
- **删除（2）**：plugins/goal-recovery.mjs、plugins/dsh-event-notify.mjs（重复副本）
- **文档修正（3）**：AI_CONTEXT.md、CURRENT_STATUS.md、plugins/README.md
- **新增测试（1）**：tests/reliability/Test-RestartBudget.ps1
- **保留（R1 正确成果）**：plugins/ 其余 24 文件、tests/continuity/、tests/execution-economy/、
  tests/router/、docs/roadmap/、docs/_archived/、goal-recovery.mjs（根）、dsh-event-notify.mjs（根）

## 6. Tests / Regression（完整）

| 测试 | 结果 |
|---|---|
| Test-StageB-LastGoodAuthority（含 Live promote） | **PASS**（C1/C2/C3a/C3b gate=COMMIT_READY） |
| Test-StageC-Transaction | **PASS**（T1-T4，finalState=COMMITTED/ROLLED_BACK） |
| Test-StageD-BootMode | **PASS**（D1-D6，safe/experimental/normal round-trip） |
| Test-StageE-SafeMode | **PASS**（E4/E5，isolated，未触碰真实 profile） |
| Test-CommitReadiness | **PASS**（Gate: True, Stage: COMMIT_READY，7 项全绿） |
| Test-FinalDrill | **PASS**（含 SAFE escalation、RETURNED_TO_SAFE、journal audit） |
| Reliability Lab L1 | **PASS**（9/9） |
| Test-RestartBudget（新增） | **PASS**（5/5，R1-R5 状态机） |
| execution-continuity-crashsafe | **33 PASS** |
| execution-continuity-faultinjection | **38 PASS** |
| verify-waiting-user-gate | **12 PASS** |
| verify-compaction-scope | **15 PASS** |
| verify-nonrecoverable-states | **19 PASS** |
| verify-multitask-recovery | **6 PASS** |
| verify-execution-continuity | **8 PASS** |
| verify-ask-telegram-cleanup | **6 PASS** |
| verify-lastreal-buildsignal | PASS |
| model-selection-guard | **21 PASS** |
| commandcode-router | **51 PASS** |
| router exact-model | **9 PASS** |
| router native-multimodal | **25 PASS** |
| secret scan | CLEAN（ci-level4 L25 为测试假凭据） |
| gitignore assertion | PASS（.workbuddy/log/pem/key/credentials 全忽略） |
| Runtime | HTTP 200，服务 PID 10428，COMMIT_READY PASS |

**总计：Reliability 全套 + continuity 全套 + router/model/commandcode 全套全绿。**

## 7. PR / CI 治理

- 分支：`fix/phase01-review-r2`（push origin）
- **PR：#8** → main（https://github.com/ZTKyo/deepseek-harness-desktop/pull/8）
- **required checks（全部 PASS）**：
  - Static + secret + syntax gate：PASS（58s）
  - Reliability state machine tests：PASS（35s）
  - DSH boot + readiness smoke：PASS（7m25s）
- **Merge SHA**：`5c8eb1bb`（"Merge pull request #8"），main 已更新
- R2 途中修复记录（CURRENT）：
  1. ci-level1.yml Module import smoke 卡死 → 根因 `dsh-power-lease.ps1` 有 45min 主循环未进
     skip 列表 → 已加入 skip（commit 6984644）
  2. Test-RouterDeployRollback / deploy-router-fix 引用已归档的 docs/*/plugins 路径 → 更新为
     plugins/（commit da67f67）

## 8. Canonical ↔ Deployment hashes

- 12 个恢复文件：canonical（工作树）与 DSH-Client 部署内容一致（忽略行尾符比对 OK）
- plugins/ 24 个插件：与 Live ~/.dsh/profiles/web hash 一致（R1 已验证，未改动）

## 9. Rollback

- Checkpoint：`DSH-Client/_checkpoint-PHASE01-R2-20260823-142809`（Base b0f7d235 + 14 文件备份）
- 部署备份：`DSH-Client/_backup-phase01-r2-deploy-20260823-144145`
- git：`git reset --hard b0f7d235`（回 R1 状态）；或 checkout PR commit
- R1 Golden 已标记 REJECTED_CANDIDATE（保留历史，不引用）

## 10. Golden / Tag 状态

- **REJECTED_CANDIDATE**：`PHASE01_CANONICAL_GOLDEN` / `phase01-save-complete`（R1 含回退代码）
- **Candidate Golden（R2）**：`PHASE01_CANONICAL_GOLDEN_R2` / tag `phase01-save-r2`（待 Reviewer 审核）
  （PR merge 后建立）

## 11. 未完成项

- **NONE**（Phase 01 范围内；BACKLOG 见 §12）

## 12. BACKLOG（记录不执行）

- B1: Live ~/.dsh/profiles/web/cordis.patch.yml 仍硬编码 NOTION_TOKEN（部署机本地事实；长期可 env 注入）
- B2: cordis.patch.yml 机器特定路径（C:\Users\Administrator\...）可模板化（Phase 02 候选）
- B3: `execution-economy-v1`（2 独有 commit）、`feature/ox-alpha-multi-relay-fallback`（1 独有 commit）
  未合并，Phase 02/03 评估
- B4: CI 工作流仅 PR 触发，直接 push main 不触发检查（既有配置，R2 已走 PR 治理）

## 13. Self Audit

- **重复源码？** 已消除（CURRENT-4 关闭；plugins/ 与根目录 goal-recovery/event-notify 不再双份）
- **重复造轮子？** 否；复用既有 tests/reliability 全套 + continuity 全套
- **Authority 冲突？** 已修正（GitHub verified = canonical；Live 只作 deployment）
- **新冗余？** 无（新增 1 个 restart budget 测试填补验收缺口）
- **偏离原始 Phase？** 否；未做 Phase 02 架构合并，未新增后续功能

## 14. Final Verdict

**IMPLEMENTATION_COMPLETE**

（BLOCKING-1/2/3 与 CURRENT-4/5/6 全部关闭；Reliability 全套 + 原 Phase 01 全套回归 PASS；
PR/CI 治理执行；rollback 可用；等待外部审核）

## 15. Waiting For

**EXTERNAL_REVIEW**

（等待 99｜Reviewer Feedback 中 Reviewer Verdict；未获 APPROVED 前禁止进入 Phase 02，
禁止自行标记 VERIFIED）

---

*报告不可覆盖：复审修改将生成 REPORT_R3.md……*
