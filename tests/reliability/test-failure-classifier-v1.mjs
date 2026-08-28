// test-failure-classifier-v1.mjs — Phase 02.6 R1: Failure Taxonomy V1 unit tests.
// Covers: 9-class taxonomy, provider business codes (1310 quota / 1305 overload),
// Chinese quota wording, reset-timestamp parsing (incl. ISO-Z timezone fix),
// stable normalized signature across message variants, EC-core legacy category
// mapping preservation, and the T13 budget-variant non-bypass property.
import { classifyFailureV1, parseResetTimestamp, parseProviderBody, normalizedSignatureOf, FAILURE_CLASS, TAXONOMY_VERSION, QUOTA_PROVIDER_CODES, OVERLOAD_PROVIDER_CODES } from '../../plugins/failure-classifier-core.mjs';
import { classifyFailure, CATEGORY } from '../../plugins/execution-continuity-core.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('PASS  ' + name + (detail ? '  ' + detail : '')); pass++; }
  else { console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); fail++; }
}
const NOW = new Date('2026-08-28T02:00:00+08:00').getTime();
// Real production incident shape (2026-08-26 zhipu 1310), de-sensitized.
const GLM_1310 = { code: 'RATE_LIMIT', message: '429: {"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 2026-09-03 01:49:02 重置。"}' };

