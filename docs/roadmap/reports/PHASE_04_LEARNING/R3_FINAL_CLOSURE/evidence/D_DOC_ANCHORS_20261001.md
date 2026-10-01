# Finding D 专档：文档定位弃用手写行号、改用可机检锚点

- 轮次：`p4-final-remediation-r2`（闭环 P4 External Review R1 Finding D，2026-10-01）
- 工作树：`C:\Users\Administrator\Desktop\sdeepseek harness\_p4rem-wt`
- 审计基线：`main@63bf5585c64742169c8b66ddfc2938e7de936343`（本文件所述改动**未**提交、**未** push）
- 相关文件：
  - 门：`tools/check-doc-anchors.mjs`（新增）
  - 负控：`tests/roadmap/test-anchor-gate-negative-control.mjs`（新增）
  - 注册表：`docs/roadmap/P4_STATUS.json` → `docAnchors` / `linePointerBans`
  - 断言：`tests/roadmap/validate-p4-status-consistency.mjs` §G（G1–G7）
  - 被修文档：`docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/A10_CONTRACT_MATRIX.md` 等

---

## 1. 一句话结论

**Finding D = 已修复（根因级）**：文档定位不再依赖手写行号，改为**锚点 + 当场解析**；
并且新增两道"会真的变红"的机器门——① 锚点缺失即 FAIL（fail-closed）；
② **新写入**的行号式定位即 FAIL（append-only 历史豁免）；两道门都有**可复现负控**证明其能变红。

---

## 2. 根因（可复算的实测，不是推测）

手写行号指针是**派生数据**：文档一改，指针整体偏移，而指针本身"看起来还在"，
任何现有门都不会响。实测：`A10_CONTRACT_MATRIX.md` 在其更正表写下**「字母 L + 数字」式**的
5 处行号指针，在文件此后整体偏移 **+34 行**后**已不再指向所引原文**
（本档**刻意不复述那批失效数字**——复述它们等于为"取消手写行号"的修复再造新的行号指针；
需要真实行号时一律跑门当场打印）。

- `docs/roadmap/CURRENT_STATUS.md` 的 D1 索引第 4 行据此登记为：
  「L23 指向 `A10_CONTRACT_MATRIX.md:33` 并称裁决 PARTIAL（**指针已不再解析到所引原文**）」。
- 关键点：**不是"改对一次"就完了**（下次还会漂）；修法是**取消手写**这一动作本身。

---

## 3. 修法（三层，缺一层就等于没修）

| 层 | 内容 | 失败时的行为 |
|---|---|---|
| ① 解析层 | 注册表 `docAnchors`：13 条锚点，按「文档 + 标题 / 行内唯一文本 / 代码标识」定位；真实行号由门**当场算出并打印** | 锚点缺失/不再唯一 ⇒ **FAIL**（不静默） |
| ② 阻断层 | 注册表 `linePointerBans`：2 处已确认漂移点**不得再出现手写行号**；三段式判据 = 命中 `banPattern` ∧ **不是** `git show HEAD:<file>` 的冻结文本 ∧ 未同时给出锚点 | 命中 ⇒ **FAIL** |
| ③ 证明层 | 负控测试：临时 fixture 三条用例（裸行号必须红 / 同带锚点必须绿 / 被禁区块外不误杀） | 门退化为"永远绿"时 G7 失败 |

设计取舍（写清楚，避免被读成"放水"）：
- **历史豁免**用 `git show HEAD:<file>` 的冻结文本作判据，而不是"整段跳过"——D1 纪律是
  **只标注、不改写历史**（历史保全门 `verify-history-preserved.mjs` 同时要求历史行仍在）。
- 冻结判据要求 HEAD 行是新行的**严格前缀且长度 ≥8**：一个孤立的 `>` / `---` 曾把负控注入的
  新行误判为"历史"，该退化路径已被负控用例 1 锁住。
- 锚点注册表为空时门 **fail-closed**（"没有可检的东西"≠"通过"）——负控开发过程中实测到这一点，
  故负控 fixture 自身也必须声明一个锚点。

---

## 4. 原始输出（逐条可复现）

### 4.1 门 PASS（含 13 锚点解析出的真实行号）

```
$ node tools/check-doc-anchors.mjs
=== D. 文档锚点（行号由本门当场算出，禁止手写） ===
  注册表: docs\roadmap\P4_STATUS.json
  id                              kind      line    status
  A10.currentStatus               heading   L11     OK
  A10.section1                    heading   L67     OK
  A10.section3                    heading   L95     OK
  A10.ac6row                      line      L76     OK
  A10.superseded.ac6ac10          line      L98     OK
  AC6.gapSection                  heading   L24     OK
  AC6.a10pointer                  line      L29     OK
  STATUS.d1index                  line      L803    OK
  R1.d12section                   heading   L195    OK
  code.learn.loadBoundaryHeal     code      L591    OK
  code.learn.redactToken          code      L596    OK
  code.audit.summarize            code      L55     OK
  code.audit.selfTest             code      L121    OK

=== D2. 手写行号指针禁令（D 的回归锁） ===
  ban.A10.banner                  OK :: no new hand-written line pointer (frozen history lines exempted: 6, anchor-bearing: 0)
  ban.STATUS.d1row                OK :: no new hand-written line pointer (frozen history lines exempted: 1, anchor-bearing: 0)

DOC ANCHORS: 13  RESOLVED: 13  BANS: 2  FAIL: 0
DOC ANCHOR GATE: PASSED
exit = 0
```

