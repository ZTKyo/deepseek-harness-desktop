# D3 / D4 — 合并门（merge gate）根因分类与修复蓝图

> **文档性质**：只读复核 + 根因分类的**证据与治理记录**。本文件**不是**状态权威；
> P4 当前状态的唯一口径见 `docs/roadmap/CURRENT_STATUS.md` 的「2026-10-01 External Review remediation」段。
> **本文件记载的内容全部未执行**（无 GitHub 设置写入、无 workflow 改动），属"记录 + 待授权"。

- **审计基线**：`main@63bf5585c64742169c8b66ddfc2938e7de936343`
- **复核日期**：2026-10-01
- **范围**：D3（branch protection / ruleset 未启用）、D4（必需检查被 paths 过滤跳过）
- **方法**：只读。GitHub 侧仅 GET；本地仅 `git ls-files` / 读取 workflow / 运行只读审计器。
  **未**创建或修改任何 ruleset、protection、workflow、PR 或 dispatch。

---

## 0. 先给结论

| # | 事项 | 判定 |
|---|---|---|
| 1 | `audit-merge-enforcement.mjs --strict` 当前 exit **1**（红灯） | **实测复现**（本文件 §4 有 BEFORE/AFTER） |
| 2 | "红门能到达 main" 的路径**真实存在** | **成立**（A/B/C 三条根因） |
| 3 | 评审给出的修复方案（"加 ruleset 或加 `push:main`，二者任一即可转绿"） | **错误**（本文件 §5 有机器验证；采纳它会白改一轮） |
| 4 | D3 是否构成 AC10 失败 / 是否推翻 2026-09-30 封条 | **否**（合同无此要求，属超合同加固项，§6-G） |
| 5 | 本轮是否修 | **未修**：需业主授权（改仓库设置 = 能力边界；改 L3 触发 = 变更必需门语义），属 Part B |

---

## 1. 线上事实（只读 GET 实测）

**必需检查 = 3 个 context，且 context 名 == Actions job 的 `name:` 字段：**

| context | 来源文件 | 触发 |
|---|---|---|
| `Static + secret + syntax gate` | `.github/workflows/ci-level1.yml` | `pull_request[main]` + `push[reliability-v1]` |
| `Reliability state machine tests` | `.github/workflows/ci-level2.yml` | `pull_request[main]` + `push[reliability-v1]` |
| `DSH boot + readiness smoke` | `.github/workflows/ci-level3.yml` | `pull_request[main]` + `workflow_dispatch`，**带 workflow 级 `paths:` 过滤** |

`main` 的 legacy branch protection 实测：`strict=true`、`enforce_admins=true`、
`allow_force_pushes=false`、`allow_deletions=false`、`required_pull_request_reviews=null`；
**rulesets 列表为空（0 个）**。

**本地可复算的独立复核**（本轮实跑，非引用）：

```
$ git grep -n 'reliability-v1' -- .github/workflows/
.github/workflows/ci-level1.yml:7:    branches: [reliability-v1]
.github/workflows/ci-level2.yml:7:    branches: [reliability-v1]
$ node tools/check-l3-paths-coverage.mjs
workflow          : .github/workflows/ci-level3.yml
paths patterns    : 18
tracked files     : 638
OUTSIDE the filter: 211 (33.1%)  <-- changes here never create an L3 run
```

⇒ **上述三点（无 push→main 触发 / 零 ruleset / 33.1% 文件在 L3 过滤之外）均已由本仓库内可复算的
命令独立确认**，不依赖任何子代理的自述。

---

## 2. "3 / 2 / 0" 三个数字的真相（不是同一口径的矛盾）

| 数字 | 含义 | 来源 |
|---|---|---|
| **3** | 当前必需 context 数 | 线上 protection 实测 |
| **2** | **闭合前**的历史值（当时仅 L1/L2） | `CURRENT_STATUS.md:46-47` 自述 |
| **0** | `main` HEAD 上**永远为 0 个 check-run**（无 push→main 触发） | 线上 `check-runs` 实测 |

三者是**不同时点/不同对象**的度量被并列陈述，**不是**同一基线的自相矛盾。

---

## 3. 根因分类（A–G）

