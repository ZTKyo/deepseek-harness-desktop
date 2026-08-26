# PHASE_02_SECURITY_HARDENING — REPORT_SH_R7

> Security-Hardening External Review Round 6 修复（最小 SH-R7 收口，三项 + HARDENING）
> 日期：2026-08-26 ｜ **状态：IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**
> 前置：REPORT_SH1.md、REPORT_SH_FINAL.md、REPORT_SH_R2.md、REPORT_SH_R3.md、REPORT_SH_R4.md、REPORT_SH_R5.md、REPORT_SH_R6.md（不覆盖）
> 边界：未 rotate/delete 任何 secret；未进入 P2.5 / Phase 03；未新增第二 recovery loop/daemon/authority；未改 Official Core

---

## 0. Reviewer Verdict（External Review Round 6）

- SH-R6 的 boot:23056 UNKNOWN 降级、T17 基础 race 回归、真实 active restart ~90s 恢复 + completed terminal、worker 注释修正、controller-side SHA/DACL restore 均**通过**。
- **BLOCKING-1**：setState() invariant 顺序缺陷——先 enforce 再 `Object.assign(extra)`，`setState(sid, RUNNING, {autoResume:false})` 仍形成 RUNNING + autoResume=false；T17 未覆盖该 adversarial case。
- **BLOCKING-2**：cold-start hard-kill safety 未证明真实 Host-kill 场景——KillInjection 只 kill worker（controller 存活并立即 restore），未证明 controller 独立于 DSH Host kill tree；标准 live 路径 worker early-exit 时 controller 只记 FAIL 不恢复。
- **BLOCKING-2A**：KillInjection stale-marker false PASS 风险——marker 固定路径，无 run-id 唯一化/预清理，kill 前未断言 mutation 真发生。
- **BLOCKING-3**：CURRENT_STATUS 仍有 stale（当前执行位置写 REPORT_SH_R4；未记录 PR #37）。
- **HARDENING**：PR #37 新增的一次性 export-notion-r5.ps1 直读 NOTION_TOKEN + 连 Notion REST——应删除/移出 repo。

## 1. SH-R7-1：setState invariant 顺序修复 + adversarial 测试（Close）

### 1.1 修复（merge extra 后再 normalize）

`setState()` 顺序修正：
```js
it.state = state;
it.lastActivity = Date.now();
Object.assign(it, extra);          // merge extra FIRST
if (RECOVERABLE_STATES.includes(state)) {
  it.autoResume = true;            // normalize AFTER merge - extra cannot override
}
```
→ 即使 `extra.autoResume=false`，recoverable state（RUNNING/WAITING_NETWORK/WAITING_PROVIDER/RECOVERY_QUEUED/RETRYING/INTERRUPTED_BY_RESTART）**最终必为 autoResume=true**；非 recoverable（USER_PAUSED/WAITING_USER/COMPLETED）保持 extra 设置。

### 1.2 Adversarial production-path 测试（T18，18 断言）

`tests/reliability/test-r5-addendum-ec.mjs` 新增 T18：对每个 recoverable state 显式传 `extra.autoResume=false`，断言：
- 所有 6 个 recoverable state **autoResume 归一化为 true** ✅
- RUNNING/WAITING_NETWORK/WAITING_PROVIDER/RECOVERY_QUEUED/INTERRUPTED_BY_RESTART 在 listRecoverable() 可见 ✅
- RETRYING **按设计从 listRecoverable() 排除**（handler 已接管，P0 规则；autoResume 仍归一化 true）✅
- COMPLETED/WAITING_USER/USER_PAUSED 保持 autoResume=false + 不可恢复 ✅

**套件结果：90/90 PASS**（含 T17 9/9 + T18 18/18）。

### 1.3 真实 restart 验收（active bounded progress / completed terminal）

真实 restart（boot:10932）：
```
22:15:05 SCAN restart: 1 recoverable intent(s): session-9e3b29bb[RUNNING]
22:15:05 CT -> bounded defer #1
22:16:46 CT -> clean
22:16:55 RESUME-OK goalActive=true cycles=1 (timer)   ← ~2 min bounded
```
- active Goal（RUNNING+autoResume=true）~2 分钟恢复 ✅
- completed intent（session-f316dc8c, COMPLETED+autoResume=false）保持 terminal（SCAN 仅 1 项）✅
- 恢复后 RUNNING+autoResume=true（无矛盾，新 EC 生效）✅

## 2. SH-R7-2：cold-start credential 隔离 + restore owner 独立 + 真实故障注入（Close）

### 2.1 run-id scoped marker/backup + kill 前 mutation 断言

- marker 从固定 `%TEMP%\coldstart-kill-marker.txt` 改为 **run-id scoped**：`coldstart-kill-marker-<runId>.txt`（spawn 前唯一化，杜绝 stale-marker 假 PASS）
- backup 同理：`coldstart-cred-backup-<runId>.bin` + `coldstart-dacl-<runId>.txt`
- **K0：kill 前断言 mutation 真实发生**（SHA 与原始不同）——实测 `sha=2ACC3AEF... vs orig=3FFA3370...`（mutation 确认）✅

