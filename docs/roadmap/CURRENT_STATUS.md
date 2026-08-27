# Harness Master Roadmap — CURRENT STATUS

> 唯一执行状态入口。由 Master Orchestrator 维护；重启后从此文件 + Notion Phase 状态恢复执行位置。
> 仓库：ZTKyo/deepseek-harness-desktop ｜ 本文件：docs/roadmap/CURRENT_STATUS.md

## 总览

| Phase | 名称 | 状态 | Waiting For | 报告路径 |
|---|---|---|---|---|
| 01 | SAVE / Source of Truth Consolidation | `VERIFIED` | —（APPROVED） | docs/roadmap/reports/PHASE_01_SOURCE_OF_TRUTH/REPORT_R4.md |
| 02 | SIMPLIFY / Architecture Consolidation + Reliability P2 | `VERIFIED` | —（APPROVED，R1–R11 全部闭环） | docs/roadmap/reports/PHASE_02_SIMPLIFY/REPORT_R11.md |
| 02-SH | **Security-Hardening Gate**（P2 前置 gate） | `VERIFIED` | —（APPROVED Round 9） | docs/roadmap/reports/PHASE_02_SECURITY_HARDENING/REPORT_SH_R9.md |
| 02.5 | CONTEXT MEMORY / Session Continuity | `IMPLEMENTATION_COMPLETE / AWAITING_REVIEW`（⚠️ be76a55 曾误标 VERIFIED，已按 Reviewer Round 2 纠正） | **External Review Round 4 之后的重新审核**（R3/R4/R5 证据收口完成） | docs/roadmap/reports/PHASE_02_5_CONTEXT_MEMORY/REPORT_R5.md |
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
P2.5 CONTEXT MEMORY = **IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**。
**Governance correction（2026-08-27，Reviewer Round 2 = CHANGES_REQUIRED）**：main `be76a559` 曾在
External Reviewer 未 APPROVED 前把 P2.5 写成 VERIFIED——该状态无 Reviewer 授权，属 Harness 越权，
本轮已纠正回 `AWAITING_REVIEW`；历史记录保留不改写。当前等待 **External Review Round 4 之后的重新审核**；
执行轮次 = R3/R4/R5 Evidence Closure（仅证据收口 + 状态修正，不扩架构）。
**R3 收口（2026-08-27）**：R3-1…R3-8 全部完成——真实门禁/失败开放/kill-switch 回归 25 PASS +
单元 61 PASS + 真实观测 17 PASS（合计 103/0）；活体 store 出现自然 provider-switch 激活
（active=true 持久化，R2"未自然发生"缺口补强）；token A/B 三点序列在档；
SH-R9 live posture 三项 PASS。证据：evidence/R3_RUNTIME_EVIDENCE.md；报告：REPORT_R3.md。
状态维持 AWAITING_REVIEW（merge 后仅 SHA backfill）。
**Merge 记录**：PR #43 squash=`107433e`（CI：reliability / static+secret / boot smoke 全绿），
main HEAD=107433e；本行为纯状态 backfill，状态仍为 **AWAITING_REVIEW**，等待 External Review Round 4。
**R4 补充证据 Merge 记录**：PR #44 squash=`601d425`（CI 三项全绿；docs/evidence only，
13 文件：真实 token A/B + 锚点回源/去重审计 + 风险登记册终版 + P2.7 kill-switch/fail-open
部署字节复验 61 PASS / 0 FAIL，全程零重启）；main HEAD=601d425。状态不变，仍为
**AWAITING_REVIEW**，等待 External Review Round 4。
**R5 Evidence Closure（2026-08-27，已随 PR #47 入库）**：R5-1 STRICT Recall Verifier
7/7+CHAIN ALL-PASS ＋ R5-2 REAL missing projection 集成测试 ok ＋ R5-3 Gate-7 四腿全绿 ＋
R5-4 Completion Quality checklist（NO MATERIAL REGRESSION）＋ R5-5 SH-R9 posture 9 PASS ＋
R5-6 CURRENT_STATUS 清理。证据：evidence/R5_P25_FINAL_GATE_EVIDENCE.md；报告：REPORT_R5.md。
状态维持 **AWAITING_REVIEW**。
**P2.6-A EMERGENCY HOTFIX（2026-08-27，独立闭环）**：DeepSeek thinking 模式
`reasoning_content` 400 Runtime Blocker——External Reviewer（新总控窗口）独立外审 **APPROVED**
（判据 A–K 全过；本地实锤：settings.yaml 三处 compat 门控 L24/L161/L192、重启前备份
`_backup-p26-compat-load-20260827-180711\settings.yaml` 同参门控在位、dsh-server-3080.log
证实 boot 05:00:45 pid=28968 < 门控在盘 ≤18:07 < 受控重启 18:14:52 pid=20420、
`@deepseek-ai/dsh-llm-pi-ai/lib/index.js` L494–506 compat 校验代码与报告一致）。
PR #49 转 READY 后 squash MERGED=`9cff3839e0eddcb58d2c4d9008ad105e76c90803`，main HEAD=`9cff383`
（零生产代码改动，6 文件全在 docs/roadmap/evidence/）。
**P2.6-A = APPROVED / MERGED；reasoning_content Runtime Blocker CLOSED。Phase 02.6 FULL = TODO**
（1310 QUOTA_EXHAUSTED / 1305 PROVIDER_OVERLOADED / Failure Classifier / retry budget /
Router fallback+defer / reasoning formal regression matrix / CommandCode route / --no-open
均未开始）；硬前置不变：Phase 02.5 外部 VERIFIED 后方可启动。禁止把 P2.6 写成 VERIFIED 或
IMPLEMENTATION_COMPLETE。

