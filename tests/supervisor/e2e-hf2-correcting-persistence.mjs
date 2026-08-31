// e2e-hf2-correcting-persistence.mjs —— 02.75-HF2 Supervisor CORRECTING State Persistence
//
// REAL Supervisor E2E（disposable 隔离实例）：boot 独立 dsh（隔离 DSH_HOME + 本 worktree 的
// plugins/ + 全局 dsh bin），全部走真实 RPC：bridge /supervisor/* + 宿主 /api/goal.complete。
// 复用 tests/watchdog/e2e-watchdog-real.mjs 的隔离实例编排模式，不新建第二套基建。
// 红线：不触碰真实 ~/.dsh（零凭据复制）；不触碰任何既有 goal（所有 probe goal 均为本运行
// 在临时 home 中自建，运行结束即删）；零模型回合（P1 语义，状态链全部由真实 RPC 驱动）。
//
// 被测问题：review FAIL → CORRECTING 后，宿主 goal phase=complete 时读时推导
// （syncControlState，get_goal 即触发）是否会把 CORRECTING 压回 AWAITING_REVIEW。
//
// 双模式（HF2_EXPECT）：
//   'squeeze' —— canonical main 复现模式：断言 CORRECTING 在读时被压回（bug 存在）。
//                全部腿通过 → 退出码 42（= REPRO CONFIRMED，HF2 立项依据）。
//   'sticky'  —— HF2 修复模式：断言 CORRECTING 粘滞（读/restart 后保持，直到
//                correction_accepted → RUNNING / FAIL(预算尽) → BLOCKED / cancel → CANCELLED）。
//
// 腿清单（一个实例三个 goal）：
//   Goal A：dispatch → host goal.complete → 读推导 AWAITING_REVIEW → review FAIL →
//           CORRECTING →【复现窗口：两次 get_goal 读采样】→ correction×3 → BLOCKED
//   Goal B：… → CORRECTING → cancel_goal(clear) → CANCELLED + 重放幂等（副作用单次）
//   Goal C：… → CORRECTING 采样 S1 → 服务重启（同 home）→ 读 → 状态 == S1（零漂移）
//
// env：HF2_PORT_BASE（默认 33660）· HF2_EXPECT=sticky|squeeze（默认 sticky）·
//      HF2_KEEP=1 保留隔离 home（诊断）· HF2_SKIP_RESTART=1 跳过 Goal C
// 运行：node tests/supervisor/e2e-hf2-correcting-persistence.mjs

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, existsSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const PLUGIN_DIR = join(ROOT, 'plugins');
const KEEP = process.env.HF2_KEEP === '1';
const SKIP_RESTART = process.env.HF2_SKIP_RESTART === '1';
const EXPECT = process.env.HF2_EXPECT === 'squeeze' ? 'squeeze' : 'sticky';
const PORT_BASE = Number(process.env.HF2_PORT_BASE ?? '33660');
const RUN = `hf2-${Date.now().toString(36)}`;
const NPM_DSH = join(process.env.APPDATA ?? '', 'npm', 'dsh.cmd');
const DSH = existsSync(NPM_DSH) ? NPM_DSH : 'dsh';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
	if (cond) { pass++; console.log(`PASS ${name}`); }
	else { fail++; failures.push(name); console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}
function log(msg) { console.log(`[hf2-e2e] ${msg}`); }
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

