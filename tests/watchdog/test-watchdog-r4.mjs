// test-watchdog-r4.mjs — Phase 02.8 R4 multi-task projection（tasks[]）纯函数测试
// 运行：node tests/watchdog/test-watchdog-r4.mjs
// 覆盖：§4 fields / §5 per-task state（含 WAITING_USER、per-task stall）/ §6 排序 /
//       §7 完成时间冻结（firstObservedTerminalAt，一经冻结不漂移）/ §8 lastProgressAt。

import assert from 'node:assert/strict';
import * as core from '../../plugins/watchdog-core.mjs';

let pass = 0;
const fails = [];
function step(name, fn) {
	try { fn(); pass += 1; console.log(`PASS ${name}`); }
	catch (e) { fails.push({ name, e }); console.error(`FAIL ${name}: ${e?.message}`); }
}

const NOW = Date.parse('2026-08-31T12:00:00.000Z');
function row(overrides = {}) {
	return {
		supervisorGoalId: 'sg-test-0001', harnessGoalId: 'goal-1', harnessSessionId: 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
		generation: 4, revision: 9, currentControlState: 'RUNNING', nextExpectedAction: null,
		correctionsUsed: 0, correctionsLeft: 3, objective: 'do the thing', createdAt: NOW - 3600_000, updatedAt: NOW - 1000,
		pendingMutation: null, ...overrides,
	};
}
function session(overrides = {}) {
	return {
		sessionId: 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'test', running: true,
		updatedAt: NOW - 1000, goalPhase: 'phase-1', roundsStarted: 2, ...overrides,
	};
}
function makeSnapshot(rows, sessions, current = undefined) {
	return {
		ok: true, supervisorGoals: rows, current: current === undefined ? (rows[0] ?? null) : current,
		sessions: sessions ?? rows.map(() => session()), receipts: [],
	};
}
const HEARTBEATS = { 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee': NOW - 5000 };

// ---------- §4 fields ----------
step('projectTasks: fields present (§4) and no content leakage', () => {
	const snap = makeSnapshot([row({ currentControlState: 'RUNNING' })]);
	const { tasks } = core.projectTasks({ now: NOW, cfg: {}, snapshot: snap, heartbeats: HEARTBEATS });
	assert.equal(tasks.length, 1);
	const t = tasks[0];
	for (const f of ['taskId', 'sessionId', 'goalId', 'title', 'state', 'startedAt', 'lastProgressAt',
		'currentStep', 'completedAt', 'finalDurationMs', 'terminal', 'source', 'updatedAt']) {
		assert.ok(f in t, `missing field ${f}`);
	}
	assert.equal(t.taskId, 'sg-test-0001');
	assert.equal(t.goalId, 'sg-test-0001');
	assert.equal(t.title, 'do the thing');
	assert.equal(t.sessionId, 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
	assert.equal(t.state, 'RUNNING');
	assert.equal(t.terminal, false);
	// 红：不泄露 prompt/evidence/token/session history（白名单字段校验）
	const keys = Object.keys(t);
	for (const banned of ['prompt', 'history', 'evidence', 'content', 'messages']) {
		assert.ok(!keys.some((k) => k.toLowerCase().includes(banned)), `leak field ${banned}`);
	}
});

// ---------- §5 per-task state ----------
step('projectTasks: VERIFIED -> COMPLETED-ish terminal, startedAt preserved', () => {
	const snap = makeSnapshot([row({ currentControlState: 'VERIFIED' })]);
	const { tasks } = core.projectTasks({ now: NOW, cfg: {}, snapshot: snap, heartbeats: HEARTBEATS });
	assert.equal(tasks[0].terminal, true);
	assert.equal(tasks[0].state, 'VERIFIED');
	assert.equal(tasks[0].startedAt, NOW - 3600_000);
	assert.equal(tasks[0].updatedAt, NOW - 1000);
});

step('projectTasks: normal wait (nextExpectedAction user) -> WAITING_USER, never STALLED', () => {
	const snap = makeSnapshot([row({ currentControlState: 'RUNNING', nextExpectedAction: 'waiting for user approval' })]);
	const { tasks } = core.projectTasks({ now: NOW, cfg: {}, snapshot: snap, heartbeats: HEARTBEATS });
	assert.equal(tasks[0].state, 'WAITING_USER');
});

step('projectTasks: in-flight failsafe (running=true, stale) -> RUNNING not STALLED', () => {
	// running=true 且无进展 → 仍为 RUNNING（长前台命令可能仍在工作，绝不猜 STALLED）
	const snap = makeSnapshot([row({ currentControlState: 'RUNNING' })], [session({ running: true, updatedAt: NOW - 7200_000 })]);
	const { tasks } = core.projectTasks({ now: NOW, cfg: {}, snapshot: snap, heartbeats: {} });
	assert.equal(tasks[0].state, 'RUNNING');
});

step('projectTasks: per-task STALLED only when idle + stale + confirmed (R1 B4 philosophy)', () => {
	// running=false + row 与会话都陈旧 + 心跳静默 + 超过阈值 -> STALLED
	const snap = makeSnapshot([row({ currentControlState: 'RUNNING', updatedAt: NOW - 31 * 60_000 })], [session({ running: false, updatedAt: NOW - 31 * 60_000 })]);
	const { tasks } = core.projectTasks({ now: NOW, cfg: { stallAfterMs: 30 * 60_000 }, snapshot: snap, heartbeats: {} });
	assert.equal(tasks[0].state, 'STALLED');
});

step('projectTasks: recent heartbeat keeps RUNNING (not STALLED)', () => {
	const snap = makeSnapshot([row({ currentControlState: 'RUNNING' })], [session({ running: false, updatedAt: NOW - 31 * 60_000 })]);
	const { tasks } = core.projectTasks({ now: NOW, cfg: { stallAfterMs: 30 * 60_000 }, snapshot: snap, heartbeats: { 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee': NOW - 1000 } });
	assert.equal(tasks[0].state, 'RUNNING');
});

// ---------- §6 ordering ----------
step('projectTasks: ordering RUNNING > RECOVERING > WAITING_USER > STALLED > BLOCKED > AWAITING_REVIEW', () => {
	const s1 = 'session-aaaaaaaa-bbbb-4ccc-8ddd-111111111111';
	const s2 = 'session-aaaaaaaa-bbbb-4ccc-8ddd-222222222222';
	const s3 = 'session-aaaaaaaa-bbbb-4ccc-8ddd-333333333333';
	const s4 = 'session-aaaaaaaa-bbbb-4ccc-8ddd-444444444444';
	const s5 = 'session-aaaaaaaa-bbbb-4ccc-8ddd-555555555555';
	const s6 = 'session-aaaaaaaa-bbbb-4ccc-8ddd-666666666666';
	const s7 = 'session-aaaaaaaa-bbbb-4ccc-8ddd-777777777777';
	const rows = [
		row({ supervisorGoalId: 'g-wait', harnessSessionId: s2, currentControlState: 'RUNNING', nextExpectedAction: 'waiting for user input', updatedAt: NOW - 60_000 }),
		row({ supervisorGoalId: 'g-running', harnessSessionId: s1, currentControlState: 'RUNNING', updatedAt: NOW - 1000 }),
		row({ supervisorGoalId: 'g-stall', harnessSessionId: s3, currentControlState: 'RUNNING', updatedAt: NOW - 120 * 60_000 }),
		row({ supervisorGoalId: 'g-recover', harnessSessionId: s4, currentControlState: 'CORRECTING', updatedAt: NOW - 1000 }),
		row({ supervisorGoalId: 'g-blocked', harnessSessionId: s5, currentControlState: 'BLOCKED', updatedAt: NOW - 1000 }),
		row({ supervisorGoalId: 'g-awaits', harnessSessionId: s6, currentControlState: 'AWAITING_REVIEW', updatedAt: NOW - 1000 }),
		row({ supervisorGoalId: 'g-verified', harnessSessionId: s7, currentControlState: 'VERIFIED', updatedAt: NOW - 1000 }),
	];
	const sessions = rows.map((r) => session({
		sessionId: r.harnessSessionId, running: r.supervisorGoalId === 'g-running',
		updatedAt: r.supervisorGoalId === 'g-stall' ? NOW - 120 * 60_000 : NOW - 1000,
	}));
	const snap = makeSnapshot(rows, sessions);
	const { tasks } = core.projectTasks({ now: NOW, cfg: { stallAfterMs: 30 * 60_000 }, snapshot: snap, heartbeats: {} });
	const ids = tasks.map((t) => t.taskId);
	// 期望顺序：running > recover > wait > stall > blocked > awaits > verified
	assert.deepEqual(ids, ['g-running', 'g-recover', 'g-wait', 'g-stall', 'g-blocked', 'g-awaits', 'g-verified']);
	// 真正 running Session 排在旧 AWAITING_REVIEW 之前（§6 关键断言）
	assert.ok(ids.indexOf('g-running') < ids.indexOf('g-awaits'));
});

step('projectTasks: running task outranks stale verified (truly running before completed)', () => {
	const rows = [
		row({ supervisorGoalId: 'g-verify', currentControlState: 'VERIFIED', updatedAt: NOW - 10 * 60_000 }),
		row({ supervisorGoalId: 'g-run', currentControlState: 'RUNNING', updatedAt: NOW - 1000 }),
	];
	const sessions = [
		session({ sessionId: rows[0].harnessSessionId, running: false, updatedAt: NOW - 10 * 60_000 }),
		session({ sessionId: rows[1].harnessSessionId, running: true, updatedAt: NOW - 1000 }),
	];
	const snap = makeSnapshot(rows, sessions);
	const { tasks } = core.projectTasks({ now: NOW, cfg: {}, snapshot: snap, heartbeats: {} });
	assert.equal(tasks[0].taskId, 'g-run');
});

// ---------- §7 completion freeze ----------
step('projectTasks: terminal freeze firstObservedTerminalAt, then stable across refresh', () => {
	const snap = makeSnapshot([row({ currentControlState: 'VERIFIED' })]);
	// 第一次观察：进入终态，无 canonical 时间戳 -> firstObservedTerminalAt = now
	const p1 = core.projectTasks({ now: NOW, cfg: {}, snapshot: snap, heartbeats: {}, terminalCache: {} });
	assert.equal(p1.tasks[0].terminal, true);
	const frozenAt = p1.tasks[0].completedAt;
	assert.equal(frozenAt, NOW); // firstObservedTerminalAt
	assert.ok(p1.terminalCachePatch['sg-test-0001']?.completedAt === NOW);
	// 第二次刷新（生成时间前进很多）：completedAt 必须保持冻结，不漂移
	const p2 = core.projectTasks({ now: NOW + 3 * 3600_000, cfg: {}, snapshot: snap, heartbeats: {}, terminalCache: p1.terminalCachePatch });
	assert.equal(p2.tasks[0].completedAt, frozenAt);
	assert.ok(p2.tasks[0].finalDurationMs === frozenAt - (NOW - 3600_000));
	assert.equal(p2.tasks[0].finalDurationMs, 3600_000);
});

step('projectTasks: non-terminal task clears stale terminal cache', () => {
	const snapRunning = makeSnapshot([row({ currentControlState: 'RUNNING' })]);
	const p1 = core.projectTasks({ now: NOW, cfg: {}, snapshot: snapRunning, heartbeats: HEARTBEATS, terminalCache: {} });
	// 先给一个假想冻结
	const cache = { 'sg-test-0001': { completedAt: NOW, timeSource: 'firstObservedTerminalAt' } };
	const p2 = core.projectTasks({ now: NOW, cfg: {}, snapshot: snapRunning, heartbeats: HEARTBEATS, terminalCache: cache });
	assert.equal(p2.tasks[0].terminal, false);
	assert.equal(p2.terminalCachePatch['sg-test-0001'], undefined); // 非终态清除缓存
});

// ---------- §8 lastProgressAt ----------
step('projectTasks: lastProgressAt uses trusted signal, never now (freshness honesty)', () => {
	const snap = makeSnapshot([row({ currentControlState: 'RUNNING', updatedAt: NOW - 1000 })]);
	const { tasks } = core.projectTasks({ now: NOW, cfg: {}, snapshot: snap, heartbeats: {} });
	// session.updatedAt = NOW-1000 是最新权威信号，lastProgressAt 必须是它（不能是 now）
	assert.equal(tasks[0].lastProgressAt, NOW - 1000);
});

// ---------- overflow ----------
step('projectTasks: overflow count = 3 current + 1 recent completed', () => {
	const rows = Array.from({ length: 6 }, (_, i) => row({
		supervisorGoalId: `g-${i}`, harnessSessionId: `session-aaaaaaaa-bbbb-4ccc-8ddd-${String(i).padStart(12, '0')}`,
		currentControlState: i === 5 ? 'VERIFIED' : 'RUNNING', updatedAt: NOW - 1000,
	}));
	const sessions = rows.map((r) => session({ sessionId: r.harnessSessionId, running: r.currentControlState === 'RUNNING', updatedAt: NOW - 1000 }));
	const snap = makeSnapshot(rows, sessions);
	const { overflow } = core.projectTasks({ now: NOW, cfg: {}, snapshot: snap, heartbeats: {} });
	assert.equal(overflow, Math.max(0, 6 - 4));
});

// ---------- sanitizeSnapshot tasks[] ----------
step('sanitizeSnapshot: tasks[] wired, task.* enriched from primaryTask, otherGoals preserved', () => {
	const snap = makeSnapshot([row({ currentControlState: 'RUNNING' })]);
	const evaluated = core.evaluate({ now: NOW, cfg: { stallAfterMs: 60 * 60_000 }, bridgeOk: true, snapshot: snap, heartbeats: HEARTBEATS, prev: null, episode: core.blankEpisode(), budget: { dayKey: '2026-08-31', acceptedToday: 0, maxPerDay: 3, left: 3, source: 'x', failClosed: false } });
	const { tasks, terminalCachePatch } = core.projectTasks({ now: NOW, cfg: {}, snapshot: snap, heartbeats: HEARTBEATS });
	const s = core.sanitizeSnapshot({ now: NOW, evaluated, model: { default: { provider: 'bai', model: 'glm-5.3-flash' } }, pollMs: 60_000, budget: { dayKey: '2026-08-31', acceptedToday: 0, maxPerDay: 3, left: 3, source: 'x', failClosed: false }, tasks, terminalCachePatch });
	assert.ok(Array.isArray(s.tasks));
	assert.equal(s.tasks.length, 1);
	assert.equal(s.task.goalId, 'sg-test-0001');
	assert.equal(s.task.state, 'RUNNING');
	assert.equal(s.task.lastProgressAt, new Date(NOW - 1000).toISOString());
});

// 汇总
console.log(`\nTOTAL PASS=${pass} FAIL=${fails.length}`);
if (fails.length) { process.exitCode = 1; }
