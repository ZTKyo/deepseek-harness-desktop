# P4 LEARN — 合同逐字重建 + 合同对照表 + Delta 清单（Stage A）

- 生成时间：2026-09-21
- 性质：只读重建（本文件不修改任何实现代码）
- 合同来源（canonical，Notion，fresh-fetch）：
  - 主合同页：`04｜LEARN / Autonomous Learning`，page_id `3c5357fd-c5d6-8149-b03b-d8a854bbec49`，**Status = `TODO`**
  - Master Roadmap：page_id `3c5357fd-c5d6-81b6-af19-d6cdf2a6b444`（本页只链接各 Phase 页，不承载 P4 细则）
  - Reviewer 权威页：`99｜Reviewer Feedback｜外部审核与修复指令`，page_id `3c5357fd-c5d6-81c2-b477-c7850f984eb7`
  - 前置阶段页：`03｜AUTONOMY｜Task Autonomy`，page_id `3c5357fd-c5d6-8199-927a-f9244aa0ea6e`
- 仓库侧基线：`origin/main = 6d0623627c4b38f6b870ef03fe9ed776186c9e09`（fresh-fetch 实测，与 P4 baseline 同一提交）
- 仓库侧工作分支：`p4-learning-r1` ＋ 隔离工作树 `.worktree-p4-learning-r1`；PR **#90**，HEAD `4cc0832eed575301ec7188bc11fb7896c36985a1`

---

## 1 Notion 原始合同（逐字重建）

> 以下为 Notion 主合同页 `04｜LEARN` 的原文重建，未改写、未摘要、未补全。

### 1.1 页头

```
Phase 04 — LEARN / Autonomous Learning
目标：实现"不会 → 自主研究 → 解决 → 验证 → 保存经验 → 下次复用 → 重复缺口才生成 Candidate Skill"的闭环，
但不建设无限自我迭代系统。
```

### 1.2 Status

```
- `TODO`
```

### 1.3 完整执行 Prompt（逐字）

