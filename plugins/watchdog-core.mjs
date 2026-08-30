// watchdog-core.mjs — Phase 02.8 Supervisor Runtime Watchdog（纯函数层，零依赖）
//
// 定位（Notion 02.8）：Supervisor / Official Session / Goal / Router / Runtime 是唯一事实源。
// 本模块只做 PROJECTION（投影），绝不反向成为任务 Authority；不维护第二份任务状态真相。
//
// 输入全部来自既有权威面（supervisor-bridge get_snapshot/get_state + 宿主内 session/event 心跳）；
// 输出为用户可读投影状态与「有界恢复」决策建议。真正执行恢复的永远是既有 bridge 的
// /supervisor/send_correction（幂等 commandId + generation gate + 预算闸），本层只计算参数。
//
// 状态机（Notion 02.8 §1.2 + §3）：
//   权威投影态：IDLE / RUNNING / STALLED / RECOVERING / AWAITING_REVIEW / BLOCKED / VERIFIED
//   UI 补充态（只读 UI 层专用，不进任务 Authority）：OFFLINE / UNKNOWN
//
// stall 判定铁律（§1.3）：禁止仅因“超过 X 分钟”判 STALLED。必须同时：
//   ① 会话处于 running / goal 处于 active 控制态；② 无 pendingMutation；
//   ③ 非正常等待（nextExpectedAction 指向 user/review）；④ 连续 N 次轮询无任何有效进展
//   （进展 = generation/revision/updatedAt 变化 或 in-host session/event 心跳）。
//   OFFLINE（宿主/桥不可达）永远优先于 STALLED——不可达 ≠ 卡住。

export const SCHEMA_VERSION = 1;
export const WATCHDOG_VERSION = '0.1.0';

export const STATES = Object.freeze([
	'IDLE', 'RUNNING', 'STALLED', 'RECOVERING', 'AWAITING_REVIEW', 'BLOCKED', 'VERIFIED',
]);
export const UI_ONLY_STATES = Object.freeze(['OFFLINE', 'UNKNOWN']);

// bridge 原生控制态（supervisor-bridge-core CONTROL_STATES）
const TERMINAL = new Set(['BLOCKED', 'VERIFIED', 'CANCELLED']);
const AWAITING = new Set(['AWAITING_REVIEW']);
const RECOVERING_NATIVE = new Set(['CORRECTING']);
const ACTIVE = new Set(['CREATED', 'DISPATCHED', 'RUNNING']);

export function defaultConfig() {
	return Object.freeze({
		pollMs: 60_000,
		stallAfterMs: 30 * 60_000,        // 无有效进展阈值（进展信号见上）
		stallConfirmations: 2,            // 连续轮询确认次数（防单次抖动）
		recoverAfterMs: 60 * 60_000,      // STALLED 持续到该时长才允许自动 correction
		recoveryWindowMs: 15 * 60_000,    // 发出 correction 后的观察窗（窗内 = RECOVERING，不重复发）
		maxCorrectionsPerEpisode: 1,      // 单次卡住事件最多自动 correction 数
		maxCorrectionsPerDay: 3,          // 每自然日（UTC）全局自动 correction 上限
		denyGoalIds: [],                  // 硬拒绝恢复的 goal（如 P3 冻结对象）
		pendingStuckMs: 10 * 60_000,      // pendingMutation 卡死判定（超过 → BLOCKED）
	});
}

function clampInt(v, lo, hi, dflt) {
	const n = Number(v);
	if (!Number.isFinite(n)) return dflt;
	return Math.min(hi, Math.max(lo, Math.round(n)));
}

export function normalizeConfig(raw = {}) {
	const d = defaultConfig();
	return Object.freeze({
		pollMs: clampInt(raw.pollMs, 10_000, 600_000, d.pollMs),
		stallAfterMs: clampInt(raw.stallAfterMs, 60_000, 24 * 3600_000, d.stallAfterMs),
		stallConfirmations: clampInt(raw.stallConfirmations, 1, 10, d.stallConfirmations),
		recoverAfterMs: clampInt(raw.recoverAfterMs, 120_000, 7 * 24 * 3600_000, d.recoverAfterMs),
		recoveryWindowMs: clampInt(raw.recoveryWindowMs, 60_000, 6 * 3600_000, d.recoveryWindowMs),
		maxCorrectionsPerEpisode: clampInt(raw.maxCorrectionsPerEpisode, 0, 3, d.maxCorrectionsPerEpisode),
		maxCorrectionsPerDay: clampInt(raw.maxCorrectionsPerDay, 0, 10, d.maxCorrectionsPerDay),
		denyGoalIds: Array.isArray(raw.denyGoalIds) ? raw.denyGoalIds.filter((x) => typeof x === 'string') : d.denyGoalIds,
		pendingStuckMs: clampInt(raw.pendingStuckMs, 60_000, 24 * 3600_000, d.pendingStuckMs),
	});
}

