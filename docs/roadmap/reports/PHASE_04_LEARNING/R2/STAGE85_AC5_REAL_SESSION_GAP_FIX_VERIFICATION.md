# STAGE 8.5 · AC5 能力缺口路径「真实会话活性」缺陷修复与验证报告

- **日期**：2026-09-24
- **范围**：`_p4r2/plugins/learn-core.mjs`、`_p4r2/plugins/learn.mjs`（AC5 能力缺口 / STAGE 8.5 capability-gap 路径）
- **被测 HEAD**：`5a206ae8dc10fe1f73aa20925b28f5fbb5d1702f`（worktree dirty，改动仅限 `plugins/learn*.mjs` 与 `tests/learn/**`）
- **性质**：**真实缺陷修复**（不是测试补齐、不是口径调整）

---

## 1. 结论（先说结果）

AC5「工具能力缺口 → 学习候选」链路在**真实会话上此前完全不会触发**。根因是观测面（observation
face）的拓扑模型错了：它把「会话节点 seq」当成工具事件的载体。修复后，缺口路径在真实会话上
产出候选，并已用**磁盘真实数据**端到端验证。

| 项 | 修复前 | 修复后 |
|---|---|---|
| 真实会话上 `extractToolOutcomes` 抽到的事实数 | **0**（死代码） | 正常（全库 6397 个工具事件可见） |
| 真实会话上是否产出 AC5 候选 | **否**（永不触发） | **是**，`cand_81948d28`（`state=PROPOSED`） |
| 合成孪生对照（同一夹具同一调用） | `calls=0 failures=0` | `calls=2 failures=2` |

---

## 2. 根因

### 2.1 真实拓扑事实（本次实测，非推断）

对 `~/.dsh/sessions` 下 40 个真实会话（>500 KB）实测：

```
工具事件合计 6397 个，其中落在 surface 节点 seq 上 = 0
```

即：**真实会话里 `tool/call`、`tool/result` 事件落在节点与节点之间的 seq 上，与
`surface.nodes` 的 seq 集合零交集**。这与合成夹具（把工具事件 seq 直接当作节点 seq）**不同构**。

### 2.2 缺陷形态

观测面此前按「节点 seq 集合」筛选工具事件，因此在真实拓扑下**恒为空集** ⇒
`extractToolOutcomes` 永远返回空 ⇒ 缺口路径是**死代码**（永不触发，且不报错、不告警，
属"静默失效"——最难发现的一类）。

### 2.3 RED → GREEN 对照（同夹具、同调用、仅扫描面一行之差）

`_diag-s85-red-green-topology.mjs` 用**同一份真实会话**分别喂给两份实现：

```
BUGGY（节点 seq 交集）：calls=0  failures=0      ← 死代码，与真实拓扑不适配
FIXED（全量事件扫描）：calls=2  failures=2      ← 活的
```

这是本缺陷的**最小可复现对照**，也是修复必要性的直接证据。

### 2.4 为何此前测试没发现

合成测试的夹具把工具事件 seq **同时**当成了节点 seq（`nodes = [1,6,7,12]` 与工具事件 seq
重合的构造方式），于是"用节点 seq 筛工具事件"在夹具上**恰好**能筛到东西 ⇒ 测试全绿而线上死。
**测试夹具与真实拓扑不同构，是本次缺陷得以长期存活的唯一原因。**

---

## 3. 修复

| 文件 | 改动 |
|---|---|
| `plugins/learn-core.mjs` | `extractToolOutcomes` 观测面由「节点 seq 集合」改为**全量事件扫描**（真实拓扑下工具事件不落在节点上） |
| `plugins/learn.mjs` | 缺口路径触发面/观测面同步对齐；`capabilityDeficiency` 证据按适配器契约传入（`learn.mjs:407`） |

修复保持既有有界常量不变（`MAX_SESSION_OBSERVATIONS=64`、`MAX_GAP_SIGNATURES=16`），
不扩大单次扫描成本量级。

---

## 4. 验证证据

### 4.1 真实会话闭环 E2E（`tests/learn/run-learn-real-gap-e2e.mjs`）—— 20 PASS / 0 FAIL

全链路使用**生产函数**（`extractToolOutcomes` / `unresolvedToolFailures` /
`capabilitySignature` / `learn.apply`），在磁盘真实会话上驱动真实插件：

```
真实拓扑自检: 工具事件合计 6397 个，其中落在 surface 节点 seq 上 = 0   → PASS
结构化事实: 工具失败 72 条 → 未解决 23 条
选定真实签名: tool:glob::tool|glob|SEARCH_FAILED|v1   真实出现 7 次
  seqs=[790,792,1004,1207,1731,11072,14779]
候选: id=cand_81948d28  kind=NEW_SKILL  state=PROPOSED  obs=5
      dedupKey=tool:glob::tool|glob|SEARCH_FAILED|v1
```

**出处独立复核**（重新解析原会话、逐 seq 回读原始事件）：

- 每条证据 seq 都指向真实 `tool/result` 事件 → PASS
- 每条原始事件 `content.isError === true`（**官方事实，非推断**）→ PASS
- 每条原始事件带同一 `errorCode`（同底层能力）→ PASS
- 证据 seq 全部落在节点 seq 之外 → PASS

**闭环不变量**：`state=PROPOSED`（不自动激活）→ PASS；重复驱动不重复建候选、id/dedupKey
稳定 → PASS；候选不污染稳定经验库（Stable 不被绕过）→ PASS。

### 4.2 拓扑回归（`tests/learn/test-learn-real-topology-tool-events.mjs`）—— 22 PASS / 0 FAIL

