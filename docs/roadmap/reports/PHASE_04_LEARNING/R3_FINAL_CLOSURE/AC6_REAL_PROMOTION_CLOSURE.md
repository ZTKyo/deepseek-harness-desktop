# AC6 缺口关闭报告 —— Candidate 真实三腿晋升 E2E（2026-09-28）

> 本报告**只关闭 AC6 一处**。AC2（研究腿未接线）与 AC10（CI 内无真实 E2E 门）**仍未关闭**，
> A8 真人审批边界**未被触碰**（细节见 §6「诚实的范围边界」）。
> 上游文档：`P4_FINAL_VERDICT.md`（A11 终局判定 = P4 ≠ VERIFIED）、`A10_CONTRACT_MATRIX.md`（AC1–AC10 逐条）。

---

## 1. 一句话结论

**AC6 = PASS**：Candidate 的 CI 腿与 Transaction 腿**已真实接线并被真实端到端证据覆盖**
（真 git worktree / 真 commit / 真 CI 作业命令 / 真 `dsh-transaction.ps1` / 真隔离宿主 canary），
**24 PASS / 0 FAIL**，且晋升在正反两个方向上都被证明有承载力的收据门把守。**没有造第二套 promotion engine**：
全部复用既有 `ci-level2.yml` 作业命令、既有 `dsh-transaction.ps1`、既有 `tests/learn/mount-gate.mjs` 与既有候选状态机。

## 2. 缺口原文（关闭前）

| 来源 | 原文 |
|---|---|
| `P4_FINAL_VERDICT.md:50` | **AC6**：Candidate 的 **Transaction/canary/deploy 腿仅声明、零调用**；`tests/learn` 中 `Transaction` 引用 = **0**；`ci-level1.yml:191` 把 `dsh-plugin-transaction.ps1` 列入 `$skip` |
| `A10_CONTRACT_MATRIX.md:33` | 裁决 **PARTIAL**（CI 腿真；**Transaction/canary/deploy 腿仅声明、零调用**） |

「声明」指 `learn-candidate.mjs:85-110 STAGE_DELEGATION` 里写着要委托 ci-level1 / dsh-transaction.ps1 / reliability-lab / plugin-transaction，
但**没有任何测试真实驱动过这些腿**，`verifyPromotionReceipts` 的 transaction 腿因此在真实调用下拿不到真收据。

## 3. 交付物

| 文件 | 性质 | 说明 |
|---|---|---|
| `tests/learn/test-learn-ac6-real-promotion-e2e.mjs` | **新增（516 行，10 段）** | 真实三腿晋升 E2E：真 git worktree/commit + 真 ci-level2 作业命令 + 真事务 journal + 真隔离宿主 canary + 晋升门正反向 + 不变量 + 清理 |
| `dsh-transaction.ps1` | 修改（**引擎**，非 `tests/`） | ① journal/manifest 等 JSON 产物改为**无 BOM UTF-8**；② label 做防御性 token 清洗（见 §4） |
| `plugins/learn-candidate.mjs` | 修改（**插件**） | 候选派生事务 label 改为文件系统安全形态 `candidate-<id>`（原 `candidate:<id>` 会让引擎建路径失败）+ 门内拒绝不安全 label |
| `tests/learn/mount-gate.mjs` | 修改（测试门） | 隔离改为临时 `DSH_HOME` + 生产同形 `--profile web`（否则身份判定在隔离宿主上不可达） |
| `tests/learn/run-learn-all-tests.mjs`、CI-safe 子集 | 修改 | 把 receipts 套件接入 CI 安全子集 |
| `docs/roadmap/evidence/AC6_REAL_E2E_R3_CLOSURE/` | **新增证据留档（8 文件，0 命中密钥扫描）** | 报告 JSON、CI 运行日志（`ci-run.txt`）、mount-gate 日志、tx journal/manifest/receipt、以及**修复前 19P/5F 与修复后 24P/0F 两份原始运行日志**。注：日志以 `.txt` 留档——仓库 `.gitignore` 忽略 `*.log`，`.txt` 是本仓库既有证据约定格式 |

## 4. 三腿真实证据

