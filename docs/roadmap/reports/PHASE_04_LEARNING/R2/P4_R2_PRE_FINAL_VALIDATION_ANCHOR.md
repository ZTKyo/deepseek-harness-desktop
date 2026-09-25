# P4_R2_PRE_FINAL_VALIDATION_ANCHOR

> 生成时间：2026-09-24（本次 FINAL VALIDATION 会话开始时 fresh 实测）
> 性质：**冻结当前 R2 实现状态的锚点**。本文件所有数值均为本次实测，非从旧报告转录。
> 用途：后续 Stage 的对照基线；任何"实现被改动"的判定以本锚点哈希为准。

---

## 1. 仓库身份（fresh verify）

| 项 | 值 |
|---|---|
| 仓库根（主工作树） | `C:\Users\Administrator\Desktop\sdeepseek harness\deepseek-harness-desktop` |
| 当前工作树 | `C:\Users\Administrator\Desktop\sdeepseek harness\_p4r2` |
| git-common-dir | `.../deepseek-harness-desktop/.git`（`_p4r2` 是 **worktree**，非独立仓库） |
| **branch** | **`p4-learning-r2-contract-first`** ✅ 符合合同的 R2 分支名，**未复用 R1 分支** |
| **HEAD** | **`5a206ae8dc10fe1f73aa20925b28f5fbb5d1702f`** |
| HEAD 提交 | `docs(status): correct P4 rollback runtime-state claim (config+runtime BOTH rolled back) (#95)` |
| HEAD 时间 | 2026-09-24 07:12:03 +0800 |
| **origin/main** | `5a206ae8dc10fe1f73aa20925b28f5fbb5d1702f` |
| local `main` | `00d28fcfcfc3aa3198a1b52a91c86870e99f66ca` |
| merge-base(HEAD, origin/main) | `5a206ae8…` |
| **ahead/behind vs origin/main** | **0 / 0** ⇒ **分支未领先 main；全部 R2 工作尚在工作树未提交状态** |

### 工作树拓扑
`git worktree list` 共 **17 个** worktree。与本任务相关的：
- `_p4r2` @ `5a206ae` = `[p4-learning-r2-contract-first]` ← **本任务工作树**
- `_p4r2-baseline-wt` @ `5a206ae` (detached) ← 基线对照锚
- `.worktree-p4-learning-r1` @ `2f68c45` = `[p4-learning-r1]`（R1，**本任务不得复用**）
- `_p4-hotfix-main` @ `00d28fc` = `[main]`

---

## 2. 工作树 diff（fresh verify）

`git status --porcelain` 共 **26 项**：**9 modified（tracked）+ 17 untracked**

### Modified（9）
```
 M plugins/learn-core.mjs
 M plugins/learn.mjs
 M tests/learn/redteam-r3-contamination.mjs
 M tests/learn/redteam-r3-isolation.mjs
 M tests/learn/run-ac7-regression.ps1
 M tests/learn/run-learn-real-e2e.mjs
 M tests/learn/run-r3-final-head-full.ps1
 M tests/learn/test-learn-core.mjs
 M tests/learn/test-learn-r3-fixes.mjs
```
diffstat：`9 files changed, 707 insertions(+), 145 deletions(-)`

### Untracked（17）
```
 STAGE85_AC5_REAL_SESSION_GAP_FIX_VERIFICATION.md
 _diag-s85.mjs                            ← 诊断脚本（Stage 9 需清理出 PR diff）
 _diag-s85-hunt-real-failures.mjs         ← 同上
 _diag-s85-real-shape.mjs                 ← 同上
 _diag-s85-red-green-topology.mjs         ← 同上（红绿对照证据脚本）
 _diag-s85-tool-events.mjs                ← 同上
 plugins/learn-candidate.mjs
 plugins/learn-gap-veto.mjs
 plugins/learn.mjs.ac5-fix-backup         ← 回退锚点（不得进入 PR）
 tests/learn/_real-session-harness.mjs
 tests/learn/run-learn-all-tests.mjs
 tests/learn/run-learn-real-gap-e2e.mjs
 tests/learn/test-learn-ac5-e2e.mjs
 tests/learn/test-learn-ac5-gap-veto.mjs
 tests/learn/test-learn-candidate.mjs
 tests/learn/test-learn-real-topology-tool-events.mjs
 tests/learn/test-learn-stage85-twins.mjs
```

---

## 3. learn 模块哈希（fresh verify，sha256）

| 文件 | sha256 | lines |
|---|---|---|
| `plugins/learn-core.mjs` | `bb8afe8950d2772b540a5ad392fae17a3acb46f9a878a56f1ba2c516dcd6074b` | 1093 |
| `plugins/learn.mjs` | `cb28faaa8b76f42bbdca7b8bf10090efc243aac976f52caee9338e3179e11181` | 704 |
| `plugins/learn-candidate.mjs` | `a06079828928ef1b…`（sha16） | 700 |
| `plugins/learn-gap-veto.mjs` | `7c4e3233119a0ac3…`（sha16） | 500 |