新增测试，锁死「工具事件 seq 与节点 seq 零交集」这一真实拓扑前提，防止夹具再次同构错误。

### 4.3 P4 LEARN 全量回归（自有 runner `tests/learn/run-learn-all-tests.mjs`）

**19 个套件全绿**（门槛套件 14 个 / 观测套件 5 个），门槛断言 **698 PASS / 0 FAIL**
（含真实会话 E2E 59 PASS、真实缺口闭环 20 PASS、真实拓扑 22 PASS、AC5 系 79 PASS、
core 327 PASS、redteam 观测套件全 exit 0）。

> 更正记录：本报告初稿此处写「18 个套件 / 678 PASS」，那是在把真实缺口 E2E 显式纳入 runner
> ORDER 清单**之前**的数字；纳入后当次实测为 **19 套件 / 698 PASS**，已就地更正。

### 4.4 仓库官方全量入口（`tests/learn/run-r3-final-head-full.ps1`）

```
TOTAL=36  GREEN=35  RED=1  MISSING=0  totalPASS=1210  totalFAIL=2
```

**唯一 RED = `tests/install-plugin/verify-install-plugin.mjs`（既有无关失败）**：

- 失败项 = `restart preflight failed: install-plugin --check 未通过`
- 实测 `node tools\install-plugin.mjs --check`：**11 项失败全部集中在其它插件**
  （ask-telegram / computer-use / secret-gate / completion-notify / failure-classifier /
  openrouter-router / agentrouter-wire / agent-inspector / keepalive-patch /
  model-selection-guard / execution-continuity），**输出中完全没有 `learn` 字样**；
- 该套件源码**无任何 `learn` 引用**；本次 `git status` 只改 `plugins/learn*.mjs`
  ⇒ 归类 **PRE-EXISTING / UNRELATED**，不在本任务范围（按"发现范围外问题只报告不执行"）。

---

## 5. 本轮自身踩到的两个测试侧错误（诚实披露）

修复过程中，验证脚本自身出过两次错，均属**测试服从生产契约**问题，不是生产缺陷：

1. **回归 runner 误报全绿套件为 FAIL**（`run-learn-all-tests.mjs` 首版）：用全文计数
   `\bPASS\b` / `\bFAIL\b`，把**标题里的 FAIL 字样**（如 `FAIL = 0`、"F4 R2 既有锁定用例
   仍成立"）算成失败。修正为「取**最后一条**汇总摘要 + 退出码权威」，并识别仓库实测存在的
   **三种**摘要格式（`N PASS / M FAIL`、`n pass, m fail`、`PASS = n  FAIL = m`）。
   顺带给官方 runner `run-r3-final-head-full.ps1` 的 `$pats` 补了后两种（原先会漏计 AC5 系
   PASS 数，统计失真但不会误报失败）。
2. **真实 E2E 的 G5 段构造观测时漏传 `capabilityDeficiency`** ⇒ 被适配器正确否决
   （`reason='missing capability deficiency evidence'`，`learn-gap-veto.mjs:276/279`）。
   生产侧 `learn.mjs:407` 明确传入该字段。修正为与生产**逐字一致**的观测形状后，全库真实数据
   上 tool 域合格签名 = 5、否决 = 0。

**规则沉淀**：任何"按真实数据判定生产行为"的验证脚本，其**夹具形状必须与生产契约逐字一致**；
出现否决/不合格结论时，先自检观测形状，再考虑是否是生产缺陷。

---

## 6. 交付物

| 类型 | 路径 |
|---|---|
| 修复 | `_p4r2/plugins/learn-core.mjs`、`_p4r2/plugins/learn.mjs` |
| 新增测试 | `_p4r2/tests/learn/run-learn-real-gap-e2e.mjs`（真实闭环，20 断言）<br>`_p4r2/tests/learn/test-learn-real-topology-tool-events.mjs`（拓扑回归，22 断言） |
| 共享驱动器 | `_p4r2/tests/learn/_real-session-harness.mjs`（真实会话加载/伪 ctx/逐节点驱动，两个 E2E 共用） |
| 全量 runner | `_p4r2/tests/learn/run-learn-all-tests.mjs`（19 套件一键回归，门槛断言 698 PASS / 0 FAIL） |
| 最小对照证据 | `_p4r2/_diag-s85-red-green-topology.mjs`（RED→GREEN 孪生对照） |
| 已接入官方入口 | `run-ac7-regression.ps1`、`run-r3-final-head-full.ps1`（补入 P4 LEARN R2 全部套件） |

**回退锚点**：`_p4r2/plugins/learn.mjs.ac5-fix-backup`（修复前原件）。

---

## 7. 判定边界（诚实披露）

1. 本报告是**执行侧证据**，不构成任何官方 verdict。
2. 真实 E2E 的候选发现只在**生产真的能看见**的签名上判定（受
   `MAX_SESSION_OBSERVATIONS=64` / `MAX_GAP_SIGNATURES=16` 上界约束）；上界效应已在
   G0 段显式计算并对齐，不把有界裁剪误报为缺陷。
3. 官方全量入口的 `TESTED_HEAD` 与证据落盘提交存在自引用差异（runner 已自带说明），
   `plugins/` 与 `tests/learn/` 在两者之间零差异，复核命令：
   `git diff 5a206ae <evidence-commit> -- plugins tests/learn`（应为空）。
4. 未覆盖面：仅扫描前 40 个 >500 KB 的真实会话（全库 96 个）；其余会话未逐一验证。
