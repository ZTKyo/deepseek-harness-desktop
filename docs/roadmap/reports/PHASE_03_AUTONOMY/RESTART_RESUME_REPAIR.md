# P3 AUTONOMY R1 — 重启自动恢复：根因修复报告（E2B 确定性腿 + CT 持久事件回退）

日期：2026-08-30 ｜ 关联：GAP_AUDIT_R1.md、P3_R1_RESTART_CHECKPOINT.md、e2e/E2B-*.json

## TL;DR

重启自动恢复（boot scan → CT → RESUME-OK）的 happy path 此前**从未真正工作过**。
根因不是"kill 竞态/脏历史"，而是 CT 取事件的唯一来源是**内存会话注册表**：
重启后任何未被重新打开的会话都不在内存 → `session events unavailable` →
6 次 bounded defer 超限 → 永久钉死 NEEDS_VERIFICATION。修复：CT 内存未命中时
回退 **loopback API 的持久事件日志**（session.history 冷读，contiguous raw event
range，含 tool-call/tool-result 记录）。修复后确定性 E2E 腿 E2B 7/7 全绿，
三套单测无回归。

## 证据链（全部来自真实运行）

### 1. 旧 E2 腿 8 次 run 的重新解释

- run4/6/7 的重启后 pin（NEEDS_VERIFICATION, autoResumeCycles=0）此前被假设为
  "在途未闭合工具调用被 kill 切断（脏历史）"。E2B 腿用**确定性预置**证伪了该假设：
  种子回合 CT=clean（58 事件，E2B.0 PASS）→ 干净停机 → 离线注入官方 RUNNING intent
  → 重启后 CT 仍然报 `session events unavailable`（6 次 defer → pin）。
  **历史为干净也会被钉死** → run4/6/7 的 pin 全部同因，竞态假设不成立。
- run7/8 模型幻觉"阶段2完成"（假里程碑/假 file_hash PASS/goal complete）→
  意图 COMPLETED → 无恢复。这是 F1（执行者自证）在 goal 完成层的真实半径，
  记录在案（R2 候选：宿主侧独立复核 file_hash/system_api 证据），不属于本修复范围。

### 2. 根因定位（代码级）

`plugins/execution-continuity.mjs` `completionTruth()`（原 595-613 行）：

```js
const session = ctx.sessions?.get ? ctx.sessions.get(sessionId) : null;
if (!session || !Array.isArray(session.events)) { ... return evidence_unavailable; }
```

`ctx.sessions` 是**内存注册表**；web 服务重启后按需加载会话，boot scan 在启动后
约 5 秒运行时**没有任何会话在内存**。而 `session.history` 的 API 合同
（dsh-host-apiproxy README）明确支持"inspects a cold log through persistence
without resuming or publishing an Agent"，返回 contiguous raw event range
（含工具记录；E2.9 诊断 tool-record mentions=3 为正面证据）→ 可安全用作 CT 事件源。

### 3. 修复（最小、可回退）

`completionTruth()`：内存事件**优先**（行为不变），未命中时
`apiRpc("session.history", { sessionId, maxMessages: 4000 })` 冷读持久日志 →
同一 `evaluateCompletion` 判定；任何错误仍走原有 fail-closed bounded defer。
诊断行标注事件来源：`(in-memory, N events)` / `(persisted-log fallback, N events)`。
备份：`plugins/execution-continuity.mjs.bak-p3r2-ctfallback`。

### 4. E2B 确定性腿（tests/autonomy/run-autonomy-real-e2e.mjs 新增，P3R1_LEGS=E2B）

把"阶段1"从模型关键路径移除（只预置"任务进行中被杀"先验状态本身，其余全真实）：
良性种子回合 → 停机 → 运行器写**官方 IntentStore**（RUNNING + schema v3 autonomy
VERIFIED 块）→ 重启 → boot scan 自动恢复。运行 3 次：

| run | 结果 | 关键证据 |
|---|---|---|
| 1（修复前） | E2B.0 PASS；重启后 6 次 defer → pin，恢复未发生 | EC log: `session events unavailable` ×6 |
| 2（修复后） | 6/7 PASS，仅诊断行读源错（读 instLog 而 web 模式 stdout 近空） | EC log: `CT -> clean (persisted-log fallback, 58 events)` + `RESUME-OK ... cycles=1` |
| 3 | **7/7 PASS**（E2B.0-6） | `SCAN restart: 1 recoverable intent(s)` → `CT -> clean (persisted-log fallback, 51 events)` → `RESUME-OK cycles=1`；恢复消息含 Verified progress/checkpoint/no-redo；autonomy 块跨重启逐字节一致；副作用文件 content+mtime 恰好一次 |

### 5. 回归

- `tests/continuity/verify-execution-continuity.mjs`：15 PASS / 0 FAIL
- `tests/autonomy/test-autonomy-state-core.mjs`：54 PASS / 0 FAIL
- `tests/autonomy/test-ec-autonomy-deployed.mjs`：32 PASS / 0 FAIL
- 旧 E2 腿保留（模型依赖型，已知脆）；E2B 为确定性回归腿。

## 结论

- 重启自动恢复 happy path 修复并验证（确定性 E2E + 诊断行正面证据）。
- 遗留（不阻塞）：F1 证据自证半径（R2 宿主侧复核候选）；WAIT-GATE 不变量
  （真实 question/requested 阻断恢复）未受影响，本轮未触碰。
