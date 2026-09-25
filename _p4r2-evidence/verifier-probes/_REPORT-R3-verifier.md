# 独立只读验证报告（R3 §6 / §8 / F2）— 23:21 快照

- 验证者：独立只读 agent（未修改仓库任何文件）。探针全部位于 `%TEMP%\_vfy-probes\`（4 个文件），stateDir 全部为 `%TEMP%\_vfy-*` 隔离目录。
- 被测修订：**冻结副本** `_vfy-frozen`（learn-core sha 9912BED5…，learn.mjs sha 2F4E7704…，23:11–23:12）
  ＋ **实时仓库快照** `_vfy-live-2322`（plugins/*.mjs 于 23:21:43 复制；learn-core sha 5215A9D78F9A234B mtime 23:16:32，learn.mjs sha 575E942BC0879CDB mtime 23:14:56）。
  两套修订上**结论完全一致**。仓库在 23:14–23:16 又被写过（冻结后仍有更新）。

## §6 信任通道（human approval seam）— 3 项攻击全部成功
1. **读/复制/推导**：`<stateDir>\_human-approvals.jsonl` 为明文 JSONL（852B/2 行），无任何密钥字段
   （`any_secret_field_in_ledger: false`）。链条 = `sha256(JSON(["learn-human-approval-ledger/v1",seq,prev,body]))`，
   纯公开字段，**任何人可离线复算**（实测 stored==mine, match=true）。
2. **伪造台账+attestation（零人类参与）→ canPublish 放行**：
   离线 `makeApprovalRecord` 造 grant+consume，attestation 指向该 recordId，写进 stateDir。全新进程：
   `validHumanApproval {"ok":true,"reason":"ok"}` / `canPublish {"ok":true,"reason":"verified_approvable_experience"}`
   / `isPublishable true` / `publishToGlobal {"ok":true}`。
   该 approvalRef 在任何宿主日志中都不存在（`hostApprovalRecord → approval_ref_not_in_host_log`），
   但**发布判定根本不查宿主日志**。
3. **进程内自铸**：`approve()` 接受**攻击者自己拼的普通对象**当 session（events 里塞 approval/asked+decided）
   → `{"ok":true,"ledgerRecordId":"hap-…","state":"APPROVED"}`；且 `attachApprovalLedger`/`createMemoryApprovalLedger`
   为公开导出 → 注入一本伪造内存台账即可 `canPublish {"ok":true}`（不写任何文件）。
   前置条件：能与 learn-core 共享同一模块实例的进程内代码（流氓插件/被改插件代码）。

## §8 A–F（全新进程重启后判定）
| 项 | 结果 | 证据 |
|---|---|---|
| A 合法批准跨重启仍有效 | **PASS** | `canPublish {"ok":true,"reason":"verified_approvable_experience"}`；`validHumanApproval ok` |
| B 跨会话 | **PASS** | A 会话 publish → B 会话 `recall items:["exp-4efbf6c9"]`；grant 里 hostSessionId 仅记录、判定从不比对 |
| C 内容不变 | **PASS** | 同 A（重启未降级） |
| D 内容变化 → 旧批准失效 | **PASS**（fail-closed） | body/title 任一改动 → `approval_content_changed` |
| E 验证失效 → 不得发布 | **PASS**（fail-closed） | 复验失败 → `REVALIDATION_REQUIRED`；`canPublish not_verified:REVALIDATION_REQUIRED`（批准本身仍 ok，职责正确分离） |
| F 重新验证不得错误降级 | **PASS** | 复验通过 → status 回 `VERIFIED`，state 仍 `APPROVED`，`canPublish ok` |

注：父 agent 预期“A/C FAIL（进程内密钥每次 apply 轮换）”在**本修订不成立**——A/C 现在 PASS。

## F2 边界
| ENV | apply 抛错 | 配置校验日志 | maxFiles | 66 个会话文件 → kept/removed |
|---|---|---|---|---|
| 63 | 无 | **无**（`minimum supported sessionStoreMaxFiles is 64` 不存在） | 63 | 63 / 3 |
| 64 | 无 | 无 | 64 | 64 / 2 |
| 65 | 无 | 无 | 65 | 65 / 1 |

→ **63 未被 reject（规格期望 reject）**：63/64/65 一律 accept；`envPosInt(..., min=1)` 无下界校验。

## 复现命令
```powershell
cd $env:TEMP\_vfy-probes
$env:VFY_STATE="$env:TEMP\_vfy-p8-state"; node p8-lifecycle.mjs 1; node p8-lifecycle.mjs 2   # §8
$env:VFY_STATE="$env:TEMP\_vfy-p6-forge"; node p6-trust.mjs forge; node p6-trust.mjs decide    # §6(b)
node p6-trust.mjs read; node p6-trust.mjs session-forge; node p6-trust.mjs memory-ledger        # §6(a)(c)
node p-f2-bounds.mjs                                                                           # F2
# 对实时修订复跑：$env:VFY_FROZEN="$env:TEMP\_vfy-live-2322" 后再执行上述命令
```
耗时：探针总墙钟 ≈ 3 分钟（23:19:03 起，含两轮修订复跑；单条 probe < 30s）。

## 修复方向（建议，未实施）
台账链条无密钥 ⇒ 谁可写 stateDir 谁就能造授权。可选：① 把台账移出 agent 可写边界（独立 OS 账户/ACL + DPAPI 保护）；② 链条改由宿主持有密钥签章（宿主 ApprovalService 签名，发布时验签）；③ 发布判定同时校验宿主会话日志里的 approval/decided 原始记录。