### 4.2 负控 A：真实文档注入一条**新**的裸行号 ⇒ 门必须变红

在被禁区块（A10 文件头更正表 banner）**新写入**一行 `> NEW-LINE-POINTER L999 (negative control injection)`，
其余不动：

```
$ node tools/check-doc-anchors.mjs
  ban.A10.banner                  FAIL :: 1 new hand-written line pointer(s) without an anchor
  L12 :: > NEW-LINE-POINTER L999 (negative control injection)
DOC ANCHORS: 13  RESOLVED: 13  BANS: 2  FAIL: 1
FAILURES:
  - ban ban.A10.banner: 1 new hand-written line pointer(s) without an anchor
exit = 1        ← 期望 1
（随后从备份逐字节还原；复跑恢复 PASS）
```

### 4.3 负控 B：离线 fixture 三条用例（不触碰仓库任何真实文档）

```
$ node tests/roadmap/test-anchor-gate-negative-control.mjs
=== D negative control: can the line-pointer ban actually fail? ===
  PASS  negctl-1 bare new line pointer is caught  (exit=1 want=1 contains="negctl.bareLinePointer")
  PASS  negctl-2 anchor-bearing line pointer is allowed  (exit=0 want=0)
  PASS  negctl-3 pointer outside the banned block is not flagged  (exit=0 want=0)

NEGATIVE CONTROLS: 3  PASS: 3  FAIL: 0
ANCHOR GATE NEGATIVE CONTROL: PASSED (the ban is falsifiable, not decorative)
exit = 0
```

### 4.4 全仓普查（如实衡量范围，**不**声称"全仓已无行号指针"）

```
$ node tools/check-doc-anchors.mjs --census
=== D-census. 全仓手写行号指针普查（启发式；只报告，不改变本门判定） ===
  扫描文档 124 个，候选命中 318 处，涉及文件 58 个
      31  docs/audits/CODEX_FULL_HARNESS_AUDIT_20260823.md
      19  docs/roadmap/CURRENT_STATUS.md
      18  docs/roadmap/reports/PHASE_04_LEARNING/R2/P4_R2_REVIEW_BLOCKER_FIX_R1.md
      18  docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/A10_CONTRACT_MATRIX.md
      17  docs/roadmap/evidence/P4_D11_D13_REMEDIATION_20261001/REGRESSION_COUNT_AUDIT/FINAL-AUDIT.md
      …（完整清单用 --json）
DOC ANCHOR GATE: PASSED
exit = 0
```

---

## 5. 范围与边界（如实登记，不放大结论）

1. **禁令当前覆盖 2 处已确认漂移点**（A10 更正表 banner、CURRENT_STATUS 的 D1 索引第 4 行），
   **不是**"全仓 318 处候选都已被判定"。
2. 普查到的 318 处候选多为**历史文本**（含命令输出示例、评审原文引述）；按 D1 纪律
   **只标注、不改写**，因此本轮**未**做全仓改写。全仓改写会与
   `verify-history-preserved.mjs`（历史行必须仍在）直接冲突，属需另行授权的动作。
3. 普查是**启发式**（`L\d{2,4}` / `文件.md:33` / 「第 N 行」），会误报命令输出里的行号；
   它只用于衡量范围，**判定权仍在** `docAnchors` / `linePointerBans`。
4. 本文件**不抄录**任何"会漂的行号"作为定位；需要行号时一律跑门当场打印。

## 6. 复现命令（全部只读或自校验）

```bash
node tools/check-doc-anchors.mjs                  # 门（exit 0 = 全过）
node tools/check-doc-anchors.mjs --census         # 门 + 全仓普查（只报告）
node tools/check-doc-anchors.mjs --json           # 机读（含 anchors/bans/census）
node tests/roadmap/test-anchor-gate-negative-control.mjs   # 负控（exit 0 = 门可被证伪）
node tests/roadmap/validate-p4-status-consistency.mjs      # parity（含 §G G1–G7）
node tests/roadmap/verify-history-preserved.mjs            # 历史保全（只增不删）
```

## 7. 未判定 / 未修（不得读成"已全部解决"）

- 全仓 318 处候选**未逐个判定**（仅定性为"多数属历史文本"，未逐条复核）。
- 禁令区块**未**扩展到全仓；若后续要扩展，需先解决与历史保全门的冲突（只增不删约束）。
- `code.*` 锚点指向的是**代码标识行**（如 `redactStore`）而非语义行号；若实现移动，
  锚点会 FAIL 提醒更新注册表——这是有意的，不是缺陷。