### tests/learn 哈希（sha16）
```
_real-session-harness.mjs                 351891fce930c885
redteam-r3-contamination.mjs              75aabf296bedf466
redteam-r3-injection-positions.mjs        06eebce1fba60d71
redteam-r3-isolation.mjs                  fe83b4d76233e7d6
redteam-r3-labels.mjs                     838fbabf9c19b117
redteam-r3-metrics.mjs                    a8d150f1ad3d874b
redteam-r3-probe.mjs                      f255fd7c0bb64d83
redteam-r3-quality.mjs                    e704d0918a9c12de
run-ac7-regression.ps1                    1567a155b9cc9ae3
run-learn-all-tests.mjs                   f9dadafc72a87899
run-learn-real-e2e.mjs                    17ea707b6520ac0b
run-learn-real-gap-e2e.mjs                eedfcdc54f509b66
run-r3-final-head-full.ps1                67bd4b91c8dc61ab
test-learn-ac5-e2e.mjs                    b13c3adc7ece8935
test-learn-ac5-gap-veto.mjs               6638062b5b995c97
test-learn-candidate.mjs                  85ed7c3d51d298a9
test-learn-core.mjs                       38ccd1ef834fca63
test-learn-plugin-contract.mjs            9e7da89725b26d85
test-learn-r3-fixes.mjs                   01fb09a6a31bfbee
test-learn-r3-hardening.mjs               355bb175f9e4a4db
test-learn-r3-secrets.mjs                 331343f59c78e600
test-learn-real-topology-tool-events.mjs  e9bbd0a29fb1b712
test-learn-stage85-twins.mjs              61ca6cf53a365e82
```

---

## 4. DSH 运行时（fresh verify）

| 项 | 值 |
|---|---|
| node | `v22.22.2` |
| 服务端口 | `127.0.0.1:3080`，health = **HTTP 200** |
| 服务日志 | `%LOCALAPPDATA%\DSHHarness\logs\dsh-server-3080.log`（**289 MB**） |
| 最近一次启动 | `===== dsh server runner start 2026-09-24T12:53:16.275Z (port 3080, launcher 11024) =====`（L1650879） |
| 启动次数（日志尾部区间） | 最近 6 次：12:01:53 / 12:18:43 / 12:25:28 / 12:39:38 / 12:46:34 / **12:53:16** |
| 运行时观察 | 日志尾部为高频 V8 Scavenge（heap ≈ 2.13–2.29 GB，多次 `allocation failure`），属**运行中服务的既有内存压力**，非 R2 造成（R2 未加载）。**仅记录，不在本任务处理**（范围外）。 |

---

## 5. 🔴 PRODUCTION P4 R2 激活状态（红线检查，fresh verify，穷尽 5 条加载路径）

### 结论：**`P4_PRODUCTION_ACTIVATED = NO` —— 未注册、未加载**，无需停止任务。

### 但发现**历史遗留物**，必须记录（不处理）：

| 事实 | 证据 |
|---|---|
| profile 目录**存在** `learn.mjs` / `learn-core.mjs` | `~/.dsh/profiles/web/learn.mjs` (22655 B, mtime 2026-09-22 22:46:39)、`learn-core.mjs` (47202 B, mtime 2026-09-21 23:48:55) |
| 它们是**旧版（pre-R2）**，不是 R2 代码 | profile `learn.mjs` sha256=`8b183e37…`、`learn-core.mjs` sha256=`a66ac2d8…`；与 `_p4r2` 工作树的 R2 版本 `cb28faaa…` / `bb8afe89…` **均不相等** |
| 它们**不含任何 R2 特征** | 对 `capabilityDeficiency|learn-gap-veto|SEARCH_FAILED|normalizedSignature` 匹配数 = **0 / 0** |
| 历史上加载**失败**过 | 日志 L1169552–1169569：`failed to apply loader entry learn (./learn.mjs): cannot get property "tools" without inject`（@ `profile/learn.mjs:252`） |
| 该失败是**历史**，与最近 6 次启动无关 | 全部 54 条 learn 日志位于 **L1167795–L1169569**；最近 6 次启动位于 **L1636721 – L1650879**（均晚于 learn 日志）⇒ 最近启动 **0** 条 learn 记录 |

### 五条加载路径穷尽核查（全部 = 0）
1. `~/.dsh/profiles/web/cordis.patch.yml`（唯一 patch 层，插件以显式 `insert: [{id, name}]` 注册，**非目录扫描**）：`learn` 匹配 = **0**
2. `~/.dsh/settings.yaml`：`learn` 匹配 = **0**
3. `~/.dsh` 下全部 yml/yaml（**含隐藏目录** `-Force`，含 `.agent-presets`）：**无任何文件注册 learn**
4. `~/.dsh/.agent-presets/autonomous/`（autonomous 预设立插件树，含 `agent.cordis.yml` 及 6 个备份）：逐文件 `learn` 匹配 = **0**
5. `tools/install-plugin.mjs` 管理清单：`learn` 匹配 = **0**；三个 profile（web/headless/experimental）的 `cordis.patch.yml` 均 = **0**

> **自我保护记录**：路径 3 首次检查时用了 `Get-ChildItem -Recurse` 而**漏加 `-Force`**，会静默跳过隐藏目录 `.agent-presets`。已重查并修正。这类"检查自身有洞"的失误必须显式留痕（参照 KNOWN_ISSUES 中"验证脚本自身出错"的教训）。

### 处置
按「范围外只报告不执行」：**不删除** profile 内的旧 learn 文件（未注册、无危害、删除属越权），仅登记为遗留物。

---

## 6. 复核义务

后续 Stage 若修改 `plugins/learn-*.mjs` 或 `tests/learn/*`，必须回写本锚点对照表并说明差异；
若哈希与本节不符且非本任务改动 ⇒ 视为**外部改动**，参照此锚点判定归属。
