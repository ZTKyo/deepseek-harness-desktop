# P4 终局判定（A11）—— **P4 ≠ VERIFIED**

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
| **AC2** | 运行时**研究腿未接线**：`researchPlan` 在插件内只有定义、无调用者 | `learn-candidate.mjs:181`；plugins 全量 grep 仅 1 处命中（=定义）⇒ mandatory 场景① **未达成** |
| **AC6** | Candidate 的 **Transaction/canary/deploy 腿仅声明、零调用** | `tests/learn` 中 `Transaction` 引用 = **0**；`ci-level1.yml:191` 把 `dsh-plugin-transaction.ps1` 列入 `$skip` |
| **AC10** | **CI 内无真实 E2E 门**（本地真门全绿，但 CI 自述刻意排除 6 个真实数据门） | `ci-level2.yml:149-154` |

⇒ 完整对照（AC1–AC10 逐条 + 4 个 mandatory 场景）见 `A10_CONTRACT_MATRIX.md`。

> **补记（2026-09-28，不修改上文历史判定）**：上表 **AC6 一行已关闭**。
> 经真实三腿端到端（真 git worktree/commit `74fd41c9…` + 在该 commit 真跑 `ci-level2.yml` 作业命令 +
> 真 `dsh-transaction.ps1` 到 `COMMITTED/COMMIT_READY` + 真隔离宿主 canary）**24 PASS / 0 FAIL**，
> 含 3 组篡改负向对照全拒 ⇒ AC6 **PARTIAL → PASS**。
> 报告：`AC6_REAL_PROMOTION_CLOSURE.md`；原始证据：`docs/roadmap/evidence/AC6_REAL_E2E_R3_CLOSURE/`；
> 矩阵同步：`A10_CONTRACT_MATRIX.md` AC6 行。
> **本文档的总判定不变：P4 仍 ≠ VERIFIED** —— 理由 A（真人审批门）**未变**，理由 B 中 **AC2 与 AC10 仍未关闭**
> （AC10 需 GitHub 托管运行 = 动 main/reliability-v1，属需人类裁决的范围扩权）。

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
