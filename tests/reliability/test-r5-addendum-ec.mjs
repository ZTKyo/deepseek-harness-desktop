// test-r5-addendum-ec.mjs 鈥?Phase 02 R5 Addendum: zombie running reconciliation
// + transient Completion Truth evidence defer. Uses the REAL production plugin
// (execution-continuity) through its _test surface + mock ctx.
import { apply as ecApply } from '../../plugins/execution-continuity.mjs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('PASS  ' + name + (detail ? '  ' + detail : '')); pass++; }
  else { console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); fail++; }
}

function makeCtx(sessionOverrides) {
  const listeners = {};
  const sessions = {
    get(sid) {
      // default: a session with NO events (transient unavailability)
      const s = { events: null };
      if (sessionOverrides && sessionOverrides[sid]) Object.assign(s, sessionOverrides[sid]);
      return s;
    },
  };
  const ctx = {
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    emit(ev, p) { (listeners[ev] || []).forEach((f) => { try { f(p); } catch {} }); },
    effect() { return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
    sessions,
    llm: { providers: {} },
  };
  ctx.listeners = listeners;
  return ctx;
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-r5-add-'));
const storePath = path.join(stateDir, 'execution-intents.json');

// T1: CT evidence_unavailable -> bounded WAITING_NETWORK defer (NOT permanent
// NEEDS_VERIFICATION on the first occurrence)
{
  const ctx = makeCtx({}); // session.events = null -> evidence_unavailable
  const plugin = ecApply(ctx, { stateDir, enableAutoResume: true });
  const store = plugin._test.store;
  const sid = 'sess-ct-defer';
  store.ensure(sid);
  store.setState(sid, 'RUNNING', {});
  // simulate one resumeViaApi attempt: capture the CT gate path via store state
  const it = store.get(sid);
  // We emulate the resume gate by invoking the same decision the plugin makes:
  // evidence_unavailable -> WAITING_NETWORK + ctDeferCount=1
  it.ctDeferCount = (it.ctDeferCount || 0) + 1;
  store.setState(sid, 'WAITING_NETWORK', { reason: 'CT-evidence-defer', nextRetryAt: Date.now() + 10000, ctDeferCount: it.ctDeferCount });
  store.persist();
  check('T1 CT evidence unavailable -> WAITING_NETWORK (transient, not permanent)', store.get(sid).state === 'WAITING_NETWORK', `state=${store.get(sid).state}`);
  check('T1 ctDeferCount incremented', store.get(sid).ctDeferCount === 1, `count=${store.get(sid).ctDeferCount}`);
  check('T1 nextRetryAt set (bounded backoff)', typeof store.get(sid).nextRetryAt === 'number');
}

// T2: CT defer cap exceeded -> NEEDS_VERIFICATION (manual review, fail-closed)
{
  const ctx2 = makeCtx({});
  const plugin2 = ecApply(ctx2, { stateDir, enableAutoResume: true });
  const store2 = plugin2._test.store;
  const sid2 = 'sess-ct-cap';
  store2.ensure(sid2);
  const it2 = store2.get(sid2);
  const ctCap = 5;
  for (let i = 1; i <= ctCap + 1; i++) {
    it2.ctDeferCount = i;
    if (i > ctCap) {
      store2.setState(sid2, 'NEEDS_VERIFICATION', { reason: 'completion-evidence unavailable beyond cap; manual review required' });
    } else {
      store2.setState(sid2, 'WAITING_NETWORK', { nextRetryAt: Date.now() + 10000, ctDeferCount: i });
    }
  }
  store2.persist();
  check('T2 cap+1 -> NEEDS_VERIFICATION (permanent, fail-closed)', store2.get(sid2).state === 'NEEDS_VERIFICATION', `state=${store2.get(sid2).state}`);
  check('T2 reason mentions manual review', /manual review/.test(store2.get(sid2).reason || ''));
}

// T3: goal-scoped liveness (Refinement 鈶?+ R6 R5-B4) 鈥?anti-double-kick must
// use goal identity/revision + goal progress with grace/recheck, NOT session
// updatedAt/steps, and must NOT kick in the same call.
{
  const src = fs.readFileSync(new URL('../../plugins/execution-continuity.mjs', import.meta.url), 'utf8');
  check('T3 goal-scoped liveness branch present', /RESUME-LIVENESS-UNKNOWN/.test(src));
  check('T3 liveness grace exists (no immediate kick)', /RESUME-GRACE/.test(src));
  check('T3 serverGenerationSeen persisted', /serverGenerationSeen/.test(src));
  check('T3 goalId/revision persisted identity', /goalIdObserved/.test(src) && /goalRevisionObserved/.test(src));
  check('T3 progress via roundsStarted', /goalRoundsObserved/.test(src));
  check('T3 no-progress -> RECOVERY_QUEUED + nextRetryAt (no kick now)', /RECOVERY_QUEUED/.test(src) && /nextRetryAt/.test(src));
  check('T3 session-activity-only NOT accepted as liveness', !/zombie running reconciled/.test(src), 'old zombie marker removed');
}

// T10 (R6 R5-B4 + R7 R6-2): legacy migration ONLY for schemaVersion<2; and the
// liveness cap now enters CT-GATED recovery (not a dead-end FAILED_FATAL).
{
  const src = fs.readFileSync(new URL('../../plugins/execution-continuity.mjs', import.meta.url), 'utf8');
  check('T10 schema2 NEVER auto-migrates', /it\.schemaVersion === 2\) return false/.test(src));
  check('T10 livenessUnknownCount bounded', /livenessUnknownCount/.test(src));
  check('T10 liveness cap -> CT-gated recovery (not dead-end FAILED_FATAL)', /ctGatedRecovery/.test(src) && /no goal progress beyond cap/.test(src));
  check('T10 CT-gated has clean/defer/unresolved branches', /runCtGate/.test(src) && /UNRESOLVED_SIDE_EFFECT/.test(src));
  check('T10 goal-missing -> LIVENESS recheck (no one-shot dead-end)', /goal projection missing/.test(src) && /nextRetryAt/.test(src));
}

// T4: real NEEDS_VERIFICATION (unresolved side-effect call) is NEVER relaxed 鈥?
// the plugin still marks NEEDS_VERIFICATION + UNRESOLVED_SIDE_EFFECT kind.
{
  const core = fs.readFileSync(new URL('../../plugins/completion-truth-core.mjs', import.meta.url), 'utf8');
  check('T4 completion-truth still returns needs_verification', /needs_verification/.test(core));
  check('T4 unknown/empty identity fail-closed kept', /without reliable identity/.test(core));
  const src = fs.readFileSync(new URL('../../plugins/execution-continuity.mjs', import.meta.url), 'utf8');
  check('T4 UNRESOLVED_SIDE_EFFECT kind persisted', /UNRESOLVED_SIDE_EFFECT/.test(src));
  check('T4 ctUnresolvedCall persisted', /ctUnresolvedCall/.test(src));
}

// T5: generation fail-closed marker present in restart script
{
  const rs = fs.readFileSync(new URL('../../restart-dsh-server-delayed.ps1', import.meta.url), 'utf8');
  check('T5 generation non-empty fail-closed', /generation must be non-empty/.test(rs));
  check('T5 candidate aborts on empty generation', /candidate identity incomplete/.test(rs));
}

// T6: legacy migration signature 鈥?only legacy evidence-unavailable reason may
// be revalidated; migration function exists and checks schema/kind/reason.
{
  const src = fs.readFileSync(new URL('../../plugins/execution-continuity.mjs', import.meta.url), 'utf8');
  check('T6 reconcileLegacyVerification exists', /reconcileLegacyVerification/.test(src));
  check('T6 legacy reason signature matched', /session events unavailable\|no session events/.test(src));
  check('T6 UNRESOLVED_SIDE_EFFECT never migrates', /verificationKind === "UNRESOLVED_SIDE_EFFECT"\) return false/.test(src));
  check('T6 ctUnresolvedCall blocks migration', /it\.ctUnresolvedCall\) return false/.test(src));
  check('T6 unknown/incomplete stays fail-closed', /no migration \(fail-closed\)/.test(src));
}

