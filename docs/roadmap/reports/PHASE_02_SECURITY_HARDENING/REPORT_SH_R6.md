# PHASE_02_SECURITY_HARDENING — REPORT_SH_R6

> Security-Hardening External Review Round 5 修复（最小 SH-R6 收口，三项）
> 日期：2026-08-26 ｜ **状态：IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**
> 前置：REPORT_SH1.md、REPORT_SH_FINAL.md、REPORT_SH_R2.md、REPORT_SH_R3.md、REPORT_SH_R4.md、REPORT_SH_R5.md（不覆盖）
> 边界：未 rotate/delete 任何 secret；未进入 P2.5 / Phase 03；未新增第二 recovery loop/daemon/authority；未改 Official Core

---

## 0. Reviewer Verdict（External Review Round 5）

- SH-R5 的 B1 SHA256 equality + DACL unchanged **通过**。
- **BLOCKING-1**：72 分钟停滞仍无历史证据证明；暴露出 EC 状态不变量缺口——`goal/changed` complete 写 `state=COMPLETED + autoResume=false`，而 `setState()` 只改 state + Object.assign(extra)，liveness/resume 成功路径重写 `state=RUNNING` **不恢复 autoResume=true** → **RUNNING + autoResume=false 矛盾组合可形成**，同时被 listRecoverable()/listDue() 过滤 → boot scan + timer 静默。
- **BLOCKING-2**：CURRENT_STATUS 在 PR #36 merge + backfill 后仍停 Round4/SH-R5 修复中。
- **BLOCKING-3**：cold-start gate 依赖"可能被 hard-kill 的 worker finally"保护真实 .credentials.yaml；worker 头注释仍声称 "NOT a child ... always runs restore"。

## 1. SH-R6-1：EC 状态不变量 + race 回归 + 真实 restart 验收（Close）

### 1.1 不变量修复（最小，现有 EC 内）

`setState()` 增加不变量 enforce（plugins/execution-continuity.mjs）：
```js
if (RECOVERABLE_STATES.includes(state)) {
  it.autoResume = true;   // recoverable state must NEVER coexist with autoResume=false
}
```
- RECOVERABLE_STATES = RUNNING, RETRYING, WAITING_NETWORK, WAITING_PROVIDER, RECOVERY_QUEUED, INTERRUPTED_BY_RESTART（6 项）
- 所有走 setState 的 recoverable 写入路径自动恢复 autoResume=true
- 直接赋值路径核查：goal/changed 的 USER_PAUSED/WAITING_USER（非 recoverable，autoResume=false 正确）、RUNNING 分支已显式 autoResume=true → 无矛盾入口
- **不新增第二 recovery loop/authority**——只在现有 setState 内 enforce

### 1.2 生产路径 race 回归（T17，9 断言）

`tests/reliability/test-r5-addendum-ec.mjs` 新增 T17：
- T17a complete → COMPLETED+autoResume=false（非 recoverable，允许）✅
- T17b **RUNNING 重写后 autoResume 恢复 TRUE（不变量）** ✅
- T17c RUNNING+autoResume=true 在 listRecoverable() ✅
- T17d WAITING_USER → autoResume=false（允许）✅
- T17e **RUNNING 重写后 autoResume TRUE** ✅
- T17f 恢复后再次 recoverable ✅
- T17g 直接 active-path 赋值保持 true ✅

**结果：72/72 PASS（含 T17 9/9）**。

### 1.3 真实 restart 验收（bounded time 真实 progress / terminal 保持）

真实 restart（boot:20780）EC 日志：
```
18:26:31 SCAN restart: 1 recoverable intent(s): session-9e3b29bb[RUNNING]
18:26:31 RESUME-BUDGET-RESET + CT -> bounded defer #1
18:27:51 CT -> clean
18:27:56 RESUME-OK goalActive=true cycles=1 (timer)   ← ~90s 内恢复
```
- **active Goal（session-9e3b29bb, RUNNING+autoResume=true）在 ~90s bounded time 内恢复**（SCAN→RESUME-BUDGET-RESET→CT→RESUME-OK）
- **inactive/completed Goal（session-f316dc8c, COMPLETED+autoResume=false）保持 terminal**（SCAN 仅 1 项 = 只扫描 active）
- 恢复后 intent 状态：RUNNING+autoResume=true（不变量保持，无矛盾）

### 1.4 boot:23056 历史结论降级（UNKNOWN / most-likely）

