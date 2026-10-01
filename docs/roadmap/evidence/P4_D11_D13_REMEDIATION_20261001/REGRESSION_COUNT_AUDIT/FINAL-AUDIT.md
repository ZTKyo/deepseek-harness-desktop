# LEARN 回归面 · 终审对账（FINAL AUDIT）

生成时间：2026-10-01 04:15（本机时间）
审计目录：`C:\Users\Administrator\Desktop\sdeepseek harness\_p4rem-closure\regression-count-audit\`
被测对象：`wt\` = **deepseek-harness-desktop** 的独立克隆（`.git` 指向 ZTKyo/deepseek-harness-desktop）

---

## 0. 审计边界（先纠正一个前提，否则后面全部结论都悬空）

| 事实 | 值 | 怎么验的 |
|---|---|---|
| `wt` 的 HEAD | **`63bf558`**（Merge PR #102 from ZTKyo/p4seal-gov-sync） | `git -C wt rev-parse HEAD` |
| 分支 / 脏状态 | `p4-ext-review-remediation-r1`，**working tree clean**，无 upstream | `git status --porcelain` 空 |
| 是否等于 origin/main | **是**（`git rev-list --count 63bf558..origin/main` = **0**） | 同上 |
| **`f79704aa` 是否存在** | **不存在**。5 个本地仓库（wt、deepseek-harness-desktop、output/gh-upload/…、_audit-r1/official-dsh、_release-staging、_rh1-hotfix/canonical）全部 `cat-file -e f79704aa` → exit 128，`log --all` 也搜不到 | 逐仓 `cat-file`/`--grep` |

> **因此：任何引用「HEAD f79704aa」的账本、证据包或对账结论，在本机无法与任何一份字节核对。**
> 本报告的"HEAD"一律指 `63bf558`。若 `f79704aa` 来自另一个克隆/另一台机器，需要把该克隆的路径给我才能做收敛比对——这不是可以靠推测补齐的。

另外：工作区根目录 `Desktop\sdeepseek harness` **本身不是 git 仓库**（无 `.git`），所以"工作区版本"的说法在这里没有对象。

---

## 1. 结论摘要（一页看完）

1. **登记面 43 项 = 39 项由我直接实跑 + 3 项由仓库自带 runner 这条路径覆盖（`production-load-probe`、`ac6-e2e-lock`、`run-learn-all-tests`）+ 1 项 `_real-session-harness.mjs` 为被 import 的助手（无独立执行语义）**，全部在 HEAD 字节上；**45 份**原始日志零丢失。
2. **没有任何一个登记项是"断言失败"**：非零退出只有 4 次，且**没有一次是断言失败**——1 次 OOM、2 次缺参数（用法错误）、1 次是仓库 runner 自己的格式假红（§14）。
3. 计数方式**极度不统一**：32 项靠套件自报总数，只有 1 项能被逐行数（mount-gate），**7 项完全没有逐条计数**（纯 exit 码），其中 **3 项在源码层面就不可能变红**。
4. **最严重的计数陷阱**：`test-learn-ac6-real-promotion-e2e.mjs` 会**把另外 19 个套件的 `PASS tests\learn\xxx.mjs (exit 0)` 行打进自己的 stdout**（它作为子进程重跑 CI 清单）。任何"数 PASS 行"的聚合器会给它记 **46**，而它自己的真实断言是 **27**。这正是历史 totalPASS 虚高的机制性真因之一。
5. **第二严重**：`test-learn-ac1-secret-families.mjs` **成功即静默**（只在失败时打印名字），日志里 **0 条断言行**，只有 `PASS=43 FAIL=0`；逐行计数得 0，自报得 43；43 由循环展开（§1 8 族×2 + §2 10 族×1 + §3–§5 静态检查）而来，**随表长度变动**，无法从日志枚举。
6. **3 项"永远绿"**：`redteam-r3-labels.mjs`（纯数据模块 `export const LABELS`，全文 **0 个 `console.*` / 0 个 `process.exit` / 0 个 `throw` / 0 个 `assert`**）、`redteam-r3-probe.mjs`（头部自述"刻意不做断言"）、`redteam-r3-injection-positions.mjs`（自述目的是"决定规则是否该收紧"）。**三者都挂在 CI 的执行数组里**（ci-level2 L201/L202/L205），CI 只看 exit code ⇒ 它们永远绿。
7. **CI 接线 23/43，排除 20 条且每条都带 `requires` + 排除理由 + 本地命令（0 条缺记录）**；没有绕过登记表的野门（CI 引用但未登记 = 0）。
8. **登记表没有生产消费者**：全库只有 `validate-gate-registry.mjs` 与 `_ac10-registry-mutation-proof.mjs` 两个文件读 `gate-registry.json`，两者都在 `tests/learn/` 内；`~/.dsh/profiles/web/` 里对 `gate-registry` 的命中**全部是注释**。⇒ **"登记表 = 运行时约束"不成立，它是 CI/测试期的账本。**
9. **生产部署与 HEAD 是字节级一致的**（这是我原本没指望的干净结果）：生产 `~/.dsh/profiles/web/` 的 4 个 learn 插件 SHA256 与仓库 `plugins/` 在 63bf558 上**逐个相同**：
   `learn.mjs 5C4EE78CA2DE` / `learn-core.mjs DCF2A2AE05E1` / `learn-candidate.mjs 2B4D38532300` / `learn-gap-veto.mjs B7623CEDF87E`。
   ⇒ ac1 的默认目标（生产字节）与它的仓库目标变体**测的是同一份字节**，所以两次都 43 PASS（见 §5）。
10. **确定性判定**：逻辑层确定性成立（同名套件重跑结论一致）；资源层有 **1 个已知 flake**：`run-learn-contract-scenarios.mjs` 首次跑 `Error: Allocation error : not enough memory`（exit 1，并发负载下 OOM），重试 118.74s 后 **36 PASS / 0 FAIL**。
11. **观测者效应：无**。生产 3080 的 node 服务 **pid=8272，自 03:27:42 起未变化**（全程同一进程）；guardian 日志仅 04:13:34 记了一次 `health DEGRADED (failures=1, errorClass=api_unready) - no restart (RH1)`——**没有重启**。
12. **仓库自带的汇总 runner（`run-learn-all-tests.mjs`）本轮真的跑完了：765.4s，exit 1，报告「36/39 全绿 / 门槛断言 1240 PASS / 0 FAIL / 失败套件 3 个」——但那 3 个「失败」全是格式解析假警报**（三个套件本体 **exit=0**，被判 `NO-SUMMARY`，而该 runner 的判定式是 `ok = code===0 && fl===0 && kind!=='NO-SUMMARY'`）。⇒ **聚合层的假红**，与"空转假绿"正好互为镜像。详见 §14。

---

## 2. 交付物（本次新增，全部可重跑）

| 文件 | 作用 |
|---|---|
| `FINAL-AUDIT.md` | 本文件（结论 + 大表） |
| `FINAL-AUDIT.json` | 机读版：43 项 × 权威通过数 / 计数依据 / 能否变红 / 每次运行明细 |
| `finalize.mjs` | 汇总脚本（只读输入，重跑即复现本报告全部数字） |
| `final-reconciliation.txt` | `finalize.mjs` 的控制台输出（含 HEADLINE） |
| `ci-coverage.json` / `ci-coverage-report.txt` | CI 接线 vs 登记表逐条对账（23/20/0 mismatch） |
| `fail-path-audit.json` / `fail-path-report.txt` | 每项的"能否变红"证据（exit 路径 / throw / assert / 数据模块判定） |
| `named-suite-evidence.json` / `named-suite-evidence.txt` | 三个命名套件 + isolation/labels/probe/stage2 的**断言名逐条清单** |
| `logs\`（**45 份**） | 原始日志：`########## SUITE/CMD/EXIT/ELAPSED_S/TIMEOUT_FLAG/CWD ---- STDOUT ---- STDERR` 分区（第 45 份 = 仓库 runner 的输出，见 §14） |

