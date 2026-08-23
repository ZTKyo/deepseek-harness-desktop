# HARNESS_P1_RELIABILITY_HARDENING_REPORT_20260823

- 日期：2026-08-23（无人值守）
- 任务：P1 Reliability Hardening（上一轮只读审计后的定向修复）
- 范围：严格只处理 P1-A / P1-B / P1-C，不处理其他 P2，不改 ACL，不升级，不改 Router/Guard

---

## 1. Executive Summary

三个 P1 全部修复并 Runtime 验证：

- **P1-A** WAITING_USER 保护真实接入生产恢复路径（checkUserWaitGate 统一 gate，fail-closed）
- **P1-B** execution-continuity CONTEXT_OVERFLOW 改为 agent-scoped compaction 获取（修复假 DEGRADED，移除全局缓存）
- **P1-C** notify sidecar 加载修复代码 + **发现并修复真实 reconnect 卡死 bug**（single-flight reconnect）

集成回归 98+21+3+8 = 130 断言全 PASS，Server 稳定 595s+，NEW_LOCAL_GOLDEN_P1_HARDENED 建立。

**Verdict: SUCCESS**

## 2. Baseline

| 项 | 值 |
|---|---|
| dsh version | 0.1.1-rc.2 |
| backend PID | 10428（start 08:35:19，重启加载 P1 修复） |
| execution-continuity | ACTIVE（enableAutoResume=true） |
| notify sidecar | 旧 PID 18064（旧代码）→ 新 PID 17440（修复代码） |
| restart budget | attempts=0（健康，未触碰） |
| Guardian | 未修改 |

## 3. P1-A — WAITING_USER

- **Previous bug**（审计 CONFIRMED）：hasPendingQuestion 只在定义+测试导出，生产恢复路径从未调用；
  goal/changed 从不设置 WAITING_USER；有未回答提问的 active goal 重启后会被当 RUNNING 恢复
- **Exact production path**：resumeViaApi（所有恢复入口汇聚点）→ recoverableScan → goal/changed → turn-end 补位
- **Fix**：新增 `checkUserWaitGate(sessionId, it, reason)`——ctx.sessions.get 拿真实 session（含 events）
  → hasPendingQuestion → true 则 state=WAITING_USER + autoResume=false + 跳过；**fail-closed**（sessions
  服务不可用/判断抛错 → 保守跳过）。接入 resumeViaApi 开头 + recoverableScan 预检 + goal/changed
  （active 时检查 pending question）
- **Runtime evidence**：W1-W6 12 PASS（真实 schema）；Server 重启后 gate 生效（intent 保持 RUNNING
  对正常 session 无干扰；pending-question session 会被拦）
- **Server restart behavior**：WAITING_USER 持久化（intent store），重启后不进 recoverable set，不自动插入"继续"

## 4. P1-B — Compaction Scope

- **Host ctx result**：compaction=UNAVAILABLE（realm 隔离，host 层看不到）
- **Agent ctx result**：compaction=available（autonomous preset L423-444 在 isolated realm 挂载
  compaction-basic，CompactionEngine extends Service，agent scoped ctx 可见）
- **Exact service scope**：preset realm `isolate: { compaction: true }` → 仅 agent.ctx 可访问
- **Fix**：getCompaction(ctx, agent) 优先 agent.ctx（get/read/属性，try/catch），回退 host ctx；
  **移除模块级 _compactionCache 全局缓存**（per-agent 可用性独立）；CONTEXT_OVERFLOW 分支传 agent
- **CONTEXT_OVERFLOW runtime test**：C1-C5 15 PASS（agent lookup / compactNow 调用 / unavailable
  fallback / throw 隔离 / 多 agent 无污染）
- **Fallback behavior**：agent 无 compaction → COMPACTION_UNAVAILABLE → larger-context fallback，
  Host 存活；compactNow throw → 隔离，仍 retry
- **不变量**：compaction 仍 optional/lazy/agent-scoped/fail-open（未重声明 boot hard dependency）

## 5. P1-C — Notify Sidecar

