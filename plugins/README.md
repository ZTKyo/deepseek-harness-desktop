# plugins/ — Canonical Cordis Plugin Source（唯一真源）

> **Authority**：本目录是 Harness **Cordis 运行时插件**的唯一 canonical 源码。
> **Deployment Target**：`~/.dsh/profiles/web/`（Live Runtime 从本目录部署，禁止"最新版只存在 Runtime"）。
> 本目录由 Phase 01（SAVE / Source of Truth Consolidation）建立，替代散落在
> `docs/execution-economy/plugins/`、`docs/lossless-token-optimization/plugins/` 的旧副本。

## 目录规则

1. **本目录是 Cordis 插件唯一真源**；旧副本（docs/*/plugins/ 下的 .mjs）已由 Phase 01 归档/移除，不再作为源码引用。
2. **非 Cordis 插件的独立脚本不放入本目录**：例如 `goal-recovery.mjs`（guardian 直接调用）、
   `dsh-event-notify.mjs`（客户端 sidecar 启动）是**独立运行时脚本**，其 canonical 位置在**仓库根目录**，
   消费者（guardian / DSH-Harness-PS.ps1）从根目录调用，本目录不再保留副本（Reviewer R2 收口）。
3. **改动流程**：改本目录 → 部署到 `~/.dsh/profiles/web/` → 回归测试 → 提交。
4. **测试**：对应测试脚本在本仓库 `tests/continuity/`、`tests/router/`；也可直接运行各插件自带测试。

## 插件清单与部署映射

| 插件文件 | 部署目标 (~/.dsh/profiles/web/) | 功能 |
|---|---|---|
| execution-continuity.mjs | ✓ | 执行连续性（Crash-Safe 恢复、WAITING_USER gate、agent-scoped compaction） |
| execution-continuity-core.mjs | ✓ | 纯函数核心（classifyFailure / recoverableScan，被 execution-continuity import） |
| model-selection-guard.mjs | ✓ | 模型选择守卫 |
| model-selection-guard-core.mjs | ✓ | 模型选择纯函数核心 |
| openrouter-router.mjs | ✓ | OpenRouter 三模型路由（model=auto） |
| openrouter-router-core.mjs | ✓ | 路由决策纯函数核心 |
| vision-bridge.mjs | ✓ | 视觉桥（图片理解） |
| ask-telegram.mjs | ✓ | Telegram 提问桥 |
| agent-inspector.mjs | ✓ | Agent 检查器（tapIndex 注入） |
| agentrouter-wire.mjs | ✓ | AgentRouter 接线 |
| completion-notify.mjs | ✓ | 完成通知 flag |
| computer-use.mjs | ✓ | 浏览器 Computer Use |
| secret-gate.mjs | ✓ | 密钥安全面板 host 插件 |
| tool-output-offload.mjs | ✓ | 工具输出卸载 |
| keepalive-patch.mjs | ✓ | Keep-alive 补丁 |
| commandcode-router.mjs | ✓ | CommandCode 路由 |
| commandcode-router-core.mjs | ✓ | CommandCode 纯函数核心 |
| provider-registry-core.mjs | ✓ | Provider 注册表核心 |
| client.js | ✓ | 客户端注入脚本（agent-inspector 浏览器 boot entries） |
| cordis.patch.yml | ✓ | 插件加载清单（Deployment Manifest） |

> 说明：`*core.mjs` 为各插件 import 的纯函数核心（非独立插件）；`*-test.mjs` 为回归测试。
> 独立脚本 `goal-recovery.mjs`、`dsh-event-notify.mjs` 的 canonical 位置为仓库根目录。

## 测试清单

- `tests/continuity/` — 执行连续性回归（crash-safe / fault-injection / WAITING_USER / compaction-scope / multitask）
- `tests/router/` — 路由回归（deepseek-native-multimodal / exact-model-preservation）
- `tests/reliability/` — 可靠性 P1 演练（CommitReadiness / FinalDrill / LastGood / Transaction / BootMode / SafeMode）

## 与 Golden 的关系

- 当前 Candidate Golden：`PHASE01_CANONICAL_GOLDEN_R2`（DSH-Client/_release-staging/，含 HASHES.txt）
- R1 的 `PHASE01_CANONICAL_GOLDEN` / `phase01-save-complete` 因含回退代码已标记 `REJECTED_CANDIDATE`
- Golden 是**可回滚快照**，本目录是**日常真源**；两者 hash 应保持一致（见 Phase 01 REPORT_R2.md）。

## 变更日志

- 2026-08-23（Phase 01 R1）：建立本目录，从 Live Runtime 收口插件源码；修正 notify/router/tool-output-offload 漂移。
- 2026-08-23（Phase 01 R2）：收口精确重复——移除 plugins/ 中非 Cordis 插件的 `goal-recovery.mjs`、
  `dsh-event-notify.mjs` 副本（根目录为消费者 canonical 位置）。

## P2.5 CONTEXT MEMORY 插件（2026-08-26 新增）

| 插件文件 | 部署目标 (~/.dsh/profiles/web/) | 功能 |
|---|---|---|
| context-memory.mjs | ✅（挂载于 autonomous 预设 compaction 组：tool-output-offload 之后、compaction-basic 之前） | 上下文记忆投影（Recent Window / Observation / Reflection / Recall / provider-switch activation）；单开关 config.enabled 或 env CM_DISABLED |
| context-memory-core.mjs | ✅ | 纯函数核心（被 context-memory.mjs import，零 IO） |

测试：`tests/context-memory/verify-context-memory.mjs`。设计/审计：`docs/roadmap/reports/PHASE_02_5_CONTEXT_MEMORY/`。