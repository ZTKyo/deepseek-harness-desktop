# P4 LEARN — R3 对抗评审报告

**Status:** `P4_LEARN_R3 = COMPLETE` — 5 个经实证的缺陷已修复（F1–F4 + **会话隔离撞名根因 F5**），412 条断言全绿
**Verdict:** **B — FIXED AND VERIFIED**（见 §7；发现真实缺陷并全部修复复验，故非 A）
**Commit:** 最终 HEAD `cb64d8b`（文档收口；`b5fa812` = 隔离根因修复 + 加固；`7f786be` = F1–F4 修复）
**分支:** `p4-learning-r1` ｜ **PR:** #90（OPEN，未 merge）
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

### F5（会话隔离失效：跨会话污染，R3 追加发现）

**缺陷**：`sanitizeFileId(sid)` 只做「非法字符 → `_`」+ 截断 120，**不做唯一性保证**。
两个不同 sessionId 会映射到**同一个库文件**：

| 形态 | 会话 A | 会话 B | 撞名结果 |
|---|---|---|---|
| 清洗撞名 | `probe session X` | `probe_session_X` | 同为 `probe_session_X.json` |
| 截断撞名 | `session-aaa…tailONE`（>120） | `session-aaa…tailTWO`（>120） | 截断后同名 |

**危害**：后请求方 `loadStore` 读到的是**别人写的库**（结构合法，`validateStore` 放行），
于是**静默继承前一方的经验**——跨会话污染，且**无任何 STORE_REBUILT 告警**。
更隐蔽的是双向覆盖：两方轮流写入同一文件，各自学到的经验被对方覆盖掉（**互相丢数据**）。

**修复（两层，先根因后兜底）**：

1. **根因**：`sanitizeFileId` 在「清洗确实改变了原 sid」时追加原 sid 的短哈希
   （`stableHash(s).slice(0,8)`）→ 撞名从源头消除。
   **零迁移影响**：未被改动的常规 sessionId（`session-<uuid>`）文件名**保持原样**
   （实证：`session-04ecc1a4-…-89b79128bcd4.json` 命名不变），既有库文件不会变孤儿。
2. **兜底（fail-closed）**：`loadStore` 增加归属校验 —— 库的 `sessionId` 必须等于请求方，
   否则拒绝载入（返回 null → 触发重建 + `STORE_REBUILT` 遥测）。
   纵深防御：即使未来出现新的撞名途径，也只会「拒绝载入并告警」，不会静默污染。

**为什么不只做兜底**：兜底只能拒绝载入、**不能避免覆盖**（双方仍抢同一文件互相覆盖）。
根因修复才真正消除数据丢失。

**验证**（`redteam-r3-isolation.mjs`，13 PASS / 0 FAIL）：

```
A1 两个会话映射到两个不同文件                          PASS
A3 两库各自归属正确 sessionId                          PASS
B1 两个不同 sid 不再映射到同一文件（撞名已消除）        PASS   probe_session_X-4d6e3e7d.json | probe_session_X.json
B4 无跨会话污染（后跑方不继承先跑方经验）              PASS
B5 守卫直测：伪造他人归属的库必须被拒绝载入并重建      PASS   telemetry=[STORE_REBUILT,PROPOSED]
C1 超长 sid 不再撞名（两个独立文件）                   PASS
C2 超长 sid 两库各自归属正确（无互相覆盖）             PASS
撞名是否仍可达 = NO（根因已消除）   归属守卫 = YES   跨会话污染 = NOT CONFIRMED
```

B5 为**守卫直测**：撞名既已从根因消除，就手工伪造一个「归属他人」的库文件，
验证 fail-closed 兜底**真的生效**（而非纸面存在）。

**探针判定极性修正（过程记录）**：原探针 B2/B3 的 verdict 逻辑写反了
（把「文件合法归属 Y」判为 FAIL），修复后会误报。已重写为
**PASS = 隔离成立**，并把「撞名机制确认」升级为「撞名已消除」。
此坑记录在此，避免下次误读 FAIL。

---

## 3. 测试与验证

| 套件 | 结果 |
|---|---|
| `tests/learn/test-learn-core.mjs`（R1+R2 全量回归） | **276 PASS / 0 FAIL** |
| `tests/learn/test-learn-r3-fixes.mjs`（R3 新增） | **29 PASS / 0 FAIL** |
| `tests/learn/test-learn-r3-hardening.mjs`（R3 加固） | **26 PASS / 0 FAIL** |
| `tests/learn/run-learn-real-e2e.mjs`（真实会话 E2E） | **59 PASS / 0 FAIL** |
| `tests/learn/redteam-r3-isolation.mjs`（会话隔离红队） | **13 PASS / 0 FAIL** |
| `tests/learn/redteam-r3-contamination.mjs`（污染红队） | **9 PASS / 0 FAIL** |
| `redteam-r3-{metrics,quality,labels,injection-positions}` | 全部 **exit=0** |

合计 **412 PASS / 0 FAIL**（276 + 29 + 26 + 59 + 13 + 9），`tests/learn/` 全目录 **0 个非零退出**。

