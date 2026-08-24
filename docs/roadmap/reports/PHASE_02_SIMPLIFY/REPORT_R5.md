# PHASE_02_SIMPLIFY — REPORT_R5

> Phase 02：SIMPLIFY / Architecture Consolidation + Reliability P2 — Reviewer Round 4 修复
> 日期：2026-08-24 ｜ 执行：Harness Master Orchestrator
> 报告路径：docs/roadmap/reports/PHASE_02_SIMPLIFY/REPORT_R5.md
> 前置：REPORT_R1/R2/R3/R4（不覆盖）

---

## 1. Reviewer Round 4 Verdict & 修复范围

**Reviewer Verdict：CHANGES_REQUIRED**（5 个 BLOCKING + R5 Runtime Interruption Addendum + Second Post-Restart Diagnosis Refinement）
**R4 确认的真实进展（保留）**：Goal Recovery 只读 --check、Completion Truth exact callId、EC 无 compactNow、PR #19 Level 1/2/3 绿、RestartAndWait 真实 COMMITTED、generation 绑定真实 PASS。

**本轮 R5 全部完成**：5 个 BLOCKING + Addendum 3 项 + Refinement 2 项（详见 §3-§12）。

## 2. Baseline

| 项 | 值 |
|---|---|
| Base Commit | `153935e`（PR #19/#20 merge 后 main） |
| 修复分支 | `fix/phase02-review-r5`（10 commits） |
| 保留 | P2-0 / stable-window / R3/R4 已验证成果 |
| DSH 版本 | 0.1.1-rc.2 |

## 3. R4-B1 Test Isolation 完善（Close）

**Reviewer**：Restore-DshTransactionCheckpoint 写回真实 profile；C5 无真实 before；Lab/safe-mode 不隔离。
**修复**：
- `Restore-DshTransactionCheckpoint -ProfileRoot`（默认不变，测试隔离 profile；ProfileRoot 解析到 live 直接 deny）
- `Invoke-DshTransaction -ProfileRoot` 透传两处 rollback restore
- Test-StageC：测试前记录 live profile hash/mtime 快照 → 结束后 Compare（真实 before/after deny）
- `dsh-safe-mode.ps1`：state dir 跟随注入的 DSH_SAFE_FLAG_PATH（不再无条件建真实 state）
- `dsh-reliability-lab.ps1`：加 DSH_TX_ROOT 隔离

**验证**：StageC C5（true before/after deny）PASS、Lab 9/9、StageE PASS。

## 4. R4-B2 Process Authority 收口（Close）

**Reviewer**：generation 未参与校验；worker 传错 PID；hourly 被清空；rollback/SafeMode 等 outer wrapper；boot_failed 仍 COMMITTED。
**修复**：
- `Test-DshCandidateIdentityMatch`：generation 全量校验（空 generation 拒绝——blank identity 永不 commit）；`-ProcessId` 参数名修复
- restart worker：dot-source dsh-generation.ps1（**原来缺失导致 generation=''**）+ candidate 绑定**新 server 真实 PID + 非空 generation**（取不到 fail-closed throw）
- `Confirm-DshRestartStable`：**保留 hourly crash history**（只清 10-min window）——storm 仍闭环
- `-RestartAndWait`：一次 detach + 等 exact terminal（SafeMode 用）
- Transaction：rollback restart 等 exact terminal；**boot_failed 后禁止 COMMITTED sweep**（直接 BOOT_FAILED）
- SafeMode：Restart-DshServerNow 用 RestartAndWait（exact terminal）

**验证**：Test-RestartBudget R1-R18 全 PASS（含 R14 generation mismatch / R17 空 generation / R18 blank 注册 / R16 storm）；真实 restart attempt `b34fcb...`/`5d7691...` generation 非空；hourly 保留（hourAttempts 未清）。

## 5. R4-B3 LastGood Atomic（Close）

**Reviewer**：先删 current 再 Move-Item 有缺失窗口；Restore 读 legacy 根不验 manifest。
**修复**：
- `Save-VerifiedLastGood`：**versioned set（v-*）+ current pointer 文件**（Move-Item -Force 原子替换，无删除窗口）；legacy 根文件由 set 派生（非权威）
- `Get-VerifiedCurrentSet`：pointer → 校验 versioned set（traversal-safe）
- `Test-VerifiedSet`：逐文件 sha256 manifest 校验
- `Restore-VerifiedLastGood`：**只解析 pointer → set → hash 校验 → 一次恢复**；torn/mismatch/missing pointer 拒绝（fail-closed）；ProfileRoot 支持
- 修复 `$Src/$src` PowerShell 大小写不敏感 clobber bug

**验证**：StageB C5（pointer resolve / hash validate / torn reject / restore refuse / missing pointer / 隔离 profile restore）ALL PASS。

