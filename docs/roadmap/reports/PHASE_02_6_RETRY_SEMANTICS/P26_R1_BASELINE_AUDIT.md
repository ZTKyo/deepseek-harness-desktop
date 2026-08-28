# P2.6 R1 BASELINE AUDIT — Provider Failure Classification Production Path

- Phase: 02.6 RETRY SEMANTICS / R1
- Date: 2026-08-28
- Baseline main: `be9bde919d211aa87003928229914a52f48f3dea`（P2.5 VERIFIED/SEALED 之上）
- Branch: `feat/p26-r1-failure-semantics-v1`
- Evidence class: **REAL**（本审计全部结论来自对生产代码与真实事故事件日志的直接读取）
- 红线遵守声明: 本轮**零修改** `@deepseek-ai/dsh/**`（运行中服务代码）、`~/.dsh/sessions/**`、`~/.dsh/storages/**`。

---

## 1. 真实事故回放（REAL，脱敏）

GLM（zhipu，`open.bigmodel.cn/api/coding/paas/v4`）HTTP 429：

```json
{"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 2026-09-03 01:49:02 重置。"}
```

生产会话事件日志（真实记录，seq 引用见会话）显示完整风暴链：

1. pi-ai 适配器把失败分类为 `RATE_LIMIT`（`failure = {message: "429: {…1310…}", code: "RATE_LIMIT"}`）。
2. core `dsh-llm-retry` 按 provider 默认策略 `["normal", 5, ["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"], 500, 10000, 0.1]` 盲重试 5 次（`llm/retry` 事件，delayMs 500→10000 指数退避）。
3. turn 以 error 结束 → EC `classifyFailure` 命中 `RATE_LIMIT_RE`（消息含 "429"）→ retryable=true → 恢复消息拼接 + 有界 resume → 新 turn 再次 5 连击。
4. 09:38–09:53 观测约 **9 次同路重试**（retry storm），且 reset 时间戳 `2026-09-03 01:49:02` 全程无人解析。

## 2. 生产路径 Authority Map（现有，REAL）

请求错误进入点与四层职责（全部为**现存** production 代码）：

```
Provider HTTP/protocol error
  └─ adapter 适配器分类（只读 core，模式匹配英文文案）
       dsh-llm-deepseek: httpErrorCode() → AUTH(401/403) / QUOTA(isQuotaExceededError) /
                         RATE_LIMIT(其他429) / CONTEXT_WINDOW_EXCEEDED(400) / INVALID_REQUEST /
                         SERVER(5xx) / HTTP_<status>；Retry-After → providerRetryAfterMs
       dsh-llm-pi-ai:    classifyPiAiError() → AUTH / QUOTA(同函数) / RATE_LIMIT(429) /
                         INVALID_REQUEST(413/400) / SERVER / TIMEOUT / TRANSPORT / PI_AI_ERROR
  └─ cordis 事件 agent/request-error 中间件链（注册序 = 执行序）：
       1) dsh-llm-retry (core)      ← 同路 in-request 有界重试 Authority
       2) openrouter-router (patch) ← 唯一 Model/Provider Authority（fallback chain）
       3) commandcode-router (patch)← 镜像单跳回落
       4) model-selection-guard     ← 选择校验/记录（不选模型）
       5) execution-continuity (patch, 链尾) ← Recovery Authority
```

### 2a. Failure Classifier 现状（EC，execution-continuity-core.mjs:52 `classifyFailure`）

已有 10 类：REASONING_PROTOCOL_ERROR / CONTEXT_OVERFLOW / RATE_LIMIT / PROVIDER_OUTAGE /
QUOTA_EXHAUSTED / MODEL_UNAVAILABLE / RETRYABLE_TRANSIENT / AUTH / INVALID_REQUEST / UNKNOWN，
配 DEFAULT_BUDGETS（sameModelRetries:3, providerFallbackCount:2, contextRecoveryCount:2,
contextOverflowRetry:1, autoResumeCycles:10）+ backoffDelay(jitter + Retry-After 覆盖)。

