# P2.6 R1.1 — direct managed provider 配额耗尽跨池回退验证报告（Blocker 1）

日期：2026-08-28 ｜ 会话：session-a144fe3f ｜ 状态：实现 + 验证完成（随 R1.1 PR 提交；未单独部署到运行 profile）

## 背景与目标（Blocker 1）

R1 把 1310/QUOTA_EXHAUSTED 分类为不可重试（无窗口）+ unavailableUntil defer 语义，
并建立「EC 发 recovery requirement → Router 消费并改写」的 typed bridge；R2 覆盖
commandcode 主力分支。R1.1 补齐最后一类主力 provider —— **direct managed provider
（zhipu/bai）**：

1. EC 对 zhipu/bai 主力同样发出 `quota_exhausted` recovery requirement，并记录
   `sourceProvider` / `sourceModel`（provenance，供 Router 决策依据）；
2. Router 泛化 `isPrimaryModel`（覆盖 zhipu/bai/opencode/commandcode），在
   `resolved.provider !== "openrouter"` 分支消费 quota requirement 并跨 provider 改写
   openrouter（不同配额池），复用既有 `pickQuotaRouteTarget`（**零第二引擎**）；
3. 未命中 quota requirement 的 managed provider 流量原样放行（不误伤）。

## 改动（repo 工作区，随 R1.1 PR 提交）

- `plugins/openrouter-router.mjs`：`isPrimaryModel` 泛化 + managed-direct quota requirement
  消费分支；复用 `pickQuotaRouteTarget`。
- `plugins/execution-continuity.mjs`：quota requirement 携带 `sourceProvider`/`sourceModel`。
- `tests/continuity/verify-p26-r1-1-managed-direct-quota.mjs`：R1.1 验证套件（15 断言）。

## 验证（verify-p26-r1-1-managed-direct-quota.mjs，15/15 PASS）

| ID | 断言 | 结果 |
|---|---|---|
| V1a | EC 对 zhipu session 发出 quota requirement（reason 含 quota_exhausted） | PASS |
| V1b | Router 存储该 requirement（recoveryRequirement 含 quota_exhausted） | PASS |
| V3a | sourceProvider 记录 = zhipu | PASS |
| V3b | sourceModel 记录 = glm-4.6 | PASS |
| V1c | provider 被改写 zhipu → openrouter | PASS |
| V1d | 模型移出耗尽路由（→ deepseek/deepseek-v4-flash-0731） | PASS |
| V2a | EC 对 bai session 发出 quota requirement | PASS |
| V2b | provider 被改写 bai → openrouter | PASS |
| V2c | 模型移出耗尽路由（→ deepseek/deepseek-v4-flash-0731） | PASS |
| V4a | commandcode 回归：仍改写 → openrouter | PASS |
| V4b | commandcode 回归：模型移出 auto 路由 | PASS |
| V5a | 无 requirement 时 zhipu 原样放行（不误伤） | PASS |
| V5b | 无残留 stale requirement 被消费 | PASS |
| V6a | openrouter 分支既有 quota-route-switch 回归（仍切走耗尽模型） | PASS |
| V6b | openrouter requirement ack 语义回归 | PASS |

实测输出（2026-08-28 全量重跑，`node --no-warnings tests\continuity\verify-p26-r1-1-managed-direct-quota.mjs`）：

```
PASS  V1a EC emitted quota requirement for zhipu session  {"requirement":true,"reason":"quota_exhausted: router-decided route switch","modalities":[],"used":false,"sourceProvider=zhipu ...}
PASS  V1b Router stored the requirement
PASS  V3a sourceProvider recorded  sourceProvider=zhipu
PASS  V3b sourceModel recorded  sourceModel=glm-4.6
PASS  V1c provider rewritten zhipu -> openrouter  provider=openrouter
PASS  V1d model moved off exhausted route  model=deepseek/deepseek-v4-flash-0731
PASS  V2a EC emitted quota requirement for bai session
PASS  V2b provider rewritten bai -> openrouter  provider=openrouter
PASS  V2c model moved off exhausted route  model=deepseek/deepseek-v4-flash-0731
PASS  V4a commandcode still rewritten -> openrouter  provider=openrouter
PASS  V4b model off auto route  model=deepseek/deepseek-v4-flash-0731
PASS  V5a zhipu untouched without requirement  provider=zhipu model=glm-4.6
PASS  V5b no stale requirement consumed
PASS  V6a openrouter branch still switches off exhausted model  model=xiaomi/mimo-v2.5
PASS  V6b openrouter requirement ack'd

15 pass, 0 fail
```

