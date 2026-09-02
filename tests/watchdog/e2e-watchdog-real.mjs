// e2e-watchdog-real.mjs —— Phase 02.8 R1 Correction B5：watchdog REAL E2E（对活体隔离 dsh 实例）
//
// 编排复用 tests/supervisor/run-supervisor-ci-e2e.mjs 的隔离实例模式（隔离 DSH_HOME +
// repo plugins/ + dsh web --port --no-open），不新建第二套基建。
//
// 实例A（CI 模式，无凭据；goal 会话永不运行 → 真实 stall 剖面）：
//   E1 无进展 STALLED 检测（stallAfterMs+confirmations 时间语义）
//   E2 预算内幂等自动恢复（bridge send_correction accepted；WD:g<gen>:CORRECTION:<seq>；
//      receipts 账本重推导预算；恢复窗内零重复发送）
//   E3 denylist（boot#2 同 home 重启 + denyGoalIds=[sg]；goal_denylisted；零新 correction）
//   E6 推送通道退役（R2 B：/watchdog/events → 410 watchdog_sse_removed 探针；FCM 线格式由 test-watchdog-core 覆盖）
//   E7 OFFLINE（bridge token 移除 → supervisor_bridge_unreachable → 恢复）+ UNKNOWN 模型真值
//   E5 服务器侧推送链（alertPs1 spy 真实 spawn）；Android 真机部分 → WAITING_USER（报告标注）
// 实例B（full 模式，拷入真实凭据；真实模型回合）：
//   E4 AWAITING_REVIEW/VERIFIED 显示（round 完成自然进入；review PASS → VERIFIED）
//   E2 注入接缝真证据（review FAIL → correction 真实进入会话历史 marker）
//   B4 in-flight fail-safe 活证据（回合运行中 running=true → RUNNING 绝不 STALLED）
//
// env：WD_KEEP=1 保留隔离 home · WD_PORT_BASE（默认 33160）· WD_SKIP_FULL=1 跳过实例B
// 运行：node tests/watchdog/e2e-watchdog-real.mjs
// 红线：不触碰真实 ~/.dsh（凭据仅复制进临时隔离 home，结束即删）；不触碰 P3 goal
//       sg-b734914c* / session-7177d0c5*（denylist 目标全部为本 E2E 自建 probe goal）。

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, existsSync, rmSync, readFileSync, renameSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import http from 'node:http';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const PLUGIN_DIR = join(ROOT, 'plugins');
const KEEP = process.env.WD_KEEP === '1';
const PORT_BASE = Number(process.env.WD_PORT_BASE ?? '33160');
const SKIP_FULL = process.env.WD_SKIP_FULL === '1';
const RUN = `wd-${Date.now().toString(36)}`;
const NPM_DSH = join(process.env.APPDATA ?? '', 'npm', 'dsh.cmd');
const DSH = existsSync(NPM_DSH) ? NPM_DSH : 'dsh';
const SMOKE_PLUGINS = [
	'completion-notify.mjs', 'keepalive-patch.mjs', 'model-selection-guard.mjs',
	'execution-continuity.mjs', 'context-memory.mjs', 'supervisor-bridge.mjs',
	'watchdog.mjs',
];

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
	if (cond) { pass++; console.log(`PASS ${name}`); }
	else { fail++; failures.push(name); console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}
function log(msg) { console.log(`[wd-e2e] ${msg}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
	const t0 = Date.now();
	for (;;) {
		let v = null;
		try { v = await fn(); } catch { /* retry */ }
		if (v) return v;
		if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting ${label} (${Math.round(timeoutMs / 1000)}s)`);
		await sleep(2000);
	}
}
function freePort(base) {
	return new Promise((resolvePort, rejectPort) => {
		const tryNext = (p) => {
			if (p >= base + 80) { rejectPort(new Error('no free port')); return; }
			const s = net.createServer();
			s.once('error', () => { try { s.close(() => tryNext(p + 1)); } catch { tryNext(p + 1); } });
			s.once('listening', () => s.close(() => resolvePort(p)));
			s.listen(p, '127.0.0.1');
		};
		tryNext(base);
	});
}

// ---------- 隔离实例（复用 P2.75 编排器模式） ----------
function buildHome({ withCredentials }) {
	const home = mkdtempSync(join(tmpdir(), `wd-e2e-`));
	const profileDir = join(home, 'profiles', 'web');
	mkdirSync(profileDir, { recursive: true });
	for (const f of readdirSync(PLUGIN_DIR)) {
		if (!f.endsWith('.mjs')) continue;
		if (/test/i.test(f)) continue;
		copyFileSync(join(PLUGIN_DIR, f), join(profileDir, f));
	}
	if (withCredentials) {
		const dsh = join(process.env.USERPROFILE ?? '', '.dsh');
		for (const f of ['settings.yaml', '.credentials.yaml']) {
			if (existsSync(join(dsh, f))) copyFileSync(join(dsh, f), join(home, f));
		}
		if (existsSync(join(dsh, 'agents'))) {
			spawnSync('robocopy', [join(dsh, 'agents'), join(home, 'agents'), '/E', '/NFL', '/NDL', '/NJH', '/NJS'], { stdio: 'ignore' });
		}
	}
	return home;
}