```
你正在执行 Phase 04：LEARN / Autonomous Learning。
前提：Phase 03 必须已外部 VERIFIED，否则停止。

【核心目标】
让 Harness 在遇到不会的问题时，先自主解决并沉淀可复用经验；只有重复出现的稳定能力缺口才固化为 Candidate Skill。禁止把"学习"做成无限修改自身的系统。

【实现原则】
1. 第一版优先 policy + file-based structured knowledge；禁止引入向量数据库、常驻学习 daemon、复杂 memory platform。
2. 先查已有 Experience / Skill / Tool / code / docs，再决定是否需要新能力。
3. 所有经验必须经过真实成功验证后才能标记 VERIFIED_EXPERIENCE。
4. 失败原因必须先分类，避免把网络/Provider/环境故障误学成 Skill 缺陷。
5. 复用历史经验前必须重新检查当前版本/环境是否仍适用。

【Autonomous Problem Solving Loop】
收到任务
→ 查询已有 Experience
→ 查询已有 Skill/Tool
→ 若仍不会：读取真实错误与环境
→ 查官方文档 / GitHub / 网络 / 当前代码
→ 选择最低风险可逆方案
→ checkpoint
→ bounded attempts
→ 失败则分类并换路线
→ 成功则 deterministic verify
→ 保存 compact verified experience

【Failure Class】
至少：Environment / Provider / Network / User / Website / Tool / Skill / Model / Unknown。

【Experience Store】
优先保存在 Private Deployment knowledge 结构或当前适合的私有可版本化位置；不得保存 Secret。
每条经验只保留：
- id/title
- taskType / trigger / symptoms
- applicable versions/environment
- rootCause
- successfulMethod
- failedOrUnsafeMethods（有价值时）
- verificationEvidence
- rollback
- source links/commit（适用时）
- stale/expiry conditions
- lastVerifiedAt
禁止保存整段聊天、全量日志、巨大 tool output。

【复用规则】
相似任务 → 检索 experience → 检查适用性 → 复用 → 重新验证。
历史经验只是先验，不是绝对真相。

【Capability Gap / Learning Seed】
只有满足重复阈值且证据显示是同一真实能力缺口时：
Task Type + Failure Signature 重复
→ dedup
→ gap record
→ research
→ Candidate Skill/Plugin/Rule。
优先级：Rule > extend existing Skill > new Skill > new Plugin。

【Candidate Lifecycle】
Candidate 禁止直接覆盖 Stable。
必须复用现有 Git / branch / tests / CI / Reliability Lab / Transaction：
Candidate → isolated tests → regression/holdout → canary → PASS promote / FAIL reject。
失败 Candidate 保留最小失败记录，不长期挂载 Runtime。

【瘦身】
不要新建独立"清理系统"。只记录 metadata：usageCount / successRate / lastUsed / replacement / status。
第一版只做 dedup/Archive/Prune 建议，禁止自动删除 Stable。

【边界】
自动研究 ✅
自动总结经验 ✅
自动生成 Candidate ✅
自动测试 Candidate ✅
未经验证自动替换 Stable ❌
自动修改 Official Core ❌
无限安装 Skill/Plugin ❌
无限重试 ❌
Secret 进入 Experience ❌

【必须真实验证】
至少设计并执行：
1. 一个"没有经验"的陌生低风险任务：自主研究→解决→保存经验。
2. 第二次相似任务：成功检索并复用经验，且重新验证。
3. 一个伪能力缺口（例如网络/Provider 故障）：正确分类，不生成 Candidate。
4. 一个重复真实缺口的受控案例：生成 Candidate，测试，证明 Stable 未被直接覆盖。

【Acceptance Criteria】
1. Experience compact、结构化、无 Secret。
2. 不会的问题不会第一时间失败/问用户，低风险场景会自主研究。
3. 经验只有验证成功后进入 verified。
4. 复用时做环境/version check。
5. Failure Classification 能阻止错误学习。
6. Candidate 复用现有 CI/Transaction，不造第二套 promotion engine。
7. Candidate 无法直接覆盖 Stable。
8. 无常驻学习 daemon / vector DB / 自训练平台。
9. Learning 不导致插件数量无界增长。
10. 真实 E2E 证据 PASS。

【报告输出】
docs/roadmap/reports/PHASE_04_LEARNING/REPORT_R1.md
更新 CURRENT_STATUS.md。
报告必须列出：Experience schema、实际保存的示例（脱敏）、复用证据、Gap 判定、Candidate 生命周期、对系统体积/复杂度的影响。
完成后 AWAITING_REVIEW，停止，禁止 Phase 05。
```

### 1.4 Mandatory Output Contract（逐字）

```
- Report：`docs/roadmap/reports/PHASE_04_LEARNING/REPORT_R1.md`
- 必含陌生任务→学习→复用的真实闭环证据。
- 未经外部 APPROVED 禁止 Phase 05。
```

### 1.5 合同硬前置（三处独立原文）

合同对「能否开始 P4」有明确且重复的硬门禁，**三处原文**：

| # | 来源 | 原文 |
|---|---|---|
| P-1 | P4 合同 §完整执行 Prompt 第 2 行 | 「**前提：Phase 03 必须已外部 VERIFIED，否则停止。**」 |
| P-2 | P3 页 §Status 新前置 | 「External Review APPROVED 前**禁止 VERIFIED / Phase 04**。」 |
| P-3 | P3 页 2026-09-02 Roadmap Decision | 「完成后回到 External Review，**禁止进入 P4**。」 |
| P-4 | P3 页 交接快照末行 | 「**只有 P3 External Review APPROVED 后**，才允许状态 backfill / VERIFIED，并**解锁 P4**。」 |
| P-5 | Reviewer 页 P3 Round 1 | 「完成上述唯一 blocker 的最小修复后，回到 `AWAITING_EXTERNAL_REVIEW Round 2` 并 STOP；未经 External Review APPROVED 不得自宣 VERIFIED，**不得进入 Phase 04**。」 |

---

## 2 仓库侧实际状态（fresh-fetch 实测）

