// test-supervisor-mutation-state.mjs —— P2.75 R1.1 mutation 状态机受控套件（L2，无真实服务器）
//
// 合同（External Review Round 2 §26）：dispatch/correction/cancel 全幂等（重复请求真实
// 副作用计数=1）、stale-generation guard、账本损坏 fail-closed、objective-only dispatch
// 可执行、同一 Harness Goal continuity、Bridge restart 后 replay 不产生第二副作用、
// rpc 歧义 fail-closed（不盲重放）、断点续传（已执行步骤不重复）。
// 实现：真实 core 模块 + fake host（副作用计数 = 宿主 RPC 调用次数，provider 无关）。
// 运行：node tests/supervisor/test-supervisor-mutation-state.mjs

import assert from 'node:assert/strict';
import * as core from '../../plugins/supervisor-bridge-core.mjs';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
	Promise.resolve().then(fn).then(
		() => { pass++; console.log(`PASS ${name}`); },
		(e) => { fail++; failures.push({ name, err: String(e?.message ?? e) }); console.log(`FAIL ${name}: ${e?.message ?? e}`); },
	);
}
function httpError(code, message, extra = {}) {
	const e = new Error(message);
	e.code = code;
	Object.assign(e, extra);
	return e;
}

// ---------- fake host（宿主 RPC 替身；调用计数 = 真实副作用计数） ----------
class FakeHost {
	constructor() {
		this.calls = [];
		this.goal = null; // {id, revision} | null
	}
	async rpc(method, payload) {
		this.calls.push({ method, payload, at: Date.now() });
		switch (method) {
			case 'session.create': return { running: true };
			case 'goal.create':
				this.goal = { id: `goal-${this.calls.length}`, revision: 1 };
				return { ref: this.goal };
			case 'session.prompt': return { ok: true };
			case 'session.list': return { items: this.goal ? [{ sessionId: SID, running: true, projections: { values: { goal: { goal: this.goal, phase: 'active' } } } }] : [] };
			case 'session.history': return { events: [], hasMore: false };
			default: return {}; // goal.pause / goal.complete / goal.clear / session.cancel
		}
	}
	count(method) { return this.calls.filter((c) => c.method === method).length; }
}

