# P4 LEARN — 独立 Delta Review（Stage B）

- 生成时间：2026-09-21
- 性质：**独立评审**，不修改任何实现代码
- 被审对象：PR #90 / 分支 `p4-learning-r1` / HEAD `4cc0832eed575301ec7188bc11fb7896c36985a1`
  （工作树 `.worktree-p4-learning-r1`，baseline `6d0623627c4b38f6b870ef03fe9ed776186c9e09` = `origin/main`）
- 评审基准：`CONTRACT_RECONCILIATION_R1.md`（Stage A，合同逐字重建）
- 独立性声明：本次评审由**两路互不重叠的独立验证**并行执行，均**只读**，均未修改仓库或生产文件。
  两路结论在下文按合同口径收敛；**分歧点单独列出**，不做平均、不做调和。

| 路线 | 范围 | 工具 | 关键方法 |
|---|---|---|---|
| Verifier-A | 合同 AC1–AC5 | 只读 + 真实会话复现 | 读实现源码 + 跑 9 个 `tests/learn/*.mjs` + 写反证探针 |
| Verifier-B | 合同 AC6–AC10 | 只读 + 真实会话复现 | 读实现源码 + 跑 5 个套件 + 反证探针 + CI/workflow grep |

---

## 1 合同口径 AC 终裁（合并两路，逐条）

