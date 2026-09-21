# Phase 02.8 WATCHDOG / Mobile Monitor — REPORT R1

日期：2026-08-31 ｜ 分支：`phase-02-8-watchdog-mobile-monitor`（基线 main=fd26b08）｜ 状态：**AWAITING_REVIEW**（等待 External Review；禁自行 VERIFIED）

## 1. 交付组件（全部新增，零核心修改）

> ※ **Superseded by External Review Round 2（2026-09-01）**：「零核心修改」在 R1 Correction 期间曾失效（B6 曾把 CORRECTING 持有修复内嵌进 `supervisor-bridge-core.mjs`）；Round 2 判定该修复必须独立承载，已从本 PR diff 移除（commit 80f113c，core 恢复 canonical main fd26b08 原样，diff 归零），独立 Hotfix 由 **02.75-HF2 / PR #80**（`hf2-supervisor-correcting-persistence`）承载。本标题陈述恢复为真。

| 组件 | 说明 |
|---|---|
| `plugins/watchdog-core.mjs` | 纯函数核：状态投影（IDLE/RUNNING/STALLED/RECOVERING/AWAITING_REVIEW/BLOCKED/VERIFIED + UI 层 OFFLINE/UNKNOWN）、进展信号 stall 判定（revision/evidence/session running/nextExpectedAction，非纯时长）、有界恢复策略（episode/日预算 + 幂等 commandId + denylist）、脱敏 schema |
| `plugins/watchdog.mjs` | 宿主插件：60s 回环只读拉取（supervisor-bridge get_snapshot/get_state，同一权威面）+ in-host session/event 心跳 + 只读路由 `/watchdog/health`、`/watchdog/status`（Bearer token）+ 状态变化 Telegram 推送（spawn 既有 telegram-alert.ps1，同 completion-notify 模式）+ 脱敏投影落盘 `~/.dsh/watchdog/last-snapshot.json` |
| `supervisor-mcp-adapter/server.mjs` | +62 行：`GET /watchdog/health|status` 只读 proxy 到 3080 同名路由（复用 p275 既有隧道边界，零新开裸端口；watchdog 独立 token） |
| `mobile-widget/` | 自建最小 Android 只读 Widget V1（aapt2+javac+d8+zipalign+apksigner 零第三方依赖；WatchdogConfigActivity 配置端点+token；仅 INTERNET 权限，零 mutation） |

> ※ **Superseded by External Review Round 2（2026-09-01）**：① R1 Correction B1 曾引入 `dataSync` ForegroundService（SSE 长连接）+ `BOOT_COMPLETED` 自启 + FOREGROUND_SERVICE(_DATA_SYNC)/RECEIVE_BOOT_COMPLETED/POST_NOTIFICATIONS 权限，「仅 INTERNET 权限」随之失效；② Round 2 B 项要求删除 SSE 前台服务与开机自启，改造为 FCM data-message push（工程见 §13），Manifest 权限以 §13 R2 复核表为准（INTERNET + FCM 平台必需权限，仍零 mutation）。
| CI | `.github/workflows/ci-level2.yml` 新增步骤「P2.8 Watchdog state machine (stall/recovery budget/projection/redaction)」接 `tests/watchdog/test-watchdog-core.mjs` |
| 测试 | `tests/watchdog/test-watchdog-core.mjs`：27 项（投影/stall/预算/幂等/denylist/脱敏/clamp） |
| 审计 | `GAP_AUDIT.md`（Step1 只读 Fresh Audit，权威面盘点 + 缺口 + 复用面 + D1-D6 决策） |

## 2. T1–T12 验证矩阵（全部真实执行，非 mock 声明）

