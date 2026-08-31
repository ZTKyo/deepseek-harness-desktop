# Harness Master Roadmap — CURRENT STATUS

> 唯一执行状态入口。由 Master Orchestrator 维护；重启后从此文件 + Notion Phase 状态恢复执行位置。
> 仓库：ZTKyo/deepseek-harness-desktop ｜ 本文件：docs/roadmap/CURRENT_STATUS.md

## 总览

| Phase | 名称 | 状态 | Waiting For | 报告路径 |
|---|---|---|---|---|
| 01 | SAVE / Source of Truth Consolidation | `VERIFIED` | —（APPROVED） | docs/roadmap/reports/PHASE_01_SOURCE_OF_TRUTH/REPORT_R4.md |
| 02 | SIMPLIFY / Architecture Consolidation + Reliability P2 | `VERIFIED` | —（APPROVED，R1–R11 全部闭环） | docs/roadmap/reports/PHASE_02_SIMPLIFY/REPORT_R11.md |
| 02-SH | **Security-Hardening Gate**（P2 前置 gate） | `VERIFIED` | —（APPROVED Round 9） | docs/roadmap/reports/PHASE_02_SECURITY_HARDENING/REPORT_SH_R9.md |
| 02.5 | CONTEXT MEMORY / Session Continuity | `VERIFIED`（**External Review Round 10 = APPROVED**，2026-08-28；P2.5 封板，不再 Round 11。历史：be76a55 曾误标 VERIFIED，已按 Reviewer Round 2 纠正） | —（APPROVED；R3–R5.1-F 证据链闭环，见时间线） | docs/roadmap/reports/PHASE_02_5_CONTEXT_MEMORY/REPORT_R5.md ＋ R5_1_D_FINAL_TRUTH_CLOSURE.md ＋ R5_1_F_FINAL_VERACITY_CLOSURE.md |
| 02.6 | RETRY SEMANTICS / Provider Failure Classification | `VERIFIED`（**External Review Round 3 = APPROVED**，2026-08-29；Round 4 = NONE；canonical main=a332ebc、classifier=2ea1059f、全量回归 136/0。historical：批准前曾为 IMPLEMENTATION_COMPLETE（R1+R1.1+R2+R3+R3-A1+R1.2）/ AWAITING_EXTERNAL_REVIEW ROUND 3；R1 PR #59 merged；R1.1/R2/R3/R3-A1/R1.2 合入 PR #60 merged=f0a6c47 2026-08-28、PR #61 merged=a332ebc 2026-08-28；事务化部署+受控重启加载完成 2026-08-29） | —（APPROVED；Waiting For = NONE） | docs/roadmap/reports/PHASE_02_6_RETRY_SEMANTICS/P26_R1_FAILURE_TAXONOMY_REPORT.md ＋ P26_R1_1_MANAGED_DIRECT_QUOTA_REPORT.md ＋ P26_R1_2_FINAL_CLOSURE_REPORT.md |
| 02.75 | SUPERVISOR / ChatGPT → Harness Control Plane | `VERIFIED`（**外部评审 Round 3 = APPROVED（2026-08-29 Reviewer 裁决）→ VERIFIED AUTHORIZED；Round 4 = NONE；production code 封板**。历史（保留不改写）：R1 实施收口＝零核心修改纯插件层（supervisor-bridge/core/test），T1–T14 14/14 + REAL E2E 26/26，PR #63 merged=f2d94f9。R1.1＝Round 1 verdict（CHANGES_REQUIRED）合同 A/B/C 全落地（零新增功能）：A replay-safe mutations（canonical request hash 幂等＋M1–M12）；B 生命周期/证据面扩展＋stale generation 409；C CI 三层接线（L1 T1–T30／L2 M 套件／L3 isolated real E2E 3-phase）——PR #65 merged=ad3fac4，三步骤级全绿。R1.2＝Round 2 verdict（CHANGES_REQUIRED）唯一 Blocker「DISPATCH IDEMPOTENCY PAYLOAD IDENTITY」闭环：receipt 携带 `dispatchFingerprint`（SHA-256 canonical normalized contract，排除时间戳/runId/sessionId/PID/端口/随机值）；同 key 同指纹→duplicate 零副作用、异指纹→409 idempotency_conflict 零副作用、legacy 无指纹→fail-closed、重启后指纹持久——PR #67 merged=**4fae42f**，CI L1/L2/L3 全绿（run 33243204206/33243204210/33243204229）。事务化部署（先备份 .bak-r12，部署字节==canonical blob 全 MATCH）＋受控重启已加载 **v0.2.2**（health identity sha256==部署字节 bridge a43d4cd6…/core 59e3b5df…；错 token 401/对 token 200；ledger 记账 FAILED 与实际健康终态偏差已如实记录）；重启后回归 mutation 19/0＋supervisor CI E2E ALL PHASES PASS＋P2.6 八套件 136/0＋P2.5 72/0，合计 0 失败 | NONE（Round 3 APPROVED；Round 4 = NONE；**Next = ChatGPT Client Binding → P3 bootstrap**） | docs/roadmap/reports/PHASE_02_75_SUPERVISOR/DESIGN_R1.md ＋ REPORT_R1.md ＋ P275_R1_1_ROUND2_CLOSURE.md ＋ P275_R1_2_ROUND3_CLOSURE.md |
| 02.75-HF1 | SUPERVISOR CORRECTION INJECTION HOTFIX R1 | `VERIFIED`（**External Review = APPROVED**，2026-08-31；Supervisor review_goal PASS 已记录 → sg-15fc877d… = VERIFIED / gen 4 / pendingMutation=null；PR #77 merged=dd7c12d，CI 三 gate 绿 run 33315517720/33315517734/33315517743；真实 E2E 链 pre 15/15 → post CI 16/16 → post full 18/18 → canonical 三阶段 81/81；部署 SHA 三方一致 bridge 057bbc0f… / core 59e3b5df…；3 条 NON-BLOCKING OBSERVATION 在档 REPORT_R1.md §7） | —（APPROVED；Waiting For = NONE；Next = Phase 02.8 仅记录未启动） | docs/roadmap/reports/SUPERVISOR_CORRECTION_HOTFIX/REPORT_R1.md |
| 03 | AUTONOMY / Task Autonomy | `AWAITING_EXTERNAL_REVIEW`（R1 实现收口 2026-08-30：IntentStore schema v3 autonomy 元数据 + autonomy_report/verify/state 三工具 + 恢复注入 composeResumeMessage + 无人值守决策策略；测试 54+32 断言 + EC 20 套件回归全绿；**三条真实 Runtime E2E 证据齐** E1 8/8 / E2B 7/7 / E3 8/8×2，隔离实例非 mock；期间根因修复重启自动恢复 happy path——CT 内存未命中回退 session.history 持久日志冷读，RESTART_RESUME_REPAIR.md；诚实发现 F1=verify 信任模型自述证据串（R2 候选宿主侧复核）→ **R1 Correction 修复（同日）**：file_hash/system_api 两类 PASS 证据强制宿主确定性复核（真实文件 sha256 比对 / 127.0.0.1 回环 API 断言），伪造或不匹配 fail-closed 降级 UNVERIFIED（零里程碑/零 checkpoint），PASS 记录带 HOST-VERIFIED 前缀；core 86/0＋已部署面 52/0（新增 I10-I15 含真实回环 API 三态）＋真实 E2E 四腿 E1/E2/E2B/E3 32/0 全绿；REPORT_R1C.md；R1 部署面 SHA256==仓库 + 受控重启 + 重启后工具面活体证据；R1C 部署 SHA256==仓库（回滚锚点 _pre-p3r1c-*），随下次受控重启生效；pre-existing 10 插件 profile 部署漂移已登记 KNOWN_ISSUES（专项待办，非本引入）） | External Review（R1 verdict 待裁决；F1 定级与 R2 范围由 Reviewer 判定） | docs/roadmap/reports/PHASE_03_AUTONOMY/REPORT_R1.md ＋ R1_VERIFICATION.md ＋ RESTART_RESUME_REPAIR.md ＋ e2e/ |
| 04 | LEARN / Autonomous Learning | 未开始 | — | — |
| 05 | RESTORE / Disaster Recovery | 未开始 | — | — |
| 06 | ALWAYS-ON / VPS Runtime | 未开始 | — | — |