| 合同 AC | 原文要求 | 终裁 | 决定性证据（可复现） |
|---|---|---|---|
| **AC1** | Experience compact、结构化、无 Secret | **PARTIAL** | 结构化与上限真实、脱敏链路有测试；**但可被反证**：`redactSecrets`/`containsSecret` 对 Google API key(`AIza…`)、Stripe(`sk_live_`)、GitLab(`glpat_`)、HuggingFace(`hf_`)、npm(`npm_`)、**PEM 私钥块**、Slack webhook 全部失效，值原样穿过 `buildLearnDigest → propose` 进入经验 body（实测 `PEM in stored experience body: true`）。且 schema 缺合同要求的 9 项字段。 |
| **AC2** | 不会的问题不第一时间失败/问用户，低风险场景会自主研究 | **FAIL** | 整个 diff（`plugins/learn-core.mjs` + `plugins/learn.mjs`）**无任何**研究/检索/求解/计划/重试代码；`learn.mjs` 是纯被动观察者（`agent/pre-step` 钩子 + 5 个工具）。全仓 grep `research\|autonomous\|classif\|Environment\|Provider\|Network` 零相关命中。无测试、无证据。 |
| **AC3** | 经验只有验证成功后进入 verified | **FAIL** | 代码内**不存在 `verified` 状态**：`EXPERIENCE_STATES`(`learn-core.mjs:59`) 仅 `PROPOSED/APPROVED/REJECTED/RETIRED`。激活门 `approve()`(`:400-415`) 只校验「审批人字符串非空 + 证据字符串非空 + 证据不含密钥形态」，**不执行任何验证**。E2E 自己用自由文本 `evidence:'confirmed reusable against real session data'` 即得 `APPROVED`（`run-learn-real-e2e.mjs:232`）——该测试证明的是审批边界，恰是 AC3 的反例。 |
| **AC4** | 复用时做环境/version check | **FAIL** | `recall()`(`learn-core.mjs:490`) 无任何环境/版本/适用性检查；`recordRecall` 只加计数，无复用前 re-verify；schema 无 applicable-version/environment、stale/expiry、lastVerifiedAt。唯一 `version` 是库格式 `schemaVersion`(`validateStore:308`)，与适用性无关。 |
| **AC5** | Failure Classification 能阻止错误学习 | **FAIL（且行为相反）** | `plugins/learn*.mjs` **无任何失败分类**。实测探针（`node -e` 动态 import，未落盘）：<br>`provider returned 502 upstream connect error, retrying` → `hasSignal=true, kinds=["failure"]`<br>`网络请求超时，连接失败，请重试` → `hasSignal=true, kinds=["failure"]`<br>`模型服务不可用导致报错，稍后自动恢复` → `hasSignal=true, kinds=["failure"]`<br>⇒ `maybeLearn`(`learn.mjs:198-229`) 随即 `propose()`，**环境故障照样生成 PROPOSED 候选**，与合同「正确分类、不生成 Candidate」**正好相反**。仓库 PHASE_03 已有 9 类失败分类器（`CURRENT_STATUS.md` P2.6 段）**未复用**。 |
| **AC6** | Candidate 复用现有 CI/Transaction，不造第二套 promotion engine | **FAIL** | ① **CI 零接入**：`.github/workflows/*.yml` 全文 grep `learn` = **0 命中**；CI 中逐条列出的 55 处测试调用**无一条**指向 `tests/learn/`；`git diff --name-status <baseline> HEAD -- .github` = 空。② **未复用 Transaction 2.0**：`git grep -i transaction -- tests/learn plugins/learn*.mjs` = **0 命中**；既有 `tests/reliability/Test-StageC-Transaction.ps1` 完全未被复用。③ **不存在 Candidate/Stable 概念**：grep `Stable\|daemon\|vector\|embedding\|pluginCount\|install` 仅命中 `stableHash`（哈希函数）；所谓晋升 = 同一条 per-session JSON 里把 `promotion` 从 `NONE` 改成 `PROMOTED`（`learn.mjs:346-370`），无隔离测试、无 holdout、无 canary。 |
| **AC7** | Candidate 无法直接覆盖 Stable | **PASS（空转成立）** | 插件唯一落盘目标为 `stateDir/<sid>.json`，物理上无法写别处 ⇒ 不可能覆盖 Stable。**但这是「机制不存在」的成立，不是「被强制保证」的成立**，且无任何专门断言。 |
| **AC8** | 无常驻学习 daemon / vector DB / 自训练平台 | **PASS** | `setInterval/setTimeout/setImmediate/daemon/vector/embedding/spawn/child_process` grep = **0 命中**；唯一钩子 `agent/pre-step`(`learn.mjs:235`)；E2E 直证 `LEARN_DISABLED=true` 注册零钩子。 |
| **AC9** | Learning 不导致插件数量无界增长 | **PASS（空转成立）** | 无任何代码创建插件文件（写入白名单仅 `experience-store/telemetry/audit-log`）；经验库另有 `MAX_EXPERIENCES=200` 硬上限且被测试锁死。**但「插件数」无专门断言。** |
| **AC10** | 真实 E2E 证据 PASS | **FAIL** | 套件真跑真过（59/0），但**非真实运行时 E2E**：`run-learn-real-e2e.mjs:63` 用假 ctx 且 `ctx.tools.register` 是**故意抛错的陷阱**；`:100` session 对象手搓；无 agent 回合真正调用这些工具；**插件未挂载**（仓库所有 `*.yml/*.yaml/*.json` 排除 docs grep `learn` = 0；生产 `cordis.patch.yml` 同样 0）。合同规定的 **4 次真实执行**：#1 缺失、#2 近乎同义反复、**#3 被实测反证**、#4 缺失（详见 §2）。 |

### 1.1 合同口径汇总

| 终裁 | 条数 | AC |
|---|---|---|
| PASS | 3 | AC7、AC8、AC9（**其中 AC7/AC9 为「空转成立」，非强制保证**） |
| PARTIAL | 1 | AC1 |
| **FAIL** | 6 | **AC2、AC3、AC4、AC5、AC6、AC10** |

**整体终裁：`PARTIAL`。**
不是 `INCOMPLETE`（已交付物质量真实、真跑真过、无夸大完成度），
也绝不是 `COMPLETE`（合同核心闭环整块未实现，且 AC5 行为与要求相反）。

---

## 2 合同「必须真实验证」4 次规定执行的实测结果

