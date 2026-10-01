# E — D12「自愈作用域」表述更正：生产 learn 库**点值**普查（2026-10-01）

> 本档是 R2 闭环外部评审 **Finding E** 的证据与根因档。
> 结论先行：机制（自愈只在载入某个会话库时执行、**不批量扫掠历史库**）**成立且未被推翻**；
> 被更正的是**表述口径**——原句里的「3 个旧库 / mtime 未变 / 重启后仅当前活动会话库被写入」
> 三处**都缺少必要的限定**（类别、时点、时区、以及"库"指哪一种库），因此**数字对不上是可复现的**。

---

## 0 评审 Finding E 原文（External Review 2026-09-30/10-01）

> **E** D12 括号内描述过宽：机制成立（旧库确未被批量扫掠），但"3 个旧库 / 含标记库 mtime 未变"
> 在封条时点数字对不上。

原句（两处权威文档同一口径）：

- `A10_CONTRACT_MATRIX.md` → `### 2026-10-01 追加更正（External Review D11 / D12）` 块第 2 条：
  > **不批量扫掠历史库**（生产实测：重启后仅当前活动会话库被写入；3 个 `schemaVersion=1` 旧库
  > 与含标记的历史库 mtime 未变）
- `docs/roadmap/CURRENT_STATUS.md` → ⑤ D12 段的「依据（生产实测，2026-10-01 只读复核）」条。

---

## 1 根因：三处限定缺失 + 一处过宽（全部实测，非推测）

| # | 缺失/过宽 | 实测证据 | 后果 |
|---|---|---|---|
| 1 | **没有类别定义** | 按「所有 `schemaVersion=1` 文件」数 = **4**（3 个 09-23 会话期库 + 1 个索引文件 `_global-verified.json`）；剔除索引文件才是 **3** | 「3 个旧库」无法被独立复现 → 评审者复算得 4，判"对不上" |
| 2 | **没有测量时点** | 同一目录两次测量，最新文件 mtime 从 `12:21:30` 推进到 `12:22:49`（会话仍在写） | 点值被当成常量；换一天再数必然变 |
| 3 | **没有时区约定** | 同一 mtime 打印为 `2026-09-23 05:27:15+08:00`（local）与 `2026-09-22 21:27:15Z`（UTC），差 8 小时 | 两份归档清单"相差 8 小时"，看起来像漂移其实不是 |
| 4 | **「重启后仅当前活动会话库被写入」过宽** | 全局已验库 `_global-verified.json` mtime = `2026-09-29 01:24:49+08:00`（**晚于** 09-28 重启边界）；且全仓 `redactStore` 只有**一处**调用点（会话库载入路径），该索引文件**不在**自愈路径上 | 该句按字面读与实测冲突 |

**未被推翻的部分（机制）**：三个 09-23 会话期旧库的 mtime 全部停在 `2026-09-23 05:27–05:28`，
**远早于** 09-28 重启边界 ⇒ 它们**不可能**在重启期间被写过 ⇒「不批量扫掠历史库」成立。
（mtime 早于重启 = 该时刻之后未被写入，这是时间戳的单调性质，无需依赖任何归档清单。）

**「含标记库 mtime 未变」的准确边界**：封条时点那个含标记的历史库（`811ebf4e-…json`）
mtime 仍为 `2026-09-29 01:38:46+08:00`（未变，成立）；但**测量当日**（10-01）含标记的文件已达 **5 个**，
其中 **3 个是 `session-*` 会话库**，mtime 是 10-01（这些会话在封条**之后**才被载入）。
⇒ 「含标记库 mtime 未变」**不能作全称句**，只能**逐文件 + 带时点**地说。

---

## 2 方法（只读、离线自检 + 在线点值）

工具（本轮新增，`tools/` 下与既有两个独立工具同列）：`tools/learn-store-census.mjs`

```
node tools/learn-store-census.mjs --self-test    # 离线 fixture 自检（不读生产、不联网、确定性）
node tools/learn-store-census.mjs                # 人类可读点值普查
node tools/learn-store-census.mjs --json         # 机器可读
node tools/learn-store-census.mjs --dir <path>   # 指定目录
```

**工具的安全边界**：只读（只以读方式打开库文件）；**只打印计数、`schemaVersion` 与 mtime，绝不打印文件内容**
（库内可能含已脱敏但仍敏感的文字）；目录缺失/不可读 ⇒ `exit 2` + `TARGET UNAVAILABLE`
（"读不到"绝不当"零"）。

---

## 3 原始输出（原样粘贴，未润色）