function fmtLocalReset(resetAt) {
  const d = new Date(resetAt);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── T-group A: taxonomy core ────────────────────────────────────────────────
{
  const c = classifyFailureV1(GLM_1310, { provider: 'zhipu', model: 'glm-4.6', nowMs: NOW });
  check('A1 1310 -> QUOTA_EXHAUSTED (not RATE_LIMIT)', c.classification === FAILURE_CLASS.QUOTA_EXHAUSTED, `class=${c.classification}`);
  check('A2 providerCode=1310', c.providerCode === '1310');
  check('A3 same-route retry budget = 0', c.retryableSameRoute === false && c.deterministic === true);
  check('A4 unavailableUntil parsed exactly (server-local naive)', c.unavailableUntil === new Date('2026-09-03T01:49:02+08:00').getTime(),
    `got=${c.unavailableUntil ? new Date(c.unavailableUntil).toISOString() : null}`);
  check('A5 signature deterministic', c.normalizedSignature === 'zhipu|glm-4.6|QUOTA_EXHAUSTED|1310|-|v1', c.normalizedSignature);
}
{
  const c = classifyFailureV1({ code: 'RATE_LIMIT', message: '429: {"code":"1305","message":"服务繁忙，请稍后重试"}' }, { provider: 'zhipu', model: 'glm-4.6', nowMs: NOW });
  check('B1 1305 -> PROVIDER_OVERLOADED (bounded, not quota)', c.classification === FAILURE_CLASS.PROVIDER_OVERLOADED && c.retryableSameRoute === true, `class=${c.classification}`);
}
{
  const cn = classifyFailureV1({ code: 'X', message: '请求失败：您的配额已达上限，请稍后再试' }, { provider: 'p', nowMs: NOW });
  check('B2 Chinese quota wording -> QUOTA_EXHAUSTED', cn.classification === FAILURE_CLASS.QUOTA_EXHAUSTED);
  const cnNoReset = classifyFailureV1({ code: 'X', message: '您的使用额度已用尽' }, { provider: 'p', nowMs: NOW });
  check('B3 quota without reset date -> unavailableUntil null (defer falls back to bounded)', cnNoReset.classification === FAILURE_CLASS.QUOTA_EXHAUSTED && cnNoReset.unavailableUntil === null);
  const ov = classifyFailureV1({ code: 'X', message: 'upstream system busy, server is busy' }, { provider: 'p', nowMs: NOW });
  check('B4 English overload wording -> PROVIDER_OVERLOADED', ov.classification === FAILURE_CLASS.PROVIDER_OVERLOADED);
}
{
  const cases = [
    [{ code: 'RATE_LIMIT', message: '429 Too Many Requests', providerRetryAfterMs: 3000 }, FAILURE_CLASS.SHORT_WINDOW_RATE_LIMIT, true],
    [{ code: 'AUTH', message: '401 Unauthorized invalid api key' }, FAILURE_CLASS.AUTH_PERMISSION_FAILURE, false],
    [{ code: 'INVALID_CREDENTIAL', message: 'malformed key' }, FAILURE_CLASS.AUTH_PERMISSION_FAILURE, false],
    [{ code: 'CONTEXT_WINDOW_EXCEEDED', message: "This model's maximum context length is 131072 tokens" }, FAILURE_CLASS.CONTEXT_LIMIT, false],
    [{ code: 'INVALID_REQUEST', message: 'reasoning_content must be passed back to the API' }, FAILURE_CLASS.PROTOCOL_MISMATCH, false],
    [{ code: 'STREAM_CLOSED', message: 'stream closed mid-turn' }, FAILURE_CLASS.PROTOCOL_MISMATCH, false],
    [{ code: 'HTTP_404', message: 'model not found: nope/lol' }, FAILURE_CLASS.MODEL_ROUTE_UNAVAILABLE, false],
    [{ code: 'SERVER', message: '500 Internal Server Error' }, FAILURE_CLASS.NETWORK_TIMEOUT_5XX, true],
    [{ code: 'TRANSPORT', message: 'fetch failed ECONNRESET' }, FAILURE_CLASS.NETWORK_TIMEOUT_5XX, true],
    // R1 (2026-08-28 real incident, session a144fe3f): stream-level network
    // faults with NO HTTP status — transient, bounded retry, never fatal.
    [{ code: 'network_error', message: 'stream terminated: finish_reason=network_error PI_AI_ERROR (no HTTP status)' }, FAILURE_CLASS.NETWORK_TIMEOUT_5XX, true],
    [{ code: 'X', message: 'PI_AI_ERROR' }, FAILURE_CLASS.NETWORK_TIMEOUT_5XX, true],
    [{ code: 'X', message: 'socket hang up' }, FAILURE_CLASS.NETWORK_TIMEOUT_5XX, true],
    [{ code: 'X', message: 'fetch failed' }, FAILURE_CLASS.NETWORK_TIMEOUT_5XX, true],
    [{ code: 'X', message: 'bare error only' }, FAILURE_CLASS.UNKNOWN_PROVIDER_FAILURE, false],
    [{ code: 'HTTP_400', message: 'bad request body' }, FAILURE_CLASS.UNKNOWN_PROVIDER_FAILURE, false],
    [{ code: 'WEIRD', message: 'nothing recognizable' }, FAILURE_CLASS.UNKNOWN_PROVIDER_FAILURE, false],
  ];
  let allOk = true; const got = [];
  for (const [f, expectClass, expectRetry] of cases) {
    const c = classifyFailureV1(f, { provider: 'p', model: 'm', nowMs: NOW });
    const ok = c.classification === expectClass && c.retryableSameRoute === expectRetry;
    if (!ok) allOk = false;
    got.push(`${f.code}:${c.classification}`);
  }
  check('C1 15-shape classification table', allOk, got.join(' | '));
}
{
  // C4 R1 real-incident evidence bounds: the stream network fault is transient,
  // but NO HTTP status was observed — the classifier must not fabricate a 5xx.
  const c = classifyFailureV1(
    { code: 'network_error', message: 'stream terminated: finish_reason=network_error PI_AI_ERROR (no HTTP status)' },
    { provider: 'bai', model: 'glm-5.3-flash', nowMs: NOW }
  );
  check('C4a incident shape -> NETWORK_TIMEOUT_5XX/TRANSIENT, bounded retry', c.classification === FAILURE_CLASS.NETWORK_TIMEOUT_5XX && c.subKind === 'TRANSIENT' && c.retryableSameRoute === true && c.deterministic === false);
  check('C4b no fabricated status: httpStatus undefined + signature bucket "-"', c.httpStatus === undefined && /\|-\|v1$/.test(c.normalizedSignature), c.normalizedSignature);
}
{
  // Priority: quota beats plain 429 even when message mentions both.
  const c = classifyFailureV1({ code: 'RATE_LIMIT', message: '429 rate limit: insufficient quota' }, { provider: 'p', nowMs: NOW });
  check('C2 quota wording outranks bare 429', c.classification === FAILURE_CLASS.QUOTA_EXHAUSTED);
  // Retry-After survives into the failure object even for quota (evidence).
  const c2 = classifyFailureV1({ code: 'RATE_LIMIT', message: '429 Too Many Requests', providerRetryAfterMs: 9000 }, { provider: 'p', nowMs: NOW });
  check('C3 Retry-After captured', c2.retryAfterMs === 9000);
}

// ── T-group D: reset timestamp parsing ──────────────────────────────────────
{
  const r1 = parseResetTimestamp('您的限额将在 2026-09-03 01:49:02 重置。', NOW);
  check('D1 CJK labeled naive date (server-local)', r1 === new Date('2026-09-03T01:49:02+08:00').getTime());
  const r2 = parseResetTimestamp('quota resets 2026-12-01T08:00:00Z', NOW);
  check('D2 ISO with explicit Z keeps UTC', r2 === Date.parse('2026-12-01T08:00:00Z'), r2 ? new Date(r2).toISOString() : null);
  const r3 = parseResetTimestamp('no date here', NOW);
  check('D3 no date -> null', r3 === null);
  const r4 = parseResetTimestamp('您的限额将在 2099-01-01 00:00:00 重置。', NOW);
  check('D4 horizon clamp (>400d) -> null', r4 === null);
  const r5 = parseResetTimestamp('您的限额将在 2020-01-01 00:00:00 重置。', NOW);
  check('D5 past date -> null', r5 === null);
  const r6 = parseResetTimestamp(`您的限额将在 ${fmtLocalReset(NOW + 2 * 3600e3)} 重置。`, NOW);
  check('D6 future relative reset parses', Math.abs(r6 - (NOW + 2 * 3600e3)) < 1500);
  const r7 = parseResetTimestamp('您的限额将在 1790000000 重置。', NOW);
  check('D7 labeled epoch seconds', r7 === 1790000000 * 1000);
}

// ── T-group E: body parsing + signature ─────────────────────────────────────
{
  const b = parseProviderBody('prefix text 429: {"code":"1310","message":"x"} trailing');
  check('E1 body parse from embedded JSON', b.providerCode === '1310' && b.providerMessage === 'x');
  const b2 = parseProviderBody('garbage with "code": "1305" but no JSON braces');
  check('E2 regex probe fallback', b2.providerCode === '1305');
  const b3 = parseProviderBody('no body at all');
  check('E3 no body -> null code', b3.providerCode === null);
  check('E4 signature message-free + versioned', normalizedSignatureOf('a', 'b', FAILURE_CLASS.QUOTA_EXHAUSTED, '1310', 429) === 'a|b|QUOTA_EXHAUSTED|1310|4xx|v1');
  // T13: message variants CANNOT change the class (budget bypass impossible —
  // count-based budgets + stable signature).
  const v1c = classifyFailureV1({ code: 'RATE_LIMIT', message: '429: {"code":"1310","message":"AAA 5000 tokens"}' }, { provider: 'zhipu', model: 'm', nowMs: NOW });
  const v2c = classifyFailureV1({ code: 'RATE_LIMIT', message: '429: {"code":"1310","message":"BBB 7777 用尽"}' }, { provider: 'zhipu', model: 'm', nowMs: NOW });
  check('E5 text variants keep same classification + signature (T13)', v1c.classification === v2c.classification && v1c.normalizedSignature === v2c.normalizedSignature);
}

// ── T-group F: EC-core mapping (legacy preservation + R1 intent) ────────────
{
  const ec = classifyFailure(GLM_1310, { provider: 'zhipu', model: 'glm-4.6', nowMs: NOW });
  check('F1 EC: 1310 -> QUOTA_EXHAUSTED retryable=false + unavailableUntil',
    ec.category === CATEGORY.QUOTA_EXHAUSTED && ec.retryable === false && Number.isFinite(ec.unavailableUntil) && ec.providerCode === '1310');
  const pr = classifyFailure({ code: 'INVALID_REQUEST', message: 'reasoning_content must be passed back to the API' }, { provider: 'p', nowMs: NOW });
  check('F2 EC: protocol keeps repair-retry-once semantics',
    pr.category === CATEGORY.REASONING_PROTOCOL_ERROR && pr.retryable === true && pr.retryableSameRoute === false);
  const ctxOv = classifyFailure({ code: 'X', message: 'input token exceed the limit' }, { nowMs: NOW });
  const tr = classifyFailure({ code: 'TRANSPORT', message: 'fetch failed ECONNRESET' }, { nowMs: NOW });
  const out = classifyFailure({ code: 'SERVER', message: '503 Service Unavailable' }, { nowMs: NOW });
  const rl = classifyFailure({ code: 'RATE_LIMIT', message: '429 Too Many Requests', providerRetryAfterMs: 3000 }, { nowMs: NOW });
  const unk = classifyFailure({ code: 'HTTP_400', message: 'weird unknown shape' }, { nowMs: NOW });
  const auth = classifyFailure({ code: 'AUTH', message: '401 Unauthorized' }, { nowMs: NOW });
  const mu = classifyFailure({ code: 'HTTP_404', message: 'model not found: x' }, { nowMs: NOW });
  const none = classifyFailure(undefined, { nowMs: NOW });
  check('F3 EC: legacy categories preserved',
    ctxOv.category === CATEGORY.CONTEXT_OVERFLOW && ctxOv.providerRetryAfterMs === 0 &&
    tr.category === CATEGORY.RETRYABLE_TRANSIENT && out.category === CATEGORY.PROVIDER_OUTAGE &&
    rl.category === CATEGORY.RATE_LIMIT && rl.providerRetryAfterMs === 3000 &&
    auth.category === CATEGORY.AUTH && mu.category === CATEGORY.MODEL_UNAVAILABLE &&
    unk.category === CATEGORY.INVALID_REQUEST && none.category === CATEGORY.UNKNOWN,
    [ctxOv.category, tr.category, out.category, rl.category, auth.category, mu.category, unk.category, none.category].join(','));
  const ov = classifyFailure({ code: 'RATE_LIMIT', message: '429: {"code":"1305","message":"服务繁忙"}' }, { provider: 'zhipu', nowMs: NOW });
  check('F4 EC: overload flagged (overload=true) inside RATE_LIMIT', ov.category === CATEGORY.RATE_LIMIT && ov.overload === true && ov.retryable === true);
  check('F5 taxonomy version + code sets', TAXONOMY_VERSION === 1 && QUOTA_PROVIDER_CODES.has('1310') && OVERLOAD_PROVIDER_CODES.has('1305'));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
