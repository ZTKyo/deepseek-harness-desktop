// RH2 EC1-EC6: deterministic production-path recovery tests.
// No live server, profile, credentials, or process lifecycle operations.

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
  return { ok: true, json: async () => ({ result: { ok: true, value } }) };
}

function errorResult(message, code = '') {
  return {
    ok: true,
    json: async () => ({ result: { ok: false, error: { message, ...(code ? { code } : {}) } } }),
  };
}

function makeContext(sessionMap) {
  const listeners = [];
  const services = {
    agents: {},
    goals: { get: () => ({ id: 'goal-1', phase: 'active' }) },
    sessions: { get: (id) => sessionMap.get(id) || { events: [] } },
    llm: { providers: {} },
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) { return services[name]; },
    read(name) { return services[name]; },
    on(event, handler) { listeners.push({ event, handler }); return () => {}; },
    // Keep boot inert: the tests call the exposed production recovery entry.
    effect() {},
    emit() {},
    _listeners: listeners,
    agents: services.agents,
    goals: services.goals,
    sessions: services.sessions,
    llm: services.llm,
  };
  return ctx;
}

function makeListValue(sid) {
  return {
    items: [{
      sessionId: sid,
      running: false,
      projections: { values: { goal: { goal: { id: 'goal-1', revision: 1 } } } },
    }],
  };
}

