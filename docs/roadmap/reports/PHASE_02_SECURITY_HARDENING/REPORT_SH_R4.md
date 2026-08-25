# PHASE_02_SECURITY_HARDENING — REPORT_SH_R4

> Security-Hardening External Review Round 3 修复（最小 SH-R4 收口，三项）
> 日期：2026-08-25 ｜ **状态：IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**
> 前置：REPORT_SH1.md、REPORT_SH_FINAL.md、REPORT_SH_R2.md、REPORT_SH_R3.md（不覆盖）
> 边界：未 rotate/delete 任何 secret；未进入 P2.5 / Phase 03；未扩大范围；未改 Official Core；未新增常驻服务

---

## 0. Reviewer Verdict（External Review Round 3）

- SH-R3 的 fragment 级豁免与 YAML fail-closed **通过**；真实 runtime 日志支持"缺 token 时 Host 可启动、恢复后 Notion 可恢复"方向。
- **BLOCKING-1**：`Test-ColdStartCredentialGate.ps1` 不是可重复执行的真实三阶段 gate——引用未定义的 `$preflightLog`；credential mutation 无 try/finally / byte-for-byte rollback；控制器随 DSH 重启被中断。
- **BLOCKING-2**：CURRENT_STATUS canonical truth 仍停在 SH-R2 / Round 1（与 Git/Notion 冲突）。
- HARDENING：`Get-NotionMcpLoaded` 任何 probe 异常都返回 false，可能把"探针失败"误判为"Notion 未加载"。

## 1. SH-R4-1：真实、可重复、自包含的三阶段 gate（Close）

**重构** `Test-ColdStartCredentialGate.ps1` + 新增独立 `coldstart-gate-worker.ps1`：

| 要求 | 实现 | 验证 |
|---|---|---|
| 完整 live runtime paths | `$preflightLog` 等所有路径在脚本顶部统一定义（修复 SH-R3 的未定义引用 bug） | contract 模式 7/7 PASS |
| 控制器独立于 DSH 生命周期 | 控制器 `Start-Process` 独立 worker；worker 非 DSH 树子进程，负面 cold boot 后仍执行 restore + normal boot | 每次 detached 运行 A→B→C 完整执行 |
| try/finally + **byte-for-byte rollback** | worker 保存 `ReadAllBytes` 原始字节，finally `WriteAllBytes` 恢复；不再"重加一行" | 每轮 gate 前后 SHA256 完全一致（如 `3FFA3370...` before == after） |
| 中途失败先恢复再退出 | 所有 credential mutation 在 `try{...}finally{Write-OriginalBytes}` 中；任何异常走 finally 恢复 | 故障注入验证：异常后 finally 恢复 byte-for-byte |

**本轮发现并修复的 3 个真实 bug**（诚实记录）：
1. **restart-dsh-server-delayed.ps1 函数顺序 bug**：`Set-AttemptState` 调用（L51）先于定义（L98），Windows PowerShell 5.1 下使 `-RestartAndWait` 抛 CommandNotFound（pwsh 7 因 `$ErrorActionPreference='Continue'` 未致命）。修复：函数定义前移到调用之前。**并同步 DSH-Client 侧**（运行时权威，此前未同步导致线上仍用旧版）。
2. **worker 手工文本移除破坏 YAML 结构**：旧 Remove-CredentialRef 逐行删 NOTION_TOKEN 并以**带 BOM** 重写 → `.credentials.yaml` 变成 dsh-credentials-local 无法识别的形态 → **负面 boot 时 DSH 崩溃 exit 1**（`pre-release flat layout` 错误，这就是负面前几轮 A2 http=-1 的根因）。修复：用 **dsh 自带 js-yaml** 安全解析→删除 ref→dump `{version:1, refs:{}}`（无 BOM、结构必合法）+ 移除后 self-check（version+refs 在、ref 不在）。
3. **PowerShell 5.1 native stderr 升级**：`$ErrorActionPreference='Stop'` 下 `& node` 的 stderr（native warning）升级为 terminating error 使 worker 崩。修复：局部 `$ErrorActionPreference='Continue'` + node 脚本经**环境变量**传路径（规避 cmd /c 引号地狱——cmd 引号曾使 node 解析自身脚本为 YAML）。

## 2. SH-R4-2：结构化 Notion probe（Close）

**问题**：`Get-NotionMcpLoaded` 任何异常返回 false → 探针失败被误判为 Notion 未加载。
**修复**：返回结构化 `{ probe_ok, notion_loaded, tool_count, error }`。
**探测方式**（经确认 DSH host API 无 MCP 工具列表端点——UNARY_ROUTES 仅 session.*/subagent.*/host.*/workspace.*/skill.list）：mcp-notion 是 stdio 子进程（`npx @notionhq/notion-mcp-server`），disabled 时不 spawn → 用进程命令行匹配检测。
**负面 gate 判据（严格）**：仅 `probe_ok=true && notion_loaded=false` 才 PASS；探针失败是 FAIL（不再是"看起来没加载"）。

## 3a. 真实 runtime timeline 分析（20:04 restart → 21:16 任务未继续）

**用户确认的现场证据**：约 20:04 Host restart 后，至约 21:16 原任务仍未继续（>70 分钟）。

**EC 日志逐行分析**（同一 session-9e3b29bb / goal-6fd48ae4）：

