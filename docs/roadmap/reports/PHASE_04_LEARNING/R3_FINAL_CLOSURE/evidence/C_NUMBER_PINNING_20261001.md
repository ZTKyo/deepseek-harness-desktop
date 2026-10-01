# Finding C 证据 —— 权威文档自述数字被"钉住"（2026-10-01，R2）

> **对象**：External Review Round 3 的非阻塞发现 **C**。
> **性质**：精度类（不是"结论错"，是"数字会过期且没人管"）。
> **处置**：R2 **没有**把 `43` 改成 `45`——那样只是把过期日期往后推一次；R2 消灭的是"文档里手写数字"这一类别。
> **原始输出**：`_p4rem-closure/r2-regression/gate-battery.log`（电池 A）与本文件内引用的段落逐字一致。

---

## 0. 一句话结论

评审原话：权威文档自述 `43 断言 / 1420 行 / 55 豁免`，门实测 `45 / 1934 / 59`，**且没有任何门钉住这三个数字**。
R2 的处置分两步：

1. 文档里**只保留一行**机器可核的数字声明（在 `docs/roadmap/CURRENT_STATUS.md`
   的「【数字口径·机器可核】」行）；
2. 该行的每个数字由校验器 **I1 / I2 / I3** 在**运行时当场重算并逐字比对**：
   - **I1** = 该行必须存在且形状正确（fail-closed，**删除该行 ⇒ 直接红**）；
   - **I2** = 声明的断言数 == **本门自身的运行时断言总数**（不是 `check()` 调用点个数）；
   - **I3** = 声明的历史保全数字（文档数 / HEAD 行数 / 表格分隔行豁免数）== **当场重跑**
     `verify-history-preserved.mjs` 得到的结果。

⇒ 任一侧单独改动而另一侧未改，**门立刻变红**，不再依赖"人记得同步"。

---

## 1. 机器可复算的四个基线（本节所有数字均为实测，非转述）

| # | 基线 | 断言数 | HEAD 行数 | 表格分隔行豁免 | 该值的来源 | 判定 |
|---|---|---|---|---|---|---|
| 1 | 权威文档 R2 前的自述（写于更早基线） | 43 | 1420 | 55 | `CURRENT_STATUS.md` 历史自述（已标注保留） | **过期**（无门钉住 ⇒ Finding C 的原始现象） |
| 2 | 本 R1 报告自述（本文件 §1/§5 等处的 `45/45`、`1800`） | 45 | 1800 | 59 | R1 作者期实测值 | 断言数与豁免数在其作者期成立；**行数在封条时已过期**（见下） |
| 3 | Round 3 评审实测（对象 = `74adf93`） | 45 | 1934 | 59 | 评审者独立跑出的数 | **正确**；封条方已在 `74adf93` 上逐项复现（同为 45 / 1934 / 59） |
| 4 | R2 当前基线（`main@63bf558` + R2 整改） | **90** | **1961** | **59** | 由 I1–I3 **当场重算**（唯一当前口径） | 机器钉住 |

**行数为什么会从 1800 涨到 1934（+134）**：D1 时效标注是**追加在历史行行尾**的（保证"历史行原文仍是该行严格前缀"），
这些**新增的非空行**计入 HEAD 行数。⇒ R1 报告里的 `1800` 在其写下时是真的，在封条时已经过期——
**这正是 Finding C 的普遍规律**：手写数字在"文档自身被追加内容"时也会过期，所以 R2 的解法是"让门来算"，不是"记得改"。

**断言数为什么从 45 涨到 90**：R2 新增了 I1–I3（数字钉住）、H7 泛化（控制存在 **且** 有 CI 归属）、
以及逐条 AC 裁决平价等断言；I2 的判据是**运行时**总数，所以这类"写代码时顺手加断言"的行为**不会再让文档过期**。

### 1.1 本机制当场抓到过一次"自己造成的漂移"（如实记录）

R2 收口时，为了让本证据档也能被锚点门定位，往 `P4_STATUS.json` 的 `docAnchors` 里**新增了一个锚点**
（`doc.cNumberPinning`）。锚点表每一项都要在 G 段被断言"能解析"，所以**运行时断言总数 89 → 90**，
而文档里声明的数字还是 89 —— 门立刻红：