`audit-merge-enforcement.mjs --strict` 的 exit 1 由 `hard = 直推未拦数 > 0 || PR 未拦数 > 0 || adminBypass`
决定。逐条根因：

| 代号 | 根因 | 类别 | 证据 |
|---|---|---|---|
| **A** | **没有任何 workflow 在 `push → main` 上触发**（L1/L2 仅 `push[reliability-v1]`；L3 仅 `pull_request` + `workflow_dispatch`；L4 仅 `workflow_dispatch` + `schedule`）⇒ 直推 main 时必需 context **不可能**被报告 | 真实缺口 | `git grep`（本文件 §1） |
| **B** | **承载缺失**：`required_pull_request_reviews=null` 且 **rulesets = 0** ⇒ 没有任何规则**禁止**直推 main | 真实缺口 | 线上 protection + rulesets 实测 |
| **C** | **必需检查语义不覆盖直推**：legacy required contexts + `enforce_admins=true` 的审计器模型里，直推路径的 `blocked` 依赖 `rulesetEnforcesChecks` ⇒ 无 ruleset 时直推不被拦 | 真实缺口（含 1 个未判定前提，§7） | 审计器 `:135` `:161` `:231` `:245` |
| **D** | **paths 过滤死锁**：L3 被 workflow 级 `paths:` 过滤，33.1% 的仓库文件（211/638，含 `src/DSHHarness.cs`、`plugins/cordis.patch.yml`、`supervisor-mcp-adapter/server.mjs`）落在清单外 ⇒ 这类 PR 的必需 context 永不报告 ⇒ "Waiting for status to be reported" | 真实缺口（与 D3 耦合） | `node tools/check-l3-paths-coverage.mjs` |
| **E** | **绕过承载**：审计器把"无 ruleset"本身视为直推路径的绕过承载（`bypassOpen = rulesetBypassOpen \|\| (enforceAdmins===false && !rulesetEnforcesChecks)`）；当前 `enforce_admins=true` 关掉了 admin 绕过，但承载仍缺 | 承载类 | 审计器 `:130` `:135` |
| **F** | **证据可得性**：`main` HEAD 的 `check-runs total=0`，无法仅凭 API 证明"该提交上必需检查真的跑过并通过" | 证据类（独立事实，见 §5） | 线上 `check-runs` 实测 |
| **G** | **合同作用域**：canonical 合同 AC1–AC10 与执行 Prompt 全文**无** ruleset / branch protection / `push:main` / GH006 / "直推"字样；2026-09-30 封条自述的 AC10 定义 = 3 contexts + `enforce_admins=true` + `strict=true` + 行为实证（PR #100 BLOCKED / #99 MERGED），**亦不含 ruleset** | 合同结论 | `CONTRACT_RECONCILIATION_R1.md:122-132`（canonical 逐字）+ `CURRENT_STATUS.md:43-49` |

⇒ **D3 不构成 AC10 失败、不推翻封条**（G）；它是**超出合同的加固项**，且**尚未登记在残留清单**里。

### 3.1 按任务规定的 A–G 分类重新落位（**以本表为准**）

上表的 A–G 是本文件早先自拟的细粒度根因代号。任务 §11 规定了**固定的七类**，
两者字母相同、含义不同，故此处按**规定分类**逐条落位，避免混淆：

| 规定类别（任务 §11） | 本项目落位 | 是否真的违反 P4 合同 |
|---|---|---|
| **A. P4 contract failure** | **无**。canonical 合同与执行 Prompt 全文无 ruleset / branch protection / `push:main` / GH006 / "直推"字样；封条自述的 AC10 定义 = 3 contexts + `enforce_admins=true` + `strict=true` + 行为实证 | **否** |
| **B. repository governance** | **主因**：① 无任何 workflow 在 `push → main` 触发；② `required_pull_request_reviews=null` 且 rulesets = 0；③ L3 的 workflow 级 `paths:` 过滤使 33.1% 文件的 PR 必需 context 永不报告 | **否**（治理缺口） |
| **C. documentation inconsistency** | **有 1 项，本轮已修**：D3/D4 此前未登记在任何残留/待办清单（已写入 `CURRENT_STATUS.md` ⑦ 与本文件） | 否 |
| **D. false positive** | **无**。审计器报的"直推未被拦"不是假阳性——A/B/D 三条缺口均由本仓库内可复算命令独立确认（§1、§4） | 否 |
| **E. unrelated scope** | **部分**：`main` HEAD `check-runs = 0`（D5）与 `.github/` 配置本身都不在 P4 学习机制 scope 内 | 否 |
| **F. historical artifact** | **部分**：`main` 自 2026-09-23（`00d28fcfcf`，PR #92）起无任何直推 ⇒ 线上历史**无法**判定"今天直推会不会被拒"，只能靠一次性可逆实验（§7-1） | 否 |
| **G. tool defect** | **有 1 项**：审计器 `:131-132` 把"legacy 必需检查不作用于非合并直推"写成**未经任何实验证实的前提**，并据此判定直推 `blocked=false`——属工具自身未定假设（不是假阳性，也不足以单独定案） | 否 |

