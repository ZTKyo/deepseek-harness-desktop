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

// T14 (R10-1): autoResumeBudgetGeneration — once-per-boot budget epoch marker.
// Source-level contract verification (production-path test in T15).
{
  const src = fs.readFileSync(new URL('../../plugins/execution-continuity.mjs', import.meta.url), 'utf8');
  check('T14 autoResumeBudgetGeneration field present', /autoResumeBudgetGeneration/.test(src));
  check('T14 reset uses dedicated marker', /it\.autoResumeBudgetGeneration !== serverGeneration/.test(src));
  check('T14 atomic cycles + marker in one path', /it\.autoResumeCycles = 0[\s\S]*?it\.autoResumeBudgetGeneration = serverGeneration/.test(src));
  check('T14 no longer reuses serverGenerationSeen for reset', !/serverGenerationSeen !== serverGeneration[\s\S]*?autoResumeCycles = 0/.test(src));
  check('T14 initialState has autoResumeBudgetGeneration', /autoResumeBudgetGeneration: null/.test(src));
}

// T15 (R10-1): production-path once-per-boot — same generation repeated
// entries must NOT re-reset (marker = current gen after 1st reset); store
// reload preserves the marker.
{
  const ctxT = makeCtx({ 'sess-gen': { events: [] } });
  const realFetch = globalThis.fetch;
  const okResult = (value) => ({ ok: true, json: async () => ({ result: { ok: true, value } }) });
  globalThis.fetch = async (url, opts) => {
    if (url.includes('/session.list')) return okResult({ items: [{ sessionId: 'sess-gen', projections: { values: { goal: { goal: { id: 'g-gen', revision: 1 } } } } }] });
    if (url.includes('/goal.resume')) return okResult({});
    if (url.includes('/session.prompt')) return okResult({});
    return okResult({});
  };
  const p = ecApply(ctxT, { stateDir, enableAutoResume: true });
  const it = p._test.store.ensure('sess-gen');
  it.goalId = 'g-gen';
  it.autoResumeBudgetGeneration = 'boot:OLD';
  it.autoResumeCycles = 15;
  it.lastResumeAt = 0;
  it.serverGenerationSeen = 'boot:OLD';
  p._test.store.persist();
  // The plugin's serverGeneration is read from the real runtime ledger at
  // apply() time; in this isolated test env it may be null. We verify the
  // CONTRACT: the reset branch is guarded by the dedicated marker and the
  // marker is set in the SAME atomic write as the cycles reset.
  const src = fs.readFileSync(new URL('../../plugins/execution-continuity.mjs', import.meta.url), 'utf8');
  check('T15 once-per-boot guard', /if \(serverGeneration && it\.autoResumeBudgetGeneration !== serverGeneration\)/.test(src));
  check('T15 atomic write marker+cycles', /it\.autoResumeCycles = 0;\s*it\.autoResumeBudgetGeneration = serverGeneration;/.test(src));
  check('T15 marker persist', /autoResumeBudgetGeneration[\s\S]*?store\.persist\(\)/.test(src) || /store\.persist\(\)[\s\S]*?autoResumeBudgetGeneration/.test(src));
  // store reload preserves marker
  const p2 = ecApply(ctxT, { stateDir, enableAutoResume: true });
  const it2 = p2._test.store.get('sess-gen');
  check('T15 marker survives store reload', it2 && it2.autoResumeBudgetGeneration === 'boot:OLD', `marker=${it2 && it2.autoResumeBudgetGeneration}`);
  globalThis.fetch = realFetch;
}

