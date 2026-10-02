// event-shape-compat.mjs — dual-substrate event-binding tolerance + fail-safe diagnostics.
//
// WHY THIS FILE EXISTS
//   Two official bases dispatch the SAME event with DIFFERENT listener-visible argument shapes:
//     * 0.1.1-rc.2  : the scope carrier / event name were passed as POSITIONAL arguments
//                     (`cb(carrier, "agent/created", payload)` — the old emit form), so listeners
//                     written as `(carrier, _eventName, payload)` were correct.
//     * 0.2.0-rc.2  : the carrier moved to `this`, so the payload is the ONLY positional argument
//                     (`(this: Scoped<Agent>, payload: { agent, source, signal? })`), and
//                     `session/event` is delivered as TWO positional arguments
//                     (`(this: Scoped<Session>, session, event)`).
//   A listener written for one form therefore does not throw on the other — it simply reads
//   `undefined` and does nothing. That is a SILENT no-op: the failure mode this project treats as
//   the worst kind, because every health signal still looks green.
//
// WHAT THIS MODULE GUARANTEES
//   1. Binding accepts EITHER substrate form and reports which form it matched (so a base switch
//      cannot silently disable a listener).
//   2. A shape that matches NO known form produces LISTENER_BINDING_FAILED — never a silent return,
//      and never a false "success". Diagnostics are rate-limited (one per distinct observation per
//      event, hard-capped per process) so a hot event path cannot flood the log.
//   3. The pickers are pure and self-tested at plugin startup; a failing self-test is reported once
//      as COMPATIBILITY_UNKNOWN.
//   4. Only SHAPES are ever logged (types + own key names, max 8 per argument). Payload VALUES are
//      never logged, so no session content or credential can leak through a diagnostic.
//
// Pure ESM, zero dependencies.

export const SHAPE = Object.freeze({
  PAYLOAD_ARG0: 'payload-arg0',
  PAYLOAD_ARG0_EXTRA: 'payload-arg0+extra',
  CARRIER_FIRST: 'carrier-first',
  PAYLOAD_ARG1: 'payload-arg1',
  POSITIONAL2: 'positional2',
  PAYLOAD_WRAPPED: 'payload-wrapped',
  EVENT_ARG0: 'event-arg0',
  UNKNOWN: 'unknown',
});

export const BINDING_STATE = Object.freeze({
  RECOGNIZED: 'RECOGNIZED',
  COMPATIBILITY_UNKNOWN: 'COMPATIBILITY_UNKNOWN',
  LISTENER_BINDING_FAILED: 'LISTENER_BINDING_FAILED',
});

const isObj = (v) => v !== null && typeof v === 'object';
const has = (o, k) => isObj(o) && k in o;

/** Shape-only descriptor of an argument list. Never captures values. */
export function observe(args) {
  return Array.from(args).slice(0, 4).map((a, i) => {
    const t = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
    let keys = [];
    if (isObj(a) && !Array.isArray(a)) {
      try { keys = Object.keys(a).slice(0, 8); } catch { keys = ['<unreadable>']; }
    }
    return { i, type: t, isObject: isObj(a), keyCount: isObj(a) && !Array.isArray(a) ? Object.keys(a).length : 0, keys };
  });
}

/**
 * agent/created — official shapes:
 *   0.2.0-rc.2: (payload { agent, source, signal? })           -> payload-arg0
 *   0.1.1     : (carrier, eventName, payload { agent })        -> carrier-first
 * Some substrates deliver the wrapper with extra positional args; still recognised.
 */
export function pickAgentCreated(args) {
  const a = Array.from(args);
  if (has(a[0], 'agent')) return { agent: a[0].agent, shape: a.length === 1 ? SHAPE.PAYLOAD_ARG0 : SHAPE.PAYLOAD_ARG0_EXTRA };
  if (a.length >= 3 && has(a[2], 'agent')) return { agent: a[2].agent, shape: SHAPE.CARRIER_FIRST };
  if (has(a[1], 'agent')) return { agent: a[1].agent, shape: SHAPE.PAYLOAD_ARG1 };
  return { agent: undefined, shape: SHAPE.UNKNOWN, observed: observe(a) };
}

/**
 * session/event — official shapes:
 *   0.2.0-rc.2: (session, event)                               -> positional2
 *   0.1.1     : (carrier, session, event)                      -> carrier-first
 *   0.1.1 alt : (carrier, 'session/event', {sessionId, event})  -> payload-wrapped
 *   defensive : ({ session, event }) / (event)                 -> payload-wrapped / event-arg0
 */
export function pickSessionEvent(args) {
  const a = Array.from(args);
  if (a.length >= 2 && has(a[1], 'type')) return { session: a[0], event: a[1], shape: SHAPE.POSITIONAL2 };
  if (a.length >= 3 && has(a[2], 'type')) return { session: a[1], event: a[2], shape: SHAPE.CARRIER_FIRST };
  // carrier-first with a NAMED-event wrapper payload: (carrier, 'session/event', { session|sessionId, event })
  if (a.length >= 3 && has(a[2], 'event') && has(a[2].event, 'type')) {
    return { session: a[2].session ?? a[2].sessionId ?? (isObj(a[1]) ? a[1] : undefined), event: a[2].event, shape: SHAPE.PAYLOAD_WRAPPED };
  }
  if (has(a[0], 'event') && has(a[0].event, 'type')) return { session: a[0].session, event: a[0].event, shape: SHAPE.PAYLOAD_WRAPPED };
  if (isObj(a[0]) && typeof a[0].type === 'string') return { session: undefined, event: a[0], shape: SHAPE.EVENT_ARG0 };
  return { session: undefined, event: undefined, shape: SHAPE.UNKNOWN, observed: observe(a) };
}

