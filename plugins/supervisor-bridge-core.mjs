// supervisor-bridge-core.mjs —— P2.75 Supervisor Bridge 纯函数核心（R1.1 + R1.2）
//
// 设计：docs/roadmap/reports/PHASE_02_75_SUPERVISOR/DESIGN_R1.md（R1 冻结基础）
//       + R1.1 Round2 closure：mutation replay safety / minimal lifecycle /
//         structured evidence bundle / resumable snapshot。
//       + R1.2 Round3 closure（唯一 Blocker：DISPATCH IDEMPOTENCY PAYLOAD IDENTITY）：
//         dispatchFingerprint = canonical dispatch contract 的 SHA-256 指纹。
//         同 idempotencyKey 重放必须与账本指纹一致（exact replay 才幂等）；
//         payload 不同 → 409 idempotency_conflict；legacy 无指纹 → fail-closed。
// 原则：零依赖（node 内置 crypto）；不含 IO/网络（由 supervisor-bridge.mjs 编排）；
//       所有变更语义 = 翻译到宿主既有 session.*/goal.* RPC（禁第二权威）。
// 红线：不暴露 shell/write_file 通道；不保存会漂移的运行态（rebind 读时推导）；
//       不依赖 Date.now() 作为幂等身份（commandId 必须稳定可重放）。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const PLUGIN_NAME = 'supervisor-bridge';
export const PLUGIN_VERSION = '0.2.2';
export const MAX_CORRECTIONS = 3;
export const MAX_GOAL_ROUNDS = 64;
export const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
export const CANCEL_ACTIONS = ['pause', 'complete', 'clear'];

// R1.1 —— mutation identity / lifecycle / evidence 常量
export const SUPERVISOR_GOAL_ID_PATTERN = /^sg-[A-Za-z0-9_-]{4,120}$/;
// <owner>:g<generation>:<KIND>:<seq>（§4 推荐 contract；owner 建议 = supervisorGoalId）
export const COMMAND_ID_PATTERN = /^([A-Za-z0-9_-]{1,100}):g(\d{1,9}):(CORRECTION|CANCEL|REVIEW):(\d{1,9})$/;
export const COMMAND_KINDS = ['CORRECTION', 'CANCEL', 'REVIEW'];
export const REVIEW_VERDICTS = ['PASS', 'FAIL'];
export const CONTROL_STATES = ['CREATED', 'DISPATCHED', 'RUNNING', 'AWAITING_REVIEW', 'CORRECTING', 'BLOCKED', 'VERIFIED', 'CANCELLED'];
export const TERMINAL_CONTROL_STATES = ['BLOCKED', 'VERIFIED', 'CANCELLED'];
export const EVIDENCE_LABELS = ['REAL', 'CONTROLLED', 'SYNTHETIC', 'INFERRED', 'REPORTED REAL', 'PARTIAL'];
export const MAX_ACCEPTANCE_ITEMS = 12;
export const RECEIPT_SCHEMA = 2;

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

// R1.1：稳定派生身份（无歧义重建的最小映射来源；不使用 Date.now()）
export function deriveSupervisorGoalId(idempotencyKey) {
	return `sg-${uuidV5(`supervisor-goal-id:${idempotencyKey}`)}`;
}
export function deriveRunId(idempotencyKey, generation) {
	return `run-g${generation}-${uuidV5(`supervisor-run:${idempotencyKey}:g${generation}`)}`;
}
export function deriveEvidenceId(supervisorGoalId, generation, revision) {
	return `ev-${supervisorGoalId}-g${generation}-r${revision}`;
}

// 宿主 sessionId 形如 session-<uuid>（实测 2026-08-29）
const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isValidSessionId = (s) => typeof s === 'string' && SESSION_ID_PATTERN.test(s);

