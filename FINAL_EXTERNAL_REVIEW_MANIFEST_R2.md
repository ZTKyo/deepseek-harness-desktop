# FINAL_EXTERNAL_REVIEW_MANIFEST_R2.md

> **用途**：为 P4 最终整改的**第二轮外部评审（R2 review）**固定一个**不可变的评审对象**，并记录其
> 逐文件哈希、只读快照与**诚实门状态**。本文件是**事后记录**（documentation only）：它本身**不在**
> 被评审的树内，**不改变 REVIEW_SHA 的任何字节**。
>
> 生成时间：2026-10-01（本轮 FREEZE → REVIEW → 条件合并 任务）

---

## 1. Review Subject

| 项 | 值 |
|---|---|
| **branch** | `p4-final-remediation-r2` |
| **base SHA** | `63bf5585c64742169c8b66ddfc2938e7de936343`（**=== origin/main**，未改动） |
| **REVIEW_SHA** | **`2592172699049b9c9f531181140151d6355b6a7c`** |
| **commit subject** | `P4 R2 docs: record the runner-first-run EOL incident, its root cause and the fix` |
| **git tree SHA** | `f515bf95eeaacebf7d889a2087dbe04e90e64da6` |
| **payload vs base** | **103 files**（19 modified + 84 added），`14593 insertions(+), 37 deletions(-)` |
| **合并载体** | **PR #104** — https://github.com/ZTKyo/deepseek-harness-desktop/pull/104（`OPEN` / **NOT MERGED**；**仅在本轮裁决 = APPROVED 时**才允许合并） |
| **评审专用 PR** | **PR #105** — https://github.com/ZTKyo/deepseek-harness-desktop/pull/105，标题 `[P4 R2 REVIEW ONLY - DO NOT MERGE]`（**禁合并**） |
| **不可变标记** | tag `p4r2-review-freeze-2592172`（annotated，指向 REVIEW_SHA；`9c3461a8…`） |
| **远端 SHA 一致性** | **YES** — `git ls-remote origin refs/heads/p4-final-remediation-r2` = `2592172…` = 本地 HEAD |
| **repo** | `ZTKyo/deepseek-harness-desktop` |

### REVIEW SUBJECT IMMUTABLE
**评审对象 = 提交 `2592172699049b9c9f531181140151d6355b6a7c` 的整棵树**（`git tree` = `f515bf95…`），
**不是分支头**（分支在此之后只允许出现 docs-only 提交，例如本 manifest）、**不是工作树**、不是聊天摘要。
自 push 起该 SHA **不得再被修改**（不 amend / 不 rebase / 不 force push）。

评审者（只读）应这样取得评审对象：

```bash
git fetch origin
git show --stat 2592172699049b9c9f531181140151d6355b6a7c
git -c core.autocrlf=false worktree add --detach <tmpdir> 2592172699049b9c9f531181140151d6355b6a7c
```

或直接读取本轮导出的**逐字节只读快照**（见 §5）：快照与 `git ls-tree`/`cat-file` 逐 blob 校验一致。

---

## 2. Artifact Integrity（在 REVIEW_SHA 上重新计算，非引用旧报告）