// ---------- Driver（复刻 bridge 的 mutation 编排；决策一律走 core） ----------
class Driver {
	constructor(host) {
		this.host = host;
		this.receipts = new Map();
		this.ledgerState = 'ABSENT';
	}
	loadFromTexts(mainText, tmpText = null) {
		const cls = core.classifyLedger(mainText, tmpText);
		this.ledgerState = cls.state;
		this.receipts = cls.receipts ?? new Map();
		return this.ledgerState;
	}
	persist() { /* Driver 内存态即持久态；restart 测试用 serializeLedger */ }
	serializeLedger() { return core.serializeReceipts(this.receipts); }
	gate() {
		if (this.ledgerState === 'CORRUPT') throw httpError(503, 'supervisor_state_corrupt');
		if (this.ledgerState === 'AMBIGUOUS') throw httpError(503, 'supervisor_state_ambiguous');
	}
	findByTarget({ sessionId, supervisorGoalId }) {
		for (const r of this.receipts.values()) {
			if (supervisorGoalId && r.supervisorGoalId === supervisorGoalId) return r;
			if (!supervisorGoalId && sessionId && r.sessionId === sessionId) return r;
		}
		return null;
	}
	async dispatch(body) {
		this.gate();
		const v = core.validateDispatch(body);
		if (!v.ok) throw httpError(400, v.error);
		const key = v.value.idempotencyKey;
		const cmdId = `DISPATCH:${key}`;
		const existing = this.receipts.get(key);
		const resumeNeeded = !!existing
			&& existing.pendingMutation?.kind === 'DISPATCH'
			&& existing.pendingMutation?.commandId === cmdId
			&& !existing.executedCommands[cmdId];
		if (existing && !resumeNeeded) {
			if (body.supervisorGoalId && body.supervisorGoalId !== existing.supervisorGoalId) {
				throw httpError(409, 'supervisor_goal_mismatch');
			}
			existing.dupHits.dispatch += 1;
			return { dispatched: false, duplicate: true, generation: existing.generation };
		}
		let sessionId;
		let r;
		let applied;
		let goalRef;
		if (resumeNeeded) {
			r = this.receipts.get(key);
			sessionId = r.sessionId;
			applied = r.pendingMutation.appliedSteps;
			goalRef = r.goalRef;
		} else {
			sessionId = core.deriveSessionId(key);
			r = core.markPending(core.newReceipt(key, sessionId, v.value.objective, null, Date.now(), { supervisorGoalId: v.value.supervisorGoalId, acceptanceCriteria: v.value.acceptanceCriteria }), 'DISPATCH', cmdId, Date.now(), 0);
			this.receipts.set(key, r);
			applied = r.pendingMutation.appliedSteps;
			goalRef = null;
		}
		try {
			const steps = core.planDispatchSteps(v.value, sessionId, applied);
			for (const step of steps) {
				const value = await this.host.rpc(step.method, step.payload);
				applied += 1;
				if (step.method === 'goal.create') goalRef = value?.ref ?? null;
				this.receipts.set(key, core.markAppliedStep(this.receipts.get(key), applied));
			}
		} catch (e) {
			if (e.ambiguous) {
				this.receipts.set(key, core.markAmbiguous(this.receipts.get(key), cmdId, Date.now(), e.message));
				throw httpError(409, 'command_outcome_ambiguous');
			}
			throw e; // definite：保留 pending/appliedSteps 供续传
		}
		const cur = this.receipts.get(key);
		r = { ...cur, goalRef, pendingMutation: null, executedCommands: { ...cur.executedCommands, [cmdId]: { kind: 'DISPATCH', at: Date.now() } }, revision: (cur.revision ?? 1) + 1 };
		this.receipts.set(key, r);
		return { dispatched: true, duplicate: false, resumed: resumeNeeded, sessionId, supervisorGoalId: r.supervisorGoalId, generation: r.generation, goalRef };
	}
	async correction(body) {
		this.gate();
		const v = core.validateCorrection(body);
		if (!v.ok) throw httpError(400, v.error);
		const { sessionId, supervisorGoalId, commandId, generation, text, mode } = v.value;
		let r = this.findByTarget({ sessionId, supervisorGoalId });
		if (!r) throw httpError(404, 'unknown_session');
		const key = r.key;
		const dup = core.lookupExecuted(r, commandId);
		if (dup) {
			if (dup.kind === 'AMBIGUOUS') throw httpError(409, 'command_outcome_ambiguous');
			r.dupHits.correction += 1;
			return { duplicate: true, accepted: false, correctionsUsed: r.corrections, correctionsLeft: r.correctionsLeft, generation: r.generation };
		}
		const isResume = r.pendingMutation?.commandId === commandId && r.pendingMutation?.kind === 'CORRECTION';
		if (!isResume) {
			const g = core.gateGeneration(r.generation, generation);
			if (!g.ok) throw httpError(g.stale ? 409 : 400, g.error);
			if (!core.canCorrect(r).ok) {
				this.receipts.set(key, core.recordExhausted(r));
				throw httpError(409, 'corrections_exhausted');
			}
			this.receipts.set(key, core.markPending(r, 'CORRECTION', commandId, Date.now(), 0));
		}
		try {
			await this.host.rpc('session.prompt', { sessionId, mode, content: [{ type: 'text', text }] });
		} catch (e) {
			if (e.ambiguous) {
				this.receipts.set(key, core.markAmbiguous(this.receipts.get(key), commandId, Date.now(), e.message));
				throw httpError(409, 'command_outcome_ambiguous');
			}
			this.receipts.set(key, { ...this.receipts.get(key), pendingMutation: null });
			throw e;
		}
		this.receipts.set(key, core.recordCorrection(this.receipts.get(key), { commandId, generation, mode, text }, Date.now()));
		const fin = this.receipts.get(key);
		return { duplicate: false, accepted: true, generation: fin.generation, correctionsUsed: fin.corrections, correctionsLeft: fin.correctionsLeft, controlState: fin.controlState, sessionId: fin.sessionId, goalRef: fin.goalRef };
	}
	async cancel(body) {
		this.gate();
		const v = core.validateCancel(body);
		if (!v.ok) throw httpError(400, v.error);
		const { sessionId, supervisorGoalId, commandId, generation, action } = v.value;
		const r = this.findByTarget({ sessionId, supervisorGoalId });
		if (!r) throw httpError(404, 'unknown_session');
		const key = r.key;
		const dup = core.lookupExecuted(r, commandId);
		if (dup) {
			if (dup.kind === 'AMBIGUOUS') throw httpError(409, 'command_outcome_ambiguous');
			r.dupHits.cancel += 1;
			return { duplicate: true, action: dup.action ?? null };
		}
		if (r.controlState === 'CANCELLED') {
			const cur = this.receipts.get(key);
			this.receipts.set(key, { ...cur, executedCommands: { ...cur.executedCommands, [commandId]: { kind: 'CANCEL', at: Date.now(), action: `noop-already-cancelled` } } });
			return { cancelled: false, alreadyCancelled: true, action };
		}
		const g = core.gateGeneration(r.generation, generation);
		if (!g.ok) throw httpError(g.stale ? 409 : 400, g.error);
		this.receipts.set(key, core.markPending(r, 'CANCEL', commandId, Date.now(), 0));
		// 步骤 1：goal.{action}（若 goal 在）
		if (this.host.goal) {
			try {
				await this.host.rpc(`goal.${action}`, { sessionId, ref: this.host.goal });
			} catch (e) {
				if (e.ambiguous) {
					this.receipts.set(key, core.markAmbiguous(this.receipts.get(key), commandId, Date.now(), e.message));
					throw httpError(409, 'command_outcome_ambiguous');
				}
				this.receipts.set(key, { ...this.receipts.get(key), pendingMutation: null });
				throw e;
			}
		}
		await this.host.rpc('session.cancel', { sessionId }).catch(() => {});
		this.receipts.set(key, core.recordCancel(this.receipts.get(key), { commandId, generation, action }, Date.now()));
		return { cancelled: true, action, controlState: this.receipts.get(key).controlState };
	}
	async review(body) {
		this.gate();
		const v = core.validateReview(body);
		if (!v.ok) throw httpError(400, v.error);
		const { sessionId, supervisorGoalId, commandId, generation, verdict, criteriaResults, evidenceId } = v.value;
		const r = this.findByTarget({ sessionId, supervisorGoalId });
		if (!r) throw httpError(404, 'unknown_session');
		const key = r.key;
		const dup = core.lookupExecuted(r, commandId);
		if (dup) { r.dupHits.review += 1; return { duplicate: true, verdict: dup.verdict ?? r.latestReviewVerdict }; }
		const g = core.gateGeneration(r.generation, generation);
		if (!g.ok) throw httpError(g.stale ? 409 : 400, g.error);
		if (r.controlState !== 'AWAITING_REVIEW') throw httpError(409, 'invalid_control_state', { currentControlState: r.controlState });
		this.receipts.set(key, core.recordReview(r, { commandId, generation, verdict, criteriaResults, evidenceId }, Date.now(), r.correctionsLeft));
		const fin = this.receipts.get(key);
		return { reviewed: true, verdict, controlState: fin.controlState, nextExpectedAction: fin.nextExpectedAction };
	}
}