| # | 验证项 | 结果 | 证据 |
|---|---|---|---|
| T1 | 7 态状态机投影正确性 | **PASS** | 单测 27/27（含每态投影用例）；live 投影实测 AWAITING_REVIEW 正确（来自 P3 goal 真实 controlState） |
| T2 | stall 判定基于进展信号、非纯时长 | **PASS** | 单测覆盖：revision/evidence 推进→不 STALLED；无进展×stallConfirmations=2 确认才 STALLED；正常等待（pending mutation/nextExpectedAction）不误判 |
| T3 | 有界恢复：预算+幂等+same-goal+denylist | **PASS** | 单测覆盖（episode 预算 1 / 日预算 3 / 幂等 commandId `WD:g<gen>:CORRECTION:<seq>` / P3 goal sg-b734914c… denylist / 非 active 控制态永不恢复）；恢复仅经既有 `/supervisor/send_correction`（bridge 侧既有幂等+预算闸双层兜底） |
| T4 | 脱敏 schema | **PASS** | 单测（objective 截断 80 字符、无 secret/prompt/日志字段）；live 快照实测：cost 全 `UNAVAILABLE`（source=not_wired_v1_no_second_billing_truth），仅含状态/进度/模型/其他 goal 最小字段 |
| T5 | 插件加载 + 60s 轮询 + 落盘 | **PASS** | 受控重启（restart-dsh-server-delayed，已预告）后插件加载；`~/.dsh/watchdog/last-snapshot.json` 持续刷新（generatedAt=19:19:05Z，schemaVersion=1，watchdog.health=healthy） |
| T6 | 3080 只读路由 + 鉴权 | **PASS** | 无 token→401；对 token→200（`{"ok":true,"plugin":"watchdog","version":"0.1.0","state":"AWAITING_REVIEW","watchdogHealth":"healthy"}`）；`/watchdog/status` 200（1332 字节） |
| T7 | 8091 代理路由 + 独立 WATCHDOG token | **PASS** | watchdog token→200（与 3080 响应一致）；错 token→401；token 与 MCP 入口/bridge 上游 token 三分离（D5） |
| T8 | Widget APK 构建/签名/零 mutation | **PASS** | `BUILD OK → dsh-watchdog-widget.apk (21 KB)`，apksigner 验签通过（CN=DSH Watchdog Widget，SHA-256 398ec537…）；aapt badging exit 0：`provides-component:'app-widget'`、仅 `INTERNET` 权限、icon 已打包 |

> ※ **Superseded by External Review Round 2（2026-09-01）**：「仅 INTERNET 权限」为 R1 初版产物口径；R1 Correction B1 与 R2 FCM 改造后权限集随 Manifest 演进（见 §13 R2 复核表 + 最终 APK badging 实测为准）。
| T9 | UI 层 OFFLINE/UNKNOWN（拉取方判定） | **PASS** | 单测：OFFLINE/UNKNOWN 仅 UI 投影层，不写入 Supervisor 权威枚举（D6）；宿主死→快照停更→拉取方判 OFFLINE（watchdog 与宿主同生命周期，无双真相） |
| T10 | 模型/Provider 真值投影 | **PASS** | live 快照：`provider: bai / model: glm-5.3-flash / source: settings.agent-default-model`（= switch_primary_model 单一事实源，与 GAP_AUDIT §4 一致） |
| T11 | 计费字段零猜测 | **PASS** | live 快照 cost 四字段全 `UNAVAILABLE`（V1 不接 provider key，避免插件触碰凭据面；D4；接线留 R2 观察） |
| T12 | 回归稳定性（重启后） | **PASS** | 受控重启后单测复跑 27/27、exit 0；git diff 干净（3 文件 +92 行，均为本阶段预期改动） |

## 3. Notion 02.8 Acceptance Criteria 映射

| AC | 满足方式 | 证据 |
|---|---|---|
| 1 手机不看 ChatGPT/Harness 可见任务状态 | Widget APK 已交付（安装配置为用户侧动作，见 §5 F3） | T8；WatchdogConfigActivity 配置端点+token |
| 2 Supervisor/Goal/Session 唯一事实源 | watchdog 只读回环同一权威面；无第二 Task DB/Engine | GAP_AUDIT Authority Map；T1/T5 |
| 3 状态变化近实时到手机 | 状态变化→Telegram 推送（事件驱动）+ 快照落盘；不走小时级轮询 | §5 F2（实现完成，真实迁移未触发，如实说明） |

