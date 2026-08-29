// run-supervisor-ci-e2e.mjs —— P2.75 R1.1 CI 编排器：隔离 DSH_HOME 启停 + 三阶段真实 E2E
//
// 流程：
//   homeA(含 supervisor-bridge 插件，隔离 DSH_HOME) → boot → verify phase1 → 停止
//   → 同 homeA 重启（Bridge restart 语义）→ verify phase2 → 停止
//   → homeB(无 supervisor-bridge) → boot → verify phase3 → 停止
// 全程不触碰真实 ~/.dsh（full 模式为让 goal 有真实模型可跑，会复制 settings/凭据到
// 隔离 home，并在结束时删除；KEEP=1 可保留现场调试）。
//
// env：SB_MODE=ci|full（默认 ci；full=本地含真实模型回合的完整 review 流程）
//      KEEP=1（保留隔离 home 与 state 文件） · SB_ORCH_PORT_BASE（默认 33140）
// 运行：node tests/supervisor/run-supervisor-ci-e2e.mjs

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const VERIFY = join(ROOT, 'tests', 'supervisor', 'verify-supervisor-real-e2e.mjs');
const PLUGIN_DIR = join(ROOT, 'plugins');
const MODE = process.env.SB_MODE ?? 'ci';
// 解析 dsh CLI：优先 npm 全局（与 3080 生产服务同款 0.1.1-rc.2）。
// PATH 上 .workbuddy 的 dsh（0.1.0-rc.8）更靠前，其 credentials-local 解析器
// 不认真实 ~/.dsh/.credentials.yaml 的 version 字段（"must be a string"），
// full 模式拷入真实凭据后 boot 必挂 —— 2026-08-29 R1.1 E2E 实测根因。
const NPM_DSH = join(process.env.APPDATA ?? '', 'npm', 'dsh.cmd');
const DSH = existsSync(NPM_DSH) ? NPM_DSH : 'dsh';
const KEEP = process.env.KEEP === '1';
const PORT_BASE = Number(process.env.SB_ORCH_PORT_BASE ?? '33140');
const RUN = `orch-${Date.now().toString(36)}`;
const SMOKE_PLUGINS = [
	'completion-notify.mjs', 'keepalive-patch.mjs', 'model-selection-guard.mjs',
	'execution-continuity.mjs', 'context-memory.mjs', 'supervisor-bridge.mjs',
];

function log(msg) { console.log(`[orch] ${msg}`); }

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

