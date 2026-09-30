# FINAL_EXTERNAL_REVIEW_MANIFEST.md

> **用途**：为 P4 最终外部评审（Round 3）固定一个**不可变的评审对象**，并记录其证据哈希与
> 诚实门状态。本文件是**事后记录**（documentation only）；它本身**不是**评审对象的组成部分。
>
> 生成时间：2026-10-01（本轮 FREEZE → PUSH → FINAL EXTERNAL REVIEW 任务）

---

## 1. Review Subject

| 项 | 值 |
|---|---|
| **branch** | `p4-final-external-review-r3` |
| **base SHA** | `63bf5585c64742169c8b66ddfc2938e7de936343` （**=== origin/main**，未改动） |
| **REVIEW_SHA** | `74adf9351c2af2f63035abdbdfa502090ad1af7e` |
| **commit subject** | `P4: freeze remediation closure package for final external review` |
| **PR** | **#103** — https://github.com/ZTKyo/deepseek-harness-desktop/pull/103 |
| **PR state** | `OPEN` / `MERGEABLE` / **NOT MERGED（禁合并）** |
| **remote SHA match** | **YES** — `git ls-remote origin refs/heads/p4-final-external-review-r3` = `74adf93…` = local HEAD |
| **payload** | 18 modified + 71 added = **89 files**, `10932 insertions(+), 23 deletions(-)` |
| **repo** | `ZTKyo/deepseek-harness-desktop`（origin = `https://github.com/ZTKyo/deepseek-harness-desktop.git`） |

### REVIEW SUBJECT IMMUTABLE
**评审对象 = 提交 `74adf9351c2af2f63035abdbdfa502090ad1af7e` 的整棵树**，不是分支头，也不是工作树。
自 push 起该 SHA **不得再被修改**（不 amend / 不 rebase / 不 force push）。
本 manifest 作为该提交的**后续 docs-only 提交**存在，**不改变 REVIEW_SHA 的任何字节**。

评审者必须：
```bash
git fetch origin
git show --stat 74adf9351c2af2f63035abdbdfa502090ad1af7e
git worktree add <tmpdir> 74adf9351c2af2f63035abdbdfa502090ad1af7e   # 只读检出该 SHA
```
**不得**以「工作树」、「聊天摘要」、「过期报告」或「后续提交」作为评审依据。

---

## 2. Artifact Integrity

| 角色 | 路径 | sha256 | 状态 |
|---|---|---|---|
| **canonical / authoritative report** | `docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/EXTERNAL_REVIEW_REMEDIATION_CLOSURE_R1.md` | `478BCF2A5154649C87ED35631FD944BB87108B00096FECF6F06FF7B48ED8D7B9` | 正文权威 |
| **release artifact**（任务指定命名） | `docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/P4_REMEDIATION_CLOSURE_20261001-0425.md` | `EC9DC37A527A10C671BC343299D486249195AC225C81DAB0E0D036F48C536AE5`（整文件） | 4 行头 + 权威正文；**body == authoritative（逐字节）** |
| **verifier** | `tools/verify-release-artifact.mjs` | `B1717964C55B1678E29C4D04B7AFB250B9801D6B0695BF3A11EA54E5E36BC7CF` | 只读，无副作用 |

- `node tools/verify-release-artifact.mjs` → **`RELEASE ARTIFACT INTEGRITY: IDENTICAL` / exit 0**
- 发布文件头部第 3 行记录 `SHA256 = 478BCF2A…D7B9`，与权威正文一致（in sync）。
- 发布文件正文哈希 = `478BCF2A5154649C87ED35631FD944BB87108B00096FECF6F06FF7B48ED8D7B9`（与权威逐字节相同）。

### Negative controls（证明校验器不是「永远绿」；全部作用于 `%TEMP%` 临时副本，真实交付物零污染）