### 3.2 任务 §7 要求的固定字段

审计器判定式（`tests/learn/audit-merge-enforcement.mjs:231`）：
`hard = canRedReachMain.prPath.length > 0 || canRedReachMain.directPushPath.length > 0 || canRedReachMain.adminBypass`

```
STRICT BEFORE = exit 1   （--json：prPath=0，directPushPath=6，adminBypass=false）
STRICT AFTER  = exit 1   （同上，数值逐项未变；本轮未改 GitHub 治理、未改审计器判定逻辑）
ROOT CAUSE    = B. repository governance（触发缺口 + 承载缺口 + paths 死锁）；
                附 C. documentation inconsistency ×1（已修）、G. tool defect ×1（未定前提）
P4 BLOCKING   = NO（无任何一条落入 A. P4 contract failure；canonical 合同未要求 ruleset）
```

**上述数值来自本轮实测复跑**（只读，未改任何设置）：
`node tests/learn/audit-merge-enforcement.mjs --strict --json`
→ `adminBypass=false`、`"直推 → main（门：…）"` 共 **6** 条、`gitHead=63bf5585c647`
（= 基线 `main@63bf558`，与封条同一基线）、`generatedAt=2026-09-30T20:04:23Z`
（= 本地 2026-10-01 04:04），exit 1。**注意**：该审计器取证对象是 **`main` HEAD**，
不是本轮工作树 —— 所以它的 BEFORE/AFTER 必然相同，这正是"未造假"的机器证据。

> 附一条**时间语义**澄清（防止被误读为自相矛盾）：审计器 §5 事故实证引用的 **PR #97**
>（2026-09-26 合并、必需检查 `DSH boot + readiness smoke = failure`）证明的是**当时**
> 绕过路径开通；而 §6 与 `--json` 报告的 `adminBypass=false` 是**当前**状态
> （`enforce_admins=true` 已封住 admin 绕过）。两者是**不同时点**，可同时为真。


---

## 4. `--strict` BEFORE / AFTER（无造假证明）

| 时点 | 命令 | 结果 |
|---|---|---|
| **BEFORE**（基线 `main@63bf558`） | `node tests/learn/audit-merge-enforcement.mjs --strict` | **exit 1** |
| **AFTER**（本轮文档/门禁补强后的工作树） | 同上 | **exit 1**（未变） |

**机器数值（BEFORE 与 AFTER 完全相同，因审计器取证对象是 `main` HEAD）**：

```
prPath            = 0        （PR → main：红门被拦）
directPushPath    = 6        （直推 → main：红门能到达 main）
adminBypass       = false    （enforce_admins=true ⇒ admin 绕过关闭）
gitHead           = 63bf5585c647   （= 基线 main@63bf558）
⇒ hard            = true ⇒ exit 1
```

**为什么 AFTER 仍是 1 —— 且这是正确的结果**：A/B/C/D 全部是 **GitHub 设置 + workflow 触发**层面的事实，
本轮**没有**触碰它们（改它们需要业主授权，见 §8）。本轮做的是**记录与分类**，不是把红灯涂绿。

**无造假证明（三道）**：

