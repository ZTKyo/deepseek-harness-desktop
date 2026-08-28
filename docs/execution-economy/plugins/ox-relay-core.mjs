// ox-relay-core.mjs —— 同模型（stealth/ox-alpha）跨 relay provider failover 纯核心（单一真源）
//
// 纯模块：不做网络、不做 I/O、不调用 LLM、无随机性。同一输入永远产生同一决策。
// 被三处复用：1) ox-relay-failover.mjs（服务内插件，agent/request + agent/request-error 钩子）
//            2) 确定性单元测试（Node 直接 import）
//            3) ox-relay-audit.mjs 的分类引用（审计报告口径一致）
//
// 核心不变量（Same-Model Invariant，任务 §3）：
//   logical_model / requested_model / final_model 永远等于 OX_ALPHA_MODEL（stealth/ox-alpha）。
//   Fallback 只允许改变 provider（relay 身份），绝不允许改变 model。
//
// Fallback 触发条件（任务 §2，白名单，严格枚举）——只允许真实 provider failure：
//   RATE_LIMIT  429 / overloaded
//   SERVER      5xx
//   TRANSPORT   connection / DNS / network / stream 连接失败
//   TIMEOUT     provider timeout / stream idle timeout
// 其他一切（正常完成、用户取消、auth/billing/access、UNKNOWN_MODEL、content error）一律不 fallback。

export const OX_ALPHA_MODEL = "stealth/ox-alpha";

// 规范失败码（与 dsh-llm / dsh-llm-pi-ai 的 canonical code 对齐；见
// @deepseek-ai/dsh-llm 的 HarnessError.code 与 dsh-llm-pi-ai 的 classifyPiAiError）
export const PROVIDER_FAILURE_CODES = Object.freeze(new Set([
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
]));

// 明确禁止 fallback 的失败类别（任务 §2：必须如实报错，不许偷偷换 provider/model 掩盖问题）
export const NO_FALLBACK_CODES = Object.freeze(new Set([
  "AUTH",                    // 401/403 —— ACCESS_REQUIRED / AUTH_REQUIRED
  "INVALID_CREDENTIAL",      // 凭据格式错误
  "MISSING_CREDENTIAL",      // 凭据引用解析为空
  "QUOTA",                   // 余额/配额耗尽 —— PAYMENT_REQUIRED
  "UNKNOWN_MODEL",           // 该 route 未配置此模型 —— model identity mismatch
  "INVALID_REQUEST",         // 400/prompt/content error
  "CONTEXT_WINDOW_EXCEEDED", // 内容超窗（content error）
  "EMPTY_RESPONSE",          // provider 正常完成但空响应（非 provider failure）
  "ABORTED",                 // 用户取消 / 主动 stop
  "NO_ADAPTER",
  "PI_AI_ERROR",
  "DISCOVERY_FAILED",
]));

// 默认 relay 链（env 可覆盖）。每个条目都是独立的 provider/route identity（任务 §5）。
// 真实审计（2026-08-21）结论：
//   ox-relay-a = OpenRouter（SUPPORTED，respModel=stealth/ox-alpha）
//   ox-relay-b = Command Code（SUPPORTED，respModel=stealth/ox-alpha）
//   agentrouter / opencode-zen / zenmux / bai = UNSUPPORTED（不进入链）
// 若某 relay 不支持，如实缩短链（任务 §12），绝不造假。
export const DEFAULT_RELAY_CHAIN = Object.freeze(["ox-relay-a", "ox-relay-b"]);

export function resolveChain(env = {}) {
  const raw = (env && env.OX_RELAY_CHAIN) || "";
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : [...DEFAULT_RELAY_CHAIN];
}

export function resolveModel(env = {}) {
  const m = (env && env.OX_ALPHA_MODEL && String(env.OX_ALPHA_MODEL).trim()) || "";
  return m.length > 0 ? m : OX_ALPHA_MODEL;
}

/**
 * 规范化失败分类：优先用 canonical code（failure.code），缺失时按 message 关键字回退。
 * 返回与 PROVIDER_FAILURE_CODES / NO_FALLBACK_CODES 对齐的字符串。
 * @param {object|null} failure
 * @returns {string}
 */