// ---------- 隔离实例（supervisor-only 插件面） ----------
function buildHome() {
	const home = mkdtempSync(join(tmpdir(), 'hf2-e2e-'));
	const profileDir = join(home, 'profiles', 'web');
	mkdirSync(profileDir, { recursive: true });
	const bridge = join(PLUGIN_DIR, 'supervisor-bridge.mjs');
	if (!existsSync(bridge)) throw new Error('supervisor-bridge.mjs missing (wrong worktree?)');
	copyFileSync(bridge, join(profileDir, 'supervisor-bridge.mjs'));
	const core = join(PLUGIN_DIR, 'supervisor-bridge-core.mjs');
	if (existsSync(core)) copyFileSync(core, join(profileDir, 'supervisor-bridge-core.mjs'));
	const manifest = [
		'- insert:',
		'    - id: hf2-bridge',
		"      name: './supervisor-bridge.mjs'",
		'      config: {}',
	].join('\n');
	writeFileSync(join(profileDir, 'cordis.patch.yml'), manifest, 'utf8');
	writeFileSync(join(profileDir, 'cordis.yml'), '[]', 'utf8');
	return home;
}
function boot(port, home) {
	const child = spawn('cmd.exe', ['/c', DSH, 'web', '--port', String(port), '--no-open'], {
		env: { ...process.env, DSH_HOME: home, DSH_WEB_PORT: String(port) },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
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
	for (let i = 0; i < 150; i++) {
		await sleep(1000);
		try {
			const r = await fetch(`http://127.0.0.1:${port}/api/host.describe`, {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ type: 'client-request', rpcId: `hf2-${label}`, method: 'host.describe', payload: {} }),
				signal: AbortSignal.timeout(2500),
			});
			const j = await r.json().catch(() => null);
			if (j?.result?.ok) return true;
		} catch { /* retry */ }
	}
	throw new Error(`dsh did not become ready (${label}) on port ${port}`);
}
function readToken(file) {
	try { return readFileSync(file, 'utf8').trim(); } catch { return null; }
}
async function sb(port, bridgeToken, verb, body) {
	const r = await fetch(`http://127.0.0.1:${port}/supervisor/${verb}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(bridgeToken ? { authorization: `Bearer ${bridgeToken}` } : {}) },
		body: JSON.stringify(body ?? {}),
	});
	return { status: r.status, body: await r.json().catch(() => null) };
}
async function rpc(port, method, payload) {
	const r = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ type: 'client-request', rpcId: `hf2-${Date.now()}`, method, payload }),
	});
	const j = await r.json();
	if (j?.result?.ok === false) throw new Error(`rpc ${method}: ${JSON.stringify(j.result.error ?? 'err').slice(0, 200)}`);
	return j?.result?.value;
}
function cs(g) { return g?.supervisor?.controlState ?? `(none:${g?.error ?? '?'})`; }
// 观察项（非断言）：canonical/HF2 均可能出现的瞬时 500 internal_error
// （get_goal → findSession → host session.list 瞬时超时，多发生在 P1 无模型回合失败窗口；
//  响应无 detail、无 upstream 标记 → 与本 HF2 状态机无关，只计数上报）
let transient500 = 0;
async function getGoal(port, token, sid, label = '') {
	for (let i = 0; i < 5; i++) {
		const g = await sb(port, token, 'get_goal', { sessionId: sid });
		if (g.status === 200) return g.body;
		if (g.status === 500 && g.body?.error === 'internal_error') {
			transient500++;
			log(`transient 500 internal_error on get_goal${label ? ` (${label})` : ''} — retrying (occurrence #${transient500})`);
			await sleep(800);
			continue;
		}
		return g.body;
	}
	throw new Error(`get_goal kept failing after retries${label ? ` (${label})` : ''}`);
}