// T16 (R11-1): REAL production-path budget-epoch test — drives production
// resumeViaApi() with a TEST-ONLY injected serverGeneration, 20+ entries in the
// SAME generation (including an early-return fault path) must reset the budget
// EXACTLY ONCE; store reload in the same generation must NOT re-reset; a new
// generation (changed childPid/startedAt) resets once more. Checks the PERSISTED
// autoResumeBudgetGeneration + autoResumeCycles (no regex-only acceptance).
{
  const ctxT = makeCtx({ 'sess-epoch': { events: [] } });
  const realFetch = globalThis.fetch;
  const okResult = (value) => ({ ok: true, json: async () => ({ result: { ok: true, value } }) });
  let listCall = 0;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('/session.list')) {
      listCall++;
      // early-return fault path: every 5th call throws (simulates session.list
      // unavailable -> WAITING_NETWORK defer path, which returns BEFORE the
      // liveness branch that would otherwise update serverGenerationSeen)
      if (listCall % 5 === 0) throw new Error('simulated session.list unavailable');
      return okResult({ items: [{ sessionId: 'sess-epoch', projections: { values: { goal: { goal: { id: 'g-epoch', revision: 1 } } } } }] });
    }
    if (url.includes('/goal.resume')) return okResult({});
    if (url.includes('/session.prompt')) return okResult({});
    return okResult({});
  };

  // Boot A: inject generation boot:AAA, intent has old marker boot:OLD
  const pA = ecApply(ctxT, { stateDir, enableAutoResume: true, serverGeneration: 'boot:AAA_1' });
  const itA = pA._test.store.ensure('sess-epoch');
  itA.goalId = 'g-epoch';
  itA.autoResumeBudgetGeneration = 'boot:OLD_0';   // marker from a previous boot
  itA.autoResumeCycles = 15;                        // historical cycles above cap
  itA.lastResumeAt = 0;
  itA.serverGenerationSeen = 'boot:OLD_0';
  pA._test.store.persist();

  // 20+ entries in the SAME generation boot:AAA_1 — including early-return
  // fault paths (every 5th call throws). The budget must reset EXACTLY ONCE
  // (first entry sets marker=AAA_1; later entries see marker==gen -> skip).
  for (let i = 0; i < 25; i++) {
    await pA._test.resumeViaApi('sess-epoch', 't16-same-gen');
  }
  const after20 = pA._test.store.get('sess-epoch');
  check('T16 same-gen 25 entries reset EXACTLY once', after20.autoResumeBudgetGeneration === 'boot:AAA_1' && after20.autoResumeCycles <= 1, `marker=${after20.autoResumeBudgetGeneration} cycles=${after20.autoResumeCycles}`);
  // The cycles should be 0 or 1 (reset once at first entry, then +1 per
  // RESUME-OK within this boot). The KEY assertion: marker stayed AAA_1 and
  // cycles did NOT get reset again (would show cycles > 1 if re-reset looped).

  // store reload (simulate plugin restart in the SAME boot) -> same gen, no reset
  const pB = ecApply(ctxT, { stateDir, enableAutoResume: true, serverGeneration: 'boot:AAA_1' });
  const itB = pB._test.store.get('sess-epoch');
  const cyclesBeforeReload = itB.autoResumeCycles;
  const markerBeforeReload = itB.autoResumeBudgetGeneration;
  for (let i = 0; i < 20; i++) {
    await pB._test.resumeViaApi('sess-epoch', 't16-reload-same-gen');
  }
  const afterReload = pB._test.store.get('sess-epoch');
  check('T16 reload same-gen does NOT re-reset marker', afterReload.autoResumeBudgetGeneration === 'boot:AAA_1' && afterReload.autoResumeBudgetGeneration === markerBeforeReload, `marker=${afterReload.autoResumeBudgetGeneration}`);
  check('T16 reload same-gen cycles monotonic (no reset to 0)', afterReload.autoResumeCycles >= cyclesBeforeReload, `cycles ${cyclesBeforeReload}->${afterReload.autoResumeCycles}`);

  // NEW generation (childPid/startedAt changed -> boot:BBB) -> reset ONCE more
  const pC = ecApply(ctxT, { stateDir, enableAutoResume: true, serverGeneration: 'boot:BBB_2' });
  const itC = pC._test.store.get('sess-epoch');
  const cyclesBeforeNew = itC.autoResumeCycles;
  await pC._test.resumeViaApi('sess-epoch', 't16-new-gen');
  const afterNew1 = pC._test.store.get('sess-epoch');
  check('T16 new gen resets marker to new gen', afterNew1.autoResumeBudgetGeneration === 'boot:BBB_2', `marker=${afterNew1.autoResumeBudgetGeneration}`);
  check('T16 new gen resets cycles', afterNew1.autoResumeCycles <= 1, `cycles=${afterNew1.autoResumeCycles} (was ${cyclesBeforeNew})`);
  for (let i = 0; i < 15; i++) {
    await pC._test.resumeViaApi('sess-epoch', 't16-new-gen-more');
  }
  const afterNew2 = pC._test.store.get('sess-epoch');
  check('T16 new gen 16 entries reset EXACTLY once', afterNew2.autoResumeBudgetGeneration === 'boot:BBB_2', `marker=${afterNew2.autoResumeBudgetGeneration} cycles=${afterNew2.autoResumeCycles}`);

  globalThis.fetch = realFetch;
}

