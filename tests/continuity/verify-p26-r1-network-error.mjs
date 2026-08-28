// verify-p26-r1-network-error.mjs — Phase 02.6 R1 regression.
// Real incident (2026-08-28, session a144fe3f, provider=bai model=glm-5.3-flash):
// stream-level network failure with NO HTTP status evidence
// ("finish_reason=network_error", provider marker PI_AI_ERROR).
// Old behavior: classifier fell through to UNKNOWN_PROVIDER_FAILURE =>
// retryableSameRoute=false => EC FAILED_FATAL — a transient transport blip
// killed the turn. New behavior under test:
//   classify: NETWORK_TIMEOUT_5XX / subKind=TRANSIENT, no fabricated 5xx
//             (httpStatus stays undefined, signature status bucket "-").
//   EC chain: CATEGORY.RETRYABLE_TRANSIENT => bounded same-route retry with
//             real backoff (breaker-aware, SAME session) => budget exhausted
//             => EC bounded defer (WAITING_PROVIDER + nextRetryAt), never
//             FAILED_FATAL, no Router requirement for transient blips.
//   Guard:    a bare "error" text still classifies UNKNOWN => FAILED_FATAL
//             (evidence-bounded regex, no over-matching).
//   Obs:      evidence JSONL records the incident shape; payload untouched.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { apply as ecApply } from '../../plugins/execution-continuity.mjs';
import { apply as obsApply } from '../../plugins/failure-classifier.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('PASS  ' + name + (detail ? '  ' + detail : '')); pass++; }
  else { console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); fail++; }
}

