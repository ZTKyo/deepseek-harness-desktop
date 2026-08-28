// supervisor-bridge-test.mjs —— P2.75 受控测试矩阵（T1–T14，纯核心，无服务器）
// 运行：node plugins/supervisor-bridge-test.mjs
// 对应：docs/roadmap/reports/PHASE_02_75_SUPERVISOR/DESIGN_R1.md §7

import assert from 'node:assert/strict';
import * as core from './supervisor-bridge-core.mjs';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
	try { fn(); pass++; console.log(`PASS ${name}`); }
	catch (e) { fail++; failures.push({ name, err: String(e?.message ?? e) }); console.log(`FAIL ${name}: ${e?.message ?? e}`); }
}

// T1 idempotencyKey 校验
t('T1 key validation', () => {
	assert.equal(core.validateDispatch({ idempotencyKey: 'short', objective: 'goal test ok' }).ok, false);
	assert.equal(core.validateDispatch({ idempotencyKey: 'has space!!', objective: 'goal test ok' }).ok, false);
	assert.equal(core.validateDispatch({ idempotencyKey: 'a'.repeat(129), objective: 'goal test ok' }).ok, false);
	assert.equal(core.validateDispatch({ idempotencyKey: 'ok-key_01', objective: 'goal test ok' }).ok, true);
	assert.equal(core.validateDispatch({ idempotencyKey: 'k'.repeat(128), objective: 'goal test ok' }).ok, true);
	assert.equal(core.validateDispatch({ objective: 'goal test ok' }).ok, false);
});

// T2 objective 校验
t('T2 objective validation', () => {
	assert.equal(core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'ab' }).ok, false);
	assert.equal(core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: '' }).ok, false);
	assert.equal(core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'x'.repeat(8001) }).ok, false);
	const v = core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: '  do the thing  ' });
	assert.equal(v.ok, true);
	assert.equal(v.value.objective, 'do the thing');
});

// T3 maxGoalRounds 边界
t('T3 maxGoalRounds bounds', () => {
	for (const bad of [0, 65, 1.5, 'x']) {
		assert.equal(core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'goal test ok', maxGoalRounds: bad }).ok, false, `should reject ${bad}`);
	}
	const v = core.validateDispatch({ idempotencyKey: 'ok-key-01', objective: 'goal test ok', maxGoalRounds: 64 });
	assert.equal(v.ok, true);
	assert.equal(v.value.maxGoalRounds, 64);
});

