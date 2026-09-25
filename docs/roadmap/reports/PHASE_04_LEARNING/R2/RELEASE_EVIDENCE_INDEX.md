# P4 LEARN R2 — Release Evidence Index（交付索引）

> **本文件性质**：由**发布执行方**在 RC 打包时撰写的"引用→实体"映射表。它**不修改、不覆盖、不追认**任何 R5 已审报告的任何结论；只做三件事：
> (1) 声明本次发布的**冻结来源与字节同一性证明方法**；
> (2) 把三份报告中引用的证据路径逐条映射到**仓库内实体**，并显式登记**未随仓库归档**或**设计排除**的项；
> (3) 登记发布时实测到的**既有失败**（与本次变更无关）与其对部署的约束。
>
> **状态口径（不因本文件改变）**：P4 = `NOT VERIFIED / ROLLED BACK / AWAITING REDESIGN`（`docs/roadmap/CURRENT_STATUS.md` P4 行）。
> 本文件**不构成** "P4 完成"、"生产已批准"、或任何治理状态回填。

---

## 1. 冻结来源与字节同一性

| 项 | 值 |
|---|---|
| 被审来源树（R5 审阅对象） | `4fcf3c2`（分支 `p4-learn-r2`，10 提交） |
| 审阅基线（origin/main） | `5a206ae` |
| 本 RC 发布分支 | `p4-learning-r2-release`，起点 `5a206ae` |
| 源码/测试可互换性 | `git diff 6b73f4e 4fcf3c2 -- plugins tests` **为空** ⇒ 源码/测试以 `6b73f4e`＝`4fcf3c2` |
| 同一性证明方法 | 对每个入包路径比较 `git -C <release> hash-object <path>` 与 `git -C <src> rev-parse 4fcf3c2:<path>`；**全部相等（36/36，0 mismatch）**；提交后再以 `rev-parse HEAD:<path>` 复核**全部相等** |
| 关键文件 blob | `learn.mjs f0d10bf71e5d`、`learn-core.mjs 5db0d1a17427`、`learn-candidate.mjs 217497a17abf`、`learn-gap-veto.mjs 2daf006d114c`、`ci-level2.yml f023a18f2b92` |
| 工作副本全文 sha256 | `learn.mjs 36642349A4AB…ACAC`、`learn-core.mjs B5BD39771F4C…1196`、`learn-candidate.mjs A06079828928…2C38`、`learn-gap-veto.mjs D961C1F4E5FC…1089`（＝R5 被审值） |
| EOL 环境因子 | 仓库 `core.autocrlf=true` 且无 `.gitattributes` ⇒ **git blob 恒为 LF（因此 blob 级同一性成立）**；工作副本在**重新检出**时可能变 CRLF。部署必须取"与 blob 同为 LF 的工作副本"，不得经"另存为"重写。 |

## 2. 引用闭合（报告 → 仓库实体）

逐条扫描 16 份报告/证据文本中出现的 53 个工件引用，结果分类如下。

### 2.1 已随仓库归档（引用可解析）

| 引用 | 仓库实体 | 备注 |
|---|---|---|
| `_p4r2-evidence/learn-full-regression.txt` | 同路径 | 全量回归原始输出 |
| `_p4r2-evidence/cross-stage-supervisor-e2e.txt` | 同路径 | 跨阶段监督器 E2E |
| `_p4r2-evidence/b1-exploit-after.txt`、`B1-approval-gate-differential-20260925.txt`、`B1-mutation-proof-17-20260925.txt` | 同路径 | B1 闸门差分与变异证明 |
| `_p4r2-evidence/b2-test-output.txt`、`B2-mutation-proof-20260925.txt` | 同路径 | B2 边界证明 |
| `_p4r2-evidence/mutations/{learn.mjs.pristine, learn-core.mjs.pristine, mutation-proof-17-b1.mjs, mutation-proof-b2.mjs}` | 同路径 | **独立还原源**（变异证明可复算） |
| `_p4r2-evidence/probe-disk-slack.mjs`、`probe-gap-pressure.mjs` | 同路径 | 磁盘/缺口压力探针 |
| `_p4r2-evidence/verifier-probes/**`（38 个：R3/R4/R5 报告、`p6-*`、`p8-*`、`p9-*`、`p-dup-impact`、`p-f2-bounds`、`_vfy-*`、`rev-probe*`） | 同路径（**整目录归档，无删减**） | 独立验证方全部材料 |
| `_f1-r1-mutation-proof.ps1`、`_f1-r1-forgery-mutation-evidence.txt` | 仓库根同路径 | F1 变异证明与产出 |
| `_f2-mutation-proof.ps1`、`_f2-mutation-evidence.txt`、`_f2-bounds-raw-output.txt`、`_f2-full-regression-evidence.txt` | 仓库根同路径 | F2 变异/边界/全量证据 |
| `_f1-spec.md` | 仓库根同路径 | F1 规范（治理/追溯用） |
| `tests/learn/run-ac7-regression.ps1`（跨阶段汇总运行器） | 同路径 | 见 2.3 的**本次重跑** |

