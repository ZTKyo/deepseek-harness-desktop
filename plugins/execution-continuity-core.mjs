// execution-continuity-core.mjs — 错误分类器 + 恢复决策 + 预算管理 + 断路器（纯逻辑，无外部依赖）
//
// 职责：
//   1. classifyFailure(failure) → { category, retryable, providerRetryAfterMs }
//   2. decideRecovery(category, sessionState, circuitState) → { action, params }
//   3. Budgets + backoff（指数退避 + jitter + Retry-After）
//   4. Circuit breaker（provider/model 健康标记 + 冷却期）
//   5. Capability compatibility check（context window / modalities）
//
// 本模块不依赖任何 DSH 运行时，仅使用标准 JS 类型。

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

// 分类关键词（大小写不敏感匹配）
// P0 细分类优先：reasoning_content / thinking-mode 协议错误（确定性 400，盲重试重复失败，需修复请求状态后重试）
const REASONING_PROTOCOL_RE = /(reasoning_content.*must be passed back|thinking mode.*must be passed back|must be passed back to the API)/i;
// 上下文溢出（网络层报告的 quotaLimitReached 也可能是 input token 超限）
const CTX_OVERFLOW_RE = /(input token exceed|context.*window|token.*limit|input.*too large|context length|maximum context|max_tokens|context_length_exceeded)/i;
const RETRYABLE_TRANSIENT_RE = /(timeout|timed\s*out|etimedout|econnreset|econnrefused|enotfound|econnaborted|keepalive|empty[_ ]response|empty response|no[_ ]content|no[_ ]output)/i;
const RATE_LIMIT_RE = /(429|rate[_ ]limit|rate limit|too many requests|retry.*after|retry_after)/i;
const PROVIDER_OUTAGE_RE = /(5\d{2}|service unavailable|overloaded|internal server error|bad gateway|gateway timeout|server error|temporarily unavailable)/i;
const QUOTA_EXHAUSTED_RE = /(quota|insufficient.*quota|usage.*limit|billing|allowance.*exhausted|finance|payment)/i;
const MODEL_UNAVAILABLE_RE = /(model.*not.*found|unknown.*model|no.*adapter|model.*unavailable|model.*not.*supported|unrecognized.*model)/i;
const AUTH_RE = /(401|403|unauthorized|forbidden|invalid.*api.*key|authentication|api.*key.*required|no.*auth)/i;

/**
 * 分类一个错误（failure 对象来自 agent/request-error payload）。
 * @param {object} failure
 * @param {string} [failure.code]
 * @param {string} [failure.message]
 * @param {number} [failure.providerRetryAfterMs]
 * @param {number} [failure.statusCode]
 * @returns {{ category: string, retryable: boolean, providerRetryAfterMs: number }}
 */
