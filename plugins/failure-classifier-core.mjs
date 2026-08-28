// failure-classifier-core.mjs — P2.6 R1 Failure Taxonomy V1 (pure functions)
// ─────────────────────────────────────────────────────────────────────────────
// Roadmap: docs/roadmap/PHASE_02_6_RETRY_SEMANTICS.md R1
// Audit:   docs/roadmap/reports/PHASE_02_6_RETRY_SEMANTICS/P26_R1_BASELINE_AUDIT.md
//
// Design contract (from the phase task brief + baseline audit):
//  - PURE module: no imports, no I/O, no clock reads (nowMs injected), no state.
//    It never mutates its inputs and never decides recovery. Consumers:
//      * plugins/execution-continuity-core.mjs (Recovery Authority — delegates)
//      * plugins/failure-classifier.mjs (thin observation plugin, evidence only)
//  - Single source of truth for error-shape patterns. The legacy EC patterns
//    moved here verbatim so existing EC categories keep their behavior
//    (documented per-category mapping below); only the intended semantic fixes
//    are new:
//      (a) provider business codes (e.g. zhipu 1310 quota / 1305 overload)
//          are detected BEFORE the generic 429->rate-limit mapping,
//      (b) Chinese quota/overload wording is recognized,
//      (c) provider explicit reset timestamps are parsed into
//          `unavailableUntil` (server hints priority: explicit reset >
//          Retry-After > backoff; NEVER a hardcoded date),
//      (d) stable `normalizedSignature` for cross-attempt correlation.
//  - Budget enforcement stays count-based in the EC Recovery Authority, so a
//    text variant can never bypass an existing budget (T13). The signature is
//    correlation metadata, not a budget key.
//
// Classification priority (first match wins):
//   1 PROTOCOL_MISMATCH        deterministic protocol violation (reasoning_content contract,
//                              STREAM_CLOSED / MALFORMED_RESPONSE) — same bad request is never retried
//   2 CONTEXT_LIMIT            context window / token limit — network retry pointless; official
//                              compaction + needLargerContext->Router own recovery
//   3 QUOTA_EXHAUSTED          business code (1310) OR quota wording (EN+CN) — same-route retry = 0,
//                              defer until provider reset when parseable
//   4 PROVIDER_OVERLOADED      business code (1305) OR overload wording — bounded recovery only
//   5 SHORT_WINDOW_RATE_LIMIT  remaining 429 / rate-limit wording (with Retry-After respect)
//   6 AUTH_PERMISSION_FAILURE  401/403/AUTH/INVALID_CREDENTIAL — no same-credential retry
//   7 MODEL_ROUTE_UNAVAILABLE  model not found / unsupported
//   8 NETWORK_TIMEOUT_5XX  5xx / timeout / transport / empty response / stream
//                          network errors without status evidence (bounded retryable)
//   9 UNKNOWN_PROVIDER_FAILURE fallback; deterministic when evidence shows a hard 4xx
// Note vs legacy EC order: QUOTA now outranks RATE_LIMIT *by design* — a 429
// carrying a quota body used to be swallowed as RATE_LIMIT (the 2026-08 storm);
// AUTH stays after RATE_LIMIT as before (no behavior drift observed there).

export const TAXONOMY_VERSION = 1;

export const FAILURE_CLASS = Object.freeze({
  PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH",
  CONTEXT_LIMIT: "CONTEXT_LIMIT",
  QUOTA_EXHAUSTED: "QUOTA_EXHAUSTED",
  PROVIDER_OVERLOADED: "PROVIDER_OVERLOADED",
  SHORT_WINDOW_RATE_LIMIT: "SHORT_WINDOW_RATE_LIMIT",
  AUTH_PERMISSION_FAILURE: "AUTH_PERMISSION_FAILURE",
  MODEL_ROUTE_UNAVAILABLE: "MODEL_ROUTE_UNAVAILABLE",
  NETWORK_TIMEOUT_5XX: "NETWORK_TIMEOUT_5XX",
  UNKNOWN_PROVIDER_FAILURE: "UNKNOWN_PROVIDER_FAILURE",
});

// ── Pattern set (single source of truth) ────────────────────────────────────