## 6. R4-B4 EC→Router Bridge 完善（Close）

**Reviewer**：needLargerContext 盲目 mimo||deepseek；explicit selection 用 stale agent.options.model；T1 恒真断言；CommandCode 不消费。
**修复**：
- `openrouter-router`：needLargerContext **exact capacity 比较**（registry provenance-backed；候选严格更大才切；当前未知 fail-closed keep）；explicit selection 取 **current official request truth**（`resolvedModelOf(payload)` = payload.resolved.model / payload.model / payload.request.model）；**单 owner**（非 openrouter 路由不消费，留给目标 provider）
- `commandcode-router`：**第一等 recovery consumer**——监听 ec/recovery-requirement + agent/request 应用（needLargerContext capacity 比较 / image→MUSE / reasoning→DEEPSEEK）
- `model-registry`：+`deepseek/deepseek-v4-flash` 1310720（commandcode id）
- test-ec-router-bridge：**删恒真断言**（T1 真实 ack 验证）；T4 capacity 切换；T5 单 owner；T6 CommandCode 消费

**验证**：bridge 14/14 PASS（T1 ack'd、T4 严格更大切换 deepseek、T6 commandcode 切 deepseek + ack）；commandcode 51 / router 9+25 / registry 33 PASS。

## 7. R4-B5 Model Facts + CI（Close）

**Reviewer**：unknown required context fail-open；thresholdRatio 未证运行时；attestation 无 loaded 比较。
**修复**：
- `modelSupports(required.contextWindow)`：**UNKNOWN window fail-closed**（无法证明满足 → 拒绝）
- `r5-runtime-truth.mjs`：现场输出 host.describe route + settings declared contextWindow + **官方 compaction 默认（thresholdRatio=0.8 / retainRatio=0.16，读 dsh-compaction-basic 源码 L13/L15）** + proactive threshold（resolvedCtx×0.8）+ **source→deployed attestation（ALL MATCH）**
- 部署同步：model-registry / vision-bridge / openrouter-router-core / execution-continuity-core（Live==canonical）

**验证**：registry 33/33（R9 unknown context fail-closed 边界）；attestation 6/6 MATCH。

## 8. R5 Runtime Interruption Addendum（Close，3 项）

### ① generation production binding
**根因**：restart worker **未 dot-source dsh-generation.ps1** → Get-DshGenerationId 未定义 → generation=''。
**修复**：dot-source + 非空 generation fail-closed（candidate/commit 必须非空 identity）。
**真实证据**：第二次真实 restart attempt `b34fcbbef82c49ff8511391e236fac96`（12:51）→ `candidate bound to new server pid=23808 generation='639231726601795822_23808'` **非空**；COMMITTED。Test-RestartBudget R17/R18。

### ② zombie running reconciliation
**修复**：anti-double-kick 不再仅凭 `running===true` 跳过——stale updatedAt（>3min）→ INTERRUPTED_BY_RESTART（继续恢复）。
**验证**：crashsafe/fault 回归；后续 Refinement 升级为 goal-scoped（见 §10）。

### ③ transient CT evidence defer
**修复**：completionTruth events-unavailable 返回 `evidence_unavailable` → **bounded WAITING_NETWORK defer**（cap 5 → manual review）；真实 needs_verification 永不放松。
**验证**：test-r5-addendum-ec T1/T2（defer + cap）。

## 9. R5 Runtime Interruption Diagnosis（§8-§9 真实证据）

**第一次真实 restart（12:00）**：attempt `5566e4...` COMMITTED；generation=''（旧代码缺陷）→ 触发 Addendum ①。
**诊断结论**：NEEDS_VERIFICATION 是状态机死端（白名单外 + 无重扫）→ 触发 Refinement。

## 10. R5 Second Post-Restart Diagnosis Refinement（Close，2 项）

### ① legacy NEEDS_VERIFICATION reason-aware migration
**修复**：
- intent schemaVersion=2 + verificationKind（`UNRESOLVED_SIDE_EFFECT` / `EVIDENCE_DEFER` / `LEGACY_EVIDENCE_UNAVAILABLE`）+ ctUnresolvedCall
- `reconcileLegacyVerification`（boot scan 前）：**仅精确 legacy 签名**（旧 schema + reason=session events unavailable / no session events + 无 persisted unresolved call）才重跑 Completion Truth；clean→可恢复、evidence_unavailable→bounded defer、**真实 unresolved→保持 NEEDS_VERIFICATION（fail-closed）**；字段不完整默认不迁移

