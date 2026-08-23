# PHASE_01_SOURCE_OF_TRUTH — REPORT_R1

> Phase 01：SAVE / Source of Truth Consolidation
> 日期：2026-08-23 ｜ 执行：Harness Master Orchestrator
> 报告路径：docs/roadmap/reports/PHASE_01_SOURCE_OF_TRUTH/REPORT_R1.md

---

## 1. Phase / 原始目标 / Acceptance Criteria

**原始目标**：建立唯一 Source of Truth，解决 Live Runtime、~/.dsh、DSH-Client、GitHub main、
Golden、报告之间的漂移。不追求新增功能，只做收口、对齐、清理、验证、Freeze。

**Acceptance Criteria（8 条）**：

| # | 标准 | 结果 |
|---|---|---|
| 1 | GitHub canonical source 与当前部署关键源码可一一追溯 | ✅ PASS（plugins/ 24 个 mjs 与 Live hash 全一致） |
| 2 | 不存在“报告说已修但 GitHub 无对应源码”的关键能力 | ✅ PASS（17 个缺失插件已补入 plugins/） |
| 3 | main 无明显 secret / log / temp / .workbuddy 污染 | ✅ PASS（NOTION_TOKEN 已脱敏；scan CLEAN；gitignore 补齐） |
| 4 | 关键 runtime 与 canonical hash/diff 关系明确 | ✅ PASS（hash 对比表见 §7） |
| 5 | relevant tests + runtime health PASS | ✅ PASS（243+ 项测试全绿；HTTP 200） |
| 6 | 新 Golden/checkpoint 可回滚 | ✅ PASS（PHASE01_CANONICAL_GOLDEN + tag phase01-save-complete） |
| 7 | Git working tree/branch 状态清楚 | ✅ PASS（fc181dd ahead 1，工作树干净，4 分支清理） |
| 8 | Self Audit 明确回答重复/真源/冲突/遗留漂移 | ✅ PASS（见 §12） |

## 2. Baseline

| 项 | 值 |
|---|---|
| DSH | 0.1.1-rc.2 |
| Node | 22.x（DSH-Client/node-runtime） |
| Base Commit | eec17de5eaafe27e9bca03e596a99fdcbcb88027 |
| Golden（前） | NEW_LOCAL_GOLDEN_P1_HARDENED（2026-08-23，HASHES.txt） |
| Runtime | 服务 PID 10428（start 08:35:19），notify sidecar PID 17440 |
| Canonical 仓库 | `_release-staging/` → ZTKyo/deepseek-harness-desktop |
| Deployment Target | DSH-Client/（守护/启动脚本）、~/.dsh/profiles/web/（插件） |

## 3. Gap Audit / 已复用能力 / 新增能力

### 发现的漂移（读真实环境，非历史报告结论）

