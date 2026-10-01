# R2 收官加固（2026-10-01）：控制套件的"可跑性"与"归属"复核

- 轮次：`p4-ext-review-remediation-r2`（收官加固，不是新一轮功能）
- 工作树：`C:\Users\Administrator\Desktop\sdeepseek harness\_p4rem-wt`（独立 linked worktree）
- 权威状态文档：`docs/roadmap/CURRENT_STATUS.md`；机读索引：`docs/roadmap/P4_STATUS.json`
- 本文性质：**定向自检报告**（对象是本轮自己写的控制套件，不是新功能）
- 复现前提：Windows + node v22.22.2 + PATH 上的 `git`；所有命令在仓库根目录执行

> 本文所有结论都附**原始命令与原始输出片段**，可逐条复现；未执行的项一律显式标注「未执行」。
> 本轮**未改动**发布件与权威正文（Finding B 的哈希封条保持原状），也未启动/重启任何服务。

---

## 0. 一句话结论

在把 Finding E/F 闭环收口之前，对本轮自己产出的三个控制套件做了一次定向自检，发现并修复了 **2 个真实缺陷**：

| # | 缺陷 | 危害等级 | 处置 |
|---|---|---|---|
| 1 | Finding A 负控的环境缺陷：副本不是 git 仓库 ⇒ 基线恒红 | **高**（会让"应为红"的用例**因错误原因通过＝假绿**） | 已修（副本 `git init`+提交；并把"基线必须为绿"提升为显式断言） |
| 2 | A / B 两个控制**没有任何 CI 航道调用**（写了但永远不会跑） | 中（控制存在与否在 CI 侧不可见） | 已修（三者一并接线 ci-level1；H7 泛化为"四个控制都必须有归宿"，并用注入证明可证伪） |

修复后复验：控制套件 3 个全绿（11/11、14/14、14/14）、校验器 86/86、锚点门 19/19、YAML 6 文件合法、AC10 门登记表 15 PASS/0 FAIL。
**未覆盖边界见 §5（其中最重要的一条：三个控制均为本机实测，尚未在 GitHub runner 上跑过）。**

---

## 1. 发现 1 —— Finding A 负控的环境缺陷（假绿风险）

### 1.1 现象（修复前的原始输出）

```
[baseline] exit=1  fails=4
    FAIL  G2 anchor gate exits 0 (every anchor resolves; no hand-written line pointer) —
      ban.A10.banner   FAIL :: frozenExempt requested but `git show HEAD:<file>` failed (cannot prove what is history)
      ban.STATUS.d1row FAIL :: frozenExempt requested but `git show HEAD:<file>` failed (cannot prove what is history)
      DOC ANCHORS: 18  RESOLVED: 18  BANS: 2  FAIL: 2 | DOC ANCHOR GATE: FAILED
[A7 applied] exit=1  (expected 0)  fails=4
```

### 1.2 根因

`tests/roadmap/test-p4-status-per-ac-consistency.mjs` 把整棵树复制到 `%TEMP%` 时 **跳过 `.git`**（有意如此：副本不该带仓库历史），
于是副本只是一个"看起来像仓库的目录"。而它真正运行的校验器会连带跑**文档锚点门**，后者的「冻结历史行豁免」判据是
`git show HEAD:<file>`——副本里没有 HEAD，锚点门就无法证明哪些行属于历史，两条 ban 记录因此 FAIL，**副本基线自己就是红的**。

### 1.3 为什么这是"高"危害（关键，不是洁癖）

后果有两层，第二层才是真正的危险：

1. 明面后果：两个**应保持绿**的用例（A0「未改动树应绿」、A7「合法同步改动应绿」）必然失败——本轮就是被它们暴露的；
2. **真实隐患**：另外 9 个**应为红**的用例会因为"基线本来红"而通过——即负控失去了区分力，**"变红"不再证明被测缺陷被抓到**。
   这与外部评审反复强调的那类问题同源：**判定依据没有绑定到被测对象**。一个恒红的基线会让整套负控变成装饰。