**真实证据（13:54 restart，new server 22032）**：
```
RECONCILE-LEGACY sid=session-9e3b29bb legacy NEEDS_VERIFICATION -> revalidate
CT ... session events unavailable -> evidence_defer (transient, bounded)
SCAN restart: 2 recoverable intent(s): ...[WAITING_NETWORK]   ← 死端被救出
CT sid=... -> clean
RESUME-OK sid=... goalActive=true cycles=7 (timer)             ← 真实恢复
```
intent: NEEDS_VERIFICATION → RUNNING（verificationKind=EVIDENCE_DEFER）；goal roundsStarted **0→4**。

### ② goal-scoped liveness（anti-double-kick）
**修复**：running=true 不再单独决定 SKIP——要求 **current generation + target active Goal identity/revision + Goal progress evidence（roundsStarted delta）**；无 goal 进度证据 → **LIVENESS_UNKNOWN → INTERRUPTED_BY_RESTART（bounded recheck，CT-gated）**；session activity（用户诊断/steps）**不算** Goal liveness；旧 zombie（updatedAt 版）标记移除。
**验证**：test-r5-addendum-ec T3（goal-scoped 分支 + 旧 marker 移除）；Refinement 真实 RESUME-OK。

## 11. Real vs Synthetic Evidence 分栏

| 证据 | 类型 |
|---|---|
| generation 非空 + COMMITTED（两次真实 restart） | real |
| hourly crash history 保留（budget 实测） | real |
| legacy NEEDS_VERIFICATION migration → RESUME-OK（13:54） | real |
| goal roundsStarted 0→4（goal 自主推进） | real |
| 官方 thresholdRatio=0.8/retainRatio=0.16（源码读取） | real |
| source→deployed attestation 6/6 MATCH | real |
| bridge capacity 比较 / CT defer cap / zombie 判定 | synthetic（真实模块+mock ctx） |
| StageB/C5 atomicity / RestartBudget R1-R18 | synthetic（隔离 state） |

## 12. 已确认 PASS（R5 禁止重做）

- Goal Recovery autonomous executor 已关闭（仅 --check）
- Completion Truth exact callId + fail-closed
- EC 无手工 compactNow（官方 compaction 独占）
- RESUME-DEFER durable + cap
- RestartAndWait exact terminal
- PR #19 CI Level 1/2/3 绿（当前 DSH + hard fail）

## 13. Regression（全量）

| 测试 | 结果 |
|---|---|
| RestartBudget R1-R18（generation/corruption/hourly/storm） | PASS |
| StageB C1-C5（atomic LastGood） | PASS |
| StageC/E + CommitReadiness + FinalDrill D1-D8 + Lab L1 | PASS |
| model-registry 33（R8/R9 fail-closed） | PASS |
| completion-truth 18 / resume-defer 12 / r5-addendum 24 | PASS |
| ec-router-bridge 14（capacity/single-owner/CommandCode） | PASS |
| crashsafe 33 / fault 38 / compaction 18 / WAITING_USER 12 | PASS |
| router 9+25 / commandcode 51 / model-guard 21 | PASS |
| r5-runtime-truth（route/ctx/threshold/attestation） | PASS |

## 14. PR / Merge SHA / CI

- PR #21（代码）：`fix/phase02-review-r5`（commits bb7734d→5a8f744，10 个）
- CI：待 PR 创建后跑
- Merge SHA：待 merge 后记录

## 15. Rollback

- Checkpoint：`DSH-Client\_checkpoint-PHASE02-R5-20260824-112155`（Base 153935e）
- git：`git reset --hard 153935e`（R5 前）
- 部署：Live profile 与 canonical 一致（attestation ALL MATCH）

## 16. Remaining UNKNOWN / BACKLOG

**UNKNOWN**：
- AGENTROUTER_BACKEND_ACCEPTED_CONTEXT（300K probe 需成本+key；标 UNKNOWN 不假装）
- commandcode 路由的 settings contextWindow 未声明（registry hint=1310720；resolveModelInfo 权威）

**BACKLOG**：
- Test-P20OrphanLock flaky（guardian dot-source 主循环）
- Live cordis.patch.yml 硬编码 NOTION_TOKEN（SECURITY-HARDENING 阶段）
- settings.yaml 中文 displayName 乱码（显示级）

## 17. Final Verdict

**IMPLEMENTATION_COMPLETE**

（5 BLOCKING + Addendum 3 项 + Refinement 2 项全部关闭；post-restart task recovery 从 FAIL → 真实 PASS（legacy migration + RESUME-OK）；全量回归绿；真实 vs synthetic evidence 分栏清晰）

## 18. Waiting For

**EXTERNAL_REVIEW**

（等待 Reviewer Verdict；未 APPROVED 禁止 Phase 03；Phase 03 入口仍需单独 Security-Hardening gate）

---

*报告不可覆盖：复审修改将生成 REPORT_R6.md……*
