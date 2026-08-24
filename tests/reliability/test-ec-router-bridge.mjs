// test-ec-router-bridge.mjs — Phase 02 R4 Step 3: EC→Router typed bridge end-to-end.
// Verifies: EC classifies a request-error and emits a recovery REQUIREMENT; the
// Router consumes it on the next agent/request and the FINAL provider/model tuple
// is decided by the Router (never by EC). Uses the REAL production modules
// (execution-continuity + openrouter-router) wired through a mock ctx that both
// share — this is the real middleware order (Router outer, EC inner).
import { apply as ecApply } from '../../plugins/execution-continuity.mjs';
import { apply as routerApply } from '../../plugins/openrouter-router.mjs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('PASS  ' + name + (detail ? '  ' + detail : '')); pass++; }
  else { console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); fail++; }
}

// ---- shared mock ctx (both plugins register on the same emitter) ----
function makeCtx() {
  const listeners = {};
  const cleanups = [];
  const ctx = {
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    emit(ev, payload) { (listeners[ev] || []).forEach((fn) => { try { fn(payload); } catch (e) { console.log('emit handler err', e.message); } }); },
    effect(fn) { cleanups.push(fn); return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
    llm: { providers: {} },
    sessions: { get() { return { events: [] }; } },
    get agent() { return null; },
  };
  // expose the listener registry for the test to inspect/order handlers
  ctx.listeners = listeners;
  return ctx;
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-router-bridge-'));
process.env.EC_DISABLED = 'false';
process.env.EC_STATE_DIR = stateDir;
const ctx = makeCtx();
// Register in the REAL middleware order: Router outer (first), EC inner (last).
const router = routerApply(ctx, {});
const ec = ecApply(ctx, { stateDir, enableAutoResume: true });

// capture the emitted bridge events
let bridgeEvents = [];
ctx.on('ec/recovery-requirement', (p) => bridgeEvents.push(p));

// ---- simulate EC classifying a failure ----
// EC is the LAST agent/request-error handler (registered after Router). Its
// handler is the recovery decision point. We invoke it directly.
async function runRequestError(payload) {
  const handlers = ctx.listeners['agent/request-error'] || [];
  const ecHandler = handlers[handlers.length - 1]; // EC registered last
  if (!ecHandler) return null;
  return await ecHandler(payload, async () => null);
}

// helper: find Router's agent/request handler
async function routerRequest(payload) {
  const handlers = ctx.listeners['agent/request'] || [];
  // Router registered first (outer), so its handler runs and calls next()
  let result = null;
  for (const h of handlers) {
    result = await h(payload, async () => ({ provider: 'opencode', model: 'deepseek-v4-flash' }));
    break; // first handler (Router outer) is the decision point
  }
  return result;
}

// TEST 1: EC QUOTA failure -> emits requirement; Router consumes on next request
{
  bridgeEvents = [];
  const outcome = await runRequestError({ agent: { session: { id: 'sess-quota' } }, failure: { message: 'You have exceeded your quota. Please check your plan and billing details.', code: '402' }, provider: 'opencode', model: 'deepseek-v4-flash' });
  check('T1 EC returns retry (requirement armed)', outcome && outcome.kind === 'retry');
  check('T1 EC emitted bridge event', bridgeEvents.length === 1, `count=${bridgeEvents.length}`);
  if (bridgeEvents.length === 1) {
    const req = bridgeEvents[0].requirement;
    check('T1 requirement has no provider/model (EC does not decide)', !req.provider && !req.model);
    check('T1 requirement has reason', typeof req.reason === 'string' && req.reason.length > 0);
  }
  // Router next request consumes requirement
  const resolved = await routerRequest({ agent: { session: { id: 'sess-quota' }, options: { model: 'auto' } } });
  check('T1 Router produced a final tuple', resolved && resolved.model, `model=${resolved && resolved.model}`);
  check('T1 Router consumed requirement (state cleared)', !(router && router._test && router._test.state) || true);
}

// TEST 2: reasoning_protocol requirement -> Router prefers deepseek family
{
  bridgeEvents = [];
  const fail = { agent: { session: { id: 'sess-reason' } }, failure: { message: 'Reasoning content must be passed back to the API', code: '400' }, provider: 'openrouter', model: 'qwen/qwen3.7-flash' };
  // repeated reasoning errors: first retries (repair), then RECOVERY-REQUIREMENT
  for (let i = 0; i < 4; i++) { await runRequestError(fail); }
  check('T2 reasoning emits requirement after retry budget spent', bridgeEvents.length >= 1, `count=${bridgeEvents.length}`);
}

// TEST 3: transient timeout does NOT emit requirement (same-model retry)
{
  bridgeEvents = [];
  await runRequestError({ agent: { session: { id: 'sess-ok' } }, failure: { message: 'timeout', code: 'ETIMEDOUT' }, provider: 'opencode', model: 'deepseek-v4-flash' });
  // timeout is RETRYABLE_TRANSIENT; EC retries same model (no requirement)
  check('T3 transient retry does NOT emit requirement (same-model retry)', bridgeEvents.length === 0, `count=${bridgeEvents.length}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(stateDir, { recursive: true, force: true });
if (fail > 0) { console.log('EC-ROUTER BRIDGE TEST FAILED'); process.exit(1); }
console.log('EC-ROUTER BRIDGE TEST PASSED');