| 项 | 实测值 |
|---|---|
| `origin/main` | `6d0623627c4b38f6b870ef03fe9ed776186c9e09` |
| P4 baseline | `6d06236`（= origin/main，**不落后**） |
| PR #90 HEAD | `4cc0832eed575301ec7188bc11fb7896c36985a1`（origin/main 是其祖先） |
| PR #90 mergeStateStatus | `CLEAN`（required checks 全绿 + 分支与 main 同步） |
| PR #90 CI | `Static + secret + syntax gate` pass / `Reliability state machine tests` pass / `DSH boot + readiness smoke` pass |
| 分支保护 required checks | `Static + secret + syntax gate`、`Reliability state machine tests`；`strict=true`；**不要求 PR review** |
| 代码增量 | `plugins/learn-core.mjs`(+887)、`plugins/learn.mjs`(+425)、`docs/roadmap/evidence/cm-r4-log-decoder.mjs`(+25/−8) |
| CURRENT_STATUS P4 行 | `IMPLEMENTATION_COMPLETE` / `AWAITING_EXTERNAL_REVIEW` |
| CURRENT_STATUS P3 行 | `AWAITING_EXTERNAL_REVIEW`（文字为「R1 verdict 待裁决」） |
| Notion P4 Status | `TODO` |
| Notion P3 Status | `TODO` |
| P3 R1C 修复部署 | 生产 `~/.dsh/profiles/web/execution-continuity.mjs` 与 `origin/main` **逐字节一致**（126860 B，sha256 `041aad8d4510…`） |

---

## 3 合同 ↔ 实现 对照表

「合同项」= §1.3 原文条目；「实现证据」= 仓库实测；「判定」按合同口径（不按报告自定口径）。

