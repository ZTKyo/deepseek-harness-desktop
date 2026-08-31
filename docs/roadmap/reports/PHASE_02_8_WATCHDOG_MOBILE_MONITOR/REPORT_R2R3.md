# REPORT R2 B + R3 B — Watchdog 手机侧无常驻连接改造（External Review B 落地）

日期：2026-08-31 · 状态：工作树未提交（与 R1 一致，待 PR 打包）
前置：REPORT_R1.md（R1 B1-B5 已解决）· GAP_AUDIT.md · 本报告覆盖 R2 B（桌面服务端）与 R3 B（Android 侧）

## 0. 目标回顾（External Review B 的两条核心整改）

1. **去除手机侧常驻连接**：R1 B1 的 SSE 前台服务（WatchdogEventService + foregroundServiceType=dataSync）
   违背最小权限/最省电目标 → 移除前台长连接，改「服务端 FCM data-message 唤醒 + 客户端兜底轮询」。
2. **服务端 SSE 端点退役**：/watchdog/events 不复存在；入口给旧客户端一个可判定的停用信号（410 Gone），
   而非 404/挂起。近实时告警职责回归服务端（Telegram 旁路不变，可选 FCM）。

## 1. 服务端变更（R2 B）

### plugins/watchdog.mjs
- 删除 `/watchdog/events` SSE 路由（原 199 行改造含 FCM push 集成）；
- 只读路由：`/watchdog/health`、`/watchdog/status`；另注册**退役探针路由**
  `/watchdog/events`：GET-only → Bearer 401 → 410 `{ok:false, error:'watchdog_sse_removed',
  replacement:'fcm_data_message+poll_fallback'}`（Cache-Control: no-store，零 mutation）——
  R1 B1 旧手机客户端直连的是**宿主端口**（非 adapter 端口），必须在这里给出可判定的停用信号；
- 启动日志标注 `push=fcm+fallback-poll`。

### plugins/watchdog-core.mjs
- 新增 `buildFcmPushPayload({ evaluated, eventId })`：载荷 = 元数据白名单
  `{v, ev:'state_change', eid:'fcm-<seq>', rev, gen, wake:true, ts}`（不含 state 文本/内容，客户端收到后自行拉取）；
- 新增 `buildFcmRequest({ projectId, payload })`：FCM HTTP v1 请求体（topic=watchdog，
  data 值全字符串，priority=HIGH，ttl=900s；project id 形状校验 fail-closed）；
- `sanitizeSnapshot` 新增 `freshness: { policy:'poll+fcm', pollMs, push:'fcm-data-message' }`；
- `push` 元数据保持 `channel:'sse'` 字符串仅为 schema 兼容（消费方按字段名读取），`path` 指向语义等价的
  `/watchdog/status`，并新增 `fcm:true` 标志。

### supervisor-mcp-adapter/server.mjs
- `/watchdog/events` 显式 410 Gone：`{ ok:false, error:'watchdog_sse_removed',
  replacement:'fcm_data_message+poll_fallback' }`（Bearer 鉴权保留，零 mutation）。
  注：与插件侧退役探针同语义（单一真值 `watchdog_sse_removed`），覆盖 MCP 适配入口。

## 2. Android 侧变更（R3 B）

| 组件 | R1 B1 | R3 B |
|---|---|---|
| WatchdogEventService | 前台 SSE 长连接（-178 行删除） | **删除** |
| WatchdogBootReceiver | BOOT_COMPLETED 恢复长连接 | **删除** |
| WatchdogPollReceiver | — | **新增**：JobService，15 分钟只读轮询（`fetchAllSync` 后 `jobFinished`；Doze 下系统自动推迟） |
| WatchdogWidgetProvider | 依赖 SSE 推送 | 改为拉取式：`schedulePoll` 注册 persisted Job + 点击手动刷新 + widget_info 30 分钟兜底 |
| AndroidManifest | FOREGROUND_SERVICE + FOREGROUND_SERVICE_DATA_SYNC + POST_NOTIFICATIONS + BOOT receiver | 仅 INTERNET + RECEIVE_BOOT_COMPLETED（仅为 `JobScheduler.setPersisted(true)` 跨重启保活，无 BOOT receiver 组件）；versionCode 2 / versionName 0.2.0 |