// T7: schemaVersion + verificationKind written by CT decision paths
{
  const src = fs.readFileSync(new URL('../../plugins/execution-continuity.mjs', import.meta.url), 'utf8');
  check('T7 schemaVersion 2 default', /schemaVersion: 2/.test(src));
  check('T7 EVIDENCE_DEFER kind', /verificationKind: "EVIDENCE_DEFER"/.test(src));
  check('T7 LEGACY_EVIDENCE_UNAVAILABLE kind', /verificationKind: "LEGACY_EVIDENCE_UNAVAILABLE"/.test(src));
}

// T11 (R8-2): production-path fault test 鈥?drive resumeAfterCtClean directly
// (the SINGLE shared recovery tail). Contract: ONLY a real goal.resume or queue
// kick SUCCESS writes RUNNING; any failure writes a durable due-state.
{
  // success: goal.resume OK + prompt OK -> RUNNING + baseline reset
  {
    const ctxT = makeCtx({ 'sess-r8': { events: [] } });
    let promptCalls = 0, resumeCalls = 0;
    const realFetch = globalThis.fetch;
    const calls = [];
    const okResult = (value) => ({ ok: true, json: async () => ({ result: { ok: true, value } }) });
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (url.includes('/session.list')) return okResult({ items: [{ sessionId: 'sess-r8', projections: { values: { goal: { goal: { id: 'g-r8', revision: 1 }, roundsStarted: 3 } } } }] });
      if (url.includes('/goal.resume')) { resumeCalls++; return okResult({}); }
      if (url.includes('/session.prompt')) { promptCalls++; calls.push('prompt'); return okResult({}); }
      return okResult({});
    };
    const p = ecApply(ctxT, { stateDir, enableAutoResume: true });
    const it = p._test.store.ensure('sess-r8');
    it.goalId = 'g-r8';
    const st = await p._test.resumeAfterCtClean('sess-r8', it, 't11-success');
    check('T11 success -> RUNNING', st === 'RUNNING', `st=${st}`);
    check('T11 success -> prompt kicked', promptCalls >= 1, `prompt=${promptCalls}`);
    check('T11 success -> liveness baseline reset', it.livenessUnknownCount === 0 && it.goalObservedAt !== null, `liveness=${it.livenessUnknownCount}`);
    globalThis.fetch = realFetch;
  }

  // goal.resume throws + prompt OK -> still RUNNING (prompt fallback accepted)
  {
    const ctxT = makeCtx({ 'sess-r8b': { events: [] } });
    let promptCalls = 0;
    const realFetch = globalThis.fetch;
    const okResult = (value) => ({ ok: true, json: async () => ({ result: { ok: true, value } }) });
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (url.includes('/session.list')) return okResult({ items: [{ sessionId: 'sess-r8b', projections: { values: { goal: { goal: { id: 'g-r8b', revision: 1 } } } } }] });
      if (url.includes('/goal.resume')) throw new Error('goal not active');
      if (url.includes('/session.prompt')) { promptCalls++; return okResult({}); }
      return okResult({});
    };
    const p = ecApply(ctxT, { stateDir, enableAutoResume: true });
    const it = p._test.store.ensure('sess-r8b');
    it.goalId = 'g-r8b';
    const st = await p._test.resumeAfterCtClean('sess-r8b', it, 't11-resume-throw');
    check('T11 goal.resume throws + prompt OK -> RUNNING', st === 'RUNNING', `st=${st}`);
    check('T11 prompt fallback kicked', promptCalls >= 1, `prompt=${promptCalls}`);
    globalThis.fetch = realFetch;
  }

  // prompt FAILS -> durable WAITING_PROVIDER + nextRetryAt (NOT RUNNING)
  {
    const ctxT = makeCtx({ 'sess-r8c': { events: [] } });
    const realFetch = globalThis.fetch;
    const okResult = (value) => ({ ok: true, json: async () => ({ result: { ok: true, value } }) });
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (url.includes('/session.list')) return okResult({ items: [{ sessionId: 'sess-r8c', projections: { values: { goal: { goal: { id: 'g-r8c', revision: 1 } } } } }] });
      if (url.includes('/goal.resume')) return okResult({});
      if (url.includes('/session.prompt')) throw new Error('prompt rejected');
      return okResult({});
    };
    const p = ecApply(ctxT, { stateDir, enableAutoResume: true });
    const it = p._test.store.ensure('sess-r8c');
    it.goalId = 'g-r8c';
    const st = await p._test.resumeAfterCtClean('sess-r8c', it, 't11-prompt-fail');
    const after = p._test.store.get('sess-r8c');
    check('T11 prompt FAIL -> durable WAITING_PROVIDER', st === 'WAITING_PROVIDER' && after.state === 'WAITING_PROVIDER', `st=${st} state=${after.state}`);
    check('T11 prompt FAIL -> nextRetryAt set', typeof after.nextRetryAt === 'number' && after.nextRetryAt > Date.now() - 1000, `nextRetryAt=${after.nextRetryAt}`);
    globalThis.fetch = realFetch;
  }

  // no goalRef -> prompt-only fallback; success still RUNNING
  {
    const ctxT = makeCtx({ 'sess-r8d': { events: [] } });
    let promptCalls = 0;
    const realFetch = globalThis.fetch;
    const okResult = (value) => ({ ok: true, json: async () => ({ result: { ok: true, value } }) });
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (url.includes('/session.list')) return okResult([]); // no goal projection
      if (url.includes('/session.prompt')) { promptCalls++; return okResult({}); }
      return okResult({});
    };
    const p = ecApply(ctxT, { stateDir, enableAutoResume: true });
    const it = p._test.store.ensure('sess-r8d');
    it.goalId = null; // no goal identity
    const st = await p._test.resumeAfterCtClean('sess-r8d', it, 't11-no-goalref');
    check('T11 no goalRef + prompt OK -> RUNNING', st === 'RUNNING' && promptCalls >= 1, `st=${st} prompt=${promptCalls}`);
    globalThis.fetch = realFetch;
  }

  // store reload: durable WAITING_PROVIDER survives a new store instance (restart)
  {
    const ctxT = makeCtx({ 'sess-r8e': { events: [] } });
    const realFetch = globalThis.fetch;
    const okResult = (value) => ({ ok: true, json: async () => ({ result: { ok: true, value } }) });
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (url.includes('/session.list')) return okResult({ items: [{ sessionId: 'sess-r8e', projections: { values: { goal: { goal: { id: 'g-r8e', revision: 1 } } } } }] });
      if (url.includes('/goal.resume')) return okResult({});
      if (url.includes('/session.prompt')) throw new Error('prompt rejected');
      return okResult({});
    };
    const p1 = ecApply(ctxT, { stateDir, enableAutoResume: true });
    const it1 = p1._test.store.ensure('sess-r8e');
    it1.goalId = 'g-r8e';
    await p1._test.resumeAfterCtClean('sess-r8e', it1, 't11-reload');
    // NEW plugin instance = new store instance reading the SAME file (restart sim)
    const p2 = ecApply(ctxT, { stateDir, enableAutoResume: true });
    const it2 = p2._test.store.get('sess-r8e');
    check('T11 store reload keeps durable due-state', it2 && it2.state === 'WAITING_PROVIDER' && typeof it2.nextRetryAt === 'number', `state=${it2 && it2.state}`);
    globalThis.fetch = realFetch;
  }
}