**语义缺口（本轮要补的全部）**：
- `RATE_LIMIT_RE`（含裸 "429"）先于 `QUOTA_EXHAUSTED_RE` 测试 → GLM 1310/1305 一律 RATE_LIMIT。
- 配额识别正则**只覆盖英文**（quota/balance/credits…），中文「使用上限/限额重置」不命中。
- 无 provider 业务码（1310/1305）概念；无 `unavailableUntil/resetAt` 解析；无 `normalizedSignature`。

### 2b. Retry Budget Authority 现状

- **core dsh-llm-retry**：每 provider `retryPolicy`（normal{maxRetries=5, retryableCodes, delays,
  jitter} / always）；计数**durable**（扫 session `llm/retry` 事件，per turn/step/provider/policyKey）；
  `providerRetryAfterMs ≤ maxDelayMs` 时直接采用，超上限时 normal 模式**放弃重试直接委托下游**。
- **EC**：预算组（上表）+ per-provider CircuitBreaker + WAITING_PROVIDER/nextRetryAt 定时恢复。
- **禁造第二套清单核对**：本轮不新增 retry database / daemon / controller / scheduler / task state。

### 2c. Router Authority 现状

- `agent/request`：唯一模型决策点（fallback chain deepseek→mimo→qwen，fallbackIndex 持久于内存 state）。
- `agent/request-error`：`PROVIDER_FAILURE_RE /(429|5\d{2}|timeout|…|overloaded|insufficient[_ ]quota|finance|keepalive)/i`
  → 跨模型单跳回落（primary 保护）。
- `ec/recovery-requirement` 桥：EC 只记录恢复需求（reason/modalities/needLargerContext），Router 消费并 ack，
  EC **不选模型**（Phase 02 R4 已确立，保持）。

### 2d. Side-Effect / Session 语义现状（复用，不重建）

- EC 恢复 = durable resume（session 续跑，Goal/Session 身份不变）；`hasPendingQuestion→WAITING_USER`；
  WAITING_USER/USER_PAUSED/USER_CANCELLED/COMPLETED/FAILED_FATAL 永不自动恢复（anti-double-kick）。
- 副作用安全 = EC 既有 completion-truth / transaction / checkpoint（Phase 02 系列），retry 前置检查沿用；
  本轮**不新增** side-effect ledger。
- `--no-open` 契约：`DSH-Harness-PS.ps1:344-346` 已于 2026-08-21 修复（`dsh web --port N --no-open`），
  本轮只加回归证据（T17），不重做 launcher。

## 3. 已存在 vs 缺失（Gap 表）

| Primitive | 状态 | 位置 |
|---|---|---|
| Retry-After 解析（core 侧） | **已有** | dsh-llm-deepseek/dsh-llm-pi-ai → failure.providerRetryAfterMs |
| Retry-After 尊重（恢复侧） | **已有** | llm-retry delayMs 覆盖 + EC backoffDelay(retryAfter) |
| per-provider retryPolicy 配置 seam | **已有（关键）** | pi-ai profile schema `retryPolicy`（settings.yaml 每 provider 条目可配，经 providerRetryPolicy()→payload.retryPolicy→llm-retry） |
| core 非重试码 QUOTA/AUTH/CONTEXT_WINDOW_EXCEEDED/INVALID_REQUEST | **已有** | dsh-llm QUOTA_EXCEEDED_CODE 等；默认 retryableCodes 不含它们 |
| 配额/溢出识别（英文文案） | **已有** | isQuotaExceededError / isContextWindowExceededError（dsh-llm 共享） |
| 配额/溢出识别（中文文案 + provider 业务码） | **缺失** | — |
| unavailableUntil/resetAt 解析（如「限额将在 <ts> 重置」） | **缺失** | — |
| normalizedSignature（防文字变体绕预算） | **缺失** | — |
| EC 分类器 provider-code 语义（1310 vs 1305 分流） | **缺失** | execution-continuity-core.classifyFailure |
| 分类证据留痕 | **部分** | llm/retry / turn/end 仅存原始 message+code；无分类结果事件 |
| reset 窗口内 defer（不盲恢复） | **缺失** | EC QUOTA 分支按 backoff 恢复，无视窗口 |

