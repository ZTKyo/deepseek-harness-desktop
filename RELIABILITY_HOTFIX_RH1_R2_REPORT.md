# RELIABILITY HOTFIX RH1 R2 REPORT — REVIEW ROUND 2 整改

**状态: AWAITING_EXTERNAL_REVIEW_R2**
**DEPLOYMENT: DEFERRED_ACTIVE_TASK** — 本分支【不部署生产】,仅供外部评审并在部署窗口内人工放行。
**R1 结论: CHANGES_REQUIRED** — R1 评审认定需整改(review round 1 = 需修改),本文件记录 R2 对 4 个 blocking 项的整改与证据。

- 分支: `hotfix/reliability-liveness-rh1`(更新 PR#83,**无新 PR、无 merge、无 deploy**)
- 最新提交: `fa56b0a` rh1 R2 — pure reconnect SM + full-ready + incident redaction + authority exception
- Base: `main` (dbe56be) — 与 PR#79 (phase-02-8-watchdog) 完全独立,未混入;未触碰 PR#79 / P3 / 其他 running task。
- 隔离 worktree: `_wt-rh1`(独立工作树,**未触碰生产目录 / 运行中的 3080 服务 / Desktop Client**)。

---

## 0. R1 = CHANGES_REQUIRED(逐项对照 R1 评审)

| R1 Blocker | 整改后方案(R2) | 证据位置 |
|---|---|---|
| **B1** 客户端 recovery 语义散落 UI、无法测试 | 抽成**纯函数** `Invoke-DshReconnectTransition`(dsh-reconnect.ps1,时钟注入),UI DispatcherTimer 只读结果 + 至多应用那一次 reload | §1 |
| **B2** `HEALTHY` 判定必须是 FULL success | `Get-DshHealthProbe` 引入 `apiReady/wsReady/partialReady/readiness`,`ready` = 全部必需组件成功(FULL);混合结果 = `partial_ready`(不 reset HEALTHY、不重启) | §2、真值表 §2.1 |
| **B3** incident bundle 需扩充但禁敏感 | `New-DshIncidentBundle` 字段化(process/runtime/health/taskPresence/serverLog),统一经 `Invoke-DshRedactText` + `ConvertTo-DshRedactedJson`,敏感 fixture 注入测试**缺失** | §3 |
| **B4** 真实隔离 E2E + CI gate | `tests/rh1-tests.ps1` 扩至 **G0..G21**,接入 `ci-level3.yml` 的 RH1 步骤;重构改为 CI 确定性 + 本机真实 loopback | §4 |

---

## 1. B1 — 客户端 reconnect 纯状态机(dsh-reconnect.ps1)

- **时钟注入**:`Invoke-DshReconnectTransition -State -Mode -PageSelfRecovered -Now [-GraceSec -CooldownSec -OfflineHitsThreshold]`,返回 `{ Operation; Mode; Reload; Reason; State; Diagnostic }`。纯函数**不触网络/I/O/UI**。
- **语义(实测参数)**:
  - `GraceSec = 10`(离线→在线需稳定连续在线 ≥10s 才考虑 reload)
  - `CooldownSec = 120`(距上次 auto reload ≥120s 才允许下一次)
  - `OfflineHitsThreshold = 2`(连续探针不可达 ≥2 次才判 OFFLINE)
  - `DEGRADED → ONLINE` = **恒 0 reload**(G15)
  - `OFFLINE → ONLINE` = 稳定恢复 grace 后,仅当**页面未自恢复** 且本 episode **未 reload** 且距上次 ≥cooldown,才触发**最多 1 次** auto reload(G17/G18/G18b)
  - 页面**已自恢复** → **0 reload**(不与自愈页面打架,G19)
  - "episode" = 连续不可达且达 OFFLINE 的一次事件;每 episode ≤1 次 auto reload。
- **UI DispatcherTimer 现在只做**:读 probe mode + 页面自恢复标志 → 调纯函数 → 应用返回状态 → 至多执行函数授权的那 1 次 reload。判定(grace/cooldown/episode/no-reload-on-degraded)全部在纯函数内,不再散落 UI 代码。
- **持久化**:reconnect 状态由客户端进程内 `$script:reconn` 持有(纯函数返回更新副本,调用方决定何时持久化);`Get-DshReconnectState` 为对称占位,不写盘。

## 2. B2 — FULL_READY 语义(dsh-health.ps1)

- **LIVENESS** = 进程/HTTP 存活(任何响应 200/4xx/5xx → matched);**READINESS** = 必需组件集合。
- 字段:`apiReady / wsReady / partialReady / readiness = full|partial|unready`。
- `requiredCount = 1 + ($IncludeWebSockets ? 1 : 0)`;`ready` (FULL) 仅当 `okCount == requiredCount`。

### 2.1 FULL vs PARTIAL 真值表

| IncludeWebSockets | API ready | WS ready | ready(FULL) | readiness | 行为 |
|---|---|---|---|---|---|
| false | ✓ | —(不要求) | **TRUE** | full | HEALTHY,FULL success 才 reset healthy |
| false | ✗ | — | FALSE | unready | 未就绪;持续全失败+streak/window/confirm → RECOVERY_ELIGIBLE |
| true | ✓ | ✓ | **TRUE** | full | FULL_READY |
| true | ✓ | ✗ | FALSE | **partial** | PARTIAL — **不 reset HEALTHY,不重启**,仅诊断值 |
| true | ✗ | ✓ | FALSE | **partial** | PARTIAL — 同上(单组件成功掩盖长期坏 → 不被误判为 full) |

> 规则:R2 明确**单组件成功不得掩盖长期坏**。仅**持续全必需组件失败**(streak ≥3 & window ≥30s & 独立确认 & 总异常 ≥60s)才到 `RECOVERY_ELIGIBLE`;混合(partial)永远不升级、永不 reset healthy。

## 3. B3 — incident bundle 字段化 + 红色action(dsh-health.ps1)

`New-DshIncidentBundle`(仅 owner=ok 且真进入 restart eligibility 路径)写 `incident-<ts>.json` 到 %LOCALAPPDATA%\DSHHarness\incidents\,字段:

```jsonc
{
  "ts", "port", "reason",
  "ownerState", "ownerPid", "ownerCreation", "ownerCmdHash", "nonLoopbackCount",
  "probe":        { "basicState","basicHttpStatus","apiState","wsState","apiReady","wsReady","ready","partialReady","readiness","failureSignal","errorClass","probeDurationMs" },
  "healthState":  { "state","consecutiveFailures","maxFailures","firstFailureAtMs","lastFailureAtMs","lastHealthyAtMs","errorClass","readiness","lastProbeSummary" },
  "runtime":      { "state","port","childPid","launcherPid","entryHash","startedAt","updatedAt","exitCode" },          // best-effort, 读取失败不阻塞
  "process":      { "pid","startTime","cpuSeconds","rssBytes","handleCount","path" },                                   // 仅 live owner pid;不含 cmdline args
  "taskPresence": { "activeGoalExists","goalFileCount","runningSessionCount","newestSessionWriteAt" },                 // 仅 presence/timestamp/count/id 代理;禁 session raw text
  "serverLog":    { "path","tailLines":200,"tail" },                                                                    // tail 过 Invoke-DshRedactText
  "budget":       { "attempts","hourAttempts","pauseUntil","lastReason" }
}
```

- **红色action 单一出口**:所有值经 `Invoke-DshRedactText` 后再经 `ConvertTo-DshRedactedJson` 序列化,序列化后再整体脱敏扫描。
- **禁入**:prompt/message body / Authorization / Bearer / token / api key / password / credential / service-account / private key / 完整 session history。
- **有限**:读取任何失败一律写 `UNKNOWN`/null,不阻塞恢复。
- **测试**:`Test-DshIncidentRedaction`(G20/G20b)向 bundle 注入敏感 fixture(token / Authorization Bearer / PEM 私钥),断言序列化产物中**缺失**,而非"看起来被处理"。

## 4. B4 — 真实隔离 E2E + CI gate

### 4.1 隔离套件(隔离 worktree,不读真实 ~/.dsh)
- 临时 `USERPROFILE` / `LOCALAPPDATA`;disposable loopback 服务器端口 **33183**(非生产 3080);不读真实 `~/.dsh`;不碰真实 Goal/Session;不碰生产 guardian/client。
- 覆盖 **G0..G21**:
  - G0 dot-source dsh-health / G1-G3 liveness+ready 分离(200/503/timeout) / G4a-G4b owner 安全(identity_mismatch/owner_unsafe)
  - G5-G8b 状态机 R1..R4(noop / degrade / hard_candidate / recovery_eligible)
  - G9 append-only+start marker / G10 无截断 / G11 单一起动权威 / G12 共享 health probe / G13 guardian 由 Test-DshRestartAllowed 门禁
  - G14a UTF-8 BOM / G14b parse-valid
  - G15-G19 reconnect 纯状态机(degraded→online=0 reload / offline 观察与声明阈值 / offline→online grace 未过不 reload / grace 过后页面未恢复→1 次 reload 且无第 2 次 / 页面自恢复→0 reload)
  - G20-G20b incident 脱敏(fixture 缺失) / G21 生产 PS 路径收敛单权威

### 4.2 结果
```
PASS=31  FAIL=0  (exit 0)   —— 见 §6(本机运行输出)
```
- 断言关键:**BOM(DshReconnect/G14a)、parse(G14b)、append-only(G9)、单权威(G11/G21)、脱敏(G20/G20b)、reload 决策(G15-G19)** 全绿。

### 4.3 CI 确定性 vs HOST REAL wall-clock(诚实区分)
- **本机(host,实跑)**:真实 disposable loopback 服务器(33183)驱动 G1-G14 的 liveness/readiness/状态机;G15-G19(GraceSec=10/CooldownSec=120/Offline=2)与时序由**测试注入时钟**确定性驱动(goal 允许的 test-only clock seam),非真实 60s 等待。
- **真实 wall-clock ≥60s soak**:本轮**未单独执行**(评审/不部署上下文)。Grace/Cooldown 的 ≥60s 慢场景已由**确定性时钟注入**覆盖(这是 CI 可复现路径)。
- **CI gate**:已把 `RH1 R2 harness` 步骤接入 `ci-level3.yml`(deployment gate),触发路径含 `tests/rh1-tests.ps1` / `tests/dsh-disposable-server.ps1`;失败即 gate 失败。CI run id:推送后由 GitHub Actions 生成(见 §6 提交),待 CI 运行记录。

### 4.4 其他证据
- **真实 restart count**:0(仅评审修复,无部署;被测 restarts 均在 disposable server 隔离内,不触及生产 3080)。
- **log sentinel**:dsh-launcher.js 以 `append` 模式打开 server 日志并写入 start marker(G9)。
- **max concurrent probes**:客户端每 tick 发**一次**非阻塞共享探针(移出 UI 线程),不并发刷探针、不 flood;reconnect 判定在纯函数内单线程。
- **UI dispatcher**:重连决策移出 DispatcherTimer 的核心逻辑,计时器只读结果、应用状态,至多执行授权的那 1 次 reload。
- **生产未触碰证明**:见 §5。

## 5. 变更风险与回退 / 生产未触碰

- 全部改动仅在隔离 worktree `_wt-rh1`;**未触碰生产目录、未触碰运行中的 3080、未重启 Desktop Client、未 merge、未 deploy**。
- 未改动 `dsh-guardian.ps1` 主逻辑之外的内容(guardian hash 未变:`954cead…`);改动集中在 `dsh-health.ps1`、`DSH-Harness-PS.ps1`、新增 `dsh-reconnect.ps1`、`tests/rh1-tests.ps1`、`ci-level3.yml`。
- 回退 = `git checkout main`(生产 main 未动);分支可随时丢弃。
- 生命周期为独立 PR(更新 PR#83),无新 PR。

## 6. 证据(本机实测)

```
PASS  G0 dot-source dsh-health.ps1  loaded ok
PASS  G1 online 200 matched
PASS  G2 unready 503 matched (alive)
PASS  G3 offline => liveness loss
PASS  G4a non-dsh owner not ready  ownerState=identity_mismatch
PASS  G4b non-dsh owner never triggers restart  Action=owner_unsafe
PASS  G5 ready resets healthy (noop)
PASS  G6 R1 degrade (no restart)
PASS  G7 R2 degrade (no restart)
PASS  G8 R3 hard_candidate
PASS  G8b R4 recovery_eligible (restart gated)
PASS  G9 launcher append-only + start marker
PASS  G10 no truncating server-log redirect
PASS  G11 single authority (client + restart route to start-dsh-server.ps1)
PASS  G12 client uses shared health probe
PASS  G13 guardian restart gated by Test-DshRestartAllowed
PASS  G14a UTF-8 BOM preserved on all PS1
PASS  G14b PS1 parse-valid
PASS  G15 dot-source dsh-reconnect.ps1
PASS  G15 degraded->online always 0 reload
PASS  G16 offline observe (< threshold) no declare
PASS  G16b offline declared at threshold
PASS  G17 offline->online grace not elapsed, no reload
PASS  G18 grace elapsed page not recovered -> auto reload (1x)
PASS  G18b no second auto reload this episode
PASS  G19 page self-recovered -> no reload
PASS  G20 incident redaction: sensitive fixture absent
PASS  G20b incident bundle JSON redacted
PASS  G21 production PS paths converge on single authority
==== RH1 harness result: PASS=31 FAIL=0 ====
```

- 文件 SHA256(最终字节,HEAD=fa56b0a):
  - `DSH-Harness-PS.ps1` = `82e649022b60b9285c0ba67187f02085992aeaaee00d2bdf8428f8e252121a04`
  - `dsh-health.ps1` = `ec62a20c7422d1baa9019a3169a0a1f30fbfd1daf55ef09d8ea8c750e50cad56`
  - `tests/rh1-tests.ps1` = `2a69881254641beb5edd4e82d885a1edcd2aef4abb20da6c7183bd161faa80ec`
  - `dsh-guardian.ps1` = `954cead59713bc57d33f398fb317a4553131500ffbaa7140b7aac954f49a912a`(未变)
  - `dsh-reconnect.ps1` = `7cfbfaa0bf9d0591849408db41a5ceec37f454edeb446e066f464aade32e6f5b`(新增)

## 7. 遗留 / Next(诚实)

- 本分支**未部署**;部署须在部署窗口内人工放行并重启 dsh,使新 dsh-health / reconnect / client 生效。
- **真实 wall-clock ≥60s E2E** 未独立运行(评审/不部署上下文);建议部署前在真实服务上补一次 ≥60s 的离线-恢复 soak 以印证注入时钟所模拟的语义。
- CI run id 待 GitHub Actions 跑完后回填(本次为评审交付;不作为阻塞)。
- R1 报告的 host-verifiable 区仍标注 PARTIAL(判据 9/10/11 为 host-variable/手动性质,与 §5 一致)。

**END REPORT — AWAITING_EXTERNAL_REVIEW_R2 (no merge, no deploy)**