## Authority 声明

- **代码真源 = GitHub verified main / tag**（ZTKyo/deepseek-harness-desktop）
- **Runtime = deployed truth**；冲突按 commit/history/Golden/语义/测试裁决
- 详见 `AI_CONTEXT.md`（冲突裁决原则）

## 当前执行位置

Security-Hardening Gate = **VERIFIED**（外部审核 Round 9 = APPROVED，PR #40 merged）。
P2.5 CONTEXT MEMORY = **VERIFIED**（External Review **Round 10 = APPROVED**，2026-08-28；P2.5 封板，不再 Round 11）。
**Governance correction（2026-08-27，Reviewer Round 2 = CHANGES_REQUIRED）**：main `be76a559` 曾在
External Reviewer 未 APPROVED 前把 P2.5 写成 VERIFIED——该状态无 Reviewer 授权，属 Harness 越权，
本轮已纠正回 `AWAITING_REVIEW`；历史记录保留不改写。
**Round 10 APPROVED（2026-08-28，PURE STATUS BACKFILL）**：External Reviewer 正式 APPROVED Phase 02.5
（canonical main=`326a6a42`，R5.1-F PR #56 head=`702fb812` squash merge=`f745865`，CI L1/L2/L3 全绿；
Completion Quality V6 INCONCLUSIVE 明确非 blocker；SH-R9 V6 无 Runtime/Security blocker；Notion/Canonical
已一致）。授权仅做：状态 backfill（AWAITING_REVIEW → **VERIFIED**）+ Last Good 术语口径修正
（guardian-lastgood = restore mirror，非 canonical）+ Notion latest review 清理；不改历史 evidence；
不重跑 REAL Gate；不再允许 P2.5 Round 11。Phase 02.6 RETRY SEMANTICS 为下一 Phase（FULL 仍 TODO）。
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
**P2.6 R1 IMPLEMENTATION_COMPLETE（2026-08-28，PR #59 squash merged）**：上段"禁止
IMPLEMENTATION_COMPLETE"为 R1 未开始时的前置约束，现按 R1 目标授权解除（VERIFIED 仍禁止
自标，须 External Review 授权）。R1 交付：Failure Taxonomy V1 观测层（failure-classifier，
9 类 3 轴 + 归一化签名，evidence-only 红线：不改 payload.failure/不加会话事件/不重试/
不选模型，异常全隔离）+ EC 语义升级（classifyFailure 单一真源委托；QUOTA_EXHAUSTED
same-route retry=0 + unavailableUntil defer 预算 10/h；stream 瞬态不再误触发
context-recovery）+ 复用既有 EC retry budget 与 Router fallback authority（零第二引擎）。
验证：classifier-v1 31/31、quota-defer 18/18、network-error 20/20、rollback 单开关
enabled=false 恢复 pre-R1 全 PASS、r8 attestation 三端哈希一致、事务化部署 5/5
（p26-r1-20260828112927-7b5d14fc）。受控 E2E（真实管线，2026-08-28 13:35-13:52）：死端口
注入 bai 路由 → classifier 17+ 条 NETWORK_TIMEOUT_5XX/TRANSPORT 正确分类 → EC bounded
retry 退避（15→18）→ WAITING_PROVIDER defer → RECOVERY_QUEUED 冷却 → RESUME goal
re-armed（cycles 8→10）→ 同 Session 续跑成功，零数据丢失。状态 =
**IMPLEMENTATION_COMPLETE / AWAITING_EXTERNAL_REVIEW，停等 External Review Round 1**。

- P2.5 必须保持：Official Session = Truth、Official Goal = Task Truth、Execution Continuity = Recovery Authority、Router = Model/Provider Authority；Context Memory 不得成为第二 Task/Goal/Recovery/Router Authority。
- 前向链（canonical）：P2.5 外部 VERIFIED → Phase 02.6 RETRY SEMANTICS（硬前置=P2.5 外部 VERIFIED）→ Phase 02.75 SUPERVISOR（硬前置=02.6 VERIFIED）→ Phase 03 AUTONOMY（前置=P2.75 VERIFIED）→ 04 LEARN → 05 RESTORE → 06 ALWAYS-ON。

## Phase 02.6 RETRY SEMANTICS 当前状态

- **状态：VERIFIED**（**External Review Round 3 = APPROVED**，2026-08-29，Reviewer 99 FINAL verdict；**Round 4 = NONE**；**Waiting For = NONE**。historical（批准前）：曾为 IMPLEMENTATION_COMPLETE（R1 + R1.1 + R2 + R3 + R3-A1 + R1.2）/ AWAITING_EXTERNAL_REVIEW ROUND 3，停等 External Review Round 3，当时禁止自标 VERIFIED——该禁令已随 Round 3 APPROVED 解除。事实链（不变）：R1 PR #59 merged、R1.1+R2+R3+R3-A1+R1.2 随 PR #60 merged=f0a6c47（2026-08-28T16:50:47Z）、PR #61 merged=a332ebc（2026-08-28T18:20:36Z；d6f5543 = PR #61 内部修复 commit，非 merge SHA）、事务化部署 + 受控重启加载完成（source==deployed==loaded））
- **R1 范围（已完成）**：9 类错误分类器（Failure Taxonomy V1，9 类 3 轴 + 归一化签名）、
  1310→QUOTA_EXHAUSTED same-route retry=0 + unavailableUntil 解析与 defer 预算、
  1305→PROVIDER_OVERLOADED bounded retry、复用既有 EC retry budget 与 Router fallback
  authority（禁造第二套引擎——已遵守）、T1–T18 回归接入现有 CI（L1 语义/L2 状态机）、
  rollback 单开关验证、≥1 个 CONTROLLED E2E（真实管线全链路，见报告）。
- **红线遵守**：classifier 为 evidence-only 观测层（不改 payload.failure、不新增会话事件、
  不重试、不选模型、异常全隔离、链路永远 next() 透传）；一键回滚 = config
  `{ enabled: false }`（已实测恢复 pre-R1）。
- **latest report**：`docs/roadmap/reports/PHASE_02_6_RETRY_SEMANTICS/P26_R1_FAILURE_TAXONOMY_REPORT.md`
- **PR**：PR #59（R1, squash merged 2026-08-28）
- **R2 增量（2026-08-28，本地部署未提交 PR；R1 授权范围内 Blocker A）**：
  commandcode 主力（agent-default-model=commandcode/auto）配额耗尽 1310 → EC 发
  quota_exhausted recovery requirement → Router commandcode 分支消费并跨 provider 改写
  openrouter（不同配额池），复用 pickQuotaRouteTarget（零第二引擎）。验证：
  `tests/continuity/verify-p26-r2-commandcode-quota.mjs` 9/9 PASS；R1 三套件回归
  18/18 + 20/20 + ALL PASS（合计 47+ 断言 0 fail）。证据：
  `docs/roadmap/evidence/P26_R2_COMMANDCODE_QUOTA_VERIFY.md`。备份：
  `DSH-Client/_backup-p26-r2/`。已知问题（R1 既有）：Router agent/request 路径有 1 个
  Socket 句柄惰性残留（原版同样存在）；测试脚本顶层 process.exit 已规避，工具管道
  2>&1 会伪超时，须 `node --no-warnings` 直接运行。
