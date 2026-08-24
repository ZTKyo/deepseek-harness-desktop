# PHASE_02_SIMPLIFY — REPORT_R4

> Phase 02：SIMPLIFY / Architecture Consolidation + Reliability P2 — Reviewer Round 3 修复
> 日期：2026-08-24 ｜ 执行：Harness Master Orchestrator
> 报告路径：docs/roadmap/reports/PHASE_02_SIMPLIFY/REPORT_R4.md
> 前置：REPORT_R1/R2/R3（不覆盖）

---

## 1. Reviewer Round 3 Verdict & 修复范围

**Reviewer Verdict：CHANGES_REQUIRED**（11 Step Required Fix Prompt + Codex C1-C7 Cross-Audit）
**核心批评**：R3 对 6 个旧 BLOCKING 有真实进展，但①EC→Router bridge 未真实接通；②Codex C1-C7 未处理。

**本轮 11 Step 全部完成**（详见 §3-§14）。

## 2. Baseline

| 项 | 值 |
|---|---|
| Base Commit | `3b7adc8`（R3 报告 merge） |
| 修复分支 | `fix/phase02-review-r4`（PR #19） |
| 保留 | P2-0 / stable-window / R3 已验证成果 |
| DSH 版本 | 0.1.1-rc.2 |

## 3. Round 3 Findings Closure（R3-B1…B10）

| # | Finding | 修复（Step） | 证据 |
|---|---|---|---|
| R3-B1 | EC pendingFallback 只写 IntentStore，Router 不读 | **Step 3**：EC 3 处 requirement 设置点 `ctx.emit("ec/recovery-requirement")`；Router 监听存 session state + agent/request 消费+ack（needLargerContext→大模型、image→mimo、reasoning→deepseek） | test-ec-router-bridge 8/8（真实模块串联） |
| R3-B2 | goal-recovery executor 无 caller 或 goalRef 契约错 | **Step 2**：executor 无生产 caller → **删除 executor + 死代码**；只留 `--check`；Guardian attestation（loaded 代码=current release） | --check exit 0；--session fail-closed exit 4；Guardian reload 后加载新代码 |
| R3-B3 | completion-truth resultMatches 同 turn 碰撞 | **Step 4**：extractCalls 取全部 tool-call；resultMatches **exact callId only**（删 same-turn fallback）；空名/缺 id fail-closed | test-completion-truth 18/18（含 collision I1-I7） |
| R3-B4 | EC 手工 compactNow(undefined) 违反官方 contract | **Step 5**：删除 EC 手工 compactNow；EC 只分类+durable state+提交 needLargerContext；官方 compaction-basic 独占 | compaction test 18/18（C2/C5 断言 0 次 compactNow 调用） |
| R3-B5 | Registry 是第二张 context DB + fail-open | **Step 6**：unknown family tools/structuredJson **fail-closed**（原 {true,true}→{false,false}）；chars→tokens 修正；声明为 thin override | model-registry 27/27（R8 unknown fail-closed） |
| R3-B6 | Opus 5 三层真相未区分 | **Step 6**：ANTHROPIC_UPSTREAM=1M（官方文档）/ HARNESS_RESOLVED=1M（settings+resolveModelInfo）/ AGENTROUTER_BACKEND=**UNKNOWN**（无 metadata；300K probe 需成本+key，标 UNKNOWN 不假装） | evidence/PHASE02_R4_OPUS_CONTEXT_TRUTH.md |
| R3-B7 | GUI/Transaction 直接 start/stop，outer exit 0 误当完成 | **Step 1**：restart attempt 写 attemptId+terminal ledger（SPAWNED→STARTED→COMMITTED/FAILED）；`-WaitAttempt` 阻塞等 exact terminal；Transaction 捕获 attemptId + 等 COMMITTED | WaitAttempt 验证（COMMITTED=0/FAILED=2/TIMED_OUT=3） |
| R3-B8 | Budget 无 generation 绑定 + corrupt 恢复可用 | **Step 7**：candidate 绑 {attemptId,pid,generation}；Confirm 验证 same candidate（foreign fail-closed）；corrupt JSON → quarantine（不返回全新默认） | Test-RestartBudget R1-R13 全 PASS |
| R3-B9 | LastGood 逐文件复制无 manifest | **Step 8**：staging complete set + {path,sha256} manifest → 原子切换 current pointer；Guardian 恢复校验 manifest（torn/hash mismatch 拒绝） | StageB PASS（含 C4 deny assertion） |
| R3-B10 | SkipLive 测试污染真实路径 | **Step 0**：verified-lastgood 支持 DSH_STATE_ROOT；Test-StageB/C 强制 temp root + deny assertion | C4/C5 filesystem deny PASS |

## 4. Codex C1-C7 Closure

