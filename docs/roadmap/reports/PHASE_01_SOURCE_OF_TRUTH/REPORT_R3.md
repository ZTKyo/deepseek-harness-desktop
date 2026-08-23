# PHASE_01_SOURCE_OF_TRUTH — REPORT_R3

> Phase 01：SAVE / Source of Truth Consolidation — Reviewer Round 2 修复
> 日期：2026-08-23 ｜ 执行：Harness Master Orchestrator
> 报告路径：docs/roadmap/reports/PHASE_01_SOURCE_OF_TRUTH/REPORT_R3.md
> 前置：REPORT_R1.md、REPORT_R2.md（均不覆盖）

---

## 1. Reviewer Round 2 Verdict & 修复范围

**Reviewer Verdict：CHANGES_REQUIRED**
**根因**：R2 恢复 Boot Mode 接线时，把 R1 已存在的 `--no-open` 与两个 `--trusted-host` 丢弃了；
且 R2 的 Runtime PASS 只证明了旧进程健康，未真正验证新启动链。

**R3 修复范围**（最小收尾，不重新设计架构）：

| Finding | 状态 | 修复 |
|---|---|---|
| **BLOCKING-1**：launcher 合并丢失 R1 正确功能 | ✅ 已关闭 | 三方语义合并：boot-mode profile + --no-open + 两个 trusted-host |
| **BLOCKING-2**：R2 未真实激活新 Runtime | ✅ 已关闭（见 §8） | Guardian PID 4988→19892 重载新脚本；DSH server 经新启动链真实重启 |
| **REVIEW-3**：三方 Preservation Audit | ✅ 已关闭 | 8 文件 KEEP/DROP_INTENTIONAL/BUG 矩阵（见 §4） |

## 2. Baseline

| 项 | 值 |
|---|---|
| Base Commit（R3 起点） | `0beec549`（R2 报告 merge） |
| Result Commit（代码修复） | `265e4532`（PR #10 merge） |
| 修复分支 | `fix/phase01-review-r3`（PR #10 → main） |
| Reliability 语义基线 | `eec17de`（对照） |
| R1 代码快照 | `b0f7d235`（对照三方审计） |
| DSH 版本 | 0.1.1-rc.2 |
| Checkpoint | `DSH-Client/_checkpoint-PHASE01-R3-20260823-165521` |

## 3. BLOCKING-1 修复：dsh-launcher.js 三方语义合并

**当前 main（265e4532）启动参数**：

| Boot Mode | 实际 argv | 证据 |
|---|---|---|
| normal | `dsh web --port <p> --no-open --trusted-host 100.120.3.29:3080 --trusted-host ai-office-windows.tailab0bb5.ts.net:3080` | 源码 L75（Test-LauncherArgs 2.normal PASS） |
| safe | `dsh --profile safe web --port <p> --no-open --trusted-host ... --trusted-host ...` | 源码 L75（Test-LauncherArgs 2.safe PASS） |
| experimental | `dsh --profile experimental web --port <p> --no-open --trusted-host ... --trusted-host ...` | 源码 L75（Test-LauncherArgs 2.experimental PASS） |

**修复方式**（不模板化 trusted-host，留 Phase 02/05）：
```js
const trustedHosts = ['--trusted-host', '100.120.3.29:3080', '--trusted-host', 'ai-office-windows.tailab0bb5.ts.net:3080'];
child = spawn(nodeExe, [dshEntry, ...profileArgs, 'web', '--port', port, '--no-open', ...trustedHosts], { ... });
```

## 4. REVIEW-3 关闭：三方 Preservation Audit 矩阵

比较 R1（b0f7d235）↔ Reliability 基线（eec17de）↔ current main（265e4532），对 8 个启动/可靠性文件的功能点审计：

