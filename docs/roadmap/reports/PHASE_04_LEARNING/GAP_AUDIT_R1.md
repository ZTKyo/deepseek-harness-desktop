# P4 LEARNING R1 — 只读 Gap Audit + 基线 / Authority 映射 + REUSE_MAP

- 生成时间：2026-09-21
- 性质：只读审计（审计阶段未修改任何文件；结论驱动后续 R1 最小增量实现）
- 前置 Gate：P1 SAVE / P2 SIMPLIFY / P2.5 CONTEXT MEMORY / P2.6 RETRY SEMANTICS / P2.75 SUPERVISOR / P3 AUTONOMY 均已在册（P2.5 / P2.6 / P2.75 = VERIFIED；P3 = AWAITING_EXTERNAL_REVIEW）
- 本文件用途：回答"P4 要学什么、**已经有什么可以复用**、因此最小增量是多少、哪些东西**禁止重建**"

## 0 基线（审计时刻快照）

| 项 | 值 |
|---|---|
| Repo | `ZTKyo/deepseek-harness-desktop`，baseline **main = `6d0623627c4b38f6b870ef03fe9ed776186c9e09`** |
| 工作分支 | `p4-learning-r1` |
| 隔离工作树 | `.worktree-p4-learning-r1`（与主工作区物理隔离，生产 profile 不加载） |
| 生产部署面 | **未触碰**（R1 不注册进生产 profile，不重启服务） |
| 经验库路径 | `%LOCALAPPDATA%\DSHHarness\state\learn\<sanitized-session-id>.json`（原子写 tmp+rename） |
| 原始会话事实源 | Official Session（`~/.dsh/sessions`，durable events，node `seq` 锚点） |
| 单开关 | `config.enabled=false` 或环境变量 `LEARN_DISABLED=true` ⇒ 不注册任何钩子 |

## 1 Authority 映射（既有权威面，R1 不新增 Authority）

| Authority | 载体 | 职责 | R1 是否触碰 |
|---|---|---|---|
| Official Session | dsh core（session persistence） | **唯一任务事实源**：原始事件、node seq | 只读消费（经验必须带 `sourceEventSeqs` 回源锚点） |
| P2.5 CONTEXT MEMORY | `context-memory-core.mjs`（`messageOfEvent` / `recursiveText` / `isPluginSourced`） | **原始会话抽取唯一权威** | **复用（直接 import），不复制、不重写** |
| Execution Continuity (EC) | `execution-continuity.mjs` + IntentStore | **恢复/进度唯一权威**：状态机、预算、boot scan、WAIT-GATE | 不动 |
| completion-truth-core | `completion-truth-core.mjs` | deterministic 副作用重放判定 | 不动 |
| Supervisor Bridge（sealed） | `supervisor-bridge{,-core}.mjs` + receipts.json | 外部控制面：dispatch idempotency、acceptanceCriteria 账本、review/verdict | 不动 |
| Router / Model Registry | openrouter-router + model-registry | 模型唯一权威 | 不动 |
| Guardian + goal-recovery | 工作区 `DSH-Client\*.ps1/.mjs` | 进程级自愈 | 不动 |
| **P4 LEARN（新增）** | `learn-core.mjs` + `learn.mjs` + 经验库 | **仅"经验"这一派生面**：提案 → 审批 → 召回 → （可选）晋升资格。**不是**第二 Task/Goal/Recovery/Router/compaction authority | ✅ 新增（唯一新增面） |

> 结论：P4 新增的**不是**一个 Authority，而是一个**派生存储 + 生命周期状态机**。原始事实仍只在 Official Session。

## 2 逐项 Gap Audit（对照 P4 Goal 合同）

