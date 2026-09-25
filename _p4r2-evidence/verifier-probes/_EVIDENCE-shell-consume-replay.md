# 证据固化：插件壳（learn.mjs 工具层）单次消费 / 回放 + 变异灵敏度

- 固化时间：2026-09-26 00:08–00:10（本机）
- 验证者：独立只读验证者（不属写者），**0 仓库改动**、不 commit/push/merge/PR、变异只在 `%TEMP%` 副本
- 对象：v2 字节复刻 `%TEMP%\_vfy-final-2347`
  - `plugins\learn-core.mjs` sha256 = `98A49D4BBB36E32663724FC1089E67F25D57C5DFFEAE117168D47E0BA29C6D8A`
  - `plugins\learn.mjs` sha256 = `72D1D2AE76BFE094757C24B5604BC02FD6EE60D9796E49049191CCC6AE23FE8B`
- 探针：`%TEMP%\_vfy-probes\p9-shell-consume-replay.mjs` sha256 = `06952C99374932819D718CF12F721EF731E2A9CD7895EA06080E536D524C15B5`
- 原始逐行输出（verbatim）：`%TEMP%\_vfy-probes\_p9-evidence-raw.txt`
- **与 F2 无关**：本件只涉及审批权威 / 单次消费 / 回放，F2 落地不改变其结论；冻结 SHA 上会原样重跑。

## 1. 这条路径为什么此前是缺口
前序验证（p6/p7/p8）一律直接调 `core.*`（含 `core.publishToGlobal`），**没有**经过 `learn.mjs` 的工具层实现，也没有用壳实例自身的台账判定。本次改为：
- 驱动：`apply(ctx, {stateDir}).toolSpecs['learn_review'].execute(...)` —— **真实工具实现**，与生产调用同层；
- 判定：同一 `apply()` 返回的 live 授权面 `canPublishFor(exp)` / `validHumanApprovalFor(exp)`；
- 宿主：`ApprovalService` 替身把 `approval/asked` + `approval/decided(outcome='allowed-once')` 写入 `exec.agent.session.events`，`ctx.sessions.get(sid)` 返回该会话（即宿主事实层的真实接缝）。

## 2. 基线结果（v2 字节复刻）

| 检验 | 结果 | 判定 |
|---|---|---|
| 正控：工具层 `learn_review approve` | `{ok:true, publication:'published', state:'APPROVED'}`；台账 `[grant, consume]` 链 ok | PASS（正控非空） |
| 批准 reason 内容绑定 | `learn_review: approve experience exp-… digest=<64hex>` | PASS（批准绑定到内容摘要） |
| **回放**：同一经验第 2 次工具层 approve | **`learn_review rejected: already_human_approved`**；台账**仍 2 条 / consume 仍 1 条**（`chain:true`） | **PASS（回放被拒且无二次落账）** |
| 克隆候选（同内容、换 id） | `{ok:false, reason:'approval_content_changed'}` | PASS（内容绑定先于台账层拦下） |
| 篡改 `dropconsume`（删除 consume，仅留 grant） | `{ok:false, reason:'approval_ledger_grant_not_consumed'}` | PASS |
| 篡改 `dupconsume`（同一 grant 追加第 2 条 consume） | `{ok:false, reason:'approval_ledger_grant_consumed_twice'}` | PASS |
| 篡改 `dupgrant`（复刻 grant 指向克隆候选） | honest→`approval_ledger_record_unknown`；attacker→`approval_content_changed` | PASS（拒） |
| 篡改 `forge`（完整伪造 grant+consume，ref 不在宿主日志） | honest→`approval_ledger_record_unknown`；attacker→`approval_content_changed` | PASS（拒） |

四例篡改的台账**链校验均 `ok:true`**（篡改经内存台账 `append` 重算链，故"链完好但语义非法"正是要考的情形）。

## 3. 拒因层级（谁在拒）—— 必须先让宿主事实层放行
首轮抓取时篡改相位**未回放**诚实流的宿主事件，导致每个篡改例同时被宿主事实层拦下，变异后拒因从 `grant_consumed_twice` 漂成 `approval_host_fact_approval_ref_not_in_host_log` ⇒ **"拒"无法隔离到消费层**（我自己的探针缺陷，已修）。
修法：base 相位把 `approval/asked|decided` 落盘，篡改相位回放（实测 `host_fact_seeded: {events:4, asked:2}`）⇒ 上表拒因确定为**台账/消费层**作出。

## 4. 变异灵敏度（我自己的断言会不会变红）
变异 **MUT-B2**：把 `learn-core.mjs` 中单次消费强制整块删除（`grant_not_consumed` / `grant_consumed_twice` / `consumed_by_other` 三个判定连同解引用），副本 sha256 = `5F24CFD7268D8412102B1734930A222600A580FE15F957685CB7A7088699E0F8`。

| 例 | v2 基线 | MUT-B2 | 结论 |
|---|---|---|---|
| `dropconsume` | `{ok:false, approval_ledger_grant_not_consumed}` | **`{ok:true, verified_approvable_experience}`** | **断言变红 ⇒ 敏感** |
| `dupconsume` | `{ok:false, approval_ledger_grant_consumed_twice}` | **`{ok:true, verified_approvable_experience}`** | **断言变红 ⇒ 敏感** |
| （正控）base 工具层发布 | `ok:true, published` | `ok:true, published` | 变异不影响正控（非"全崩"式变异） |
| （正控）base 回放 | `already_human_approved` | `already_human_approved` | 回放防线**不依赖**消费检查（独立层） |

半删变异（MUT-B，仅把两个 `if` 改成 `if (false)`）只让 `dupconsume` 翻红、`dropconsume` 崩在残留的 `consumes[0].body` —— 属**变异不完整**，非产品缺陷；MUT-B2 消除了该假象。

## 5. `insert_dup_grant` 伪阳性的机制级结清
- `candidateDigest(exp)` **把 `id` 计入摘要** ⇒ 换 id 的克隆候选**永远拿不到可匹配摘要**，`approval_content_changed` 在台账层之前就拦下 ⇒ 该攻击**无可达面**。
- 对**同一候选**追加重复 grant 是**惰性**的：经验 attestation 只引用原 `recordId`，其视图仍恰有 1 条 consume。
- 我上一轮报出的"`insert_dup_grant` 生效"是**我自建探针的假阳性**（我伪造了自洽 attestation），已自纠；本件为机制级解释。

## 6. 复现命令（只读，全部写在 %TEMP%）
```powershell
$Pdir="$env:TEMP\_vfy-probes"; $env:VFY_FROZEN="$env:TEMP\_vfy-final-2347"
node "$Pdir\p9-shell-consume-replay.mjs" base        # 正控发布 + 回放 + 克隆
foreach ($ph in 'dupgrant','dupconsume','dropconsume','forge') { node "$Pdir\p9-shell-consume-replay.mjs" $ph }
# 灵敏度：把同一探针指向 MUT-B2 副本
$env:VFY_FROZEN="$env:TEMP\_vfy-mutB2"; foreach ($ph in 'dupconsume','dropconsume') { node "$Pdir\p9-shell-consume-replay.mjs" $ph }
```

## 7. 诚实边界（未覆盖项）
- **无真人审批 E2E**：宿主由 `ApprovalService` 替身模拟（`allowed-once`），未由真人经 GUI 点击完成一次批准。
- 本件仅在 **v2 字节复刻**上成立；**冻结 SHA 上必须原样重跑**后方可作为终版裁定的一部分。
- `learn.mjs` 的 `publishToGlobal` 仍有 1 处 `await import()` 型动态载入（已知警告），与本件结论无关。