```
FAIL  I2 the declared assertion count equals THIS gate's runtime assertion total (Finding C: pinned, not hand-maintained) — declared=89 runtime=90
ASSERTIONS: 90  PASS: 89  FAIL: 1
P4 STATUS CONSISTENCY: FAILED
```

把声明值更正为 90 后回绿（`ASSERTIONS: 90  PASS: 90  FAIL: 0`）。
**这正是该机制存在的意义**：改动导致的数字漂移在**同一次运行里**就被指出来，而不是等下一轮评审读文档时才发现。
（不记录这段会显得"整改一次就永久绿"，那是假象。）

---

## 2. 门本身的原始输出（R2 当前基线，可重复运行）

```
$ node tests/roadmap/validate-p4-status-consistency.mjs
PASS  I1 authority document carries exactly one machine-checkable numeric declaration line (fail-closed shape)
PASS  I2 the declared assertion count equals THIS gate's runtime assertion total (Finding C: pinned, not hand-maintained)
PASS  I3 the declared history-preservation numbers equal a freshly re-run history gate (documents / HEAD lines / exemptions)
ASSERTIONS: 90  PASS: 90  FAIL: 0
P4 STATUS CONSISTENCY: PASSED
```

```
$ node tests/roadmap/verify-history-preserved.mjs
DOCUMENTS: 14  PASS: 14  FAIL: 0  HEAD LINES CHECKED: 1961
NOTES: 59 table-separator row(s) exempted from the prefix rule
HISTORY PRESERVATION: PASSED (historical text intact; changes are additive only)
```

（上表第 4 行的三个数字就是这两条命令**当场算出来**的数——不是任何人写下来的。）

---

## 3. 可证伪性：控制套件 `tests/roadmap/test-finding-c-number-pinning.mjs`

一条"永远绿"的断言等于装饰。该控制**不改仓库文件**，而是把工作树镜像到临时目录
（`git init` + 一次提交，使锚点门的"冻结历史行豁免"仍然成立），先在镜像上要求**基线必须绿**，
再**逐一注入三种缺陷**，并要求对应断言从 PASS 翻成 FAIL：

| 注入 | 注入内容 | 必须翻红的断言 |
|---|---|---|
| A | 把声明的断言数改成过期值 | **I2** |
| B | 把声明的 HEAD 行数改成过期值 | **I3** |
| C | **整行删除**数字声明行 | **I1**（fail-closed） |

每种注入后都要求"还原 ⇒ 恢复绿"，证明不是靠偶发失败过关。

```
$ node tests/roadmap/test-finding-c-number-pinning.mjs
NEGATIVE CONTROL: 17 assertions  PASS: 17  FAIL: 0
VERDICT: the number-pinning assertions (I1/I2/I3) are falsifiable.
```

---

## 4. CI 归属（Finding G 的一半）

该控制已接入 **required workflow** `.github/workflows/ci-level1.yml`；
校验器 **H7** 断言"每个控制文件存在**且**被某个 workflow 调用"，
并由 Finding E 负控的**注入 C**（删掉接线行 ⇒ H7 PASS→FAIL，还原 ⇒ 绿）证明 H7 本身可被证伪。

⇒ 结论：数字不再是"文档里的承诺"，而是"两条命令 + 一条 CI 步骤"的**可复算事实**。

---

## 5. 未覆盖边界（如实登记）

1. 本机制钉住的是**四个数字**（断言数 / 文档数 / HEAD 行数 / 豁免数），
   **不**覆盖文档里其它历史自述数字（例如本 R1 报告 §1/§5 的 `45/45`、`1800`）。
   那些值**按 D1「只标注不改写」纪律保留为历史记录**，并在本报告的 R2 附录 §21.2 的对账表里逐一定位；
   唯一当前口径是第 1 节表中第 4 行。
2. I-组断言比较的是**声明值 vs 当场重算值**；如果**两者被人同时改成同一个错值**，I 组不会红。
   这不是本次要防的威胁模型（防的是"无意的漂移"）；对抗性篡改由仓库层面的评审/分支保护承担。