---

## 3. 43 项大表（权威通过数 · 计数依据 · 能否变红 · CI）

计数依据：`self-report` = 套件自报总数；`per-line` = 逐行断言行；`exit-only` = 只有退出码；`not-run` = 本轮未运行。

### A. CI 真正执行的 23 项

| 套件 | kind | 依据 | 通过数 | 能变红 |
|---|---|---|---|---|
| test-learn-plugin-contract.mjs | gate | self-report | 8 | ✅ |
| test-learn-core.mjs | gate | self-report | 505 | ✅ |
| test-learn-candidate.mjs | gate | self-report | 40 | ✅ |
| test-learn-ac6-candidate-durability.mjs | gate | self-report | 10 | ✅ |
| test-learn-ac5-e2e.mjs | gate | self-report | 13 | ✅ |
| test-learn-stage85-twins.mjs | gate | self-report | 22 | ✅ |
| test-learn-real-topology-tool-events.mjs | gate | self-report | 22 | ✅ |
| test-learn-candidate-receipts.mjs | gate | self-report | 33 | ✅ |
| test-learn-ac2-research-leg.mjs | gate | self-report | 27 | ✅ |
| test-learn-r3-fixes.mjs | gate | self-report | 30 | ✅ |
| test-learn-r3-hardening.mjs | gate | self-report | 30 | ✅ |
| test-learn-r3-secrets.mjs | gate | self-report | 65 | ✅ |
| redteam-r3-contamination.mjs | gate | self-report | 9 | ✅ |
| redteam-r3-isolation.mjs | gate | self-report | 13 | ✅ |
| **redteam-r3-labels.mjs** | gate | **exit-only** | **0** | ❌ **永远绿** |
| **redteam-r3-probe.mjs** | gate | **exit-only** | **0** | ❌ **永远绿** |
| **redteam-r3-injection-positions.mjs** | gate | **exit-only** | **0** | ❌ **永远绿** |
| test-learn-b2-verify-output-contract.mjs | gate | self-report | 21 | ✅ |
| test-learn-r2-f2-store-min.mjs | gate | self-report | 19 | ✅ |
| test-learn-ac6-real-promotion-e2e.mjs | gate | self-report | **27**（**不是 46**，见 §4 陷阱 1） | ✅ |
| _ac2-mutation-proof.mjs | mutation-proof | self-report | 27 | ✅ |
| validate-gate-registry.mjs | registry-gate | self-report | 15 | ✅ |
| _ac10-registry-mutation-proof.mjs | mutation-proof | self-report | 15 | ✅ |