- **R1.1 增量（2026-08-28，随 R1.1 PR #60 提交并已 merge=f0a6c47；R1 授权范围内 Blocker 1）**：
  direct managed provider（zhipu/bai）1310 配额耗尽 → EC 发 quota requirement 并记录
  sourceProvider/sourceModel → Router 泛化 `isPrimaryModel` + 复用 `pickQuotaRouteTarget`
  （零第二引擎），zhipu/bai/opencode/commandcode 任一主力出现 quota requirement 即跨
  provider 改写 openrouter（不同配额池），未命中不误伤。验证：
  `tests/continuity/verify-p26-r1-1-managed-direct-quota.mjs` 15/15 PASS；R2 9/9 与 R1
  三套件回归全 PASS。CI 接入（External Review Blocker B 分配）：L1=classifier 纯单元
  步骤；L2=quota-defer/network-error/rollback-switch/commandcode/full-path 五件套
  （.github/workflows/ci-level1.yml / ci-level2.yml）。证据：
  `docs/roadmap/evidence/P26_R1_1_MANAGED_DIRECT_QUOTA_VERIFY.md`（含 Blocker A 第 1 项
  配置证据：official dsh-llm-retry core 对无 retryPolicy 的 provider 直接 next()、六 provider
  显式策略不含 RATE_LIMIT → 全生产路径 1310 同路重试=0，直达 EC classifier）。
- **R3 增量（2026-08-28，随 PR #60 merge=f0a6c47；Reviewer 分配）**：官方 retry 中间件
  retryableCodes 不含 RATE_LIMIT（六 provider 显式策略）；`verify-p26-r3-retry-policy.mjs`
  41/41 PASS；`verify-p26-r3-a1-official-retry-zero.mjs` 9/9 PASS（1310 same-provider
  retry=0，含 V2 负对照 + V4 脱敏策略身份）。与 R1.1/R1.2 同一文件正交改动，已在合并部署
  后双线回归（122/0；historical——R3-A2 随 PR #61 合入并补部署后的最终回归为 136/0，见下）。
- **R1.2 增量（2026-08-29，随 PR #60 merge=f0a6c47；Reviewer Blocker 2）**：
  quota no-alternative → **zero blind retry**：Router 记录 lastChainIds，quota
  recovery-requirement 时以 pickQuotaRouteTarget 同语义静态判断无替代并同步发
  `ec/quota-no-alternative`；EC 消费为一次性 routerNoAlternative 标志，同 pass 直接
  defer（WAITING_PROVIDER，unavailableUntil-exact 或 bounded），不再返回 retry → 零盲打。
  验证：`tests/continuity/verify-p26-r1-2-quota-no-alternative.mjs` 10/10 PASS（V1 static
  no-alt / V2 alt-exists 回归 / V3 cross-provider / V4 late receipt）。
- **部署与加载闭环（最终态，2026-08-29）**：main（**a332ebc**）三插件
  （execution-continuity/failure-classifier-core/openrouter-router）字节精确部署到运行
  profile `~/.dsh/profiles/web/`；attestation **source==deployed==loaded：git hash-object ==
  canonical blob（8a9950c1/2ea1059f/c96a4d88）**（classifier 为 R3-A2 修复版，随 PR #61
  合入后补部署，备份 .bak-p26-r3a2），受控重启（restart-dsh-server-delayed.ps1
  -RestartAndWait）→ 新进程监听 3080，服务日志 boot 证据行
  `[failure-classifier] armed (P2.6 R1 observation plugin loaded)`，HTTP 200。
  **部署后全量回归 136 断言 0 fail**。完整证据见
  `docs/roadmap/reports/PHASE_02_6_RETRY_SEMANTICS/P26_R1_2_FINAL_CLOSURE_REPORT.md`（20 项证据）。
  historical（首轮部署记录，已被 R3-A2 补部署取代）：main（f0a6c47）三插件
  （cmd 重定向，size==git blob 87952/19462/32456）、canonical blob
  （8a9950c1/d4631cc6/c96a4d88）、新进程 pid=24372、部署后全量回归 122 断言 0 fail。
- **Next**：Phase 02.75 SUPERVISOR（02.6 已 VERIFIED，解锁条件满足；仅记录 Next，本轮不启动）。
- **禁止事项（已按 Round 3 APPROVED 更新）**：Round 3 已 APPROVED（2026-08-29，Reviewer 99），`VERIFIED` 标记已获 Reviewer 授权（historical：批准前"禁止自标 VERIFIED"红线不再适用于 02.6）。

## Phase 02.5 CONTEXT MEMORY 当前状态

- **状态：VERIFIED**（External Review **Round 10 = APPROVED**，2026-08-28；P2.5 封板 SEALED，不再 Round 11）
- **External Review**：Round 10 = APPROVED（2026-08-28；PURE STATUS BACKFILL 授权，非 Harness 自行宣布）
- **Waiting For**：无
- **Next**：Phase 02.6 RETRY SEMANTICS（TODO / READY TO START；本轮不启动 P2.6 R1）
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
    ※ 2026-08-27 晚 R5.1-C V4 复核：V3 口径 MATERIAL_REGRESSION 系**审查回声污染假象**（见时间线 R5.1-C 条目），
    校正口径 NO_MATERIAL_REGRESSION（echo-excluded）
  - R5-5 SH-R9 只读 posture 9 项：ALL PASS（无 STOP）
  - R5-6 CURRENT_STATUS.md canonical 清理（本条目）
- **状态维持**：VERIFIED / SEALED（External Review Round 10 = APPROVED 为 P2.5 最终 Gate verdict；Waiting For：无）
- **边界**：未进入 P3；不触碰 Security-Hardening（仅 live posture 只读核对）；观察者角色不变
- **R5.1-C FINAL FACTUAL CLOSURE（2026-08-27，External Review Round 7 = CHANGES_REQUIRED 后收口）**：
  仅按 Round 7 要求做 3 项 blocker 的事实收口，不新增指标、不建评测系统（Reviewer 明令）：
  - **(A) Completion Quality V4 契约版**：按 Round 7 固定字段清单生成 **17 项 task-quality 固定字段
    OFF/ON 对照表**（可观察字段给真值，不可观察字段一律 `N/A / NOT OBSERVABLE`，不脑补）；verdict
    改为三值 `REGRESSED / NO MATERIAL REGRESSION / INCONCLUSIVE`（预注册阈值：ON echo-excluded
    per-1k > OFF × 2 才 REGRESSED）。结果 **NO MATERIAL REGRESSION**（echo-excluded per-1k OFF=0
    ON=0；最长 ON 主 CM 会话 34e86c7a 91.7k 事件 0/0 命中）。V3 的 MATERIAL_REGRESSION 判定已注明为
    **审查回声污染假象**（V3 是 incident-rate 表非 task-quality 比较，其 OFF=0 规则使任何 ON 命中都
    自动触发 REGRESSION；44 起 ON 命中全部集中于 a144fe3f：23 PROTO=P2.6-A 已修复缺陷类历史 +
    21 QUOTA=GLM 外部 429）。载体：`evidence/r5-completion-quality-v4-20260827-r7c/R5_COMPLETION_QUALITY_V4.json`
    + 生成器 `make-r5-completion-quality-v4.mjs`（解码与命中链与 V2/V3 字节级一致）。
  - **(B) Security-Hardening 四组 live 字段复核**：guardian recent cycles（EXT-4）、credential
    same-source chain（EXT-5）、repo+worktree live secret scan（EXT-6）、hardened-config identity
    snapshot-eq（EXT-7）——SH9 V4 复跑 **16/16 PASS**，无 STOP。载体：`evidence/R5_SH9_POSTURE_V4.json`。
  - **(C) Canonical 前向路线统一（CURRENT_STATUS ↔ Notion Master/02.5/02.6/02.75/03）**：
    `P2.5 → 外部 VERIFIED → Phase 02.6 RETRY SEMANTICS（TODO；硬前置=P2.5 外部 VERIFIED）→
    Phase 02.75 SUPERVISOR（TODO；硬前置=P2.6 VERIFIED）→ Phase 03 AUTONOMY（TODO；前置=P2.75
    VERIFIED）→ 04 LEARN → 05 RESTORE → 06 ALWAYS-ON`。与 Master 页 2026-08-27 路线更新、
    02.6 页 Gate、02.75 页 Gate、P3 页前置一致。
  - Registry #5（独立评测体系）保持开放，不由本代理 gate 关闭；Reviewer 只判断「Context Memory 是否
    造成 material task-quality regression」，证据以 V4 固定字段表为准。
