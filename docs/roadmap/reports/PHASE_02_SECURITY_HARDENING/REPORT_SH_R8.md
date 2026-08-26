# PHASE_02_SECURITY_HARDENING — REPORT_SH_R8

> Security-Hardening External Review Round 7 修复（最小 SH-R8 收口，三项）
> 日期：2026-08-26 ｜ **状态：IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**
> 前置：REPORT_SH1.md、REPORT_SH_FINAL.md、REPORT_SH_R2.md、REPORT_SH_R3.md、REPORT_SH_R4.md、REPORT_SH_R5.md、REPORT_SH_R6.md、REPORT_SH_R7.md（不覆盖）
> 边界：未 rotate/delete 任何 secret；未进入 P2.5 / Phase 03；未新增第二 recovery loop/daemon/authority；未改 Official Core

---

## 0. Reviewer Verdict（External Review Round 7）

- SH-R7 的 setState merge-after-normalize、T18 adversarial 90/90、真实 restart 恢复、run-id marker + K0 方向、一次性 secret-consumer 移除均**通过**。
- **BLOCKING-1**：restore-owner 跨 Host restart 独立性未被证明——owner 由 controller Start-Process 启动（不证明脱离 job/process tree）；当前在 mutation 后才启动 owner（可能 restart boundary 前就恢复）；仍由原 controller 做 post-kill 验收。REPORT_SH_R7 的结论强于证据。
- **BLOCKING-2**：标准 live gate 15/16（PASS* 不算全绿）——A5 扫描整个 store，历史 FAILED_FATAL 污染本轮。
- **BLOCKING-3**：CURRENT_STATUS 未做 PR #38 post-merge final backfill。

## 1. SH-R8-1：isolated credential source（彻底消除 restore-owner 依赖）（Close）

### 1.1 优先方案：隔离凭据源（不修改 canonical）

**实现**：
1. `start-dsh-server.ps1` 的 preflight 支持 `DSH_CREDENTIALS_PATH` 环境变量（若设置则 preflight 读该文件，否则读 canonical `~/.dsh/.credentials.yaml`）——最小生产改动，缺省行为不变。
2. gate worker 的负面 boot：用 js-yaml 创建**隔离副本**（canonical 复制 + 移除 NOTION_TOKEN，`version: 1` + `refs:` 结构合法），设 `DSH_CREDENTIALS_PATH` 指向它 → 触发 restart → preflight 读隔离副本 → FAIL → SAFE-DEGRADE。**canonical 全程不被碰**。
3. 正常 boot（C 阶段）：清 `DSH_CREDENTIALS_PATH` → restart → preflight 读 canonical → ok → Notion 加载。

**效果**：canonical `.credentials.yaml` 无 mutation → **restore-owner / guaranteed-restore 不再需要**（旧 restore-owner.ps1 保留但不再被标准路径依赖；隔离方案下 canonical SHA/DACL 恒 UNCHANGED，B1 断言直接证明）。

### 1.2 验收证据（真实 standard live gate，16/16 全 PASS）

```
PASS  A1 isolated credential source created (canonical untouched)
PASS  A2 host HTTP 200 after negative cold boot  http=200
PASS  A3 probe succeeded (probe_ok=true)
PASS  A4 mcp-notion NOT loaded (notion_loaded=false, tool_count=0)
PASS  A5 recovery chain unaffected (no NEW FAILED_FATAL vs baseline)  new=0
PASS  A6 preflight audit log records SAFE-DEGRADE
PASS  B1 canonical credential byte-for-byte UNCHANGED (SHA256 equality)  sha=3FFA3370...
PASS  B1b canonical credential DACL unchanged  dacl-identical=True
PASS  C1 host HTTP 200 after normal cold boot  http=200
PASS  C2 mcp-notion loaded after restore (probe_ok=true notion_loaded=true)
16 passed, 0 failed  →  COLD-START CREDENTIAL GATE PASSED
```
- canonical SHA before==after（`3FFA3370...`）
- 未新增常驻 daemon（隔离副本是测试期临时文件，finally 清理）

> 说明：由于采用隔离源优先方案，本轮的 restore-owner 独立性不再需要"跨 restart verifier"证明——canonical 根本不被 mutation，无需恢复。原 restore-owner.ps1 保留作为非标准路径的兜底工具（不再被标准 gate 依赖）。

## 2. SH-R8-2：A5 baseline-aware + 真实 standard live gate 全 PASS（Close）

**修复**：A5 改为 **baseline-aware**——worker 启动时记录 store 中已有 FAILED_FATAL 的 session 集合（`$baselineFatalSet`），gate 结束后只断言**本轮没有新增** FAILED_FATAL（`newFatal = currentFatal - baselineFatalSet`）。历史遗留 FAILED_FATAL（如 session-87287cda）不再污染本轮。

**真实 standard live gate 结果**：`A5 recovery chain unaffected (no NEW FAILED_FATAL vs baseline) new=0` ✅ + 整体 **16/16 全 PASS**（上轮 15/16 的 A5 假失败已消除）。

## 3. SH-R8-3：CURRENT_STATUS post-merge truth 收口（Close）

全文统一到：
- **Round 7 = CHANGES_REQUIRED / SH-R8 修复中**
- latest report = **REPORT_SH_R7**（SH-R8 完成后指 REPORT_SH_R8）
- **PR #38 merge 52176a77 / backfill 4b1f9dd** 已记录
- 删除 SH-R7 修复中 stale（历史 changelog 保留 SH-R7 完成行）

校验：stale `SH-R7 修复中/进行中`=0；含 Round 7 / SH-R8 / REPORT_SH_R7 / 52176a77 / 4b1f9dd；mojibake=0、NUL=0。

## 4. Real vs Synthetic Evidence

| 证据 | 类型 |
|---|---|
| start-dsh-server.ps1 DSH_CREDENTIALS_PATH 支持 + 隔离副本创建（js-yaml） | real（生产代码 + 生产路径） |
| 真实 standard live gate 16/16 全 PASS（负面 HTTP 200 + SAFE-DEGRADE + canonical UNCHANGED + 正常 Notion 加载） | real |
| canonical SHA before==after + DACL unchanged | real |
| A5 baseline-aware new=0（不再被历史 FAILED_FATAL 污染） | real |
| CURRENT_STATUS 收口校验（stale=0 / truth 字段） | real（文件） |

## 5. Regression

| 测试 | 结果 |
|---|---|
| r5-addendum-ec（含 T17/T18，90 项） | PASS |
| secret-scan + fixtures 6/6 / yaml-parse / r8-attestation | PASS |
| Test-CredentialPreflight 30/30 | PASS |
| Test-ColdStartCredentialGate（contract 7/7；标准 live **16/16 全 PASS**） | PASS |

## 6. PR / CI / Merge

- PR：`fix/shardening-r8`
- CI：Level 1/2/3（PR 创建后运行）
- Merge SHA：**`6a0dbf72`**（2026-08-26 merged，PR #39）

## 7. Final Verdict

**IMPLEMENTATION_COMPLETE**

## 8. Waiting For

**EXTERNAL_REVIEW** — Security-Hardening 保持 `AWAITING_REVIEW`；Reviewer APPROVED 后才由纯状态 backfill 置 `VERIFIED`，之后方可进入 P2.5。

---

*报告不可覆盖：复审修改将生成 REPORT_SH_R9.md……*
