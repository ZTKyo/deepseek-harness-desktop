// verify-supervisor-real-e2e.mjs —— P2.75 REAL E2E（对活体 dsh 实例的 /supervisor/* 全链路）
// 前置：隔离 DSH_HOME 实例已启动（env: SB_BASE=http://127.0.0.1:<port>，SB_TOKEN_DIR=<DSH_HOME>）
// 覆盖：T15 dispatch+goal armed · T16 幂等 · T17 纠偏上限3 · T18 cancel · 负例（401/404/400）
// 运行：node tests/supervisor/verify-supervisor-real-e2e.mjs

const BASE = process.env.SB_BASE ?? 'http://127.0.0.1:33127';
const TOKEN_DIR = process.env.SB_TOKEN_DIR;
if (!TOKEN_DIR) { console.error('SB_TOKEN_DIR required'); process.exit(1); }

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
	if (cond) { pass++; console.log(`PASS ${name}`); }
	else { fail++; failures.push(name); console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}
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
		body: JSON.stringify({ type: 'client-request', rpcId: `e2e-${Date.now()}`, method, payload }),
	});
	const j = await r.json();
	if (j.result?.ok === false) throw new Error(`rpc ${method}: ${j.result.error}`);
	return j.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
	const t0 = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting ${label}`);
		await sleep(1000);
	}
}

// ---------- 0. 读 token（插件 boot 已生成） ----------
const token = readFileSync(join(TOKEN_DIR, 'supervisor-bridge', 'token'), 'utf8').trim();
ok('T0 token exists (64 hex)', /^[0-9a-f]{64}$/.test(token), token.slice(0, 8));

// ---------- 负例 ----------
{
	const noAuth = await sb('get_state', {}, null);
	ok('NEG get_state without token → 401', noAuth.status === 401, `got ${noAuth.status}`);
	const badAuth = await sb('get_state', {}, 'f'.repeat(64));
	ok('NEG get_state wrong token → 401', badAuth.status === 401, `got ${badAuth.status}`);
	const health = await sb('health', {}, token, 'GET');
	ok('health with token → 200 ok:true', health.status === 200 && health.body?.ok === true, JSON.stringify(health.body).slice(0, 120));
	const unknown = await sb('get_goal', { sessionId: 'session-00000000-0000-4000-8000-000000000000' }, token);
	ok('NEG get_goal unknown session → 404', unknown.status === 404 && unknown.body?.error === 'unknown_session', `got ${unknown.status}`);
	const badBody = await sb('dispatch_goal', { idempotencyKey: 'short', objective: 'x' }, token);
	ok('NEG dispatch bad key → 400', badBody.status === 400 && badBody.body?.error === 'invalid_idempotency_key', `got ${badBody.status}`);
}

// ---------- T15 dispatch（真实派发） ----------
const key = `e2e-r1-${Date.now()}`;
const disp = await sb('dispatch_goal', {
	idempotencyKey: key,
	objective: 'P2.75 REAL E2E: confirm readiness then stop',
	maxGoalRounds: 2,
	initialInstruction: 'E2E smoke: reply exactly READY and stop. Do not modify any files.',
}, token);
ok('T15 dispatch → 200 dispatched:true', disp.status === 200 && disp.body?.dispatched === true, JSON.stringify(disp.body).slice(0, 200));
const sid = disp.body?.receipt?.sessionId;
ok('T15 sessionId = session-<uuid>', /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid ?? ''), sid);
ok('T15 correctionsLeft = 3', disp.body?.receipt?.correctionsLeft === 3);
ok('T15 session row present (running is transient, not asserted)', typeof disp.body?.session?.running === 'boolean');

const goal = await waitFor(async () => {
	const g = await sb('get_goal', { sessionId: sid }, token);
	return g.status === 200 && g.body?.goal ? g.body : null;
}, 20000, 'goal projection armed');
ok('T15 goal armed with matching objective', goal?.goal?.objective === 'P2.75 REAL E2E: confirm readiness then stop', JSON.stringify(goal?.goal).slice(0, 160));
ok('T15 goal ref (id+revision)', typeof goal?.goal?.id === 'string' && Number.isInteger(goal?.goal?.revision), JSON.stringify(goal?.goal?.id));

// 初始指令必须真正进入会话（mode 'now' 启动 goal worker）
const evKick = await waitFor(async () => {
	const e = await sb('get_evidence', { sessionId: sid, maxMessages: 30 }, token);
	if (e.status !== 200 || !Array.isArray(e.body?.events)) return null;
	return e.body.events.some((ev) => JSON.stringify(ev).includes('E2E smoke: reply exactly READY')) ? e.body : null;
}, 20000, 'initial instruction in evidence');
ok('T15c initial instruction reached session (evidence)', !!evKick);

// ---------- T16 幂等（同 key 重派） ----------
const disp2 = await sb('dispatch_goal', { idempotencyKey: key, objective: 'DIFFERENT objective must be ignored' }, token);
ok('T16 redispatch → dispatched:false', disp2.status === 200 && disp2.body?.dispatched === false, JSON.stringify(disp2.body).slice(0, 160));
ok('T16 same sessionId', disp2.body?.receipt?.sessionId === sid);
ok('T16 correctionsLeft unchanged (3)', disp2.body?.receipt?.correctionsLeft === 3);

// ---------- T17 纠偏上限 3，第 4 次 409 ----------
for (let i = 1; i <= 3; i++) {
	const c = await sb('send_correction', { sessionId: sid, text: `E2E correction #${i} — do nothing, just acknowledge`, mode: 'steer' }, token);
	ok(`T17.${i} correction accepted (${i}/3)`, c.status === 200 && c.body?.accepted === true && c.body?.correctionsUsed === i && c.body?.correctionsLeft === 3 - i, JSON.stringify(c.body).slice(0, 120));
}
const c4 = await sb('send_correction', { sessionId: sid, text: 'fourth must be rejected' }, token);
ok('T17 4th correction → 409 corrections_exhausted', c4.status === 409 && c4.body?.error === 'corrections_exhausted' && c4.body?.correctionsLeft === 0, `got ${c4.status} ${JSON.stringify(c4.body).slice(0, 120)}`);

