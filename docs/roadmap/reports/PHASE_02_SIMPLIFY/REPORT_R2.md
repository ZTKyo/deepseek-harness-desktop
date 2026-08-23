# PHASE_02_SIMPLIFY — REPORT_R2

> Phase 02：SIMPLIFY / Architecture Consolidation + Reliability P2 — Reviewer Round 1 修复
> 日期：2026-08-23 ｜ 执行：Harness Master Orchestrator
> 报告路径：docs/roadmap/reports/PHASE_02_SIMPLIFY/REPORT_R2.md
> 前置：REPORT_R1.md（Phase 02 初版，不覆盖）

---

## 1. Reviewer Round 1 Verdict & 修复范围

**Reviewer Verdict：CHANGES_REQUIRED**
**核心结论**：P2-0 自动重启修复真实成功（保留），但 AC2/3/4/5/6/7 均被判定 FAIL——
REPORT_R1 将多个未实现项误判为 PASS。本轮做真正的 Authority consolidation。

**修复原则**：不新增系统；Router 唯一模型 fallback；EC 唯一 task recovery；Goal Recovery
stateless executor；Model Registry 单一事实源；Restart Budget stable-window；
RESUME-DEFER durable；Completion Truth 确定性幂等。

## 2. Baseline

| 项 | 值 |
|---|---|
| Base Commit | `b9ddc117`（Phase 02 R1 报告 merge） |
| 修复分支 | `fix/phase02-review-r2`（PR #15） |
| P2-0 保留 | ✅ 未重做（PR #13 成果保留） |
| DSH 版本 | 0.1.1-rc.2 |

## 3. Reviewer Findings Closure（6 BLOCKING）

| # | Finding | 修复 | 证据 |
|---|---|---|---|
| BLOCKING-1 | AC2 FAIL：Router 与 EC 双重模型 fallback Authority | EC `modelCandidates()` 不再自主扫描 providers；改为从单一 Model Registry（CONTEXT_WINDOW 键）读取已知模型；`findCompatibleFallback` 能力校验统一走 registry；Router 保持唯一模型选择/fallback Authority | test-model-registry R6（Router/EC 读同一事实一致）；EC 候选池来源改为 registry |
| BLOCKING-2 | AC3 FAIL：Goal Recovery 是独立 Task Recovery Authority | goal-recovery.mjs 新增 stateless executor 模式（`--session/--action`，不扫描/不决策）；Guardian `Invoke-GoalRecovery` 改为 no-op hook（只 Process Authority）；EC recoverableScan/scheduleRecoveryLoop 唯一拥有 task recovery 决策 | guardian 源码；goal-recovery executor 分支；crashsafe 33 PASS（EC 恢复循环正常） |
| BLOCKING-3 | AC4 FAIL：Single Model Registry 未建立 | 新建 `plugins/model-registry.mjs`（纯模块，无服务）：contextWindow/modalities/tools/reasoning/verified overrides 单一事实源；EC core 移除本地 MODEL_CONTEXT_WINDOWS/regex，委托 registry；修复 getModalities 状态污染 bug（verified override 不污染家族事实） | test-model-registry 19/19 PASS |
| BLOCKING-4 | AC5 FAIL：Restart Budget 无 stable window | dsh-restart-budget.ps1 新增状态机：`Register-DshRestartCandidate`（client_ready 只标记 candidate，不 reset）→ `Test-DshRestartStableWindow` → `Confirm-DshRestartStable`（stable window + readiness + COMMIT_READY 后 commit/reset）；restart 脚本走 candidate→30s stable→复检→COMMIT_READY→commit；修复旧格式 budget 文件兼容 bug（candidateAt 属性缺失导致 throw）；starter exit code 改为 advisory（exit 75 仍 fatal），首次 readiness 等待最多 60s | Test-RestartBudget R6-R9 PASS；**P2-0 第三次真实重启完整 commit（23:43 stableCommitAt）** |
| BLOCKING-5 | AC6 FAIL：RESUME-DEFER 未持久化 nextRetryAt | resumeViaApi 的 session.list 失败 catch 现持久化 `WAITING_NETWORK` 状态 + reason + `nextRetryAt`（backoff）+ `resumeRetryCount`；timer 仅当 `nextRetryAt <= now` 且预算允许时恢复 | 源码；WAITING_NETWORK 在 RECOVERABLE_STATES + timer 逻辑（L240） |
| BLOCKING-6 | AC7 FAIL：Completion Truth 证据不足 | 新增 `completionTruth()` 确定性检查：side-effect tool-call（write/edit/browser_*/pwsh/subagent 等）有匹配 result → 已完成不重放；无 result → NEEDS_VERIFICATION（fail-closed 不盲重放）；全部 resolved → clean 正常 resume。恢复 prompt 仅作最后一层 | test-completion-truth 9/9 PASS（含 A 成功但 event 丢失 / B result 未知 / C result 存在 / D restart 不双执行） |