接线位置：`ci-level2.yml` L142/L188–L205/L225、`ci-level1.yml` L125/L139、`ci-level3.yml` L597（ac6-real-promotion）。

### B. 登记但 CI 不跑的 20 项（每条都有 `requires` + 原因，此处是实跑结果）

| 套件 | kind | 依据 | 通过数 | 能变红 | 为什么不在 CI |
|---|---|---|---|---|---|
| test-learn-b1-session-access.mjs | gate | self-report | 22 | ✅ | 需**已安装**的 dsh 包（mkHostApproval/resolveHarnessPackage） |
| test-learn-ac1-secret-families.mjs | gate | self-report | 43 | ✅ | 需已部署 profile 字节（默认测生产） |
| test-learn-ac5-gap-veto.mjs | gate | self-report | 44 | ✅ | 需生产 P2.6 遥测日志 |
| test-learn-r2-b1-approval-gate.mjs | gate | self-report | 19 | ✅ | 需真实会话语料 + 宿主批准台账 |
| test-learn-r2-b2-bounds.mjs | gate | self-report | 45 | ✅ | 需真实会话语料 |
| test-learn-r3-approval-forgery.mjs | gate | self-report | 27 | ✅ | 需真实会话候选 |
| test-learn-stage2-schema-and-negative-lock.mjs | gate | self-report | 23 | ✅ | 需真实会话 tool/result 事实 |
| run-learn-contract-scenarios.mjs | gate | self-report | 36 | ✅ | 需 ≥2 个真实会话文件 |
| run-learn-real-e2e.mjs | gate | self-report | 65 | ✅ | 需真实会话文件 |
| run-learn-real-gap-e2e.mjs | gate | self-report | 20 | ✅ | 需语料里真有"重复未解决工具失败" |
| redteam-r3-metrics.mjs | gate | **exit-only** | 0（**有真实失败路径**） | ✅ | 需仓外人工评审产物 `_r3\r3_quality_sample.json` |
| redteam-r3-quality.mjs | gate | **exit-only** | 0（有真实失败路径） | ✅ | 需真实语料（取最大候选） |
| production-load-probe.mjs | tool | not-run | — | ✅ | 需活的生产服务 + 真实模型凭据（会真发对话） |
| mount-gate.mjs | tool | **per-line** | 4 | ✅ | 需显式 `--plugin <abs path>` |
| deploy-preflight.mjs | tool | exit-only | 0（有真实失败路径） | ✅ | 需显式 `--deploy <列表>` |
| run-learn-all-tests.mjs | runner | self-report（runner 自算） | **1240 / 0 FAIL** | ✅（本轮 exit 1，为 3 个 NO-SUMMARY 假红，见 §14） | 本机完整环境（它把全部床子跑一遍） |
| _real-session-harness.mjs | helper | not-run | — | ✅ | **`requires` 字段为空**（登记纪律的小缺口） |
| test-learn-ac6-e2e-mutex.mjs | gate | self-report | 11 | ✅ | 独占运行（跨 worktree 互斥锁 + 真 worktree + 隔离宿主 3099） |
| ac6-e2e-lock.mjs | helper | not-run | — | ❌ | **`requires` 为空** + 自身无失败路径（助手模块） |
| audit-merge-enforcement.mjs | tool | exit-only | 0（有真实失败路径） | ✅ | 需 gh CLI 登录 + admin 只读权限 |

**合计**：能变红 39 / 不能变红 4；`self-report` **32** 项、`per-line` 1 项（mount-gate）、`exit-only` 7 项、`not-run` **3** 项（`suitesGreenVacuous`=3、`suitesExitOnlyButCanFail`=4，见 `FINAL-AUDIT.json`）。
**逐行打印的自身 PASS 行合计 1286**（外溢行 58 行**已剔除**，见 §4）；**32 个自报项的数字不可加总**——其中 runner 的 **1240 本身就是对另外 31 项断言的汇总**，加进去会与逐项重复。真正互不重复的逐项自报合计 = **1306**。

---

## 4. 计数方言与三个计数陷阱

### 方言表（决定"数字从哪来"）

| 方言 | 形态 | 代表套件 | 影响 |
|---|---|---|---|
| A | `PASS  名字`（2 空格） | core、b1、isolation… | 逐行可数 |
| B | `[PASS] 名字` | stage2（实为 ✓）、r3-fixes 等变体 | 逐行可数 |
| C | `✓ 名字` | stage2、isolation 部分 | 逐行可数（但会被只认 `PASS` 的聚合器漏掉） |
| D | **成功静默**，只打印总数 | **ac1**（`PASS=43 FAIL=0`） | 逐行得 0，只能取自报 |
| E | 中文结果行 + 总数 | b1（`结果：PASS 22 / FAIL 0`）、stage2（`…23 PASS / 0 FAIL`） | 需专门正则 |
| F | 观测模式，无断言 | probe（`探针完成（观测模式，无 pass/fail 门槛）`） | 无论怎么数都是 0 |

### 陷阱 1（最严重）：ac6-real-promotion 的外溢行

