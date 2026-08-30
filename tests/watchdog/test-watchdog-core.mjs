// test-watchdog-core.mjs — Phase 02.8 watchdog-core 状态机测试（纯函数，零宿主依赖）
// 运行：node tests/watchdog/test-watchdog-core.mjs（CI ci-level2 接线）
// 覆盖：投影映射 / OFFLINE 优先 / stall 双条件（时长+确认）/ 正常等待不误判 /
//       pending 卡死 / 有界恢复预算（episode/日）/ denylist / 幂等 commandId / 脱敏白名单

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
function snap(rows, sessions, current = undefined) {
	return {
		ok: true, supervisorGoals: rows, current: current === undefined ? (rows[0] ?? null) : current,
		sessions: sessions ?? rows.map(() => session()), receipts: [],
	};
}
const baseEpisode = () => core.blankEpisode();
// stall 类测试的夹具：行与会话时间戳都要陈旧（session.updatedAt 是合法进展信号，
// 新鲜会话时间戳会把 stall 压掉——这是设计行为，不是 bug）。
const OLD_SESSION = session({ updatedAt: NOW - 7200_000 });

// ---------- 投影映射 ----------
step('projectRow: RUNNING control state maps RUNNING', () => {
	const p = core.projectRow(row(), session(), { now: NOW });
	assert.equal(p.state, 'RUNNING');
	assert.equal(p.generation, 4);
});
step('projectRow: VERIFIED/BLOCKED/AWAITING_REVIEW direct', () => {
	assert.equal(core.projectRow(row({ currentControlState: 'VERIFIED' }), session(), { now: NOW }).state, 'VERIFIED');
	assert.equal(core.projectRow(row({ currentControlState: 'BLOCKED' }), session(), { now: NOW }).state, 'BLOCKED');
	assert.equal(core.projectRow(row({ currentControlState: 'AWAITING_REVIEW' }), session(), { now: NOW }).state, 'AWAITING_REVIEW');
});
step('projectRow: CORRECTING maps RECOVERING (bridge-native)', () => {
	assert.equal(core.projectRow(row({ currentControlState: 'CORRECTING' }), session(), { now: NOW }).state, 'RECOVERING');
});
step('projectRow: CANCELLED projects BLOCKED with reason flag', () => {
	const p = core.projectRow(row({ currentControlState: 'CANCELLED' }), session(), { now: NOW });
	assert.equal(p.state, 'BLOCKED');
	assert.equal(p._cancelled, true);
});

// ---------- evaluate：OFFLINE/UNKNOWN/IDLE ----------
step('evaluate: bridge unreachable => OFFLINE (never STALLED)', () => {
	const r = core.evaluate({ now: NOW, cfg: {}, bridgeOk: false, snapshot: null, heartbeats: {}, prev: null, episode: baseEpisode() });
	assert.equal(r.state, 'OFFLINE');
	assert.equal(r.recovery, null);
});
step('evaluate: malformed snapshot => UNKNOWN', () => {
	const r = core.evaluate({ now: NOW, cfg: {}, bridgeOk: true, snapshot: { hello: 1 }, heartbeats: {}, prev: null, episode: baseEpisode() });
	assert.equal(r.state, 'UNKNOWN');
});
step('evaluate: no goals + no running sessions => IDLE', () => {
	const r = core.evaluate({ now: NOW, cfg: {}, bridgeOk: true, snapshot: snap([], []), heartbeats: {}, prev: null, episode: baseEpisode() });
	assert.equal(r.state, 'IDLE');
});
step('evaluate: no goals + running session => RUNNING', () => {
	const r = core.evaluate({
		now: NOW, cfg: {}, bridgeOk: true,
		snapshot: { ok: true, supervisorGoals: [], current: null, sessions: [session()], receipts: [] },
		heartbeats: {}, prev: null, episode: baseEpisode(),
	});
	assert.equal(r.state, 'RUNNING');
});