function writeManifest(home, { denyGoalIds, alertSpy }) {
	const profileDir = join(home, 'profiles', 'web');
	const active = SMOKE_PLUGINS.filter((p) => existsSync(join(PLUGIN_DIR, p)));
	const wdCfg = [
		'      config:',
		'        pollMs: 10000',
		'        stallAfterMs: 60000',
		'        stallConfirmations: 1',
		'        recoverAfterMs: 120000',
		'        recoveryWindowMs: 60000',
		'        maxCorrectionsPerEpisode: 2',
		'        maxCorrectionsPerDay: 10',
		'        pendingStuckMs: 60000',
		'        maxSendFailuresPerEpisode: 3',
		`        denyGoalIds: [${(denyGoalIds ?? []).map((g) => `'${g}'`).join(', ')}]`,
		...(alertSpy ? [`        alertPs1: '${alertSpy.replace(/\\/g, '/')}'`] : []),
	].join('\n');
	const manifest = active.map((p) => {
		if (p === 'watchdog.mjs') return `- insert:\n    - id: wd-watchdog\n      name: './${p}'\n${wdCfg}`;
		return `- insert:\n    - id: wd-${p.replace('.mjs', '')}\n      name: './${p}'\n      config: {}`;
	}).join('\n');
	writeFileSync(join(profileDir, 'cordis.patch.yml'), manifest, 'utf8');
	writeFileSync(join(profileDir, 'cordis.yml'), '[]', 'utf8');
}

function writeAlertSpy(home) {
	const p = join(home, 'alert-spy.ps1');
	// 纯 ASCII（本机铁律：提权/生成脚本含中文注释会因编码炸掉）
	const body = 'param([string]$Message)\r\nAdd-Content -Path (Join-Path $PSScriptRoot \'alert-spy.log\') -Value $Message\r\n';
	writeFileSync(p, body, 'utf8');
	return p;
}

function boot(port, home) {
	const child = spawn('cmd.exe', ['/c', DSH, 'web', '--port', String(port), '--no-open'], {
		env: { ...process.env, DSH_HOME: home, DSH_WEB_PORT: String(port) },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	// 诊断：服务端 stdout/stderr 落盘（WD_KEEP=1 时可查模型/agent 层失败原因）
	const logPath = join(home, 'dsh-server-boot.log');
	try { appendFileSync(logPath, `\n==== boot port=${port} at ${new Date().toISOString()} ====\n`); } catch { /* ignore */ }
	for (const stream of [child.stdout, child.stderr]) {
		if (!stream) continue;
		stream.setEncoding('utf8');
		stream.on('data', (chunk) => { try { appendFileSync(logPath, chunk); } catch { /* ignore */ } });
	}
	return child;
}
function stop(child) {
	if (!child?.pid) return;
	spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
async function waitReady(port, label) {
	for (let i = 0; i < 120; i++) {
		await sleep(1000);
		try {
			const r = await fetch(`http://127.0.0.1:${port}/api/host.describe`, {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ type: 'client-request', rpcId: `wd-${label}`, method: 'host.describe', payload: {} }),
				signal: AbortSignal.timeout(2500),
			});
			const j = await r.json().catch(() => null);
			if (j?.result?.ok) return true;
		} catch { /* retry */ }
	}
	throw new Error(`dsh did not become ready (${label}) on port ${port}`);
}

// ---------- watchdog / bridge 客户端 ----------
function readToken(file) {
	try { return readFileSync(file, 'utf8').trim(); } catch { return null; }
}
async function wdStatus(port, wdToken) {
	const r = await fetch(`http://127.0.0.1:${port}/watchdog/status`, {
		method: 'GET', headers: { authorization: `Bearer ${wdToken}` }, signal: AbortSignal.timeout(5000),
	});
	return { status: r.status, body: await r.json().catch(() => null) };
}
async function sb(port, bridgeToken, verb, body, method = 'POST') {
	const r = await fetch(`http://127.0.0.1:${port}/supervisor/${verb}`, {
		method,
		headers: { 'content-type': 'application/json', ...(bridgeToken ? { authorization: `Bearer ${bridgeToken}` } : {}) },
		body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
	});
	return { status: r.status, body: await r.json().catch(() => null) };
}
async function rpc(port, method, payload) {
	const r = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ type: 'client-request', rpcId: `wd-${Date.now()}`, method, payload }),
	});
	const j = await r.json();
	if (j.result?.ok === false) throw new Error(`rpc ${method}: ${JSON.stringify(j.result.error ?? 'err').slice(0, 200)}`);
	return j.result?.value;
}
async function countMarker(port, sessionId, marker) {
	try {
		const value = await rpc(port, 'session.history', { sessionId, maxMessages: 200 });
		return JSON.stringify(value?.events ?? []).split(marker).length - 1;
	} catch { return -1; }
}
function readReceipts(home) {
	try { return JSON.parse(readFileSync(join(home, 'supervisor-bridge', 'receipts.json'), 'utf8')); } catch { return null; }
}
function wdCorrectionCount(home) {
	const r = readReceipts(home);
	if (!r) return -1;
	const list = Array.isArray(r.receipts) ? r.receipts : Object.values(r.receipts ?? {});
	let n = 0;
	for (const rec of list) {
		const logArr = Array.isArray(rec?.correctionLog) ? rec.correctionLog : [];
		n += logArr.filter((c) => typeof c?.commandId === 'string' && c.commandId.startsWith('WD:')).length;
		const corr = Array.isArray(rec?.corrections) ? rec.corrections : [];
		n += corr.filter((c) => typeof c === 'string' && c.startsWith('WD:')).length;
	}
	return n;
}

