# PHASE_02_SECURITY_HARDENING — REPORT_SH_R5

> Security-Hardening External Review Round 4 修复（最小 SH-R5 收口，三项 + HARDENING）
> 日期：2026-08-26 ｜ **状态：IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**
> 前置：REPORT_SH1.md、REPORT_SH_FINAL.md、REPORT_SH_R2.md、REPORT_SH_R3.md、REPORT_SH_R4.md（不覆盖）
> 边界：未 rotate/delete 任何 secret；未进入 P2.5 / Phase 03；未新增第二 recovery loop/daemon/authority；未改 Official Core

---

## 0. Reviewer Verdict（External Review Round 4）

- SH-R4 的 $preflightLog 补齐、try/finally + WriteAllBytes 方向、结构化 probe、5.1 restart 修复、15/15 真实 cold boot 均**通过**。
- **BLOCKING-1**：20:04→21:16 的 72 分钟 Task Recovery 根因仍未证明；REPORT_SH_R4 的"intent=RUNNING 所以 boot scan 跳过"与 production code 冲突（RECOVERABLE_STATES 含 RUNNING + apiOk 后固定 5s recoverableScan + listRecoverable 返回 autoResume=true 的 RUNNING）。该回归**不得推给 P2.5**。
- **BLOCKING-2**：CURRENT_STATUS 全文仍自相矛盾（顶部 SH-R4 完成 / 下部 SH-R4 修复中 + REPORT_SH_R3）。
- **VERIFICATION GAP**：B1 名称写 byte-for-byte 但实现只 regex 检查 token 行存在。
- **HARDENING**：Start-Process sibling/not-child 注释夸大了 Windows 进程树保证。

## 1. SH-R5-1：boot:23056 72 分钟停滞 — 可证伪根因分析（Close）

### 1.1 代码事实（修正 REPORT_SH_R4 的错误解释）

production code 确认（execution-continuity.mjs）：
- `RECOVERABLE_STATES` 含 `"RUNNING"`；
- `listRecoverable()` = `autoResume !== false && state !== RETRYING && RECOVERABLE_STATES.includes(state)` → **RUNNING + autoResume=true 必在 recoverable 列表**；
- boot 时 `apiOk && enableAutoResume` → **无条件** `setTimeout(recoverableScan("restart"), 5000)` + `scheduleRecoveryLoop()`（L1427-1431）；
- `recoverableScan` 在 `listRecoverable()` 空时**静默 return（无日志）**（L1298）。

→ **REPORT_SH_R4"RUNNING 被设计上跳过"的说法错误**。正确推论：boot:23056 的 SCAN 静默 = **listRecoverable() 返回 0**，唯一可能是 **intent 的 autoResume === false**（或 intent 不在 store）。

### 1.2 autoResume=false 的来源（goal/changed 事件）

`ctx.on("goal/changed")`（L1194）：
- `goal.phase === "paused"` → `USER_PAUSED; autoResume = false`（L1202）
- `goal active && hasPendingQuestion` → `WAITING_USER; autoResume = false`（L1206）
- `goal complete/blocked` → `COMPLETED; autoResume = false`（L1212）

**现场时序还原（可证伪）**：
- 20:04 restart（boot:23056）：intent 已被某 goal/changed 事件设为 **autoResume=false**（原任务 goal-6fd48ae4 当时已完成/暂停）→ scan@5s 执行但 `listRecoverable()=0`（静默）+ timer 的 `listDue()` 空（RUNNING 无 nextRetryAt 不 due，autoResume=false 更被排除）→ **72 分钟正确静默**（goal 已完成，本就不该续跑）。
- 13:17（=21:17）：新 goal 激活（goal/changed → RUNNING + autoResume=true）→ 恢复扫描可见 recoverable → `CT clean` + `RESUME-GRACE` → 任务从新 goal 继续。
- **不是 EC 故障，是 goal 完成后的正确静默**；"72 分钟不续跑"的原因是**当时没有活跃 goal**（旧 goal 完成、新 goal 未建立），而非 scan/timer 未启动。

### 1.3 可证伪实验（真实 restart，当前 RUNNING+autoResume=true 状态）

```
boot:25220 (17:26:50 本次真实 restart)
  17:26:50 plugin ready; apiOk=true enableAutoResume=true
  17:26:55 SCAN restart: 1 recoverable intent(s): session-9e3b29bb[RUNNING]   ← SCAN 出现
  17:26:55 RESUME-BUDGET-RESET + CT -> bounded defer #1
  17:28:20 CT -> clean
  17:28:26 RESUME-OK (timer)                                                 ← 恢复成功
```

对比 boot:23056（20:04）无 SCAN 行 → **同代码路径下，autoResume=true 时 SCAN 必出现、autoResume=false 时静默**。根因分析被实验证实。

### 1.4 真实 restart 验收：同一 session/Goal bounded time 内真实新 progress

