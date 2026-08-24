# PHASE02_R9_RUNTIME_GATES — Runtime Gate Evidence（只读证据文档）

> Phase 02 Round 9 两个最终真实 gate 的可审核证据（R10-3 补提交）
> 创建：2026-08-25 ｜ 归属：REPORT_R9 / REPORT_R10
> 敏感信息：本文件不含任何 secret / raw key / token（session/goal/intent id 已脱敏为短前缀）

---

## 1. Gate A：真实长会话 Provider Switch（CommandCode → OpenCode）

**Reviewer 要求**：Runtime exact route truth，不接受 alias 猜测；pre-switch 明确
`provider=commandcode, model=deepseek/deepseek-v4-flash`；post-switch `provider=opencode,
model=deepseek-v4-flash`；两侧 source=runtime；compaction 不变；Goal/EC progress 连续；无人为"继续"。

**关键事实（R9 复核发现）**：R9 当时用的 `bai` 是 **B.AI**（baseURL `https://api.b.ai/v1`），
**不是** CommandCode（baseURL `https://api.commandcode.ai/provider/v1`）——R9 的 bai→opencode
不满足 Reviewer 的 commandcode→opencode 要求。R10 重新用真实 commandcode 执行。

### 时间线（2026-08-25）

| 时刻 | 事件 | 证据 |
|---|---|---|
| pre-switch | settings.yaml `provider: commandcode, model: deepseek/deepseek-v4-flash`；重启加载 | host.describe → `provider=commandcode model=deepseek/deepseek-v4-flash` |
| pre-switch capacity | loaded-release.json | `source=runtime wired=True`；`commandcode/deepseek/deepseek-v4-flash ctx=1000000` |
| pre-switch generation | loaded-release.json | `boot:20572_1787595237255` |
| post-switch | settings.yaml `provider: opencode, model: deepseek-v4-flash`；重启加载 | host.describe → `provider=opencode model=deepseek-v4-flash` |
| post-switch capacity | loaded-release.json | `source=runtime wired=True`；`opencode/deepseek-v4-flash ctx=1000000` |
| post-switch generation | loaded-release.json | `boot:30840_1787595405158` |

**exact route truth（runtime resolveModelInfo 官方解析，非 alias）**：
```
pre-switch:  { provider: commandcode, model: deepseek/deepseek-v4-flash, contextWindow: 1000000, source: runtime }
post-switch: { provider: opencode,     model: deepseek-v4-flash,         contextWindow: 1000000, source: runtime }
```
- 两侧 `source=runtime`（官方 ctx.llm.resolveModelInfo 真接线，wired=True）
- **active compaction 不变**：thresholdRatio=0.6 / retainRatio=0.2 / maxTokens=32768（未改配置）
- **EC intent / Goal progress 连续**：切换全程 intent state=RUNNING（session-9e3b…），goal 持续推进
- **无人为"继续"**：两次重启后 EC 均自动 RESUME-OK（timer 驱动，见 §3 日志）

## 2. Gate B：最终无人为输入 Restart Auto-Resume

**Reviewer 要求**：pre-restart 状态 → exact restart COMMITTED → new generation →
grace due recheck → automatic resume/progress → LIVE-CAPACITY wired=true/source=runtime；
时间线 + 日志摘要提交；人工唤醒不算 PASS。

### 时间线（R9-4 最终 gate，2026-08-24/25）

| 时刻 | 事件 | 证据 |
|---|---|---|
| pre-restart | intent: RUNNING, autoResumeCycles=10（=cap），gen=（旧版未写） | execution-intents.json |
| restart | `restart-dsh-server-delayed.ps1 -RestartAndWait -Reason r9-final-gate` | attempt（见 ledger） |
| new generation | serverGeneration 变化 | `boot:29444_1787592321316` |
| boot scan | EC recoverableScan 发现 RUNNING intent | log: `SCAN restart: 1 recoverable intent(s)` |
| budget reset | **R9-4 修复**：新 generation 重置 autoResumeCycles | log: `RESUME-BUDGET-RESET ... new generation resets autoResumeCycles 10->0` |
| CT gate | Completion Truth clean | log: `CT sid=... -> clean` |
| auto resume | goal re-armed + prompt queue 成功 | log: `RESUME sid=... goal re-armed (timer)` / `RESUME-OK ... goalActive=true cycles=1 (timer)` |
| capacity | LIVE-CAPACITY wired=true source=runtime | loaded-release.json |

**关键 EC log 行（脱敏）**：
```
17:25:32 RESUME-BUDGET-RESET sid=session-9e3b… new generation (boot:29444_…) resets autoResumeCycles 10->0
17:26:51 RESUME sid=session-9e3b… goal re-armed (timer)
17:26:51 RESUME-OK sid=session-9e3b… goalActive=true cycles=1 (timer)
```

**人工输入判定方法**：
- 判定标准：restart 后**无人点击 GUI 暂停/开始按钮**、无人发送"继续"消息；恢复由 EC 定时器
  （timer）驱动（log 中 `(timer)` 后缀证明）
- 实际结果：**用户确认未点击任何按钮，页面刷新后任务自动运行**（用户原话："
  是重启，我没有点开始按钮，它是在页面刷新过后自动开始运行的"）
- 与 R9 早期一次 restart 对比：那次因 budget 耗尽需手动恢复（FAILED），R9-4 修复后自动成功

## 3. R10 补充：真实 exact CommandCode→OpenCode（本文件 §1 的日志佐证）

R10-2 执行期间 EC 自动恢复日志（2026-08-24T18:1x）：
```
18:16:55 CT sid=session-9e3b… evidence unavailable -> bounded defer #1
18:18:10 CT sid=session-9e3b… -> clean
18:18:13 RESUME sid=session-9e3b… goal re-armed (timer)
18:18:13 RESUME-OK sid=session-9e3b… goalActive=true cycles=1 (timer)
```
（两次 provider 切换重启后均自动恢复，无人为输入）

## 4. Identifiers（脱敏摘要）

| 实体 | 脱敏 id |
|---|---|
| 会话 | session-9e3b29bb… |
| Goal | goal-6fd48ae4…（R9/R10 目标） |
| Intent | session-9e3b29bb 对应 intent（state=RUNNING） |
| 服务器 generation（多次） | boot:29444_… / boot:20572_… / boot:30840_… |
| 本文件 | docs/roadmap/evidence/PHASE02_R9_RUNTIME_GATES.md |

## 5. 不含 secret

本文件只含 id 前缀、generation、attempt 状态、capacity tuples、EC log 摘要。
**不含任何 API key / token / Authorization header / raw credential**。