## 回归（2026-08-28 实测）

| 套件 | 结果 |
|---|---|
| verify-p26-r2-commandcode-quota.mjs | 9/9 PASS |
| verify-p26-r1-quota-defer.mjs | 18/18 PASS |
| verify-p26-r1-network-error.mjs | 20/20 PASS |
| verify-p26-r1-rollback-switch.mjs | ALL PASS |
| test-failure-classifier-v1.mjs | 31/31 PASS |
| verify-p26-r3-retry-policy.mjs（R3 本地线，正交） | 41/41 PASS |

合计 134+ 断言 0 fail。全部脚本 `node --no-warnings` 直接运行正常退出（exit=0）。

## Blocker A 第 1 项配置证据（同路重试=0 的全生产路径闭合）

1310 不被官方层吞掉的配置链已核实（2026-08-28）：

1. **official dsh-llm-retry core**（`@deepseek-ai/dsh-llm-retry` lib/index.js，只读引用）：
   - `recover()` 在 `policy === undefined` 时**直接 `next()`**（L129-130）→ 无 retryPolicy 的
     provider 天然 same-route retry=0；
   - `!policy.retryableCodes.includes(failure.code)` → `next()`（L138）→ 已配置 provider 仅对
     `EMPTY_RESPONSE/SERVER/TIMEOUT/TRANSPORT` 重试，**不含 RATE_LIMIT**。
2. **settings.yaml**（运行 profile）：opencode / opencode-qwen / opencode-free / openrouter /
   agentrouter-openai / commandcode 六 provider 均显式 `retryPolicy`，`retryableCodes` 仅
   `EMPTY_RESPONSE/SERVER/TIMEOUT/TRANSPORT`（RATE_LIMIT 已移除）；zhipu / bai 未配
   retryPolicy → 命中 core `policy === undefined` 分支 → retry=0。**全生产路径（含
   zhipu/bai）1310 均不会被官方层同路盲重试，直达 EC classifier。**
3. **EC classifier** → 1310 → `QUOTA_EXHAUSTED`（不可重试/无窗口 + unavailableUntil）→ 发
   quota requirement（含 sourceProvider/sourceModel）→ Router 消费并跨池改写 openrouter。
4. **禁改 @deepseek-ai/dsh core**：本项仅通过 provider retryPolicy seam（settings.yaml）配置，
   未改动任何 core 文件。

## 部署与回滚（如实记录）

- R1.1 改动当前仅在 repo 工作区，未部署到运行 profile（`~/.dsh/profiles/web/`）。
  运行 profile 的 router 为 R1 版本（BD453674），EC 为 R3 中间态（含 R3 guard、不含
  sourceProvider）。R1.1 随 PR 合入后，按 R1 事务流程统一部署。
- R1.1 与 R3 为同一文件（EC/router）上的两组正交改动，合并部署前需重跑双方套件
  （见 R1.1 报告「后续」）。
- 备份：`DSH-Client/_backup-p26-r2/`（R2 线留存，含 openrouter-router.mjs 与
  settings.yaml 现场）。R1.1 无独立部署，回滚 = git revert PR。

## 结论

direct managed provider（zhipu/bai）1310 配额耗尽全路径闭合：官方层不盲重试（retry=0，
含未配 retryPolicy 的 zhipu/bai）→ EC 分类 + 发 requirement（带 provenance）→ Router 泛化
消费并跨池改写 openrouter；未命中不误伤；无第二引擎、无 core 改动、无行为回归。
状态 **IMPLEMENTATION_COMPLETE / AWAITING_EXTERNAL_REVIEW**（R1 授权范围内增量，随 R1.1 PR 提交）。
