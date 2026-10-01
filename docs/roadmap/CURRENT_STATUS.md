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
| 02.75-HF2 | SUPERVISOR CORRECTING PERSISTENCE HOTFIX R1 | `FIXED / RUNTIME-VERIFIED`（Hotfix 闭环 2026-09-01；External Review 待下一轮 Supervisor 面审核一并裁决）。缺陷：`deriveControlState` 读时推导把宿主 goal 已 complete 的 CORRECTING（review FAIL 显式监督裁定）压回 AWAITING_REVIEW，重启/新读持续丢失显式监督裁定；修复：读路径持有（CORRECTING+complete 原样返回，显式命令出口不变，+10 行零 schema/路由/账本改动，commit b32852d）。PR #80 merged=2bf4194 CI 三 gate 绿；验证：repro exit 42（squeeze 复现）→ sticky 32/32（含 Leg C 重启零漂移）＋ mutation 19/19 ＋ 三阶段 E2E ALL PASS；事务化部署（备份 .bak-hf2-20260901）＋受控重启三环一致（identity bridge 057bbc0f…/core 5d012c56… == deployed == repo，ledger OK）＋重启后回归 sticky 32/0＋mutation 19/0＋P3 冻结态完好（sg-b734914c… gen=2 AWAITING_REVIEW 未 reconcile）＋HF1 VERIFIED 态完好。治理事件（同日如实记录）：收口文档初版 PR #81 曾误携 02.8 实现面入 main，已 revert 恢复边界；02.8 内容仍由 PR #79 承载（OPEN）待 External Review | —（Hotfix 闭环；02.8 External Review 进行中不受影响） | docs/roadmap/reports/PHASE_02_75_SUPERVISOR/REPORT_HF2.md |
| 03 | AUTONOMY / Task Autonomy | `VERIFIED`（**External Review Round 2 FINAL = APPROVED（2026-09-23 Reviewer 裁决）→ `P3 VERIFIED AUTHORIZED = YES`；Round 3 = NONE；PURE STATUS BACKFILL 由 Reviewer 授权、本轮执行**。裁决复核 canonical main = `00d28fcfcfc3aa3198a1b52a91c86870e99f66ca`；**F1 closure = PASS**（fake/missing hash、wrong hash、fake system API、soft evidence、unbound 与 target-binding mismatch 均 fail-closed；仅真实文件 hash 与真实 localhost GET 可产生 HOST-VERIFIED；write-once rebinding 受拒）；Fresh tests：`test-autonomy-state-core.mjs` **104 PASS / 0 FAIL**、`test-ec-autonomy-deployed.mjs` **67 PASS / 0 FAIL**；P1-A WAITING_USER / EC recovery / non-recoverable / multi-task recovery / compaction scope regression 均通过。**provenance 口径更正（Reviewer 记录，non-blocking）**：此前「raw byte identical」表述过强——`autonomy-state-core.mjs` raw SHA 完全一致，`execution-continuity.mjs` raw SHA 不同但 CRLF/LF 归一后逐字节一致（换行格式差异、非逻辑漂移），按**可执行内容一致**接受。**PR #91 仍为 OPEN / NOT MERGED**（docs/status closure；P3 implementation 与 required gate 来自已合入的 PR #76 / PR #86）——不得写成 merged。历史（保留不改写）：R1 实现收口 2026-08-30：IntentStore schema v3 autonomy 元数据 + autonomy_report/verify/state 三工具 + 恢复注入 composeResumeMessage + 无人值守决策策略；测试 54+32 断言 + EC 20 套件回归全绿；**三条真实 Runtime E2E 证据齐** E1 8/8 / E2B 7/7 / E3 8/8×2，隔离实例非 mock；期间根因修复重启自动恢复 happy path——CT 内存未命中回退 session.history 持久日志冷读，RESTART_RESUME_REPAIR.md；诚实发现 F1=verify 信任模型自述证据串（R2 候选宿主侧复核）→ **R1 Correction 修复（同日）**：file_hash/system_api 两类 PASS 证据强制宿主确定性复核（真实文件 sha256 比对 / 127.0.0.1 回环 API 断言），伪造或不匹配 fail-closed 降级 UNVERIFIED（零里程碑/零 checkpoint），PASS 记录带 HOST-VERIFIED 前缀；core 86/0＋已部署面 52/0（新增 I10-I15 含真实回环 API 三态）＋真实 E2E 四腿 E1/E2/E2B/E3 32/0 全绿；REPORT_R1C.md；R1 部署面 SHA256==仓库 + 受控重启 + 重启后工具面活体证据；R1C 部署 SHA256==仓库（回滚锚点 _pre-p3r1c-*），随下次受控重启生效；pre-existing 10 插件 profile 部署漂移已登记 KNOWN_ISSUES（专项待办，非本引入）） | —（APPROVED；Round 3 = NONE；Waiting For = NONE；**P4 gate = unlocked**） | docs/roadmap/reports/PHASE_03_AUTONOMY/REPORT_R1.md ＋ R1_VERIFICATION.md ＋ RESTART_RESUME_REPAIR.md ＋ e2e/ |
| 04 | LEARN / Autonomous Learning | `VERIFIED (ENGINEERING-COMPLETE) / AWAITING EXTERNAL REVIEW`（**2026-09-30 canonical 封条**：P4 学习系统以 **AC10 客观闭合**为依据回到 VERIFIED；封条与全链证据索引 = `_p4r2-final-closure/POST_P4_FINAL_GOLDEN_20260930.md`；本文件 §「2026-09-30 P4 canonical 封条」。**依据**：① 未经豁免的 P4 合同 AC1–AC10 全 PASS，唯一曾 FAIL 的 AC10 已客观闭合（真实 E2E 进入**必需门**、同赛道红灯**真实拦下合并**、`enforce_admins=true`）；② 生产字节 == canonical main@3ba3511（git 对象身份逐文件同一，仅 CRLF/LF 差异）；③ 当前活进程经**运行时装载探针**判定 `NEW_CODE_LOADED`；④ 生产 6 个 `learn_*` 工具、无重复注册；⑤ 负向安全 8/8 DENIED；⑥ 全部在 `_p4r2-final-closure/` 与 `_ac10/p4seal-evidence/` 存档、可重跑。**残留（如实登记，不阻塞本封条）**：外部 Reviewer 99 裁决面仍缺（属另行授权动作）、POST-P4 可靠性债务 G1/G2 与 HMR 上游漂移、6 个真实数据门在 CI 外、AC2 `RESEARCH_FULFILLED`/AC6 事务腿尚无生产实例、R2-F2 非硬约束、paths 清单**外**路径（如 `docs/_p4seal-probe.md`）的 PR 不触发 L3 ⇒ 必需检查不报告、被永久阻塞（`docs/roadmap/**` 在清单内不受影响）。）。**historical（保留不改写）：2026-09-23 外部治理评审曾裁决 `NOT VERIFIED / ROLLED BACK / AWAITING REDESIGN`，原文如下 ——**（**External Governance Review 2026-09-23 裁决：Question ①「P4 生产激活追认」= NO；Question ②「要求回滚」= YES；Question ④ = `OPTION 2 — ROLLBACK ACTIVATION`**；Question ③ PR #92 仅被追认为**有界可部署性/宿主契约热修**（ACCEPTED as a bounded deployability/host-contract hotfix only），不构成 P4 完成、不授权状态回填。授权动作原文：Remove the `learn` registration from the active production profile and restore the pre-P4 production state。**P4 = NOT VERIFIED**。**生产激活已于 2026-09-24 06:25 撤销**：`~/.dsh/profiles/web/cordis.patch.yml` 移除 learn 注册块，回滚后 sha256 = `a40558ada824884e3ba727a6151129a4bd25a865210123366104b8153b55519b`，**与 pre-P4 基线逐字节一致**；`dsh --profile web --dump-config` 已无 learn；注册插件清单与 pre-P4 完全相同（18 个）。**源码与经验数据全部保留**（`learn.mjs` sha256 `8b183e37…`、`learn-core.mjs` `a66ac2d8…`、`%LOCALAPPDATA%\DSHHarness\state\learn\` 4 文件）——**CODE PRESENT ≠ FEATURE ACTIVE**。**运行态已同步卸载 learn（`RUNTIME_RELOAD_SYNCED_VIA_HMR`）**：**2026-09-24 06:5x 事实更正**——原记 `RUNTIME_RELOAD_PENDING` / `MANUAL_SAFE_RELOAD_REQUIRED` **为误判，已撤回**。`cordis.patch.yml` 是 profile 用户覆盖层，dsh 经 `@deepseek-ai/cordis-plugin-hmr` 对其做 **Cordis HMR 事务式热重挂**（`dsh-app-boot` 的 `watchUserPatches()` → `hmr.registerConfig(filename, …)` → `entry.update({ patches })`），**改 patch 无需重启**（早前 RUNBOOK/DECISIONS 中「改 patch 需重启」的记载对 profile 用户层不成立）。**实证（同一 PID 18552，启动 2026-09-23 04:05:10，全程未重启）**：经验库 `state/learn/session-04ecc1a4-…json` 最后写入 **2026-09-24 06:24:52**（= 回滚前 24 秒），**回滚后零写入**；回滚后于同进程新派发子代理，工具清单 **0 个 `learn_*`**（69 工具全集实测）；`dump-config` 插件清单含 `cordis-plugin-hmr`、**不含 `./learn.mjs`**。⇒ 配置层与运行层**均已回滚**，P4 的 `source == deployed == loaded` 成立。**无需用户做任何操作。****合同缺口（Reviewer 判定）**：AC1 PARTIAL（多类常见 secret 与 PEM private-key 形态未被可靠脱敏）；AC2/AC3/AC4/AC5/AC6/AC10 FAIL；AC7/AC8/AC9 PASS（空转；AC9 全局 disk/memory boundedness 未达成）。**新增缺陷定性**：secret redaction gap = BLOCKING；per-session files 全局无界 = BLOCKING for active production；`stores`/`watermarks` Maps 无淘汰 = BLOCKING for active production；写入边界自检传字面量而非 `cfg.stateDir` = BLOCKING；载入字段上界不完整 = NON-BLOCKING SECURITY DEBT。**P4 需 contract-first R2 重设计**。历史（保留不改写）：2026-09-21 合同逐字重建 + 独立 delta review 结论：合同 AC1–AC10 中 3 PASS（AC7/AC8/AC9，其中 AC7/AC9 属「空转成立」而非强制保证）／ 1 PARTIAL（AC1）／ 6 FAIL（AC2、AC3、AC4、AC5、AC6、AC10）**。合同要求的 **4 次真实执行 3 缺 1 且被实测反证**（#1 缺失、#2 近乎同义反复、#3 行为相反、#4 缺失）。**最高风险＝AC5 与合同要求相反**：Provider 502／网络超时／服务不可用三类文本实测均产生 `failure` 信号并照样生成 PROPOSED 候选（合同要求「正确分类、不生成 Candidate」），且仓库 PHASE_03 已有 9 类失败分类器**未复用**。**AC2/AC3/AC4/AC6 整块未实现**：无自主研究闭环、无 `verified` 状态（`EXPERIENCE_STATES` 仅 PROPOSED/APPROVED/REJECTED/RETIRED，`approve()` 只校验「审批人非空＋证据非空＋证据不含密钥形态」，不执行任何验证）、复用前无环境/版本检查、CI 零接入（`.github/workflows/*` grep `learn` = 0）且未复用既有 Transaction 2.0。**AC1 可被反证**：脱敏对 Google API key／Stripe／GitLab／HuggingFace／npm／PEM 私钥块／Slack webhook 全部失效。**口径断裂（根因）**：报告使用**自定 AC1–AC12** 编号，与合同 AC1–AC10 不对齐，致「测试全绿」不能作为合同达成证据。详见 `CONTRACT_RECONCILIATION_R1.md` ＋ `INDEPENDENT_DELTA_REVIEW_R1.md`。**以下为原实现自述（保留不改写）**）**R3 对抗评审收口 2026-09-21，commit `b5fa812`（＋`7f786be`）**：4 个实证缺陷 F1–F4（注入过度剥离 / 否定语境从未排除 / latin failure 形态漏检 / CJK 覆盖缺口）全部修复，并**追加发现并根因修复会话隔离撞名缺陷 F5**——`sanitizeFileId` 只做「非法字符→`_`」＋截断 120、**不做唯一性保证**，`'probe session X'` 与 `'probe_session_X'`（及超长 sid 截断后）映射到**同一库文件** ⇒ 后请求方经 `validateStore` 放行后**静默继承前一方经验**（跨会话污染、**无 STORE_REBUILT 告警**），且双方轮流写入同一文件会**互相覆盖、互相丢数据**；修复＝①**根因**：清洗确实改变原 sid 时追加原 sid 短哈希（常规 `session-<uuid>` 文件名**保持原样** ⇒ 既有库文件零迁移影响，已实证）②**兜底**：`loadStore` 归属校验 fail-closed（库 `sessionId` ≠ 请求方即拒绝载入并记 `STORE_REBUILT`）；**只做兜底不够**——兜底只能拒绝载入、不能避免覆盖。验证：`tests/learn/` 全目录 **0 个非零退出**，合计 **478 PASS / 0 FAIL**（core 276 / r3-fixes 29 / hardening 30 / secrets 62 / real-E2E 59 / isolation 13 / contamination 9 ＋ metrics·quality·labels·injection-positions 全 exit=0；早期误写 413，经最终 HEAD 逐套件复核为算术错误已更正；PRE-MERGE R-3 再增 hardening +4、secrets +4 ⇒ 412→478）；隔离红队结论「撞名可达=**NO**、归属守卫=**YES**、跨会话污染=**NOT CONFIRMED**」，含**守卫直测**（伪造他人归属文件 → 被拒载入并重建 + STORE_REBUILT）。过程记录：原隔离探针 B2/B3 判定极性写反（把「文件合法归属 Y」判为 FAIL），已重写为 PASS=隔离成立并升级为「撞名已消除」，避免下次误读。**R2 对抗评审修正 2026-09-21，commit `e1df5b0` 已推送 PR #90**：对抗评审＝刻意攻击**已交付代码**而非重跑其测试，实证 5 个缺陷并全部修复——**D1** `\b` 是 ASCII 词边界 ⇒ 全部中文关键词**物理不可达**（`\b报错\b` 在「这里报错了」中永不匹配），拆为 latin/cjk 双正则，真实会话信号 **161→769**、候选标题 **152→754**；**D2** 首个命中即 `break` ⇒ 语义反转（"fixed the error" 被判 `failure`，而标签决定学什么），改为按语义强度声明（resolution>correction>failure）；**D3** 无失败-解决配对 ⇒ 已修好的 bug 与未修的无法区分，新增 `resolved`/`unresolvedFailureSeqs`（按 seq 判定），真实会话 9 个含失败窗口现分为 **6 已解决 / 3 真缺口**；**D4** harness 注入的 `<system-reminder>` 被当经验学习（`isPluginSourced` 只覆盖部分事件形态），新增内容级 `stripInjectedContent()`（含未闭合块/纯注入轮）；**D5** 调用方 `nodeSeqs` 被原样采信（`[0,0,0,1]` 计数=4、乱序污染确定性），改为去重+排序规范化。**每项均由「在 R1 代码上必失败」的回归测试锁死**（R1 逻辑逐字重建后对照：**19/19 行为全部改变、0 未变**）。单元 **274 PASS / 0 FAIL**（原 220，+54）＋ 真实会话 E2E **59 PASS / 0 FAIL**（原 58，+1＝新增反向对照）＋ AC7 回归 19/20 绿，唯一红 `tests/install-plugin/verify-install-plugin.mjs` **不靠推断、经在 pristine HEAD 上重跑实证为 PRE-EXISTING**（同样 13/2，插件同步漂移）。**自曝并修复本次引入的 2 个缺陷**：① E2E 标题断言把 `oneLine()` 折叠后的标题与**原文**比对（中文轮成为信号轮后 `\n` vs `' '` 必然假失败，E2E 曾 58→57）→ 两侧统一规范化 + 加反向对照防「空洞通过」；② 静默丢掉英文关键词 `actually`（能力回退）→ 恢复并加「R1 英文关键词全部仍命中」断言，恢复后真实会话**丢失标题 = 0**（R2 是 R1 能力的严格超集，不是权衡）。**R1 实现收口 2026-09-21：baseline main=`6d0623627c4b38f6b870ef03fe9ed776186c9e09`，分支 `p4-learning-r1` + 隔离工作树 `.worktree-p4-learning-r1`；最小增量=2 个新文件（`plugins/learn-core.mjs` 纯核心 674 行 / `plugins/learn.mjs` 插件壳 407 行）+ 1 处仅导出改动（R4 解码器 +25/−8）；**提案 ≠ 激活由代码强制**（召回只认 `APPROVED`，`ALLOWED_TRANSITIONS` 白名单，REJECTED/RETIRED 为终态不可复活）；AC1 **硬保证**=直接 `import` P2.5 官方提取器 `context-memory-core.mjs`（`P25_EXTRACTORS`，缺失即 `missing_official_extractors` fail-closed）⇒ 物理上不存在第二个 raw-session parser；R4 解码器仅补导出，实测解码输出**逐字节相同**（32388 帧 / 39827 行 / bad=0，改前==改后）；经验库 per-session 原子写 `%LOCALAPPDATA%\DSHHarness\state\learn\<sid>.json`，损坏 → `validateStore` 返回 null → **fail-closed 重建**；写入白名单 `experience-store/telemetry/audit-log` + 启动自检；密钥持久化前强制脱敏；ELIGIBLE ≠ PROMOTED（无自动晋升）；单开关 `LEARN_DISABLED=true`；测试 **单元 220 PASS / 0 FAIL** ＋ **真实会话 E2E E1–E4 58 PASS / 0 FAIL**（真实 session 3227 节点，非 mock/非 fixture）；AC7 全量回归 **19/20 绿**，唯一红 `tests/install-plugin/verify-install-plugin.mjs` 经实证为 **PRE-EXISTING**（11 个既有插件生产部署漂移，`git status` 全部未改动，P4 新增文件不在该检查范围）⇒ 只登记不擅修；**未进生产 profile、未重启服务、未部署**（R1 仅隔离工作树内成立）。诚实说明：acceptanceCriteria 声明时 bindings 为 `kind:'none'`（write-once 不可改），故**逐条 AC 无主机侧 PASS 通道**，`verificationState` 保持 `UNVERIFIED`；已记录 **8 个主机哈希复核里程碑**作为底层机器可验证据）。**R3 对抗评审修正 2026-09-21，commit `7f786be`**：对 R2 后代码再攻击一轮，实证 4 个缺陷并全部修复——**F4（最严重：静默删真人发言）** `INJECTED_OPEN_RE = /<system-reminder>[\s\S]*$/i` 任意位置命中即吞到结尾，用户只是**讨论**该标签时（"我注意到日志里有 `<system-reminder>` 这个标签，它后面的报错都没被记录"）**81% 文本被删**，而规范 §4 明确要求区分"harness 注入 vs 用户讨论该标签"；收紧为"标签独占一行"（真注入块排版形态），**实证 2174 次真实出现**：真注入 **720/720** = 行首且独占一行、引用/讨论 **1454/1454** = 行中且标签后跟行内文字（`lsOnly=0`/`aloneOnly=0`，**完美分离**），普通工作会话 21/21 真实注入仍被剥；**F3** 否定从未排除（规范 §9）：`没有报错`/`not broken`/`not fixed` 全部被当正向信号（实测 **6/6** 反向表述误判），新增有界 `isNegated()`（CJK 要求否定词紧贴关键词、Latin 查前 2 词含 `not only` 例外；第一版"遇标点即结束"在 `运行了一下，没有报错` 上误判 → 改为结尾锚定）；**F1** latin failure 缺 `failing/fails/fail` ⇒ 规范 §4 的 `still failing → failure` **完全漏检**；**F2** CJK 缺 `出错/不工作/没反应/崩了`、`修好了` 未作 resolution ⇒ 回归检测 `又崩了` 不可检。测试：R2 套件 **276 PASS / 0 FAIL**（把**编码了旧过剥行为**的那条 R2 断言升级为 R3 规格并保留为反向锁，非删除）＋ 新增 `test-learn-r3-fixes.mjs` **29 PASS / 0 FAIL**（正反孪生对，过否定无法静默通过）。**如实登记未修边界**（需句法/语义层，超出最小修复范围）：假设句、文档/字段名描述、引用他人发言。**PRE-MERGE R-3 独立 Release Gate 修正（F6，2026-09-21，commit `d70a169`）**：PR #90 的独立 Release Gate 评审（**非自评**）在通用密钥脱敏上发现覆盖缺口——规范家族（notion/openai/openrouter/slack/github/jwt/anthropic/telegram/aws）覆盖良好，缺口在**"不属于任何已知厂商但明显是口令"**的通用形态：① `generic-assignment` 值字符集为 `[A-Za-z0-9_\-./+]{12,}`（**纯字母数字**），遇 `! @ # $ % ^ & * ( )` 即断 ⇒ 含符号口令**整体漏脱敏**（实测 `password: "P@ssw0rd!xyz"`、`passwd: p@ss#w0rd$2026`、`client_secret="s!e@c#r$e%t^&*"` 全部原样泄漏）；② **完全缺失 URI credential 形态** ⇒ `postgres://user:PASS@host/db`、`mysql://root:PASS@host`、`redis://default:PASS@host` 无任何规则覆盖。修复（`plugins/learn-core.mjs` **+15/−2 行，仅 `SECRET_PATTERNS` 两处**）：① 新增 `uri-credential` = `/(?<=:\/\/)[^\s/?#]+(?=@)/g`——关键难点是**口令内的 `@` 与 userinfo/host 分隔符的 `@` 同形**，只截第一个 `@` 会把 `ss@host/db` 继续泄漏，故从 `://` 后**贪婪**取到 authority 内最后一个 `@`（authority 不含 `/`），且 lookbehind/lookahead **不消费** scheme 与 `@` ⇒ 输出 `postgres://[REDACTED:uri-credential]@db.internal:5432/app`，**scheme/`@`/host 全保留**（C7 专锁此点，脱敏同时保住可诊断性）；② `generic-assignment` 由**按字符集**改为**按分隔符**取值（引号内取到闭合引号、无引号取到空白/分号/逗号/引号为止），与符号种类**解耦**，另补 `api[_-]?token`（此前 `\btoken\b` 在 `api_token` 中无词边界而漏）。**防过度脱敏**：仍要求 keyword 后**紧跟** `[:=]`，故 `token count = 5`、`the password field is required` 不被误脱敏（E3/E4 锁定）。**端到端落盘证据（不止测函数）**：新增 `tests/learn/test-learn-r3-secrets.mjs` **58 PASS / 0 FAIL**，H 段驱动**真实插件壳**（`plugins/learn.mjs` 的 `apply()`，非复制品）让假密钥经 `digest → signal → candidate → title/body → 持久化 JSON` 全链路，断言**落盘文件字节**不含完整原始密钥；H2/H3/H4/H5 **fail-closed**（前置不成立即判失败——首版曾因产物为空而"通过"，那是**比没有测试更糟的假绿**，已修正）。**负向对照（证明非纸面通过）**：换回 HEAD（修复前）实现后同套件 **32 PASS / 26 FAIL**，H 段 3 条全部报「原始密钥出现在持久化产物中」；换回后恢复 58/0，且按 sha256 校验还原字节**完全一致**（`68CE70DB…6042A1`）。`tests/learn/` 合计 **412 → 470 PASS / 0 FAIL**（逐套件实跑复核，非沿用旧表：core 276 / r3-fixes 29 / hardening 26 / **secrets 58（新）** / real-E2E 59 / isolation 13 / contamination 9，其余观测模式 exit=0）；AC7 全量 **21/22 绿（TOTAL 22，新增本套件入闸）**，唯一红仍为 `tests/install-plugin/verify-install-plugin.mjs` **PRE-EXISTING**（11 个既有插件生产部署漂移，**其中无一为 learn\***，与本次改动无关）。**过程确认的两个 harness 事实（易错，已写入测试注释）**：① 会话事件形状**按角色不同**——`user/message` 的 message 是**扁平** `data.content`，`assistant/message` 的 message **嵌在** `data.message` 下；P2.5 官方提取器 `messageOfEvent` 对 assistant 只读 `data.message`，用扁平形状造 assistant 事件返回 `null` ⇒ 该轮被**静默丢弃**（`digest.turnCount` 偏小但不报错）；② `minNewNodes` 是**单次推进的增量下限**而非累计，逐节点推进时每次仅新增 1 个节点，`minNewNodes=2` 将**永不触发**自动候选。**F6 新增并如实登记的边界**：`generic-assignment` 无引号分支值下限 `{8,}` ⇒ `password=abc123`（6 字符）仍不脱敏；**不修的理由**=下限是误报/漏报的权衡旋钮，降到 4 会让 `token = null`、`secret: true` 这类普通代码/文档文本被误脱敏，而"看到 password 就吞正常内容"正是负向孪生 E3/E4 明确要防的错误（带引号分支下限为 4，因引号本身已是强边界）。取证：`docs/roadmap/evidence/P4_LEARN_R3_SECRETS.txt`（含修复 diff、修复版 58 PASS、负向对照 26 FAIL、还原 sha256 校验） | **External Governance Review 裁决（2026-09-23，已到达）**：① P4 生产激活追认 = **NO**；② 要求回滚 = **YES**；③ PR #92 = ACCEPTED as a bounded deployability/host-contract hotfix only（不构成 P4 完成、不授权状态回填）；④ = **OPTION 2 — ROLLBACK ACTIVATION**。授权动作原文：Remove the `learn` registration from the active production profile and restore the pre-P4 production state。**P4 = NOT VERIFIED；P5 = LOCKED / NOT STARTED**。历史（保留不改写）——**送审请求原文（2026-09-21）**：请针对**最新 HEAD** 裁决——① 是否接受**合同口径 `PARTIAL`**（AC2/AC3/AC4/AC5/AC6/AC10 未达成）；② AC5「环境故障 vs 真实能力缺口」判定层是否列为**最高优先级补救**；③ 是否要求把 `tests/learn/` 接入 CI（AC6 的 CI 部分）；④ P4 是否可在 PARTIAL 状态下合并进 main（治理侧另有硬前置：P3 尚未获 Round 2 APPROVED）。历史（保留不改写）：R2 修正 `e1df5b0`、R3 修正 `7f786be`+`b5fa812`、PRE-MERGE R-3 修正 `d70a169`（F6）均已推送 PR #90；**R3 自评结论 = `B — FIXED AND VERIFIED`**（工程面真实，但与合同达成无关，依据 `REPORT_R3.md` §7）。**治理侧硬前置（2026-09-21 补）**：合同 P4 第 2 行「前提：Phase 03 必须已外部 VERIFIED，否则停止」；P3 已于同日完成 Round 2 收口并送审（PR #91），**P4 解锁权在 Reviewer**。 | docs/roadmap/reports/PHASE_04_LEARNING/REPORT_R3.md ＋ REPORT_R2.md ＋ REPORT_R1.md ＋ GAP_AUDIT_R1.md ＋ PREFLIGHT_AUTONOMY_VERIFY.md ＋ **CONTRACT_RECONCILIATION_R1.md** ＋ **INDEPENDENT_DELTA_REVIEW_R1.md** ＋ evidence/ |
| 05 | RESTORE / Disaster Recovery | 未开始 | — | — |
| 06 | ALWAYS-ON / VPS Runtime | 未开始 | — | — |