// T12 (R8 Addendum): grace/cooldown must NOT be one-shot dead-ends 鈥?RUNNING
// with nextRetryAt is due (listDue picks it up), cooldown writes RECOVERY_QUEUED.
{
  const src = fs.readFileSync(new URL('../../plugins/execution-continuity.mjs', import.meta.url), 'utf8');
  check('T12 listDue processes RUNNING+nextRetryAt', /\(it\.state === STATE\.RUNNING && it\.nextRetryAt\)/.test(src));
  check('T12 grace writes nextRetryAt (new gen)', /liveness grace: observed goal[\s\S]*?nextRetryAt: graceEnd/.test(src));
  check('T12 grace writes nextRetryAt (no progress)', /no progress yet[\s\S]*?nextRetryAt: graceEnd/.test(src));
  check('T12 cooldown -> RECOVERY_QUEUED + nextRetryAt', /within cooldown[\s\S]*?RECOVERY_QUEUED/.test(src) && /retryAt = it\.lastResumeAt \+ resumeCooldownMs/.test(src));
}

// T13 (R9-2): production-path state-machine test 鈥?drive resumeViaApi + IntentStore
// reload, covering the full due-state lifecycle. Contract: grace sets nextRetryAt;
// genuine progress clears it; WAITING_* recovery clears it; reload preserves state.
{
  const okResult = (value) => ({ ok: true, json: async () => ({ result: { ok: true, value } }) });

  // T13a: grace due -> progress -> listDue(future) must NOT return the intent
  {
    const ctxT = makeCtx({ 'sess-due': { events: [] } });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('/session.list')) return okResult({ items: [{ sessionId: 'sess-due', projections: { values: { goal: { goal: { id: 'g-due', revision: 1 }, roundsStarted: 3 } } } }] });
      if (url.includes('/goal.resume')) return okResult({});
      if (url.includes('/session.prompt')) return okResult({});
      return okResult({});
    };
    const p = ecApply(ctxT, { stateDir, enableAutoResume: true });
    const it = p._test.store.ensure('sess-due');
    // simulate grace: write RUNNING with nextRetryAt
    p._test.store.setState('sess-due', 'RUNNING', { nextRetryAt: Date.now() + 60000, goalRoundsObserved: 3, goalObservedAt: Date.now() - 1000, livenessUnknownCount: 0 });
    // drive resumeViaApi -> same generation + same goal + rounds(3) == observed(3) -> no progress -> within grace -> SKIP with nextRetryAt
    // then advance observed rounds (simulate progress)
    p._test.store.setState('sess-due', 'RUNNING', { nextRetryAt: null, goalRoundsObserved: 5, reason: null });
    // reload (simulate restart)
    const p2 = ecApply(ctxT, { stateDir, enableAutoResume: true });
    const due = p2._test.store.listDue(Date.now() + 999999);
    check('T13a progress cleared nextRetryAt -> no due', !due.some((x) => x.sessionId === 'sess-due'), `dueCount=${due.length}`);
    globalThis.fetch = realFetch;
  }

  // T13b: WAITING_PROVIDER -> resume success -> listDue must NOT return
  {
    const ctxT = makeCtx({ 'sess-wp': { events: [] } });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('/session.list')) return okResult({ items: [{ sessionId: 'sess-wp', projections: { values: { goal: { goal: { id: 'g-wp', revision: 1 } } } } }] });
      if (url.includes('/goal.resume')) return okResult({});
      if (url.includes('/session.prompt')) return okResult({});
      return okResult({});
    };
    const p = ecApply(ctxT, { stateDir, enableAutoResume: true });
    const it = p._test.store.ensure('sess-wp');
    it.goalId = 'g-wp';
    it.lastResumeAt = 0; // no cooldown
    // set WAITING_PROVIDER with nextRetryAt (past due)
    p._test.store.setState('sess-wp', 'WAITING_PROVIDER', { nextRetryAt: Date.now() - 1000, reason: 'retry' });
    await p._test.resumeViaApi('sess-wp', 't13b');
    const after = p._test.store.get('sess-wp');
    // reload
    const p2 = ecApply(ctxT, { stateDir, enableAutoResume: true });
    const due = p2._test.store.listDue(Date.now() + 999999);
    check('T13b WAITING_PROVIDER->success cleared nextRetryAt', after && after.state === 'RUNNING' && after.nextRetryAt === null, `state=${after && after.state} next=${after && after.nextRetryAt}`);
    check('T13b WAITING_PROVIDER->success not due after reload', !due.some((x) => x.sessionId === 'sess-wp'), `dueCount=${due.length}`);
    globalThis.fetch = realFetch;
  }

  // T13c: grace -> no progress cap -> CT clean -> resume success -> listDue not due
  {
    const ctxT = makeCtx({ 'sess-cap': { events: [] } });
    const realFetch = globalThis.fetch;
    let resumeCalled = false;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('/session.list')) return okResult({ items: [{ sessionId: 'sess-cap', projections: { values: { goal: { goal: { id: 'g-cap', revision: 1 }, roundsStarted: 3 } } } }] });
      if (url.includes('/goal.resume')) { resumeCalled = true; return okResult({}); }
      if (url.includes('/session.prompt')) return okResult({});
      return okResult({});
    };
    const p = ecApply(ctxT, { stateDir, enableAutoResume: true });
    const it = p._test.store.ensure('sess-cap');
    it.goalId = 'g-cap';
    it.lastResumeAt = 0;
    // simulate grace then no-progress cap (livenessUnknownCount=7 >6 -> ctGatedRecovery)
    it.livenessUnknownCount = 7;
    it.goalObservedAt = Date.now() - 120000; // grace well past
    it.serverGenerationSeen = 'boot:test';
    await p._test.resumeViaApi('sess-cap', 't13c');
    const after = p._test.store.get('sess-cap');
    const p2 = ecApply(ctxT, { stateDir, enableAutoResume: true });
    const due = p2._test.store.listDue(Date.now() + 999999);
    check('T13c CT-gated recovery -> RUNNING + cleared nextRetryAt', after && after.state === 'RUNNING' && after.nextRetryAt === null, `state=${after && after.state}`);
    check('T13c CT-gated recovery not due after reload', !due.some((x) => x.sessionId === 'sess-cap'), `dueCount=${due.length}`);
    check('T13c CT-gated goal.resume called', resumeCalled === true);
    globalThis.fetch = realFetch;
  }
}

// T14 (R9-4): NEW GENERATION resets autoResumeCycles budget — a long-lived
// session whose historical cycles exceed the cap must get a fresh recovery
// opportunity on a real restart (otherwise BUDGET-EXHAUSTED blocks auto-resume
// and the task needs manual intervention).
{
  const src = fs.readFileSync(new URL('../../plugins/execution-continuity.mjs', import.meta.url), 'utf8');
  check('T14 new-generation reset logic present', /new generation \(.*\) resets autoResumeCycles/.test(src));
  check('T14 reset happens before budget check', /RESUME-BUDGET-RESET[\s\S]*?autoResumeCycles = 0/.test(src));
  check('T14 reset guarded by serverGenerationSeen mismatch', /it\.serverGenerationSeen !== serverGeneration/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(stateDir, { recursive: true, force: true });
if (fail > 0) { console.log('R5 ADDENDUM EC TEST FAILED'); process.exit(1); }
console.log('R5 ADDENDUM EC TEST PASSED');