```
$ git diff --quiet HEAD -- tests/learn/audit-merge-enforcement.mjs ; echo $?
0                     # 审计器字节与 HEAD 完全一致 ⇒ 未加 exit-0 硬编码、未删规则、未改阈值
$ git diff --numstat HEAD -- tests/learn/audit-merge-enforcement.mjs
(空)                  # 无任何改动
```
① 审计器**字节未变**（上）；② 本轮**未**创建/删除任何 GitHub 规则；③ 本轮**未**把 `--strict` 包进
任何"总是成功"的包装脚本。**红线遵守**：没有把红灯改绿，也没有弱化门。

> 设计说明：本轮新增的 `tests/roadmap/*` 与 `tools/check-l3-paths-coverage.mjs` 都是**独立新门/只读分析器**，
> 不参与 `audit-merge-enforcement` 的判定，不改变其结论。

---

## 5. 评审修复方案的正确性验证（关键纠正）

评审结论是"**加 ruleset，或加 `push:main` 触发，二者任一即可让审计器转绿**"。把审计器
`:135/:161/:231/:245` 的布尔式按线上实测值代入后：

| 情形 | 直推 `blocked` | `bypassOpen` | audit exit |
|---|---|---|---|
| ① 现状（无 ruleset、无 push:main） | 否 | 否 | **1** ✓（与实测一致） |
| ② 只加 `push:[main]` | 否 | 否 | **1** ← 评审说会转绿，**不成立** |
| ③ 只加"必需检查型 ruleset"（无 `pull_request` 规则） | 否 | 否 | **1** ← 同上 |
| ④ ②+③ 同时 | 是 | 否 | 0 |
| ⑤ **含 `pull_request` 规则、`bypass_actors` 为空的 ruleset**（不需 push:main） | 是 | 否 | **0** ← **唯一单点解法** |

⇒ **口径更正**：只有「**含 `pull_request` 规则、且 bypass 为空**」的 ruleset 能**单独**把审计器转为
exit 0；单独加 `push:main` **不能**。此结论已由本表逐式代入验证，供后续执行者直接采用。

---

## 6. 最小修复蓝图（**未执行**，仅蓝图）

### 铁律：**先修 D4（paths 死锁），再修 D3（直推）**
顺序反了，会把"清单外 211 个文件可绕行"变成"清单外 211 个文件彻底无路"（PR 永久卡住，
且其中含生产代码 `src/DSHHarness.cs`、`plugins/cordis.patch.yml`、`supervisor-mcp-adapter/server.mjs`）。

**方案 A（修 D4；1 个 workflow 文件）**
- 去掉 `ci-level3.yml` 的 **workflow 级** `paths:`，改为"workflow 恒触发 + 过滤下沉"：
  增加轻量 change-detection（`git diff --name-only` 或 `dorny/paths-filter`），清单外时让 **job 被 `if:` 跳过**。
  依据：GitHub 官方明文——被 `if:` 跳过的 job **报告 Success**，而 `success`/`skipped`/`neutral`
  都算"满足必需检查"。**不要**用"另建同名占位 job"的路线（官方无承诺）。
- 爆炸半径：每个 PR→main 多排一个 job（清单外秒级结束）；L3 实测耗时 5.2–12.1 min（中位 ≈7）。
- **风险（必须处理）**：过滤判定写错 ⇒ AC6 的真实 E2E 门**静默跳过却报绿**（假绿）。
  ⇒ 必须附"命中清单时断言 E2E 步骤确实跑过"的断言，否则不得合并。
- 对审计器：**不转绿**。

**方案 B（修 D3；GitHub 设置）**
- 新建 main ruleset：`active`、`refs/heads/main`、**`bypass_actors` 留空**、
  含 **`pull_request` 规则**（可选再加 3 个必需检查）。
- **`required_approving_review_count` 必须 = 0** —— 单操作者仓库若要求审批，将永远无法合并任何 PR。
- 爆炸半径：业主**永久不能直推 main**（可删 ruleset 回退）。**必须在方案 A 之后**。
- 对审计器：**唯一能转绿的单点解法**（情形 ⑤）。

**方案 C（修 D5；2 行）**
- `ci-level1.yml` / `ci-level2.yml` 的 `push: branches: [reliability-v1]` → `[reliability-v1, main]`。
- 效果：`main` 不再 0 check（D5 消除）。**单独做 C 不转绿**（情形 ②），且**单独做 C 会让红灯到达 main**
  ⇒ 它的价值是"与 B 组合后的验证"，不是"补门"。**不可单独先做**。

