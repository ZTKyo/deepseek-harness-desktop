# AC10 — 门存在性可机器判定 + CI 内真跑真实 E2E（关闭记录）

- 日期：2026-09-29（本机）
- 分支 / 提交：`p4-ci-real-gates` @ `422c08f`（主改动）+ `d75640a`（AC6 中断自愈）
- 合同原文：`docs/roadmap/reports/PHASE_04_LEARNING/CONTRACT_RECONCILIATION_R1.md:122-132`
  —— **AC10 = 「真实 E2E 证据 PASS」**（canonical Acceptance Criteria 第 10 条）。
- 关闭前的缺口（`A10_CONTRACT_MATRIX.md` AC10 行逐字）：
  「本地真实门 PASS；**CI 内无真实 E2E 门**」= PARTIAL。
  更深一层的缺陷：**门的"存在性"只写在文字里**——某个套件可以悄悄不再被任何人运行
  （或从来没被接上），而报告仍把它列为"要求门"；`plugins/learn-candidate.mjs`
  的 `STAGE_DELEGATION.ISOLATED_TESTS` 甚至指向 `ci-level1.yml`（一条**根本不运行隔离面**的航道）。

---

## 一、本次关闭的两件事

### 1) 门存在性变成**机器可判的事实**（不再靠文档记性）

| 产物 | 作用 |
|---|---|
| `tests/learn/gate-registry.json` | 唯一登记表：`tests/learn/*.mjs` **全部 39 个**套件的 `kind / ci（哪条航道·哪个 step）/ requires（缺什么真实数据）/ exclusionReason / localCommand / lastVerified` |
| `tests/learn/validate-gate-registry.mjs` | fail-closed 校验器（13 项）：覆盖性、无幽灵/无重复、排除必有据、声明的 workflow 必须真能被 YAML 解析、声明的 CI 门必须**真的**被该 step 的 run 调用、workflow 里不得出现未登记接线、`STAGE_DELEGATION` 指针必须与登记表逐字一致；`helper` 必须真的被某个已登记门 import（"helper"不能是藏门的后门） |
| `tests/learn/_ac10-registry-mutation-proof.mjs` | 反空转证明：先证**未突变时校验器全绿**，再注入 6 个真实缺陷，**每一个都必须让它对应的编号检查变红** |

### 2) CI 内**真跑**真实 E2E（这是 AC10 合同要求的那一条）

- `ci-level3.yml` 新增 step：`P4 LEARN AC6 real promotion e2e (real git + real CI job commands + real transaction)`
  —— 真 `git worktree` + 真隔离分支 + 真 commit（40 位对象名）、真隔离宿主（`mount-gate --hold`，端口 **3099**，非生产 3080）、
  该 commit 上真跑 `ci-level2.yml` 的作业命令清单、真 `dsh-transaction.ps1` 跑到 `COMMITTED` + `COMMIT_READY`，
  再加**负向对照**（篡改任一腿必拒 + 留痕 + 状态不动）。
- `ci-level3.yml` 触发条件新增 `tests/learn/*`：否则"守 learn 的门"在 learn 改动时根本不会跑。
- `ci-level1.yml` 新增两个 step：登记表门 + 它的突变证明（静态、数据无关 ⇒ 必须每个 PR 都跑）。
- `ci-level2.yml`：真实数据无关的 4 个套件由"只在本机跑"改为**进 CI**
  （`test-learn-b1-session-access` / `test-learn-b2-verify-output-contract` / `test-learn-r2-f2-store-min` /
  `redteam-r3-injection-positions`，均以空 profile 判据复核 exit 0）。
- `plugins/learn-candidate.mjs`：`ISOLATED_TESTS.file` 由 `ci-level1.yml`（假绿灯指针）改为 **`ci-level3.yml`**
  （真的运行隔离真实实例的那条航道）；`tests/learn/test-learn-ac2-research-leg.mjs` 的事实锁同步改为真实航道。

---

## 二、证据（可复核命令 + 真结果）

