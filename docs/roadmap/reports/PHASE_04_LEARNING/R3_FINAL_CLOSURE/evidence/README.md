# AC2 研究腿关闭 · 证据索引（R3_FINAL_CLOSURE/evidence）

**用途**：本目录是 `AC2_RESEARCH_LEG_CLOSURE.md` 的**原始证据**（不是结论复述）。
每条证据都带生成时间、执行命令、`exit code`，并在可复现时带 `HEAD` / 文件 sha256 前 12 位。
**入库前已做密钥族扫描（19 族模式）= 0 命中**。

| 文件 | 是什么 | 关键结果 | 复现命令（在 `_p4r2-inject-fix` 下执行） |
|---|---|---|---|
| `AC2_RESEARCH_LEG_SUITE.txt` | **正向接线锁**：AC2 研究腿专项门 | `PASS=25 FAIL=0` | `node tests/learn/test-learn-ac2-research-leg.mjs` |
| `AC2_MUTATION_PROOF.txt` | **负控**：7 种突变证明锁不恒真 | 基线全绿 → `M1..M6` 全被抓住 → `PASS=7 FAIL=0` | `node tests/learn/_ac2-mutation-proof.mjs` |
| `AC2_CI_SAFE_PROOF.txt` | 把该套件纳入 CI-safe 子集的**前置证明**（空 profile 重定向下可跑） | `PASS=25 FAIL=0`（含 `D3` 委托去处 = 既有隔离腿） | 见文件头命令 |
| `AC2_APPROVAL_CHAIN.txt` | **批准后发布链路**（真宿主 `ApprovalService` + 真人"允许一次"） | `PASS=22 FAIL=0`，exit 0，含"重启后另一会话仍可召回" | `node tests/learn/test-learn-b1-session-access.mjs` |
| `AC6_E2E_AFTER_AC2.txt` | AC2 改动后的 **AC6 真三腿 E2E 复跑**（含 CI 腿真跑） | `24 PASS / 0 FAIL`；CI 腿 `15 条命令全 exit 0 / 14 套件`（含 AC2 套件 exit 0） | `node tests/learn/test-learn-ac6-real-promotion-e2e.mjs` |
| `ac6-real-e2e-report-after-ac2.json` | 上面那次 E2E 的**结构化报告**（机器可读） | 逐腿 verdict + 隔离 commit id | 同上一行（报告由套件自动写出） |
| `ci-run-after-ac2.txt` | 上面那次 E2E 的**CI 腿原始日志**（397 行级） | 逐条命令 + exit code | 同上一行 |

**读出结论时请注意（防误读）**：

1. `test-learn-ac2-research-leg.mjs` 的 `0.7/0.8` 两条是**反向锁**：它们专门抓「`researchPlan` 有定义但
   没人调用」「偷偷加第二套研究引擎/定时器/子进程」——即 A10 初判所指的**纸面缺陷**。
2. `AC2_MUTATION_PROOF.txt` 的价值在于**证伪"锁恒真"**：若接线被拆，门必须变红；文件中
   `M*` 行后面括号里的 `PASS/FAIL` 数是**突变后**的残存结果，不是通过数。
3. `AC6_E2E_AFTER_AC2.txt` 里的隔离 commit id（`8211c184…`）是**每次运行新建**的临时对象名，
   与仓库 HEAD（`b5f198f`）不同属**正常**：E2E 在临时 worktree 里提交以证明"绿报告针对同一 commit"。
4. 本目录**不含生产运行时证据**：生产 profile 仍是旧插件副本（`researchDirective` 0 命中），
   AC2 的生产遥测要等**部署 + 一次服务重启**后才有（见 `AC2_RESEARCH_LEG_CLOSURE.md` §6 与工作区 `RUNBOOK.md`）。