const KEY = 'mtest-key-0001';
const SG = core.deriveSupervisorGoalId(KEY);
const SID = core.deriveSessionId(KEY); // 与 dispatch 派生的 sessionId 一致
const CID = (gen, kind, seq) => `${SG}:g${gen}:${kind}:${seq}`;
const CORR = { commandId: CID(1, 'CORRECTION', 1), generation: 1, sessionId: SID, text: 'fix X', mode: 'steer' };

// ---------- M1 dispatch 幂等：重复派发副作用=1 ----------
t('M1 dispatch duplicate: side effect = 1', async () => {
	const host = new FakeHost();
	const d = new Driver(host);
	await d.dispatch({ idempotencyKey: KEY, objective: 'objective one', initialInstruction: 'KICK' });
	const r2 = await d.dispatch({ idempotencyKey: KEY, objective: 'DIFFERENT ignored' });
	assert.equal(r2.dispatched, false);
	assert.equal(r2.duplicate, true);
	assert.equal(host.count('session.create'), 1);
	assert.equal(host.count('goal.create'), 1);
	assert.equal(host.count('session.prompt'), 1);
});

// ---------- M2 correction 幂等：重放副作用=1（真实 prompt 只发一次） ----------
t('M2 correction duplicate: prompt executed once', async () => {
	const host = new FakeHost();
	const d = new Driver(host);
	await d.dispatch({ idempotencyKey: KEY, objective: 'objective m2', initialInstruction: 'KICK' });
	const r1 = await d.correction(CORR);
	assert.equal(r1.accepted, true);
	assert.equal(r1.generation, 2);
	const r2 = await d.correction(CORR); // 完全相同的 commandId 重放
	assert.equal(r2.duplicate, true);
	assert.equal(r2.accepted, false);
	assert.equal(host.count('session.prompt'), 2); // 1 次启动 kick + 1 次 correction（重放不再发生）
	assert.equal(r2.generation, 2);
	assert.equal(r2.correctionsUsed, 1);
});