| 角色 | 路径 | bytes | sha256 | git blob |
|---|---|---|---|---|
| **canonical / authoritative report** | `docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/EXTERNAL_REVIEW_REMEDIATION_CLOSURE_R1.md` | 55166 | `F805CFA8E50D2A8F4DEA2D9F34E28A4121FFA957455D92A1E80F5C8FF2DFE2E4` | `aef83201e26414c90a3ce5d1f15cee3c6775fcd4` |
| **release artifact**（任务指定命名） | `…/R3_FINAL_CLOSURE/P4_REMEDIATION_CLOSURE_20261001-0425.md` | 57495 | `81A904B8A54716F969C555147EFA44500F82716DC0B806F986A1E23B6755A630` | `b21d7e250893d86485b725f8b20393ed6d0e613c` |
| **verifier**（Finding B 的修复点） | `tools/verify-release-artifact.mjs` | 10068 | `A77950D957B0DBBF5B9C596DC1093B10B228C74DE334F835BB68F579209E5D70` | `1f5de1b36ac5d37e251e0ae1cd74bde17b2ec33c` |
| **EOL 矩阵 runner** | `tools/run-control-in-eol.mjs` | 4070 | `B0CC3F1AE33ECB29B3B3B6EE416CAA0DE4D8EB5DC22F6428312182B95E15E6F2` | `49348d456b6165d997bd0d6e8ffba2383fca6791` |
| **anchor gate（Finding D）** | `tools/check-doc-anchors.mjs` | 11824 | `1838F5DFE922D9D12D88F68E965B49E2F763DEC5BE56308EA391A82F64C3569D` | `4f896ee43df0e8131cbba7eaf7210f618a0d5939` |
| **store census（Finding E）** | `tools/learn-store-census.mjs` | 14796 | `8558C780DDEAF09635932062A138973AF612D67BFCE08C088718EFBC38D8E97B` | `62e306f6564bb10316a9d2b406df0cb3a22ae21f` |
| **D1 parity gate（Finding A/C）** | `tests/roadmap/validate-p4-status-consistency.mjs` | 29847 | `4E64EF5C9991A37E9D3A1CE1FCDB9D6AE45A31AC2DC62D061C882C15896C10E1` | `b2072870a744fe2ae14d69b45c47c2f152e8e429` |
| **Finding A 控制套件** | `tests/roadmap/test-p4-status-per-ac-consistency.mjs` | 10812 | `AFCE8ABF26D72A3B31CD2090C4C3D144564810CEBF997E00011B7B8E45B2D1D0` | `d7e5bd5cb7970160afc140e5c98847c88ff8ca24` |
| **Finding B 控制套件** | `tests/roadmap/test-release-artifact-verifier.mjs` | 9826 | `BB1A1371D056490F318868C0C368CC2E72DD1E662D583ECD6BA050F1CBC4AF01` | `bafff26d163fdc372ea50b057f6c465d29f3c6d5` |
| **Finding D 负控** | `tests/roadmap/test-anchor-gate-negative-control.mjs` | 4307 | `D6DD23980FC9405FF2A1EC05D6351449A7826464AED1616C362590A135640E40` | `2565c2fe8709ee71b677c59739fb39c797b39e63` |
| **Finding C 负控** | `tests/roadmap/test-finding-c-number-pinning.mjs` | 9197 | `7FA8EC6C8AB890D31B4FA661BFD0A2695FDA87CFB8ECA02FBEC1675CB7E77F92` | `eebc94862a81e134ac3b8bd53aa074fc84649909` |
| **Finding E 负控** | `tests/roadmap/test-finding-e-negative-control.mjs` | 9669 | `A321228DA6FE741998C19998F200898B70FB9F2745E7AE36968F2E6DD0F9B88D` | `9206b4f49df81b5fc88c69d85f44f91a15fb34d8` |
| **CI 接线（Finding F/G）** | `.github/workflows/ci-level1.yml` | 25847 | `2F224ABDE6BE56A6E0EBB146E704AE555F64C761B462919908F5CF6DAFBF6E8D` | `e35aa449ea21a32d274f63da758eae30f5d495c1` |
| **控制加固证据** | `…/R3_FINAL_CLOSURE/evidence/R2_CONTROL_HARDENING_20261001.md` | 17563 | `BC1A0C9E69A6BBAFBC14295EAFF8827B54A39BB4A1E04C88A8D8020A2505F745` | `d04bcd4e4ece275ab532263b52a7f960d033bff6` |
| **状态 PARITY INDEX** | `docs/roadmap/P4_STATUS.json` | 21383 | `D6C71DD272F3A598BDEB9BCB36D99F642145889E4A34EDA67AA694F2EDF83FCF` | `5b85adc20ec2c400dd702819e1b896484a56b46b` |

- `node tools/verify-release-artifact.mjs` → **`RELEASE ARTIFACT INTEGRITY: IDENTICAL`**，exit 0
  （判据 = `CANONICAL_BODY_SHA256`（EOL 归一化后的正文哈希）；原始字节哈希另列 `rawFileSha256`，仅作法证）。
  **Finding B 的口径修正**：裁决**不再**取决于检出的行尾风格，只取决于正文内容。

> **口径纠错（送审前自查发现，主动记录，不藏）**：上表两行的 `sha256` **不是同一个值** ——
> 权威报告 `F805CFA8…`、发布件 `81A904B8…`（发布件多一段 provenance 注释头）。**完全相同的是
> 规范化（CRLF/CR → LF）后的正文**（`canonicalBodySha256` 两者同为 `F805CFA8…`）。
> `tools/verify-release-artifact.mjs` 自身也打印 `raw-bytes match=NO — forensic only`。
> ⇒ 本评审可主张的是 **"正文（EOL 归一化后）一致"**，**不是**"两份文件逐字节一致"。
> 若在其它材料（含聊天摘要）里看到"字节级一致"的措辞，**以本处口径为准**。

