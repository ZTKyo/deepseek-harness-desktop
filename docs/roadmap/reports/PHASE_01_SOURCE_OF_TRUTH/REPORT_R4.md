# PHASE_01_SOURCE_OF_TRUTH — REPORT_R4

> Phase 01：SAVE / Source of Truth Consolidation — Reviewer Round 3 收尾
> 日期：2026-08-23 ｜ 执行：Harness Master Orchestrator
> 报告路径：docs/roadmap/reports/PHASE_01_SOURCE_OF_TRUTH/REPORT_R4.md
> 前置：REPORT_R1.md、REPORT_R2.md、REPORT_R3.md（均不覆盖；R4 明确纠正 R3 的归因）

---

## 0. 诚实声明（最高优先级）

R3 报告（REPORT_R3 §5.2）将新 server PID 4556 归因于 `restart-dsh-server-delayed.ps1`
自动重启成功——**该归因不正确**。用户亲自提供的生产证据表明：
- 执行 restart 后 Harness 卡住；
- server 确实被关闭（期间无法发消息、无法切模型）；
- **自动流程没有把服务恢复回来**；
- 用户手动退出/关闭后**重新双击 Desktop**，服务才恢复，原任务随后继续运行。

本报告（R4）以用户现场观察为最高优先级真实证据，还原真实时间线并纠正归因。
R3 保留作为历史报告，不修改、不覆盖。

---

## 1. User-observed Production Evidence（用户现场证据，逐条如实记录）

| # | 用户观察 | 证据/佐证 |
|---|---|---|
| 1 | 执行 restart 后 Harness 卡住 | restart 日志 17:19:20 begin → 17:19:22 validate → **无后续**（无 stop result / starter / readiness） |
| 2 | server 确实被关闭 | dsh-runtime-3080.json：`childPid 10428, exitCode 4294967295(-1), updatedAt 17:19:23` |
| 3 | 期间无法发消息、无法切模型 | 用户确认（server down，GUI 不可用） |
| 4 | 自动流程没有自行恢复 | guardian 日志 17:19-17:28 **无任何 auto-restart 尝试**（仅 CONFIG SAFETY 心跳） |
| 5 | 用户手动退出/关闭后重新双击 Desktop | 新 server PID 4556 父进程链：`PID 1656(退出) → 10152 powershell "DSH-Harness-PS.ps1"(17:28:26) → 7200 cmd.exe dsh.cmd(17:28:31) → 4556 node bin.js` |
| 6 | 服务恢复后原任务继续 | 同一 session.jsonl.zstd 持续写入（17:25→18:16+）；本任务 goal 未丢失 |

## 2. Corrected Restart Timeline（纠正后的真实时间线）

| 时间（本地） | 事件 | 证据 |
|---|---|---|
| 17:19:20 | restart-dsh-server-delayed.ps1 begin | restart-apply-patch.log |
| 17:19:22 | validate DSH loopback PID 10428 | restart-apply-patch.log |
| 17:19:23 | **server 10428 终止**（exitCode=-1） | dsh-runtime-3080.json updatedAt=09:19:23Z |
| 17:19:23 | **restart worker 随宿主死亡**（agent 工具进程树与 server 绑定） | 日志无 finally 清锁记录；restart 日志在此截断 |
| 17:19:23-17:28 | **maintenance lock 遗留**（fresh <10min）→ guardian 暂停自救 | guardian 日志无 RESTART 尝试；Test-MaintenanceLock 逻辑（<10min 不清锁） |
| 17:23:52 | guardian CONFIG SAFETY 心跳（未尝试拉起） | guardian.log |
| 17:28:26 | **用户手动打开 Desktop**（DSH-Harness-PS.ps1 PID 10152） | 进程创建时间 + 命令行 |
| 17:28:31 | **新 server PID 4556 启动**（cmd → dsh.cmd → bin.js） | 进程创建时间 + 父进程链 |
| 17:28:39 | notify sidecar 5320 启动 | 进程创建时间 |
| 17:29:00 | guardian CONFIG SAFETY（server 已恢复） | guardian.log |
| — | 原任务继续（goal 未丢，会话未新建） | session.jsonl.zstd 持续写入 |