async function runResume({ sid, prompt, rpcTimeoutMs = 20, retryCount = 0 }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh2-ec-'));
  const sessions = new Map([[sid, { events: [] }]]);
  const ctx = makeContext(sessions);
  const plugin = apply(ctx, { stateDir, enableAutoResume: false, rpcTimeoutMs });
  const intent = plugin._test.store.ensure(sid);
  if (retryCount > 0) {
    plugin._test.store.setState(sid, 'WAITING_PROVIDER', { resumeRetryCount: retryCount, nextRetryAt: 0 });
  }
  const previousFetch = globalThis.fetch;
  let promptCalls = 0;
  let abortObserved = false;
  globalThis.fetch = async (url, options = {}) => {
    if (url.includes('/session.list')) return okResult(makeListValue(sid));
    if (url.includes('/goal.resume')) return okResult({});
    if (url.includes('/session.prompt')) {
      promptCalls += 1;
      return prompt({ options, call: promptCalls });
    }
    return okResult({});
  };
  try {
    const result = await plugin._test.resumeViaApi(sid, 'rh2-test');
    return { stateDir, plugin, intent, result, promptCalls, abortObserved: () => abortObserved };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

// EC1: ownership conflict is terminal and never becomes a provider loop.
{
  const sid = 'rh2-ec1-ownership';
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh2-ec1-'));
  const ctx = makeContext(new Map([[sid, { events: [] }]]));
  const plugin = apply(ctx, { stateDir, enableAutoResume: false, rpcTimeoutMs: 20 });
  plugin._test.store.ensure(sid);
  const previousFetch = globalThis.fetch;
  let promptCalls = 0;
  globalThis.fetch = async (url) => {
    if (url.includes('/session.list')) return okResult(makeListValue(sid));
    if (url.includes('/goal.resume')) return okResult({});
    if (url.includes('/session.prompt')) {
      promptCalls += 1;
      return errorResult(`session "${sid}" is owned by subagent routing`);
    }
    return okResult({});
  };
  try {
    const first = await plugin._test.resumeViaApi(sid, 'rh2-ec1');
    const it = plugin._test.store.get(sid);
    const due = plugin._test.store.listDue(Date.now() + 999999);
    const second = await plugin._test.resumeViaApi(sid, 'rh2-ec1-timer');
    check('EC1 exactly one prompt attempt', promptCalls === 1, `calls=${promptCalls}`);
    check('EC1 terminal/manual-review state', first === 'FAILED_FATAL' && it.state === 'FAILED_FATAL' && second === 'FAILED_FATAL', `state=${it.state}`);
    check('EC1 ownership conflict typed', it.failureClass === 'OWNERSHIP_CONFLICT' && it.lastFailure?.failureClass === 'OWNERSHIP_CONFLICT', JSON.stringify(it.lastFailure));
    check('EC1 no WAITING_PROVIDER due loop', !due.some((entry) => entry.sessionId === sid) && it.nextRetryAt === null, `due=${due.length}`);
    check('EC1 failure truth persisted', typeof it.lastFailureAt === 'number' && /owned by subagent routing/.test(it.lastFailure.message), JSON.stringify(it.lastFailure));
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

// EC2: a transient prompt timeout is durable and consumes the recovery budget.
{
  const sid = 'rh2-ec2-timeout';
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh2-ec2-'));
  const ctx = makeContext(new Map([[sid, { events: [] }]]));
  const plugin = apply(ctx, { stateDir, enableAutoResume: false, rpcTimeoutMs: 10 });
  plugin._test.store.ensure(sid);
  const previousFetch = globalThis.fetch;
  let promptCalls = 0;
  let aborted = false;
  globalThis.fetch = async (url, options = {}) => {
    if (url.includes('/session.list')) return okResult(makeListValue(sid));
    if (url.includes('/goal.resume')) return okResult({});
    if (url.includes('/session.prompt')) {
      promptCalls += 1;
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          aborted = options.signal.aborted;
          const error = new Error('request aborted by test timeout');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
    return okResult({});
  };
  try {
    await plugin._test.resumeViaApi(sid, 'rh2-ec2');
    const it = plugin._test.store.get(sid);
    check('EC2 timeout prompt attempted once', promptCalls === 1);
    check('EC2 AbortController observed', aborted === true);
    check('EC2 bounded transient state', it.state === 'WAITING_NETWORK' && it.resumeRetryCount === 1, `state=${it.state} count=${it.resumeRetryCount}`);
    check('EC2 timeout truth persisted', it.failureClass === 'TIMEOUT' && it.lastFailure?.category === 'transient' && typeof it.nextRetryAt === 'number', JSON.stringify(it.lastFailure));
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

// EC3: the same transient error beyond the cap fail-closes, with no infinite loop.
{
  const sid = 'rh2-ec3-cap';
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh2-ec3-'));
  const ctx = makeContext(new Map([[sid, { events: [] }]]));
  const plugin = apply(ctx, { stateDir, enableAutoResume: false, rpcTimeoutMs: 20 });
  plugin._test.store.ensure(sid);
  const previousFetch = globalThis.fetch;
  let promptCalls = 0;
  globalThis.fetch = async (url) => {
    if (url.includes('/session.list')) return okResult(makeListValue(sid));
    if (url.includes('/goal.resume')) return okResult({});
    if (url.includes('/session.prompt')) {
      promptCalls += 1;
      const error = new Error('socket temporarily unavailable');
      error.code = 'ECONNRESET';
      return Promise.reject(error);
    }
    return okResult({});
  };
  try {
    for (let i = 0; i < plugin._test.RESUME_FAILURE_RETRY_CAP + 1; i += 1) {
      const it = plugin._test.store.ensure(sid);
      it.nextRetryAt = 0;
      await plugin._test.resumeViaApi(sid, 'rh2-ec3');
    }
    const it = plugin._test.store.get(sid);
    check('EC3 cap exceeded terminal', it.state === 'FAILED_FATAL', `state=${it.state}`);
    check('EC3 prompt attempts are cap+1 then stop', promptCalls === plugin._test.RESUME_FAILURE_RETRY_CAP + 1, `calls=${promptCalls}`);
    check('EC3 count-based budget persisted', it.resumeRetryCount === plugin._test.RESUME_FAILURE_RETRY_CAP + 1 && it.failureClass === 'NETWORK', JSON.stringify(it));
    const before = promptCalls;
    await plugin._test.resumeViaApi(sid, 'rh2-ec3-after-terminal');
    check('EC3 terminal guard prevents further prompt', promptCalls === before);
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

// EC4: a fetch that never settles is released by the hard API timeout.
{
  const sid = 'rh2-ec4-rpc-timeout';
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh2-ec4-'));
  const ctx = makeContext(new Map([[sid, { events: [] }]]));
  const plugin = apply(ctx, { stateDir, enableAutoResume: false, rpcTimeoutMs: 15 });
  plugin._test.store.ensure(sid);
  const previousFetch = globalThis.fetch;
  let signal;
  globalThis.fetch = async (_url, options = {}) => {
    signal = options.signal;
    // Headers arrive, but body parsing never settles. The hard deadline must
    // cover this phase too, not only the fetch promise.
    return { ok: true, json: () => new Promise(() => {}) };
  };
  try {
    const started = Date.now();
    let error;
    try { await plugin._test.apiRpc('session.prompt', {}, { timeoutMs: 15 }); } catch (caught) { error = caught; }
    const elapsed = Date.now() - started;
    check('EC4 never-returning RPC rejects', !!error && error.failureClass === 'TIMEOUT', error ? error.message : 'no error');
    check('EC4 request aborted and bounded', signal?.aborted === true && elapsed < 500, `aborted=${signal?.aborted} elapsed=${elapsed}`);
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

// EC5: only an accepted RESUME-OK resets the transient budget and due marker.
{
  const sid = 'rh2-ec5-success';
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh2-ec5-'));
  const ctx = makeContext(new Map([[sid, { events: [] }]]));
  const plugin = apply(ctx, { stateDir, enableAutoResume: false, rpcTimeoutMs: 20 });
  const store = plugin._test.store;
  store.ensure(sid);
  store.setState(sid, 'WAITING_PROVIDER', { resumeRetryCount: 3, nextRetryAt: Date.now() - 1 });
  const previousFetch = globalThis.fetch;
  let promptCalls = 0;
  globalThis.fetch = async (url) => {
    if (url.includes('/session.list')) return okResult(makeListValue(sid));
    if (url.includes('/goal.resume')) return okResult({});
    if (url.includes('/session.prompt')) { promptCalls += 1; return okResult({}); }
    return okResult({});
  };
  try {
    await plugin._test.resumeViaApi(sid, 'rh2-ec5');
    const it = store.get(sid);
    check('EC5 resume success is RUNNING', it.state === 'RUNNING' && promptCalls === 1, `state=${it.state} prompts=${promptCalls}`);
    check('EC5 transient budget reset only on success', it.resumeRetryCount === 0, `count=${it.resumeRetryCount}`);
    check('EC5 stale nextRetryAt cleared', it.nextRetryAt === null, `next=${it.nextRetryAt}`);
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

// EC6: different UNKNOWN error text still shares the same persisted counter.
{
  const sid = 'rh2-ec6-text-variants';
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh2-ec6-'));
  const ctx = makeContext(new Map([[sid, { events: [] }]]));
  const plugin = apply(ctx, { stateDir, enableAutoResume: false, rpcTimeoutMs: 20 });
  plugin._test.store.ensure(sid);
  const previousFetch = globalThis.fetch;
  let promptCalls = 0;
  globalThis.fetch = async (url) => {
    if (url.includes('/session.list')) return okResult(makeListValue(sid));
    if (url.includes('/goal.resume')) return okResult({});
    if (url.includes('/session.prompt')) {
      promptCalls += 1;
      return errorResult(`opaque recovery fault variant-${promptCalls}`);
    }
    return okResult({});
  };
  try {
    for (let i = 0; i < plugin._test.RESUME_FAILURE_RETRY_CAP + 1; i += 1) {
      const it = plugin._test.store.ensure(sid);
      it.nextRetryAt = 0;
      await plugin._test.resumeViaApi(sid, `rh2-ec6-${i}`);
    }
    const it = plugin._test.store.get(sid);
    check('EC6 text variants remain UNKNOWN class', it.failureClass === 'UNKNOWN' && it.lastFailure?.category === 'unknown', JSON.stringify(it.lastFailure));
    check('EC6 text variants cannot evade cap', it.state === 'FAILED_FATAL' && it.resumeRetryCount === plugin._test.RESUME_FAILURE_RETRY_CAP + 1, `state=${it.state} count=${it.resumeRetryCount}`);
    check('EC6 latest variant is persisted truth', it.lastFailure?.message?.includes(`variant-${plugin._test.RESUME_FAILURE_RETRY_CAP + 1}`), JSON.stringify(it.lastFailure));
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

console.log(`\nRH2 EC: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('RH2 EC TEST PASSED');