### 1.4 修法（`tests/roadmap/test-p4-status-per-ac-consistency.mjs`）

1. 复制完成后在副本内 `git init -q` + `git add -A` + 一次提交，使副本的 HEAD 就代表"副本基线"（语义与真实仓库一致：HEAD 里有的行=历史行）；
2. 把"基线必须是绿的"从**隐含假设**提升为**显式断言**：未改动时门若 exit≠0，控制立即 exit 1 并打印前 12 条 FAIL——
   这样即使将来环境再变（例如 runner 上没有 git），失败信息会直指"环境问题"，而不是伪装成"某个用例不符合预期"；
3. 代码注释里写明上述理由（供后来者不重犯）。

### 1.5 修复后（原始输出）

```
PASS  A0  expected=GREEN actual=GREEN(exit 0)  :: untouched tree stays GREEN
PASS  A1  expected=RED actual=RED(exit 1) assert=B7 fired  :: index AC10 PASS->FAIL, authority untouched (the reproduced exploit)
PASS  A2  expected=RED actual=RED(exit 1) assert=B7 fired  :: index AC3 PASS->PARTIAL, authority untouched
PASS  A3a expected=RED actual=RED(exit 1) assert=B1 fired  :: index is missing AC7
PASS  A3b expected=RED actual=RED(exit 1) assert=B5 fired  :: authority table is missing its AC7 row
PASS  A4a expected=RED actual=RED(exit 1) assert=B1 fired  :: index carries an unknown extra AC11 key
PASS  A4b expected=RED actual=RED(exit 1) assert=B5 fired  :: authority table carries an unknown extra AC11 row
PASS  A5a expected=RED actual=RED(exit 1) assert=B2 fired  :: index verdict is not a legal token (AC5 = GREEN)
PASS  A5b expected=RED actual=RED(exit 1) assert=B6 fired  :: authority verdict is not a legal token (AC5 = GREEN)
PASS  A6  expected=RED actual=RED(exit 1) assert=B8 fired  :: both sides agree on AC10=PARTIAL but the summary still claims all-PASS
PASS  A7  expected=GREEN actual=GREEN(exit 0)  :: legitimate synchronised change (AC10=PARTIAL everywhere) stays GREEN

CONTROLS: 11  AS-REQUIRED: 11  MISBEHAVED: 0
```

每个 RED 用例都**命中具体编号断言**（B1/B2/B5/B6/B7/B8），而不是"只要红就算过"——这是"差分而非红绿"的证据。

---

## 2. 发现 2 —— 两个控制"无归属"（写了但没有任何航道会跑）

### 2.1 现象（修复前，全 workflow 扫描原始输出）

```
  - ci-level1.yml
  - ci-level2.yml
  - ci-level3.yml
  - ci-level4.yml

=== who wires the two P4 controls (Finding A / Finding B)? ===
  UNWIRED  test-p4-status-per-ac-consistency.mjs
  UNWIRED  test-release-artifact-verifier.mjs
  UNWIRED  verify-release-artifact.mjs
  UNWIRED  test-finding-e-negative-control.mjs
```

（`verify-release-artifact.mjs` 是被 B 控制调用的**工具**，不需要单独接线；另外三个是套件。）
注：`tests/roadmap` 不在 `ci-level3` 的 `paths:` 过滤内——这条缺口 **D4 已登记**，它同时意味着"没接线"这件事在 CI 侧完全不可见。

### 2.2 修法

1. `.github/workflows/ci-level1.yml` 的 P4 段新增/补齐三个步骤（Finding A 控制、Finding B 控制、E 控制；连同既有的
   D 锚点负控，共四个控制各有一步），每个步骤的注释写明**它证伪什么**、以及副本为什么要 `git init`（与 §1 同源）；
