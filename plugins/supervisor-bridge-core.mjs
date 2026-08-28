// supervisor-bridge-core.mjs —— P2.75 Supervisor Bridge 纯函数核心
//
// 设计：docs/roadmap/reports/PHASE_02_75_SUPERVISOR/DESIGN_R1.md
// 原则：零依赖（node 内置 crypto）；不含 IO/网络（由 supervisor-bridge.mjs 编排）；
//       所有变更语义 = 翻译到宿主既有 session.*/goal.* RPC（禁第二权威）。
// 红线：不暴露 shell/write_file 通道；不保存会漂移的运行态（rebind 读时推导）。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const PLUGIN_NAME = 'supervisor-bridge';
export const PLUGIN_VERSION = '0.1.0';
export const MAX_CORRECTIONS = 3;
export const MAX_GOAL_ROUNDS = 64;
export const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
export const CANCEL_ACTIONS = ['pause', 'complete', 'clear'];

// RFC 4122 v5 —— idempotencyKey → 确定性 sessionId（同 key 永远同会话）
// 固定命名空间 UUID（全 hex，P2.75 专用；更换会使旧 receipts 的 sessionId 派生漂移，禁改）
const NS_UUID = '9e5c1a02-3f2a-4d58-9a10-5c1e2b7d0001';

export function uuidV5(name, namespace = NS_UUID) {
	const nsHex = namespace.replace(/-/g, '');
	const nsBytes = Buffer.from(nsHex, 'hex');
	const h = createHash('sha1').update(nsBytes).update(String(name), 'utf8').digest();
	h[6] = (h[6] & 0x0f) | 0x50; // version 5
	h[8] = (h[8] & 0x3f) | 0x80; // variant 10
	const s = h.subarray(0, 16).toString('hex');
	return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

export function deriveSessionId(idempotencyKey) {
	return `session-${uuidV5(`supervisor-goal:${idempotencyKey}`)}`;
}

// 宿主 sessionId 形如 session-<uuid>（实测 2026-08-29）
const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isValidSessionId = (s) => typeof s === 'string' && SESSION_ID_PATTERN.test(s);

// ---------- 校验 ----------

export function validateDispatch(input = {}) {
	const key = input.idempotencyKey;
	if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
		return { ok: false, error: 'invalid_idempotency_key' };
	}
	const objective = input.objective;
	if (typeof objective !== 'string' || objective.trim().length < 4 || objective.length > 8000) {
		return { ok: false, error: 'invalid_objective' };
	}
	let maxGoalRounds;
	if (input.maxGoalRounds !== undefined && input.maxGoalRounds !== null) {
		const n = Number(input.maxGoalRounds);
		if (!Number.isInteger(n) || n < 1 || n > MAX_GOAL_ROUNDS) {
			return { ok: false, error: 'invalid_max_goal_rounds' };
		}
		maxGoalRounds = n;
	}
	if (input.initialInstruction !== undefined && input.initialInstruction !== null
		&& (typeof input.initialInstruction !== 'string' || input.initialInstruction.length > 8000)) {
		return { ok: false, error: 'invalid_initial_instruction' };
	}
	return { ok: true, value: { idempotencyKey: key, objective: objective.trim(), maxGoalRounds, initialInstruction: input.initialInstruction ?? null } };
}

export function validateCorrection(input = {}) {
	if (!isValidSessionId(input?.sessionId)) {
		return { ok: false, error: 'invalid_session_id' };
	}
	if (typeof input?.text !== 'string' || input.text.trim().length === 0 || input.text.length > 8000) {
		return { ok: false, error: 'invalid_text' };
	}
	const mode = input.mode ?? 'steer';
	if (mode !== 'steer' && mode !== 'queue') return { ok: false, error: 'invalid_mode' };
	return { ok: true, value: { sessionId: input.sessionId, text: input.text.trim(), mode } };
}

export function validateCancel(input = {}) {
	if (!isValidSessionId(input?.sessionId)) {
		return { ok: false, error: 'invalid_session_id' };
	}
	const action = input.action ?? 'pause';
	if (!CANCEL_ACTIONS.includes(action)) return { ok: false, error: 'invalid_action' };
	return { ok: true, value: { sessionId: input.sessionId, action } };
}

export function validateSessionQuery(input = {}) {
	if (!isValidSessionId(input?.sessionId)) {
		return { ok: false, error: 'invalid_session_id' };
	}
	return { ok: true, value: { sessionId: input.sessionId } };
}

// ---------- 鉴权（常量时间） ----------

export function checkAuth(header, expectedToken) {
	if (typeof header !== 'string' || typeof expectedToken !== 'string' || expectedToken.length < 32) return false;
	const m = /^Bearer\s+(.+)$/.exec(header.trim());
	if (!m) return false;
	const given = Buffer.from(m[1], 'utf8');
	const want = Buffer.from(expectedToken, 'utf8');
	if (given.length !== want.length) {
		// 长度不等也做一次比较以平滑时序（等长填充，不泄露长度信息）
		timingSafeEqual(given.subarray(0, 1), given.subarray(0, 1));
		return false;
	}
	return timingSafeEqual(given, want);
}

export function generateToken() {
	return randomBytes(32).toString('hex');
}

// ---------- Receipts（持久账本；运行态一律读时推导） ----------