| # | 合同项（原文） | 实现证据（实测） | 判定 |
|---|---|---|---|
| C1 | 前提：Phase 03 必须已外部 VERIFIED | P3 = `AWAITING_EXTERNAL_REVIEW`；Notion 最新裁决 = `CHANGES_REQUIRED`（Round 1，2026-08-30）；R1C 修复已完成并部署，但**从未回到 Round 2 送审** | **未满足（硬前置违反）** |
| C2 | 实现原则 1：policy + file-based；禁 vector DB / 常驻 daemon / memory platform | 定时器 / daemon / vector / embedding / spawn 全零命中；唯一钩子 `agent/pre-step`；per-session JSON 文件库 | PASS |
| C3 | 实现原则 2：先查已有 Experience/Skill/Tool/code/docs | 复用 P2.5 官方提取器 ✅；但 **P3 已有 9 类失败分类器未复用** | **部分（存在未复用）** |
| C4 | 实现原则 3：经验必须经真实成功验证后才标 VERIFIED_EXPERIENCE | 代码内**不存在 `verified` 状态**（`EXPERIENCE_STATES` 仅 PROPOSED/APPROVED/REJECTED/RETIRED）；审批门只校验「非空字符串」 | **FAIL** |
| C5 | 实现原则 4：失败原因必须先分类 | `plugins/learn*.mjs` 无任何失败分类；Provider 502 与网络超时产生**完全相同**的 `failure` 信号 | **FAIL** |
| C6 | 实现原则 5：复用时重新检查版本/环境是否适用 | `recall()` 无环境/版本/适用性检查；无复用前 re-verify | **FAIL** |
| C7 | Autonomous Problem Solving Loop（收到任务→查经验→查 Skill→读取真实错误→查文档/GitHub/网络→最低风险可逆方案→checkpoint→bounded attempts→失败分类换路线→成功 deterministic verify→保存） | 整个 diff 内**无任何**研究/检索/计划/重试代码；`learn.mjs` 是被动观察者 | **FAIL（未实现）** |
| C8 | Failure Class：至少 9 类（Environment/Provider/Network/User/Website/Tool/Skill/Model/Unknown） | 无该概念 | **FAIL（未实现）** |
| C9 | Experience Store：私有可版本化位置；不得保存 Secret | 位置 = `%LOCALAPPDATA%\DSHHarness\state\learn\<sid>.json`（私有但**不可版本化**）；脱敏对 Google API key / PEM 私钥 / Stripe / GitLab / HuggingFace / npm / Slack webhook **失效**，值可原样落盘 | **FAIL（位置不合偏好 + Secret 反证）** |
| C10 | Experience 字段 11 项（taskType/trigger/symptoms、applicable versions/environment、rootCause、successfulMethod、failedOrUnsafeMethods、verificationEvidence、rollback、source links/commit、stale/expiry、lastVerifiedAt…） | 实际字段为 id/state/title/body/tags/sourceEventSeqs/originSessionId/createdAt/approved*/rejected*/retiredAt/promotion*/recallCount/lastRecalledAt；**契约 9 项字段全缺** | **FAIL** |
| C11 | 禁止保存整段聊天 / 全量日志 / 巨大 tool output | 有长度上限与 watermark；E2E 有脱敏断言 | PASS |
| C12 | 复用规则：检索→检查适用性→复用→**重新验证** | 只有 `learn_recall` 返回记录，**无适用性检查、无重新验证**；且召回结果不自动进入 agent 上下文 | **FAIL** |
| C13 | Capability Gap：重复阈值 + dedup + gap record + research + Candidate（Rule > extend Skill > new Skill > Plugin） | **无「能力缺口」概念**；无重复阈值（仅 `minNewNodes/minTurnsForLearning`）；dedup 键含 `originSessionId` ⇒ 同一缺口跨会话各生成一条 | **FAIL** |
| C14 | Candidate Lifecycle：复用既有 Git/branch/tests/CI/Reliability Lab/Transaction；isolated tests → regression/holdout → canary → promote/reject | **零 CI 接入**（4 个 workflow grep `learn` = 0；`.github` 零改动）；**未复用 Transaction 2.0**（grep `transaction` = 0）；无 Candidate/Stable 概念；晋升 = 同一条 JSON 里把 flag 从 `NONE` 改 `PROMOTED` | **FAIL** |
| C15 | Candidate 禁止直接覆盖 Stable | 插件唯一落盘目标为 stateDir ⇒ 物理上不可能覆盖；**但无强制、无专门断言（空转成立）** | PASS（空转） |
| C16 | 瘦身：不新建独立清理系统；metadata（usageCount/successRate/lastUsed/replacement/status）；第一版只做建议；禁自动删除 Stable | 无清理系统 ✅；有 `recallCount`/`lastRecalledAt`；但 `successRate`/`replacement`/`lastUsed` 缺失，无 dedup/Archive/Prune 建议 | **部分** |
| C17 | 边界 ✅：自动研究 / 自动总结经验 / 自动生成 Candidate / 自动测试 Candidate | 「自动总结经验」= 被动关键词提案（成立）；其余三项未实现 | **部分** |
| C18 | 边界 ❌：未验证自动替换 Stable / 自动改 Official Core / 无限安装 / 无限重试 / Secret 进 Experience | 前三项不存在 ✅；无限重试无关本改动 ✅；**Secret 进 Experience 可复现** ❌ | **FAIL（Secret 一条）** |
| C19 | 必须真实验证 #1：陌生任务→自主研究→解决→保存 | 缺失（无研究环节） | **FAIL** |
| C20 | 必须真实验证 #2：第二次相似任务成功检索复用 + 重新验证 | E2E 的「复用」查询串**直接等于候选自己的标题**（近乎同义反复）；无第二个任务、无应用、无重新验证 | **FAIL** |
| C21 | 必须真实验证 #3：伪能力缺口（网络/Provider 故障）正确分类、**不生成 Candidate** | **实测反证**：`provider returned 502…`、`网络请求超时，连接失败`、`模型服务不可用导致报错` 均 `hasSignal=true, kinds=["failure"]` ⇒ **照样生成 PROPOSED 候选**，行为与要求相反 | **FAIL（行为相反）** |
| C22 | 必须真实验证 #4：重复真实缺口受控案例→生成 Candidate→测试→证明 Stable 未被覆盖 | 缺失 | **FAIL** |
| C23 | AC1：Experience compact、结构化、无 Secret | 结构化有上限、脱敏链路有测试；但 Secret 可反证、契约字段缺 9 项 | **PARTIAL** |
| C24 | AC2：不会的问题不第一时间失败/问用户，低风险会自主研究 | 无实现、无测试 | **FAIL** |
| C25 | AC3：经验只有验证成功后进入 verified | 无 `verified` 状态 | **FAIL** |
| C26 | AC4：复用时做环境/version check | 无 | **FAIL** |
| C27 | AC5：Failure Classification 能阻止错误学习 | 无分类，且实测行为相反 | **FAIL** |
| C28 | AC6：Candidate 复用现有 CI/Transaction，不造第二套 promotion engine | CI 零接入、Transaction 未复用、自建 promote() | **FAIL** |
| C29 | AC7：Candidate 无法直接覆盖 Stable | 空转成立 | PASS（空转） |
| C30 | AC8：无常驻 daemon / vector DB / 自训练平台 | 零命中 | PASS |
| C31 | AC9：Learning 不导致插件数无界增长 | 无代码创建插件；经验库另有 200 条硬上限 | PASS（空转） |
| C32 | AC10：真实 E2E 证据 PASS | 套件真跑真过（59/0），但**非真实运行时 E2E**（假 ctx、`ctx.tools.register` 为故意抛错陷阱、session 手搓、插件未挂载）；4 次规定执行 3 缺 1 反证 | **FAIL** |
| C33 | 报告输出：`REPORT_R1.md` + 更新 CURRENT_STATUS.md + 必列 6 项内容 | 报告齐（R1/R2/R3/GAP_AUDIT/PREFLIGHT）；CURRENT_STATUS 已更新；6 项内容基本齐（但 Candidate 生命周期为「未实现」而非「列出」） | **部分** |
| C34 | 完成后 `AWAITING_REVIEW`，停止，禁止 Phase 05 | 状态 = `AWAITING_EXTERNAL_REVIEW` ✅；未进入 P05（CURRENT_STATUS L20 = 未开始）✅ | PASS |

