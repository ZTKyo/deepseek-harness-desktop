# P4 LEARN — R3 对抗评审报告

**Status:** `P4_LEARN_R3 = COMPLETE` — 4 个经实证的 R2 后缺陷已修复，305 条断言全绿
**Commit:** `7f786be`（分支 `p4-learning-r1`）
**日期:** 2026-09-21
**前置:** R1（`c0849d2` 之前）、R2（`e1df5b0`，PR #90）

---

## 1. R3 与 R2 的区别

R2 是"重跑自己的测试 + 读代码"；R3 是**拿真实会话数据当证据去攻击已交付的代码**，
并按规范逐条核对实现是否满足**规范原文**（而不是实现者自己的理解）。

三个独立证据源（全部只读、可复现）：

| 证据 | 规模 | 产出文件 |
|---|---|---|
| 真实发言里 `<system-reminder>` 的**位置分布** | 2 个真实会话、2174 次出现 | `evidence/P4_LEARN_R3_INJECTION_POSITIONS.txt` |
| 真实学习信号的**人工核对** | 116 条信号逐条判定 | `evidence/P4_LEARN_R3_PROBE.txt` / `_LABELS` / `_METRICS` / `_QUALITY` |
| 信号**污染源**归因 | 逐来源分类 | `evidence/P4_LEARN_R3_CONTAMINATION.txt` |

---

## 2. 实证缺陷与修复

### F4（最严重：静默删除真人发言）

**缺陷**：`INJECTED_OPEN_RE = /<system-reminder>[\s\S]*$/i` —— 任意位置命中即吞到字符串结尾。

**危害**：用户只是**讨论/引用**这个标签时，整段真人发言被删。实测：

```
输入: "我注意到日志里有 <system-reminder> 这个标签，它后面的报错都没被记录，帮我查一下"
输出: "我注意到日志里有"          ← 81% 文本被删
```

这直接违反规范 §4「区分 harness 注入 vs 用户讨论该标签」。更糟的是它**静默**：
剥离后的文本照样进摘要、照样参与信号判定，没有任何报错或计数异常。

**修复**：收紧为"标签独占一行"（`/^[ \t]*<system-reminder>[ \t]*\r?\n[\s\S]*$/im`）——
真注入块的排版形态。

**实证依据**（关键：不是猜的，是量的）：

| 类别 | 次数 | 特征 |
|---|---|---|
| 真注入 | **720** | 行首 **且** 标签独占一行 |
| 引用/讨论 | **1454** | 行中 **且** 标签后紧跟行内文字 |
| `lsOnly`（行首但非独占行） | **0** | — |
| `aloneOnly`（独占行但非行首） | **0** | — |

两个特征在真实数据里**100% 重合、零歧义**，故"独占一行"是充分的判别特征。
普通工作会话（`session-9e3b29bb`）**21/21 真实注入仍被正确剥离**，
未因收紧而漏剥任何注入。

### F3 否定语境从未排除（违反规范 §9）

**缺陷**：`SIGNAL_PATTERNS` 是纯关键词表，`没有报错` / `not broken` / `not fixed`
全部被当成正向信号。实测 **6/6** 反向表述误判。

**修复**：新增有界否定作用域判定 `isNegated()`：

- **CJK**：要求否定词**紧贴**关键词之前（窗口结尾 = 否定词 + 至多 2 个虚词）。
  `没有报错` / `已经不报错了` / `还没修好` / `根本没有报错` / `会不会报错` 被否掉；
  `这里报错了`、`我不确定，但是报错了` 仍是失败。
- **Latin**：只看命中前 2 个词，含 `not only` 例外。

**过程记录（失败方案不重走）**：第一版用"窗口内遇标点即认为否定作用域结束"，
在 `运行了一下，没有报错` 上**误判**——逗号在否定词**之前**，却被当成作用域结束。
改为**结尾锚定**后与标点完全无关，该用例通过。此坑已写进代码注释。