function makeCtx() {
  const listeners = {};
  const ctx = {
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    emit(ev, payload) { (listeners[ev] || []).forEach((fn) => { try { fn(payload); } catch (e) {} }); },
    effect(fn) { return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
    llm: { providers: {} },
    sessions: { get() { return { events: [] }; } },
    get agent() { return null; },
  };
  ctx.listeners = listeners;
  return ctx;
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-p26r1net-'));
process.env.EC_DISABLED = 'false';
process.env.EC_STATE_DIR = stateDir;
const ctx = makeCtx();
ecApply(ctx, { stateDir, enableAutoResume: false });

let bridgeEvents = [];
ctx.on('ec/recovery-requirement', (p) => bridgeEvents.push(p));

async function runRequestError(payload) {
  const handlers = ctx.listeners['agent/request-error'] || [];
  const h = handlers[handlers.length - 1];
  if (!h) return null;
  return await h(payload, async () => null);
}

function readIntents() {
  const p = path.join(stateDir, 'execution-intents.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function intentOf(sid) {
  const intents = readIntents();
  return intents.intents ? intents.intents[sid] : intents[sid];
}

// The exact incident shape (no HTTP status, no provider JSON body).
const SID = 'sess-p26r1-neterr';
const incident = () => ({
  agent: { session: { id: SID } },
  provider: 'bai',
  model: 'glm-5.3-flash',
  failure: { code: 'network_error', message: 'stream terminated: finish_reason=network_error PI_AI_ERROR (no HTTP status)' },
});

// ── V1: first incident failure -> bounded same-route retry, no fake status ──
{
  const t0 = Date.now();
  const action = await runRequestError(incident());
  const elapsed = Date.now() - t0;
  const it = intentOf(SID);
  check('V1a retry returned (official chain re-issues same session)', action && action.kind === 'retry', JSON.stringify(action));
  check('V1b state RETRYING during bounded retry', it?.state === 'RETRYING', `state=${it?.state}`);
  check('V1c taxonomy: NETWORK_TIMEOUT_5XX + no fabricated status', it?.lastFailure?.taxonomyClass === 'NETWORK_TIMEOUT_5XX' && it.lastFailure.providerCode === undefined && it.lastFailure.normalizedSignature === 'bai|glm-5.3-flash|NETWORK_TIMEOUT_5XX|-|-|v1', JSON.stringify(it?.lastFailure || {}));
  check('V1d real backoff sleep (bounded, not instant storm)', elapsed >= 1200 && elapsed <= 4000, `elapsed=${elapsed}ms`);
  check('V1e no Router requirement for transient blip', bridgeEvents.length === 0, JSON.stringify(bridgeEvents));
}

// ── V2: second failure -> still inside retry budget ────────────────────────
{
  const t0 = Date.now();
  const action = await runRequestError(incident());
  const elapsed = Date.now() - t0;
  const it = intentOf(SID);
  check('V2a second bounded retry', action && action.kind === 'retry' && it?.retryCount === 2, `retryCount=${it?.retryCount}`);
  check('V2b exponential backoff grew (bounded)', elapsed >= 2400 && elapsed <= 7000, `elapsed=${elapsed}ms`);
  check('V2c still no requirement', bridgeEvents.length === 0);
}

// ── V3: third failure -> budget exhausted -> EC bounded defer, NEVER fatal ──
{
  const action = await runRequestError(incident());
  const it = intentOf(SID);
  check('V3a no third retry (budget exhausted)', !(action && action.kind === 'retry'), JSON.stringify(action));
  check('V3b state WAITING_PROVIDER (defer, not FAILED_FATAL)', it?.state === 'WAITING_PROVIDER', `state=${it?.state}`);
  const due = Number(it?.nextRetryAt);
  check('V3c defer scheduled with nextRetryAt', Number.isFinite(due) && due > Date.now(), `due=${new Date(due).toISOString()}`);
  check('V3d taxonomy stays NETWORK_TIMEOUT_5XX across attempts', it?.lastFailure?.taxonomyClass === 'NETWORK_TIMEOUT_5XX');
  check('V3e transient path never emits Router requirement', bridgeEvents.length === 0, `events=${bridgeEvents.length}`);
  // Same-session recovery: EC keeps exactly one durable record for this sid
  // (no sid churn; retry actions are consumed by the official chain in-turn).
  const keys = Object.keys(readIntents().intents || {});
  check('V3f single session record, sid preserved', keys.length === 1 && keys[0] === SID, keys.join(','));
}

// ── V4: evidence-bounded guard — bare "error" must NOT become transient ────
{
  const sidG = 'sess-p26r1-guard';
  const payload = {
    agent: { session: { id: sidG } },
    provider: 'p2',
    model: 'm2',
    failure: { code: 'X', message: 'bare error only' },
  };
  const action = await runRequestError(payload);
  const it = intentOf(sidG);
  check('V4a unknown failure still FAILED_FATAL (no over-match)', it?.state === 'FAILED_FATAL' && !(action && action.kind === 'retry'), `state=${it?.state}`);
  check('V4b fatalReason = unclassified', String(it?.fatalReason || '').startsWith('unclassified failure'), it?.fatalReason);
}

// ── V5: observation plugin — evidence JSONL records the incident shape ─────
{
  const evidenceFile = path.join(stateDir, 'classifier-evidence.jsonl');
  const obsCtx = makeCtx();
  obsApply(obsCtx, { evidenceFile });
  let forwarded = 0;
  const payload = incident();
  const failureRef = payload.failure;
  const handlers = obsCtx.listeners['agent/request-error'] || [];
  await handlers[handlers.length - 1](payload, async () => { forwarded++; return null; });
  const lines = fs.readFileSync(evidenceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = lines[lines.length - 1];
  check('V5a evidence appended with incident classification', lines.length >= 1 && last.classification === 'NETWORK_TIMEOUT_5XX', JSON.stringify(last).slice(0, 200));
  check('V5b evidence carries sessionId + no-status signature', last.sid === SID && last.normalizedSignature === 'bai|glm-5.3-flash|NETWORK_TIMEOUT_5XX|-|-|v1', `sig=${last.normalizedSignature}`);
  check('V5c payload.failure never mutated', payload.failure === failureRef);
  check('V5d chain forwarded exactly once', forwarded === 1);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