| control | 扰动 | 期望 | 实测 |
|---|---|---|---|
| control-0 | 临时副本原样（baseline） | exit 0 | **exit 0** `IDENTICAL` |
| control-1 | 发布文件正文追尾漂移 | exit 1 | **exit 1** `DRIFT (body-drift)` |
| control-2 | 头部记录的 SHA256 改成错误值 | exit 1 | **exit 1** `DRIFT (header-hash-stale)` |
| control-3 | 还原 | exit 0 | **exit 0** `IDENTICAL` |

**真实交付物在负对照后复验仍为 `IDENTICAL` / exit 0。**

#### ⚠️ 行尾（EOL）说明 —— 避免把 CRLF 误判成 drift
两个 `.md` 在索引与磁盘上**均为 LF**（`git ls-files --eol` → `i/lf w/lf`；磁盘 CRLF 计数 = 0），
头部记录的 SHA256 是 **LF 形态**的哈希。若评审者在 Windows 上以 `core.autocrlf=true`
**新克隆/新检出**，工作树可能变 CRLF，此时校验器可能只报 `header-hash-stale`（**不是** `body-drift`）。
判定口径：**`body == authoritative` 在两种行尾下都成立**（两文件被同样处理），
故以「两份文件是否逐字节相同」为准；如需 LF 视角复算，用 `git show REVIEW_SHA:<path>` 读取 blob。

---

## 3. Gate Battery @ REVIEW_SHA（全部真跑，命令可复现）

| # | Gate | 命令 | 结果 |
|---|---|---|---|
| 1 | Artifact identity | `node tools/verify-release-artifact.mjs` | **IDENTICAL, exit 0** |
| 2 | Negative controls | 临时副本 ×3 扰动 | **0 / 1 / 1 / 0（非永远绿）** |
| 3 | D1 state consistency | `node tests/roadmap/validate-p4-status-consistency.mjs` | **45/45 PASS, exit 0** |
| 4 | D1 history preservation | `node tests/roadmap/verify-history-preserved.mjs` | **14/14 documents PASS, exit 0** |
| 5 | D11 redaction-aware audit | `node tests/reliability/test-redaction-aware-audit.mjs` | **116/116 PASS, exit 0** |
| 6 | Full-tree secret scan | `node tests/reliability/secret-scan-check.mjs .` | **RAW 0 / PLACEHOLDER 0 / REAL 0, exit 0** |
| 7 | Merge-enforcement audit | `node tests/learn/audit-merge-enforcement.mjs --strict` | **exit 1** |
| 8 | Prefix integrity（附加，非仓库门） | 18 个 modified 文件逐行前缀核对 | 文档 **0 violation**；1 行为**代码**行（见下） |

### GATE 7 — STRICT GATE = **RED**（诚实保留，未洗绿）
```text
--strict：存在能让红门到达 main 的路径 ⇒ exit 1
```
含义（来自该审计自身输出）：缺口**不在「门是假的」**（门确实在跑、变异证明也证明它会变红），
而在**承载（required 列表）与绕过（enforce_admins、无 ruleset）**没堵住。
本任务**未**将其改为 warning / skip / exclude，**未**修改 aggregator 使其返回 0。

### GATE 8 明细（诚实标注）
- 18 个 modified 文件中，HEAD 版本里有 4076 行未出现在工作树中——绝大多数是**行内追加式改写**
  （HEAD 整行仍是工作树行的**严格前缀**，符合 "annotate, never rewrite"）。
- **前缀违规 = 1 行**，位于 `tests/reliability/secret-scan-check.mjs`：
  `if (p.re.test(probe)) {` → 被替换为 D11 的红acted-aware 计数逻辑（`rawHits/placeholderHits`）。
  **这是代码行，不是治理/历史文档**；「annotate-never-rewrite」规则适用于文档，文档违规数 = **0**。
- 仓库内正式门 `verify-history-preserved.mjs` 独立判定：**14/14 PASS**。

---

## 4. Findings Carried Into Review（本轮**不修**，仅交付裁决）

