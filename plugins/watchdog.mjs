// watchdog.mjs — Phase 02.8 Supervisor Runtime Watchdog（宿主插件）
//
// 定位（Notion 02.8）：Supervisor 的轻量观察/有界恢复层，不是第二 Task Supervisor Authority。
//   - 只读权威：每 pollMs 回环拉取 supervisor-bridge get_snapshot / get_state（同一权威投影）；
//   - 心跳：in-host 监听全部 session/event（turn/tool 活动 = 有效进展信号，长命令不误判）；
//   - 投影：watchdog-core 纯函数 → IDLE/RUNNING/STALLED/RECOVERING/AWAITING_REVIEW/BLOCKED/VERIFIED
//           （UI 层补充 OFFLINE/UNKNOWN，不进任务 Authority）；
//   - 恢复：只经既有 /supervisor/send_correction（幂等 commandId WD:g<gen>:CORRECTION:<seq>
//           + generation gate + bridge 预算闸 + denylist）；不创建 Goal、不跨 Phase、
//           不 cancel/review/dispatch；
//   - 预算（R1 §1.4）：每日自动 correction 预算 = 从既有 bridge receipts 账本只读推导的
//           「今日已接受数」——bridge 真正执行才计数；definite 注入失败不消耗（同 commandId
//           幂等重试，上限内）；ambiguous fail-closed 不重发转人工；重启不丢（每轮重推导）；
//   - 推送：投影状态变化 → ① 既有 telegram-alert.ps1；② SSE 事件通道 /watchdog/events
//           （R1 B1：只推 wake/revision/event-id 元数据，不推内容；Widget 实时刷新）；
//   - 落盘：~/.dsh/watchdog/last-snapshot.json（脱敏投影）+ budget.json（预算交叉核对元数据，
//           非权威——权威是账本重推导）；
//   - 红线：无 shell/write 通道（除 telegram-alert spawn）；不读写 sessions/** storages/**；
//           token 不进日志/聊天；不放宽 CORS；禁第二真相源。
//
// 只读路由（Bearer = ~/.dsh/watchdog/token）：
//   GET /watchdog/health   → { ok, plugin, version, state, watchdogHealth }
//   GET /watchdog/status   → 脱敏 snapshot（adapter 8091 同名路由的 upstream）
//   GET /watchdog/events   → text/event-stream（SSE；state_change 事件 + 15s 心跳注释）

import * as core from './watchdog-core.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';

export const name = 'watchdog';
export const inject = ['webServer'];

const PLUGIN_NAME = 'watchdog';
const FETCH_TIMEOUT_MS = 10_000;
const SETTINGS_POLL_MS = 30_000;
const LEDGER_POLL_MS = 10_000;
const SSE_HEARTBEAT_MS = 15_000;
const SSE_MAX_CLIENTS = 3;

function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

function checkAuth(header, expectedToken) {
	if (typeof expectedToken !== 'string' || expectedToken.length < 32) return false;
	const m = /^Bearer\s+(.+)$/i.exec(String(header ?? '').trim());
	if (!m) return false;
	const given = Buffer.from(m[1], 'utf8');
	const want = Buffer.from(expectedToken, 'utf8');
	if (given.length !== want.length) return false;
	return timingSafeEqual(given, want);
}

function respond(res, code, body) {
	const text = JSON.stringify(body);
	res.writeHead(code, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
	});
	res.end(text);
}

function readTokenFile(file) {
	try {
		const raw = readFileSync(file, 'utf8').trim();
		return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
	} catch {
		return null;
	}
}