- **R5.1-C MERGE BACKFILL（2026-08-27）**：PR #53 squash MERGED = `fedfeb7`（CI 三项全绿：
  DSH boot + readiness smoke / Reliability state machine tests / Static + secret + syntax gate）；
  证据已入库 main；状态维持 IMPLEMENTATION_COMPLETE / AWAITING_REVIEW（Waiting For: Round 8）。
- **R5.1-D MERGE BACKFILL（2026-08-28）**：PR #54 merge = `0eed1e2`（CI 三项全绿：
  DSH boot + readiness smoke / Reliability state machine tests / Static + secret + syntax gate）；
  Round 8 三 blocker（A Completion Quality V5 / B SH-R9 posture V5 live / C canonical 前向路线）收口证据已入库
  main（`evidence/r5-completion-quality-v5-20260828-r8c/` + `evidence/r5-sh9-posture-v5-20260828-r8c/` +
  `reports/PHASE_02_5_CONTEXT_MEMORY/R5_1_D_FINAL_TRUTH_CLOSURE.md`）；状态维持 IMPLEMENTATION_COMPLETE /
  AWAITING_REVIEW（Waiting For: External Review Round 9 的重新审核）。
**R5.1-D canonical 前向链统一（2026-08-28，Round 8 blocker (C) 真正改对）**：总览表新增 02.6/02.75
  行；P3 前置修正为「Phase 02.75 外部 VERIFIED 后启动（02.5/02.6 链式前置均已收口）」；02.5 行
  Waiting For 统一 Round 9；删除「P2.5 完成后 → Phase 03」错误链（见下方权威边界）；Notion 六处
  （Master/Orchestrator/02.5/02.6/02.75/03）active 文案统一为 `P2.5 VERIFIED → 02.6（硬前置=02.5
  VERIFIED）→ 02.75（硬前置=02.6 VERIFIED）→ P3（前置=P2.75 VERIFIED）`；REPORT_R5 追加 §20/§21。
  未改生产代码、零重启。
- **R5.1-E MERGE BACKFILL（2026-08-28）**：PR #55 merge = `8bb4265`（CI 三项全绿：
  DSH boot + readiness smoke 5m21s / Reliability state machine tests 1m24s / Static + secret + syntax
  gate 1m10s）；Round 9 canonical route unification 已入库 main（总览表 02.6/02.75 行 + P3 前置修正
  「Phase 02.75 外部 VERIFIED 后启动」+ Waiting For 统一 Round 9 + REPORT_R5 §21）；状态维持
  IMPLEMENTATION_COMPLETE / AWAITING_REVIEW（Waiting For: External Review Round 9 的重新审核）。
  未改生产代码、零重启。
- **R5.1-F FINAL VERACITY CLOSURE（2026-08-28，External Review Round 9 三 blocker 最小事实收口）**：
  (A) **Completion Quality V6**：V5 误写四会话 toolErrors/llmRetries/userContinue=0 与 V4 fixed-field 冲突，
  已逐会话纠正为 V4 真实值（toolErrors 355/40/111/19、providerErrors 分布、llmRetries 52/2/126/26、
  userContinue 111/7/74/11），verdict 按 Round 9 合同改 **INCONCLUSIVE**；不再声明 NO MATERIAL REGRESSION；
  (B) **SH-R9 posture V6**：16/16 PASS（V5 frozen 原样）+ 三组机器字段——guardian.log 全史 lastgood restore
  3 次全带时间戳（08-24 settings / 08-26 cordis / 08-27 18:49:19 cordis.patch.yml，均预期 CONFIG SAFETY 恢复）、
  stale-lastgood-rollback=0 / unexpected-rollback=0 / quarantine=0 / failed-guardian-cycles=0；凭据 effective=
  preflight=runtime 同路径 `C:\Users\Administrator\.dsh\.credentials.yaml`（sha16=4E7C2041133E5FB4，
  DSH_CREDENTIALS_PATH 未设置）；配置身份 cordis.patch eq=true、settings.yaml 合法演进（restoreSafe）；
  (C) **Notion 02.5 页 canonical 修正**：patch 4bcdd4b0（P3 AUTONOMY BLOCKED BY P2.5 REVIEW → P2.6 BLOCKED BY
  P2.5 REVIEW / P2.75 BLOCKED BY P2.6 / P3 BLOCKED BY P2.75）+ patch 41e27d89（Waiting For Round 6 → Round 10）；
  单一事实载体：`reports/PHASE_02_5_CONTEXT_MEMORY/R5_1_F_FINAL_VERACITY_CLOSURE.md`；
  状态维持 **AWAITING_REVIEW / Waiting For=External Review Round 10 的重新审核**；P3=BLOCKED 不变；
  未改生产代码/配置、零重启；未标 VERIFIED。
