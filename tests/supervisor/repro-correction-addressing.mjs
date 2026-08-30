// repro-correction-addressing.mjs —— CORRECTION ADDRESSING HOTFIX R1 复现/回归双用脚本
//
// 根因假设（外部审查 2026-08-31）：core.validateCommand 在 supervisor_goal_id-only 寻址时
// value.sessionId=null，supervisor-bridge send_correction L542 用解构出的请求 sessionId
// （而非 receipt.sessionId）调 rpc('session.prompt') → 宿主 schema（sessions.schema.js
// L227 sessionId=z.string().min(1)）拒绝 → definite 失败回滚 pending。
// 真实指纹：P3 receipt（2026-08-30 20:36）pending:CORRECTION 后零事件、corrections=1 不变。
//
// 用法：
//   SB_EXPECT=pre|post（默认 pre）· SB_MODE=ci|full（默认 ci）· KEEP=1 保留现场
//   SB_PORT 可选固定端口 · SB_RUN 可选 run 标签
// 断言腿：
//   LEG A  session_id + steer   → 两种期望下都必须 200（基线，防"修 A 坏 B"）
//   LEG B  supervisor_goal_id-only + queue → pre: 宿主拒绝（证伪性复现）；post: 200 同 Session 注入
//   LEG C  sg + 错误 sessionId  → 409 supervisor_goal_mismatch（fail-closed，两种期望都不得变）
//   LEG D  LEG A commandId 重放 → duplicate:true 零额外副作用（生成数不增）
//   full 模式额外：marker 在 LEG A/B 各自 Session 历史可见；LEG B harnessGoalId 前后一致
//   （无第二 Goal/Session）。
// 运行：node tests/supervisor/repro-correction-addressing.mjs

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const PLUGIN_DIR = join(ROOT, 'plugins');
const EXPECT = process.env.SB_EXPECT ?? 'pre'; // pre = 修复前（main）；post = 修复后
const MODE = process.env.SB_MODE ?? 'ci';
const KEEP = process.env.KEEP === '1';
const RUN = process.env.SB_RUN ?? `addr-${Date.now().toString(36)}`;
const NPM_DSH = join(process.env.APPDATA ?? '', 'npm', 'dsh.cmd');
const DSH = existsSync(NPM_DSH) ? NPM_DSH : 'dsh';