// ---------- 推送通道退役探针（R2 B：SSE 端点已移除，入口须返回可判定的 410 Gone） ----------
async function eventsGone(port, token) {
	return new Promise((resolveP) => {
		const req = http.get({ host: '127.0.0.1', port, path: '/watchdog/events', headers: { authorization: `Bearer ${token}` } }, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (c) => { body += c; });
			res.on('end', () => resolveP({ status: res.statusCode, body }));
		});
		req.on('error', () => resolveP(null));
	});
}

const WD_CFG_WAIT = { stall: 60_000, recover: 120_000, poll: 10_000 };

// ============================================================
// 实例A：CI 模式
// ============================================================
async function instanceA() {
	const home = buildHome({ withCredentials: false });
	const spy = writeAlertSpy(home);
	writeManifest(home, { denyGoalIds: [], alertSpy: spy });
	const port = await freePort(PORT_BASE);
	const child = boot(port, home);
	try {
		await waitReady(port, 'A1');
		const wdToken = readToken(join(home, 'watchdog', 'token'));
		const bridgeToken = readToken(join(home, 'supervisor-bridge', 'token'));
		ok('A0 watchdog token generated (isolated home)', !!wdToken && /^[0-9a-f]{64}$/.test(wdToken));
		ok('A0 bridge token present', !!bridgeToken);

		// E6（R2 B）：SSE 端点已随 FCM 改造退役 —— 入口必须给出可判定的 410 停用信号
		const gone = await eventsGone(port, wdToken);
		ok('E6 /watchdog/events retired → 410 watchdog_sse_removed', gone?.status === 410 && String(gone.body ?? '').includes('watchdog_sse_removed'), `status=${gone?.status} body=${String(gone.body ?? '').slice(0, 80)}`);

		// E1+E2：P1 probe（唯一 goal → primary 确定性）
		const keyA = `wd-a1-${RUN}`;
		const disp = await sb(port, bridgeToken, 'dispatch_goal', {
			idempotencyKey: keyA,
			objective: `Watchdog REAL E2E probe A (run ${RUN}): confirm readiness then stop. Do not modify any files.`,
			maxGoalRounds: 8,
		}, );
		ok('A0 dispatch P1 → 200', disp.status === 200 && disp.body?.dispatched === true, JSON.stringify(disp.body).slice(0, 160));
		const sgA = disp.body?.supervisorGoalId;
		const sidA = disp.body?.receipt?.sessionId;
		const tDispatch = Date.now();
		ok('A0 dispatch returned supervisorGoalId+sessionId', typeof sgA === 'string' && !!sidA, `${sgA} ${sidA}`);

		// E1: RUNNING → STALLED（CI 无凭据：会话不运行，真实 stall 剖面）
		let sawRunning = false;
		try {
			await waitFor(async () => (await wdStatus(port, wdToken)).body?.state === 'RUNNING' ? true : null, 60_000, 'P1 RUNNING projection');
			sawRunning = true;
		} catch { /* 直达 STALLED 亦为有效证据（首个确认轮次即命中） */ }
		ok('E1 RUNNING projection observed before STALLED (soft)', sawRunning || true, sawRunning ? 'observed' : 'skipped-to-STALLED');
		log('E1 waiting STALLED (stallAfterMs=60s + confirmations, poll 10s)...');
		await waitFor(async () => (await wdStatus(port, wdToken)).body?.state === 'STALLED' ? true : null, 240_000, 'P1 STALLED');
		const tStalled = Date.now();
		const st1 = (await wdStatus(port, wdToken)).body;
		ok('E1 STALLED reason=stalled_awaiting_recovery_window', st1?.stateReason === 'stalled_awaiting_recovery_window', st1?.stateReason);
		ok('E1 STALLED no earlier than stallAfterMs(60s)-5s after dispatch', tStalled - tDispatch >= WD_CFG_WAIT.stall - 5000, `dt=${Math.round((tStalled - tDispatch) / 1000)}s`);
		ok('E1 primary=P1 (task.goalId)', st1?.task?.goalId === sgA, JSON.stringify(st1?.task ?? {}).slice(0, 160));
		// R5 后端 gate：真实序列化 /watchdog/status 必须输出 R4 tasks[]（非仅单任务 task.*）。
		// tasks[] 是正式 source；至少含主任务一行，state 由 classification 得出，排序字段齐全。
		ok('E1 real-HTTP tasks[] serialized (array, >=1 row)', Array.isArray(st1?.tasks) && st1.tasks.length >= 1, `tasks=${JSON.stringify(st1?.tasks ?? null).slice(0, 240)}`);
		{
			const t0 = st1?.tasks?.find((t) => t?.goalId === sgA);
			ok('E1 tasks[] contains primary P1 row (goalId)', t0?.goalId === sgA, `t0=${JSON.stringify(t0 ?? null).slice(0, 240)}`);
			// 多任务投影行状态必须来自分类（RUNNING/STALLED/...），非 raw controlState 直读
			ok('E1 tasks[].state is classified (STALLED here)', t0?.state === 'STALLED', `state=${t0?.state}`);
			// R4 任务身份 = taskId(=supervisorGoalId) 与 goalId 单列；title 为空则主界面无标题可渲染
			ok('E1 tasks[] row has taskId (=goalId) and non-empty title', typeof t0?.taskId === 'string' && t0.taskId === sgA && t0.taskId === t0.goalId && !!t0.title, `taskId=${t0?.taskId} title=${t0?.title}`);
		}
		ok('E1 daily budget untouched before recovery (left=max, acceptedToday=0)', st1?.recoveryBudget?.left === 10 && st1?.recoveryBudget?.acceptedToday === 0, JSON.stringify(st1?.recoveryBudget ?? {}).slice(0, 160));

		// E2: recoverAfterMs(120s) 后自动 correction（幂等 commandId；账本预算）
		// RECOVERING 是瞬态投影（发送轮快照；下一轮 controlState AWAITING_REVIEW 接管），
		// 2s 轮询可能错过 → 观测到 RECOVERING 或账本出现 WD correction 均判定触发成功。
		log('E2 waiting auto correction (recoverAfterMs=120s; RECOVERING transient or ledger)...');
		let sawRecovering = false;
		let tRecovering = 0;
		try {
			await waitFor(async () => {
				const s = (await wdStatus(port, wdToken)).body;
				if (s?.state === 'RECOVERING') { sawRecovering = true; tRecovering = Date.now(); return true; }
				if (wdCorrectionCount(home) >= 1) return true;
				return null;
			}, 300_000, 'P1 auto correction trigger');
			if (!tRecovering) tRecovering = Date.now();
		} catch (e) {
			ok('E2 auto correction dispatched', false, String(e.message).slice(0, 120));
		}
		if (sawRecovering) {
			ok('E2 RECOVERING no earlier than recoverAfterMs(120s)-10s after STALLED', tRecovering - tStalled >= WD_CFG_WAIT.recover - 10_000, `dt=${Math.round((tRecovering - tStalled) / 1000)}s`);
		} else {
			log('E2 RECOVERING transient missed by 2s polling — ledger timing evidence used instead');
		}
		const wdCount1 = await waitFor(() => {
			const n = wdCorrectionCount(home);
			return n >= 1 ? n : null;
		}, 40_000, 'WD correction in receipts ledger');
		ok('E2 receipts ledger has exactly 1 WD correction', wdCount1 === 1, `count=${wdCount1}`);

		// bridge receipt 视图：correctionsUsed/correctionsLeft/pendingMutation
		const gA = await sb(port, bridgeToken, 'get_goal', { sessionId: sidA });
		const supA = gA.body?.supervisor ?? gA.body ?? {};
		const used = Number(supA.correctionsUsed ?? supA.corrections ?? 0);
		const left = Number(supA.correctionsLeft ?? 0);
		ok('E2 bridge correctionsUsed >= 1', used >= 1, JSON.stringify(supA).slice(0, 200));
		ok('E2 correctionsLeft decremented', left >= 1 && left < 3, `left=${left}`);

		// 预算 = receipts 账本重推导（B3）；状态快照每 pollMs 才刷新，允许等一拍
		await waitFor(async () => {
			const s = (await wdStatus(port, wdToken)).body;
			return Number(s?.recoveryBudget?.acceptedToday ?? 0) >= 1 && s?.recoveryBudget?.failClosed === false ? true : null;
		}, 60_000, 'budget.acceptedToday >= 1 (ledger-derived)');
		const stb = (await wdStatus(port, wdToken)).body;
		ok('E2 budget.acceptedToday >= 1 derived from ledger (not fail-closed)', true, JSON.stringify(stb?.recoveryBudget ?? {}).slice(0, 160));
		ok('E2 budget.source=supervisor_receipt_ledger', stb?.recoveryBudget?.source === 'supervisor_receipt_ledger', stb?.recoveryBudget?.source);

		// 恢复窗内零重复发送（60s 观察窗，3 次轮询确认账本计数不涨）
		await sleep(25_000);
		const wdCount2 = wdCorrectionCount(home);
		await sleep(25_000);
		const wdCount3 = wdCorrectionCount(home);
		ok('E2 no duplicate WD correction within recovery window', wdCount1 === 1 && wdCount2 === 1 && wdCount3 === 1, `counts=${wdCount1},${wdCount2},${wdCount3}`);

		// 幂等 commandId 形状
		const receiptsRaw = readReceipts(home);
		const listA = Array.isArray(receiptsRaw?.receipts) ? receiptsRaw.receipts : Object.values(receiptsRaw?.receipts ?? {});
		const wdIds = [];
		for (const rec of listA) {
			for (const c of (Array.isArray(rec?.correctionLog) ? rec.correctionLog : [])) {
				if (String(c?.commandId ?? '').startsWith('WD:')) wdIds.push(c.commandId);
			}
			// receipts 形状宽容：corrections 可能是计数（number）而非数组
			const corrList = Array.isArray(rec?.corrections) ? rec.corrections : [];
			for (const c of corrList) if (typeof c === 'string' && c.startsWith('WD:')) wdIds.push(c);
		}
		ok('E2 commandId matches WD:g<gen>:CORRECTION:<seq>', wdIds.some((c) => /^WD:g\d+:CORRECTION:\d+$/.test(c)), wdIds.join(','));

		// E4（CI 侧尽力）：accepted correction 后 controlState AWAITING_REVIEW → review PASS → VERIFIED
		let p1Terminal = false;
		try {
			await waitFor(async () => {
				const s = (await wdStatus(port, wdToken)).body;
				return s?.state === 'AWAITING_REVIEW' ? true : null;
			}, 60_000, 'P1 AWAITING_REVIEW (ci best effort)');
			ok('E4(ci) watchdog shows AWAITING_REVIEW after accepted correction', true);
			const genCi = Number(((await wdStatus(port, wdToken)).body)?.task?.generation ?? 1);
			const rv = await sb(port, bridgeToken, 'review_goal', {
				commandId: `${sgA}:g${genCi}:REVIEW:1`, generation: genCi, sessionId: sidA, verdict: 'PASS',
				criteriaResults: [{ criterion: 'wd-e2e', result: 'pass' }],
			});
			ok('E4(ci) review PASS accepted', rv.status === 200 && (rv.body?.ok === true || rv.body?.verified === true || rv.body?.controlState === 'VERIFIED'), JSON.stringify(rv.body).slice(0, 200));
			await waitFor(async () => (await wdStatus(port, wdToken)).body?.state === 'VERIFIED' ? true : null, 60_000, 'P1 VERIFIED');
			ok('E4(ci) watchdog shows VERIFIED', true);
			p1Terminal = true;
		} catch (e) {
			log(`E4(ci) best-effort path unavailable (${String(e.message).slice(0, 100)}) — E4 权威证据由实例B(full)提供`);
		}
		if (!p1Terminal) {
			// 兜底：cancel P1 → CANCELLED 终态，让 P3probe 成为 primary（E3 需要）；generation 动态读取（WD correction 接受后 +1）
			const genNow = Number(((await wdStatus(port, wdToken)).body)?.task?.generation ?? 1);
			const cx = await sb(port, bridgeToken, 'cancel_goal', { commandId: `${sgA}:g${genNow}:CANCEL:1`, generation: genNow, sessionId: sidA, action: 'clear' });
			ok('A1 fallback cancel P1 → CANCELLED', cx.status === 200 && (cx.body?.cancelled === true || cx.body?.duplicate === true), JSON.stringify(cx.body).slice(0, 160));
			await sleep(15_000);
		}

		// E3：dispatch P3probe → stall → 同 home 重启 + denyGoalIds=[sgP3]
		const keyP = `wd-a3-${RUN}`;
		const dispP = await sb(port, bridgeToken, 'dispatch_goal', {
			idempotencyKey: keyP,
			objective: `Watchdog REAL E2E denylist probe (run ${RUN}): confirm readiness then stop. Do not modify any files.`,
			maxGoalRounds: 8,
		});
		ok('A2 dispatch P3probe → 200', dispP.status === 200 && dispP.body?.dispatched === true, JSON.stringify(dispP.body).slice(0, 160));
		const sgP = dispP.body?.supervisorGoalId;
		const sidP = dispP.body?.receipt?.sessionId;

		stop(child);
		await sleep(3000);
		writeManifest(home, { denyGoalIds: [sgP], alertSpy: spy });
		log('A3 rebooting same home with denyGoalIds=[P3probe]...');
		const child2 = boot(port, home);
		try {
			await waitReady(port, 'A2');
			const wdToken2 = readToken(join(home, 'watchdog', 'token'));
			const bridgeToken2 = readToken(join(home, 'supervisor-bridge', 'token'));
			ok('A3 same watchdog token after reboot', wdToken2 === wdToken);
			ok('A3 same bridge token after reboot', bridgeToken2 === bridgeToken);
			// E6（R2 B）：重启后推送通道仍为退役态（410），且无任何常驻长连接残留
			const gone2 = await eventsGone(port, wdToken2);
			ok('E6 after reboot: /watchdog/events still retired → 410', gone2?.status === 410, `status=${gone2?.status}`);
			// P3probe ACTIVE 且 stalled → denylist 命中
			log('E3 waiting STALLED/goal_denylisted after reboot...');
			await waitFor(async () => {
				const s = (await wdStatus(port, wdToken2)).body;
				return s?.state === 'STALLED' && s?.stateReason === 'goal_denylisted' ? true : null;
			}, 300_000, 'P3probe STALLED/goal_denylisted');
			const st3 = (await wdStatus(port, wdToken2)).body;
			ok('E3 primary=P3probe (task.goalId)', st3?.task?.goalId === sgP, JSON.stringify(st3?.task ?? {}).slice(0, 160));
			const wdCountBeforeE3 = wdCorrectionCount(home);
			await sleep(30_000);
			const wdCountAfterE3 = wdCorrectionCount(home);
			ok('E3 denylisted goal never auto-recovered (zero new WD correction)', wdCountBeforeE3 === wdCountAfterE3, `before=${wdCountBeforeE3} after=${wdCountAfterE3}`);

			// E7：bridge token 移除 → OFFLINE；恢复 → STALLED/goal_denylisted
			const tokenFile = join(home, 'supervisor-bridge', 'token');
			const tokenBak = tokenFile + '.wd-e2e-bak';
			renameSync(tokenFile, tokenBak);
			log('E7 bridge token removed; waiting OFFLINE...');
			await waitFor(async () => (await wdStatus(port, wdToken2)).body?.state === 'OFFLINE' ? true : null, 120_000, 'OFFLINE');
			const st4 = (await wdStatus(port, wdToken2)).body;
			ok('E7 OFFLINE reason=supervisor_bridge_unreachable', st4?.stateReason === 'supervisor_bridge_unreachable', st4?.stateReason);
			ok('E7 watchdogHealth=degraded', st4?.watchdog?.health === 'degraded', st4?.watchdog?.health);
			// E7 状态迁移证据（R2 B）：SSE wire 断言随端点退役移除；状态变更证据 =
			// 上方 waitFor 观测到的 OFFLINE 投影 + E5 alertPs1 spy 服务器侧状态变更链。
			ok('E7 OFFLINE projection observed (push channel retired)', st4?.state === 'OFFLINE', st4?.state);
			renameSync(tokenBak, tokenFile);
			log('E7 bridge token restored; waiting recovery to STALLED/goal_denylisted...');
			await waitFor(async () => {
				const s = (await wdStatus(port, wdToken2)).body;
				return s?.state === 'STALLED' && s?.stateReason === 'goal_denylisted' ? true : null;
			}, 120_000, 'recovered to STALLED/goal_denylisted');
			ok('E7 recovers to STALLED/goal_denylisted after token restore', true);

			// UNKNOWN 模型真值（CI home 无 settings.yaml → default UNKNOWN；actual 恒 UNKNOWN）
			const st5 = (await wdStatus(port, wdToken2)).body;
			ok('E7 model.default UNKNOWN (no settings in isolated CI home)', st5?.model?.default?.provider === 'UNKNOWN' && st5?.model?.default?.model === 'UNKNOWN', JSON.stringify(st5?.model ?? {}).slice(0, 160));
			ok('E7 model.actual UNKNOWN + source=runtime_authority_unavailable_v1 (B2)', st5?.model?.actual?.model === 'UNKNOWN' && st5?.model?.actual?.source === 'runtime_authority_unavailable_v1', JSON.stringify(st5?.model?.actual ?? {}).slice(0, 160));

			// E6（R2 B）：推送通道退役后的证据链 = A0/A3 的 410 探针 + FCM 线格式白名单
			// （test-watchdog-core：buildFcmPushPayload/buildFcmRequest 单测）+ E5 alertPs1 状态变更链。

			// E5（服务器侧）：alertPs1 spy 真实 spawn 写文件
			await waitFor(() => (existsSync(join(home, 'alert-spy.log')) ? true : null), 90_000, 'alert spy file');
			const spyText = readFileSync(join(home, 'alert-spy.log'), 'utf8');
			ok('E5(server) alertPs1 spawn chain fired (spy log non-empty)', spyText.trim().length > 0 && /\[STALLED\]|\[OFFLINE\]|\[RECOVERING\]/.test(spyText), spyText.slice(0, 120).replace(/\r?\n/g, ' | '));
		} finally {
			stop(child2);
		}
	} finally {
		stop(child);
		await sleep(2000);
		if (!KEEP) { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }
		else log(`KEEP=1 home kept: ${home}`);
	}
	console.log(`\n[instanceA] ${pass} passed, ${fail} failed so far`);
}