| 项 | 状态 | 说明 |
|---|---|---|
| **D2** | **unresolved** | 状态/评估口径未闭合（需状态口径扩展） |
| **D3** | **unresolved** | GitHub ruleset / branch protection 未变更（**本任务禁止修改**） |
| **D4** | **unresolved** | `--strict` = exit 1：红门可达 main 的路径仍在；`ci-level3` 的 `paths:` 过滤未覆盖 `tests/roadmap` |
| AC10 | 待外部裁决 | 由评审者按 canonical contract 在两种解释（A/B）中选择并给 canonical rationale |
| R7 / R8 | 待外部裁决 | 同上 |

评审者必须对 **D2 / D3 / D4** 逐项给出 **BLOCKER / NON-BLOCKING DEBT / OUT-OF-SCOPE** 之一
及 canonical rationale，**不得**只写 "known issue"。

---

## 5. Evidence

| 项 | 值 |
|---|---|
| **evidence directory** | `docs/roadmap/evidence/P4_D11_D13_REMEDIATION_20261001/` |
| files | **61** |
| bytes | **380,625** |
| **set_digest** | `4AC4C50A5986F50D0EE344F625C954A3A159D994EFB14C959571697459AE15E7` |
| ↳ 口径 | 先对各文件取 sha256，再对**按路径排序**的 `"<sha>  <path>"` 行（含末尾换行）取 sha256 |
| 关键子目录 | `REGRESSION_COUNT_AUDIT/`（`FINAL-AUDIT.json|md`、`audit-summary.json`、`logs/*`） |
| 人力门清单 | `HUMAN_GATED_RUNNERS.txt`（human-gated runners 明示，未伪装成自动） |

其他关键文件哈希：

```text
61526F3479F39D131E844023FE087194450BE188511B35042458C47E6C3325F4  docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/evidence/D3_D4_MERGE_GATE_GOVERNANCE_20261001.md
2DEEA749B5959E46071075E877C08006B3CD417B12166759DE89379C3056B2F5  docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/P4_FINAL_VERDICT.md
2FAEC1AAC7F6BA87B2A9759AC174F9CD851ACE55EC711E0E944B090761BFCC32  docs/roadmap/CURRENT_STATUS.md
D3F6934224C65EE218FDE89EA79B9C2DED9F891F62B0F7C06C27B42C5D328341  docs/roadmap/P4_STATUS.json
0A1BC1972763E1EDD12B4C73DAFB184BE55D6410BB009F10BCF286FD265CCF5F  tools/check-l3-paths-coverage.mjs
CDC50481EB1A72722EB592FB0C89FD3454A9C841512E22D6B14A568F93A4B01B  tests/roadmap/validate-p4-status-consistency.mjs
E2719D09C0F3E5700FE0BC20D61B8253236DB22F9D516F23806FE0357C4E64CC  tests/roadmap/verify-history-preserved.mjs
0E1BDDABDFB3AE6B58CEBA41B706F3E4493447665DEA128A38C8B0CC76BDAFA3  tests/reliability/test-redaction-aware-audit.mjs
A5973F951659AE977520FA9497917C60107722361116E11A7DB4A54BA5627FCF  tests/reliability/redaction-aware-secret-audit.mjs
31D639CF53BFEBCB718B3AF033C94F2AB70E4A0D8C52E0FD8526070A353043B1  tests/reliability/secret-scan-check.mjs
9C9A1D0B05453403071BCEB6E5A99A78E220346CFE45F6971E693162CF9AC2C3  tests/learn/audit-merge-enforcement.mjs
78FF4737317E2E291F24F6F1CABEB3DD8ABD1E3F86209CA263DEE9C5452BE3F3  tests/learn/test-learn-core.mjs
93C3F7D9AA1D5135491F5AC832AAB835717D6F70CBE709925C071789B287F441  KNOWN_ISSUES.md
9D8160E3A0BF4259221DD6BBFFCD29BE4F4EFA1E2DF1DDD12C0F291EFAC98489  .github/workflows/ci-level1.yml
```

**CI 工作流改动性质（已审计）**：`.github/workflows/ci-level1.yml` 的改动为**纯追加**——
新增 D1 parity 与 history-preservation 两步，且二者失败即 `exit 1`。审计确认
**对 18 个 modified 文件不存在任何削弱门的删除行**（无 `exit 0` / `continue-on-error` / skip / exclude 强改）。

