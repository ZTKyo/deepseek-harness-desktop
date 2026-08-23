# plugins/ — Canonical Runtime Plugin Source（唯一真源）

> **Authority**：本目录是 Harness 运行时插件的**唯一 canonical 源码**。
> **Deployment Target**：`~/.dsh/profiles/web/`（Live Runtime 从本目录部署，禁止“最新版只存在 Runtime”）。
> 本目录由 Phase 01（SAVE / Source of Truth Consolidation）建立，替代散落在
> `docs/execution-economy/plugins/`、`docs/lossless-token-optimization/plugins/` 的旧副本。

## 目录规则

1. **本目录是唯一真源**；旧副本（docs/*/plugins/ 下的 .mjs）已由 Phase 01 归档/移除，不再作为源码引用。
2. **改动流程**：改本目录 → 部署到 `~/.dsh/profiles/web/` → 回归测试 → 提交。
3. **测试**：对应测试脚本在本仓库 `tests/continuity/`、`tests/router/`；也可直接运行各插件自带测试。

## 插件清单与部署映射

| 插件文件 | 部署目标 (~/.dsh/profiles/web/) | 功能 |
|---|---|---|
| execution-continuity.mjs | ✓ | 执行连续性（Crash-Safe 恢复、WAITING_USER gate、agent-scoped compaction） |
| execution-continuity-core.mjs | ✓ | 纯函数核心（classifyFailure / recoverableScan） |
| goal-recovery.mjs | ✓ | 服务恢复后 goal re-arm + continue 消息 |
| model-selection-guard.mjs | ✓ | 模型选择守卫 |
| model-selection-guard-core.mjs | ✓ | 模型选择纯函数核心 |
| openrouter-router.mjs | ✓ | OpenRouter 三模型路由（model=auto） |
| openrouter-router-core.mjs | ✓ | 路由决策纯函数核心 |
| vision-bridge.mjs | ✓ | 视觉桥（图片理解） |
| dsh-event-notify.mjs | ✓ | 事件通知 sidecar（P1-C 修复：single-flight reconnect + log rotation） |
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
| client.js | ✓ | 客户端注入脚本 |
| cordis.patch.yml | ✓ | 插件加载清单（Deployment Manifest） |

## 测试清单

- `tests/continuity/` — 执行连续性回归（crash-safe / fault-injection / WAITING_USER / compaction-scope / multitask）
- `tests/router/` — 路由回归（deepseek-native-multimodal / exact-model-preservation）
- `tests/reliability/` — 可靠性 P1 演练（CommitReadiness / FinalDrill / LastGood / Transaction / BootMode / SafeMode）

## 与 Golden 的关系

- 当前 Golden：`NEW_LOCAL_GOLDEN_P1_HARDENED`（DSH-Client/_release-staging/，含 HASHES.txt）
- Golden 是**可回滚快照**，本目录是**日常真源**；两者 hash 应保持一致（见 Phase 01 REPORT_R1.md）。

## 变更日志

- 2026-08-23（Phase 01）：建立本目录，从 Live Runtime（~/.dsh/profiles/web）收口 25 个关键插件源码；
  修正 notify/router/tool-output-offload 旧实现漂移。
