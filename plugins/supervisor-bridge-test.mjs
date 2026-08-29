// supervisor-bridge-test.mjs —— P2.75 受控测试矩阵（T1–T30，纯核心，无服务器）
// R1.1：新增 mutation contract（commandId/generation/stale guard）、ledger 分类（fail-closed）、
//       lifecycle reducer（Harness COMPLETE != Supervisor VERIFIED）、evidence/snapshot 构造。
// 运行：node plugins/supervisor-bridge-test.mjs
// 对应：docs/roadmap/reports/PHASE_02_75_SUPERVISOR/DESIGN_R1.md §7 + R1.1 Round2 contract

import assert from 'node:assert/strict';
import * as core from './supervisor-bridge-core.mjs';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
	try { fn(); pass++; console.log(`PASS ${name}`); }
	catch (e) { fail++; failures.push({ name, err: String(e?.message ?? e) }); console.log(`FAIL ${name}: ${e?.message ?? e}`); }
}

const SID = 'session-11111111-2222-3333-4444-555555555555';

// ---------- R1 冻结基础（保持） ----------

t('T1 key validation', () => {
	assert.equal(core.validateDispatch({ idempotencyKey: 'short', objective: 'goal test ok' }).ok, false);
	assert.equal(core.validateDispatch({ idempotencyKey: 'has space!!', objective: 'goal test ok' }).ok, false);
	assert.equal(core.validateDispatch({ idempotencyKey: 'a'.repeat(129), objective: 'goal test ok' }).ok, false);
	assert.equal(core.validateDispatch({ idempotencyKey: 'ok-key_01', objective: 'goal test ok' }).ok, true);
	assert.equal(core.validateDispatch({ idempotencyKey: 'k'.repeat(128), objective: 'goal test ok' }).ok, true);
	assert.equal(core.validateDispatch({ objective: 'goal test ok' }).ok, false);
});

t('T2 objective validation', () => {
	assert.equal(core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'ab' }).ok, false);
	assert.equal(core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: '' }).ok, false);
	assert.equal(core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'x'.repeat(8001) }).ok, false);
	const v = core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: '  do the thing  ' });
	assert.equal(v.ok, true);
	assert.equal(v.value.objective, 'do the thing');
});

t('T3 maxGoalRounds bounds', () => {
	for (const bad of [0, 65, 1.5, 'x']) {
		assert.equal(core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'goal test ok', maxGoalRounds: bad }).ok, false, `should reject ${bad}`);
	}
	const v = core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'goal test ok', maxGoalRounds: 64 });
	assert.equal(v.ok, true);
	assert.equal(v.value.maxGoalRounds, 64);
});

