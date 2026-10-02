#!/usr/bin/env node
// P4.5 K3 — offline fixture tests for the hardened goal-recovery projection read path.
//
// Ported from the K3 spike suite (_p4_5-sandbox/tools/p45-k3k4-goal-recovery-tests.mjs, 34 fixtures)
// and extended with R6 CLI-contract fixtures that spawn the REAL goal-recovery.mjs against a
// loopback-only fake API. Nothing here touches the live service, the sessions store, or the network
// beyond 127.0.0.1. The "resume" sink is a counter, so no fixture can have a side effect.
//
// Run: node tests/goal-recovery/run-goal-recovery-projection-tests.mjs
// Exit: 0 = every fixture behaved as required · 1 = at least one requirement FAILED · 2 = harness error
//
// Requirements covered: R1..R6 + the (a)(b)(c)(d)(e)(e2) fixture groups named in the P4.5 brief.
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(HERE, '..', '..', 'goal-recovery.mjs');

const {
  REASON, EXIT, readSessionListEnvelope, extractGoalView, activeGoalSessions,
  evaluatePendingQuestion, evaluateRecoveryEligibility, planRecovery, applyResume,
} = await import(new URL('../../goal-recovery.mjs', import.meta.url).href);

let pass = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { failures.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
};

// real wire value shape, taken verbatim from dsh-goal 0.1.1-rc.2 / 0.2.0-rc.2 goalProjectionSchema
const GOAL_VIEW = (phase = 'active', over = {}) => ({
  goal: { id: 'g-1', revision: 3, objective: 'do the thing', phase, maxGoalRounds: 256, ...over },
  roundsStarted: 1, createdAt: 1000, updatedAt: 2000,
});
const row = (sessionId, goal, over = {}) => ({ sessionId, running: true, agentAvailable: true, updatedAt: 2000, projections: { kind: 'sequenced', asOfSeq: 42, values: { goal } }, ...over });
const envelope = (items) => ({ jsonrpc: '2.0', id: 1, result: { value: { items } } });

process.on('uncaughtException', (e) => { console.log('  FAIL  <uncaught> ' + (e && e.stack ? e.stack : e)); failures.push('uncaught: ' + e); });
process.on('unhandledRejection', (e) => { console.log('  FAIL  <unhandled> ' + (e && e.stack ? e.stack : e)); failures.push('unhandled: ' + e); });