### 3.1 离线自检（14 断言，fixture，无生产、无网络）

```
PASS  self-test: census succeeds on the fixture
PASS  self-test: schemaVersion=1 bucket = 4 (3 libs + 1 index)
PASS  self-test: old-schema SESSION libs = 0 (none starts with session-)
PASS  self-test: old-schema INDEX files = 4
PASS  self-test: schemaVersion=2+ = 2
PASS  self-test: unparsable = 1 (counted, not dropped)
PASS  self-test: total = 7 (nothing silently skipped)
PASS  self-test: marker bucket = 1
PASS  self-test: session libs = 2
PASS  self-test: UTC label carries Z
PASS  self-test: local label carries an explicit offset
PASS  self-test: the two labels denote the SAME instant (no hidden drift)
PASS  self-test: missing directory fails closed (never rendered as zero)
PASS  self-test: bucket definition is load-bearing (bare "3 个旧库" is reproducible only by dropping the index file)

SELF-TEST: 14 assertions  PASS: 14  FAIL: 0
```

> 最后一条是**负控**：它锁住"3 这个数字只有在**剔除索引文件**时才成立"——即"数字对不上"的
> 具体机理被固定成断言，而不是被解释掉。

### 3.2 生产点值（`%LOCALAPPDATA%\DSHHarness\state\learn`，测量时点见输出）

```
DIR            : C:\Users\Administrator\AppData\Local\DSHHarness\state\learn
MEASURED AT    : 2026-10-01 04:23:16Z (UTC)  =  2026-10-01 12:23:16+08:00 (local)
CATEGORIES     :
    65  all .json files in the store
    24  session libraries (name starts with session-)
    41  index / non-session files
     4  schemaVersion=1 (ALL files)
     0  schemaVersion=1 AND a session library
     4  schemaVersion=1 AND an index file
    61  schemaVersion=2+
     0  unparsable schemaVersion
     5  containing a [REDACTED:*] marker
     3  marked AND a session library
    24  mtime >= 2026-09-28T00:00:00Z boundary
SCHEMA VERSION : {"1":4,"2":61}
OLDEST FILE    : 2026-09-23 05:27:15+08:00  4dd5158f-3abf-4c27-b6d9-4fb5d9259d70.json
NEWEST FILE    : 2026-10-01 12:22:49+08:00  session-41e2b3be-c816-41f6-ac9b-507029965ca4.json
schemaVersion=1 bucket (file / mtimeLocal / bytes / sessionLib / hasMarker):
  4dd5158f-3abf-4c27-b6d9-4fb5d9259d70.json  2026-09-23 05:27:15+08:00  32149  sessionLib=false  marker=false
  e15160cd-ea0d-4e82-ab52-a3f8ca88d777.json  2026-09-23 05:27:32+08:00  25037  sessionLib=false  marker=false
  64d52ee9-f73f-46a0-86f6-f2a5bbb0133c.json  2026-09-23 05:28:03+08:00  25190  sessionLib=false  marker=false
  _global-verified.json  2026-09-29 01:24:49+08:00  8676  sessionLib=false  marker=false
files carrying a [REDACTED:*] marker: 5
  811ebf4e-17d5-4fae-925a-6068f1ed4e5b.json  2026-09-29 01:38:46+08:00  sessionLib=false  schemaVersion=2
  session-76de1ca9-0a7a-4ad4-97b1-750a3dabbaf8.json  2026-10-01 03:27:17+08:00  sessionLib=true  schemaVersion=2
  d895cf57-aab2-47aa-83f9-d941db3d2ae0.json  2026-10-01 04:52:06+08:00  sessionLib=false  schemaVersion=2
  session-09137a1b-dea3-43c1-a326-67ec78e491e6.json  2026-10-01 12:19:33+08:00  sessionLib=true  schemaVersion=2
  session-41e2b3be-c816-41f6-ac9b-507029965ca4.json  2026-10-01 12:22:49+08:00  sessionLib=true  schemaVersion=2
```

### 3.3 同一目录的第二次测量（证明"点值非常量"）

```
MEASURED AT    : 2026-10-01 04:21:50Z (UTC)  =  2026-10-01 12:21:50+08:00 (local)
NEWEST FILE    : 2026-10-01 12:21:30+08:00  session-41e2b3be-c816-41f6-ac9b-507029965ca4.json
```

两次测量（12:21:50 与 12:23:16）文件总数都是 65，但**同一个最新文件的 mtime 从 `12:21:30` 推进到
`12:22:49`** ⇒ 目录在被测量期间仍在被写 ⇒ 任何"共 N 个"的写法**必须**带测量时点。

