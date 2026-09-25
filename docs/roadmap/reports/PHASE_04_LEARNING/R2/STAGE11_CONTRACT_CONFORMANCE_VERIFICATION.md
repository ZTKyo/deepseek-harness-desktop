# STAGE 11 · 合同符合性验证（P4 R2）

生成时间：2026-09-25
验证者：主 Agent（Codex 实现工因卡死被中断后由主 Agent 接手验证与取证）
状态：**R2 = NOT CONTRACT-COMPLETE / P5 保持 LOCKED**

---

## 0. 一句话结论

R2 的**自有测试面全绿**（门槛 740 PASS / 0 FAIL，20/21 套件全绿），但按 **Notion PHASE 04 合同原文**
逐条求证，**存在 17 条未成立的合同条款**；其中最关键的一项使合同核心闭环
「解决 → 验证 → 保存经验 → **下次复用**」在实现上**结构不可达**。

因此：**不得称 R2 完成，不得进 P5。**

---

## 1. 为什么本文件按"合同原文"而不是"自定 AC 编号"求证

PHASE 04 合同页自身记录的病根（原文）：

> **口径断裂（根因）**：P4 报告使用**自定 AC1–AC12** 编号，与合同 AC1–AC10 不对齐
> ⇒「测试全绿」不能作为合同达成证据。

因此本次验证**不复用 R2 的自定 AC 编号**，而是直接对合同硬条款求证，并把求证过程做成
**可重复执行的探针**，而不是一段文字断言。

---

## 2. 交付物

| 文件 | 性质 |
|---|---|
| `tests/learn/run-learn-contract-scenarios.mjs` | 合同符合性探针（新增，可重复执行，exit 1 = 有未成立条款） |
| `STAGE11_CONTRACT_CONFORMANCE_VERIFICATION.md` | 本文件 |

探针不写生产状态；只读真实会话（`~/.dsh/sessions/*.jsonl.zstd`）；只写 `os.tmpdir()`。

**复现命令**

```powershell
cd "C:\Users\Administrator\Desktop\sdeepseek harness\_p4r2"
node tests\learn\run-learn-contract-scenarios.mjs   # 期望：18 PASS / 17 FAIL，exit 1
node tests\learn\run-learn-all-tests.mjs            # 期望：20/21 全绿，门槛 740 PASS / 17 FAIL
```

---

## 3. 实测结果（真实会话，非合成数据）

真实会话选材：A = 116,496 events / 9,465 surface nodes；B = 36,907 events / 3,066 nodes（两个不同文件）。

### 3.1 成立的合同条款（18 PASS）

| 条款 | 求证方式 | 结果 |
|---|---|---|
| 【Failure Class】合同点名的 9 类来源 | `FAILURE_ORIGIN` = environment / provider / network / user / website / tool / skill / model / unknown | **PASS（逐类具备）** |
| 场景 1 学习：真实会话 → 自动候选 | 真实会话 A 自动产出 1 条 PROPOSED，回源 seq 均指向真实事件 | **PASS** |
| 学习 ≠ 生效 | PROPOSED 不可召回 | **PASS** |
| 【Experience Store】`id/title` | 记录含 id、title | **PASS** |
| 场景 3 重复阈值 | `REPEAT_THRESHOLD = 2`（缺口必须重复才固化） | **PASS** |
| 场景 3 防误学（硬否决面） | `HARD_VETO_CLASSES` 7 类（限流/超时/过载/配额/鉴权/路由/上下文） | **PASS** |
| 场景 3 有界 | `MAX_CANDIDATES` 为正整数 | **PASS** |
| 场景 4 不泄漏 Secret | 密钥形态正文未持久化进经验库 | **PASS** |
| 场景 4 会话隔离 | B 库不含 A 条目 | **PASS** |
| 首轮不回填历史 | 首次 pre-step 只建水位 | **PASS** |

### 3.2 未成立的合同条款（17 FAIL）★ 这是本文件的核心

#### A. 合同【复用规则】与【实现原则 5】整体不可达（决定性）

合同原文：

> 【复用规则】相似任务 → 检索 experience → **检查适用性** → 复用 → **重新验证**。
> 历史经验只是先验，不是绝对真相。

实测（真实两会话）：