t('T4 deterministic session id', () => {
	const a = core.deriveSessionId('alpha-key-0001');
	const b = core.deriveSessionId('alpha-key-0001');
	const c = core.deriveSessionId('alpha-key-0002');
	assert.equal(a, b);
	assert.notEqual(a, c);
	assert.match(a, /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	assert.equal(a.split('-')[3][0], '5');
});

t('T5 receipt v2 shape + transitions', () => {
	const key = 'key-t5';
	let r = core.newReceipt(key, SID, 'objective t5', { id: 'goal-x', revision: 1 }, 1000, { acceptanceCriteria: ['a', 'b'] });
	assert.equal(r.schema, 2);
	assert.equal(r.controlState, 'DISPATCHED');
	assert.equal(r.generation, 1);
	assert.equal(r.revision, 1);
	assert.equal(r.correctionsLeft, 3);
	assert.match(r.supervisorGoalId, /^sg-[A-Za-z0-9_-]+$/);
	assert.match(r.runId, /^run-g1-/);
	r = core.recordCorrection(r, { commandId: `${r.supervisorGoalId}:g1:CORRECTION:1`, generation: 1, mode: 'steer', text: 'fix it' }, 2000);
	assert.equal(r.generation, 2);
	assert.equal(r.controlState, 'RUNNING');
	assert.equal(r.corrections, 1);
	assert.equal(r.correctionsLeft, 2);
	assert.match(r.runId, /^run-g2-/);
	r = core.recordCancel(r, { commandId: `${r.supervisorGoalId}:g2:CANCEL:1`, generation: 2, action: 'pause' }, 3000);
	assert.equal(r.controlState, 'CANCELLED');
	assert.equal(r.status, 'cancelled:pause');
	assert.equal(r.history.length, 3);
});

t('T6 correction gate max3', () => {
	let r = core.newReceipt('key-t6', SID, 'objective t6', null, 1000);
	for (let i = 0; i < 3; i++) {
		const g = core.canCorrect(r);
		assert.equal(g.ok, true, `correction ${i + 1} should pass`);
		r = core.recordCorrection(r, { commandId: `k-t6:g${r.generation}:CORRECTION:${i + 1}`, generation: r.generation, mode: 'steer', text: `c${i}` }, 2000 + i);
	}
	assert.equal(r.corrections, 3);
	assert.equal(r.correctionsLeft, 0);
	const g4 = core.canCorrect(r);
	assert.equal(g4.ok, false);
	assert.equal(g4.error, 'corrections_exhausted');
});

t('T7 auth check', () => {
	const tok = 'a'.repeat(64);
	assert.equal(core.checkAuth(`Bearer ${tok}`, tok), true);
	assert.equal(core.checkAuth(`Bearer ${'b'.repeat(64)}`, tok), false);
	assert.equal(core.checkAuth('Bearer short', tok), false);
	assert.equal(core.checkAuth(null, tok), false);
	assert.equal(core.checkAuth(`bearer ${tok}`, tok), false);
});

t('T8 events sanitization strips media + truncates', () => {
	const out = core.sanitizeEvents([{ a: 'x'.repeat(2500), image: 'DATA', screenshot: 'S', nested: { png: 'P' }, ok: 1 }]);
	assert.equal(out[0].image, '[media-stripped]');
	assert.equal(out[0].screenshot, '[media-stripped]');
	assert.equal(out[0].nested.png, '[media-stripped]');
	assert.ok(out[0].a.endsWith('…[truncated]'));
	assert.equal(out[0].ok, 1);
});

t('T9 goal projection pick', () => {
	assert.deepEqual(core.pickGoalProjection({}), { goal: null, phase: null, roundsStarted: null, maxGoalRounds: null, activation: null });
	const p = core.pickGoalProjection({ projections: { values: { goal: { goal: { id: 'g', revision: 1 }, phase: 'active', roundsStarted: 2, maxGoalRounds: 5 } } } });
	assert.equal(p.phase, 'active');
	assert.equal(p.roundsStarted, 2);
});

t('T10 uuid v5 determinism', () => {
	assert.equal(core.uuidV5('same'), core.uuidV5('same'));
	assert.notEqual(core.uuidV5('a'), core.uuidV5('b'));
	assert.match(core.uuidV5('v'), /^[0-9a-f-]{36}$/);
});

t('T11 token generation', () => {
	assert.match(core.generateToken(), /^[0-9a-f]{64}$/);
	assert.notEqual(core.generateToken(), core.generateToken());
});

t('T12 validateSessionQuery', () => {
	assert.equal(core.validateSessionQuery({ sessionId: SID }).ok, true);
	assert.equal(core.validateSessionQuery({ sessionId: 'nope' }).ok, false);
	assert.equal(core.validateSessionQuery({}).ok, false);
});

t('T13 deriveLiveStatus legacy mapping', () => {
	const r = core.newReceipt('key-t13', SID, 'obj', null, 1000);
	assert.equal(core.deriveLiveStatus(r, null).status, 'absent');
	assert.equal(core.deriveLiveStatus(r, { goal: { id: 'g', revision: 1 }, phase: 'active' }).status, 'active');
	assert.equal(core.deriveLiveStatus(r, { goal: { id: 'g', revision: 1 }, phase: 'paused' }).status, 'paused');
	assert.equal(core.deriveLiveStatus(r, { goal: { id: 'g', revision: 1 }, phase: 'complete' }).status, 'complete');
	const rc = core.recordCancel(r, { commandId: 'k-t13:g1:CANCEL:1', generation: 1, action: 'complete' }, 2000);
	assert.equal(core.deriveLiveStatus(rc, { goal: { id: 'g', revision: 1 }, phase: 'active' }).status, 'cancelled:complete');
});

t('T14 serialize/deserialize roundtrip (v2)', () => {
	const r = core.newReceipt('key-t14', SID, 'obj', { id: 'g', revision: 1 }, 1000);
	const map = new Map([[r.key, r]]);
	const text = core.serializeReceipts(map);
	const back = core.deserializeReceipts(text);
	assert.equal(back.get('key-t14').controlState, 'DISPATCHED');
	assert.equal(back.get('key-t14').schema, 2);
	assert.throws(() => core.deserializeReceipts('{"version":9,"receipts":{}}'));
	assert.throws(() => core.deserializeReceipts('not json'));
});

// ---------- R1.1 新契约 ----------

t('T15 dispatch contract: supervisorGoalId/generation/acceptanceCriteria', () => {
	// generation 必须为 1
	assert.equal(core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'goal test ok', generation: 2 }).error, 'invalid_generation');
	assert.equal(core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'goal test ok', generation: 1 }).ok, true);
	// supervisorGoalId 格式
	assert.equal(core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'goal test ok', supervisorGoalId: 'bad id!' }).error, 'invalid_supervisor_goal_id');
	const v = core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'goal test ok', supervisorGoalId: 'sg-my-goal-01' });
	assert.equal(v.ok, true);
	assert.equal(v.value.supervisorGoalId, 'sg-my-goal-01');
	// 缺省派生：确定性（同 key 恒同 id）
	const v1 = core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'goal test ok' });
	const v2 = core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'goal test ok' });
	assert.equal(v1.value.supervisorGoalId, v2.value.supervisorGoalId);
	assert.equal(core.deriveSupervisorGoalId('ok-key-01'), v1.value.supervisorGoalId);
	// acceptanceCriteria 边界
	assert.equal(core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'goal test ok', acceptanceCriteria: 'no' }).error, 'invalid_acceptance_criteria');
	assert.equal(core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'goal test ok', acceptanceCriteria: [] }).error, 'invalid_acceptance_criteria');
	assert.equal(core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'goal test ok', acceptanceCriteria: Array(13).fill('c') }).error, 'invalid_acceptance_criteria');
	const va = core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'goal test ok', acceptanceCriteria: [' tests pass ', ''] });
	assert.equal(va.ok, false); // 空串拒绝
	const vb = core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'goal test ok', acceptanceCriteria: [' tests pass ', 'ci green'] });
	assert.deepEqual(vb.value.acceptanceCriteria, ['tests pass', 'ci green']);
});