// ---------- M3 cancel 幂等：goal.* 只执行一次 ----------
t('M3 cancel duplicate: goal mutation executed once', async () => {
	const host = new FakeHost();
	const d = new Driver(host);
	await d.dispatch({ idempotencyKey: KEY, objective: 'objective m3', initialInstruction: 'KICK' });
	const c1 = { commandId: CID(1, 'CANCEL', 1), generation: 1, sessionId: SID, action: 'pause' };
	const r1 = await d.cancel(c1);
	assert.equal(r1.cancelled, true);
	const r2 = await d.cancel(c1);
	assert.equal(r2.duplicate, true);
	assert.equal(host.count('goal.pause'), 1);
	assert.equal(host.count('session.cancel'), 1);
	const r3 = await d.cancel({ commandId: CID(1, 'CANCEL', 2), generation: 1, sessionId: SID, action: 'clear' });
	assert.equal(r3.alreadyCancelled, true);
	assert.equal(host.count('goal.pause'), 1);
	assert.equal(host.count('goal.clear'), 0);
});

// ---------- M4/M5 stale generation guard：副作用=0 ----------
t('M4 stale generation correction rejected (side effect 0)', async () => {
	const host = new FakeHost();
	const d = new Driver(host);
	await d.dispatch({ idempotencyKey: KEY, objective: 'objective m4', initialInstruction: 'KICK' });
	await d.correction(CORR); // gen 1 → 2
	await assert.rejects(
		() => d.correction({ commandId: CID(1, 'CORRECTION', 9), generation: 1, sessionId: SID, text: 'stale attempt' }),
		(e) => e.code === 409 && e.message === 'stale_generation',
	);
	assert.equal(host.count('session.prompt'), 2); // kick + 第一次 correction；stale 未执行
});

t('M5 stale generation cancel rejected', async () => {
	const host = new FakeHost();
	const d = new Driver(host);
	await d.dispatch({ idempotencyKey: KEY, objective: 'objective m5', initialInstruction: 'KICK' });
	await d.correction(CORR); // gen → 2
	await assert.rejects(
		() => d.cancel({ commandId: CID(1, 'CANCEL', 1), generation: 1, sessionId: SID, action: 'pause' }),
		(e) => e.code === 409 && e.message === 'stale_generation',
	);
	assert.equal(host.count('goal.pause'), 0);
	// 跳代（generation 大于当前）→ 400
	await assert.rejects(
		() => d.cancel({ commandId: CID(9, 'CANCEL', 1), generation: 9, sessionId: SID, action: 'pause' }),
		(e) => e.code === 400 && e.message === 'invalid_generation',
	);
});

// ---------- M6 correction cap=3 + BLOCKED ----------
t('M6 corrections exhausted at 3 → BLOCKED', async () => {
	const host = new FakeHost();
	const d = new Driver(host);
	await d.dispatch({ idempotencyKey: KEY, objective: 'objective m6', initialInstruction: 'KICK' });
	for (let i = 1; i <= 3; i++) {
		const r = await d.correction({ commandId: CID(i, 'CORRECTION', i), generation: i, sessionId: SID, text: `c${i}` });
		assert.equal(r.accepted, true);
	}
	await assert.rejects(
		() => d.correction({ commandId: CID(4, 'CORRECTION', 4), generation: 4, sessionId: SID, text: 'c4' }),
		(e) => e.code === 409 && e.message === 'corrections_exhausted',
	);
	assert.equal(d.receipts.get(KEY).controlState, 'BLOCKED');
	assert.equal(host.count('session.prompt'), 4); // kick + 3 corrections
});

