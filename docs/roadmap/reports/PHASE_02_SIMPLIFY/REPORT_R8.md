# PHASE_02_SIMPLIFY — REPORT_R8

> Phase 02：SIMPLIFY / Architecture Consolidation + Reliability P2 — Round 7 + Post-PR24 Follow-up 修复
> 日期：2026-08-24 ｜ 执行：Harness Master Orchestrator
> 报告路径：docs/roadmap/reports/PHASE_02_SIMPLIFY/REPORT_R8.md
> 前置：REPORT_R1/R2/R3/R4/R5/R6/R7（不覆盖）

---

## 1. Reviewer Verdict & 修复范围

**Reviewer Verdict：CHANGES_REQUIRED**（Round 7 Review 4 项 + Post-PR24 Follow-up 复核，两项直接反证 R7 的"真实 generation / runtime capacity 已接通"结论）
**R7 确认的真实进展（保留）**：PR #23 + PR #24 merged；Guardian exact restart + boot grace + budget gate；LastGood canonicalSetId；async capacity 契约（PR #24 关闭）；legacy migration；schema2 no-migrate。

**本轮 R8 全部完成**：5 个剩余 blocker（R8-1…R8-5）逐项关闭，关键真实 runtime gate 通过。

## 2. Baseline

| 项 | 值 |
|---|---|
| Base Commit | `7fd5b0f`（PR #24 merge 后 main） |
| 修复分支 | `fix/phase02-review-r8`（commits） |
| 保留 | R7 + PR24 已验证成果（禁止重做） |
| DSH 版本 | 0.1.1-rc.2 |

## 3. R8-1 真实 per-boot generation（Close）

**Reviewer**：EC 用 `entryHash` 当 generation——entryHash 是 **executable PATH identity**（SHA256 of DSH entry path），跨 restart 不变；真正的 generation 是 `Get-DshGenerationId`（StartTime.Ticks_PID，每次 boot 变）；`proc:${processStartMs}` fallback 把 plugin reload 当新 generation。
**修复**：
- serverGeneration = runtime ledger 的 **childPid + startedAt**（`boot:${childPid}_${bootMs}`）——与 Get-DshGenerationId 同构（PID + boot 时间戳 = per-boot、plugin reload 不变）
- **禁 entryHash / Date.now / plugin-start fallback**——ledger 读不到 → null → LIVENESS_UNKNOWN（fail-closed，bounded recheck），不再走 grace-RUNNING 死循环
**真实验证**：
```
restart 前: boot:27424_1787566974368
restart 后: boot:29732_1787583711934（新 server PID + 新 boot 时间）→ 变化 ✅
再 restart: boot:28732_1787584603246（又变）✅
```
3 次真实 restart generation 每次变化（R8 Final Gate #1 达成）。

## 4. R8-2 单一恢复尾 resumeAfterCtClean（Close）

**Reviewer**：ctGatedRecovery CT clean 后先写 RUNNING 再 goal.resume，失败只 log 仍 RUNNING（无 prompt fallback / 无 due-state）；timer listDue 不处理 RUNNING → zombie 永久停；不得第二套半恢复路径。
**修复**：
- 抽 **`resumeAfterCtClean(sessionId, it, reason)`** 为正常恢复与 liveness **共用的单一恢复尾**：
  - goal.resume（带当前 revision）成功 → goalActive
  - goalRef 缺失 / goal.resume 抛错 → **session.prompt（queue kick）fallback**
  - **仅当 kick 被接受（goal.resume OK 或 queue 成功）→ RUNNING**（含 liveness 基线重置）
  - **kick 失败 → durable WAITING_PROVIDER + nextRetryAt**（timer listDue 重驱）——绝不失败仍 RUNNING
- ctGatedRecovery = runCtGate（CT 决策）+ resumeAfterCtClean（恢复尾），无重复算法
**验证**：**T11 生产-path fault test**（直接驱动真实 resumeAfterCtClean）：success / goal.resume throws+prompt OK / prompt FAIL→durable WAITING_PROVIDER+nextRetryAt / no goalRef+prompt OK / **store reload（跨重启 durable due-state 保持）**——r5-addendum 40/40 PASS（R8 Final Gate #2 达成）。

## 5. R8-3 Live Exact-Route Capacity（Close — 反证 R7 结论的最关键修复）

**Reviewer**：r5-runtime-truth 用 defaultCapacityResolver 输出 registry hints，不是 live ctx.llm.resolveModelInfo 结果；R7 adapter 同步读 async 方法（PR #24 已修契约但 wiring 仍可能未真接通）。
**修复（真实调用链追踪发现新缺陷）**：
- `makeRuntimeCapacityResolverLoose`：`ctx.get(key)` 对未知 key **抛错会中止整个循环**（try 包住整个 for）→ 即使 `ctx.llm.resolveModelInfo` 存在也 wired=false。**修复：每个 key 独立 try**。
- EC boot 用 adapter 接 ctx.llm 探测真实容量写入 loaded-release.json + diag
**真实验证（3 次真实 restart 迭代）**：
```
第一次: CTX-LLM type=LlmRuntime resolveModelInfo=function 但 wired=false（ctx.get 抛错 bug）
修复后: LIVE-CAPACITY wired=true
  commandcode/deepseek-v4-flash: ctx=1000000 source=runtime   ← 官方运行时！
  opencode/deepseek-v4-flash:     ctx=1000000 source=runtime
  openrouter/qwen3.7-flash:       ctx=1000000 source=runtime
```
**重大发现**：官方 runtime 解析 CommandCode DeepSeek contextWindow = **1000000（1M）**，而 registry hint = **1310720**——**hint 高估容量**，之前 Router 基于 hint 决策可能错误；现在 **runtime 是权威**（R8 Final Gate #3 达成：live source=runtime）。
**长会话 CommandCode↔OpenCode 切换**：live capacity 已证明 runtime 源真实工作；切换的代码路径由 test-runtime-capacity-adapter T5 + bridge 14/14 覆盖（Router/CommandCode await resolve）。真实长会话中途切换需运行中用户会话，**诚实标注为 Reviewer 环境可执行项**（不在本回合伪造）。

