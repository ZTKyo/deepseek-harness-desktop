# EXECUTION_ECONOMY_V1_FINAL_VALIDATION

**日期**：2026-08-21
**分支**：execution-economy-v1 @ `8098c7ca7562ea4804c895136e906fef6c18c0b0`
**PR**：#3（OPEN）
**Base**：main @ `3f4208c7c01b9bdf437de421809c098f6d778ee4`

---

## 1 Executive Summary

三个证据缺口逐一补齐（隔离性 / 真实 Harness Trial Route generation / 真实 Agent 行为 replay）。
**两个 PASS，一个 FAIL**：

- Replay Isolation：**PASS**（唯一临时 route + try/finally fail-safe cleanup，3s）
- Real Harness Trial Route Generation：**PASS**（真实 Harness runtime 经独立 Trial Route 完成 generation，request/header 证实走 ox-alpha，18s）
- Policy Behavioral Compliance：**FAIL**（新 Agent 加载了 Policy，但未在预算内完成；陷入 router/GUI 研究；不过**独立发现了真实技术阻塞**——openrouter 主 route 下显式选 ox-alpha 会被 router 改写为 auto）

**FINAL VERDICT = NOT READY TO MERGE**
（Policy 行为合规未达验收线；发现的 Router 行为需在后续独立阶段处理，本阶段禁止修改 Router）

## 2 PR / Git State

- branch：execution-economy-v1 @ 8098c7c（未变）
- PR：#3 OPEN，CI L1 PASS + L2 PASS（未重跑，代码未改；本次仅新增验证文档+测试，将 push 更新）
- main / Reliability tag 未触碰

## 3 Changes Made During Validation

- `tests/execution-economy/Test-ExecutionEconomyReplay.ps1`：隔离性修正（唯一临时 route `openrouter-ee-test-<guid>` + try/finally fail-safe cleanup + 移除直连 key 读取）
- `tests/execution-economy/Test-HarnessTrialRouteGeneration.ps1`：**新增**（真实 Harness Trial Route generation 验证，manual/live）
- `docs/execution-economy/EXECUTION_ECONOMY_V1_FINAL_VALIDATION.md`：**新增**（本文件）
- `docs/execution-economy/EXECUTION_ECONOMY_V1_REPORT.md`：Capability/Behavior 区分更新

## 4 Replay Isolation Fix

| 项 | 结果 |
|---|---|
| 唯一临时 route | `openrouter-ee-test-<guid>`（每次运行随机，无碰撞） |
| try/finally cleanup | PASS（断言失败/超时/异常均走 finally） |
| cleanup 后 settings 无残留 | PASS |
| cleanup 后 llm.models 无残留 | PASS |
| 既有 route 无覆盖 | PASS（9 个 route 前后一致） |
| stable catalog 不变 | PASS（5 项一致） |
| primary 不变 | PASS（commandcode/auto） |
| 直接 key 读取 | 已移除（不再读 ~/.dsh/.credentials.yaml） |
| Wall clock | 3s |

## 5 Real Harness Trial Route Generation

**PASS**

- route id：`openrouter-ee-test-66e81ae6`（唯一临时）
- model：`stealth/ox-alpha`
- 方式：`settings.mutate` 创建 route → `agent-default-model` 临时指向 trial route → `session.create` → `session.prompt("Reply exactly: OK")` → 等 turn/end
- **generation completed 证据**：`turn/end reason.kind=completed`；`request/header` 记录 `provider=openrouter-ee-test-66e81ae6, model=stealth/ox-alpha`
- **关键机制发现**：`openrouter-router.mjs` 只在 `provider === "openrouter"`（精确匹配）时改写（第 209/323 行）；独立 Trial Route id **天然绕过 router**，请求直达 ox-alpha —— 这正是 §28 Trial Route 方案的价值
- cleanup：primary 恢复 commandcode/auto、route 无残留、catalog 不变
- wall clock：18s（含 45s 预算内的轮询）
- 无 credential 输出/打印

## 6 Real Agent Behavioral Replay

**FAIL（未达验收线），但有重大发现**

- 方式：全新 Harness session（cwd=_release-staging，确认加载 Execution Economy AGENTS.md：`Instructions from:` + `CLASSIFY` + `Execution Economy` 均在会话注入中）
- 任务：等价 ox-alpha 的隔离任务（不给步骤，只给 facts）
- 观察到的行为：
  - 任务分类：**未显式分类**（无 FAST 声明）
  - 验证路径：先 `web_search`（3 查询）→ 读 settings.yaml/provider-registry/router 源码 → 读了我写的测试脚本 → `read_secret` + 直连 HTTP probe（**违反 Machine-First 和 §5 禁止直连**）→ 转向 Invoke-Rpc 走 settings API → 深入 router 研究 → 准备读 GUI 前端源码
  - tool calls：35+（pwsh 22 / read 10 / web_search 1 / read_secret 1 / grep 1 / secret_status 1）
  - wall clock：>10 分钟（被取消时仍在跑）
  - GUI/Screenshot/Vision：0（good）
  - same-path failures：Invoke-Rpc function 重复定义多次（同一动作重复）
  - Human questions：0
  - Scope creep：YES（web_search 研究 + router 源码深入 + 计划读 GUI 前端——超出"最小接入"）
  - STOP discipline：**未达成 DoD 即未 STOP**（取消时仍在中途）