export function sha256Hex(text) {
	return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// ---------- 校验 ----------

function validateAcceptanceCriteria(raw) {
	if (raw === undefined || raw === null) return { ok: true, value: null };
	if (!Array.isArray(raw)) return { ok: false, error: 'invalid_acceptance_criteria' };
	if (raw.length < 1 || raw.length > MAX_ACCEPTANCE_ITEMS) return { ok: false, error: 'invalid_acceptance_criteria' };
	const out = [];
	for (const item of raw) {
		if (typeof item !== 'string') return { ok: false, error: 'invalid_acceptance_criteria' };
		const t = item.trim();
		if (t.length < 1 || t.length > 500) return { ok: false, error: 'invalid_acceptance_criteria' };
		out.push(t);
	}
	return { ok: true, value: out };
}

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
	// R1.1 §4：supervisorGoalId 可显式传入；缺省由 idempotencyKey 确定性派生（同 key 恒同 id）。
	let supervisorGoalId = null;
	if (input.supervisorGoalId !== undefined && input.supervisorGoalId !== null) {
		if (typeof input.supervisorGoalId !== 'string' || !SUPERVISOR_GOAL_ID_PATTERN.test(input.supervisorGoalId)) {
			return { ok: false, error: 'invalid_supervisor_goal_id' };
		}
		supervisorGoalId = input.supervisorGoalId;
	}
	// R1.1 §4：dispatch 的 generation 恒为 1；显式传入其他值 = 契约违反。
	if (input.generation !== undefined && input.generation !== null && Number(input.generation) !== 1) {
		return { ok: false, error: 'invalid_generation' };
	}
	const ac = validateAcceptanceCriteria(input.acceptanceCriteria);
	if (!ac.ok) return ac;
	return {
		ok: true,
		value: {
			idempotencyKey: key,
			objective: objective.trim(),
			maxGoalRounds,
			initialInstruction: input.initialInstruction ?? null,
			supervisorGoalId: supervisorGoalId ?? deriveSupervisorGoalId(key),
			generation: 1,
			acceptanceCriteria: ac.value,
		},
	};
}

// ---------- R1.2 dispatch 指纹（payload identity；External Review Round 3 唯一 Blocker） ----------
//
// dispatchFingerprint = SHA-256(JSON.stringify(canonicalDispatchContract))。
// 覆盖语义派发输入全集（§4）：objective / initialInstruction / maxGoalRounds /
// acceptanceCriteria（保序，语义数组）/ supervisorGoalId / generation。
// 不含任何时间戳 / runId / sessionId / revision / PID / 端口 / 随机值 / optional 挂载（§3）。
// canonical 序列化 = 固定 key 顺序的对象字面量 + JSON.stringify（确定性；无 undefined）。
// 表示噪声不产生假冲突（§4）：objective/acceptanceCriteria 已由 validateDispatch trim，
// initialInstruction 此处仅 trim 归一（不改实际派发语义——planDispatchSteps 用原始值），
// maxGoalRounds 缺省/null 统一为 null。

export function canonicalDispatchContract(value) {
	return {
		objective: String(value?.objective ?? ''),
		initialInstruction: typeof value?.initialInstruction === 'string' ? value.initialInstruction.trim() : null,
		maxGoalRounds: Number.isInteger(value?.maxGoalRounds) ? value.maxGoalRounds : null,
		acceptanceCriteria: Array.isArray(value?.acceptanceCriteria) ? value.acceptanceCriteria.slice() : null,
		supervisorGoalId: value?.supervisorGoalId ?? null,
		generation: value?.generation ?? 1,
	};
}

export function dispatchFingerprintOf(value) {
	return createHash('sha256').update(JSON.stringify(canonicalDispatchContract(value)), 'utf8').digest('hex');
}

// ---------- commandId / generation（R1.1 §4-6） ----------

export function parseCommandId(commandId) {
	if (typeof commandId !== 'string') return null;
	const m = COMMAND_ID_PATTERN.exec(commandId);
	if (!m) return null;
	return { owner: m[1], generation: Number(m[2]), kind: m[3], seq: Number(m[4]) };
}

/** commandId 内嵌 generation 必须与请求 generation 一致（防身份漂移） */
export function validateCommand(input = {}, allowedKinds = COMMAND_KINDS) {
	const parsed = parseCommandId(input?.commandId);
	if (!parsed) return { ok: false, error: 'invalid_command_id' };
	if (!allowedKinds.includes(parsed.kind)) return { ok: false, error: 'invalid_command_id' };
	const generation = input?.generation;
	if (!Number.isInteger(generation) || generation < 1 || generation > 999999999) {
		return { ok: false, error: 'invalid_generation' };
	}
	if (parsed.generation !== generation) return { ok: false, error: 'invalid_command_id_generation_mismatch' };
	const hasSession = isValidSessionId(input?.sessionId);
	const hasSg = typeof input?.supervisorGoalId === 'string' && SUPERVISOR_GOAL_ID_PATTERN.test(input.supervisorGoalId);
	if (!hasSession && !hasSg) return { ok: false, error: 'invalid_target' };
	return {
		ok: true,
		value: {
			commandId: input.commandId,
			commandKind: parsed.kind,
			generation,
			sessionId: hasSession ? input.sessionId : null,
			supervisorGoalId: hasSg ? input.supervisorGoalId : null,
		},
	};
}

