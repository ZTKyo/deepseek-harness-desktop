# P3 AUTONOMY R1 — 阶段报告（REPORT）

日期：2026-08-30 ｜ 分支：`p3-autonomy-r1` ｜ 最终状态：**AWAITING_EXTERNAL_REVIEW**

## 0 TL;DR

P3 AUTONOMY R1 落地"Task Autonomy 元数据 + 验证面 + 无人值守 E2E"：
IntentStore schema v3 autonomy 子对象（write-once 验收标准 / 证据台账 / 里程碑 /
派生 verificationState）、3 个 agent 工具（autonomy_report / autonomy_verify /
autonomy_state）、恢复消息注入（Verified progress + no-redo）、无人值守决策策略
（P1-A 不变量不动）。**三条真实 Runtime E2E 全部拿到证据**；期间发现并修复
重启自动恢复 happy path 的真实根因（CT 事件源仅内存注册表），并记录 F1/F2
两项诚实发现。20 套 EC 回归 + 3 套 autonomy 测试全绿；部署面与仓库一致；
受控重启后工具面活体可用。

## 1 范围与边界（No Second Authority）

- 新增 `plugins/autonomy-state-core.mjs`（纯模块，schema v3）+ EC 集成
  （幂等迁移 v1/v2→v3、唯一写入者 applyAutonomyPatch、3 工具、dsh-tools 软导入）。
- autonomy 元数据只存在于 EC IntentStore `execution-intents.json`（单一状态源）；
  **未新增** Task DB / Task Engine / Auditor；supervisor-bridge / router / guardian /
  goal-recovery / P1-A WAIT-GATE 不变量零改动。
- Policy 文档两处一致：~/.dsh/AGENTS.md（任务收资协议第 5 条）+ 工作区 AGENTS.md。

## 2 实现与测试证据（全部实跑，详见 R1_VERIFICATION.md）

- 单测/集成：test-autonomy-state-core **54/0**、test-ec-autonomy-deployed **32/0**。
- EC 回归 **20 套件全绿**（crashsafe / faultinjection / P26 家族 7 / reliability 3 /
  waiting-user-gate / multitask-recovery / nonrecoverable-states / compaction-scope 等）。
- 部署：事务化（.bak 回滚锚点）+ SHA256 部署面==仓库 + 受控重启（提前预告）；
  重启后 3 工具活体调用证据（system_api，非代码检查）。

## 3 三条真实 E2E（隔离实例，真 Runtime，非 mock）

| 腿 | 证据文件 | 结果 | 覆盖 AC |
|---|---|---|---|
| E1 无人值守二选一决策 | `e2e/E1-2026-08-30T01-24-05.json` | **8/8 PASS**：无 ask_user_question 真实工具记录；决策文件 chose-A\|chose-B；AC 持久化 + verify PASS + VERIFIED 派生；intent 非 WAITING_USER | AC7 |
| E2B 重启自动恢复（确定性） | `e2e/E2B-2026-08-30T03-06-41.json` | **7/7 PASS**：官方 IntentStore 注入 RUNNING intent → 重启 → `SCAN restart` → `CT -> clean (persisted-log fallback, 51 events)` → `RESUME-OK cycles=1`；恢复消息含 checkpoint/no-redo；autonomy 块跨重启逐字节一致；副作用文件恰好一次 | AC8 |
| E3 完成验证真相 | `e2e/E3-2026-08-30T00-58-38.json` + `e2e/E3-2026-08-30T00-12-01.json`（两次） | **8/8 PASS**：裸断言完成被拒（≠VERIFIED、无里程碑、无 PASS 证据、未产 proof 文件）；真实证据 → 同一 AC 派生 VERIFIED + 里程碑 + 文件落地 | AC9 |

E2B 说明：里程碑/副作用为**运行器按官方 store 预置**（把"任务进行中被杀"先验状态
从模型关键路径移除），恢复链路本身 100% 真实产品代码路径；模型依赖型旧 E2 腿
保留作为补充。这是无人值守决策策略下的可逆技术选择，理由记录于 RESTART_RESUME_REPAIR.md。

## 4 关键发现与修复（Failure Ledger 摘要）

1. **重启自动恢复 happy path 从未真正工作（本轮最重要发现）**：CT 取事件唯一来源是
   内存会话注册表；重启后 boot scan 时刻无会话在内存 → `session events unavailable`
   → bounded defer 超限 → 永久 NEEDS_VERIFICATION。旧 E2 腿 run4/6/7 的 pin 全部同因
   （E2B 干净历史也复现，证伪"kill 竞态脏历史"假设）。**修复**：内存未命中回退
   loopback `session.history` 持久日志冷读（同 evaluateCompletion 判定；错误仍
   fail-closed）。修复后 E2B 7/7。详见 RESTART_RESUME_REPAIR.md。
2. **F1（诚实发现，R2 候选）**：autonomy_verify 信任模型自述证据串——不存在的文件
   也能编造 PASS（E3 run 期间实际发生）；goal 完成层同理（旧 E2 run7/8 幻觉完成 →
   intent COMPLETED → 无恢复）。缓解=外部评审机制本身；R2 候选=宿主侧独立复核
   file_hash/system_api 证据。
3. **F2（已修，同日）**：EC 每 tick 同步写盘造成无谓 IO 峰值/日志噪声 → 加脏检查
   跳过无变化写（单测 execution-continuity-f2-test.mjs）。

## 5 交付与状态

- 提交：`p3-autonomy-r1`（466abc9 实现 + 69ade9b 验证证据 + 本轮修复与报告）。
- 回滚锚点：`~/.dsh/profiles/web/_pre-p3r1-20260830-034456-execution-continuity.mjs.bak`
  + `plugins/execution-continuity.mjs.bak-p3r2-ctfallback`（CT 修复前）+ git 分支。
- 状态机：IMPLEMENTATION_COMPLETE → **AWAITING_EXTERNAL_REVIEW**（评审通过后
  才可 VERIFIED；无 Phase 04 自行推进；无 self-VERIFIED）。