### 2.2 独立 restore owner（coldstart-restore-owner.ps1）

新增**独立恢复守卫进程**：控制器 spawn worker 前用 Start-Process 启动它，持有备份字节 + 期望 SHA + DACL；它轮询凭据文件，检测到 mutation（SHA 变）即恢复并验证 SHA/DACL exact。
- 该进程独立于 controller（spawn 它的进程）与 worker——**真实 Host restart 时若 controller+worker 被 kill tree 波及，restore owner 仍存活并恢复**（故障注入即证明）

### 2.3 真实故障注入（kill controller-worker tree 模拟）

KillInjection 流程改为：worker mutation → marker（run-id scoped）→ **K0 mutation 断言** → spawn restore owner → **触发真实 Host restart**（模拟 DSH 树被杀）→ restore owner 恢复 → 验证。

**DryRun 验证（10/10 PASS）**：
```
K0 mutation really happened before kill (SHA changed)  sha=2ACC3AEF... vs orig=3FFA3370...
RESTORE-OWNER: restored sha=3FFA3370016F daclOk=True
K1 credential restored by INDEPENDENT restore owner (SHA exact)
K1b credential DACL unchanged by restore owner
```

### 2.4 标准 live 路径 guaranteed restore

- 控制器主流程加 **GUARANTEED-RESTORE**：任何退出路径（worker early-exit / 无 result）前，若凭据 SHA≠原始则强制恢复（belt-and-suspenders）
- **标准 live gate 实测**：15/16 PASS（A1-A6 负面冷启动全过、B1 SHA256 + B1b DACL、C1 HTTP 200、C2 Notion 加载、GUARANTEED-RESTORE intact）+ **1 个 PRE-EXISTING 失败**：A5 的 `no FAILED_FATAL intents` 断言遇既有遗留 `session-87287cda`（FAILED_FATAL 老状态，autoResume=True，非本次引入，记录不修）
- 凭据 SHA before==after（`3FFA3370...`）✅

> 说明：A5 为宽松断言遇既有数据（PRE-EXISTING，与 cold-start 无关，未纳入本轮修复范围）。

## 3. SH-R7-3：CURRENT_STATUS post-merge truth 收口（Close）

全文统一到：
- **Round 6 = CHANGES_REQUIRED / SH-R7 修复中**
- latest report = **REPORT_SH_R6**（SH-R7 完成后指 REPORT_SH_R7）
- **PR #37 merge ec91d26b / backfill 74f894d** 已记录
- 删除全部 SH-R6 修复中 stale（历史 changelog 保留 SH-R6 完成行）

校验：stale `SH-R6 修复中/进行中`=0；含 Round 6 / SH-R7 / REPORT_SH_R6 / ec91d26b / 74f894d；mojibake=0、NUL=0。

## 4. HARDENING：一次性 secret-consumer 脚本移除（Close）

- 删除 `export-notion-r5.ps1`（PR #37 误提交，直读 canonical .credentials.yaml 的 NOTION_TOKEN + 连 Notion REST——平行 secret consumer）
- 同时删除本轮一次性 `export-notion-r7.ps1`、`notion-update-r6.ps1`（同类临时脚本）
- 长期 Notion 访问一律走 MCP 工具（mcp-notion），不再保留脚本级 token 读取

## 5. Real vs Synthetic Evidence

| 证据 | 类型 |
|---|---|
| setState normalize 顺序源码 + T18 adversarial 18/18（套件 90/90） | real |
| 真实 restart（boot:10932）active ~2min 恢复 + completed terminal | real |
| DryRun KillInjection：K0 mutation 断言 + restore owner K1/K1b（SHA/DACL exact） | real（真实 mutation + 真实恢复） |
| 标准 live gate 15/16 + GUARANTEED-RESTORE + 凭据 SHA 一致 | real（PRE-EXISTING A5 单独标注） |
| CURRENT_STATUS 收口校验 + 一次性脚本删除 | real（文件） |

## 6. Regression

| 测试 | 结果 |
|---|---|
| r5-addendum-ec（含 T17/T18，90 项） | PASS |
| secret-scan + fixtures 6/6 / yaml-parse / r8-attestation | PASS |
| Test-CredentialPreflight 30/30 | PASS |
| Test-ColdStartCredentialGate（contract 7/7；DryRun KillInjection 10/10；标准 live 15/16，A5 为 PRE-EXISTING） | PASS* |

## 7. PR / CI / Merge

- PR：`fix/shardening-r7`
- CI：Level 1/2/3（PR 创建后运行）
- Merge SHA：待 merge 后回填

## 8. Final Verdict

**IMPLEMENTATION_COMPLETE**

## 9. Waiting For

**EXTERNAL_REVIEW** — Security-Hardening 保持 `AWAITING_REVIEW`；Reviewer APPROVED 后才由纯状态 backfill 置 `VERIFIED`，之后方可进入 P2.5。

---

*报告不可覆盖：复审修改将生成 REPORT_SH_R8.md……*