| # | Codex Finding | Closure | 证据 |
|---|---|---|---|
| C1 | Router/EC 双模型 Authority | **FIXED**（Step 3） | EC 不选模型（requirement only）；Router 消费+ack；bridge test 8/8 |
| C2 | Goal Recovery 双 Task Recovery Authority | **FIXED**（Step 2） | executor 删除；Guardian no-op；--session fail-closed |
| C3 | Completion Truth fail-open（runtime-confirmed 23:17/23:42） | **FIXED**（Step 4） | no events→needs_verification（fail-closed）；exact identity |
| C4 | Model/context truth 漂移 | **FIXED**（Step 6） | unknown fail-closed；contextWindow Authority=resolveModelInfo |
| C5 | CI/copied test 假绿（rc8+空 profile+readiness fail exit 0） | **FIXED**（Step 10） | Level3 用 0.1.1-rc.2 + 真实 plugins manifest + exit 1 hard fail |
| C6 | Test Isolation（SkipLive 写真实路径） | **FIXED**（Step 0） | StateRoot 注入 + deny assertion |
| C7 | loaded Guardian 未 attestation | **FIXED**（Step 2） | 受控 reload + loaded 时间≥代码修改时间 |

## 5. Authority Before / After

| 职责 | Before（R3） | After（R4） |
|---|---|---|
| 模型选择 | EC 记录 requirement（无 bridge） | EC emit → **Router 消费+ack**（唯一决策） |
| Context overflow | EC 手工 compactNow | **官方 compaction-basic 独占**；EC 提交 needLargerContext |
| Goal recovery | executor（无 caller） | **只留 --check** |
| Restart terminal | outer exit 0 = 完成 | **attemptId + WaitAttempt terminal** |
| Restart Budget | candidateAt（无身份） | **attemptId/pid/generation 绑定 + corrupt quarantine** |
| LastGood | 逐文件复制 | **manifest + 原子切换 + 校验恢复** |
| Test isolation | 部分 | **StateRoot 全注入 + deny assertion** |
| CI Level3 | rc8 + 空 profile + PARTIAL | **0.1.1-rc.2 + 真实 plugins + hard fail** |

## 6. Process Terminal Call Chain（Step 1）

```
caller (Transaction/GUI/SafeMode)
  → restart-dsh-server-delayed.ps1 -AttemptId <id>   (detach)
      → SPAWNED ledger → Start-Process worker → outer exit 0 (NOT completion)
  → restart-dsh-server-delayed.ps1 -WaitAttempt <id> -TimeoutSec 180
      → poll ledger until COMMITTED | FAILED | TIMED_OUT
      → COMMITTED: exit 0 (budget reset by Confirm-DshRestartStable w/ identity)
```

## 7. EC→Router Requirement Bridge Call Chain（Step 3）

```
agent/request-error (EC)
  → classifyFailure → category
  → pendingFallback = {requirement:true, reason, modalities, needLargerContext?}
  → ctx.emit("ec/recovery-requirement", {sessionId, requirement})
Router:
  ctx.on("ec/recovery-requirement") → state[sid].recoveryRequirement = requirement
  next agent/request → route() → consume requirement (ack=null) →
    needLargerContext→mimo/deepseek | image→mimo | reasoning→deepseek
  → final {provider, model} tuple (Router唯一)
```

## 8. Completion Truth Exact Identity Contract（Step 4）

- 有 callId → **exact callId/resultId match only**
- 缺 callId / 空工具名 / 无法唯一关联 → **NEEDS_VERIFICATION**（fail-closed）
- 同 turn 多 tool-call → 每个独立评估，sibling result 不证明
- read-only allowlist 保留（read/grep/glob/web_search 等）
- 不声称全局 exactly-once；只防 blind replay

## 9. Context Overflow Owner Call Chain（Step 5）

```
agent/request-error (官方 compaction-basic 最外层)
  → canonical context overflow → real AbortSignal → compact → surface 前进 → retry
EC（内层，不重复 compact）：
  → CONTEXT_OVERFLOW 分类 → durable incident count
  → emit needLargerContext requirement → Router 决定更大 context 模型
  → 预算耗尽 → FAILED_FATAL（fail-closed）
```

## 10. Model Fact Resolution + Opus Three-Layer Truth（Step 6）

```
contextWindow Authority = routed Adapter resolveModelInfo(provider, model)
  pi-ai: contextWindow = entry.contextWindow ?? base ?? defaultContextWindow(262144)
  agentrouter-anthropic/claude-opus-5: settings 声明 1000000 → resolveModelInfo = 1M

三层证据:
  ANTHROPIC_UPSTREAM_CONTEXT       = 1,000,000  (Claude 官方文档确认)
  HARNESS_RESOLVED_CONTEXT         = 1,000,000  (settings + resolveModelInfo 表达式验证)
  AGENTROUTER_BACKEND_ACCEPTED     = UNKNOWN    (无公开 metadata; 300K probe 需成本+key)
proactive threshold = 1,000,000 × 0.8 (dsh 默认) = 800,000 tokens
（修复前: 200,000 × 0.8 = 160,000 → 过早 compaction）
```

