// verify-supervisor-real-e2e.mjs —— P2.75 R1.1 REAL E2E（对活体 dsh 实例的 /supervisor/* 全链路）
//
// 三阶段（External Review R2 §26 合同）：
//   phase 1（默认）：负例(401/404/400) → health identity → dispatch(真实启动+marker) →
//                    dispatch 幂等 → correction 接受/重放幂等/stale/上限3→BLOCKED →
//                    objective-only dispatch（marker 证明真实 start prompt）→ cancel clear
//                    幂等/已终态不重执行 → review seam（ci: 409 on RUNNING / full: 完整
//                    FAIL→CORRECTING→correction→AWAITING_REVIEW→PASS→VERIFIED→重放不改写
//                    → evidence bundle REAL）。
//   phase 2        ：Bridge restart 后重放 dispatch/correction/cancel → 零第二副作用
//                    （marker 计数不变）+ continuity（同 harnessGoalId）→ 账本损坏
//                    fail-closed（mutation 503，read 200）→ 恢复后可继续派发。
//   phase 3        ：manifest 无 supervisor 插件 → /supervisor/* 无桥 JSON（dsh web 对未注册
//                    路径 GET 回退 SPA 200 / POST 405，桥激活则无 token 必 401 JSON），
//                    宿主 session.list 正常（隔离性）。
//
// env：SB_BASE · SB_TOKEN_DIR(=DSH_HOME) · SB_PHASE(1|2|3) · SB_MODE(full|ci) ·
//      SB_STATE_FILE(phase2 读) · SB_DSH_HOME(phase2 损坏账本用) · SB_RUN(标记后缀)
// 运行：node tests/supervisor/verify-supervisor-real-e2e.mjs

