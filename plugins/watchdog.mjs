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
//   - 推送：投影状态变化 → ① 既有 telegram-alert.ps1（桌面旁路）；② FCM data-message
//           （R2 B，取代 R1 B1 SSE：Widget 收到 eventId/revision/wake 白名单元数据后
//           自行 GET /watchdog/status；凭据仅 Secret Store，不入 Git/日志/路由）；
//   - 落盘：~/.dsh/watchdog/last-snapshot.json（脱敏投影）+ budget.json（预算交叉核对元数据，
//           非权威——权威是账本重推导）；
//   - 红线：无 shell/write 通道（除 telegram-alert spawn）；不读写 sessions/** storages/**；
//           token 不进日志/聊天；不放宽 CORS；禁第二真相源。
//
// 只读路由（Bearer = ~/.dsh/watchdog/token）：
//   GET /watchdog/health   → { ok, plugin, version, state, watchdogHealth }
//   GET /watchdog/status   → 脱敏 snapshot（adapter 8091 同名路由的 upstream）
//   （R2 B：原 GET /watchdog/events SSE 端点已移除——手机侧改 FCM data-message 唤醒，
//     桌面侧 Telegram 保留；不再有前台长连接消费方）

import * as core from './watchdog-core.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, timingSafeEqual, createSign } from 'node:crypto';
import { spawn } from 'node:child_process';

export const name = 'watchdog';
export const inject = ['webServer'];