**时间跨度说明**：17:19→17:28 间隔约 9 分钟，其中 server down 后 guardian 因 maintenance lock
暂停自救（锁 10 分钟超时前不清除），自动恢复未发生；用户约 9 分钟后手动打开 Desktop 恢复。

## 3. Automatic Restart Verdict

**AUTOMATIC_RESTART = FAILED / STALLED**（需调查——已调查，根因见 §5）

- restart 脚本 stop 了旧 server（17:19:23）后，**未能完成 start**（日志无 starter 记录）；
- 新 server 4556 经进程父链证实为**用户手动启动**（DSH-Harness-PS.ps1 链），非自动 starter 创建；
- guardian 因遗留 maintenance lock 未自动拉起。

## 4. Manual Relaunch Recovery Verdict

**MANUAL_RELAUNCH_RECOVERY = PASS**

用户手动重新打开 Desktop 后：
- server 恢复（PID 4556，17:28:31，command line 完整含 `--no-open` + 双 `--trusted-host`）；
- **原任务不是新建任务，而是恢复/继续原任务**（同一 session.jsonl.zstd、同一 goal 上下文）；
- 这是**有价值的 Session/Goal/Execution Continuity 生产证据**，必须保留。

## 5. Restart Worker / Maintenance-Lock 根因证据

### 5.1 高概率根因验证结果：ROOT_CAUSE_CONFIRMED（证据链完整）

| 环节 | 证据 |
|---|---|
| restart worker 从 agent 工具进程树启动（前台 `&` 调用，父进程树 = DSH server 10428 的子进程） | R3 执行记录：restart 由 agent 的 pwsh 工具调用 |
| restart 脚本创建 maintenance lock（L29）→ stop server → start → finally 清锁（L87-89） | restart-dsh-server-delayed.ps1 源码 |
| server 10428 被 stop（17:19:23 exitCode=-1）→ **agent 宿主进程树死亡 → restart worker 随之死亡** | dsh-runtime-3080.json；restart 日志在 validate 后截断（无 finally 记录） |
| **finally 未执行 → maintenance lock 遗留** | guardian 日志 17:19-17:28 无 auto-restart 尝试（锁生效）；锁文件当时应在（<10min） |
| guardian 对新鲜 maintenance lock 暂停自救（<10min 不清锁） | dsh-guardian.ps1 L274-284（Test-MaintenanceLock）；L485/L521（lock 时跳过 restart） |
| 自动恢复缺失 | guardian 日志 17:19-17:28 仅 CONFIG SAFETY，无 "RESTART: server not ready" |

### 5.2 判定

- **ROOT_CAUSE_CONFIRMED**（高置信）：
  1. restart worker 的生存期与 DSH/Agent 宿主进程树绑定；
  2. 宿主（server）被 stop 时 worker 同步死亡，`finally` 清锁逻辑无机会执行；
  3. maintenance lock 遗留 → guardian 按设计暂停自救 → 服务无法自动恢复；
  4. 只有外部（用户）手动操作才能恢复。

- 无法 100% 回溯 lock 文件历史内容（lock 已被清理），但 guardian 行为（17:19-17:28 无 restart 尝试）
  与 lock 遗留完全一致，且 08:35 的成功 restart 有完整 finally 记录作对照。

## 6. Scope Classification

**CASE B — PRE-EXISTING / INDEPENDENT RELIABILITY GAP**（不是 R3 回归）

