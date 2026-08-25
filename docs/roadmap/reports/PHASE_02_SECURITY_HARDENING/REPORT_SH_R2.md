# PHASE_02_SECURITY_HARDENING — REPORT_SH_R2

> Security-Hardening External Review Round 1 修复（最小 SH-R2，4 项）
> 日期：2026-08-25 ｜ **状态：IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**
> 前置：REPORT_SH1.md、REPORT_SH_FINAL.md（不覆盖）
> 边界：未 rotate/delete 任何 secret；未进入 P2.5 / Phase 03；未改 Official Core；未新增常驻服务

---

## 0. 状态机 Authority 更正（首要）

Reviewer 指出：阶段完成后应为 `AWAITING_REVIEW`，`VERIFIED` **只能**由 99 Reviewer APPROVED 后回填。
上一轮 CURRENT_STATUS.md / REPORT_SH_FINAL 在外部审核前自行写了 `VERIFIED`，违反 Authority。

**本轮已更正**：Security-Hardening Gate = `AWAITING_REVIEW`，Final Verdict = `IMPLEMENTATION_COMPLETE`。

## 1. 四项修复与证据

| 项 | Reviewer 要求 | 本轮实现 | 证据 |
|---|---|---|---|
| SH-R2-1 | 状态回退为 AWAITING_REVIEW / IMPLEMENTATION_COMPLETE | CURRENT_STATUS 总览表 02-SH → `AWAITING_REVIEW`；执行上下文/当前位置/恢复指令/路线全部改写 | 见 `docs/roadmap/CURRENT_STATUS.md` |
| SH-R2-2 | 真实 icacls/DACL 证据 + 最小收紧 broad ACE | 记录三个敏感文件真实 DACL；发现继承 broad ACE **`CodexSandboxUsers:(I)(RX)`**；`/inheritance:r` + 显式 grant 收紧；ACL 前置状态已备份 | 见 §2 |
| SH-R2-3 | secret-scan 接入 CI Level1 + 正反 fixture 证明 | ci-level1.yml 新增 node 扫描步骤（旧 PowerShell 扫描保留为第一层，形成双层）+ 独立 fixture 证明脚本 | 见 §3，5/5 PASS |
| SH-R2-4 | credential preflight / safe-degrade + cold-start negative test | 新增最小专用 helper（引用解析 + 形状校验 + 结构化 reason code + 可审计日志）；starter 仅在 Ok 分支注入；mcp-notion `disabled: !!js "!process.env.NOTION_TOKEN"` 显式 safe-degrade；30 断言 negative test | 见 §4，30/30 PASS |

## 2. SH-R2-2：真实 DACL 证据与最小收紧

**收紧前（真实 icacls 输出，问题确认）**：
```
.dsh\.credentials.yaml   WIN-...\CodexSandboxUsers:(I)(RX)     <-- broad read ACE（继承）
                         NT AUTHORITY\SYSTEM:(I)(F)
                         BUILTIN\Administrators:(I)(F)
                         WIN-...\Administrator:(I)(F)
```
`settings.yaml` / `profiles\web\cordis.patch.yml` 同样带 `CodexSandboxUsers:(I)(RX)`。
→ 证实 Reviewer 判断：**owner 不等于 DACL 仅该用户**，继承 ACE 使其他组可读。

**收紧后（真实 icacls 输出）**：
```
.dsh\.credentials.yaml   BUILTIN\Administrators:(F)
                         NT AUTHORITY\SYSTEM:(F)
                         WIN-...\Administrator:(F)
```
- 操作：`icacls <file> /inheritance:r` + `/grant:r <user>:(F) SYSTEM:(F) Administrators:(F)`（三个文件）
- **CodexSandboxUsers broad ACE 已移除**（三文件均已确认不再出现）
- **回滚点**：收紧前 ACL 已导出到 `DSH-Client\_checkpoint-SH-R2-20260825-123304\acl-before.txt`
- **Harness 仍可启动/可读凭据**：收紧后服务 HTTP 200，且 Notion MCP `get-self` 正常（读取 .credentials.yaml 成功）
- 未展示任何 secret 内容

## 3. SH-R2-3：secret-scan 真正接入 CI + 正反 fixture

**接入**（`.github/workflows/ci-level1.yml`，Static gate）：
1. 原 PowerShell pattern scan（保留 = 第一层）
2. **新增**：`node tests\reliability\secret-scan-check.mjs`（仓库全扫，第二层）
3. **新增**：`node tests\reliability\test-secret-scan-fixtures.mjs`（正反 fixture 证明）
4. **新增**：`Test-CredentialPreflight.ps1`（SH-R2-4 negative tests）