| # | 合同原文要求 | 实测 | 结论 |
|---|---|---|---|
| #1 | 一个「没有经验」的陌生低风险任务：自主研究→解决→保存经验 | 全仓 `learn*.mjs` 无任何研究/检索/求解逻辑；`maybeLearn` 仅被动观察会话、按关键词命中即提案（`learn.mjs:175-232`）。**没有「研究」这一步。** | **缺失** |
| #2 | 第二次相似任务：成功检索并复用经验，**且重新验证** | E2E 的「复用」只是 `learn_recall`，且**查询串直接等于该候选自己的标题**（`run-learn-real-e2e.mjs:251 q = 'walk zstd frames before trusting event counts'` = `prop2.title`，`:252` 用它召回）——近乎同义反复。无第二个任务、无应用、无重新验证。更关键：**召回结果不会自动进入任何 agent 上下文**（唯一钩子只做观察）。 | **未证明** |
| #3 | 一个伪能力缺口（网络/Provider 故障）：**正确分类，不生成 Candidate** | **被实测反证**（见 AC5 探针）：Provider 502 / 网络超时 / 服务不可用三类文本均产生 `failure` 信号 ⇒ 照样生成 PROPOSED 候选。代码内**根本不存在「能力缺口」概念**，也无测试覆盖（grep `network\|provider\|false gap` = 0）。 | **FAIL（行为相反）** |
| #4 | 一个重复真实缺口的受控案例：生成 Candidate、测试、**证明 Stable 未被直接覆盖** | 无重复阈值（仅 `minNewNodes:4` / `minTurnsForLearning:4`，非「同缺口重复」）；去重键含 `originSessionId` ⇒ **同一缺口在不同会话各生成一条**；无候选测试环节；无 Stable。`REPORT_R2.md` §5 自述 "Candidate volume is intentionally not capped here"。 | **缺失** |

---

## 3 Delta 终裁（与 Stage A §4 对齐，补独立证据）

| Delta | 终裁 | 独立证据 |
|---|---|---|
| **D1 硬前置违反** | **确认 BLOCKER** | 合同 P4 第 2 行「前提：Phase 03 必须已外部 VERIFIED，否则停止。」＋ Notion P3 页四处原文（「P4 继续 LOCKED」「禁止进入 P4」「禁止 VERIFIED / Phase 04」「只有 P3 APPROVED 后才解锁 P4」）。P3 最新裁决 = `CHANGES_REQUIRED`（Round 1，2026-08-30），R1C 修复已完成并部署但**从未回 Round 2 送审**。 |
| **D2 验收口径错位** | **确认 BLOCKER** | `REPORT_R1.md:98-111` 自定 AC1–AC12（其 AC2=提案非激活、AC4=确定性召回、AC5=损坏 fail-closed）；`test-learn-core.mjs:7-15`、`run-learn-real-e2e.mjs:194` 沿用同编号。⇒ 报告「AC2/AC4/AC5 PASS」**不能作为合同 AC 的证据**。`REPORT_R3.md` 亦用另一套（AC6=真实会话学习、AC7=无回归、AC8=遥测、AC9=E2E、AC10=写入边界）。**合同 AC6–AC10 从未在任何一套编号下被正面回应。** |
| **D3 交付缺口** | **确认 BLOCKER** | 合同 AC2/AC3/AC4/AC5/AC6/AC10 FAIL；4 次规定执行 3 缺 1 反证。 |
| **D4 状态登记** | **确认（高）** | Notion P3/P4 Status 均 `TODO`；仓库 P3 行写「R1 verdict 待裁决」（裁决实际已发出）；仓库 P4 行标 `IMPLEMENTATION_COMPLETE`，按合同口径应为 `PARTIAL`。 |
| **D5 复用纪律** | **确认（高）** | P3 已有 9 类失败分类器未复用 → 直接导致 AC5 缺失。合同实现原则 2「先查已有」被违反。 |
| **D6 存储位置** | **确认（中）** | 合同偏好「Private Deployment knowledge 结构或可版本化私有位置」；实现用 `%LOCALAPPDATA%\DSHHarness\state\learn`（私有但不可版本化），报告未提及此偏差。 |
| **D7 报告轮次** | **确认（低，合规增量）** | 合同要求 `REPORT_R1.md`；实际 R1/R2/R3 + GAP_AUDIT + PREFLIGHT。增量、不违规。 |
| **D8 运行时挂载** | **确认（中，已诚实自述）** | 插件在仓库与生产 profile 中 grep `learn` = 0 ⇒ 运行时不存在。`REPORT_R3.md` §5 已如实自述「未进生产 profile、未部署、verificationState=UNVERIFIED」。 |

