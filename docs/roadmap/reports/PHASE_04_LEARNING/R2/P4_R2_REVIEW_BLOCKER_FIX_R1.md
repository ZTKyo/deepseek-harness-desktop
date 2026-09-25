# P4 R2 外部复核缺口修复报告（R1）

- 日期：2026-09-25
- 仓库：`C:\Users\Administrator\Desktop\sdeepseek harness\_p4r2`
- 分支 / HEAD：`p4-learning-r2-contract-first` / `3a9f30f`（修复未提交时的工作树）
- 候选文件（提交前 sha256 前 16 位）
  - `plugins/learn-core.mjs` = `06ff37ccc3dc3901`
  - `plugins/learn.mjs` = `ed39accec1b5a671`
  - `tests/learn/test-learn-core.mjs` = `c4becc6d620489b2`
  - `tests/learn/test-learn-r2-b1-approval-gate.mjs` = `2b6b576b71204be2`
  - `tests/learn/test-learn-r2-b2-bounds.mjs` = `619d4e09e70e3da3`

## 0. 顶部声明（三项，均为当前事实）

| 声明 | 取值 | 依据 |
|---|---|---|
| `P4_PRODUCTION_ACTIVATED` | **NO** | 生产 home 无任何 `learn` 配置项（全部 yml 0 匹配）、无 learn 工具注册、无 learn stateDir；见 §8 |
| `OFFICIAL_DSH_UPGRADE` | **NO** | 本次未改动 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh`、未升级/替换官方包；本报告全部证据来自仓库内测试与隔离 DSH_HOME |
| `PHASE_05_STARTED` | **NO** | 仅修 R2 复核缺口 + 回归，未开始 P5 任何工作 |

## 1. 结论摘要

外部复核的两项缺口已修复，且**修复点具备变异敏感度**（回滚修复点即测试变红）：

| 缺口 | 修复 | 攻击/压力前 | 攻击/压力后 | 变异证明 |
|---|---|---|---|---|
| **BLOCKER-1** 未审批经验可进入跨会话全局库（AC4 授权绕过） | 人工审批成为**唯一**发布授权门 `canPublish()` | 同一外部探针：未审批条目 `publication=published`、全局库落盘 1 条、另一会话可召回 | 未审批条目 `publication=denied:not_human_approved:VERIFIED_EXPERIENCE`、全局库条目数 **0** | MUT-17（`canPublish` 恒 true）→ B1 门套件 **12 PASS / 7 FAIL**（含"授权被绕过""跨会话泄露"类断言变红），还原后逐字节等于 pristine |
| **BLOCKER-2** 会话派生状态无界增长 | 磁盘保留策略（数量 + TTL）+ 进程内 per-session 结构 LRU 上限 | 320 次真实写入：文件数 322（未收敛，随会话数线性增长）；内存 `stores=322`、`gapWatermarks=82` 超上限 | 同一压力：文件数峰值 **207**、末值 **206**、显式 prune 后 **200**（上限 200）；内存 `stores/watermarks/pendingFailures/activeSessions/gapWatermarks` 全部 **≤64** | MUT-18a（关闭 prune）→ 文件 322 > 215、A 组 3 条红；MUT-18b（关闭 evictLRU）→ `stores=322`、`gapWatermarks=82`，M 组 2 条红；两次均逐字节还原 |

数据安全（B2 的"清理不得误伤"硬约束）全部成立：Global Store（Layer B）逐字节未变、条目数不变、清理后仍可发布与跨会话召回；Global Experience 的 `sourceEventSeqs` 四个溯源锚点在官方原始会话里全部可解析，清理后仍能做**确定性重新验证**。

## 2. BLOCKER-1：人工审批授权门

### 2.1 攻击前（外部独立证据，未改动）

- 证据：`_p4r2-review-external/evidence/A-AC4-approval-bypass.txt`（外部复核方原件，`_p4r2-review-external/**` 本轮未做任何修改）
- 攻击：真实会话驱动 → 自动候选 → 确定性验证 PASS（`VERIFIED_EXPERIENCE`）→ **不审批** → 直接发布
- 攻击前结果：发布成功（`publication=published`）、跨会话全局库落盘该条目、另一会话可召回到它 ⇒ 违反"人工审批是唯一可召回途径"

### 2.2 实现（修复点）

- 唯一授权判定：`canPublish(exp)` —— `plugins/learn-core.mjs:1872`
  - `exp.state !== 'APPROVED'` ⇒ 直接拒（`learn-core.mjs:1852` 注释"★ 人工授权是唯一出口"；`:1880` 返回 `not_human_approved:<state>`）
  - 同时校验收敛于此：验证状态须 VERIFIED、证据须机器可核、密钥扫描、去重幂等、条目字段有界
- 唯一调用点：`publishToGlobal()` —— `plugins/learn-core.mjs:1940`，其 `:1944` 是 `canPublish` 的**唯一**调用处
- 唯一审批赋值点：`approve()` —— `plugins/learn-core.mjs:484`，`:496` 是 `state:'APPROVED'` 的**唯一**赋值处（`canTransition` + 审批人 + 非空且不含密钥的审批证据）
- 唯一落盘路径：`commitGlobal()` —— `plugins/learn.mjs:601`，其 `:611`（遥测）/`:623`（发布结果）调用，`saveGlobalStore()` 仅被它调用 ⇒ 全局库只有一条写入链路

### 2.3 攻击后（本轮真命令输出）

命令（外部探针只读、不写文件，已验证探针内 0 处 `writeFileSync/mkdirSync/appendFileSync`）：

```
node _p4r2-review-external\probes\attack-AC4-approval-bypass.mjs
```

输出（原始文件 `_p4r2/_p4r2-evidence/b1-exploit-after.txt`）：

```
PASS  A0-auto-propose :: 自动候选 id=exp-36981768 state=PROPOSED approvals=[] evidence={...}
PASS  A1-verify-无审批 :: verify: ok=true state=VERIFIED_EXPERIENCE vstatus=VERIFIED method=session_outcome
        publication=denied:not_human_approved:VERIFIED_EXPERIENCE error=-
FAIL  A2-global-store-populated :: 全局库文件存在=true 条目数=0
PASS  A5-explicit-propose-cannot-verify :: verify: ok=false error=invalid_or_non_machine_checkable_evidence
        publication=not_applicable
```

判读：探针的 A2 是"攻击是否成功"的断言（要求全局库被写入），它 **FAIL 即攻击失败**；A1 明确给出 `publication=denied:not_human_approved:VERIFIED_EXPERIENCE`，即门在**发布动作之前**就切断了攻击链。

### 2.4 变异证明（回滚修复点 ⇒ 必须变红）

工具与产物：`_p4r2-evidence/mutations/mutation-proof-17-b1.mjs` → `_p4r2-evidence/B1-mutation-proof-17-20260925.txt`

```
MUT-17 把 canPublish() 改成恒 true（关掉人工审批授权门）
  变异后 sha256 = 364268d1d2628385ed396cd4fb1f7cd241adb26ccfb95c87d5ea996cdf67e579
  测试 exit code = 1 ；RESULT: 12 PASS / 7 FAIL
  · FAIL A2 ★ 未审批 ⇒ publication 必须是 denied:not_human_approved —— 实际 publication=published
  · FAIL A3 ★ 全局库不落盘该条目 —— 实际磁盘全局库条目数=1
  · FAIL A4 ★ 另一会话召回不到它 —— 实际会话 B 召回到未审批条目（跨会话泄露）
  · FAIL A5 被拒须留痕 GLOBAL_PUBLISH_DENIED —— 实际 telemetry kinds=["GLOBAL_PUBLISHED"]
  · FAIL B2 / C1 / D2（审批来源完整性、旧格式条目闸门、晋升路径）
  还原后 sha256 = 06ff37ccc3dc3901… ✔ 逐字节等于 pristine
总判定：PASS —— 变异被捕获，文件已逐字节还原
```

### 2.5 第二 authority 检查（本次未新增任何第二条链路）

- `canPublish` 调用点：1 处（`learn-core.mjs:1944`，在 `publishToGlobal` 内）；`learn.mjs:1292` 仅为注释引用
- `publishToGlobal` 调用点：1 处（`learn.mjs:621`）
- `commitGlobal` 调用点：2 处（`learn.mjs:611` 遥测、`:623` 发布结果），二者共用同一 `saveGlobalStore`（`learn.mjs:589`）
- `state:'APPROVED'` 赋值点：1 处（`learn-core.mjs:496`，`approve()` 内）
- ⇒ 链路唯一：`approve()`（人工）→ 发布请求 → `canPublish()` → `publishToGlobal()` → `commitGlobal()` → `saveGlobalStore()`，无第二条发布/审批旁路。

## 3. BLOCKER-2：会话派生状态有界 + 清理安全

### 3.1 增长前（无界）

- MUT-18a（关闭 prune）同一压力下：**文件数 = 322**（无平台期，随会话数线性增长）
- MUT-18b（关闭内存淘汰）同一压力下：`stores = 322`、`gapWatermarks = 82`（均超上限 64）
- 修复前仓库行为即上述无界形态：每次写入按会话落一个文件、进程内 per-session 结构随会话数增长。

### 3.2 保留策略与取值依据

| 参数 | 取值 | 位置 | 依据 |
|---|---|---|---|
| `sessionStoreMaxFiles` | 200 | `plugins/learn.mjs:114`（env `LEARN_SESSION_STORE_MAX_FILES`，`:153` 校验为正整数） | 磁盘会话文件数量上限；与"每会话一文件"落盘口径配套 |
| `sessionStoreTtlDays` | 30 | `plugins/learn.mjs:115`（env `LEARN_SESSION_STORE_TTL_DAYS`，`:154`） | TTL 兜底：非活跃 + 超期即清（`:394` `ttlMs = ttlDays*86400000`） |
| `MAX_IN_MEMORY_SESSIONS` | 64 | `plugins/learn.mjs:181` | **沿用仓库既有口径**：同文件 §15 能力缺口路径的 `MAX_TRACKED_SESSIONS = 64`（`:793` 已对齐），不新造第二套数字 |
| 清理节流 | 每 16 次写入扫一次目录 | `plugins/learn.mjs:339` `PRUNE_EVERY_N_WRITES = 16` | 避免每次写入都 `readdir`，把清理成本摊薄为 O(1) 摊销 |
| 活跃保护 | 活跃会话恒保留 | `plugins/learn.mjs:369`（规则②：active 全保留，其余按 mtime 新→旧保留至上限） | 清理不得删掉正在写的会话 |
| 上限口径暴露 | `_memoryLimit()` / `retentionPolicy()` | `plugins/learn.mjs:1415` / `:1417` | 供测试与运行时可读到真实口径（非硬编码断言） |

### 3.3 磁盘后（实测数字）

命令：`node tests/learn/test-learn-r2-b2-bounds.mjs`（原始输出 `_p4r2/_p4r2-evidence/b2-test-output.txt`，`RESULT: 42 PASS / 0 FAIL`）

```
INFO 320 次真实写入期间：最大文件数=207 末值=206（上限 200 + 节流余量 15 = 215）
INFO 平台期判定：末值 206 ≤ 上界 215
INFO prune report: scanned=206 removed=6 kept=200
INFO 清理后文件数=200
PASS A0 ★ 反空断言对照：上限之前文件数确实在增长（否则"有界"可能是"根本没落盘"）
PASS A1 ★ 节流路径下实测最大文件数 ≤ maxFiles + 节流余量（有界，O(1) 而非 O(n)）
PASS A2 ★ 写入数达 1.6× 上限后曲线进入平台期（末值 ≈ 上限，不随会话数增长）
PASS A4 ★ 显式 prune 后实测文件数 ≤ maxFiles
PASS A5 清理只发生在 stateDir 内：Global Store 文件被显式排除（不在 scanned 里）
```

- TTL 组（伪造 mtime，用真实 `ttlDays`）：过期且非活跃 → 被清；过期但活跃 → 存活；未过期 → 不误清（B0/B1/B2 全 PASS，成对对照非空断言）
- 活跃保护 C 组："同条件一对"（活跃 vs 非活跃，均最旧、均 TTL 过期）：活跃者存活、非活跃者被清（C1/C2 PASS，`清理前=206 removed=6 清理后=200 活跃文件存活=true`）

### 3.4 内存后（实测数字）

```
INFO footprint = {"limit":64,"stores":64,"watermarks":64,"pendingFailures":64,"sessionCache":8,
                  "activeSessions":64,"gapWatermarks":64,"gapObservedKeys":0,"gapVetoedKeys":0,"candidateStores":0}
PASS M1 ★ stores / watermarks / pendingFailures / activeSessions ≤ 64（真实 Map/Set 尺寸）
PASS M2 ★ 缺口水位 / 观察面缓存有界（gapWatermarks / sessionCache）
PASS M4 ★ 压力确实建立了（否则"有界"可能是"根本没长"的假通过）
```

- 淘汰语义严格性（V 组）：超上限时 `SID_KEEP` 的**内存态**被淘汰（`_watermarkFor` 由 `23935` → `undefined`，watermarks=64），但**磁盘文件仍在**、其中 VERIFIED 经验无损、`getStore` 惰性重载后不丢；未审批的 VERIFIED 经验在淘汰/清理后**始终没有**进入 Layer B（V1–V4 PASS）
- 重载后仍成立（R 组）：装载全新实例后**立即** `stores=0 watermarks=0`（磁盘有 200 个会话文件）⇒ 惰性载入，不是启动即全量灌入；驱动 1 个会话后 `stores=0 watermarks=1 sessionCache=1`（远小于磁盘文件数）；对磁盘上确实存在的历史会话可惰性读回且逐条一致（`内存=1 磁盘=1`）

### 3.5 数据保留（清理不得误伤）

```
INFO 溯源锚点 [10459,10607,10838,11128] 均可解析到官方 event
PASS D1 ★ Global Store 文件在（多轮 TTL/数量清理后仍存在）
PASS D2 ★ Global Store 条目数不变、仍可发布、审批来源完整
PASS D3 ★ Global Store 逐字节未变（清理没有"顺手重写"全球库）
PASS D4 ★ 清理后跨会话仍可召回该经验（复用能力未被清理破坏）
PASS E1 ★ 溯源锚点 sourceEventSeqs 全部指向官方会话中真实存在的 event
PASS E2 ★ 清理后仍可对 origin 会话做确定性重新验证（从官方原始会话独立复算，PASS）
PASS E3 learn_verify 是会话作用域的（Global 条目不在新会话本地库 ⇒ not_found；设计边界不是断链）
PASS V4 ★ 未审批的 VERIFIED 经验始终未进入 Layer B（淘汰/清理都不得让它"顺带上位"）
```

### 3.6 变异证明（回滚修复点 ⇒ 必须变红）

产物：`_p4r2-evidence/B2-mutation-proof-20260925.txt`

```
MUT-18a 关闭磁盘保留策略（pruneSessionStore 立即返回 no-op）
  exit=1 ；36 PASS / 6 FAIL（期望组 A 转 RED 3 条）
  · FAIL A1 实测最大=322 > 215 ｜ FAIL A2 末值=322 > 215 ⇒ 未收敛 ｜ FAIL A4 文件数=322 > 200
  还原后 sha256 = ed39accec1b5a671… ✔ 逐字节等于 pristine
MUT-18b 关闭内存淘汰（evictLRU 立即返回 0）
  exit=1 ；38 PASS / 4 FAIL（期望组 M 转 RED 2 条）
  · FAIL M1 stores=322 > 64 ｜ FAIL M2 gapWatermarks=82 > 64
  还原后 sha256 = ed39accec1b5a671… ✔ 逐字节等于 pristine
总判定：PASS —— 两处单点破坏均被测试捕获，且线下文件已逐字节还原
```

## 4. 回归（逐项命令 + 结果）

### 4.1 本次缺口直接相关

| 项 | 命令（cwd=`_p4r2`） | 结果 |
|---|---|---|
| learn 全量测试（23 个套件） | `node tests/learn/run-learn-all-tests.mjs` | **907 PASS / 0 FAIL**（23/23 全绿） |
| learn 契约场景 | `node tests/learn/run-learn-contract-scenarios.mjs` | 35 PASS / 0 FAIL |
| 契约场景（39 条） | `node tests/learn/test-learn-contract-scenarios.mjs` | PASS |
| AC5 真实 E2E | `node tests/learn/run-learn-real-e2e.mjs` | 59 PASS / 0 FAIL |
| AC5 真缺口 E2E | `node tests/learn/run-learn-real-gap-e2e.mjs` | 20 PASS / 0 FAIL |
| R2 真实拓扑 | `node tests/learn/test-learn-real-topology-tool-events.mjs` | 22 PASS / 0 FAIL |
| B1 授权门 | `node tests/learn/test-learn-r2-b1-approval-gate.mjs` | 19 PASS / 0 FAIL |
| B2 有界与清理 | `node tests/learn/test-learn-r2-b2-bounds.mjs` | 42 PASS / 0 FAIL |
| learn 核心 | `node tests/learn/test-learn-core.mjs` | 417 PASS / 0 FAIL |
| 候选/阶段 6-7 | `node tests/learn/test-learn-candidate.mjs` | 39 PASS / 0 FAIL |
| 宿主契约门 | `node tests/learn/test-learn-plugin-contract.mjs` | PASS |
| 85 双胞胎 | `node tests/learn/test-learn-stage85-twins.mjs` | 22 PASS / 0 FAIL |
| 缺口水位否决 | `node tests/learn/test-learn-ac5-gap-veto.mjs` | 44 PASS / 0 FAIL |
| R3 修复回归 | `node tests/learn/test-learn-r3-fixes.mjs` | 30 PASS / 0 FAIL |
| R3 密钥脱敏 | `node tests/learn/test-learn-r3-secrets.mjs` | 62 PASS / 0 FAIL |

### 4.2 逐阶段被点名复核项

| 阶段 | 命令 | 结果 |
|---|---|---|
| P2.5 上下文记忆 | `node tests/context-memory/verify-context-memory.mjs` | 72 PASS / 0 FAIL |
| P2.6 R1.1 托管直连配额 | `node tests/continuity/verify-p26-r1-1-managed-direct-quota.mjs` | 15 pass / 0 fail |
| P2.6 R2 commandcode 配额 | `node tests/continuity/verify-p26-r2-commandcode-quota.mjs` | 9 pass / 0 fail |
| P2.6 R3 重试策略 | `node tests/continuity/verify-p26-r3-retry-policy.mjs` | **18 pass / 7 FAIL —— 既有环境漂移，与本次修改无关，见 §4.3** |
| P2.6 R3-A1 官方重试零 | `node tests/continuity/verify-p26-r3-a1-official-retry-zero.mjs` | 16 pass / 0 fail |
| Supervisor 变异状态 | `node tests/supervisor/test-supervisor-mutation-state.mjs` | 19 passed / 0 failed |
| Supervisor CI E2E | `node tests/supervisor/run-supervisor-ci-e2e.mjs` | **ALL PHASES PASS**（phase1 40/0、phase2 19/0、phase3 3/0；SKIP 项为 ci 模式设计内，history 相关断言在 `SB_MODE=full` 强制） |
| P3 验证器核心 | `node tests/autonomy/test-autonomy-state-core.mjs` | 104 PASS / 0 FAIL |
| P3 验证器（已部署 EC） | `node tests/autonomy/test-ec-autonomy-deployed.mjs` | 67 PASS / 0 FAIL |
| Router 精确模型保留 | `node tests/router/test-exact-model-preservation.mjs` | 9 passed / 0 failed |
| Router 原生多模态 | `node tests/router/test-deepseek-native-multimodal.mjs` | 25 passed / 0 failed |
| EC 路由桥 | `node tests/reliability/test-ec-router-bridge.mjs` | PASSED |
| EC（RH2 / R5 addendum） | `node tests/reliability/test-rh2-ec.mjs`、`test-r5-addendum-ec.mjs` | PASSED |
| EC 容量（解析器 / 运行时适配） | `node tests/reliability/test-capacity-resolver.mjs`、`test-runtime-capacity-adapter.mjs` | PASSED |
| 完成真相 / 恢复延迟 | `node tests/reliability/test-completion-truth.mjs`、`test-resume-defer.mjs` | PASSED |
| YAML 校验 | `node tests/reliability/yaml-parse-check.mjs` | YAML CHECK: 6 ok, 0 failed |
| 密钥扫描（L1） | CI 密钥扫描检查 | **SECRET SCAN PASSED**（无泄漏） |
| 密钥扫描夹具 | `node tests/reliability/test-secret-scan-fixtures.mjs` | PASSED |

### 4.3 P2.6「重试策略」7 条失败 —— 既有环境漂移（非本次引入，已做差分证明）

失败清单（全部与 settings.yaml 的 provider 集合有关）：

```
FAIL settings.yaml loads + llm-pi-ai.providers present  providers=5
FAIL R3-1 opencode / opencode-qwen / opencode-free / agentrouter-openai: retryPolicy present MISSING
FAIL R3-2 all target retryPolicies pass RetryPolicySchema (RATE_LIMIT-free)
FAIL R3-3 bai: untouched (no explicit retryPolicy -> official default incl. RATE_LIMIT)  mode=normal
```

差分证明（同一套件、同一 `~/.dsh/settings.yaml`、**pristine HEAD 代码**）：

```
cd "_p4r2-baseline-wt" && node tests/continuity/verify-p26-r3-retry-policy.mjs
→ 18 pass, 7 fail（与在修复后代码上完全一致的 7 条）
```

补充旁证：该套件全文 **0 处**引用 `learn`（`Select-String … -Pattern "learn"` 计数 = 0），且失败项只读 `~/.dsh/settings.yaml` 里的 provider 配置 —— 与本次 learn 修复不存在调用关系。⇒ 定性为**既有环境漂移（PRE-EXISTING）**，按指令"外部模型问题/drift 只记录不修"未做处理。

### 4.4 跨阶段回归（29 套件）

命令：`& tests\learn\run-ac7-regression.ps1`（原始输出 `_p4r2/_p4r2-evidence/cross-stage-ac7-sweep.txt`）

```
==== P4 AC7 REGRESSION SUMMARY ====
GREEN=28  RED=1  MISSING=0  TOTAL=29  totalFAILlines=2
--- non-green detail ---
  [exit=1] tests\install-plugin\verify-install-plugin.mjs   结果: FAIL（13 通过，2 失败）
```

唯一的 RED 是 `install-plugin` 的 2 条失败，与 R1 报告中记录的既有失败**同数量同形态**（13 通过 / 2 失败），非本次引入，按指令未做 drift 修复。

## 5. ERRATA：外部探针 A3 字段误判（登记，未改外部文件）

- 现象：`_p4r2-review-external/probes/attack-AC4-approval-bypass.mjs` 的 A3/A4 分支依赖一个名为 `approvals` 的字段（其输出中可见 `approvals=[]`）。
- 事实：契约中**不存在** `approvals` 字段——审批来源是**扁平三字段** `approvedBy` / `approvalEvidence` / `approvedAt`（`learn-core.mjs:494-500` 写入；`:333`/`:344`/`:571`/`:695` 读取校验）。
- 后果：该探针 A3（"审批被绕过"的正向断言）**永远无法变绿**，因为它的判据字段恒为空数组；修复后探针真正生效的阻断证据是 A1 的 `publication=denied:not_human_approved:VERIFIED_EXPERIENCE` 与 A2 的 `条目数=0`（攻击未成功）。
- 处置：**只登记不改**——`_p4r2-review-external/**` 属外部复核方证据，本轮未做任何修改（本轮只在只读方式下运行了探针）。仓库侧以 `tests/learn/test-learn-r2-b1-approval-gate.mjs`（B2 断言按真实扁平三字段校验"落盘条目带完整人工审批来源 + APPROVED + VERIFIED"）覆盖同一语义。

## 6. 未覆盖范围（诚实声明）

以下三点**本轮没有覆盖**，不作为"已验证"：

1. **真实模型凭据下的 supervisor 全链路**：`run-supervisor-ci-e2e.mjs` 在 ci 模式运行，7 条依赖真实会话历史的断言为 SKIP（marker A1/A2/B1 的"真的只发一次提示"），需 `SB_MODE=full` + 真实模型凭据才能执行。
2. **长时运行的真实增长曲线**：B2 的 320 次写入/80 会话压力是**分钟级合成压力**（真实工具 + 真实钩子 + 真实 stateDir），不是数天量级的真实使用曲线；平台期结论是"在 1.6× 上限写入规模上成立"，不是"任意规模下已证明"。
3. **`sessionCache` / `candidateStores` 等其余映射的独立打满**：M3 明确标注"本组未驱动到上限"——这些映射与 `stores/watermarks` 共用同一 `evictLRU` 调用点与同一上限常量（`:221`/`:228`/`:233`/`:808`/`:881`/`:900`/`:926`），因此由 M1/M2 的变异证明间接覆盖，**未做独立打满实验**。
4. P2.6「重试策略」套件的 7 条既有失败保持原状（§4.3），未修复。

## 7. 生产未动核对（P4 预激活事实）

| 核对项 | 结果 |
|---|---|
| 生产 home（`C:\Users\Administrator\.dsh`）全部 yml/yaml 是否含 `learn` | **0 匹配** ⇒ 无 learn 插件注册项 |
| 生产 `settings.yaml` 是否含 `learn` | 0 匹配 |
| 生产 `profiles/web/cordis.patch.yml` 是否注册 learn | 0 匹配（已注册项为 notion MCP / ask-telegram / computer-use / vision-bridge / secret-gate(+client) 等） |
| 是否存在 learn stateDir（`~/.dsh/learn`、`~/.dsh/storages/learn`） | 均 **False** ⇒ 生产从未运行过 learn |
| 宿主工具面是否有 `learn_*` 工具 | 无 ⇒ 插件未加载 |
| 服务日志中 learn 痕迹 | 有 **历史**报错（`failed to apply loader entry learn (./learn.mjs): cannot get property "tools" without inject`），但最后一次出现在日志第 1,169,566 行 / 共 1,986,021 行（≈59% 位置），**不在当前运行段**；当前尾部为正常运行日志 |
| 生产 home 中的 learn 文件 | 存在**陈旧拷贝**：`profiles/web/learn.mjs`（22,655B，2026-09-22）、`profiles/web/learn-core.mjs`（47,202B，2026-09-21）+ 一份 `_backup-cordis.patch-learn-20260922-060153.yml`；因无注册项 ⇒ **惰性文件，未加载** |

⇒ `P4_PRODUCTION_ACTIVATED = NO` 成立（**注意**：生产 home 留有 09-21/22 的陈旧拷贝与一次历史加载失败记录，属 P4 激活时的清理事项，按"非请求范围内只报告不执行"未做处理；陈旧拷贝的字节与本次修复后的候选版本也不一致，激活时应以仓库候选为准重新投放）。

## 8. 变更与回退

- 修改文件：`plugins/learn-core.mjs`、`plugins/learn.mjs`、`tests/learn/test-learn-core.mjs`
- 新增文件：`tests/learn/test-learn-r2-b1-approval-gate.mjs`、`tests/learn/test-learn-r2-b2-bounds.mjs`
- 证据目录（未纳入生产）：`_p4r2/_p4r2-evidence/**`
- 回退：本报告对应的提交为单次提交；`git revert <commit>` 即可回到 `3a9f30f` 行为。变异证明使用的 pristine 副本（`_p4r2-evidence/mutations/learn.mjs.pristine`、`learn-core.mjs.pristine`）与候选文件逐字节一致（sha256 已在校验脚本中比对通过），可作为独立还原源。
- 未改动：`_p4r2-review-external/**`（外部复核方证据，全程只读）、`~/.dsh/**`（生产配置与服务数据）。

## 9. 证据文件索引

| 文件 | 内容 |
|---|---|
| `_p4r2/_p4r2-evidence/b1-exploit-after.txt` | BLOCKER-1 攻击后真命令输出（本轮） |
| `_p4r2/_p4r2-evidence/B1-mutation-proof-17-20260925.txt` | MUT-17 变异证明（缺陷注入 → 变红 → 逐字节还原） |
| `_p4r2/_p4r2-evidence/B1-approval-gate-differential-20260925.txt` | 授权门前置差分（基线 vs 修复） |
| `_p4r2/_p4r2-evidence/b2-test-output.txt` | B2 完整输出（42 PASS，含全部实测数字） |
| `_p4r2/_p4r2-evidence/B2-mutation-proof-20260925.txt` | MUT-18a/18b 变异证明 |
| `_p4r2/_p4r2-evidence/mutations/mutation-proof-17-b1.mjs` | B1 变异脚本（可重复运行） |
| `_p4r2/_p4r2-evidence/mutations/mutation-proof-b2.mjs` | B2 变异脚本（可重复运行） |
| `_p4r2/_p4r2-evidence/probe-disk-slack.mjs` | 磁盘节流余量探针 |
| `_p4r2/_p4r2-evidence/probe-gap-pressure.mjs` | 缺口水位压力探针 |
| `_p4r2/_p4r2-evidence/cross-stage-ac7-sweep.txt` | 29 套件跨阶段回归汇总 |
| `_p4r2/_p4r2-evidence/cross-stage-supervisor-e2e.txt` | Supervisor CI E2E 三阶段原始输出 |
| `_p4r2/_p4r2-evidence/learn-full-regression.txt` | learn 全量测试（23/23）输出 |
| `_p4r2-review-external/evidence/A-AC4-approval-bypass.txt` | 外部复核方原始攻击证据（未改动） |
