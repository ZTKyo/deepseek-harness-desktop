# P4 终局判定（A11）—— **P4 ≠ VERIFIED**

> ## ⚠ 时效标注（2026-10-01 增补；**本文下方正文逐字保留历史原样，未作任何改写或删除**）
>
> **标记规范**：本次全部时效标注共用同一 token「**2026-10-01 时效标注**」，由 CI 门
> `tests/roadmap/validate-p4-status-consistency.mjs` fail-closed 校验（任何历史文档缺标注即红灯）。
>
> 本文是 **2026-09-28 00:25 的历史快照**。标题中的 `P4 ≠ VERIFIED` 与正文各段判定
> **在其写下时属实**（含两条补记），但**不是当前状态**。本标注即"更正留痕"；
> 引用本文任何历史结论时**必须连同本标注一起引用**。
>
> ### 当前状态（唯一口径，基线 `main@63bf558`）
> - **AC1–AC10 = 全 PASS**；判定字符串 = `VERIFIED (ENGINEERING-COMPLETE) / AWAITING EXTERNAL REVIEW`。
> - 权威来源：`docs/roadmap/CURRENT_STATUS.md` →「2026-09-30 P4 canonical 封条」段与
>   「2026-10-01 External Review remediation（D1–D13）」段。
>
> ### 本文中已被取代的具体条目
> | 本文位置 | 历史结论（当时属实） | 取代事实 |
> |---|---|---|
> | 标题 / §二 理由 B / L61 / L76 | `P4 ≠ VERIFIED`（理由 A 真人审批门 + 理由 B 合同缺口） | **已被取代**：2026-09-30 canonical 封条按合同原文判 **AC1–AC10 全 PASS**；真人审批边界本身**未被放宽**（代理仍只能请求、不能授予），它作为**设计上的正确边界**登记，不再构成 AC 级阻塞 |
> | §二 表 L51 | `AC10`：CI 内无真实 E2E 门 | **已被取代**：AC10 于 2026-09-30 客观闭合（线上只读 GET 前后对照；required contexts 三项 + `enforce_admins=true` + `strict=true`；违规红灯 PR #100 = BLOCKED、真 E2E 绿灯 PR #99 = MERGED） |
> | §二 补记二 L74-75 | 「AC2 生产部署」待办（生产 profile 仍是旧副本 `6bdd3fe5…`） | **已被取代**：该部署已于 2026-09-30 封条前完成，并以**运行时行为探针**判 `NEW_CODE_LOADED`（不以 mtime 作装载证据） |
> | §五 L107-110 接手提示 | 指向工作区 `_p4r2-final-closure/` 与 `_post-restart-verify.mjs` | **口径更正**：`_p4r2-final-closure/` **不在仓库内**（仅存操作者工作区，见下）；且 `_post-restart-verify.mjs` 的 §③「mtime < 服务启动时间」**不是有效装载证据**（profile 插件有 HMR 热挂载，mtime 与装载无因果），该脚本仅可作健康/泄漏只读复核 |
>
> ### 2026-10-01 追加更正（External Review D2 / D11 / D12）
> 1. **D2（证据可得性，如实声明）**：本文引用的封条证据目录 `_p4r2-final-closure/`、`_ac10/p4seal-evidence/`
>    **从未提交进 `main`**（`gh api .../contents/<dir>?ref=main` ⇒ `Not Found`）。
>    它们**仅存于操作者工作区** `C:\Users\Administrator\Desktop\sdeepseek harness\` 下，
>    外部 Reviewer 仅凭 `main` **无法**复核该部分；复核需操作者另行提供该目录。
>    **仓库内可独立复算的部分**（不依赖上述目录）：`.github/workflows/ci-level*.yml`、
>    `tests/learn/**`、`tests/reliability/**`、`docs/roadmap/evidence/**`。
> 2. **D11（度量口径）**：AC1 的「存量 2 命中」为**度量假阳性**——插件自身占位符
>    `[REDACTED:uri-credential]` 被 `uri-credential` 家族正则二次命中。剥标记后命中 = 0、
>    `containsSecret` = false ⇒ **真实密钥 = 0**。审计输出自 2026-10-01 起区分
>    **RAW MATCH / REDACTION PLACEHOLDER / REAL SECRET** 三个数。
> 3. **D12（自愈作用域）**：本文 §一 AC1 行「含存量自愈」的**准确作用域**是
>    「**载入某个会话库时按需执行**」，**不批量扫掠历史库**（生产实测：重启后仅当前活动会话库被写）。

- 判定时间：2026-09-28 00:25（本机）
- 判定人：主 agent（无人值守回合），**未代替外部评审（Reviewer 99）出 verdict**、**未代替真人审批**
- 代码身份：分支 `p4-final-b1b2-fix` @ `0d3adf7`（本回合新增 AC1 自愈迁移提交）；
  生产装载字节 = 源字节 = 部署字节（四插件 SHA256 前 12 位逐一相同）
- 生产进程：PID 20580（2026-09-28 00:17:59 重启提交，`COMMIT_READY: True`）

---

## 一句话结论

**该修的都修好并已在生产生效（B1 / B2 / AC1 三项，回归 29/29 全绿），但 P4 整体仍不能判 VERIFIED**，
因为存在**两条相互独立的阻塞**：① 真人审批门在本会话结构上不可达；② A10 独立复核确认 3 处合同缺口。
两条都**不是本轮修复引入的**，也**没有被我掩盖或改写**。

---

## 一、已完成并已生产生效（硬证据）

| 项 | 结论 | 新鲜证据 |
|---|---|---|
| **B1** `approval_host_fact_session_unavailable` | 关闭 | 生产消失；T1–T5 全 PASS；守卫 fail-closed 保留 |
| **B2** `learn_verify` 成功结果 `value.method` 合法且来自真实确定性验证（非硬编码） | 关闭 | 伪造/错 hash/软证据/未绑定证据/digest 不符**仍全部 FAIL** |
| **AC1** 无 Secret（19 家族） | 关闭（**含存量自愈**） | 家族 **19**；`test-learn-ac1-secret-families` **40 PASS/0 FAIL**；生产 `LEAK_AUDIT=CLEAN`（19 族 × 10 文件零命中，重启前存量 google=1/stripe=1 → **0**） |
| **A7** 安全正例（1 条低风险 Experience） | 达成 | `learn_verify exp-2ed0f0c9` → `ok:true / VERIFIED_EXPERIENCE / method=session_outcome`；未批准发布被拒 |
| 全量回归 | **0 新失败** | **29/29 套件全绿，1129 PASS / 0 FAIL**（门槛断言） |
| 生产部署 | 生效 | 健康 **200**、learn 工具**恰好 6**、无重复注册、无崩溃签名、四插件 `SAME` 且 mtime < 启动时间 |
| 生产负向安全 | 8/8 **DENIED** | 含"代理自审批"被拒（`approval_not_granted:rejected`） |
| 边界（6 项） | 全 **NO** | 无 force push、无重启 Windows、无 base 变更、无真实会话迁移、未进 P5、无升级官方 DSH |
| 本任务产物凭据清除 | 完成 | 3 个文件含**与现行生产配置同值的真实凭据副本** → 就地脱敏 + 复验 0（见 `AC1_ARTIFACT_REDACTION.md`） |

---

## 二、为什么仍不是 VERIFIED（两条独立理由）

### 理由 A（设计上的真人边界，不可由代理绕过）

- 本会话审批策略为 `never`（`NEVER_SENTENCE`）⇒ `@deepseek-ai/dsh-user-approval` 在 `never` 下
  **在交互式分发之前**直接返回 `rejected`（`lib/index.js L188`）。
- 实测（非推断）：`learn_review(experienceId=exp-2ed0f0c9, approve)` → `approval_not_granted:rejected`；
  审批台账 `HUMAN_APPROVAL_REQUESTED → HUMAN_APPROVAL_DENIED`；全局库 `GLOBAL_PUBLISH_DENIED ×2`、`count=0`。
- ⇒ 代理侧**只能请求、不能授予**。要跨过这道门，必须**真人在 policy=ask 的会话**里批准。

### 理由 B（A10 独立复核确认的合同级缺口，属既有范畴）

| AC | 缺口 | 证据 |
|---|---|---|
| **AC2** | 运行时**研究腿未接线**：`researchPlan` 在插件内只有定义、无调用者 | `learn-candidate.mjs:181`；plugins 全量 grep 仅 1 处命中（=定义）⇒ mandatory 场景① **未达成**<br>**→ 2026-09-28 已修复并加锁，见下方「补记二」** |
| **AC6** | Candidate 的 **Transaction/canary/deploy 腿仅声明、零调用** | `tests/learn` 中 `Transaction` 引用 = **0**；`ci-level1.yml:191` 把 `dsh-plugin-transaction.ps1` 列入 `$skip` |
| **AC10** | **CI 内无真实 E2E 门**（本地真门全绿，但 CI 自述刻意排除 6 个真实数据门） | `ci-level2.yml:149-154` |

⇒ 完整对照（AC1–AC10 逐条 + 4 个 mandatory 场景）见 `A10_CONTRACT_MATRIX.md`。

> **补记（2026-09-28，不修改上文历史判定）**：上表 **AC6 一行已关闭**。
> 经真实三腿端到端（真 git worktree/commit `74fd41c9…` + 在该 commit 真跑 `ci-level2.yml` 作业命令 +
> 真 `dsh-transaction.ps1` 到 `COMMITTED/COMMIT_READY` + 真隔离宿主 canary）**24 PASS / 0 FAIL**，
> 含 3 组篡改负向对照全拒 ⇒ AC6 **PARTIAL → PASS**。
> 报告：`AC6_REAL_PROMOTION_CLOSURE.md`；原始证据：`docs/roadmap/evidence/AC6_REAL_E2E_R3_CLOSURE/`；
> 矩阵同步：`A10_CONTRACT_MATRIX.md` AC6 行。
> **本文档的总判定不变：P4 仍 ≠ VERIFIED** —— 理由 A（真人审批门）**未变**，理由 B 中 **AC10 仍未关闭**
> （AC10 需 GitHub 托管运行 = 动 main/reliability-v1，属需人类裁决的范围扩权）。 〔**⚠ 2026-10-01 时效标注：已被取代** —— AC10 已于 09-30 客观闭合，当前判定 = `VERIFIED (ENGINEERING-COMPLETE) / AWAITING EXTERNAL REVIEW`。见文首标注〕

> **补记二（2026-09-28，不修改上文历史判定）**：上表 **AC2 一行已关闭（代码层）**。
> 经用户明确授权后，研究腿从"零调用"改为真接线（**不新建第二套研究系统**：`researchDirective` 交回既有 agent
> 研究工具链执行，有界失败落 `EXPERIENCE_LOOKUP_MISS`）：
> ① 接线锁 `test-learn-ac2-research-leg` **25 PASS / 0 FAIL**（真跑插件 execute 路径）；
> ② 负控 7 种突变**全部被抓住**（**7 PASS / 0** ⇒ 锁不恒真）；
> ③ CI 内真跑 `test-learn-ac2-research-leg.mjs (exit 0)`（隔离 commit `8211c184…`）；
> ④ 批准后发布链路 `test-learn-b1-session-access` **22 PASS / 0**（真真人批准 → 发布 → 重启后跨会话召回）；
> ⑤ AC6 回归复跑 **24 PASS / 0 FAIL**。
> 报告：`AC2_RESEARCH_LEG_CLOSURE.md`；证据：`R3_FINAL_CLOSURE/evidence/`。
> **⇒ 剩余阻塞收敛为三项**：**A8 真人审批门**（结构性，需用户）+ **AC10**（CI 内真实 E2E 门，需裁决扩权）
> + **AC2 生产部署**（代码已绿；生产 profile 仍是旧副本 `6bdd3fe5…`，需把 3 个源插件覆盖到生产挂载位。
> 本仓实测该 profile 有 watcher 热挂载 ⇒ **通常无需重启**；需用户同意后执行，配方见 `RUNBOOK.md`）。
> **故 P4 总判定仍为 ≠ VERIFIED**，但**理由 B 中只剩 AC10 属"未修的合同缺口"**。 〔**⚠ 2026-10-01 时效标注：已被取代** —— 见文首标注；当前 AC1–AC10 = 全 PASS〕

**为什么不在本轮顺手修**：本轮授权范围是"B1/B2 最小修复 + 终局判定"，AC2/AC6/AC10 的修复属于**扩范围**
（会改 CI 工作流与插件架构）。按纪律：**只定位、只登记，不动手**（已写入 `KNOWN_ISSUES.md`）。

---

## 三、有意**没有**做的事（避免越权/洗白）

1. **未冻结 `POST_P4_VERIFIED_GOLDEN`** —— 因为判定不是 VERIFIED（冻结它等于伪造一个"已验证"锚点）。
2. **未进入 STAGE B**（只读审计）—— 合同规定"仅 P4=VERIFIED 后进入"，本轮保持 **NO**。
3. **未生成 Reviewer 99 的新 verdict** —— Reviewer 99 是**外部评审通道**，代理只记执行结果
   （与 Phase 02.75/02.5 的既有纪律一致：`未触碰 Reviewer 99 页 verdict`）。
4. **未洗白历史** —— 旧的"未重启即宣称生效"结论仍按 A5 的更正保留：只撤回结论、保留"未执行重启"的执行事实。
5. **未修任何旁支缺陷**（six pre-existing defects 等）—— 一律 `NOT FIXED / OUT OF SCOPE`。

---

## 四、真人待办（3 步，做完之后我才能继续）

1. **在审批策略=ask 的会话**里批准 `exp-2ed0f0c9`：`learn_review({ experienceId:"exp-2ed0f0c9", action:"approve", evidence:"<为何可复用的具体证据>" })`。
   （本会话是 `never`，所以**换一个新会话**做这一步。）
2. 批准后可自主完成：**全局发布 count=1 → 新会话 `learn_recall` 跨会话召回 → 耐久确认**（全局库是磁盘文件）。
3. 若上述 + AC2/AC6/AC10 缺口也被接受/修复，再谈 `P4_VERIFIED` 与 `POST_P4_VERIFIED_GOLDEN` 冻结。

---

## 五、接手提示（下一个会话/模型只需读这 4 个文件）

| 文件 | 作用 |
|---|---|
| `_p4r2-final-closure/P4_FINAL_VERDICT.md` | 本判定（先读这个） |
| `_p4r2-final-closure/A10_CONTRACT_MATRIX.md` | AC1–AC10 + 4 场景逐条裁决与证据（含生产生效补充） |
| `_p4r2-final-closure/AC1_ARTIFACT_REDACTION.md` | 凭据清除记录（含回滚注意） |
| `_p4r2-final-closure/_post-restart-verify.mjs` | 一键复验（健康/工具/装载/泄漏/崩溃签名） |

P4 仓库内同一份副本：`_p4r2-inject-fix/docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/`。