它的 stdout 里混着 **19 行**别的套件的行，因为它把 CI 清单当子进程重跑，举两行实例：

```
PASS  tests/learn/test-learn-plugin-contract.mjs  (exit 0)
PASS  tests/learn/test-learn-core.mjs  (exit 0)
```

它自己的自报是 `27 PASS / 0 NA / 0 FAIL`；逐行数（含外溢）**46**。
**本报告的 `finalize.mjs` 内置外溢行剔除规则**（模式 ①：`PASS  tests/learn/<file>.mjs  (exit …)`），剔除后 27 == 自报 27，两侧对得上。

**同类第二处外溢（本轮新增）：仓库 runner 的汇总表**。`run-learn-all-tests.mjs` 的 stdout 里有两段逐套件报表，形式为

```
  PASS  mount-gate.mjs                                  1P/  0F  exit=   0  gated       26.1s
  FAIL  ac6-e2e-lock.mjs                                0P/  0F  exit=   0  NO-SUMMARY  0.2s
```

——这 **39 行**是"runner 关于别家套件的报表行"，**不是 runner 自己的断言**。`finalize.mjs` 已加模式 ②（`(PASS|FAIL)  <file>.mjs  <N>P/`）一并剔除。

**全库外溢行合计 58 行**（19 + 39），已全部剔除；剔除后 `totalOwnAssertPassLines` 为 **1286**（= 未加 runner 日志前的同值，可作剔除规则正确性的自证）。
→ 任何历史 totalPASS 若明显偏高，先查这两条。

### 陷阱 2：ac1 的成功静默

`check(name, ok, detail)` 的实现是 `if (ok) pass++; else { fail++; failures.push(...) }` —— **成功不打名字**。
所以日志里只有 `§0 PASS import=<哪个字节>`、`PASS=43 FAIL=0`、`AC1_SECRET_FAMILIES_VERDICT=PASS`。
43 的来源（读源码可复算）：§1 反证家族 8 族 × 2 检查（`noValueSurvives` + `containsSecret=true`）= 16；§2 对照族 10 族 × 1 = 10；§3 通用形态 3；其余为 §4 过度脱敏、§5 幂等/边界检查。
⇒ **它是一个真门（fail>0 → exit 1），但它的通过数不可从日志枚举，且随家族表长度变化。**

### 陷阱 3：labels 的"零输出"

`redteam-r3-labels.mjs`（133 行）：源码里 `console.*` **0** 个、`process.exit` **0** 个、`throw` **0** 个、`assert` **0** 个，唯一导出是 `export const LABELS = {`。
⇒ 它**在结构上不可能打印任何计数、也不可能变红**。任何聚合器给它 0 是"正确但无意义"。

---

## 5. 三个命名套件档案（父代理点名的那三个）

### 5.1 `test-learn-ac1-secret-families.mjs`（gate，CI 不跑）

- **现在做什么**：import 被测模块（默认 `%USERPROFILE%\.dsh\profiles\web\learn-core.mjs`，**可用 argv 覆盖**），检查密钥脱敏家族覆盖 + fail-closed 前置：§0 必须导出 `redactSecrets`/`containsSecret` 否则直接 `exit 3`（fail-closed，不静默跳过）；§1 反证家族必须被拦；§2 对照族不得回归；§3 通用形态（KEY=值、Bearer、URI 凭据）；§4 不得过度脱敏（经验正文仍可读）；§5 幂等与边界入参。
- **设计事实**：文件里所有假密钥都用**运行时字符串拼接**（`'AIza' + 'A'.repeat(35)`，PEM/JWT 标记也拆开），注释写明理由=否则本文件会被仓库两层 secret-scan（`tests/reliability/secret-scan-check.mjs` + CI Level1 正则）判成真泄漏。
- **实测两条目标线**：
  - 生产目标：`§0 PASS import=…\.dsh\profiles\web\learn-core.mjs` → exit 0，`PASS=43 FAIL=0`，逐行断言行 **0**。
  - 仓库目标：`§0 PASS import=…\regression-count-audit\wt\plugins\learn-core.mjs` → exit 0，`PASS=43 FAIL=0`，逐行断言行 **0**。
  - **两者同值的原因已查明**：生产 `learn-core.mjs` 与仓库 `plugins/learn-core.mjs` **SHA256 逐字节相同**（DCF2A2AE05E1…），所以不是"目标无关"，而是"两个目标本来就同一份字节"（见 §9）。
- **定性**：真门、真 43 条断言、能变红；缺点只有两条——(a) 成功不可枚举；(b) 默认目标是**部署字节**而非仓库字节，所以要主张"HEAD 上的证据"必须显式传仓库路径（本次已做该变体）。

### 5.2 `test-learn-ac2-research-leg.mjs`（gate，**CI 跑**，ci-level2 L195）