// T4 UUIDv5 确定性 + sessionId 前缀
t('T4 deterministic session id', () => {
	const a = core.deriveSessionId('alpha-key-0001');
	const b = core.deriveSessionId('alpha-key-0001');
	const c = core.deriveSessionId('alpha-key-0002');
	assert.equal(a, b);
	assert.notEqual(a, c);
	assert.match(a, /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	// v5 版本位（session-<g1>-<g2>-<g3>-…：split 后 [3] 为版本组）
	assert.equal(a.split('-')[3][0], '5');
});

// T5 receipt 状态迁移
t('T5 receipt transitions', () => {
	let r = core.newReceipt('key-t5', 'session-11111111-2222-3333-4444-555555555555', 'objective t5', { id: 'goal-x', revision: 1 });
	assert.equal(r.status, 'dispatched');
	assert.equal(r.correctionsLeft, 3);
	r = core.recordCorrection(r, 'fix it', 'steer', 1000);
	r = core.recordCancel(r, 'pause', 2000);
	assert.equal(r.corrections, 1);
	assert.equal(r.correctionsLeft, 2);
	assert.equal(r.status, 'cancelled:pause');
	assert.equal(r.history.length, 3);
	assert.ok(r.history[1].text.length <= 200);
});

// T6 纠偏闸门（0..3 通过，第 4 拒绝）
t('T6 correction gate max3', () => {
	let r = core.newReceipt('key-t6', 'session-11111111-2222-3333-4444-555555555555', 'objective t6', null);
	for (let i = 0; i < 3; i++) {
		const g = core.canCorrect(r);
		assert.equal(g.ok, true, `correction ${i + 1} should pass`);
		r = core.recordCorrection(r, `c${i}`, 'steer', i * 10);
	}
	const g4 = core.canCorrect(r);
	assert.equal(g4.ok, false);
	assert.equal(g4.error, 'corrections_exhausted');
	assert.equal(g4.correctionsUsed, 3);
	assert.equal(g4.correctionsLeft, 0);
});

// T7 state 裁剪（无内容/cwd 泄漏）
t('T7 state sanitize minimal', () => {
	const item = {
		sessionId: 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
		name: 'secret session name',
		running: true, blank: false,
		cwd: 'C:\\Users\\x\\top-secret-path',
		updatedAt: 123,
		projections: { values: { goal: { goal: { id: 'goal-1', revision: 2, objective: 'obj' }, phase: 'active', roundsStarted: 3 } } },
		content: 'SHOULD NOT LEAK',
	};
	const s = core.sanitizeStateItem(item);
	assert.equal(s.sessionId, item.sessionId);
	assert.equal(s.hasGoal, true);
	assert.equal(s.goalPhase, 'active');
	assert.equal(s.roundsStarted, 3);
	assert.ok(!('cwd' in s), 'cwd must not leak');
	assert.ok(!('content' in s), 'content must not leak');
	assert.ok(!('projections' in s), 'raw projections must not leak');
	const noGoal = core.sanitizeStateItem({ sessionId: 'x', running: false });
	assert.equal(noGoal.hasGoal, false);
});

// T8 Bearer 常量时间校验
t('T8 auth check', () => {
	const tok = 'a'.repeat(64);
	assert.equal(core.checkAuth(`Bearer ${tok}`, tok), true);
	assert.equal(core.checkAuth(`Bearer ${'b'.repeat(64)}`, tok), false);
	assert.equal(core.checkAuth('Bearer', tok), false);
	assert.equal(core.checkAuth(undefined, tok), false);
	assert.equal(core.checkAuth(`bearer ${tok}`, tok), false);
	assert.equal(core.checkAuth(`Bearer ${tok}x`, tok), false);
	assert.equal(core.checkAuth('Basic abc', tok), false);
	assert.equal(core.checkAuth('Bearer short', 'x'.repeat(64)), false);
});

// T9 receipts 序列化回环 + 损坏拒载
t('T9 receipts roundtrip', () => {
	const m = new Map([['k1', core.newReceipt('k1', 'session-11111111-2222-3333-4444-555555555555', 'obj', null)]]);
	const text = core.serializeReceipts(m);
	const back = core.deserializeReceipts(text);
	assert.equal(back.get('k1').key, 'k1');
	assert.equal(back.get('k1').correctionsLeft, 3);
	assert.throws(() => core.deserializeReceipts('{"version":9,"receipts":{}}'));
	assert.throws(() => core.deserializeReceipts('not json'));
});

// T10 dispatch 步骤计划（create→goal→prompt 顺序与参数）
t('T10 plan dispatch steps', () => {
	const v = core.validateDispatch({
		idempotencyKey: 'plan-key-001', objective: '  build the bridge  ',
		maxGoalRounds: 5, initialInstruction: 'start now',
	});
	const sid = core.deriveSessionId(v.value.idempotencyKey);
	const steps = core.planDispatchSteps(v.value, sid, null);
	assert.deepEqual(steps.map((s) => s.method), ['session.create', 'goal.create', 'session.prompt']);
	assert.deepEqual(steps[0].payload, { sessionId: sid });
	assert.equal(steps[1].payload.objective, 'build the bridge');
	assert.equal(steps[1].payload.maxGoalRounds, 5);
	assert.equal(steps[1].payload.sessionId, sid);
	assert.equal(steps[2].payload.mode, 'now');
	assert.equal(steps[2].payload.content[0].type, 'text');
	// 无 initialInstruction → 只有两步
	const v2 = core.validateDispatch({ idempotencyKey: 'plan-key-002', objective: 'second objective' });
	const steps2 = core.planDispatchSteps(v2.value, sid, null);
	assert.equal(steps2.length, 2);
	// 幂等命中 → 零步
	assert.deepEqual(core.planDispatchSteps(v.value, sid, { key: 'plan-key-001' }), []);
});

// T11 cancel action 白名单
t('T11 cancel whitelist', () => {
	const sid = 'session-11111111-2222-3333-4444-555555555555';
	for (const a of ['pause', 'complete', 'clear']) {
		const v = core.validateCancel({ sessionId: sid, action: a });
		assert.equal(v.ok, true, a);
	}
	assert.equal(core.validateCancel({ sessionId: sid, action: 'delete' }).ok, false);
	assert.equal(core.validateCancel({ sessionId: sid, action: 'shell' }).ok, false);
	const d = core.validateCancel({ sessionId: sid });
	assert.equal(d.ok, true);
	assert.equal(d.value.action, 'pause');
	assert.equal(core.validateCancel({ sessionId: 'garbage' }).ok, false);
});

// T12 evidence 裁剪
t('T12 evidence sanitize', () => {
	const events = [{
		type: 'tool_result',
		imageBase64: 'AAAA',
		screenshot: 'data-url',
		text: 'y'.repeat(3000),
		nested: { audioBase64: 'zz', keep: 'yes', deep: { imageDataUrl: 'q' } },
	}];
	const out = core.sanitizeEvents(events)[0];
	assert.equal(out.imageBase64, '[media-stripped]');
	assert.equal(out.screenshot, '[media-stripped]');
	assert.ok(out.text.length === 2012 && out.text.endsWith('…[truncated]')); // 2000 + 12
	assert.equal(out.nested.audioBase64, '[media-stripped]');
	assert.equal(out.nested.keep, 'yes');
	assert.equal(out.nested.deep.imageDataUrl, '[media-stripped]');
});

// T13 correctionsLeft 计算
t('T13 correctionsLeft math', () => {
	let r = core.newReceipt('key-t13', 'session-11111111-2222-3333-4444-555555555555', 'obj', null);
	for (let i = 0; i < 5; i++) r = core.recordCorrection(r, 'c', 'steer', i);
	assert.equal(r.corrections, 5);
	assert.equal(r.correctionsLeft, 0);
});

// T14 rebind：运行态读时推导
t('T14 rebind derive status', () => {
	const r = core.newReceipt('key-t14', 'session-11111111-2222-3333-4444-555555555555', 'obj', null);
	assert.equal(core.deriveLiveStatus(r, null).status, 'absent');
	assert.equal(core.deriveLiveStatus(r, { goal: { id: 'g', revision: 1 }, phase: 'active' }).status, 'active');
	assert.equal(core.deriveLiveStatus(r, { goal: { id: 'g', revision: 1 }, phase: 'paused' }).status, 'paused');
	assert.equal(core.deriveLiveStatus(r, { goal: { id: 'g', revision: 1 }, phase: 'complete' }).status, 'complete');
	assert.equal(core.deriveLiveStatus(r, { goal: { id: 'g', revision: 1 } }).status, 'active');
	const rc = core.recordCancel(r, 'complete', 1);
	assert.equal(core.deriveLiveStatus(rc, { goal: { id: 'g', revision: 1 }, phase: 'active' }).status, 'cancelled:complete');
});

// 汇总
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
	for (const f of failures) console.log(`  FAIL ${f.name}: ${f.err}`);
	process.exit(1);
}
