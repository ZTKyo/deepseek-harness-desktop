// supervisor-bridge.mjs —— P2.75 Supervisor Bridge（ChatGPT → Harness Control Plane，R1.1+R1.2）
//
// 设计：docs/roadmap/reports/PHASE_02_75_SUPERVISOR/DESIGN_R1.md（R1 冻结基础）
//       + R1.1：全部 mutation replay-safe（commandId+generation+持久 receipts）；
//         账本损坏/歧义 → mutation fail-closed（503），只读继续；
//         最小 Supervisor lifecycle（Harness COMPLETE != Supervisor VERIFIED）；
//         结构化 Evidence Bundle / resumable Snapshot / review_goal 受控 seam。
//       + R1.2（External Review Round 3 唯一 Blocker）：dispatch payload identity ——
//         每次 dispatch 计算 canonical contract 指纹并存入 receipt；
//         同 key 重放必须指纹一致（exact replay → duplicate）；
//         payload 不同 / legacy 无指纹 → 409 idempotency_conflict（fail-closed，不猜）。
// 定位：thin plugin/adapter —— 在宿主 3080 webServer 上注册 /supervisor/* 端点，
//       变更一律回环调用宿主既有 session.*/goal.* RPC（与 GUI 同一权威，禁第二权威）。
// 只读：health / get_state / get_goal / get_evidence / get_snapshot
// 变更：dispatch_goal / send_correction / cancel_goal / review_goal（全部幂等）
// 红线：无 shell/write_file 通道；不读写 sessions/** storages/**；不放宽 CORS；
//       bearer token 不进日志/报告；receipts 只存控制元数据（禁第二 Task DB）。
// 数据：~/.dsh/supervisor-bridge/{token, receipts.json}（自管目录，非会话存储）。

import * as core from './supervisor-bridge-core.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from './supervisor-bridge-core.mjs';

export const name = 'supervisor-bridge';
export const inject = ['webServer'];

const MAX_BODY_BYTES = 256 * 1024;
const RPC_TIMEOUT_MS = 15000;
const THIS_FILE = fileURLToPath(import.meta.url);
const CORE_FILE = join(dirname(THIS_FILE), 'supervisor-bridge-core.mjs');

function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

function httpError(code, message, extra = {}) {
	const e = new Error(message);
	e.code = code;
	e.extra = extra; // 序列化层 catch 统一展开 e.extra（review 合同字段：currentGeneration 等）
	Object.assign(e, extra);
	return e;
}

