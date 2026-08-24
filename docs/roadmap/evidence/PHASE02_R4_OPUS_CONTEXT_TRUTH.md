# Phase 02 R4 Step 6 — AgentRouter Opus context three-layer truth (evidence)

Date: 2026-08-24  |  Branch: fix/phase02-review-r4

## Three-layer context truth for agentrouter-anthropic / claude-opus-5

| Layer | Value | Source |
|---|---|---|
| ANTHROPIC_UPSTREAM_CONTEXT | **1M (1,000,000)** | Claude 官方文档（platform.claude.com "What's new in Claude Opus 5": "1M token context window (1M tokens is both the default and the maximum)"）；Opus 4.8 同为 1M（Anthropic model card / Morph aggregation） |
| HARNESS_RESOLVED_CONTEXT | **1,000,000** | settings.yaml agentrouter-anthropic models[].contextWindow=1000000（YAML VALID，js-yaml 验证）；pi-ai adapter 表达式 `contextWindow = entry.contextWindow ?? base?.contextWindow ?? defaultContextWindow(262144)` → 返回 1M |
| AGENTROUTER_BACKEND_ACCEPTED_CONTEXT | **UNKNOWN** | AgentRouter 无公开 catalog/metadata（/v1/models 需认证 401；/models 页为 JS 空壳 1562B）；300-320K 探针需真实 API 调用（约 $4.5 成本）+ AGENTROUTER_API_KEY（当前不在 env）→ 按 Reviewer 允许标记 UNKNOWN，不假装证明 |

## Compaction threshold (proactive)

- active thresholdRatio: **0.8**（dsh 默认；未显式配置）
- proactive threshold = resolvedContext × ratio = 1,000,000 × 0.8 = **800,000 tokens**
- 修复前：registry 硬编码 200,000 × 0.8 = 160,000（过早 compaction）

## Optional future probe (requires user consent + key)

`probe-agentrouter-backend.mjs`（未运行）：构造约 300-320K token 的纯文本输入
（无工具、无图片），请求 claude-opus-5 返回极小输出（"ok"），观察是否被截断：
- 若成功返回 → backend ≥ 320K（至少证明非 200K/262K 截断）
- 若报 context_length_exceeded → backend < 320K（记录实际上限）
- 不跑 900K 全量 1M 证明（成本）；完整 1M 上限保持 UNKNOWN 除非必要

## Files changed (Step 6)

- plugins/model-registry.mjs: getTools unknown family -> fail-closed
  {tools:false, structuredJson:false}（原 fail-open {true,true}）；contextWindow
  注释修正 chars→tokens + Authority 声明（thin override, not capacity DB）
- tests/reliability/test-model-registry.mjs: 需更新 unknown-family 断言（R7 区域）
