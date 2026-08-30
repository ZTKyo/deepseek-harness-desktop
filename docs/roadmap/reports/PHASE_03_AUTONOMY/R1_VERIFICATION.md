# P3 AUTONOMY R1 — 验证报告（VERIFICATION）

- 时间：2026-08-30（R1 实现 + 回归全绿后）
- 分支：`p3-autonomy-r1`（自 main @ e2c8f2d），实现提交 `466abc9`
- 部署面：`~/.dsh/profiles/web/`（execution-continuity.mjs + autonomy-state-core.mjs，SHA256 与仓库一致）
- 回滚锚点：`~/.dsh/profiles/web/_pre-p3r1-20260830-034456-execution-continuity.mjs.bak`（pre-R1 部署面）+ git 分支

## 1 实现内容（对应 DESIGN_R1.md §1–§4）

| 设计项 | 实现 | 位置 |
|---|---|---|
| schema v3 autonomy 子对象（9 字段 + caps + write-once） | `emptyAutonomy/sanitizeAutonomy` | `plugins/autonomy-state-core.mjs` |
| ensure() 幂等迁移（v1/v2 → v3，只增不清） | EC `ensure()` 内联迁移 | `plugins/execution-continuity.mjs` |
| 唯一写入者 `applyAutonomyPatch`（sanitize→assign→persist，fail-soft） | EC 私有方法 | 同上 |
| 3 个 agent 工具 autonomy_report / autonomy_verify / autonomy_state | `defineTool` + `ctx.tools.register`（会话作用域） | 同上 |
| 证据纪律：PASS/FAIL 必须带非空 evidence；criterionIndex 白名单 upsert | verify execute 前置校验 | 同上 |
| 恢复注入 `composeResumeMessage(reason, autonomy)`（空状态零注入=现状） | 导出函数 | 同上 |
| dsh-tools 软导入（repo 导入无 node_modules 时禁用工具面、恢复链路不受影响） | TLA try/catch import | 同上 |
| 纯模块单测 54 断言 + 部署路径集成 32 断言 | `tests/autonomy/` | 新增两个套件 |
| Policy 文档（无人值守决策策略，两处一致） | ~/.dsh/AGENTS.md 任务收资协议第 5 条 + 工作区 AGENTS.md 独立节 | 文档 |

## 2 测试证据（全部实跑）

**新增套件**
- `tests/autonomy/test-autonomy-state-core.mjs` → **54 PASS / 0 FAIL**（caps、write-once、enum 白名单、upsert last-write-wins、derive 四态、进度行、FIFO 淘汰、evidenceClass 默认）
- `tests/autonomy/test-ec-autonomy-deployed.mjs` → **32 PASS / 0 FAIL**（I1 迁移 / I2 legacy 保留 / I3 patch 白名单+持久化 round-trip / I4+I5 三工具 execute 语义含 write-once·里程碑·VERIFIED/FAILED 派生·证据纪律 / I7 恢复消息注入与 redo-avoidance / I8 跨 store 实例重启模拟）

**EC 回归（20 个套件全绿，全部 exit 0）**
- 核心恢复链路：verify-execution-continuity / multitask-recovery(6) / nonrecoverable-states(19) / waiting-user-gate(12) / compaction-scope(18) / haspendingquestion-real
- crash-safety：execution-continuity-crashsafe-test（repo 相对导入 → 验证软导入路径）+ faultinjection-test
- P26 家族（7）：network-error / quota-defer / managed-direct-quota / quota-no-alternative / commandcode-quota / official-retry-zero / retry-policy
- Reliability（3）：ec-router-bridge(14) / r5-addendum-ec(90) / resume-defer(12)

## 3 关键失败→修复记录（Failure Ledger）

| # | 症状 | 根因 | 修复 | 复跑 |
|---|---|---|---|---|
| 1 | 集成套件 53/1：无证据 PASS 未被拒 | 工具层只校验 criterionIndex 分支的证据 | verify execute 前置：PASS/FAIL 必须非空 evidence + status 枚举校验 | 32/0 |
| 2 | crashsafe ENOENT 读旧文件名 | 测试残留 `execution-continuity-intents.json` 旧命名（实际 `execution-intents.json`） | 修正测试路径 | pass |
| 3 | crashsafe ERR_MODULE_NOT_FOUND dsh-tools | repo 相对导入无 node_modules 解析裸导入 | EC 改 TLA try/catch 软导入；不可用时跳过工具注册并 warn，恢复链路零依赖 | pass |
| 4 | 全量批跑 420s 超时误判 router-bridge 挂死 | 累计超时预算耗尽，非挂死 | 单独复跑 14/0 | pass |

## 4 不变量核对（红线）

- 单一状态源：autonomy 只存在于 IntentStore `execution-intents.json`，无第二状态文件 ✔
- 恢复链路零改动：WAIT-GATE / completion-truth / liveness / 预算 / P1-A 不变量全部回归绿 ✔
- 迁移幂等、只增不清：I1/I2 断言 ✔
- 失败 fail-soft：patch 失败不抛入恢复链路，工具层返回错误 ✔

## 5 待办（后续轮次）— 全部完成（2026-08-30）

1. ✅ 受控延迟重启已执行（提前预告）→ 重启后 3 工具活体调用证据（system_api）
2. ✅ 真实 Runtime E2E 3 条齐：E1 8/8（AC7）/ E2B 7/7（AC8，确定性腿）/ E3 8/8×2（AC9）→ `e2e/*.json`
3. ✅ REPORT_R1.md + CURRENT_STATUS.md 已更新 → 状态 AWAITING_EXTERNAL_REVIEW
4. ➕ 本轮新增根因修复：重启恢复 CT persisted-log fallback（RESTART_RESUME_REPAIR.md）
5. R2 候选（Reviewer 裁定范围）：F1 宿主侧独立复核 file_hash/system_api 证据