---

## 4 应被肯定的部分（独立复核后确认成立）

| # | 项 | 独立复核结果 |
|---|---|---|
| 1 | **无自动激活路径是硬不变量** | `makeExperience:219` 出生即 `PROPOSED`；`EXPERIENCE_STATES:59` 无自动态；`sanitizeExperience:273-274` **载入时**也拒绝「无审批人/无证据的 APPROVED 行」→ 落盘层 fail-closed。**确认成立。** |
| 2 | **写入边界真实** | `assertWriteAllowed:592` 白名单拒绝 runtime-state/goals/credentials/policy；库只能落 `cfg.stateDir`(`learn.mjs:114,134`)。**确认成立。** |
| 3 | **会话隔离经红队验证** | `sanitizeFileId` 追加原 sid 短哈希 + `loadStore` 归属校验 fail-closed；伪造他人归属文件被拒载入并记 `STORE_REBUILT`。`redteam-r3-isolation.mjs` **13 PASS / 0 FAIL**（两路各自实跑 exit 0）。**确认成立。** |
| 4 | **脱敏不是空转** | `test-learn-r3-secrets.mjs` 用「先于实现的失败测试 + 负向孪生」，H2/H5 带 fail-closed 前置（产物为空即判失败），62 PASS。**确认成立**（但覆盖面仅 9–12 个模式家族，被 N1 反证不足以满足 AC1）。 |
| 5 | **测试计数可复现** | `test-learn-core.mjs` **276/0**、`run-learn-real-e2e.mjs` **59/0**、`test-learn-r3-fixes.mjs` **29/0**、hardening 30/0、secrets 62/0、isolation 13/0、contamination 9/0 = **478 PASS / 0 FAIL**；两路独立复现一致。**确认成立。** |
| 6 | **无第二套 raw-session extractor** | `learn-core.mjs:18-22` 真 `import` P2.5 官方 `context-memory-core.mjs`；learn-core 内 `zstd / JSON.parse / readFileSync` grep = **0 命中** ⇒ 物理上不存在第二个 parser。**确认成立。** |
| 7 | **不夸大完成度** | `REPORT_R3.md` §5 明确「未进生产 profile、未部署」「verificationState 保持 UNVERIFIED」——**没有把 PARTIAL 伪装成 COMPLETE**。**确认成立，应予肯定。** |
| 8 | **自曝缺陷确实已修** | D1（中文关键词 `\b` 物理不可达）、D2（首个命中即 break 致语义反转）、F4（`<system-reminder>` 被当经验学习）、F5（会话撞名污染）在代码中均已修（`isNegated` / 双正则 / 独占一行判定 / `sanitizeFileId` 加哈希 + 归属守卫）。**确认成立。** |
| 9 | **唯一红的定性正确** | `tests/install-plugin/verify-install-plugin.mjs` 经在 pristine HEAD 上重跑实证为 **PRE-EXISTING**（同样 13/2，插件同步漂移），非本次引入。**确认成立。** |

---

## 5 两路验证的分歧与未覆盖（不调和，如实列出）

### 5.1 分歧

