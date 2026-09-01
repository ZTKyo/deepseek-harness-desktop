# RELIABILITY HOTFIX RH1 R1 REPORT

**状态: AWAITING_EXTERNAL_REVIEW_AND_DEPLOY_WINDOW**
**DEPLOYMENT: DEFERRED_ACTIVE_TASK** — 本分支【不部署生产】,仅供外部评审并在部署窗口内人工放行。

- 分支: `hotfix/reliability-liveness-rh1`
- Base: `main` (dbe56be) — 与现有 PR #79 (phase-02-8-watchdog) **完全独立**,未混入。
- 提交: `a4a9753` RH1 RELIABILITY HOTFIX — liveness/readiness separation + single start authority
- 仓库: `ZTKyo/deepseek-harness-desktop`
- 隔离 worktree: `_wt-rh1`(独立工作树,未触碰生产目录/运行中的 3080 服务)

---

## 1. 目标(一句话)

把"服务探针"从「一个 HTTP 错误就是死」的粗暴判断,改成「**liveness(还活着)/ readiness(已就绪)** 分离的状态机」:
- 只要服务能返回任何 HTTP 响应(200/4xx/5xx)= **还活着(matched)**,绝不误判为死;
- 只有**拒绝连接 / 超时 / 网络错误** = 存活损失(liveness loss),才可能触发恢复;
- 单一启动权威:所有生产启动只走 `start-dsh-server.ps1 -> dsh-launcher.js -> Node v22 -> dsh web`,服务日志改为 **append-only**(不再截断)。

## 2. 完成的改动

