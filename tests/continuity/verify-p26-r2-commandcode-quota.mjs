// verify-p26-r2-commandcode-quota.mjs — Phase 02.6 R2 integration test.
// Blocker A fix: agent-default-model = commandcode/auto（当前主力）配额耗尽（1310）
// 后，Router 必须消费 EC 的 quota recovery requirement 并跨 provider 改写到
// openrouter 的 fallback 模型（不同配额池）——否则 commandcode 1310 后 session 停摆。
//
//   V1: commandcode 1310 -> EC emits quota requirement -> Router (outer agent/request)
//       REWRITES provider commandcode -> openrouter, model -> fallback target (≠auto)
//   V2: requirement consumed (ack -> null) after apply
//   V3: commandcode request WITHOUT requirement -> untouched (no interference)
//   V4: regression: openrouter branch quota switch still works (R1 V5 behavior)
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { apply as ecApply } from '../../plugins/execution-continuity.mjs';
import { apply as routerApply } from '../../plugins/openrouter-router.mjs';

// Deterministic model ids for assertions (mirrors real settings mappings).
process.env.OPENROUTER_DEEPSEEK_MODEL = 'deepseek/deepseek-v4-flash-0731';
process.env.OPENROUTER_QWEN_MODEL = 'qwen/qwen3.7-flash';
process.env.OPENROUTER_MIMO_MODEL = 'xiaomi/mimo-v2.5';
process.env.ROUTER_DIAGNOSTICS = 'false';

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

const RESET_LOCAL = new Date(Date.now() + 3600_000).toISOString();
function quotaPayload(sid, model) {
  return {
    agent: { session: { id: sid } },
    provider: 'zhipu',
    model,
    failure: { code: 'RATE_LIMIT', message: `429: {"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 ${RESET_LOCAL} 重置。"}` },
  };
}

// ── shared harness: Router (outer) + EC (inner), fresh state dirs ──────────
const ctx = makeCtx();
const router = routerApply(ctx, {});
const ecDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-p26r2-'));
process.env.EC_DISABLED = 'false';
process.env.EC_STATE_DIR = ecDir;
ecApply(ctx, { stateDir: ecDir, enableAutoResume: false });

let bridgeEvents = [];
ctx.on('ec/recovery-requirement', (p) => bridgeEvents.push(p));

async function runRequestError(payload) {
  const handlers = ctx.listeners['agent/request-error'] || [];
  const ecHandler = handlers[handlers.length - 1];
  if (!ecHandler) return null;
  return await ecHandler(payload, async () => null);
}
async function runAgentRequest(sid, resolved, opts = {}) {
  const handlers = ctx.listeners['agent/request'] || [];
  const routerHandler = handlers[0];
  return await routerHandler(
    { agent: { session: { id: sid }, options: { model: opts.model || 'auto' } } },
    () => resolved
  );
}

// ── V1: commandcode 1310 -> requirement -> cross-provider rewrite ───────────
{
  const SID = 'sess-p26r2-commandcode-quota';
  await runRequestError(quotaPayload(SID, 'glm-4.6'));
  const reqEvent = bridgeEvents.filter((e) => e.sessionId === SID);
  check('V1a EC emitted quota requirement for commandcode session', reqEvent.length >= 1 && /quota_exhausted/i.test(reqEvent[reqEvent.length - 1].requirement?.reason || ''), JSON.stringify(reqEvent[reqEvent.length - 1]?.requirement || {}).slice(0, 120));
  const st = router.state.get(SID);
  check('V1b Router stored the requirement', !!st?.recoveryRequirement && /quota_exhausted/i.test(st.recoveryRequirement.reason || ''));
  // next agent/request resolves the exhausted commandcode/auto route
  const resolvedOut = await runAgentRequest(SID, { provider: 'commandcode', model: 'auto', apiKey: 'k' });
  check('V1c provider rewritten commandcode -> openrouter', resolvedOut?.provider === 'openrouter', `provider=${resolvedOut && resolvedOut.provider}`);
  check('V1d model moved off exhausted route', !!resolvedOut?.model && resolvedOut.model !== 'auto' && resolvedOut.model === 'deepseek/deepseek-v4-flash-0731', `model=${resolvedOut && resolvedOut.model}`);
}

// ── V2: requirement ack'd (consumed) after apply ───────────────────────────
{
  const SID = 'sess-p26r2-commandcode-quota';
  const st = router.state.get(SID);
  check('V2a requirement consumed after apply', st ? (st.recoveryRequirement === null || st.recoveryRequirement === undefined) : false, `req=${st && st.recoveryRequirement && st.recoveryRequirement.reason}`);
}

// ── V3: commandcode without requirement -> untouched (no interference) ─────
{
  const SID = 'sess-p26r2-commandcode-plain';
  const resolvedOut = await runAgentRequest(SID, { provider: 'commandcode', model: 'auto', apiKey: 'k' });
  check('V3a no rewrite without requirement', resolvedOut?.provider === 'commandcode' && resolvedOut?.model === 'auto', `provider=${resolvedOut && resolvedOut.provider} model=${resolvedOut && resolvedOut.model}`);
  const st = router.state.get(SID);
  check('V3b no stale requirement consumed', !st?.recoveryRequirement);
}

// ── V4: regression — openrouter branch quota switch still works ────────────
{
  const SID = 'sess-p26r2-openrouter-quota';
  await runRequestError(quotaPayload(SID, 'glm-4.6'));
  const resolvedOut = await runAgentRequest(SID, { provider: 'openrouter', model: 'zhipu/glm-4.6' });
  check('V4a openrouter branch still switches off exhausted model', !!resolvedOut?.model && resolvedOut.model !== 'zhipu/glm-4.6', `model=${resolvedOut && resolvedOut.model}`);
  const st = router.state.get(SID);
  check('V4b openrouter requirement ack\'d', st ? (st.recoveryRequirement === null || st.recoveryRequirement === undefined) : false);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