### 3.1 合同口径汇总

| 判定 | 条数 | 条目 |
|---|---|---|
| PASS | 7 | C2、C11、C15、C29、C30、C31、C34 |
| PASS（空转成立） | 3 | C15、C29、C31 |
| PARTIAL / 部分 | 4 | C3、C16、C17、C23 |
| FAIL | 20 | C4、C5、C6、C7、C8、C9、C10、C12、C13、C14、C18、C19、C20、C21、C22、C24、C25、C26、C27、C28 |
| 硬前置未满足 | 1 | C1 |

**合同口径结论：`PARTIAL`。** 交付物本身工程质量高（真跑真过、隔离有效、fail-closed、无自动激活、无夸大完成度），但合同的核心闭环——**自主研究循环、验证后才进 verified、复用前环境检查、失败分类、Capability Gap → Candidate 生命周期、CI/Transaction 复用、4 次规定真实执行**——未交付；且 **AC5 对应行为被实测反证为与合同要求相反**。

---

## 4 Delta 清单（合同 vs 实际）

| Delta | 类型 | 内容 | 严重度 |
|---|---|---|---|
| **D1** | 治理 | 合同硬前置未满足：P3 从未获 External Review APPROVED（Notion 最新 = `CHANGES_REQUIRED`，R1C 修复已完成但未回 Round 2 送审）。Notion 四处原文明确「P4 继续 LOCKED / 禁止进入 P4 / 禁止 Phase 04 / 只有 P3 APPROVED 后才解锁 P4」。P4 仍于 2026-09-21 执行。 | **BLOCKER（治理）** |
| **D2** | 验收口径 | `REPORT_R1.md:98-111` 自定义了一套 AC1–AC12，其 AC2=「提案不是激活」、AC4=「确定性召回」、AC5=「损坏 fail-closed」，**与合同 AC2/AC4/AC5 语义完全不同**；`test-learn-core.mjs:7-15`、`run-learn-real-e2e.mjs:194` 沿用同一编号。⇒ 报告中「AC2/AC4/AC5 PASS」不能作为合同 AC 的证据。属「测试全绿但测的不是合同要求」。 | **BLOCKER（验收）** |
| **D3** | 交付缺口 | 合同 AC2/AC3/AC4/AC5/AC6/AC10 未交付；4 次规定真实执行 3 缺 1 反证。 | **BLOCKER（交付）** |
| **D4** | 状态登记 | Notion P4 Status=`TODO`、P3 Status=`TODO`（均未随实际推进更新）；仓库 P3 行写「R1 verdict 待裁决」，但裁决（`CHANGES_REQUIRED`）已于 2026-08-30 发出，未登记；仓库 P4 行标 `IMPLEMENTATION_COMPLETE`，按合同口径应为 `PARTIAL`。 | 高 |
| **D5** | 复用纪律 | 合同实现原则 2「先查已有」被违反：P3 已交付 9 类失败分类器（`CURRENT_STATUS.md` P2.6 段），P4 未复用，直接导致 AC5 缺失。 | 高 |
| **D6** | 存储位置 | 合同偏好「Private Deployment knowledge 结构或可版本化的私有位置」；实现用 `%LOCALAPPDATA%`（私有但不可版本化），报告未提及此偏差。 | 中 |
| **D7** | 报告轮次 | 合同要求 `REPORT_R1.md`；实际产出 R1/R2/R3 + GAP_AUDIT + PREFLIGHT（增量、不违规）。 | 低（合规增量） |
| **D8** | 运行时挂载 | 插件在仓库（所有 `*.yml/*.yaml/*.json`，排除 docs）与生产 profile 中 **grep `learn` = 0 命中** ⇒ 交付物在运行时不存在。报告 §5 已如实自述「未进生产 profile、未部署」。 | 中（诚实自述，非隐瞒） |