| # | 命令（cwd = `_wt-ci`） | 结果 |
|---|---|---|
| 1 | `node tests\learn\validate-gate-registry.mjs` | **13 PASS / 0 FAIL，exit 0** —— 39 条目 / 4 航道 / 23 个 CI 门经"workflow+step+run 调用"三连核验 / 24 条接线全部已登记 / 16 个未进 CI 条目均写明理由（0 个静默排除）/ `ISOLATED_TESTS -> ci-level3.yml` 指针逐字一致 |
| 2 | `node tests\learn\_ac10-registry-mutation-proof.mjs` | **基线绿（13 PASS）+ M1..M6 全部被抓住 = 7 PASS / 0 FAIL，exit 0** |
| 3 | `node tests\learn\test-learn-ac6-real-promotion-e2e.mjs` | **24 PASS / 0 FAIL，exit 0** —— Git 腿 `609b0b9ccf1d`；CI 腿 **19 条命令全 exit 0（18 套件 + plugin-contract gate）**；隔离宿主 3099 pid=5932；事务 `FinalState=COMMITTED / Verify=COMMIT_READY`；**生产 3080（127.0.0.1 pid=26376）前后一致、监听者 3 项不变**；插件字节不变；清理干净（worktree/分支已删、3099 FREE） |
| 4 | 空 profile 下 `mount-gate`（模拟裸 runner：`USERPROFILE/HOME/APPDATA/LOCALAPPDATA` 指向空目录 + `DSH_BIN` 来自 `npm root -g`） | **PASS，exit 0** —— 依赖 junction 已无来源（裸机没有 `~/.dsh`）时宿主**仍然** HTTP 200 起来并暴露 6 个 `learn_*` 工具、A1–A5 全过、生产 3080 未被扰动 |
| 5 | 登记表里 4 条航道 YAML 真解析（校验器检查 7） | ci-level1/2/3/4 全部合法 |

证据文件（本机临时目录，不随仓库走）：
`%TEMP%\ac6-real-e2e-20260928172819\ac6-real-e2e-report.json`、同目录 `ci-run.log`、`tx\tx-journal.json`。

---

## 三、顺带修掉的两个"假红"根因（否则真问题会被噪声埋掉）

1. **AC6 被中断后必然假红**：隔离分支名由插件哈希派生（`candidate/cand_<hash>`），
   上一次被中断的运行会留下同名分支 + 残留 worktree + 占着 3099 的孤儿宿主；
   下一次运行于是 20+ 检查"看起来像代码坏了"，实测为
   `fatal: a branch named 'candidate/cand_d9b6ae32' already exists` + `EADDRINUSE 127.0.0.1:3099`，
   CI 腿 19 条全部 `exit null`（cwd 不存在）。
   现在：前置**只清自己这次本来就要创建/占用的对象**（同名分支仅在提交信息确为本门所写时删除、
   匹配本门临时布局的残留 worktree、`worktree prune`），3099 若被**他人**占用则直接 ENV 失败（exit 2）
   并报出占用 pid——假红不会再被误读成代码失败。
2. **`mount-gate` 只能在开发机跑**：`DSH_BIN` 硬编码 `%APPDATA%\npm\...`。
   现在按 `--dsh-bin` / `$env:DSH_BIN` / `%APPDATA%` / `npm root -g` 逐级回退，依赖来源同样多级回退。

---

## 四、诚实边界（未覆盖 / 仍然开着的东西）

1. **本机执行的是"同一条作业命令"，不是 GitHub 上的一次真实 run**（`runUrl` 留空，未 push、未建 PR、未合并 main）。
   若要"CI 平台侧"的证据，需要 push 分支 + 开 PR 触发一次真实 workflow（**尚未执行，需用户/主流程决定**）。
2. **4 个真实数据门仍不进 CI**：`run-learn-real-e2e` / `run-learn-contract-scenarios` / `run-learn-real-gap-e2e` /
   `test-learn-real-topology-tool-events` 等消费**本机真实会话日志与生产失败遥测**，裸 runner 上会因"没有数据"失败而非因缺陷失败。
   它们不是"被静默排除"：登记表逐条写明 `requires` + `exclusionReason` + `localCommand`，校验器会对空理由/缺字段变红。
3. **AC10 合同里的"真实 E2E"最强可用形态**是 AC6 那条（真 git + 真隔离宿主 + 真事务 + 真负控）。
   若审阅者要求的是"CI 里跑消费生产会话数据的门"，则需先决定把（脱敏）会话语料纳入仓库——**这是数据边界决策，不擅自做**。
4. `A10_CONTRACT_MATRIX.md` 的 AC10 行需要由主流程按本文件更新裁决（本文件只记录事实与证据，不改既有裁决表）。

---

## 五、复现命令（照抄即可）

```powershell
cd "<repo>\\_wt-ci"
$env:NODE_PATH = (npm root -g)                       # 校验器需要 js-yaml
node tests\learn\validate-gate-registry.mjs           # 期望 exit 0，13 PASS / 0 FAIL
node tests\learn\_ac10-registry-mutation-proof.mjs    # 期望 exit 0，基线绿 + 6 突变全抓 = 7 PASS
node tests\learn\test-learn-ac6-real-promotion-e2e.mjs # 期望 exit 0，24 PASS / 0 FAIL（仓库须干净）
```
