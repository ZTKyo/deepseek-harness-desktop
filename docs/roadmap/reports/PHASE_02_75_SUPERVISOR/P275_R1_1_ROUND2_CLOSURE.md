# Phase 02.75 SUPERVISOR — R1.1 Round 2 收口报告（2026-08-29）

> 状态：**IMPLEMENTATION COMPLETE（R1.1 / Round 2）— 待外部评审 Round 3**（未获 VERIFIED 授权，不自行标注）。
> 前序：REPORT_R1.md（R1 / Round 1）；本报告只覆盖 Reviewer 99 Round 1 verdict 合同 A/B/C 修复项，**零新增功能**。

## 合同执行（A / B / C 全量落地）

- **A — 变更操作回放安全（replay-safe mutations）**：全部变更 RPC（dispatch/correct/cancel）改为 canonical request hash 幂等派生——同 key 同 body 重放返回原 receipt（`dispatched:false`），不同 body 同 key → 409 `idempotency_conflict`；不再依赖到达顺序。mutation M1–M12 套件覆盖重放/乱序/陈旧 generation。
- **B — 生命周期与证据面**：goal 生命周期投影（armed→running→completed/failed/cancelled）与 receipt 状态机补齐；evidence schema 版本化；`/supervisor/get_state` 幂等快照；stale generation 拒绝语义（旧 generation 的 mutation → 409 `stale_generation`，观测面只读不受影响）。
- **C — CI 三层接线（真实 GitHub CI，非本地自证）**：
  - L1 `ci-level1.yml`：新增步骤「P2.75 Supervisor core/tool-surface unit tests (T1–T30, pure unit)」；
  - L2 `ci-level2.yml`：新增步骤「P2.75 Supervisor mutation replay/idempotency/lifecycle/stale-generation (R1.1)」；
  - L3 `ci-level3.yml`：新增步骤「P2.75 Supervisor isolated real E2E (dispatch/review, bridge-restart replay, disabled baseline)」。

## 交付物（canonical blob id = 部署字节一致凭证）

| 文件 | 大小 | canonical blob（origin/main=ad3fac4） |
|---|---|---|
| `plugins/supervisor-bridge.mjs` | 30,577 B | `d40e0af460ed3473f0f7f9dc8c71aeece1c86f92` |
| `plugins/supervisor-bridge-core.mjs` | 33,303 B | `be5414aae7547691d1165544853a6500bbdffca5` |
| `plugins/supervisor-bridge-test.mjs` | 25,117 B | `d2df06e4ca20a6e626967e544228e6e741639629` |

## CI / PR 证据

- PR #65（branch `p275-r11-round2-closure`，head=efdc5a0）→ 全绿后守护脚本自动 squash merge → **canonical main = `ad3fac4f041bdff9e13919a05598f625347e48ac`**。
- 三条 run（head=efdc5a0）步骤级证据：
  - L1 run 33234796824：`✓ P2.75 Supervisor core/tool-surface unit tests (T1-T30, pure unit)`；
  - L2 run 33234797153：`✓ P2.75 Supervisor mutation replay/idempotency/lifecycle/stale-generation (R1.1)`；
  - L3 run 33234796827：`✓ P2.75 Supervisor isolated real E2E (dispatch/review, bridge-restart replay, disabled baseline)`。

## 部署与加载 attestation（生产 3080）

- 事务化部署：`git show origin/main:<file>` → cmd 重定向 → `copy /Y` → `~/.dsh/profiles/web/`；`git hash-object` 三文件 == canonical blob **全 MATCH**（部署零漂移）。
- 受控重启（`restart-dsh-server-delayed.ps1 -RestartAndWait -Reason "P275 R1.1 deploy"`，ledger：旧实例停止 → 新 pid=25424 绑定 → 稳定窗提交；日志无 fatal/QUARANTINE）。
- **loaded attestation**：`POST/GET /supervisor/health`（Bearer token）→ `200 ok:true version=0.2.1`，且 health `identity.bridgeSha256/coreSha256` == deployed 文件字节 SHA-256（`ef3430dbb22a…` / `cccf1e67b228…`）——运行中进程加载的即 canonical 字节。
- 安全基线：`get_state` 错误 token → 401；正确 token → 200 ok（无派发历史，sessions=0 属干净基线）；`session.list` 为无效路径（该版本 dsh 无此公开路由，非回归——会话持久化以本会话跨重启延续 + get_state 200 为证）。

## 重启后全量回归（2026-08-29，重启后新进程上执行）

- P2.6 八套件（tests/continuity/verify-p26-*.mjs）：**136 PASS / 0 FAIL**；
- P2.5 context-memory（verify-context-memory.mjs）：**72 PASS / 0 FAIL**；
- supervisor canonical E2E（隔离实例）：见下方「E2E 证据」；合计 **0 失败，无关失败 0 个**。

## E2E 证据（隔离 DSH_HOME 实例）

3-phase 结构：① dispatch/review（真实派发+纠偏+取消语义）② bridge-restart replay（重启后幂等重放一致）③ disabled baseline（插件禁用时 /supervisor/* 不注册，宿主 boot 不受影响）。CI L3 步骤全绿；本地复跑计数见 REPORT_R1 附录。

## 红线遵守 / 治理纪律

- 零 Harness 核心修改（纯插件层 + CI yml）；零现有任务/会话中断（重启在任务换挡点执行，已提前预告）。
- 未触碰 Reviewer 99 页 verdict；VERIFIED 仍须 Reviewer 授权。
- 一次性诊断脚本（`tests/supervisor/_diag*.mjs` ×10、`_probe-goal.mjs`）验证后已删除；隔离实例阶梯法配方完整记录于工作区 VERIFICATION.md（P2.75 段），可复现。

## 备份 / 回滚

- 部署前原 profile 文件备份：`~/.dsh/profiles/web/supervisor-bridge{,-core}.mjs.bak-r11`（test.mjs 原不在 profile，无需备份）。
- 回滚路径：恢复 `.bak-r11` 两文件 + `cordis.patch.yml` 未改动（注册段自 R1 未变）+ 重启即回到 v0.1.0 行为；canonical 侧 git revert `ad3fac4`。

## 已知边界 / Round 3 等待项

1. 外部评审 Round 3 未决前状态保持 IMPLEMENTATION COMPLETE；VERIFIED 由 Reviewer 授权。
2. `session.list` 路由不存在为**预期**（R1 设计即无此路由；观测走 get_state/get_evidence）。
3. 长轮询/流式推送仍未做（R1 轮询语义，非本轮合同范围）。
