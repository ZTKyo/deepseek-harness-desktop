# Phase 02.8 WATCHDOG / Mobile Monitor — REPORT R1

日期：2026-08-31 ｜ 分支：`phase-02-8-watchdog-mobile-monitor`（基线 main=fd26b08）｜ 状态：**AWAITING_REVIEW**（等待 External Review；禁自行 VERIFIED）

## 1. 交付组件（全部新增，零核心修改）

| 组件 | 说明 |
|---|---|
| `plugins/watchdog-core.mjs` | 纯函数核：状态投影（IDLE/RUNNING/STALLED/RECOVERING/AWAITING_REVIEW/BLOCKED/VERIFIED + UI 层 OFFLINE/UNKNOWN）、进展信号 stall 判定（revision/evidence/session running/nextExpectedAction，非纯时长）、有界恢复策略（episode/日预算 + 幂等 commandId + denylist）、脱敏 schema |
| `plugins/watchdog.mjs` | 宿主插件：60s 回环只读拉取（supervisor-bridge get_snapshot/get_state，同一权威面）+ in-host session/event 心跳 + 只读路由 `/watchdog/health`、`/watchdog/status`（Bearer token）+ 状态变化 Telegram 推送（spawn 既有 telegram-alert.ps1，同 completion-notify 模式）+ 脱敏投影落盘 `~/.dsh/watchdog/last-snapshot.json` |
| `supervisor-mcp-adapter/server.mjs` | +62 行：`GET /watchdog/health|status` 只读 proxy 到 3080 同名路由（复用 p275 既有隧道边界，零新开裸端口；watchdog 独立 token） |
| `mobile-widget/` | 自建最小 Android 只读 Widget V1（aapt2+javac+d8+zipalign+apksigner 零第三方依赖；WatchdogConfigActivity 配置端点+token；仅 INTERNET 权限，零 mutation） |
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
| 4 长任务不因"时间长"误判 STALLED | 进展信号判定 + 2 次确认 | T2 |
| 5 人工制造无进展可检测+预算内恢复 | core 逻辑+单测覆盖；端到端实弹未执行（见 §5 F1） | T3 |
| 6 AWAITING_REVIEW/VERIFIED 明确显示 | live 投影实测 AWAITING_REVIEW 正确显示 | T1/T5/T6 |
| 7 模型/Provider 真值投影；计费拿不到→UNKNOWN | settings PRIMARY 投影 + UNAVAILABLE 如实标注 | T10/T11 |
| 8 Widget 零 mutation | 仅 INTERNET 权限；代码无 POST/mutation 面 | T8；badging |
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