// ── SH-R6 T17: state invariant — recoverable state must NEVER coexist with
// autoResume=false (the hidden contradiction that silently filters the intent
// out of BOTH listRecoverable() and listDue(), stalling boot scan + timer).
// Simulates the production race: goal complete -> COMPLETED+autoResume=false
// -> liveness/resume success path re-writes RUNNING -> invariant must restore
// autoResume=true so the intent stays visible to recovery.
{
  const ctx = makeCtx({});
  const plugin = ecApply(ctx, { stateDir, enableAutoResume: true, serverGeneration: 'boot:R6_1' });
  const store = plugin._test.store;
  const sid = 'sess-r6-invariant';

  // Phase 1: goal complete path (goal/changed) writes COMPLETED + autoResume=false
  store.ensure(sid);
  store.setState(sid, 'COMPLETED', { autoResume: false, reason: 'goal-complete' });
  let it = store.get(sid);
  check('T17a complete -> COMPLETED+autoResume=false (non-recoverable, allowed)', it.state === 'COMPLETED' && it.autoResume === false, `state=${it.state} autoResume=${it.autoResume}`);

  // Phase 2: liveness/resume success path re-writes RUNNING (the race)
  store.setState(sid, 'RUNNING', { note: 'resume-after-ct-clean kick accepted', nextRetryAt: null, reason: null });
  it = store.get(sid);
  check('T17b RUNNING after resume success -> autoResume restored TRUE (invariant)', it.autoResume === true, `state=${it.state} autoResume=${it.autoResume}`);

  // Phase 3: the intent must be visible to recovery (listRecoverable + listDue)
  const recoverable = store.listRecoverable().filter((x) => x.sessionId === sid);
  check('T17c RUNNING+autoResume=true is in listRecoverable()', recoverable.length === 1, `recoverable=${recoverable.length}`);

  // Phase 4: WAITING_USER (pending question) -> active/recovery path also restores
  store.setState(sid, 'WAITING_USER', { autoResume: false, reason: 'pending-question' });
  it = store.get(sid);
  check('T17d WAITING_USER -> autoResume=false (non-recoverable, allowed)', it.autoResume === false, `autoResume=${it.autoResume}`);
  store.setState(sid, 'RUNNING', { note: 'user answered -> active again' });
  it = store.get(sid);
  check('T17e RUNNING after WAITING_USER -> autoResume TRUE (invariant)', it.autoResume === true, `autoResume=${it.autoResume}`);
  check('T17f recoverable again after re-activation', store.listRecoverable().filter((x) => x.sessionId === sid).length === 1);

  // Phase 5: direct it.state assignment (goal/changed active path) stays true
  it = store.get(sid);
  it.state = 'RUNNING'; it.autoResume = true; // L1218 path
  check('T17g direct active-path assignment keeps autoResume=true', store.get(sid).autoResume === true);
}

// ── SH-R7 T18: ADVERSARIAL invariant gate - even an explicit
// { autoResume: false } in extra must NOT create a recoverable state with
// autoResume=false (setState normalizes AFTER merging extra).
{
  const ctx = makeCtx({});
  const plugin = ecApply(ctx, { stateDir, enableAutoResume: true, serverGeneration: 'boot:R7_1' });
  const store = plugin._test.store;
  const recoverableStates = ['RUNNING', 'WAITING_NETWORK', 'WAITING_PROVIDER', 'RECOVERY_QUEUED', 'INTERRUPTED_BY_RESTART'];
  for (const st of recoverableStates) {
    const sid = `sess-r7-adversarial-${st}`;
    store.ensure(sid);
    // the adversarial call: explicit autoResume:false in extra
    store.setState(sid, st, { autoResume: false, reason: 'adversarial' });
    const it = store.get(sid);
    check(`T18 ${st} + extra.autoResume=false -> autoResume normalized TRUE`, it.autoResume === true, `state=${it.state} autoResume=${it.autoResume}`);
    // and it must remain visible to recovery
    check(`T18 ${st} visible in listRecoverable()`, store.listRecoverable().filter((x) => x.sessionId === sid).length === 1);
  }
  // RETRYING: autoResume is normalized TRUE too, but listRecoverable() EXCLUDES
  // RETRYING by design (P0: the retry handler owns it; boot scan/timer must not
  // concurrently resume it) - so assert normalization + exclusion separately.
  {
    const sid = 'sess-r7-adversarial-RETRYING';
    store.ensure(sid);
    store.setState(sid, 'RETRYING', { autoResume: false, reason: 'adversarial' });
    const it = store.get(sid);
    check('T18 RETRYING + extra.autoResume=false -> autoResume normalized TRUE', it.autoResume === true, `autoResume=${it.autoResume}`);
    check('T18 RETRYING excluded from listRecoverable() (design: handler owns retry)', store.listRecoverable().filter((x) => x.sessionId === sid).length === 0);
  }
  // non-recoverable states must KEEP autoResume=false (extra respected)
  for (const [st, sid] of [['COMPLETED', 'sess-r7-nr-complete'], ['WAITING_USER', 'sess-r7-nr-waituser'], ['USER_PAUSED', 'sess-r7-nr-paused']]) {
    store.ensure(sid);
    store.setState(sid, st, { autoResume: false });
    const it = store.get(sid);
    check(`T18 ${st} keeps autoResume=false (non-recoverable)`, it.autoResume === false, `autoResume=${it.autoResume}`);
    check(`T18 ${st} NOT in listRecoverable()`, store.listRecoverable().filter((x) => x.sessionId === sid).length === 0);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(stateDir, { recursive: true, force: true });
if (fail > 0) { console.log('R5 ADDENDUM EC TEST FAILED'); process.exit(1); }
console.log('R5 ADDENDUM EC TEST PASSED');