---

## 3. 两个被评审的阻断项（A / B）及其**可伪证**证据

| Finding | 问题 | 修复 | 负控/证明 | 本轮实测 |
|---|---|---|---|---|
| **A** | 逐 AC 裁决一致性门是否**真的可执行**（不是装饰性绿灯） | `P4_STATUS.json.acVerdicts` 必须与权威文档逐 AC 一致；`tests/roadmap/validate-p4-status-consistency.mjs` 运行时复算 | `tests/roadmap/test-p4-status-per-ac-consistency.mjs`（11 条控制：篡改任一 AC 裁决 → 门必须变红） | **PASSED**（11/11）；CI step 同名 success |
| **B** | release artifact 裁决曾被 **EOL 归一化**影响，可能产生歧义 | 裁决改由 `CANONICAL_BODY_SHA256` 决定；原始字节单列 | `tests/roadmap/test-release-artifact-verifier.mjs`（14 条控制：真实内容漂移必红；**行尾风格变化不得改变裁决**） | **PASSED**（14/14）；`IDENTICAL` |

### Finding A 的 EOL 矩阵（本轮新增的 CI 真实步骤）
CI runner 检出树是 **CRLF**，而本地是 **LF**——只用其中一种行尾证明"控制可执行"是不充分的。
新增 `tools/run-control-in-eol.mjs` + CI step
**`Finding A controls EOL matrix (a runner tree is CRLF; prove the LF checkout too)`**：
同一控制套件在 **LF** 与 **CRLF** 两种检出风格下都必须变红/变绿得当。
本步骤在 REVIEW_SHA 的 CI（run `36825276283`）中为 **success**。

> 事故与根因（**如实记录**）：该步骤**第一次在 CI 上运行时**暴露了本地从未出现的失败——控制套件
> 依赖了本地 LF 检出。根因与修复记于提交 `f2b910b`、`2592172`，未做任何"跳过/洗绿"处理；
> 这也是本轮 REVIEW_SHA 为何晚于 `766beda` 的原因（`766beda` **不是**评审对象）。

---

## 4. 诚实门状态（在 REVIEW_SHA 上，本地电池 + CI）

**本地电池 A**（`_p4rem-closure/probes/_r2-full-gate-battery.mjs`，工作树干净、HEAD = REVIEW_SHA）：

| # | 门/控制 | 结果 |
|---|---|---|
| 1 | P4 status consistency (D1) | PASSED，FAIL: 0 |
| 2 | History preservation (D1) | PASSED（仅追加） |
| 3 | Document anchors (D) | PASSED |
| 4 | L3 paths coverage | PASSED |
| 5 | Learn store census self-test (E) | 14/14 PASS |
| 6 | Release artifact identity (B) | IDENTICAL，exit 0 |
| 7 | Control: anchor-gate negative control (D) | PASSED |
| 8 | Control: per-AC consistency (A) | PASSED |
| 9 | Control: release-artifact verifier (B) | PASSED |
| 10 | Control: finding E negative control | 14/14 PASS |
| 11 | Control: finding C number pinning | 17/17 PASS |

→ `TOTAL GATES: 11  PASS: 11  FAIL: 0`（`gate-battery.log`）。

**本地电池 B**（`_r2-regression-battery-b.mjs`）：redaction-aware secret audit `REAL SECRET = 0`；
D11 套件 116/116 PASS；全树 secret scan `RAW 0 / REAL 0`；gate registry PASS；learn core 505 PASS / 0 FAIL；
YAML 6/6 parse ok；`TOTAL: 8 checks  GREEN: 8  PROBLEM: 0`。

**唯一诚实红（未修、未洗）**：
`node tests/learn/audit-merge-enforcement.mjs --strict` → **exit 1**
（原因：**D2/D3/D4 = GitHub 侧 required checks / 分支保护架构**不在本次授权范围内，本分支**未修改**
该架构）。该红被如实记录为 EXPECTED-RED。

**CI（该 SHA 的三条必过工作流）**：

| 工作流 | run id | 结论 |
|---|---|---|
| CI Level 1 - Static Gate (every PR) | `36825276283` | **success** |
| CI Level 2 - Windows Reliability State Machines | `36825276269` | **success** |
| CI Level 3 - Harness Smoke (current version + sanitized profile) | `36825276249` | **success** |