## Authority 声明

- **代码真源 = GitHub verified main / tag**（ZTKyo/deepseek-harness-desktop）
- **Runtime = deployed truth**；冲突按 commit/history/Golden/语义/测试裁决
- 详见 `AI_CONTEXT.md`（冲突裁决原则）

## 2026-09-30 P4 canonical 封条（最新状态；以下「当前执行位置」历史原文保留不改写）

**P4 = `VERIFIED (ENGINEERING-COMPLETE) / AWAITING EXTERNAL REVIEW`（2026-09-30 canonical 封条）。** 封条 = `_p4r2-final-closure/POST_P4_FINAL_GOLDEN_20260930.md`；
证据索引 = `_p4r2-final-closure/`（生产实证、门证据、最终矩阵）＋ `_ac10/p4seal-evidence/`（本轮新增可重跑件）。

> **两级表述的强制配套（必须与状态值同时引用，不得单独引用前半段）**：
> ① **工程口径 = 全部达成**：未经豁免的 P4 合同 AC1–AC10 **全 PASS**，其中曾唯一 FAIL 的 **AC10 已客观闭合**（真实 E2E 进入必需门 +
> `enforce_admins=true`，红灯真实拦下合并）；生产字节与 canonical `main@3ba3511` **git 对象身份同一**；今日运行时装载探针判定 `NEW_CODE_LOADED`。
> ② **治理口径的最后一项条件仍缺**：合同要求「AC1–AC10 PASS **且经 External Review APPROVED**」，而 **外部 Reviewer 的裁决仍未取得**。
> 本封条**不声称**已获外部批准；它与本行历史上红线「**未获 Reviewer 授权，禁止标 VERIFIED**」的关系是：**由业主（2026-09-30 指示）以"AC10 客观闭合"
> 为据裁定收尾并授权封条**，属**业主层裁定**，已在封条 §治理前提 如实登记（历史同类登记见 `A11_GOVERNANCE_UPDATE.md`）。
> 故本行采用**不吞掉该缺项的写法**：`VERIFIED (ENGINEERING-COMPLETE) / AWAITING EXTERNAL REVIEW`。若需绝对的合同级 `VERIFIED`，
> 剩余唯一动作 = 取得外部 Reviewer 裁决（属另行授权动作，本轮不做）。

