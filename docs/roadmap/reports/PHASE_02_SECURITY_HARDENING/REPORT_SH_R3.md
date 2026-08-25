# PHASE_02_SECURITY_HARDENING — REPORT_SH_R3

> Security-Hardening External Review Round 2 修复（最小 SH-R3 收口，三项）
> 日期：2026-08-25 ｜ **状态：IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**
> 前置：REPORT_SH1.md、REPORT_SH_FINAL.md、REPORT_SH_R2.md（不覆盖）
> 边界：未 rotate/delete 任何 secret；未进入 P2.5 / Phase 03；未扩大范围；未改 Official Core；未新增常驻服务

---

## 0. Reviewer Verdict（External Review Round 2）

- SH-R2 四项中：状态 Authority、真实 DACL 收紧、CI secret gate 接线 **通过**；credential preflight 方向 **通过**。
- **BLOCKING**：所谓 cold-start negative test 实际没有启动真实 Harness Host（Test-CredentialPreflight 只执行 helper + 契约断言 + synthetic disabled A/B），无法证明缺失/坏 token 下 Host 仍 HTTP 200、mcp-notion 确实不加载、其他插件正常、恢复链不受影响。
- MINOR×2：① secret-scan exact-mock 豁免按整行 continue，mock+真实 secret 同行可绕过；② yaml-parse gate 在 parser 不可用时 SKIPPED exit 0。

## 1. SH-R3-1：真实 Harness cold-start negative runtime gate（BLOCKING，Close）

**新增** `tests/reliability/Test-ColdStartCredentialGate.ps1`——三阶段真实 cold boot 编排：

| 阶段 | 操作 | 真实验证 |
|---|---|---|
| **A 负面冷启动** | 临时移除 `.credentials.yaml` 中 NOTION_TOKEN ref → `restart-dsh-server-delayed.ps1` 真实重启 | Host HTTP 200；mcp-notion 不加载（disabled 生效）；无 FAILED_FATAL intent（恢复链不受影响）；审计日志记录 FAIL/SAFE-DEGRADE |
| **B 恢复** | 恢复 NOTION_TOKEN ref（原样，不旋转） | ref 存在性校验 |
| **C 正常冷启动** | 再真实重启 | Host HTTP 200；mcp-notion 恢复加载 |

**真实执行证据（2026-08-25，live runtime）**：

审计日志 `%LOCALAPPDATA%\DSHHarness\logs\credential-preflight.log`：
```
08:13:46 NOTION-PREFLIGHT FAIL ref=NOTION_TOKEN reason=ref-missing len=0 (value not logged) -> mcp-notion SAFE-DEGRADE (not loaded); host boot continues
08:15:50 NOTION-PREFLIGHT ok ref=NOTION_TOKEN reason=ok len=50 (value not logged)
```

EC 日志（两次 cold boot 均完整恢复，恢复链不受影响）：
```
08:13:51 plugin ready; apiOk=true ... LIVE-CAPACITY wired=true ...
08:13:56 SCAN restart: 1 recoverable intent(s) ... RESUME-BUDGET-RESET ...
08:15:27 RESUME-OK ... goalActive=true cycles=1 (timer)      <- 负面 boot 后恢复
08:15:56 plugin ready; apiOk=true ... LIVE-CAPACITY wired=true ...
08:16:01 SCAN restart ... RESUME-BUDGET-RESET ...
08:17:48 RESUME-OK ... goalActive=true cycles=1 (timer)      <- 正常 boot 后恢复
```

- **负面冷启动下 Host 仍 HTTP 200**（其他插件正常启动）
- **mcp-notion 确实不加载**（disabled 表达式在真实缺失 token 时生效；正常恢复后 `notion.get-self` 返回 bot，证明重新加载）
- **恢复链不受影响**（两次 boot 均 RESUME-OK，无 FAILED_FATAL）
- 凭据恢复后 Notion MCP 重新可用（MCP get-self 实测 OK）

**CI 接入**：`ci-level1.yml` 新增步骤调用 `Test-ColdStartCredentialGate.ps1 -SkipLive`（契约模式：校验 deployed patch 的 disabled/process.env/无明文、starter preflight、审计日志存在）。**真实三阶段 cold boot 是 release/runtime gate**（在 live 机器执行，本报告记录真实输出）。

