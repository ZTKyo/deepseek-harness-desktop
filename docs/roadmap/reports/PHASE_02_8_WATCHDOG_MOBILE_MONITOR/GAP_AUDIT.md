# Phase 02.8 WATCHDOG / Mobile Monitor — Gap Audit R1（Step 1，只读）

日期：2026-08-31 ｜ 分支：`phase-02-8-watchdog-mobile-monitor`（基线 main=fd26b08）｜ 审计方式：全只读

## 1. 哪些真实状态已经能读取

| 状态 | 来源（既有权威面，零新增） |
|---|---|
| Supervisor goals / controlState / generation / revision / pendingMutation / nextExpectedAction / correctionsLeft / objective | `POST /supervisor/get_snapshot`（supervisor-bridge v0.2.2，Bearer `~/.dsh/supervisor-bridge/token`）→ `supervisorGoals[]`（buildSnapshotRow）+ `current` + `sessions[]`（sanitizeStateItem：running/updatedAt/goalPhase） |
| Session running / updatedAt | 同上 `sessions[]` |
| Host 健康 | `/supervisor/health`（bridge 自报 SHA identity）；watchdog 插件本身 in-host，宿主死 → watchdog 同死（OFFLINE 由**拉取方**判定） |
| 当前模型/Provider 真值 | `~/.dsh/settings.yaml` `agent-default-model`（switch_primary_model 的单一事实源，实测 `provider: bai / model: glm-5.3-flash`）；`provider-registry-core.mjs` 静态默认指针（bai/deepseek-v4-flash）+ 角色/健康状态机；`~/.dsh/router-diagnostics.log` 最近 decision（需 ROUTER_DIAGNOSTICS 开启，当前陈旧仅作辅助） |
| Provider 配额失败语义 | failure-classifier（429/1310/1305 → QUOTA_EXHAUSTED + unavailableUntil）+ EC per-session 内存态（非全局可读余额） |

## 2. 哪些状态目前缺失

- 无统一 Watchdog 投影状态（IDLE/RUNNING/STALLED/RECOVERING/AWAITING_REVIEW/BLOCKED/VERIFIED + UI 层 OFFLINE/UNKNOWN）。
- 无全局 quota/balance/resetAt 只读真值（Provider 官方 balance API 未接线；EC `unavailableUntil` 为 per-session 内存态，不作全局计费真相源）。
- 无移动端只读快照端点与 Widget。
- `router-diagnostics.log` 长期未更新（decision 日志依赖诊断开关）→ 实际模型真值以 settings PRIMARY 为准。

## 3. 已有可复用 notification / push / 只读 HTTP 面

- **Push**：`DSH-Client/telegram-alert.ps1` + bot @mydeepssekharnessbot（授权 chatId、走 OpenClash 代理）——completion-notify 已验证服务内 `spawn` 模式，直接复用。
- **只读 HTTP**：supervisor-bridge 只读面（health/get_state/get_goal/get_evidence/get_snapshot）；supervisor-mcp-adapter（8091，三 token 分离：入口 MCP_TOKEN / 上游 BRIDGE_TOKEN）。
- **隧道**：既有 p275 tunnel（→8091）为唯一公网边界，**不新开裸端口**；Widget 走 `GET /watchdog/status`（新增、只读、独立 token）复用同一隧道与鉴权模式。

## 4. 当前模型/Provider 真值从哪里获取

`settings.yaml agent-default-model`（live PRIMARY 指针，switch_primary_model 维护）＝投影权威；辅以 provider-registry 角色指针与 router decision 日志（`source` 字段在 snapshot 中如实标注）。

## 5. quota / balance / resetAt 可靠性

| Provider | 可靠来源 | V1 决策 |
|---|---|---|
| OpenRouter | `GET /api/v1/credits`（官方） | 可接线，V1 暂不接 → `UNAVAILABLE` |
| DeepSeek 平台 | `GET /user/balance`（官方） | 同上 |
| B.AI / zhipu / xiaomi / agentrouter | 无已验证公开 balance 端点 | `UNAVAILABLE` |
| resetAt | EC unavailableUntil（per-session 内存） | `UNAVAILABLE`（不猜测、不建第二余额库） |

V1 全部计费字段如实显示 `UNAVAILABLE`（T11 满足，零猜测）；接线留 R2 观察。

## 6. 最小新增组件

1. `plugins/watchdog-core.mjs` — 纯函数：状态投影 / stall 判定（进展信号非纯时长）/ 有界恢复策略 / 脱敏 schema。
2. `plugins/watchdog.mjs` — 宿主插件：60s 轮询（get_snapshot/get_state 回环）+ in-host session/event 心跳 + 只读路由 `/watchdog/health|status` + 状态变更 Telegram 推送 + 投影落盘 `~/.dsh/watchdog/last-snapshot.json`。
3. `supervisor-mcp-adapter/server.mjs` — 增 `GET /watchdog/health|status`（独立 WATCHDOG 只读 token，proxy 到 3080 同名路由）。
4. `mobile-widget/` — 自建最小 Android Widget APK（aapt2+javac+d8，零第三方依赖，零 mutation）。
5. CI：`tests/watchdog/test-watchdog-core.mjs` 接入 ci-level2。

## Authority Map（不变量）

`Supervisor / Official Session+Goal / Router / Harness = 唯一权威` → bridge（既有控制面）← watchdog（只读观察 + 同 goal 有界恢复调用者，仅经 `send_correction` 既有幂等 mutation）← Widget/手机（纯只读消费）。**无第二 Task DB / Task Engine / Router / Billing Authority。**

## 自动决策记录（无人值守决策策略）

- D1 恢复指令文本固定为最小安全句（"continue"），不改写用户目标 → 幂等 + 无意图漂移。
- D2 恢复只允许 correction(kind=CORRECTION, mode=steer)，禁 cancel/review/dispatch → 最小权限。
- D3 P3 goal（sg-b734914c…）写入硬 denylist，另加规则：非 active 控制态永不恢复 → 双保险冻结。
- D4 计费字段 V1 全 `UNAVAILABLE`（不接 provider key，避免插件触碰凭据面）。
- D5 Widget token 独立生成（`~/.dsh/watchdog/token`），与 MCP 入口/bridge 上游 token 分离 → 最小权限。
- D6 UI 层补充 OFFLINE/UNKNOWN，不写入 Supervisor 权威枚举。