// ---------- 观测面一致性 ----------
{
	const snap = await sb('get_snapshot', {}, token);
	const row = snap.body?.sessions?.find((s) => s.sessionId === sid);
	ok('T15b snapshot contains e2e session (metadata only)', !!row && row.hasGoal === true && !('cwd' in row) && !('content' in row), JSON.stringify(row).slice(0, 160));
	const rcpt = snap.body?.receipts?.find((r) => r.sessionId === sid);
	ok('T15b snapshot receipts row present', !!rcpt && rcpt.corrections === 3, JSON.stringify(rcpt));
	const ev = await sb('get_evidence', { sessionId: sid, maxMessages: 50 }, token);
	ok('T15b evidence 200 + sanitized', ev.status === 200 && Array.isArray(ev.body?.events), `got ${ev.status} events=${ev.body?.events?.length}`);
}

// ---------- T18 cancel（clear 移除 goal） ----------
const cc = await sb('cancel_goal', { sessionId: sid, action: 'clear' }, token);
ok('T18 cancel clear → cancelled:true', cc.status === 200 && cc.body?.cancelled === true && cc.body?.action === 'clear', JSON.stringify(cc.body).slice(0, 160));
await sleep(1500);
const gAfter = await sb('get_goal', { sessionId: sid }, token);
ok('T18 goal projection cleared', gAfter.status === 200 && gAfter.body?.goal == null, JSON.stringify(gAfter.body).slice(0, 120));
{
	const snap = await sb('get_snapshot', {}, token);
	const rcpt = snap.body?.receipts?.find((r) => r.sessionId === sid);
	ok('T18 receipt status = cancelled:clear', rcpt?.status === 'cancelled:clear', JSON.stringify(rcpt));
}

// ---------- 汇总 ----------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { for (const f of failures) console.log(`  FAIL ${f}`); process.exit(1); }
console.log('REAL E2E PASS');