判定依据：
- R3 改动的文件：`dsh-launcher.js`、`tests/reliability/Test-LauncherArgs.mjs`、`.github/workflows/ci-level2.yml`
- `restart-dsh-server-delayed.ps1` **不引用**上述任何文件；
- restart 脚本最后修改于 R1（`fc181dd`），远早于 R3；
- 失败模式 = restart worker 宿主绑定 + maintenance-lock 遗留（2026-08-16 引入的既有设计），
  与 Phase 01 Source-of-Truth 修改无因果；
- 08:35（R2 时期）同脚本 restart 成功、17:19（R3 时期）失败——差异在**调用上下文**（宿主绑定），
  不在脚本本身。

**结论**：Phase 01 **不再继续大修**；自动 restart 缺口正式移交 Phase 02。

## 7. Phase 02 P2-0 正式移交项

```
Phase 02 最高优先级 P2-0 / HIGH：
  Automatic Restart Ownership & Worker Survival

问题：restart-dsh-server-delayed.ps1 的 worker 生存期与 DSH/Agent 宿主进程树绑定；
      宿主被 stop 时 worker 死亡，finally 清 maintenance-lock 不执行，guardian 因锁暂停自救，
      服务无法自动恢复（需人工介入）。

已知状态：AUTOMATIC_RESTART = FAILED（known issue，Phase 01 如实记录，不掩盖）
          MANUAL_RELAUNCH_RECOVERY = PASS（用户手动重开 Desktop 后任务续跑）

建议方向（Phase 02 设计，不在 Phase 01 实施）：
  - restart worker 脱离宿主进程树（独立 spawn / 计划任务 / detached job）；
  - 或 maintenance-lock 由独立 watchdog 兜底清理；
  - 或 guardian 在 lock 新鲜但 server down 超时时接管（降级策略）。
```

## 8. Current Process Cmdline + client_ready + COMMIT_READY（基于手动 relaunch 后进程）

**当前 server（PID 4556，用户手动 relaunch 创建，17:28:31）**：
```
...\node.exe C:\...\@deepseek-ai\dsh\lib\bin.js web --port 3080 --no-open --trusted-host 100.120.3.29:3080 --trusted-host ai-office-windows.tailab0bb5.ts.net:3080
```
- ✅ `--no-open` 存在
- ✅ 两个 `--trusted-host` 存在
- ✅ `web --port 3080`（normal 模式，无错误 `--profile`）

**Runtime 验证（R4 复核）**：

| 检查 | 结果 |
|---|---|
| Test-DshReadiness -RequireWebSockets | ✅ **client_ready** |
| Test-CommitReadiness | ✅ **Gate: True \| Stage: COMMIT_READY** |
| HTTP | ✅ 200 |
| Guardian | ✅ 心跳正常，Config Safety 规则正确（not promoted） |

## 9. Session/Goal/EC Continuation Evidence

| 证据 | 结果 |
|---|---|
| 断服前任务 | Phase 01 R3 收尾执行中（goal active） |
| 断服窗口（17:19-17:28） | server down，无法交互（用户确认） |
| 手动 relaunch 后 | **原任务继续**：同一 session.jsonl.zstd（17:25→18:16 持续写入）；goal 上下文未丢 |
| 结论 | `Full server loss + manual relaunch → original task resumable/continued` ✅ |
| 状态机 | 无 WAITING_USER / completed / paused 被错误跨越（任务无缝续跑） |

## 10. CURRENT_STATUS NUL/Control-Char 修复与检查

**问题（Reviewer CURRENT-2）**：CURRENT_STATUS.md 含 2 个 NUL（0x00）+ 1 个 U+000C（form feed）：
- `Base Commit: [NUL]beec549`（应为 `0beec549`）
- `修复分支: [FF]ix/phase01-review-r3`（应为 `fix/phase01-review-r3`）
- `DSH 版本: [NUL].1.1-rc.2`（应为 `0.1.1-rc.2`）