// Legacy EC patterns (kept VERBATIM so pre-existing classifications don't drift).
const REASONING_PROTOCOL_RE = /(reasoning_content.*must be passed back|thinking mode.*must be passed back|must be passed back to the API)/i;
const CTX_OVERFLOW_RE = /(input token exceed|context.*window|token.*limit|input.*too large|context length|maximum context|max_tokens|context_length_exceeded)/i;
const RATE_LIMIT_RE = /(429|rate[_ ]limit|rate limit|too many requests|retry.*after|retry_after)/i;
const PROVIDER_OUTAGE_RE = /(5\d{2}|service unavailable|overloaded|internal server error|bad gateway|gateway timeout|server error|temporarily unavailable)/i;
const QUOTA_EXHAUSTED_RE = /(quota|insufficient.*quota|usage.*limit|billing|allowance.*exhausted|finance|payment)/i;
const MODEL_UNAVAILABLE_RE = /(model.*not.*found|unknown.*model|no.*adapter|model.*unavailable|model.*not.*supported|unrecognized.*model)/i;
const AUTH_RE = /(401|403|unauthorized|forbidden|invalid.*api.*key|authentication|api.*key.*required|no.*auth)/i;
const RETRYABLE_TRANSIENT_RE = /(timeout|timed\s*out|etimedout|econnreset|econnrefused|enotfound|econnaborted|keepalive|empty[_ ]response|empty response|no[_ ]content|no[_ ]output)/i;

// NEW in R1 (2026-08-28 real incident, session a144fe3f, provider=bai
// glm-5.3-flash): stream-level network failures that carry NO HTTP status
// evidence — `finish_reason=network_error`, provider internal marker
// PI_AI_ERROR, turn/end(error). Evidence-bounded rules:
//   - they are TRANSIENT transport faults (bounded retry, never fatal),
//   - they must NOT be recorded as 5xx (no HTTP status was observed — the
//     httpStatus field stays undefined and the signature status bucket is "-"),
//   - only literal stream/network shapes match; a bare "error" never does.
// Old behavior: this shape fell through to UNKNOWN_PROVIDER_FAILURE
// (retryableSameRoute=false) => fatal turn termination.
const NETWORK_STREAM_TRANSIENT_RE = /(network[_ ]?error|pi[_ ]?ai[_ ]?error|finish[_ ]?reason\s*[=:]\s*network[_ ]?error|stream\s+(terminated|aborted|interrupted|dropped)|socket\s+hang\s+up|fetch\s+failed|prematurely\s+closed)/i;

// NEW in R1: provider business codes embedded in the error body.
// Known today (zhipu/BigModel): 1310 = quota/usage window exhausted (with reset
// timestamp), 1305 = provider overloaded (transient). The sets are data, not
// logic — extend without touching the classifier.
export const QUOTA_PROVIDER_CODES = new Set(["1310"]);
export const OVERLOAD_PROVIDER_CODES = new Set(["1305"]);
const PROVIDER_CODE_RE = /"code"\s*:\s*"?(1310|1305)"?/i;

// NEW in R1: Chinese provider wording (observed in the real 2026-08 incident).
const CHINESE_QUOTA_RE = /(使用上限|额度(已)?用尽|配额(已)?(超限|用尽|达?上限)|余额不足|欠费|资源包(已)?(到期|用完)|限额(已)?用完|达到.{0,12}(使用|用量|配额|限额).{0,4}(上限|限额))/;
const CHINESE_OVERLOAD_RE = /(服务繁忙|系统繁忙|负载(过高|已满)|请求过于频繁|请稍后重试)/;
const OVERLOAD_EN_RE = /(server\s+is\s+busy|server\s+busy|system\s+busy|temporarily\s+over\s+capacity)/i;