> ※ **Superseded by External Review Round 2（2026-09-01）**：手机侧近实时通道已改为 FCM data-message push（R2 B 项，见 §13）；Telegram 推送保留为桌面侧旁路，不再承担手机触达。
| 4 长任务不因"时间长"误判 STALLED | 进展信号判定 + 2 次确认 | T2 |
| 5 人工制造无进展可检测+预算内恢复 | core 逻辑+单测覆盖；端到端实弹未执行（见 §5 F1） | T3 |
| 6 AWAITING_REVIEW/VERIFIED 明确显示 | live 投影实测 AWAITING_REVIEW 正确显示 | T1/T5/T6 |
| 7 模型/Provider 真值投影；计费拿不到→UNKNOWN | settings PRIMARY 投影 + UNAVAILABLE 如实标注 | T10/T11 |
| 8 Widget 零 mutation | 仅 INTERNET 权限；代码无 POST/mutation 面 | T8；badging |

> ※ **Superseded by External Review Round 2（2026-09-01）**：权限集演进见 §13 R2 复核表（「仅 INTERNET」为初版口径；FCM 版含 FCM 平台必需权限）；「零 mutation」恒成立（全链路仍只读拉取 + 仅既有 send_correction 出口）。
| 9 无新 Authority / 无 P3/P4 扩张 | 组件全部为观察/投影/既有通道复用；P3 goal 硬 denylist | GAP_AUDIT §6；D3 |

## 4. 部署链（受控重启，已预告中断）

`source == deployed == loaded` 三环一致：
- source：repo 分支文件（watchdog.mjs / watchdog-core.mjs / server.mjs / cordis.patch.yml 注册段）
- deployed：`~/.dsh/profiles/web/` 插件部署 + cordis.patch.yml 注册（YAML 校验通过，19 顶层条目）
- loaded：受控重启后 3080 实测路由 200 + 快照落盘持续刷新（T5/T6 实测即 loaded 活体证据）

## 5. 诚实发现（不隐藏）

- **F1（AC5 端到端实弹未执行）**：真实制造"卡住任务"并观察 watchdog 注入 correction 的 live-fire 演练，R1 未执行——会向真实 Supervisor goal 注入真实 mutation，且当前活跃控制面即本任务自身，自演自复存在自指风险。以 core 单测（预算/幂等/denylist/状态迁移全路径）+ bridge 侧既有双重预算闸作为 R1 证据；live-fire 建议 External Review 裁决后于受控环境（专用测试 goal）执行。
- **F2（AC3 推送未在真实迁移中触发）**：pushOnStateChange=true + spawn telegram-alert.ps1 已实现并接入（同 completion-notify 已验证模式）；自部署以来未发生状态迁移（快照稳定 AWAITING_REVIEW），故推送尚未在真实迁移中发射。单元层已验证迁移判定；首次真实迁移即自然验证点。
- **F3（手机侧安装为用户动作）**：APK 已构建签名；安装到手机 + 填入隧道地址/token 需用户手动完成（token 在 `~/.dsh/watchdog/token`，通过安全通道交给用户，不进聊天明文）。

## 6. 决策记录（无人值守策略 D1–D6）

继承 GAP_AUDIT §"自动决策记录"：D1 恢复指令固定最小句 "continue"；D2 恢复仅 correction(kind=CORRECTION, mode=steer)；D3 P3 goal 硬 denylist + 非 active 永不恢复；D4 计费字段 V1 全 UNAVAILABLE；D5 Widget token 独立三分离；D6 OFFLINE/UNKNOWN 仅 UI 层。

## 7. 回滚