**方案 D（D1/D2 类，低风险）**
- 3 个必需 context 落机器可读单一真源（如 `docs/roadmap/governance/required-checks.json`），
  审计器/CI 与线上 protection 比对，漂移即 fail。
- 注：本轮已建立同类"parity index + fail-closed 校验器"范式（`docs/roadmap/P4_STATUS.json` +
  `tests/roadmap/validate-p4-status-consistency.mjs`），方案 D 可直接复用该范式。

---

## 7. 未判定项（NOT DETERMINED）与决定性实验

**共同前提**：以下实验都**需要 GitHub 写权限**，因此**需业主授权**后才能执行。

1. **今天直推 main 是否会被拒（GH006）**：线上证据（`enforce_admins=true` + 3 必需检查 + 无 PR 强制 + 零 ruleset）
   **不足以判定**；REST 对 `enforce_admins` 的描述像"应拦"，但无一句覆盖"非合并直推"。
   仓库自 2026-09-26 起**无任何直推 main**（first-parent 链最后非 merge 提交 = `00d28fcfcf`，2026-09-23，PR #92）
   ⇒ 线上历史无法判定。**实验**：建一次性 `_prot-test` 分支，protection 与 main 同构，
   试一次 fast-forward 直推，记录是否被拒，随后删分支与 protection。**不碰 main、完全可逆**。
   —— 该实验**同时**为 §3-C 中审计器自己的未验证前提（`:131-132` "legacy 必需检查不作用于直推"）定案。
2. **`workflow_dispatch` 补跑 L3 能否满足 legacy 必需检查**：仓库某处记载的处置
   （`CURRENT_STATUS.md:73`"workflow_dispatch L3 使必需检查在该 SHA 报告"）与 GitHub 文档
   "由 `workflow_dispatch` 在 PR head 分支触发的检查**不出现**在该 PR 的 checks 区、即使通过也**不满足**
   必需状态检查"**相冲突**（后者写在 ruleset 语境，legacy 是否逐字同理**未逐字覆盖**）。
   ⇒ 列为**待实验**，在定案前**不得**再把它当作已知有效的处置陈述。
3. **同名多 check 能否满足一个必需 context**（"占位门"路线）：官方无承诺；采用方案 A 即可绕开该不确定性。
4. **修 D3 后清单外路径是否真无处可去**：取决于 #1。

---

## 8. 状态与授权边界

- **本轮执行内容**：**只读复核 + 本文档记录**。未改 ruleset、未改 protection、未改 workflow、
  未 dispatch、未建/关 PR。
- **本轮未修的原因**：A 改的是**必需门的语义**（有"假绿"风险，需断言兜底 + PR 探针验证）；
  B 改的是**仓库能力边界**（业主将永久失去直推 main 的能力）。二者都超出"修 bug"的授权，
  属 Part B「需授权」范围。
- **建议给业主的一行话**：**先做 A（可逆、仓库内、可验证），验证通过后再做 B（外部设置），
  并接受"此后不能直推 main"这一结果**；`required_approving_review_count` 保持 0。
- **诚实边界**：本文件 §3 的 C 依赖审计器自身未验证的前提（§7-1 可一次实验同时定案）；
  在实验完成前，"直推是否真能被拦"仍是**未判定**，因此本文件**不**声称"已证实存在可利用的实害"，
  而只声称"审计器与线上事实共同指向存在该路径"。

---

## 9. 复现命令（全部只读）

```bash
# 线上事实
gh api repos/ZTKyo/deepseek-harness-desktop/branches/main/protection
gh api repos/ZTKyo/deepseek-harness-desktop/rulesets
gh api "repos/ZTKyo/deepseek-harness-desktop/commits/main/check-runs" | head -c 400
# 本地可复算
git grep -n 'reliability-v1' -- .github/workflows/
node tools/check-l3-paths-coverage.mjs
node tests/learn/audit-merge-enforcement.mjs --strict ; echo "exit=$?"   # 期望 1（未修）
git diff --quiet HEAD -- tests/learn/audit-merge-enforcement.mjs ; echo "exit=$?"  # 期望 0（未造假）
```