// ---------- stall 判定（时长 + 确认双条件） ----------
step('evaluate: no progress < stallAfterMs => RUNNING', () => {
	const r = core.evaluate({ now: NOW, cfg: { stallAfterMs: 1800_000 }, bridgeOk: true, snapshot: snap([row({ updatedAt: NOW - 60_000 })]), heartbeats: {}, prev: null, episode: baseEpisode() });
	assert.equal(r.state, 'RUNNING');
});
step('evaluate: no progress beyond threshold but 1st confirmation => RUNNING (candidate)', () => {
	const r = core.evaluate({ now: NOW, cfg: { stallAfterMs: 1800_000 }, bridgeOk: true, snapshot: snap([row({ updatedAt: NOW - 1900_000 })], [session({ updatedAt: NOW - 1900_000 })]), heartbeats: {}, prev: null, episode: baseEpisode() });
	assert.equal(r.state, 'RUNNING');
	assert.equal(r.stateReason, 'stall_candidate_pending_confirmation');
});
step('evaluate: beyond threshold + 2nd confirmation => STALLED', () => {
	const ep = baseEpisode();
	ep.confirmations = 1;
	const r = core.evaluate({ now: NOW, cfg: { stallAfterMs: 1800_000 }, bridgeOk: true, snapshot: snap([row({ updatedAt: NOW - 1900_000 })], [session({ updatedAt: NOW - 1900_000 })]), heartbeats: {}, prev: null, episode: ep });
	assert.equal(r.state, 'STALLED');
});
step('evaluate: progress via heartbeat keeps RUNNING (long command alive)', () => {
	const r = core.evaluate({
		now: NOW, cfg: { stallAfterMs: 1800_000 }, bridgeOk: true,
		snapshot: snap([row({ updatedAt: NOW - 1900_000 })], [session({ updatedAt: NOW - 1900_000 })]),
		heartbeats: { 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee': NOW - 5_000 },
		prev: null, episode: baseEpisode(),
	});
	assert.equal(r.state, 'RUNNING');
});
step('evaluate: nextExpectedAction user-wait never STALLED', () => {
	const ep = baseEpisode(); ep.confirmations = 3;
	const r = core.evaluate({
		now: NOW, cfg: { stallAfterMs: 1800_000 }, bridgeOk: true,
		snapshot: snap([row({ updatedAt: NOW - 7200_000, nextExpectedAction: 'WAITING_USER_INPUT' })], [OLD_SESSION]),
		heartbeats: {}, prev: null, episode: ep,
	});
	assert.equal(r.state, 'RUNNING');
	assert.equal(r.stateReason, 'normal_wait_not_stall');
});
step('evaluate: AWAITING_REVIEW / VERIFIED never stall or recover', () => {
	for (const cs of ['AWAITING_REVIEW', 'VERIFIED', 'BLOCKED']) {
		const r = core.evaluate({ now: NOW, cfg: {}, bridgeOk: true, snapshot: snap([row({ currentControlState: cs, updatedAt: NOW - 86400_000 })]), heartbeats: {}, prev: null, episode: baseEpisode() });
		assert.ok(['AWAITING_REVIEW', 'VERIFIED', 'BLOCKED'].includes(r.state), cs);
		assert.equal(r.recovery, null);
	}
});
step('evaluate: pendingMutation stuck => BLOCKED', () => {
	const r = core.evaluate({
		now: NOW, cfg: { stallAfterMs: 1800_000, pendingStuckMs: 600_000 }, bridgeOk: true,
		snapshot: snap([row({ updatedAt: NOW - 1200_000, pendingMutation: { kind: 'CORRECTION', commandId: 'X:g4:CORRECTION:1' } })], [session({ updatedAt: NOW - 1200_000 })]),
		heartbeats: {}, prev: null, episode: baseEpisode(),
	});
	assert.equal(r.state, 'BLOCKED');
	assert.equal(r.stateReason, 'pending_mutation_stuck');
});

// ---------- 有界恢复 ----------
const stalledSetup = (overrides = {}) => ({
	now: NOW,
	cfg: { stallAfterMs: 1800_000, stallConfirmations: 2, recoverAfterMs: 3600_000, recoveryWindowMs: 900_000, maxCorrectionsPerEpisode: 1, maxCorrectionsPerDay: 3, denyGoalIds: [] },
	bridgeOk: true,
	snapshot: snap([row({ updatedAt: NOW - 7200_000, ...overrides })], [OLD_SESSION]),
	heartbeats: {},
});
step('recovery: STALLED persisted < recoverAfterMs => no recovery yet', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 1800_000;
	const r = core.evaluate({ ...stalledSetup(), prev: null, episode: ep });
	assert.equal(r.state, 'STALLED');
	assert.equal(r.recovery, null);
});
step('recovery: persisted >= recoverAfterMs => correction WD:g4:CORRECTION:1', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 3600_000;
	const r = core.evaluate({ ...stalledSetup(), prev: null, episode: ep });
	assert.equal(r.state, 'RECOVERING');
	assert.ok(r.recovery);
	assert.equal(r.recovery.commandId, 'WD:g4:CORRECTION:1');
	assert.equal(r.recovery.text, 'continue');
	assert.equal(r.recovery.mode, 'steer');
	assert.equal(r.recovery.generation, 4);
	assert.equal(r.recovery.supervisorGoalId, 'sg-test-0001');
});
step('recovery: within recovery window => RECOVERING, no second send', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 7200_000;
	ep.recoverySentAt = NOW - 300_000; ep.correctionsSentInEpisode = 1; ep.correctionsSentToday = 1;
	const r = core.evaluate({ ...stalledSetup(), prev: null, episode: ep });
	assert.equal(r.state, 'RECOVERING');
	assert.equal(r.recovery, null);
});
step('recovery: episode budget exhausted => BLOCKED (no recovery)', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 7200_000;
	ep.recoverySentAt = NOW - 3600_000; ep.correctionsSentInEpisode = 1; ep.correctionsSentToday = 1;
	const r = core.evaluate({ ...stalledSetup(), prev: null, episode: ep });
	assert.equal(r.state, 'BLOCKED');
	assert.equal(r.stateReason, 'episode_recovery_budget_exhausted');
});
step('recovery: correctionsLeft=0 => BLOCKED corrections_exhausted', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 7200_000;
	const r = core.evaluate({ ...stalledSetup({ correctionsLeft: 0 }), prev: null, episode: ep });
	assert.equal(r.state, 'BLOCKED');
	assert.equal(r.stateReason, 'corrections_exhausted');
});
step('recovery: denylisted goal never auto-recovers', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 7200_000;
	const cfg = { ...stalledSetup().cfg, denyGoalIds: ['sg-test-0001'] };
	const r = core.evaluate({ ...stalledSetup(), cfg, prev: null, episode: ep });
	assert.equal(r.recovery, null);
	assert.equal(r.episodePatch.blockedReason, 'goal_denylisted');
});
step('recovery: daily budget exhausted => BLOCKED', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 7200_000;
	ep.correctionsSentInEpisode = 0; ep.correctionsSentToday = 3; ep.dayKey = core.blankEpisode().dayKey ?? null;
	// dayKey 匹配 now 的日期（2026-08-31）
	const r = core.evaluate({ ...stalledSetup(), prev: null, episode: { ...ep, dayKey: '2026-08-31' } });
	assert.equal(r.state, 'BLOCKED');
	assert.equal(r.stateReason, 'daily_recovery_budget_exhausted');
});
step('recovery: CANCELLED goal never recovers (terminal early-return)', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 7200_000;
	const r = core.evaluate({
		...stalledSetup({ currentControlState: 'CANCELLED' }), prev: null, episode: ep,
	});
	assert.equal(r.state, 'BLOCKED');
	assert.equal(r.recovery, null);
	// CANCELLED 在终态早退分支处理，episode 不记 blockedReason（它不是恢复拒绝，而是用户终态）
	assert.equal(r.episodePatch.blockedReason, null);
});