try {
  console.log('[K3] fixture group 1 — envelope strictness (R1)');
  ok('(R1) null body refused', readSessionListEnvelope(null).reason === REASON.ENVELOPE_MALFORMED);
  ok('(R1) result missing refused', readSessionListEnvelope({}).reason === REASON.ENVELOPE_MALFORMED);
  ok('(R1) result.value missing refused', readSessionListEnvelope({ result: {} }).reason === REASON.ENVELOPE_MALFORMED);
  ok('(R1) items absent refused', readSessionListEnvelope({ result: { value: {} } }).reason === REASON.ITEMS_MALFORMED);
  ok('(R1) items non-array refused', readSessionListEnvelope({ result: { value: { items: {} } } }).reason === REASON.ITEMS_MALFORMED);
  ok('(R1) error member refused', readSessionListEnvelope({ result: { error: { code: -1 }, value: { items: [] } } }).reason === REASON.ENVELOPE_MALFORMED);
  ok('(R1) empty items accepted', readSessionListEnvelope({ result: { value: { items: [] } } }).ok === true);

  console.log('[K3] fixture group 2 — (a) projection missing / (b) malformed shape / (c) cold miss');
  ok('(a) row without projections refused', extractGoalView({ sessionId: 's1' }).reason === REASON.PROJECTION_BLOCK_MISSING);
  ok('(a) projections without values refused', extractGoalView({ sessionId: 's1', projections: {} }).reason === REASON.PROJECTION_VALUES_MISSING);
  ok('(c) partial hint row (values without goal key) refused', extractGoalView({ sessionId: 's1', projections: { kind: 'cached', asOfSeq: 7, values: { sessionListMetadata: { blank: false } } } }).reason === REASON.GOAL_COLUMN_MISSING);
  ok('(c) one cold row poisons the whole listing, no silent skip',
    activeGoalSessions(envelope([row('s1', GOAL_VIEW('active')), { sessionId: 's2' }])).ok === false);
  ok('(b) goal projection not object,null refused', extractGoalView(row('s1', 'active')).reason === REASON.GOAL_SHAPE_MALFORMED);
  ok('(b) missing inner goal member refused', extractGoalView(row('s1', { roundsStarted: 1, createdAt: 1, updatedAt: 2 })).reason === REASON.GOAL_SHAPE_MALFORMED);
  ok('(b) id not string refused', extractGoalView(row('s1', GOAL_VIEW('active', { id: 5 }))).reason === REASON.GOAL_SHAPE_MALFORMED);
  ok('(b) revision non-positive refused', extractGoalView(row('s1', GOAL_VIEW('active', { revision: 0 }))).reason === REASON.GOAL_SHAPE_MALFORMED);
  ok('(b) unknown phase refused (drift, never "inactive")', extractGoalView(row('s1', GOAL_VIEW('running_forever'))).reason === REASON.GOAL_PHASE_UNKNOWN);
  ok('(b) 0.2.0 half-written projection (no createdAt/updatedAt) refused',
    extractGoalView({ sessionId: 's1', projections: { values: { goal: { goal: { id: 'g', revision: 1, phase: 'active', maxGoalRounds: 4 }, roundsStarted: 0 } } } }).reason === REASON.GOAL_SHAPE_MALFORMED);
  ok('(state-shape drift) 0.2.0 internal state {current,...} is NOT accepted as a wire view',
    extractGoalView(row('s1', { current: GOAL_VIEW('active'), seenGoalIds: ['g-1'], failure: null })).reason === REASON.GOAL_SHAPE_MALFORMED);
  ok('null goal projection = trustworthy "no goal"', (() => { const r = extractGoalView(row('s1', null)); return r.ok === true && r.hasGoal === false; })());

  console.log('[K3] fixture group 3 — (e) happy path + non-active phases');
  ok('(e) active goal read exactly as 0.1.1/0.2.0 publish it', (() => { const r = extractGoalView(row('s1', GOAL_VIEW('active'))); return r.ok && r.goal.id === 'g-1' && r.goal.phase === 'active' && r.goal.revision === 3 && r.asOfSeq === 42; })());
  ok('paused/blocked/complete are read, not resumable', ['paused', 'blocked', 'complete'].every((p) => { const r = extractGoalView(row('s1', GOAL_VIEW(p))); return r.ok && r.hasGoal && r.goal.phase === p; }));

  console.log('[K3] fixture group 4 — (d) WAIT-GATE never weakened');
  const askedCall = { type: 'assistant/message', data: { turn: 5, message: { content: [{ type: 'tool-call', id: 'call-9', name: 'ask_user_question' }] } } };
  const answeredCall = { type: 'tool/result', data: { turn: 5, message: { source: { callId: 'call-9' } } } };
  ok('(d) ask_user_question without tool/result => pending', evaluatePendingQuestion([askedCall]).state === 'pending');
  ok('(d) answered by call id => none', evaluatePendingQuestion([askedCall, answeredCall]).state === 'none');
  ok('(d) answered by turn => none', evaluatePendingQuestion([askedCall, { type: 'tool/result', data: { turn: 5 } }]).state === 'none');
  ok('(d) question/requested without resolved => pending', evaluatePendingQuestion([{ type: 'question/requested', data: { rpcId: 'q1' } }]).state === 'pending');
  ok('(d) question/requested then resolved => none', evaluatePendingQuestion([{ type: 'question/requested', data: { rpcId: 'q1' } }, { type: 'question/resolved', data: { rpcId: 'q1' } }]).state === 'none');
  ok('(d) unevaluable stream => unknown (EC fails open here, we must not)', evaluatePendingQuestion(undefined).state === 'unknown');
  ok('(d) pending question blocks an otherwise active goal', evaluateRecoveryEligibility(extractGoalView(row('s1', GOAL_VIEW('active'))), { state: 'pending' }).reason === REASON.WAITING_USER);
  ok('(d) unknown wait state blocks resume', evaluateRecoveryEligibility(extractGoalView(row('s1', GOAL_VIEW('active'))), { state: 'unknown' }).reason === REASON.WAIT_STATE_UNKNOWN);

  console.log('[K3] fixture group 5 — (e2) refusal paths perform NO resume side effect');
  const sink = { resumed: 0 };
  const requestResume = async () => { sink.resumed += 1; };
  const refusedPlans = [
    planRecovery({ bad: true }, () => ({ state: 'none' })),
    planRecovery(envelope([{ sessionId: 's2' }]), () => ({ state: 'none' })),
    planRecovery(envelope([row('s1', GOAL_VIEW('active'))]), () => ({ state: 'pending' })),
    planRecovery(envelope([row('s1', GOAL_VIEW('active'))]), () => ({ state: 'unknown' })),
    planRecovery(envelope([row('s1', null)]), () => ({ state: 'none' })),
    planRecovery(envelope([row('s1', GOAL_VIEW('complete'))]), () => ({ state: 'none' })),
  ];
  for (const p of refusedPlans) await applyResume(p, requestResume);
  ok('(e2) zero resumes across all refusal fixtures', sink.resumed === 0, 'resumed=' + sink.resumed);
  ok('(e2) refusal plan is flagged refused', refusedPlans.every((p) => p.refused === true || p.decisions.every((d) => !d.eligible)));

  const good = planRecovery(envelope([row('s1', GOAL_VIEW('active')), row('s3', GOAL_VIEW('complete')), row('s4', null)]), () => ({ state: 'none' }));
  const applied = await applyResume(good, requestResume);
  ok('(e) exactly one resume for one eligible active goal', sink.resumed === 1 && applied.attempted === 1, 'resumed=' + sink.resumed + ' attempted=' + applied.attempted);
  ok('(e) complete/no-goal rows never attempted', applied.results.filter((r) => r.resumed).length === 1);

  const boom = await applyResume(planRecovery(envelope([row('s1', GOAL_VIEW('active'))]), () => ({ state: 'none' })), async () => { throw new Error('rpc down'); });
  ok('(e) resume failure is reported, not hidden', boom.results[0].resumed === false && boom.results[0].reason === 'RESUME_FAILED');

  console.log('[K3] fixture group 6 — (R6) CLI contract against a loopback fake API (exit codes)');
  // A tiny loopback-only API. NOTE: the CLI must be spawned ASYNCHRONOUSLY — spawnSync would block
  // this process's event loop, and the fake server could then never answer (deadlock, not a bug in
  // the CLI). No fixture may reach the real service on 3080.
  let listBody = envelope([]);
  let listStatus = 200;
  let describeOk = true;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url.endsWith('host.describe')) {
        if (!describeOk) { res.writeHead(503); res.end('{}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: { value: {} } }));
        return;
      }
      if (listStatus !== 200) { res.writeHead(listStatus); res.end('{"error":"boom"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(typeof listBody === 'string' ? listBody : JSON.stringify(listBody));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const runCli = (args) => new Promise((resolve) => {
    const cp = spawn(process.execPath, [MODULE_PATH, '--port', String(port), '--grace-ms', '600', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
  });
  const jsonOf = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

  try {
    listBody = envelope([row('s1', GOAL_VIEW('active'))]);
    const active = await runCli(['--check']);
    ok('(R6) --check exits 0 when an active goal exists (guardian "active")', active.status === EXIT.OK, 'status=' + active.status + ' out=' + JSON.stringify(active.stdout));

    listBody = envelope([row('s1', null)]);
    const inactive = await runCli(['--check']);
    ok('(R6) --check exits 1 when the projection reads cleanly and no goal is active', inactive.status === EXIT.NOTHING_TO_DO, 'status=' + inactive.status + ' out=' + JSON.stringify(inactive.stdout));

    listBody = envelope([{ sessionId: 's1' }]);
    const refusedRow = await runCli(['--check']);
    ok('(R6) --check exits 3 (REFUSED, not 1) when a row carries no projections block', refusedRow.status === EXIT.REFUSED, 'status=' + refusedRow.status + ' out=' + JSON.stringify(refusedRow.stdout));

    listBody = envelope([{ sessionId: 's1', projections: { kind: 'cached', asOfSeq: 1, values: { sessionListMetadata: {} } } }]);
    ok('(R6) --check exits 3 on a cold/partial row (absence of evidence is never "nothing to do")', (await runCli(['--check'])).status === EXIT.REFUSED);

    listBody = envelope([row('s1', GOAL_VIEW('running_forever'))]);
    ok('(R6) --check exits 3 on unknown phase drift', (await runCli(['--check'])).status === EXIT.REFUSED);

    listBody = '{"jsonrpc":"2.0","id":1,"result":{"value":{"items":"nope"}}}';
    ok('(R6) --check exits 3 on a malformed envelope', (await runCli(['--check'])).status === EXIT.REFUSED);

    listStatus = 500;
    ok('(R6) --check exits 2 (API_UNAVAILABLE) on a transport error', (await runCli(['--check'])).status === EXIT.API_UNAVAILABLE);
    listStatus = 200;

    describeOk = false;
    ok('(R6) --check exits 2 when the API never becomes ready', (await runCli(['--check'])).status === EXIT.API_UNAVAILABLE);
    describeOk = true;

    listBody = envelope([row('s1', GOAL_VIEW('active'))]);
    const asJson = await runCli(['--check', '--json']);
    const parsed = jsonOf(asJson);
    ok('(R6) --check --json emits parseable JSON with mode=check', asJson.status === EXIT.OK && parsed && parsed.mode === 'check' && parsed.activeCount === 1,
      'status=' + asJson.status + ' out=' + JSON.stringify(asJson.stdout).slice(0, 200));
    ok('(R6) --check --json reports the WAIT-GATE block reason (no verified events source => unknown)',
      !!(parsed && parsed.blocked.length === 1 && parsed.blocked[0].reason === REASON.WAIT_STATE_UNKNOWN),
      JSON.stringify(parsed && parsed.blocked));

    const requireEligible = await runCli(['--check', '--require-eligible']);
    ok('(R6) --check --require-eligible exits 1 when the only candidate is wait-gated',
      requireEligible.status === EXIT.NOTHING_TO_DO, 'status=' + requireEligible.status);

    const eventsFile = path.join(HERE, '..', 'fixtures', 'goal-recovery-wait-states.json');
    const withEvents = await runCli(['--check', '--require-eligible', '--events-file', eventsFile]);
    const parsedEvents = jsonOf(await runCli(['--check', '--json', '--require-eligible', '--events-file', eventsFile]));
    ok('(R6) --events-file with a clean stream makes the candidate eligible (exit 0)',
      withEvents.status === EXIT.OK && !!(parsedEvents && parsedEvents.eligible === 1),
      'status=' + withEvents.status + ' eligible=' + JSON.stringify(parsedEvents && parsedEvents.eligible));

    const parsedPlan = jsonOf(await runCli(['--plan', '--json']));
    ok('(R6) --plan is read-only and reports the same decision set',
      !!(parsedPlan && parsedPlan.mode === 'plan' && parsedPlan.blocked.length === 1),
      JSON.stringify(parsedPlan && { mode: parsedPlan.mode, b: parsedPlan.blocked.length }));

    const legacy = await runCli(['--session', 'some-id', '--action', 'resume']);
    ok('(R6) the removed stateless executor surface is rejected fail-closed (exit 4)', legacy.status === EXIT.AUTONOMY_DISABLED, 'status=' + legacy.status);

    const noMode = await runCli([]);
    ok('(R6) no --check/--plan exits 4 (autonomous recovery stays disabled)', noMode.status === EXIT.AUTONOMY_DISABLED, 'status=' + noMode.status);

    const badEvents = await runCli(['--check', '--events-file', path.join(HERE, 'does-not-exist.json')]);
    ok('(R6) an unreadable --events-file is refused (exit 3), never silently ignored', badEvents.status === EXIT.REFUSED, 'status=' + badEvents.status);
  } finally {
    await new Promise((r) => server.close(r));
  }
} catch (e) {
  // A crashed fixture must never be reported as green.
  console.log('  FAIL  <suite crashed> ' + (e && e.stack ? e.stack : e));
  failures.push('suite crashed: ' + (e && e.message ? e.message : e));
}

console.log('\n[K3] RESULT: pass=' + pass + ' fail=' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  !! ' + f)); process.exit(1); }
console.log('[K3] ALL FIXTURES PASS — the hardened read path keeps the goal.phase vocabulary of 0.1.1-rc.2 AND 0.2.0-rc.2, refuses every unreadable/absent/partial projection, and never resumes through a WAIT-GATE.');
process.exit(0);