### 2.2 本次发布**收集入仓**的外部工件（原不在仓库）

`STAGE8B_MUTATION_ROUND2_COVERAGE_CLOSURE.md` 引用 `_p4r2-evidence/stage8b-mutation-round2*.{mjs,json,txt}`；核验发现这些工件**实际生成于仓库之外**（撰写时的工作区根目录 `_p4r2-evidence\`，因运行器以工作区根为 cwd）。为使引用可解析，本次将下列 8 个文件**原样收集**入 `_p4r2-evidence/`：

`stage8-mutation-proof.{mjs,json,txt}`、`stage8b-mutation-round2.{mjs,json,txt}`、`stage8b-mutation-round2-after-c16.{json,txt}`

**来源与边界声明**：这 8 个文件为**证据工件**（非运行时代码、非测试入口、不在任何 profile 挂载路径），此前**未被任何提交纳入**，也**未经 R5 逐字节审阅**；本次仅做"从撰写工作区原样搬入"，不修改内容。它们的加入**只影响可复现性，不影响源码字节同一性**（第 1 节的源码清单不含它们）。

### 2.3 本次**重新生成**以补回的证据（真证据，非伪造）

| 引用 | 处理 |
|---|---|
| `_p4r2/_p4r2-evidence/cross-stage-ac7-sweep.txt`（29 套件跨阶段汇总） | 原文件**全盘已失**（仓库内、仓库外、任何分支历史均无）。本次在 RC 树上**重跑** `tests/learn/run-ac7-regression.ps1` 生成同名文件：**28 GREEN / 1 RED / 0 MISSING**（红项见第 3 节，为既有失败）。**声明**：该文件内容是 **2026-09-25 重跑结果**，不是报告撰写当时的原始转储；调用命令与套件清单在文件首行与运行器中可查。 |

### 2.4 设计排除（不入仓，附理由）

| 被引用或存在的工件 | 排除理由 |
|---|---|
| `plugins/learn.mjs.ac5-fix-backup` | 报告自身注明"**回退锚点（不得进入 PR）**"（`P4_R2_PRE_FINAL_VALIDATION_ANCHOR.md:62`）。按报告指示排除。 |
| `_f1-checkpoint-20260925-230246/`、`_f2-checkpoint-20260926-001832/`（F1 报告 `:255` 列为"回滚点"） | 是**撰写时的源快照副本**（内含旧版插件全文，如旧 `learn-core.mjs` 143201B/126052B；且 `tests/test-learn-*.mjs` 位于**旧 `tests/` 根位置**）。入仓会产生"同名不同路径的第二份实现"，违反单一事实源。**独立还原源**改由 `_p4r2-evidence/mutations/*.pristine` 承担（已入仓）。 |
| `_f1-spec-raw.jsonl` | 原始会话转储（含真实会话数据，隐私与泄漏面）。 |
| `_f1-probe-seam.mjs`、`_f1-session-grep.mjs`、`_f2-probe.mjs`、`probe-session-extract.mjs`、`_patch-core-test-ledgers.mjs` | 一次性调试/迁移脚本。其中 `_patch-core-test-ledgers.mjs` 对 `test-learn-core.mjs` 做字符串注入，**幂等性为 0**（重跑会二次注入 `getSession: getHostSession,`）⇒ 归档会引入"可被误执行"的风险。 |
| `_obs-*.txt`（11 个）、`_f1-regress-all.txt`、`_final-verify-regression.txt`、`f1-baseline-suites.txt`、`f1-final-baseline-suites.txt` | 控制台转储/被 `docs/.../FULL_REGRESSION_R2.txt` 取代的**重复中间证据**。 |
| `_p4r2-evidence/_checkpoints/PRE_P4_R2_REVIEW_BLOCKER_FIX/*` | 工作树快照（`learn.mjs.pre`/`learn-core.mjs.pre`），功能等价于 `mutations/*.pristine`（后者已入仓）。 |
| 仓库外 `_p4r2-evidence/{diag,pristine,logs}/**`、`_probe-*.mjs`（8 个 0 字节文件）、`commit-msg-stage*.txt`、`code-safety-matrix.csv` 等 | 诊断探针/重复 pristine/已被 `FULL_REGRESSION_R2.txt` 取代的日志/0 字节残留/提交信息草稿 ⇒ 不属"发布必需"，按"去除重复原始中间证据"排除。 |

### 2.5 报告文本瑕疵（**不修报告**，在此登记）

| 位置 | 情况 | 实际 |
|---|---|---|
| `P4_R2_REVIEW_BLOCKER_FIX_R1.md:184` | 写作 `node tests/learn/test-learn-contract-scenarios.mjs` | 仓库实体为 **`tests/learn/run-learn-contract-scenarios.mjs`**（36 断言，已在全量回归中执行）。疑为文件名笔误。 |
| `STAGE8B_...md:99,156` 出现的裸文件名 `stage8b-mutation-round2.mjs` | 相对路径取决于执行时 cwd；报告 `:9` 已注明"证据目录" | 已在 2.2 将工件收集入 `_p4r2-evidence/`，据此可解析。 |

> 说明：本索引**刻意不修改**上述已审报告文本。任何对已审文本的编辑都会改变 R5 审阅对象的字节，故以"登记 + 补实体"方式处理，保证引用可解析且不产生新的未审文本。

## 3. 发布时实测的**既有失败**（与本次变更无关）与其部署约束

| 项 | 实测 |
|---|---|
| 套件 | `tests/install-plugin/verify-install-plugin.mjs` |
| RC 树结果 | FAIL，13 通过 / 2 失败（T3.1 `preflight 退出码 0`、T3.2 `输出包含 PREFLIGHT PASS`），根因 `install-plugin --check 未通过` |
| **pristine `origin/main`（5a206ae）对照** | **同样 FAIL、同样 2 处、同样根因**（exit=1） |
| 根因实体 | `node tools/install-plugin.mjs --check` 在**两棵树上都**报 **11 项历史漂移**（agent-inspector、keepalive-patch、model-selection-guard、execution-continuity 等 profile 挂载文件与 repo 不一致），与 P4 learn 无关 |
| 分类 | **PRE-EXISTING / UNRELATED**（与树无关；不由本次变更引入；**按纪律记录不修**，修它属越界生产变更） |

**部署约束（重要）**：该既有漂移会阻塞**任何重启前 preflight**（`PREFLIGHT FAIL: restart preflight failed: install-plugin --check 未通过`）。因此本次交付采用 **HMR 热挂载（不重启服务）**：既有除 learn 之外的挂载文件**不做任何可能的同步**，从而**绕开**该既有阻塞，也避免触碰无关生产文件。

**依赖闭包与一处既有漂移（如实披露）**：`learn-gap-veto.mjs` → `./failure-classifier-core.mjs`。实测 **profile 副本（旧，`2A00A17F463A…`）≠ repo（新，`F780150783A1…`）**，具名导出同名故不会导入失败；但**生产运行的 Gap-Veto 将使用生产既有的旧分类器**，与 R5 在 repo 树上的验证环境存在差异。修该文件＝修改 P4 之外的既有生产挂载行为，**本次不做**（越界）；已登记为"已接受漂移"，并将在生产会话验收中**以事实检查其是否影响 Gap-Veto 判定**，如影响则如实报告而非掩盖。

## 4. 本索引的**非声明**清单（防止误读为追认）

1. 本文件**不声明** P4 通过、完成、可生产、已批准；治理状态仍为 `NOT VERIFIED / ROLLED BACK / AWAITING REDESIGN`。
2. 本文件**不追认**任何"人工正向审批"能力：生产宿主的批准通道在本机为 **fail-closed**（需批准的动作被自动拒绝，而非自动同意）⇒ **Human-Positive-Approval E2E 属未验证**，必须作为遗留风险报出。
3. 本文件**不把**原始中间证据的缺失判定为"可忽略"，而是按 2.2/2.3/2.4 逐项给出**可解析路径或明确理由**。
4. 本文件中的"既有失败"**不被称为绿**：`verify-install-plugin` 仍为 RED，只是**归因于既有漂移**。