## 4. 根因判定（Root Cause, INFERRED→已由代码证实）

1310 风暴 = **两层分类器都缺 provider 业务码语义**：
1. core 适配器英文正则不识中文配额文案 → 1310 落入 RATE_LIMIT（core 默认策略可重试）→ 5 连击；
2. EC 分类器同样 "429"→RATE_LIMIT(retryable) → turn 级 resume → 再 5 连击。
其中 core 侧分类发生在 adapter 内部（消息→码映射，闭源只读），**patch 层无法前置改写**；
core 的 `isQuotaExceededError` 模式增强属**上游 core 修复**（本轮记录为 HARDENING/上游建议，不改 core）。

## 5. Minimal Insertion Points（本轮实施设计）

原则核对：全部为**薄层接入既有 seam**，零 core 修改、零第二引擎。

| # | 变更 | 类型 | Seam |
|---|---|---|---|
| I1 | 新增 `plugins/failure-classifier-core.mjs`：Taxonomy V1 纯函数（9 类 + NormalizedFailureObject + 1310/1305 业务码解析 + 中文配额/reset 文案 + unavailableUntil 解析 + normalizedSignature） | 新增（复用扩展，非第二分类器：EC 委托它） | 被 EC 与观察插件共同 import |
| I2 | 新增 `plugins/failure-classifier.mjs`：观察插件，patch 注册序**先于 openrouter-router**；仅分类+留痕（自有 JSONL 诊断文件，不新增 session 事件类型，不改写 payload），零决策 | 新增 | `agent/request-error` 链首（patch 层） |
| I3 | 修改 `plugins/execution-continuity-core.mjs`：`classifyFailure` 委托 V1 core（保留原类别名/返回形状，零行为回归），新增 QUOTA_EXHAUSTED 的 `unavailableUntil` + `retryable=false` 语义、1310→QUOTA、1305→RATE_LIMIT(overloaded 细分保留) | 修改（最小 diff） | EC Recovery Authority 内部 |
| I4 | 修改 `plugins/execution-continuity.mjs`：QUOTA 分支加 defer-until-unavailableUntil（WAITING_PROVIDER + `nextRetryAt=unavailableUntil`，预算封顶）；fallback-requirement 桥保持（需要 fallback 时仍只交 Router） | 修改（最小 diff） | EC 既有 switch |
| I5 | 修改 `~/.dsh/settings.yaml` zhipu 条目：`retryPolicy.retryableCodes` 移除 `RATE_LIMIT`（含 QUOTA 以前瞻）→ core 对 zhipu 的 429 in-request 盲重试=0（1310 与 1305 同；1305 的有界重试由 EC turn 级预算 + Router fallback 承担，见 §6 语义映射） | 生产配置（backup+YAML 校验） | core 显式文档化的 per-provider 配置点 |
| I6 | `cordis.patch.yml` 注册 failure-classifier（先于 openrouter-router），带 `enabled` 单开关 | 生产配置（backup+YAML 校验） | patch 层 |

## 6. 目标语义映射（Taxonomy V1 → 既有 Authority）

