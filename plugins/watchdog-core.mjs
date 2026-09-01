// watchdog-core.mjs — Phase 02.8 Supervisor Runtime Watchdog（纯函数层，零依赖）
//
// 定位（Notion 02.8）：Supervisor / Official Session / Goal / Router / Runtime 是唯一事实源。
// 本模块只做 PROJECTION（投影），绝不反向成为任务 Authority；不维护第二份任务状态真相。
//
// 输入全部来自既有权威面（supervisor-bridge get_snapshot/get_state + 宿主内 session/event 心跳
// + supervisor-bridge receipts 账本只读推导）；输出为用户可读投影状态与「有界恢复」决策建议。
// 真正执行恢复的永远是既有 bridge 的 /supervisor/send_correction（幂等 commandId + generation
// gate + 预算闸），本层只计算参数。
//
// 状态机（Notion 02.8 §1.2 + §3）：
//   权威投影态：IDLE / RUNNING / STALLED / RECOVERING / AWAITING_REVIEW / BLOCKED / VERIFIED
//   UI 补充态（只读 UI 层专用，不进任务 Authority）：OFFLINE / UNKNOWN
//
// stall 判定铁律（§1.3，R1 修订 2026-08-31）：
//   禁止仅因"超过 X 分钟"判 STALLED。STALLED 必须同时满足：
//   ① 有"明确无 in-flight 工作"的正向证据：会话 running===false（running 缺失/未知 → fail-safe
//      视为可能有 in-flight → RUNNING，绝不判 STALLED）且宿主 session/event 心跳已静默超过
//      stallAfterMs；② 无 pendingMutation；③ 非正常等待（nextExpectedAction 指向 user/review）；
//   ④ 连续 N 次轮询无任何有效进展（进展 = generation/revision/updatedAt 变化 或心跳）。
//   长前台命令/工具执行期间（running===true、无 revision 变化）是"可能仍在工作"，不是 stall。
//   OFFLINE（宿主/桥不可达）永远优先于 STALLED——不可达 ≠ 卡住。
//
// 恢复预算铁律（§1.4，R1 修订）：每日预算 = 从既有 supervisor-bridge receipts 账本
// （~/.dsh/supervisor-bridge/receipts.json，bridge 自管目录，只读）推导的「今日已接受 WD
// correction 数」——只有 bridge 真正执行的（correctionLog 有记录的）才计数；definite 注入失败
// 不消耗预算（幂等 commandId 可安全重试）；ambiguous（发送后结果未知）fail-closed：不重发、
// 转人工观察。重启/换代不丢预算：每轮轮询从账本重新推导，持久化文件仅为交叉核对元数据。

export const SCHEMA_VERSION = 2;
export const WATCHDOG_VERSION = '0.2.0';

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
		maxCorrectionsPerEpisode: 1,      // 单次卡住事件最多自动 correction 数（按已接受计）
		maxCorrectionsPerDay: 3,          // 每自然日（UTC）全局自动 correction 上限（账本推导）
		denyGoalIds: [],                  // 硬拒绝恢复的 goal（如 P3 冻结对象）
		pendingStuckMs: 10 * 60_000,      // pendingMutation 卡死判定（超过 → BLOCKED）
		maxSendFailuresPerEpisode: 2,     // definite 注入失败重试上限（同 commandId 幂等重试）
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
		maxSendFailuresPerEpisode: clampInt(raw.maxSendFailuresPerEpisode, 1, 5, d.maxSendFailuresPerEpisode),
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
 *        pendingMutation, nextExpectedAction, goalPhase, running, runningKnown, updatedAt }
 * runningKnown：session 在场时以 get_state.running 为权威（true）；session 缺失且 row 无
 * running 字段 → false（未知 → 上层 fail-safe 视为可能有 in-flight）。
 */