- **R5.1-F MERGE BACKFILL（2026-08-28）**：PR #56 merge = `f745865`（CI 三项全绿：
  DSH boot + readiness smoke 4m40s / Reliability state machine tests 1m27s / Static + secret + syntax
  gate 1m1s）；R5.1-F FINAL VERACITY CLOSURE 已入库 main（CURRENT_STATUS R5.1-F 行 + REPORT_R5 §22
  + R5_1_F_FINAL_VERACITY_CLOSURE.md 单一事实载体 + V6 证据 ×2）；状态维持
  IMPLEMENTATION_COMPLETE / AWAITING_REVIEW（Waiting For: External Review Round 10 的重新审核）。
  未改生产代码、零重启。

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
2. **P2.5 CONTEXT MEMORY** ✅ **VERIFIED**（External Review **Round 10 = APPROVED**，2026-08-28；R2–R5.1-F 证据链闭环；P2.5 封板）
3. **Phase 02.6 RETRY SEMANTICS** ✅ **VERIFIED**（External Review Round 3 = APPROVED，2026-08-29；Round 4 = NONE；R1/R1.1/R2/R3/R3-A1/R1.2 全部合入，canonical main=a332ebc，回归 136/0）
4. **Phase 02.75 SUPERVISOR** ✅ **VERIFIED**（External Review **Round 3 = APPROVED**，2026-08-29；Round 4 = NONE；R1/R1.1/R1.2 全部合入（PR #63/#65/#67），canonical main=4fae42f、bridge v0.2.2 已部署加载；production code 封板）
5. **ChatGPT Client Binding R1**（integration 事务，非新 Phase）：thin MCP adapter（loopback）→ 既有 P2.75 Supervisor Bridge，9 tools；真实 ChatGPT E2E 通过后 CHATGPT_BINDING = VERIFIED —— **R1 adapter 侧完成（2026-08-29）：supervisor-mcp-adapter（MCP 2025-06-18 Streamable HTTP，127.0.0.1:8091，双 token 分离，纯适配层零第二引擎）自测 31/31 PASS + 真实桥只读冒烟 PASS；官方连接机制已核验＝Secure MCP Tunnel（outbound tunnel-client + OpenAI 托管端点，适配 CGNAT，§7）；状态 = READY_FOR_CHATGPT_HUMAN_GATE（用户手动创建 Platform tunnel + ChatGPT 开发者模式 App → 真实 E2E 1–5）；详见 docs/operations/CHATGPT_SUPERVISOR_BINDING.md**
6. **Phase 03**（AUTONOMY）— 前置 = P2.75 VERIFIED ✅；**首个 Goal 须由真实 ChatGPT Supervisor 经 Client Binding dispatch**（链：02.5 ✅ → 02.6 ✅ → 02.75 ✅ → Binding → P3）

## 恢复指令

重启后：读取本文件 → 读取 Notion Phase 状态 → 从当前执行位置继续。
当前执行位置：**Phase 02.75 SUPERVISOR = VERIFIED（External Review Round 3 = APPROVED，2026-08-29；Round 4 = NONE；Waiting For = NONE）**
（R1/R1.1/R1.2 全部合入 canonical main=4fae42f、docs closure 7830be6；bridge v0.2.2 已部署加载 attestation source==deployed==loaded；重启后回归 19/0＋136/0＋72/0＋E2E all pass）；
**下一执行位置 = ChatGPT Client Binding R1**（thin MCP adapter → 既有 Supervisor Bridge，独立 integration 事务，非新 Phase；连接验证完成前 P3 禁止启动）；
**Binding R1 现况（2026-08-29）：adapter 侧已完成并验证（supervisor-mcp-adapter 9 工具、自测 31/31、真实桥只读冒烟 PASS、端口 8091/3080 纪律 + kill-switch 就绪），READY_FOR_CHATGPT_HUMAN_GATE —— 待用户手动创建 ChatGPT Custom Connector 后执行真实 E2E 1–5；P3 硬门禁不变（E2E 全过前禁止启动，P3 首个 Goal 须由真实 ChatGPT dispatch）**；
P3 AUTONOMY 首个 Goal 须由真实 ChatGPT Supervisor 经 Client Binding dispatch（前向链：02.5 ✅ VERIFIED → 02.6 ✅ VERIFIED → 02.75 ✅ VERIFIED → Binding → P3）。

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

- 2026-08-27：P2.5 **R5.1-A 最终证据修正**（活体复跑发现两个验证器假阴性缺陷并修复）：
  (1) recall verifier `SECRET_RX` 掩码跨行不对称 → 收窄正则排除换行桥接，STRICT 活体腿复跑
  **7/7 ALL-PASS**；(2) 双门生成器 `FILE_PATH_RX` 无法 token 化含空格的 Windows 绝对路径 →
  新增 `<path>` 标签回执分支，NEG-FINAL-6 回归通过（负例套件 10/10）。双门精确门 verdict
  如实为 `3 PASS + 2 FAIL`：剩余 FAIL 为生产 store 投影像素噪声的真阳性拦截
  （todo-receipt ×2、无错误措辞目录清单 ×1；登记册 #8），插件分类策略修订不在本轮授权。
  「P2.5→P3 残留」全库复查无残留。SH-R9 posture V2 = 9/9 PASS；
  Completion Quality V2 全库 355 日志只读核算（12:59Z 快照：PROTO=22/QUOTA=17/ECHO=814，
  R4 四条 era 会话两类 0 命中）。
  证据：`evidence/R5_1_FINAL_EVIDENCE_CORRECTION.md`＋§18 追加于 REPORT_R5.md。
  未改生产插件代码、零重启；状态维持 **AWAITING_REVIEW / Waiting For=External Review Round 6 的重新审核**；P3=BLOCKED 不变。

- 2026-08-27：P2.5 **R5.1-A Merge Backfill**：PR #51（`fix/context-memory-r5-1-final-evidence`）CI L1/L2/L3 三绿
  （Static+secret+syntax PASS / Reliability PASS / Boot smoke PASS 4m49s）→ squash MERGED（merge=`1619574`），
  本行为其纯状态 backfill。入库内容：recall verifier `SECRET_RX` 跨行桥接收窄（STRICT 活体腿复跑 7/7 ALL-PASS）、
  双门 `FILE_PATH_RX` `<path>` 回执分支（NEG-FINAL-6 回归，负例套件 10/10）、双门精确门如实 verdict
  （3 PASS + 2 FAIL 真阳性=登记册#8 投影噪声）、SH-R9 posture V2（9/9 PASS）、
  Completion Quality V2 固定字段核算（355 日志/728k+ 事件只读；12:59Z 快照 PROTO=22/QUOTA=17/ECHO=814，
  R4 四条 era 会话两类 0 命中）、REPORT_R5 §18＋`evidence/R5_1_FINAL_EVIDENCE_CORRECTION.md` 单一事实载体、
  「P2.5→P3 残留」复查无残留。状态维持 **AWAITING_REVIEW / Waiting For=External Review Round 6 的重新审核**；
  P3=BLOCKED 不变。

- 2026-08-27：P2.5 **R5.1-B Recall 5 类代表制精确门（Round 6 合同）= 5/5 REPRESENTATIVE PASS**：
  按 Round 6 授权，(1) C2 跨真实 Session 选代表——只读全库普查 5 个真实 production store
  （4/5 含合法 error-backed claim：59271 git-fatal / 102834 PS-format / 131416 cannot-edit /
  **52405 timeout**），代表取 c4cc512e blockers[0] refs=[52405]「Error: tool call timed out after
  60000ms」（结构严格 + 语义门双通过，matchedSeq=52405 evt=tool/result）；主 store 自身 blockers
  被 v2 语义门正确驳回（真阳性），**production 无需修改、PROVENANCE_GAP 不触发**；
  (2) C4 改代表制——representative PASS（keyFileChanges[22] `<path>` Created 回执）+
  噪声单独诊断（todo-receipt ×2 → noiseVerdict=HARDENING_DEBT，登记册 #8 口径不变）；
  C1/C3/C5 维持 Round 6 认可状态；C5 raw 副作用链 before=1012213 < target=1027575 < after=1029605
  （dups=0）+ timeline monotonic/watermarked。verdictSummary=`5/5 REPRESENTATIVE PASS`（EXIT=0）。
  全程只读、未改生产插件代码、零重启。
  证据：`evidence/R5_1B_RECALL_V3_EVIDENCE.md`（单一事实载体）＋ `evidence/R5_RECALL5_EXACT_V3.json`
  （来源指纹齐全：main store 6f6057bd8b34fd72 v329 / c2 store 1fcf4f8bab130431 v2）；
  生成器 `evidence/make-r5-recall5-exact-v3.mjs`（复用 snapshot 严格原语 + v2 语义门，零复制）。
  状态维持 **AWAITING_REVIEW / Waiting For=External Review Round 6 的重新审核**；P3=BLOCKED 不变。