function oneLine(s, max) {
	if (typeof s !== 'string') return null;
	const t = s.replace(/[\r\n\t]+/g, ' ').trim();
	return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * 单 goal 投影。row = bridge buildSnapshotRow；session = sanitizeStateItem 或 null。
 * 返回 { id, sessionId, state, controlState, generation, revision, correctionsLeft,
 *        pendingMutation, nextExpectedAction, goalPhase, running, updatedAt }
 */
export function projectRow(row, session, opts = {}) {
	const now = Number(opts.now) || Date.now();
	const cs = row?.currentControlState ?? null;
	const controlState = typeof cs === 'string' ? cs : 'UNKNOWN_CONTROL';
	const running = !!(session?.running ?? row?.running);
	let state;
	if (controlState === 'VERIFIED') state = 'VERIFIED';
	else if (controlState === 'BLOCKED') state = 'BLOCKED';
	else if (controlState === 'CANCELLED') state = 'BLOCKED'; // 投影决策：CANCELLED 归入需注意态（UI 枚举受限），reason 标注
	else if (AWAITING.has(controlState)) state = 'AWAITING_REVIEW';
	else if (RECOVERING_NATIVE.has(controlState)) state = 'RECOVERING';
	else if (ACTIVE.has(controlState)) state = 'RUNNING';
	else state = 'UNKNOWN';

	return {
		id: typeof row?.supervisorGoalId === 'string' ? row.supervisorGoalId : null,
		sessionId: row?.harnessSessionId ?? session?.sessionId ?? null,
		state,
		controlState,
		generation: Number.isInteger(row?.generation) ? row.generation : null,
		revision: Number.isInteger(row?.revision) ? row.revision : null,
		correctionsLeft: Number.isInteger(row?.correctionsLeft) ? row.correctionsLeft : null,
		pendingMutation: row?.pendingMutation ? { kind: row.pendingMutation.kind, commandId: row.pendingMutation.commandId } : null,
		nextExpectedAction: oneLine(row?.nextExpectedAction ?? '', 40),
		goalPhase: session?.goalPhase ?? null,
		roundsStarted: Number.isInteger(session?.roundsStarted) ? session.roundsStarted : null,
		running,
		updatedAt: Number.isFinite(row?.updatedAt) ? row.updatedAt : (Number.isFinite(session?.updatedAt) ? session.updatedAt : null),
		objective: oneLine(row?.objective ?? session?.name ?? '', 80),
		_cancelled: controlState === 'CANCELLED',
		checkedAt: now,
	};
}

function isNormalWait(proj) {
	const nea = String(proj?.nextExpectedAction ?? '').toLowerCase();
	if (!nea) return false;
	return nea.includes('user') || nea.includes('review') || nea.includes('input') || nea.includes('approve');
}

function dayKeyOf(now) {
	return new Date(now).toISOString().slice(0, 10);
}

/**
 * 汇总评估（每轮轮询调用一次）。
 * input = { now, cfg, bridgeOk, snapshot, heartbeats: {sessionId: lastEventAt}, prev, episode }
 *   prev     : 上轮 sanitizeSnapshot 结果（用于进展指纹对比）
 *   episode  : { key, stallSince, confirmations, recoverySentAt, correctionsSentInEpisode,
 *                dayKey, correctionsSentToday, blockedReason }
 * 返回 { ok, state, stateReason, watchdogHealth, lastProgressAt, stalledForMs,
 *        goals:[projection], primary, recovery, episodePatch }
 */
export function evaluate(input = {}) {
	const now = Number(input.now) || Date.now();
	const cfg = normalizeConfig(input.cfg);
	const heartbeats = input.heartbeats && typeof input.heartbeats === 'object' ? input.heartbeats : {};

	// ① 桥不可达 → OFFLINE（优先一切；不可达不是卡住）
	if (!input.bridgeOk) {
		return {
			ok: false, state: 'OFFLINE', stateReason: 'supervisor_bridge_unreachable', watchdogHealth: 'degraded',
			lastProgressAt: null, stalledForMs: null, goals: [], primary: null, recovery: null,
			episodePatch: { ...blankEpisode(), blockedReason: null },
		};
	}
	const snap = input.snapshot;
	if (!snap || typeof snap !== 'object' || !Array.isArray(snap.supervisorGoals)) {
		return {
			ok: false, state: 'UNKNOWN', stateReason: 'malformed_snapshot', watchdogHealth: 'degraded',
			lastProgressAt: null, stalledForMs: null, goals: [], primary: null, recovery: null,
			episodePatch: blankEpisode(),
		};
	}

	// ② 逐行投影
	const sessionsBySid = new Map((Array.isArray(snap.sessions) ? snap.sessions : []).map((s) => [s.sessionId, s]));
	const goals = snap.supervisorGoals.map((row) => {
		const session = sessionsBySid.get(row.harnessSessionId) ?? null;
		return projectRow(row, session, { now });
	});

	// ③ 主行选择：bridge 已给 current（首个非终态，否则第一行）
	const primaryRow = snap.current ?? snap.supervisorGoals[0] ?? null;
	const primary = goals.find((g) => primaryRow && g.id === primaryRow.supervisorGoalId) ?? goals[0] ?? null;

	// ④ 无任何 goal：有 running 会话 → RUNNING，否则 IDLE
	if (!primary) {
		const anyRunning = (snap.sessions ?? []).some((s) => s.running);
		return {
			ok: true, state: anyRunning ? 'RUNNING' : 'IDLE',
			stateReason: anyRunning ? 'session_running_no_goal' : 'no_active_task',
			watchdogHealth: 'healthy', lastProgressAt: null, stalledForMs: null,
			goals, primary: null, recovery: null, episodePatch: blankEpisode(),
		};
	}

	// ⑤ 终态/等待/桥原生恢复态：直接投影，永不算 stall、永不自动恢复
	if (['VERIFIED', 'BLOCKED', 'AWAITING_REVIEW', 'RECOVERING'].includes(primary.state)) {
		return {
			ok: true, state: primary.state,
			stateReason: primary.state === 'BLOCKED' && primary._cancelled ? 'cancelled_by_user' : `control_state_${primary.controlState}`,
			watchdogHealth: 'healthy', lastProgressAt: primary.updatedAt, stalledForMs: null,
			goals, primary, recovery: null,
			episodePatch: blankEpisode(),
		};
	}

	// ⑥ active 态：进展/stall 判定
	const hb = heartbeats[primary.sessionId] ?? 0;
	const signals = [primary.updatedAt, sessionsBySid.get(primary.sessionId)?.updatedAt ?? 0, hb];
	const prevGoals = Array.isArray(input.prev?.goals) ? input.prev.goals : [];
	const prevPrimary = prevGoals.find((g) => g.id === primary.id) ?? null;
	const fingerprint = {
		changed:
			prevPrimary == null ||
			prevPrimary.generation !== primary.generation ||
			prevPrimary.revision !== primary.revision ||
			prevPrimary.updatedAt !== primary.updatedAt ||
			prevPrimary.controlState !== primary.controlState,
	};
	const prevStamp = Number(input.prev?.lastProgressAt) || 0;
	const authoritative = Math.max(...signals.filter((n) => Number.isFinite(n) && n > 0), 0);
	let lastProgressAt = authoritative;
	// 权威字段未变化时，心跳/会话活动仍算进展；完全无信号且指纹未变 → 沿用旧 stamp
	if (!fingerprint.changed && authoritative <= prevStamp) lastProgressAt = prevStamp > 0 ? prevStamp : (hb || authoritative || now);
	if (fingerprint.changed) lastProgressAt = authoritative > 0 ? authoritative : now;

	const stalledForMs = Math.max(0, now - lastProgressAt);
	const ep = { ...(input.episode ?? blankEpisode()) };

	// pendingMutation 卡死 → BLOCKED（bridge 幂等中间态不该长期挂起）
	if (primary.pendingMutation && stalledForMs >= cfg.pendingStuckMs) {
		return {
			ok: true, state: 'BLOCKED', stateReason: 'pending_mutation_stuck', watchdogHealth: 'attention',
			lastProgressAt, stalledForMs, goals, primary, recovery: null,
			episodePatch: { ...blankEpisode(), blockedReason: 'pending_mutation_stuck' },
		};
	}

	// stall 候选：running 且无进展；确认次数累计
	const noProgress = stalledForMs >= cfg.stallAfterMs;
	const confirmations = noProgress ? (Number.isInteger(ep.confirmations) ? ep.confirmations + 1 : 1) : 0;
	let episodePatch = {
		key: `${primary.id ?? primary.sessionId}`,
		stallSince: noProgress ? (Number.isFinite(ep.stallSince) ? ep.stallSince : now) : null,
		confirmations,
		recoverySentAt: ep.recoverySentAt ?? null,
		correctionsSentInEpisode: ep.correctionsSentInEpisode ?? 0,
		dayKey: dayKeyOf(now),
		correctionsSentToday: ep.dayKey === dayKeyOf(now) ? (ep.correctionsSentToday ?? 0) : 0,
		blockedReason: null,
	};

	const stalledConfirmed = noProgress && confirmations >= cfg.stallConfirmations;
	if (!stalledConfirmed) {
		return {
			ok: true, state: 'RUNNING', stateReason: noProgress ? 'stall_candidate_pending_confirmation' : 'progressing',
			watchdogHealth: 'healthy', lastProgressAt, stalledForMs, goals, primary, recovery: null,
			episodePatch,
		};
	}

	// 已确认 STALLED —— 正常等待除外（等待 ≠ 卡住）
	if (isNormalWait(primary)) {
		return {
			ok: true, state: 'RUNNING', stateReason: 'normal_wait_not_stall', watchdogHealth: 'healthy',
			lastProgressAt, stalledForMs, goals, primary, recovery: null, episodePatch,
		};
	}

	// ⑦ 恢复决策（只经既有 bridge mutation；预算 + 幂等 + 同 goal）
	const stallPersistedMs = Number.isFinite(episodePatch.stallSince) ? now - episodePatch.stallSince : stalledForMs;
	const inRecoveryWindow = episodePatch.recoverySentAt && (now - episodePatch.recoverySentAt) < cfg.recoveryWindowMs;
	if (inRecoveryWindow) {
		return {
			ok: true, state: 'RECOVERING', stateReason: 'auto_correction_in_flight', watchdogHealth: 'recovering',
			lastProgressAt, stalledForMs, goals, primary, recovery: null, episodePatch,
		};
	}
	const denyHit = cfg.denyGoalIds.includes(primary.id);
	const correctionsLeft = primary.correctionsLeft == null ? 0 : primary.correctionsLeft;
	if (primary._cancelled || denyHit) {
		return { ok: true, state: 'STALLED', stateReason: denyHit ? 'goal_denylisted' : 'cancelled_by_user', watchdogHealth: 'attention', lastProgressAt, stalledForMs, goals, primary, recovery: null, episodePatch: { ...episodePatch, blockedReason: denyHit ? 'goal_denylisted' : 'cancelled_by_user' } };
	}
	if (correctionsLeft <= 0) {
		return { ok: true, state: 'BLOCKED', stateReason: 'corrections_exhausted', watchdogHealth: 'attention', lastProgressAt, stalledForMs, goals, primary, recovery: null, episodePatch: { ...episodePatch, blockedReason: 'corrections_exhausted' } };
	}
	if (episodePatch.correctionsSentInEpisode >= cfg.maxCorrectionsPerEpisode) {
		return { ok: true, state: 'BLOCKED', stateReason: 'episode_recovery_budget_exhausted', watchdogHealth: 'attention', lastProgressAt, stalledForMs, goals, primary, recovery: null, episodePatch: { ...episodePatch, blockedReason: 'episode_recovery_budget_exhausted' } };
	}
	if (episodePatch.correctionsSentToday >= cfg.maxCorrectionsPerDay) {
		return { ok: true, state: 'BLOCKED', stateReason: 'daily_recovery_budget_exhausted', watchdogHealth: 'attention', lastProgressAt, stalledForMs, goals, primary, recovery: null, episodePatch: { ...episodePatch, blockedReason: 'daily_recovery_budget_exhausted' } };
	}
	if (stallPersistedMs < cfg.recoverAfterMs) {
		return { ok: true, state: 'STALLED', stateReason: 'stalled_awaiting_recovery_window', watchdogHealth: 'attention', lastProgressAt, stalledForMs, goals, primary, recovery: null, episodePatch };
	}

	// 发出自动恢复（WATCHDOG:g<gen>:CORRECTION:<seq>；seq 幂等键 = goal+日+episode 序号）
	const seq = 1 + (episodePatch.correctionsSentInEpisode ?? 0);
	const commandId = `WD:g${primary.generation ?? 1}:CORRECTION:${seq}`;
	return {
		ok: true, state: 'RECOVERING', stateReason: 'auto_correction_dispatched', watchdogHealth: 'recovering',
		lastProgressAt, stalledForMs, goals, primary,
		recovery: {
			kind: 'correction',
			commandId,
			generation: primary.generation,
			supervisorGoalId: primary.id,
			sessionId: primary.sessionId,
			text: 'continue',
			mode: 'steer',
		},
		episodePatch: {
			...episodePatch,
			recoverySentAt: now,
			correctionsSentInEpisode: episodePatch.correctionsSentInEpisode + 1,
			correctionsSentToday: episodePatch.correctionsSentToday + 1,
		},
	};
}

export function blankEpisode() {
	return {
		key: null, stallSince: null, confirmations: 0, recoverySentAt: null,
		correctionsSentInEpisode: 0, dayKey: null, correctionsSentToday: 0, blockedReason: null,
	};
}

/**
 * 脱敏 snapshot（Widget / 手机可见的唯一形态）。
 * 白名单字段；禁：prompt/log/session history/evidence 内容/token/路径/密钥。
 * 计费字段：无法可靠获取时一律 'UNAVAILABLE'（T11，零猜测）。
 */
export function sanitizeSnapshot({ now, evaluated, model, pollMs }) {
	const m = model && typeof model === 'object' ? model : {};
	return {
		schemaVersion: SCHEMA_VERSION,
		kind: 'dsh-watchdog-snapshot',
		generatedAt: new Date(now).toISOString(),
		freshness: { policy: 'poll', pollMs: Number(pollMs) || null },
		watchdog: {
			version: WATCHDOG_VERSION,
			health: evaluated?.watchdogHealth ?? 'unknown',
		},
		state: evaluated?.state ?? 'UNKNOWN',
		stateReason: evaluated?.stateReason ?? null,
		task: {
			name: evaluated?.primary?.objective ?? null,
			goalId: evaluated?.primary?.id ?? null,
			sessionId: evaluated?.primary?.sessionId ?? null,
			phase: evaluated?.primary?.goalPhase ?? null,
			generation: evaluated?.primary?.generation ?? null,
			revision: evaluated?.primary?.revision ?? null,
			nextExpectedAction: evaluated?.primary?.nextExpectedAction ?? null,
		},
		progress: {
			lastProgressAt: evaluated?.lastProgressAt ? new Date(evaluated.lastProgressAt).toISOString() : null,
			stalledForMs: Number.isFinite(evaluated?.stalledForMs) ? evaluated.stalledForMs : null,
		},
		model: {
			provider: typeof m.provider === 'string' ? m.provider : 'UNKNOWN',
			model: typeof m.model === 'string' ? m.model : 'UNKNOWN',
			source: typeof m.source === 'string' ? m.source : 'unknown',
		},
		cost: {
			freePaid: 'UNAVAILABLE',
			quota: 'UNAVAILABLE',
			balance: 'UNAVAILABLE',
			resetAt: 'UNAVAILABLE',
			source: 'not_wired_v1_no_second_billing_truth',
		},
		otherGoals: (evaluated?.goals ?? [])
			.filter((g) => g !== evaluated?.primary)
			.slice(0, 10)
			.map((g) => ({ id: g.id, state: g.state, controlState: g.controlState, generation: g.generation, revision: g.revision, updatedAt: g.updatedAt })),
	};
}