// ---------- M7 账本损坏/歧义 → mutation fail-closed ----------
t('M7 corrupt ledger fail-closed for mutation', async () => {
	const host = new FakeHost();
	const d = new Driver(host);
	assert.equal(d.loadFromTexts('{broken json', null), 'CORRUPT');
	await assert.rejects(() => d.dispatch({ idempotencyKey: KEY, objective: 'objective m7' }), (e) => e.code === 503 && e.message === 'supervisor_state_corrupt');
	await assert.rejects(() => d.correction(CORR), (e) => e.code === 503);
	// 歧义（主坏 + tmp 可解析）同样 fail-closed
	const good = core.serializeReceipts(new Map([[KEY, core.newReceipt(KEY, SID, 'o', null, 1)]]));
	assert.equal(d.loadFromTexts('{broken', good), 'AMBIGUOUS');
	await assert.rejects(() => d.dispatch({ idempotencyKey: KEY, objective: 'objective m7' }), (e) => e.code === 503 && e.message === 'supervisor_state_ambiguous');
	// 合法空态（ABSENT）不阻塞首派发
	assert.equal(d.loadFromTexts(null, null), 'ABSENT');
	const r = await d.dispatch({ idempotencyKey: KEY, objective: 'objective m7', initialInstruction: 'KICK' });
	assert.equal(r.dispatched, true);
});

// ---------- M8 objective-only dispatch 真实启动（3 步 RPC 全发生） ----------
t('M8 objective-only dispatch executes start prompt', async () => {
	const host = new FakeHost();
	const d = new Driver(host);
	const r = await d.dispatch({ idempotencyKey: KEY, objective: 'objective only m8' });
	assert.equal(r.dispatched, true);
	assert.deepEqual(
		host.calls.map((c) => c.method),
		['session.create', 'goal.create', 'session.prompt'],
	);
	const prompt = host.calls[2].payload.content[0].text;
	assert.ok(prompt.includes('objective only m8'));
	// mode 必须是宿主 schema 权威值 'queue'（sessions.schema.js: union literal queue|steer；
	// 'now' 不存在，zod 会拒 → R1.1 曾回归为 'now' 被 REAL E2E 捕获）
	assert.equal(host.calls[2].payload.mode, 'queue');
});

// ---------- M9 生命周期：完整协议（非文档） ----------
t('M9 lifecycle protocol: complete → AWAITING_REVIEW → review VERIFIED', async () => {
	const host = new FakeHost();
	const d = new Driver(host);
	await d.dispatch({ idempotencyKey: KEY, objective: 'objective m9', initialInstruction: 'KICK', acceptanceCriteria: ['tests green'] });
	// review 在非 AWAITING_REVIEW 状态被拒（409 invalid_control_state）
	await assert.rejects(() => d.review({ commandId: CID(1, 'REVIEW', 1), generation: 1, sessionId: SID, verdict: 'PASS' }), (e) => e.code === 409 && e.message === 'invalid_control_state');
	// 模拟 harness complete（Official projection 完成态）
	const r = d.receipts.get(KEY);
	const d1 = core.deriveControlState(r, { goal: r.goalRef, phase: 'complete' });
	assert.equal(d1.controlState, 'AWAITING_REVIEW');
	d.receipts.set(KEY, { ...r, controlState: d1.controlState });
	// PASS → VERIFIED（唯一路径）
	const rv = await d.review({ commandId: CID(1, 'REVIEW', 1), generation: 1, sessionId: SID, verdict: 'PASS', criteriaResults: [{ criterion: 'tests green', result: 'pass' }] });
	assert.equal(rv.verdict, 'PASS');
	assert.equal(rv.controlState, 'VERIFIED');
	assert.equal(d.receipts.get(KEY).latestAcceptance.results[0].result, 'pass');
	// review 重放幂等
	const rv2 = await d.review({ commandId: CID(1, 'REVIEW', 1), generation: 1, sessionId: SID, verdict: 'FAIL' });
	assert.equal(rv2.duplicate, true);
	assert.equal(d.receipts.get(KEY).controlState, 'VERIFIED'); // 不被重放改写
});

