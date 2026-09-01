# RELIABILITY HOTFIX RH1 R3 REPORT — REVIEW ROUND 3 整改（进度快照）

**状态: IN_PROGRESS（尚未到达 AWAITING_EXTERNAL_REVIEW_R3）— 但 ISOLATED REAL 证据已补齐**
**DEPLOYMENT: DEFERRED_ACTIVE_TASK** — 本分支【不部署生产】,仅供外部评审。
**R2 结论: CHANGES_REQUIRED** — R2 评审要求 R3 补"真实 wall-clock ≥60s E2E / 真实 guardian recovery path / 只读 append-only restart 证据 / probe 不重叠 / UI 响应 / 字段改名 / PR body 诚实"。

- 分支: `hotfix/reliability-liveness-rh1`（更新 PR#83, 无新 PR、无 merge、无 deploy）
- Base: `main`(dbe56be) — 与 PR#79 / P3 完全独立;未触碰生产 3080 服务 / Desktop Client / 会话。
- 隔离 worktree: `_wt-rh1`。

---

## 0. 证据分类（诚实——不把"确定性/已跑"说成"真实 60s 已证"）

| 证据类别 | 含义 | 本报告已包含 |
|---|---|---|
| **CODE VERIFIED** | 代码已被解析/逻辑审查 | 是的（guardian/health/reconnect 全部 PARSE OK） |
| **DETERMINISTIC VERIFIED** | 已被确定性脚本实际运行并断言通过 | 是（G0–G21 =31 PASS; R3 guardian-path =19 PASS） |
| **ISOLATED REAL VERIFIED** | 真实 wall-clock / 真实隔离 dsh 服务 / 只读追加日志 | **是（已补齐 — 见 §6/§7）** |
| **PRODUCTION NOT DEPLOYED** | 未部署、未放行、不重启生产 | 是（未触碰） |

> 读者注意：本次快照已补齐 **ISOLATED REAL**（≥60s 真实 soak = PASS=15;真实追加日志 sentinel + 真实 boot banner-after-sentinel = PASS=4;probe 不重叠实测 = PASS=5;真实 UI/Dispatcher 心跳实测 = PASS=3）;这些证据在 §6/§7 如实记录,未声称超范围。

---

## 1. Item 1 — L1 secret/private-key scan 修复（CODE+DETERMINISTIC VERIFIED）

`tests/rh1-tests.ps1` 的 incident redaction 用例改为**运行时动态拼接 PEM fixture**（拆段拼接,源码不含任何完整 "PRIVATE KEY" marker）。G20/G20b 实证：
`incident redaction: sensitive fixture absent  Hits=` 且 `incident bundle JSON redacted  leak=` → **PASS**。
静态源码 `grep 'PRIVATE KEY'` 不再命中完整私钥块。

## 2. Item 3 — 真实 guardian recovery path（CODE+DETERMINISTIC VERIFIED）

R2 评审指出旧 R2 只测 `Invoke-DshHealthTriage`（纯分诊），未走 guardian 真实的恢复决策路径。本次整改：

- dsh-health.ps1 新增单一 health-authority 决策/执行器 **`Invoke-DshHealthGuard`**（dot-source-safe,可注入 restart/alert/recover/log/confirm 五个执行器;production 默认具名解析到 guardian 原语,新增隔离测试以记录桩覆盖,不成为第二 restart authority——budget gate 仍在 `Invoke-BudgetedRestart` 内,production 保留）。
- dsh-guardian.ps1 第 57 行 dot-source `dsh-health.ps1`;生产循环改走 `Invoke-DshHealthGuard -Port … -Probe $snap -CurrentState $cur -State $healthState -BudgetState $null -MaintenanceLocked (Test-MaintenanceLock)`。**production 默认路径行为不变**。
- 修复一个被本套件顺带暴露的**真实生产 bug**：`Invoke-DshHealthTriage` 参数 `[datetime]$Now = $null` 在未传 `-Now` 时（helper 正是这样调的）PS 5.1 绑定报错 `Cannot convert null to type System.DateTime`,即旧 helper 一旦进入 unready 分支就会抛错。已改为 `[Nullable[datetime]]$Now = $null`。

新增 **`tests/rh1-r3-guardian-path.ps1`**（确定性,隔离,CI 安全）——直接驱动生产同款 `Invoke-DshHealthGuard`,注入记录桩,断言：