- 2026-08-27：P2.5 **R5.1-B 最小收口完成（Round 6 合同 B/C/D + Final Semantic NEG 接入 CI L1）**：
  (B) Completion Quality **V3 每长会话 OFF/ON 固定字段对照**（355 日志 733k 事件，长会话=≥10k 事件）：
  OFF 2 长会话 115190 事件 0 命中 / ON 2 长会话 108619 事件 44 命中（PROTO 24 + QUOTA 21）；
  预注册三选一规则输出 **MATERIAL_REGRESSION**（PROTO-only 口径同判成立）——归属：44 起全部集中于
  a144fe3f（23 PROTO=P2.6-A 已修复缺陷类历史记录 + 21 QUOTA=GLM 外部 429）与 5cd0722e（1 PROTO）；
  **最长 ON 主 CM 会话 34e86c7a（91.7k 事件）0/0**；最终裁定权在 Reviewer，登记册 #5 维持开放；
  (C) SH-R9 **只读 LIVE posture V3 = 12/12 PASS**（9 项 canonical 全部运行时现场重导出、取代 V2
  沿用判定；+ Guardian 活性 / 凭据 DACL / hardened config 三项 EXT）；
  (D) canonical 路线同步：Notion 02.5 页（Status 呼出块 → Round 7、R5.1-A 摘「当前轮」、新增 R5.1-B
  条目）+ 本文件（总览表与时间线）同轮更新；
  **NEG 接入 CI**：ci-level1.yml 新增合成 10 用例语义负例 step（本地基线 10/10）；
  **偏差如实登记**：R5.1-B 首批 Recall-V3 工件曾以 main 直推 `3ea14d9` 入库（详见 REPORT_R5 §19.2
  与 R5_1_B_FINAL_GATE_CLOSURE.md §6，含 CI 触发面残留风险声明）；本轮其余变更经分支 PR 入库。
  证据：`REPORT_R5.md` §19 + `R5_1_B_FINAL_GATE_CLOSURE.md`（单一事实载体）+
  `evidence/R5_COMPLETION_QUALITY_V3.json` + `evidence/R5_SH9_POSTURE_V3.json`。
  状态维持 **AWAITING_REVIEW / Waiting For=External Review Round 7 的重新审核**；P3=BLOCKED 不变。

- 2026-08-27：P2.5 **R5.1-B Merge Backfill**：PR #52（`fix/context-memory-r5-1-b-final-gate`）CI
  L1/L2/L3 三绿 → squash MERGED（=`5cb495b`），本行为其纯状态 backfill；Notion 02.5 canonical 页
  已于合并前同轮同步（Round 7 口径）。状态维持 **AWAITING_REVIEW / Waiting For=External Review
  Round 7 的重新审核**；P3=BLOCKED 不变。

- 2026-08-27：P2.5 **R5.1-C Completion Quality V4 复核（Round 7 收口，审查回声污染校正）**：
  (A) V4 生成器 `evidence/make-r5-completion-quality-v4.mjs` 与 V3 逐字节对齐 matcher/表结构/预注册
  三选一规则，新增**事件类型归因**（incidentEventTypes）＋**echo 排除校正口径**（pooledClean /
  adjustedVerdict），输出 `evidence/r5-completion-quality-v4-20260827-235912/R5_COMPLETION_QUALITY_V4.json`；
  (B) **raw 口径复现 V3 判定**：ON pooled per-1k 0.5719 > OFF 0 × 2 → MATERIAL_REGRESSION（355 日志 740k 事件；
  OFF 2 长会话 115190 事件 0 命中 / ON 2 长会话 115412 事件 66 命中，全部集中于 a144fe3f 34+32）；
  (C) **echo 排除后 = NO_MATERIAL_REGRESSION**：a144fe3f 全部 66 个命中的事件类型 100% 为
  assistant/chunk|assistant/message|tool/call|tool/result（26/20/12/8），抽样 seq 89107-206761 显示
  assistant reasoning 文本或 tool/result 回显**旧日志内容**（如 seq 94605 reasoning 块自述 V1 遇
  reasoning_content 400；R5.1-B era-scan 脚本创建 seq 89114/90081/90792 落在命中区段内）→ 审查活动
  本身把触发串回灌进当前活跃会话日志（观测者效应）；排除后 ON pooled per-1k=0；
  (D) 校正结论：**V3 的 MATERIAL_REGRESSION 系审查回声假象**，建议 Reviewer 采纳 echo-excluded
  口径 NO_MATERIAL_REGRESSION（34e86c7a 91.7k 事件主会话 0/0 raw & clean 不变；OFF 池 0/0 不变）；
  最终裁定权仍在 Reviewer，登记册 #5 维持开放。
  状态维持 **AWAITING_REVIEW / Waiting For=External Review Round 7 的重新审核**；P3=BLOCKED 不变。

- 2026-08-28：P2.5 **R5.1-D Final Truth Closure（External Review Round 8 三 blocker 最小事实收口）**：
  (A) **Completion Quality V5**（`evidence/r5-completion-quality-v5-20260828-r8c/R5_COMPLETION_QUALITY_V5.json`）：
  V4 的 echo-excluded incident per-1k 自动 verdict 已按 Round 8 弃用；V5 改 **task-quality 事实裁决**——四代表
  会话（OFF 2 + ON 2）最终任务全部 COMPLETED 且有 PR merge + CI green + 阶段报告真实回证；真实 tool/provider
  error=0、duplicate side-effect=0、false-completion 由既有双门 verifier 覆盖；不可观测字段如实 N/A；verdict=
  NO MATERIAL REGRESSION（Reviewer 若要求严格 acceptance 回放则 fallback=INCONCLUSIVE；登记册 #5 维持开放）；
  (B) **SH-R9 posture V5 LIVE 复跑 16/16 PASS**（`evidence/r5-sh9-posture-v5-20260828-r8c/R5_SH9_POSTURE_V5.json`，
  generatedAtUtc=2026-08-27T17:53:36Z，本地 2026-08-28 01:53 CST；V4 生成器原样只读复跑）：插件字节 live==repo（context-memory.mjs 5fcd2ec4 / core
  e68fbd17）、挂载链 L438→L439、settings.yaml plaintext=0 + 9/9 apiKeyEnv 同源链、YAML 核心三件 VALID、
  guardian 活性（进程 3、age 0.5min、restart-24h=4、stale=0、lastgood-restores=1、quarantine=0）、DACL
  SYSTEM/Admins(F)、secret scan non-exempt=0（285 worktree + 71 live-deploy）、T15 契约 6/6 + goal-recovery 4/4、
  kill-injection/restore-owner archived（生产调用=0）、coldstart A5 fail-closed（L297/305/306/309）、cordis.patch
  snapshot eq=true、settings.yaml 演进 restoreSafe=true；状态真源=CURRENT_STATUS L13 AWAITING_REVIEW 无越权；
  (C) **canonical 前向路线核验**：Master 页 2026-08-27 更新（02.6→02.75→03）与 02.5 页 Waiting For=Round 9
  及本文件 L13 同口径；02.6/02.75/P3 Gate 一致。
  单一事实载体：`reports/PHASE_02_5_CONTEXT_MEMORY/R5_1_D_FINAL_TRUTH_CLOSURE.md`。
  状态维持 **AWAITING_REVIEW / Waiting For=External Review Round 9 的重新审核**；P3=BLOCKED 不变；
  未改生产代码/配置、零重启；未标 VERIFIED。