// ---------- commandId 幂等形状（与 bridge COMMAND_ID_PATTERN 一致） ----------
step('commandId matches bridge COMMAND_ID_PATTERN shape', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 7200_000;
	const r = core.evaluate({ ...stalledSetup({ generation: 77 }), prev: null, episode: ep });
	assert.match(r.recovery.commandId, /^WD:g77:CORRECTION:\d{1,9}$/);
});

// ---------- 脱敏白名单 ----------
step('sanitize: whitelist fields only; no prompt/log/text/token leakage', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 3600_000;
	const evaluated = core.evaluate({ ...stalledSetup(), prev: null, episode: ep });
	const s = core.sanitizeSnapshot({ now: NOW, evaluated, model: { provider: 'bai', model: 'glm-5.3-flash', source: 'settings.agent-default-model' }, pollMs: 60_000 });
	const json = JSON.stringify(s);
	for (const banned of ['session.prompt', 'authorization', 'Bearer', 'token', 'prompt', 'log', 'evidence bundle']) {
		if (banned === 'log' || banned === 'prompt') {
			// 允许出现在字段名内部？本 schema 不含这两个词的字段；直接断言不出现
		}
		assert.ok(!json.includes(banned), `banned token leaked: ${banned}`);
	}
	assert.equal(s.cost.quota, 'UNAVAILABLE');
	assert.equal(s.cost.resetAt, 'UNAVAILABLE');
	assert.equal(s.schemaVersion, core.SCHEMA_VERSION);
	assert.equal(s.task.generation, 4);
	assert.equal(s.model.model, 'glm-5.3-flash');
	assert.ok(s.task.name.length <= 80);
});
step('sanitize: long objective truncated to 80 chars', () => {
	const longObjective = 'x'.repeat(500) + '\nline2';
	const p = core.projectRow(row({ objective: longObjective }), session(), { now: NOW });
	assert.ok(p.objective.length <= 80);
	assert.ok(!p.objective.includes('\n'));
});
step('normalizeConfig clamps insane values', () => {
	const c = core.normalizeConfig({ pollMs: 1, stallAfterMs: 999999999999, maxCorrectionsPerDay: 999 });
	assert.ok(c.pollMs >= 10_000);
	assert.ok(c.stallAfterMs <= 24 * 3600_000);
	assert.equal(c.maxCorrectionsPerDay, 10);
});

// ---------- 汇总 ----------
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length > 0) {
	process.exitCode = 1;
	for (const f of fails) console.error(`- ${f.name}: ${f.e?.stack ?? f.e}`);
}