- **现在做什么**：27 条**具名**断言，覆盖 AC2 自主研究腿的完整契约：复刻版校验器能抓类型/undefined 键/未声明字段（0.1–0.3）；风险分级 LOW/HIGH 及非字符串保守（0.4–0.6）；★接线锁：`learn.mjs` 里 `researchPlan` **真的被调用且结果被用上**（0.7）、无定时器/无子进程/无第二套研究引擎（0.8）；主场景与输出契约（A1–A7，含负控 A7：有覆盖时**不存在** researchDirective）；有界与防刷（B1–B4）；时间序闭环（C1–C4-2，含"更早的经验即使验证通过也不闭环"负控与 `time_only` 如实标注）；纯 JSON 与唯一权威上限（D1–D3）。
- **实测**：生产目标 27 PASS、仓库目标 27 PASS，**逐行断言名两侧完全一致**（44 行 stdout，无外溢）。
- **定性**：**当前最可信的门之一**——具名、可逐条核对、目标无关、既有正例也有负控，且真的在 CI 里跑。

### 5.3 `test-learn-b1-session-access.mjs`（gate，CI 不跑）

- **现在做什么**：22 条具名断言，围绕"宿主会话访问 + 审批信任锚"：T1.0–T1.4（未注入 sessions 的部署形态下 `apply` 不得抛、挂载期对 `ctx.sessions` 的**裸读次数必须为 0**、夹具自证裸读确实抛并 +1、缺 sessions 判 `service_absent` 而非"已验证"、缺 sessions 仍可服务）；T2.0–T2.4（真实宿主 ApprovalService 可用才继续，否则**明确失败而非静默跳过**；file_hash 证据 PASS ⇒ VERIFIED_EXPERIENCE；人类在宿主通道答"允许一次"⇒ 批准+发表；台账落账+信任锚在岗+全局库真的收到）；T2−（人类答"拒绝"⇒ 不批准不发表，证明 T2.2 非恒真）；T3.0–T3.3（第二个部署形态：看得到已批准经验、判定点 DENY 且原因是**宿主事实不可复验**、全局库未被污染并留 `GLOBAL_PUBLISH_DENIED`）；T4.0–T4c（自述审批无 attestation ⇒ 拒绝；批准后篡改内容 ⇒ live 授权失效；**链式完全自洽的伪造台账 + 宿主无事件对 ⇒ DENY**）；T5.0–T5.2（进程重启后 live 授权/可发布性不变、**另一个会话仍能召回**）。
- **实测**：exit 0、1.02s、**22 PASS / FAIL 0**（有 `=== 结果：PASS 22 / FAIL 0 ===` 汇总行）。
- **定性**：真门、具名、可逐条核对；不在 CI 的原因写得很实在——它需要**宿主已安装的 `@deepseek-ai/dsh` 包**（`mkHostApproval → resolveHarnessPackage` 需要 cordis + dsh-*），CI 容器里没有。

---

## 6. `redteam-r3-isolation.mjs` 的 13 条断言（并且它确实跑了）

它在 CI 里（ci-level2 L200），本轮实跑：**exit 0、0.37s、13 条具名断言、0 FAIL**，源码有真实失败路径（能变红）。四个小节：

```
=== A. 正常会话隔离（真实 DSH 形状 sessionId） ===
  A0 真实插件确实产出了候选（前置条件）
  A1 两个会话映射到两个不同文件
  A2 磁盘上确实两个库文件
  A3 两库各自归属正确 sessionId
  A4 A/B 候选标题无交集
  A5 B 库无 A 的语料痕迹
=== B. sanitizeFileId 撞名（R3 根因修复验证：撞名应已消除）===
  B1 两个不同 sid 不再映射到同一文件（撞名已消除）
  B2 磁盘上两个独立库文件
  B3 两库各自归属正确 sessionId（无顶替）
  B4 无跨会话污染（后跑方不继承先跑方经验）
  B5 守卫直测：伪造他人归属的库必须被拒绝载入并重建
=== C. 超长 sessionId（>120 字符）截断撞名应已消除 ===
  C1 超长 sid 不再撞名（两个独立文件）
  C2 超长 sid 两库各自归属正确（无互相覆盖）
=== D. 结论 ===
```

**判定**：这是一条**货真价实的门**——既有正例（两会话两文件、归属正确）又有负例（B5 伪造归属必须被拒载），且覆盖了两个历史撞名根因（sanitizeFileId、超长 sid 截断）。

---

## 7. 三个"永远绿"的登记项：定性 + 接班人

| 套件 | 源码证据 | 自述目的 | 有没有接班者 |
|---|---|---|---|
| `redteam-r3-labels.mjs` | 133 行；`console.*`=0、`process.exit`=0、`throw`=0、`assert`=0；唯一导出 `export const LABELS = {`；头部："R3 人工质量标签（HUMAN GROUND TRUTH）… 标签依据上下文语义，不依据关键词命中" | 人工真值标签**数据** | 无（它就是数据；消费者是 metrics/quality 这类离线分析） |
| `redteam-r3-probe.mjs` | 252 行；`console.*`=10、`process.exit`=0、`throw`=0、`assert`=0；头部："**本文件刻意不做断言**（不设 pass/fail 门槛）——它输出真实观测，供人工质量抽样与缺陷定位。**断言化的回归测试在 test-learn-core.mjs（C16+）**" | 输出观测（A–N 共 14 个小节） | **有，且它自己写明了**：`test-learn-core.mjs`（CI 里跑，自报 505 条） |
| `redteam-r3-injection-positions.mjs` | 88 行；`console.*`=9、`process.exit`=0、`throw`=0、`assert`=0；头部："目的：**决定**『未闭合注入块剥离』规则是否应该收紧" | 决策支持实证（真实发言里 `<system-reminder>` 出现在什么位置） | 无（它是"零事件数据集"的脚本化版本，不该有线上门） |