t('T16 commandId parsing + generation mismatch', () => {
	const p = core.parseCommandId('sg-goal-01:g3:CORRECTION:2');
	assert.deepEqual(p, { owner: 'sg-goal-01', generation: 3, kind: 'CORRECTION', seq: 2 });
	assert.equal(core.parseCommandId('nope'), null);
	assert.equal(core.parseCommandId('sg-goal-01:g3:REBOOT:2'), null);
	// kind 白名单
	assert.equal(core.validateCommand({ commandId: 'sg-goal-01:g1:CORRECTION:1', generation: 1, sessionId: SID }).ok, true);
	// commandId 内嵌 generation 与请求 generation 不一致 → 拒绝（防身份漂移）
	assert.equal(core.validateCommand({ commandId: 'sg-goal-01:g2:CORRECTION:1', generation: 1, sessionId: SID }).error, 'invalid_command_id_generation_mismatch');
	// 无目标（sessionId/supervisorGoalId 都缺）→ 拒绝
	assert.equal(core.validateCommand({ commandId: 'sg-goal-01:g1:CORRECTION:1', generation: 1 }).error, 'invalid_target');
});

t('T17 correction/cancel/review validation', () => {
	assert.equal(core.validateCorrection({ commandId: 'sg:g1:CORRECTION:1', generation: 1, sessionId: SID, text: 'hi' }).ok, true);
	assert.equal(core.validateCorrection({ commandId: 'sg:g1:CANCEL:1', generation: 1, sessionId: SID, text: 'hi' }).error, 'invalid_command_id');
	assert.equal(core.validateCorrection({ commandId: 'sg:g1:CORRECTION:1', generation: 1, sessionId: SID, text: '  ' }).error, 'invalid_text');
	assert.equal(core.validateCorrection({ commandId: 'sg:g1:CORRECTION:1', generation: 1, sessionId: SID, text: 'hi', mode: 'zap' }).error, 'invalid_mode');
	assert.equal(core.validateCancel({ commandId: 'sg:g1:CANCEL:1', generation: 1, sessionId: SID, action: 'explode' }).error, 'invalid_action');
	assert.equal(core.validateCancel({ commandId: 'sg:g1:CANCEL:1', generation: 1, sessionId: SID, action: 'clear' }).ok, true);
	assert.equal(core.validateReview({ commandId: 'sg:g1:REVIEW:1', generation: 1, sessionId: SID, verdict: 'MAYBE' }).error, 'invalid_verdict');
	assert.equal(core.validateReview({ commandId: 'sg:g1:REVIEW:1', generation: 1, sessionId: SID, verdict: 'PASS', criteriaResults: [{ criterion: 'a', result: 'pass' }] }).ok, true);
	assert.equal(core.validateReview({ commandId: 'sg:g1:REVIEW:1', generation: 1, sessionId: SID, verdict: 'PASS', criteriaResults: [{ criterion: 'a', result: 'maybe' }] }).error, 'invalid_criteria_results');
	assert.equal(core.validateReview({ commandId: 'sg:g1:REVIEW:1', generation: 1, sessionId: SID, verdict: 'PASS', evidenceId: 'ev-xyz' }).ok, true);
});

