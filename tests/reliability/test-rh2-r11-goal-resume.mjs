// RH2 R1.1 GR1-GR7: phase-aware goal.resume fallback semantics.
// Synthetic only: no live server, profile, credentials, sessions, or process
// lifecycle operations.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../plugins/execution-continuity.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
    console.log(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function okResult(value) {
  return {
    ok: true,
    json: async () => ({ result: { ok: true, value } }),
  };
}

function structuredError(message, code = '') {
  return {
    ok: true,
    json: async () => ({
      result: { ok: false, error: { message, ...(code ? { code } : {}) } },
    }),
  };
}

function httpError(status, message = '') {
  return {
    ok: false,
    status,
    statusText: message,
    json: async () => ({}),
  };
}

function makeContext(sid) {
  const session = { events: [] };
  const sessions = new Map([[sid, session]]);
  const services = {
    agents: {},
    goals: { get: () => ({ id: 'goal-1', phase: 'active' }) },
    sessions: { get: (id) => sessions.get(id) || null },
    llm: { providers: {} },
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) { return services[name]; },
    read(name) { return services[name]; },
    on() { return () => {}; },
    effect() {},
    emit() {},
    agents: services.agents,
    goals: services.goals,
    sessions: services.sessions,
    llm: services.llm,
  };
  return ctx;
}

function makeListValue(sid, revision = 7) {
  const goal = { id: 'goal-1' };
  if (typeof revision === 'number') goal.revision = revision;
  return {
    items: [{
      sessionId: sid,
      running: false,
      projections: { values: { goal: { goal } } },
    }],
  };
}