t('M9b review FAIL → CORRECTING → correction 回 RUNNING（同一 Goal continuity）', async () => {
	const host = new FakeHost();
	const d = new Driver(host);
	const disp = await d.dispatch({ idempotencyKey: KEY, objective: 'objective m9b', initialInstruction: 'KICK' });
	const r0 = d.receipts.get(KEY);
	d.receipts.set(KEY, { ...r0, controlState: 'AWAITING_REVIEW' });
	const rv = await d.review({ commandId: CID(1, 'REVIEW', 1), generation: 1, sessionId: SID, verdict: 'FAIL', criteriaResults: [{ criterion: 'x', result: 'fail' }] });
	assert.equal(rv.controlState, 'CORRECTING');
	assert.equal(rv.nextExpectedAction, 'send_correction');
	const c = await d.correction(CORR);
	assert.equal(c.accepted, true);
	assert.equal(c.generation, 2);
	assert.equal(c.controlState, 'RUNNING');
	// continuity：同 sessionId、同 harness goal
	assert.equal(c.sessionId, disp.sessionId);
	assert.deepEqual(c.goalRef, r0.goalRef);
	assert.equal(core.deriveSupervisorGoalId(KEY), r0.supervisorGoalId);
});

// ---------- M10 Bridge restart：persisted receipts 重载后 replay 无第二副作用 ----------
t('M10 restart replay: no second side effects after reload', async () => {
	const host1 = new FakeHost();
	const d1 = new Driver(host1);
	await d1.dispatch({ idempotencyKey: KEY, objective: 'objective m10', initialInstruction: 'KICK' });
	await d1.correction(CORR);
	const cancelCmd = { commandId: CID(2, 'CANCEL', 1), generation: 2, sessionId: SID, action: 'pause' };
	await d1.cancel(cancelCmd);
	const text = d1.serializeLedger();
	// —— restart：新 Driver 从持久文本重载（真实 classify/deserialize 路径）——
	const host2 = new FakeHost();
	const d2 = new Driver(host2);
	assert.equal(d2.loadFromTexts(text, null), 'OK');
	const r1 = await d2.dispatch({ idempotencyKey: KEY, objective: 'DIFFERENT ignored' });
	assert.equal(r1.dispatched, false);
	const r2 = await d2.correction(CORR);
	assert.equal(r2.duplicate, true);
	const r3 = await d2.cancel(cancelCmd);
	assert.equal(r3.duplicate, true);
	assert.equal(host2.calls.length, 0); // 重放零副作用
	// v1 账本也能被 restart 重载（迁移路径）
	const v1text = JSON.stringify({ version: 1, savedAt: 'x', receipts: { [KEY]: { key: KEY, sessionId: SID, objective: 'o', goalRef: null, createdAt: 1, corrections: 1, correctionsLeft: 2, status: 'dispatched', history: [] } } });
	const d3 = new Driver(new FakeHost());
	assert.equal(d3.loadFromTexts(v1text, null), 'OK');
	assert.equal(d3.receipts.get(KEY).controlState, 'DISPATCHED');
});