```
OBS   session A auto-proposed experiences = 1        → A 内审批后 APPROVED
PASS  同会话（A 内）召回条数 = 1                     ← 这正是上一轮被判"近乎同义反复"的路径
OBS   storePath 形态 = stateDir/<sid>.json（每会话一库）
OBS   session B experience count = 1
OBS   跨会话（B 检索 A 的经验）召回条数 = 0
FAIL  [场景2] 合同核心闭环「下次复用」成立 ⇒ B 库条目=1；召回=0
```

**根因（代码级）**：`plugins/learn.mjs` L173

```js
function storePath(sid) { return path.join(cfg.stateDir, sanitizeFileId(sid) + '.json'); }
```

经验库是 **`<sid>.json` 每会话一库**，`loadStore(sid)` 只加载本会话文件（含归属守卫）。
⇒ A 会话学到的经验对 B 会话**完全不可见**，合同所说的"**下次**复用"在结构上不可能成立。

这也**解释了合同早先的判定**：「#2 近乎同义反复（E2E 复用查询串 = 候选自身标题）」
—— 因为只有**同一会话内**的"复用"才可能命中，任何真实的"下次复用"都会得到 0 条。

#### B. 适用性检查机制不存在

```
FAIL  [场景2] 存在可执行的"适用性检查"入口
      — 工具面 = ["learn_propose","learn_review","learn_recall","learn_promote","learn_status"]
```

`plugins/learn-core.mjs` L508 `recall()` 只做**词面匹配**
（候选集 = APPROVED；打分 = 查询词命中率 + 标签加权；排序 = 分数降序 → id 升序），
**没有任何版本 / 环境 / 适用性判定**；`recordRecall()`（L552）只累加 `recallCount` / `lastRecalledAt`。
仓库内 `plugins/learn*.mjs` 对 `isApplicable|适用性|applicable|revalidat|重新验证` 的命中数为 **0**
（唯一 `STALE` 命中是 `learn-gap-veto.mjs` 中与 **goal** 有关的错误码，与经验无关）。

#### C. 合同【Experience Store】字段清单 11 项中 8 项缺失

合同原文（必须包含）：

> 每条经验只保留：id/title · taskType/trigger/symptoms · **applicable versions/environment** ·
> rootCause · successfulMethod · failedOrUnsafeMethods · verificationEvidence · rollback ·
> source links/commit · **stale/expiry conditions** · **lastVerifiedAt**

实测经验记录字段（`makeExperience()` L249）**仅有**：

```
id, state, title, body, tags, sourceEventSeqs, originSessionId, createdAt,
approvedAt, approvedBy, approvalEvidence, rejectedAt, rejectedBy, rejectionReason,
retiredAt, promotion, promotionEvidence, recallCount, lastRecalledAt
```

⇒ 缺失：`taskType/trigger/symptoms`、`applicable versions/environment`、`rootCause`、
`successfulMethod`、`failedOrUnsafeMethods`、`verificationEvidence`、`rollback`、
`source links/commit`、`stale/expiry conditions`、`lastVerifiedAt`
（仅 `id/title` 一项成立）。

即：当前记录是**通用 title/body/tags 便签**，不是合同要求的**结构化经验**。

#### D. 【实现原则 3】VERIFIED_EXPERIENCE 不存在，且审批不做验证

```
OBS   EXPERIENCE_STATES = ["PROPOSED","APPROVED","REJECTED","RETIRED"]
FAIL  合同要求存在 VERIFIED_EXPERIENCE 终态
OBS   ALLOWED_TRANSITIONS = {PROPOSED:[APPROVED,REJECTED], APPROVED:[RETIRED], REJECTED:[], RETIRED:[]}
FAIL  合同要求"复用后重新验证"存在可表达的状态迁移
```

合同【实现原则 3】：

> 所有经验必须经过**真实成功验证**后才能标记 VERIFIED_EXPERIENCE。

实现里 `approve()` 只校验「审批人非空 + 证据非空 + 证据不含密钥形态」，
**不执行任何验证动作**，也没有 `VERIFIED_EXPERIENCE` 这一状态可标记。
状态机里也**没有任何"验证/重新验证"迁移**可表达合同的语义。

#### E. 复用后无可审计的"重新验证"痕迹