export function classifyFailure(failure) {
  const code = failure && typeof failure.code === "string" && failure.code.length > 0
    ? failure.code.trim().toUpperCase()
    : "";
  if (PROVIDER_FAILURE_CODES.has(code)) return code;
  if (NO_FALLBACK_CODES.has(code)) return code;
  const msg = String(failure && (failure.message || failure.reason || failure.detail) || "");
  if (!msg) return code || "UNKNOWN";
  if (/\b(?:401|403)\b/.test(msg)) return "AUTH";
  if (/\b429\b|rate.?limit|overloaded/i.test(msg)) return "RATE_LIMIT";
  if (/\binsufficient[ _-](?:quota|balance|credits?)\b|\b(?:quota|usage[ _-]limit)[ _-](?:exceeded|exhausted|reached)\b|\bout[ _-]of[ _-](?:credits?|budget)\b|payment|billing/i.test(msg)) return "QUOTA";
  if (/\b5\d\d\b/.test(msg)) return "SERVER";
  if (/\bunknown[_ ]model\b|model[ _-]not[ _-]found|does not exist|not (?:found|available|supported)/i.test(msg)) return "UNKNOWN_MODEL";
  if (/\btime(?:d)?\s*out\b|timeout|etimedout|idle/i.test(msg)) return "TIMEOUT";
  if (/\b(?:network|connection|socket|fetch|dns)\b|\bECONN[A-Z]+\b|\benotfound\b|\beconnreset\b|\beconnrefused\b|stream ended|premature close|other side closed/i.test(msg)) return "TRANSPORT";
  if (/\bempty[_ ]response|no[_ ]content|zero[_ ]tokens|returned an empty/i.test(msg)) return "EMPTY_RESPONSE";
  if (/\babort(?:ed)?\b|cancel(?:led|lation)?\b|user stopped/i.test(msg)) return "ABORTED";
  if (/\b400\b|invalid[ _-]request|bad request/i.test(msg)) return "INVALID_REQUEST";
  if (/context[ _-]window|context[ _-]length|too (?:large|long) for/i.test(msg)) return "CONTEXT_WINDOW_EXCEEDED";
  return code || "UNKNOWN";
}

/** 是否属于允许触发 fallback 的真实 provider failure。 */
export function isProviderFailure(failure) {
  return PROVIDER_FAILURE_CODES.has(classifyFailure(failure));
}

/** 是否属于禁止 fallback 的类别（auth/billing/access/model/content/user）。 */
export function isNoFallbackFailure(failure) {
  return NO_FALLBACK_CODES.has(classifyFailure(failure));
}

/**
 * 下一个 relay provider id；链末返回 null（= 全部耗尽，fail closed）。
 * @param {string} failingProvider 本次失败的 provider id
 * @param {string[]} chain relay 链（ox-relay-a, ox-relay-b, ...）
 * @param {string[]} usedProviders 本轮已实际尝试过的 provider id（有序）
 * @returns {string|null}
 */
export function nextProvider(failingProvider, chain, usedProviders = []) {
  const list = chain && chain.length > 0 ? chain : DEFAULT_RELAY_CHAIN;
  const ordered = [...new Set([...usedProviders, ...list])];
  const idx = ordered.indexOf(failingProvider);
  const next = idx >= 0 ? ordered[idx + 1] : list[0] ?? null;
  return next ?? null;
}

/**
 * 构建机器可读的 attempt 记录（任务 §15 的观测字段）。
 * @param {object} p
 * @returns {object} 固定字段：logical_model/requested_model/attempt/provider/failure_kind/next_provider/final_provider/final_model
 */
export function buildAttemptRecord(p) {
  const model = p.model || OX_ALPHA_MODEL;
  return {
    logical_model: model,
    requested_model: p.requestedModel || model,
    attempt: Number.isInteger(p.attempt) ? p.attempt : 0,
    provider: p.provider ?? null,
    failure_kind: p.failureKind ?? null,
    next_provider: p.nextProvider ?? null,
    final_provider: p.finalProvider ?? null,
    final_model: model, // 同模型不变量：永远是 stealth/ox-alpha
    relay_exhausted: !!p.exhausted,
  };
}

/**
 * Fail-closed 错误（任务 §16）：A/B/C 全失败 → 明确失败，不降级到 DeepSeek 等。
 * 错误消息包含 "all ox-alpha relay attempts exhausted" 与每个 provider 的简要 failure kind，
 * 不含任何 secret。
 * @param {Array<{provider:string, failure_kind:string|null}>} attempts
 * @returns {Error}
 */
export function failClosedError(attempts = []) {
  const detail = attempts
    .map((a) => `${a.provider}=${a.failure_kind || "unknown"}`)
    .join(", ");
  const msg = `all ox-alpha relay attempts exhausted (${detail || "no attempts recorded"})`;
  const err = new Error(msg);
  err.code = "OX_ALPHA_RELAYS_EXHAUSTED";
  err.attempts = attempts;
  return err;
}

/** 幂等：attempt 序号从 1 开始，等于 usedProviders.length（按实际使用顺序）。 */
export function attemptNumberFor(usedProviders) {
  return Array.isArray(usedProviders) ? usedProviders.length : 0;
}