- **一、AC10 客观闭合（唯一的最终阻塞项）**：`ci-level3.yml` 的 **必需检查** 现含 `DSH boot + readiness smoke`，
  `enforce_admins=true`、`strict=true`；程序化实证：违反 AC10 的同赛道红灯 PR **#100 = BLOCKED（mergeable=false, blockers=1）**、
  含真实 E2E 的绿灯 PR **#99 = MERGEABLE**，且 #99 已合入 **main=`3ba3511`**（含 AC10 三件套 + 2 个 CI 探针测试）。
  **闭合前后对照（均为线上只读 GET，存档可复算）**：闭合前 required contexts 仅 `Static + secret + syntax gate` /
  `Reliability state machine tests`、**`enforce_admins=false`**、无 main ruleset ⇒ AC6 真实晋升 E2E 所在 L3 门 `required=false`、
  **红门拦不住合并**（见 `_p4r2-final-closure/merge-enforcement-audit.txt` §2–§4 的 `[NOT-BLOCKED]`）；闭合后 required contexts
  三项含 L3 smoke 门、`enforce_admins=true`（存档 `_ac10/p4seal-evidence/branch-protection-main-20260930.json`）。
  ⇒ 旧口径（“AC10 未闭合、由业主豁免继续”）**已失去事实前提**，本轮据此把**工程口径**改判为客观 VERIFIED（治理口径仍待外部评审，见文首两级表述）。
- **二、生产侧全链复核（2026-09-30 实测，非自述）**：① 生产 4 个 learn 插件与 **canonical main@3ba3511 逐文件字节同一**
  （git 对象身份：`git hash-object(生产)` == `git ls-tree main` 的 blob；LF 归一化 sha256 亦逐一相等，
  原始 sha256（CRLF 工作副本）`learn.mjs=5c4ee78c…`/`dcf2a2ae…`/`2b4d3853…`/`b7623ced…`）；② 运行时**装载探针**判定
  `NEW_CODE_LOADED`（`exit 0`），离开同一探针会话的 `learn_recall` 实时输出；③ `GET / = 200`；④ 工具面 = **6 个 learn_***、
  **无重复注册**；⑤ 负向安全 **8/8 DENIED**（含「插件自审批 → 授权为假」）＋ 台账哈希链/digest 绑定/时序/宿主授权来源 4 项只读事实 PASS。
- **三、合同矩阵 AC1–AC10**：AC1 PASS（19 族 secret 自愈迁移，`AC1_SECRET_FAMILIES_VERDICT=PASS`，生产字节）、AC2 PASS
  （研究腿接线 + 生产遥测 + **今日活进程实时 `researchDirective`**）、AC3 PASS（先确定性验证后批准，官方日志时序）、
  AC4 PASS（适用性判据）、AC5 PASS（`GAP_VETOED=4`/`CAPABILITY_GAP_VETOED=1`）、AC6 PASS（真实晋升 E2E 24P/0F +
  晋升后 `learn_recall` 产出新条目）、AC7 PASS（合成断言：候选不得覆写 stable）、AC8 PASS（无 daemon）、
  AC9 PASS（插件占用有界；**诚实注**：`sessionStoreMaxFiles` 语义未证明，self-audit 弱断言已登记）、
  AC10 PASS（**客观闭环**：真实 E2E 已入必需门且红灯真实拦合并）。
- **四、真人/运行时六项 + 晋升**：真人审批（宿主台账哈希链 `host-approval-seam` / `host-approved-human`，grant→consume 单次）、
  全局发布、跨会话召回、适用性判据、复用、复验（`learn_verify` 确定性重推导）＋ `PROMOTION_ELIGIBLE=promoted` 全部成立。