// Reset-timestamp extraction. Priority: labeled CJK/ISO date > labeled epoch.
// Naive timestamps are interpreted in SERVER-LOCAL time (documented limitation:
// providers emitting Beijing time on a Beijing-local server parse exactly; a
// non-Chinese-timezone host should set context.tzOffsetMinutes if needed).
const RESET_CJK_DATE_RE = /(?:重置|恢复|解锁|reset)[^\d]{0,16}(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/;
const RESET_ISO_RE = /(?:重置|恢复|解锁|reset)[^\d]{0,16}(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;
const RESET_EPOCH_RE = /(?:重置|恢复|解锁|reset)[^\d]{0,12}(1[7-9]\d{8}|2\d{9})\b/;
// Positional-unconstrained epoch probe (used with the labeled guard only).
const RESET_EPOCH_ANY_RE = /(?:^|\D)(1[7-9]\d{8}|2\d{9})(?!\d)/;
const RESET_PLAIN_DATE_RE = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/;
const MAX_RESET_HORIZON_MS = 400 * 24 * 60 * 60 * 1000; // sanity: reject garbage dates

/** Extract the provider JSON body (code/message) embedded in a failure message. */
export function parseProviderBody(message) {
  const out = { providerCode: null, providerMessage: null };
  if (typeof message !== "string" || message.length === 0) return out;
  const jsonMatch = message.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const body = JSON.parse(jsonMatch[0]);
      if (body && typeof body === "object" && !Array.isArray(body)) {
        if (body.code !== undefined && body.code !== null && String(body.code).length > 0) {
          out.providerCode = String(body.code);
        }
        if (typeof body.message === "string") out.providerMessage = body.message;
      }
    } catch {
      // Not valid JSON — fall through to the regex probe.
    }
  }
  if (out.providerCode === null) {
    const m = message.match(PROVIDER_CODE_RE);
    if (m) out.providerCode = m[1];
  }
  return out;
}

/**
 * Parse a provider-provided reset timestamp ("您的限额将在 2026-09-03 01:49:02 重置。").
 * @returns {number|null} epoch ms, or null when absent/implausible.
 */
export function parseResetTimestamp(text, nowMs, tzOffsetMinutes) {
  if (typeof text !== "string" || text.length === 0) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  let ms = null;
  let m;
  if ((m = text.match(RESET_CJK_DATE_RE))) {
    const [, y, mo, d, h, mi, s] = m;
    ms = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), s ? Number(s) : 0).getTime();
  } else if ((m = text.match(RESET_ISO_RE))) {
    ms = new Date(`${m[1]}T${m[2]}`).getTime();
  } else if ((m = text.match(RESET_EPOCH_RE))) {
    ms = Number(m[1]) * 1000;
  } else if (tzOffsetMinutes === undefined) {
    // Plain date is only trusted when the text explicitly names a reset.
    const labeled = /(?:重置|恢复|解锁|reset)/i.test(text);
    if (labeled && (m = text.match(RESET_PLAIN_DATE_RE))) {
      ms = new Date(`${m[1]}T${m[2]}`).getTime();
    } else if (labeled && (m = text.match(RESET_EPOCH_ANY_RE))) {
      // Chinese order ("将在 <epoch> 重置") puts the label AFTER the number.
      ms = Number(m[1]) * 1000;
    }
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  if (!Number.isFinite(tzOffsetMinutes)) {
    // tzOffsetMinutes (minutes EAST of UTC, JS Date#getTimezoneOffset sign) lets
    // a caller re-anchor a naive timestamp; undefined = server-local parse.
  } else {
    ms = reanchorNaive(text, ms, tzOffsetMinutes);
  }
  if (ms <= now || ms > now + MAX_RESET_HORIZON_MS) return null;
  return ms;
}

function reanchorNaive(text, localMs, tzOffsetMinutes) {
  const naive = /(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!naive) return localMs;
  const asUtc = Date.UTC(
    Number(naive[1]), Number(naive[2]) - 1, Number(naive[3]),
    Number(naive[4]), Number(naive[5]), naive[6] ? Number(naive[6]) : 0
  );
  return asUtc - tzOffsetMinutes * 60 * 1000; // caller passes minutes EAST of UTC (e.g. +480 for Beijing)
}

/** Stable correlation signature. Deliberately message-free (variant-proof). */
export function normalizedSignatureOf(provider, model, classification, providerCode, httpStatus) {
  const statusBucket = httpStatus === undefined || httpStatus === null ? "-" : `${String(httpStatus)[0]}xx`;
  return [
    provider || "?", model || "?", classification, providerCode || "-", statusBucket,
    `v${TAXONOMY_VERSION}`,
  ].join("|");
}