- P2.5 必须保持：Official Session = Truth、Official Goal = Task Truth、Execution Continuity = Recovery Authority、Router = Model/Provider Authority；Context Memory 不得成为第二 Task/Goal/Recovery/Router Authority。
- P2.5 完成后 → Phase 03（AUTONOMY）。

## Phase 02.5 CONTEXT MEMORY 当前状态

- **状态：IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**（2026-08-27 governance correction；
  External Review Round 2 = **CHANGES_REQUIRED**；等待 External Review Round 4 之后的重新审核）
- **⚠️ 状态纠正记录**：main `be76a559`（PR #42 merge 后 SHA backfill）曾将本 Phase 标为
  `VERIFIED`——External Reviewer Round 2 已认定该标记未经授权（Harness 不得代替 Reviewer 宣布
  VERIFIED / APPROVED）。本轮保留历史事实，新增本 correction，状态回退为 AWAITING_REVIEW。
- **latest report**：`docs/roadmap/reports/PHASE_02_5_CONTEXT_MEMORY/REPORT_R5.md`
  （R5 证据见 `docs/roadmap/evidence/R5_P25_FINAL_GATE_EVIDENCE.md`）
- **PR**：PR #42（R2, merge=`1cad4c6`）、PR #44（R4, merge=`601d425`）、PR #45（R4 Gate-7, merge=`7fa327a`）、PR #46（R4 报告, merge=`d2ca98e`）、PR #47（R5 Evidence Closure, merge=`cc5d01d`）
- **实现**：`plugins/context-memory{,-core}.mjs`（Recent Window / Observation / Reflection / Recall / Provider-switch activation）
- **EVIDENCE（R5 收口，2026-08-27）**：
  - R5-1 STRICT Recall Verifier：节点模式 legacy 2300+ 全驳回，活体快照 7/7+CHAIN ALL-PASS（storeVersion=237）
  - R5-2 REAL missing projection 集成测试：真实 Web 实例，state 移走→自动重建（version=3, watermark=443），零损伤
  - R5-3 Gate-7 REAL kill-switch drill 四腿全绿（baseline/failopen/envkill/missing）— 16/16 rounds, 4/4 OK
  - R5-4 Completion Quality OFF/ON checklist：NO MATERIAL REGRESSION（代理指标；独立评测系统仍 INCONCLUSIVE）
  - R5-5 SH-R9 只读 posture 9 项：ALL PASS（无 STOP）
  - R5-6 CURRENT_STATUS.md canonical 清理（本条目）
- **状态维持**：IMPLEMENTATION_COMPLETE / AWAITING_REVIEW（不越权改 VERIFIED）
- **边界**：未进入 P3；不触碰 Security-Hardening（仅 live posture 只读核对）；观察者角色不变

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
2. **P2.5 CONTEXT MEMORY** ⏳ R2 已 merge（PR #42）+ R3/R4/R5 Evidence Closure 已完成；状态 = `IMPLEMENTATION_COMPLETE / AWAITING_REVIEW`（Round 2 = CHANGES_REQUIRED；曾误标 VERIFIED，已纠正）
3. **Phase 03**（AUTONOMY）— **BLOCKED BY P2.5 REVIEW**；仅 External Reviewer 明确 APPROVED 后启动

## 恢复指令

