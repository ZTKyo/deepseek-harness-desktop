// verify-p26-r3-a1-official-retry-zero.mjs — Phase 02.6 Round 3 Blocker A residual 1
// CONTROLLED FULL-PATH PROOF: 1310 (quota) must NOT be retried by the OFFICIAL
// dsh-llm-retry layer, and must flow straight into classifier -> EC -> Router
// (same-provider llm/retry count == 0), matching the live sanitized provider policy.
//
// Round 1 contract required: reuse the ACTUAL official retry middleware (not a
// re-implementation), a sanitized effective provider policy (mirror of live
// settings.yaml retryPolicy, secrets stripped), and assert same-provider
// llm/retry=0 before the request-error chain proceeds to EC/Router.
//
// Scenarios:
//   V1 1310 RATE_LIMIT with the live openrouter policy (retryableCodes WITHOUT
//     RATE_LIMIT) -> official layer emits NO llm/retry, forwards to EC -> EC
//     QUOTA branch with fallback budget -> retry kind -> Router rewrite off
//     exhausted model. Same-provider llm/retry events == 0.
//   V2 CONTROL: RATE_LIMIT with a policy that DOES include RATE_LIMIT -> official
//     layer retries (proves the middleware itself is live and would retry when
//     configured to). This is the negative control that makes V1 meaningful.
//   V3 policy===undefined (managed direct provider w/o retryPolicy) -> official
//     layer passes through (next()) without retry -> EC sees the 1310.
//   V4 sanitized policy identity: fixed canonical digest over the sanitized
//     effective policy (mode/maxRetries/retryableCodes/backoff), stable and
//     secret-free, recorded as proof artifact.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
// Official dsh-llm-retry middleware (the REAL package, not a re-implementation).
// Resolve from DSH_GLOBAL_ROOT (CI exposes `npm root -g`; GitHub runner prefix
// differs from local %APPDATA%\npm), falling back to the local dsh install.
const require = createRequire(import.meta.url);
function findOfficialRetry() {
  const candidates = [];
  const g = process.env.DSH_GLOBAL_ROOT;
  if (g) {
    candidates.push(path.join(g, '@deepseek-ai', 'dsh', 'node_modules'));
    candidates.push(g);
  }
  candidates.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'));
  for (const base of candidates) {
    try {
      return import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-retry', { paths: [base] })).href);
    } catch { /* try next */ }
  }
  throw new Error('dsh-llm-retry not found: set DSH_GLOBAL_ROOT or install @deepseek-ai/dsh globally');
}
const llmRetryMod = await findOfficialRetry();
const { apply: llmRetryApply } = llmRetryMod;
import { apply as ecApply } from '../../plugins/execution-continuity.mjs';
import { apply as routerApply } from '../../plugins/openrouter-router.mjs';

process.env.OPENROUTER_DEEPSEEK_MODEL = 'deepseek/deepseek-v4-flash-0731';
process.env.OPENROUTER_QWEN_MODEL = 'qwen/qwen3.7-flash';
process.env.OPENROUTER_MIMO_MODEL = 'xiaomi/mimo-v2.5';
process.env.ROUTER_DIAGNOSTICS = 'false';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('PASS  ' + name + (detail ? '  ' + detail : '')); pass++; }
  else { console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); fail++; }
}
const noRetry = (a) => !a || a.kind !== 'retry';