t('T18 generation gate: stale vs invalid', () => {
	assert.deepEqual(core.gateGeneration(3, 3), { ok: true });
	const stale = core.gateGeneration(3, 1);
	assert.equal(stale.ok, false);
	assert.equal(stale.stale, true);
	assert.equal(stale.error, 'stale_generation');
	const ahead = core.gateGeneration(3, 5);
	assert.equal(ahead.ok, false);
	assert.equal(ahead.stale, undefined);
	assert.equal(ahead.error, 'invalid_generation');
});

t('T19 objective-only dispatch truth: derived start prompt', () => {
	const derived = core.deriveStartPrompt('Build the widget now', null);
	assert.ok(derived.includes('Build the widget now'));
	assert.equal(core.deriveStartPrompt('Build the widget now', undefined), derived); // 确定性
	const provided = core.deriveStartPrompt('Build the widget now', '  custom kick  ');
	assert.equal(provided, 'custom kick');
});

t('T20 planDispatchSteps: always includes start prompt + resume slicing', () => {
	const value = core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'goal test ok' }).value;
	const steps = core.planDispatchSteps(value, SID, 0);
	assert.deepEqual(steps.map((s) => s.method), ['session.create', 'goal.create', 'session.prompt']); // R1.1: prompt 恒在
	assert.ok(steps[2].payload.content[0].text.includes('goal test ok'));
	assert.equal(steps[2].payload.mode, 'queue'); // R1.1: schema 权威仅 queue|steer（sessions.schema.js L228），'now' 会被 zod 拒绝
	// objective-only 与 provided 的区别只在 prompt 文本
	const value2 = core.validateDispatch({ idempotencyKey: 'ok-key-02', objective: 'goal test ok', initialInstruction: 'KICK' }).value;
	const steps2 = core.planDispatchSteps(value2, SID, 0);
	assert.equal(steps2[2].payload.content[0].text, 'KICK');
	// 断点续传：appliedSteps=2 → 只剩 prompt
	const resume = core.planDispatchSteps(value, SID, 2);
	assert.deepEqual(resume.map((s) => s.method), ['session.prompt']);
	assert.deepEqual(core.planDispatchSteps(value, SID, 3), []);
});