### F1 latin failure 形态漏检

`\b(error|failed|failure|...)\b` 缺 `failing` / `fails` / `fail`
⇒ 规范 §4 明确要求的 `still failing → failure` **完全不可达**。已补齐。

### F2 CJK 覆盖缺口

缺 `出错` / `不工作` / `没反应` / `崩了`；`修好了` 未作为 resolution
⇒ 规范 §6 的回归检测（`又崩了`）不可检。已补齐。

---

## 3. 测试与验证

| 套件 | 结果 |
|---|---|
| `tests/learn/test-learn-core.mjs`（R1+R2 全量回归） | **276 PASS / 0 FAIL** |
| `tests/learn/test-learn-r3-fixes.mjs`（R3 新增） | **29 PASS / 0 FAIL** |

**关于那条"变红"的 R2 断言**：R2 的
`stripInjectedContent("keep me<system-reminder>unterminated tail") === "keep me"`
把**缺陷行为本身锁进了测试**。按纪律**不删除**该断言，而是升级为 R3 规格，
并**反向保留**同一输入作为锁（它现在必须被保留，因为那正是用户讨论该标签的形态）。
R2 由 274 → **276 PASS / 0 FAIL**（净增 3 条、改判 1 条）。

**正反孪生对**：R3 测试每个修复都配正向 + 反向断言，使
「过否定把真实信号修没了」与「漏否定把反向表述算成信号」两种错误都无法静默通过。

**模块完整性**：`learn-core.mjs` 可加载，8 个公开导出全部存在（含新增
`isNegated` / `hasNonNegatedMatch`）。

---

## 4. 如实登记的未修边界

以下缺陷**已确认存在但不在本次修复范围**（纯关键词方案在**词形上无法区分**，
需句法/语义层）：

1. **假设句**："如果它报错就重试" → 被判 failure
2. **文档/字段名描述**："「failure」字段表示失败状态" → 被判 failure
3. **引用他人发言**："用户说'我这边报错了'，我怎么回？" → 被判 failure

这三类与真实陈述在词形上不可区分。**不修的理由**：修它们需要句法分析或语义模型，
成本远超收益，且**误报代价有界**——本模块只生成"待人工审批的候选"，
绝不构成激活、绝不改变任何行为（误报 = 一条被驳回的提案）。

---

## 5. 边界声明

- **未进生产 profile、未重启服务、未部署**：R3 与 R1/R2 一样只在隔离工作树内成立。
- 服务进程未受影响（未触碰 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\**`）。
- `verificationState` 保持 `UNVERIFIED`（AC 声明时 bindings 为 `kind:'none'`，write-once 不可改）。
- P4 是否进生产由 External Reviewer + 用户决定。

## 6. 证据文件

- `docs/roadmap/evidence/P4_LEARN_R3_INJECTION_POSITIONS.txt` — 位置分布实证（F4 依据）
- `docs/roadmap/evidence/P4_LEARN_R3_FIXES.txt` — R3 回归输出（29 PASS / 0 FAIL）
- `docs/roadmap/evidence/P4_LEARN_R3_PROBE.txt` — 真实信号探针
- `docs/roadmap/evidence/P4_LEARN_R3_METRICS.txt` — 精确率/召回率（由人工标注算出）
- `docs/roadmap/evidence/P4_LEARN_R3_QUALITY.txt` — 候选质量
- `docs/roadmap/evidence/P4_LEARN_R3_CONTAMINATION.txt` — 污染归因
- **人工标注真值**：`tests/learn/redteam-r3-labels.mjs`（`export const LABELS`，133 行数据模块，
  **不是可执行探针**——它只被 `redteam-r3-metrics.mjs` 导入以计算指标，直接运行无输出）
- 探针源码：`tests/learn/redteam-r3-{contamination,injection-positions,metrics,probe,quality}.mjs`、
  `tests/learn/test-learn-r3-fixes.mjs`