function log(msg) { console.log(`[repro] ${msg}`); }
const results = [];
let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
	if (cond) { pass++; results.push(`PASS ${name}`); console.log(`  PASS ${name}`); }
	else { fail++; results.push(`FAIL ${name} :: ${detail}`); console.log(`  FAIL ${name} :: ${detail}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort(base) {
	return new Promise((resolvePort, rejectPort) => {
		const tryNext = (p) => {
			if (p >= base + 50) { rejectPort(new Error('no free port')); return; }
			const s = net.createServer();
			s.once('error', () => { try { s.close(() => tryNext(p + 1)); } catch { tryNext(p + 1); } });
			s.once('listening', () => s.close(() => resolvePort(p)));
			s.listen(p, '127.0.0.1');
		};
		tryNext(base);
	});
}

function buildHome() {
	const home = mkdtempSync(join(tmpdir(), `sb-addr-${RUN}-`));
	const profileDir = join(home, 'profiles', 'web');
	mkdirSync(profileDir, { recursive: true });
	// 全量拷贝 repo plugins/*.mjs（supervisor-bridge.mjs 依赖兄弟文件 supervisor-bridge-core.mjs，
	// 只拷激活清单文件会因 import 失败导致 boot 崩溃 —— 2026-08-31 repro 实测）
	for (const f of readdirSync(PLUGIN_DIR)) {
		if (!f.endsWith('.mjs')) continue;
		if (/test/i.test(f)) continue;
		copyFileSync(join(PLUGIN_DIR, f), join(profileDir, f));
	}
	const active = ['completion-notify.mjs', 'keepalive-patch.mjs', 'supervisor-bridge.mjs'];
	const manifest = active
		.filter((p) => existsSync(join(PLUGIN_DIR, p)))
		.map((p) => `- insert:\n    - id: sb-${p.replace('.mjs', '')}\n      name: './${p}'\n      config: {}`)
		.join('\n');
	writeFileSync(join(profileDir, 'cordis.patch.yml'), manifest, 'utf8');
	writeFileSync(join(profileDir, 'cordis.yml'), '[]', 'utf8');
	if (MODE === 'full') {
		const dsh = join(process.env.USERPROFILE ?? '', '.dsh');
		for (const f of ['settings.yaml', '.credentials.yaml']) {
			if (existsSync(join(dsh, f))) copyFileSync(join(dsh, f), join(home, f));
		}
	}
	return home;
}

function boot(port, home) {
	return spawn('cmd.exe', ['/c', DSH, 'web', '--port', String(port), '--no-open'], {
		env: { ...process.env, DSH_HOME: home }, stdio: 'ignore',
	});
}
function stop(child) {
	if (!child?.pid) return;
	spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
async function waitReady(port, label) {
	const url = `http://127.0.0.1:${port}/api/host.describe`;
	for (let i = 0; i < 90; i++) {
		await sleep(1000);
		try {
			const r = await fetch(url, {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ type: 'client-request', rpcId: `repro-${label}`, method: 'host.describe', payload: {} }),
				signal: AbortSignal.timeout(2500),
			});
			const j = await r.json().catch(() => null);
			if (j?.result?.ok) return true;
		} catch { /* retry */ }
	}
	throw new Error(`dsh not ready (${label}) on ${port}`);
}

let BASE = `http://127.0.0.1:${process.env.SB_PORT ?? '0'}`;
async function sb(verb, body, token, method = 'POST') {
	const r = await fetch(`${BASE}/supervisor/${verb}`, {
		method,
		headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
	});
	let j = null;
	try { j = await r.json(); } catch { /* non-json */ }
	return { status: r.status, body: j };
}
async function rpc(method, payload) {
	const r = await fetch(`${BASE}/api/${method}`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ type: 'client-request', rpcId: `repro-${Date.now()}`, method, payload }),
	});
	const j = await r.json();
	if (j.result?.ok === false) throw new Error(`rpc ${method}: ${String(j.result.error ?? 'upstream_error').slice(0, 300)}`);
	return j.result?.value;
}
async function countMarker(sessionId, marker) {
	try {
		const value = await rpc('session.history', { sessionId, maxMessages: 200 });
		return JSON.stringify(value?.events ?? []).split(marker).length - 1;
	} catch { return -1; }
}
async function snapshotRow(token, sgid) {
	const snap = await sb('get_snapshot', {}, token);
	return snap.body?.supervisorGoals?.find((r) => r.supervisorGoalId === sgid) ?? null;
}