// ---------- 单 goal 状态链驱动 ----------
// dispatch → host goal.complete → 读推导 AWAITING_REVIEW → review FAIL(gN) → 采样两次读
async function driveToCorrecting(port, token, tag) {
	const disp = await sb(port, token, 'dispatch_goal', {
		idempotencyKey: `hf2-${tag}-${RUN}`,
		objective: `HF2 correcting persistence probe ${tag} (run ${RUN}): reply with exactly READY then stop. Do not modify any files.`,
		maxGoalRounds: 8,
	});
	ok(`A[${tag}] dispatch P4 → 200 with receipt`, disp.status === 200 && disp.body?.dispatched === true && !!disp.body?.receipt?.sessionId, JSON.stringify(disp.body).slice(0, 200));
	const sid = disp.body?.receipt?.sessionId;
	const sg = disp.body?.supervisorGoalId;

	// 宿主 goal.complete（真实 host RPC；review 的 recipe：host goal phase=complete）
	const g0 = await getGoal(port, token, sid, 'goalRef');
	const ref0 = g0?.supervisor?.goalRef;
	ok(`A[${tag}] receipt exposes host goalRef`, !!ref0?.id, JSON.stringify(g0?.supervisor ?? {}).slice(0, 160));
	const done = await rpc(port, 'goal.complete', { sessionId: sid, ref: ref0 });
	ok(`A[${tag}] host goal.complete accepted`, !!done?.ref?.id, JSON.stringify(done).slice(0, 160));

	// 读#1：Completion Truth 真值推导 → AWAITING_REVIEW（canonical 语义，两种模式都必须成立）
	const g1 = await getGoal(port, token, sid, 'read#1');
	ok(`A[${tag}] read#1 complete-projection → AWAITING_REVIEW`, cs(g1) === 'AWAITING_REVIEW', `cs=${cs(g1)}`);

	// review FAIL（generation=1；receipt 未变，correctionsLeft=3 → CORRECTING）
	const rv = await sb(port, token, 'review_goal', {
		commandId: `${sg}:g1:REVIEW:1`, generation: 1, sessionId: sid, verdict: 'FAIL',
		criteriaResults: [{ criterion: 'hf2-probe-ready-reply', result: 'fail' }],
	});
	ok(`A[${tag}] review FAIL accepted → controlState CORRECTING`, rv.status === 200 && rv.body?.controlState === 'CORRECTING', JSON.stringify(rv.body).slice(0, 200));

	// 复现窗口：读#2（立即）+ 读#3（2s 后）——读时推导每次都会跑 syncControlState
	const g2 = await getGoal(port, token, sid, 'read#2');
	await sleep(2000);
	const g3 = await getGoal(port, token, sid, 'read#3');
	return { sid, sg, afterFail: cs(g2), afterFail2: cs(g3), tokenRef: { sid, sg } };
}

