// verify-p26-r1-2-quota-no-alternative.mjs — Phase 02.6 R1.2 (Reviewer Blocker 2)
// integration test: quota-exhausted + NO alternative route -> zero blind retries.
//
// Reviewer Blocker 2: when a quota-exhausted provider/model is the ONLY candidate
// (the fallback chain holds no different model id), Router's agent/request rewrite
// cannot move off the exhausted route. Previously EC still emitted a retry after a
// backoff sleep (1 blind hit against an exhausted quota pool), then eventually
// deferred. R1.2 adds an event-driven receipt:
//   - Router stores lastChainIds on each agent/request decision; when the quota
//     recovery-requirement arrives it judges "no alternative" against the LAST
//     DECISION CHAIN (same logic as pickQuotaRouteTarget) and synchronously emits
//     ec/quota-no-alternative during ec/recovery-requirement.
//   - Router also emits the receipt as a fallback in the agent/request no-alternative
//     branches (openrouter chain exhausted, cross-provider target none).
//   - EC consumes the receipt: on the SAME request-error pass it defers to
//     WAITING_PROVIDER instead of returning { kind: "retry" } -> zero blind retry.
//
// Semantics: EC request-error returns null when it DEFERS (WAITING_PROVIDER), and
// returns { kind: "retry" } when it wants a retry. "no retry" == (action == null
// || action.kind !== "retry").
//
// Scenarios:
//   V1 static no-alternative (single-model chain): last decision chain is
//     [deepseek] (only candidate). quota requirement for deepseek arrives ->
//     Router emits receipt synchronously -> EC defers on the same pass (no retry)
//   V2 static alternative EXISTS (full chain): no receipt -> EC retries ->
//     Router rewrites off exhausted model (regression)
//   V3 cross-provider quota: managed direct provider (zhipu) exhausted ->
//     Router rewrites to openrouter (different quota pool) (regression)
//   V4 late receipt (emitted without pending requirement) -> next failure defers
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { apply as ecApply } from '../../plugins/execution-continuity.mjs';
import { apply as routerApply } from '../../plugins/openrouter-router.mjs';

// Deterministic model ids (mirrors real settings mappings).
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

const RESET_LOCAL = new Date(Date.now() + 3600_000).toISOString();
function quotaPayload(sid, provider, model) {
  return {
    agent: { session: { id: sid } },
    provider,
    model,
    failure: { code: 'RATE_LIMIT', message: `429: {"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 ${RESET_LOCAL} 重置。"}` },
  };
}

// ── shared harness: Router (outer, registered first) + EC (inner) ─────────
const ctx = makeCtx();
const router = routerApply(ctx, {});
const ecDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-p26r12-'));
process.env.EC_DISABLED = 'false';
process.env.EC_STATE_DIR = ecDir;
ecApply(ctx, { stateDir: ecDir, enableAutoResume: false });

let receiptEvents = [];
ctx.on('ec/quota-no-alternative', (p) => receiptEvents.push(p));
const receiptsFor = (sid) => receiptEvents.filter((e) => e.sessionId === sid).length;

// EC request-error is the LAST handler (inner); Router's own request-error is [0].
async function runRequestError(payload) {
  const handlers = ctx.listeners['agent/request-error'] || [];
  const ecHandler = handlers[handlers.length - 1];
  if (!ecHandler) return null;
  return await ecHandler(payload, async () => null);
}
// Router agent/request is handlers[0] (outer, registered first).
async function runAgentRequest(sid, resolved, opts = {}) {
  const handlers = ctx.listeners['agent/request'] || [];
  const routerHandler = handlers[0];
  if (!routerHandler) return null;
  return await routerHandler(
    { agent: { session: { id: sid }, options: { model: opts.model || 'auto' } }, request: opts.request || {}, resolved, model: resolved.model, provider: resolved.provider },
    async () => resolved
  );
}
// merge into router state (state is the exported Map; set() replaces whole entry)
function seedRouterState(sid, patch) {
  const cur = router.state.get(sid) || {};
  router.state.set(sid, { ...cur, ...patch });
}

// ── V1: static no-alternative (single-model chain) -> sync receipt -> same-pass defer ─
{
  const SID = 'sess-p26r12-v1-static';
  // seed the decision chain [deepseek] ONLY (chain collapsed to a single candidate).
  seedRouterState(SID, { lastChainIds: ['deepseek/deepseek-v4-flash-0731'] });
  const before = receiptsFor(SID);
  const action = await runRequestError(quotaPayload(SID, 'openrouter', 'deepseek/deepseek-v4-flash-0731'));
  check('V1a receipt emitted synchronously', receiptsFor(SID) === before + 1, `recs=${before}->${receiptsFor(SID)}`);
  check('V1b EC deferred (no retry kind)', noRetry(action), `action=${JSON.stringify(action)}`);
  check('V1c zero blind retry (defer, not retry)', noRetry(action) === true);
}

// ── V2: static alternative EXISTS (full chain) -> no receipt -> retry -> rewrite ─
{
  const SID = 'sess-p26r12-v2-alt';
  // build a real decision first so lastChainIds is a full chain (deepseek->mimo->qwen)
  const dOut = await runAgentRequest(SID, { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' });
  check('V2a decision recorded (chain seeded)', !!dOut && !!dOut.model, `model=${dOut && dOut.model}`);
  const before = receiptsFor(SID);
  const action = await runRequestError(quotaPayload(SID, 'openrouter', 'deepseek/deepseek-v4-flash-0731'));
  check('V2b no static receipt (chain has alternatives)', receiptsFor(SID) === before, `recs=${receiptsFor(SID) - before}`);
  check('V2c EC retries (not deferred)', action && action.kind === 'retry', `action=${JSON.stringify(action)}`);
  const resolvedOut = await runAgentRequest(SID, { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' });
  check('V2d router moves off exhausted model', !!resolvedOut?.model && resolvedOut.model !== 'deepseek/deepseek-v4-flash-0731', `model=${resolvedOut && resolvedOut.model}`);
}

// ── V3: cross-provider quota (managed direct -> openrouter, different quota pool) ─
{
  const SID = 'sess-p26r12-v3-cross';
  // zhipu/glm-4.6 managed direct; requirement consumed in agent/request cross-provider branch
  const a1 = await runRequestError(quotaPayload(SID, 'zhipu', 'deepseek/deepseek-v4-flash-0731'));
  check('V3a first pass retries (budget available)', a1 && a1.kind === 'retry', `action=${JSON.stringify(a1)}`);
  const resolvedOut = await runAgentRequest(SID, { provider: 'zhipu', model: 'deepseek/deepseek-v4-flash-0731' }, { model: 'deepseek' });
  check('V3b cross-provider moves to openrouter', !!resolvedOut && resolvedOut.provider === 'openrouter' && resolvedOut.model !== 'deepseek/deepseek-v4-flash-0731', `provider=${resolvedOut && resolvedOut.provider} model=${resolvedOut && resolvedOut.model}`);
}

// ── V4: late receipt (no pending requirement) -> next failure defers ────────
{
  const SID = 'sess-p26r12-v4-late';
  ctx.emit('ec/quota-no-alternative', { sessionId: SID, provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731', reason: 'quota_exhausted' });
  const action = await runRequestError(quotaPayload(SID, 'openrouter', 'deepseek/deepseek-v4-flash-0731'));
  check('V4a late receipt -> defer (no retry)', noRetry(action), `action=${JSON.stringify(action)}`);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