export function projectRow(row, session, opts = {}) {
	const now = Number(opts.now) || Date.now();
	const cs = row?.currentControlState ?? null;
	const controlState = typeof cs === 'string' ? cs : 'UNKNOWN_CONTROL';
	const runningKnown = session != null || typeof row?.running === 'boolean';
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
		runningKnown,
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

// ---------- R1：bridge receipts 账本只读推导（§1.4 恢复预算权威源） ----------

/**
 * 解析 receipts.json 原文（bridge serializeReceipts 产物，形状宽容）。
 * 返回 { ok, receipts:[{key, correctionLog:[{commandId, at}]}], error }。
 * 任何解析失败 → ok:false（上层 fail-closed：预算视为耗尽，不自动恢复）。
 */
export function parseReceiptsLedger(rawText) {
	if (typeof rawText !== 'string' || rawText.length === 0) {
		return { ok: false, receipts: [], error: 'empty_or_non_string' };
	}
	let parsed;
	try {
		parsed = JSON.parse(rawText);
	} catch (e) {
		return { ok: false, receipts: [], error: `json_parse_failed:${String(e?.message ?? e).slice(0, 80)}` };
	}
	if (!parsed || typeof parsed !== 'object') return { ok: false, receipts: [], error: 'not_object' };
	let list = parsed.receipts;
	if (list && typeof list === 'object' && !Array.isArray(list)) {
		list = Object.values(list); // {key: receipt} 形状
	}
	if (!Array.isArray(list)) return { ok: false, receipts: [], error: 'receipts_not_collection' };
	const out = [];
	for (const r of list) {
		if (!r || typeof r !== 'object') continue;
		const log = Array.isArray(r.correctionLog)
			? r.correctionLog
				.filter((c) => c && typeof c === 'object' && typeof c.commandId === 'string')
				.map((c) => ({ commandId: c.commandId, at: Number.isFinite(Number(c.at)) ? Number(c.at) : null }))
			: [];
		out.push({ key: typeof r.key === 'string' ? r.key : null, correctionLog: log });
	}
	return { ok: true, receipts: out, error: null };
}

/**
 * 统计今日（UTC 自然日）已被 bridge 真正接受的 WD correction 数。
 * ownerPrefix 默认 'WD:'（watchdog 专用 commandId 前缀；DISPATCH/CANCEL/review 不计）。
 * bridge 对同 commandId 幂等重放不产生新 log 条目 → 天然去重。
 */
export function countAcceptedToday(ledger, now = Date.now(), ownerPrefix = 'WD:') {
	const day = dayKeyOf(now);
	const dayStart = Date.parse(`${day}T00:00:00.000Z`);
	const dayEnd = dayStart + 24 * 3600_000;
	let count = 0;
	for (const r of (ledger?.receipts ?? [])) {
		for (const c of (r?.correctionLog ?? [])) {
			if (typeof c.commandId !== 'string' || !c.commandId.startsWith(ownerPrefix)) continue;
			const at = Number(c.at);
			if (!Number.isFinite(at)) continue;
			if (at >= dayStart && at < dayEnd) count += 1;
		}
	}
	return count;
}

/**
 * 预算推导（每轮轮询调用）。账本不可读 → fail-closed：left=0（本轮不自动恢复，绝不猜）。
 * persistedMeta：本地交叉核对元数据（budget.json；不作为权威，仅记录 source 与一致性告警输入）。
 */
export function deriveBudget({ ledgerText, cfg, now = Date.now(), ledgerState = 'OK' }) {
	const dayKey = dayKeyOf(now);
	const parsed = parseReceiptsLedger(ledgerText);
	if (!parsed.ok) {
		return {
			dayKey, acceptedToday: null, maxPerDay: cfg.maxCorrectionsPerDay, left: 0,
			source: 'supervisor_receipt_ledger', ledgerState: `unreadable:${parsed.error}`,
			failClosed: true,
		};
	}
	const acceptedToday = countAcceptedToday(parsed, now);
	return {
		dayKey,
		acceptedToday,
		maxPerDay: cfg.maxCorrectionsPerDay,
		left: Math.max(0, cfg.maxCorrectionsPerDay - acceptedToday),
		source: 'supervisor_receipt_ledger',
		ledgerState,
		failClosed: false,
	};
}

/**
 * R1：发送结果三分类 → episode 修补（纯函数；host 在 send_correction 返回后调用）。
 * outcome.kind:
 *   'accepted'         — bridge 明确接受（ok:true, accepted:true）→ 计入 episode + 恢复观察窗
 *   'duplicate'        — bridge 幂等命中（duplicate:true）→ 视同已发送（记账，不重复副作用）
 *   'definite_failure' — 明确未执行（连接拒绝/4xx/5xx 非 ambiguous；bridge 回滚 pending）→
 *                        不消耗预算；同 commandId 幂等重试，超限 → 转人工
 *   'ambiguous'        — 发送后结果未知（超时/连接中断；bridge 已置 pendingMutation fail-closed）
 *                        → 不重发、记 ambiguous，等待 bridge reconcile 或人工
 */
export function applySendOutcome(episode, outcome, opts = {}) {
	const now = Number(opts.now) || Date.now();
	const maxFailures = Number.isFinite(opts.maxSendFailuresPerEpisode) ? opts.maxSendFailuresPerEpisode : 2;
	const ep = { ...(episode ?? blankEpisode()) };
	const kind = outcome?.kind;
	if (kind === 'accepted' || kind === 'duplicate') {
		return {
			...ep,
			recoverySentAt: now,
			correctionsSentInEpisode: (ep.correctionsSentInEpisode ?? 0) + 1,
			lastSendError: null,
			sendFailures: 0,
			ambiguousSince: null,
			ambiguousCommandId: null,
			blockedReason: null,
		};
	}
	if (kind === 'definite_failure') {
		const failures = (ep.sendFailures ?? 0) + 1;
		return {
			...ep,
			sendFailures: failures,
			lastSendError: oneLine(outcome?.error ?? 'unknown', 120),
			// 超限 → 转人工（不再自动重试；预算未消耗）
			blockedReason: failures >= maxFailures ? 'recovery_send_failed' : null,
		};
	}
	if (kind === 'ambiguous') {
		return {
			...ep,
			ambiguousSince: now,
			ambiguousCommandId: typeof outcome?.commandId === 'string' ? outcome.commandId : (ep.ambiguousCommandId ?? null),
			lastSendError: oneLine(outcome?.error ?? 'ambiguous', 120),
			recoverySentAt: now, // 观察窗语义一致：窗内不重发
			blockedReason: null,
		};
	}
	return ep;
}

/**
 * 汇总评估（每轮轮询调用一次）。
 * input = { now, cfg, bridgeOk, snapshot, heartbeats: {sessionId: lastEventAt}, prev, episode, budget }
 *   prev     : 上轮 sanitizeSnapshot 结果（用于进展指纹对比）
 *   episode  : { key, stallSince, confirmations, recoverySentAt, correctionsSentInEpisode,
 *                sendFailures, ambiguousSince, ambiguousCommandId, dayKey, blockedReason }
 *   budget   : deriveBudget() 输出（账本推导；缺省 → fail-closed 视为耗尽）
 * 返回 { ok, state, stateReason, watchdogHealth, lastProgressAt, stalledForMs,
 *        goals:[projection], primary, recovery, episodePatch }
 */
export function evaluate(input = {}) {
	const now = Number(input.now) || Date.now();
	const cfg = normalizeConfig(input.cfg);
	const heartbeats = input.heartbeats && typeof input.heartbeats === 'object' ? input.heartbeats : {};
	const budget = input.budget && typeof input.budget === 'object'
		? input.budget
		: { dayKey: dayKeyOf(now), acceptedToday: null, maxPerDay: cfg.maxCorrectionsPerDay, left: 0, source: 'missing_fail_closed', failClosed: true };

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

	// ---- R1 B4 fail-safe：明确无 in-flight 工作才允许 stall 确认 ----
	// running===true（turn/工具执行中，含长前台命令）→ 可能仍在工作 → RUNNING，绝不判 STALLED。
	// running 未知（session 缺失且 row 无该字段）→ fail-safe 同上。
	// running===false 但心跳仍新（< stallAfterMs）→ 有近期活动 → RUNNING。
	const inFlight = primary.running || !primary.runningKnown;
	const hbFresh = hb > 0 && (now - hb) < cfg.stallAfterMs;
	if (inFlight) {
		return {
			ok: true, state: 'RUNNING',
			stateReason: primary.running ? 'in_flight_work_failsafe' : 'in_flight_unknown_failsafe',
			watchdogHealth: 'healthy', lastProgressAt, stalledForMs, goals, primary, recovery: null,
			episodePatch: blankEpisode(),
		};
	}
	if (hbFresh) {
		return {
			ok: true, state: 'RUNNING', stateReason: 'recent_host_activity',
			watchdogHealth: 'healthy', lastProgressAt: Math.max(lastProgressAt, hb), stalledForMs,
			goals, primary, recovery: null, episodePatch: blankEpisode(),
		};
	}

	// 无进展 + 明确空闲 → stall 候选；确认次数累计
	const noProgress = stalledForMs >= cfg.stallAfterMs;
	const confirmations = noProgress ? (Number.isInteger(ep.confirmations) ? ep.confirmations + 1 : 1) : 0;
	let episodePatch = {
		key: `${primary.id ?? primary.sessionId}`,
		stallSince: noProgress ? (Number.isFinite(ep.stallSince) ? ep.stallSince : now) : null,
		confirmations,
		recoverySentAt: ep.recoverySentAt ?? null,
		correctionsSentInEpisode: ep.correctionsSentInEpisode ?? 0,
		sendFailures: ep.sendFailures ?? 0,
		ambiguousSince: ep.ambiguousSince ?? null,
		ambiguousCommandId: ep.ambiguousCommandId ?? null,
		dayKey: dayKeyOf(now),
		blockedReason: null,
	};

	const stalledConfirmed = noProgress && confirmations >= cfg.stallConfirmations;
	if (!stalledConfirmed) {
		return {
			ok: true, state: 'RUNNING', stateReason: noProgress ? 'stall_candidate_pending_confirmation' : 'idle_no_progress_pending_confirmation',
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

	// ambiguous 未决（发送后结果未知）→ fail-closed：不重发、转人工观察
	if (ep.ambiguousSince) {
		return {
			ok: true, state: 'STALLED', stateReason: 'recovery_outcome_ambiguous', watchdogHealth: 'attention',
			lastProgressAt, stalledForMs, goals, primary, recovery: null,
			episodePatch: { ...episodePatch, blockedReason: 'recovery_outcome_ambiguous' },
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
	// 等待恢复窗（尚未到可发送时长）→ STALLED；先于预算判定（此时不存在发送，预算闸无意义）
	if (stallPersistedMs < cfg.recoverAfterMs) {
		return { ok: true, state: 'STALLED', stateReason: 'stalled_awaiting_recovery_window', watchdogHealth: 'attention', lastProgressAt, stalledForMs, goals, primary, recovery: null, episodePatch };
	}
	// 每日预算 = 账本推导（已接受计数）；fail-closed / 耗尽 → BLOCKED
	if (budget.failClosed || (Number.isFinite(budget.left) && budget.left <= 0)) {
		return { ok: true, state: 'BLOCKED', stateReason: budget.failClosed ? 'daily_budget_ledger_unreadable_fail_closed' : 'daily_recovery_budget_exhausted', watchdogHealth: 'attention', lastProgressAt, stalledForMs, goals, primary, recovery: null, episodePatch: { ...episodePatch, blockedReason: budget.failClosed ? 'daily_budget_ledger_unreadable_fail_closed' : 'daily_recovery_budget_exhausted' } };
	}
	// definite 注入失败重试上限（同 commandId 幂等重试；超限转人工，预算未消耗）
	if ((episodePatch.sendFailures ?? 0) >= cfg.maxSendFailuresPerEpisode) {
		return { ok: true, state: 'BLOCKED', stateReason: 'recovery_send_failed', watchdogHealth: 'attention', lastProgressAt, stalledForMs, goals, primary, recovery: null, episodePatch: { ...episodePatch, blockedReason: 'recovery_send_failed' } };
	}

	// 发出自动恢复（WD:g<gen>:CORRECTION:<seq>；seq = 1 + episode 内已接受数 →
	// definite 失败不推进 seq → 同 commandId 幂等重试）
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
		// 注意：此处不预记账数——host 拿到 bridge 明确结果后经 applySendOutcome 记账
		episodePatch,
	};
}

export function blankEpisode() {
	return {
		key: null, stallSince: null, confirmations: 0, recoverySentAt: null,
		correctionsSentInEpisode: 0, sendFailures: 0, ambiguousSince: null, ambiguousCommandId: null,
		dayKey: null, blockedReason: null,
	};
}

/**
 * R1 B2：模型真值规范化。运行时权威面（每 turn 实际所用模型）在宿主无只读权威端点、
 * sessions/** 又是 watchdog 红线 → actual 恒为 UNKNOWN（零猜测）；default 来自
 * settings.agent-default-model（配置级事实，来源标注）。绝不把 default 伪装成 actual。
 */
export function normalizeModelTruth(raw = {}) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const dflt = r.default && typeof r.default === 'object' ? r.default : r;
	return {
		actual: {
			provider: r.actual?.provider ?? 'UNKNOWN',
			model: r.actual?.model ?? 'UNKNOWN',
			source: r.actual?.source ?? 'runtime_authority_unavailable_v1',
		},
		default: {
			provider: typeof dflt.provider === 'string' && dflt.provider ? dflt.provider : 'UNKNOWN',
			model: typeof dflt.model === 'string' && dflt.model ? dflt.model : 'UNKNOWN',
			source: typeof dflt.source === 'string' && dflt.source ? dflt.source : 'settings.agent-default-model',
		},
		displayRule: 'actual_unavailable_shows_unknown',
	};
}

/**
 * 脱敏 snapshot（Widget / 手机可见的唯一形态）。
 * 白名单字段；禁：prompt/log/session history/evidence 内容/token/路径/密钥。
 * 计费字段：无法可靠获取时一律 'UNAVAILABLE'（T11，零猜测）。
 * push 块：SSE 事件通道元信息（只推 wake/revision/event-id，不推内容）。
 */
export function sanitizeSnapshot({ now, evaluated, model, pollMs, budget, tasks, terminalCachePatch }) {
	const m = normalizeModelTruth(model);
	const b = budget && typeof budget === 'object' ? budget : null;
	// R4：多任务投影。host 传入 projectTasks 结果（主入口已计算排序+冻结）；缺省回退为旧
	// single-task + otherGoals 兼容形态（v1 Widget / schemaVersion=2 消费方按字段名读取）。
	const taskRows = Array.isArray(tasks) ? tasks : null;
	const primaryTask = taskRows?.[0] ?? null;
	return {
		schemaVersion: SCHEMA_VERSION,
		kind: 'dsh-watchdog-snapshot',
		generatedAt: new Date(now).toISOString(),
		// R2（External Review B）：freshness 策略 = 30min 兜底轮询 + 服务端 FCM push 即时唤醒；
		// SSE 前台长连接已被移除（常驻前台服务违背最小权限/最省电目标）。
		freshness: { policy: 'poll+fcm', pollMs: Number(pollMs) || null, push: 'fcm-data-message' },
		watchdog: {
			version: WATCHDOG_VERSION,
			health: evaluated?.watchdogHealth ?? 'unknown',
		},
		state: evaluated?.state ?? 'UNKNOWN',
		stateReason: evaluated?.stateReason ?? null,
		// R4：一等多任务投影（§4）。已按 §6 排序，完成时间已按 §7 冻结。
		tasks: taskRows,
		task: {
			name: primaryTask?.title ?? evaluated?.primary?.objective ?? null,
			goalId: primaryTask?.goalId ?? evaluated?.primary?.id ?? null,
			sessionId: primaryTask?.sessionId ?? evaluated?.primary?.sessionId ?? null,
			phase: evaluated?.primary?.goalPhase ?? null,
			generation: primaryTask?.generation ?? evaluated?.primary?.generation ?? null,
			revision: primaryTask?.revision ?? evaluated?.primary?.revision ?? null,
			nextExpectedAction: primaryTask?.currentStep ?? evaluated?.primary?.nextExpectedAction ?? null,
			state: primaryTask?.state ?? null,
			lastProgressAt: primaryTask?.lastProgressAt ? new Date(primaryTask.lastProgressAt).toISOString() : null,
		},
		progress: {
			lastProgressAt: evaluated?.lastProgressAt ? new Date(evaluated.lastProgressAt).toISOString() : null,
			stalledForMs: Number.isFinite(evaluated?.stalledForMs) ? evaluated.stalledForMs : null,
		},
		model: m,
		recoveryBudget: {
			dayKey: b?.dayKey ?? dayKeyOf(now),
			acceptedToday: Number.isFinite(b?.acceptedToday) ? b.acceptedToday : null,
			maxPerDay: Number.isFinite(b?.maxPerDay) ? b.maxPerDay : null,
			left: Number.isFinite(b?.left) ? b.left : null,
			source: typeof b?.source === 'string' ? b.source : 'missing_fail_closed',
			failClosed: !!b?.failClosed,
		},
		// R2（External Review B）：手机侧推送通道 = FCM data-message（载荷仅 eventId/revision/wake
		// 白名单元数据；客户端收到后自行拉取 /watchdog/status）。channel 保留 'sse' 字符串仅为
		// schema 兼容（v1 Widget/schemaVersion=2 消费方按字段名读取），path 指向语义等价的
		// status 快照路由；桌面侧 SSE 端点已随本改造移除。
		push: { channel: 'sse', path: '/watchdog/status', events: 'fcm_state_change', heartbeatSec: 0, fcm: true },
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

// ---------- R2（External Review B）：FCM 推送元数据构造（纯函数；密钥绝不入此层） ----------
// 与 R1 SSE 载荷同一白名单哲学：只给「有变化，来拉」所需的最小元数据（eventId/revision/
// wake），不给 state 文本、不给内容。Widget 收到后自行 GET /watchdog/status（同一 token）。
// data-message（非 notification）：Android 10+ 无 POST_NOTIFICATIONS 授权也能收到，
// 不产生系统通知横幅，纯唤醒信号。
export function buildFcmPushPayload({ evaluated, eventId }) {
	const seq = Number.isFinite(Number(eventId)) ? Number(eventId) : 0;
	return {
		v: 1,
		ev: 'state_change',
		eid: `fcm-${seq}`,
		rev: evaluated?.primary?.revision ?? null,
		gen: evaluated?.primary?.generation ?? null,
		wake: true,
		ts: new Date().toISOString(),
	};
}

// 构造 FCM HTTP v1 请求体（project 接收端；data 字段值必须全为字符串）。
export function buildFcmRequest({ projectId, payload }) {
	if (typeof projectId !== 'string' || !/^[a-z0-9-]{6,63}$/.test(projectId)) {
		return { ok: false, error: 'invalid_project_id' };
	}
	if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid_payload' };
	const data = {};
	for (const [k, val] of Object.entries(payload)) data[k] = String(val ?? '');
	return {
		ok: true,
		url: `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
		body: { message: { topic: 'watchdog', data, android: { priority: 'HIGH', ttl: '900s' } } },
	};
}

// =================================================================================
// R2.5 (R4): MULTI-TASK MONITOR PROJECTION  —— 真正的一等多任务投影 tasks[]
// 定位（Notion 02.8 R4 §4-§9）：把 task + otherGoals 升级为一等 tasks[]。
//   纯函数；从既有权威面（Official Session/Goal + Supervisor state + 现有 progress-signal）
//   组合推导，绝不反向成为 Task Authority，绝不建第二 Task DB / Task Engine，不复制
//   prompt / session history / evidence 内容。
// UI 任务状态（§5）：RUNNING / STALLED / WAITING_USER / RECOVERING / AWAITING_REVIEW /
//   BLOCKED / COMPLETED(VERIFIED) / FAILED / PAUSED / UNKNOWN。OFFLINE 是主机/数据源态，
//   不是任务态。STALLED 必须复用现有 progress-signal，且 per-task（任务 A 无进展不影响 B）。
// 排序（§6）：RUNNING > RECOVERING > WAITING_USER > STALLED > BLOCKED > AWAITING_REVIEW
//   > 最近终态。真正 running Session 必须排在旧 AWAITING_REVIEW Goal 前面。
// Widget 默认：3 当前 + 1 最近完成，超出显示「还有 N 个任务」。
// 完成时间冻结（§7）：进入真实终态后冻结 completedAt/finalDuration，用 canonical 终态
//   时间戳，否则 firstObservedTerminalAt 薄 telemetry cache（一旦冻结不得随刷新漂移，
//   timeSource 标注，非 Task Authority，可安全重建，不存任务正文）。
// 最近进展（§8）：优先可信 progress signal（session.updatedAt / 心跳），禁止用 HTTP fetch
//   time / widget refresh time 冒充任务进展；currentStep 次级，无可靠来源则隐藏。
// =================================================================================

// task-state enum + UI 排序 rank（§5 + §6）
export const TASK_UI_STATES = Object.freeze([
	'RUNNING', 'STALLED', 'WAITING_USER', 'RECOVERING', 'AWAITING_REVIEW', 'BLOCKED',
	'COMPLETED', 'VERIFIED', 'FAILED', 'PAUSED', 'UNKNOWN',
]);
const TASK_UI_RANK = Object.freeze({
	RUNNING: 0, RECOVERING: 1, WAITING_USER: 2, STALLED: 3, BLOCKED: 4,
	AWAITING_REVIEW: 5, COMPLETED: 6, VERIFIED: 6, FAILED: 6, PAUSED: 7, UNKNOWN: 8,
});
// 真实终态集合（§7：这些进入后必须冻结 completedAt/finalDuration）
export const TASK_TERMINAL = Object.freeze(new Set(['VERIFIED', 'BLOCKED', 'COMPLETED', 'FAILED']));

/**
 * 读取一行 goal 的 startedAt（canonical = row.createdAt；缺失 → null，上层自行决定是否显示 duration）。
 */
function taskStartedAt(row) {
	const at = Number(row?.createdAt);
	return Number.isFinite(at) ? at : null;
}

/**
 * §8 最新进展信号：取权威信号最大值（goal.updatedAt / session.updatedAt / 宿主心跳），
 * 明确禁止用 now（绝不拿 HTTP fetch / widget refresh time 冒充任务进展）。
 */
function lastProgressSignal(base, session, hb) {
	const signals = [
		Number.isFinite(base?.updatedAt) ? base.updatedAt : null,
		Number.isFinite(session?.updatedAt) ? session.updatedAt : null,
		Number.isFinite(hb) && hb > 0 ? hb : null,
	].filter((n) => n != null);
	return signals.length ? Math.max(...signals) : null;
}

/**
 * per-task stall 分类（§5 铁律：复用现有 progress-signal，非纯时长；per-task 独立）。
 *   base            : projectRow 输出（含 state / running / runningKnown / updatedAt / nextExpectedAction）
 *   session         : sanitizeStateItem 或 null
 *   hb              : 宿主 session/event 心跳最近时间（ms）；0/缺失 → 无
 *   inFlightFailsafe: 该任务是否为「当前主任务」（沿用 evaluate 的 fail-safe 语义）
 * 返回 { state, stalledForMs, lastProgressAt, progressSignal }
 * 注意：本分类器是「只读投影（Widget 展示）」；真正的恢复决策/确认计数仍由 evaluate() 权威完成。
 */
export function classifyTaskState(base, { now, cfg, session, hb = 0, inFlightFailsafe = false }) {
	const nowMs = Number(now) || Date.now();
	const c = normalizeConfig(cfg);
	const b = base && typeof base === 'object' ? base : {};
	const state0 = typeof b.state === 'string' ? b.state : 'UNKNOWN';

	// 非 active 态（VERIFIED / BLOCKED / AWAITING_REVIEW / RECOVERING / UNKNOWN）：
	// 直接沿用投影态，永不算 stall，不动 progress 语义（与 evaluate §⑤ 同哲学）。
	if (!['RUNNING', 'WAITING_USER'].includes(state0)) {
		const lp = Number.isFinite(b.updatedAt) ? b.updatedAt : null;
		return { state: state0, stalledForMs: null, lastProgressAt: lp, progressSignal: null };
	}

	// active 态：先看是否正常等待（等待 ≠ 卡住，§5）
	if (isNormalWait(b)) {
		const lp = Number.isFinite(b.updatedAt) ? b.updatedAt : null;
		return { state: 'WAITING_USER', stalledForMs: Math.max(0, nowMs - (lp || nowMs)), lastProgressAt: lp, progressSignal: null };
	}

	// 进展信号（§8）：取权威信号最大值（updatedAt / session.updatedAt / 心跳），禁止用 now。
	const lp = lastProgressSignal(b, session, hb);
	const stalledForMs = Number.isFinite(lp) ? Math.max(0, nowMs - lp) : null;

	// fail-safe：running 未知/在场 → 可能仍有 in-flight（长前台命令）→ RUNNING，绝不猜 STALLED。
	const inFlight = b.running || !b.runningKnown;
	const hbFresh = hb > 0 && (nowMs - hb) < c.stallAfterMs;
	if (!inFlightFailsafe && (inFlight || hbFresh)) {
		return { state: 'RUNNING', stalledForMs, lastProgressAt: lp, progressSignal: lp };
	}
	// 无进展 + 明确空闲 + 超出阈值 → STALLED；否则 RUNNING（含候选但未确认）。
	const noProgress = Number.isFinite(stalledForMs) && stalledForMs >= c.stallAfterMs;
	return {
		state: noProgress ? 'STALLED' : 'RUNNING',
		stalledForMs, lastProgressAt: lp, progressSignal: lp,
	};
}

/**
 * 单任务投影（§4 字段集）。
 * taskId = goal 的 supervisorGoalId（goal 级任务身份，沿用 Authority）；sessionId/goalId 单列。
 * terminal=true → 需冻结 completedAt/finalDuration。source 标注推导来源（不隐藏，§7 timeSource 需溯源）。
 */
function projectTask(row, session, opts) {
	const b = projectRow(row, session, opts);
	const nowMs = Number(opts.now) || Date.now();
	const cf = classifyTaskState(b, opts);
	const startedAt = taskStartedAt(row);
	const controlState = b.controlState ?? null;
	const terminal = TASK_TERMINAL.has(cf.state) || ['VERIFIED', 'BLOCKED', 'CANCELLED'].includes(controlState);
	const completedAt = terminal
		? (opts.terminalCache?.[b.id]?.completedAt ?? null)
		: null;
	const durationMs = Number.isFinite(startedAt)
		? (completedAt != null ? Math.max(0, completedAt - startedAt) : Math.max(0, nowMs - startedAt))
		: null;
	return {
		taskId: b.id,
		sessionId: b.sessionId,
		goalId: b.id,
		title: b.objective,
		state: cf.state,
		// 完成冻结：completedAt/finalDuration 由 projectTasks 的 terminal cache 写入（一经冻结不漂移）；
		// 此处仅占位，避免单任务路径出现「自己算自己」的漂移。
		completedAt,
		finalDurationMs: terminal ? durationMs : null,
		startedAt,
		lastProgressAt: cf.lastProgressAt,
		currentStep: b.nextExpectedAction ?? null,
		reviewState: controlState,
		waitingReason: b.nextExpectedAction || null,
		terminal,
		source: 'supervisor_goal',
		updatedAt: b.updatedAt,
		generation: b.generation,
		revision: b.revision,
		internal: { running: b.running, runningKnown: b.runningKnown, stalls: cf.stalledForMs },
	};
}

/**
 * 多任务投影（§4/§6/§7 主入口。纯函数；terminal cache 由 host 持有并往返传入传出）。
 *   input = { now, cfg, snapshot, heartbeats, terminalCache?, primaryId? }
 *   snapshot  : supervisor get_snapshot（同上 evaluate 输入）
 *   heartbeats: { sessionId: lastEventAt }
 *   terminalCache: { [taskId]: { completedAt, timeSource } } —— 上一轮冻结结果（薄 telemetry）
 * 返回 { tasks:[...ordered], primaryTaskId, terminalCachePatch:{...}, overflow }
 *   tasks 已按 §6 排序；terminalCachePatch 需 host 持久化并在下一轮回传（一旦冻结不漂移）。
 */
export function projectTasks({ now, cfg, snapshot, heartbeats = {}, terminalCache = {}, primaryId = null }) {
	const c = normalizeConfig(cfg);
	const nowMs = Number(now) || Date.now();
	const sessionsBySid = new Map((Array.isArray(snapshot?.sessions) ? snapshot.sessions : []).map((s) => [s.sessionId, s]));
	const tc = { ...terminalCache };

	const tasks = (snapshot?.supervisorGoals ?? [])
		.map((row) => {
			const session = sessionsBySid.get(row.harnessSessionId) ?? null;
			const b = projectRow(row, session, { now: nowMs });
			return { row, session, b };
		})
		.map(({ row, session, b }) => projectTask(row, session, {
			now: nowMs, cfg: c, hb: heartbeats[b.sessionId] ?? 0,
			terminalCache: tc,
			inFlightFailsafe: b.id === primaryId,
		}));

	// §7 完成时间冻结：terminal 任务若无 canonical 终态时间戳 → firstObservedTerminalAt；一经冻结永不漂移。
	for (const t of tasks) {
		if (!t.terminal) continue;
		if (Number.isFinite(t.completedAt)) continue; // 已冻结，保持
		const frozen = tc[t.taskId];
		if (frozen && Number.isFinite(frozen.completedAt)) {
			t.completedAt = frozen.completedAt;
		} else {
			t.completedAt = nowMs;
			tc[t.taskId] = { completedAt: nowMs, timeSource: 'firstObservedTerminalAt' };
		}
		t.finalDurationMs = Number.isFinite(t.startedAt) ? Math.max(0, t.completedAt - t.startedAt) : null;
	}
	// 非终态任务：清除其 terminal cache 条目（防止旧冻结残留导致误展示）
	for (const t of tasks) {
		if (!t.terminal && tc[t.taskId]) delete tc[t.taskId];
	}

	// §6 排序：rank 优先；同 rank 内 running 优先；再按 lastProgressAt 新→旧。
	const rank = (t) => TASK_UI_RANK[t.state] ?? TASK_UI_RANK.UNKNOWN;
	const ordered = tasks.slice().sort((a, z) => {
		const ra = rank(a), rz = rank(z);
		if (ra !== rz) return ra - rz;
		if ((a.internal.running ? 1 : 0) !== (z.internal.running ? 1 : 0)) {
			return (a.internal.running ? 1 : 0) - (z.internal.running ? 1 : 0);
		}
		const ta = Number.isFinite(a.lastProgressAt) ? a.lastProgressAt : 0;
		const tz = Number.isFinite(z.lastProgressAt) ? z.lastProgressAt : 0;
		return tz - ta;
	});

	const primaryTaskId = primaryId ?? ordered[0]?.taskId ?? null;
	const overflow = Math.max(0, ordered.length - 4); // 3 当前 + 1 最近完成
	return { tasks: ordered, primaryTaskId, terminalCachePatch: tc, overflow };
}