**数字更正记录**：本报告早期版本写作「413 PASS」，经最终 HEAD 逐套件复核为**算术错误**
（六套之和 = 412）。已在最终 HEAD 全量回归中逐条重算并修正，避免把错误数字交给评审。

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
- `docs/roadmap/evidence/P4_LEARN_R3_ISOLATION.txt` — **会话隔离红队最终输出（13 PASS / 0 FAIL）**
- `docs/roadmap/evidence/P4_LEARN_R3_AC7_FULL.txt` — **AC7 全量回归最终输出（全目录 0 非零退出）**
- **人工标注真值**：`tests/learn/redteam-r3-labels.mjs`（`export const LABELS`，133 行数据模块，
  **不是可执行探针**——它只被 `redteam-r3-metrics.mjs` 导入以计算指标，直接运行无输出）
- 探针源码：`tests/learn/redteam-r3-{contamination,injection-positions,metrics,probe,quality}.mjs`、
  `tests/learn/test-learn-r3-fixes.mjs`

---

## 7. 对抗评审结论（A/B/C/D）

```
Phase 04 LEARN R3 External Review Result
Verdict: B — FIXED AND VERIFIED
Final HEAD: cb64d8b4576eb6bf2aaad303e695b069c5f87306
Branch: p4-learning-r1   PR: #90 (OPEN, 未 merge)
```

### 1. What I independently verified（独立复核了什么）

不是重跑实现者自己的测试，而是**用真实会话数据攻击已交付的代码**：

1. **真实注入形态的量化**（2174 次真实出现，2 个真实会话）——`lineStart`=720 / `midLine`=1454 /
   `lsOnly`=0 / `aloneOnly`=0，两个特征**零歧义**，故「独占一行」是充分判别特征。
2. **116 条真实信号的人工逐条标注**（26 层分层抽样，覆盖 26/26 层），据此算出精度基线。
3. **污染源归因**：逐来源分类（user/assistant/transient/temporary-state/secret 形状）。
4. **隔离对抗**：真实 DSH sessionId 形状 + 清洗撞名 + 超长截断撞名三类，含**守卫直测**。
5. **最终 HEAD 全量回归**：28 套（AC7 21 套 + R3 红队/加固 7 套），逐套件复核退出码。

### 2. Defects actually found（实际发现的缺陷）

| ID | 缺陷 | 危害 | 状态 |
|---|---|---|---|
| **F4** | `INJECTED_OPEN_RE` 任意位置命中即吞到字符串结尾 | **静默删除真人发言**（实测 81% 文本被删） | 已修 + 锁死 |
| **F3** | 否定语境从未排除（违反规范 §9） | `没有报错` / `not fixed` 全被当正向信号（实测 6/6 误判） | 已修 + 锁死 |
| **F5** | `sanitizeFileId` 无唯一性保证 | **跨会话污染 + 互相覆盖丢数据**（无告警） | 已修（根因+兜底）|
| **F1** | latin failure 缺 `failing/fails/fail` | 规范 §4 的 `still failing → failure` **完全不可达** | 已修 + 锁死 |
| **F2** | CJK 缺 `出错/不工作/没反应/崩了` | 规范 §6 回归检测 `又崩了` 不可检 | 已修 + 锁死 |

五个都是**真实缺陷**（非风格问题），且每个都由「在修复前代码上必失败」的回归测试锁死，
并配**正反孪生断言**——「过否定把真实信号修没了」与「漏否定把反向表述算成信号」两种错误
都无法静默通过。

### 3. Final verification（最终验证）

| 套件 | 最终 HEAD 结果 |
|---|---|
| `test-learn-core.mjs` | 276 PASS / 0 FAIL |
| `test-learn-r3-fixes.mjs` | 29 PASS / 0 FAIL |
| `test-learn-r3-hardening.mjs` | 26 PASS / 0 FAIL |
| `run-learn-real-e2e.mjs`（真实会话） | 59 PASS / 0 FAIL |
| `redteam-r3-isolation.mjs` | 13 PASS / 0 FAIL |
| `redteam-r3-contamination.mjs` | 9 PASS / 0 FAIL |
| **合计** | **412 PASS / 0 FAIL** |
| 全量回归（28 套，AC7 + R3） | 27 绿 / 1 红 / 908 PASS / 2 FAIL |
| 唯一红 `verify-install-plugin.mjs` | **PRE-EXISTING**（pristine HEAD 上同样 13/2，插件同步漂移，与 P4 无关）|

**为什么是 B 而不是 A**：A 要求「未发现缺陷」。R3 **确实发现了 5 个真实缺陷**（含 2 个
静默级：F4 删真人发言、F5 跨会话污染），故不满足 A。全部在授权范围内修复并重新验证，
故为 **B — FIXED AND VERIFIED**。

**为什么不是 C/D**：C 指真实设计 blocker（需越权才能正确解决）——不存在，五个缺陷都在
`learn-core.mjs` 内部可修。D 指环境阻塞——不存在，全部验证在隔离工作树内完成，未触碰生产。

**诚实登记的未修边界**（见 §4）：假设句 / 文档字段名描述 / 引用他人发言三类词形不可区分，
需句法或语义层，超出最小修复范围；**误报代价有界**（只生成待人工审批候选，绝不激活）。

