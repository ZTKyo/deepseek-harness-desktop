# R5 独立审查报告（外部评审 · F1 人类审批边界 + R3 伪造面）

生成时间：本轮（本机）
角色：独立审查者（**未修改 `_p4r2` 仓库任何文件**；全部探针/产物在 `%TEMP%\_rev-p4r2\`）
被验对象：`_p4r2` HEAD `1e31537`（其上 `6b73f4e fix(learn): F1 human approval authority boundary — agent cannot mint APPROVED`）

---

## 0. 结论

**VERDICT：PASS（有条件通过）**

- 交付的 F1 修复与 R3 伪造面断言 **全部独立复现**（不是照抄交付的测试，而是自建探针 + 独立跑交付套件两条腿）。
- 交付自述的 **"诚实残余"成立且比其自述更强**：本轮首次把它从"离线函数返回 `ok:true`"推进到
  **生产召回链路端到端可复现**（全新会话真的召回出伪造条目）。
- 发现 1 项**低危**契约/实现措辞不一致（不可通过插件公开面利用），不构成 BLOCKER。
- **无新增 BLOCKER / 无新增高危。**

---

## 1. 交付完整性（PASS）

| 项 | 交付自述 | 独立复核 | 结论 |
|---|---|---|---|
| `plugins/learn.mjs` SHA256 | `36642349…91ACAC` | 逐字节一致 | ✅ |
| `plugins/learn-core.mjs` SHA256 | `B5BD3977…C1196` | 逐字节一致 | ✅ |
| 修复提交 | `fix(learn): F1 human approval authority boundary` | `6b73f4e` 在 HEAD 历史中，其后 2 个提交均为 `[no source change]` 文档提交 | ✅ |
| 工作树 | — | `git status --porcelain` 为空 | ✅ |
| 回滚点 | `_f1-checkpoint-20260925-230246/`、`_f2-checkpoint-20260926-001832/` | 两个目录均存在 | ✅ |

## 2. 全量回归（PASS，独立复现）

命令：`node tests/learn/run-learn-all-tests.mjs`（在仓库内直接跑，未改任何文件）

- **套件：25/25 全绿**（门槛 20 / 观测 5）
- **门槛断言：1045 PASS / 0 FAIL**
- 逐套件复核（关键）：`test-learn-core.mjs` 499P、`test-learn-r3-approval-forgery.mjs` 27P、
  `test-learn-r3-hardening.mjs` 30P、`test-learn-r3-fixes.mjs` 30P、`test-learn-r3-secrets.mjs` 62P、
  `test-learn-r2-b1-approval-gate.mjs` 19P、`test-learn-r2-f2-store-min.mjs` 19P、`test-learn-r2-b2-bounds.mjs` 45P。

> 对照 R4 报告：R4 当时测到 **22/23、3 FAIL**（唯一失败 `test-learn-r2-b2-bounds.mjs` 42P/3F），
> 并自行判定为"移动靶/并发污染"。本轮在当前字节上 **3 FAIL 不再复现，全绿** ⇒ R4 的判定被证实：
> 那 3 个 FAIL 是并发写入产物，**不是 R3 引入的真实回归**。

## 3. R2 → R3 delta 专项（自建探针 H 组：5/5 PASS）

| 断言 | 实测 | 判定 |
|---|---|---|
| H1 APPROVED + 机器验证 PASS ⇒ 仍 APPROVED | `verifyOk=true err=undefined method=file_hash state=APPROVED` | PASS |
| H2 PROPOSED + PASS ⇒ 晋升 VERIFIED_EXPERIENCE | `state=VERIFIED_EXPERIENCE` | PASS |
| H3 APPROVED + 机器验证 FAIL ⇒ 仍 APPROVED（授权不被验证失败反手判废） | `err=file_hash_mismatch state=APPROVED vstatus=UNVERIFIED` | PASS |
| H4 真实宿主批准 ⇒ 台账簿记齐备 | `provenance=true/ok`、`actor=host-approved-human`、`outcome=allowed-once`、`digestBound=true`、`chainOk=true` | PASS |
| H5 grant 二次消费 ⇒ 拒 | `ok=false reason=approval_ledger_grant_consumed_twice`（记录数 2→3） | PASS |

⇒ R2 外部评审 **BLOCKER-1（未审批经验可跨会话进入全局库）的根因确实被修**，
且"审批粘性"（APPROVED 不因重新验证被撤销）与"晋升路径未被粘性逻辑误伤"两者**同时成立**。
交付套件自身也覆盖了这两条（`test-learn-r2-b1-approval-gate.mjs` 的 B5 / D1 / D2）⇒ 属**独立双证**。

## 4. 回源锚点（AC1）绑定强度专项（自建探针 I 组）

| 断言 | 实测 | 判定 |
|---|---|---|
| I3 对照：未改动 ⇒ 可发布 | `canPublish={"ok":true,"reason":"verified_approvable_experience"}` | PASS |
| I1 审批后改 `sourceEventSeqs` ⇒ 判废 | `approval_content_changed`（`approvalProvenance` 与 `canPublish` 同判） | PASS |
| I2 审批后改 `body` ⇒ 判废 | `approval_content_changed` | PASS |
| I4 锚点校验的不对称性 | `file_hash` 类证据**不**校验锚点；`session_outcome` 类校验 | INFO（见 §6） |
| I5 发布面不核对"锚点是否真实存在" | 锚点 `[11,22,33]`、会话只有 3 个事件 ⇒ `canPublish ok:true` | OBSERVED-GAP（见 §6） |

⇒ **审批后偷换来源锚点不可能**（`sourceEventSeqs` 已纳入 `candidateDigest`），AC1 的"回源锚点不可被事后改写"成立。

## 5. 残余风险端到端实证（本轮最关键的新证据）

交付 §9.1 自述：*"宿主会话存储完整性是信任根…**生产实证未做**…⇒ 不得声称「agent 绝对无法自铸授权」"*。
本轮把这条从"离线函数返回 `ok:true`"推进到**生产召回链路**：

| 探针 | 构造 | 实测 |
|---|---|---|
| **G1** | 伪造 `grant`+`consume` 台账（链自洽）+ 植入宿主会话日志 `approval/asked`+`approval/decided` 事件对 + 写入全局库 ⇒ **全新会话**召回 | `globalStoreLoadedN=1`、`recalledIds=["exp-a4cbc474"]`、`validHumanApproval.ok=true` |
| **G2** | 同上但**去掉**植入的宿主日志事件对（对照） | `recalledIds=[]`（被拒） |
| **G5** | PROPOSED 条目跨会话召回（对照） | A/B 会话命中均 0（设计：PROPOSED 永不召回） |

**结论：交付声明的残余风险成立、且可端到端利用**（伪造内容 + 伪造授权一起通过、零人类参与），
但**前提是同时具备两处写权限**：插件 `stateDir`（台账/全局库）+ **宿主会话存储**（`~/.dsh/sessions` 的原始文件写）。
G2 证明"只改插件侧"被 fail-closed 挡住 ⇒ 残余的作用域描述是准确的，未被夸大也未被低估。

> 与交付自述的一致性：`test-learn-r3-approval-forgery.mjs` 自身在结尾就声明该边界"不在 learn 插件权限面内、
> 生产实证未做、由宿主/运维负责存储完整性"。本轮**不是推翻**这条声明，而是**为其提供了生产链路的实证**。

## 6. 低危发现（不构成 BLOCKER；建议但不阻塞）

**F-R5-1（LOW，契约/实现措辞不一致）**：`learn_propose` 的权威契约声明
"Official Session = 唯一 Truth Source。经验必须携带 `sourceEventSeqs` 官方回源锚点"，
但**提案面只校验"非空"**，不在发布面回源核对"该 seq 在会话中真的存在"（I5）。
- **实际影响 = 低**：插件公开面产生的经验，其 `verificationEvidence` 只可能是 `session_outcome`
  （该类**会**回源核对，G4 实测 `anchors_not_found_in_session`），
  故伪造锚点的经验**永远到不了 VERIFIED ⇒ 到不了发布**（G3 实测 `not_verified:UNVERIFIED`）。
  要触达 I5 需要手写 store 条目 —— 与 §5 残余同属"已具备存储写权限"的信任边界。
- **建议**：把契约措辞收紧为"锚点必须非空且（机器证据路径下）须能在官方会话中回源命中"，
  或把 `learn_propose` 的锚点校验升级为"存在于当前会话"。**属文档/UX 正确性，非安全缺口。**

**F-R5-2（INFO，设计观察，非缺陷）**：台账链为**无密钥纯 sha256**，具备文件写权限者可完整重算
（含 `recordId`）⇒ **链本身不提供抗篡改**，真正的防线是 `attestation ↔ 台账` 的
`recordId/candidateDigest/approvedAt/ref` 四重交叉绑定 + 宿主事实复验。交付代码注释已如实说明这一点。

## 7. 探针自身缺陷的诚实归类（不得当作产品缺陷上报）

第一轮探针（`rev-probe.mjs`）有 2 条 FAIL，经复核**均为探针侧缺陷**，已由后续探针纠正：

- `P0-positive-control` FAIL：探针把 `verificationStatus==='VERIFIED'` 写进了通过条件，
  但该路径（LLM 提案）本就不产生机器证据 ⇒ 期望值错误。**产品行为正确**（审批 ≠ 可发布，需另有机器验证）。
- `P7-approval-stickiness` FAIL（`after=undefined`）：探针用 `applyVerification(…, before.verificationEvidence, …)`
  重跑验证，而该字段为 `null` ⇒ 断言实际未执行，属**探针管道缺陷**。
  粘性已由探针 3 的 H1/H3 **正确重测并通过**。

## 8. 未覆盖范围（本轮未测，不得视为已验）

1. **真人审批端到端**（本会话审批提示被禁用，正向腿建立在"模拟诚实宿主"接缝上）；
2. `~/.dsh/sessions` 原始文件级攻击的**生产环境**实证（本轮在忠实夹具中复现，未触碰生产状态）；
3. GUI / 真实模型路径下的审批与召回；
4. 生产环境激活与投放后的行为（本轮四项开关全 NO）；
5. 忙时/限流/并发多会话下的台账竞争。

## 9. 证据索引（全部可复现）

| 产物 | 路径 |
|---|---|
| 探针 1（审批边界 P 组） | `%TEMP%\_rev-p4r2\rev-probe.mjs` |
| 探针 2（残余端到端 G 组） | `%TEMP%\_rev-p4r2\rev-probe2.mjs` |
| 探针 3（R2→R3 delta H 组，5/5 PASS） | `%TEMP%\_rev-p4r2\rev-probe3.mjs` + `rev-probe3-out.txt` |
| 探针 4（锚点绑定 I 组） | `%TEMP%\_rev-p4r2\rev-probe4.mjs` + `rev-probe4-out.txt` + `rev-probe4-result.json` |
| 全量回归原始输出 | 本轮 `node tests/learn/run-learn-all-tests.mjs` stdout |

## 10. 仓库改动数 = 0（审查者）

本轮全程只读：读文件、`git` 查询、`Get-FileHash`、运行既有测试、在 `%TEMP%` 下建探针。
未对 `_p4r2` 执行任何写命令（可对照 §1 的哈希/工作树复核）。