| # | 合同项 | 现状与证据 | 判定 | R1 动作 |
|---|---|---|---|---|
| 1 | 经验提炼来源 | P2.5 已有 `messageOfEvent` / `recursiveText` / `isPluginSourced` 官方提取器 | ✅ 已有 | **直接 import**，禁止第二 parser |
| 2 | 经验存储 | 无任何"经验/教训"持久化面 | ❌ 缺失 | 新增 per-session 经验库（schema v1，原子写） |
| 3 | 提案 ≠ 激活 | 无 | ❌ 缺失 | 状态机 `PROPOSED → APPROVED / REJECTED`，**代码强制**（召回只认 APPROVED） |
| 4 | 人工审批 | 无 | ❌ 缺失 | `approve()` / `reject()` 显式工具 + 审批人署名 + 理由 |
| 5 | 确定性召回 | 无 | ❌ 缺失 | 纯函数召回（同输入 → 同输出，稳定排序，无随机/无时间依赖） |
| 6 | 回源锚点 | 无 | ❌ 缺失 | 每条经验携带 `sourceEventSeqs`（≤64），可回原始会话核对 |
| 7 | 损坏/缺失处理 | 无 | ❌ 缺失 | `validateStore()` 结构不符 → 返回 `null` → **fail-closed 重建**，绝不部分信任 |
| 8 | 密钥脱敏 | P2 已有脱敏先例 | ⚠️ 部分 | P4 自持脱敏实现（`redactSecrets` / `containsSecret`），持久化前强制过滤 |
| 9 | 写入边界 | EC 有 IntentStore 边界 | ⚠️ 部分 | 新增白名单 `LEARN_WRITE_TARGETS = ['experience-store','telemetry','audit-log']` + 启动自检 |
| 10 | 晋升 | 无 | ❌ 缺失 | `PROMOTION_STATES`；**ELIGIBLE ≠ PROMOTED**，晋升永远需显式调用 |
| 11 | 遥测/可观测 | 无 | ❌ 缺失 | 8 类事件环形缓冲（≤500）+ `learn_status` 工具 |
| 12 | 防重复学习 | 无 | ❌ 缺失 | 每会话 watermark（已提炼到的 node seq），避免重复提炼同一段 |
| 13 | 有界增长 | 无 | ❌ 缺失 | `MAX_EXPERIENCES=200`、正文/标签/锚点长度上限 |
| 14 | 工具注册 | secret-gate `defineTool` 先例；会话作用域 `exec.agent.session.id` | ✅ 已有模式 | 复用既有注册模式（不建常驻服务） |
| 15 | 快速回退 | EC 有 `EC_DISABLED=true` 先例 | ✅ 已有模式 | 复用同构开关 `LEARN_DISABLED=true` |

## 3 结论：R1 最小增量 = 2 个新文件 + 1 处仅导出改动（无新增常驻服务 / DB / Authority）

1. **A（纯核心）**：`plugins/learn-core.mjs` — 零 IO / 零依赖纯函数：经验 schema、状态机与迁移白名单、脱敏、写入边界判定、确定性召回、晋升资格、遥测构造、损坏 fail-closed 校验。
2. **B（插件壳）**：`plugins/learn.mjs` — IO 与钩子注册：注入 P2.5 官方提取器、per-session 经验库原子读写、5 个 operator 工具（`learn_digest` / `learn_review` / `learn_recall` / `learn_promote` / `learn_status`）、遥测落盘、单开关。
3. **C（仅导出）**：`docs/roadmap/evidence/cm-r4-log-decoder.mjs` — **仅加导出**（+25/−8），供 P4 复用日志解码而**不复制一份解码器**；已实测输出**逐字节相同**（32388 帧 / 39827 行 / bad=0，改前 == 改后）。

> 没有新增常驻服务、没有新增 DB、没有新增 Authority、没有第二套 router / retry / memory / promotion engine。

## 4 REUSE_MAP — 已有能力复用清单（**禁止重建**）

