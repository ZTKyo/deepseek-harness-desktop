// supervisor-bridge.mjs —— P2.75 Supervisor Bridge（ChatGPT → Harness Control Plane）
//
// 设计：docs/roadmap/reports/PHASE_02_75_SUPERVISOR/DESIGN_R1.md
// 定位：thin plugin/adapter —— 在宿主 3080 webServer 上注册 /supervisor/* 端点，
//       变更一律回环调用宿主既有 session.*/goal.* RPC（与 GUI 同一权威，禁第二权威）。
// 只读：health / get_state / get_goal / get_evidence / get_snapshot
// 变更：dispatch_goal（幂等 receipts）/ send_correction（≤3）/ cancel_goal
// 红线：无 shell/write_file 通道；不读写 sessions/** storages/**；不放宽 CORS。
// 数据：~/.dsh/supervisor-bridge/{token, receipts.json}（自管目录，非会话存储）。

import * as core from './supervisor-bridge-core.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const name = 'supervisor-bridge';
export const inject = ['webServer'];

const MAX_BODY_BYTES = 256 * 1024;
const RPC_TIMEOUT_MS = 15000;

function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

export function apply(ctx) {
	const dataDir = join(dshHome(), 'supervisor-bridge');
	const tokenFile = join(dataDir, 'token');
	const receiptsFile = join(dataDir, 'receipts.json');
	const port = Number(process.env.DSH_WEB_PORT || process.env.PORT || 3080);

	// ---------- 数据目录 + token（首次自动生成，永不入日志/聊天） ----------
	mkdirSync(dataDir, { recursive: true });
	let token;
	if (existsSync(tokenFile)) {
		try {
			token = readFileSync(tokenFile, 'utf8').trim();
		} catch { /* fallthrough */ }
	}
	if (!token || !/^[0-9a-f]{64}$/.test(token)) {
		token = core.generateToken();
		writeFileSync(tokenFile, token + '\n', { encoding: 'utf8' });
	}

	// ---------- receipts 账本（原子写：tmp + rename） ----------
	let receipts = new Map();
	function loadReceipts() {
		if (!existsSync(receiptsFile)) return;
		try {
			receipts = core.deserializeReceipts(readFileSync(receiptsFile, 'utf8'));
		} catch (e) {
			// 损坏不覆盖：保留原文，账本降级为空（幂等由宿主 session.create 兜底）
			try { renameSync(receiptsFile, receiptsFile + '.corrupt-' + Date.now()); } catch { /* ignore */ }
			receipts = new Map();
		}
	}
	function persistReceipts() {
		const tmp = receiptsFile + '.tmp';
		writeFileSync(tmp, core.serializeReceipts(receipts), 'utf8');
		renameSync(tmp, receiptsFile);
	}
	loadReceipts();

	// ---------- 回环 RPC（宿主权威；wire 已实测：{type,rpcId,method,payload}） ----------
	async function rpc(method, payload) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
		try {
			const r = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ type: 'client-request', rpcId: `sb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, method, payload }),
				signal: ctrl.signal,
			});
			const j = await r.json().catch(() => null);
			if (!j || typeof j !== 'object' || !('result' in j)) {
				throw new Error(`bad_envelope:${r.status}`);
			}
			if (j.result?.ok === false) {
				const err = new Error(j.result.error ?? 'upstream_error');
				err.upstream = true;
				throw err;
			}
			return j.result?.value;
		} finally {
			clearTimeout(timer);
		}
	}

	async function findSession(sessionId) {
		const value = await rpc('session.list', {});
		const items = value?.items ?? [];
		return items.find((i) => i.sessionId === sessionId) ?? null;
	}

	// ---------- HTTP 骨架 ----------
	function respond(res, code, obj) {
		const body = JSON.stringify(obj);
		res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
		res.end(body);
	}
	async function readJson(req) {
		let n = 0;
		const chunks = [];
		for await (const c of req) {
			n += c.length;
			if (n > MAX_BODY_BYTES) throw new Error('body_too_large');
			chunks.push(c);
		}
		if (n === 0) return {};
		const text = Buffer.concat(chunks).toString('utf8');
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_json');
		return parsed;
	}

	/**
	 * 端点包装：鉴权 → handler → 统一错误映射。
	 * codes: 400 invalid_* / body_* · 401 unauthorized · 404 unknown_session
	 *        409 corrections_exhausted · 502 upstream_rpc_failed
	 */
	function route(pathName, handler, opts = {}) {
		ctx.webServer?.register({
			kind: 'exact',
			path: pathName,
			handler: async (req, res) => {
				try {
					if (req.method !== 'POST' && !(opts.get && req.method === 'GET')) {
						return respond(res, 405, { ok: false, error: 'method_not_allowed' });
					}
					if (!core.checkAuth(req.headers.authorization, token)) {
						return respond(res, 401, { ok: false, error: 'unauthorized' });
					}
					const body = req.method === 'GET' ? {} : await readJson(req);
					const out = await handler(body, req);
					return respond(res, out.__code ?? 200, (() => { const { __code, ...rest } = out; return rest; })());
				} catch (e) {
					const msg = String(e?.message ?? e);
					if (msg.startsWith('invalid_')) return respond(res, 400, { ok: false, error: msg });
					if (msg === 'body_too_large' || msg === 'invalid_json') return respond(res, 400, { ok: false, error: msg });
					if (msg === 'unknown_session') return respond(res, 404, { ok: false, error: msg });
					if (msg === 'corrections_exhausted') return respond(res, 409, { ok: false, error: msg, correctionsUsed: e.correctionsUsed ?? core.MAX_CORRECTIONS, correctionsLeft: 0 });
					if (e?.upstream) return respond(res, 502, { ok: false, error: 'upstream_rpc_failed', detail: msg.slice(0, 200) });
					return respond(res, 500, { ok: false, error: 'internal_error' });
				}
			},
		});
	}

	// ---------- 只读面 ----------
	route('/supervisor/health', async () => ({
		ok: true, plugin: core.PLUGIN_NAME, version: core.PLUGIN_VERSION, now: new Date().toISOString(),
	}), { get: true });

	route('/supervisor/get_state', async () => {
		const value = await rpc('session.list', {});
		const items = value?.items ?? [];
		return { ok: true, sessions: items.map(core.sanitizeStateItem) };
	});

	route('/supervisor/get_goal', async (body) => {
		const v = core.validateSessionQuery(body);
		if (!v.ok) { const e = new Error(v.error); throw e; }
		const item = await findSession(v.value.sessionId);
		if (!item) { const e = new Error('unknown_session'); throw e; }
		return { ok: true, sessionId: v.value.sessionId, ...core.pickGoalProjection(item) };
	});

	route('/supervisor/get_evidence', async (body) => {
		const v = core.validateSessionQuery(body);
		if (!v.ok) { const e = new Error(v.error); throw e; }
		const max = Math.min(200, Math.max(1, Number(body.maxMessages) || 50));
		const item = await findSession(v.value.sessionId);
		if (!item) { const e = new Error('unknown_session'); throw e; }
		const value = await rpc('session.history', { sessionId: v.value.sessionId, maxMessages: max });
		return { ok: true, sessionId: v.value.sessionId, events: core.sanitizeEvents(value?.events ?? []), hasMore: !!value?.hasMore };
	});

	route('/supervisor/get_snapshot', async () => {
		const value = await rpc('session.list', {});
		const items = value?.items ?? [];
		const sessions = items.map(core.sanitizeStateItem);
		const goals = items.filter((i) => i.projections?.values?.goal)
			.map((i) => ({ sessionId: i.sessionId, ...core.pickGoalProjection(i) }));
		const receiptList = [...receipts.values()].map((r) => ({
			key: r.key, sessionId: r.sessionId, status: r.status,
			corrections: r.corrections, correctionsLeft: r.correctionsLeft,
		}));
		return { ok: true, host: { ok: true, now: new Date().toISOString(), version: core.PLUGIN_VERSION }, sessions, goals, receipts: receiptList };
	});

	// ---------- 变更面 ----------
	route('/supervisor/dispatch_goal', async (body) => {
		const v = core.validateDispatch(body);
		if (!v.ok) { const e = new Error(v.error); throw e; }
		const { idempotencyKey } = v.value;
		const existing = receipts.get(idempotencyKey);
		if (existing) {
			// 幂等命中：不重派；运行态读时推导（rebind）
			const item = await findSession(existing.sessionId);
			const live = core.deriveLiveStatus(existing, item?.projections?.values?.goal ?? null);
			return { ok: true, dispatched: false, receipt: { key: existing.key, sessionId: existing.sessionId, goalRef: existing.goalRef, status: live.status, phase: live.phase, corrections: existing.corrections, correctionsLeft: existing.correctionsLeft }, session: { sessionId: existing.sessionId, running: !!item?.running } };
		}
		const sessionId = core.deriveSessionId(idempotencyKey);
		const steps = core.planDispatchSteps(v.value, sessionId, null);
		let goalRef = null;
		let running = false;
		for (const step of steps) {
			const value = await rpc(step.method, step.payload);
			if (step.method === 'session.create') running = !!(value?.running);
			if (step.method === 'goal.create') goalRef = value?.ref ?? null;
		}
		const now = Date.now();
		const receipt = core.newReceipt(idempotencyKey, sessionId, v.value.objective, goalRef, now);
		receipts.set(idempotencyKey, receipt);
		persistReceipts();
		return { ok: true, dispatched: true, receipt: { key: receipt.key, sessionId, goalRef, status: receipt.status, corrections: 0, correctionsLeft: core.MAX_CORRECTIONS }, session: { sessionId, running } };
	});

	route('/supervisor/send_correction', async (body) => {
		const v = core.validateCorrection(body);
		if (!v.ok) { const e = new Error(v.error); throw e; }
		const { sessionId, text, mode } = v.value;
		const item = await findSession(sessionId);
		if (!item) { const e = new Error('unknown_session'); throw e; }
		// receipt：优先按 sessionId 查找；无则收养（GUI 派发的 goal 也可被纠偏，上限同样生效）
		let key = null;
		for (const [k, r] of receipts) if (r.sessionId === sessionId) { key = k; break; }
		if (!key) {
			const proj = item.projections?.values?.goal;
			const adopted = core.newReceipt(`adopted:${sessionId.slice(-8)}`, sessionId, proj?.goal?.objective ?? '(adopted)', proj?.goal ? { id: proj.goal.id, revision: proj.goal.revision } : null);
			receipts.set(adopted.key, adopted);
			key = adopted.key;
		}
		const receipt = receipts.get(key);
		const gate = core.canCorrect(receipt);
		if (!gate.ok) {
			const e = new Error('corrections_exhausted');
			e.correctionsUsed = gate.correctionsUsed;
			throw e;
		}
		await rpc('session.prompt', { sessionId, mode, content: [{ type: 'text', text }] });
		const updated = core.recordCorrection(receipt, text, mode);
		receipts.set(key, updated);
		persistReceipts();
		return { ok: true, accepted: true, correctionsUsed: updated.corrections, correctionsLeft: updated.correctionsLeft };
	});

	route('/supervisor/cancel_goal', async (body) => {
		const v = core.validateCancel(body);
		if (!v.ok) { const e = new Error(v.error); throw e; }
		const { sessionId, action } = v.value;
		const item = await findSession(sessionId);
		if (!item) { const e = new Error('unknown_session'); throw e; }
		const proj = item.projections?.values?.goal;
		if (!proj?.goal) return { ok: true, cancelled: false, reason: 'no_active_goal', action };
		const ref = { id: proj.goal.id, revision: proj.goal.revision };
		await rpc(`goal.${action}`, { sessionId, ref });
		try { await rpc('session.cancel', { sessionId }); } catch { /* 会话未在跑：可忽略 */ }
		for (const [k, r] of receipts) {
			if (r.sessionId === sessionId) {
				receipts.set(k, core.recordCancel(r, action));
			}
		}
		persistReceipts();
		return { ok: true, cancelled: true, action, ref };
	});

	// ---------- 诊断导出（供测试/巡检，不含 token） ----------
	return {
		_diag: () => ({ dataDir, receipts: receipts.size, hasToken: !!token }),
	};
}

export default { name, inject, apply };