| # | 漂移 | 证据 | 处置 |
|---|---|---|---|
| G1 | GitHub main **缺少 17 个 Live runtime 关键插件源码**（execution-continuity、goal-recovery、model-selection-guard、ask-telegram、agent-inspector、completion-notify、computer-use、secret-gate、keepalive-patch、commandcode-router 等） | gh api tree 对比 | 补入 plugins/（AC#2 核心修复） |
| G2 | **dsh-event-notify.mjs 旧实现**：GitHub 8283B vs Live 12055B（缺 P1-C single-flight reconnect + log rotation） | hash + diff | 同步新实现；旧版归档 |
| G3 | **openrouter-router.mjs 旧实现**：GitHub 17619B vs Live 19458B（缺 ROUTING_FAILURE_RE/PROVIDER_FAILURE_RE/QUALITY_FAILURE_RE/EMPTY_RESPONSE_RE 4 个失败分类正则 + session 推导 + empty-response failover） | hash + 非注释 diff 30 行 | 同步新实现；旧版归档 |
| G4 | **tool-output-offload.mjs 旧实现**：GitHub vs Live（缺 THRESHOLD_CHARS=8192 + recursiveChars） | diff 51 行 | 同步新实现；旧版归档 |
| G5 | **守护/启动脚本落后**：dsh-guardian.ps1、start-dsh-server.ps1、restart-dsh-server-delayed.ps1、DSH-Harness-PS.ps1、build.ps1、DSH-Client.ps1、4 个 cmd 启动器、README 全部 GitHub 旧版 vs DSH-Client 真实生效版 | hash 对比 | 同步 Live 真实版本（DSH-Client = Golden = Live 已确认） |
| G6 | **同功能多份副本**：docs/execution-economy/plugins/ 与 docs/lossless-token-optimization/plugins/ 各 2 份旧插件副本 | 文件树 | 归档至 docs/_archived/ |
| G7 | **docs/roadmap 不存在**：Master Orchestrator 状态入口缺失 | Test-Path | 建立 CURRENT_STATUS.md |
| G8 | **AI 入口缺失**：无 AI_CONTEXT.md / CURRENT_STATE.md | Test-Path | 建立 AI_CONTEXT.md |
| G9 | **.gitignore 未覆盖 .workbuddy/ 与运行日志** | grep | 补齐规则 |
| G10 | **cordis.patch.yml 硬编码真实 NOTION_TOKEN**（50 字符 ntn_ 开头）→ 提交将泄露到公开仓库 | secret scan | 改为 ${NOTION_TOKEN} 占位（CURRENT 修复） |
| G11 | tests/router/* 导入旧 canonical 路径 docs/execution-economy/plugins | 源码 | 迁移至 plugins/（测试 9+25 PASS） |
| G12 | 4 个 fully-merged 本地分支残留 | git branch | 删除 |

### 已复用能力（未重造）

- 既有 Golden 机制（NEW_LOCAL_GOLDEN_P1_HARDENED）复用为回滚基线
- 既有 CI 工作流（ci-level1~4）未改动，确认无旧路径引用
- 既有测试套件（crash-safe/fault-injection/WAITING_USER/compaction/model-guard/commandcode/router）全部复用并纳入 canonical

### 新增能力（仅收口必需）

- `plugins/` 目录：唯一 canonical 插件真源 + README（部署映射）
- `docs/roadmap/`：CURRENT_STATUS.md（状态入口）
- `AI_CONTEXT.md`：最简 AI 入口（Mission / Golden / Authority Map / Invariants / Read Next）
- `tests/continuity/`：连续性验证套件（8 个 verify 脚本从 Live 收口）
- `docs/_archived/`：旧副本归档区 + 指针 README
- PHASE01_CANONICAL_GOLDEN：pre-next-stage Golden + tag

## 4. 实际修改文件

- **新增（11 目录/文件）**：plugins/（27 文件）、docs/roadmap/（CURRENT_STATUS.md + reports/）、
  AI_CONTEXT.md、tests/continuity/（8 个 verify）、docs/_archived/（4 个旧副本 + 2 README）、
  goal-recovery.mjs、dsh-power-lease.ps1、telegram-alert.ps1、RELIABILITY_V1_SEAL_REPORT.md、
  OX_ALPHA_CONTINUATION_DIAGNOSIS.md、tests/execution-economy/（7 文件）
- **修改（31）**：.gitignore、DSH-Harness-PS.ps1、DSH-Client.ps1、build.ps1、README.md、
  4 个 cmd、dsh-guardian.ps1、start-dsh-server.ps1、restart-dsh-server-delayed.ps1、
  dsh-event-notify.mjs、dsh-context-budget.mjs、dsh-guardian-watchdog.ps1、dsh-healthcheck.ps1、
  dsh-diagnostics.ps1、dsh-readiness.ps1、dsh-safe-mode.ps1、dsh-transaction.ps1、
  dsh-plugin-transaction.ps1、dsh-verified-lastgood.ps1、dsh-restart-budget.ps1、
  dsh-clean-reclaim.ps1、dsh-process-identity.ps1、dsh-generation.ps1、dsh-credential-manager.ps1、
  dsh-vps-tunnel-loop.ps1、dsh-launcher.js、quota-widget.js、tests/router/*.mjs（2）
- **删除（4，归档）**：docs/execution-economy/plugins/ 与 docs/lossless-token-optimization/plugins/ 下 4 个旧插件副本

## 5. 删除、合并、保留的冗余

| 冗余 | 处置 |
|---|---|
| docs/execution-economy/plugins/{openrouter-router,openrouter-router-core,vision-bridge}.mjs | 归档（被 plugins/ 替代） |
| docs/lossless-token-optimization/plugins/tool-output-offload.mjs | 归档 |
| 仓库根旧 dsh-event-notify.mjs / dsh-guardian.ps1 / start-dsh-server.ps1 等（GitHub 旧版） | 同步为新版，旧版备份于 docs/_archived/legacy-root-scripts/ |
| 4 个 fully-merged 本地分支 | 删除（远端保留） |

## 6. Authority Before / After

| 职责 | Before | After |
|---|---|---|
| 运行时插件源码 | 分散 3 处：Live(~/.dsh)、DSH-Client、docs/*/plugins（漂移） | **唯一：plugins/**（部署到 ~/.dsh/profiles/web） |
| 守护/启动脚本 | GitHub 根（旧）vs DSH-Client（新）双份 | **唯一：仓库根**（同步自 DSH-Client Live 版本） |
| 状态入口 | 无 | **唯一：docs/roadmap/CURRENT_STATUS.md** |
| AI 入口 | 无 | **唯一：AI_CONTEXT.md** |
| Golden | NEW_LOCAL_GOLDEN_P1_HARDENED（本地） | + PHASE01_CANONICAL_GOLDEN（tag phase01-save-complete） |

## 7. 新问题分类：CURRENT / BLOCKING / BACKLOG

**CURRENT（已修复）**
- C1: cordis.patch.yml 硬编码真实 NOTION_TOKEN → 已改为 ${NOTION_TOKEN} 占位（防公开泄露）

**BLOCKING（无）**

**BACKLOG（记录不执行）**
- B1: Live ~/.dsh/profiles/web/cordis.patch.yml 仍保留硬编码 NOTION_TOKEN（部署机本地事实，
  不进入 Git；后续可改为 env 注入）
- B2: cordis.patch.yml 含机器特定路径（C:\Users\Administrator\...），对他人不可用但非凭据；
  长期可模板化（Phase 02 候选）
- B3: 远端分支 sync/audit-20260823（2 个临时同步 commit，无 merge base）与 reliability-v1
  （14 个未合并 commit）未删除——保守保留，待 Reviewer/Phase 02 决策
- B4: execution-economy-v1 / feature/ox-alpha-multi-relay-fallback 有独有 commit 未合并，
  Phase 02/03 评估
- B5: 历史报告 OPENROUTER_EXACT_MODEL_PRESERVATION_REPORT.md 中“canonical=docs/execution-economy/plugins”
  的旧声明保留原文（报告不可覆盖原则），以本报告为准

## 8. Tests / Regression / Runtime Evidence / Production Evidence

| 测试 | 结果 |
|---|---|
| execution-continuity-crashsafe-test | **33 PASS / 0 FAIL** |
| execution-continuity-faultinjection-test | **38 PASS / 0 FAIL** |
| verify-waiting-user-gate | **12 PASS** |
| verify-compaction-scope | **15 PASS** |
| verify-nonrecoverable-states | **19 PASS** |
| verify-multitask-recovery | **6 PASS** |
| model-selection-guard-test | **21 PASS** |
| verify-execution-continuity | **8 PASS** |
| verify-ask-telegram-cleanup | **6 PASS** |
| verify-lastreal-buildsignal | PASS |
| commandcode-router-test | **51 PASS** |
| tests/router/test-exact-model-preservation | **9 PASS**（迁移后新路径） |
| tests/router/test-deepseek-native-multimodal | **25 PASS**（迁移后新路径） |
| **Runtime Health** | **HTTP 200**；服务 PID 10428；notify sidecar PID 17440；notify-events.log 正常轮转 |
| **Git Clean** | fc181dd ahead 1；工作树干净；无日志/凭据/temp 被追踪 |

**G 项（Checklist G）专项审计**：execution-continuity-crashsafe-test.mjs 中 L204 的
`{0,600}` 是源码结构断言（检查 recoverable 循环内调用 resumeViaApi），非状态码弱化；
分类器断言含 REASONING_PROTOCOL_ERROR 优先级、429/401 映射，语义严格。git 历史无
“400→600”弱化修改记录。**未发现测试削弱**。

## 9. Rollback

- **Golden 快照**：DSH-Client/_release-staging/PHASE01_CANONICAL_GOLDEN/（29 文件 + HASHES.txt + Manifest）
- **Git tag**：`phase01-save-complete`（`git reset --hard phase01-save-complete`）
- **旧版备份**：docs/_archived/legacy-root-scripts/（5 个旧脚本）+ docs/_archived/plugins/（4 个旧插件）
- **Checkpoint**：DSH-Client/_checkpoint-PHASE01-20260823-132019/（Base eec17de + Live 插件备份 23 文件）

## 10. Result Commit / Candidate Golden

- **Result Commit**：`fc181dd`（phase01(save): source of truth consolidation…）
- **Candidate Golden**：`PHASE01_CANONICAL_GOLDEN`（tag `phase01-save-complete`）
- 上推：push 至 origin/main 后 tag 同步

## 11. 未完成项

- **NONE**（Phase 01 范围内全部完成；BACKLOG 见 §7，不阻塞）

## 12. Self Audit

- **重复源码？** 否。plugins/ 唯一真源；旧副本全部归档；仓库根与 plugins/ 的 dsh-event-notify
  双份已收口（根目录保留新实现 + plugins/ 副本，README 说明关系）
- **重复造轮子？** 否。复用全部既有测试/Golden/CI
- **Authority 冲突？** 已消除（§6 Authority Map）
- **新冗余？** 无。唯一新增目录均为“唯一真源”或“归档区”
- **偏离原始 Phase？** 否。未做 Phase 02 架构合并，未新增 Task Engine/Learning/VPS 功能

## 13. Final Verdict

**IMPLEMENTATION_COMPLETE**

（8 条 Acceptance Criteria 全部 PASS；无 Blocking Issue；rollback 可用；Git 状态清晰；
243+ 项测试全绿；Runtime Health OK）

## 14. Waiting For

**EXTERNAL_REVIEW**

（等待 99｜Reviewer Feedback 中 Reviewer Verdict；未获 APPROVED 前禁止进入 Phase 02，
禁止自行标记 VERIFIED）

---

*报告不可覆盖：复审修改将生成 REPORT_R2.md、REPORT_R3.md……*