**fixture 证明（本地实跑，5/5 PASS）**：
| fixture | 期望 | 实测 |
|---|---|---|
| 真实形状 `sk-...` key | FAIL exit 1 | ✅ FAIL |
| `${ENV}` 模板 | PASS exit 0 | ✅ PASS |
| `ntn_...` 字面量 | FAIL exit 1 | ✅ FAIL |
| 与 CI mock **共享前缀**但不同的 key | **仍 FAIL** | ✅ FAIL |
| CI mock 精确字面量 | 豁免 PASS | ✅ PASS |

**同时修掉一个真实缺陷**：上一轮豁免用的是**前缀匹配** `sk-abcdef`，会把任何以该前缀开头的真 key 静默放行（我的第一版 bad fixture 正因此被误豁免、没能 FAIL）。已改为**精确字面量白名单**（`CI_MOCK_LITERALS`），并由第 4 条 fixture 永久守住这一点。

## 4. SH-R2-4：credential preflight / safe-degrade + cold-start negative test

**问题（Reviewer）**：starter 直接 regex 解析凭据文件、失败只 Warning 后继续 → 可能带空 token 半初始化。

**实现**：
1. **最小专用 helper** `dsh-credential-preflight.ps1`（纯函数、可 dot-source、CI 可导入）：
   - `Get-DshCredentialRefValue`：锚定/注释感知/引号感知的单键读取
   - `Test-DshTokenShape`：非空 + 最小长度 + 前缀 + 拒绝未展开模板/占位符
   - `Invoke-DshCredentialPreflight` / `Invoke-DshNotionPreflight`：返回 **secret-free 结构化结果**（`Ok / Reason / Length / Ref / Source`）
   - reason codes：`ok | source-missing | source-unreadable | ref-missing | empty | bad-format`
   - **永不 throw**（破损源不拖死 host boot）、**永不输出值**
   - `Write-DshPreflightResultLog`：可审计决策行（verdict + reason + len，无值），best-effort 不阻塞 boot
2. **starter**（`start-dsh-server.ps1`）：`Invoke-DshNotionPreflight` → **仅 Ok 分支**注入 `$env:NOTION_TOKEN`；失败写明确 `SAFE-DEGRADE` 警告 + 审计日志行
3. **配置层显式 safe-degrade**：`mcp-notion` 增加 `disabled: !!js "!process.env.NOTION_TOKEN"`
   → token 缺失时 **mcp-notion 直接不装载**，不存在"空 token 的 MCP"

**disabled 契约实测**（loader 同款 `new Function + with(ctx) eval` 语义）：
```
A token present -> disabled = false | env len = 48   （正常装载）
B token missing -> disabled = true  | env len = 0    （不装载 = safe-degrade）
```

**cold-start negative test**（`tests/reliability/Test-CredentialPreflight.ps1`，**30 断言全 PASS**，PS 5.1）：
- source missing / ref missing / empty / 错前缀 / 过短 / 未展开 `${...}` 模板 → 全部 `Ok=false` + 正确 reason
- 合法形状 → `Ok=true`，长度正确；带引号值正确处理
- **结果对象不含 secret**、**日志行不含 secret**
- **垃圾/不可解析源 → 不 throw**（host boot 不被拖死），结果确定
- 配置契约：模板含 disabled 表达式 / 用 process.env / 无明文 / **无 require() 动态表达式**
- starter 契约：只在 Ok 分支赋值 / 有 SAFE-DEGRADE / 不打印值 / 写审计日志

## 5. 本轮模型路由验证（用户指定，附带真实收益）

本轮主模型 = `agentrouter-anthropic / claude-opus-5`（`host.describe` 实测确认）。
按要求先做 **runtime exact route 实测**（不接受 registry 提示冒充）：EC boot capacity probe 增加该 route 后重启，`loaded-release.json` 实测：
```
commandcode/deepseek/deepseek-v4-flash : ctx=1000000 src=runtime
opencode/deepseek-v4-flash             : ctx=1000000 src=runtime
openrouter/qwen/qwen3.7-flash          : ctx=1000000 src=runtime
agentrouter-anthropic/claude-opus-5    : ctx=1000000 src=runtime   <-- 本轮新增实测
```
→ **AgentRouter Opus 5 exact route contextWindow = 1,000,000（source=runtime）**，此前长期 UNKNOWN 的"是否被错误事实源压成 200K/262144"在 runtime 解析层得到否证。
（说明：backend 实际接受多大 context 仍需一次付费长请求，属独立 backlog，未在本轮声明。）
最小健康请求：本轮全部工具链在 Opus 5 上正常完成；无 quota/rate-limit/provider 失败，未触发 Router fallback。