- **重大发现（行为 replay 的核心价值）**：Agent 独立发现了真实技术阻塞——
  `openrouter-router.mjs` 的 `deriveRequestedMode()` 只识别 `auto/qwen/deepseek/mimo`；
  `stealth/ox-alpha` 落到 `auto` → 三模型路由 → 默认 deepseek。
  **在 openrouter 主 route 下显式选 ox-alpha 会被改写为 deepseek**。
  这解释了原始 ox-alpha 任务"路由到 MiMo/DeepSeek"的深层机制（我此前解释不完整），
  也解释了 Stage B 若用 openrouter 主 route 会失败——但 **Trial Route 方案规避了它**。

## 7 Capability vs Behavioral Evidence

| 项 | 结果 | 证据 |
|---|---|---|
| Fast Path Capability | **PASS** | 隔离 replay 3s：注册→热生效→验证→删除→cleanup |
| Harness Trial Route Generation | **PASS** | 真实 runtime 18s：turn completed + request/header 证实 ox-alpha |
| Policy Behavioral Compliance | **FAIL** | 新 Agent 加载 Policy 但未遵守 FAST 预算/Machine-First/STOP；35+ calls 未完成 DoD |

## 8 Stable State Protection

| 项 | 结果 |
|---|---|
| stable openrouter catalog | 5 项不变（auto/qwen/deepseek/mimo/ox-alpha） |
| 既有 provider routes | 9 个不变 |
| agent-default-model | commandcode/auto 不变 |
| trial residue | 无（3 次测试均无残留） |
| credential leak | 无（全程未打印 key；行为 agent 曾 read_secret 但未输出明文） |
| restart | 无 |

## 9 Failure Path Tests

| TEST | 结果 |
|---|---|
| 唯一临时 route 创建 | PASS |
| runtime registry 可见 | PASS |
| 真实 Harness generation completed | PASS |
| stable catalog 不变 | PASS |
| primary 不变 | PASS |
| 错误 model id 快速失败 | PASS（probe 失败无重试风暴） |
| schema 拒绝无 partial state | PASS（settings-rejected） |
| cleanup fail-safe | PASS（try/finally 双验证） |
| TEMP_ROUTE 无残留 | PASS |
| 无 GUI/Screenshot/Vision | PASS（结构性） |

## 10 Reliability Regression

- COMMIT_READY：PASS（7 项 + stable window）
- Process Identity / host.describe / session.list：PASS
- events.mux / events.host：PASS（WS open）
- Renderer：PASS
- Guardian running：PASS（PID 9608）
- Restart Budget：PASS（normal）
- Sessions readable：PASS（268）
- Diagnostics redaction：PASS（此前的 13 文件扫描）
- Tool Output Offload：未改
- Transaction / Verified Last Good / Safe Mode：未触碰

## 11 CI

- CI Level 1（Static + secret + syntax）：PASS（46s）—— 之前运行
- CI Level 2（Reliability state machines）：PASS（28s）—— 之前运行
- 新增的 `Test-HarnessTrialRouteGeneration.ps1` 为 **manual/live**（依赖真实 OpenRouter + 凭据），**不进公共 PR CI**（符合 §19 口径）
- 注：本次 push 更新测试后 CI L1/L2 将重跑（新增文件需过 syntax/secret gate）

## 12 Remaining Risks

1. **Router 改写行为（真实技术阻塞）**：openrouter 主 route 下显式选非三模型（如 ox-alpha）会被 `deriveRequestedMode` 当作 auto 改写。Trial Route 规避了它，但用户在 openrouter 主 route 手动选 ox-alpha 仍会路由到 deepseek。**需独立阶段处理（本阶段禁止改 Router）**。
2. **Policy 行为合规未达成**：AGENTS.md 已加载但不足以约束新 Agent 的 FAST 预算/Machine-First 行为。可能需要 §35 的 Thin Helper（wall-clock deadline / 强制 machine-first）——**但需独立验证，不在此阶段实现**。
3. 行为 replay 中 Agent 读取了测试脚本作为参考（说明"测试脚本存在于仓库"本身会引导 Agent 模仿——这是双刃剑）。

## 13 Final Verdict

# **NOT READY TO MERGE**

- Replay Isolation：PASS
- Real Harness Trial Route Generation：PASS
- **Policy Behavioral Compliance：FAIL**（未达验收线）
- 发现真实技术阻塞（Router 改写 ox-alpha），需后续独立阶段处理
- 按 §22 验收标准，行为合规为硬性条件，未满足 → NOT READY TO MERGE

**后续建议（独立阶段，不在本 PR）**：
1. 处理 `deriveRequestedMode` 对非三模型的放行（Router 行为，需单独设计+测试）
2. 评估 Thin Helper（wall-clock deadline + machine-first 强制）是否必要
3. 重新跑行为 replay 验证 Policy 合规
