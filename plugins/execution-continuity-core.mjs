// execution-continuity-core.mjs — 错误分类器 + 恢复决策 + 预算管理 + 断路器（纯逻辑，无外部依赖）
//
// 职责：
//   1. classifyFailure(failure) → { category, retryable, providerRetryAfterMs }
//   2. decideRecovery(category, sessionState, circuitState) → { action, params }
//   3. Budgets + backoff（指数退避 + jitter + Retry-After）
//   4. Circuit breaker（provider/model 健康标记 + 冷却期）
//   5. Capability compatibility check（context window / modalities）
//
// Phase 02 R1 (BLOCKING-1/3): 模型能力事实统一从单一 Model Registry 读取，
// 本模块不再维护第二套 MODEL_CONTEXT_WINDOWS / modality regex。
// 本模块不依赖任何 DSH 运行时，仅使用标准 JS 类型。

import { modelSupports as registryModelSupports, getContextWindow } from "./model-registry.mjs";
// P2.6 R1: single source of truth for failure-shape patterns now lives in
// failure-classifier-core.mjs (Taxonomy V1). classifyFailure delegates; the
// legacy pattern constants below were moved there VERBATIM so pre-existing
// classifications don't drift, with only the intended R1 semantic fixes
// (provider business codes 1310/1305, Chinese quota wording, unavailableUntil).
import { classifyFailureV1, FAILURE_CLASS, TAXONOMY_VERSION } from "./failure-classifier-core.mjs";

export { FAILURE_CLASS, TAXONOMY_VERSION };

// ─── 错误分类 ───────────────────────────────────────────────────────────────

export const CATEGORY = Object.freeze({
  REASONING_PROTOCOL_ERROR: 'REASONING_PROTOCOL_ERROR',
  CONTEXT_OVERFLOW:   'CONTEXT_OVERFLOW',
  RETRYABLE_TRANSIENT:'RETRYABLE_TRANSIENT',
  RATE_LIMIT:         'RATE_LIMIT',
  PROVIDER_OUTAGE:    'PROVIDER_OUTAGE',
  QUOTA_EXHAUSTED:    'QUOTA_EXHAUSTED',
  MODEL_UNAVAILABLE:  'MODEL_UNAVAILABLE',
  INVALID_REQUEST:    'INVALID_REQUEST',
  AUTH:               'AUTH',
  UNKNOWN:            'UNKNOWN',
});

/**
 * 分类一个错误（failure 对象来自 agent/request-error payload）。
 * P2.6 R1: 委托 failure-classifier-core (Taxonomy V1)，本函数只做 V1→EC 类别
 * 映射并保持既有返回形状 { category, retryable, providerRetryAfterMs }；
 * 额外携带 taxonomy 事实（taxonomyClass / providerCode / unavailableUntil /
 * normalizedSignature / deterministic / retryableSameRoute）供恢复层使用。
 *
 * 有意的 R1 语义变化（对照旧实现，见 P26_R1_BASELINE_AUDIT.md §6）：
 *  - QUOTA_EXHAUSTED 不再 retryable（同路重试预算=0），携带 unavailableUntil
 *    （provider 明确重置时间）——恢复层改为 defer，不再窗口内盲恢复。
 *  - provider 业务码 1310/1305 及中文配额/过载文案优先于裸 429 判定
 *    （与 core 适配器 isQuotaExceededError 先于 429 的顺序对齐）。
 *  - 其余类别映射与旧实现逐一保形（REASONING→…→UNKNOWN 延迟值不变）。
 *
 * @param {object} failure - { code, message, providerRetryAfterMs?, status? }
 * @param {object} [context] - { provider, model, nowMs, tzOffsetMinutes }
 * @returns {{ category: string, retryable: boolean, providerRetryAfterMs: number,
 *             taxonomyVersion: number, taxonomyClass: string, providerCode: string|null,
 *             unavailableUntil: number|null, normalizedSignature: string,
 *             deterministic: boolean, retryableSameRoute: boolean, overload?: boolean }}
 */