### 仓库外的记忆文件（**不在 REVIEW_SHA 内**，信息性）
仓库约定「工作区记忆」位于**仓库之外**的工作区根目录：
- `C:\Users\Administrator\Desktop\sdeepseek harness\KNOWN_ISSUES.md`（本轮追加 R9 复核与 3 条新事实）
- `C:\Users\Administrator\Desktop\sdeepseek harness\VERIFICATION.md`（工作区级验证配方；**仓库内不存在该文件**，
  这是仓库约定而非缺失——历史报告多处引用「工作区 VERIFICATION.md」）
评审者可**只读**参考这两个文件；它们**不属于评审对象**，不得据其存在与否判定 REVIEW_SHA 的完整性。

---

## 6. Safety / Boundary Flags

```text
production mutation          = NO   (生产 runtime 未改；插件字节未变；3080 服务未重启)
PRODUCT_CODE_CHANGED         = NO   （本轮未新增任何产品代码改动；冻结的是既有整改包）
BRANCH_PROTECTION_CHANGED    = NO
RULESET_CHANGED              = NO
FORCE_PUSH                   = NO
DIRECT_MAIN_PUSH             = NO   (origin/main 仍 = 63bf558…)
WINDOWS_REBOOT               = NO
OFFICIAL_DSH_UPGRADE         = NO
P4.5_STARTED                 = NO
P5_STARTED                   = NO
PR MERGED                    = NO
```

---

## 7. Reviewer Instructions（只读 / 独立 / 面向该 SHA）

1. 以 **REVIEW_SHA = `74adf9351c2af2f63035abdbdfa502090ad1af7e`** 为唯一依据；**只读**，不改文件、不提交、不合并。
2. **不得**重新发明 P4 合同；以仓库内 canonical 文档（`docs/roadmap/P4_STATUS.json`、
   `CURRENT_STATUS.md` 为冲突权威、`A10_CONTRACT_MATRIX.md`、`AC10_GATE_REGISTRY_AND_REAL_E2E_IN_CI.md`）为准。
3. 必须**独立运行**并记录真实 exit code：
   `node tests/learn/audit-merge-enforcement.mjs --strict`（若无法复现 exit 1，**不得**采用实现者结论），
   `node tools/verify-release-artifact.mjs`（含至少一个负对照）。
4. 必须独立回答：**是否存在一条不消费真实 E2E 门即可到达 main/stable 的路径？** 若是，再据 canonical
   contract 判定其是否为 **P4 blocker**（禁止模糊表述）。
5. AC1–AC10 逐条给 `PASS / FAIL / N/A` + **决定性证据**（文件行号 / 命令 / exit code），不得只给结论。
6. 回归计数口径：**1240**（门槛套件）/ **27**（内部 E2E）/ 其他已记录口径（1286 自有、1306 自报）
   必须分别解释；**不得**因统计器 `NO-SUMMARY` 假警报直接判 FAIL；但**真实断言失败必须 FAIL**。
7. 历史完整性：确认 09-23 回滚、历史 `NOT VERIFIED`、既往失败记录、provisional Golden 与 final state
   的区分均**保留**，无历史洗白（本 SHA 的 `verify-history-preserved` 强制该性质）。
8. 发现 blocker → **REPORT ONLY**：本任务**不修** D2/D3/D4、不改 GitHub rules、不合并 PR、不启动 P4.5/P5。
9. 最终只允许输出一个裁决：**APPROVED / CHANGES_REQUIRED / BLOCKED**，并给出 §18 规定格式的报告。

---

## 8. 下一步授权（仅在 APPROVED 时）

```text
NEXT = P4 CONTRACT FINALIZATION TRANSACTION
```
（在**下一任务**中执行：finalize governance artifact → mark P4 CONTRACT VERIFIED → complete P4 goal
→ formally start P4.5）。**本任务到此为止，不做任何状态变更。**