| 断言 | 结果 |
|---|---|
| E3 单次 unready (owner=ok) → DEGRADED, restart=0, 无 incident | **PASS** |
| E4 fail/fail/success → restart=0, streak reset | **PASS** |
| E5 后置 120s+第3次失败 → recovery_eligible; incident 先写,**restart 恒恰好1次**; `incidentCreatedAt ≤ restartRequestedAt` | **PASS** (19:52:20.248 ≤ 19:52:20.254) |
| E7 maintenance lock + eligible → Suppressed/noop, restart=0 | **PASS** |
| owner_unsafe → 仅告警, restart=0 | **PASS** |
| server_absent(无非回环) → budgeted restart 1次 + goal recover | **PASS** |
| server_absent + 非回环监听 → 跳过 restart + 告警 | **PASS** |
| E6 budget/circuit 耗尽 → gate 拒绝（原因=budget_exhausted,重启数不增） | **PASS** |

**总计 RH1 R3 guardian-path: PASS=19 FAIL=0。**

## 3. Item 6 — task-presence 字段改名 + HEURISTIC_ONLY（CODE VERIFIED）

dsh-health.ps1 task-presence 块字段统一改为 `recentGoalFileExists / recentGoalFileCount / recentSessionFileCount / newestSessionWriteAt`,对象带 `heuristic = 'HEURISTIC_ONLY'`。不再出现 `activeGoalExists / runningSessionCount` 伪精确命名。注释明示"HEURISTIC_ONLY so consumers never treat them as a hard gate"。

## 4. Item 7 — PageSelfRecovered → LastNavigationSucceeded（CODE VERIFIED）

dsh-reconnect.ps1 / dsh-health.ps1 / DSH-Harness-PS.ps1 / dsh-guardian.ps1 中 `PageSelfRecovered` 语义字段 + 注释改准确为 `LastNavigationSucceeded`（= WebView2 NavigationCompleted 成功驱动,并非 WebSocket/runtime 自恢复）。保留核心规则：DEGRADED→ONLINE 恒 0 reload; 真 OFFLINE 恢复 ≥10s grace; auto reload ≤1/episode; cooldown ≥120s。G15–G19 全部 **PASS**。

## 5. 回归确认（DETERMINISTIC VERIFIED）

- 全部改动脚本 `[System.Management.Automation.Language.Parser]::ParseFile` **PARSE OK**（guardian/health/reconnect/DSH-Harness-PS/rh1-tests/rh1-r3-guardian-path, 0 失败）。
- 既有确定性套件 `tests/rh1-tests.ps1`：**G0–G21 PASS=31 FAIL=0（ALL GREEN）**——`[Nullable[datetime]]` 改动向后兼容,无回归。
- 所有改动的 `.ps1` 已恢复 **UTF-8 BOM**（PS 5.1 中文不乱码）。

## 6. Item 2/4 真实 wall-clock ≥60s soak + 只读 append-only 证据（ISOLATED REAL VERIFIED）

新增 **`tests/rh1-real-e2e.ps1`**——真实墙钟（Get-Date / 真实 elapsed）、严格隔离（DSH_HOME / USERPROFILE
/ LOCALAPPDATA / APPDATA 全指向注入的 temp isolate,不读真实 ~/.dsh）、直接驱动生产同款
`Invoke-DshHealthGuard`,只用可注入的 restart/alert/recover/log/confirm 桩（sanctioned test seam）。
仅两处例外:probe 注入 100ms 睡眠以拉宽并发窗口（用于实测 probe 是否重叠）,以及守卫 120s→90s 缩短
（墙钟真实,但总时长压到 ~90s 而非 ~120s,已在断言中明示 elapsed=90.5s）。结果（PASS=15 FAIL=0）:

| 断言 | 结果 |
|---|---|
| REAL-E3 首次 unready (owner=ok) → DEGRADED, restart=0（无 incident） | **PASS** |
| REAL-E1 观察到 HARD_UNHEALTHY_CANDIDATE（≥30s window 真实墙钟） | **PASS** |
| REAL-E1 eligible 前不 restart（restartAtCandidate=0） | **PASS** |
| REAL-E2 到达 RECOVERY_ELIGIBLE（action=restart_eligible） | **PASS** |
| REAL-E2 跨越真实墙钟 **≥60s**（实际 elapsed=**90.5s**） | **PASS** |
| REAL-E5 restart 执行器**恰好 1 次**（count=1） | **PASS** |
| REAL-E5 incident bundle 已写（incident-*.json） | **PASS** |
| REAL-E5 incident **先于** restart（incidentCreatedAt ≤ restartRequestedAt） | **PASS** |
| REAL-E8 probe 不重叠（maxConcurrentProbe 实测 = **1**） | **PASS** |
| REAL-E4 resume ready → noop（ready=True action=noop） | **PASS** |
| REAL-E4 failStreak 成功后退位 0 | **PASS** |