const PLUGIN_NAME = 'watchdog';
const FETCH_TIMEOUT_MS = 25_000; // bridge 2-7s typical, >10s under contention: 10s caused 60s OFFLINE latch (R5)
const SETTINGS_POLL_MS = 30_000;
const LEDGER_POLL_MS = 10_000;
// ---------- R2 B：FCM 推送常量 ----------
const FCM_OAUTH_URL = 'https://oauth2.googleapis.com/token';
const FCM_OAUTH_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_SA_REF = 'FCM_SERVICE_ACCOUNT_JSON';   // 服务账号 JSON（单行字符串；Secret Store）
const FCM_JWT_TTL_SEC = 3600;
const FCM_TOKEN_REFRESH_MARGIN_MS = 120_000;
const FCM_SA_CACHE_MS = 300_000;                 // SA JSON 解析缓存（内存；不落盘不打日志）

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
	// R4（§7）：完成时间冻结薄 cache（内存态；只存 { taskId: { completedAt, timeSource } }，不存正文、
	// 非 Task Authority、可安全重建——进程重启后丢失仅导致重新 firstObservedTerminalAt，不漂移不误报）。
	// 一经冻结持续到进程生命周期内的下一次 refresh，完成时间不再随刷新前进（§7 核心）。
	let terminalCache = {};

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
		async function once(signal) {
			try {
				const res = await fetch(base + pathname, {
					method: 'POST',
					headers: { authorization: `Bearer ${bt}`, 'content-type': 'application/json' },
					body: '{}',
					signal,
				});
				const json = await res.json().catch(() => null);
				// HTTP 200 with body.ok=false is a definitive (authoritative) negative -> do NOT retry
				if (res.status === 200 && json?.ok === false) return { ok: false, status: 200, json, error: 'bridge_ok_false' };
				return { ok: res.status === 200, status: res.status, json, error: null };
			} catch (e) {
				return { ok: false, status: 0, json: null, error: String(e?.message ?? e).slice(0, 120) };
			}
		}
		// First attempt with FETCH_TIMEOUT_MS; on transient failure (network/timeout, NOT a
		// definitive ok:false) retry once with a fresh AbortController so a brief bridge
		// spike doesn't latch a full pollMs OFFLINE window. (R5 correction)
		for (let attempt = 0; attempt < 2; attempt++) {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
			try {
				const r = await once(ac.signal);
				if (attempt === 0 && !r.ok && r.status === 0) { clearTimeout(t); continue; } // transient -> retry once
				return r;
			} finally {
				clearTimeout(t);
			}
		}
		// unreachable
		return { ok: false, status: 0, json: null, error: 'bridge_unreachable' };
	}

	// ---------- FCM 推送（R2 B，取代 R1 B1 SSE 事件通道） ----------
	// 凭据仅 Secret Store（FCM_SERVICE_ACCOUNT_JSON；SA JSON 单行字符串，含 project_id/
	// client_email/private_key）。解析缓存仅内存；任何值不进日志/路由/落盘。
	// 目标 = topic 'watchdog'（Widget 端 FirebaseMessaging 订阅；免存 device token）。
	// 未配置 → 记一次 info 后静默跳过（Widget 自动落到 30min 兜底轮询 + 手动刷新）。
	const fcmCache = { sa: null, saAt: 0, token: null, tokenExpAt: 0, seq: 0, missingLogged: false };
	let lastFcmAt = 0;
	let lastFcmRev = null;
	let lastFcmState = null;
	// R4：多任务变更指纹（§5/§6 per-task trigger）。shape = "taskId:state:revision" 排序拼接，
	// 任一任务 state/revision 变化 → 唤醒手机（Widget 视图有任务级状态迁移，不再只看主任务）。
	// 首轮只登记基线不推送；冷启动仍由 Widget 兜底轮询覆盖。
	let lastFcmTasksSig = null;
	let lastFcmTasksCount = null;

	function b64url(input) {
		return Buffer.from(input).toString('base64url');
	}

	async function resolveFcmSecret() {
		try {
			const credentials = ctx.get?.('credentials');
			const hit = credentials?.resolve ? await credentials.resolve(FCM_SA_REF) : undefined;
			if (hit?.value) return String(hit.value).trim();
		} catch { /* 回退直读凭据库 */ }
		try {
			const credFile = join(dshHome(), '.credentials.yaml');
			const text = readFileSync(credFile, 'utf8');
			const m = new RegExp(`^\\s*${FCM_SA_REF}\\s*:\\s*(.+?)\\s*$`, 'm').exec(text);
			if (m?.[1]) return m[1].trim();
		} catch { /* 凭据库不可读 = FCM 未配置 */ }
		return null;
	}

	function parseServiceAccount(raw) {
		const obj = JSON.parse(raw);
		if (typeof obj?.client_email !== 'string' || typeof obj?.private_key !== 'string' || typeof obj?.project_id !== 'string') {
			throw new Error('service_account_json_missing_fields');
		}
		return obj;
	}

	async function fcmAccessToken(sa) {
		const now = Date.now();
		if (fcmCache.token && now < fcmCache.tokenExpAt) return fcmCache.token;
		const nowSec = Math.floor(now / 1000);
		const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
		const claims = b64url(JSON.stringify({
			iss: sa.client_email,
			scope: FCM_OAUTH_SCOPE,
			aud: FCM_OAUTH_URL,
			iat: nowSec,
			exp: nowSec + FCM_JWT_TTL_SEC,
		}));
		const signingInput = `${header}.${claims}`;
		const signature = createSign('RSA-SHA256').update(signingInput).sign(sa.private_key, 'base64url');
		const assertion = `${signingInput}.${signature}`;
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
		try {
			const res = await fetch(FCM_OAUTH_URL, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
				signal: ac.signal,
			});
			const json = await res.json().catch(() => null);
			if (!res.ok || typeof json?.access_token !== 'string' || !json.access_token) {
				throw new Error(`oauth_http_${res.status}`);
			}
			fcmCache.token = json.access_token;
			fcmCache.tokenExpAt = now + Math.max(60, (Number(json.expires_in) || 3600) * 1000 - FCM_TOKEN_REFRESH_MARGIN_MS);
			return fcmCache.token;
		} finally {
			clearTimeout(t);
		}
	}

	// 状态/revision 变化即推送（fire-and-forget；失败仅 warn 状态码，绝不影响观察主循环）。
	// 节流由 fcmPushState 的「变化才触发」承担，这里不再重复设窗（避免自我阻塞）。
	async function fcmSendStateChange(sanitized) {
		try {
			const now = Date.now();
			if (!fcmCache.sa || now - fcmCache.saAt > FCM_SA_CACHE_MS) {
				const raw = await resolveFcmSecret();
				fcmCache.sa = raw ? parseServiceAccount(raw) : null;
				fcmCache.saAt = now;
				if (!fcmCache.sa && !fcmCache.missingLogged) {
					fcmCache.missingLogged = true;
					ctx.logger?.info?.('watchdog: fcm disabled (FCM_SERVICE_ACCOUNT_JSON not configured; widget falls back to 30min poll)');
				}
			}
			const sa = fcmCache.sa;
			if (!sa) return;
			fcmCache.seq += 1;
			const payload = core.buildFcmPushPayload({ evaluated: sanitized, eventId: fcmCache.seq });
			const request = core.buildFcmRequest({ projectId: sa.project_id, payload });
			if (!request.ok) {
				ctx.logger?.warn?.(`watchdog: fcm request build failed (${request.error})`);
				return;
			}
			const bearer = await fcmAccessToken(sa);
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
			try {
				const res = await fetch(request.url, {
					method: 'POST',
					headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
					body: JSON.stringify(request.body),
					signal: ac.signal,
				});
				if (!res.ok) ctx.logger?.warn?.(`watchdog: fcm push failed (http ${res.status})`);
			} finally {
				clearTimeout(t);
			}
		} catch (e) {
			ctx.logger?.warn?.(`watchdog: fcm push error (${String(e?.message ?? e).slice(0, 80)})`);
		}
	}

	function fcmPushState(sanitized) {
		const state = sanitized?.state ?? null;
		const rev = sanitized?.task?.revision ?? null;
		// R4：多任务指纹（含任务级状态迁移）。仅当 tasks[] 存在时启用；空数组用旧基线。
		const taskRows = Array.isArray(sanitized?.tasks) ? sanitized.tasks : null;
		let tasksSig = null;
		let tasksCount = null;
		if (taskRows && taskRows.length > 0) {
			// 稳定排序（taskId 字典序）拼 "taskId:state:revision"；空数组/全 null 视为无信号。
			const sigParts = taskRows
				.slice()
				.sort((a, z) => String(a?.taskId ?? '').localeCompare(String(z?.taskId ?? '')))
				.map((t) => `${t?.taskId ?? '?'}:${t?.state ?? '?'}:${t?.revision ?? '?'}`);
			if (sigParts.length) {
				tasksSig = sigParts.join('|');
				tasksCount = taskRows.length;
			}
		}
		if (lastFcmState === null && lastFcmRev === null && lastFcmTasksSig === null) {
			// 首轮观测只登记基线，不推送（冷启动由 Widget 兜底轮询覆盖）。
			lastFcmState = state;
			lastFcmRev = rev;
			lastFcmTasksSig = tasksSig;
			lastFcmTasksCount = tasksCount;
			return;
		}
		const multiChanged = tasksSig !== null
			&& (tasksSig !== lastFcmTasksSig || tasksCount !== lastFcmTasksCount);
		if (state !== lastFcmState || (rev !== null && rev !== lastFcmRev) || multiChanged) {
			lastFcmState = state;
			lastFcmRev = rev;
			lastFcmTasksSig = tasksSig;
			lastFcmTasksCount = tasksCount;
			lastFcmAt = Date.now();
			void fcmSendStateChange(sanitized);
		}
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
		fcmPushState(snapshot);
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
			// R4：多任务投影（§4/§6/§7）。从同一权威 snapshot 派生 tasks[]（排序 + 完成冻结），
			// terminalCache 往返传入传出以在 refresh 间保持完成时间不漂移。
			const proj = core.projectTasks({
				now, cfg, snapshot: snapshotForEval,
				heartbeats: Object.fromEntries(heartbeats),
				terminalCache,
				primaryId: evaluated?.primary?.id ?? null,
			});
			terminalCache = proj.terminalCachePatch;
			const sanitized = core.sanitizeSnapshot({ now, evaluated, model: readModelTruth(), pollMs: cfg.pollMs, budget, tasks: proj.tasks, terminalCachePatch: proj.terminalCachePatch });
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

	// （R2 B）原 /watchdog/events SSE 路由已删除：手机侧 FCM data-message 唤醒 +
	// 30min 兜底轮询取代前台长连接；桌面侧 Telegram 旁路不变。
	// 旧入口保留显式退役信号（与 supervisor-mcp-adapter/server.mjs 单一真值一致）：
	// GET-only → Bearer 401 → 410 watchdog_sse_removed。旧客户端拿到可判定的
	// Gone（而非 404/挂起），零 mutation、零状态读取。
	ctx.webServer?.register({
		kind: 'exact',
		path: '/watchdog/events',
		handler: async (req, res) => {
			if (req.method !== 'GET') return respond(res, 405, { ok: false, error: 'method_not_allowed' });
			if (!checkAuth(req.headers.authorization, token)) return respond(res, 401, { ok: false, error: 'unauthorized' });
			return respond(res, 410, {
				ok: false,
				error: 'watchdog_sse_removed',
				replacement: 'fcm_data_message+poll_fallback',
				detail: 'push moved to FCM data-message; poll GET /watchdog/status remains (PHASE_02_8 R2 B).',
			});
		},
	});

	ctx.logger?.info?.(`watchdog: active (pollMs=${cfg.pollMs}, stallAfterMs=${cfg.stallAfterMs}, recoverAfterMs=${cfg.recoverAfterMs}, budgetSource=supervisor_receipt_ledger, push=fcm+fallback-poll)`);
}