**boot:23056 原始 store snapshot / goal projection / autoResume 现场证据不可恢复**（execution-intents.json 实时覆盖，无历史备份）。因此：
- **不宣称 PROVEN**；结论降级为 **UNKNOWN / most-likely**：
  - 代码事实（PROVEN 级别）：RUNNING+autoResume=false 矛盾可形成（现已被不变量修复关闭）；boot:23056 无 SCAN 行 + timer 静默 72 分钟 = listRecoverable()/listDue() 均空 = **most-likely** intent 当时 autoResume=false（由 goal/changed 在 goal complete/paused/pending-question 时设置）
  - 具体"旧 goal 已完成"的现场断言 **UNKNOWN**（无 snapshot 证明 goal-6fd48ae4 当时 phase）
- SH-R5 的"可证伪实验证实历史状态"表述在 R6 更正为"实验证实**代码路径**行为，历史 boot:23056 的精确状态无法证实"。

## 2. SH-R6-2：cold-start negative gate 隔离 credential（Close）

### 2.1 恢复 owner 转移到控制器（独立于 kill 目标）

- **控制器（Test-ColdStartCredentialGate.ps1）成为 restore owner**：spawn worker 前捕获 `$originalCredBytes`（ReadAllBytes）+ SHA256 + icacls DACL；提供 `Restore-OriginalCredential -Assert`（写回 + 断言 R1 SHA256 / R2 DACL）
- worker 头部注释修正（不再声称 "NOT a child ... always runs restore"）→ 真实保证：控制器为 restore owner + worker finally 为 best-effort 快路径 + guardian orphan-lock 兜底 host

### 2.2 故障注入（-KillInjection）

流程：worker（-WaitForKillMarker）移除 NOTION_TOKEN → 写 marker → park；控制器检测 marker → **Stop-Process -Force 硬杀 worker（finally 绕过）** → 控制器 Restore-OriginalCredential -Assert（SHA/DACL）→ 正常 cold boot（K2/K3 验收）。

**DryRun 验证（10/10 PASS）**：
```
K1 worker force-killed (finally bypassed)  exited=True
R1 credential SHA256 restored by CONTROLLER  sha=3FFA3370...
R2 credential DACL unchanged by CONTROLLER restore  dacl-identical=True
```

**live 验收（真实 kill + 正常 cold boot）**：
- 服务 HTTP 200 ✅
- 凭据 SHA `3FFA3370...`（与恢复前一致）+ NOTION_TOKEN present ✅
- **Notion MCP loaded=True（tool_count=4）+ get-self 正常** ✅

**证明**：凭据恢复**不依赖 worker finally**——worker 被硬杀（finally 未运行），恢复由控制器完成。

## 3. SH-R6-3：CURRENT_STATUS final backfill（Close）

全文（总览表 / 执行上下文 / 当前执行位置 / Final Verdict / 路线 / changelog）统一到：
- **Round 5 = CHANGES_REQUIRED / SH-R6 已完成 / 等待复审**
- latest report = **REPORT_SH_R6**
- **PR #36 merge e1a90326 / backfill 18c6136** 已记录
- 删除全部 SH-R5 修复中 / REPORT_SH_R5 为 latest 的 stale（历史 changelog 保留 SH-R5 完成行）

校验：stale `SH-R5 修复中/进行中`=0；含 Round 5 / SH-R6 / REPORT_SH_R6 / e1a90326 / 18c6136；mojibake=0、NUL=0。

## 4. Real vs Synthetic Evidence

| 证据 | 类型 |
|---|---|
| setState 不变量源码 + T17 race 回归 72/72 | real（生产代码 + 生产路径测试） |
| 真实 restart（boot:20780）SCAN→RESUME-OK ~90s + completed 保持 terminal | real |
| boot:23056 结论降级 UNKNOWN/most-likely（无原始 snapshot） | real（诚实标注） |
| kill 注入 DryRun 10/10 + live（K1 硬杀 / R1-R2 控制器恢复 / K2-K3 正常 boot + Notion 加载） | real |
| CURRENT_STATUS 收口校验（stale=0 / truth 字段） | real（文件） |

## 5. Regression

| 测试 | 结果 |
|---|---|
| r5-addendum-ec（含 T17 72 项） | PASS |
| secret-scan + fixtures 6/6 / yaml-parse / r8-attestation | PASS |
| Test-CredentialPreflight 30/30 | PASS |
| Test-ColdStartCredentialGate（contract 7/7；DryRun KillInjection 10/10；live KillInjection 已执行） | PASS |

## 6. PR / CI / Merge

- PR：`fix/shardening-r6`
- CI：Level 1/2/3（PR 创建后运行）
- Merge SHA：待 merge 后回填

## 7. Final Verdict

**IMPLEMENTATION_COMPLETE**

## 8. Waiting For

**EXTERNAL_REVIEW** — Security-Hardening 保持 `AWAITING_REVIEW`；Reviewer APPROVED 后才由纯状态 backfill 置 `VERIFIED`，之后方可进入 P2.5。

---

*报告不可覆盖：复审修改将生成 REPORT_SH_R7.md……*
