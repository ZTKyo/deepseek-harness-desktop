// watchdog.mjs — Phase 02.8 Supervisor Runtime Watchdog（宿主插件）
//
// 定位（Notion 02.8）：Supervisor 的轻量观察/有界恢复层，不是第二 Task Supervisor Authority。
//   - 只读权威：每 pollMs 回环拉取 supervisor-bridge get_snapshot / get_state（同一权威投影）；
//   - 心跳：in-host 监听全部 session/event（turn/tool 活动 = 有效进展信号，长命令不误判）；
//   - 投影：watchdog-core 纯函数 → IDLE/RUNNING/STALLED/RECOVERING/AWAITING_REVIEW/BLOCKED/VERIFIED
//           （UI 层补充 OFFLINE/UNKNOWN，不进任务 Authority）；
//   - 恢复：只经既有 /supervisor/send_correction（幂等 commandId WATCHDOG:g<gen>:CORRECTION:<seq>
//           + generation gate + bridge 预算闸 + 本层 episode/日预算 + denylist）；不创建 Goal、
//           不跨 Phase、不 cancel/review/dispatch；
//   - 推送：投影状态变化 → spawn 既有 telegram-alert.ps1（同 completion-notify 模式）；
//   - 落盘：仅 ~/.dsh/watchdog/last-snapshot.json（脱敏投影，Widget last-known 用途）；
//   - 红线：无 shell/write 通道（除 telegram-alert spawn）；不读写 sessions/** storages/**；
//           token 不进日志/聊天；不放宽 CORS；禁第二真相源。
//
// 只读路由（Bearer = ~/.dsh/watchdog/token）：
//   GET /watchdog/health   → { ok, plugin, version, state, watchdogHealth }
//   GET /watchdog/status   → 脱敏 snapshot（adapter 8091 同名路由的 upstream）

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
	const cfg = { ...core.normalizeConfig(config), pushOnStateChange: config.pushOnStateChange !== false, alertPs1: typeof config.alertPs1 === 'string' ? config.alertPs1 : null };
	const dataDir = join(dshHome(), 'watchdog');
	const tokenFile = join(dataDir, 'token');
	const snapshotFile = join(dataDir, 'last-snapshot.json');
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
	const bridgeTokenFile = join(dshHome(), 'supervisor-bridge', 'token');
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

	ctx.on('session/event', (session, event) => {
		try {
			const sid = session?.id ?? session?.sessionId;
			if (sid) heartbeats.set(sid, Date.now());
		} catch { /* 心跳永不影响事件流 */ }
	});

	// ---------- 模型真值（settings.yaml agent-default-model；mtime 缓存，不打印内容） ----------
	const settingsFile = join(dshHome(), 'settings.yaml');
	let modelCache = { at: 0, value: null };
	function readModelTruth() {
		const now = Date.now();
		if (modelCache.value && now - modelCache.at < SETTINGS_POLL_MS) return modelCache.value;
		let value = { provider: 'UNKNOWN', model: 'UNKNOWN', source: 'unavailable' };
		try {
			const text = readFileSync(settingsFile, 'utf8');
			const m = /agent-default-model:\s*\r?\n\s*provider:\s*([^\s#]+)\s*\r?\n\s*model:\s*([^\s#]+)/.exec(text);
			if (m) value = { provider: m[1], model: m[2], source: 'settings.agent-default-model' };
		} catch { /* keep UNKNOWN */ }
		modelCache = { at: now, value };
		return value;
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

	// ---------- 推送（状态变化 → 既有 Telegram 通道；一次性状态迁移防抖） ----------
	function pushState(state, snapshot) {
		if (cfg.pushOnStateChange !== false && lastPushState !== undefined && state !== lastPushState && Date.now() - lastPushAt > 30_000) {
			const alertPs1 = config.alertPs1;
			const task = snapshot?.task?.name ? String(snapshot.task.name).slice(0, 40) : '(no task)';
			const model = `${snapshot?.model?.model ?? 'UNKNOWN'}@${snapshot?.model?.provider ?? 'UNKNOWN'}`;
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
		lastPushState = state;
	}

	// ---------- 有界恢复执行（只经既有 bridge mutation；结果只记录，不重试循环） ----------
	async function runRecovery(recovery) {
		if (!recovery || recovery.kind !== 'correction') return;
		if (typeof recovery.supervisorGoalId !== 'string' || !recovery.supervisorGoalId) return;
		const bt = readTokenFile(bridgeTokenFile);
		if (!bt) return;
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
		} catch (e) {
			ctx.logger?.warn?.(`watchdog: recovery send failed (${String(e?.message ?? e).slice(0, 80)})`);
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
			const evaluated = core.evaluate({
				now, cfg, bridgeOk, snapshot: snapshotForEval,
				heartbeats: Object.fromEntries(heartbeats),
				prev, episode,
			});
			episode = { ...core.blankEpisode(), ...evaluated.episodePatch };
			lastEvaluated = evaluated;
			const sanitized = core.sanitizeSnapshot({ now, evaluated, model: readModelTruth(), pollMs: cfg.pollMs });
			prev = sanitized;
			writeSnapshotAtomic(sanitized);
			pushState(sanitized.state, sanitized);
			if (evaluated.recovery) await runRecovery(evaluated.recovery);
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
	setInterval(poll, cfg.pollMs);

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

	ctx.logger?.info?.(`watchdog: active (pollMs=${cfg.pollMs}, stallAfterMs=${cfg.stallAfterMs}, recoverAfterMs=${cfg.recoverAfterMs})`);
}