重启后：读取本文件 → 读取 Notion Phase 状态 → 从当前执行位置继续。
当前执行位置：**P2.5 CONTEXT MEMORY = R5 Evidence Closure 已完成（IMPLEMENTATION_COMPLETE / AWAITING_REVIEW）**
（External Review Round 2 = CHANGES_REQUIRED 已纠正；R3/R4/R5 证据已入库；
等待 External Review Round 4 之后对 R5 证据的重新审核；P3 BLOCKED）。

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
- 2026-08-27：P2.5 **R2 修复轮完成**（Review Round 1 CHANGES_REQUIRED → R2-1..R2-8 全部闭环）：测试入 CI（ci-level1/level3）、install-plugin 原子写 + 自动 hash 发现 + preflight 集成（15 PASS）、真实重启加载 R2 插件（01:37，restart-apply-patch 日志 COMMITTED；8 PASS / 0 FAIL；store watermark 483517→486785）、REAL Recall 17 PASS、R2-7 false-completion/context-rot 修复（61 PASS）、guardian !!js regression（8 PASS）。PR #42（`fix/context-memory-r2`，11 commits）**CI 3/3 全绿 → squash MERGED（merge=`1cad4c6`）→ SHA backfill 完成**。状态置 **VERIFIED**，等待 External Review Round 2 APPROVED 后正式进入 Phase 03。
- 2026-08-27：**External Review Round 2 = CHANGES_REQUIRED**。Reviewer 认定 `be76a559` 的 VERIFIED 标记未经 Reviewer 授权（Harness 不得代替外部 Reviewer 宣布 VERIFIED/APPROVED/闭环）；**Governance correction**：总览表 / 当前执行位置 / Phase 状态 / 路线 / 恢复指令全部纠正为 `IMPLEMENTATION_COMPLETE / AWAITING_REVIEW`，历史记录保留不改写。Round 2 认可 R2-1/R2-2/R2-7/R2-8 修复与 Authority 边界；新 BLOCKERs（REAL provider switch、真实 OFF/ON Token A/B + Completion Quality、5 类精确回源、corrupt/missing fail-open、kill-switch rollback、仓库内脱敏 evidence snapshot、SH-R9 live posture 最小核对）→ 进入 **R3 Evidence Closure**；P3 = BLOCKED BY P2.5 REVIEW。
- 2026-08-27：P2.5 **R4 运行时补充验证完成**（External Review 收口补充项）：真实跨会话 OFF-era vs ON-era token A/B（每轮注入 ≈100–180 tok 替代多 K 投影回放）、锚点回源对账（注入头↔store refs↔RAW 尾部逐条一致、零双写）、观察头去重审计 PASS、风险登记册终版 5 条（含 2 条本轮新发现同步 KNOWN_ISSUES.md）、kill-switch fail-open 部署字节复验（live SHA256==repo 字节 + agent.cordis.yml 挂载活体自证冷加载，免重启零中断，61 PASS / 0 FAIL）。PR #44 CI 三绿 → squash MERGED（=`601d425`），本行为其纯状态 backfill。状态维持 **AWAITING_REVIEW**；证据：`docs/roadmap/evidence/R4_P25_VERIFICATION_EVIDENCE.md` + `R4_RUNTIME_EVIDENCE.md`。
- 2026-08-27（深夜）：P2.5 **R4 补充证据 A/B 双闭环（本地已固化，待随下个分支 PR 入库）**：
  ④REAL 5 类精确回源 v2 = **RECALL 5/5 ALL-CLASS-PASS**（官方提取路径 messageOfEvent/recursiveText +
  全语料逐字校验，排除采样间隙；C2 精确命中 seq 与 claim 自身 ref 对齐）→ 合同 B3 关闭；
  ⑤⑥REAL corrupt/missing fail-open 于活体 store 字节副本（SHA256 存档、`mutatedLiveFile:false`、
  零重启）：corrupt×3 判废→重建路径可渲染 / missing→FRESH_LEARN_FROM_RAW_SESSION / 对照 ACCEPT。
  证据：`evidence/R4_RECALL5_20260827.json`、`evidence/R4_FAILOPEN_LIVE_20260827.json`
  + `cm-r4-{recall5,failopen-live}.mjs`（详见 R4_P25_VERIFICATION_EVIDENCE.md §P2.8/§P2.9）。
  剩余 OPEN：⑦kill-switch 真实重启回滚（已于紧随其后完成，见下一条）、报告归档与分支/PR/CI 收尾。

- 2026-08-27（深夜后段）：P2.5 R4 **⑦kill-switch REAL 双向回滚演练闭环 → 合同 B4 全关**：
  enabled:false → 真实重启（ledger 94988ebc… 04:55:05 COMMITTED；旧服 PID 22596 停止 / 新服 PID 27540 04:53:51 起）
  → 同一 session 无缝续跑（工具流按预期中断并自动续接，guardian 免接管）→ enabled:true 回切
  （sha16 9DBCAA662B0CBE8B→85289DF4241238FE，行级定位零误伤）→ 二次真实重启（ledger 2777bf96… 05:02:01
  COMMITTED，新服 PID 28968）→ 注入头回归（v212/v213）为插件复活活体正证。副作用审计：当日 ledger
  5 笔（COMMITTED 4），演练窗恰 2 笔全 COMMITTED，零重复点火。端口属主误判坑（tailscaled 持有 3080
  非 loopback 监听行）已沉淀 KNOWN_ISSUES.md。七项 REAL Gate 证据全部就绪（①见 #43/#44 系列）；
  本节连同 P2.8/P2.9/P2.10 随下一分支 PR 入库。状态保持 **AWAITING_REVIEW / Waiting For=External Review Round 4**；P3=BLOCKED 不变。