## 6. Real vs Synthetic Evidence

| 证据 | 类型 |
|---|---|
| icacls 收紧前/后真实 DACL 输出、CodexSandboxUsers 移除 | real |
| 收紧后 HTTP 200 + Notion MCP get-self 正常（能读凭据） | real |
| agentrouter-anthropic/claude-opus-5 ctx=1000000 source=runtime | real |
| 重启后 3-way attestation ALL MATCH | real |
| 重启后 EC 自动恢复（RESUME-OK timer，无人工输入） | real |
| deployed cordis.patch.yml：无明文、无 require、disabled 表达式、YAML 可解析 | real |
| secret-scan 正反 fixture 5/5 | synthetic（受控 fixture，证明真拦截） |
| credential preflight negative 30/30 | synthetic（生产 helper + 生产 starter 契约断言） |
| disabled 表达式 A/B 语义 | synthetic（loader 同款 evaluate 语义） |

## 7. Regression

| 测试 | 结果 |
|---|---|
| r5-addendum-ec（65） | PASS |
| secret-scan-check（仓库全扫） | PASS |
| secret-scan fixtures（5） | PASS |
| Test-CredentialPreflight（30） | PASS |
| capacity-resolver / runtime-capacity-adapter | PASS |
| crashsafe（33）/ fault-injection（38） | PASS |
| r8-attestation-check（3-way） | PASS |

## 8. 未做（明确边界）

- **未 rotate / 未 delete 任何 secret**（Reviewer 与用户均未授权；NOTION_TOKEN 仍为原值，仅存储位置与校验方式加固）
- 未进入 P2.5 / Phase 03；未改 Official DSH Core；未新增常驻服务
- backend accepted-context 真实探测（付费长请求）仍为 backlog

## 9. PR / CI / Merge

- **PR #33**（`fix/shardening-r2`）→ **MERGED**，main = `70932de`
- **CI Level 1/2/3 全绿**：Static + secret + syntax gate 1m8s / Reliability state machine 1m23s / DSH boot + readiness smoke 5m38s
- Static gate 现包含：旧 PowerShell pattern scan（层1）+ node secret-scan-check（层2）+ secret-scan fixture 证明 + credential preflight negative 测试 + cordis-aware YAML gate

### 9.1 本轮 CI 修复（诚实记录：由本轮改动暴露的真实问题）

1. **YAML gate 假失败**：Level1 原用 DEFAULT js-yaml schema 校验所有 .yml，而 cordis patch 合法使用 `!!js` 标签 → 加入 `disabled: !!js ...` 后报 `unknown scalar tag`。改为 `tests/reliability/yaml-parse-check.mjs`（与 loader 一致的 schema，对 js-yaml interop 形状健壮，并带 strip-tag 兜底）。正反验证：含 `!!js` 的 5 个文件 PASS；真语法错仍 exit 1。
2. **扫描器自命中**：层1 PowerShell 扫描命中新扫描器/fixture 内的假 key 字面量。**未**用路径豁免削弱任一层，而是把假 key 改为运行时拼接（源码不含密钥形状字面量）；因此 fixture 测试文件也不再被 node 扫描器跳过，同样被扫并通过。

### 9.2 真实 preflight 审计日志（SH-R2-4 证据）

真实 boot 产生（`%LOCALAPPDATA%\DSHHarness\logs\credential-preflight.log`）：

```
2026-08-25T06:06:53.387Z NOTION-PREFLIGHT ok ref=NOTION_TOKEN reason=ok len=50 (value not logged)
```

该文件不含明文 token（已校验）。失败路径写 `... -> mcp-notion SAFE-DEGRADE (not loaded); host boot continues`（由 30 断言测试覆盖）。

## 10. Final Verdict

**IMPLEMENTATION_COMPLETE**

## 11. Waiting For

**EXTERNAL_REVIEW** — Security-Hardening 保持 `AWAITING_REVIEW`；Reviewer APPROVED 后才由纯状态 backfill 置 `VERIFIED`，之后方可进入 P2.5。

---

*报告不可覆盖：复审修改将生成 REPORT_SH_R3.md……*