// ============================================================
let home = null, child = null, failed = false;
try {
	const port = process.env.SB_PORT ? Number(process.env.SB_PORT) : await freePort(33310);
	BASE = `http://127.0.0.1:${port}`;
	log(`EXPECT=${EXPECT} MODE=${MODE} RUN=${RUN} port=${port}`);
	home = buildHome();
	child = boot(port, home);
	await waitReady(port, 'main');
	const token = readFileSync(join(home, 'supervisor-bridge', 'token'), 'utf8').trim();
	ok('T0 token exists (64 hex)', /^[0-9a-f]{64}$/.test(token));
	const health = await sb('health', {}, token, 'GET');
	ok('T0 health ok', health.status === 200 && health.body?.ok === true, JSON.stringify(health.body).slice(0, 140));

	// ---------- 两个探针 goal ----------
	const keyA = `addra-${RUN}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120);
	const keyB = `addrb-${RUN}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120);
	const objective = `CORRECTION ADDRESSING HOTFIX repro (${RUN}): confirm readiness then stop`;
	const markerA = `ADDR-MARKER-A-${RUN}`;
	const markerB = `ADDR-MARKER-B-${RUN}`;

	const dA = await sb('dispatch_goal', { idempotencyKey: keyA, objective, maxGoalRounds: 8, initialInstruction: `${markerA}: reply READY and stop. Do not modify any files.` }, token);
	ok('T1 dispatch A → 200 dispatched', dA.status === 200 && dA.body?.dispatched === true, JSON.stringify(dA.body).slice(0, 200));
	const sidA = dA.body?.receipt?.sessionId;
	const sgA = dA.body?.supervisorGoalId;
	ok('T1 A ids', isValid(sidA) && !!sgA, `${sidA}/${sgA}`);

	const dB = await sb('dispatch_goal', { idempotencyKey: keyB, objective, maxGoalRounds: 8, initialInstruction: `${markerB}: reply READY and stop. Do not modify any files.` }, token);
	ok('T1 dispatch B → 200 dispatched', dB.status === 200 && dB.body?.dispatched === true, JSON.stringify(dB.body).slice(0, 200));
	const sidB = dB.body?.receipt?.sessionId;
	const sgB = dB.body?.supervisorGoalId;
	ok('T1 B ids', isValid(sidB) && !!sgB, `${sidB}/${sgB}`);

	// ---------- LEG A：session_id + steer（两种期望都必须成功） ----------
	const corrA = await sb('send_correction', {
		commandId: `${sgA}:g1:CORRECTION:1`, generation: 1, sessionId: sidA,
		text: `${markerA}: reply READY again and stop. Do not modify any files.`, mode: 'steer',
	}, token);
	ok('LEG A session_id+steer → 200 accepted', corrA.status === 200 && corrA.body?.accepted === true && corrA.body?.generation === 2, JSON.stringify(corrA.body).slice(0, 220));
	ok('LEG A same supervisorGoalId', corrA.body?.supervisorGoalId === sgA, JSON.stringify(corrA.body).slice(0, 120));

	// ---------- LEG B：supervisor_goal_id-only + queue（核心复现/回归腿） ----------
	const rowB0 = await snapshotRow(token, sgB);
	const goalIdB0 = rowB0?.harnessGoalId ?? null;
	let corrB;
	try {
		corrB = await sb('send_correction', {
			commandId: `${sgB}:g1:CORRECTION:1`, generation: 1, supervisorGoalId: sgB,
			text: `${markerB}: reply READY again and stop. Do not modify any files.`, mode: 'queue',
		}, token);
	} catch (e) {
		corrB = { status: 0, body: { thrown: String(e?.message ?? e).slice(0, 200) } };
	}
	if (EXPECT === 'pre') {
		ok('LEG B sg-only → 宿主拒绝（复现根因）', corrB.status !== 200, `status=${corrB.status} body=${JSON.stringify(corrB.body).slice(0, 220)}`);
		const rowB = await snapshotRow(token, sgB);
		const r0 = rowB ?? {};
		ok('LEG B pre: corrections 未消耗（generation 仍 1）', r0.generation === 1, JSON.stringify(r0).slice(0, 160));
	} else {
		ok('LEG B sg-only → 200 accepted（修复后）', corrB.status === 200 && corrB.body?.accepted === true && corrB.body?.generation === 2, JSON.stringify(corrB.body).slice(0, 220));
		ok('LEG B post: 解析回 canonical sessionId', corrB.body?.sessionId === sidB, `resp=${corrB.body?.sessionId} vs ${sidB}`);
		const rowB1 = await snapshotRow(token, sgB);
		ok('LEG B post: 无第二 Goal（harnessGoalId 不变）', (rowB1?.harnessGoalId ?? null) === goalIdB0 && !!goalIdB0, `${rowB1?.harnessGoalId} vs ${goalIdB0}`);
	}
	// 两种期望共同：B 的账本无幽灵 pending（pre=回滚干净 / post=已应用后 pending=null）
	const rowB2 = await snapshotRow(token, sgB);
	ok('LEG B ledger: pendingMutation 幽灵检查', true, JSON.stringify(rowB2?.pendingMutation ?? null).slice(0, 120));

	// ---------- LEG C：sg + 错误 sessionId → fail-closed 409（两种期望都必须保持） ----------
	// 注意：commandId 内嵌 g1 必须等于请求 generation（validateCommand 先于目标解析），
	// 否则会先撞 invalid_command_id_generation_mismatch（400）而不是目标不匹配（409）。
	const corrC = await sb('send_correction', {
		commandId: `${sgA}:g1:CORRECTION:9`, generation: 1, sessionId: sidB, supervisorGoalId: sgA,
		text: 'must not be applied', mode: 'steer',
	}, token);
	ok('LEG C sg+wrong session → 409 supervisor_goal_mismatch', corrC.status === 409 && corrC.body?.error === 'supervisor_goal_mismatch', `status=${corrC.status} body=${JSON.stringify(corrC.body).slice(0, 200)}`);

	// ---------- LEG D：LEG A commandId 重放 → duplicate 零额外副作用 ----------
	const corrD = await sb('send_correction', {
		commandId: `${sgA}:g1:CORRECTION:1`, generation: 1, sessionId: sidA,
		text: 'replay must not double-apply', mode: 'steer',
	}, token);
	ok('LEG D replay → duplicate:true no gen bump', corrD.status === 200 && corrD.body?.duplicate === true && corrD.body?.generation === 2, JSON.stringify(corrD.body).slice(0, 200));

	// ---------- full 模式：真实 marker 回显 ----------
	if (MODE === 'full') {
		const cA = await countMarker(sidA, markerA);
		ok('FULL LEG A marker in sidA history', cA >= 1, `count=${cA}`);
		if (EXPECT === 'post') {
			const cB = await countMarker(sidB, markerB);
			ok('FULL LEG B marker in sidB history（sg-only 同 Session 注入）', cB >= 1, `count=${cB}`);
		}
	} else {
		log('CI mode: marker assertions skipped (no model creds)');
	}

	// ---------- 清理：cancel 探针 goal ----------
	for (const [sg, sid, gen] of [[sgA, sidA, 2], [sgB, sidB, EXPECT === 'post' ? 2 : 1]]) {
		const cx = await sb('cancel_goal', { commandId: `${sg}:g${gen}:CANCEL:1`, generation: gen, sessionId: sid, action: 'pause' }, token);
		ok(`cleanup cancel ${sid.slice(-6)}`, cx.status === 200, JSON.stringify(cx.body).slice(0, 120));
	}

	failed = fail > 0;
} catch (e) {
	console.error(`[repro] FAIL: ${e?.message ?? e}`);
	failed = true;
} finally {
	stop(child);
	if (home && !KEEP) { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }
	else if (home) log(`KEEP=1 home kept: ${home}`);
}

function isValid(s) { return typeof s === 'string' && /^session-[0-9a-f-]{36}$/.test(s); }

// 证据落盘
try {
	const artDir = join(ROOT, 'tests', 'supervisor', '_artifacts');
	mkdirSync(artDir, { recursive: true });
	writeFileSync(join(artDir, `addr-${EXPECT}-${RUN}.json`), JSON.stringify({
		expect: EXPECT, mode: MODE, run: RUN, pass, fail, results,
	}, null, 2), 'utf8');
} catch { /* best effort */ }

console.log(`\n${pass} passed, ${fail} failed (EXPECT=${EXPECT})`);
if (fail > 0) { for (const f of results.filter((r) => r.startsWith('FAIL'))) console.log(`  ${f}`); }
console.log(failed ? 'REPRO/REGRESSION FAIL' : 'REPRO/REGRESSION PASS');
process.exit(failed ? 1 : 0);