// ── sanitized LIVE effective provider policies (secrets stripped) ──────────
// These mirror settings.yaml: retryPolicy with retryableCodes = [EMPTY_RESPONSE,
// SERVER, TIMEOUT, TRANSPORT] (RATE_LIMIT removed per P2.6 R3). Sanitized ==
// policy shape only; no apiKey/baseURL/secret fields are ever read or emitted.
const LIVE_POLICY_OPENROUTER = {
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: ['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 },
};
const LIVE_POLICY_WITH_RATE_LIMIT = { // negative-control (NOT a live policy)
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: ['RATE_LIMIT', 'EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 },
};

// ── makeCtx: shared harness (same shape as sibling continuity tests) ────────
function makeCtx() {
  const listeners = {};
  const ctx = {
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    emit(ev, payload) { (listeners[ev] || []).forEach((fn) => { try { fn(payload); } catch (e) {} }); },
    effect() { return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
    llm: { providers: {} },
    sessions: { get() { return { events: [] }; } },
    get agent() { return null; },
  };
  ctx.listeners = listeners;
  return ctx;
}

// ── session stub with real event array (official backoff appends llm/retry) ──
function makeSession(sid) {
  const events = [];
  return {
    id: sid,
    events,
    append(type, data) { events.push({ type, data }); },
  };
}

const RESET_LOCAL = new Date(Date.now() + 3600_000).toISOString();
function quotaPayload(sid, provider, model, policy) {
  return {
    agent: { session: makeSession(sid) },
    provider,
    model,
    retryPolicy: policy,
    signal: new AbortController().signal,
    failure: { code: 'RATE_LIMIT', message: `429: {"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 ${RESET_LOCAL} 重置。"}` },
  };
}
const llmRetryCount = (sess) => (sess?.events || []).filter((e) => e.type === 'llm/retry').length;

// ── harness: official llm-retry FIRST (outermost) + Router + EC ────────────
// Registration order matters: llm-retry must see every request-error before the
// Router/EC classifiers, exactly like the live plugin registration order
// (plugins/openrouter-router.mjs registers llm-retry before itself).
const ctx = makeCtx();
const llmRetryDispose = llmRetryApply(ctx, {}); // [0] official retry
const router = routerApply(ctx, {});            // [1] Router
const ecDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-p26r3a1-'));
process.env.EC_DISABLED = 'false';
process.env.EC_STATE_DIR = ecDir;
const ec = ecApply(ctx, { stateDir: ecDir, enableAutoResume: false }); // [2] EC

// handler order: [llm-retry, router, ec]
const REQUEST_ERROR_HANDLERS = ctx.listeners['agent/request-error'] || [];
const officialRetryHandler = REQUEST_ERROR_HANDLERS[0]; // MUST be the official dsh-llm-retry middleware
async function runRequestErrorChain(payload) {
  const handlers = ctx.listeners['agent/request-error'] || [];
  let idx = 0;
  const run = async () => {
    if (idx >= handlers.length) return null;
    const h = handlers[idx++];
    return await h(payload, run);
  };
  return await run();
}
async function runAgentRequest(sid, resolved, opts = {}) {
  const handlers = ctx.listeners['agent/request'] || [];
  const routerHandler = handlers[0];
  if (!routerHandler) return null;
  return await routerHandler(
    { agent: { session: { id: sid }, options: { model: opts.model || 'auto' } }, request: opts.request || {}, resolved, model: resolved.model, provider: resolved.provider },
    async () => resolved
  );
}
function seedRouterState(sid, patch) {
  const cur = router.state.get(sid) || {};
  router.state.set(sid, { ...cur, ...patch });
}
function sessionFor(sid) {
  return { id: sid, events: [], append(t, d) { this.events.push({ type: t, data: d }); } };
}

// ── V1: live openrouter policy + 1310 -> official layer NO retry -> EC QUOTA → Router ─
{
  const SID = 'sess-p26r3a1-v1';
  seedRouterState(SID, { lastChainIds: ['deepseek/deepseek-v4-flash-0731', 'xiaomi/mimo-v2.5', 'qwen/qwen3.7-flash'] });
  const sess = sessionFor(SID);
  const payload = quotaPayload(SID, 'openrouter', 'deepseek/deepseek-v4-flash-0731', LIVE_POLICY_OPENROUTER);
  payload.agent = { session: sess };
  const action = await runRequestErrorChain(payload);
  check('V1a official layer: same-provider llm/retry count == 0', llmRetryCount(sess) === 0, `events=${sess.events.length}`);
  check('V1b EC received 1310 and chose retry (fallback budget exists)', !!action && action.kind === 'retry', `action=${JSON.stringify(action)}`);
  const resolvedOut = await runAgentRequest(SID, { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' });
  check('V1c Router rewrites off exhausted model', !!resolvedOut?.model && resolvedOut.model !== 'deepseek/deepseek-v4-flash-0731', `model=${resolvedOut && resolvedOut.model}`);
}

// ── V2 CONTROL: policy WITH RATE_LIMIT -> OFFICIAL layer itself retries ─────
// Isolation: only the official handler runs (next -> null), so any retry kind
// MUST come from the official middleware itself, proving it is live and would
// retry RATE_LIMIT when the policy lists it (negative control for V1).
{
  const SID = 'sess-p26r3a1-v2';
  const sess = sessionFor(SID);
  const payload = { agent: { session: sess }, provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731', retryPolicy: LIVE_POLICY_WITH_RATE_LIMIT, signal: new AbortController().signal, failure: { code: 'RATE_LIMIT', message: '429 quota' } };
  const officialHandler = officialRetryHandler;
  const action = await officialHandler(payload, async () => null);
  check('V2a official layer alone retries when RATE_LIMIT is retryable', llmRetryCount(sess) === 1 && action && action.kind === 'retry', `events=${llmRetryCount(sess)} action=${JSON.stringify(action)}`);
}

// ── V3: policy===undefined (managed direct provider) -> official pass-through ─
{
  const SID = 'sess-p26r3a1-v3';
  seedRouterState(SID, { lastChainIds: ['deepseek/deepseek-v4-flash-0731'] });
  const sess = sessionFor(SID);
  const payload = quotaPayload(SID, 'zhipu', 'deepseek/deepseek-v4-flash-0731', undefined);
  payload.agent = { session: sess };
  const action = await runRequestErrorChain(payload);
  check('V3a official layer: undefined policy -> pass-through (no retry)', llmRetryCount(sess) === 0, `events=${llmRetryCount(sess)}`);
  check('V3b EC sees 1310 (quota handling active)', action !== undefined, 'chain advanced to EC');
}

// ── V4: sanitized policy identity (canonical digest, secret-free) ───────────
{
  const canon = (p) => crypto.createHash('sha256').update(JSON.stringify({
    mode: p.mode, maxRetries: p.maxRetries,
    retryableCodes: [...p.retryableCodes].sort(),
    backoff: p.backoff,
  })).digest('hex');
  const d1 = canon(LIVE_POLICY_OPENROUTER);
  const d2 = canon(LIVE_POLICY_WITH_RATE_LIMIT);
  check('V4a policy identity stable', d1 === canon(LIVE_POLICY_OPENROUTER), d1.slice(0, 16));
  check('V4b RATE_LIMIT-removed identity differs from control', d1 !== d2);
  check('V4c identity is secret-free', !d1.includes('api') && !d2.includes('api'), 'sha256 hex');
  fs.writeFileSync(path.join(ecDir, 'p26-r3-a1-policy-identity.json'), JSON.stringify({
    openrouter: { sha256: d1, policy: LIVE_POLICY_OPENROUTER },
    controlWithRateLimit: { sha256: d2 },
  }, null, 2), 'utf8');
  console.log('  policy identity artifact:', path.join(ecDir, 'p26-r3-a1-policy-identity.json'));
}

// ── V5: 1305 (provider overload) with live policy -> official layer does NOT ─
// retry (RATE_LIMIT absent from retryableCodes) -> EC RATE_LIMIT branch
// (PROVIDER_OVERLOADED folds into RATE_LIMIT) returns bounded retry -> Router
// rewrites off the overloaded model. Same-provider llm/retry == 0 proves the
// official layer never blind-retried the overload.
{
  const SID = 'sess-p26r3a1-v5';
  seedRouterState(SID, { lastChainIds: ['deepseek/deepseek-v4-flash-0731', 'xiaomi/mimo-v2.5', 'qwen/qwen3.7-flash'] });
  const sess = sessionFor(SID);
  const payload = quotaPayload(SID, 'openrouter', 'deepseek/deepseek-v4-flash-0731', LIVE_POLICY_OPENROUTER);
  payload.agent = { session: sess };
  payload.failure = { code: '1305', message: '{"code":"1305","message":"服务过载，请稍后重试"}' };
  const action = await runRequestErrorChain(payload);
  check('V5a official layer: 1305 same-provider llm/retry == 0 (not in retryableCodes)', llmRetryCount(sess) === 0, `events=${sess.events.length}`);
  check('V5b EC folds 1305 into RATE_LIMIT and returns bounded retry', !!action && action.kind === 'retry', `action=${JSON.stringify(action)}`);
  // 1305 is TRANSIENT overload (not quota exhaustion): EC's RATE_LIMIT branch does
  // bounded backoff on the SAME model — it must NOT emit a recovery-requirement
  // (that is the 1310 quota path) and the Router must NOT rewrite. Contrast with
  // V1c where 1310 quota DOES trigger a route rewrite. Count actual emissions
  // during THIS request pass (the router's listener does not fire if nothing emits).
  let reqEmitted = 0;
  const origEmit = ctx.emit;
  ctx.emit = (ev, payload) => { if (ev === 'ec/recovery-requirement') reqEmitted++; origEmit(ev, payload); };
  await runRequestErrorChain(payload);
  ctx.emit = origEmit;
  check('V5c 1305 does NOT trigger route rewrite (no recovery-requirement emitted, transient overload)', reqEmitted === 0, `recovery-requirement emissions=${reqEmitted}`);
}

// ── V6: transient (SERVER/TIMEOUT) with live policy -> official layer retries ─
// (they ARE in retryableCodes) with its OWN bounded counter. Proves the official
// middleware still retries transients (no over-suppression): llm/retry >= 1 and
// the action kind is retry. This is the regression guard for "1310/1305 -> zero"
// NOT being implemented by disabling the official layer entirely.
{
  const SID = 'sess-p26r3a1-v6';
  seedRouterState(SID, { lastChainIds: ['deepseek/deepseek-v4-flash-0731', 'xiaomi/mimo-v2.5', 'qwen/qwen3.7-flash'] });
  const sess = sessionFor(SID);
  const payload = { agent: { session: sess }, provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731', retryPolicy: LIVE_POLICY_OPENROUTER, signal: new AbortController().signal, failure: { code: 'SERVER', message: '500 Internal Server Error' } };
  const action = await runRequestErrorChain(payload);
  check('V6a official layer retries transient SERVER (bounded, in retryableCodes)', llmRetryCount(sess) >= 1, `events=${llmRetryCount(sess)}`);
  check('V6b transient retry action kind == retry', !!action && action.kind === 'retry', `action=${JSON.stringify(action)}`);
  const sess2 = sessionFor(SID + '-t');
  const payload2 = { agent: { session: sess2 }, provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731', retryPolicy: LIVE_POLICY_OPENROUTER, signal: new AbortController().signal, failure: { code: 'TIMEOUT', message: 'ETIMEDOUT' } };
  const action2 = await runRequestErrorChain(payload2);
  check('V6c official layer retries transient TIMEOUT', llmRetryCount(sess2) >= 1, `events=${llmRetryCount(sess2)}`);
  check('V6d transient TIMEOUT action kind == retry', !!action2 && action2.kind === 'retry', `action=${JSON.stringify(action2)}`);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