**修复**：整文件重写为纯净 UTF-8（无 BOM，无控制字符）。
**验证**：NUL=0，控制字符=0。
**CI 防护**：ci-level1.yml 新增 "Roadmap status document integrity" 步骤——检查
CURRENT_STATUS.md NUL/control chars = 0，UTF-8 可读。全仓库 roadmap 文档扫描干净。

## 11. Canonical ↔ Deployment Hash

R4 无 runtime 代码变更（CASE B），沿用 R3 验证：
- 11 个启动/可靠性文件 canonical ↔ DSH-Client 全一致（R3 §8）
- 24 个插件 plugins ↔ Live 全一致
- 当前进程 cmdline 与 canonical launcher 构造一致（§8）

## 12. 未完成项与 BACKLOG

**未完成项**：
- `AUTOMATIC_RESTART` 自动重启能力 = **FAILED（known issue）**，已移交 Phase 02 P2-0，
  **不在 Phase 01 修复**（Phase 01 为 Source-of-Truth，非 Reliability P2 大修）。

**BACKLOG**：
- B1: Live ~/.dsh/profiles/web/cordis.patch.yml 硬编码 NOTION_TOKEN（部署机本地事实；长期 env 注入）
- B2: cordis.patch.yml 机器特定路径可模板化（Phase 02/05）
- B3: `execution-economy-v1`、`feature/ox-alpha-multi-relay-fallback` 独有 commit 未合并（Phase 02/03 评估）
- B4: CI 工作流仅 PR 触发，直接 push main 不触发（既有配置）

## 13. Final Verdict

**IMPLEMENTATION_COMPLETE**

（Phase 01 Source-of-Truth 收尾完成：R3 归因已如实纠正；AUTOMATIC_RESTART=FAILED 已如实记录并
移交 Phase 02 P2-0；MANUAL_RELAUNCH_RECOVERY=PASS 作为生产连续性证据保留；CURRENT_STATUS 控制
字符修复；当前 canonical runtime 验证 PASS（client_ready + COMMIT_READY）；Phase 01 原始 8 条
AC 重新核对通过——见 §14）

## 14. RETURN_TO_PHASE_CHECKLIST（Phase 01 原始 8 条 AC 复核）

| # | Acceptance Criteria | 结果 |
|---|---|---|
| 1 | GitHub canonical 与部署关键源码可一一追溯 | ✅ PASS（11 脚本 + 24 插件全一致） |
| 2 | 不存在"报告说已修但 GitHub 无源码"的关键能力 | ✅ PASS（全部关键能力在 GitHub） |
| 3 | main 无 secret/log/temp/.workbuddy 污染 | ✅ PASS（secret scan CLEAN，已追踪敏感文件 0） |
| 4 | 关键 runtime 与 canonical hash/diff 关系明确 | ✅ PASS（hash 矩阵 + 进程 cmdline 证据） |
| 5 | relevant tests + runtime health PASS | ✅ PASS（243+ 项回归；手动 relaunch 后 client_ready + COMMIT_READY） |
| 6 | 新 Golden/checkpoint 可回滚 | ✅ PASS（R3 Candidate + tag phase01-save-r3 + checkpoint） |
| 7 | Git working tree/branch 状态清楚 | ✅ PASS（main 与 origin 同步；R4 走独立分支） |
| 8 | Self Audit 明确回答重复/真源/冲突/遗留漂移 | ✅ PASS（无重复；GitHub=canonical；自动 restart 缺口如实记录为 Known Issue） |

> 注：AC5 "Runtime health PASS" 由**手动 relaunch 后的当前 canonical runtime** 证明；
> 不要求在 Phase 01 修完自动 restart P2（CASE B 判定），但报告已真实说明 automatic restart 当前失败。

## 15. Waiting For

**EXTERNAL_REVIEW**

（等待 99｜Reviewer Feedback 中 Reviewer Verdict；未获 APPROVED 前禁止进入 Phase 02，
禁止自行标记 VERIFIED）

---

*报告不可覆盖：复审修改将生成 REPORT_R5.md……*
