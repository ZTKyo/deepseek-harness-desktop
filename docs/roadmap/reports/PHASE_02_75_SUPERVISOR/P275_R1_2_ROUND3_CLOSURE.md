# Phase 02.75 SUPERVISOR — R1.2 Round 3 final closure（2026-08-29）

> 状态：**IMPLEMENTATION COMPLETE（R1.2 / Round 3 final closure）— 待外部评审 Round 3**（未获 VERIFIED 授权，不自行标注）。
> 前序：REPORT_R1.md（R1 / Round 1）＋ P275_R1_1_ROUND2_CLOSURE.md（R1.1 / Round 2）；本报告只覆盖外部评审 Round 3 **唯一 Blocker「DISPATCH IDEMPOTENCY PAYLOAD IDENTITY」** 的闭环，**零新增功能**。

## Blocker 合同执行（payload identity 全量落地）

- **dispatchFingerprint 定义**：对 canonical normalized dispatch contract 计算 SHA-256——参与字段 = `objective / initialInstruction / maxGoalRounds / acceptanceCriteria / supervisorGoalId / generation`；规范化规则 = 字典序键序 + 字符串 trim + CRLF→LF；**明确排除**时间戳、runId、sessionId、PID、端口、随机值等非语义表示噪声。
- **指纹进入 receipt 并持久化**：dispatch receipt 携带 `dispatchFingerprint`（R1.2 语义），随 ledger 持久化，重启后仍在。
- **判定语义**：
  - 同 idempotencyKey + 同指纹 → `duplicate:true`，**零副作用**（不重发 start prompt）；
  - 同 idempotencyKey + 异指纹 → **409 `idempotency_conflict`**，**零副作用**（防同 key 伪装重放造成二次派发）；
  - 遗留 receipt 无指纹 → **fail-closed**（拒绝按重复处理，completed 与 pending 两条路径均拒）；
  - 表示噪声（空白/CRLF 差异）→ 仍判 duplicate，不误报冲突（M1a）；
  - 同 key 下 `supervisorGoalId` 不同 → 409 `idempotency_conflict`（M13）。
- **对照测试**：mutation 套件由 14 扩至 **19/0**（新增 M1a/M1b/M1c/M1d/M13/M14）；隔离真实 E2E 增补 `T15 receipt carries dispatchFingerprint (R1.2)`、`T16b dispatch conflicting payload → 409 idempotency_conflict`——两项本轮全绿。

## 交付物（canonical blob id = 部署字节一致凭证）

| 文件 | 大小 | canonical blob（origin/main=4fae42f） |
|---|---|---|
| `plugins/supervisor-bridge.mjs` | 32,114 B | `d2e2cdf342ee88e32ef73ec9a4a785a91a8706ca` |
| `plugins/supervisor-bridge-core.mjs` | 35,720 B | `ab342dd263f5cb4420f544c0782e4c59476a69b3` |
| `plugins/supervisor-bridge-test.mjs` | 29,521 B | `a04f985f4e9c59097acd87483e8a74cc52880871` |

PR #67 diff 面（5 文件，+283/−27，全部插件层+测试+CI yml，零 Harness 核心）：core +39/−2、bridge +28/−6、bridge-test +65/−0、mutation tests +132/−11、real-e2e verifier +19/−8。

## CI / PR 证据

- PR #67（branch `p275-r12-round3-final`，head=`f21f3bc`）→ 全绿后 squash merge → **canonical main = `4fae42f2e5335a28f0d0a546e477249b5a494438`**（merged 2026-08-29T08:36:48Z）。
- 三条 run（head=f21f3bc）全部 success：
  - L1 Static Gate run **33243204206**；
  - L2 Windows Reliability State Machines run **33243204210**；
  - L3 Harness Smoke run **33243204229**（含 supervisor isolated real E2E 步骤）。

## 部署与加载 attestation（生产 3080）

- 事务化部署（2026-08-29 16:36:54）：部署前原文件备份 `.bak-r12`（三文件齐全）→ 覆盖 `~/.dsh/profiles/web/` 三文件 → 部署字节 == canonical blob 全 MATCH（部署零漂移）。
- 受控重启（2026-08-29 16:49，`restart-dsh-server-delayed.ps1`）：旧 pid=15572 → 新 pid=3300（16:49:31 绑定）。
- **ledger 透明记录**：重启 ledger 中 attempt `d0549067` 记为 FAILED（readiness 探测在宽限窗内 ×3 超时即提前记失败）——**实际终态健康**（pid 3300 单环回监听 127.0.0.1:3080 + 16:56 health 校验通过），ledger 记账口径与真实终态存在已知偏差，如实记录不掩饰。
- **loaded attestation**：`GET /supervisor/health`（Bearer token）→ `200 ok:true version=0.2.2`，且 `identity.bridgeSha256 = a43d4cd6e1feac673547a3a97c2ce920e805851e6a64352b96b10ed6b9c62d6c`、`identity.coreSha256 = 59e3b5dfb8e297f80c4b0e10850dd30bb6b347b5ccc4f5d0a806da1c50e458fb` == 部署文件字节 SHA-256——运行中进程加载的即 canonical 字节。
- 安全基线：错误 token → 401；正确 token → 200；重启后 ledger 全新（state=ABSENT, receipts=0，干净基线）。

## 重启后全量回归（2026-08-29，v0.2.2 进程上执行，两轮电池全部退出码 0）

- supervisor mutation 套件（test-supervisor-mutation-state.mjs）：**19 PASS / 0 FAIL**（含 R1.2 新增 M1a–M1d/M13/M14）；
- supervisor CI E2E 编排器（run-supervisor-ci-e2e.mjs）：**ALL PHASES PASS**（T15 指纹 PASS / T16b 409 conflict PASS；ci 模式下历史依赖断言按设计 SKIP，full 模式在 CI L3 执行）；
- P2.6 八套件（tests/continuity/verify-p26-*.mjs）：数值摘要合计 **136 PASS / 0 FAIL**（network-error 20、r3-retry-policy 41、quota-defer 18、quota-no-alternative 17、managed-direct-quota 15、r3-a1 16、commandcode-quota 9、rollback-switch ALL PASS 无数值摘要）；
- P2.5 context-memory（verify-context-memory.mjs）：**72 PASS / 0 FAIL**；
- 合计 **0 失败，无关失败 0 个**。

## 红线遵守 / 治理纪律

- 零 Harness 核心修改（插件层 + 测试 + CI yml）；版本 0.2.1 → 0.2.2。
- 未触碰 Reviewer 99 页 verdict；VERIFIED 仍须外部评审 Round 3 授权。
- 重启遵守预告纪律（提前告知「服务会短暂中断」），未打断任何运行中任务。

## 备份 / 回滚

- 部署前原 profile 文件备份：`~/.dsh/profiles/web/supervisor-bridge.mjs.bak-r12`、`supervisor-bridge-core.mjs.bak-r12`、`supervisor-bridge-test.mjs.bak-r12`（均 2026-08-29 13:12:16）。
- 回滚路径：恢复 `.bak-r12` 三文件 + 重启即回到 v0.2.1 行为（R1.1 语义）；canonical 侧 git revert `4fae42f`。

## 已知边界 / Round 3 等待项

1. 外部评审 Round 3 未决前状态保持 IMPLEMENTATION COMPLETE；VERIFIED 由 Reviewer 授权。
2. 重启 ledger 的 FAILED 记账口径偏差（实际健康）已如实记录；guardian/ledger 记账改进属 P2 域，不在本合同内。
3. 长轮询/流式推送、ChatGPT 侧动作卡片仍为 R1 已知边界，未变。
