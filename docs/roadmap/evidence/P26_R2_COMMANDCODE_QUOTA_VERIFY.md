# P2.6 R2 — CommandCode 主力配额耗尽跨 Provider 回落验证报告

日期：2026-08-28 ｜ 会话：session-a144fe3f ｜ 状态：实现 + 验证完成（未提交 PR；本地部署）

## 背景与目标（Blocker A）

R1 已把 1310/QUOTA_EXHAUSTED 分类为不可重试 + unavailableUntil defer，并建立
「EC 发 recovery requirement → Router 消费并跨模型改写」的 typed bridge（R5 架构）。
但 R1 的 bridge 只覆盖 **openrouter 分支**（resolved.provider === "openrouter"）。

**Blocker A（R2 目标）**：主力 provider 已是 **commandcode**（agent-default-model =
`commandcode/auto`，commandcode 网关经 openai-completions 提供 DeepSeek 推理模型）。
当 commandcode 主力遇到 1310 配额耗尽时：
1. EC 已按 R1 语义发出 `quota_exhausted` recovery requirement；
2. 但 Router 的 agent/request 在 `resolved.provider !== "openrouter"` 分支**只处理 opencode
   forcedOpenRouter 回落**，commandcode 主力被原样放行 → **requirement 无人消费、配额死循环**。

R2 交付：在 commandcode 主力分支消费该 requirement 并跨 provider 改写（openrouter 不同配额池），
复用既有 `pickQuotaRouteTarget` 决策（零第二引擎）。

## 改动（plugins/openrouter-router.mjs，未提交）

- `isPrimaryModel(provider, model)`：识别 commandcode 主力（`auto` / `commandcode/auto`）。
- `agent/request` 非 openrouter 分支新增：`resolved.provider === "commandcode"` 且为主力模型时，
  若 session 存在 reason 匹配 `/quota_exhausted/i` 的 recovery requirement →
  **先 ack（置 null）再改写**为 openrouter + `pickQuotaRouteTarget` 目标模型
  （无替代则保持原路由并记录 quota-no-alternative）。requirement 由目标 provider 单主消费
  （沿用 R5 单主消费设计，无 stale carry-over）。
- openrouter 分支 R1 既有 quota-route-switch 逻辑不变（回归验证 V4）。

## 验证（verify-p26-r2-commandcode-quota.mjs，9/9 PASS）

| ID | 断言 | 结果 |
|---|---|---|
| V1a | EC 对 commandcode session 发出 quota requirement（typed bridge 触达 Router） | PASS |
| V1b | Router 存储该 requirement | PASS |
| V1c | provider 被改写 commandcode → openrouter | PASS |
| V1d | 模型移出耗尽路由（→ deepseek/deepseek-v4-flash-0731） | PASS |
| V2a | apply 后 requirement 被消费（ack，req=null，无重复消费） | PASS |
| V3a | 无 requirement 时 commandcode/auto 不被改写（不误伤正常主力流量） | PASS |
| V3b | 无残留 stale requirement 被消费 | PASS |
| V4a | openrouter 分支既有 quota-route-switch 回归（仍切走耗尽模型） | PASS |
| V4b | openrouter requirement ack 语义回归 | PASS |

## 回归（R1 全量重跑）

| 套件 | 结果 |
|---|---|
| verify-p26-r1-quota-defer.mjs | 18/18 PASS |
| verify-p26-r1-network-error.mjs | 20/20 PASS |
| verify-p26-r1-rollback-switch.mjs | ALL PASS（含开关 OFF 恢复语义） |
| verify-p26-r2-commandcode-quota.mjs | 9/9 PASS |

合计 47+ 断言 0 fail。全部脚本以 `node --no-warnings` 直接运行正常退出（exit=0）；
`--trace-exit` 证实 process.exit 确实执行。⚠️ 工具层注意：`node ... 2>&1 | Select-Object`
管道会因 node 的 stderr 警告（NativeCommandError）造成**伪超时**，非脚本缺陷。

## 部署与回滚

- 备份：`DSH-Client/_backup-p26-r2/`（openrouter-router.mjs.20260828-180756.bak +
  settings.yaml.20260828-180756.bak）。
- 回滚：将 `.bak` 覆盖回 plugins/ 对应文件即可（settings.yaml 备份仅记录 commandcode
  主力配置现场，无改动）。
- 未提交 git（工作区 `M plugins/openrouter-router.mjs` + `?? tests/continuity/verify-p26-r2-commandcode-quota.mjs`）。

## 已知问题（非本次引入，R1 既有）

- **Router 惰性连接残留**：`agent/request` 路径产生 1 个 Socket 句柄（原版备份同样残留，
  为既有行为，来源为容量解析/诊断遥测的惰性探测）。测试脚本顶层断言后 `process.exit(0)`
  已规避；不影响运行中的服务（进程常驻）。后续若做进程级诊断需 `--trace-exit` 区分真退出
  与工具管道伪超时。

## 结论

R2 使 commandcode 主力配额耗尽能自动跨 provider 落到 openrouter（不同配额池），
补齐 R5 typed bridge 对主力 provider 的覆盖，无第二引擎、无行为回归。状态维持
**IMPLEMENTATION_COMPLETE / AWAITING_EXTERNAL_REVIEW（R1 授权范围内增量）**。