function baseResult(nowMs) {
  return {
    taxonomyVersion: TAXONOMY_VERSION,
    classification: FAILURE_CLASS.UNKNOWN_PROVIDER_FAILURE,
    provider: "",
    model: "",
    httpStatus: undefined,
    providerCode: null,
    retryAfterMs: 0,
    unavailableUntil: null,
    deterministic: false,
    retryableSameRoute: false,
    subKind: null,
    normalizedSignature: "",
    reason: "",
    at: nowMs,
  };
}

/**
 * Classify one provider failure into Taxonomy V1.
 * @param {object} [failure] - agent/request-error payload.failure ({message, code, status?, providerRetryAfterMs?})
 * @param {object} [context] - {provider, model, nowMs, tzOffsetMinutes}
 * @returns {object} NormalizedFailureObject (see header contract)
 */
export function classifyFailureV1(failure, context = {}) {
  const nowMs = Number.isFinite(context.nowMs) ? context.nowMs : Date.now();
  const out = baseResult(nowMs);
  out.provider = typeof context.provider === "string" ? context.provider : "";
  out.model = typeof context.model === "string" ? context.model : "";
  if (!failure || typeof failure !== "object") {
    out.normalizedSignature = normalizedSignatureOf(out.provider, out.model, out.classification, null, undefined);
    out.reason = "no failure object";
    return out;
  }
  const code = String(failure.code || "");
  const rawStatus = Number.isFinite(failure.status) ? failure.status : (Number.isFinite(failure.statusCode) ? failure.statusCode : undefined);
  out.httpStatus = rawStatus;
  const message = String(failure.message || "");
  const combined = `${code} ${message}`;
  const body = parseProviderBody(message);
  out.providerCode = body.providerCode;
  out.retryAfterMs = Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0 ? failure.providerRetryAfterMs : 0;
  const providerText = [body.providerCode || "", body.providerMessage || "", message].filter(Boolean).join(" ");
  out.normalizedSignature = normalizedSignatureOf(out.provider, out.model, out.classification, out.providerCode, rawStatus);

  // 1 PROTOCOL_MISMATCH — deterministic; the same malformed request is never retried.
  if (REASONING_PROTOCOL_RE.test(combined) || code === "STREAM_CLOSED" || code === "MALFORMED_RESPONSE") {
    out.classification = FAILURE_CLASS.PROTOCOL_MISMATCH;
    out.deterministic = true;
    out.retryableSameRoute = false;
    out.reason = code === "STREAM_CLOSED" || code === "MALFORMED_RESPONSE" ? `protocol violation code ${code}` : "reasoning/thinking protocol contract violation";
    out.normalizedSignature = normalizedSignatureOf(out.provider, out.model, out.classification, out.providerCode, rawStatus);
    return out;
  }
  // 2 CONTEXT_LIMIT — compaction + Router own recovery; no network-level retry.
  if (code === "CONTEXT_WINDOW_EXCEEDED" || CTX_OVERFLOW_RE.test(combined)) {
    out.classification = FAILURE_CLASS.CONTEXT_LIMIT;
    out.deterministic = true;
    out.retryableSameRoute = false;
    out.subKind = "CONTEXT_OVERFLOW";
    out.reason = "context window / token limit";
    out.normalizedSignature = normalizedSignatureOf(out.provider, out.model, out.classification, out.providerCode, rawStatus);
    return out;
  }
  // 3 QUOTA_EXHAUSTED — business code or quota wording (EN + CN); BEFORE generic 429.
  const quotaByCode = out.providerCode !== null && QUOTA_PROVIDER_CODES.has(out.providerCode);
  const quotaByText = code === "QUOTA" || QUOTA_EXHAUSTED_RE.test(combined) || CHINESE_QUOTA_RE.test(providerText);
  if (quotaByCode || quotaByText) {
    out.classification = FAILURE_CLASS.QUOTA_EXHAUSTED;
    out.deterministic = true;
    out.retryableSameRoute = false;
    out.reason = quotaByCode ? `provider business code ${out.providerCode} (quota)` : "quota wording";
    const resetAt = parseResetTimestamp(providerText, nowMs, context.tzOffsetMinutes);
    if (resetAt !== null) out.unavailableUntil = resetAt;
    out.normalizedSignature = normalizedSignatureOf(out.provider, out.model, out.classification, out.providerCode, rawStatus);
    return out;
  }
  // 4 PROVIDER_OVERLOADED — bounded recovery (never unlimited, never quota).
  const overloadByCode = out.providerCode !== null && OVERLOAD_PROVIDER_CODES.has(out.providerCode);
  const overloadByText = OVERLOAD_EN_RE.test(providerText) || CHINESE_OVERLOAD_RE.test(providerText);
  if (overloadByCode || overloadByText) {
    out.classification = FAILURE_CLASS.PROVIDER_OVERLOADED;
    out.deterministic = false;
    out.retryableSameRoute = true;
    out.reason = overloadByCode ? `provider business code ${out.providerCode} (overload)` : "overload wording";
    out.normalizedSignature = normalizedSignatureOf(out.provider, out.model, out.classification, out.providerCode, rawStatus);
    return out;
  }
  // 5 SHORT_WINDOW_RATE_LIMIT — plain 429 with Retry-After respect.
  if (code === "RATE_LIMIT" || RATE_LIMIT_RE.test(combined)) {
    out.classification = FAILURE_CLASS.SHORT_WINDOW_RATE_LIMIT;
    out.deterministic = false;
    out.retryableSameRoute = true;
    out.reason = "rate limit";
    out.normalizedSignature = normalizedSignatureOf(out.provider, out.model, out.classification, out.providerCode, rawStatus);
    return out;
  }
  // 6 AUTH_PERMISSION_FAILURE — no same-credential retry.
  if (code === "AUTH" || code === "INVALID_CREDENTIAL" || AUTH_RE.test(combined)) {
    out.classification = FAILURE_CLASS.AUTH_PERMISSION_FAILURE;
    out.deterministic = true;
    out.retryableSameRoute = false;
    out.reason = code === "INVALID_CREDENTIAL" ? "malformed credential" : "auth/permission failure";
    out.normalizedSignature = normalizedSignatureOf(out.provider, out.model, out.classification, out.providerCode, rawStatus);
    return out;
  }
  // 7 MODEL_ROUTE_UNAVAILABLE
  if (MODEL_UNAVAILABLE_RE.test(combined)) {
    out.classification = FAILURE_CLASS.MODEL_ROUTE_UNAVAILABLE;
    out.deterministic = true;
    out.retryableSameRoute = false;
    out.reason = "model route unavailable";
    out.normalizedSignature = normalizedSignatureOf(out.provider, out.model, out.classification, out.providerCode, rawStatus);
    return out;
  }
  // 8 NETWORK_TIMEOUT_5XX — bounded retryable (existing budgets apply).
  // Includes stream-level network faults with no HTTP status evidence
  // (NETWORK_STREAM_TRANSIENT_RE: finish_reason=network_error / PI_AI_ERROR /
  // stream terminated / socket hang up / fetch failed). Never labeled 5xx.
  if (code === "SERVER" || code === "TIMEOUT" || code === "TRANSPORT" || code === "EMPTY_RESPONSE" ||
      PROVIDER_OUTAGE_RE.test(combined) || RETRYABLE_TRANSIENT_RE.test(combined) ||
      NETWORK_STREAM_TRANSIENT_RE.test(combined)) {
    out.classification = FAILURE_CLASS.NETWORK_TIMEOUT_5XX;
    out.deterministic = false;
    out.retryableSameRoute = true;
    out.subKind = PROVIDER_OUTAGE_RE.test(combined) || code === "SERVER" ? "PROVIDER_OUTAGE" : "TRANSIENT";
    out.reason = "network / 5xx / timeout / transport";
    out.normalizedSignature = normalizedSignatureOf(out.provider, out.model, out.classification, out.providerCode, rawStatus);
    return out;
  }
  // 9 UNKNOWN_PROVIDER_FAILURE — deterministic when evidence shows a hard 4xx.
  if (code === "INVALID_REQUEST" || /^HTTP_4\d\d$/.test(code) || /^4\d\d$/.test(code) || /invalid.?request/i.test(combined)) {
    out.deterministic = true;
    out.reason = "deterministic 4xx (invalid request)";
    out.normalizedSignature = normalizedSignatureOf(out.provider, out.model, out.classification, out.providerCode, rawStatus);
    return out;
  }
  out.reason = "unrecognized failure shape";
  out.normalizedSignature = normalizedSignatureOf(out.provider, out.model, out.classification, out.providerCode, rawStatus);
  return out;
}