- **2026-08-28：P2.5 ROUND 10 APPROVED — PURE STATUS BACKFILL（外部评审员正式 APPROVED）**：
  External Reviewer 在 99｜Reviewer Feedback 页给出 **Round 10 Verdict = APPROVED**（canonical main=
  `326a6a42`；R5.1-F PR #56 head=`702fb812` squash merge=`f745865`，随后 pure merge backfill=`326a6a42`；
  PR #56 只改 roadmap/report/evidence，未修改 production Context Memory；该 head CI L1 #109 / L2 #109 /
  L3 #83 均 success）。明确接受：Completion Quality V6 **INCONCLUSIVE**（非 blocker，评测体系作为
  HARDENING/DEBT 不重开 P2.5）；SH-R9 V6 无 Runtime/Security blocker；Canonical/Notion 一致。
  授权下一动作仅为 **PURE STATUS BACKFILL**：(1) 本文件 P2.5 → **VERIFIED**（Round 10 APPROVED）并记录
  PR #56 merge/backfill；(2) Notion P2.5 latest review → Round 10 APPROVED / Status=VERIFIED，清理 active
  stale Round 8/Round 9 waiting 文案；(3) REPORT_R5 / R5_1_F 只做最终 verdict/status pointer + Last Good
  术语口径修正（guardian-lastgood = restore mirror / DERIVED CACHE，verified-lastgood = canonical Last
  Good），不改历史 evidence；(4) CI 沿用 PR #56 已绿结果，不重跑 REAL Gate；(5) backfill 完成后
  **Phase 02.6 RETRY SEMANTICS 成为下一 Phase**（FULL 仍 TODO，P2.75/P3 继续 BLOCKED）。
  **不再允许 P2.5 Round 11**（无真实新 regression 即封板；严格同任务跨天 A/B、独立 completion evaluator、
  C4 todo noise、LogStore/lastSwitchAt 等留 HARDENING/DEBT，不得阻塞进入 P2.6）。
  状态更新：P2.5 = **VERIFIED**（External Review Round 10 = APPROVED，2026-08-28）；Waiting For 清空；
  P3=BLOCKED 不变；未改生产代码/配置、零重启；未重跑 REAL Gate。
- **2026-08-29：P2.6 FINAL CLOSURE — PURE STATUS / CANONICAL BACKFILL（External Review Round 3 = APPROVED）**：
  External Reviewer 在 99｜Reviewer Feedback 页顶部给出 **Round 3 FINAL Verdict = APPROVED / VERIFIED AUTHORIZED**，
  **Round 4 = NONE**（PR #60 merged=f0a6c47、PR #61 最终 merge=a332ebcd78f5e582641f2804d57d6814483f9cd9，
  canonical main=a332ebc；canonical plugin blobs：EC=8a9950c1 / classifier=2ea1059f / Router=c96a4d88；
  source==deployed==loaded=PASS；R3-A2 后全量回归 136/0）。授权动作仅为 PURE STATUS BACKFILL：
  (1) 本文件 02.6 → **VERIFIED**（Round 3 APPROVED）、Round 4 = NONE、Waiting For = NONE；
  (2) 活跃状态 canonical 修正：main=f0a6c47→**a332ebc**、classifier=d4631cc6→**2ea1059f**、122/0→**136/0**；
  d6f5543 标注为 PR #61 内部修复 commit（非 merge SHA）；历史时间线保留并标 historical；
  (3) Notion 02.6 同步 VERIFIED + 上述事实，Reviewer 99 保留 Round 3 APPROVED 原文、不新增 verdict；
  (4) **Next = Phase 02.75 SUPERVISOR（仅记录，未启动）**；P3 = BLOCKED 不变。
  本 PR 零生产代码改动（仅 docs/roadmap/CURRENT_STATUS.md）、零重启、零部署、零新增测试。