- 权限模型不变量保持：**零 mutation**（无任何写/恢复调用；数据源仍为脱敏投影 /watchdog/status）。
- APK badging 已验证：`.WatchdogConfigActivity`（APPWIDGET_CONFIGURE）+ `.WatchdogPollReceiver`
  （BIND_JOB_SERVICE）+ provider（APPWIDGET_UPDATE）在案。

## 3. 测试对齐（本回合；R2 B 改造遗留的 3 个旧 SSE 断言文件全部修复）

- **test-watchdog-core.mjs**（47 → 49）：push 元数据断言改为 R2 B 真值
  （`path=/watchdog/status`、`fcm=true`、`freshness.policy=poll+fcm`）；新增
  「FCM 线格式」step：payload 白名单 + `fcm-<seq>` eid + 请求体形状 + data 值全字符串 + project-id fail-closed。
- **smoke-watchdog-host.mjs**：路由断言 2→3（health / status / events 退役探针）；直调 handler 验证
  `401（坏 Bearer）→ 410 watchdog_sse_removed（有效 Bearer）` + `cache-control: no-store`；
  补 `freshness.policy` 断言；`push.channel='sse'` 注释为 schema 兼容语义。
- **e2e-watchdog-real.mjs**：SSE 收集器（sseCollect + A0/A3 两段连接 + wire 白名单断言）整体退役，
  替换为 `eventsGone` 410 探针（A0 首连 + 重启后各验一次，断言 `watchdog_sse_removed`）；
  E7 OFFLINE 证据改由 status 投影 + E5 alertPs1 spy 状态变更链承担；FCM 线格式由 core 单测覆盖。

## 4. 验证证据

- core 单测：`node tests/watchdog/test-watchdog-core.mjs` → **49 passed, 0 failed**。
- 宿主冒烟：`node tests/watchdog/smoke-watchdog-host.mjs` → **SMOKE-OK**
  （2 路由注册 + schemaVersion 2 + freshness/push 全字段 + 零泄漏扫描通过）。
- REAL E2E：`node tests/watchdog/e2e-watchdog-real.mjs` → **43/43 PASS（§6）**。
- 红线自查：未触碰真实 ~/.dsh；测试自建隔离实例（端口 33160 段）；无密钥/token 入仓入日志。

## 5. 遗留与边界

- 全部改动仍在工作树未提交（R1/R2/R3 连续演进，待与 PR_BODY.md 一起打包提交）。
- `plugins/execution-continuity.mjs.bak-p3r2-ctfallback`：更早阶段遗留的未跟踪备份文件，非本改造产物，待确认后清理。
- FCM 真实推送链（FCM_PROJECT_ID / 服务账号）为服务端可选路径，CI 隔离 home 无凭据时跳过；
  Android 真机验证 → WAITING_USER（与 R1 报告同口径）。

## 6. REAL E2E 结果（已回填）

**最终：WATCHDOG REAL E2E PASS — 43 passed, 0 failed（run=wd-mtgvboh7，exit 0）**

- 第 1 轮（41/43）：E6 两条断言 FAIL——宿主端口返回 404 而非 410。根因：退役信号只实现在
  adapter 端口（server.mjs），而 R1 B1 旧手机客户端直连**宿主端口**（plugins/watchdog.mjs），
  落在默认 404，恰是设计要避免的"不可判定信号"。
- 修复：plugins/watchdog.mjs 补注册退役探针路由（GET-only → 401 → 410 watchdog_sse_removed，
  与 adapter 单一真值同语义）；smoke 同步 3 路由断言 + handler 直调 401/410 校验。
- 第 2 轮全绿关键断言：E1 STALLED 计时不早于 stallAfterMs(60s)-5s；E2 RECOVERING 计时 +
  receipts ledger 恰 1 条 WD correction + 预算从 ledger 派生 + 窗口内无重复 correction +
  commandId 形状；E3 重启后 denylist 目标零自动恢复；E4(full) 真实两轮
  AWAITING_REVIEW→review FAIL→CORRECTING→review PASS→VERIFIED 终态；E6 首连与重启后均
  410 watchdog_sse_removed；E7 bridge token 摘除→OFFLINE/degraded→恢复→token 还原→回到
  STALLED/goal_denylisted；B2 model.default 读真实 settings、model.actual 保持 UNKNOWN。
