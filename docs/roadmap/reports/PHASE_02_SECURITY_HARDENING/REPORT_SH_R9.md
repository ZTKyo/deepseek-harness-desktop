# PHASE_02_SECURITY_HARDENING — REPORT_SH_R9

> Security-Hardening External Review Round 8 修复（最小 SH-R9 收口，三项 + HARDENING）
> 日期：2026-08-26 ｜ **状态：IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**
> 前置：REPORT_SH1.md、REPORT_SH_FINAL.md、REPORT_SH_R2.md、REPORT_SH_R3.md、REPORT_SH_R4.md、REPORT_SH_R5.md、REPORT_SH_R6.md、REPORT_SH_R7.md、REPORT_SH_R8.md（不覆盖）
> 边界：未 rotate/delete 任何 secret；未进入 P2.5 / Phase 03；未新增第二 recovery/credential Authority；未改 Official Core

---

## 0. Reviewer Verdict（External Review Round 8）

- SH-R8 的 isolated credential source（canonical 不 mutation）、16/16 全 PASS、A5 baseline-aware、setState/T18 保留均**通过**。
- **BLOCKING-1**：DSH_CREDENTIALS_PATH 的 preflight source 与 value-read source 不一致——override 存在时 preflight 用隔离源，但 Ok=true 后 `Get-DshCredentialRefValue` 没传 path → 读 canonical（authority split）；当前 16/16 negative gate 只走 Ok=false，未覆盖正向分支。
- **BLOCKING-2**：A5 存在 missing-store false PASS——store 缺失时 `$chainOk=$true` 默认 PASS。
- **BLOCKING-3**：CURRENT_STATUS 未做 PR #39 post-merge final truth。
- **HARDENING**：legacy KillInjection/restore-owner 在新隔离源方案下已失去语义（K0 canonical-SHA mutation 假设不成立）。

## 1. SH-R9-1：credential source coherence（Close）

### 1.1 修复（effective path 单一解析，preflight + value read 同源）

`start-dsh-server.ps1` 改为**一次解析本次 boot 的 effective credential path**：
```powershell
$effectiveCredPath = if ($env:DSH_CREDENTIALS_PATH) { $env:DSH_CREDENTIALS_PATH } else { $null }
$ntnPre = if ($effectiveCredPath) { Invoke-DshNotionPreflight -CredentialsPath $effectiveCredPath } else { Invoke-DshNotionPreflight }
if ($ntnPre.Ok) {
    if ($effectiveCredPath) { $env:NOTION_TOKEN = Get-DshCredentialRefValue -Name 'NOTION_TOKEN' -CredentialsPath $effectiveCredPath }
    else { $env:NOTION_TOKEN = Get-DshCredentialRefValue -Name 'NOTION_TOKEN' }
    ...
}
```
→ **preflight 与 value read 永远读同一 source**（override 或 canonical），authority split 关闭。日志标注 source（override/canonical）便于审计。未新增第二 secret authority（仍是单一 preflight helper + 单一 env 注入链）。

### 1.2 Positive source-coherence contract/test（T15，6 断言）

`tests/reliability/Test-CredentialPreflight.ps1` 新增 T15：
- override 文件（valid NOTION_TOKEN，len 54）→ preflight Ok=true + value read **len 54 与 preflight 一致**（同源）✅
- **不跨源**：override len 54 ≠ canonical len 48（若 fall through 到 canonical 会读 48）✅
- 默认（无 override）→ preflight + read 都解析 canonical（len 48）✅
- starter 契约：`Invoke-DshNotionPreflight -CredentialsPath $effectiveCredPath` + `Get-DshCredentialRefValue ... -CredentialsPath $effectiveCredPath`（同源传参）+ `$effectiveCredPath` 一次解析 ✅

**套件结果：36/36 PASS**（原 30 + T15 6）。

## 2. SH-R9-2：A5 fail-closed 结构化 store probe（Close）