const BASE = process.env.SB_BASE ?? 'http://127.0.0.1:33127';
const PHASE = Number(process.env.SB_PHASE ?? '1');
const MODE = process.env.SB_MODE ?? 'ci';
const TOKEN_DIR = process.env.SB_TOKEN_DIR;
const RUN = process.env.SB_RUN ?? `r11-${Date.now().toString(36)}`;

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const failures = [];
const CI = MODE === 'ci';
function ok(name, cond, detail = '') {
	if (cond) { pass++; console.log(`PASS ${name}`); }
	else { fail++; failures.push(name); console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}
/** CI 无模型凭据 → 回合不落盘 → session.history 恒 session-not-found，marker 断言原理上不可能过；
 *  只能跳过（诚实标注，不计 PASS/FAIL），full 模式（真实模型）强制执行 */
function skip(name, why = 'ci mode: no model credentials, history-dependent check enforced in SB_MODE=full') {
	console.log(`SKIP ${name} (${why})`);
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
	if (j.result?.ok === false) {
		const raw = j.result.error ?? 'upstream_error';
		throw new Error(`rpc ${method}: ${typeof raw === 'string' ? raw : JSON.stringify(raw).slice(0, 300)}`);
	}
	return j.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
	const t0 = Date.now();
	for (;;) {
		let v = null;
		try { v = await fn(); } catch { /* retry */ }
		if (v) return v;
		if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting ${label}`);
		await sleep(2000);
	}
}
/** marker 在会话历史中的出现次数（provider 无关的真实副作用计数）；历史不可用返回 -1 */
let markerErrLogged = false;
async function countMarker(sessionId, marker) {
	try {
		const value = await rpc('session.history', { sessionId, maxMessages: 200 });
		return JSON.stringify(value?.events ?? []).split(marker).length - 1;
	} catch (e) {
		if (!markerErrLogged) { console.log(`[diag] countMarker history error (first): ${e.message}`); markerErrLogged = true; }
		return -1;
	}
}
async function snapshotRow(token, sgid) {
	const snap = await sb('get_snapshot', {}, token);
	return { snap, row: snap.body?.supervisorGoals?.find((r) => r.supervisorGoalId === sgid) ?? null };
}

// ============================================================
if (PHASE === 3) {
	// ---------- phase 3：隔离性（无插件 → 路由未注册；宿主正常） ----------
	// 实测（probe，2026-08-31）：dsh web 对未注册路径不返 404——GET 回退 SPA（200 text/html），
	// POST 返回 405（空体）。桥激活时所有 /supervisor/* 先鉴权：无 token 必返
	// application/json {ok:false,error:'unauthorized'}（health 亦先鉴权）。宿主自身从不对
	// 这些路径返回 application/json → 隔离性判据 = 响应不是 JSON 对象（出现 JSON 即桥在服务）。
	const isJson = (r) => String(r.headers.get('content-type') ?? '').startsWith('application/json');
	const health = await fetch(`${BASE}/supervisor/health`);
	const healthBody = await health.json().catch(() => null);
	ok('P3 health without plugin → not bridge-served (no supervisor JSON)',
		!(isJson(health) && healthBody !== null && typeof healthBody === 'object'),
		`status=${health.status} ct=${(health.headers.get('content-type') ?? '').split(';')[0]} body=${JSON.stringify(healthBody)?.slice(0, 60)}`);
	const disp = await fetch(`${BASE}/supervisor/dispatch_goal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	const dispBody = await disp.json().catch(() => null);
	ok('P3 dispatch without plugin → not bridge-served (no supervisor JSON)',
		!(isJson(disp) && dispBody !== null && typeof dispBody === 'object'),
		`status=${disp.status} ct=${(disp.headers.get('content-type') ?? '').split(';')[0]} body=${JSON.stringify(dispBody)?.slice(0, 60)}`);
	const list = await rpc('session.list', {});
	ok('P3 host session.list still works', Array.isArray(list?.items), JSON.stringify(list).slice(0, 80));
	console.log(`\n${pass} passed, ${fail} failed`);
	if (fail > 0) process.exit(1);
	console.log('REAL E2E PHASE3 PASS');
	process.exit(0);
}

if (!TOKEN_DIR) { console.error('SB_TOKEN_DIR required'); process.exit(1); }
const token = readFileSync(join(TOKEN_DIR, 'supervisor-bridge', 'token'), 'utf8').trim();
const RECEIPTS_FILE = join(process.env.SB_DSH_HOME ?? TOKEN_DIR, 'supervisor-bridge', 'receipts.json');

// ============================================================
if (PHASE === 2) {
	// ---------- phase 2：restart 重放零第二副作用 + continuity + 账本损坏 fail-closed ----------
	const st = JSON.parse(readFileSync(process.env.SB_STATE_FILE, 'utf8'));
	ok('P2 token exists after restart', /^[0-9a-f]{64}$/.test(token));
	const health = await sb('health', {}, token, 'GET');
	ok('P2 health ok + version 0.2.2', health.status === 200 && health.body?.version === '0.2.2', JSON.stringify(health.body).slice(0, 120));
	ok('P2 ledger reloaded OK', health.body?.ledger?.state === 'OK', JSON.stringify(health.body?.ledger));

	// R1.2：phase2 必须逐字重放 phase1 的 dispatch 输入（state 保存完整 initialInstruction）
	const rd = await sb('dispatch_goal', { idempotencyKey: st.keyA, objective: st.objectiveA, maxGoalRounds: 64, initialInstruction: st.initialInstructionA }, token);
	ok('P2 dispatch exact replay → duplicate:true', rd.status === 200 && rd.body?.dispatched === false && rd.body?.duplicate === true, JSON.stringify(rd.body).slice(0, 200));
	ok('P2 dispatch replay same supervisorGoalId', rd.body?.supervisorGoalId === st.sgA, `${rd.body?.supervisorGoalId} vs ${st.sgA}`);
	// R1.2：restart 后同 key 不同 payload → 409 fail-closed（零第二副作用）
	const rdc = await sb('dispatch_goal', { idempotencyKey: st.keyA, objective: `${st.objectiveA} CHANGED`, maxGoalRounds: 64, initialInstruction: st.initialInstructionA }, token);
	ok('P2 conflicting payload after restart → 409 idempotency_conflict', rdc.status === 409 && rdc.body?.error === 'idempotency_conflict' && rdc.body?.reason === 'payload_identity_mismatch', JSON.stringify(rdc.body).slice(0, 220));

	const rc = await sb('send_correction', { commandId: st.corr1CommandId, generation: 1, sessionId: st.sidA, text: st.markerA2, mode: 'steer' }, token);
	ok('P2 correction replay → duplicate:true', rc.status === 200 && rc.body?.duplicate === true && rc.body?.accepted === false, JSON.stringify(rc.body).slice(0, 200));
	ok('P2 correction replay no gen bump (still 4)', rc.body?.generation === 4, `gen=${rc.body?.generation}`);
	ok('P2 correction replay correctionsUsed=3', rc.body?.correctionsUsed === 3, JSON.stringify(rc.body).slice(0, 120));

	const rx = await sb('cancel_goal', { commandId: st.cancelCommandB, generation: 1, sessionId: st.sidB, action: 'clear' }, token);
	ok('P2 cancel replay → duplicate:true', rx.status === 200 && rx.body?.duplicate === true, JSON.stringify(rx.body).slice(0, 200));
	ok('P2 cancel replay still CANCELLED', rx.body?.controlState === 'CANCELLED', JSON.stringify(rx.body).slice(0, 120));

	const c1 = await countMarker(st.sidA, st.markerA1);
	const c2 = await countMarker(st.sidA, st.markerA2);
	if (CI) {
		skip('P2 marker A1 count unchanged (no second session.create/prompt)');
		skip('P2 marker A2 count unchanged (no second correction prompt)');
	} else {
		ok('P2 marker A1 count unchanged (no second session.create/prompt)', c1 === st.markerA1Count, `${c1} vs ${st.markerA1Count}`);
		ok('P2 marker A2 count unchanged (no second correction prompt)', c2 === st.markerA2Count, `${c2} vs ${st.markerA2Count}`);
	}

	const gs = await sb('get_goal', { sessionId: st.sidA }, token);
	ok('P2 get_goal continuity: same supervisorGoalId', gs.body?.supervisor?.supervisorGoalId === st.sgA, JSON.stringify(gs.body?.supervisor).slice(0, 120));
	const { row } = await snapshotRow(token, st.sgA);
	ok('P2 snapshot continuity: same harnessGoalId', row?.harnessGoalId === st.harnessGoalIdA, `${row?.harnessGoalId} vs ${st.harnessGoalIdA}`);
	ok('P2 snapshot continuity: same sessionId', row?.harnessSessionId === st.sidA, JSON.stringify(row).slice(0, 160));

	// 账本损坏 → mutation fail-closed，read 不受影响
	const original = readFileSync(RECEIPTS_FILE, 'utf8');
	writeFileSync(RECEIPTS_FILE, '{corrupt-by-e2e', 'utf8');
	await sleep(300); // statLedger 变化检测窗口
	const cd = await sb('dispatch_goal', { idempotencyKey: `corrupt-${RUN}`, objective: 'corrupt probe' }, token);
	ok('P2 corrupt ledger dispatch → 503 supervisor_state_corrupt', cd.status === 503 && cd.body?.error === 'supervisor_state_corrupt', JSON.stringify(cd.body));
	const cc = await sb('send_correction', { commandId: 'corrupt-cmd-0001', generation: 1, sessionId: st.sidA, text: 'x', mode: 'steer' }, token);
	ok('P2 corrupt ledger correction → 503', cc.status === 503 && cc.body?.error === 'supervisor_state_corrupt', JSON.stringify(cc.body));
	const cr = await sb('get_state', {}, token);
	ok('P2 read path still OK on corrupt ledger', cr.status === 200 && cr.body?.ok === true, JSON.stringify(cr.body).slice(0, 120));

	// 恢复账本 → 一切照常
	writeFileSync(RECEIPTS_FILE, original, 'utf8');
	await sleep(300);
	const rk = `recovered-${RUN}`;
	const rd2 = await sb('dispatch_goal', { idempotencyKey: rk, objective: `P2.75 R1.1 recovery probe ${RUN}: reply READY and stop.` }, token);
	ok('P2 recovered ledger dispatch works', rd2.status === 200 && rd2.body?.dispatched === true, JSON.stringify(rd2.body).slice(0, 160));
	if (rd2.body?.dispatched) {
		const rx2 = await sb('cancel_goal', { commandId: `${rd2.body.supervisorGoalId}:g1:CANCEL:1`, generation: 1, sessionId: rd2.body.receipt.sessionId, action: 'pause' }, token);
		ok('P2 recovery probe cancelled', rx2.status === 200 && rx2.body?.cancelled === true, JSON.stringify(rx2.body).slice(0, 120));
	}

	console.log(`\n${pass} passed, ${fail} failed`);
	if (fail > 0) { for (const f of failures) console.log(`  FAIL ${f}`); process.exit(1); }
	console.log('REAL E2E PHASE2 PASS');
	process.exit(0);
}

// ============================================================
// phase 1（默认）
const markerA1 = `E2E-MARKER-A1-${RUN}`;
const markerA2 = `E2E-MARKER-A2-${RUN}`;
const markerB1 = `E2E-MARKER-B1-${RUN}`;
const objectiveA = `P2.75 R1.1 REAL E2E (run ${RUN}): confirm readiness then stop`;
// R1.2 payload identity：dispatch 输入必须可被 phase2 逐字重放（canonical contract 一致）
const initialInstructionA = `${markerA1}: reply exactly READY and stop. Do not modify any files.`;

// ---------- 0. token + health identity ----------
ok('T0 token exists (64 hex)', /^[0-9a-f]{64}$/.test(token), token.slice(0, 8));
const health = await sb('health', {}, token, 'GET');
ok('T0 health → 200 ok:true version 0.2.2', health.status === 200 && health.body?.ok === true && health.body?.version === '0.2.2', JSON.stringify(health.body).slice(0, 140));
ok('T0 health identity sha256 present', /^[0-9a-f]{64}$/.test(health.body?.identity?.bridgeSha256 ?? '') && /^[0-9a-f]{64}$/.test(health.body?.identity?.coreSha256 ?? ''), JSON.stringify(health.body?.identity));
ok('T0 health ledger OK/ABSENT', ['OK', 'ABSENT'].includes(health.body?.ledger?.state), JSON.stringify(health.body?.ledger));

// ---------- 负例 ----------
{
	const noAuth = await sb('get_state', {}, null);
	ok('NEG get_state without token → 401', noAuth.status === 401, `got ${noAuth.status}`);
	const badAuth = await sb('get_state', {}, 'f'.repeat(64));
	ok('NEG get_state wrong token → 401', badAuth.status === 401, `got ${badAuth.status}`);
	const unknown = await sb('get_goal', { sessionId: 'session-00000000-0000-4000-8000-000000000000' }, token);
	ok('NEG get_goal unknown session → 404', unknown.status === 404 && unknown.body?.error === 'unknown_session', `got ${unknown.status}`);
	const badKey = await sb('dispatch_goal', { idempotencyKey: 'short', objective: 'x' }, token);
	ok('NEG dispatch bad key → 400 invalid_idempotency_key', badKey.status === 400 && badKey.body?.error === 'invalid_idempotency_key', `got ${badKey.status}`);
	const noObj = await sb('dispatch_goal', { idempotencyKey: `neg-obj-${RUN}` }, token);
	ok('NEG dispatch missing objective → 400', noObj.status === 400, `got ${noObj.status}:${noObj.body?.error}`);
	const badCmd = await sb('send_correction', { commandId: 'short cmd!', generation: 1, sessionId: 'session-00000000-0000-4000-8000-000000000000', text: 'x' }, token);
	ok('NEG correction bad commandId → 400', badCmd.status === 400, `got ${badCmd.status}:${badCmd.body?.error}`);
}

// ---------- goalA：dispatch 真实启动 + 幂等 + correction 合同 ----------
const keyA = `e2e-a-${RUN}`;
const dispA = await sb('dispatch_goal', {
	idempotencyKey: keyA,
	objective: objectiveA,
	maxGoalRounds: 64,
	initialInstruction: initialInstructionA,
}, token);
ok('T15 dispatch → 200 dispatched:true (fresh)', dispA.status === 200 && dispA.body?.dispatched === true && dispA.body?.duplicate === false && dispA.body?.resumed === false, JSON.stringify(dispA.body).slice(0, 240));
const sidA = dispA.body?.receipt?.sessionId;
const sgA = dispA.body?.supervisorGoalId;
ok('T15 sessionId = uuidv5(key) deterministic', sidA === dispA.body?.session?.sessionId && /^session-[0-9a-f-]{36}$/.test(sidA ?? ''), sidA);
ok('T15 supervisorGoalId present + generation 1', !!sgA && dispA.body?.generation === 1, `${sgA} gen=${dispA.body?.generation}`);
ok('T15 goalRef armed (harness goal created)', !!dispA.body?.receipt?.goalRef?.id, JSON.stringify(dispA.body?.receipt?.goalRef));
ok('T15 receipt carries dispatchFingerprint (R1.2)', /^[0-9a-f]{64}$/.test(dispA.body?.receipt?.dispatchFingerprint ?? ''), dispA.body?.receipt?.dispatchFingerprint);
ok('T15 startPromptOrigin = provided', dispA.body?.startPromptOrigin === 'provided', dispA.body?.startPromptOrigin);
// rc.8 实测 session.create 返回体可能不含 running（turn 尚未起）；真实启动证据由 marker 断言承担
ok('T15 session object returned', dispA.body?.session?.sessionId === sidA, JSON.stringify(dispA.body?.session));

// R1.2：exact replay（同 canonical contract）→ duplicate；不同 payload → 409 fail-closed
const dupA = await sb('dispatch_goal', { idempotencyKey: keyA, objective: objectiveA, maxGoalRounds: 64, initialInstruction: initialInstructionA }, token);
ok('T16 dispatch exact replay → duplicate:true same goal', dupA.status === 200 && dupA.body?.dispatched === false && dupA.body?.duplicate === true && dupA.body?.supervisorGoalId === sgA, JSON.stringify(dupA.body).slice(0, 200));
ok('T16 dispatch replay same generation (1)', dupA.body?.generation === 1, `gen=${dupA.body?.generation}`);
// R1.2 Blocker 修复的 E2E 级证明：同 key 不同 objective → 409 idempotency_conflict（不重派）
const conflictA = await sb('dispatch_goal', { idempotencyKey: keyA, objective: 'DIFFERENT objective must conflict under R1.2', maxGoalRounds: 2 }, token);
ok('T16b dispatch conflicting payload → 409 idempotency_conflict', conflictA.status === 409 && conflictA.body?.error === 'idempotency_conflict' && conflictA.body?.reason === 'payload_identity_mismatch', JSON.stringify(conflictA.body).slice(0, 220));

const m1Before = await countMarker(sidA, markerA1);
if (CI) {
	skip('T15 marker A1 visible in real session history');
	skip('T16 dispatch replay: zero second side effect (marker unchanged)');
} else {
	ok('T15 marker A1 visible in real session history', m1Before >= 1, `count=${m1Before}`);
	const m1AfterDup = await countMarker(sidA, markerA1);
	ok('T16 dispatch replay: zero second side effect (marker unchanged)', m1AfterDup === m1Before, `${m1AfterDup} vs ${m1Before}`);
}

// correction 接受 → generation 2
const c1CommandId = `${sgA}:g1:CORRECTION:1`;
const corr1 = await sb('send_correction', { commandId: c1CommandId, generation: 1, sessionId: sidA, text: `${markerA2}: reply READY again and stop. Do not modify any files.`, mode: 'steer' }, token);
ok('T17 correction accepted → generation 2', corr1.status === 200 && corr1.body?.accepted === true && corr1.body?.generation === 2, JSON.stringify(corr1.body).slice(0, 200));
ok('T17 correction budget used 1 / left 2', corr1.body?.correctionsUsed === 1 && corr1.body?.correctionsLeft === 2, JSON.stringify(corr1.body).slice(0, 120));
ok('T17 correction controlState RUNNING', corr1.body?.controlState === 'RUNNING', corr1.body?.controlState);
const m2After1 = await countMarker(sidA, markerA2);
if (CI) {
	skip('T17 correction prompt really sent (marker A2 = 1)');
	skip('T17 correction replay: zero second prompt (marker A2 unchanged)');
} else {
	ok('T17 correction prompt really sent (marker A2 = 1)', m2After1 === 1, `count=${m2After1}`);
	const m2AfterDup = await countMarker(sidA, markerA2);
	ok('T17 correction replay: zero second prompt (marker A2 unchanged)', m2AfterDup === m2After1, `${m2AfterDup} vs ${m2After1}`);
}

const corr1dup = await sb('send_correction', { commandId: c1CommandId, generation: 1, sessionId: sidA, text: `${markerA2}: replay should NOT send again`, mode: 'steer' }, token);
ok('T17 correction replay → duplicate:true accepted:false', corr1dup.status === 200 && corr1dup.body?.duplicate === true && corr1dup.body?.accepted === false, JSON.stringify(corr1dup.body).slice(0, 200));
ok('T17 correction replay: generation still 2', corr1dup.body?.generation === 2, `gen=${corr1dup.body?.generation}`);

const stale = await sb('send_correction', { commandId: `${sgA}:g1:CORRECTION:9`, generation: 1, sessionId: sidA, text: 'stale attempt' }, token);
ok('T17 stale generation correction → 409 stale_generation', stale.status === 409 && stale.body?.error === 'stale_generation' && stale.body?.currentGeneration === 2, JSON.stringify(stale.body));

// 上限 3 → BLOCKED（快速连发，避免 goal 完成投影干扰判定）
const c2 = await sb('send_correction', { commandId: `${sgA}:g2:CORRECTION:2`, generation: 2, sessionId: sidA, text: 'second correction, reply READY and stop' }, token);
ok('T17 correction #2 accepted → generation 3', c2.status === 200 && c2.body?.generation === 3, JSON.stringify(c2.body).slice(0, 160));
const c3 = await sb('send_correction', { commandId: `${sgA}:g3:CORRECTION:3`, generation: 3, sessionId: sidA, text: 'third correction, reply READY and stop' }, token);
ok('T17 correction #3 accepted → correctionsLeft 0', c3.status === 200 && c3.body?.generation === 4 && c3.body?.correctionsLeft === 0, JSON.stringify(c3.body).slice(0, 160));
const c4 = await sb('send_correction', { commandId: `${sgA}:g4:CORRECTION:4`, generation: 4, sessionId: sidA, text: 'fourth correction must fail' }, token);
ok('T17 correction #4 → 409 corrections_exhausted (3/0)', c4.status === 409 && c4.body?.error === 'corrections_exhausted' && c4.body?.correctionsUsed === 3 && c4.body?.correctionsLeft === 0, JSON.stringify(c4.body));
{
	const { row } = await snapshotRow(token, sgA);
	ok('T17 receipt controlState = BLOCKED', row?.currentControlState === 'BLOCKED', JSON.stringify(row).slice(0, 200));
}

// ---------- goalB：objective-only dispatch + cancel 合同 ----------
const keyB = `e2e-b-${RUN}`;
const dispB = await sb('dispatch_goal', {
	idempotencyKey: keyB,
	objective: `${markerB1}: P2.75 R1.1 REAL E2E objective-only: reply exactly READY and stop. Do not modify any files.`,
	maxGoalRounds: 64,
}, token);
ok('T20 objective-only dispatch → 200 (no initialInstruction)', dispB.status === 200 && dispB.body?.dispatched === true, JSON.stringify(dispB.body).slice(0, 200));
ok('T20 startPromptOrigin = objective-derived', dispB.body?.startPromptOrigin === 'objective-derived', dispB.body?.startPromptOrigin);
const sidB = dispB.body?.receipt?.sessionId;
const sgB = dispB.body?.supervisorGoalId;
const mB = await countMarker(sidB, markerB1);
if (CI) skip('T20 objective-derived start prompt really contains objective (marker B1)');
else ok('T20 objective-derived start prompt really contains objective (marker B1)', mB >= 1, `count=${mB}`);

const cancelCommandB = `${sgB}:g1:CANCEL:1`;
const cx1 = await sb('cancel_goal', { commandId: cancelCommandB, generation: 1, sessionId: sidB, action: 'clear' }, token);
ok('T18 cancel clear → cancelled:true CANCELLED', cx1.status === 200 && cx1.body?.cancelled === true && cx1.body?.action === 'clear' && cx1.body?.controlState === 'CANCELLED', JSON.stringify(cx1.body).slice(0, 200));
const cx1dup = await sb('cancel_goal', { commandId: cancelCommandB, generation: 1, sessionId: sidB, action: 'clear' }, token);
ok('T18 cancel replay → duplicate:true (no second goal.clear)', cx1dup.status === 200 && cx1dup.body?.duplicate === true && cx1dup.body?.controlState === 'CANCELLED', JSON.stringify(cx1dup.body).slice(0, 200));
const cx2 = await sb('cancel_goal', { commandId: `${sgB}:g1:CANCEL:2`, generation: 1, sessionId: sidB, action: 'pause' }, token);
ok('T18 cancel after terminal → alreadyCancelled (side effect stays 1)', cx2.status === 200 && cx2.body?.cancelled === false && cx2.body?.alreadyCancelled === true, JSON.stringify(cx2.body).slice(0, 200));
await waitFor(async () => {
	const g = await sb('get_goal', { sessionId: sidB }, token);
	return g.status === 200 && g.body?.goal == null ? true : null;
}, 20000, 'goal projection cleared after cancel clear');
{
	const { row } = await snapshotRow(token, sgB);
	ok('T18 snapshot row controlState CANCELLED', row?.currentControlState === 'CANCELLED', JSON.stringify(row).slice(0, 160));
}

// ---------- goalC：review seam ----------
const keyC = `e2e-c-${RUN}`;
const dispC = await sb('dispatch_goal', {
	idempotencyKey: keyC,
	objective: `P2.75 R1.1 REAL E2E review flow (run ${RUN}): reply with exactly READY then stop. Do not modify any files.`,
	maxGoalRounds: 8,
}, token);
ok('T13 goalC dispatched', dispC.status === 200 && dispC.body?.dispatched === true, JSON.stringify(dispC.body).slice(0, 160));
const sidC = dispC.body?.receipt?.sessionId;
const sgC = dispC.body?.supervisorGoalId;

if (MODE === 'full') {
	// 完整 review 协议（真实模型回合）：complete → AWAITING_REVIEW → FAIL → correction → AWAITING_REVIEW → PASS → VERIFIED
	await waitFor(async () => {
		const { row } = await snapshotRow(token, sgC);
		return row?.currentControlState === 'AWAITING_REVIEW' ? true : null;
	}, 240000, 'goalC round-1 completion → AWAITING_REVIEW');
	const rEarly = await sb('review_goal', { commandId: `${sgC}:g1:REVIEW:8`, generation: 1, sessionId: sidC, verdict: 'MAYBE' }, token);
	ok('NEG review with invalid verdict → 400', rEarly.status === 400, `got ${rEarly.status}:${rEarly.body?.error}`);
	const rvFail = await sb('review_goal', {
		commandId: `${sgC}:g1:REVIEW:1`, generation: 1, sessionId: sidC, verdict: 'FAIL',
		criteriaResults: [{ criterion: 'agent replied exactly READY in round 1', result: 'fail' }],
	}, token);
	ok('T13 review FAIL → CORRECTING + send_correction', rvFail.status === 200 && rvFail.body?.verdict === 'FAIL' && rvFail.body?.controlState === 'CORRECTING' && rvFail.body?.nextExpectedAction === 'send_correction', JSON.stringify(rvFail.body).slice(0, 200));
	const cC1 = await sb('send_correction', { commandId: `${sgC}:g1:CORRECTION:1`, generation: 1, sessionId: sidC, text: `${RUN} review correction: reply with exactly READY then stop. Do not modify any files.`, mode: 'steer' }, token);
	ok('T13 correction after FAIL accepted → RUNNING gen2', cC1.status === 200 && cC1.body?.accepted === true && cC1.body?.generation === 2 && cC1.body?.controlState === 'RUNNING', JSON.stringify(cC1.body).slice(0, 200));
	await waitFor(async () => {
		const { row } = await snapshotRow(token, sgC);
		return row?.currentControlState === 'AWAITING_REVIEW' ? true : null;
	}, 240000, 'goalC round-2 completion → AWAITING_REVIEW');
	const rvPass = await sb('review_goal', {
		commandId: `${sgC}:g2:REVIEW:1`, generation: 2, sessionId: sidC, verdict: 'PASS',
		criteriaResults: [{ criterion: 'agent replied exactly READY in round 2', result: 'pass' }],
	}, token);
	ok('T13 review PASS → VERIFIED', rvPass.status === 200 && rvPass.body?.verdict === 'PASS' && rvPass.body?.controlState === 'VERIFIED', JSON.stringify(rvPass.body).slice(0, 200));
	const rvDup = await sb('review_goal', {
		commandId: `${sgC}:g2:REVIEW:1`, generation: 2, sessionId: sidC, verdict: 'FAIL',
		criteriaResults: [{ criterion: 'replay must not overwrite', result: 'fail' }],
	}, token);
	ok('T13 review replay → duplicate:true, VERIFIED not overwritten', rvDup.status === 200 && rvDup.body?.duplicate === true && rvDup.body?.controlState === 'VERIFIED' && rvDup.body?.verdict === 'PASS', JSON.stringify(rvDup.body).slice(0, 200));
	{
		const { row } = await snapshotRow(token, sgC);
		ok('T13 snapshot VERIFIED + verdict PASS + pendingMutation null', row?.currentControlState === 'VERIFIED' && row?.latestReviewVerdict === 'PASS' && row?.pendingMutation === null, JSON.stringify(row).slice(0, 240));
		ok('T13 snapshot resumable identity (harnessGoalId + runId)', !!row?.harnessGoalId && !!row?.runId, JSON.stringify({ h: row?.harnessGoalId, r: row?.runId }));
		ok('T13 snapshot acceptance pass=1/total=1', row?.acceptance?.pass === 1 && row?.acceptance?.total === 1, JSON.stringify(row?.acceptance));
	}
	const ev = await sb('get_evidence', { sessionId: sidC, maxMessages: 50 }, token);
	ok('T14 evidence bundle: identity REAL + harness goal bound', ev.status === 200 && ev.body?.labels?.identity === 'REAL' && !!ev.body?.identity?.harnessGoalId, JSON.stringify({ labels: ev.body?.labels, identity: ev.body?.identity }).slice(0, 200));
	ok('T14 evidence execution VERIFIED', ev.body?.execution?.controlState === 'VERIFIED', JSON.stringify(ev.body?.execution));
	ok('T14 evidence acceptance reported', ev.body?.acceptance?.total >= 1 && ev.body?.acceptance?.pass === 1, JSON.stringify(ev.body?.acceptance));
	ok('T14 evidence continuity duplicateDetected yes', ev.body?.continuity?.duplicateDetected === 'yes', JSON.stringify(ev.body?.continuity).slice(0, 160));
	ok('T14 evidence source/verification NOT fabricated', ev.body?.source?.baseCommit == null && ev.body?.verification?.tests?.status === 'NOT_RUN', JSON.stringify(ev.body?.source?.note ?? ''));
	ok('T14 evidence supervisor view same goalRef', ev.body?.supervisor?.goalRef?.id === ev.body?.identity?.harnessGoalId, JSON.stringify(ev.body?.supervisor).slice(0, 160));
} else {
	// ci 模式（CI 无模型凭据，不等真实回合）：review 在非 AWAITING_REVIEW 被真实协议拒绝
	const rv = await sb('review_goal', { commandId: `${sgC}:g1:REVIEW:1`, generation: 1, sessionId: sidC, verdict: 'PASS', criteriaResults: [{ criterion: 'ci', result: 'pass' }] }, token);
	ok('T13 review on RUNNING → 409 invalid_control_state', rv.status === 409 && rv.body?.error === 'invalid_control_state' && ['RUNNING', 'DISPATCHED'].includes(rv.body?.currentControlState), JSON.stringify(rv.body));
	const cx = await sb('cancel_goal', { commandId: `${sgC}:g1:CANCEL:1`, generation: 1, sessionId: sidC, action: 'pause' }, token);
	ok('T13 goalC cleanup cancelled', cx.status === 200 && cx.body?.cancelled === true, JSON.stringify(cx.body).slice(0, 160));
}

// ---------- state 文件（phase2 重放依据） ----------
const stFile = process.env.SB_STATE_FILE;
if (stFile) {
	const m1 = await countMarker(sidA, markerA1);
	const m2 = await countMarker(sidA, markerA2);
	writeFileSync(stFile, JSON.stringify({
		run: RUN, keyA, keyB, keyC, sidA, sidB, sidC, sgA, sgB, sgC,
		objectiveA, initialInstructionA, markerA1, markerA2, markerB1,
		corr1CommandId: c1CommandId, cancelCommandB,
		markerA1Count: m1, markerA2Count: m2,
		harnessGoalIdA: dispA.body?.receipt?.goalRef?.id ?? null,
	}, null, 2), 'utf8');
	ok('T0 state file written', true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { for (const f of failures) console.log(`  FAIL ${f}`); process.exit(1); }
console.log('REAL E2E PHASE1 PASS');