| 能力 | 权威实现（复用来源） | P4 如何使用 | 禁止事项 |
|---|---|---|---|
| **原始会话抽取** | `context-memory-core.mjs`（P2.5）：`messageOfEvent` / `recursiveText` / `isPluginSourced` | `learn-core.mjs` **直接 import** 并冻结为 `P25_EXTRACTORS`；缺任一 → `{ok:false, error:'missing_official_extractors'}` | **禁止**在 P4 内再写任何 raw-session parser / event 解包逻辑 |
| **日志解码** | `docs/roadmap/evidence/cm-r4-log-decoder.mjs`（P2 R4） | 复用其解码，P4 不自带解码器 | **禁止**复制第二份解码器（本次仅补导出） |
| **工具注册模式** | `secret-gate.mjs` 的 `defineTool` | 复用同一注册形态 | **禁止**新建常驻 Auditor 服务 |
| **会话作用域** | `exec.agent.session.id`（官方 `dsh-tool-ask-user` 先例） | 经验库 per-session 隔离 | 禁止全局单例经验库 |
| **原子写** | EC IntentStore 的 tmp + rename 模式 | 经验库落盘同构 | 禁止非原子写（半截文件会被 fail-closed 判损坏） |
| **脱敏** | P2 脱敏先例（模式与 token 命名沿用同一风格） | `redactSecrets` / `containsSecret` 持久化前强制过滤 | 禁止把未脱敏文本写入经验库/遥测/日志 |
| **单开关** | `EC_DISABLED=true` 先例 | `LEARN_DISABLED=true` | 禁止只能靠删文件才能停用 |
| **测试隔离** | P2.5/P3 隔离实例 + 临时目录 harness 模式 | E2E 仅写 `os.tmpdir()`，不碰生产 | 禁止测试触碰生产 profile / 真实凭据 |
| **回归扫描** | 既有 20 个套件（P1/P2/P2.5/P2.6/P2.75/P3） | `tests/learn/run-ac7-regression.ps1` 统一驱动 | 禁止为"变绿"而改动无关套件 |

## 5 R1 明确不做（边界）

- 不注册进**生产 profile**、不重启服务、不部署（R1 只在隔离工作树内成立）。
- 不建第二 Task DB / Goal DB / Recovery Engine / Router / compaction authority。
- **不自动晋升**、不自动批准、不自升级；提案永远需要人。
- 不改 P1-A 不变量、不改 EC WAIT-GATE、不改 supervisor-bridge / router / guardian / goal-recovery。
- 不修 AC7 中发现的**既有**部署漂移（见 §6），只登记。
- 完成后状态只到 **AWAITING_EXTERNAL_REVIEW**，**不自称 VERIFIED**。

## 6 风险与回滚

- **风险 1（最大）**：经验库若成为"影子事实源"，会让后续会话基于陈旧/错误经验行动。缓解：经验**必须**带 `sourceEventSeqs` 回源锚点；召回只认 `APPROVED`；原文永远可回 Official Session 核对。
- **风险 2**：损坏经验库被静默信任。缓解：`validateStore()` 结构校验失败即 `null` → 重建，**fail-closed**。
- **风险 3**：密钥泄漏进经验库/遥测。缓解：持久化前强制脱敏；E2E 断言原始密钥串不出现在落盘字节中。
- **风险 4**：无界增长。缓解：条数与字段长度双重上限 + 每会话 watermark 防重复提炼。
- **AC7 回归实测（诚实记录）**：20 个套件 **19 绿 / 1 红**。唯一红为 `tests/install-plugin/verify-install-plugin.mjs`（13 通过 / 2 失败），根因是 **11 个既有插件在生产 profile 与仓库之间的部署漂移**，这 11 个文件在 `git status` 中**全部未改动**，且 P4 新增文件**不在该检查范围内** ⇒ 判定为 **PRE-EXISTING，非本次引入**。按纪律**只登记、不擅自修**（修复需覆盖生产插件，超出本任务授权）。
- **回滚链**：`git checkout -- docs/roadmap/evidence/cm-r4-log-decoder.mjs` + 删除新增文件即可；纯增量、无数据丢失风险。极端情况 `LEARN_DISABLED=true`（零钩子注册，宿主照常启动）。
- **无需重启**：R1 未进入生产，故不存在服务中断。

---

**一句话总结**：P4 的"学习"**没有**新建任何第二套基础设施 —— 它把"从原始会话里读什么"完全交给 P2.5 官方提取器，把"能不能被召回"完全交给一个**代码强制的审批边界**，自己只新增一个**带回源锚点的派生经验库**。