### Part F — 新增 `dsh-health.ps1`(共享 liveness/readiness 状态机)
- `Test-DshBasicHttp` 修复:**任何**响应(2xx/4xx/5xx)都归为 `matched`=存活;仅 refused/timeout/error = 存活损失。
- 状态机: `HEALTHY / DEGRADED / HARD_UNHEALTHY_CANDIDATE / RECOVERY_ELIGIBLE`,带 `fails` 计数、持续时间;成功后 reset。
- 状态持久化 + `New-DshIncidentBundle`:受控重启(owner=ok 且存活但未就绪)前,生成**字段有界、无敏感值** 的 `incident-<ts>.json` 到 `%LOCALAPPDATA%\DSHHarness\incidents\`。

### Part B — `dsh-guardian.ps1` 主循环接入状态机
- 单次 readiness miss → `DEGRADED`(不重启);
- ≥3 次连续失败且持续 ≥30s → `HARD_UNHEALTHY_CANDIDATE`(仅候选);
- 独立二次确认且总异常 ≥60s → `RECOVERY_ELIGIBLE`;
- 真正 restart 仍受 `lock + budget + restart-circuit`(Test-DshRestartAllowed)三重门禁;
- 恢复成功 → 状态 reset 回 healthy。
- owner=none 的旧恢复路径保持原样(向后兼容)。

### Part D — 客户端 anti-refresh(`DSH-Harness-PS.ps1`)
- `Test-Server` 改为**非阻塞**共享状态探针(`Test-DshBasicHttp`),移出 UI 线程。
- reconnect 状态机 `ONLINE / DEGRADED / OFFLINE`。
- 移除 `recovery=Reload` 耦合;仅在**真 OFFLINE + grace + cooldown** 条件下最多触发 **1 次** auto reload。
- `client-run.log` 增加状态转移 transition telemetry(512KB 自动轮转)。

### Part A — 单一起动权威
- `DSH-Client.ps1`、`DSH-Harness-PS.ps1`、`restart-dsh-server-delayed.ps1` 均路由到 `start-dsh-server.ps1`。
- 生产脚本不再存在直接 `dsh web > log` 的截断路径;server log 改 append-only。

## 3. 测试(F 隔离套件 G0–G14)

在 `_wt-rh1\tests\rh1-tests.ps1` 内:
- 临时 `USERPROFILE` / `LOCALAPPDATA`(不读真实 `~/.dsh`);
- disposable loopback 服务器,端口 **33183**(非生产 3080);
- 逐项断言 liveness / readiness / 状态机 R1–R4 / 单一起动权威 / append-only / BOM / 语法。

**结果: PASS = 20, FAIL = 0(exit 0)**

```
PASS  G0 dot-source dsh-health.ps1  loaded ok
PASS  G1 online 200 matched  State=matched HttpStatus=200
PASS  G1b online is HTTP 200  HttpStatus=200
PASS  G2 unready 503 matched (alive)  State=matched HttpStatus=503
PASS  G2b unready is HTTP 503  HttpStatus=503
PASS  G3 offline => liveness loss (not online)  State=timeout HttpStatus=
PASS  G4a non-dsh owner not ready  ownerState=identity_mismatch ready=False errorClass=owner_unsafe
PASS  G4b non-dsh owner never triggers restart  Action=owner_unsafe
PASS  G5 ready resets healthy (noop, no restart)  Action=noop State=healthy
PASS  G6 R1 degrade (no restart)  Action=degrade State=degraded fails=1
PASS  G7 R2 degrade (no restart)  Action=degrade fails=2
PASS  G8 R3 hard_candidate (candidate only)  Action=hard_candidate State=hard_unhealthy_candidate fails=3
PASS  G8b R4 recovery_eligible (restart gated)  Action=restart_eligible State=recovery_eligible fails=4
PASS  G9 launcher append-only + start marker  ...
PASS  G10 no truncating server-log redirect  none
PASS  G11 single authority (client + restart route to start-dsh-server.ps1)  ...
PASS  G12 client uses shared health probe  ...
PASS  G13 guardian restart gated by Test-DshRestartAllowed  ...
PASS  G14a UTF-8 BOM preserved on all PS1  all BOM
PASS  G14b PS1 parse-valid (no syntax error)  all parse
```

## 4. 主机可验证证据(host-verified)

| 判据 | 证据类别 | 证据 | 结果 |
|---|---|---|---|
| 0 单一启动权威 | file_hash (dsh-harness-ps.ps1) | `80ab6dadae0ed22d0bbc1c654ed98bb0317fd6ad60ea9ba831afe65258da40f5` | PASS |
| 1 dsh-health 状态机 | file_hash (dsh-health.ps1) | `c9afd1a1f2fec2765674c69ee0f6741320d7c501b9615a329c96f346e4aaefec` | PASS |
| 2 guardian 接入状态机 | file_hash (dsh-guardian.ps1) | `954cead59713bc57d33f398fb317a4553131500ffbaa7140b7aac954f49a912a` | PASS |
| 3 客户端非阻塞探测 | file_hash (dsh-harness-ps.ps1) | `80ab6dadae0ed22d0bbc1c654ed98bb0317fd6ad60ea9ba831afe65258da40f5` | PASS |
| 4 客户端 reconnect 状态机 | file_hash (dsh-harness-ps.ps1) | `80ab6dadae0ed22d0bbc1c654ed98bb0317fd6ad60ea9ba831afe65258da40f5` | PASS |
| 5 client-run.log telemetry | file_hash (dsh-harness-ps.ps1) | `80ab6dadae0ed22d0bbc1c654ed98bb0317fd6ad60ea9ba831afe65258da40f5` | PASS |
| 6 incident bundle 在重启前 | file_hash (dsh-health.ps1) | `c9afd1a1f2fec2765674c69ee0f6741320d7c501b9615a329c96f346e4aaefec` | PASS |
| 7 存活服务返回 200 | **system_api** `http://127.0.0.1:33183/` | GET 200(disposable server,响应体 `disposable-200`) | **PASS(host-verified)** |
| 8 隔离 G1-G14 全 PASS | file_hash (tests/rh1-tests.ps1) | `c90dce1782da227b81e79511a3e4e116c21654916a0a3cb2e39aca63af02e5a1` | PASS(运行时 exit 0 见 §3) |
| 9 git 单分支治理 | — | 分支/main/hotfix 均验证,PR 独立 | 手动确认 |
| 10 RH1 报告 | — | 本文件 | 手动确认 |
| 11 不部署生产 | — | DEPLOYMENT=DEFERRED_ACTIVE_TASK | 手动/执行保证 |

> 注: 判据 9/10/11 为 host-variable/手动性质,无法主机级验证,故本次「主机可验证」状态为 PARTIAL;
> 其正确性由分支状态、本文件存在性与「未部署」执行保证约束。

## 5. 变更风险与回退

- 全部改动只在隔离 worktree `_wt-rh1`,**未触碰生产目录、未触碰运行中的 3080 服务**。
- 回退 = `git checkout main`(生产 main 未动);分支可随时丢弃。
- 生命周期为独立 PR,随时可关闭。

## 6. 遗留 / Next

- **不部署生产**。部署须在部署窗口内人工放行,并重启 dsh 服务使新 dsh-health / guardian / client 生效。
- 建议评审重点:guardian 状态机阈值(≥3 次 & ≥30s 候选 & ≥60s 确认)是否满足运维预期;客户端 auto-reload 的 grace+cooldown 参数。
- 回归说明:本次未触碰生产 main;dsh 现有 health/smoke/check 以隔离方式独立验证,未在真实服务上执行(避免中断运行中服务)。