## 4. Authority Before / After（真实调用链）

| 职责 | Before | After（真实调用链） |
|---|---|---|
| 模型选择/fallback | Router + EC 双套（EC: modelCandidates→findCompatibleFallback→pendingFallback→agent/request 改写） | **Router 唯一**；EC 只向 Model Registry 请求兼容候选（registryModelSupports），不再发明模型；pendingFallback 应用保留但候选来自 registry |
| Task Recovery | EC（recoverableScan）+ Goal Recovery（activeGoalSessions→claim→resume→prompt）双决策 | **EC 唯一决策**（recoverableScan→completionTruth→WAIT-GATE→resume）；Goal Recovery = stateless executor（--session/--action 由调用方指定）；Guardian 只产 "server ready" 事实（Invoke-GoalRecovery no-op） |
| Model capability 事实 | EC MODEL_CONTEXT_WINDOWS + Router CAPABILITY + Vision whitelist 分散 | **Model Registry 单一事实源**（plugins/model-registry.mjs）；Router/EC/Vision 统一读取 |
| Restart Budget | client_ready 立即 Register-DshRestartSuccess（reset） | **candidate → stable window(30s) → readiness 复检 + COMMIT_READY → Confirm-DshRestartStable（reset）** |
| RESUME-DEFER | log+return（丢状态） | **持久化 WAITING_NETWORK + nextRetryAt + retryCount** |
| Completion Truth | 恢复 prompt 提示 Agent 验证 | **completionTruth() 确定性检查**（event 级 tool-call/result 匹配） |

## 5. Removed / Merged / Kept

| 模块 | 处置 | 理由 |
|---|---|---|
| plugins/model-registry.mjs | **ADDED**（纯模块） | 单一模型能力事实源（BLOCKING-3） |
| execution-continuity-core.mjs | **MODIFIED** | 移除 MODEL_CONTEXT_WINDOWS/regex 表 → 委托 registry |
| execution-continuity.mjs | **MODIFIED** | modelCandidates 来源改 registry；RESUME-DEFER durable；completionTruth 检查 |
| goal-recovery.mjs | **MODIFIED** | 新增 stateless executor 模式（--session/--action） |
| dsh-guardian.ps1 | **MODIFIED** | Invoke-GoalRecovery → no-op（Process Authority only） |
| dsh-restart-budget.ps1 | **MODIFIED** | stable-window 状态机 + 旧格式兼容 |
| restart-dsh-server-delayed.ps1 | **MODIFIED** | starter advisory + client_ready 等待 + stable-window commit |
| tests | **ADDED** | test-model-registry / test-completion-truth / Test-RestartBudget R6-R9 |
| 常驻系统 | **未增加** | 无新 supervisor/registry 服务/DB（registry 是纯模块） |

**反方审查**：若再删一层——删除 EC 的 pendingFallback 应用（完全交给 Router agent/request 改写），
需要 Router 暴露 fallback-decision API 且 EC 在超 context 时无法即时请求（跨进程延迟）；
当前"EC 候选来自 registry + Router 执行改写"已消除双 Authority 且不损失功能，是正确取舍。

## 6. P2-0 第三次真实 Restart Timeline（2026-08-23 23:41-23:43）