> 该 REVIEW_SHA 上**共 6 个 run = 两套**（首次 + 冻结后重跑：`36826690775` / `36826690827` /
> `36826690726`），**两套结论全部 success，非成功 = 0**（独立经 GitHub API 复核）。
> 冻结支线 `7cb59dd` 另有 3 个 run（`36826784674` / `36826784682` / `36826784760`），亦全部 success。
>
> **结论级别升级（逐步骤，不再是"仅整体绿"）**：REVIEW_SHA 的 6 个 run 各含 1 个 job，
> 逐 job 的 steps 数 = **41 / 32 / 21（L1/L2/L3，两套相同）**，其中 **`notSuccess = 0`**；
> `7cb59dd` 的 3 个 run steps = 32 / 21 / 41，同样 `notSuccess = 0`。
> ⇒ **整体绿 且 逐步骤绿，共 9 个 run 全部 step success**（本机 `CI_EVIDENCE.txt` 全量抓取，
> 且已由独立只读评审者经 GitHub API 单独复核）。

Level 1 日志中与评审直接相关的 step 全为 success：Finding A controls、**Finding A controls EOL matrix**、
Finding B controls、anchor gate（含负控）、Finding E / Finding C 负控、release artifact integrity（含负控）、
D1 parity、D1 history。

### 4.1 已知、未修、如实披露（送审前自查补记）

以下四项**都不阻断评审**，且**都不改动评审对象**（若改动即成非 docs-only 提交 ⇒ REVIEW_SHA 会变，
故本轮一律不动，仅披露）。请评审者**据此限定口径**，不要把它们当作未申报缺陷，也不要据此高估覆盖面。

| # | 事实（已独立复核） | 为什么不修 | 建议判定 |
|---|---|---|---|
| 1 | `ci-level1.yml` 中 **B verifier 步骤出现两次**：`:377` 与 `:449`，**同一命令、同一 job** | 删除重复步骤属控制流改动（非 docs-only）⇒ 会改变评审对象 | **非阻断**：重复执行不改变结论，仅多花数秒；留待合并后治理轮去重 |
| 2 | **EOL 矩阵只覆盖 Finding A 控制**：`:365` 用 `tools/run-control-in-eol.mjs … lf` 建 LF 第二环境；**E 控制（`:413`）与 C 控制（`:427`）各只有一次（CRLF 检出）运行**。括注口径说明：三个 workflow 全部 `runs-on: windows-latest`（L1:12 / L2:12 / L3:34），而仓库内 blob 是 **LF**（706/708 个文本文件纯 LF、无 `.gitattributes`）⇒ CI 检出侧为 CRLF，`:365` 的 `… lf` 才构成"另一套环境" | 为 E/C 增加步骤同属工作流改动（非 docs-only） | **非阻断，且实质风险 = 0 —— 已补测证明（C1）**：独立只读评审者用与 `run-control-in-eol.mjs` **同一算法**（tracked 树 + 真 commit + `core.autocrlf=false`）造 CRLF 检出副本后真跑 → **E `14 PASS:14 FAIL:0`、C `17 PASS:17 FAIL:0`、A `11 AS-REQUIRED:11`，全 exit 0**；LF 快照内此前亦为 **E 14/14、C 17/17**（执行方本地电池，日志 `_p4rem-closure\r2-regression\gate-battery.log`）⇒ **E/C 在 CRLF 与 LF 两种行尾风格下都已被证明**，缺的只是 CI 里的对称步骤。本文件**不主张**"E/C 有两套 CI 运行" |
| 3 | D1 行号封锁的**覆盖面边界**：`ban.STATUS.d1row` 的模式只拦 **2 位**行号指针（`foo.md:33` 命中；`learn-core.mjs:594` **不命中**，实测）。`check-doc-anchors.mjs` 另有 2–4 位普查正则，但**普查 ≠ 封锁**。（C2 补：豁免语义 = 该处含"锚点"字样，或含**不带连字符**的反引号文件名 ⇒ `` `learn.mjs:594` `` 会被豁免，而 `` `learn-core.mjs:594` `` 因文件名含连字符**不被**豁免；A10 的 `L` 形式不要求反引号、STATUS 的必须带反引号。） | 放宽模式属索引改动（非 docs-only）；且 D 档 §5/§7 已如实登记"只覆盖 2 个区块、318 处候选未逐个判定" | **非阻断**：本轮**不主张**"全仓已无行号指针"，只主张"两个封锁区块内新写入的 2 位指针必须带锚点" |
| 4 | 门电池中 G2/G4/I3 依赖 `git show HEAD:`：在**无 `.git` 的纯解压目录**里必然变红（3 条 FAIL），`learn-store-census` 报 0 文档，`verify-history-preserved.mjs` exit 1 | 这是 **fail-closed（不假绿）**，不是缺陷 | **非阻断**：评审者请按 §1 的 `git fetch` + `git worktree add` 取得评审对象；纯解压目录**不是**受支持的评审环境 |

