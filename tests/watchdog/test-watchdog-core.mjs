// test-watchdog-core.mjs — Phase 02.8 watchdog-core 状态机测试（纯函数，零宿主依赖）
// 运行：node tests/watchdog/test-watchdog-core.mjs（CI ci-level2 接线）
// 覆盖：投影映射 / OFFLINE 优先 / stall 判定（R1 B4 fail-safe：明确无 in-flight 才允许 STALLED）
//       正常等待不误判 / pending 卡死 / 有界恢复（episode 预算 + 账本推导日预算 R1 B3，含
//       definite/ambiguous 发送结果三分类）/ denylist / 幂等 commandId / 脱敏白名单 /
//       模型真值 actual=UNKNOWN + default 分离（R1 B2，零伪装）

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
// stall 类测试的夹具：行与会话时间戳都要陈旧，且 running 必须为 false（R1 B4：明确无
// in-flight 工作才允许 stall 确认；session.updatedAt 是合法进展信号）。
const OLD_SESSION = session({ running: false, updatedAt: NOW - 7200_000 });
// 账本推导预算夹具（R1 B3）：evaluate 无预算输入 → fail-closed，因此恢复类测试必须显式给
const OK_BUDGET = () => ({ dayKey: '2026-08-31', acceptedToday: 0, maxPerDay: 3, left: 3, source: 'supervisor_receipt_ledger', ledgerState: 'OK', failClosed: false });

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
step('projectRow: runningKnown tri-state (session present / missing + row field / unknown)', () => {
	assert.equal(core.projectRow(row(), session(), { now: NOW }).runningKnown, true);
	assert.equal(core.projectRow(row({ running: false }), null, { now: NOW }).runningKnown, true);
	assert.equal(core.projectRow(row(), null, { now: NOW }).runningKnown, false);
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

// ---------- R1 B4 fail-safe：明确无 in-flight 工作才允许 STALLED ----------
step('B4: running=true + long no progress => RUNNING (long foreground command, never STALLED)', () => {
	const r = core.evaluate({
		now: NOW, cfg: { stallAfterMs: 1800_000 }, bridgeOk: true,
		snapshot: snap([row({ updatedAt: NOW - 7200_000 })], [session({ running: true, updatedAt: NOW - 7200_000 })]),
		heartbeats: {}, prev: null, episode: baseEpisode(),
	});
	assert.equal(r.state, 'RUNNING');
	assert.equal(r.stateReason, 'in_flight_work_failsafe');
	assert.equal(r.recovery, null);
});
step('B4: running unknown (no session, no row flag) => RUNNING fail-safe', () => {
	const r = core.evaluate({
		now: NOW, cfg: { stallAfterMs: 1800_000 }, bridgeOk: true,
		snapshot: snap([row({ updatedAt: NOW - 7200_000 })], []),
		heartbeats: {}, prev: null, episode: baseEpisode(),
	});
	assert.equal(r.state, 'RUNNING');
	assert.equal(r.stateReason, 'in_flight_unknown_failsafe');
	assert.equal(r.recovery, null);
});
step('B4: running=false + recent host heartbeat => RUNNING (recent_host_activity)', () => {
	const r = core.evaluate({
		now: NOW, cfg: { stallAfterMs: 1800_000 }, bridgeOk: true,
		snapshot: snap([row({ updatedAt: NOW - 7200_000 })], [OLD_SESSION]),
		heartbeats: { 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee': NOW - 60_000 },
		prev: null, episode: baseEpisode(),
	});
	assert.equal(r.state, 'RUNNING');
	assert.equal(r.stateReason, 'recent_host_activity');
});
step('B4: running=false + stale heartbeat + double confirmation => STALLED (E1 shape)', () => {
	const ep = baseEpisode(); ep.confirmations = 1;
	const r = core.evaluate({
		now: NOW, cfg: { stallAfterMs: 1800_000 }, bridgeOk: true,
		snapshot: snap([row({ updatedAt: NOW - 7200_000 })], [OLD_SESSION]),
		heartbeats: { 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee': NOW - 7200_000 },
		prev: null, episode: ep,
	});
	assert.equal(r.state, 'STALLED');
});

// ---------- stall 判定（时长 + 确认双条件，明确空闲前提） ----------
step('evaluate: no progress < stallAfterMs => RUNNING', () => {
	const r = core.evaluate({ now: NOW, cfg: { stallAfterMs: 1800_000 }, bridgeOk: true, snapshot: snap([row({ updatedAt: NOW - 60_000 })], [session({ running: false })]), heartbeats: {}, prev: null, episode: baseEpisode() });
	assert.equal(r.state, 'RUNNING');
});
step('evaluate: no progress beyond threshold but 1st confirmation => RUNNING (candidate)', () => {
	const r = core.evaluate({ now: NOW, cfg: { stallAfterMs: 1800_000 }, bridgeOk: true, snapshot: snap([row({ updatedAt: NOW - 1900_000 })], [session({ running: false, updatedAt: NOW - 1900_000 })]), heartbeats: {}, prev: null, episode: baseEpisode() });
	assert.equal(r.state, 'RUNNING');
	assert.equal(r.stateReason, 'stall_candidate_pending_confirmation');
});
step('evaluate: beyond threshold + 2nd confirmation => STALLED', () => {
	const ep = baseEpisode();
	ep.confirmations = 1;
	const r = core.evaluate({ now: NOW, cfg: { stallAfterMs: 1800_000 }, bridgeOk: true, snapshot: snap([row({ updatedAt: NOW - 1900_000 })], [session({ running: false, updatedAt: NOW - 1900_000 })]), heartbeats: {}, prev: null, episode: ep });
	assert.equal(r.state, 'STALLED');
});
step('evaluate: progress via heartbeat keeps RUNNING (long command alive)', () => {
	const r = core.evaluate({
		now: NOW, cfg: { stallAfterMs: 1800_000 }, bridgeOk: true,
		snapshot: snap([row({ updatedAt: NOW - 1900_000 })], [session({ running: false, updatedAt: NOW - 1900_000 })]),
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
		snapshot: snap([row({ updatedAt: NOW - 1200_000, pendingMutation: { kind: 'CORRECTION', commandId: 'X:g4:CORRECTION:1' } })], [session({ running: false, updatedAt: NOW - 1200_000 })]),
		heartbeats: {}, prev: null, episode: baseEpisode(),
	});
	assert.equal(r.state, 'BLOCKED');
	assert.equal(r.stateReason, 'pending_mutation_stuck');
});

// ---------- R1 B3：账本解析与预算推导 ----------
const ledgerFixture = (entries) => JSON.stringify({
	version: 2, updatedAt: '2026-08-31T11:00:00.000Z',
	receipts: {
		'goal-a': {
			key: 'goal-a', sessionId: 'session-1', generation: 4, corrections: entries.length,
			correctionLog: entries,
		},
	},
});
step('B3 ledger: parses receipts and counts only WD: today', () => {
	const raw = ledgerFixture([
		{ commandId: 'WD:g4:CORRECTION:1', at: NOW - 3600_000 },
		{ commandId: 'WD:g4:CORRECTION:2', at: NOW - 1800_000 },
		{ commandId: 'SUP:g4:DISPATCH:1', at: NOW - 900_000 },
		{ commandId: 'WD:g4:CORRECTION:9', at: NOW - 48 * 3600_000 }, // 昨天
	]);
	const parsed = core.parseReceiptsLedger(raw);
	assert.equal(parsed.ok, true);
	assert.equal(core.countAcceptedToday(parsed, NOW), 2);
});
step('B3 ledger: malformed => fail-closed budget', () => {
	const b1 = core.deriveBudget({ ledgerText: 'not json{{{', cfg: core.normalizeConfig({}), now: NOW });
	assert.equal(b1.failClosed, true);
	assert.equal(b1.left, 0);
	const b2 = core.deriveBudget({ ledgerText: null, cfg: core.normalizeConfig({}), now: NOW });
	assert.equal(b2.failClosed, true);
});
step('B3 ledger: empty receipts => zero accepted, budget open', () => {
	const b = core.deriveBudget({ ledgerText: JSON.stringify({ version: 2, receipts: {} }), cfg: core.normalizeConfig({}), now: NOW });
	assert.equal(b.failClosed, false);
	assert.equal(b.acceptedToday, 0);
	assert.equal(b.left, 3);
});
step('B3 ledger: same commandId listed once counts once (idempotent replay dedupe)', () => {
	const raw = ledgerFixture([{ commandId: 'WD:g1:CORRECTION:1', at: NOW - 60_000 }]);
	const parsed = core.parseReceiptsLedger(raw);
	assert.equal(core.countAcceptedToday(parsed, NOW), 1);
});
step('B3 evaluate: budget exhausted (left=0) => BLOCKED daily_recovery_budget_exhausted', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 7200_000;
	const r = core.evaluate({
		now: NOW, cfg: { stallAfterMs: 1800_000, stallConfirmations: 2, recoverAfterMs: 3600_000 }, bridgeOk: true,
		snapshot: snap([row({ updatedAt: NOW - 7200_000 })], [OLD_SESSION]), heartbeats: {}, prev: null, episode: ep,
		budget: { dayKey: '2026-08-31', acceptedToday: 3, maxPerDay: 3, left: 0, failClosed: false },
	});
	assert.equal(r.state, 'BLOCKED');
	assert.equal(r.stateReason, 'daily_recovery_budget_exhausted');
});
step('B3 evaluate: budget missing/unreadable => BLOCKED fail-closed (never recovers blind)', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 7200_000;
	const r = core.evaluate({
		now: NOW, cfg: { stallAfterMs: 1800_000, stallConfirmations: 2, recoverAfterMs: 3600_000 }, bridgeOk: true,
		snapshot: snap([row({ updatedAt: NOW - 7200_000 })], [OLD_SESSION]), heartbeats: {}, prev: null, episode: ep,
		budget: null,
	});
	assert.equal(r.state, 'BLOCKED');
	assert.equal(r.stateReason, 'daily_budget_ledger_unreadable_fail_closed');
});
step('B3 restart-safety: budget re-derived from ledger, not episode memory', () => {
	// 空 episode（重启后）+ 账本显示今日已接受 2（max 3）→ 仍可恢复（预算来自账本重推导）
	const raw = ledgerFixture([
		{ commandId: 'WD:g4:CORRECTION:1', at: NOW - 7200_000 },
		{ commandId: 'WD:g4:CORRECTION:2', at: NOW - 3600_000 },
	]);
	const budget = core.deriveBudget({ ledgerText: raw, cfg: core.normalizeConfig({}), now: NOW });
	assert.equal(budget.acceptedToday, 2);
	assert.equal(budget.left, 1);
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 7200_000;
	const r = core.evaluate({
		now: NOW, cfg: { stallAfterMs: 1800_000, stallConfirmations: 2, recoverAfterMs: 3600_000 }, bridgeOk: true,
		snapshot: snap([row({ updatedAt: NOW - 7200_000 })], [OLD_SESSION]), heartbeats: {}, prev: null, episode: ep, budget,
	});
	assert.equal(r.state, 'RECOVERING');
	assert.equal(r.recovery.commandId, 'WD:g4:CORRECTION:1'); // 空 episode → seq 重置为 1（幂等键含 goal+gen，bridge 幂等可吸收）
});

// ---------- R1 B3：发送结果三分类（applySendOutcome） ----------
step('B3 outcome: accepted counts into episode (budget consumed)', () => {
	const ep = baseEpisode();
	const out = core.applySendOutcome(ep, { kind: 'accepted', commandId: 'WD:g4:CORRECTION:1' }, { now: NOW });
	assert.equal(out.correctionsSentInEpisode, 1);
	assert.ok(out.recoverySentAt);
	assert.equal(out.sendFailures, 0);
});
step('B3 outcome: duplicate counts too (already applied on bridge)', () => {
	const ep = baseEpisode();
	const out = core.applySendOutcome(ep, { kind: 'duplicate', commandId: 'WD:g4:CORRECTION:1' }, { now: NOW });
	assert.equal(out.correctionsSentInEpisode, 1);
});
step('B3 outcome: definite_failure consumes nothing, same commandId retried (seq unchanged)', () => {
	const ep = baseEpisode();
	const f1 = core.applySendOutcome(ep, { kind: 'definite_failure', error: 'http_400:invalid_generation' }, { now: NOW });
	assert.equal(f1.correctionsSentInEpisode, 0);
	assert.equal(f1.sendFailures, 1);
	assert.equal(f1.blockedReason, null);
	assert.equal(f1.recoverySentAt ?? null, null);
	// 重试预算内 → 下轮 evaluate 仍发同 seq=1 的 commandId
	const r = core.evaluate({
		now: NOW + 60_000, cfg: { stallAfterMs: 1800_000, stallConfirmations: 2, recoverAfterMs: 3600_000 }, bridgeOk: true,
		snapshot: snap([row({ updatedAt: NOW - 7200_000 })], [OLD_SESSION]), heartbeats: {}, prev: null,
		episode: { ...f1, confirmations: 2, stallSince: NOW - 7200_000 }, budget: OK_BUDGET(),
	});
	assert.equal(r.state, 'RECOVERING');
	assert.equal(r.recovery.commandId, 'WD:g4:CORRECTION:1');
});
step('B3 outcome: definite_failure beyond cap => attention BLOCKED recovery_send_failed', () => {
	const ep = baseEpisode(); ep.sendFailures = 1;
	const f2 = core.applySendOutcome(ep, { kind: 'definite_failure', error: 'http_400:invalid_generation' }, { now: NOW });
	assert.equal(f2.sendFailures, 2);
	assert.equal(f2.blockedReason, 'recovery_send_failed');
	const r = core.evaluate({
		now: NOW + 60_000, cfg: { stallAfterMs: 1800_000, stallConfirmations: 2, recoverAfterMs: 3600_000, maxSendFailuresPerEpisode: 2 }, bridgeOk: true,
		snapshot: snap([row({ updatedAt: NOW - 7200_000 })], [OLD_SESSION]), heartbeats: {}, prev: null,
		episode: { ...f2, confirmations: 2, stallSince: NOW - 7200_000 }, budget: OK_BUDGET(),
	});
	assert.equal(r.state, 'BLOCKED');
	assert.equal(r.stateReason, 'recovery_send_failed');
	assert.equal(r.recovery, null);
});
step('B3 outcome: ambiguous => fail-closed no resend (STALLED attention, recovery null)', () => {
	const ep = baseEpisode();
	const amb = core.applySendOutcome(ep, { kind: 'ambiguous', error: 'timeout', commandId: 'WD:g4:CORRECTION:1' }, { now: NOW });
	assert.ok(amb.ambiguousSince);
	assert.equal(amb.blockedReason, null);
	const r = core.evaluate({
		now: NOW + 120_000, cfg: { stallAfterMs: 1800_000, stallConfirmations: 2, recoverAfterMs: 3600_000 }, bridgeOk: true,
		snapshot: snap([row({ updatedAt: NOW - 7200_000 })], [OLD_SESSION]), heartbeats: {}, prev: null,
		episode: { ...amb, confirmations: 2, stallSince: NOW - 7200_000 }, budget: OK_BUDGET(),
	});
	assert.equal(r.state, 'STALLED');
	assert.equal(r.stateReason, 'recovery_outcome_ambiguous');
	assert.equal(r.watchdogHealth, 'attention');
	assert.equal(r.recovery, null);
});

// ---------- 有界恢复 ----------
const stalledSetup = (overrides = {}) => ({
	now: NOW,
	cfg: { stallAfterMs: 1800_000, stallConfirmations: 2, recoverAfterMs: 3600_000, recoveryWindowMs: 900_000, maxCorrectionsPerEpisode: 1, maxCorrectionsPerDay: 3, denyGoalIds: [] },
	bridgeOk: true,
	snapshot: snap([row({ updatedAt: NOW - 7200_000, ...overrides })], [OLD_SESSION]),
	heartbeats: { 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee': NOW - 7200_000 },
	budget: OK_BUDGET(),
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
step('recovery: dispatch does NOT pre-count budget (host applies outcome after)', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 3600_000;
	const r = core.evaluate({ ...stalledSetup(), prev: null, episode: ep });
	assert.equal(r.episodePatch.correctionsSentInEpisode, 0);
});
step('recovery: within recovery window => RECOVERING, no second send', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 7200_000;
	ep.recoverySentAt = NOW - 300_000; ep.correctionsSentInEpisode = 1;
	const r = core.evaluate({ ...stalledSetup(), prev: null, episode: ep });
	assert.equal(r.state, 'RECOVERING');
	assert.equal(r.recovery, null);
});
step('recovery: episode budget exhausted => BLOCKED (no recovery)', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 7200_000;
	ep.recoverySentAt = NOW - 3600_000; ep.correctionsSentInEpisode = 1;
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

// ---------- R1 B2：模型真值（actual UNKNOWN / default 分离） ----------
step('B2 model: runtime authority unavailable => actual UNKNOWN, default from settings', () => {
	const m = core.normalizeModelTruth({ default: { provider: 'bai', model: 'glm-5.3-flash', source: 'settings.agent-default-model' } });
	assert.equal(m.actual.provider, 'UNKNOWN');
	assert.equal(m.actual.model, 'UNKNOWN');
	assert.equal(m.actual.source, 'runtime_authority_unavailable_v1');
	assert.equal(m.default.provider, 'bai');
	assert.equal(m.default.model, 'glm-5.3-flash');
});
step('B2 model: empty/missing input => both UNKNOWN, never fabricated', () => {
	const m = core.normalizeModelTruth(null);
	assert.equal(m.actual.model, 'UNKNOWN');
	assert.equal(m.default.model, 'UNKNOWN');
});
step('B2 sanitize: snapshot carries actual/default split + recoveryBudget + push metadata', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 3600_000;
	const evaluated = core.evaluate({ ...stalledSetup(), prev: null, episode: ep });
	const s = core.sanitizeSnapshot({
		now: NOW, evaluated,
		model: { default: { provider: 'bai', model: 'glm-5.3-flash', source: 'settings.agent-default-model' } },
		pollMs: 60_000, budget: OK_BUDGET(),
	});
	assert.equal(s.model.actual.model, 'UNKNOWN');
	assert.equal(s.model.default.model, 'glm-5.3-flash');
	assert.equal(s.model.displayRule, 'actual_unavailable_shows_unknown');
	assert.equal(s.recoveryBudget.left, 3);
	// R2（External Review B）：SSE 端点已移除；push 元数据 = FCM 唤醒 + status 兜底轮询。
	// channel 'sse' 为 schema 兼容保留（消费方按字段名读取），path 指向语义等价的 status 路由。
	assert.equal(s.push.channel, 'sse');
	assert.equal(s.push.path, '/watchdog/status');
	assert.equal(s.push.fcm, true);
	assert.equal(s.freshness.policy, 'poll+fcm');
	assert.equal(s.freshness.push, 'fcm-data-message');
});
step('R2 FCM: push payload metadata whitelist + eid format; request shape + project-id guard', () => {
	const ep = baseEpisode();
	const evaluated = core.evaluate({ ...stalledSetup(), prev: null, episode: ep });
	const p = core.buildFcmPushPayload({ evaluated, eventId: 7 });
	assert.equal(p.v, 1);
	assert.equal(p.ev, 'state_change');
	assert.equal(p.eid, 'fcm-7');
	assert.equal(p.wake, true);
	const whitelist = new Set(['v', 'ev', 'eid', 'rev', 'gen', 'wake', 'ts']);
	assert.ok(Object.keys(p).every((k) => whitelist.has(k)), `keys=${Object.keys(p).join(',')}`);
	const req = core.buildFcmRequest({ projectId: 'dsh-watchdog', payload: p });
	assert.equal(req.ok, true);
	assert.equal(req.url, 'https://fcm.googleapis.com/v1/projects/dsh-watchdog/messages:send');
	assert.equal(req.body?.message?.topic, 'watchdog');
	assert.equal(req.body?.message?.android?.priority, 'HIGH');
	assert.ok(Object.values(req.body?.message?.data ?? {}).every((x) => typeof x === 'string'), 'data values must be strings (FCM HTTP v1)');
	assert.equal(core.buildFcmRequest({ projectId: 'BAD_ID!', payload: p }).ok, false);
	assert.equal(core.buildFcmRequest({ projectId: 'dsh-watchdog', payload: null }).ok, false);
});
step('B2 E6-shape: default model switch reflects in snapshot while actual stays UNKNOWN', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 3600_000;
	const evaluated = core.evaluate({ ...stalledSetup(), prev: null, episode: ep });
	const before = core.sanitizeSnapshot({ now: NOW, evaluated, model: { default: { provider: 'bai', model: 'glm-5.3-flash' } }, pollMs: 60_000, budget: OK_BUDGET() });
	const after = core.sanitizeSnapshot({ now: NOW, evaluated, model: { default: { provider: 'agentrouter-openai', model: 'claude-sonnet-4-6' } }, pollMs: 60_000, budget: OK_BUDGET() });
	assert.equal(before.model.default.model, 'glm-5.3-flash');
	assert.equal(after.model.default.model, 'claude-sonnet-4-6');
	assert.equal(before.model.actual.model, 'UNKNOWN');
	assert.equal(after.model.actual.model, 'UNKNOWN');
});

// ---------- 脱敏白名单 ----------
step('sanitize: whitelisted fields only; no prompt/log/text/token leakage', () => {
	const ep = baseEpisode(); ep.confirmations = 2; ep.stallSince = NOW - 3600_000;
	const evaluated = core.evaluate({ ...stalledSetup(), prev: null, episode: ep });
	const s = core.sanitizeSnapshot({
		now: NOW, evaluated,
		model: { default: { provider: 'bai', model: 'glm-5.3-flash', source: 'settings.agent-default-model' } },
		pollMs: 60_000, budget: OK_BUDGET(),
	});
	const json = JSON.stringify(s);
	for (const banned of ['session.prompt', 'authorization', 'Bearer', 'token', 'prompt', 'evidence bundle']) {
		assert.ok(!json.includes(banned), `banned token leaked: ${banned}`);
	}
	assert.equal(s.cost.quota, 'UNAVAILABLE');
	assert.equal(s.cost.resetAt, 'UNAVAILABLE');
	assert.equal(s.schemaVersion, core.SCHEMA_VERSION);
	assert.equal(s.task.generation, 4);
	assert.equal(s.model.default.model, 'glm-5.3-flash');
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