export function validateCorrection(input = {}) {
	const base = validateCommand(input, ['CORRECTION']);
	if (!base.ok) return base;
	if (typeof input?.text !== 'string' || input.text.trim().length === 0 || input.text.length > 8000) {
		return { ok: false, error: 'invalid_text' };
	}
	const mode = input.mode ?? 'steer';
	if (mode !== 'steer' && mode !== 'queue') return { ok: false, error: 'invalid_mode' };
	return { ok: true, value: { ...base.value, text: input.text.trim(), mode } };
}

export function validateCancel(input = {}) {
	const base = validateCommand(input, ['CANCEL']);
	if (!base.ok) return base;
	const action = input.action ?? 'pause';
	if (!CANCEL_ACTIONS.includes(action)) return { ok: false, error: 'invalid_action' };
	return { ok: true, value: { ...base.value, action } };
}

export function validateReview(input = {}) {
	const base = validateCommand(input, ['REVIEW']);
	if (!base.ok) return base;
	if (!REVIEW_VERDICTS.includes(input?.verdict)) return { ok: false, error: 'invalid_verdict' };
	let criteriaResults = null;
	if (input?.criteriaResults !== undefined && input?.criteriaResults !== null) {
		if (!Array.isArray(input.criteriaResults) || input.criteriaResults.length > MAX_ACCEPTANCE_ITEMS) {
			return { ok: false, error: 'invalid_criteria_results' };
		}
		criteriaResults = [];
		for (const cr of input.criteriaResults) {
			const criterion = typeof cr?.criterion === 'string' ? cr.criterion.trim().slice(0, 500) : '';
			const result = cr?.result;
			if (!criterion || !['pass', 'fail', 'unknown'].includes(result)) {
				return { ok: false, error: 'invalid_criteria_results' };
			}
			criteriaResults.push({ criterion, result });
		}
	}
	let evidenceId = null;
	if (input?.evidenceId !== undefined && input?.evidenceId !== null) {
		if (typeof input.evidenceId !== 'string' || input.evidenceId.length > 200 || !/^ev-[A-Za-z0-9_.:-]{1,190}$/.test(input.evidenceId)) {
			return { ok: false, error: 'invalid_evidence_id' };
		}
		evidenceId = input.evidenceId;
	}
	return { ok: true, value: { ...base.value, verdict: input.verdict, criteriaResults, evidenceId } };
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

// ---------- Receipts（持久账本 = 最小 Supervisor goal metadata，非第二 Task DB） ----------
//
// v2 字段：identity（supervisorGoalId/runId/generation/revision）+ control/review 状态 +
//          dispatchFingerprint（R1.2：canonical dispatch contract SHA-256，payload identity）+
//          executedCommands（commandId → 执行凭据，replay-safe 的唯一依据）+ correction/cancel/review log +
//          pendingMutation（rpc 前持久化，支持断点续传与 ambiguous fail-closed）。
// 禁止存：Session history 副本 / Goal body 副本 / Context Memory / Router state / 执行队列。

export function deriveStartPrompt(objective, initialInstruction) {
	// R1.1 §10 OPTION A：objective-only dispatch 也必须真实启动执行。
	if (typeof initialInstruction === 'string' && initialInstruction.trim().length > 0) {
		return initialInstruction.trim();
	}
	return `Execute the objective below. Start working now and stop when the objective is met.\n\nOBJECTIVE:\n${objective}`;
}

export function newReceipt(key, sessionId, objective, goalRef, now = Date.now(), opts = {}) {
	const generation = 1;
	return {
		schema: RECEIPT_SCHEMA,
		key,
		supervisorGoalId: opts.supervisorGoalId ?? deriveSupervisorGoalId(key),
		sessionId,
		objective: String(objective ?? '').slice(0, 200),
		acceptanceCriteria: Array.isArray(opts.acceptanceCriteria) ? opts.acceptanceCriteria : null,
		// R1.2：dispatch 指纹（同 key 重放的 payload identity 依据）。
		// adopt / legacy v1 迁移路径无 dispatch body → 保持 null，重放时 fail-closed
		// （无法确定性重建原始 canonical request → 不猜，409 idempotency_conflict）。
		dispatchFingerprint: typeof opts.dispatchFingerprint === 'string' && opts.dispatchFingerprint.length === 64
			? opts.dispatchFingerprint
			: null,
		goalRef: goalRef ?? null, // harnessGoalId = goalRef.id（Official Goal identity，不复制 body）
		runId: deriveRunId(key, generation),
		generation,
		revision: 1,
		controlState: 'DISPATCHED',
		reviewState: null,
		latestReviewVerdict: null,
		latestEvidenceId: null,
		nextExpectedAction: 'observe',
		createdAt: now,
		updatedAt: now,
		corrections: 0,
		correctionsLeft: MAX_CORRECTIONS,
		correctionLog: [],
		cancelLog: [],
		reviewLog: [],
		executedCommands: {},
		pendingMutation: null,
		dupHits: { dispatch: 0, correction: 0, cancel: 0, review: 0 },
		adopted: !!opts.adopted,
		status: 'dispatched', // legacy v1 兼容视图
		history: [{ at: now, event: 'dispatched', goalRef: goalRef ?? null, generation, controlState: 'DISPATCHED' }],
	};
}

/** v1 → v2 无歧义迁移（账本 OK 时的确定性最小重建；§8 允许明确无歧义的映射） */
export function migrateReceiptV1(old) {
	const key = old.key;
	const cancelled = typeof old?.status === 'string' && old.status.startsWith('cancelled:');
	return {
		schema: RECEIPT_SCHEMA,
		key,
		supervisorGoalId: deriveSupervisorGoalId(key),
		sessionId: old.sessionId,
		objective: String(old.objective ?? '').slice(0, 200),
		acceptanceCriteria: null,
		goalRef: old.goalRef ?? null,
		runId: deriveRunId(key, 1),
		generation: 1,
		revision: 1,
		controlState: cancelled ? 'CANCELLED' : 'DISPATCHED',
		reviewState: null,
		latestReviewVerdict: null,
		latestEvidenceId: null,
		nextExpectedAction: cancelled ? null : 'observe',
		createdAt: old.createdAt ?? 0,
		updatedAt: old.updatedAt ?? old.createdAt ?? 0,
		corrections: old.corrections ?? 0,
		correctionsLeft: old.correctionsLeft ?? Math.max(0, MAX_CORRECTIONS - (old.corrections ?? 0)),
		correctionLog: [],
		cancelLog: [],
		reviewLog: [],
		executedCommands: {},
		pendingMutation: null,
		dupHits: { dispatch: 0, correction: 0, cancel: 0, review: 0 },
		adopted: typeof key === 'string' && key.startsWith('adopted:'),
		status: old.status ?? 'dispatched',
		history: Array.isArray(old.history) ? old.history : [],
	};
}

function isValidReceiptShape(r) {
	return r && typeof r === 'object' && typeof r.key === 'string' && isValidSessionId(r.sessionId);
}

function receiptsFromParsed(parsed) {
	if (!parsed || typeof parsed !== 'object') throw new Error('invalid_receipts_file');
	const map = new Map();
	if (parsed.version === 1 && parsed.receipts && typeof parsed.receipts === 'object') {
		for (const [k, v] of Object.entries(parsed.receipts)) {
			if (!isValidReceiptShape(v) || v.key !== k) throw new Error('invalid_receipts_file');
			map.set(k, migrateReceiptV1(v));
		}
		return map;
	}
	if (parsed.version === 2 && parsed.receipts && typeof parsed.receipts === 'object') {
		for (const [k, v] of Object.entries(parsed.receipts)) {
			if (!isValidReceiptShape(v) || v.key !== k
				|| !CONTROL_STATES.includes(v.controlState)
				|| typeof v.executedCommands !== 'object' || v.executedCommands === null
				|| !Number.isInteger(v.generation) || v.generation < 1) {
				throw new Error('invalid_receipts_file');
			}
			map.set(k, v);
		}
		return map;
	}
	throw new Error('invalid_receipts_file');
}

/**
 * 账本分类（§8/§9：纯文本输入，无 IO）。
 * ABSENT=首次不存在（合法空态）；OK=可解析（v1 自动迁移到 v2）；
 * CORRUPT=曾存在但损坏；AMBIGUOUS=主文件损坏但 tmp 可解析（两个候选状态，不得猜）。
 */
export function classifyLedger(mainText, tmpText) {
	if (mainText === null || mainText === undefined) {
		if (tmpText === null || tmpText === undefined) return { state: 'ABSENT', receipts: new Map() };
		try {
			return { state: 'AMBIGUOUS', receipts: null, error: 'main_absent_tmp_present' };
		} catch { /* unreachable */ }
	}
	let map = null;
	try {
		map = receiptsFromParsed(JSON.parse(mainText));
		return { state: 'OK', receipts: map };
	} catch (mainErr) {
		if (tmpText !== null && tmpText !== undefined) {
			try {
				receiptsFromParsed(JSON.parse(tmpText));
				return { state: 'AMBIGUOUS', receipts: null, error: `main_corrupt_tmp_parses:${mainErr.message}` };
			} catch { /* fallthrough */ }
		}
		return { state: 'CORRUPT', receipts: null, error: String(mainErr?.message ?? mainErr) };
	}
}

export function serializeReceipts(map) {
	return JSON.stringify({ version: RECEIPT_SCHEMA, savedAt: new Date().toISOString(), receipts: Object.fromEntries(map) }, null, 2);
}

export function deserializeReceipts(text) {
	const parsed = JSON.parse(text);
	const map = receiptsFromParsed(parsed);
	return map;
}

// ---------- generation / duplicate / budget 闸门（纯） ----------

/**
 * stale guard（§6）：同 commandId 重放由调用方先查 executedCommands（dedupe 优先于 stale）。
 * 这里只裁决"新命令"的 generation：小于当前 → 409 STALE；大于当前 → 400（不可跳代）。
 */
export function gateGeneration(receiptGeneration, commandGeneration) {
	if (commandGeneration < receiptGeneration) return { ok: false, stale: true, error: 'stale_generation', currentGeneration: receiptGeneration };
	if (commandGeneration > receiptGeneration) return { ok: false, error: 'invalid_generation', currentGeneration: receiptGeneration };
	return { ok: true };
}

export function lookupExecuted(receipt, commandId) {
	return receipt?.executedCommands?.[commandId] ?? null;
}

/** 纠偏闸门：>= MAX_CORRECTIONS 拒绝 */
export function canCorrect(receipt) {
	const used = receipt?.corrections ?? 0;
	return used < MAX_CORRECTIONS
		? { ok: true, correctionsUsed: used, correctionsLeft: MAX_CORRECTIONS - used }
		: { ok: false, error: 'corrections_exhausted', correctionsUsed: used, correctionsLeft: 0 };
}

// ---------- receipt 变更（纯：输入 receipt，返回新 receipt） ----------

function touch(r, now, patch, event) {
	return {
		...r,
		...patch,
		revision: (r.revision ?? 1) + 1,
		updatedAt: now,
		history: [...(r.history ?? []).slice(-99), { at: now, ...event }],
	};
}

/** rpc 调用前持久化 pendingMutation（崩溃/断线后可断点续传或 fail-closed） */
export function markPending(receipt, kind, commandId, now = Date.now(), appliedSteps = 0) {
	return touch(receipt, now, {
		pendingMutation: { kind, commandId, appliedSteps, at: now },
		nextExpectedAction: kind === 'DISPATCH' ? 'observe' : kind === 'CANCEL' ? 'observe' : 'reconcile',
	}, { event: `pending:${kind}`, commandId, appliedSteps });
}

export function markAppliedStep(receipt, appliedSteps, now = Date.now()) {
	if (!receipt.pendingMutation) return receipt;
	return {
		...receipt,
		pendingMutation: { ...receipt.pendingMutation, appliedSteps },
		updatedAt: now,
	};
}

/** rpc 结果歧义（响应丢失/传输失败）→ 该 commandId 永久标记 ambiguous，重放 fail-closed（§9C） */
export function markAmbiguous(receipt, commandId, now = Date.now(), detail = '') {
	return touch(receipt, now, {
		pendingMutation: null,
		executedCommands: { ...receipt.executedCommands, [commandId]: { kind: 'AMBIGUOUS', at: now, detail: String(detail).slice(0, 200) } },
		nextExpectedAction: 'reconcile',
	}, { event: 'mutation_ambiguous', commandId });
}

export function recordCorrection(receipt, cmd, now = Date.now()) {
	// cmd: {commandId, generation, mode, text}
	const used = receipt.corrections + 1;
	const generation = cmd.generation + 1;
	const runId = deriveRunId(receipt.key, generation);
	return touch({
		...receipt,
		runId,
	}, now, {
		generation,
		corrections: used,
		correctionsLeft: Math.max(0, MAX_CORRECTIONS - used),
		controlState: 'RUNNING',
		nextExpectedAction: 'observe',
		pendingMutation: null,
		executedCommands: { ...receipt.executedCommands, [cmd.commandId]: { kind: 'CORRECTION', at: now, generation, mode: cmd.mode } },
		correctionLog: [...receipt.correctionLog, { commandId: cmd.commandId, generation, mode: cmd.mode, text: String(cmd.text ?? '').slice(0, 200), at: now }],
		status: 'dispatched',
	}, { at: now, event: 'correction', commandId: cmd.commandId, generation, mode: cmd.mode, text: String(cmd.text ?? '').slice(0, 200) });
}

export function recordCancel(receipt, cmd, now = Date.now()) {
	// cmd: {commandId, generation, action}
	return touch(receipt, now, {
		controlState: 'CANCELLED',
		nextExpectedAction: null,
		pendingMutation: null,
		executedCommands: { ...receipt.executedCommands, [cmd.commandId]: { kind: 'CANCEL', at: now, action: cmd.action } },
		cancelLog: [...receipt.cancelLog, { commandId: cmd.commandId, generation: cmd.generation, action: cmd.action, at: now }],
		status: `cancelled:${cmd.action}`,
	}, { at: now, event: `cancel:${cmd.action}`, commandId: cmd.commandId, generation: cmd.generation });
}

export function recordReview(receipt, cmd, now = Date.now(), correctionsLeft = receipt.correctionsLeft) {
	// cmd: {commandId, generation, verdict, criteriaResults?, evidenceId?}
	// §13：VERIFIED 只能由显式 review PASS 到达；FAIL → CORRECTING（预算尽 → BLOCKED 由调用方判）。
	const controlState = cmd.verdict === 'PASS' ? 'VERIFIED' : (correctionsLeft > 0 ? 'CORRECTING' : 'BLOCKED');
	return touch(receipt, now, {
		controlState,
		reviewState: cmd.verdict,
		latestReviewVerdict: cmd.verdict,
		latestEvidenceId: cmd.evidenceId ?? receipt.latestEvidenceId,
		latestAcceptance: cmd.criteriaResults ? { results: cmd.criteriaResults, at: now } : receipt.latestAcceptance ?? null,
		nextExpectedAction: cmd.verdict === 'PASS' ? null : (correctionsLeft > 0 ? 'send_correction' : 'user_intervention'),
		executedCommands: { ...receipt.executedCommands, [cmd.commandId]: { kind: 'REVIEW', at: now, verdict: cmd.verdict } },
		reviewLog: [...receipt.reviewLog, { commandId: cmd.commandId, generation: cmd.generation, verdict: cmd.verdict, at: now, evidenceId: cmd.evidenceId ?? null }],
		status: receipt.status, // cancelled 语义不变
	}, { at: now, event: `review:${cmd.verdict}`, commandId: cmd.commandId, generation: cmd.generation });
}

export function recordExhausted(receipt, now = Date.now()) {
	return touch(receipt, now, {
		controlState: 'BLOCKED',
		nextExpectedAction: 'user_intervention',
	}, { at: now, event: 'corrections_exhausted' });
}

// ---------- lifecycle（R1.1 §12-13：纯状态机） ----------

/**
 * controlReducer：允许的最小控制面迁移。VERIFIED 只能经 review_pass 到达；
 * harness complete 只映射 AWAITING_REVIEW（Completion Truth 硬 Gate）。
 */
export function controlReducer(state, event, ctx = {}) {
	const terminal = TERMINAL_CONTROL_STATES.includes(state);
	if (terminal) {
		if (event === 'cancel' && state !== 'CANCELLED') return state; // 终态不再迁移（BLOCKED/VERIFIED 保持）
		return state;
	}
	switch (event) {
		case 'dispatch':
			return state === 'CREATED' ? 'DISPATCHED' : state;
		case 'prompt_running':
			return state === 'DISPATCHED' || state === 'RUNNING' ? 'RUNNING' : state;
		case 'harness_complete':
			return state === 'RUNNING' || state === 'DISPATCHED' || state === 'CORRECTING' || state === 'AWAITING_REVIEW' ? 'AWAITING_REVIEW' : state;
		case 'review_pass':
			return state === 'AWAITING_REVIEW' ? 'VERIFIED' : state;
		case 'review_fail':
			if (state !== 'AWAITING_REVIEW') return state;
			return (ctx.correctionsLeft ?? 0) > 0 ? 'CORRECTING' : 'BLOCKED';
		case 'correction_accepted':
			return state === 'CORRECTING' || state === 'AWAITING_REVIEW' ? 'RUNNING' : state;
		case 'corrections_exhausted':
			return state === 'CORRECTING' || state === 'AWAITING_REVIEW' || state === 'RUNNING' ? 'BLOCKED' : state;
		case 'cancel':
			return ['CREATED', 'DISPATCHED', 'RUNNING', 'AWAITING_REVIEW', 'CORRECTING'].includes(state) ? 'CANCELLED' : state;
		case 'ambiguous_mutation':
			return state; // CORRECTING/DISPATCHED 保持，等待 reconcile
		default:
			throw new Error(`invalid_transition_event:${event}`);
	}
}

/**
 * Official projection wins（§21）：读时以宿主实时投影推导控制态；
 * 返回 changed=true 时由调用方持久化（metadata-only）。
 */
export function deriveControlState(receipt, projection) {
	const current = receipt?.controlState ?? 'DISPATCHED';
	if (TERMINAL_CONTROL_STATES.includes(current)) {
		return { controlState: current, changed: false, completionReason: null };
	}
	const phase = projection?.phase ?? projection?.goal?.phase ?? null;
	const completionReason = phase === 'complete' ? 'harness_goal_complete' : null;
	// R1 Correction B6（2026-08-31 P3 真实指纹）：review FAIL → CORRECTING 是 supervisor
	// 显式裁决，优先级高于宿主 harness_complete 投影。round 完成后宿主 goal 恒为
	// phase=complete，若不粘滞，读时推导（syncControlState，每次 get_goal/watchdog 轮询）
	// 会用 harness_complete 把 CORRECTING 立即压回 AWAITING_REVIEW——CORRECTING 只存活于
	// 两次轮询之间，watchdog RECOVERING 永不可达（E2E run5：bridgeCs=AWAITING_REVIEW）。
	// CORRECTING 只经 correction_accepted（recordCorrection → RUNNING）/
	// corrections_exhausted（→ BLOCKED）/ cancel 退出。
	if (current === 'CORRECTING') {
		return { controlState: current, changed: false, completionReason: null };
	}
	if (receipt?.pendingMutation) {
		return { controlState: current, changed: false, completionReason };
	}
	const event = phase === 'complete' ? 'harness_complete' : (phase === 'active' || phase === 'paused') ? 'prompt_running' : null;
	if (!event) return { controlState: current, changed: false, completionReason };
	const next = controlReducer(current, event, { correctionsLeft: receipt?.correctionsLeft });
	return { controlState: next, changed: next !== current, completionReason };
}

/** rebind：以宿主实时投影为准推导 receipt 运行态（桥不保存运行态副本）。 */
export function deriveLiveStatus(receipt, projection) {
	if (!projection || !projection.goal) return { status: 'absent', phase: null, controlState: receipt?.controlState ?? 'DISPATCHED' };
	const phase = projection.phase ?? projection.goal?.phase ?? null;
	const ref = { id: projection.goal.id, revision: projection.goal.revision };
	if (typeof receipt?.status === 'string' && receipt.status.startsWith('cancelled:')) {
		return { status: receipt.status, phase, ref, controlState: 'CANCELLED' };
	}
	const derived = deriveControlState(receipt, projection);
	const map = { active: 'active', paused: 'paused', complete: 'complete', stopped: 'paused' };
	return { status: map[phase] ?? 'active', phase, ref, controlState: derived.controlState, completionReason: derived.completionReason };
}

// ---------- RPC 计划（纯：dispatch 的宿主调用序列；R1.1 恒含启动 prompt） ----------

export function planDispatchSteps(value, sessionId, appliedSteps = 0) {
	const all = [
		{ method: 'session.create', payload: { sessionId } },
		{ method: 'goal.create', payload: { sessionId, objective: value.objective } },
		{
			// mode 'queue'：schema 权威值仅 queue|steer（sessions.schema.js L228）。
			// 空闲新会话的普通 Queue 发送即会启动 turn；'now' 不存在会被 zod 拒绝
			// （R1.1 曾误改为 'now'，CI E2E 实测 invalid payload for session.prompt）。
			method: 'session.prompt',
			payload: { sessionId, mode: 'queue', content: [{ type: 'text', text: deriveStartPrompt(value.objective, value.initialInstruction) }] },
		},
	];
	const start = Number.isInteger(appliedSteps) && appliedSteps > 0 ? Math.min(appliedSteps, all.length) : 0;
	return all.slice(start);
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

// ---------- Acceptance / Evidence Bundle（R1.1 §15-17：动态读现有事实，禁编造） ----------

/** acceptance matrix：criteria（派发契约）+ review 结果 → total/pass/fail/unknown（未知不填 PASS） */
export function computeAcceptanceTotals(criteria, criteriaResults) {
	const list = Array.isArray(criteria) ? criteria : [];
	const results = Array.isArray(criteriaResults) ? criteriaResults : [];
	const byCriterion = new Map(results.map((r) => [r.criterion, r.result]));
	const rows = list.map((c) => ({ criterion: c, result: byCriterion.get(c) ?? 'unknown' }));
	for (const r of results) {
		if (!list.includes(r.criterion)) rows.push({ criterion: r.criterion, result: r.result });
	}
	return {
		criteria: rows,
		total: rows.length,
		pass: rows.filter((r) => r.result === 'pass').length,
		fail: rows.filter((r) => r.result === 'fail').length,
		unknown: rows.filter((r) => r.result === 'unknown').length,
	};
}

/**
 * 结构化 Evidence Bundle（§15 最小结构）。
 * 输入全部由 bridge 动态读取（Official 投影 / receipt 元数据 / 宿主健康自报）；
 * 不伪造 Git/CI/test 事实：拿不到就 N/A / NOT_RUN（§16）。
 */
export function buildEvidenceBundle(receipt, projection, opts = {}) {
	const live = deriveLiveStatus(receipt, projection);
	const gen = receipt?.generation ?? 1;
	const rev = receipt?.revision ?? 1;
	const sgId = receipt?.supervisorGoalId ?? null;
	const evidenceId = receipt?.latestEvidenceId ?? deriveEvidenceId(sgId ?? 'unbound', gen, rev);
	const harnessGoalId = live.ref?.id ?? receipt?.goalRef?.id ?? projection?.goal?.id ?? null;
	const harnessSessionId = receipt?.sessionId ?? null;
	const acceptance = computeAcceptanceTotals(receipt?.acceptanceCriteria, receipt?.latestAcceptance?.results);
	const pending = receipt?.pendingMutation ?? null;
	const dupTotal = Object.values(receipt?.dupHits ?? {}).reduce((a, b) => a + b, 0);
	return {
		evidenceId,
		labels: {
			identity: harnessGoalId ? 'REAL' : 'INFERRED',
			execution: 'REPORTED REAL',
			source: 'N/A',
			verification: 'NOT_RUN',
			acceptance: receipt?.latestAcceptance ? 'REPORTED REAL' : 'INFERRED',
			continuity: 'REAL',
		},
		identity: {
			supervisorGoalId: sgId,
			harnessGoalId,
			harnessSessionId,
			runId: receipt?.runId ?? null,
			generation: gen,
			revision: rev,
			adopted: !!receipt?.adopted,
		},
		execution: {
			controlState: live.controlState,
			harnessGoalPhase: live.phase,
			running: !!opts.running,
			completionReason: live.completionReason ?? null,
			harnessStatus: live.status,
		},
		source: {
			workspace: null,
			baseCommit: null,
			headCommit: null,
			gitDirty: null,
			diffSummary: null,
			note: 'not_available_no_git_authority',
		},
		verification: {
			tests: { status: 'NOT_RUN', note: 'no test authority in bridge; not fabricated' },
			ci: { status: 'NOT_RUN', note: 'no CI authority in bridge; not fabricated' },
			runtimeHealth: opts.runtimeHealth ?? { harnessPort: opts.harnessPort ?? null, bridgeAlive: true },
		},
		acceptance,
		continuity: {
			duplicateDetected: dupTotal > 0 ? 'yes' : 'no',
			dupHits: receipt?.dupHits ?? {},
			pendingMutation: pending ? { kind: pending.kind, commandId: pending.commandId, appliedSteps: pending.appliedSteps } : null,
			recoveryState: pending ? 'PENDING_MUTATION' : (receipt?.executedCommands && Object.values(receipt.executedCommands).some((c) => c?.kind === 'AMBIGUOUS') ? 'AMBIGUOUS_COMMAND_PRESENT' : 'OK'),
			orphanState: receipt?.adopted ? 'ADOPTED_WITHOUT_DISPATCH' : 'NONE',
		},
		leftovers: {
			blockers: [],
			knownLimitations: [
				'source/verification sections are N/A by design (no git/CI authority in supervisor bridge)',
			],
			deferredWork: [],
		},
		events: Array.isArray(opts.events) ? opts.events : [],
		hasMore: !!opts.hasMore,
	};
}

// ---------- Snapshot（R1.1 §18：resumable，metadata-only） ----------

export function buildSnapshotRow(receipt, live) {
	return {
		supervisorGoalId: receipt.supervisorGoalId,
		harnessGoalId: live.ref?.id ?? receipt.goalRef?.id ?? null,
		harnessSessionId: receipt.sessionId,
		runId: receipt.runId,
		generation: receipt.generation,
		revision: receipt.revision,
		currentControlState: live.controlState,
		latestEvidenceId: receipt.latestEvidenceId,
		latestReviewVerdict: receipt.latestReviewVerdict,
		nextExpectedAction: receipt.nextExpectedAction,
		correctionsUsed: receipt.corrections,
		correctionsLeft: receipt.correctionsLeft,
		acceptance: computeAcceptanceTotals(receipt.acceptanceCriteria, receipt.latestAcceptance?.results),
		objective: receipt.objective,
		createdAt: receipt.createdAt,
		updatedAt: receipt.updatedAt,
		pendingMutation: receipt.pendingMutation ? { kind: receipt.pendingMutation.kind, commandId: receipt.pendingMutation.commandId } : null,
	};
}