async function runCase({ sid, entry = 'resumeViaApi', goalResult, promptResult = okResult({}), goalRevision = 7, initialGoalId = null }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh2-r11-'));
  const ctx = makeContext(sid);
  const plugin = apply(ctx, { stateDir, enableAutoResume: false, rpcTimeoutMs: 20 });
  const store = plugin._test.store;
  store.ensure(sid);
  if (initialGoalId) store.get(sid).goalId = initialGoalId;
  const previousFetch = globalThis.fetch;
  let promptCalls = 0;
  let goalCalls = 0;
  let promptPayload = null;
  globalThis.fetch = async (url, options = {}) => {
    if (url.includes('/session.history')) return okResult({ events: [] });
    if (url.includes('/session.list')) return okResult(makeListValue(sid, goalRevision));
    if (url.includes('/goal.resume')) {
      goalCalls += 1;
      if (typeof goalResult === 'function') return goalResult({ options, call: goalCalls });
      return goalResult || okResult({});
    }
    if (url.includes('/session.prompt')) {
      promptCalls += 1;
      try { promptPayload = JSON.parse(options.body); } catch { promptPayload = null; }
      if (typeof promptResult === 'function') return promptResult({ options, call: promptCalls });
      return promptResult;
    }
    return okResult({});
  };
  try {
    const result = entry === 'resumeAfterCtClean'
      ? await plugin._test.resumeAfterCtClean(sid, store.get(sid), 'rh2-r11')
      : await plugin._test.resumeViaApi(sid, 'rh2-r11');
    const intent = store.get(sid);
    return {
      result,
      state: intent.state,
      failureClass: intent.failureClass,
      promptCalls,
      goalCalls,
      promptPayload,
      resumeRetryCount: intent.resumeRetryCount,
      nextRetryAt: intent.nextRetryAt,
    };
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

async function runOverlapCase() {
  const sid = 'rh2-adversarial-overlap';
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh2-overlap-'));
  const plugin = apply(makeContext(sid), { stateDir, enableAutoResume: false, rpcTimeoutMs: 100 });
  plugin._test.store.ensure(sid);
  const previousFetch = globalThis.fetch;
  let promptCalls = 0;
  let activePrompts = 0;
  let peakPrompts = 0;
  globalThis.fetch = async (url) => {
    if (url.includes('/session.list')) return okResult(makeListValue(sid));
    if (url.includes('/goal.resume')) return okResult({});
    if (url.includes('/session.prompt')) {
      promptCalls += 1;
      activePrompts += 1;
      peakPrompts = Math.max(peakPrompts, activePrompts);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activePrompts -= 1;
      return okResult({});
    }
    return okResult({});
  };
  try {
    const results = await Promise.all([
      plugin._test.resumeViaApi(sid, 'overlap-a'),
      plugin._test.resumeViaApi(sid, 'overlap-b'),
    ]);
    const intent = plugin._test.store.get(sid);
    return { results, state: intent.state, promptCalls, peakPrompts };
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

// GR1: generic HTTP 400 at goal.resume is not proof that the Session is dead;
// a successful queue prompt is the accepted recovery evidence.
{
  const out = await runCase({
    sid: 'rh2-gr1-http-400',
    goalResult: httpError(400, 'stale goal revision'),
  });
  check('GR1 goal HTTP 400 falls back exactly once', out.promptCalls === 1 && out.goalCalls === 1);
  check('GR1 prompt acceptance produces RUNNING', out.state === 'RUNNING' && out.result === 'RUNNING', `state=${out.state} result=${out.result}`);
  check('GR1 goal failure does not consume resume budget', out.resumeRetryCount === 0 && out.nextRetryAt === null, `count=${out.resumeRetryCount} next=${out.nextRetryAt}`);
}

// GR2: stale goal revision/ref is a goal-level failure and uses one prompt
// fallback rather than becoming FAILED_FATAL.
{
  const out = await runCase({
    sid: 'rh2-gr2-stale-ref',
    goalResult: structuredError('goal revision is stale; ref no longer matches', 'STALE_GOAL_REVISION'),
  });
  check('GR2 stale goal ref has exactly one fallback', out.promptCalls === 1 && out.goalCalls === 1);
  check('GR2 stale goal ref reaches RUNNING', out.state === 'RUNNING' && out.result === 'RUNNING', `state=${out.state}`);

  const missingRevision = await runCase({
    sid: 'rh2-gr2-missing-revision',
    goalRevision: null,
    initialGoalId: 'goal-1',
    goalResult: httpError(400, 'goal revision is required'),
  });
  check('GR2 missing goal revision HTTP 400 still falls back', missingRevision.promptCalls === 1 && missingRevision.goalCalls === 1 && missingRevision.state === 'RUNNING', JSON.stringify(missingRevision));
}

// GR3: explicit INVALID_SESSION proves Session loss and must not blind-prompt.
{
  const out = await runCase({
    sid: 'rh2-gr3-invalid-session',
    goalResult: structuredError('session does not exist', 'INVALID_SESSION'),
  });
  check('GR3 invalid session is terminal', out.state === 'FAILED_FATAL' && out.result === 'FAILED_FATAL', `state=${out.state} result=${out.result}`);
  check('GR3 invalid session makes zero prompt calls', out.promptCalls === 0, `calls=${out.promptCalls}`);
}

// GR4: explicit ownership conflict is terminal/manual-review and makes zero
// prompt calls, preserving the accepted RH2 protection.
{
  const out = await runCase({
    sid: 'rh2-gr4-ownership',
    goalResult: structuredError('session is owned by subagent routing', 'OWNERSHIP_CONFLICT'),
  });
  check('GR4 ownership conflict is terminal', out.state === 'FAILED_FATAL' && out.result === 'FAILED_FATAL', `state=${out.state}`);
  check('GR4 ownership conflict is typed and prompt-free', out.failureClass === 'OWNERSHIP_CONFLICT' && out.promptCalls === 0, JSON.stringify(out));
}

// GR5: a transient goal-level timeout is still eligible for the queue prompt;
// an accepted prompt resets/does not consume the recovery-failure budget.
{
  const out = await runCase({
    sid: 'rh2-gr5-transient',
    goalResult: structuredError('goal resume timed out', 'TIMEOUT'),
  });
  check('GR5 transient goal failure falls back once', out.promptCalls === 1 && out.goalCalls === 1);
  check('GR5 transient fallback reaches RUNNING without terminal budget', out.state === 'RUNNING' && out.resumeRetryCount === 0 && out.nextRetryAt === null, JSON.stringify(out));

  const promptTransient = await runCase({
    sid: 'rh2-gr5-prompt-transient',
    goalResult: structuredError('goal resume timed out', 'TIMEOUT'),
    promptResult: structuredError('session.prompt timed out', 'TIMEOUT'),
  });
  check('GR5 goal transient plus prompt transient counts only prompt failure',
    promptTransient.state === 'WAITING_NETWORK' && promptTransient.promptCalls === 1 && promptTransient.resumeRetryCount === 1,
    JSON.stringify(promptTransient));
}

// GR6: the final session.prompt gate remains strict. A recoverable goal error
// followed by prompt INVALID_REQUEST must terminalize the intent.
{
  const out = await runCase({
    sid: 'rh2-gr6-prompt-invalid',
    goalResult: structuredError('inactive goal state', 'INVALID_GOAL_STATE'),
    promptResult: structuredError('invalid request for session.prompt', 'INVALID_REQUEST'),
  });
  check('GR6 recoverable goal error still attempts prompt', out.promptCalls === 1);
  check('GR6 prompt INVALID_REQUEST is terminal', out.state === 'FAILED_FATAL' && out.result === 'FAILED_FATAL' && out.failureClass === 'INVALID_REQUEST', JSON.stringify(out));

  const promptInvalidSession = await runCase({
    sid: 'rh2-gr6-prompt-invalid-session',
    goalResult: structuredError('unknown goal state', 'UNKNOWN_GOAL'),
    promptResult: structuredError('session does not exist', 'INVALID_SESSION'),
  });
  check('GR6 prompt INVALID_SESSION remains terminal',
    promptInvalidSession.state === 'FAILED_FATAL' && promptInvalidSession.failureClass === 'INVALID_SESSION' && promptInvalidSession.promptCalls === 1,
    JSON.stringify(promptInvalidSession));
}

// GR7: exercise the same fallback and terminal scenarios through the
// Completion-Truth-clean entry, which must share the exact same goal/prompt tail.
{
  const viaApi = await runCase({
    sid: 'rh2-gr7-via-api',
    entry: 'resumeViaApi',
    goalResult: structuredError('unknown goal reference', 'UNKNOWN_GOAL'),
  });
  const afterCt = await runCase({
    sid: 'rh2-gr7-after-ct',
    entry: 'resumeAfterCtClean',
    goalResult: structuredError('unknown goal reference', 'UNKNOWN_GOAL'),
  });
  check('GR7 after-CT clean fallback matches normal path',
    afterCt.state === viaApi.state && afterCt.result === viaApi.result && afterCt.promptCalls === viaApi.promptCalls && afterCt.goalCalls === viaApi.goalCalls,
    `viaApi=${JSON.stringify(viaApi)} afterCt=${JSON.stringify(afterCt)}`);

  const viaApiTerminal = await runCase({
    sid: 'rh2-gr7-terminal-api',
    entry: 'resumeViaApi',
    goalResult: structuredError('session not found', 'INVALID_SESSION'),
  });
  const afterCtTerminal = await runCase({
    sid: 'rh2-gr7-terminal-ct',
    entry: 'resumeAfterCtClean',
    goalResult: structuredError('session not found', 'INVALID_SESSION'),
  });
  check('GR7 after-CT clean terminal gate matches normal path',
    afterCtTerminal.state === viaApiTerminal.state && afterCtTerminal.result === viaApiTerminal.result && afterCtTerminal.promptCalls === viaApiTerminal.promptCalls && afterCtTerminal.failureClass === viaApiTerminal.failureClass,
    `viaApi=${JSON.stringify(viaApiTerminal)} afterCt=${JSON.stringify(afterCtTerminal)}`);
}

// Adversarial overlap regression: direct concurrent calls (the shape produced
// by an event callback racing with a timer/scan) share one in-flight guard.
{
  const out = await runOverlapCase();
  check('AD1 concurrent recovery emits one prompt and remains RUNNING',
    out.promptCalls === 1 && out.peakPrompts === 1 && out.state === 'RUNNING', JSON.stringify(out));
}

console.log(`\nRH2 R1.1 goal.resume: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('RH2 R1.1 GOAL.RESUME TEST PASSED');