- **五、R2 两项（F1/F2）处置**：**F1 = 关闭**（授权只能由宿主真人审批缝写入；`learn_review` 自审批路径在生产字节下被拒，
  承载断言 `test-learn-b1-session-access.mjs` TO4a/`approval_missing_host_attestation` 实测 PASS；本会话审批提示被禁用时
  亦 fail-closed 自动拒绝）；**F2 = 关闭**（生产字节 == main@3ba3511，见上）。
- **六、如实登记的非阻塞遗留（不改变本封条）**：外部 Reviewer 99 最终裁决仍缺（**不得写成已获外部授权**）；
  AC2 `RESEARCH_FULFILLED`、AC6 生产事务腿尚无生产实例；6 个真实数据门在 CI 之外（发版前须本地跑）；POST-P4 可靠性债务
  G1（无生产形态启动门）/G2（CI 腿为本地回放）/HMR 上游漂移；R2-F2 非硬约束；`verify-install-plugin.mjs` 2 失败属既有 profile 漂移；
  **paths 清单之外的路径**不触发 L3 ⇒ 必需检查永不报告 ⇒ PR 判 `BLOCKED` 无法合并（本轮实测：改 `docs/_p4seal-probe.md`
  的探测 PR #101 `mergeable_state=blocked`）；而 `docs/roadmap/**` **已在清单内**（`.github/workflows/ci-level3.yml` 路径清单
  含该项）⇒ roadmap 文档 PR 会正常触发 L3 并受真实 AC6 E2E 必需门约束（本封条 PR #102 实证：3 项必需检查中
  `DSH boot + readiness smoke` 由 pull_request 事件自动排队）。处置 = 对清单外分支 `workflow_dispatch` L3 使必需检查在该 SHA 报告，
  或后续把必需门改为 always-run 的占位门。
- **七、治理一致性**：本文件 Phase 04 行状态前缀已由 `NOT VERIFIED / ROLLED BACK / AWAITING REDESIGN` 改为
  `VERIFIED (ENGINEERING-COMPLETE) / AWAITING EXTERNAL REVIEW`
  ＋ 封条指针；**09-23 评审裁决原文与 09-24 回滚事实作为 historical 完整保留不改写**。

---

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
- 2026-09-21：进入 **Phase 04 LEARN / Autonomous Learning R1**（baseline main=`6d0623627c4b38f6b870ef03fe9ed776186c9e09`；分支 `p4-learning-r1` + 隔离工作树 `.worktree-p4-learning-r1`，**不进生产 profile、不重启服务**）。
  只读 Gap Audit + **REUSE_MAP** 见 `GAP_AUDIT_R1.md`（结论：**无新增常驻服务 / DB / Authority**；P4 新增的只是一个派生经验库 + 生命周期状态机）。
  最小增量 = **2 个新文件 + 1 处仅导出改动**：`plugins/learn-core.mjs`（纯核心 674 行，零 IO 零依赖）、`plugins/learn.mjs`（插件壳 407 行，IO + 钩子 + 5 工具）、`docs/roadmap/evidence/cm-r4-log-decoder.mjs`（**仅加导出**，+25/−8）。
  **核心不变式**：(a) **提案 ≠ 激活**——召回只认 `APPROVED`，`ALLOWED_TRANSITIONS` 白名单，`REJECTED`/`RETIRED` 为终态不可复活；(b) **AC1 硬保证**——直接 `import` P2.5 官方提取器 `context-memory-core.mjs`（冻结为 `P25_EXTRACTORS`，缺失即 `missing_official_extractors` fail-closed），P4 物理上**不存在第二个 raw-session parser**；(c) R4 解码器仅补导出，实测解码输出**逐字节相同**（32388 帧 / 39827 行 / bad=0）；(d) 经验库 per-session 原子写 `%LOCALAPPDATA%\DSHHarness\state\learn\<sid>.json`，损坏 → `validateStore` 返回 null → **fail-closed 重建**；(e) 写入白名单 `experience-store/telemetry/audit-log` + 启动自检；(f) 密钥持久化前强制脱敏；(g) **ELIGIBLE ≠ PROMOTED**，无自动晋升；(h) 单开关 `LEARN_DISABLED=true`。
  **实测**：单元 **220 PASS / 0 FAIL**；真实会话 E2E **E1–E4 58 PASS / 0 FAIL**（真实 session 3227 节点，非 mock / 非 fixture）；AC7 全量回归 **19/20 绿**——唯一红 `tests/install-plugin/verify-install-plugin.mjs` 经实证为 **PRE-EXISTING**（11 个既有插件生产部署漂移，`git status` 全部未改动，P4 新增文件不在该检查范围）⇒ **只登记不擅修**。
  提交 `ede575e`（12 文件，+2926/−8）；**8 个主机哈希复核里程碑**已入 autonomy 账本。
  诚实说明：acceptanceCriteria 声明时 bindings 为 `kind:'none'`（write-once 不可改），故**逐条 AC 无主机侧 PASS 通道**，`verificationState` 保持 `UNVERIFIED`（底层交付物哈希已机器复核，AC 归属为据测试结果的判断，两者不混同）。
  状态置 **IMPLEMENTATION_COMPLETE / AWAITING_EXTERNAL_REVIEW**；**未 merge、未部署、不自称 VERIFIED**。
- 2026-09-21：**P4 LEARN R3 PRE-MERGE 独立 Release Gate 记录收口——9 条记录（R-1…R-9）全部处置完毕，PR #90 仍未 merge**。
  PR #90 的独立 Release Gate 评审（非自评）在 R3 收口后追加提出 9 条记录项：3 条 pre-merge + 6 条 low-risk。
  **已修 7 条**（其中 R-5/R-6 是评审标注「当前调用图不可达」但语义确实不一致的真实缺陷，一并关闭）：
  - **R-1**（证据自引用标注）：证据文件只写 `HEAD = <sha>`，而该 sha 是「生成时 HEAD」，文件本身在紧随其后的 docs-only 提交才落盘 ⇒ 读起来像"跑的不是最终代码"。现显式区分 `TESTED_HEAD`（被测代码）与落盘说明，记录 `WORKTREE` 状态，并附复核命令 `git diff TESTED_HEAD <evidence-commit> -- plugins tests/learn`（应为空）。
  - **R-4**（陈旧注释指向不存在的文件）：`plugins/learn-core.mjs:88` 声称覆盖率对齐由 `test-learn-no-secrets.mjs` 检查，该文件**在仓库中不存在**。现指向真实套件 `tests/learn/test-learn-r3-secrets.mjs`，**且把该断言真的加上了守卫**——新增 I 段（I1–I4）读取 `tests/reliability/secret-scan-check.mjs`、解析其 PATTERNS 家族名，与 learn-core 的规范家族集合做**双向、与顺序无关的集合相等**断言；扫描器新增家族而 learn-core 未跟进即 FAIL。
  - **R-5**（同一畸形输入两种行为，真实缺陷）：R3 只加固了 6 个吃 store 的函数中的 3 个——`propose`/`recall`/`recordRecall` 返回结构化 `{ok:false,error:'invalid_store'}`，而 `approve`/`reject`/`retire` 直接读 `store.experiences` 抛 `TypeError`。现收敛为**共用** `findExperience(store,id)` 助手，守卫无法再被逐个函数漏掉。
  - **R-6**（成功写入被静默丢弃，真实缺陷）：`withExperience` 按 `createdAt` 升序后 `slice(-MAX_EXPERIENCES)`，而 `makeExperience` 在调用方未给时间戳时写 `createdAt=0` ⇒ 新记录排最前被切掉，`propose()` 返回 `ok:true` 但库里没有。现「当刚写入的条目将被淘汰时，改为淘汰**最旧**条目」，保证 `ok:true` 的写入必在返回的库中；排序仍完全确定（共用 `byCreatedThenId` 比较器）。
  - **R-7**（回归脚本少算）：`run-r3-final-head-full.ps1` 原按 `^\s*PASS` 行计数，而汇总型套件（如 `redteam-r3-isolation.mjs` 只打印一行 `  PASS=13  FAIL=0`）被计成 `pass=1` ⇒ `totalPASS` 少算 12。现取「套件自报总数 vs 逐行计数」的**较大值**，兼容四种汇总格式，并新增 `src` 列标明来源（self/both/lines）。效果：isolation 1→13；`totalPASS` 908→978。
  - **R-8**（证据文件编码，直接损害可复核性）：`docs/roadmap/evidence/P4_LEARN_R3_FINAL_HEAD_FULL.txt` 是 **UTF-16LE（`FF FE` BOM）**，而同目录其它证据文件均为 UTF-8 ⇒ `read`/`grep`/CI diff 等普通文本工具判定为二进制文件、**评审无法读取复核**。根因＝证据由调用方 `pwsh ... > 文件` 重定向产生，而 Windows PowerShell 5.1 的 `>` 默认写 UTF-16LE。**根治而非一次性转码**：脚本自身以 `-OutFile` + `UTF8Encoding($false)`（无 BOM）写出，调用方的重定向方式不再能改变产物编码；`Write-Host` 全部改为 `Emit`（同时进控制台与待写文件，二者不可能分叉）。
  - **R-9**（测试写到自己声明之外的位置）：`redteam-r3-quality.mjs` 把 `_r3/r3_quality_sample.json` 写进**主工作区**，与其自身头注释「只写 `os.tmpdir()` 与 stdout」矛盾。现改为 tmpdir。
  - **附带**：把 `test-learn-r3-secrets.mjs` 正式纳入全量回归清单（28 → 29 套）。
  **全部 9 条均已关闭**（无遗留）：R-3 由 `d70a169` 修复；R-1/R-4/R-7/R-9 由 `9a57008`；R-5/R-6 由 `7202f68`；R-8 由 `6ba394a` 脚本根治；**R-2 由更新 PR #90 body 关闭**——原 body 停留在 R1（220 PASS / 58 E2E / 19-of-20 / 619+407 行，且 `R2`·`R3`·`412`·`276`·`F5`·`isolation` 出现次数均为 0），只读 PR body 的评审者看不到 R2/R3 又发现并修复的 10 个真实缺陷（属**低估**而非夸大）。
  **验证与反向对照**：
  - 断言套件合计 **478 PASS / 0 FAIL**（core 276 / r3-fixes 29 / hardening 30 / secrets 62 / real-E2E 59 / isolation 13 / contamination 9），观测型套件全 exit=0。
  - 最终 HEAD 全量回归 **29 套 / GREEN=28 / RED=1 / MISSING=0 / totalPASS=986 / totalFAIL=2**（`WORKTREE = clean`）；唯一红 `tests/install-plugin/verify-install-plugin.mjs` 经在 pristine HEAD 重跑实证为 **PRE-EXISTING**。
  - **变异对照（证明新断言非空洞）**：① 让 `findExperience` 的畸形守卫失效 → **恰好 1 条 FAIL** 且命中 H2.13；② 移除 R-6 容量淘汰修复 → **恰好 1 条 FAIL** 且命中 H2.15；③ 把扫描器家族 `aws` 改名为 `aws-renamed-mutation` → I3 与 F-aws 同时 FAIL。三次均在验证后**逐字节还原**源码。
  - R-8 修复后 `read` 工具可正常读取该证据文件（修复前报 `binary file`），与同目录证据编码一致（UTF-8 无 BOM）。
  **提交**：`d70a169`(R-3) → `9a57008`(R-1/R-4/R-7/R-9) → `7202f68`(R-5/R-6) → `6ba394a`(R-8 脚本根治) → 本 docs 提交（证据 + 文档）。**仍未 merge、未部署、未重启服务、不自称 VERIFIED**。