// ---------- M11 rpc 歧义 fail-closed / definite 可重试 ----------
t('M11 ambiguous rpc fail-closed; definite failure retryable once-applied', async () => {
	const host = new FakeHost();
	const d = new Driver(host);
	await d.dispatch({ idempotencyKey: KEY, objective: 'objective m11', initialInstruction: 'KICK' });
	// 歧义：correction 响应丢失 → commandId 标记 AMBIGUOUS
	host.rpc = async (method, payload) => {
		if (method === 'session.prompt') { const e = new Error('rpc_timeout'); e.ambiguous = true; throw e; }
		return FakeHost.prototype.rpc.call(host, method, payload);
	};
	await assert.rejects(() => d.correction(CORR), (e) => e.code === 409 && e.message === 'command_outcome_ambiguous');
	// 重放同一 commandId → 仍 fail-closed（不猜测、不二次执行）
	await assert.rejects(() => d.correction(CORR), (e) => e.code === 409 && e.message === 'command_outcome_ambiguous');
	// definite：宿主明确拒绝 → 回滚 pending，同 commandId 可安全重试（独立 host，避免包装泄漏）
	const host2 = new FakeHost();
	const d2 = new Driver(host2);
	await d2.dispatch({ idempotencyKey: 'mtest-key-0002', objective: 'objective m11b', initialInstruction: 'KICK' });
	const CORR2 = { commandId: CID(1, 'CORRECTION', 1).replace(SG, core.deriveSupervisorGoalId('mtest-key-0002')), generation: 1, sessionId: core.deriveSessionId('mtest-key-0002'), text: 'fix Y' };
	let failedOnce = false;
	host2.rpc = async (method, payload) => {
		if (method === 'session.prompt' && !failedOnce && payload.sessionId === CORR2.sessionId) {
			failedOnce = true;
			const e = new Error('goal_paused');
			e.definite = true; e.upstream = true;
			throw e;
		}
		return FakeHost.prototype.rpc.call(host2, method, payload);
	};
	await assert.rejects(() => d2.correction(CORR2), (e) => e.upstream === true);
	assert.equal(host2.count('session.prompt'), 1); // kick 已发生；definite 失败未产生副作用
	const ok = await d2.correction(CORR2); // 同 commandId 重试成功（副作用恰 1 次）
	assert.equal(ok.accepted, true);
	assert.equal(ok.generation, 2);
	assert.equal(host2.count('session.prompt'), 2); // kick + 恰一次成功的 correction
});

// ---------- M12 dispatch 断点续传：session.create/goal.create 不重复 ----------
t('M12 dispatch resume: applied steps not repeated', async () => {
	const host = new FakeHost();
	const d = new Driver(host);
	// 注入：goal.create 成功后 connection 死亡（definite transport 失败？→ 不，goal.create 成功、prompt 阶段 definite 失败）
	const origRpc = host.rpc.bind(host);
	let killed = false;
	host.rpc = async (method, payload) => {
		if (method === 'session.prompt' && !killed) {
			killed = true;
			const e = new Error('conn_reset');
			e.definite = true; e.upstream = true;
			throw e;
		}
		return origRpc(method, payload);
	};
	await assert.rejects(() => d.dispatch({ idempotencyKey: KEY, objective: 'objective m12', initialInstruction: 'KICK' }), (e) => e.upstream === true);
	const r = d.receipts.get(KEY);
	assert.equal(r.pendingMutation.appliedSteps, 2); // session.create + goal.create 已持久化
	assert.equal(host.count('session.create'), 1);
	// 恢复后重试（相同 dispatch 输入）→ 从 step 2 继续，不重建 session/goal
	await assert.doesNotReject(() => d.dispatch({ idempotencyKey: KEY, objective: 'objective m12', initialInstruction: 'KICK' }));
	assert.equal(host.count('session.create'), 1);
	assert.equal(host.count('goal.create'), 1);
	assert.equal(host.count('session.prompt'), 1);
	assert.equal(d.receipts.get(KEY).pendingMutation, null);
});

// ---------- M13 dispatch 重放身份冲突 ----------
t('M13 dispatch replay with different supervisorGoalId → mismatch', async () => {
	const host = new FakeHost();
	const d = new Driver(host);
	await d.dispatch({ idempotencyKey: KEY, objective: 'objective m13', supervisorGoalId: 'sg-explicit-01' });
	await assert.rejects(
		() => d.dispatch({ idempotencyKey: KEY, objective: 'objective m13', supervisorGoalId: 'sg-other-02' }),
		(e) => e.code === 409 && e.message === 'supervisor_goal_mismatch',
	);
});

// ---------- M14 correction adopt 不适用（无 receipt → 404；adopt 属 bridge 行为，L3 覆盖） ----------
t('M14 unknown session correction → 404', async () => {
	const host = new FakeHost();
	const d = new Driver(host);
	await assert.rejects(() => d.correction(CORR), (e) => e.code === 404 && e.message === 'unknown_session');
});

// 汇总（异步用例全部入队后统一判定）
setTimeout(() => {
	console.log(`\n${pass} passed, ${fail} failed`);
	if (fail > 0) {
		for (const f of failures) console.log(`  FAIL ${f.name}: ${f.err}`);
		process.exit(1);
	}
}, 50);