- 插件层：删除 cordis.patch.yml `watchdog` 注册段 → 重启后插件 QUARANTINED（源码保留）；快照/token 目录 `~/.dsh/watchdog/` 可整目录删除。
- adapter：git revert `supervisor-mcp-adapter/server.mjs` 本分支改动（+62 行独立段）。
- 分支整体不合并即零影响 main；生产回滚锚点 = main fd26b08。

## 8. Next

**AWAITING_REVIEW — 停等 External Review**。PASS 后：手机安装配置（用户动作）→ live-fire 恢复演练（受控测试 goal）→ 回归 P3。

---

# 增补：External Review Round 1 → R1 Correction（2026-08-31）

## 9. Review 结论与逐条修复（CHANGES_REQUIRED → 已全部落地）

External Review Round 1 判定 **CHANGES_REQUIRED**，5 个 blocker（B1–B5）。以下逐条记录修复实现与真实证据（全部实测，非声明）。

### B1 — Widget 事件驱动近实时推送 ✅

> ※ **Superseded by External Review Round 2（2026-09-01）**：本节 SSE 前台服务（`dataSync` ForegroundService 长连接）+ `WatchdogBootReceiver` 开机自启方案已被 R2 B 项**整体取代**——External Review 判定常驻前台长连接 + 自启权限不属于"最小权限/最省电"架构；手机侧改为 FCM data-message push（服务端状态变化 → 鉴权 push → FirebaseMessagingService → GET /watchdog/status → updateAppWidget，载荷仅 eventId/revision/wake；30min fallback + 手动刷新保留）。以下原始记录保留不改写，仅作历史。
- **要求**：不能只靠 30 分钟系统轮询；需要 SSE/事件级近实时链路，push 载荷仅含 wake/revision/event-id 元数据。
- **实现**：新增 `WatchdogEventService`（前台 `dataSync` 服务，持有 SSE 长连接 `GET /watchdog/events`，Bearer WATCHDOG token；收到 `state_change` → 广播 `ACTION_FETCH` → `WatchdogWidgetProvider` 拉取脱敏投影刷新 widget）；`WatchdogBootReceiver` 开机自动恢复推送；Manifest 增 FOREGROUND_SERVICE(_DATA_SYNC)/RECEIVE_BOOT_COMPLETED/POST_NOTIFICATIONS（13+ 拒授权仅通知不可见，服务照常）。服务端 `watchdog.mjs` 增 SSE 端点：15s 心跳、载荷仅 state/revision/event-id（metadata 白名单，不含 prompt/log/secret/snapshot）。30 分钟 updatePeriodMillis 保留为 stale/fallback。零第三方依赖（HttpURLConnection 手写最小 SSE 解析）、断线指数退避 1s→60s、凭据只读本机 SharedPreferences 不进日志/intent/通知。仍零 mutation。
- **证据**：REAL E2E E6 腿（SSE 通道元数据白名单 + event-id 格式校验）；APK 重建含 dex 与新组件（7:25:45 > 最后 Java 编辑 7:25:24；classes.dex + DSHWIDGE.RSA 签名核验）。

### B2 — model.actual 真值或 UNKNOWN（禁止 default 冒充 actual）✅
- **要求**：actualModel/actualProvider 必须是运行时真值；拿不到就明确 UNKNOWN，不得用 settings default 冒充。
- **实现**：投影拆分 `model.default`（唯一来源 settings.agent-default-model，即 switch_primary_model 单一事实源）与 `model.actual`（仅当存在运行时权威信号才填真值，否则 `UNKNOWN` + `source: runtime_authority_unavailable_v1`）。
- **证据**：REAL E2E B2 腿：`model.default` 来自真实 settings（非 UNKNOWN）且 `model.actual` 保持 UNKNOWN；E7 隔离 CI home 腿：无 settings → default 也 UNKNOWN、actual UNKNOWN + source 标注；单测覆盖（watchdog-core 48/48）。