export function apply(ctx, config = {}) {
	const cfg = {
		...core.normalizeConfig(config),
		pushOnStateChange: config.pushOnStateChange !== false,
		alertPs1: typeof config.alertPs1 === 'string' ? config.alertPs1 : null,
		// bridge token 文件覆盖（宿主/隔离测试用；normalizeConfig 白名单不透传，需在此显式带过）
		bridgeTokenFile: typeof config.bridgeTokenFile === 'string' && config.bridgeTokenFile ? config.bridgeTokenFile : null,
		// R1 E2：确定性故障注入（仅 WD_TEST_MODE=1 的隔离实例测试用；生产恒 false）
		testFailInjection: process.env.WD_TEST_MODE === '1' && config.testFailInjection === true,
		testAmbiguousInjection: process.env.WD_TEST_MODE === '1' && config.testAmbiguousInjection === true,
	};
	const dataDir = join(dshHome(), 'watchdog');
	const tokenFile = join(dataDir, 'token');
	const snapshotFile = join(dataDir, 'last-snapshot.json');
	const budgetFile = join(dataDir, 'budget.json');
	mkdirSync(dataDir, { recursive: true });

	// token（首次自动生成；永不出现在日志/报告）
	let token = readTokenFile(tokenFile);
	if (!token) {
		token = randomBytes(32).toString('hex');
		writeFileSync(tokenFile, token + '\n', { encoding: 'utf8' });
		ctx.logger?.info?.('watchdog: token generated (not logged)');
	}

	// 上游（adapter→本路由）持有同一 token 文件（WATCHDOG_TOKEN_FILE 默认即此）；本插件自身
	// 的路由校验也用它——单一只读凭据，与 bridge/MCP token 完全分离。
	// cfg.bridgeTokenFile 允许宿主/测试覆盖（如 smoke 用隔离 DSH_HOME 仍要读真实 bridge token）。
	const bridgeTokenFile = cfg.bridgeTokenFile ?? join(dshHome(), 'supervisor-bridge', 'token');
	const receiptsFile = join(dshHome(), 'supervisor-bridge', 'receipts.json');
	const port = Number(ctx.webServer?.port) || Number(process.env.DSH_WEB_PORT) || 3080;
	const base = `http://127.0.0.1:${port}`;

	// ---------- 运行态（内存；不构成第二真相源，真值始终在权威面） ----------
	const heartbeats = new Map(); // sessionId -> last session/event at
	let prev = null;              // 上一轮脱敏 snapshot（进展指纹）
	let episode = core.blankEpisode();
	let lastPushState = undefined;
	let polling = false;
	let lastEvaluated = null;
	let lastPushAt = 0;
	let lastBudget = null;

	ctx.on('session/event', (session, event) => {
		try {
			const sid = session?.id ?? session?.sessionId;
			if (sid) heartbeats.set(sid, Date.now());
		} catch { /* 心跳永不影响事件流 */ }
	});

	// ---------- 模型真值（settings.yaml agent-default-model；mtime 缓存，不打印内容） ----------
	// R1 B2：settings 只给 default（配置级事实）；每 turn 实际模型在宿主无只读权威端点 →
	// actual 恒 UNKNOWN（core.normalizeModelTruth 兜底），绝不把 default 伪装成 actual。
	const settingsFile = join(dshHome(), 'settings.yaml');
	let modelCache = { at: 0, value: null };
	function readModelTruth() {
		const now = Date.now();
		if (modelCache.value && now - modelCache.at < SETTINGS_POLL_MS) return modelCache.value;
		let value = { default: { provider: 'UNKNOWN', model: 'UNKNOWN', source: 'unavailable' } };
		try {
			const text = readFileSync(settingsFile, 'utf8');
			const m = /agent-default-model:\s*\r?\n\s*provider:\s*([^\s#]+)\s*\r?\n\s*model:\s*([^\s#]+)/.exec(text);
			if (m) value = { default: { provider: m[1], model: m[2], source: 'settings.agent-default-model' } };
		} catch { /* keep UNKNOWN */ }
		modelCache = { at: now, value };
		return value;
	}

	// ---------- R1 §1.4：恢复预算（bridge receipts 账本只读推导；mtime 缓存） ----------
	let ledgerCache = { at: 0, text: null, mtime: 0 };
	function readLedger() {
		const now = Date.now();
		if (ledgerCache.text && now - ledgerCache.at < LEDGER_POLL_MS) return ledgerCache.text;
		let text = null;
		try {
			const mtime = statSync(receiptsFile).mtimeMs;
			if (ledgerCache.text && mtime === ledgerCache.mtime) {
				ledgerCache.at = now;
				return ledgerCache.text;
			}
			text = readFileSync(receiptsFile, 'utf8');
			ledgerCache = { at: now, text, mtime };
		} catch {
			text = null; // 文件缺失/不可读 → deriveBudget fail-closed
			ledgerCache = { at: now, text: null, mtime: 0 };
		}
		return text;
	}

	function writeBudgetAtomic(budget) {
		const body = JSON.stringify({ ...budget, updatedAt: new Date().toISOString(), note: 'cross-check metadata; authoritative source = supervisor receipts ledger re-derivation' }, null, 1);
		const tmp = budgetFile + '.tmp';
		try {
			writeFileSync(tmp, body, 'utf8');
			renameSync(tmp, budgetFile);
		} catch { /* 落盘失败不影响预算权威（账本重推导） */ }
	}

	// ---------- bridge 回环读取（只读权威面） ----------
	async function fetchBridge(pathname) {
		const bt = readTokenFile(bridgeTokenFile);
		if (!bt) return { ok: false, status: 0, json: null, error: 'bridge_token_unreadable' };
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
		try {
			const res = await fetch(base + pathname, {
				method: 'POST',
				headers: { authorization: `Bearer ${bt}`, 'content-type': 'application/json' },
				body: '{}',
				signal: ac.signal,
			});
			const json = await res.json().catch(() => null);
			return { ok: res.status === 200, status: res.status, json, error: null };
		} catch (e) {
			return { ok: false, status: 0, json: null, error: String(e?.message ?? e).slice(0, 120) };
		} finally {
			clearTimeout(t);
		}
	}

	// ---------- SSE 事件通道（R1 B1；只推状态/revision/event-id 元数据） ----------
	const sseClients = new Set();
	let sseEventSeq = 0;
	function sseWrite(client, chunk) {
		try { client.res.write(chunk); } catch { /* 下次遍历清理 */ }
	}
	function broadcastStateChange(sanitized) {
		if (sseClients.size === 0) return;
		sseEventSeq += 1;
		const eid = `evt-${Date.now()}-${sseEventSeq}`;
		const payload = JSON.stringify({
			v: 1, ev: 'state_change', state: sanitized?.state ?? null,
			prevState: lastPushState ?? null, rev: sanitized?.task?.revision ?? null,
			gen: sanitized?.task?.generation ?? null, eid, ts: new Date().toISOString(),
		});
		for (const c of sseClients) sseWrite(c, `event: state_change\ndata: ${payload}\n\n`);
	}
	function sseHeartbeat() {
		for (const c of sseClients) sseWrite(c, ': hb\n\n');
	}
	const sseHeartbeatTimer = setInterval(sseHeartbeat, SSE_HEARTBEAT_MS);
	sseHeartbeatTimer.unref?.();

	function openSse(req, res) {
		if (sseClients.size >= SSE_MAX_CLIENTS) {
			respond(res, 503, { ok: false, error: 'sse_client_limit_reached' });
			return;
		}
		res.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store',
			'connection': 'keep-alive',
			'x-accel-buffering': 'no',
		});
		res.write(': connected\n\n');
		const client = { res, req };
		sseClients.add(client);
		// 连接即补发当前状态快照（Widget 冷启动不必等下一次变更）
		if (prev) {
			sseEventSeq += 1;
			const payload = JSON.stringify({
				v: 1, ev: 'state_change', state: prev.state, prevState: null,
				rev: prev.task?.revision ?? null, gen: prev.task?.generation ?? null,
				eid: `evt-${Date.now()}-${sseEventSeq}`, ts: new Date().toISOString(),
			});
			sseWrite(client, `event: state_change\ndata: ${payload}\n\n`);
		}
		req.on('close', () => { sseClients.delete(client); });
	}

	// ---------- 推送（状态变化 → 既有 Telegram 通道 + SSE；一次性状态迁移防抖） ----------
	function pushState(state, snapshot) {
		if (cfg.pushOnStateChange !== false && lastPushState !== undefined && state !== lastPushState && Date.now() - lastPushAt > 30_000) {
			const alertPs1 = config.alertPs1;
			const task = snapshot?.task?.name ? String(snapshot.task.name).slice(0, 40) : '(no task)';
			const model = `${snapshot?.model?.default?.model ?? 'UNKNOWN'}@${snapshot?.model?.default?.provider ?? 'UNKNOWN'}`;
			const prog = snapshot?.progress?.lastProgressAt ?? 'n/a';
			const msg = `👁️ HARNESS [${state}] ${task} | ${model} | watchdog:${snapshot?.watchdog?.health ?? 'unknown'} | reason:${snapshot?.stateReason ?? '-'} | lastProgress:${prog}`;
			if (typeof alertPs1 === 'string' && existsSync(alertPs1)) {
				try {
					const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', alertPs1, msg], { stdio: 'ignore', windowsHide: true });
					child.on('error', () => { /* 推送失败不影响观察 */ });
				} catch { /* ignore */ }
			}
			lastPushAt = Date.now();
		}
		broadcastStateChange(snapshot);
		lastPushState = state;
	}

	// ---------- 有界恢复执行（只经既有 bridge mutation；结果三分类 → core.applySendOutcome） ----------
	// 分类规则（R1 §1.4）：bridge 明确 accepted/duplicate → 记账；连接被拒/4xx/5xx（明确未执行，
	// bridge 已回滚 pending）→ definite_failure（不消耗预算，同 commandId 幂等重试至多
	// maxSendFailuresPerEpisode 次）；超时/连接中断/bridge 报 command_outcome_ambiguous →
	// ambiguous（fail-closed：不重发，转人工/等待 reconcile）。
	async function runRecovery(recovery) {
		if (!recovery || recovery.kind !== 'correction') return { kind: 'ignored' };
		if (typeof recovery.supervisorGoalId !== 'string' || !recovery.supervisorGoalId) return { kind: 'ignored' };
		if (cfg.testFailInjection) {
			ctx.logger?.warn?.('watchdog: [TEST] injected definite failure before send');
			return { kind: 'definite_failure', error: 'test_injected_definite_failure', commandId: recovery.commandId };
		}
		if (cfg.testAmbiguousInjection) {
			ctx.logger?.warn?.('watchdog: [TEST] injected ambiguous outcome');
			return { kind: 'ambiguous', error: 'test_injected_ambiguous', commandId: recovery.commandId };
		}
		const bt = readTokenFile(bridgeTokenFile);
		if (!bt) return { kind: 'definite_failure', error: 'bridge_token_unreadable', commandId: recovery.commandId };
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
		try {
			const res = await fetch(base + '/supervisor/send_correction', {
				method: 'POST',
				headers: { authorization: `Bearer ${bt}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					supervisorGoalId: recovery.supervisorGoalId,
					commandId: recovery.commandId,
					generation: recovery.generation,
					text: recovery.text,
					mode: recovery.mode,
				}),
				signal: ac.signal,
			});
			const json = await res.json().catch(() => null);
			ctx.logger?.info?.(`watchdog: recovery commandId=${recovery.commandId} -> HTTP ${res.status} duplicate=${!!json?.duplicate}`);
			if (res.ok && json?.ok === true && json?.accepted === true) return { kind: 'accepted', commandId: recovery.commandId };
			if (res.ok && json?.duplicate === true) return { kind: 'duplicate', commandId: recovery.commandId };
			if (json?.error === 'command_outcome_ambiguous') return { kind: 'ambiguous', error: 'bridge_ambiguous', commandId: recovery.commandId };
			// 4xx/5xx（stale_generation / corrections_exhausted / invalid_* / 5xx）：bridge 明确
			// 未执行 correction（definite 路径已回滚 pendingMutation）→ 不消耗预算
			return { kind: 'definite_failure', error: `http_${res.status}:${String(json?.error ?? 'rejected').slice(0, 80)}`, commandId: recovery.commandId };
		} catch (e) {
			const msg = String(e?.message ?? e);
			// 超时/连接中断 = 发送后结果未知 → ambiguous（绝不重发，防双 correction）
			return { kind: 'ambiguous', error: msg.slice(0, 120), commandId: recovery.commandId };
		} finally {
			clearTimeout(t);
		}
	}

	function writeSnapshotAtomic(snapshot) {
		const tmp = snapshotFile + '.tmp';
		try {
			writeFileSync(tmp, JSON.stringify(snapshot, null, 1), 'utf8');
			renameSync(tmp, snapshotFile);
		} catch { /* 落盘失败不影响观察 */ }
	}

	// ---------- 主循环 ----------
	async function poll() {
		if (polling) return;
		polling = true;
		const now = Date.now();
		try {
			const [snap, st] = await Promise.all([fetchBridge('/supervisor/get_snapshot'), fetchBridge('/supervisor/get_state')]);
			const bridgeOk = snap.ok && st.ok && snap.json?.ok === true && st.json?.ok === true;
			const snapshotForEval = bridgeOk
				? { ...snap.json, sessions: st.json?.sessions ?? snap.json?.sessions ?? [] }
				: null;
			const budget = core.deriveBudget({ ledgerText: readLedger(), cfg, now });
			lastBudget = budget;
			const evaluated = core.evaluate({
				now, cfg, bridgeOk, snapshot: snapshotForEval,
				heartbeats: Object.fromEntries(heartbeats),
				prev, episode, budget,
			});
			episode = { ...core.blankEpisode(), ...evaluated.episodePatch };
			lastEvaluated = evaluated;
			const sanitized = core.sanitizeSnapshot({ now, evaluated, model: readModelTruth(), pollMs: cfg.pollMs, budget });
			prev = sanitized;
			writeSnapshotAtomic(sanitized);
			writeBudgetAtomic(budget);
			pushState(sanitized.state, sanitized);
			if (evaluated.recovery) {
				const outcome = await runRecovery(evaluated.recovery);
				// 发送结果记账（R1 §1.4）：只有 accepted/duplicate 消耗 episode 计数；
				// definite_failure 不消耗预算（重试同 commandId）；ambiguous fail-closed。
				episode = core.applySendOutcome(episode, outcome, {
					now: Date.now(),
					maxSendFailuresPerEpisode: cfg.maxSendFailuresPerEpisode,
				});
			}
		} catch (e) {
			ctx.logger?.warn?.(`watchdog: poll error (${String(e?.message ?? e).slice(0, 100)})`);
		} finally {
			polling = false;
		}
	}

	// 心跳表防膨胀：只保留最近 2h 活跃
	setInterval(() => {
		const cut = Date.now() - 2 * 3600_000;
		for (const [k, v] of heartbeats) if (v < cut) heartbeats.delete(k);
	}, 10 * 60_000).unref?.();

	setTimeout(poll, 5_000).unref?.();
	setInterval(poll, cfg.pollMs).unref?.();

	// ---------- 只读路由 ----------
	function route(pathName, handler) {
		ctx.webServer?.register({
			kind: 'exact',
			path: pathName,
			handler: async (req, res) => {
				try {
					if (req.method !== 'GET') return respond(res, 405, { ok: false, error: 'method_not_allowed' });
					if (!checkAuth(req.headers.authorization, token)) return respond(res, 401, { ok: false, error: 'unauthorized' });
					const out = await handler();
					return respond(res, 200, out);
				} catch {
					return respond(res, 500, { ok: false, error: 'internal_error' });
				}
			},
		});
	}

	route('/watchdog/health', () => ({
		ok: true,
		plugin: PLUGIN_NAME,
		version: core.WATCHDOG_VERSION,
		schemaVersion: core.SCHEMA_VERSION,
		state: prev?.state ?? null,
		watchdogHealth: prev?.watchdog?.health ?? null,
		now: new Date().toISOString(),
	}));

	route('/watchdog/status', () => {
		if (!prev) return { ok: false, error: 'snapshot_not_ready' };
		return { ok: true, ...prev };
	});

	// SSE 事件通道（R1 B1；同一 watchdog token 鉴权；头部鉴权，不用 query 传 token）
	ctx.webServer?.register({
		kind: 'exact',
		path: '/watchdog/events',
		handler: async (req, res) => {
			if (req.method !== 'GET') { respond(res, 405, { ok: false, error: 'method_not_allowed' }); return; }
			if (!checkAuth(req.headers.authorization, token)) { respond(res, 401, { ok: false, error: 'unauthorized' }); return; }
			openSse(req, res);
		},
	});

	ctx.logger?.info?.(`watchdog: active (pollMs=${cfg.pollMs}, stallAfterMs=${cfg.stallAfterMs}, recoverAfterMs=${cfg.recoverAfterMs}, budgetSource=supervisor_receipt_ledger, sse=on)`);
}