## 2026-09-21 — P4 合同逐字重建 + 独立 Delta Review（口径对账，零实现改动）

- **性质**：治理／文档收口。**未改动任何实现代码**（`plugins/learn-core.mjs`、`plugins/learn.mjs` 字节不变），未改生产配置、未重启服务、未 merge、未部署、**不自称 VERIFIED**。
- **触发**：发现 P4 报告所用 AC 编号与合同不一致，需先重建合同逐字口径再重新对账（否则「测试全绿」与「合同达成」之间口径断裂）。
- **交付物**：
  - `docs/roadmap/reports/PHASE_04_LEARNING/CONTRACT_RECONCILIATION_R1.md`（Stage A：合同 AC1–AC10 逐字重建 ＋ 实现→合同映射 ＋ 证据表 ＋ Delta 清单）
  - `docs/roadmap/reports/PHASE_04_LEARNING/INDEPENDENT_DELTA_REVIEW_R1.md`（Stage B：两路独立只读验证的收敛终裁 ＋ 分歧 ＋ 未覆盖 ＋ 副作用披露）
- **合同口径终裁**：`PARTIAL`。AC1–AC10 中 **3 PASS**（AC7／AC8／AC9；其中 AC7／AC9 属「空转成立」而非强制保证）／ **1 PARTIAL**（AC1）／ **6 FAIL**（AC2、AC3、AC4、AC5、AC6、AC10）。
- **合同「必须真实验证」4 次规定执行**：#1 缺失；#2 近乎同义反复（E2E 复用查询串 = 候选自身标题）；#3 **被实测反证**；#4 缺失。
- **最高风险（AC5，方向相反）**：实测三类环境故障文本（Provider 502／网络超时／服务不可用）**均产生 `failure` 信号并照样生成 PROPOSED 候选**，与合同「正确分类、不生成 Candidate」**方向相反**；且仓库 PHASE_03 已有 9 类失败分类器**未复用**（违反合同实现原则「先查已有」）。
- **口径断裂根因**：报告使用**自定 AC1–AC12**，与合同 AC1–AC10 不对齐 ⇒ 「测试全绿」不能作为合同达成证据。
- **独立性**：两路验证互不重叠、均只读、均未修改仓库或生产文件；在 AC1／AC2／AC3／AC4／AC5／AC10 上两路裁决**完全一致**；分歧点（D8 定性、报告诚实性评价）已在 Stage B §5.1 如实列出并采**更严口径**。
- **过程诚实记录**：两路均披露运行测试产生的 `%TEMP%` 临时目录（非生产数据，可安全删除）。
- **边界**：不代为决策、不擅自补实现（用户已裁定「不补，如实报告并交评审裁定」）；治理侧硬前置（P3 尚未获 Round 2 APPROVED）已另行收口（PR #91）。