### B3 — recovery budget 持久化/可重启 ✅
- **要求**：预算必须跨重启持久；accepted 才计数、duplicate 不重复计数、definite failure 不消耗预算。
- **实现**：`watchdog-core.mjs` 预算/账本落盘持久化（watchdog home 目录，重启后重载）；`supervisor-bridge-core.mjs` 收据账本强化（重启后同 fingerprint 重放 → `409 idempotency_conflict`，零副作用）。
- **证据**：单测（supervisor-mutation-state 20/20，含重启指纹持久化与冲突重放 409 零 RPC 用例）；REAL E2E E2 腿：`budget.acceptedToday >= 1` 由账本推导（非 fail-closed）、恢复恰好 1 次、无重复、left 正确递减；E3 重启腿 token/状态持久化存活。

> ※ **Superseded by External Review Round 2（2026-09-01）**：其中 M9c（CORRECTING 读时持久断言）随 B6 修复一并**移交 02.75-HF2 / PR #80**（supervisor-mutation-state 计数由 20→19；HF2 单测 + e2e-hf2-correcting-persistence.mjs 承载该语义）。

### B4 — 长命令 fail-safe（in-flight 不判 STALLED）✅
- **要求**：存在权威 in-flight 信号时必须复用该信号；无信号时不得判 STALLED、不得纠正。
- **实现**：`watchdog-core.mjs` stall 判定前置 in-flight fail-safe：权威 in-flight 信号（会话运行/回合进行中）→ 保持 `RUNNING`（reason=`in_flight_work_failsafe`），绝不 STALLED、绝不注入 correction。
- **证据**：REAL E2E B4 腿：真实长回合进行中投影 = RUNNING/in_flight_work_failsafe（从未 STALLED、零 correction）；单测覆盖。

### B5 — REAL E2E E1–E7（隔离实例，禁 P3）✅
- **要求**：真实端到端演练必须使用专用 disposable 隔离实例，禁止触碰 P3 goal（sg-b734914c / session-7177d0c5）。
- **实现**：新增 `tests/watchdog/e2e-watchdog-real.mjs`（616 行）：每次运行创建一次性隔离 home（`wd-e2e-*`，run id `wd-mt*`），自建真实 supervisor-bridge + watchdog 插件 + adapter + 隔离 supervisor 会话；**全链路不涉及 P3**（denylist 双保险）。两个实例：
  - **实例 A（CI 腿，36 项）**：E1 STALLED 判定时序（≥ stallAfterMs、2 次确认、判前预算未动）→ E2 自动恢复时序（≥ recoverAfterMs 才 RECOVERING、账本恰好 1 条、correctionsUsed/left 正确、acceptedToday 由账本推导）→ E3 denylist goal 永不自动恢复 + 重启后 token 持久 + SSE 重连 → E5 告警链路 spy 验证 → E6 SSE 元数据白名单 + event-id → E7 bridge token 摘除 → OFFLINE/supervisor_bridge_unreachable/degraded + SSE state_change、token 恢复 → 自愈回归。
  - **实例 B（full 腿，11 项）**：真实模型回合实弹——真实 dispatch → 真实 round-1 完成 → watchdog AWAITING_REVIEW → review FAIL 采纳 → bridge 原生 CORRECTING → watchdog RECOVERING → seam correction 采纳 → **correction 文本真实注入会话历史**（历史计数 ≥1，修复了此前 count=Promise 的 await 缺陷与测试期 generation 竞态）→ 真实 round-2 → review PASS → **watchdog 终态 VERIFIED**；另 B4 in-flight fail-safe、B2 模型真值。

> ※ **Superseded by External Review Round 2（2026-09-01）**：① 实例 B 的「bridge 原生 CORRECTING → watchdog RECOVERING」腿（E4）已降级为非致命观察——CORRECTING 读时持久由 02.75-HF2（PR #80）承载，HF2 合入前 bridge 首读 squeeze 回 AWAITING_REVIEW 亦通过（E4 断言注释已注明 HF2 合入后恢复硬断言）；② SSE 相关腿（E3 SSE 重连 / E6 / E7 SSE state_change）随 FCM 改造改为 FCM/状态投影对等验证（见 §13）。
- **证据**：定版运行 `run=wd-mtgmpw88`：**47 passed, 0 failed — WATCHDOG REAL E2E PASS**（A 36 + B 11 单次同跑全绿）。