export function apply(ctx) {
	const dataDir = join(dshHome(), 'supervisor-bridge');
	const tokenFile = join(dataDir, 'token');
	const receiptsFile = join(dataDir, 'receipts.json');
	const tmpFile = receiptsFile + '.tmp';
	// 端口铁律：relay 必须打到自己宿主的 webServer 真实监听端口（inject 保证服务已启动，
	// port getter 覆盖 config.port=0 的 OS 分配场景）。env 只作遗留兜底；裸 PORT 永不采信
	// （无关进程的 PORT 环境变量会把 dispatch 误中继到别人的实例——2026-08-29 ladder 事故根因）。
	const port = Number(ctx.webServer?.port) || Number(process.env.DSH_WEB_PORT) || 3080;

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

	// ---------- receipts 账本（§8/§9：损坏/歧义 → mutation FAIL-CLOSED） ----------
	// 状态机：ABSENT（首启合法空）/ OK / CORRUPT / AMBIGUOUS。
	// 损坏文件永不 rename/清空；惰性重载（mtime/size 变化）保证外部篡改即时生效。
	let receipts = new Map();
	let ledgerState = 'ABSENT';
	let ledgerError = null;
	let lastStat = null;

	function statLedger() {
		try {
			const st = statSync(receiptsFile);
			return { mtimeMs: st.mtimeMs, size: st.size };
		} catch { return null; }
	}
	function readTextSafe(p) {
		try { return readFileSync(p, 'utf8'); } catch { return null; }
	}
	function loadLedger() {
		const mainText = readTextSafe(receiptsFile);
		const tmpText = existsSync(tmpFile) ? readTextSafe(tmpFile) : null;
		const cls = core.classifyLedger(mainText, tmpText);
		ledgerState = cls.state;
		ledgerError = cls.error ?? null;
		receipts = cls.receipts ?? new Map();
		lastStat = statLedger();
	}
	function persistLedger() {
		// 原子写：tmp + rename；写后重算 lastStat（避免误判外部修改）。
		writeFileSync(tmpFile, core.serializeReceipts(receipts), 'utf8');
		renameSync(tmpFile, receiptsFile);
		lastStat = statLedger();
		ledgerState = 'OK';
		ledgerError = null;
	}
	/** mutation 前闸门：外部修改过账本 → 先重载；CORRUPT/AMBIGUOUS → 拒绝 mutation（fail-closed） */
	function gateLedgerForMutation() {
		const st = statLedger();
		if (lastStat && st && (st.mtimeMs !== lastStat.mtimeMs || st.size !== lastStat.size)) loadLedger();
		else if (!lastStat && st) loadLedger();
		if (ledgerState === 'CORRUPT') throw httpError(503, 'supervisor_state_corrupt');
		if (ledgerState === 'AMBIGUOUS') throw httpError(503, 'supervisor_state_ambiguous');
	}
	loadLedger();

	// ---------- 回环 RPC（宿主权威；wire 已实测：{type,rpcId,method,payload}） ----------
	// 失败分类（§9C）：definite（宿主结构化拒绝，确定未执行 → 可安全重试）
	//               ambiguous（超时/中断/坏 envelope，结果未知 → fail-closed 标记，不盲重放）
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
				const e = new Error(`bad_envelope:${r.status}`);
				e.ambiguous = true;
				throw e;
			}
			if (j.result?.ok === false) {
				const raw = j.result.error ?? 'upstream_error';
				const msg = typeof raw === 'string' ? raw : JSON.stringify(raw).slice(0, 300);
				const err = new Error(msg);
				err.upstream = true;
				err.definite = true;
				throw err;
			}
			return j.result?.value;
		} catch (e) {
			if (e?.definite) throw e;
			if (e?.name === 'AbortError') {
				const err = new Error('rpc_timeout');
				err.ambiguous = true;
				throw err;
			}
			if (e?.ambiguous) throw e;
			const err = new Error(`rpc_transport:${String(e?.message ?? e).slice(0, 120)}`);
			err.ambiguous = true;
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	async function findSession(sessionId) {
		const value = await rpc('session.list', {});
		const items = value?.items ?? [];
		return items.find((i) => i.sessionId === sessionId) ?? null;
	}

	function findReceiptByTarget({ sessionId, supervisorGoalId } = {}) {
		let hit = null;
		for (const r of receipts.values()) {
			if (supervisorGoalId && r.supervisorGoalId === supervisorGoalId) hit = r;
			else if (!supervisorGoalId && sessionId && r.sessionId === sessionId) hit = r;
			if (hit) break;
		}
		// 双目标不一致 = 旧客户端指向新状态 → 明确冲突
		if (hit && supervisorGoalId && sessionId && hit.sessionId !== sessionId) {
			throw httpError(409, 'supervisor_goal_mismatch', { supervisorGoalId, sessionId });
		}
		return hit;
	}

	/** 读时同步控制态（Official projection wins；仅在真实变化时持久化） */
	function syncControlState(receipt, projection) {
		const d = core.deriveControlState(receipt, projection);
		if (!d.changed) return receipt;
		const updated = { ...receipt, controlState: d.controlState, revision: (receipt.revision ?? 1) + 1, updatedAt: Date.now() };
		receipts.set(receipt.key, updated);
		persistLedger();
		return updated;
	}

	function liveOf(receipt, item) {
		return core.deriveLiveStatus(receipt, item?.projections?.values?.goal ?? null);
	}

	function receiptView(receipt, live) {
		return {
			key: receipt.key,
			supervisorGoalId: receipt.supervisorGoalId,
			sessionId: receipt.sessionId,
			goalRef: live?.ref ?? receipt.goalRef,
			status: live?.status ?? receipt.status,
			controlState: live?.controlState ?? receipt.controlState,
			generation: receipt.generation,
			revision: receipt.revision,
			corrections: receipt.corrections,
			correctionsLeft: receipt.correctionsLeft,
			nextExpectedAction: receipt.nextExpectedAction,
			latestEvidenceId: receipt.latestEvidenceId,
			latestReviewVerdict: receipt.latestReviewVerdict,
			dispatchFingerprint: receipt.dispatchFingerprint ?? null, // R1.2：canonical contract SHA-256（非敏感控制元数据）
		};
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
	 *        409 corrections_exhausted / stale_generation / command_outcome_ambiguous /
	 *            idempotency_conflict（R1.2 dispatch payload identity）/ invalid_control_state /
	 *            supervisor_goal_mismatch（命令目标定位冲突）
	 *        502 upstream_rpc_failed · 503 supervisor_state_corrupt / supervisor_state_ambiguous
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
					if (e?.code) return respond(res, e.code, { ok: false, error: msg, ...e.extra });
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
		ok: true,
		plugin: core.PLUGIN_NAME,
		version: core.PLUGIN_VERSION,
		now: new Date().toISOString(),
		identity: {
			bridgeSha256: sha256Hex(readTextSafe(THIS_FILE) ?? ''),
			coreSha256: sha256Hex(readTextSafe(CORE_FILE) ?? ''),
		},
		ledger: { state: ledgerState, receipts: receipts.size, error: ledgerError },
	}), { get: true });

	route('/supervisor/get_state', async () => {
		const value = await rpc('session.list', {});
		const items = value?.items ?? [];
		const bySession = new Map(items.map((i) => [i.sessionId, i]));
		for (const r of [...receipts.values()]) {
			if (bySession.has(r.sessionId)) syncControlState(r, bySession.get(r.sessionId)?.projections?.values?.goal ?? null);
		}
		return { ok: true, sessions: items.map(core.sanitizeStateItem), ledger: { state: ledgerState, receipts: receipts.size } };
	});

	route('/supervisor/get_goal', async (body) => {
		const v = core.validateSessionQuery(body);
		if (!v.ok) { const e = new Error(v.error); throw e; }
		const item = await findSession(v.value.sessionId);
		if (!item) { const e = new Error('unknown_session'); throw e; }
		const receipt = findReceiptByTarget({ sessionId: v.value.sessionId });
		const live = receipt ? (syncControlState(receipt, item.projections?.values?.goal ?? null), liveOf(receipts.get(receipt.key) ?? receipt, item)) : null;
		return { ok: true, sessionId: v.value.sessionId, ...core.pickGoalProjection(item), ...(receipt ? { supervisor: receiptView(receipts.get(receipt.key) ?? receipt, live) } : {}) };
	});

	route('/supervisor/get_evidence', async (body) => {
		const v = core.validateSessionQuery(body);
		if (!v.ok) { const e = new Error(v.error); throw e; }
		const max = Math.min(200, Math.max(1, Number(body.maxMessages) || 50));
		const item = await findSession(v.value.sessionId);
		if (!item) { const e = new Error('unknown_session'); throw e; }
		const value = await rpc('session.history', { sessionId: v.value.sessionId, maxMessages: max });
		const events = core.sanitizeEvents(value?.events ?? []);
		let receipt = findReceiptByTarget({ sessionId: v.value.sessionId });
		if (receipt) {
			syncControlState(receipt, item.projections?.values?.goal ?? null);
			receipt = receipts.get(receipt.key) ?? receipt;
			const live = liveOf(receipt, item);
			const bundle = core.buildEvidenceBundle(receipt, item.projections?.values?.goal ?? null, {
				events,
				hasMore: !!value?.hasMore,
				running: !!item.running,
				harnessPort: port,
			});
			// evidenceId 跟随 revision 演进（确定性派生，不用时间戳）
			const freshId = core.deriveEvidenceId(receipt.supervisorGoalId, receipt.generation, receipt.revision);
			if (receipt.latestEvidenceId !== freshId) {
				receipts.set(receipt.key, { ...receipt, latestEvidenceId: freshId });
				persistLedger();
				bundle.evidenceId = freshId;
			}
			return { ok: true, sessionId: v.value.sessionId, ...bundle, supervisor: receiptView(receipts.get(receipt.key) ?? receipt, live) };
		}
		// 无 receipt 的会话：最小 bundle（不编造 identity）
		const bundle = core.buildEvidenceBundle(null, item.projections?.values?.goal ?? null, { events, hasMore: !!value?.hasMore, running: !!item.running, harnessPort: port });
		return { ok: true, sessionId: v.value.sessionId, ...bundle };
	});

	route('/supervisor/get_snapshot', async () => {
		const value = await rpc('session.list', {});
		const items = value?.items ?? [];
		const bySession = new Map(items.map((i) => [i.sessionId, i]));
		for (const r of [...receipts.values()]) {
			if (bySession.has(r.sessionId)) syncControlState(r, bySession.get(r.sessionId)?.projections?.values?.goal ?? null);
		}
		const sessions = items.map(core.sanitizeStateItem);
		const goals = items.filter((i) => i.projections?.values?.goal)
			.map((i) => ({ sessionId: i.sessionId, ...core.pickGoalProjection(i) }));
		const rows = [];
		for (const r of receipts.values()) {
			const item = bySession.get(r.sessionId);
			const live = liveOf(r, item);
			rows.push(core.buildSnapshotRow(r, live));
		}
		rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
		const current = rows.find((r) => !core.TERMINAL_CONTROL_STATES.includes(r.currentControlState)) ?? rows[0] ?? null;
		const receiptList = [...receipts.values()].map((r) => ({
			key: r.key, supervisorGoalId: r.supervisorGoalId, sessionId: r.sessionId, status: r.status,
			controlState: r.controlState, generation: r.generation,
			corrections: r.corrections, correctionsLeft: r.correctionsLeft,
		}));
		return {
			ok: true,
			phase: 'P2.75_R1.1',
			host: { ok: true, now: new Date().toISOString(), version: core.PLUGIN_VERSION },
			ledger: { state: ledgerState, receipts: receipts.size, trusted: ledgerState === 'OK' || ledgerState === 'ABSENT', error: ledgerError },
			supervisorGoals: rows,
			current,
			sessions,
			goals,
			receipts: receiptList,
		};
	});

	// ---------- 变更面（全部幂等；§3-§9） ----------
	route('/supervisor/dispatch_goal', async (body) => {
		gateLedgerForMutation();
		const v = core.validateDispatch(body);
		if (!v.ok) { const e = new Error(v.error); throw e; }
		// R1.2 payload identity：同 idempotencyKey 的重放必须与账本指纹一致（§4-§6）
		const dispatchFingerprint = core.dispatchFingerprintOf(v.value);
		const { idempotencyKey } = v.value;
		const existing = receipts.get(idempotencyKey);
		const dispatchCommandId = `DISPATCH:${idempotencyKey}`;
		const resumeNeeded = !!existing
			&& existing.pendingMutation?.kind === 'DISPATCH'
			&& existing.pendingMutation?.commandId === dispatchCommandId
			&& !existing.executedCommands[dispatchCommandId];
		if (existing && !resumeNeeded) {
			// 幂等命中：不重派。R1.2 payload identity 闸门：仅 exact replay 视为 duplicate；
			// payload 不同（objective/initialInstruction/maxGoalRounds/acceptanceCriteria/
			// supervisorGoalId/generation 任一差异）或 legacy receipt 无指纹（无法确定性重建
			// canonical request）→ 409 idempotency_conflict（fail-closed，不猜）。
			if (existing.dispatchFingerprint !== dispatchFingerprint) {
				throw httpError(409, 'idempotency_conflict', {
					reason: existing.dispatchFingerprint ? 'payload_identity_mismatch' : 'legacy_dispatch_fingerprint_missing',
					supervisorGoalId: existing.supervisorGoalId,
				});
			}
			existing.dupHits.dispatch += 1;
			receipts.set(idempotencyKey, existing);
			persistLedger();
			const cur = receipts.get(idempotencyKey);
			const item = await findSession(cur.sessionId);
			syncControlState(cur, item?.projections?.values?.goal ?? null);
			const final = receipts.get(idempotencyKey) ?? cur;
			return {
				ok: true, dispatched: false, duplicate: true,
				generation: final.generation, supervisorGoalId: final.supervisorGoalId,
				receipt: receiptView(final, liveOf(final, item)),
				session: { sessionId: cur.sessionId, running: !!item?.running },
			};
		}
		let sessionId;
		let receipt;
		let applied;
		if (resumeNeeded) {
			// 断点续传：definite 失败后重放 → 从已持久化的 appliedSteps 继续（已执行步骤不重复）。
			// R1.2：续传重放同样必须通过 payload identity 闸门（legacy pending 无指纹 → fail-closed）。
			receipt = receipts.get(idempotencyKey);
			if (receipt.dispatchFingerprint !== dispatchFingerprint) {
				throw httpError(409, 'idempotency_conflict', {
					reason: receipt.dispatchFingerprint ? 'payload_identity_mismatch' : 'legacy_dispatch_fingerprint_missing',
					supervisorGoalId: receipt.supervisorGoalId,
				});
			}
			sessionId = receipt.sessionId;
			applied = receipt.pendingMutation.appliedSteps;
		} else {
			sessionId = core.deriveSessionId(idempotencyKey);
			receipt = core.newReceipt(idempotencyKey, sessionId, v.value.objective, null, Date.now(), {
				supervisorGoalId: v.value.supervisorGoalId,
				acceptanceCriteria: v.value.acceptanceCriteria,
				dispatchFingerprint,
			});
			receipt = core.markPending(receipt, 'DISPATCH', dispatchCommandId, Date.now(), 0);
			receipts.set(idempotencyKey, receipt);
			persistLedger();
			applied = receipt.pendingMutation.appliedSteps;
		}
		let goalRef = receipt.goalRef;
		let running = false;
		try {
			const steps = core.planDispatchSteps(v.value, sessionId, applied);
			for (const step of steps) {
				const value = await rpc(step.method, step.payload);
				applied += 1;
				if (step.method === 'session.create') running = !!(value?.running);
				if (step.method === 'goal.create') goalRef = value?.ref ?? null;
				receipts.set(idempotencyKey, core.markAppliedStep(receipts.get(idempotencyKey), applied));
				persistLedger(); // 断点续传：每步持久化进度（崩溃后跳过已执行步骤）
			}
		} catch (e) {
			if (e.ambiguous) {
				const cur = receipts.get(idempotencyKey);
				receipts.set(idempotencyKey, core.markAmbiguous(cur, dispatchCommandId, Date.now(), e.message));
				persistLedger();
				throw httpError(409, 'command_outcome_ambiguous', { commandId: dispatchCommandId, detail: String(e.message).slice(0, 160), recover: 'observe_get_goal_then_review' });
			}
			// definite 失败：保留 pendingMutation/appliedSteps（已执行步骤不重放），允许安全重试
			throw e;
		}
		const now = Date.now();
		const cur = receipts.get(idempotencyKey);
		receipt = {
			...cur,
			goalRef: goalRef ?? cur.goalRef,
			pendingMutation: null,
			executedCommands: { ...cur.executedCommands, [dispatchCommandId]: { kind: 'DISPATCH', at: now } },
			revision: (cur.revision ?? 1) + 1,
			updatedAt: now,
			history: [...(cur.history ?? []).slice(-99), { at: now, event: 'dispatch_completed', goalRef: goalRef ?? null }],
		};
		receipts.set(idempotencyKey, receipt);
		persistLedger();
		const startPrompt = core.deriveStartPrompt(v.value.objective, v.value.initialInstruction);
		return {
			ok: true, dispatched: true, duplicate: false, resumed: resumeNeeded,
			supervisorGoalId: receipt.supervisorGoalId, generation: receipt.generation,
			receipt: receiptView(receipt, null),
			session: { sessionId, running },
			startPromptOrigin: v.value.initialInstruction ? 'provided' : 'objective-derived',
			startPromptPreview: startPrompt.slice(0, 120),
		};
	});

	route('/supervisor/send_correction', async (body) => {
		gateLedgerForMutation();
		const v = core.validateCorrection(body);
		if (!v.ok) { const e = new Error(v.error); throw e; }
		const { sessionId, supervisorGoalId, commandId, generation, text, mode } = v.value;
		let receipt = findReceiptByTarget({ sessionId, supervisorGoalId });
		let adoptedNow = false;
		if (!receipt) {
			// 收养（GUI 派发的 goal 也可被纠偏，上限同样生效；控制元数据最小化）
			const item = await findSession(sessionId);
			if (!item) { const e = new Error('unknown_session'); throw e; }
			const proj = item.projections?.values?.goal;
			const key = `adopted:${sessionId.slice(-12)}`;
			receipt = core.newReceipt(key, sessionId, proj?.goal?.objective ?? '(adopted)', proj?.goal ? { id: proj.goal.id, revision: proj.goal.revision } : null, Date.now(), {
				adopted: true,
				supervisorGoalId: `sg-adopted-${core.uuidV5(`adopted:${sessionId}`)}`,
			});
			receipts.set(key, receipt);
			persistLedger();
			adoptedNow = true;
		}
		const key = receipt.key;
		// HOTFIX R1（correction 注入目标规范化，2026-08-31）：supervisor_goal_id-only 寻址时
		// validateCommand 返回的 sessionId 是 null（那是"请求携带值"的事实，不是"目标解析"的
		// 事实），下游 session.prompt RPC 必须使用 receipt 的 canonical sessionId
		//（uuidV5(key) 确定性会话），否则宿主 sessions.schema.js 的 sessionId=z.string().min(1)
		// 会 definite 拒绝（P3 真实指纹：pending:CORRECTION 后零事件、corrections 不变、回滚）。
		// 双目标（sg+session）不一致已在 findReceiptByTarget fail-closed（409
		// supervisor_goal_mismatch）；此检查只兜底 receipt 自身目标缺失的异常态，先于任何
		// 消耗/记账触发，fail-closed 零副作用。
		const targetSessionId = receipt.sessionId;
		if (!core.isValidSessionId(targetSessionId)) {
			throw httpError(400, 'invalid_correction_target', { supervisorGoalId: receipt.supervisorGoalId ?? null });
		}
		const dup = core.lookupExecuted(receipt, commandId);
		if (dup) {
			// §5：同 commandId 重放 → 返回已应用凭据，真实副作用不再发生
			if (dup.kind === 'AMBIGUOUS') {
				throw httpError(409, 'command_outcome_ambiguous', { commandId, recover: 'observe_get_evidence_then_review' });
			}
			const cur = receipts.get(key);
			cur.dupHits.correction += 1;
			receipts.set(key, cur);
			persistLedger();
			const final = receipts.get(key);
			return {
				ok: true, duplicate: true, alreadyApplied: true, accepted: false,
				commandId, generation: final.generation, correctionsUsed: final.corrections,
				correctionsLeft: final.correctionsLeft, controlState: final.controlState,
				supervisorGoalId: final.supervisorGoalId, sessionId: final.sessionId,
			};
		}
		const isResume = receipt.pendingMutation?.commandId === commandId && receipt.pendingMutation?.kind === 'CORRECTION';
		if (!isResume) {
			const g = core.gateGeneration(receipt.generation, generation);
			if (!g.ok) {
				if (g.stale) throw httpError(409, 'stale_generation', { currentGeneration: g.currentGeneration, commandGeneration: generation });
				throw httpError(400, 'invalid_generation', { currentGeneration: g.currentGeneration, commandGeneration: generation });
			}
			const gate = core.canCorrect(receipt);
			if (!gate.ok) {
				receipts.set(key, core.recordExhausted(receipt));
				persistLedger();
				const e = new Error('corrections_exhausted');
				e.correctionsUsed = gate.correctionsUsed;
				throw e;
			}
			receipts.set(key, core.markPending(receipt, 'CORRECTION', commandId, Date.now(), 0));
			persistLedger();
		}
		try {
			await rpc('session.prompt', { sessionId: targetSessionId, mode, content: [{ type: 'text', text }] });
		} catch (e) {
			if (e.ambiguous) {
				receipts.set(key, core.markAmbiguous(receipts.get(key), commandId, Date.now(), e.message));
				persistLedger();
				throw httpError(409, 'command_outcome_ambiguous', { commandId, detail: String(e.message).slice(0, 160), recover: 'observe_get_evidence_then_review' });
			}
			// definite 宿主拒绝：确定未执行 → 回滚 pending，允许同 commandId 安全重试
			receipts.set(key, { ...receipts.get(key), pendingMutation: null });
			persistLedger();
			throw e;
		}
		const cmd = { commandId, generation, mode, text };
		receipts.set(key, core.recordCorrection(receipts.get(key), cmd, Date.now()));
		persistLedger();
		const final = receipts.get(key);
		return {
			ok: true, accepted: true, duplicate: false, adopted: adoptedNow,
			commandId, generation: final.generation,
			correctionsUsed: final.corrections, correctionsLeft: final.correctionsLeft,
			controlState: final.controlState, supervisorGoalId: final.supervisorGoalId,
			sessionId: final.sessionId,
		};
	});

	route('/supervisor/cancel_goal', async (body) => {
		gateLedgerForMutation();
		const v = core.validateCancel(body);
		if (!v.ok) { const e = new Error(v.error); throw e; }
		const { sessionId, supervisorGoalId, commandId, generation, action } = v.value;
		let receipt = findReceiptByTarget({ sessionId, supervisorGoalId });
		if (!receipt) {
			const item = await findSession(sessionId);
			if (!item) { const e = new Error('unknown_session'); throw e; }
			const proj = item.projections?.values?.goal;
			const key = `adopted:${sessionId.slice(-12)}`;
			receipt = core.newReceipt(key, sessionId, proj?.goal?.objective ?? '(adopted)', proj?.goal ? { id: proj.goal.id, revision: proj.goal.revision } : null, Date.now(), {
				adopted: true,
				supervisorGoalId: `sg-adopted-${core.uuidV5(`adopted:${sessionId}`)}`,
			});
			receipts.set(key, receipt);
			persistLedger();
		}
		const key = receipt.key;
		const dup = core.lookupExecuted(receipt, commandId);
		if (dup) {
			if (dup.kind === 'AMBIGUOUS') {
				throw httpError(409, 'command_outcome_ambiguous', { commandId, recover: 'observe_get_goal' });
			}
			const cur = receipts.get(key);
			cur.dupHits.cancel += 1;
			receipts.set(key, cur);
			persistLedger();
			const final = receipts.get(key);
			return { ok: true, duplicate: true, alreadyApplied: true, cancelled: dup.action ? true : undefined, action: dup.action ?? final.status.replace('cancelled:', ''), commandId, controlState: final.controlState, supervisorGoalId: final.supervisorGoalId };
		}
		// 已终态 cancel：新 commandId 也不重复执行 goal.*（副作用保持 1）
		if (receipt.controlState === 'CANCELLED' || String(receipt.status ?? '').startsWith('cancelled:')) {
			const prevAction = String(receipt.status ?? 'cancelled:').replace('cancelled:', '');
			const cur = receipts.get(key);
			receipts.set(key, {
				...cur,
				executedCommands: { ...cur.executedCommands, [commandId]: { kind: 'CANCEL', at: Date.now(), action: `noop-already-cancelled:${prevAction}` } },
				dupHits: { ...cur.dupHits, cancel: cur.dupHits.cancel + 1 },
				revision: (cur.revision ?? 1) + 1,
				updatedAt: Date.now(),
			});
			persistLedger();
			const final = receipts.get(key);
			return { ok: true, cancelled: false, alreadyCancelled: true, action: prevAction, commandId, supervisorGoalId: final.supervisorGoalId };
		}
		const g = core.gateGeneration(receipt.generation, generation);
		if (!g.ok) {
			if (g.stale) throw httpError(409, 'stale_generation', { currentGeneration: g.currentGeneration, commandGeneration: generation });
			throw httpError(400, 'invalid_generation', { currentGeneration: g.currentGeneration, commandGeneration: generation });
		}
		receipts.set(key, core.markPending(receipt, 'CANCEL', commandId, Date.now(), 0));
		persistLedger();
		let applied = 0;
		const item0 = await findSession(sessionId);
		const proj0 = item0?.projections?.values?.goal;
		if (proj0?.goal) {
			const ref = { id: proj0.goal.id, revision: proj0.goal.revision };
			try {
				await rpc(`goal.${action}`, { sessionId, ref });
				applied = 1;
				receipts.set(key, core.markAppliedStep(receipts.get(key), 1));
				persistLedger();
			} catch (e) {
				if (e.ambiguous) {
					receipts.set(key, core.markAmbiguous(receipts.get(key), commandId, Date.now(), e.message));
					persistLedger();
					throw httpError(409, 'command_outcome_ambiguous', { commandId, detail: String(e.message).slice(0, 160), recover: 'observe_get_goal' });
				}
				receipts.set(key, { ...receipts.get(key), pendingMutation: null });
				persistLedger();
				throw e;
			}
		}
		try { await rpc('session.cancel', { sessionId }); } catch { /* 会话未在跑：可忽略 */ }
		const cmd = { commandId, generation, action };
		receipts.set(key, core.recordCancel(receipts.get(key), cmd, Date.now()));
		persistLedger();
		const final = receipts.get(key);
		return { ok: true, cancelled: true, action, commandId, supervisorGoalId: final.supervisorGoalId, generation: final.generation, controlState: final.controlState };
	});

	// ---------- review seam（R1.1 §13：真实协议；VERIFIED 仅经显式 review PASS） ----------
	route('/supervisor/review_goal', async (body) => {
		gateLedgerForMutation();
		const v = core.validateReview(body);
		if (!v.ok) { const e = new Error(v.error); throw e; }
		const { sessionId, supervisorGoalId, commandId, generation, verdict, criteriaResults, evidenceId } = v.value;
		const receipt = findReceiptByTarget({ sessionId, supervisorGoalId });
		if (!receipt) { const e = new Error('unknown_session'); throw e; }
		const key = receipt.key;
		const dup = core.lookupExecuted(receipt, commandId);
		if (dup) {
			const cur = receipts.get(key);
			cur.dupHits.review += 1;
			receipts.set(key, cur);
			persistLedger();
			const final = receipts.get(key);
			return { ok: true, duplicate: true, alreadyApplied: true, verdict: dup.verdict ?? final.latestReviewVerdict, commandId, controlState: final.controlState, supervisorGoalId: final.supervisorGoalId };
		}
		const g = core.gateGeneration(receipt.generation, generation);
		if (!g.ok) {
			if (g.stale) throw httpError(409, 'stale_generation', { currentGeneration: g.currentGeneration, commandGeneration: generation });
			throw httpError(400, 'invalid_generation', { currentGeneration: g.currentGeneration, commandGeneration: generation });
		}
		if (receipt.controlState !== 'AWAITING_REVIEW') {
			throw httpError(409, 'invalid_control_state', { currentControlState: receipt.controlState, require: 'AWAITING_REVIEW' });
		}
		const cmd = { commandId, generation, verdict, criteriaResults, evidenceId };
		receipts.set(key, core.recordReview(receipts.get(key), cmd, Date.now(), receipts.get(key).correctionsLeft));
		persistLedger();
		const final = receipts.get(key);
		return {
			ok: true, reviewed: true, duplicate: false, verdict,
			commandId, controlState: final.controlState,
			nextExpectedAction: final.nextExpectedAction,
			correctionsLeft: final.correctionsLeft,
			latestEvidenceId: final.latestEvidenceId,
			supervisorGoalId: final.supervisorGoalId,
		};
	});

	// ---------- 诊断导出（供测试/巡检，不含 token） ----------
	return {
		_diag: () => ({ dataDir, receipts: receipts.size, ledgerState, ledgerError, hasToken: !!token }),
	};
}

export default { name, inject, apply };