| 文件 | R1 独有能力 | 判定 | 证据 |
|---|---|---|---|
| **dsh-launcher.js** | `--no-open` + `--trusted-host`(x2) | **BUG（R2 丢失）→ 已修复 KEEP** | Test-LauncherArgs 33/33 PASS；CI Level2 含该步骤 PASS |
| **start-dsh-server.ps1** | 无独有函数 | KEEP（eec17de 已含全部能力） | Stage D PASS |
| **dsh-guardian.ps1** | 无独有函数 | KEEP（eec17de 已含全部能力） | Stage B PASS（C2 不 promote） |
| **dsh-safe-mode.ps1** | `Get-SafeModeStatus` | DROP_INTENTIONAL（Status 能力由 eec17de 等价实现，`-Status` switch 输出 bootMode，Stage E4 PASS） | Stage E PASS |
| **dsh-verified-lastgood.ps1** | 无独有函数 | KEEP（eec17de 已含 COMMIT_READY gate） | Stage B PASS（C3b gate=COMMIT_READY） |
| **dsh-transaction.ps1** | 无独有函数 | KEEP（eec17de 已含 Transaction 2.0） | Stage C PASS |
| **dsh-diagnostics.ps1** | 无独有函数 | KEEP（eec17de 已含 Safe-Write 脱敏） | Lab L1 F-SEC-001 PASS |
| **dsh-healthcheck.ps1** | 无独有函数 | KEEP（eec17de 已含 try/catch 保护） | 源码确认 |

**结论**：除 launcher 参数外，**无其它 BUG 或遗漏**。

## 5. BLOCKING-2 关闭：真实 Runtime 激活

### 5.1 Guardian 重启

| 项 | 旧 | 新 |
|---|---|---|
| PID | 4988 | 19892 |
| 启动时间 | 2026-08-23 01:33 | 2026-08-23 17:13 |
| 加载脚本 | 旧版 DSH-Client/dsh-guardian.ps1 | 当前 canonical 版本 |
| Config Safety | — | ✅ "not promoted; mirror untouched" |

### 5.2 DSH Server 真实重启

经 `restart-dsh-server-delayed.ps1`（安全 restart 路径：restart lock + maintenance lock +
budget gate + loopback ownership 验证 + stop + start-dsh-server）真实重启：

| 项 | 旧 | 新 |
|---|---|---|
| PID | 10428（创建 08:35:19） | **4556**（创建 17:28:31） |
| Launcher | 旧版（R1 时期，无 boot-mode） | R3 部署的 dsh-launcher.js |
| restart 日志 | — | `17:19:20 restart begin` → starter 成功 → readiness OK |
| notify sidecar | 10416 | 5320（17:28:39） |

### 5.3 Process Command Line 证据

**DSH Server（PID 4556）真实 command line**：
```
...\node-runtime\node.exe C:\Users\Administrator\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js web --port 3080 --no-open --trusted-host 100.120.3.29:3080 --trusted-host ai-office-windows.tailab0bb5.ts.net:3080
```
- ✅ `--no-open` 存在
- ✅ 两个 `--trusted-host` 存在（100.120.3.29:3080、ai-office-windows.tailab0bb5.ts.net:3080）
- ✅ `web --port 3080`（normal 模式，无错误 `--profile`）
- ✅ 无重复 token

### 5.4 Runtime 验证

| 检查 | 结果 |
|---|---|
| Test-DshReadiness -RequireWebSockets | ✅ **client_ready** |
| Test-CommitReadiness | ✅ **Gate: True | Stage: COMMIT_READY** |
| Guardian heartbeat | ✅ 日志持续（17:13→17:29），Config Safety 规则正确（not promoted） |
| Guardian PID | 4988 → 19892（17:13）→ 19480/19940（重启后重载） |
| Continuity 不变量 | ✅ crash-safe 33 PASS（重启后插件正常） |
| GUI | ✅ HTTP 200 |

### 5.5 全量回归（Step 5）

| 测试 | 结果 |
|---|---|
| Launcher Args（新增） | **33 PASS**（本地 + CI） |
| Stage B（LastGoodAuthority） | **PASS** |
| Stage C（Transaction 2.0） | **PASS** |
| Stage D（BootMode） | **PASS** |
| Stage E（SafeMode） | **PASS** |
| CommitReadiness | **PASS**（COMMIT_READY） |
| FinalDrill | **PASS** |
| Reliability Lab L1 | **9/9 PASS** |
| RestartBudget | **5/5 PASS** |
| continuity crashsafe / faultinjection / WAITING_USER / compaction / nonrecoverable / multitask | **33 / 38 / 12 / 15 / 19 / 6 PASS** |
| router exact-model / multimodal | **9 / 25 PASS** |
| model-selection-guard / commandcode | **21 / 51 PASS** |
| verify-execution-continuity / ask-telegram-cleanup | PASS |
| secret scan / gitignore assertion | CLEAN / PASS |
| Runtime（重启后） | client_ready + COMMIT_READY + HTTP 200 |