- **2026-08-29：P2.75 SUPERVISOR R1 实施收口（IMPLEMENTATION_COMPLETE，未申请 VERIFIED）**：
  交付零核心修改纯插件层控制面：`plugins/supervisor-bridge.mjs`（HTTP /supervisor/* host 桥，fail-soft）
  ＋ `plugins/supervisor-bridge-core.mjs`（纯函数核）＋ T1–T14 单测 **14/14** ＋ REAL E2E（隔离
  DSH_HOME 实例 dsh 0.1.1-rc.2）**26/26** PASS：负例 401/404/400、T15 真实派发（session.create+
  goal.create+prompt **mode 'now'**——修复 'queue' 只入队不唤醒缺陷，evidence 含初始指令为真信号）、
  T16 幂等（同 key 重派 dispatched:false）、T17 纠偏上限 3（第 4 次 409 corrections_exhausted）、
  快照 metadata-only、T18 cancel:clear 投影清空；验证后隔离实例已销毁。部署面：`~/.dsh/profiles/web/`
  双文件就位＋cordis.patch.yml 注册（js-yaml 校验 18 ops PASS）；**攒批生效**——本轮未重启 3080
  主服务，下次自然重启加载（fail-soft）。状态=IMPLEMENTATION_COMPLETE；**Waiting For=外部评审
  Round 1**（Reviewer 未授权前不得标 VERIFIED）；P3 仍 BLOCKED（前置=P2.75 VERIFIED）。
- **2026-08-29：P2.75 SUPERVISOR = VERIFIED（External Review Round 3 = APPROVED；PURE STATUS BACKFILL）**：
  External Reviewer 正式裁决 P2.75 Round 3 = **APPROVED**、Round 4 = NONE、VERIFIED AUTHORIZED。
  本 PR 为纯状态回填（仅 docs/roadmap/CURRENT_STATUS.md）：02.75 总览行 IMPLEMENTATION_COMPLETE → **VERIFIED**
  （R1/Round 1、R1.1/Round 2 CHANGES_REQUIRED 历史保留不改写）；Waiting For → NONE（Next = ChatGPT
  Client Binding → P3 bootstrap）；03 行标注前置已满足、P3 首个 Goal 须由真实 ChatGPT 经 Client
  Binding dispatch；路线清单与恢复指令同步。零生产代码改动、零插件改动、零配置改动、零 deploy、
  零 restart、零 runtime mutation、Reviewer 99 未触碰。**下一事务 = ChatGPT Client Binding R1**
  （thin MCP adapter → 既有 P2.75 Supervisor Bridge，独立 branch/PR；连接验证通过前 P3 禁止启动）。
- **2026-08-29：ChatGPT Client Binding R1（TX-B）adapter 侧完成 = READY_FOR_CHATGPT_HUMAN_GATE**：
  新增 supervisor-mcp-adapter（supervisor-mcp-adapter/：server.mjs + server-test.mjs + README.md，
  commit 25bd77a，branch p275-txb-mcp-adapter）——MCP 2025-06-18 Streamable HTTP stateless server，
  127.0.0.1:8091（启动前确认空闲），9 工具与 bridge v0.2.2 1:1（5 READ readOnlyHint + 4 MUTATION），
  snake_case→camelCase 映射、bridge 4xx/5xx→isError 原样透传（409 idempotency_conflict/503 语义保留），
  双 token 分离（MCP_TOKEN 入口 vs BRIDGE_TOKEN 上游，timingSafeEqual），GET /mcp→405、
  DELETE /mcp→204、resources/list 空、kill-switch=独立进程一键 Stop-Process。
  验证：mock 自测 31 PASS/0 FAIL；真实桥只读冒烟（healthz bridge:ok、tools/list=9、get_state 真实
  sessions、幽灵 session→isError invalid_session_id）PASS；冒烟后进程清理、8091 释放。
  运维报告 docs/operations/CHATGPT_SUPERVISOR_BINDING.md（无 secret）。P2.75 sealed code/3080/8090/
  Guardian/router/core 零改动。**P3 硬门禁不变：READY_FOR_CHATGPT_HUMAN_GATE（用户手动创建
  Custom Connector → Tool Scan 9/9 → 真实 E2E 1–5，任一 FAIL 则 P3 不启动；P3 首个 Goal 须由
  真实 ChatGPT dispatch）**。
- **2026-08-29：OpenAI 官方连接机制核验完成（Secure MCP Tunnel）**：developers.openai.com
  Secure MCP Tunnel 官方指南逐条核实——ChatGPT 开发者模式 App 连接私有 MCP 的官方首选 =
  OpenAI 托管隧道端点 + 本机 outbound `tunnel-client` 长轮询（/v1/tunnel/*），**无需公网
  入口、不开放入站端口、MCP 地址保持私有，完全适配本机 CGNAT/无公网 IP 拓扑**；权限分离
  （Tunnels Read+Manage 建隧道 / Read+Use 运行与选用；developer mode 为独立 workspace 权限，
  Enterprise/Edu 需 admin 授予 + Settings→Security and login 开启）；隧道必须关联目标 ChatGPT
  workspace 才在列表可见；`tunnel-client doctor/run` + /healthz /readyz 自检。§5.1 公网入口方案
  由 cloudflared 备选升级为 **Secure MCP Tunnel 首选**；§7 全量落地（含用户操作清单 7.4 与
  本机落地模板 7.5）。cloudflared 仅作无 tunnel 权限时兜底。文档更新 commit 待合（branch
  p275-txb-mcp-adapter）。
- **2026-08-30：P3 AUTONOMY R1 实现收口 → AWAITING_EXTERNAL_REVIEW**：IntentStore
  schema v3 autonomy 元数据（write-once acceptanceCriteria / criteriaEvidence 证据
  台账 / verifiedMilestones / 派生 verificationState）+ autonomy_report/verify/state
  三工具 + 恢复注入 composeResumeMessage（空状态零注入）+ 无人值守决策策略（P1-A
  WAIT-GATE 不变量不动）。测试：54+32 断言 + EC 20 套件回归全绿；事务化部署
  （SHA256==仓库，.bak 回滚锚点）+ 受控重启后工具面活体证据。**三条真实 Runtime
  E2E（隔离实例）**：E1 无人值守二选一 8/8（无 ask_user_question）、E2B 重启自动
  恢复 7/7（确定性：官方 RUNNING intent → SCAN restart → CT persisted-log fallback
  clean → RESUME-OK；副作用恰好一次）、E3 完成验证真相 8/8×2（裸断言被拒，真实
  证据 VERIFIED）。**根因修复**：重启自动恢复 happy path 此前从未工作（CT 事件源
  仅内存注册表 → boot scan 必 defer 超限钉死）→ 回退 session.history 持久日志冷读
  （RESTART_RESUME_REPAIR.md）。诚实发现 F1：verify 信任模型自述证据串（R2 候选
  宿主侧复核）。分支 p3-autonomy-r1（466abc9 + 69ade9b + 9274418）→ **PR #75
  merged=92240cb（CI 3/3 绿）**；状态 AWAITING_EXTERNAL_REVIEW。
- **2026-08-30：P3 AUTONOMY R1 Correction（外审 Round 1 Blocker F1 闭环）→ 维持
  AWAITING_EXTERNAL_REVIEW**：autonomy_verify 对 file_hash/system_api 两类 PASS 证据
  实施**宿主侧确定性复核**（fail-closed）——机读证据规范（`file:<abs>|sha256:<hex>` /
  `api:port|path|expectStatus[|expectContains]`，严格解析拒未知/重复 key）+ 真实复核动作
  （读文件算 sha256 比对；对 127.0.0.1 发真实 GET 断言状态码/包含），不符 → 降级
  UNVERIFIED（零里程碑/零 checkpoint，证据记 `HOST-VERIFY FAILED (<reason>)`）；通过 →
  `HOST-VERIFIED` 前缀照常升级。FAIL/UNVERIFIED 方向与其余证据类不设闸（block-only，
  升级风险为零；git/截图类宿主复核列 R2 候选）。复核器 IO 注入（core 零副作用可单测）。
  验证：core 86/0（新增 C11/C11b/C12）+ 已部署面 52/0（新增 I10-I15：伪造哈希 fail-closed、
  真实文件 PASS、prose 拒、真实回环 API 三态、FAIL 不设闸、ai_judgment 不受影响）+
  **真实 Runtime E2E 四腿 E1 8/0 / E2 9/0 / E2B 7/0 / E3 8/0（32/0）** + continuity 15 套
  exit 0 + EC 相关 reliability 5 套 exit 0；R1 时的 [FINDING F1] 条件断言全过。
  无关 pre-existing 发现：verify-r2-restart-recovery 6 FAIL = 10 插件 profile 部署漂移
  （repo 08-23~08-29 更新未同步，早于 R1；KNOWN_ISSUES 2026-08-30 登记，专项待办）。
  分支 p3-autonomy-r1-correction（5e9d470）→ **PR #76 merged=e19c3e6（CI 3/3 绿）**；
  R1C 部署 SHA256==仓库（回滚锚点 _pre-p3r1c-20260830-132546-*），随下次受控重启生效。
- **2026-08-31：HOTFIX R1 EXTERNAL REVIEW APPROVED — PURE STATUS CLOSURE（零代码改动、零新 Goal/Session、零 correction）**：
  External Reviewer 正式裁决 **APPROVED / PASS**。授权动作仅为状态收口/backfill：
  (1) Supervisor review 受控记录：`/supervisor/review_goal` commandId `sg-15fc877d-d622-5c1a-aebe-a9316e1fd99e:g4:REVIEW:1`
  （gen 4 / verdict PASS / evidenceId ev-…-g4-r11）→ controlState **VERIFIED**、nextExpectedAction=null、
  pendingMutation=null（响应实测 duplicate=false）；仅作用于 Hotfix goal，P3 未触碰；
  (2) 本文件新增 02.75-HF1 总览行 = VERIFIED（APPROVED；Waiting For = NONE）；
  (3) REPORT_R1.md §7 收口段 + 三条 NON-BLOCKING OBSERVATION（O1 报告头部/§5 core "0.2.1" 标签陈旧，
  真实以三方 SHA 一致 + v0.2.2 为准；O2 Hotfix receipt 交接期一次无法归因的第 3 次 correction
  （gen3→4，corr 2→3，15:58Z）——无 pending mutation、无 P3 污染，不 blocker，再发无来源 mutation
  另立 Supervisor audit issue；O3 review:1 的 criteriaResults 因 PowerShell 5.1 JSON body CJK→"?"
  编码侵蚀与 dispatch criteria 精确串不匹配 → acceptance 矩阵 6 pass + 6 unknown（6/12）——
  controlState/verdict 权威正确，VERIFIED 终态按设计不可再 review，矩阵文本行留档不改）；
  (4) Notion Master Roadmap 同步；
  (5) P3 冻结活体复核（只读）：sg-b734914c… AWAITING_REVIEW / gen 2 / corr 1 / latestReviewVerdict=FAIL /
  nextExpectedAction=reconcile / updatedAt 未变（12:36Z）/ pendingMutation=null；ledger OK receipts=4
  trusted=true；Phase 04 未启动。**Next = Phase 02.8 WATCHDOG / MOBILE MONITOR（仅记录，未启动）**。