// ---------- 主流程 ----------
async function main() {
	const home = buildHome();
	const port = await freePort(PORT_BASE);
	let child = boot(port, home);
	try {
		await waitReady(port, 'main');
		const token = readToken(join(home, 'supervisor-bridge', 'token'));
		ok('bridge token present', !!token);

		// ================= Goal A：复现窗口 + 纠偏预算走到 BLOCKED =================
		const a = await driveToCorrecting(port, token, 'A');
		if (EXPECT === 'squeeze') {
			ok('REPRO A: canonical squeezes CORRECTING → AWAITING_REVIEW on read/sync (read#2)', a.afterFail === 'AWAITING_REVIEW', `afterFail=${a.afterFail}`);
			ok('REPRO A: squeeze stable on read#3 (not transient)', a.afterFail2 === 'AWAITING_REVIEW', `afterFail2=${a.afterFail2}`);
		} else {
			ok('FIX A: CORRECTING sticky on read#2', a.afterFail === 'CORRECTING', `afterFail=${a.afterFail}`);
			ok('FIX A: CORRECTING sticky on read#3 (stable)', a.afterFail2 === 'CORRECTING', `afterFail2=${a.afterFail2}`);
		}

		// 纠偏预算 3 次走到 BLOCKED（两种模式下都必须可达；sticky 下 correction 从 CORRECTING 接受）
		let gen = 1;
		let blockedSeen = false;
		for (let k = 1; k <= 3; k++) {
			const c = await sb(port, token, 'send_correction', {
				commandId: `${a.sg}:g${gen}:CORRECTION:${k}`, generation: gen, sessionId: a.sid,
				text: `HF2 probe correction #${k} (run ${RUN}): reply with exactly READY then stop.`, mode: 'steer',
			});
			ok(`A correction#${k} accepted`, c.status === 200 && (c.body?.accepted === true || c.body?.duplicate === true), JSON.stringify(c.body).slice(0, 200));
			// note：correction 落账 → receipt RUNNING；随后任一 get_goal 读都会立即再推导
			// （RUNNING 非粘滞，两种模式一致）→ harness_complete → AWAITING_REVIEW。
			// 这里只断言 generation 前进 + 重读收敛 AWAITING_REVIEW（粘滞断言专属于 CORRECTING）。
			const gRun = await getGoal(port, token, a.sid, `after-correction#${k}`);
			ok(`A correction#${k} → generation=${gen + 1} + re-read → AWAITING_REVIEW`, Number(gRun?.supervisor?.generation) === gen + 1 && cs(gRun) === 'AWAITING_REVIEW', `cs=${cs(gRun)} gen=${gRun?.supervisor?.generation}`);
			gen = gen + 1;
			const rvN = await sb(port, token, 'review_goal', {
				commandId: `${a.sg}:g${gen}:REVIEW:${k + 1}`, generation: gen, sessionId: a.sid, verdict: 'FAIL',
				criteriaResults: [{ criterion: 'hf2-probe-ready-reply', result: 'fail' }],
			});
			const expectState = k < 3 ? 'CORRECTING' : 'BLOCKED';
			ok(`A review FAIL#${k + 1} → ${expectState}`, rvN.status === 200 && rvN.body?.controlState === expectState, JSON.stringify(rvN.body).slice(0, 200));
			if (rvN.body?.controlState === 'BLOCKED') blockedSeen = true;
		}
		const gBlocked = await getGoal(port, token, a.sid, 'blocked-stable');
		ok('A BLOCKED terminal + stable on re-read', blockedSeen && cs(gBlocked) === 'BLOCKED', `cs=${cs(gBlocked)}`);

		// ================= Goal B：cancel 正常 + 幂等重放 =================
		const b = await driveToCorrecting(port, token, 'B');
		const cn = await sb(port, token, 'cancel_goal', {
			commandId: `${b.sg}:g1:CANCEL:1`, generation: 1, sessionId: b.sid, action: 'clear',
		});
		ok('B cancel accepted → CANCELLED', cn.status === 200 && cn.body?.controlState === 'CANCELLED', JSON.stringify(cn.body).slice(0, 200));
		const cn2 = await sb(port, token, 'cancel_goal', {
			commandId: `${b.sg}:g1:CANCEL:1`, generation: 1, sessionId: b.sid, action: 'clear',
		});
		ok('B cancel replay idempotent (no double side effect)', cn2.status === 200 && (cn2.body?.duplicate === true || cn2.body?.alreadyCancelled === true), JSON.stringify(cn2.body).slice(0, 200));
		const gB = await getGoal(port, token, b.sid, 'cancel-stable');
		ok('B CANCELLED stable on re-read', cs(gB) === 'CANCELLED', `cs=${cs(gB)}`);

		// ================= Goal C：重启/re-read 零漂移 =================
		if (!SKIP_RESTART) {
			const c = await driveToCorrecting(port, token, 'C');
			const stateBefore = c.afterFail2;
			stop(child);
			await sleep(2500);
			child = boot(port, home);
			await waitReady(port, 'restart');
			const token2 = readToken(join(home, 'supervisor-bridge', 'token'));
			const gC = await getGoal(port, token2, c.sid, 'restart-drift');
			ok(`C restart/re-read zero drift (before=${stateBefore})`, cs(gC) === stateBefore, `after=${cs(gC)}`);
		}

		// ================= 汇总 =================
		console.log(`\n[hf2-e2e] mode=${EXPECT} ${pass} passed, ${fail} failed, transient500(get_goal)=${transient500} (observation, pre-existing upstream robustness issue, not HF2 scope)`);
		if (fail > 0) { for (const f of failures) console.log(`  FAIL ${f}`); process.exit(1); }
		if (EXPECT === 'squeeze') {
			console.log('HF2-REPRO CONFIRMED: canonical main loses CORRECTING on read/sync (harness_complete squeezes it back to AWAITING_REVIEW). Hotfix 02.75-HF2 justified.');
			process.exit(42);
		}
		console.log('HF2 E2E PASS: CORRECTING sticky semantics verified (read/sync, corrections, exhausted, cancel, restart).');
		process.exit(0);
	} finally {
		stop(child);
		await sleep(2000);
		if (!KEEP) { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }
		else log(`KEEP=1 home kept: ${home}`);
	}
}

await main();
