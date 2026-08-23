# docs/_archived/ — 归档区（Phase 01）

> 本目录存放**已被替代的旧副本**，仅供历史追溯，**不是源码引用位置**。

## 归档内容

| 归档文件 | 原位置 | 替代（唯一真源） |
|---|---|---|
| openrouter-router.mjs | docs/execution-economy/plugins/ | `plugins/openrouter-router.mjs`（Phase 01 同步自 Live，含失败分类/空响应 failover 新实现） |
| openrouter-router-core.mjs | docs/execution-economy/plugins/ | `plugins/openrouter-router-core.mjs` |
| vision-bridge.mjs | docs/execution-economy/plugins/ | `plugins/vision-bridge.mjs` |
| tool-output-offload.mjs | docs/lossless-token-optimization/plugins/ | `plugins/tool-output-offload.mjs` |

## 原因

Phase 01（SAVE / Source of Truth Consolidation）确认：旧 `docs/*/plugins/` 副本与 Live Runtime
存在漂移（openrouter-router 旧实现缺 4 个失败分类正则与 empty-response failover；tool-output-offload
缺 threshold/recursiveChars 新逻辑）。为消除“同功能多份副本”，统一收口到 `plugins/`，旧副本归档于此。

## 变更日志

- 2026-08-23（Phase 01）：归档 4 个旧插件副本，删除空目录。