## 6. R8-4 Attestation 完整（Close）

**Reviewer**：activePlugins 漏 runtime-capacity-adapter（最关键新插件）；loaded manifest 需绑定真实 per-boot generation；mismatch fixture 必须 FAIL。
**修复**：
- activePlugins 纳入 **runtime-capacity-adapter**（8 插件全）
- 新 **`r8-attestation-check.mjs`** 严格 3-way gate：manifest 存在 + serverGeneration（真 per-boot）+ 全部 active plugin source==deployed==loaded，缺任一/任一 mismatch → **FAIL exit 1**
**真实验证**：
```
3-way ALL MATCH 8/8（含 runtime-capacity-adapter），gen=boot:28732_1787584603246
mismatch fixture（篡改 vision-bridge）→ FAIL exit 1；还原 → PASS
```
（R8 Final Gate #4 达成：包含 adapter + true generation + mismatch FAIL。）

## 7. R8-5 杂项（Close）

- **-Reason 传 worker**：restart-dsh-server-delayed.ps1 `$inner` 构造加 `-Reason`（attempt ledger 记录真实原因，不再落成 delayed-restart）
- **清 stale finally**：Guardian Restart-Server finally 不再引用未定义 `$restartLock`
- **文档计数**：PR #23 = **6 commits**（CURRENT_STATUS 修正）；CURRENT_STATUS 更新到 R7+PR24 partial closure / R8 pending

## 8. 已确认 PASS（R8 禁止重做）

- PR #23（6 commits）+ PR #24 merged；L1/L2/L3 CI 绿
- Guardian 外层不持 mutex；重复 Register-DshRestartAttempt 已删
- 真实 Guardian-style restart COMMITTED + boot grace
- LastGood required-set/canonicalSetId/stale 拒绝
- legacy migration / schema2 no-migrate / Completion Truth exact callId
- compaction 0.6/0.2/32768；async capacity 契约（PR #24）

## 9. Real vs Synthetic Evidence 分栏

| 证据 | 类型 |
|---|---|
| per-boot generation 3 次真实 restart 全变（boot:27424→29732→28732） | real |
| LIVE-CAPACITY wired=true + source=runtime（官方 ctx.llm.resolveModelInfo） | real |
| runtime 容量 1M vs registry hint 1.3M（hint 高估被发现） | real |
| 3-way attestation 8/8 ALL MATCH + mismatch FAIL | real |
| attempt COMMITTED ×3（含 R8 代码加载重启） | real |
| resumeAfterCtClean fault test（T11 8 项） | synthetic（生产模块+真实 fetch mock） |
| adapter ctx.get 抛错隔离修复 | synthetic + 真实 CTX-LLM 诊断 |

## 10. PR / CI / Merge SHA（已回填，不留 pending）

- **PR #25（代码+报告）**：`fix/phase02-review-r8`
- CI：Level 1/2/3 **全部成功**（Static 59s / Reliability 1m40s / Boot smoke 4m14s）
- Merge SHA：**`8fe679e0`**（2026-08-24 merged）

## 11. Regression（全量）

| 测试 | 结果 |
|---|---|
| RestartBudget R1-R18 / StageB C1-C7 / StageC/D/E / FinalDrill / Lab 9 | PASS |
| model-registry 33 / CT 18 / resume-defer 12 / r5-addendum 40（含 T11）/ capacity 6 / adapter 13 | PASS |
| ec-router-bridge 14 / crashsafe 33 / fault 38 / compaction 18 / WAITING_USER 12 | PASS |
| router 9+25 / commandcode 51 / r8-attestation-check 12/12 + mismatch FAIL | PASS |

## 12. Rollback

- Checkpoint：`DSH-Client\_checkpoint-PHASE02-R8-20260824-211758`（Base 7fd5b0f）
- git：`git reset --hard 7fd5b0f`（R8 前）

## 13. Remaining UNKNOWN / BACKLOG

**UNKNOWN**：
- AGENTROUTER_BACKEND_ACCEPTED_CONTEXT（300K probe 需成本+key）
- 长会话 CommandCode↔OpenCode 中途切换的真实运行证据（需运行中用户会话；代码路径已测，live capacity 已证明 runtime 源）

**BACKLOG**：
- Test-P20OrphanLock flaky（guardian dot-source 主循环）
- Live cordis.patch.yml 硬编码 NOTION_TOKEN（SECURITY-HARDENING 阶段）
- settings.yaml 中文 displayName 乱码（显示级）

## 14. Final Verdict

**IMPLEMENTATION_COMPLETE**

（5 个剩余 blocker 全部关闭；真实 runtime gate 通过：per-boot generation 变化 / resumeAfterCtClean 终态 / live capacity source=runtime / 3-way ALL MATCH + mismatch FAIL；全量回归绿）

## 15. Waiting For

**EXTERNAL_REVIEW**

（等待 Reviewer Verdict；未 APPROVED 禁止 Phase 03；Phase 03 入口仍先执行 Security-Hardening gate）

---

*报告不可覆盖：复审修改将生成 REPORT_R9.md……*