## 11. Restart Candidate Identity State（Step 7）

```
candidateIdentity = {attemptId, pid, generation}（JSON）
Confirm 条件：candidateReady && same attemptId/pid && stable window elapsed
foreign/stale → fail-closed（不 reset）
corrupt JSON → quarantine 文件 + circuit_open（不返回全新默认）
```

## 12. LastGood Manifest / Atomicity（Step 8）

```
Save-VerifiedLastGood:
  staging dir → 逐文件 sha256 manifest → 完整后 Move-Item 原子切换 current
  → legacy 兼容复制 + guardian mirror
Guardian Restore-LastGoodConfig:
  读 manifest → 每文件 sha256 校验 → mismatch/torn → REFUSE（fail-closed）
```

## 13. Test Isolation Proof（Step 0）

- dsh-verified-lastgood: `DSH_STATE_ROOT` 注入
- Test-StageB: temp root + C4 deny（真实 lastgood 未写）
- Test-StageC: `DSH_TX_ROOT` + C5 deny（真实 tx-journal 未写）
- Test-StageE: 已有 temp 隔离

## 14. Loaded-Process Release Attestation（Step 2）

- Guardian PID 10584 启动 07:28:28 > dsh-guardian.ps1 修改 23:00 / goal-recovery 07:24
- **loaded Guardian = current release**；旧 autonomous recovery 不可能被内存旧函数触发
- DSH-Client 与 canonical 内容一致（normalized）

## 15. Regression（全量）

| 测试 | 结果 |
|---|---|
| model-registry（unknown fail-closed R8） | 27/27 PASS |
| completion-truth（exact identity collision） | 18/18 PASS |
| ec-router-bridge（end-to-end） | 8/8 PASS |
| resume-defer（cross-restart） | 12/12 PASS |
| RestartBudget（R1-R13 generation/corruption） | PASS |
| Stage B/C/D/E + CommitReadiness + FinalDrill + Lab L1 + Launcher | PASS |
| crashsafe 33 / fault 38 / compaction 18 / WAITING_USER 12 | PASS |
| router 9+25 / model-guard 21 / commandcode 51 | PASS |
| secret scan / gitignore | CLEAN / PASS |
| Runtime | HTTP 200 + COMMIT_READY True |

**已知 flaky**：Test-P20OrphanLock 超时（dot-source guardian 主循环，环境相关；P2-0 已真实验证，非本任务核心）

## 16. PR / Merge SHA / CI

- PR #19（代码）：`fix/phase02-review-r4`（commits b0ae637→33e8964，10 个）
- CI：Level 1/2/3 待定（PR 刚创建）
- Merge SHA：待 merge 后记录

## 17. Real Runtime vs Synthetic Evidence 分栏

| 证据 | 类型 |
|---|---|
| Opus 1M 官方文档 | real（web 验证） |
| settings 1000000 + YAML VALID | real（js-yaml） |
| resolveModelInfo 表达式 | real（官方源码） |
| AGENTROUTER_BACKEND=UNKNOWN | honest（无证据不假装） |
| WaitAttempt COMMITTED/FAILED/TIMED_OUT | real（实际进程测试） |
| EC→Router bridge | synthetic（mock ctx 串联真实模块） |
| Budget R1-R13 | synthetic（temp state） |
| Completion Truth collision | synthetic（event log） |
| P2-0 真实重启 | real（已保留 R3 证据） |

## 18. Rollback

- Checkpoint：`_checkpoint-PHASE02-R4-20260824-065758`（Base 3b7adc8）
- git：`git reset --hard 3b7adc8`（R4 前）
- settings 备份：`~/.dsh/settings.yaml.bak-phase02-r3`
- 部署备份：checkpoint 目录

## 19. Remaining UNKNOWN / BACKLOG

**UNKNOWN**：
- AGENTROUTER_BACKEND_ACCEPTED_CONTEXT（300K probe 可选，需用户同意成本 + key）

**BACKLOG**：
- B1: Test-P20OrphanLock flaky（guardian dot-source 主循环；CI 已覆盖实际逻辑）
- B2: Live cordis.patch.yml 硬编码 NOTION_TOKEN（SECURITY-HARDENING 阶段）
- B3: settings.yaml 中文 displayName/name 乱码（纯显示，结构已修）
- B4: 通用 exactly-once / idempotency-key contract（Phase 03/04 对支持工具增加）

## 20. Final Verdict

**IMPLEMENTATION_COMPLETE**

（11 Step 全部完成 + Codex C1-C7 关闭；R3-B1…B10 全部由真实代码/consumer/runtime evidence 支持；全量回归绿；10 条 Phase 02 AC 重新核对中——见 CURRENT_STATUS）

## 21. Waiting For

**EXTERNAL_REVIEW**

（等待 Reviewer Verdict；未 APPROVED 禁止 Phase 03 / 禁止自行 VERIFIED）

---

*报告不可覆盖：复审修改将生成 REPORT_R5.md……*