t('T21 ledger classification: ABSENT/OK/CORRUPT/AMBIGUOUS + v1 migration', () => {
	// ABSENT
	assert.equal(core.classifyLedger(null, null).state, 'ABSENT');
	// OK v2
	const r = core.newReceipt('key-t21', SID, 'obj', null, 1000);
	const v2text = core.serializeReceipts(new Map([[r.key, r]]));
	const ok = core.classifyLedger(v2text, null);
	assert.equal(ok.state, 'OK');
	assert.equal(ok.receipts.get('key-t21').controlState, 'DISPATCHED');
	// OK v1 → 自动迁移
	const v1text = JSON.stringify({ version: 1, savedAt: 'x', receipts: { 'old-key': { key: 'old-key', sessionId: SID, objective: 'old', goalRef: null, createdAt: 1, corrections: 1, correctionsLeft: 2, status: 'dispatched', history: [] } } });
	const okV1 = core.classifyLedger(v1text, null);
	assert.equal(okV1.state, 'OK');
	const migrated = okV1.receipts.get('old-key');
	assert.equal(migrated.schema, 2);
	assert.equal(migrated.controlState, 'DISPATCHED');
	assert.equal(migrated.corrections, 1);
	assert.match(migrated.supervisorGoalId, /^sg-/);
	// v1 cancelled → CANCELLED
	const v1c = JSON.stringify({ version: 1, savedAt: 'x', receipts: { 'old-k2': { key: 'old-k2', sessionId: SID, objective: 'o', createdAt: 1, corrections: 0, correctionsLeft: 3, status: 'cancelled:pause', history: [] } } });
	assert.equal(core.classifyLedger(v1c, null).receipts.get('old-k2').controlState, 'CANCELLED');
	// CORRUPT（曾存在但损坏；tmp 不存在或也坏）
	assert.equal(core.classifyLedger('{broken', null).state, 'CORRUPT');
	assert.equal(core.classifyLedger('{broken', '{also broken').state, 'CORRUPT');
	assert.equal(core.classifyLedger('{"version":1,"receipts":{"x":{"key":"x","sessionId":"BAD"}}}', null).state, 'CORRUPT');
	// AMBIGUOUS：主坏 + tmp 可解析 → 不得猜
	const okTmp = core.classifyLedger('{broken', v2text);
	assert.equal(okTmp.state, 'AMBIGUOUS');
	assert.equal(okTmp.receipts, null);
});

t('T22 migration determinism', () => {
	const v1 = { key: 'mig-key', sessionId: SID, objective: 'o', goalRef: { id: 'g', revision: 1 }, createdAt: 42, corrections: 2, correctionsLeft: 1, status: 'dispatched', history: [{ at: 42, event: 'dispatched' }] };
	const a = core.migrateReceiptV1(v1);
	const b = core.migrateReceiptV1(v1);
	assert.deepEqual(a, b);
	assert.equal(a.createdAt, 42);
	assert.equal(a.supervisorGoalId, core.deriveSupervisorGoalId('mig-key'));
	assert.equal(a.runId, core.deriveRunId('mig-key', 1));
});

t('T23 lifecycle reducer: complete path + hard gates', () => {
	// 全链：CREATED→DISPATCHED→RUNNING→AWAITING_REVIEW→VERIFIED
	let s = 'CREATED';
	s = core.controlReducer(s, 'dispatch');
	assert.equal(s, 'DISPATCHED');
	s = core.controlReducer(s, 'prompt_running');
	assert.equal(s, 'RUNNING');
	s = core.controlReducer(s, 'harness_complete');
	assert.equal(s, 'AWAITING_REVIEW'); // Harness COMPLETE != VERIFIED（硬 Gate）
	s = core.controlReducer(s, 'review_pass');
	assert.equal(s, 'VERIFIED');
	assert.equal(core.controlReducer('VERIFIED', 'cancel'), 'VERIFIED'); // 终态冻结
	// corrective loop：review FAIL → CORRECTING → correction → RUNNING
	let s2 = 'AWAITING_REVIEW';
	s2 = core.controlReducer(s2, 'review_fail', { correctionsLeft: 2 });
	assert.equal(s2, 'CORRECTING');
	s2 = core.controlReducer(s2, 'correction_accepted');
	assert.equal(s2, 'RUNNING');
	// FAIL + 预算尽 → BLOCKED
	assert.equal(core.controlReducer('AWAITING_REVIEW', 'review_fail', { correctionsLeft: 0 }), 'BLOCKED');
	// exhausted → BLOCKED；cancel → CANCELLED
	assert.equal(core.controlReducer('RUNNING', 'corrections_exhausted'), 'BLOCKED');
	assert.equal(core.controlReducer('CORRECTING', 'cancel'), 'CANCELLED');
	// 任何路径都不会把 harness complete 直接变 VERIFIED
	for (const st of ['CREATED', 'DISPATCHED', 'RUNNING', 'CORRECTING']) {
		assert.notEqual(core.controlReducer(st, 'harness_complete'), 'VERIFIED');
	}
	assert.throws(() => core.controlReducer('RUNNING', 'no_such_event'));
});