| 点 | Verifier-A | Verifier-B | 处置 |
|---|---|---|---|
| 对 D8（插件未挂载）的定性 | 未单列，仅指出「运行时不存在」 | 明确列为 **AC6 FAIL 的组成部分**（「交付物在运行时根本不存在」） | 采 **Verifier-B 更严口径**：未挂载是 AC6 的独立 FAIL 依据，不只是观察项。 |
| 对 AC7 的表述 | 「PASS（空转成立）」 | 「PASS（空转成立）」＋强调「无任何专门断言」 | **一致**，均保留「空转」限定词。 |
| 对报告诚实性的评价 | 未展开 | 明确肯定「未夸大完成度」 | 采 **Verifier-B**（已在 §4 第 7 条记录）。 |

**两路在 AC1/AC2/AC3/AC4/AC5/AC10 的裁决上完全一致，无实质分歧。**

### 5.2 未覆盖（本次评审的边界）

1. 未做**变异测试**（未逐条篡改实现验证测试是否真会红）；仅对报告自述的「变异对照」作书面采信。
2. 未运行 `run-ac7-regression.ps1` / `run-r3-final-head-full.ps1`（会全仓扫描并可能写文件）。
3. 未验证证据 commit `e31ebd8` 与 HEAD `4cc0832` 之间 `plugins/`、`tests/learn/` 的字节差异
   （证据文件自述二者零差异）；仅确认 `e31ebd8`、`d70a169` 真实存在、工作树 clean。
4. Verifier-A 未核 PR #90 远端状态；**已由主 Agent 补齐**：CI 三门禁全绿、`mergeStateStatus=CLEAN`。

### 5.3 副作用披露（两路均为只读）

- 两路均未创建/修改/删除任何仓库或生产文件；未改 git 状态；未重启服务；工作树 `git status` 全程 clean。
- 运行测试套件产生的临时目录（均在 `%TEMP%` 下、非生产数据）：
  - `%TEMP%\p4-learn-e2e-3nyWaU\`（`run-learn-real-e2e.mjs` 设计为「可安全删除」，脚本自身不删）
  - `%TEMP%\p4-r3-quality\r3_quality_sample.json`（质量脚本默认输出）
  - 其余套件自建自删 `mkdtemp` 目录，无残留。

---

## 6 给委派方的建议（不代为决策）

1. **按合同验收必须判 `PARTIAL`**：核心缺口是「**自主研究闭环 + 验证门 + 失败分类 + Capability Gap → Candidate Skill 生命周期 + 4 次规定真实执行**」整块未实现。当前交付物实质是**带人工审批门的 per-session 经验候选库**，而非合同要求的自主学习系统。
2. **最高优先级补救（按性价比）**：
   - ① **区分「环境故障 vs 真实能力缺口」判定层**（当前行为与合同要求**相反**，风险最高）；
   - ② 把 `tests/learn/` 关键套件接入 `ci-level1.yml`（AC6 的 CI 部分，改动极小、风险低）；
   - ③ 补 `verified` 状态门与复用前环境/版本检查（AC3/AC4）；
   - ④ 若保留晋升语义，必须落到既有 **Transaction 2.0** 上，或明确声明「本阶段不实现 Candidate/Stable」并相应修订合同。
3. **切勿**把 276/59/478 全绿当作 AC10 达成——它证明的是边界与隔离做得好，不是 4 次规定执行做完了。
4. **治理侧**：P4 的硬前置（P3 外部 VERIFIED）未满足，合同四处原文明确禁止进入 P4。在 P3 获得 External Review `APPROVED` 之前，P4 不应 merge 进 main、更不应部署到生产。

---

**评审结论一句话**：PR #90 是一个**工程质量扎实、边界与隔离做得好、诚实自述不夸大、但没有实现合同核心闭环**的交付物；合同口径 `PARTIAL`，其中 **AC5 对应行为被实测反证为与合同要求相反**；且它是在合同硬前置未满足的情况下执行的，报告的 AC 编号与合同错位，使「测试全绿」与「合同达成」之间出现口径断裂。