> 说明：`restart-attempts` ledger 中本次两次 attempt 显示 FAILED，原因是测试脚本进程自身是 DSH 树子进程、随服务重启被中断（restart-dsh-server-delayed.ps1 明确注释该行为），**非服务故障**——服务全程 HTTP 200、EC RESUME-OK、3-way attestation ALL MATCH、Notion MCP 恢复加载。

## 2. SH-R3-2：secret-scan exact-mock 豁免改为片段级（MINOR，Close）

**问题**：`if (CI_MOCK_LITERALS.some((lit) => line.includes(lit))) continue;` ——整行 continue，同一行若同时含 mock literal 和真实 secret 会整体绕过 node scanner。

**修复**：片段级豁免——先从行中剔除每个精确匹配的 mock literal 和 `${ENV}` 模板段，再对**剩余文本**做模式匹配；行内其他真实 secret 仍命中。仓库扫描对象不再跳过 fixture 测试文件本身（它现在也作为普通文件被扫描且通过）。

**新 fixture（第 6 项）**：`mock + real-secret 同一行` → **必须 FAIL**。
**验证**：fixture 套件 6/6 PASS（bad FAIL / 模板 PASS / notion 字面量 FAIL / 前缀共享 FAIL / 精确 mock 豁免 / **mock+real 同行 FAIL**）；仓库全扫 PASS。

## 3. SH-R3-3：yaml-parse gate fail-closed（MINOR，Close）

**问题**：`yaml-parse-check.mjs` 在 js-yaml 不可解析 / load() 不可用时 `SKIPPED` 且 `exit 0`——静默跳过等于没校验。

**修复**：两个不可用分支改为 **exit 1 + 明确 FAILED 消息**（fail-closed，绝不 SKIP）。
**验证**：
- 正常路径：5 文件 PASS（custom schema，含 `!!js`）exit 0
- 强制不可解析（NODE_PATH/APPDATA 指向不存在路径）：**exit 1** + `YAML CHECK FAILED: js-yaml not resolvable (fail-closed, no SKIP)`

## 4. Real vs Synthetic Evidence

| 证据 | 类型 |
|---|---|
| 负面冷启动审计日志 `FAIL ... SAFE-DEGRADE (not loaded)` + Host HTTP 200 | real（live runtime） |
| 正常冷启动审计日志 `ok len=50` + Notion MCP get-self OK | real（live runtime） |
| 两次 cold boot 后 EC RESUME-OK（恢复链不受影响） | real（live runtime） |
| 3-way attestation ALL MATCH | real |
| mock+real 同行 fixture FAIL / 模板 PASS / mock 豁免 | synthetic（受控 fixture） |
| yaml fail-closed 路径（强制不可解析 → exit 1） | synthetic（受控环境） |

## 5. Regression

| 测试 | 结果 |
|---|---|
| r5-addendum-ec | PASS |
| secret-scan-check（仓库全扫） | PASS |
| secret-scan fixtures（**6**） | PASS |
| Test-CredentialPreflight（30） | PASS |
| Test-ColdStartCredentialGate（契约 5；live 三阶段已执行） | PASS |
| yaml-parse-check（正常 + fail-closed） | PASS |
| capacity-resolver / runtime-capacity-adapter / crashsafe / fault-injection | PASS |
| r8-attestation-check（3-way） | PASS |

## 6. 未做（明确边界）

- **未 rotate / 未 delete 任何 secret**；未输出任何 secret 值
- 未进入 P2.5 / Phase 03；未改 Official Core；未新增常驻服务；未扩大范围

## 7. PR / CI / Merge

- PR：`fix/shardening-r3`
- CI：Level 1/2/3（PR 创建后运行）
- Merge SHA：待 merge 后回填

## 8. Final Verdict

**IMPLEMENTATION_COMPLETE**

## 9. Waiting For

**EXTERNAL_REVIEW** — Security-Hardening 保持 `AWAITING_REVIEW`；Reviewer APPROVED 后才由纯状态 backfill 置 `VERIFIED`，之后方可进入 P2.5。

---

*报告不可覆盖：复审修改将生成 REPORT_SH_R4.md……*