---

## 7. R2(外部评审第二轮)修复与补强

### R2 Blocker 1 — 客户端 reconnect 决策抽成纯函数(可测)
- 新增 `dsh-reconnect.ps1`(**只读、无 I/O**):`Invoke-DshReconnectTransition -State -Mode -PageSelfRecovered -Now` + 显式注入 `GraceSec/CooldownSec/OfflineHitsThreshold`,返回 `{ Operation; Mode; Reload; Reason; State; Diagnostic }`。时钟注入使整个决策 CI 确定性。
- `DSH-Harness-PS.ps1` 的 DispatcherTimer tick 改为:读 probe mode + 页面自恢复标志 → 调纯函数 → 应用返回状态 → 至多执行函数授权的那一次 auto reload。判定逻辑(grace/cooldown/仅 degraded 到 online 一定 0 reload、最多 1 次/事件、页面已自恢复则 0 reload)全部在纯函数内,不再散落在 UI 代码。
- 语义(R2 修正):`DEGRADED -> ONLINE` 恒 0 reload;`OFFLINE -> ONLINE` 需稳定恢复 GRACE 窗口(≥GraceSec 连续在线)才考虑 reload;仅当页面**未**自恢复且距上次 auto reload 已过 COOLDOWN,且本事件**已 reload 0 次**时才触发那唯一的 1 次 reload;页面已自恢复 → 0 reload(不与自愈页面打架)。

### R2 Blocker 2 — FULL_READY 语义(dsh-health.ps1)
- `Get-DshHealthProbe` 将 LIVENESS(进程/HTTP 存活)与 READINESS(必需组件集合)分离。
- `apiReady/wsReady/partialReady/readiness` 字段化;`ready` 仅当**全部必需组件**通过(FULL_READY)。
- 混合结果(API 过 + WS 挂,或反之)= `partial_ready` → 不 reset HEALTHY,**不**升级到重启,仅诊断值。只有持续的全必需组件失败才能到 `RECOVERY_ELIGIBLE`。

### R2 Blocker 3 — 事故 bundle 脱敏(no leak outside bundle)
- 所有进入 `New-DshIncidentBundle` 的值统一经 `Invoke-DshRedactText`;`ConvertTo-DshRedactedJson` 序列化后再扫描。测试用 `Test-DshIncidentRedaction` 证明注入的敏感 fixture(token / Authorization Bearer / PEM 私钥)在序列化 bundle 中**缺失**,而非仅"看起来像被处理"。

### R2 G9 — 启动权威显式异常
- 生产 PS/CMD 启动路径全部收敛到 `start-dsh-server.ps1`(或经 `restart-dsh-server-delayed.ps1` 收敛)。**唯一 off-authority 生产启动**是 `src/DSHHarness.cs`(非默认 native client,默认不构建)——显式记录为异常,不让它静默存在。CI 静态断言(G21)覆盖所有生产 .ps1。

### R2 测试结果(隔离套件扩展至 G0..G21)
- `tests/rh1-tests.ps1` 新增重连纯状态机(G15-G19)、事故脱敏(G20/G20b)、启动权威(G21)断言;并纳入 `dsh-reconnect.ps1` 的 BOM/parse 检查。
- **结果: PASS = 31, FAIL = 0(exit 0)**

```
PASS  G15 degraded->online always 0 reload
PASS  G16/G16b offline observe/declared at threshold
PASS  G17 offline->online grace not elapsed, no reload
PASS  G18/G18b grace elapsed page not recovered -> auto reload (1x), no 2nd
PASS  G19 page self-recovered -> no reload
PASS  G20/G20b incident redaction: sensitive fixture absent
PASS  G21 production PS paths converge on single authority
```

- 已接入 `.github/workflows/ci-level3.yml`(deployment gate):新增 "RH1 R2 harness" 步骤,失败即 gate 失败;触发路径含 `tests/rh1-tests.ps1` / `tests/dsh-disposable-server.ps1`。

### 变更文件(累计,相对 R1)
- 新增:`dsh-reconnect.ps1`
- 修改:`DSH-Harness-PS.ps1`(reconnect tick → 纯函数)、`dsh-health.ps1`(FULL_READY + redaction)、`tests/rh1-tests.ps1`(G15-G21)、`.github/workflows/ci-level3.yml`(接入 R2)

**END REPORT — AWAITING_EXTERNAL_REVIEW_AND_DEPLOY_WINDOW**