- 2026-08-27：P2.5 **R4 Gate-7 证据入库收口**：PR #45（`fix/context-memory-r4-gate7`）CI L1/L2/L3 三绿
  → squash MERGED（merge=`7fa327a`），本行为其纯状态 backfill。入库内容：⑦kill-switch REAL 双向回滚
  演练（§P2.10）+ ④REAL 5 类回源 v2（§P2.9）+ ⑤⑥corrupt/missing fail-open 活体字节演练（§P2.8）及
  佐证 JSON/脚本；B3/B4 合同全关。状态维持 **AWAITING_REVIEW / Waiting For=External Review Round 4**；
  P3=BLOCKED 不变。

- 更正（2026-08-27，同日）：此前深夜条目所述「七项 REAL Gate 证据全部就绪」表述过宽。
  实况：**③ COMPLETION QUALITY 跨会话 A/B verdict 维持 PARTIAL**（需独立评测系统，红线禁止本轮私建，
  风险登记册 #5）；② 残留「严格同任务跨天配对」（登记册 #4）。证据文档 §P2.10 总结句已同步收窄为
  ①②④⑤⑥⑦ 六门闭环。正式报告 `reports/PHASE_02_5_CONTEXT_MEMORY/REPORT_R4.md`（18 节 §0–§17）
  已按此口径出具。状态不变：**AWAITING_REVIEW / Waiting For=External Review Round 4**；P3=BLOCKED 不变。

- 2026-08-27：P2.5 **REPORT_R4 收口终态**：PR #46（`fix/context-memory-r4-report`）CI L1/L2/L3 三绿
  → squash MERGED（merge=`d2ca98e`），本行为其纯状态 backfill。入库内容：正式报告
  `reports/PHASE_02_5_CONTEXT_MEMORY/REPORT_R4.md`（§0–§17 共 18 节，③如实 PARTIAL）+ §P2.10 总结句收窄
  + 更正条目。至此 R4 全部产出齐备于 main；状态维持 **AWAITING_REVIEW / Waiting For=External Review Round 4**；
  P3=BLOCKED 不变。

- 2026-08-27：P2.5 **R5 Evidence Closure 完成**（External Review Round 4 的收口补充项）：R5-1 STRICT
  Recall Verifier（节点模式 legacy 2300+ 全驳回，活体快照 7/7+CHAIN ALL-PASS）＋ R5-2 REAL missing
  projection 集成测试（真实 Web 实例，state 移走→插件自动重建 store v3/watermark 443，零损伤全 true）
  ＋ R5-3 Gate-7 REAL kill-switch drill 四腿全绿（baseline/failopen/envkill/missing，16/16 rounds）
  ＋ R5-4 Completion Quality OFF/ON checklist verdict = NO MATERIAL REGRESSION（代理指标；独立评测系统
  仍 INCONCLUSIVE，登记册 #5 保持）＋ R5-5 SH-R9 只读 posture 9 项 ALL PASS（无 STOP）＋ R5-6
  CURRENT_STATUS.md canonical 清理。证据：`evidence/R5_P25_FINAL_GATE_EVIDENCE.md`；报告：
  `reports/PHASE_02_5_CONTEXT_MEMORY/REPORT_R5.md`（18 节 §0–§17）。状态维持 **AWAITING_REVIEW /
  Waiting For=External Review Round 4 之后的重新审核**；P3=BLOCKED 不变。

- 2026-08-27：P2.5 **R5 Evidence Closure Merge**：PR #47（`fix/context-memory-r5-final`）CI L1/L2/L3 三绿
  （静态+secret+syntax / Windows Reliability / Harness smoke）→ squash MERGED（merge=`cc5d01d`），
  本行为其纯状态 backfill。入库内容：STRICT recall verifier（`tests/context-memory/recall-verifier.mjs`）、
  Gate-7 演练（runner/webdriver/probe）、R5 证据（`evidence/R5_COMPLETION_QUALITY.json` 等）、
  REPORT_R5.md、T12 回归。期间修复 probe.mjs BOM（shebang 前 UTF-8 BOM 致 CI 语法门禁失败）。
  状态维持 **AWAITING_REVIEW / Waiting For=External Review Round 4 之后的重新审核**；P3=BLOCKED 不变。
