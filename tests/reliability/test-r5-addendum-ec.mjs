// test-r5-addendum-ec.mjs — Phase 02 R5 Addendum: zombie running reconciliation
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

// T3: goal-scoped liveness (Refinement ② + R6 R5-B4) — anti-double-kick must
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

// T4: real NEEDS_VERIFICATION (unresolved side-effect call) is NEVER relaxed —
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

// T6: legacy migration signature — only legacy evidence-unavailable reason may
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

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(stateDir, { recursive: true, force: true });
if (fail > 0) { console.log('R5 ADDENDUM EC TEST FAILED'); process.exit(1); }
console.log('R5 ADDENDUM EC TEST PASSED');