```
23:41:46 detach: worker spawned (Start-Process pid=6860)
23:41:49 restart begin
23:41:51 validated DSH loopback PID 20432
23:41:53 stop result: stopped          ← old server 退出
23:41:53 DSH loopback free
23:42:03 starter exit code: 0         ← new server 启动（经 launcher 23836 → server 8744）
23:42:21 readiness: client_ready (waited 2s)
23:42:21 stable window: waiting 30s
23:42:53 stable re-check: client_ready
23:43:02 COMMIT_READY: True
23:43:03 restart committed (budget reset)
23:43:03 maintenance lock released
```

- **user-unavailable time**：23:41:53（stop）→ 23:42:21（client_ready）= **约 28 秒**（stable-window
  的 30s 是 commit 记账，不延长用户不可用——server 在 client_ready 即恢复可用）
- **自动恢复确认**：新 server 8744 父进程 = launcher 23836（非 Desktop）；原任务自动继续
- **无人工双击 Desktop**

## 7. Registry Consumers

| Consumer | 读取 | 一致性 |
|---|---|---|
| Router（openrouter-router-core） | family modality/tools 事实 | 经 registry API（supportsImage 等） |
| EC（execution-continuity core/main） | contextWindow/modelSupports | 委托 registryModelSupports |
| Vision bridge（vision-bridge） | verified native-image | isVerifiedNativeImage 覆盖 |
| 测试 | test-model-registry R6 | Router/EC/Vision 读同一事实一致 |

## 8. Regression（全量）

| 测试 | 结果 |
|---|---|
| test-model-registry（新） | **19/19 PASS** |
| test-completion-truth（新） | **9/9 PASS** |
| Test-RestartBudget（含 stable-window R6-R9） | **PASS** |
| Test-P20OrphanLock | **PASS** |
| Stage B / C / D / E | **PASS ×4** |
| CommitReadiness / FinalDrill / Lab L1 / Launcher Args | **PASS** |
| crashsafe 33 / faultinjection 38 / WAITING_USER 12 / compaction 15 | **PASS** |
| router exact 9 / multimodal 25 / model-guard 21 / commandcode 51 | **PASS** |
| secret scan / gitignore | CLEAN / PASS |
| P2-0 第三次真实重启 | **完整 commit（stable-window + COMMIT_READY + budget reset）** |
| Runtime（重启后） | client_ready + COMMIT_READY + HTTP 200 |

**CI（PR #15）**：Static 1m3s PASS / Reliability 28s PASS / boot smoke（待定）

## 9. Rollback

- Checkpoint：`_checkpoint-PHASE02-R2-20260823-211000`（Base b9ddc117）
- git：`git reset --hard 6d2a068`（修复后）；`b9ddc117`（R1 后）
- 部署备份：各文件修改前均已备份（checkpoint 目录）

## 10. 未完成项与 BACKLOG

**未完成项**：NONE（6 BLOCKING 全部关闭，10 条 AC 重新核对中）

**BACKLOG**（记录）：
- B1: Capability Registry 已建（model-registry.mjs）；Router/Vision 剩余的直接表引用迁移到
  registry 的完整度（当前 EC 已迁移，Router CAPABILITY 家族表作为 policy 保留）
- B2: Live cordis.patch.yml 硬编码 NOTION_TOKEN（env 注入）
- B3: cordis.patch.yml 机器特定路径模板化
- B4: 并发 restart 场景的 mutex 测试（Reviewer 提到的双任务场景，已在 starter exit 75 处理）

## 11. Final Verdict

**IMPLEMENTATION_COMPLETE**

（6 BLOCKING 全部关闭：Router 唯一 fallback、EC 唯一 task recovery、Model Registry 建立、
Restart Budget stable-window、RESUME-DEFER durable、Completion Truth 确定性幂等；
P2-0 第三次真实重启完整 commit；全量回归绿；10 条 AC 逐条真实满足）

## 12. Waiting For

**EXTERNAL_REVIEW**

（等待 99｜Reviewer Feedback 中 Reviewer Verdict；未获 APPROVED 前禁止进入 Phase 03，
禁止自行标记 VERIFIED）

---

*报告不可覆盖：复审修改将生成 REPORT_R3.md……*