2. 校验器 `validate-p4-status-consistency.mjs` 的 **H7 断言泛化**：
   - 旧：只查 E 控制"文件存在 + 被 ci-level1 调用"；
   - 新：**四个**控制套件都必须**存在**，且**被某条 workflow 真实调用**（扫 `.github/workflows/*.yml` 全文，不绑定具体航道，允许后续迁移）。
   仍然**不在校验器里 spawn 它们**——E 控制会跑校验器（在副本内），校验器若再 spawn 控制就形成递归；实际执行由 CI 的独立步骤负责。

### 2.3 证伪（证明 H7 本身不是装饰）

在 E 负控里新增**注入 C**：删掉副本 `ci-level1.yml` 里对本控制的调用行 ⇒ H7 必须 `PASS→FAIL`；还原 ⇒ 回绿。原始输出见 §3。

---

## 3. E 负控扩展（11 → 14 断言）

| 组 | 断言 | 观察点 |
|---|---|---|
| 基线 | 2 | 副本门 `exit 0`；`H2`+`H5` 起始为 PASS（否则差分无意义） |
| 注入 A（E 的原始缺陷形态） | 4 | 删掉 `、非常量` 限定 ⇒ `H5` PASS→FAIL、门 exit 1 ⇒ 还原后回绿 |
| 注入 B（E 的根因：桶逻辑没被真正断言） | 4 | 普查 fixture 期望 `4`→`5` ⇒ `--self-test` exit 1 ⇒ `H2` PASS→FAIL ⇒ 还原后回绿 |
| **注入 C（本轮新增：控制失去 CI 归属）** | **3** | 删接线行 ⇒ `H7` PASS→FAIL、门 exit 1 ⇒ 还原后回绿 |
| 零副作用 | 1 | 真实仓库文件（校验器/状态文档/普查工具/**ci-level1.yml**）sha256 前后逐字节一致 |

原始输出（修复后）：

```
PASS  C1 the CI wiring line to be removed exists exactly once (targeted injection)
PASS  C2 gate goes RED when the control suite loses its CI owner (H7 flips PASS→FAIL)
PASS  C3 restoring the wiring turns H7 back to PASS (injection was the cause, not noise)
PASS  C0 the real repository files are byte-identical (sha256) — this test never mutates them

FINDING E NEGATIVE CONTROL: 14 assertions  PASS: 14  FAIL: 0
```

### 3.1 诚实记录：注入 C 的第一版是错的（以及它教了什么）

第一版用字符串 `needle + "\n"` 做替换，但 `ci-level1.yml` 是 **CRLF** 行尾（实测 `CRLF=399 bareLF=0`），替换因此**空操作**——
表现为 `C2 ... exit=0 H7=true` 失败，而 `C1`（"注入点恰好出现 1 次"）仍是 PASS。改成"按行过滤 + 保留原行尾风格"后通过。
这条恰好是负控自身的纪律：**只有先断言"注入真的发生了"，后面的红/绿才有意义**（C1 就是为此存在的）。

---

## 4. 复验台账（全部命令 + 实际结果）

| # | 命令 | 实际结果 |
|---|---|---|
| 1 | `node tests\roadmap\validate-p4-status-consistency.mjs` | `ASSERTIONS: 86  PASS: 86  FAIL: 0` → exit 0（含新 H7 PASS；断言数随登记的锚点数增长：锚点门 19 个锚点各一条） |
| 2 | `node tools\check-doc-anchors.mjs` | `DOC ANCHORS: 19  RESOLVED: 19  BANS: 2  FAIL: 0` → exit 0（第 19 个即本档案锚点 `doc.r2ControlHardening`） |
| 3 | `node tests\roadmap\test-anchor-gate-negative-control.mjs` | `NEGATIVE CONTROLS: 3  PASS: 3  FAIL: 0` → exit 0 |
| 4 | `node tests\roadmap\test-finding-e-negative-control.mjs` | `14 assertions  PASS: 14  FAIL: 0` → exit 0 |
| 5 | `node tests\roadmap\test-p4-status-per-ac-consistency.mjs` | `CONTROLS: 11  AS-REQUIRED: 11  MISBEHAVED: 0` → exit 0 |
| 6 | `node tests\roadmap\test-release-artifact-verifier.mjs` | `CONTROLS: 14  AS-REQUIRED: 14  MISBEHAVED: 0` → exit 0 |
| 7 | `node tests\roadmap\verify-history-preserved.mjs` | `HISTORY PRESERVATION: PASSED`（59 条表分隔行按规则豁免）→ exit 0 |
| 8 | `node tools\check-l3-paths-coverage.mjs` | exit 0（信息性 NOT：`tests/roadmap` 仍不在 ci-level3 paths 内 = D4 未修） |
| 9 | `node tests\learn\validate-gate-registry.mjs` | `15 PASS / 0 FAIL`（含"接线双向为真"；本次新增接线未破坏登记表一致性） |
| 10 | `NODE_PATH=(npm root -g) node tests\reliability\yaml-parse-check.mjs` | `YAML CHECK: 6 ok, 0 failed`（含本轮改动的 ci-level1.yml） |
| 11 | 全仓 `node --check`（所有 `.js`/`.mjs`，排除 node_modules） | 无 SYNTAX FAIL |

---

## 5. 未覆盖边界（如实登记，不洗绿）

1. **三个控制本轮全部是"本机实测"**（Windows / node v22.22.2 / PATH 上有 git）——**尚未在 GitHub runner 上执行过**。
   "接线正确"≠"已在 runner 上跑过"；CI 侧证据需下一次工作流运行才能补上。
2. H7 断言的是"某条 workflow 文本里真实出现该套件"，**不是**"该步骤在 runner 上一定被调度"：
   `paths:` 过滤导致的"航道不触发"属 **D4** 范围，本轮**未**修（已在 D4 证据档登记）。
3. 三个控制各自把树复制到 `%TEMP%`（不含 `.git`/`node_modules`，约 5–8 MB）并 `git init`+提交，单次约多耗 1–3 秒；
   本地可接受，CI 上是非零成本（尚未测量 runner 上的实际耗时）。
4. 副本内的 `git init` 依赖 runner 上有 `git`（`windows-latest` 默认具备；未在无 git 环境下验证失败表现——
   按 §1.4 的设计，此时会以"基线不是绿的"这一条显式断言失败，而不是伪装成用例不符）。
5. 本轮**未**改动：发布件 `P4_REMEDIATION_CLOSURE_20261001-0425.md` 的哈希封条、被评审时的权威正文
   `EXTERNAL_REVIEW_REMEDIATION_CLOSURE_R1.md`、`FINAL_EXTERNAL_REVIEW_MANIFEST.md`（评审对象清单保持原样）。

---

## 6. 本轮改动清单

| 文件 | 改动 |
|---|---|
| `tests/roadmap/test-p4-status-per-ac-consistency.mjs` | 副本 `git init`+一次提交；"基线必须为绿"提升为显式断言（含失败时打印前 12 条 FAIL） |
| `tests/roadmap/validate-p4-status-consistency.mjs` | H7 泛化：四个控制套件必须存在且被某条 workflow 真实调用 |
| `tests/roadmap/test-finding-e-negative-control.mjs` | 新增注入 C（H7 可证伪）；断言 11 → 14；`REAL_FILES` 纳入 ci-level1.yml |
| `.github/workflows/ci-level1.yml` | 新增 Finding A / Finding B 控制步骤；补齐 E 控制步骤；四处说明"证伪什么" |
| `docs/roadmap/P4_STATUS.json` | `_r2Remediation` 补记本轮两条发现与修法；登记本档案锚点 `doc.r2ControlHardening` |
| `docs/roadmap/reports/.../evidence/R2_CONTROL_HARDENING_20261001.md` | 本文件（新增） |