export function classifyFailure(failure, context = {}) {
  const v1 = classifyFailureV1(failure, context);
  const retryAfter = v1.retryAfterMs;
  const base = {
    taxonomyVersion: TAXONOMY_VERSION,
    taxonomyClass: v1.classification,
    providerCode: v1.providerCode,
    unavailableUntil: v1.unavailableUntil ?? null,
    normalizedSignature: v1.normalizedSignature,
    deterministic: v1.deterministic,
    retryableSameRoute: v1.retryableSameRoute,
  };
  switch (v1.classification) {
    case FAILURE_CLASS.PROTOCOL_MISMATCH:
      // 保留 EC 既有契约：repair-retry-once（修复请求状态后的重试不是盲重放同一坏请求）。
      return { ...base, category: CATEGORY.REASONING_PROTOCOL_ERROR, retryable: true, providerRetryAfterMs: 0 };
    case FAILURE_CLASS.CONTEXT_LIMIT:
      return { ...base, category: CATEGORY.CONTEXT_OVERFLOW, retryable: true, providerRetryAfterMs: 0 };
    case FAILURE_CLASS.QUOTA_EXHAUSTED:
      // R1: quota 同路重试预算=0；defer 由恢复层按 unavailableUntil 执行。
      return { ...base, category: CATEGORY.QUOTA_EXHAUSTED, retryable: false, providerRetryAfterMs: retryAfter || 30000 };
    case FAILURE_CLASS.PROVIDER_OVERLOADED:
      // R1: 1305/overload 细分（仍是 RATE_LIMIT 类别=有界恢复），overload 标记供证据。
      return { ...base, category: CATEGORY.RATE_LIMIT, retryable: true, providerRetryAfterMs: retryAfter || 5000, overload: true };
    case FAILURE_CLASS.SHORT_WINDOW_RATE_LIMIT:
      return { ...base, category: CATEGORY.RATE_LIMIT, retryable: true, providerRetryAfterMs: retryAfter || 5000 };
    case FAILURE_CLASS.AUTH_PERMISSION_FAILURE:
      return { ...base, category: CATEGORY.AUTH, retryable: false, providerRetryAfterMs: 0 };
    case FAILURE_CLASS.MODEL_ROUTE_UNAVAILABLE:
      return { ...base, category: CATEGORY.MODEL_UNAVAILABLE, retryable: false, providerRetryAfterMs: 0 };
    case FAILURE_CLASS.NETWORK_TIMEOUT_5XX:
      return v1.subKind === 'PROVIDER_OUTAGE'
        ? { ...base, category: CATEGORY.PROVIDER_OUTAGE, retryable: true, providerRetryAfterMs: retryAfter || 10000 }
        : { ...base, category: CATEGORY.RETRYABLE_TRANSIENT, retryable: true, providerRetryAfterMs: retryAfter || 3000 };
    default:
      return v1.deterministic
        ? { ...base, category: CATEGORY.INVALID_REQUEST, retryable: false, providerRetryAfterMs: 0 }
        : { ...base, category: CATEGORY.UNKNOWN, retryable: false, providerRetryAfterMs: 0 };
  }
}

// ─── 预算与退避 ────────────────────────────────────────────────────────────

export const DEFAULT_BUDGETS = Object.freeze({
  sameModelRetries: 3,        // 同模型重试上限
  providerFallbackCount: 2,   // 跨 Provider/模型回退上限
  contextRecoveryCount: 2,    // 上下文溢出恢复上限（compaction 次数）
  contextOverflowRetry: 1,    // 上下文溢出后同模型重试次数
  autoResumeCycles: 10,       // 自动续跑回合上限（防 recovery storm）
  initialDelayMs: 1000,       // 初试延迟（ms）
  maxDelayMs: 60000,          // 最大延迟（ms）
  jitterRatio: 0.3,           // 抖动系数
});

/**
 * 计算指数退避延迟（含 jitter + Retry-After 覆盖）。
 * @param {number} retryCount - 当前已重试次数
 * @param {object} [budgets]
 * @param {number} [budgets.initialDelayMs]
 * @param {number} [budgets.maxDelayMs]
 * @param {number} [budgets.jitterRatio]
 * @param {number} [providerRetryAfterMs] - 服务端给出的 Retry-After
 * @returns {number} 延迟毫秒数
 */
export function backoffDelay(retryCount, budgets = DEFAULT_BUDGETS, providerRetryAfterMs = 0) {
  if (providerRetryAfterMs > 0) {
    return Math.min(providerRetryAfterMs, budgets.maxDelayMs);
  }
  const exponent = Math.min(retryCount, 10);
  const exponential = Math.min(budgets.initialDelayMs * 2 ** exponent, budgets.maxDelayMs);
  const jitter = 1 - budgets.jitterRatio + 2 * budgets.jitterRatio * Math.random();
  return Math.round(Math.min(exponential * jitter, budgets.maxDelayMs));
}