被封锁模式原文（供核对）：

```
ban.STATUS.d1row.banPattern = "`L\d{2,3}`|:\d{2}\b"      // 只拦 2 位 \d{2}
ban.A10.banner.banPattern   = "\bL\d{2,3}\b"             // L23 / L123 形式
```

---

## 5. 冻结只读快照（本轮导出，供只读评审者）

| 项 | 值 |
|---|---|
| 导出目录 | `_p4r2-review-2592172/tree/`（工作区，非仓库） |
| 清单 | `_p4r2-review-2592172/tree-manifest.json` |
| 文件数 / 总字节 | **722 / 8512752** |
| 形态 | `git cat-file blob` 原始字节（**LF**，等价于仓库内存形态）；无 EOL 转换、无 smudge 过滤 |
| **rootHash** | `0e88941f67d12be9fdfc613f372b26fab89894f922bf999c4f13e0e083290e89` |
| 自检 | 导出后**独立复读磁盘**重算 rootHash = 同一值 → **PASS** |
| 性质 | 该快照是**执行方生成的只读副本**，**不是**内容作者；其权威性由与 `ls-tree`/`blobSha1` 的逐条相等保证 |

`rootHash = sha256(JSON.stringify({reviewSha, fileCount, totalBytes, files:[{path, mode, blobSha1, sha256, bytes}]（按 path 排序）}))`。

---

## 6. 被评审的改动清单（相对 base `63bf558`）

**新增（与门/控制/证据直接相关）**：
`tools/check-doc-anchors.mjs`、`tools/check-l3-paths-coverage.mjs`、`tools/learn-store-census.mjs`、
`tools/run-control-in-eol.mjs`、`tools/verify-release-artifact.mjs`；
`tests/roadmap/validate-p4-status-consistency.mjs`、`verify-history-preserved.mjs`、
`test-p4-status-per-ac-consistency.mjs`、`test-release-artifact-verifier.mjs`、
`test-anchor-gate-negative-control.mjs`、`test-finding-c-number-pinning.mjs`、`test-finding-e-negative-control.mjs`；
`tests/reliability/redaction-aware-secret-audit.mjs`、`test-redaction-aware-audit.mjs`；
状态索引 `docs/roadmap/P4_STATUS.json`（新增 parity index）；
证据 `evidence/{R2_CONTROL_HARDENING,C_NUMBER_PINNING,D_DOC_ANCHORS,E_D12_STORE_CENSUS,D3_D4_MERGE_GATE_GOVERNANCE}_20261001.md`。

**修改（19 个）**：`.github/workflows/ci-level1.yml`、2 份 `RELIABILITY_*.md` 报告、
13 份 roadmap 文档（含权威报告与发布件 `EXTERNAL_REVIEW_REMEDIATION_CLOSURE_R1.md`、
`P4_REMEDIATION_CLOSURE_20261001-0425.md`、`CURRENT_STATUS.md`、`A10_CONTRACT_MATRIX.md` 等）、
`tests/learn/audit-merge-enforcement.mjs`、`tests/learn/test-learn-core.mjs`、
`tests/reliability/secret-scan-check.mjs`。

**范围声明**：不涉及 D3/D4 的 GitHub 架构、不涉及 learn 插件/运行时、审批架构、经验库、
AC2/AC6 运行时、HMR、goal-recovery、504 会话工作、official base、production；
未启动 P4.5 / P5；未重启生产；无 force push；无历史重写；未直接推 main。

---

## 7. 结论与裁决（Reviewer 输出要求）

评审者**只读**，且必须给出**恰好一个**裁决：**APPROVED** / **CHANGES_REQUIRED** / **BLOCKED**，
并对每个接受或否定的断言给出**文件级证据**（路径 + 关键行）。不得以本 PR 正文、聊天摘要、
后续提交或过期报告作为评审依据。

> 若裁决 = APPROVED：按任务书**仅**允许合并 PR #104（= 本 REVIEW_SHA 的整改），随后核验 main 内容一致，
> 再以**纯治理** PR 记录 P4 `CONTRACT VERIFIED` / `GOAL COMPLETED` 与 `P4.5 = READY_TO_START`（**不启动**）。
> 若裁决 = CHANGES_REQUIRED / BLOCKED：**不合并**，如实记录并进入下一轮整改。