/**
 * agent/error — official shape 0.2.0-rc.2: (payload { agent, turn, step, error }) -> payload-arg0
 * 0.1.1 carrier-first form accepted as well.
 */
export function pickAgentError(args) {
  const a = Array.from(args);
  const looksLike = (o) => has(o, 'agent') || has(o, 'error');
  if (looksLike(a[0])) return { payload: a[0], shape: a.length === 1 ? SHAPE.PAYLOAD_ARG0 : SHAPE.PAYLOAD_ARG0_EXTRA };
  if (a.length >= 3 && looksLike(a[2])) return { payload: a[2], shape: SHAPE.CARRIER_FIRST };
  if (looksLike(a[1])) return { payload: a[1], shape: SHAPE.PAYLOAD_ARG1 };
  return { payload: undefined, shape: SHAPE.UNKNOWN, observed: observe(a) };
}

/**
 * Fail-safe binding diagnostics.
 *  - report(event, shape, ok, observed?) : records the binding outcome; logs ONCE per distinct
 *    outcome (shape) per event, and never more than MAX_LOGS times per process.
 *  - state() : current per-event binding state for probes/tests.
 *  - selfTest() : validates every picker against the canonical arg sets of BOTH official bases plus
 *    a malformed set (which must NOT be reported as recognised).
 */
export function createBindingDiagnostics({ plugin = 'plugin', logger = null, maxLogs = 6 } = {}) {
  const state = new Map();
  const seen = new Set();
  let logs = 0;
  const log = (level, msg) => {
    if (logs >= maxLogs) return;
    logs++;
    try { logger?.[level]?.(`[${plugin}] ${msg}`); } catch { /* logging must never throw */ }
  };

  function report(event, shape, ok, observed) {
    const prev = state.get(event);
    const next = ok ? BINDING_STATE.RECOGNIZED : BINDING_STATE.LISTENER_BINDING_FAILED;
    const detail = ok ? shape : `${shape} observed=${JSON.stringify(observed ?? [])}`;
    if (prev?.state === next && prev?.detail === detail) return prev; // no repeat logging
    const entry = { state: next, shape, detail, at: Date.now() };
    state.set(event, entry);
    if (ok) {
      log('info', `event binding OK: ${event} shape=${shape}`);
    } else {
      log('warn', `LISTENER_BINDING_FAILED: ${event} matched no known substrate shape — the listener is INERT (no silent success assumed). observed=${JSON.stringify(observed ?? [])}`);
    }
    return entry;
  }

  function providerUnavailable(event, note) {
    state.set(event, { state: BINDING_STATE.COMPATIBILITY_UNKNOWN, detail: String(note ?? ''), at: Date.now() });
    log('warn', `COMPATIBILITY_UNKNOWN: ${event} ${note ?? ''}`);
  }

  function selfTest() {
    const checks = [];
    const t = (name, got, want) => checks.push({ name, got, want, ok: got === want });
    const wrapper = { agent: { id: 'a' }, source: 'x' };
    t('agent/created payload-arg0', pickAgentCreated([wrapper]).shape, SHAPE.PAYLOAD_ARG0);
    t('agent/created carrier-first', pickAgentCreated([{ id: 'carrier' }, 'agent/created', wrapper]).shape, SHAPE.CARRIER_FIRST);
    t('agent/created malformed->unknown', pickAgentCreated(['agent/created', undefined, undefined]).shape, SHAPE.UNKNOWN);
    t('session/event positional2', pickSessionEvent([{ id: 's' }, { type: 'turn/end' }]).shape, SHAPE.POSITIONAL2);
    t('session/event carrier-first', pickSessionEvent([{ id: 'c' }, { id: 's' }, { type: 'turn/end' }]).shape, SHAPE.CARRIER_FIRST);
    t('session/event wrapped', pickSessionEvent([{ session: { id: 's' }, event: { type: 'turn/end' } }]).shape, SHAPE.PAYLOAD_WRAPPED);
    t('session/event malformed->unknown', pickSessionEvent([{ id: 's' }]).shape, SHAPE.UNKNOWN);
    t('agent/error payload-arg0', pickAgentError([{ agent: {}, error: new Error('x') }]).shape, SHAPE.PAYLOAD_ARG0);
    t('agent/error carrier-first', pickAgentError([{}, 'agent/error', { agent: {}, error: new Error('x') }]).shape, SHAPE.CARRIER_FIRST);
    t('agent/error malformed->unknown', pickAgentError([{}, 'agent/error']).shape, SHAPE.UNKNOWN);
    const pass = checks.every((c) => c.ok);
    if (!pass) {
      state.set('*selfTest', { state: BINDING_STATE.COMPATIBILITY_UNKNOWN, detail: 'picker self-test failed', at: Date.now() });
      log('error', `COMPATIBILITY_UNKNOWN: picker SELF-TEST FAILED — ${checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`);
    } else {
      log('info', 'picker self-test PASS (both official substrate shapes + malformed rejection)');
    }
    return { pass, checks };
  }

  return {
    report,
    providerUnavailable,
    selfTest,
    state: () => Object.fromEntries([...state.entries()].map(([k, v]) => [k, { state: v.state, shape: v.shape, detail: v.detail }])),
    logCount: () => logs,
  };
}