---

## 4 分类定义（本轮固化；今后引用该数字时必须一并给出）

| 类别 | 定义 |
|---|---|
| all .json files in the store | 目录下全部 `*.json` |
| session libraries | 文件名以 `session-` 开头 |
| index / non-session files | 文件名不以 `session-` 开头（如 `_global-verified.json`） |
| `schemaVersion=1`（ALL files） | JSON 可解析且 `schemaVersion === 1`，会话库与索引文件**一并计入**（**原句「3 个旧库」依赖的正是这个桶**） |
| `schemaVersion=1` AND a session library | 上桶中属于会话库的子集 |
| `schemaVersion=1` AND an index file | 上桶中属于索引/非会话文件的子集 |
| `schemaVersion=2+` | JSON 可解析且 `schemaVersion >= 2` |
| unparsable schemaVersion | JSON 解析失败（**计入**，绝不静默丢弃） |
| containing a `[REDACTED:*]` marker | 文本命中 `/\[REDACTED:[a-z0-9-]+\]/i` |
| `mtime >= 2026-09-28T00:00:00Z` | 写入发生在 09-28 重启边界之后 |

---

## 5 更正后的口径（已写入权威文档的文本）

1. **自愈作用域（机制，不变）**：自愈在 `loadStore(sid)` 成功之后执行，作用域 = **该次被载入的那一个会话库**
   ⇒ 准确表述仍是「**当前已加载会话的库已自愈；历史库未被扫掠**」。
2. **历史库未被扫掠（可证部分）**：三个 `schemaVersion` 为 1 的**会话期旧库** mtime 全部停在
   `2026-09-23 05:27–05:28+08:00`，**远早于** 09-28 重启边界 ⇒ 重启期间/之后**未**被写入。
3. **"旧库"必须点明是哪一种库**：同目录下 `schemaVersion` 为 1 的文件**共 4 个**——
   3 个会话期旧库 + 1 个**全局已验库索引** `_global-verified.json`；该索引**不是**会话库、
   也**不在**自愈路径上（`redactStore` 全仓仅一处调用点，作用于被载入的会话库）。
4. **删掉过宽句**：「重启后仅当前活动会话库被写入」**不再使用**；`_global-verified.json`
   mtime `2026-09-29 01:24:49+08:00` 晚于重启边界，即重启之后该索引确有写入。
5. **含标记文件的表述改为逐文件 + 带时点**：封条时点的含标记历史库 `811ebf4e-…json` mtime 仍为
   `2026-09-29 01:38:46+08:00`；测量当日含标记文件共 **5 个**，其中 3 个是**封条之后才被载入**的会话库
   ⇒ **不得**写"含标记库 mtime 未变"这样的一般句。
6. **任何数字必须带测量时点与类别**：本档 §3.2 的计数是 `2026-10-01 12:23:16+08:00` 的**点值**，
   目录持续增长，**不得**当常量引用；复核时跑第 §2 节命令当场重算。

---

## 6 本轮**不**声明的事（边界）

- 不声明"历史库已全部自愈/已全库扫掠"——相反，本档进一步限定了作用域（历史库未被扫掠，属**已接受的设计边界**）。
- 不声明"目录内容不会变"或"计数是常量"——恰恰相反，本档把它固定为**点值**。
- **未**改任何 learning 插件字节（`redactStore` 调用点、载入路径均未触碰）、**未**动生产、
  **未**触发任何库文件的写（普查全程只读）、**未**改 GitHub 规则、**未**开/合 PR。
- **未**对 `_global-verified.json` 是否"应当"也走自愈下结论——若要全库扫掠，应作为独立维护动作另行授权
  （与本轮"只更正描述口径"的范围一致）。

---

## 7 复核者如何证伪本档

| 想验证的断言 | 命令 | 期望 |
|---|---|---|
| 桶逻辑与类别定义真的生效 | `node tools/learn-store-census.mjs --self-test` | 14 断言全 PASS、`exit 0` |
| 「3 个旧库」只在剔除索引文件时成立 | 同上（最后一条负控断言） | PASS |
| 生产点值可重算 | `node tools/learn-store-census.mjs` | `exit 0`，分类计数与表头时点同时打印 |
| "读不到"不会变成 0 | `node tools/learn-store-census.mjs --dir Z:\nope` | `exit 2` + `TARGET UNAVAILABLE` |
| 自愈调用点只有一处 | 全仓检索 `redactStore` | 定义 1 处 + 调用 1 处（会话库载入路径） |