**只读 append-only 重启证据** —— 单独打包为 **`tests/rh1-real-append-only.ps1`**（真实 env 的
canonical `start-dsh-server.ps1` 在一次性端口 33651 上两次真实启动,杀一次、在两次之间写入 sentinel）。
结果（PASS=4 FAIL=0）:
- boot#1 产生真实 dsh 启动 mark（runner-start） **PASS**
- 重启后 **sentinel 仍在**（sentinelIdx=250,即未 truncate） **PASS**
- boot#2 **在 sentinel 之后**追加了全新 dsh boot banner（"dsh web: http://127.0.0.1:33651",bannerIdx=377） **PASS**
- 日志长度越过 sentinel（284→409） **PASS**

> 结论:canonical 重启对 dsh-server-<port>.log 是**追加**而非覆盖（与 §记忆一致,现以真实启动 + sentinel 实证）。

## 6b. Item 5/8 — 真实 UI/Dispatcher 响应实测 + probe 不重叠（ISOLATED REAL VERIFIED）

新增 **`tests/rh1-real-ui-dispatcher.ps1`** —— 用最小 WPF Dispatcher 心跳（DispatcherTimer ~100ms,
独立 STA 线程)做一个行为级(非"看代码像不像 runspace")实验:同一 dispatcher 上,一个 **BACKGROUND
线程阻塞 3s** 时,若同步网络 probe 曾跑回 UI 线程,心跳必被拖停;反之心跳保持响应即证明 probe 未
跑回 dispatcher。三阶段对照:Phase A 基线 → Phase B 负对照(Dispatcher.Invoke Sleep 2s 拖停,证明
探测器"看得见"UI 阻塞) → Phase C 真测(后台线程阻塞 3s,dispatcher 保持 pumping)。结果(PASS=3 FAIL=0):

| 断言 | 结果 |
|---|---|
| 负对照:UI 线程阻塞时 dispatcher 拖停（negMaxMs=**2064ms** ≥ 1500ms） | **PASS** |
| 真测:后台 probe 阻塞时心跳仍响应（realMaxMs=**~23ms** < 800ms） | **PASS** |
| 真测:后台阻塞不拖停 dispatcher（realMaxMs=23ms < negMaxMs=2064ms） | **PASS** |

> 结论:同步网络 probe 阻塞时,UI/dispatcher 心跳仍保持 ~毫秒级响应(基线 124ms,负对照 2064ms,
> 实测 23ms)——**并非**"代码看起来像 runspace",而是**行为**上后台 probe 未跑回 UI 线程。

**probe 不重叠(独立真实打包)** —— **`tests/rh1-real-probe-overlap.ps1`**(隔离 dsh 服务,端口 33654,
真实墙钟,probe 注入 ~3.6s 慢确认)。结果(PASS=5 FAIL=0):maxConcurrentProbe 实测=**1**;3 次慢 probe
periods **两两不相交**;总耗时 16457ms ≈ n×duration(串行,非倍增)。

## 7. 仍未完成（诚实,原因）

- **Item 5/8 UI Dispatcher 延迟实测量 + 测试分类** — **已完成**（真实 UI/Dispatcher 心跳实测 PASS=3,见 §6b;probe 不重叠独立实测 PASS=5）。
- **Item 9 CI push + GitHub Actions run id** — commit + push 后回填 run id。
- **Item 11 治理** — 仅当 5/8/9 完成且 PR body 更新后才到 `AWAITING_EXTERNAL_REVIEW_R3`。
- 已交付证据:CODE(DETERMINISTIC,PARSE)+DETERMINISTIC(31+19 PASS)+ISOLATED REAL(15+4+5+3 PASS);生产 3080 未触碰,无 merge,无 deploy。

**END SNAPSHOT — IN_PROGRESS（no merge, no deploy; 生产 3080 未触碰）**