## 6. 新 Launcher 回归测试

**文件**：`tests/reliability/Test-LauncherArgs.mjs`（33 断言，3 模式）

**测试内容**：
- 1a-1e：源码结构检查（--no-open、trusted-host、boot-mode、profile 条件）
- 2.normal/safe/experimental：动态模拟 argv 验证（--no-open 位置、trusted-host 存在、profile 正确）
- 3：无重复 token（允许多个 `--trusted-host` 合法重复）

**CI 执行**：接入 ci-level2.yml（Reliability state machines），PR #10 实际执行 PASS

## 7. PR / CI 治理

| 项 | 值 |
|---|---|
| 分支 | `fix/phase01-review-r3` |
| PR | #10（https://github.com/ZTKyo/deepseek-harness-desktop/pull/10） |
| Static + secret + syntax gate | PASS（53s） |
| Reliability state machine（含 Launcher Args） | PASS（27s） |
| DSH boot + readiness smoke | PASS（6m32s） |
| Merge SHA | `265e4532`（"Merge pull request #10"） |
| R3 途中修复 | 无（PR #10 一次性通过） |

## 8. Canonical ↔ Deployment hashes

11 个启动/可靠性文件 canonical（main 265e4532）与 DSH-Client 部署**逐文件内容一致（忽略行尾符）**：

| 文件 | 一致 |
|---|---|
| dsh-launcher.js / start-dsh-server.ps1 / dsh-guardian.ps1 / dsh-safe-mode.ps1 / dsh-verified-lastgood.ps1 / dsh-transaction.ps1 / dsh-diagnostics.ps1 / dsh-healthcheck.ps1 / dsh-boot-mode.ps1 / dsh-safe-profile.ps1 / dsh-commit-readiness.ps1 | ✅ 全部 OK |

部署备份：`DSH-Client/_backup-phase01-r3-20260823-171220`

## 9. Golden 状态

| 快照 | 状态 | Tag |
|---|---|---|
| PHASE01_CANONICAL_GOLDEN（R1） | **REJECTED_CANDIDATE** | phase01-save-complete（保留历史） |
| PHASE01_CANONICAL_GOLDEN_R2（R2） | **REJECTED_CANDIDATE** | phase01-save-r2（保留历史） |
| PHASE01_CANONICAL_GOLDEN_R3（R3） | **Candidate Golden** | phase01-save-r3（待审核） |

## 10. Rollback

- Checkpoint：`DSH-Client/_checkpoint-PHASE01-R3-20260823-165521`
- 部署备份：`DSH-Client/_backup-phase01-r3-20260823-171220`
- git：`git reset --hard 0beec549`（回 R2 状态）；或 `265e4532`（当前）
- Golden：`PHASE01_CANONICAL_GOLDEN_R3`（tag `phase01-save-r3`，可回滚）

## 11. 未完成项

**NONE**（Phase 01 范围内全部完成；BACKLOG 见 §12 注）

## 12. Final Verdict

**IMPLEMENTATION_COMPLETE**

（BLOCKING-1/2 与 REVIEW-3 全部关闭；launcher 三方合并 + 真实 Runtime 激活验证完成；
Launcher Args 回归接入 CI；全量回归 PASS；PR #10 经 CI 3/3 绿后 merged；rollback 可用）

> BACKLOG（记录不执行）：trusted-host 机器特定配置模板化留 Phase 02/05（Reviewer 明确指示本轮不模板化）。

## 13. Waiting For

**EXTERNAL_REVIEW**

（等待 99｜Reviewer Feedback 中 Reviewer Verdict；未获 APPROVED 前禁止进入 Phase 02，
禁止自行标记 VERIFIED）

---

*报告不可覆盖：复审修改将生成 REPORT_R4.md……*