**修复**：A5 改为结构化 fail-closed：
```
$storeProbeOk = $false; $newFatalCount = -1
if (Test-Path $IntentsFile) {
    try { ...parse...; $storeProbeOk = $true; $newFatalCount = $newFatal.Count }
    catch { $storeProbeOk = $false; $newFatalCount = -1 }
}
$a5Pass = ($storeProbeOk -eq $true -and $newFatalCount -eq 0)
```
→ **只有 store 可读且本轮新增 FAILED_FATAL=0 才 PASS**；store 缺失/不可读 → FAIL（不再默认 true）。

**真实 standard live gate 结果**（16/16 全 PASS）：
```
A5 recovery chain unaffected (FAIL-CLOSED: store readable AND no NEW FAILED_FATAL)  store_probe_ok=True new_fatal_count=0
```
整体：
```
A1 isolated source / A2 negative HTTP 200 / A3 probe_ok / A4 notion not loaded /
A5 store_probe_ok=True new=0 / A6 SAFE-DEGRADE / B1 canonical UNCHANGED (sha 3FFA3370...) /
B1b DACL unchanged / C1 normal 200 / C2 notion loaded  →  16 passed, 0 failed
```
canonical SHA before==after。

## 3. SH-R9-3：CURRENT_STATUS post-merge truth 收口（Close）

全文统一到：
- **Round 8 = CHANGES_REQUIRED / SH-R9 修复中**
- latest report = **REPORT_SH_R8**（SH-R9 完成后指 REPORT_SH_R9）
- **PR #39 merge 6a0dbf72 / backfill c0510c9** 已记录
- 删除 SH-R8 修复中 stale

校验：stale `SH-R8 修复中/进行中`=0；含 Round 8 / SH-R9 / REPORT_SH_R8 / 6a0dbf72 / c0510c9；mojibake=0、NUL=0。

## 4. HARDENING：legacy KillInjection/restore-owner 归档（Close）

- SH-R8 起标准负面 boot 用**隔离凭据源**（canonical 永不 mutation）→ 无 mutation 可恢复 → kill/restore 契约失去语义（K0 的 canonical-SHA mutation 假设不成立）
- `Test-ColdStartCredentialGate.ps1` 的 `-KillInjection` 改为**归档 no-op**（输出明确弃用警告，不做任何 kill/restore——避免误用）
- `coldstart-restore-owner.ps1` **归档**到 `docs/archive/`（不再被标准路径引用）
- 未新增任何新机制

## 5. Real vs Synthetic Evidence

| 证据 | 类型 |
|---|---|
| effective path 单一解析源码（preflight + value read 同源）+ T15 6 断言（套件 36/36） | real |
| 真实 standard live gate 16/16 全 PASS（A5 store_probe_ok=True new=0 fail-closed） | real |
| canonical SHA before==after + DACL unchanged | real |
| KillInjection 归档 no-op + restore-owner 归档 docs/archive | real（文件） |
| CURRENT_STATUS 收口校验（stale=0 / truth 字段） | real（文件） |

## 6. Regression

| 测试 | 结果 |
|---|---|
| r5-addendum-ec（含 T17/T18，90 项） | PASS |
| secret-scan + fixtures 6/6 / yaml-parse / r8-attestation | PASS |
| Test-CredentialPreflight（含 T15，**36/36**） | PASS |
| Test-ColdStartCredentialGate（contract 7/7；真实 standard live **16/16 全 PASS**） | PASS |

## 7. PR / CI / Merge

- PR：`fix/shardening-r9`
- CI：Level 1/2/3（PR 创建后运行）
- Merge SHA：**`5ba4363d`**（2026-08-26 merged，PR #40）

## 8. Final Verdict

**IMPLEMENTATION_COMPLETE**

## 9. Waiting For

**EXTERNAL_REVIEW** — Security-Hardening 保持 `AWAITING_REVIEW`；Reviewer APPROVED 后才由纯状态 backfill 置 `VERIFIED`，之后方可进入 P2.5。

---

*报告不可覆盖：复审修改将生成 REPORT_SH_R10.md……*
