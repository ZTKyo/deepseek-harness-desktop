# R4 独立验证者报告（中间态，因"冻结"前提不成立）

生成时间：2026-09-25 23:31（本机）
角色：只读独立验证者（未修改 `_p4r2` 任何文件）

## 0. 冻结判定：NOT FROZEN（关键前提不成立）
- 最后一次项目写入：**23:30:02** `tests\learn\test-learn-r2-b2-bounds.mjs`（此前 23:29:23 `plugins\learn.mjs`、23:27:35 同测试文件、23:18:21 `test-learn-core.mjs`）
- 我 23:28:55 检查时静默仅 1.3 分钟；在我跑套件期间（23:28:59–23:30:30）**又有 2 个文件被改**。
- `_p4r2` 相关 node 测试进程：0（进程侧干净，写入侧不干净）。
- 结论：**不满足"≥10 分钟无写入"**，故不宣布"冻结版本验证完成"；下文区分【当前字节有效】与【已过期】。

## 1. 被验 revision（清单已落盘）
- HEAD = `c5aa5beb0541e8b442cedd0d435472c02fabf025`（R2 修复提交），工作树另有 9 个 tracked 文件为 M。
- 逐文件 SHA256 清单（497 个文件，排除 .git / `_f1-checkpoint-*` / `_p4r2-evidence`）：
  `%TEMP%\_vfy-frozen-manifest.txt`
- **被验核心 artifact**：`plugins\learn-core.mjs` = `5215A9D78F9A234B80BD000E239B045928DD448B63E7F96B1548DE9B0F7ADA20`，mtime 23:16:32，
  与我的判定快照 `%TEMP%\_vfy-live-2322` **字节相同（SAME=True）** → §2/§3 结论对**当前字节**有效。
- **已过期**：`plugins\learn.mjs` 于 23:29:23 被改（快照 575E942B… → 现 EE4D61E1…，+34 行，新增只读诊断面
  `approvalLedgerStatus/approvalLedger/approvalLedgerFile`，34 处行差异）→ 任何走 **shell 链路**（`learn.mjs` apply→tool）
  的证据需在冻结后重跑。

## 2. §6(b) 篡改矩阵（新证据，对当前 learn-core 字节有效）
方法：合法批准状态落盘 → 施加篡改 → **全新进程**判定 `validHumanApproval/canPublish/publishToGlobal`。
关键点：`smart` 类篡改会**用纯 sha256 重算整本台账的链**（含 `recordId='hap-'+chain[0:16]`），
实测重算后 `verifyApprovalLedgerChain` 返回 `chain_ok=true` → **链无任何密钥、agent 可完整重算，链本身不提供抗篡改**。

| 篡改 | 链重算后 | 判定 | 结果 |
|---|---|---|---|
| 重放（删 consume 只留 grant） | chain_ok=true | `approval_ledger_grant_not_consumed` | 拒绝 ✅ |
| 插条目（复制已有 grant） | chain_ok=true | — | **放行**（但为冗余副本，未提权）⚠️ |
| 改 digest（只改台账） | chain_ok=true | `approval_ledger_record_unknown` | 拒绝 ✅ |
| 改 digest（台账+attestation 同改） | chain_ok=true | `approval_content_changed` | 拒绝 ✅ |
| 改 approvedAt | chain_ok=true | `approval_ledger_record_unknown` | 拒绝 ✅ |
| 删 grant 留 consume | chain_ok=true | `approval_ledger_record_unknown` | 拒绝 ✅ |
| 删台账文件 | n/a | `approval_ledger_record_unknown` | 拒绝 ✅ |
| attestation ref 换指 | chain_ok=true | `approval_ledger_ref_mismatch` | 拒绝 ✅ |
| **forge_full：改内容 + 伪造 grant/consume + 重写 attestation（两文件同时改，字段互相自洽）** | chain_ok=true | `validHumanApproval={"ok":true}`、`canPublish={"ok":true,"reason":"verified_approvable_experience"}`、`publishToGlobal=true` | **放行（VULNERABLE）❌** |

结论：**单文件篡改全部 fail-closed**（真正的防线是 attestation↔台账的 recordId/digest/approvedAt/ref 交叉绑定，不是链）；
**同时改两处即可完全放行**，且被改内容（`[ATTACKER-INSERTED CONTENT]`）与重造授权一起通过、零人类参与。
两处文件（`_human-approvals.jsonl`、`<sessionId>.json`）都在 agent 的 fs 写边界内 ⇒ §6 仍不合格。
（此路径在上一轮 `p6-trust.mjs forge` 已独立复现：离线伪造 `canPublish ok:true`、`publishToGlobal ok:true`。）

## 3. §9 全量回归（快照版，**不是**冻结版）
命令：`node tests/learn/run-learn-all-tests.mjs`，在 temp 全量副本 `%TEMP%\_vfy-frozen-final`（robocopy /MIR，
副本哈希与源一致；原始输出 `%TEMP%\_vfy-suite-out.txt`）
- 套件：**22/23 全绿**（门槛 18 / 观测 5）
- 门槛断言：**996 PASS / 3 FAIL** → ≥907 满足，**0 FAIL 不满足**
- 唯一失败：`test-learn-r2-b2-bounds.mjs` 42P/**3F** exit=1（摘录：`R3c ★ F1 R1：授权没丢时幂等拒绝重复批准… :: learn_review rejected: already_human_approved`）
- ⚠️ 该文件在我取样时**正被并发改写**（23:27:35、23:30:02 两次写入）⇒ 3F 属**移动靶**，不能定性为"R3 引入 3 个真实回归"，须冻结后重测。
- 反向证据（确认并发污染）：23:03 那次污染基线中 3 个"崩溃"套件
  （`redteam-r3-injection-positions` / `redteam-r3-quality` / `run-learn-contract-scenarios`）在本快照上
  **全部 PASS（exit 0）**，其中 `run-learn-contract-scenarios` 由 NO-SUMMARY/exit1 变为 36P/0F。

## 4. 仓库改动数 = 0（我）
- 我全程只读（读文件、`git` 查询、`Get-FileHash`、robocopy 出站复制）；所有探针、副本、变异都在 `%TEMP%` 下。
- 前后清单对比出现 4 处差异，全部来自**并发写入者**：`tests\learn\test-learn-r2-b2-bounds.mjs`（23:30:02）、
  `plugins\learn.mjs`（23:29:23）——与我的操作无因果（我未对仓库执行任何写命令）。

## 5. 未覆盖范围（本次未测）
1. 冻结版全量回归（前提不成立）；2. 走 shell 链路的 §8/F2 证据（learn.mjs 已变，需重跑）；
3. GUI/真实模型路径、真实会话日志的跨进程重放；4. 忙时/限流/并发多会话下台账竞争；
5. `insert_dup_grant` 放行是否可在其他语义下提权（未构造出提权变体）。