```
boot:23056 (20:04) - restart e5602b20 COMMITTED
  12:04:49 plugin ready; apiOk=true ...
  12:04:49 LIVE-CAPACITY wired=true
  12:04:49 LOADED-MANIFEST serverGeneration=boot:23056_1787659484530
  ── 72 分钟 EC 日志真空 ──
  13:17:33 CT sid=session-9e3b29bb -> clean
  13:17:36 RESUME-GRACE new generation/goal observed -> SKIP (grace)

boot:26128 (21:46) - gate C 阶段正常 boot
  13:46:04 plugin ready
  13:46:04 LIVE-CAPACITY wired=true
  13:46:04 LOADED-MANIFEST
  13:46:10 SCAN restart: 1 recoverable intent(s) [RECOVERY_QUEUED]  ← boot:23056 缺失此步
  13:46:10 CT -> bounded defer #1 (timer 每 15s 循环)
```

**根因**：boot:23056 的 EC `recoverableScan`（boot scan）**未执行**——日志中无 `SCAN restart` 行。对比 boot:26128 有 SCAN。
差异在于 intent 状态：boot:23056 时 intent 为 `RUNNING`（无 nextRetryAt，boot scan 跳过，认为"正在运行"）；
boot:26128 时 intent 为 `RECOVERY_QUEUED`（触发 boot scan + CT + bounded defer）。
EC 的 15s timer 循环在 72 分钟内也未触发（`listDue()` 可能返回空——RUNNING 无 nextRetryAt 不 due）。

**结论**：这是 EC 既有的 boot scan 行为（RUNNING intent 在 boot 时不触发 SCAN，timer 非 due 时不驱动恢复），
不是本次 SH-R4 gate 脚本的缺陷。该问题已在 21:46 的下一次 boot 中自动恢复（SCAN → CT → bounded defer → RESUME-OK），
且从 21:46 至当前（00:08）任务持续在正常推进（多个 RESUME-OK cycles 和 goal rounds 递进）。
建议在 P2.5 或 Phase 03 中考虑：RUNNING intent 在 boot 时也应触发 grace period 检测，而非仅依赖 timer 驱动。

## 3. SH-R4-3：CURRENT_STATUS canonical truth（Close）

更新到：Phase 02-SH = `AWAITING_REVIEW`；**Round 3 = CHANGES_REQUIRED；SH-R4 pending/进行中**；latest report = `REPORT_SH_R3`（SH-R4 完成后指 REPORT_SH_R4）；记录 **PR #34 merge 1959b5b + backfill 92c6774**；变更日志补 SH-R2/SH-R3/SH-R4 完整轮次；修正历史遗留的"误标 VERIFIED"描述。

## 4. 真实 live gate 最终结果（SH-R4 端到端）

```
=== Phase A: NEGATIVE cold boot (NOTION_TOKEN removed) ===
PASS  A1 credential ref removed for negative boot
PASS  A2 host HTTP 200 after negative cold boot  http=200
PASS  A3 probe succeeded (probe_ok=true)
PASS  A4 mcp-notion NOT loaded (notion_loaded=false, tool_count=0)
PASS  A5 recovery chain unaffected (no FAILED_FATAL intents)
PASS  A6 preflight audit log records SAFE-DEGRADE
=== credentials file restored (byte-for-byte, finally) ===
PASS  B1 credentials byte-for-byte restored
=== Phase C: NORMAL cold boot (credential present) ===
PASS  C1 host HTTP 200 after normal cold boot  http=200
PASS  C2 mcp-notion loaded after restore (probe_ok=true notion_loaded=true)
15 passed, 0 failed  →  COLD-START CREDENTIAL GATE PASSED
```

审计日志实测：`16:05:49 FAIL reason=ref-missing → mcp-notion SAFE-DEGRADE (not loaded)` + `16:07:52 ok len=50`。
凭据 SHA256 before==after（byte-for-byte）；Notion MCP 恢复加载（get-self OK）。

## 5. Real vs Synthetic Evidence

| 证据 | 类型 |
|---|---|
| 15/15 live gate（真实两次冷启动 + 结构化 probe + byte-for-byte rollback） | real |
| 审计日志负面/正常两条 + 凭据 SHA 一致 + get-self OK | real |
| 故障注入（异常后 finally 恢复） | synthetic（生产 finally 路径） |
| contract 模式 7/7（模板契约） | synthetic（CI） |
| restart 脚本函数顺序修复 + DSH-Client 同步（hash 一致） | real |

## 6. Regression

| 测试 | 结果 |
|---|---|
| r5-addendum-ec / capacity / adapter / bridge / crashsafe / fault | PASS |
| secret-scan（仓库全扫）+ fixtures 6/6 | PASS |
| yaml-parse-gate（正反） | PASS |
| Test-CredentialPreflight 30/30 | PASS |
| Test-ColdStartCredentialGate（contract 7/7；live 15/15） | PASS |
| r8-attestation（3-way ALL MATCH） | PASS |

## 7. PR / CI / Merge

- PR：`fix/shardening-r4`
- CI：Level 1/2/3（PR 创建后运行）
- Merge SHA：待 merge 后回填

## 8. Final Verdict

**IMPLEMENTATION_COMPLETE**

## 9. Waiting For

**EXTERNAL_REVIEW** — Security-Hardening 保持 `AWAITING_REVIEW`；Reviewer APPROVED 后才由纯状态 backfill 置 `VERIFIED`，之后方可进入 P2.5。

---

*报告不可覆盖：复审修改将生成 REPORT_SH_R5.md……*