**判定（只报告不改）**：
1. 三者的 `kind` 在登记表里都是 **`gate`**，但按语义应是 `evidence` / `probe`；建议改 kind 或从 CI 执行数组里摘出——**否则 CI 的绿灯里永远混着 3 个死门**。
2. `probe` 的断言职责确实已由 `test-learn-core.mjs` 承接（它自己注明），所以"probe 被取代"成立；`labels`/`injection-positions` 属于证据类，**不该被期待变红**——需要修的是账本口径，不是套件。

---

## 8. Gate vs Ledger（CI 接线 / 看门狗等价）

| 问题 | 答案 | 证据 |
|---|---|---|
| 登记表有多少项 | 43 | `gate-registry.json`（registryVersion 见文件） |
| CI 真正执行多少 | **23** | `ci-coverage.json`（逐 workflow:line） |
| 排除多少 / 是否都有理由 | **20**，**每条都有 `requires` + `exclusionReason` + `localCommand`** | 同上（仅 `_real-session-harness.mjs`、`ac6-e2e-lock.mjs` 的 `requires` 为空——小缺口） |
| 登记表 ↔ CI 不一致 | **0** | `registry<->CI mismatch: 0` |
| CI 里有绕过登记表的门吗 | **没有**（CI 引用但未登记 = 0） | 同上 |
| 登记表有生产（运行时）消费者吗 | **没有**。全库仅 2 个文件读 `gate-registry.json`（`validate-gate-registry.mjs`、`_ac10-registry-mutation-proof.mjs`），都在 tests 内；`~/.dsh/profiles/web/*.mjs` 里的命中全是注释 | 逐文件正则扫描 |
| 那"看门狗等价"存在吗 | **不存在**。生产侧唯一的健康判断是 `dsh-guardian.ps1`（进程/健康探针级），它不读登记表、不知道有哪些门；登记表是 CI/测试期账本 | guardian 日志 + 上述扫描 |

**推论**：登记表的"约束力"完全依赖 CI 触发路径。**23 条接线里有 3 条是死门** ⇒ 实际能变红且被 CI 执行的 = **20**；剩下 20 条登记项只有"人工或本地跑一遍"这一条执行路径。

---

## 9. 生产部署 vs HEAD：字节级收敛

| 插件 | 生产 `~/.dsh/profiles/web/` | 仓库 `wt/plugins/`（HEAD 63bf558） | 一致 |
|---|---|---|---|
| learn.mjs | `5C4EE78CA2DE…` | `5C4EE78CA2DE…` | ✅ |
| learn-core.mjs | `DCF2A2AE05E1…` | `DCF2A2AE05E1…` | ✅ |
| learn-candidate.mjs | `2B4D38532300…` | `2B4D38532300…` | ✅ |
| learn-gap-veto.mjs | `B7623CEDF87E…` | `B7623CEDF87E…` | ✅ |

⇒ 就 learn 插件面而言，**生产 = HEAD 63bf558**（SHA256 全等）。
这也解释了一个看似矛盾的现象：ac1 默认测生产字节却与仓库目标同分——它们本来就是同一份字节。
（仓库侧 `plugins/*` 的 mtime 是 10-01 03:22，那是 worktree 检出时间，不是内容改动时间；判据用 SHA256。）

---

## 10. 确定性 / flake / 未运行项

**非零退出共 3 次，无一为断言失败**：

| 运行 | exit | 性质 | 复现证据 |
|---|---|---|---|
| `run-learn-contract-scenarios.mjs`（首次） | 1 | **环境**：`Error: Allocation error : not enough memory`（stderr 965B），并发负载下 OOM | `logs\run-learn-contract-scenarios.txt` |
| 同上（重试） | 0 | 118.74s，**36 PASS / 0 FAIL**，`合同符合性：36 PASS / 0 FAIL` | `logs\run-learn-contract-scenarios-retry.txt` |
| `mount-gate.mjs`（无参数） | 2 | **用法**：缺 `--plugin <abs path>` | `logs\mount-gate.txt` |
| `deploy-preflight.mjs`（无参数） | 2 | **用法**：`[env error] 缺少 --deploy <file1,...>`（脚本明确禁止"全部同步"） | `logs\deploy-preflight.txt` |
| `run-learn-all-tests.mjs`（仓库自带 runner） | **1** | **聚合层假红**：36 个真门全部 exit 0、门槛断言 1240 PASS/0 FAIL，RED 由 3 处**摘要格式不匹配**（`NO-SUMMARY`）造成，详见 §14 | `logs\run-learn-all-tests.txt` |

（后两项属 fail-closed 正确行为；带参运行 `mount-gate-pass.txt` exit 0、`deploy-preflight-real.txt` exit 0 已另存。）

**同名套件多跑结论一致**：ac1（生产/仓库两线均 43、0 FAIL）、ac2（两线均 27、0 FAIL）、contract-scenarios（重试后 36/0）。
**已知 flake**：仅 contract-scenarios 的内存敏感一项 ⇒ **结论：逻辑层确定性 OK；资源层有 1 个已知 flake，触发条件是并发负载**。