/**
 * 判断是否还有预算进行重试/回退。
 * @param {string} action - 'retry' | 'fallback' | 'context-recovery' | 'auto-resume'
 * @param {object} state - 会话级别计数器 { retryCount, fallbackCount, contextRecoveryCount, autoResumeCycles }
 * @param {object} [budgets]
 * @returns {boolean}
 */
export function hasBudget(action, state = {}, budgets = DEFAULT_BUDGETS) {
  switch (action) {
    case 'retry': return (state.retryCount || 0) < budgets.sameModelRetries;
    case 'fallback': return (state.fallbackCount || 0) < budgets.providerFallbackCount;
    case 'context-recovery': return (state.contextRecoveryCount || 0) < budgets.contextRecoveryCount;
    case 'auto-resume': return (state.autoResumeCycles || 0) < budgets.autoResumeCycles;
    default: return false;
  }
}

// ─── 断路器 ─────────────────────────────────────────────────────────────────

/**
 * 创建断路器（每个 (provider, model) 独立状态）。
 * @param {number} [cooldownMs=60000] - 冷却期毫秒
 * @param {number} [threshold=3] - 连续失败次数触发断路
 * @returns {object} circuitBreaker API
 */
export function createCircuitBreaker(cooldownMs = 60000, threshold = 3) {
  const state = new Map(); // key: `${provider}::${model}` -> { failures, cooldownUntil, lastFailureAt }

  function key(provider, model) {
    return `${String(provider || '?')}::${String(model || '?')}`;
  }

  function canUse(provider, model) {
    const k = key(provider, model);
    const s = state.get(k);
    if (!s) return true;
    if (s.cooldownUntil && Date.now() < s.cooldownUntil) return false;
    if (s.failures >= threshold) {
      s.cooldownUntil = Date.now() + cooldownMs;
      return false;
    }
    return true;
  }

  function recordFailure(provider, model) {
    const k = key(provider, model);
    let s = state.get(k);
    if (!s) {
      s = { failures: 0, cooldownUntil: 0, lastFailureAt: 0 };
      state.set(k, s);
    }
    s.failures += 1;
    s.lastFailureAt = Date.now();
    if (s.failures >= threshold) {
      s.cooldownUntil = Date.now() + cooldownMs;
    }
  }

  function recordSuccess(provider, model) {
    const k = key(provider, model);
    state.delete(k);
  }

  function getState(provider, model) {
    const k = key(provider, model);
    return state.get(k) || { failures: 0, cooldownUntil: 0, lastFailureAt: 0 };
  }

  function reset() { state.clear(); }

  function diagnostics() {
    const out = {};
    for (const [k, s] of state) out[k] = { ...s };
    return out;
  }

  return { canUse, recordFailure, recordSuccess, getState, reset, diagnostics };
}

// ─── 兼容性检查 ─────────────────────────────────────────────────────────────
// Phase 02 R1 (BLOCKING-3): 模型能力事实统一来自 plugins/model-registry.mjs。
// 本模块只做 policy（排序/排除当前模型），不持有模型事实数据。

/**
 * 检查模型是否满足所需能力（委托 Model Registry 单一事实源）。
 * @param {string} modelId - 模型 ID
 * @param {object} required - { modalities: string[], tools: boolean, structuredJson: boolean, contextWindow: number }
 * @returns {boolean}
 */
export function modelSupports(modelId, required = {}) {
  return registryModelSupports(modelId, required);
}

/**
 * 查找兼容 fallback 模型（按 context window 降序，来自 Registry 事实）。
 * @param {string} currentModelId - 当前失败模型
 * @param {object} required - 所需能力
 * @param {string[]} candidates - 候选模型 ID 列表
 * @returns {string|null} 第一个兼容的模型 ID，或 null
 */
export function compatibleFallback(currentModelId, required = {}, candidates = []) {
  const sorted = [...candidates]
    .filter((m) => registryModelSupports(m, required))
    .sort((a, b) => (getContextWindow(b) || 0) - (getContextWindow(a) || 0));
  for (const m of sorted) {
    if (m !== currentModelId) return m;
  }
  return null;
}