t('T24 deriveControlState: official projection wins', () => {
	const r = core.newReceipt('key-t24', SID, 'obj', null, 1000);
	// goal complete → AWAITING_REVIEW（非 VERIFIED）
	const d1 = core.deriveControlState(r, { goal: { id: 'g', revision: 1 }, phase: 'complete' });
	assert.equal(d1.controlState, 'AWAITING_REVIEW');
	assert.equal(d1.completionReason, 'harness_goal_complete');
	assert.equal(d1.changed, true);
	// pendingMutation 存在 → 不做投影推导（保持 pending 态）
	const pend = core.markPending(r, 'CORRECTION', 'k:g1:CORRECTION:1', 2000);
	const d2 = core.deriveControlState(pend, { goal: { id: 'g', revision: 1 }, phase: 'complete' });
	assert.equal(d2.controlState, pend.controlState);
	assert.equal(d2.changed, false);
	// cancelled 终态不变
	const rc = core.recordCancel(r, { commandId: 'k-t24:g1:CANCEL:1', generation: 1, action: 'pause' }, 3000);
	const d3 = core.deriveControlState(rc, { goal: { id: 'g', revision: 1 }, phase: 'active' });
	assert.equal(d3.controlState, 'CANCELLED');
	assert.equal(d3.changed, false);
	// active → RUNNING
	const d4 = core.deriveControlState(r, { goal: { id: 'g', revision: 1 }, phase: 'active' });
	assert.equal(d4.controlState, 'RUNNING');
});

t('T25 executedCommands ledger (replay依据)', () => {
	let r = core.newReceipt('key-t25', SID, 'obj', null, 1000);
	const c1 = 'sg-t25:g1:CORRECTION:1';
	r = core.recordCorrection(r, { commandId: c1, generation: 1, mode: 'steer', text: 'do x' }, 2000);
	assert.equal(core.lookupExecuted(r, c1).kind, 'CORRECTION');
	assert.equal(core.lookupExecuted(r, 'sg-t25:g1:CORRECTION:9'), null);
	assert.equal(r.correctionLog.length, 1);
	assert.equal(r.correctionLog[0].commandId, c1);
	const c2 = 'sg-t25:g2:CANCEL:1';
	r = core.recordCancel(r, { commandId: c2, generation: 2, action: 'clear' }, 3000);
	assert.equal(core.lookupExecuted(r, c2).kind, 'CANCEL');
	assert.equal(r.cancelLog.length, 1);
	// review 记录
	let r2 = core.newReceipt('key-t25b', SID, 'obj', null, 1000);
	r2 = { ...r2, controlState: 'AWAITING_REVIEW' };
	const rv = 'sg-t25b:g1:REVIEW:1';
	r2 = core.recordReview(r2, { commandId: rv, generation: 1, verdict: 'PASS', criteriaResults: [{ criterion: 'tests', result: 'pass' }], evidenceId: 'ev-x' }, 4000);
	assert.equal(core.lookupExecuted(r2, rv).kind, 'REVIEW');
	assert.equal(r2.controlState, 'VERIFIED');
	assert.equal(r2.latestAcceptance.results[0].result, 'pass');
	assert.equal(r2.latestEvidenceId, 'ev-x');
});

t('T26 pendingMutation / ambiguous fail-closed', () => {
	let r = core.newReceipt('key-t26', SID, 'obj', null, 1000);
	r = core.markPending(r, 'DISPATCH', 'DISPATCH:key-t26', 2000, 0);
	assert.equal(r.pendingMutation.kind, 'DISPATCH');
	assert.equal(r.pendingMutation.appliedSteps, 0);
	r = core.markAppliedStep(r, 1, 3000);
	assert.equal(r.pendingMutation.appliedSteps, 1);
	// 歧义标记：commandId 进入 executedCommands（AMBIGUOUS），重放必 fail-closed
	r = core.markAmbiguous(r, 'DISPATCH:key-t26', 4000, 'rpc_timeout');
	assert.equal(core.lookupExecuted(r, 'DISPATCH:key-t26').kind, 'AMBIGUOUS');
	assert.equal(r.pendingMutation, null);
	assert.equal(r.nextExpectedAction, 'reconcile');
	// correction pending → markAmbiguous
	let r2 = core.markPending(core.newReceipt('key-t26b', SID, 'obj', null, 1000), 'CORRECTION', 'k:g1:CORRECTION:1', 2000, 0);
	r2 = core.markAmbiguous(r2, 'k:g1:CORRECTION:1', 3000);
	assert.equal(core.lookupExecuted(r2, 'k:g1:CORRECTION:1').kind, 'AMBIGUOUS');
});