- **2026-09-24 06:2x：P3 官方 APPROVED backfill ＋ P4 生产激活授权回滚（External Reviewer 裁决执行）**：
  - **裁决来源**：Notion `99｜Reviewer Feedback` 的 `P3 AUTONOMY R1 — External Review Round 2 FINAL` 与
    `P4 LEARN — External Governance Review` 两段（2026-09-23）。复核 canonical main = `00d28fcf`。
  - **P3**：Reviewer Verdict = **APPROVED**；`P3 VERIFIED AUTHORIZED = YES`；Round 3 = **NONE**；
    `PURE STATUS BACKFILL：仅授权，不执行` ⇒ 本轮执行 backfill（AWAITING_EXTERNAL_REVIEW → **VERIFIED**）。
    F1 closure = PASS；fresh tests 104/0 + 67/0。**PR #91 明确记录为 OPEN / NOT MERGED**，本轮**未 merge**，
    也未把其写成 merged。**未**采用旧 PR 的 stale diff —— 本轮 backfill 基于**最新 main 的新分支**重做。
  - **P4**：Question ① = NO、② = YES、④ = `OPTION 2 — ROLLBACK ACTIVATION`；**P4 = NOT VERIFIED**；
    **P5 = LOCKED / NOT STARTED**。
  - **回滚执行（配置层，已实证）**：`~/.dsh/profiles/web/cordis.patch.yml` 移除 learn 注册块；
    回滚后 sha256 = `a40558ada824884e3ba727a6151129a4bd25a865210123366104b8153b55519b`，
    **与 pre-P4 基线 `_backup-cordis.patch-learn-20260922-060153.yml` 逐字节一致**（含行尾）；
    YAML 有效（19 顶层条目）；`dsh --profile web --dump-config` 输出 **19,390 B**（原始字节实测，
    LF 行尾；早前所记 19,982 B 系 `Out-File` 编码改写所致的测量误差，已更正）**不含 learn**；
    注册插件清单与 pre-P4 **完全相同（18 个）**。回滚前安全备份：`cordis.patch.yml.pre-rollback-20260924-062516.bak`。
  - **保留（零删除）**：`learn.mjs`（sha256 `8b183e37…`）、`learn-core.mjs`（`a66ac2d8…`）、
    `%LOCALAPPDATA%\DSHHarness\state\learn\` 4 个经验库文件（合计 538,909 B）；**未** revert PR #90 / #92。
  - **运行态（2026-09-24 06:5x 更正）**：**原记「仍加载 learn / `RUNTIME_RELOAD_PENDING` /
    `MANUAL_SAFE_RELOAD_REQUIRED`」为误判，现撤回。** 事实：`cordis.patch.yml` 是 profile 的
    **用户覆盖层**，dsh 由 `@deepseek-ai/cordis-plugin-hmr` 对其做 **Cordis HMR 事务式热重挂**
    （`dsh-app-boot` 的 `watchUserPatches()` → `hmr.registerConfig(filename, …)` →
    `entry.update({ patches })`；源码注释即写明 "hot-reloaded on long-lived surfaces"），
    **改本层 patch 无需重启**；早前 RUNBOOK/DECISIONS 中「改 patch 需重启」的记载对该层不成立
    （那是启动期/`--patch` 叠加层的语义）。
    **实证链（同一 PID 18552，启动 2026-09-23 04:05:10，全程未重启）**：
    ① 经验库 `%LOCALAPPDATA%\DSHHarness\state\learn\session-04ecc1a4-…json` 最后写入
    **2026-09-24 06:24:52**（= 回滚动作前 24 秒）→ 证明 learn 在 18552 内确实活跃运行过；
    ② 回滚（06:25:16）之后该目录**零写入**（至今 >30 分钟）；
    ③ 回滚后于**同进程**新派发子代理，其工具清单（69 个，preset 同为本机 autonomous）
    **0 个 `learn_*`**；主 agent 工具清单同样无 `learn_*`；
    ④ `dsh --profile web --dump-config` 原始字节 **19,390 B**、插件清单含 `cordis-plugin-hmr`、
    **不含 `./learn.mjs`**。
    ⇒ **配置层与运行层均已回滚**，P4 的 `source == deployed == loaded` 成立。
    **无需用户做任何操作**；亦无需重启（重启只会重载同一份已回滚配置）。
    （更正说明：原「不强重启」的 SAFETY 判断本身无误——`restart-dsh-server-delayed.ps1`
    近 7 次尝试 5 FAILED + 1 卡 SPAWNED、全历史 108 次中 49 FAILED、`restart-budget.json` 有
    `candidateReady=true`/`stableCommitAt=null` 悬挂候选，该证据仍然成立且未被推翻；
    错的是「必须重启才能生效」这一前提。故保留「未执行重启」这一执行事实，仅撤回其结论。）
  - **未做（边界）**：未 force push、未重启 Windows/机器、未删用户数据或 learn 历史、未升级官方 DSH
    （`OFFICIAL_DSH_UPGRADE = NO`、`UPSTREAM_SYNC = BLOCKED` 保持）、未进入 P5（`PHASE_05_STARTED = NO`）、
    **未**修任何旁支缺陷（six pre-existing defects / restart 缺陷 / P4 合同缺口一律 `NOT FIXED / OUT OF SCOPE`）、
    **未**重新实现 P4、**未**补 P4 AC、**未**在 Reviewer 99 生成新 verdict（只记执行结果）。

  - **2026-09-28 00:25 P4 FINAL CLOSURE（R3 收尾回合，终局判定落地）**：
    - **判定：`P4 ≠ VERIFIED`**（两条独立阻塞，均**非**本轮修复引入）：
      ① **真人审批门结构上不可达**——本会话 approval policy=`never`，`dsh-user-approval` 在交互式
         分发**之前**直接返回 rejected；实测 `learn_review(approve)` → `approval_not_granted:rejected`、
         台账 `HUMAN_APPROVAL_REQUESTED → HUMAN_APPROVAL_DENIED`、全局库 `GLOBAL_PUBLISH_DENIED×2 / count=0`。
         ⇒ 代理**只能请求、不能授予**；需**真人在 policy=ask 的新会话**批准 `exp-2ed0f0c9`。
      ② **A10 独立复核确认 3 处合同缺口**（属既有范畴，本轮**只登记不修**）：AC2 运行时研究腿
         `researchPlan` 零调用（mandatory 场景①未达成）、AC6 Transaction/canary/deploy 腿零调用
         （`tests/learn` 中 `Transaction` 引用=0）、AC10 CI 内无真实 E2E 门（`ci-level2.yml:149-154` 自述排除 6 个真实门）。
    - **已完成并生产生效**：B1/B2 修复（分支 `p4-final-b1b2-fix` @ `0d3adf7`，PR #97 merge=`171f1b4`）；
      AC1 密钥族 **19** + 存量**自愈迁移生产生效**（重启后 `LEAK_AUDIT=CLEAN`，重启前 google=1/stripe=1 → **0**）；
      全量回归 **29/29 套件全绿、1129 PASS / 0 FAIL**；生产健康 **200**、learn 工具**恰好 6 个**、
      四插件 `source == deployed` 且 mtime < 服务启动时间、无重复注册 / 无崩溃签名 / 无未捕获异常。
    - **真实服务级重启（非推断）**：PID **15540 → 20580**（00:17:59 绑定；00:18:45 `COMMIT_READY: True` → committed）。
    - **本任务产物安全**：产物内 3 个文件含真实凭据副本（2 份配置备份含**与现行生产配置同值**的 Notion PAT、
      1 份生产 store 快照含 google/stripe 形态）→ **就地脱敏 + 逐文件复验 0 命中**；
      其余命中经无泄漏细看定性为源码表达式/文档示例/合成夹具（保留原样）。
    - **未做（边界）**：未冻结 `POST_P4_VERIFIED_GOLDEN`（判定不是 VERIFIED）、未进 STAGE B（`NO`）、
      未代外部评审出 verdict、未修任何旁支缺陷、未触碰生产配置与凭据库。
    - 报告：`docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/`
      （`P4_FINAL_VERDICT.md` + `A10_CONTRACT_MATRIX.md` + `AC1_ARTIFACT_REDACTION.md`）。

  - **2026-09-28 01:41 AC6 合同缺口关闭（真实三腿晋升 E2E，范围扩权后）**：
    - **判定增量：AC6 `PARTIAL → PASS`**（真实 E2E **24 PASS / 0 FAIL**）。**总判定不变：`P4 ≠ VERIFIED`**
      —— A8 真人审批门、AC2 研究腿、AC10 CI 内真实门**均未触碰/未关闭**。
    - **三腿全真**：真 `git worktree` + 真分支/commit `74fd41c9…`；**在该 commit 的 worktree 内真跑
      `ci-level2.yml` 作业命令**（14 命令全 exit 0、13 套件 PASS、环境隔离判据与 CI 相同）；
      真 `dsh-transaction.ps1` → `FinalState=COMMITTED` + `Verify=COMMIT_READY` + **journal 独立回读**；
      真 `mount-gate --hold host` 隔离宿主 canary（`127.0.0.1:3099`，生产 3080 PID 全程一致）。
    - **门有承载力（双向）**：正向真收据 ⇒ `PROMOTED` 且**只存 1859 B 有界摘要**；
      反向 3 组篡改（`ci.headSha`／`transaction.faultClass`／`git.branch`）⇒ **全拒 + `CANDIDATE_PROMOTION_DENIED` 留痕 + 状态不动**。
      不变量：晋升未改插件（`learn.mjs` `bf5cfa6d…`、`learn-candidate.mjs` `f732806a…`），工作区仍干净。
    - **修复前 19P/5F → 修复后 24P/0F**（两份原始日志均留档）。本轮在 AC6 路径上修掉 **4 个必经缺陷**：
      ① 候选 label 含 `:`（Windows 路径非法）→ 改 `candidate-<id>` + 引擎防御性清洗 + 门拒绝不安全 label；
      ② mount-gate 隔离未复现生产 profile 形态 → 临时 `DSH_HOME` + `--profile web`；
      ③ **PS 5.1 给 JSON 产物写入 BOM** ⇒ Node `JSON.parse` 报 `Unexpected token ''` ⇒ 收据门判事务腿无效
      （= 5 FAIL 的**总根因**）→ 引擎写 journal/manifest 改**无 BOM UTF-8**；
      ④ E2E 自身两处误判（本机无 `pwsh`、worktree 路径比较）→ 修 harness，非产品缺陷。
      **方法学**：`UTF-8 带 BOM` 与 `UTF-8 不带 BOM` 是**按消费方**定的两套要求——PS 脚本（给 PS 5.1 读）必须带 BOM，
      给 Node 解析的 JSON 必须不带。
    - **证据留档**：`docs/roadmap/evidence/AC6_REAL_E2E_R3_CLOSURE/`（8 文件，密钥扫描 **0 命中**）；
      报告 `docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/AC6_REAL_PROMOTION_CLOSURE.md`（含 §6 诚实的范围边界）。
    - **未做（边界）**：**未动 `main`**（只在特性分支 `p4-final-b1b2-fix`）、未重启服务、未改 `cordis.patch.yml`、
      未把插件部署到生产挂载位、**未放宽真人审批门**（本 E2E 的「晋升」用的是纯状态函数 + 自报审批字段，
      **不构成真人审批**）、未改 `tests/learn` 之外的生产代码。
    - **AC10 结构性说明（实测）**：`ci-level2.yml` 触发仅 `pull_request → main` 与 `push → reliability-v1`
      ⇒ 本特性分支**不可能**产生 GitHub 托管运行（证据 `ci.runUrl` 为空），关闭 AC10 需动 main / reliability-v1
      = **需人类裁决的范围扩权**；AC2（研究腿接线）同理。

  - **2026-09-30 P4 canonical 封条（AC10 客观闭合 → 工程口径 `VERIFIED`；外部 Reviewer 裁决仍缺）**：
    - **AC10 从 FAIL 到客观 PASS（线上只读 GET 前后对照）**：此前 required contexts 仅 L1/L2、`enforce_admins=false`、
      无 main ruleset ⇒ AC6 真实晋升 E2E 所在 `ci-level3.yml` 门 `required=false`、**红门拦不住合并**；
      现 required contexts = `Static + secret + syntax gate`｜`Reliability state machine tests`｜**`DSH boot + readiness smoke`**、
      `enforce_admins=true`、`strict=true`。**行为实证**：违规红灯 PR **#100 = BLOCKED**、真实 E2E 绿灯 PR
      **#99 = MERGEABLE → MERGED**（main=`3ba3511`，CLI 重取 `mergeCommit=3ba35117c417691218f8ac5e5a447df2b15aa283`）。
      存档：`_ac10/p4seal-evidence/branch-protection-main-20260930.json`、`merge-enforcement-canonical-20260930.json`。
    - **生产侧今日复核（非自述）**：4 个 learn 插件与 main@3ba3511 **git 对象身份同一**（LF 归一化 sha256 逐一相等）；
      运行时装载探针判定 **`NEW_CODE_LOADED`** 且 `learn_recall` 实时输出含 `researchDirective`；`GET / = 200`；
      工具面 **恰好 6 个 `learn_*` 且无重复注册**；原始输出存档 `_ac10/p4seal-evidence/`。
    - **合同矩阵 AC1–AC10 全 PASS**（AC10 由客观闭合达成），真人/运行时六项 + 晋升成立；**F1/F2 均关闭**
      （F1 = 授权只能由宿主真人审批缝写入、插件自审批在生产字节下被拒；F2 = 生产字节 == main）。
    - **F2 复核方法学（本轮更正）**：先前“生产与 main 不一致”的结论属**测量口径错误**——生产工作副本为 CRLF
      （`learn.mjs` 135,030 B / 2,238 个 CRLF），git blob 为 LF（132,792 B）；正确判据是 **git 对象身份**
      （`git hash-object(生产文件)` == `git ls-tree main` 的 blob）或 **LF 归一化 sha256**，二者均逐一相等。
      ⇒ 凡“字节同一”类判定必须显式声明比较口径（raw / LF 归一化 / git 对象），否则会得出假 DIFF。
    - **如实登记的遗留（不改变本封条）**：外部 Reviewer 99 最终裁决仍缺；AC2 `RESEARCH_FULFILLED` 与 AC6 生产事务腿尚无生产实例；
      6 个真实数据门在 CI 之外（发版前须本地跑）；POST-P4 可靠性债务 G1/G2 与 HMR 上游漂移；`sessionStoreMaxFiles` 语义未证；
      **paths 清单之外的路径 PR 不触发 L3 ⇒ 必需检查永不报告、PR 永久 blocked**（实测探测 PR #101 = `BLOCKED`，其唯一改动
      `docs/_p4seal-probe.md` 不在 `.github/workflows/ci-level3.yml` 的 paths 清单内），
      **更正**：`docs/roadmap/**` 属清单内路径 ⇒ roadmap 文档 PR 会正常触发 L3（本封条 PR #102 实测三必需检查全部排队）；
      处置 = 对文档分支 `workflow_dispatch` L3 使必需检查在该 SHA 报告，或把必需门改为 always-run 占位门。
    - 封条与证据索引：`_p4r2-final-closure/POST_P4_FINAL_GOLDEN_20260930.md`（工作区）。

  - **2026-10-01 External Review remediation（D1–D13）——审计基线 `main@63bf5585c64742169c8b66ddfc2938e7de936343`**：

    > 本段是**唯一当前状态口径**。凡本仓库内其它文档（尤其 2026-09-28 及更早的历史报告）与本节冲突，
    > **一律以本节为准**；历史文档保留原样，冲突以"时效标注"消解（见 D1）。

    - **① 当前 AC 状态（唯一口径）**：**AC1–AC10 全部 PASS**。
      判定字符串 = `VERIFIED (ENGINEERING-COMPLETE) / AWAITING EXTERNAL REVIEW`。
      `POST_P4_VERIFIED_GOLDEN` **未冻结**；`P4_PRODUCTION_ACTIVATED = NO`；`PHASE_05_STARTED = NO`。
      合同来源（canonical 逐字）：`docs/roadmap/reports/PHASE_04_LEARNING/CONTRACT_RECONCILIATION_R1.md:122-132`；
      4 个 mandatory 场景逐字：同文件 `:115-120`。

      | AC | 合同要求（逐字摘要） | 当前状态 | 仓库内可复算的当前证据 |
      |---|---|---|---|
      | AC1 | Experience compact、结构化、无 Secret | **PASS** | `tests/learn/test-learn-ac1-secret-families.mjs`（19 家族 + 库级幂等）；`tests/reliability/secret-scan-check.mjs`；**2026-10-01 口径更正见 §③** |
      | AC2 | 不会的问题不第一时间失败/问用户，低风险会自主研究 | **PASS** | `tests/learn/test-learn-ac2-research-leg.mjs`（接线锁）+ `_ac2-mutation-proof.mjs`（7 突变负控）+ `ci-level2.yml` 内 exit 0 |
      | AC3 | 经验只有验证成功后进入 verified | **PASS** | `tests/learn/test-learn-stage2-schema-and-negative-lock.mjs`、`test-learn-r2-b1-approval-gate.mjs`、`test-learn-b2-verify-output-contract.mjs` |
      | AC4 | 复用时做环境/version check | **PASS** | `tests/learn/run-learn-contract-scenarios.mjs`（场景②） |
      | AC5 | Failure Classification 能阻止错误学习 | **PASS** | `tests/learn/test-learn-ac5-gap-veto.mjs`、`test-learn-ac5-e2e.mjs` |
      | AC6 | Candidate 复用现有 CI/Transaction，不造第二套 promotion engine | **PASS** | `tests/learn/test-learn-ac6-real-promotion-e2e.mjs`（真三腿 E2E）+ `ci-level2.yml` 三腿接线 |
      | AC7 | Candidate 无法直接覆盖 Stable | **PASS** | `test-learn-stage2-schema-and-negative-lock.mjs` 的 Stable 守卫断言 |
      | AC8 | 无常驻学习 daemon / vector DB / 自训练平台 | **PASS** | `plugins/learn*.mjs` 全为按需事件钩子，无 daemon/DB 依赖（静态可核） |
      | AC9 | Learning 不导致插件数量无界增长 | **PASS** | `tests/learn/validate-gate-registry.mjs`；learn 插件集固定 4 件 |
      | AC10 | 真实 E2E 证据 PASS | **PASS** | 2026-09-30 客观闭合：required contexts 三项 + `enforce_admins=true` + `strict=true`；红灯 PR #100 = BLOCKED / 绿灯 PR #99 = MERGED（`3ba3511`）；工作流 `.github/workflows/ci-level2.yml`、`ci-level3.yml` |

      **mandatory 场景（合同原文「至少设计并执行」）**：4 个场景**全部已执行**（① 合成+真 CI；
      ② 合成门 + 真实跨会话复用受真人审批门正确保护；③ 真实生产遥测 `GAP_VETOED=4`；
      ④ 真 E2E 受控案例 + 篡改负向全拒）。**诚实边界**：②④① 的"**生产自然实例**"仍缺
      （① 未在无经验的生产任务上自然发生；② 生产自然跨会话复用 = 0 次，被"无真人审批"正确拒绝；
      ④ Candidate 生产自然晋升 = 0 次）。这是**已知边界**而非"达成与否"之争。

    - **② D1 历史文档时效标注索引（矛盾以标注消解，不删不改历史）**：

      **标注规范（单一 token，机器可核）**：全部替换性标注共用同一 token「**2026-10-01 时效标注**」，
      且一律**追加在历史行的行尾**（保证历史行原文仍是该行的严格前缀 ⇒ "一字未改"可被机器证明，
      而非只靠人工比对 diff）。

      **配套门（本轮新增，均可重复运行）**：
      - `docs/roadmap/P4_STATUS.json` —— **parity index（不是权威面；权威面 = 本文件）**；
      - `node tests/roadmap/validate-p4-status-consistency.mjs` —— **43 项断言**：本文件与索引**双向**平价、
        全部已登记历史文档必须带标注、**仓库级扫掠**（任何**未登记**文档复述被取代结论即红灯）、
        post-P4 四项锁（GOLDEN 未冻结 / 未上生产 / P5 未开 / P4.5 未开）；
      - `node tests/roadmap/verify-history-preserved.mjs` —— **逐行证明历史未被改写**：对每个已登记文档，
        HEAD 修订的**每一非空行**都必须仍以工作树某行为严格前缀。
        本轮回执：**14/14 文档、1420 行全部通过**（含 55 行表格分隔行豁免）。

      | # | 文档（仓库内路径） | 其历史结论（正文逐字保留） | 标注 |
      |---|---|---|---|
      | 1 | `docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/A10_CONTRACT_MATRIX.md` | `AC6 / AC10 = PARTIAL`、`P4 ≠ VERIFIED`、场景 ①未达成/②半达成/④部分达成 | 文首标注 + 5 处行尾标注 |
      | 2 | `…/R3_FINAL_CLOSURE/P4_FINAL_VERDICT.md` | **标题即** `P4 ≠ VERIFIED` | 文首标注 + 3 处行尾标注 |
      | 3 | `…/R3_FINAL_CLOSURE/AC2_RESEARCH_LEG_CLOSURE.md` | 继承被取代的总判定 | 文首标注 + 2 处行尾标注 |
      | 4 | `…/R3_FINAL_CLOSURE/AC6_REAL_PROMOTION_CLOSURE.md` | L23 指向 `A10_CONTRACT_MATRIX.md:33` 并称裁决 PARTIAL（**指针已不再解析到所引原文**） | 文首标注 + 2 处行尾标注 + 指针失效说明 | 〔**2026-10-01 D 修复**：本行的行号式引用只作历史描述；该文件的定位改用锚点 `AC6.gapSection` / `AC6.a10pointer`，真实行号由 `node tools/check-doc-anchors.mjs` 当场算出〕 |
      | 5 | `…/R3_FINAL_CLOSURE/AC10_GATE_REGISTRY_AND_REAL_E2E_IN_CI.md` | "CI 内无真实 E2E 门"（AC10 已于 2026-09-30 客观闭合） | 文首标注 + 1 处行尾标注 |
      | 6 | `…/R3_FINAL_CLOSURE/PRE_DEPLOY_PREFLIGHT.md` | 部署前旧口径 `P4 ≠ VERIFIED` | 文首标注 + 1 处行尾标注 |
      | 7 | `…/R3_FINAL_CLOSURE/evidence/POST_RESTART_STATE_AND_READINESS.md` | 重启后就绪度证据 `P4 = NOT VERIFIED` | 文首标注 + 1 处行尾标注 |
      | 8 | `…/R3_FINAL_CLOSURE/evidence/POST_RESTART_LOAD_AND_REGRESSION.md` | STAGE B 前置条件表述 | 文首标注 + 1 处行尾标注 |
      | 9 | `…/PHASE_04_LEARNING/R2/RELEASE_EVIDENCE_INDEX.md` | 把 `NOT VERIFIED / ROLLED BACK / AWAITING REDESIGN` 逐字抄为"让位"目标（**让位对象本身已更新 ⇒ 该行成为残留**） | 文首标注 + 1 处行尾标注 |
      | 10 | `…/PHASE_04_LEARNING/CONTRACT_RECONCILIATION_R1.md` | R1 期合同口径（`合同口径结论：PARTIAL`） | 文首标注 + 2 处行尾标注 + 备注行 |
      | 11 | `…/PHASE_04_LEARNING/INDEPENDENT_DELTA_REVIEW_R1.md` | 独立增量评审旧终裁 | 文首标注 + 2 处行尾标注 |
      | 12 | `…/PHASE_04_LEARNING/REPORT_R1.md` | 使用**自定 AC1–AC12 编号**（与 canonical AC1–AC10 语义不同） | 文首标注 + 编号声明行 + 1 处行尾标注 |
      | 13 | `RELIABILITY_HOTFIX_RH2_R1_REPORT.md`（根） | `P4 = LOCKED`（封条前口径） | 文首标注 + 1 处行尾标注 |
      | 14 | `RELIABILITY_RH2_R11_OVERNIGHT_REPORT.md`（根） | `P4=LOCKED`（封条前口径） | 文首标注 + 1 处行尾标注 |

      **D8 编号消歧（与上表同批，独立登记）**：`tests/learn/test-learn-core.mjs`（注释中的 `(ACn)` 指向
      R1 自定编号）与 `REPORT_R1.md` 的自定编号表，均已加**编号体系声明**，防止"同号不同义"被误读为矛盾。
      该两项由 `P4_STATUS.json` 的 `numberingDisambiguated` 登记并受同一门校验。

      **不列入上表的"非矛盾"项**：更早的 2026-09-23 **回滚**记录
      （`P4 = NOT VERIFIED` / 旧插件副本）**属不同时间基线**，其执行事实在本文件内**原样保留**；
      按定义它不构成"同一基线自相矛盾"，故不标注、不修改（`validate-p4-status-consistency.mjs` 的
      **C8 断言**专门锁住"该回滚记录仍然存在"，防止后续被"顺手清理"）。

      → 同一 audited baseline（`main@63bf558`）在仓库内**只承认 ①** 这一个 AC 状态。


    - **③ D2 封条证据可得性（如实声明；D2 采纳"索引处明写"方案）**：
      - 2026-09-30 封条引用的证据目录 **`_p4r2-final-closure/`** 与 **`_ac10/p4seal-evidence/`**
        **不在仓库内**：`gh api repos/ZTKyo/deepseek-harness-desktop/contents/_p4r2-final-closure?ref=main`
        与 `.../_ac10/p4seal-evidence?ref=main` 均返回 **`Not Found`**。它们**仅存于操作者工作区**
        `C:\Users\Administrator\Desktop\sdeepseek harness\` 下。
      - **⇒ 外部 Reviewer 仅凭 `main` 无法复核封条中"生产侧/证据目录"那部分**；复核需操作者另行提供该目录，
        或由操作者按下列仓库内可复算项目自行重建。
      - **仓库内可独立复算（不依赖上述目录）**：`.github/workflows/ci-level1..4.yml`、`tests/learn/**`、
        `tests/reliability/**`、`docs/roadmap/evidence/**`、`plugins/learn*.mjs`（含 SHA256）；
        分支保护/合并约束类结论可用 **只读** `gh api repos/<slug>/branches/main/protection` 与
        `gh api repos/<slug>/rulesets` 现场重取。
      - **为何不把证据目录"入库"**：该目录含**与现行生产配置同值的凭据副本**（`AC1_ARTIFACT_REDACTION.md`
        记载就地脱敏过 3 个文件）以及生产 store 快照 —— 批量入库会把凭据面搬进长期版本历史，
        **风险高于收益**。故采纳评审给出的替代方案（索引处明写），并在此**明确标注该项复核的外部依赖**。

    - **④ D11 密钥审计口径更正（度量假阳性 ⇒ REAL SECRET = 0）**：
      - **根因**：插件自身的脱敏占位符 `[REDACTED:uri-credential]` 处在 `postgres://…@host` 形态内时，
        会被 `uri-credential` 家族正则**再次命中**（占位符含 `:`，形似 `user:pass@`）。
        即"扫描器把自己的输出再报成新泄漏"。
      - **复算**：对同一文本，剥掉 `[REDACTED:<family>]` 标记后 `containsSecret` = **false**、命中 = **0**。
        ⇒ 此前 AC1 记的「存量 2 命中（google=1 / stripe=1）」中，**uri-credential 形态的那部分为度量假阳性**；
        真实密钥计数 = **0**。
      - **口径（自 2026-10-01 起强制）**：任何密钥审计输出必须**分开报告三个数** ——
        `RAW MATCH` / `REDACTION PLACEHOLDER` / `REAL SECRET`；**只允许把 `REAL SECRET` 当作泄漏结论**，
        `RAW MATCH` 单独出现时不得表述为"发现泄漏"。
      - **边界（不降低灵敏度）**：占位符豁免**仅**对 `[REDACTED:<family>]` 这一种由本插件生成的标记生效
        （标记被剔除后重新扫描，而非"整行跳过"），**不新增**任何跨结构白名单；
        含密钥形态的**真实**文本仍必须被判为 `REAL SECRET`。回归用例 A–D：
        `tests/reliability/test-redaction-aware-audit.mjs`（A 干净=0/0/0；B 单条脱敏 ⇒ REAL=0；
        C 真实密钥仍被抓 ⇒ exit 非 0；D 生产只读审计分列三数）。
      - 实现：`tests/reliability/redaction-aware-secret-audit.mjs`（审计层新增，**learning 插件未改字节**）。
      - **F 补记（External Review Finding F，2026-10-01；无需改动、只固定作用域）**：评审的对抗性检查
        **通过** —— 掩码只会"**造出**"命中（把已脱敏文本再次命中），**不会删除**命中 ⇒ **未削弱**检测能力。
        其结论为：该掩码是**防误提交的回归门**，**不是**防恶意提交者的安全边界（恶意提交者可绕过工程门）；
        安全保证来自**真实密钥计数 = 0** 与**逐次审计**。此处把这句作用域**明写固定**，避免后续把工程门
        误读成安全边界。

    - **⑤ D12 脱敏自愈作用域更正**：
      - **实现事实**（`plugins/learn.mjs:594` → `learn-core.mjs:542 redactStore`）：自愈在
        **`loadStore(sid)` 成功之后**执行，作用域 = **该次被载入的那一个会话库**；
        命中即 `saveStore` 落盘；`heal.skipped` 非空时**保守保留原值**并上报 `STORE_REDACT_SKIPPED`。
      - **⇒ 准确表述**：「**当前已加载会话的库已自愈；历史库未扫掠**」。
        **不**表述为"历史存量已全部清除"或"全库扫描完成"。
      - **依据（生产实测，2026-10-01 只读复核）**：`%LOCALAPPDATA%\DSHHarness\state\learn\` 下
        3 个 `schemaVersion=1` 旧库与含 `[REDACTED:` 标记的历史库 **mtime 全部早于** 2026-09-28 重启
        ⇒ 未被扫掠；会话库写入时点与该会话被载入的时点一致。
      - **E 更正（External Review Finding E，2026-10-01；机制不变、口径收窄）**：上面这条**依据的
        表述过宽**，现更正为**可当场复算**的点值口径（原句按 append-only 纪律保留在上一行）：
        ① **「3 个旧库」必须点明是哪一种库**——同目录 `schemaVersion=1` 的文件**共 4 个**：3 个会话期旧库
        （mtime `2026-09-23 05:27–05:28+08:00`）＋ **1 个全局已验库索引** `_global-verified.json`
        （mtime `2026-09-29 01:24:49+08:00`）；剔除索引文件才得 3 ⇒ 评审者复算得 4 属**类别歧义**，非数据漂移。
        ② **删除过宽句「重启后仅当前活动会话库被写入」**：该索引文件 mtime **晚于** 09-28 重启边界，
        即重启之后确有写入；且它**不在**自愈路径上（`redactStore` 全仓**仅一处**调用点，作用于被载入的会话库）。
        ③ **「含标记库 mtime 未变」降级为逐文件 + 带时点**：封条时点那个含标记历史库 mtime 确实未变，
        但测量当日含标记文件共 **5 个**、其中 **3 个是封条之后才被载入**的 `session-*` 会话库
        ⇒ **不得**写成一般句（"含标记库 mtime 未变"）。
        ④ **所有计数为点值、非常量**：上列数字是 `2026-10-01 12:23:16+08:00` 的**点值**
        （同一目录两次测量间最新文件 mtime 即从 `12:21:30` 推进到 `12:22:49`），且**时间戳一律标注时区**
        （本地 `+08:00` 与 UTC 相差 8 小时，正是"两份清单看起来对不上"的另一个来源）。
        复算命令 `node tools/learn-store-census.mjs`（只读、离线自检 14 断言、读不到即 fail-closed）；
        证据档 `docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/evidence/E_D12_STORE_CENSUS_20261001.md`。
      - **正确性上无问题**（AC1 只要求"进入 Experience 的内容无 Secret"）；此处**只更正描述口径**，
        并把"历史库不批量扫掠"登记为**已接受的设计边界**（如需全库扫掠，应作为独立维护动作另行授权）。

    - **⑥ D13 `source == production == loaded` 的准确作用域**：
      - **成立的部分**：`plugins/learn.mjs`、`learn-core.mjs`、`learn-candidate.mjs`、`learn-gap-veto.mjs`
        **4 件 learn 插件**：源（`main` blob，LF 归一化 sha256）== 生产挂载位字节；装载由
        **运行时行为探针**判定（不以 mtime 作装载证据 —— profile 插件有 HMR 热挂载，mtime 与装载无因果）。
      - **不成立 / 曾被过度概括的部分（如实登记为已知分歧，本轮不修）**：生产 profile 与 `main`
        在**非 learning** 插件上存在分歧，共 **5 件**：
        `openrouter-router-core.mjs`、`model-registry.mjs`、`provider-registry-core.mjs`、
        `model-selection-guard-core.mjs`、`provider-registry.mjs`；差异集中在 **model-id 级别**
        （`provider-registry-core.mjs` 27 行 / `model-selection-guard-core.mjs` 6 行等）。
      - **⇒ 口径**：今后只能说「**learn 4 件插件 source == production == loaded**」，
        **不得**推广为"整个插件面与 main 一致"。
      - **处置**：这 5 件的分歧归属 = **用户本机模型接入面决策**，**不在 P4 范围**；
        本轮**只登记、不修改、不部署**（改它们会动生产模型路由 = 高风险且与 P4 无关）。
        需用户单独裁决后再动。

    - **⑦ D3 / D4 合并门根因分类（只读复核；本轮**未修**，需业主授权）**：
      - **专档（根因分类 A–G / BEFORE-AFTER / 修复蓝图 / 未判定项 / 复现命令）**：
        `docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/evidence/D3_D4_MERGE_GATE_GOVERNANCE_20261001.md`
      - **`--strict` BEFORE/AFTER（禁造假）**：`node tests/learn/audit-merge-enforcement.mjs --strict`
        **BEFORE = exit 1、AFTER = exit 1（未变）**。原因：根因全在 **GitHub 设置 + workflow 触发**
        层面，本轮**未**触碰它们；**未**加 exit-0 硬编码、**未**删规则、**未**把红灯包成"总是成功"。
        三道防伪证明：① `git diff --quiet HEAD -- tests/learn/audit-merge-enforcement.mjs` → **0（字节未变）**；
        ② 本轮未创建/删除任何 GitHub 规则；③ 本轮新增的 `tests/roadmap/*` 与
        `tools/check-l3-paths-coverage.mjs` 都是**独立新门/只读分析器**，不参与该审计器的判定。
      - **根因分类**：
        **A** 无任何 workflow 在 `push → main` 触发（L1/L2 仅 `push[reliability-v1]`，L3 无 push，L4 仅手动/定时）；
        **B** `required_pull_request_reviews=null` 且 **rulesets = 0** ⇒ 无规则禁止直推 main；
        **C** 必需检查语义不覆盖直推（依赖 ruleset；含 1 个未判定前提，可用一次可逆实验定案）；
        **D** **L3 被 workflow 级 `paths:` 过滤 ⇒ 211/638 文件 = 33.1% 的 PR 必需 context 永不报告、
        永久卡在 "Waiting for status to be reported"**（含生产代码 `src/DSHHarness.cs`、
        `plugins/cordis.patch.yml`、`supervisor-mcp-adapter/server.mjs`）；
        **E** 审计器把"无 ruleset"本身视为直推路径的绕过承载；
        **F** `main` HEAD 的 `check-runs = 0`（证据可得性，独立事实）；
        **G** canonical 合同与执行 Prompt **全文无** ruleset / branch protection / `push:main` / 直推字样
        ⇒ **D3 不构成 AC10 失败、不推翻 2026-09-30 封条**，属**超合同加固项**（此前未登记，本轮补登）。
      - **本轮独立复算（不依赖任何自述）**：
        `node tools/check-l3-paths-coverage.mjs` → `tracked = 638`、`OUTSIDE the filter = 211 (33.1%)`；
        `git grep -n 'reliability-v1' -- .github/workflows/` → 仅 `ci-level1.yml:7`、`ci-level2.yml:7`。
      - **口径纠正（防后续踩坑）**：评审给出的"加 ruleset **或** 加 `push:main` 触发，**二者任一**即可让
        审计器转绿"**不成立**；把审计器布尔式按线上值逐式代入后，**只有**「含 `pull_request` 规则、
        `bypass_actors` 为空的 main ruleset」能**单独**转绿（audit exit 0）。且**顺序铁律 = 先修 D4
        （paths 死锁）再修 D3**，否则清单外 211 个文件从"可绕行"变成"彻底无路"。
      - **处置**：**本轮未修**。改 D4 = 变更**必需门语义**（有"命中清单却不真跑 E2E"的假绿风险，
        须配断言兜底 + PR 探针验证）；改 D3 = 变更**仓库能力边界**（业主将永久失去直推 main 的能力）。
        二者均超出"修 bug"授权 ⇒ 登记为**待授权**项并附最小蓝图；若后续执行，D3 的
        `required_approving_review_count` **必须 = 0**（否则单操作员仓库永远无法合并任何 PR）。

    - **⑧ D 修复：文档定位弃用手写行号、改用可机检锚点（R2 2026-10-01；根因级）**：
      - **根因（实测，非推测）**：「字母 L + 数字」式、或「文件名 + 冒号 + 数字」式的**手写行号指针**
        属于**派生数据**，文档一改即整体偏移（实测 `A10_CONTRACT_MATRIX.md` 此后整体偏移 **+34 行**），
        而指针"看着还在"、没有门会响 ⇒ 上文 D1 索引中登记「指针已不再解析到所引原文」的那一行
        （即 `ban.STATUS.d1row` 锁定的行）才会出现该现象。
        修法**不是**"把行号改对一次"（下次仍会漂），而是**取消手写这个动作**。
        （本段刻意不复述那批失效数字，避免在"取消手写"的同时再造出新的行号指针。）
      - **修法三层**：① 锚点解析（`P4_STATUS.json` → `docAnchors` 13 条，真实行号由
        `node tools/check-doc-anchors.mjs` **当场算出并打印**；锚点缺失/不唯一 ⇒ FAIL，fail-closed）；
        ② 回归锁（`linePointerBans` 阻断**新写入**的行号式定位，判据 = 命中禁用式 ∧ 非
        `git show HEAD:<file>` 的冻结文本 ∧ 未同时给出锚点；历史行按 D1"只标注不改写"纪律豁免）；
        ③ 证明层（负控测试证明这道门**能真的变红**，不是装饰门）。
      - **两道负控（原始输出见专档）**：
        ① 真实文档注入：在 A10 更正表 banner **新写入**一条裸行号 →
        `ban.A10.banner FAIL :: 1 new hand-written line pointer(s) without an anchor`、**exit 1**
        （随后逐字节还原，复跑恢复 PASS）；
        ② 离线 fixture：`node tests/roadmap/test-anchor-gate-negative-control.mjs` →
        裸行号必须红 / 同带锚点必须绿 / 被禁区块外不误杀 = **3/3 PASS**、exit 0。
      - **专档（根因 / 修法 / 原始输出 / 范围与边界 / 复现命令 / 未判定项）**：
        `docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/evidence/D_DOC_ANCHORS_20261001.md`
      - **范围与边界（如实登记，不放大结论）**：禁令当前覆盖 **2 处已确认漂移点**；
        全仓普查（`--census`，启发式）**扫描 124 个文档、候选 318 处、涉及 58 个文件**，
        多为历史文本/命令输出示例 ⇒ 按 D1 纪律**只标注、不改写**，本轮**未**做全仓改写
        （全仓改写会与历史保全门"历史行必须仍在"直接冲突，属需另行授权的动作）；
        且本段**不抄录任何会漂的行号**，需要行号时一律跑门当场打印。
      - **边界**：本条只做"定位方式"的治理更正——**未**改任何 learning 插件字节、**未**动生产、
        **未**改 GitHub 规则、**未**新增/关闭 PR、**未**代外部评审出 verdict。


    - **边界（本段只做治理/口径更正）**：本轮**未**改任何 learning 插件字节（4 件 learn 插件
      SHA256 与基线逐一相同 ⇒ **无需重启、未重启**）、**未**改 `cordis.patch.yml`、**未**动生产凭据、
      **未**改任何 GitHub 规则/分支保护、**未**改任何 workflow 触发、**未** dispatch/建/关 PR、
      **未**启动 P4.5（`PHASE_05_STARTED = NO`、P4.5 未开）、**未**冻结 GOLDEN、
      **未**代外部评审出 verdict。本轮新增内容**只**是：独立新门（`tests/roadmap/*`，含
      `test-anchor-gate-negative-control.mjs` 负控）、文档锚点门与锚点注册表
      （`tools/check-doc-anchors.mjs` + `P4_STATUS.json` 的 `docAnchors`/`linePointerBans`）、
      只读分析器（`tools/check-l3-paths-coverage.mjs`）、parity index（`docs/roadmap/P4_STATUS.json`）、
      历史文档的**行尾**时效标注、以及本段的治理记录。