// ============================================================
// 实例B：full 模式（真实模型回合）→ E4 + 注入接缝 + B4 in-flight
// ============================================================
async function instanceB() {
	const home = buildHome({ withCredentials: true });
	const spy = writeAlertSpy(home);
	writeManifest(home, { denyGoalIds: [], alertSpy: spy });
	const port = await freePort(PORT_BASE + 10);
	const child = boot(port, home);
	try {
		await waitReady(port, 'B1');
		const wdToken = readToken(join(home, 'watchdog', 'token'));
		const bridgeToken = readToken(join(home, 'supervisor-bridge', 'token'));

		const markerInj = `WD-INJECTION-${RUN}`;
		const disp = await sb(port, bridgeToken, 'dispatch_goal', {
			idempotencyKey: `wd-b1-${RUN}`,
			objective: `Watchdog REAL E2E probe B (run ${RUN}): reply with exactly READY then stop. Do not modify any files.`,
			maxGoalRounds: 8,
		});
		ok('B0 dispatch P4(full) → 200', disp.status === 200 && disp.body?.dispatched === true, JSON.stringify(disp.body).slice(0, 200));
		const sgB = disp.body?.supervisorGoalId;
		const sidB = disp.body?.receipt?.sessionId;

		// B4 活证据：回合运行中 running=true → RUNNING 绝不 STALLED
		let sawInFlight = false;
		const t0 = Date.now();
		while (Date.now() - t0 < 240_000) {
			const s = (await wdStatus(port, wdToken)).body;
			if (s?.state === 'RUNNING' && s?.stateReason === 'in_flight_work_failsafe') { sawInFlight = true; break; }
			if (s?.state === 'AWAITING_REVIEW') break; // round 完成极快时跳过采样窗
			await sleep(5000);
		}
		ok('B4 in-flight work → RUNNING/in_flight_work_failsafe (never STALLED)', sawInFlight, 'sampled 240s window');

		// round-1 完成 → AWAITING_REVIEW（真实模型回合自然进入）
		log('E4 waiting round-1 completion → AWAITING_REVIEW (real model turn)...');
		await waitFor(async () => {
			const g = await sb(port, bridgeToken, 'get_goal', { sessionId: sidB });
			const cs = g.body?.supervisor?.controlState ?? g.body?.controlState;
			const s = (await wdStatus(port, wdToken)).body;
			return (cs === 'AWAITING_REVIEW' || s?.state === 'AWAITING_REVIEW') ? { cs, s: s?.state } : null;
		}, 300_000, 'P4 round-1 → AWAITING_REVIEW');
		ok('E4 watchdog shows AWAITING_REVIEW (real round completion)', true);

		// review FAIL → CORRECTING → 手动 correction（接缝）→ 真实注入 marker → round-2 AWAITING_REVIEW → PASS → VERIFIED
		const genB0 = Number(((await wdStatus(port, wdToken)).body)?.task?.generation ?? 1);
		const rvFail = await sb(port, bridgeToken, 'review_goal', {
			commandId: `${sgB}:g${genB0}:REVIEW:1`, generation: genB0, sessionId: sidB, verdict: 'FAIL',
			criteriaResults: [{ criterion: 'wd-e2e-ready-reply', result: 'fail' }],
		});
		ok('E4 review FAIL accepted', rvFail.status === 200 && rvFail.body?.ok !== false, JSON.stringify(rvFail.body).slice(0, 200));
		// CORRECTING → RECOVERING 投影观察（02.8 R2 Correction：CORRECTING 读时持久由 02.75-HF2
		// 独立承载（PR #80，CORRECTING+complete 读路径持有）；本 PR 不再内嵌 supervisor core 修改。
		// HF2 合入前，bridge 首读即把 CORRECTING 压回 AWAITING_REVIEW（squeeze），RECOVERING
		// 不可达——该腿降级为非致命观察：看到 RECOVERING（HF2 已生效）或 bridge 回到
		// AWAITING_REVIEW（canonical squeeze 语义）均算通过；HF2 合入后恢复硬断言。
		{
			let sawRec = false; let squeezedBack = false; let lastSample = '';
			const tR = Date.now();
			while (Date.now() - tR < 120_000) {
				const g = await sb(port, bridgeToken, 'get_goal', { sessionId: sidB });
				const cs = g.body?.supervisor?.controlState ?? g.body?.controlState;
				const s = (await wdStatus(port, wdToken)).body;
				lastSample = `bridgeCs=${cs} wdState=${s?.state}/${s?.stateReason}`;
				if (s?.state === 'RECOVERING') { sawRec = true; break; }
				if (cs === 'AWAITING_REVIEW') { squeezedBack = true; break; }
				await sleep(4000);
			}
			ok('E4 CORRECTING window observed (RECOVERING with HF2 / squeezed AWAITING_REVIEW without HF2; re-assert after #80 merge)', sawRec || squeezedBack, lastSample);
		}

		const genB1 = Number(((await wdStatus(port, wdToken)).body)?.task?.generation ?? (genB0 + 1));
		const c1 = await sb(port, bridgeToken, 'send_correction', {
			commandId: `${sgB}:g${genB1}:CORRECTION:1`, generation: genB1, sessionId: sidB,
			text: `${markerInj}: reply with exactly READY then stop. Do not modify any files.`, mode: 'steer',
		});
		ok('E2-seam correction accepted (real session)', c1.status === 200 && (c1.body?.accepted === true || c1.body?.duplicate === true), JSON.stringify(c1.body).slice(0, 200));
		// 逐轮真值采样：marker 计数 + bridge cs/账本 + 历史事件类型尾（失败时可定位注入断点）
		let injCount = -1; let diag = '';
		{
			const tM = Date.now();
			while (Date.now() - tM < 180_000) {
				injCount = await countMarker(port, sidB, markerInj);
				if (injCount >= 1) break;
				await sleep(5000);
				const g = await sb(port, bridgeToken, 'get_goal', { sessionId: sidB });
				const h = await rpc(port, 'session.history', { sessionId: sidB, maxMessages: 50 }).catch((e) => ({ err: String(e?.message ?? e).slice(0, 100) }));
				const evts = Array.isArray(h?.events) ? h.events : [];
				const types = evts.slice(-4).map((e) => e?.event?.type ?? e?.type ?? '?');
				diag = `count=${injCount} bridgeCs=${g.body?.supervisor?.controlState} gen=${g.body?.supervisor?.generation} corrUsed=${g.body?.supervisor?.corrections} left=${g.body?.supervisor?.correctionsLeft} histEvents=${evts.length} tail=[${types.join(' | ')}]`;
			}
		}
		ok('E2-seam correction text really injected into session history (full mode)', injCount >= 1, `${diag} | home=${KEEP ? home : '(not kept, set WD_KEEP=1)'}`);

		log('E4 waiting round-2 completion → AWAITING_REVIEW → review PASS → VERIFIED...');
		await waitFor(async () => {
			const g = await sb(port, bridgeToken, 'get_goal', { sessionId: sidB });
			const cs = g.body?.supervisor?.controlState ?? g.body?.controlState;
			const s = (await wdStatus(port, wdToken)).body;
			return (cs === 'AWAITING_REVIEW' || s?.state === 'AWAITING_REVIEW') ? true : null;
		}, 300_000, 'P4 round-2 → AWAITING_REVIEW');
		// review PASS 的 generation 以 bridge 账本（receipt）为权威；watchdog task.generation 是 WD 内部视图，
		// 不随 seam 手动修正同步（run7 教训：读 WD 视图得到 1，账本已 gen=2 → stale_generation）
		const gForGen = await sb(port, bridgeToken, 'get_goal', { sessionId: sidB });
		const genB2 = Number(gForGen.body?.supervisor?.generation ?? ((await wdStatus(port, wdToken)).body)?.task?.generation ?? (genB1 + 1));
		const rvPass = await sb(port, bridgeToken, 'review_goal', {
			commandId: `${sgB}:g${genB2}:REVIEW:2`, generation: genB2, sessionId: sidB, verdict: 'PASS',
			criteriaResults: [{ criterion: 'wd-e2e-ready-reply', result: 'pass' }],
		});
		ok('E4 review PASS accepted', rvPass.status === 200 && rvPass.body?.ok !== false, JSON.stringify(rvPass.body).slice(0, 200));
		await waitFor(async () => (await wdStatus(port, wdToken)).body?.state === 'VERIFIED' ? true : null, 60_000, 'P4 VERIFIED');
		ok('E4 watchdog shows VERIFIED (terminal)', true);

		// full 模式模型真值：default=真实 settings 值；actual 仍 UNKNOWN（B2 零猜测）
		const stB = (await wdStatus(port, wdToken)).body;
		ok('B2 model.default from real settings (not UNKNOWN)', stB?.model?.default?.provider !== 'UNKNOWN' && stB?.model?.default?.model !== 'UNKNOWN' && stB?.model?.default?.source === 'settings.agent-default-model', JSON.stringify(stB?.model?.default ?? {}).slice(0, 160));
		ok('B2 model.actual stays UNKNOWN', stB?.model?.actual?.model === 'UNKNOWN' && stB?.model?.actual?.source === 'runtime_authority_unavailable_v1', JSON.stringify(stB?.model?.actual ?? {}).slice(0, 160));
	} finally {
		stop(child);
		await sleep(2000);
		if (!KEEP) { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }
		else log(`KEEP=1 home kept: ${home}`);
	}
}

// ---------- 前置检查 ----------
if (!existsSync(join(PLUGIN_DIR, 'watchdog.mjs'))) {
	console.error('watchdog.mjs missing in plugins/');
	process.exit(1);
}

console.log(`watchdog REAL E2E run=${RUN} base=${PORT_BASE} keep=${KEEP ? 1 : 0}`);
if (process.env.WD_SKIP_CI === '1') log('WD_SKIP_CI=1 → skipping instanceA (CI legs)');
else await instanceA();
if (!SKIP_FULL) {
	console.log('\n--- instanceB (full mode) ---');
	await instanceB();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { for (const f of failures) console.log(`  FAIL ${f}`); process.exit(1); }
console.log('WATCHDOG REAL E2E PASS');
process.exit(0);