**本轮未运行的 3 项及原因**：
1. `production-load-probe.mjs` —— 需要**真实模型凭据**并会**发起一次真实对话**（花钱、会写入真实会话），且它是"验证生产装载了哪版字节"的探针；本报告不需要它，故**故意不跑**。
   ⚠️ 但与它**同族的 `run-learn-all-tests.mjs` 内部把它跑了**（runner 日志里 `PASS production-load-probe.mjs 1P/0F exit=0 VERDICT=NEW_CODE_LOADED 21.4s`）——那一次是 runner 用**无参默认方式**发起的，与"我故意不主动发起真实对话"不矛盾。
2. `_real-session-harness.mjs` / `ac6-e2e-lock.mjs` —— helper（被其它套件 import），无独立判定语义；二者均在本轮被其它路径实际执行到（runner 内 0.2s / 被 ac6 系列 import）。
3. `run-learn-all-tests.mjs` —— **已运行（批 B 尾部，765.4s，exit 1）**，结果见 §14；它不在 `not-run` 里。

⇒ 修正后的口径：**43 项中 42 项在本轮被真正执行过**（唯一未被任何路径执行的是我主动避开的 `production-load-probe.mjs` 独立直跑，但它在 runner 内被执行并 PASS）。

---

## 11. 观测者效应与"看门狗等价"

- **生产服务未被扰动**：3080 的 node 服务 **pid=8272，启动 03:27:42，全程未变**（同进程、6 条 established 连接）。
  ⚠️ 注意别被 `Get-NetTCPConnection` 误导：监听 3080 的还有 **pid=7176 = `tailscaled`**（Tailscale 的 IPv6/100.120.3.29 代理），取"第一个 listener"会读成 tailscaled（我第一遍就读错了）。
- **ac6-real-promotion 自带反扰动断言**：`生产 3080 未被扰动（前后身份 pid 一致 + 完整监听者集逐字一致）`，`隔离宿主已关停 + 3099 端口已释放` —— 它自己就是"别把生产搞坏"的守卫。
- **真看门狗是 health 型**：`dsh-guardian.ps1` 在 04:13:34 记了一次 `health DEGRADED (owner=ok, failures=1, window=0s, errorClass=api_unready) - no restart (RH1)`——高并发负载下的一次瞬时 API 未就绪采样，**guardian 正确地没有重启**。
- **两套互斥锁**（`ac6-e2e-lock.mjs` + `test-learn-ac6-e2e-mutex.mjs`）说明 AC6 的 E2E 已被当作"独占资源"管理；它也因此被排除出 CI。
- 我的批量执行方式：**只读日志/源码 + 逐套件独立子进程**，没有改生产 profile、没有重启服务、没有写生产状态。

---

## 12. 复现命令（全部可原样重跑）

```powershell
$r = "C:\Users\Administrator\Desktop\sdeepseek harness\_p4rem-closure\regression-count-audit"
node "$r\finalize.mjs"            # 重建 FINAL-AUDIT.json + 控制台对账（43 项 × 计数依据）
node "$r\ci-coverage.mjs"         # 重建 CI 接线 vs 登记表对账
node "$r\fail-path-audit.mjs"     # 重建"能否变红"证据表
node "$r\named-suite-extract.mjs" # 重建命名套件断言清单
```

单跑某项（示例，把 ac1 钉在**仓库字节**上）：
```powershell
node "…\wt\tests\learn\test-learn-ac1-secret-families.mjs" "…\wt\plugins\learn-core.mjs"
```

---

## 13. 剩余缺口（诚实清单）

1. **`f79704aa` 无法对账**（本机 5 个仓库都不存在该提交）——需要对方给出路径/仓库，否则任何"HEAD 收敛"结论的对象只能是 `63bf558`。
2. **ac1 的 43 条断言名不可枚举**（成功静默）；若需要逐条名单，得改套件（让 `check()` 成功也打印）或读源码复算——本报告选择了后者并给出了构成。
3. **3 条死门仍被 CI 接线**（labels/probe/injection-positions）⇒ CI 绿灯中的门数被虚高 3。
4. **ac6-real-promotion 的外溢行**会持续污染任何"数 PASS 行"的聚合器（本次已在汇总层剔除并留规则）。
5. **2 个 helper 的 `requires` 为空**（`_real-session-harness.mjs`、`ac6-e2e-lock.mjs`）——登记纪律的文档缺口，不影响执行。
6. **contract-scenarios 的内存敏感 flake** 未根治（重试可过）；根因在并发负载，不在断言逻辑。
7. **`audit-merge-enforcement` / `redteam-r3-metrics` / `redteam-r3-quality` / `deploy-preflight`** 属"只有 exit 码、无逐条计数"但仍可失败；要给它们逐条计数需改套件输出格式（本轮未改，遵守"只报告不改"）。
8. 生产面不存在登记表消费者 ⇒ **登记表的"门"语义只在 CI 成立**；若期望"部署面也被登记表约束"，需要新建机制（本次未做，属架构变更，需用户/父代理决定）。

---

## 14. 第三套计数实现：仓库自带 runner（`run-learn-all-tests.mjs`）—— 本轮实测结果

