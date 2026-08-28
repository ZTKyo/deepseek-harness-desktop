// verify-p26-r1-quota-defer.mjs — Phase 02.6 R1 integration test.
// Drives the REAL execution-continuity plugin (agent/request-error chain) and the
// REAL failure-classifier observation plugin through a shared mock ctx:
//   V1: GLM 1310 quota -> EC records a Router recovery REQUIREMENT (route switch,
//       bounded), returns retry (Router consumes on next agent/request).
//   V2: same 1310 again (different message text — T13 variant) -> no budget for
//       another requirement -> STRICT defer: WAITING_PROVIDER with nextRetryAt
//       == provider reset time (unavailableUntil), never a blind same-route probe.
//   V3: GLM 1305 overload -> RATE_LIMIT bounded retry path PRESERVED (regression).
//   V4: observation plugin: evidence JSONL appended, payload never mutated, chain
//       forwarded.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { apply as ecApply } from '../../plugins/execution-continuity.mjs';
import { apply as obsApply } from '../../plugins/failure-classifier.mjs';
import { apply as routerApply } from '../../plugins/openrouter-router.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('PASS  ' + name + (detail ? '  ' + detail : '')); pass++; }
  else { console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); fail++; }
}

function makeCtx() {
  const listeners = {};
  const cleanups = [];
  const ctx = {
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    emit(ev, payload) { (listeners[ev] || []).forEach((fn) => { try { fn(payload); } catch (e) {} }); },
    effect(fn) { cleanups.push(fn); return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
    llm: { providers: {} },
    sessions: { get() { return { events: [] }; } },
    get agent() { return null; },
  };
  ctx.listeners = listeners;
  return ctx;
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-p26r1-'));
process.env.EC_DISABLED = 'false';
process.env.EC_STATE_DIR = stateDir;
const ctx = makeCtx();
const ec = ecApply(ctx, { stateDir, enableAutoResume: false });

let bridgeEvents = [];
ctx.on('ec/recovery-requirement', (p) => bridgeEvents.push(p));

async function runRequestError(payload) {
  const handlers = ctx.listeners['agent/request-error'] || [];
  const ecHandler = handlers[handlers.length - 1];
  if (!ecHandler) return null;
  return await ecHandler(payload, async () => null);
}

function readIntents() {
  const p = path.join(stateDir, 'execution-intents.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// reset time = now + 2h, formatted as the provider's server-local naive
// wall-clock (zhipu/bai render Asia/Shanghai +08:00, like the real 1310 shape).
// Constructing it from UTC components of (RESET_AT + 8h) keeps the test
// timezone-independent — identical on UTC CI runners and local +08:00 hosts.
const RESET_AT = Date.now() + 2 * 3600e3;
const pad = (n) => String(n).padStart(2, '0');
const d = new Date(RESET_AT + 8 * 3600e3);
const resetLocal = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const SID1 = 'sess-p26r1-quota';
const SID2 = 'sess-p26r1-overload';

// ── V1: first 1310 -> Router requirement + bounded retry ────────────────────
{
  const payload = {
    agent: { session: { id: SID1 } },
    provider: 'zhipu',
    model: 'glm-4.6',
    failure: { code: 'RATE_LIMIT', message: `429: {"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 ${resetLocal} 重置。"}` },
  };
  const action = await runRequestError(payload);
  const intents = readIntents();
  const it = intents.intents ? intents.intents[SID1] : intents[SID1];
  check('V1a requirement bridged to Router', bridgeEvents.length === 1 && bridgeEvents[0].sessionId === SID1 && bridgeEvents[0].requirement?.requirement === true, JSON.stringify(bridgeEvents[0] || {}).slice(0, 160));
  check('V1b pendingFallback recorded (Router decides route)', it?.pendingFallback?.requirement === true && it.pendingFallback.used === false);
  check('V1c retry returned (Router consumes on next request)', action && action.kind === 'retry', JSON.stringify(action));
  check('V1d taxonomy facts in lastFailure', it?.lastFailure?.taxonomyClass === 'QUOTA_EXHAUSTED' && it.lastFailure.providerCode === '1310' && it.lastFailure.normalizedSignature === 'zhipu|glm-4.6|QUOTA_EXHAUSTED|1310|-|v1', JSON.stringify(it?.lastFailure || {}));
  check('V1e reset time captured in intent', Number.isFinite(it?.lastFailure?.unavailableUntil) && Math.abs(it.lastFailure.unavailableUntil - RESET_AT) < 1500, `${it?.lastFailure?.unavailableUntil} vs ${RESET_AT}`);
}

// ── V2: same 1310 again (variant text) -> strict defer to reset time ───────
{
  const variant = `429: {"code":"1310","message":"换一种说法：您本周期 ${pad(d.getUTCHours())} 点后流量包额度已用尽，${resetLocal} 恢复。"}`;
  const payload = {
    agent: { session: { id: SID1 } },
    provider: 'zhipu',
    model: 'glm-4.6',
    failure: { code: 'RATE_LIMIT', message: variant },
  };
  const before = readIntents();
  const itBefore = before.intents ? before.intents[SID1] : before[SID1];
  const action = await runRequestError(payload);
  const after = readIntents();
  const it = after.intents ? after.intents[SID1] : after[SID1];
  check('V2a variant text does NOT bypass (T13): same taxonomy', it.lastFailure.taxonomyClass === 'QUOTA_EXHAUSTED' && it.lastFailure.normalizedSignature === itBefore.lastFailure.normalizedSignature);
  check('V2b no second blind retry', !(action && action.kind === 'retry'), JSON.stringify(action));
  check('V2c state WAITING_PROVIDER (defer)', it.state === 'WAITING_PROVIDER', `state=${it.state}`);
  const due = Number(it.nextRetryAt);
  check('V2d defer until provider reset (±15s)', Number.isFinite(due) && Math.abs(due - RESET_AT) < 15000, `due=${new Date(due).toISOString()} reset=${new Date(RESET_AT).toISOString()}`);
  check('V2e requirement NOT duplicated', bridgeEvents.length === 1);
}

// ── V3: 1305 overload -> bounded RATE_LIMIT retry preserved ────────────────
{
  const payload = {
    agent: { session: { id: SID2 } },
    provider: 'zhipu',
    model: 'glm-4.6-air', // fresh breaker circuit (V1/V2 opened zhipu|glm-4.6)
    failure: { code: 'RATE_LIMIT', message: '429: {"code":"1305","message":"服务繁忙，请稍后重试"}' },
  };
  const action = await runRequestError(payload);
  const intents = readIntents();
  const it = intents.intents ? intents.intents[SID2] : intents[SID2];
  check('V3a overload still bounded retry (regression)', action && action.kind === 'retry', JSON.stringify(action));
  check('V3b overload classified as RATE_LIMIT w/ taxonomy', it?.lastFailure?.taxonomyClass === 'PROVIDER_OVERLOADED' && it.lastFailure.providerCode === '1305', JSON.stringify(it?.lastFailure || {}));
}

// ── V4: observation plugin (evidence JSONL, no mutation, chain forwarded) ──
{
  const evidenceFile = path.join(stateDir, 'classifier-evidence.jsonl');
  const obsCtx = makeCtx();
  obsApply(obsCtx, { evidenceFile });
  let forwarded = 0;
  const payload = {
    agent: { session: { id: SID1 } },
    provider: 'zhipu',
    model: 'glm-4.6',
    failure: { code: 'RATE_LIMIT', message: `429: {"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 ${resetLocal} 重置。"}` },
  };
  const failureRef = payload.failure;
  const handlers = obsCtx.listeners['agent/request-error'] || [];
  await handlers[handlers.length - 1](payload, async () => { forwarded++; return null; });
  const lines = fs.readFileSync(evidenceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = lines[lines.length - 1];
  check('V4a evidence JSONL appended with taxonomy', lines.length >= 1 && last.classification === 'QUOTA_EXHAUSTED' && last.providerCode === '1310' && Number.isFinite(last.unavailableUntil), JSON.stringify(last).slice(0, 200));
  check('V4b payload.failure never mutated', payload.failure === failureRef);
  check('V4c chain forwarded exactly once', forwarded === 1);
  const ecLines = lines.filter((l) => l.sid === SID1);
  check('V4d evidence carries sessionId + signature', ecLines.length >= 1 && ecLines[ecLines.length - 1].normalizedSignature === 'zhipu|glm-4.6|QUOTA_EXHAUSTED|1310|-|v1');
}

// V5: Router consumes the quota requirement by ACTUALLY switching route
// (P2.6 R1 core promise — not just an ack). Fresh ctx, Router outer + EC inner.
{
  const ctxR = makeCtx();
  const router = routerApply(ctxR, {});
  const ecDir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-p26r1-v5-'));
  ecApply(ctxR, { stateDir: ecDir5, enableAutoResume: false });
  const SID5 = 'sess-p26r1-route-switch';
  const payload5 = {
    agent: { session: { id: SID5 } },
    provider: 'zhipu',
    model: 'glm-4.6',
    failure: { code: 'RATE_LIMIT', message: `429: {"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 ${new Date(Date.now() + 3600_000).toISOString()} 重置。"}` },
  };
  const handlersErr5 = ctxR.listeners['agent/request-error'] || [];
  const ecHandler5 = handlersErr5[handlersErr5.length - 1];
  await ecHandler5(payload5, async () => null);
  // next request goes through the Router (outer handler); mock next resolves
  // the SAME exhausted route — Router must move off it.
  const routerHandlers = ctxR.listeners['agent/request'] || [];
  const resolved5 = await routerHandlers[0](
    { agent: { session: { id: SID5 }, options: { model: 'auto' } } },
    () => ({ provider: 'openrouter', model: 'zhipu/glm-4.6' })
  );
  check('V5a route switched off exhausted pool', !!resolved5?.model && resolved5.model !== 'zhipu/glm-4.6', `model=${resolved5 && resolved5.model}`);
  const st5 = router.state && router.state.get ? router.state.get(SID5) : null;
  check('V5b requirement ack\'d after apply', st5 ? (st5.recoveryRequirement === null || st5.recoveryRequirement === undefined) : false, `req=${st5 && st5.recoveryRequirement}`);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
