# P4 R2 · STAGE 2 验证报告：Ground Truth Schema 锁 + 能力缺口负例/正例锁

> 时间：2026-09-25（全部数值为本次**实测**，非转录旧报告）
> 套件：`tests/learn/test-learn-stage2-schema-and-negative-lock.mjs`
> 结论：**23 PASS / 0 FAIL**；全量回归 **20 套件全绿 / 722 PASS / 0 FAIL**
> 性质：本文件是"**事实台账**"，不是进度汇报。凡是数值都可用 `_diag-s2-*.mjs` 复算。

---

## 0. 一句话结论

R2 的学习链路（能力缺口判定）**依赖一批"官方字段路径"**。本阶段把这些路径从"我以为"
升级为"**实测锁定**"：真实会话 560 条 tool/call、625 条 tool/result 上，官方字段命中率 100%；
并修掉了一个**让否决动作完全不可见**的根因（遥测白名单静默丢弃），使"不产出候选"这一行为
第一次**有证据可查**。

---

## 1. 唯一权威事实（实测，可复算）

样本：真实会话日志中**含工具事实**的会话 12 个（候选池 12）。

| 事实 | 实测值 | 备注 |
|---|---|---|
| `tool/call` 事件 | **560** 条 | |
| ├ `data.callId` 命中 | **560 / 560** | 官方配对键 |
| ├ `data.name` 命中 | **560 / 560** | 工具身份 |
| └ `data.arguments` | **560 / 560**，**类型 = string** | 是 JSON **字符串**，不是对象 |
| `tool/result` 事件 | **625** 条 | |
| ├ `data.message.source.kind === 'tool'` | **625 / 625** | |
| ├ `data.message.source.callId` | **625 / 625** | |
| ├ `content[0].type === 'tool-result'` | **625 / 625** | |
| ├ `content[0].isError` 为布尔 | **625 / 625** | 唯一失败判据（结构化，不用关键词） |
| └ `content[0].toolCallId === source.callId` | **625 / 625** | 配对一致性 |
| `isError === true` | **28** 条 | 真实失败 |
| ├ 带结构化 `error.code` | **26** 条 | 码级判定基础 |
| └ **完全没有 `error` 键** | **2** 条 | data 仅 `{message, step, turn}` |
| `isError === false` 却带 `error.code` | **0** 条 | 不变量成立 |
| 工具事件落在 surface 节点 seq 上 | **0 条** | 历史死路径根因（观察面必须是事件范围） |
| `seq > max(nodeSeq)`（观察上界外） | `tool/call` **1** 条 | 按设计不提取 |
| `MAX_TOOL_FACTS` | **256** | `calls`/`successes`/`failures` 各自上限 |
| 提取器汇总 | calls **559/559**、failures **28/28**、successes **596**、unresolved **15** | 逐会话精确相等 |

---

## 2. 认知偏差台账（我错在哪 · 为什么 · 以后禁止怎么想）

> 这是本阶段**最有价值的产物**：以下每一条都曾让我写出"看起来合理但事实错误"的断言。
> 后续任何涉及真实 schema 的工作，先读本节。

| # | 我的假设（错） | 实测真相 | 后果（若未纠正） |
|---|---|---|---|
| 1 | `data.arguments` 是**对象** | 是 **JSON 字符串**（560/560） | 断言必红，且会误判"字段漂移"去改不该改的代码 |
| 2 | 提取器返回 `{calls, failures, successes, results}` | **没有 `results`**，只有前三者 | `o.results.length` 抛错 / 恒 0 → 假红或假绿 |
| 3 | `calls` 是"**有效才入表**" | 是"**出现即记**"（`callId` 空也 push） | 对照实验断言条数归零 → 恒假红；真正的后果链被漏掉 |
| 4 | `failures >= 真实值 50%` 算合格 | 必须**逐条精确相等**（28/28） | 宽松断言会放过"漏读一半失败"的静默缺陷 |
| 5 | `isError=true ⇒ 必有 error 对象`（当成不变量） | **2/28 例外**（无 error 键） | 假红；且会诱使把合法数据当"退化"去修 |
| 6 | 提取条数比全量少 1 = **bug** | 是**观察上界设计**（`seq > max(nodeSeq)` 不提取） | 会把正确设计当缺陷"修坏" |
| 7 | 4 个不同错误码各 1 次，应留 `VETOED` 痕迹 | 每签名 count=1 < 阈值 2 ⇒ **到不了闸门**，走 `OBSERVED` 可见路径 | 用例设计错误 → 假红；且掩盖了真正的可见性语义 |

**方法论固化**：
- 断言真实 schema 前，**先测**（`_diag-s2-schema-truth.mjs`），不靠记忆和推理；
- 区分"**我期望的形状**"与"**系统真实的形状**"，只锁后者；
- 对照实验（差分锁）必须锁**后果链**，且必须有基线正例，否则是恒真式。

---

## 3. 根因：否决留痕被**同一个**静默丢弃机制吞掉（本阶段最深的坑）

### 现象
N8 端到端用例"网络超时 3 次不得产出候选"**通过**了，但遥测里**只有 `CAPABILITY_GAP_OBSERVED`，
没有 `CAPABILITY_GAP_VETOED`**——即"否决发生了"这件事**没有任何证据**。