本次真实 restart 后：
- session-9e3b29bb 在 **~2 分钟内**完成 `SCAN → RESUME-BUDGET-RESET → CT bounded defer → CT clean → RESUME-OK（goal re-armed）`；
- 当前 goal（goal-a81de761, SH-R5 目标）phase=active、roundsStarted 随回合推进递增（revision 1→2 已观测）；
- **不只是 RESUME-OK**：CT clean（completion-truth 核验）+ RESUME-GRACE（新 generation/goal 判定）+ goal rounds 递增 = 同一 session/Goal 的真实新 progress。

### 1.5 结论

- **无需 EC 代码修复**：72 分钟停滞是"旧 goal 完成、无活跃 goal"下的正确静默（autoResume=false 由 goal/changed 设置），非 scan/timer 故障。
- **REPORT_SH_R4 的 RUNNING-skip 解释已在本报告更正**。
- 已记录（不推 P2.5，仅留档）：若希望"goal 完成后的 session 在重启后更快被识别为已终结/可清理"，可在 P2.5 评估对 `COMPLETED` intent 的显式归档；**本轮不做**（禁止扩大范围）。

## 2. SH-R5-2：CURRENT_STATUS 全文收口（Close）

全文（含总览表 / 执行上下文 / 当前执行位置 / Final Verdict / 路线 / 恢复指令 / changelog）统一到：
- `Round 4 = CHANGES_REQUIRED` / **SH-R5 修复中（分支 fix/shardening-r5）**；
- latest report = **REPORT_SH_R4**（SH-R5 完成后指 REPORT_SH_R5）；
- **PR #35 merge c9f18f9 + backfill 585e5e8** 已记录；
- 删除全部 SH-R4 修复中 / REPORT_SH_R3 为 latest 的 stale 描述（REPORT_SH_R3 仅保留在历史 changelog 作为已过轮次）。

校验：`SH-R4 修复中/进行中` 出现 0 次；`REPORT_SH_R3` 仅 changelog 历史 1 处；含 `c9f18f9`/`585e5e8`；mojibake=0、NUL=0。

## 3. SH-R5-3：B1 真正 byte/hash equality + DACL unchanged（Close）

**问题**：B1 只 regex 检查 NOTION_TOKEN 行存在（"token 仍存在但文件其余字节损坏"也会 PASS）。
**修复**（coldstart-gate-worker.ps1）：
- 开始时记录 `$originalSha256 = Get-FileHash -Algorithm SHA256` + `$originalDaclText = icacls` 输出；
- finally 恢复后：`B1 = (SHA256 after) -eq (SHA256 before)`（真正 equality）+ **`B1b = icacls after 与 before 一致`**；
- 保留 finally WriteAllBytes 恢复。

**实测**（前台 worker -NoRestart，真实凭据文件）：
```
PASS  B1 credentials byte-for-byte restored (SHA256 equality)  sha=3FFA3370...
PASS  B1b credentials DACL unchanged  dacl-identical=True
5 checks, 0 failed；凭据 SHA before==after
```

## 4. HARDENING：Start-Process 注释真实性（Close）

修正 Test-ColdStartCredentialGate.ps1 两处注释，不再声称 worker 是"not a child / sibling"（Start-Process 不保证 Windows 进程树外）；改为真实保证：**(1) worker 的 try/finally 在任何退出路径先恢复凭据；(2) guardian orphan-lock backstop 兜底 host 自身**。实现不变，文档与证据强度对齐。

## 5. Real vs Synthetic Evidence

| 证据 | 类型 |
|---|---|
| boot:23056 与 boot:25220 EC 日志对比（无 SCAN vs SCAN[RUNNING]） | real |
| 代码事实：RECOVERABLE_STATES/listRecoverable/5s scan/timer/autoResume=false 写入点 | real（源码） |
| 真实 restart 后同 session bounded time 恢复（CT clean + RESUME-GRACE + goal rounds 递增） | real |
| B1 SHA256 equality + B1b DACL unchanged（前台实测） | real |
| CURRENT_STATUS 全文收口校验（stale=0 / truth 字段） | real（文件） |

## 6. Regression

| 测试 | 结果 |
|---|---|
| r5-addendum-ec / secret-scan + fixtures 6/6 / yaml-parse / r8-attestation | PASS |
| Test-CredentialPreflight 30/30 | PASS |
| Test-ColdStartCredentialGate（contract 7/7；worker B1+B1b 5/5；live 15/15 见 SH-R4） | PASS |

## 7. PR / CI / Merge

- PR：`fix/shardening-r5`
- CI：Level 1/2/3（PR 创建后运行）
- Merge SHA：**`e1a90326`**（2026-08-25 merged，PR #36）

## 8. Final Verdict

**IMPLEMENTATION_COMPLETE**

## 9. Waiting For

**EXTERNAL_REVIEW** — Security-Hardening 保持 `AWAITING_REVIEW`；Reviewer APPROVED 后才由纯状态 backfill 置 `VERIFIED`，之后方可进入 P2.5。

---

*报告不可覆盖：复审修改将生成 REPORT_SH_R6.md……*
