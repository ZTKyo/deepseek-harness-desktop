# Phase 02.75 SUPERVISOR — R1 实施收口报告（2026-08-29）

> 状态：**IMPLEMENTATION COMPLETE（R1）— 待外部评审**（未获 VERIFIED 授权，不自行标注）。
> 设计文档：`DESIGN_R1.md`（同目录）。Canonical 代码真源：repo `plugins/`（GitHub verified main 流程走 PR）。

## R1 交付物

| 文件 | 作用 |
|---|---|
| `plugins/supervisor-bridge.mjs`（12,055 B） | Cordis 插件：注册 `/supervisor/*` HTTP 路由（host event 桥），fail-soft 隔离（内部异常只记录不逃逸） |
| `plugins/supervisor-bridge-core.mjs`（9,815 B） | 纯函数核：状态机 / 投影派生 / 幂等键派生 / 纠偏上限 / 路由回环翻译（零业务逻辑在插件层） |
| `plugins/supervisor-bridge-test.mjs` | T1–T14 单元测试（node:assert，零依赖） |
| `tests/supervisor/verify-supervisor-real-e2e.mjs` | REAL E2E：对活体 dsh 实例的 26 项断言 |
| `plugins/cordis.patch.yml` / `~/.dsh/profiles/web/cordis.patch.yml` | 注册段（repo 模板 + 部署 profile 均已登记） |

## 架构要点（与 DESIGN_R1 一致）

- **零核心修改**：纯插件层；变更操作一律回环翻译到宿主既有 `session.create / session.prompt / goal.create / goal.update` RPC——禁第二权威。
- **安全**：`/supervisor/*` 全部 Bearer token（`~/.dsh/supervisor-bridge/token`，首次 boot 自动生成，64 hex）；无 shell/write_file 通道；快照仅元数据（sessionId/running/hasGoal），会话正文走 `get_evidence` 且脱敏；纠偏上限 3；不放宽 CORS。
- **禁派发路径**（`insert:false` + `metadataOnly` config 语义）：R1 部署面仅观测 + 代理已有会话变更。

## 验证证据

### 单元测试（T1–T14）：14/14 PASS
key 校验 / objective 校验 / maxGoalRounds 边界 / 确定性 session id（同 key→同 id）/ receipt 状态机迁移（dispatched→corrected→cancelled:clear）/ 纠偏上限 3 与拒绝语义 / 状态健全性 / rebind 派生 / dispatch 步骤回环翻译（含初始指令 `mode:'now'`）。

### REAL E2E（隔离 DSH_HOME 实例，dsh 0.1.1-rc.2，端口 33127）：26/26 PASS
- **负例**：无 token→401、错 token→401、未知会话→404 unknown_session、非法 key→400 invalid_idempotency_key。
- **T15 真实派发**：`dispatch_goal` → `session.create` + `goal.create` + `session.prompt(mode:'now')`；sessionId 格式校验；goal 投影 armed（objective 一致、id+revision 在）；**初始指令真实进入会话**（evidence 出现派发文本——'queue' 只入队不唤醒的缺陷已在 R1 修复为 'now'）。
- **T16 幂等**：同 key 重派 → `dispatched:false`、同 sessionId、纠偏计数不变。
- **T17 纠偏**：3 次依序 accepted（correctionsUsed=1/2/3，correctionsLeft 递减），第 4 次 → **409 corrections_exhausted**。
- **观测面**：快照含会话行且 metadata-only（无 cwd/content 字段）；receipts 行 corrections=3；evidence 200 且脱敏。
- **T18 取消**：`cancel_goal(clear)` → cancelled:true → goal 投影清空 → receipt status=`cancelled:clear`。
- 实例含插件 boot 自动生成 token、健康检查 `GET /supervisor/health` ok:true。
- 隔离实例已在验证后销毁（临时 DSH_HOME 清理）。

### CI / PR / 回归
- PR #63（branch `p275-r1-supervisor-bridge`，head=7fd83db）CI 全绿：L1 Static+secret+syntax 1m07s ✅ / L2 Reliability state machine（P2.5/P2.6 回归矩阵）6m33s ✅ / L3 DSH boot+readiness smoke **8m00s ✅（含 supervisor-bridge 真实 boot 冒烟）**。
- Squash merge → **canonical main = f2d94f9**（feat(p275): supervisor bridge R1 ... (#63)）。9 files changed, 1074 insertions。
- 部署面（`~/.dsh/profiles/web/`）与 canonical main 同源提交，内容一致。

### 部署状态
- 部署 profile（`~/.dsh/profiles/web/`）：双插件文件已就位；`cordis.patch.yml` 追加注册段，js-yaml（含 `!!js` schema）校验 PASS（18 ops，supervisor-bridge 在列）。
- **生效时机**：遵守攒批重启纪律，本次未重启 3080 主服务；插件将在下一次自然重启时加载（fail-soft：加载异常仅 QUARANTINED 不影响 boot）。当前会话无感、零中断。

## 已知边界 / 遗留（不阻塞 R1 收口）

1. **ChatGPT 侧动作卡片**：R1 交付 Harness 侧 HTTP API 全量；ChatGPT 端 connector/GPT 配置是用户侧操作，不属 Harness 代码。
2. 长轮询/流式推送未做（R1 轮询即可）；`session.running` 为瞬态运行时标志，E2E 以 evidence 文本为真信号。
3. token 轮换命令未提供（可删 `~/.dsh/supervisor-bridge/token` 重启再生）。
4. 外部评审通过前状态保持 IMPLEMENTATION COMPLETE，VERIFIED 须 Reviewer 授权（governance 纪律）。