| Taxonomy V1 | 判定源 | retryableSameRoute | 交谁 |
|---|---|---|---|
| QUOTA_EXHAUSTED | 业务码 1310 / 配额文案(中英) | **0**（core 策略层 + EC defer） | EC defer→unavailableUntil；需要 route switch 时仅 Router |
| PROVIDER_OVERLOADED | 业务码 1305 / overloaded 文案 | 有界（EC turn 级预算+backoff） | 预算内 EC retry→Router fallback→无 fallback EC defer |
| SHORT_WINDOW_RATE_LIMIT | 429 + Retry-After（无 1310/1305） | 有界，尊重 Retry-After | 同上 |
| AUTH_PERMISSION_FAILURE | 401/403/AUTH | **0**（core 已不重试；EC FAILED_FATAL 不重同凭据） | 既有 credential/safe-degrade 路径 |
| MODEL_ROUTE_UNAVAILABLE | model not found 等 | 0 / 严格有限 | 仅 Router |
| NETWORK_TIMEOUT_5XX | timeout/5xx/TRANSPORT | 有界（core/EC 既有） | 预算尽→Router/defer |
| CONTEXT_LIMIT | context length exceeded | 非 network 重试 | official compaction + needLargerContext→Router |
| PROTOCOL_MISMATCH | reasoning_content/malformed（P2.6-A 已修根因） | 同坏请求 **0**（EC repair-retry-once 既有契约保留） | 既有 repair/fallback |
| UNKNOWN_PROVIDER_FAILURE | 兜底 | 既有 bounded（EC FAILED_FATAL/WAITING_PROVIDER 保守语义） | 既有恢复 |

Server hints 优先级：**Provider explicit reset（unavailableUntil）> Retry-After（providerRetryAfterMs）> 既有 bounded backoff**（I1 实现；不硬编码日期）。

## 7. 风险与红线核对

- **不改 core**：1310 的 core 级分类修复（英文正则增强/业务码透传）记录为上游建议（§8），本轮以 I5 配置 seam 达成同等效果。
- **1305 有界重试语义偏差的诚实说明**：I5 使 zhipu 的 core in-request RATE_LIMIT 重试=0（1310 硬性要求 retry=0 的必然代价，二者同为 RATE_LIMIT 码、core 策略无法按业务码分流）；1305 的有界重试由 **EC turn 级预算恢复**（sameModelRetries/backoff/breaker）+ **Router fallback** 承担——符合「达到现有预算后 Router fallback / EC defer」契约；core in-request 级 1305 重试保留在**其他 provider**（seam 按 provider 生效）。已列为已知的、可接受的语义权衡（REPORT 披露）。
- **不新增 session 事件类型**：分类留痕走插件自有 JSONL（仿 router-diagnostics），避免 session projection 校验风险；payload failure 对象**零改写**（llm/retry 持久化 schema 校验安全）。
- **rollback 单开关**：I2 `enabled:false` / 删除 patch 条目 + I5 移除 zhipu retryPolicy = 精确还原旧行为；repo 侧单 commit revert。
- settings.yaml / cordis.patch.yml 修改前备份 + js-yaml 校验（守护进程 lastgood 兜底不依赖）。

## 8. 上游 Core 修复建议（HARDENING，本轮不动手）

`@deepseek-ai/dsh-llm` 的 `isQuotaExceededError` 建议增加：中文配额文案（使用上限/限额重置/额度用尽）、
provider 业务码白名单（如 zhipu 1310）；`classifyPiAiError` 建议在 429 分流前做业务码检测，
使 1305（overloaded）与 1310（quota）在 core 层即分流为 RATE_LIMIT / QUOTA。
此修复属 Official Harness Core（RED ZONE），须上游发布流程处理。

## 9. 审计结论

- existing authority：core llm-retry（同路 in-request 重试）/ Router（模型唯一权威）/ EC（恢复权威）/ Context Memory（不参与错误分类，保持隔离）。
- reusable primitive：per-provider retryPolicy seam、Retry-After、EC 分类器+预算+defer 机制、fallback chain+requirement 桥、breaker、--no-open。
- missing primitive：业务码语义、中文文案识别、unavailableUntil、normalizedSignature、分类留痕。
- insertion point：I1–I6（全部薄层）。
- 可以进入实现，无阻塞。