### 根因（逐层查证，非猜测）
1. `learn-core.mjs` 的 `telemetryEvent()` 用 **`TELEMETRY_KINDS` 白名单**校验 `kind`；
2. `CAPABILITY_GAP_VETOED` **不在名单里**（全文件出现 0 次）⇒ 返回 `{ok:false, error:'invalid_telemetry_kind'}`；
3. `learn.mjs` 的 `tel()` 在 `!ev.ok` 时 **`return stores.get(sid)`** —— 直接返回、**不追加**；
4. 即使写进去，`learn-core.mjs` 的 store 净化器（`TELEMETRY_KINDS.includes(t.kind)`）也会在重载时**再次丢弃**。

### 讽刺点（值得记住）
我为"**防止否决静默**"而加的留痕，被**同一个静默丢弃机制**吞掉了；
而这正是该文件注释里**已经记录过**的历史缺陷类型（"标题里的 FAIL 字样被算成失败"同类问题：
**判定口径本身没被验证**）。

### 修复
`plugins/learn-core.mjs`：把 `'CAPABILITY_GAP_VETOED'` 追加进 `TELEMETRY_KINDS`（能力缺口面）。
**安全性论证**：全部使用点均为 `.includes()` 或遍历（`test-learn-core.mjs` 的
"summary includes kind" 断言要求每个 kind 都出现在计数里），**无顺序/长度依赖**，追加即可。

### 验证
| 用例 | 锁什么 |
|---|---|
| `N8-b` | 单一非能力签名（网络超时 ×3）→ 必须有 `VETOED` 且原因可读 |
| `N9-b` | **多签名**（凭据失败 ×2 + provider 中断 ×2）→ **每个签名各自留痕**，且 detail 含两个码 |
| `N9-c` | 低于阈值（1 次）→ 无候选，但**必须可见**（`OBSERVED` 或 `VETOED`），不得全静默 |
| `test-learn-core`（328P） | 每个 kind 都必须出现在遥测摘要计数中 |

---

## 4. 测试设计教训（工程纪律）

1. **汇总行格式必须匹配回归跑的摘要正则**：`run-learn-all-tests.mjs` 只认三种格式
   （`N PASS / M FAIL`、`N pass, M fail`、`PASS = N FAIL = M`）。用了别的写法，**全绿套件会被判
   `NO-SUMMARY` ⇒ FAIL**（本阶段实际踩到，已改为 `23 PASS / 0 FAIL`）。
2. **必须挂进标准回归跑**：新套件已加入 `run-learn-all-tests.mjs` 的 `ORDER`
   （放在真实拓扑锁之后、真实 e2e 之前）。不挂 = 没人跑的"死测试"。
3. **负例锁要有"看得见的通过"**：只断言"没有候选"是不够的——**必须同时断言否决留痕存在**，
   否则"路径静默失效"和"路径正确否决"在测试上完全无法区分。

---

## 5. 本阶段交付清单

| 文件 | 动作 | 作用 |
|---|---|---|
| `plugins/learn-core.mjs` | 改 | 遥测白名单补 `CAPABILITY_GAP_VETOED`（**根因修复**） |
| `tests/learn/test-learn-stage2-schema-and-negative-lock.mjs` | 新增 | 23 条锁：S1–S8 schema/拓扑 + N1–N11 负例/正例/可见性 |
| `tests/learn/run-learn-all-tests.mjs` | 改 | 新套件纳入标准回归 `ORDER` |
| `_diag-s2-*.mjs`（4 个） | 新增 | 可复算的事实探针（groundtruth/coverage/fakegap/schema-truth） |
| 本文件 | 新增 | 事实台账 + 偏差台账 + 根因记录 |

---

## 6. 证据（可复核）

```
tests/learn/test-learn-stage2-schema-and-negative-lock.mjs    23 PASS / 0 FAIL
tests/learn/run-learn-all-tests.mjs      20/20 套件全绿  →  门槛断言 722 PASS / 0 FAIL
                                          （门槛套件 15 个 / 观测套件 5 个）
```

---

## 7. 诚实边界（未覆盖 / 未证明）

1. **真实数据上的"产出候选"未被证明**：真实会话有 15 条 unresolved 失败，但端到端**候选产出**
   由夹具（N10）证明，非真实数据。原因：真实链路的触发还依赖水位 `hasFresh` 与会话新鲜度，
   真实会话多为已完成/已解决。⇒ **不得声称"真实会话已产出候选"**。
2. `data.arguments` 提取器当前**不读取**，本阶段仅作"事实锁"（记录形状，防将来静默变化）。
3. `S4` 的"缺 `error` 对象"允许 ≤15% 缺口：这是**对已记录真实例外**（2/28）的诚实让步，
   不是"100% 不变量"。若该比例上升会报警，但**不**声称结构绝对完整。
4. 本阶段的 schema 锁**只覆盖本机当前 12 个真实会话样本**；样本结构若整体换代（如上游改字段），
   锁会**立即变红**——这正是设计目的，但需人工确认是"漂移"还是"上游升级"。