function buildHome(withSupervisor) {
	const home = mkdtempSync(join(tmpdir(), `sb-e2e-${withSupervisor ? 'a' : 'b'}-`));
	const profileDir = join(home, 'profiles', 'web');
	mkdirSync(profileDir, { recursive: true });
	for (const f of readdirSync(PLUGIN_DIR)) {
		if (!f.endsWith('.mjs')) continue;
		if (/test/i.test(f)) continue;
		copyFileSync(join(PLUGIN_DIR, f), join(profileDir, f));
	}
	const active = withSupervisor ? SMOKE_PLUGINS : SMOKE_PLUGINS.filter((p) => p !== 'supervisor-bridge.mjs');
	const manifest = active
		.filter((p) => existsSync(join(PLUGIN_DIR, p)))
		.map((p) => `- insert:\n    - id: sb-${p.replace('.mjs', '')}\n      name: './${p}'\n      config: {}`)
		.join('\n');
	writeFileSync(join(profileDir, 'cordis.patch.yml'), manifest || '[]', 'utf8');
	writeFileSync(join(profileDir, 'cordis.yml'), '[]', 'utf8');
	// full 模式：让隔离 home 拥有真实模型配置（本地同用户临时目录，结束即清理）
	if (MODE === 'full') {
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

function boot(port, home) {
	const child = spawn('cmd.exe', ['/c', DSH, 'web', '--port', String(port), '--no-open'], {
		env: { ...process.env, DSH_HOME: home },
		stdio: 'ignore',
	});
	return child;
}
function stop(child) {
	if (!child?.pid) return;
	spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
async function waitReady(port, label) {
	const url = `http://127.0.0.1:${port}/api/host.describe`;
	for (let i = 0; i < 90; i++) {
		await new Promise((r) => setTimeout(r, 1000));
		try {
			const r = await fetch(url, {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ type: 'client-request', rpcId: `orch-${label}`, method: 'host.describe', payload: {} }),
				signal: AbortSignal.timeout(2500),
			});
			const j = await r.json().catch(() => null);
			if (j?.result?.ok) return true;
		} catch { /* retry */ }
	}
	throw new Error(`dsh did not become ready (${label}) on port ${port}`);
}

function runPhase(phase, env) {
	const r = spawnSync('node', [VERIFY], {
		env: { ...process.env, ...env },
		stdio: 'inherit',
		encoding: 'utf8',
	});
	return r.status === 0;
}

// ---------- 前置检查 ----------
const dshVer = spawnSync('cmd.exe', ['/c', DSH, '--version'], { encoding: 'utf8' });
if (dshVer.status !== 0 || !String(dshVer.stdout).trim()) {
	console.error('[orch] FAIL: global dsh CLI not available (npm i -g @deepseek-ai/dsh)');
	process.exit(1);
}
log(`dsh version: ${String(dshVer.stdout).trim()} · mode=${MODE}`);

const portA = await freePort(PORT_BASE);
const portB = await freePort(PORT_BASE + 100);
const stateFile = join(tmpdir(), `sb-e2e-state-${RUN}.json`);
const homes = [];
let failed = false;

try {
	// ---------- homeA：phase1 → restart → phase2 ----------
	const homeA = buildHome(true);
	homes.push(homeA);
	log(`homeA=${homeA} port=${portA}`);
	let child = boot(portA, homeA);
	await waitReady(portA, 'phase1');
	log('phase 1: negatives + dispatch/correction/cancel/review on live instance');
	failed = !runPhase(1, {
		SB_BASE: `http://127.0.0.1:${portA}`,
		SB_TOKEN_DIR: homeA,
		SB_DSH_HOME: homeA,
		SB_PHASE: '1',
		SB_MODE: MODE,
		SB_RUN: RUN,
		SB_STATE_FILE: stateFile,
	});
	stop(child);
	if (failed) throw new Error('phase 1 failed');

	log('restarting same DSH_HOME (bridge restart semantics)');
	child = boot(portA, homeA);
	await waitReady(portA, 'phase2');
	log('phase 2: replay → zero second side effects + corrupt-ledger fail-closed');
	failed = !runPhase(2, {
		SB_BASE: `http://127.0.0.1:${portA}`,
		SB_TOKEN_DIR: homeA,
		SB_DSH_HOME: homeA,
		SB_PHASE: '2',
		SB_MODE: MODE,
		SB_RUN: RUN,
		SB_STATE_FILE: stateFile,
	});
	stop(child);
	if (failed) throw new Error('phase 2 failed');

	// ---------- homeB：phase3 隔离性 ----------
	const homeB = buildHome(false);
	homes.push(homeB);
	log(`homeB=${homeB} port=${portB} (no supervisor plugin)`);
	child = boot(portB, homeB);
	await waitReady(portB, 'phase3');
	failed = !runPhase(3, {
		SB_BASE: `http://127.0.0.1:${portB}`,
		SB_PHASE: '3',
		SB_MODE: MODE,
		SB_RUN: RUN,
	});
	stop(child);
	if (failed) throw new Error('phase 3 failed');

	log('ALL PHASES PASS');
} catch (e) {
	console.error(`[orch] FAIL: ${e.message}`);
	failed = true;
} finally {
	if (!KEEP) {
		for (const h of homes) rmSync(h, { recursive: true, force: true });
		try { rmSync(stateFile, { force: true }); } catch { /* ignore */ }
		log('temp homes cleaned');
	} else {
		log(`KEEP=1: homes kept: ${homes.join(', ')}; state: ${stateFile}`);
	}
}
process.exit(failed ? 1 : 0);
