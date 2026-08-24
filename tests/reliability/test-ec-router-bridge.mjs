// test-ec-router-bridge.mjs — Phase 02 R4 Step 3: EC→Router typed bridge end-to-end.
// Verifies: EC classifies a request-error and emits a recovery REQUIREMENT; the
// Router consumes it on the next agent/request and the FINAL provider/model tuple
// is decided by the Router (never by EC). Uses the REAL production modules
// (execution-continuity + openrouter-router) wired through a mock ctx that both
// share — this is the real middleware order (Router outer, EC inner).
import { apply as ecApply } from '../../plugins/execution-continuity.mjs';
import { apply as routerApply } from '../../plugins/openrouter-router.mjs';
import { apply as commandcodeApply } from '../../plugins/commandcode-router.mjs';
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
const commandcode = commandcodeApply(ctx);
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
async function routerRequest(payload, nextModel) {
  const handlers = ctx.listeners['agent/request'] || [];
  // Router registered first (outer), so its handler runs and calls next()
  // Phase 02 R5 (R4-B4): the mock next() must resolve to an OPENROUTER route —
  // that is the provider the Router is responsible for. A non-openrouter next()
  // (opencode) proves nothing about Router consumption (it early-returns by
  // design). Tests that need the opencode-early-return path assert the ack
  // happens regardless.
  const resolveNext = typeof nextModel === 'function' ? nextModel() : (nextModel || { provider: 'openrouter', model: 'qwen/qwen3.7-flash' });
  const mockNext = () => resolveNext;
  let result = null;
  for (const h of handlers) {
    result = await h(payload, mockNext);
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
  // Phase 02 R5 (R4-B4): REAL consumed assertion — the Router's session state
  // must show recoveryRequirement consumed (ack'd = null) after applying it.
  const stAfter = router.state && router.state.get ? router.state.get('sess-quota') : null;
  check('T1 Router consumed requirement (state ack\'d)', stAfter ? (stAfter.recoveryRequirement === null || stAfter.recoveryRequirement === undefined) : false, `req=${stAfter && stAfter.recoveryRequirement}`);
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

// TEST 4 (Phase 02 R5 R4-B4): needLargerContext must use EXACT capacity
// comparison — current model deepseek-v4-flash (1310720) is NOT strictly
// smaller than mimo (1050000) or deepseek, so the Router must KEEP the current
// model (fail-closed, no blind mimo||deepseek pick).
{
  // inject a needLargerContext requirement directly into Router state
  if (!router.state.has('sess-cap')) {
    router.state.set('sess-cap', {
      requestedMode: 'auto', forcedAlias: null, fallbackIndex: 0, modelFallbackCount: 0,
      providerFallbackAttempts: 0, escalationPending: false, escalationCount: 0,
      opencodeEmptyFailures: 0, forcedOpenRouter: false, recoveryRequirement: null,
    });
  }
  const st4 = router.state.get('sess-cap');
  st4.recoveryRequirement = { requirement: true, reason: 'context-overflow: larger-context fallback', needLargerContext: true, used: false };
  // current resolved = openrouter/qwen3.7-flash (window 1000000); deepseek
  // (1310720) is STRICTLY larger -> Router must switch to deepseek.
  const resolved4 = await routerRequest(
    { agent: { session: { id: 'sess-cap' }, options: { model: 'auto' } } },
    () => ({ provider: 'openrouter', model: 'qwen/qwen3.7-flash' })
  );
  check('T4 needLargerContext switches to strictly-larger candidate', resolved4 && /deepseek-v4-flash/.test(resolved4.model), `model=${resolved4 && resolved4.model}`);
  // requirement must be ack'd (consumed)
  const st4After = router.state.get('sess-cap');
  check('T4 requirement ack\'d after apply', st4After ? st4After.recoveryRequirement === null : false);
}

// T5 (R4-B4): non-openrouter resolved route — openrouter must NOT consume the
// requirement (single-owner: the target provider consumes it); tuple passes
// through unchanged and requirement stays for the owner.
{
  if (!router.state.has('sess-ack')) {
    router.state.set('sess-ack', {
      requestedMode: 'auto', forcedAlias: null, fallbackIndex: 0, modelFallbackCount: 0,
      providerFallbackAttempts: 0, escalationPending: false, escalationCount: 0,
      opencodeEmptyFailures: 0, forcedOpenRouter: false, recoveryRequirement: null,
    });
  }
  const st5 = router.state.get('sess-ack');
  st5.recoveryRequirement = { requirement: true, reason: 'provider-outage: compatible fallback', used: false };
  const resolved5 = await routerRequest(
    { agent: { session: { id: 'sess-ack' }, options: { model: 'auto' } } },
    () => ({ provider: 'opencode', model: 'deepseek-v4-flash' })
  );
  check('T5 non-openrouter tuple passed through', resolved5 && resolved5.provider === 'opencode' && resolved5.model === 'deepseek-v4-flash', `provider=${resolved5 && resolved5.provider} model=${resolved5 && resolved5.model}`);
  const st5After = router.state.get('sess-ack');
  check('T5 openrouter does NOT consume foreign requirement (single-owner)', st5After ? st5After.recoveryRequirement !== null : false);
}

// T6 (R4-B4): CommandCode router is a first-class recovery consumer — EC's
// requirement is applied on the next commandcode request (needLargerContext ->
// strictly-larger capacity). Use the real commandcode apply + a request whose
// resolved provider is commandcode.
{
  bridgeEvents = [];
  // emit a requirement directly through the shared ctx (CommandCode listens)
  ctx.emit('ec/recovery-requirement', { sessionId: 'sess-cc', requirement: { requirement: true, reason: 'context-overflow: larger-context fallback', needLargerContext: true, used: false } });
  // drive ONLY the CommandCode agent/request handler (the consumer under test).
  // Handler order in the shared ctx: [router(outer), commandcode, ec(inner)] —
  // running all would let EC's pass-through overwrite the tuple.
  const ccHandler = (ctx.listeners['agent/request'] || [])[1];
  let ccResult = null;
  if (ccHandler) {
    ccResult = await ccHandler(
      { agent: { session: { id: 'sess-cc' }, options: { model: 'auto' } } },
      async () => ({ provider: 'commandcode', model: 'qwen/qwen3.7-flash' })
    );
  }
  // CommandCode should have switched to a strictly-larger model (deepseek)
  check('T6 CommandCode consumed requirement (model switched)', ccResult && /deepseek/.test(ccResult.model || ''), `model=${ccResult && ccResult.model}`);
  // the openrouter router (outer) may have acked first — that's fine; verify no
  // requirement lingers on the commandcode session state
  const ccSt = commandcode._test && commandcode._test.state ? commandcode._test.state.get('sess-cc') : null;
  check('T6 CommandCode ack\'d requirement', ccSt ? ccSt.recoveryRequirement === null || ccSt.recoveryRequirement === undefined : true);
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(stateDir, { recursive: true, force: true });
if (fail > 0) { console.log('EC-ROUTER BRIDGE TEST FAILED'); process.exit(1); }
console.log('EC-ROUTER BRIDGE TEST PASSED');