export function classifyFailure(failure) {
  if (!failure) return { category: CATEGORY.UNKNOWN, retryable: false, providerRetryAfterMs: 0 };
  const code = String(failure.code || '');
  const msg = String(failure.message || '');
  const combined = code + ' ' + msg;
  const retryAfter = Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0 ? failure.providerRetryAfterMs : 0;

  // 优先级：P0 最具体 → CONTEXT_OVERFLOW → ...
  // 0) reasoning_protocol 必须最先（避免被 QUOTA/INVALID 抢匹配）
  if (REASONING_PROTOCOL_RE.test(combined)) {
    return { category: CATEGORY.REASONING_PROTOCOL_ERROR, retryable: true, providerRetryAfterMs: 0 };
  }
  if (CTX_OVERFLOW_RE.test(combined)) {
    return { category: CATEGORY.CONTEXT_OVERFLOW, retryable: true, providerRetryAfterMs: 0 };
  }
  if (RATE_LIMIT_RE.test(combined)) {
    return { category: CATEGORY.RATE_LIMIT, retryable: true, providerRetryAfterMs: retryAfter || 5000 };
  }
  if (PROVIDER_OUTAGE_RE.test(combined)) {
    return { category: CATEGORY.PROVIDER_OUTAGE, retryable: true, providerRetryAfterMs: retryAfter || 10000 };
  }
  if (QUOTA_EXHAUSTED_RE.test(combined)) {
    return { category: CATEGORY.QUOTA_EXHAUSTED, retryable: true, providerRetryAfterMs: retryAfter || 30000 };
  }
  if (MODEL_UNAVAILABLE_RE.test(combined)) {
    return { category: CATEGORY.MODEL_UNAVAILABLE, retryable: false, providerRetryAfterMs: 0 };
  }
  if (RETRYABLE_TRANSIENT_RE.test(combined)) {
    return { category: CATEGORY.RETRYABLE_TRANSIENT, retryable: true, providerRetryAfterMs: retryAfter || 3000 };
  }
  if (AUTH_RE.test(combined)) {
    return { category: CATEGORY.AUTH, retryable: false, providerRetryAfterMs: 0 };
  }
  // 400 或未知 code 落入 INVALID_REQUEST
  if (/^4\d{2}$/.test(code) || code === '400' || /invalid_request/i.test(combined)) {
    return { category: CATEGORY.INVALID_REQUEST, retryable: false, providerRetryAfterMs: 0 };
  }
  return { category: CATEGORY.UNKNOWN, retryable: false, providerRetryAfterMs: 0 };
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

// 已知模型的 context window 近似值（来自 settings.yaml 预估）
const MODEL_CONTEXT_WINDOWS = {
  'deepseek/deepseek-v4-flash-0731': 1310720,
  'deepseek-v4-flash': 1000000,
  'deepseek-v4-flash-vision-exp': 1000000,
  'deepseek-v4-pro': 1000000,
  'xiaomi/mimo-v2.5': 1050000,
  'mimo-v2.5': 1048576,
  'qwen/qwen3.7-flash': 1000000,
  'qwen3.7-plus': 200000,
  'deepseek-v4-flash-free': 200000,
  'stealth/ox-alpha': 1048576,
  'meta/muse-spark-1.2-contributor': 1048576,
  'gpt-5.6-sol': 400000,
  'claude-opus-5': 200000,
  'claude-opus-4-8': 200000,
};

/**
 * 检查模型是否满足所需能力。
 * @param {string} modelId - 模型 ID
 * @param {object} required - { modalities: string[], tools: boolean, structuredJson: boolean, contextWindow: number }
 * @returns {boolean}
 */
export function modelSupports(modelId, required = {}) {
  if (!modelId) return false;
  if (required.contextWindow && required.contextWindow > (MODEL_CONTEXT_WINDOWS[modelId] || Infinity)) return false;
  // 多模态能力：已知支持 image/video 的模型（来自 settings 的 input 字段）
  const hasImage = /mimo|vision|ox-alpha|muse/i.test(modelId);
  if (required.modalities && required.modalities.includes('image') && !hasImage) return false;
  // 工具/structured JSON：DeepSeek 系列全支持；Qwen 部分支持
  if (required.structuredJson && /qwen/i.test(modelId)) return false;
  if (required.tools && /qwen/i.test(modelId)) return false;
  return true;
}

/**
 * 查找兼容 fallback 模型（按 context window 降序）。
 * @param {string} currentModelId - 当前失败模型
 * @param {object} required - 所需能力
 * @param {string[]} candidates - 候选模型 ID 列表
 * @returns {string|null} 第一个兼容的模型 ID，或 null
 */
export function compatibleFallback(currentModelId, required = {}, candidates = []) {
  const sorted = [...candidates]
    .filter((m) => modelSupports(m, required))
    .sort((a, b) => (MODEL_CONTEXT_WINDOWS[b] || 0) - (MODEL_CONTEXT_WINDOWS[a] || 0));
  for (const m of sorted) {
    if (m !== currentModelId) return m;
  }
  return null;
}