t('T27 acceptance matrix totals', () => {
	const totals = core.computeAcceptanceTotals(['a', 'b', 'c'], [{ criterion: 'a', result: 'pass' }, { criterion: 'b', result: 'fail' }]);
	assert.equal(totals.total, 3);
	assert.equal(totals.pass, 1);
	assert.equal(totals.fail, 1);
	assert.equal(totals.unknown, 1); // 未 review 的项 = unknown，绝不自动 PASS
	const empty = core.computeAcceptanceTotals(null, null);
	assert.equal(empty.total, 0);
	assert.equal(empty.unknown, 0);
});

t('T28 evidence bundle: 结构化 + 不编造', () => {
	const r = core.newReceipt('key-t28', SID, 'obj t28', { id: 'h-goal', revision: 1 }, 1000, { acceptanceCriteria: ['c1'] });
	const b = core.buildEvidenceBundle(r, { goal: { id: 'h-goal', revision: 1 }, phase: 'complete' }, { events: [{ e: 1 }], running: false, harnessPort: 3080 });
	// 必备 section
	for (const k of ['evidenceId', 'labels', 'identity', 'execution', 'source', 'verification', 'acceptance', 'continuity', 'leftovers', 'events']) {
		assert.ok(k in b, `missing section ${k}`);
	}
	assert.equal(b.identity.harnessGoalId, 'h-goal');
	assert.equal(b.execution.controlState, 'AWAITING_REVIEW'); // complete → 非 VERIFIED
	assert.equal(b.execution.completionReason, 'harness_goal_complete');
	// §16 不编造：无 Git/CI/test authority → N/A / NOT_RUN
	assert.equal(b.source.headCommit, null);
	assert.equal(b.labels.source, 'N/A');
	assert.equal(b.verification.tests.status, 'NOT_RUN');
	assert.equal(b.verification.ci.status, 'NOT_RUN');
	// 未 review → acceptance unknown
	assert.equal(b.acceptance.total, 1);
	assert.equal(b.acceptance.unknown, 1);
	assert.equal(b.continuity.recoveryState, 'OK');
	assert.equal(b.events.length, 1);
	// pendingMutation 可见
	const pend = core.markPending(r, 'CORRECTION', 'k:g1:CORRECTION:1', 2000, 0);
	const b2 = core.buildEvidenceBundle(pend, { goal: { id: 'g', revision: 1 }, phase: 'active' }, {});
	assert.equal(b2.continuity.recoveryState, 'PENDING_MUTATION');
	assert.equal(b2.continuity.pendingMutation.commandId, 'k:g1:CORRECTION:1');
	// adopted → orphanState
	const adopted = core.newReceipt('adopted:abc', SID, 'o', null, 1000, { adopted: true });
	assert.equal(core.buildEvidenceBundle(adopted, null, {}).continuity.orphanState, 'ADOPTED_WITHOUT_DISPATCH');
});

t('T29 snapshot row: resumable fields', () => {
	const r = core.newReceipt('key-t29', SID, 'obj', { id: 'h', revision: 2 }, 1000);
	const live = core.deriveLiveStatus(r, { goal: { id: 'h', revision: 2 }, phase: 'active' });
	const row = core.buildSnapshotRow(r, live);
	for (const k of ['supervisorGoalId', 'harnessGoalId', 'harnessSessionId', 'runId', 'generation', 'revision', 'currentControlState', 'latestEvidenceId', 'latestReviewVerdict', 'nextExpectedAction', 'correctionsUsed', 'correctionsLeft']) {
		assert.ok(k in row, `missing snapshot field ${k}`);
	}
	assert.equal(row.harnessSessionId, SID);
	assert.equal(row.harnessGoalId, 'h');
	assert.equal(row.currentControlState, 'RUNNING');
});

t('T30 stable derived identities (no Date.now in identity)', () => {
	assert.equal(core.deriveEvidenceId('sg-x', 2, 5), 'ev-sg-x-g2-r5');
	assert.equal(core.deriveRunId('k', 3), core.deriveRunId('k', 3));
	assert.notEqual(core.deriveRunId('k', 3), core.deriveRunId('k', 4));
	assert.equal(core.deriveSupervisorGoalId('k'), core.deriveSupervisorGoalId('k'));
});

// 汇总
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
	for (const f of failures) console.log(`  FAIL ${f.name}: ${f.err}`);
	process.exit(1);
}