---

## 5 应当被肯定的部分（避免只列问题）

1. **无自动激活路径是硬不变量**：`makeExperience` 出生即 `PROPOSED`；`EXPERIENCE_STATES` 无自动态；`sanitizeExperience` 在**载入时**也拒绝「无审批人/无证据的 APPROVED 行」——落盘层 fail-closed。
2. **写入边界真实**：`assertWriteAllowed` 白名单拒绝 runtime-state/goals/credentials/policy；库只能落 `stateDir`。
3. **会话隔离经红队验证**：`sanitizeFileId` 加原 sid 短哈希 + `loadStore` 归属校验 fail-closed；伪造他人归属文件被拒载入并记 `STORE_REBUILT`（13/0）。
4. **脱敏不是空转**：secrets 套件用「先于实现的失败测试 + 负向孪生」，且 H2/H5 带 fail-closed 前置（产物为空即判失败），62 PASS。
5. **测试计数可复现**：276 / 59 / 478 三个关键数字经两路独立复现一致。
6. **不夸大完成度**：`REPORT_R3.md` §5 明确「未进生产 profile、未部署」「verificationState 保持 UNVERIFIED」，**没有把 PARTIAL 伪装成 COMPLETE**。
7. **自曝缺陷确实已修**：D1（中文关键词 `\b` 物理不可达）、D2（首个命中即 break 致语义反转）、F4（`<system-reminder>` 被当经验学习）、F5（会话撞名污染）在代码中均已修。
8. **AC7 中唯一红的定性正确**：`tests/install-plugin/verify-install-plugin.mjs` 经在 pristine HEAD 上重跑实证为 **PRE-EXISTING**，非本次引入。

---

**一句话总结**：P4 交付了一个**工程质量扎实、边界与隔离做得好、但没有实现合同核心闭环**的「带人工审批门的 per-session 经验候选库」；同时它是在合同硬前置（P3 外部 VERIFIED）**未满足**的情况下执行的，且其报告的 AC 编号与合同错位，使「测试全绿」与「合同达成」之间出现了口径断裂。