- **Old PID**：18064（01:33:52 启动，旧代码无 reconnect 修复）
- **New PID**：17440（08:41:55 启动，修复代码）
- **真实 bug 发现**：旧修复（onerror 主动 close）在 server 重启场景**仍卡死**——实测 08:35 server
  重启后 sidecar 无 OPEN、无重试日志、CPU 空闲；根因：Node 22 原生 WS 的 error 后 close() 不保证
  触发 onclose → 重连循环停在 onerror
- **Fix**：single-flight reconnect（scheduleReconnect + reconnectTimer），onerror 直接调度重连
- **Reconnect**：新 sidecar 验证 websocket OPEN + 事件流恢复（notify log 持续更新）
- **Log update**：notify-events.log 从 02:02（旧卡死）恢复实时（08:41+ 持续）
- **Rotation**：安全测试 PASS（3 generations bounded + main 重建）

## 6. Files Changed

| path | change | reason | risk | rollback |
|---|---|---|---|---|
| ~/.dsh/profiles/web/execution-continuity.mjs | +checkUserWaitGate（WAITING_USER）；getCompaction agent-scoped；去全局缓存；CONTEXT_OVERFLOW 传 agent | P1-A/B | 低（全防御性） | checkpoint 恢复 |
| ~/.dsh/profiles/web/execution-continuity-crashsafe-test.mjs | 正则 400→600 | 测试模式容忍 gate 插入 | 无 | — |
| DSH-Client/dsh-event-notify.mjs | single-flight reconnect（onerror 直接调度） | P1-C 真实 bug | 低 | checkpoint 恢复 |

## 7. Official Core Modified

**NO**（未修改任何 node_modules/@deepseek-ai/dsh/**）

## 8. Regression Matrix

| 项 | 结果 |
|---|---|
| Execution Continuity crash-safe | 33 PASS |
| Execution Continuity fault-injection | 38 PASS |
| WAITING_USER gate | 12 PASS |
| Compaction scope | 15 PASS |
| Model Selection | 21 PASS |
| lastReal | PASS |
| ask-telegram | 3 PASS |
| verify-execution-continuity | 8 PASS |
| Notify | 新 sidecar OPEN + 事件流恢复 + rotation PASS |
| Guardian | 未修改，正常 |

## 9. Server Stability

| 项 | 值 |
|---|---|
| PID | 10428（08:35:19） |
| uptime | 595s+ 且持续 |
| 180s | PASS |
| 300s | PASS |
| health | / 200；host.describe OK；session.list OK（326）；events.mux/host OPEN |

## 10. Golden

- old：NEW_LOCAL_GOLDEN（0.1.1-rc.2 base）
- new：**NEW_LOCAL_GOLDEN_P1_HARDENED**（含 P1 修复后全部关键文件 + manifest + hashes）
- rollback：P1_RELIABILITY_HARDENING_PRE_FIX checkpoint（修复前文件）或新 golden 回拷

## 11. Deferred Findings（本轮不处理，保留）

- P2: Router/EC 双 Authority、RESUME-DEFER nextRetryAt、budget reset 语义、MODEL_CONTEXT_WINDOWS
  hardcode、fallback reasoning capability、vision whitelist、golden 缺 DSH-Harness-PS.ps1、
  goal-recovery ledger 增长、插件 apply() 全局 crash-safe 改造
- 安全: CodexSandboxUsers ACL（SECURITY_REVIEW_REQUIRED，未修改）

## 12. 不变量验证

- A. 等待用户的问题 → 永不自动恢复（WAITING_USER gate）✓
- B. Context Overflow → agent-scoped compaction 优先 → 缺失降级 → 不影响 boot ✓
- C. Notify 自己挂掉 → 不影响 DSH Host（独立 sidecar，single-flight 重连）✓
- D. Execution Continuity 出错 → 不拉进 crash-loop（fail-open 保持）✓

---

## Final Verdict: **SUCCESS**

- WAITING_USER 真实生产恢复保护 PASS
- Agent-scoped compaction recovery PASS
- Notify sidecar 新代码运行 + reconnect PASS（含 single-flight 修复）
- 回归 130 断言全 PASS
- Server 稳定 595s+（>300s 目标），无 crash-loop，Guardian 无异常重启