**运行**：`node tests/learn/run-learn-all-tests.mjs --timeout=600000`，cwd=wt，**765.4s，EXIT=1，无超时**。日志：`logs\run-learn-all-tests.txt`（5667B）。
它的**自算口径**（与我、与 CI 都不同，是第三套）：

```
套件：36/39 全绿    （门槛套件 31 个 / 观测套件 5 个 / 环境前置未满足 0 个）
门槛断言：1240 PASS / 0 FAIL   观测套件仅按退出码判定（无 pass/fail 门槛）
失败套件：ac6-e2e-lock.mjs , audit-merge-enforcement.mjs , test-learn-ac6-real-promotion-e2e.mjs
```

### 14.1 它的计数规则（源码 `run-learn-all-tests.mjs` L84–L139，逐条核实）

- 判定式：`ok = code === 0 && fl === 0 && kind !== 'NO-SUMMARY'`（**exit code 是权威信号，但 NO-SUMMARY 一律判 FAIL**）。
- 计数**不数行**：`p/fl` 只来自套件**自报的数字摘要**，用一条交替正则取**最后一条**摘要（L98），认 **4 种数字格式**：
  ① `59 PASS / 0 FAIL` ② `44 pass, 0 fail` ③ `PASS = 8  FAIL = 0` ④ `结果：PASS 22 / FAIL 0`；
  外加 **2 种文本裁决**兜底：⑤ `verdict: PASS`（mount-gate）⑥ `VERDICT=NEW_CODE_LOADED`（production-load-probe，折算 1/0）。
- 观测模式特例：文件名以 `redteam-` 开头且无摘要 → 归 `OBS`（只按退出码，不参与断言计数）。
- 环境前置特例：`code===2` 且输出含环境字样 → 归 `ENV`，不计失败（例如 deploy-preflight 缺 `--deploy`）。
- 源码注释里**已记录同类事故**（L95–L96）：b1 曾因格式未识别被误判 `NO-SUMMARY`，"属**回归器假警报**"，2026-09-27 才补上第 ④ 种格式。

### 14.2 那 3 个「失败套件」逐个查证：**全是解析假红，本体 exit=0**

| 被判失败项 | 本体 exit | 真实原因（已逐个查证） | 定性 |
|---|---|---|---|
| `test-learn-ac6-real-promotion-e2e.mjs` | **0** | 它的摘要原文是 **`AC6 真实端到端: 27 PASS / 0 NA / 0 FAIL`** —— 中间夹了 `0 NA`，runner 的 4 种格式**都不覆盖** `N PASS / M NA / K FAIL` 形状 → 正则不命中 → `NO-SUMMARY`。它自己有 27 条具名 `PASS  …` 行（如 `PASS  三阶段推进（证据引用真实产物…）`） | **假红**（格式不匹配） |
| `audit-merge-enforcement.mjs` | **0** | 它输出的是 **JSON 报告**（`"gitHead": "63bf5585c647"`, `"generatedAt": …`）——全文没有 `PASS/FAIL` 字样，4 种数字格式与 2 种裁决行**全部不命中** | **假红**（它本来就是"产出审计 JSON 的工具"，exit 0=正常产出） |
| `ac6-e2e-lock.mjs` | **0** | 0.2s、无输出（互斥锁助手），无摘要可言 | **假红**（结构上无摘要） |

⇒ **runner 的 exit 1 完全由 3 处格式不匹配造成，36 个真门全部 exit 0 且 0 FAIL。**
这是"空转假绿"（§7）的**镜像问题：聚合层假红**。任何账本若把 runner 的「失败套件 3 个」当作真实回归证据，结论会反向错。

### 14.3 三套口径并列（同一批套件，三个不同的数）

| 口径 | 通过数 | 覆盖 | 判定结果 |
|---|---|---|---|
| 我的逐行/自报对账（本报告 §3） | 逐行 1286 行自身 PASS（剔 19 外溢）/ 自报合计 1306 | 43 项 | 39 可红项全绿，0 断言失败 |
| 仓库 runner 自算 | **1240 PASS / 0 FAIL** | 只算 31 门槛套件 | 36/39 全绿，但**总判定 RED**（3 假红） |
| CI（ci-level1/2/3） | 无总数（只看每步 exit code） | 23 项 | 3 条死门恒绿（§7） |

**三者互不相等的原因是口径、覆盖面、判定规则各不相同——不是任何一方算错。** 这正是"对不上账"的根源：需要先统一口径（建议至少统一"摘要格式"与"哪些项算门"），数字才可比较。

### 14.4 给父代理的 3 条最小建议（只报告不改，本轮未动任何源码）

1. 让 runner 的 `sumRe` 增加 `N PASS / M NA / K FAIL` 形状（覆盖 ac6-real-promotion）→ 假红 −1。
2. 把"产出型工具"（`audit-merge-enforcement`，输出 JSON）与"助手"（`ac6-e2e-lock`）在 runner 内显式归类为 `tool/helper`（按退出码判定），而不是按门判定 → 假红 −2，runner 才能当红绿灯用。
3. 登记表 `kind` 字段应能表达 `evidence/probe/tool/helper`（现仅有 `gate` 等），否则 CI 与 runner 都无法区分"门"与"证据"，空转假绿会持续存在。