运行命令：`node tests/learn/test-learn-ac6-real-promotion-e2e.mjs`（canonical 工作区 `_p4r2-inject-fix`）
证据根：`%TEMP%\ac6-real-e2e-<runid>\`（已复制留档至上表证据目录）

| 段 | 真实动作 | 实测值 |
|---|---|---|
| 0 前置 | 工作区干净 / HEAD 未变 / 生产 3080 不受扰动 | 断言通过 |
| 1 状态机 | 候选经三阶段（证据引用真产物） | `ISOLATED_TESTS → REGRESSION_HOLDOUT → CANARY` |
| 2 **git 腿** | **真** `git worktree add` + 真分支 + 真 commit | branch `candidate/cand_d9b6ae32`，commit **`74fd41c9594aee04ab12ba60fd4b51bc42cece4a`**，worktree 隔离 |
| 3 **CI 腿** | 在**该 commit 的 worktree 内**执行 `ci-level2.yml` 作业命令（`HOME`/`USERPROFILE`/`LOCALAPPDATA` 重定向到空目录 = 与 CI 相同判据） | **14 条命令全 exit 0**，13 个套件 PASS，日志 `ci-run.log` |
| 4 **Transaction 腿** | 真 `dsh-transaction.ps1`（经真 runner） | `FinalState=COMMITTED`、`Verify=COMMIT_READY`、`faultClass=none`、journal 回读一致（**独立真值，不是引擎自述**），label/transactionId 三腿互证 `candidate-cand_d9b6ae32-20260928-014049-bf91cb` |
| 5 canary | 真 `mount-gate.mjs --hold host` 在 `127.0.0.1:3099`（隔离 profile） | verdict PASS、A1–A5 全过；释放后端口 FREE；**生产 3080 PID 前后一致（7176）** |
| 6 晋升（正向） | 门自检 → `promoteCandidate` | `verifyPromotionReceipts(真收据)=ok`；`state=PROMOTED`；**只存 1859 字节有界摘要**（原始收据路径未落入 store） |
| 7 负向对照（3 组） | 篡改其中一腿 | `ci.headSha` → `promotion_receipt_invalid leg=ci ci_headSha_mismatch_git_commitSha`；`transaction.faultClass` → `leg=transaction`；`git.branch` → `leg=git`。**三组全部拒绝 + `CANDIDATE_PROMOTION_DENIED` 留痕 + 状态不动** |
| 8 不变量 | 晋升**没有**改动生产插件文件 | `plugins/learn.mjs` `bf5cfa6d…`、`plugins/learn-candidate.mjs` `f732806a…` 四哈希一致；晋升后工作区仍干净 |
| 9 清理 | worktree/分支删除、HEAD 未变、临时宿主退出 | 全部通过 |

**修复前后对照（两份原始日志均在留档目录）**：
- 修复前：**19 PASS / 5 FAIL** —— 失败串根因 = 真 journal 回读 `Unexpected token ''`（**BOM**）⇒ 事务腿拿不到真收据 ⇒ 门报 `promotion_receipts_missing` ⇒ 晋升失败
- 修复后：**24 PASS / 0 FAIL**

### 4.1 本轮在 AC6 路径上修掉的缺陷（4 个，均为**必经**缺陷，不是顺手重构）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| D1 | 引擎建 checkpoint 路径报错、事务腿拿不到证据 | 候选派生 label 含 `:`（`candidate:<id>`），在 Windows 路径中非法 | label 改 `candidate-<id>`；引擎对 label 做防御性 token 清洗；门拒绝不安全 label |
| D2 | 隔离宿主上「生产同形身份」判定不可达（mount-gate 语义与生产不一致） | 隔离仅换端口，未复现生产 profile 形态与其 `DSH_HOME` | 隔离改为临时 `DSH_HOME` + `--profile web` |
| D3 | **Node 读真 journal 失败**：`Unexpected token ''` ⇒ 收据门判 transaction 腿无效 | **PowerShell 5.1 写 UTF-8 时自动加 BOM**，JSON 文件带 BOM ⇒ Node `JSON.parse` 失败 | 引擎写 journal/manifest 等 **JSON 产物**改用无 BOM UTF-8（脚本自身仍保持带 BOM，见 §6 注） |
| D4 | E2E 自身两处误判（非被测代码缺陷） | 本机无 `pwsh`（只有 Windows PowerShell）；worktree 路径比较未规范化 | runner 解析真实 PowerShell；路径比较规范化 |

> D3 的方法学价值：**同一份「UTF-8」在不同消费方是两套要求** ——
> PowerShell **脚本**必须带 BOM（否则 PS 5.1 把中文读成乱码、直接语法错误，见工作区 `AGENTS.md` 红线），
> 而给 **Node 解析的 JSON 产物**必须不带 BOM。二者不能一刀切，按**消费方**定。

### 4.2 提交后复核运行（同一 HEAD，防"文档改动扰动"与"一次性偶绿"）

- 在**本报告与证据所在提交 `ecec589`** 上**再独立运行一次** ⇒ **24 PASS / 0 FAIL**，`exit=0`。
- 断言要点与 §4 完全一致：CI 腿 14 条命令全 `exit 0`／**真 journal 回读**一致（`COMMITTED` / `none` / `COMMIT_READY`）／
  3 组篡改全拒 + 留痕 + 状态不动／隔离宿主端口释放／**生产 3080 PID 前后一致（7176）**／插件 4 项哈希不变。
- 说明（避免复核者误判为不一致）：**每次运行的隔离 commit 是新建的**（隔离 worktree 内新提交，内容相同、对象名不同），
  故留档的首次报告为 `74fd41c9…`、本次复核为 `ab764b9fb70a…`；两次均 24 PASS / 0 FAIL。
- 证据：`e2e-run-final-verify-24PASS.txt`、`ac6-real-e2e-report-final-verify.json`（两文件密钥扫描 **0 命中**）。

---

## 5. 与合同逐字要求的对应（AC6）

合同原文（canonical，见 `CONTRACT_RECONCILIATION_R1.md` 与 `A10_CONTRACT_MATRIX.md` 逐字摘要）：
> Candidate **复用现有 CI / Transaction**，**不造第二套 promotion engine**

| 合同要素 | 本报告证据 | 判定 |
|---|---|---|
| 复用现有 CI | 直接跑 `ci-level2.yml` 的**同一批作业命令**、在候选 commit 的 worktree 内、采用与 CI 相同的环境隔离判据 | **PASS** |
| 复用现有 Transaction | 直接调用既有 `dsh-transaction.ps1`（未新增事务实现），真 journal 产出并被回读校验 | **PASS** |
| 不造第二套 promotion engine | 晋升仍走既有 `promoteCandidate` / `verifyPromotionReceipts`；候选派生 label 供三腿互证；**无新引擎、无常驻服务**（AC8 不变量本次复验仍成立） | **PASS** |
| 收据门有承载力 | 正向：真收据 ⇒ ok/PROMOTED；反向：三组篡改 ⇒ 全拒 + 留痕 + 状态不动 | **PASS** |

---

## 6. 诚实的范围边界（**这些不是 PASS**）

1. **CI 腿是「本地执行 CI 作业命令」，不是 GitHub Actions 托管运行**：证据里 `ci.runUrl` 为**空**。
   这满足「复用现有 CI 作业」的合同要素，但**不等于**「CI 内有真实 E2E 门」——**AC10 仍未关闭**。
   结构性原因（实测）：`.github/workflows/ci-level2.yml` 的触发只有 `pull_request → main` 与 `push → reliability-v1`；
   故本特性分支**不可能**产生 GitHub 托管运行，除非动 main / reliability-v1 ⇒ **属需人类裁决的范围扩权**。
2. **本 E2E 的「晋升」用的是纯状态函数 + 自报审批字段**（`promoteCandidate(..., {approvedBy, approvalEvidence})`），
   **它不构成一次真人审批**。真实真人审批门（A8 / host-fact）在**工具边界**，本次**未触碰、未放宽**；
   本 E2E 不写任何真实 store（store 为进程内对象，证据只落 `%TEMP%`）。
3. **AC2 仍未关闭**：研究腿（`researchPlan` 调用者）依旧零调用，属另一次范围扩权。
4. **未改生产**：未重启服务、未改 `cordis.patch.yml`、未部署插件到生产挂载位；生产 3080 PID 全程一致。

---

## 7. 结论增量（相对 A11 终局判定）

- AC6：**PARTIAL → PASS**（真实三腿 E2E，24P/0F，正反向均验证）。
- A11 的**总判定不变**：P4 仍 ≠ VERIFIED（阻塞仍在 A8 真人审批 + AC2 + AC10；本轮只关闭 AC6）。
- 证据可复跑：`node tests/learn/test-learn-ac6-real-promotion-e2e.mjs`（需 canonical 工作区）。