export function newReceipt(key, sessionId, objective, goalRef, now = Date.now()) {
	return {
		key, sessionId, objective,
		goalRef: goalRef ?? null,
		createdAt: now,
		corrections: 0,
		correctionsLeft: MAX_CORRECTIONS,
		status: 'dispatched',
		history: [{ at: now, event: 'dispatched', goalRef: goalRef ?? null }],
	};
}

export function recordCorrection(receipt, text, mode, now = Date.now()) {
	const used = receipt.corrections + 1;
	return {
		...receipt,
		corrections: used,
		correctionsLeft: Math.max(0, MAX_CORRECTIONS - used),
		history: [...receipt.history, { at: now, event: 'correction', mode, text: text.slice(0, 200) }],
	};
}

export function recordCancel(receipt, action, now = Date.now()) {
	return {
		...receipt,
		status: `cancelled:${action}`,
		history: [...receipt.history, { at: now, event: `cancel:${action}` }],
	};
}

/** 纠偏闸门：>= MAX_CORRECTIONS 拒绝 */
export function canCorrect(receipt) {
	const used = receipt?.corrections ?? 0;
	return used < MAX_CORRECTIONS
		? { ok: true, correctionsUsed: used, correctionsLeft: MAX_CORRECTIONS - used }
		: { ok: false, error: 'corrections_exhausted', correctionsUsed: used, correctionsLeft: 0 };
}

/**
 * rebind：以宿主实时投影为准推导 receipt 运行态（桥不保存运行态副本）。
 * projection = session.list 中该会话 projections.values.goal（可为 null）。
 */
export function deriveLiveStatus(receipt, projection) {
	if (!projection || !projection.goal) return { status: 'absent', phase: null };
	const phase = projection.phase ?? projection.goal?.phase ?? null;
	const ref = { id: projection.goal.id, revision: projection.goal.revision };
	if (typeof receipt?.status === 'string' && receipt.status.startsWith('cancelled:')) {
		return { status: receipt.status, phase, ref };
	}
	const map = { active: 'active', paused: 'paused', complete: 'complete', stopped: 'paused' };
	return { status: map[phase] ?? 'active', phase, ref };
}

// ---------- RPC 计划（纯：dispatch 的宿主调用序列） ----------

export function planDispatchSteps(value, sessionId, existingReceipt) {
	if (existingReceipt) return []; // 幂等命中：不重派
	const steps = [
		{ method: 'session.create', payload: { sessionId } },
		{ method: 'goal.create', payload: { sessionId, objective: value.objective } },
	];
	if (value.maxGoalRounds) steps[1].payload.maxGoalRounds = value.maxGoalRounds;
	if (value.initialInstruction) {
		steps.push({
			method: 'session.prompt',
			// mode 'now'：立刻启动 goal worker（'queue' 仅入队不唤醒，见 P2.75 R1 E2E）
			payload: { sessionId, mode: 'now', content: [{ type: 'text', text: value.initialInstruction }] },
		});
	}
	return steps;
}

// ---------- 响应裁剪 ----------

/** get_state 单条：只留元数据，不留内容 */
export function sanitizeStateItem(item = {}) {
	const goal = item.projections?.values?.goal ?? null;
	return {
		sessionId: item.sessionId,
		name: typeof item.name === 'string' ? item.name.slice(0, 120) : null,
		running: !!item.running,
		blank: !!item.blank,
		updatedAt: item.updatedAt ?? null,
		hasGoal: !!goal,
		goalPhase: goal?.phase ?? null,
		roundsStarted: goal?.roundsStarted ?? null,
	};
}

/** get_goal：投影 goal 值 */
export function pickGoalProjection(item = {}) {
	const g = item.projections?.values?.goal;
	if (!g) return { goal: null, phase: null, roundsStarted: null, maxGoalRounds: null, activation: null };
	return {
		goal: g.goal ?? null,
		phase: g.phase ?? null,
		roundsStarted: g.roundsStarted ?? null,
		maxGoalRounds: g.maxGoalRounds ?? null,
		activation: g.activation ?? null,
	};
}

const MEDIA_KEYS = /(image|base64|audio|video|png|jpeg|screenshot|dataUrl|content_bytes)/i;

/** get_evidence：剔除媒体/二进制字段（递归），长字符串截断 */
export function sanitizeEvents(events = []) {
	const strip = (v) => {
		if (Array.isArray(v)) return v.slice(0, 50).map(strip);
		if (v && typeof v === 'object') {
			const out = {};
			for (const [k, val] of Object.entries(v)) {
				if (MEDIA_KEYS.test(k)) { out[k] = '[media-stripped]'; continue; }
				out[k] = typeof val === 'string' && val.length > 2000 ? val.slice(0, 2000) + '…[truncated]' : (val && typeof val === 'object' ? strip(val) : val);
			}
			return out;
		}
		return typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) + '…[truncated]' : v;
	};
	return events.map(strip);
}

// ---------- receipts 序列化（原子写由调用方执行） ----------

export function serializeReceipts(map) {
	return JSON.stringify({ version: 1, savedAt: new Date().toISOString(), receipts: Object.fromEntries(map) }, null, 2);
}

export function deserializeReceipts(text) {
	const parsed = JSON.parse(text);
	if (!parsed || parsed.version !== 1 || typeof parsed.receipts !== 'object' || parsed.receipts === null) {
		throw new Error('invalid_receipts_file');
	}
	return new Map(Object.entries(parsed.receipts));
}