```
FAIL  [场景2] 存在"重新验证"的遥测种类
      — 实际 19 种遥测里无 VERIF/REVALIDAT 类
```

---

## 4. 实现侧的真实改进（应予确认，不因上述缺口而抹去）

R2 在**能力缺口路径**上是真实接线且质量较高的，本次实测确认：

- `maybeQualifyCapabilityGap()` 在插件真实路径上运行，把**未解决 + 可归属自身能力 + 重复**
  的失败聚合为能力缺口（`REPEAT_THRESHOLD = 2`），与经验路径**水位互不干扰**。
- **Fake Gap Guard 的码级否决面（本会话内由实现工修复，已验证一致）**：
  `CAPABILITY_ADAPTER_VERSION = 2` + `NON_CAPABILITY_CODES`。
  修复前 `classifyFailureOrigin()` 只要 `isError === true` 且带 `toolName` 就判 `origin = tool`，
  而 `tool ∈ LEARNABLE_ORIGINS` ⇒ learnable = true；实测把真实会话出现过的**全部 25 个 error.code**
  逐个喂入，**25/25 全判 learnable**（含 `TOOL_TIMEOUT` / `WEB_ABORTED` /
  `WEB_PROVIDER_CREDENTIAL_MISSING` / `ABORTED` / `ASK_CANCELLED` / `GOAL_*` / `INVALID_ARGS` /
  `UNKNOWN_TOOL`），违反任务书 §21 与 STAGE 2 负例要求。v2 已加入码级否决并 bump 版本。
- 【Failure Class】9 类来源逐类具备。

**但**：这一改进属"缺口路径的正确性"，**不能替代**第 3.2 节的合同条款。

---

## 5. 诚实边界（本次**未**验证的事项）

1. **场景 3 未取得端到端真实缺口候选**：探针运行到 `session A candidate store = null`
   ——所选真实会话未出现达阈值的合格缺口。本次对场景 3 的结论**仅到机制面**
   （阈值 / 否决面 / 有界性），**不代表**已在真实数据上跑通"缺口 → 候选 → 有界研究"全链。
2. 未审计实现工 03:25 对 `learn-gap-veto.mjs` 改动的**每一行**；只做了结果级一致性核验
   （其余 20 套件门槛 740 PASS / 0 FAIL，无半成品破损）。
3. 未触碰生产 profile、未重启服务、未 merge、未部署。
4. 本文件不构成对 P4 完成与否的裁决 —— **裁决权在外部 Reviewer**。

---

## 6. 建议的下一步（交 Reviewer 裁定，本 Agent 不擅自补实现）

合同要求的机制缺失不是"测试没写好"，而是**实现缺失**，因此补测试无法解决。可选路线：

1. **回炉补实现（推荐）**：把经验库改为**跨会话共享库 + 会话归属标注**；
   按合同扩展 Experience Store 字段；引入 `VERIFIED_EXPERIENCE` 状态与「复用后重新验证」迁移；
   新增可执行的适用性检查入口（版本/环境/过期条件）。之后本探针应自然转绿。
2. **收窄合同**：若坚持"每会话隔离"是刻意设计，则须由 Reviewer 修改合同措辞，
   并明确「下次复用」的替代语义。**不得**在合同未改的情况下声称达成。
3. 无论选哪条，P5 **保持 LOCKED**。

---

## 7. 附：本会话内其它已验证结果

| 项 | 证据 | 结果 |
|---|---|---|
| LEARN 全量回归（R2 自有面） | `node tests/learn/run-learn-all-tests.mjs` | 20/21 套件全绿；门槛 **740 PASS / 0 FAIL**（唯一失败项 = 本探针，即合同缺口） |
| 跨阶段全量回归（L1/L2 纯 node 只读子集） | 见 `_p4r2/_diag-fullreg-pure-node.mjs` 输出 | **26/26 全绿** |
| CI L1 secret scan（真实门槛） | `SECRET SCAN PASSED`，EXITCODE=0 | **PASS** |

以上三项与第 3.2 节的合同缺口**并不矛盾**：前者的口径是"R2 自定 AC 下的工程面"，
后者的口径是"合同原文硬条款"。**两者都成立，且不得互相替代** —— 这正是合同页所说的"口径断裂"。