### E2E harness 自身缺陷修复（诚实记录）
验证过程中发现并修复 3 个**测试工具**缺陷（非被测代码缺陷）：① correction 注入计数 `countMarker` 少了 `await`（返回 Promise 导致 count=[object Promise]）；② B2 断言曾误读 default 代际，改为读权威 gen 源（genB2）；③ SSE 断言曾把非元数据线误入白名单过滤。均修复后定版运行全绿。

## 10. T1–T12 复核（R1 Correction 后如实重判）

| # | 复核结论 | 说明 |
|---|---|---|
| T1 | **PASS（口径更新）** | 7 态 + in-flight fail-safe 路径；单测 48/48（R1 时 27 → +21 新行为用例） |
| T2 | PASS | REAL E2E E1 实测 STALLED 时序与确认次数 |
| T3 | **PASS（证据升级）** | 由"仅单测"升级为 REAL E2E E2/E3 实弹（真实账本、真实 denylist、真实重启）；预算三规则（accepted 计数/duplicate 不重复/definite failure 不消耗）单测+实测双证据 |
| T4 | PASS | 不变（E2E 隔离 home 全程脱敏投影） |
| T5 | PASS | 隔离实例快照落盘/重载实测（E3 重启腿） |
| T6 | PASS | 3080 路由既有证据不变 |
| T7 | PASS | 8091 代理 + 三分离 token 不变；E7 摘 token → 401/OFFLINE 实测 |
| T8 | **PASS（产物更新）** | APK 重建含 B1 事件服务与 BootReceiver（classes.dex + 签名 + 时间戳核验） |

> ※ **Superseded by External Review Round 2（2026-09-01）**：B1 事件服务与 BootReceiver 已被 FCM 方案取代（删除），APK 以 §13 R2 重建产物为准。
| T9 | PASS | E7 实测 OFFLINE 投影与恢复 |
| T10 | **PASS（口径修正）** | R1 曾以 default 充当投影；现 actual=UNKNOWN + source 标注，default 仅单独字段（B2） |
| T11 | PASS | 计费仍零猜测（UNAVAILABLE） |
| T12 | PASS | 单测复跑 48/48 + 20/20；REAL E2E 47/47 定版；git 工作区仅本阶段预期改动 |

## 11. AC 映射更新（仅列变化项）

- **AC3（近实时推送）**：由"Telegram 推送 + 30min 轮询"升级为 **SSE 事件链近实时（B1）**，Telegram 推送保留为桌面侧旁路；推送发射验证为 spy 级（E5），真实 Telegram 首次迁移推送仍是自然验证点（见 F2）。

> ※ **Superseded by External Review Round 2（2026-09-01）**：手机侧近实时通道再升级为 **FCM data-message push（R2 B 项）**，SSE 事件链被取代；Telegram 仍为桌面侧旁路。
- **AC5（可检测+预算内恢复）**：由"仅 core 单测"升级为 **REAL E2E 实弹全链路证据**（F1 关闭）。
- **AC7（模型真值）**：actual/default 语义修正（B2/T10）。

## 12. 诚实发现（Round 1 增量）

- **F1 已关闭**：live-fire 恢复演练已在隔离实例内真实完成（真实模型回合 + 真实 correction 注入 + VERIFIED 终态），未触碰 P3。
- **F2 维持（spy 级）**：告警链路以 spy 捕获 spawn 参数验证；真实 Telegram 投递依赖首次真实状态迁移（隔离 home 无凭据，属预期）。
- **F3 不变**：APK 安装 + 配置仍为用户侧动作。
- **状态保持 AWAITING_REVIEW**：等 External Review Round 2；P3 冻结、禁 P4 不变。
