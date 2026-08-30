#!/usr/bin/env node
// run-autonomy-real-e2e.mjs —— P3 AUTONOMY R1 真实 Runtime E2E（三条腿，全部隔离实例）
//
// E1 无人值守决策：真实模型任务含二选一可逆选择 → 全程无 ask_user_question 事件，
//    决策经 autonomy_report 记录、autonomy_verify 留真实证据、verificationState=VERIFIED。
// E2 kill/重启恢复：任务执行中（1 个已验证里程碑 + 真实文件副作用）强杀隔离实例 →
//    重启后 autonomy 状态持久、resume 提示含 Verified progress 行（含 last verified
//    checkpoint）、副作用文件恰好一次（completion truth 防重复副作用）。
// E3 完成验证真值：被记录的 PASS 必须真实（HOST-VERIFIED 前缀 + 文件存在 +
//    sha256 重算匹配），state/milestone/checkpoint 与 PASS 一致；补真实证据后同一条
//    AC 推导出 VERIFIED。"伪造证据被拒"的 deterministic 负向镜头由已部署套件
//    I10-I13（无模型依赖）承担——真实模型拒绝配合伪造剧本（两轮实测，见 legE3 注释）。
//
// 隔离保障（沿用 run-supervisor-ci-e2e.mjs 的成熟模式）：
//   - DSH_HOME 指向临时目录；EC config.stateDir 指向 <home>/ec-state（绝不碰生产
//     %LOCALAPPDATA%\DSHHarness\state\execution-intents.json）。
//   - 端口 33310+ 空闲分配；apiPort 显式指向隔离端口。
//   - enableAutoResume: true（E2 需要真实重启恢复；仅作用于隔离实例）。
//   - full 凭据：临时拷贝 settings.yaml + .credentials.yaml + agents/ 到隔离 home
//     （真实模型回合所需），KEEP!=1 时运行结束删除。
//   - 生产 loaded-release.json 先快照后恢复（EC boot 会覆写该全局诊断文件）。
//   - 绝不触碰 3080 生产服务进程；taskkill 仅针对本脚本 spawn 的隔离子进程。
//
// env：KEEP=1 保留现场调试 · P3R1_E2E_PORT_BASE（默认 33310）· P3R1_LEGS=E1,E2,E2B,E3
// 运行：node tests/autonomy/run-autonomy-real-e2e.mjs
import { spawn, spawnSync } from 'node:child_process';
import { evaluateCompletion } from '../../plugins/completion-truth-core.mjs';
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, existsSync, rmSync, readFileSync, statSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const PLUGIN_DIR = join(ROOT, 'plugins');
const EVIDENCE_DIR = join(ROOT, 'docs', 'roadmap', 'reports', 'PHASE_03_AUTONOMY', 'e2e');
const NPM_DSH = join(process.env.APPDATA ?? '', 'npm', 'dsh.cmd');
const DSH = existsSync(NPM_DSH) ? NPM_DSH : 'dsh';
const KEEP = process.env.KEEP === '1';
const PORT_BASE = Number(process.env.P3R1_E2E_PORT_BASE ?? '33310');
const LEGS = (process.env.P3R1_LEGS ?? 'E1,E2,E3').split(',').map((s) => s.trim()).filter(Boolean);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const DSH_DOT = join(process.env.USERPROFILE ?? '', '.dsh');
const LOADED_RELEASE = join(process.env.LOCALAPPDATA ?? '', 'DSHHarness', 'state', 'loaded-release.json');

function log(msg) { console.log(`[p3r1-e2e] ${msg}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort(base) {
	return new Promise((res, rej) => {
		const tryNext = (p) => {
			if (p >= base + 50) { rej(new Error('no free port')); return; }
			const s = net.createServer();
			s.once('error', () => { try { s.close(() => tryNext(p + 1)); } catch { tryNext(p + 1); } });
			s.once('listening', () => s.close(() => res(p)));
			s.listen(p, '127.0.0.1');
		};
		tryNext(base);
	});
}

// ---------- 隔离 home ----------
function buildHome(tag) {
	const home = mkdtempSync(join(tmpdir(), `p3r1-e2e-${tag}-`));
	const profileDir = join(home, 'profiles', 'web');
	mkdirSync(profileDir, { recursive: true });
	for (const f of readdirSync(PLUGIN_DIR)) {
		if (!f.endsWith('.mjs') || /test/i.test(f)) continue;
		copyFileSync(join(PLUGIN_DIR, f), join(profileDir, f));
	}
	mkdirSync(join(home, 'workdir'), { recursive: true });
	mkdirSync(join(home, 'ec-state'), { recursive: true });
	return home;
}

function writeManifest(home, port, enableAutoResume) {
	const stateDir = join(home, 'ec-state').replaceAll('\\', '/');
	// 仅插 EC（含 autonomy 工具面 + completion truth）；不插 router/bridge（隔离最小面）。
	const manifest = `- insert:
    - id: p3r1-execution-continuity
      name: './execution-continuity.mjs'
      config:
        stateDir: '${stateDir}'
        apiPort: ${port}
        enableAutoResume: ${enableAutoResume ? 'true' : 'false'}
`;
	writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), manifest, 'utf8');
	writeFileSync(join(home, 'profiles', 'web', 'cordis.yml'), '[]\n', 'utf8');
}

function copyCredentials(home) {
	for (const f of ['settings.yaml', '.credentials.yaml']) {
		if (existsSync(join(DSH_DOT, f))) copyFileSync(join(DSH_DOT, f), join(home, f));
	}
	if (existsSync(join(DSH_DOT, 'agents'))) {
		spawnSync('robocopy', [join(DSH_DOT, 'agents'), join(home, 'agents'), '/E', '/NFL', '/NDL', '/NJH', '/NJS'], { stdio: 'ignore' });
	}
}

// ---------- 进程 ----------
// 2026-08-30 R1：实例 stdout 落盘（此前 stdio:'ignore' 把 EC 的 RESUME-*/CT 诊断
// 全部丢弃，恢复失败只能盲猜分支）。日志写到 EVIDENCE_DIR 下，不随 home 清理丢失。
function boot(port, home, logFile = null) {
	const child = spawn('cmd.exe', ['/c', DSH, 'web', '--port', String(port), '--no-open'], {
		env: { ...process.env, DSH_HOME: home, EC_API_PORT: String(port) },
		stdio: logFile ? ['ignore', 'pipe', 'pipe'] : 'ignore',
	});
	if (logFile) {
		try { mkdirSync(dirname(logFile), { recursive: true }); } catch { /* exists */ }
		const stream = createWriteStream(logFile, { flags: 'a' });
		child.stdout.pipe(stream);
		child.stderr.pipe(stream);
		child._e2eLogFile = logFile;
	}
	return child;
}
function stopTree(pid) {
	if (!pid) return;
	spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

// ---------- RPC ----------
async function rpc(port, method, payload) {
	const r = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ type: 'client-request', rpcId: `p3r1-${Date.now()}`, method, payload }),
		signal: AbortSignal.timeout(15000),
	});
	const j = await r.json().catch(() => null);
	if (!j || j.result?.ok === false) {
		const raw = j?.result?.error ?? `http ${r.status}`;
		throw new Error(`rpc ${method}: ${typeof raw === 'string' ? raw : JSON.stringify(raw).slice(0, 300)}`);
	}
	return j.result?.value;
}
async function waitReady(port, label, timeoutMs = 90000) {
	const t0 = Date.now();
	for (;;) {
		try { await rpc(port, 'host.describe', {}); return; } catch { /* retry */ }
		if (Date.now() - t0 > timeoutMs) throw new Error(`dsh not ready (${label}) port ${port}`);
		await sleep(1500);
	}
}
async function history(port, sessionId) {
	try {
		const v = await rpc(port, 'session.history', { sessionId, maxMessages: 4000 });
		return v?.events ?? null;
	} catch { return null; }
}
async function sessionRow(port, sessionId) {
	try {
		const list = await rpc(port, 'session.list', {});
		// 2026-08-30 R1 修复：本机服务端 session.list 返回 { items: [...] }
		// （execution-continuity.mjs resumeViaApi 用的就是 list.items）。
		// 旧实现只读 list/list.sessions → 恒 null → waitTurnEnd 阶段1 永远
		// 等不到 running=true，烧满超时后提前 kill，把在途回合切断（E2 根因）。
		const arr = Array.isArray(list) ? list
			: (Array.isArray(list?.items) ? list.items
			: (Array.isArray(list?.sessions) ? list.sessions : []));
		return arr.find((s) => s && s.sessionId === sessionId) ?? null;
	} catch { return null; }
}
async function waitTurnEnd(port, sessionId, timeoutMs, label) {
	// 权威结束信号 = session.list 行的 running===false（history 只含消息事件，无 turn/end）。
	const t0 = Date.now();
	// 阶段1：等回合真的开始（running=true，或 history 已有事件——防秒完成竞态）
	for (;;) {
		const row = await sessionRow(port, sessionId);
		const ev = row && row.running !== true ? await history(port, sessionId) : null;
		if (row && (row.running === true || (ev && ev.length > 0))) break;
		if (Date.now() - t0 > timeoutMs) { log(`[warn] turn-start wait timeout (${label})`); return history(port, sessionId); }
		await sleep(2000);
	}
	// 阶段2：等 running=false
	for (;;) {
		const row = await sessionRow(port, sessionId);
		if (row && row.running === false) return history(port, sessionId);
		if (Date.now() - t0 > timeoutMs) { log(`[warn] turn-end wait timeout (${label})`); return history(port, sessionId); }
		await sleep(3000);
	}
}

// ---------- intent store（唯一真源，隔离路径直读） ----------
function readIntents(home) {
	const f = join(home, 'ec-state', 'execution-intents.json');
	if (!existsSync(f)) return null;
	try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}
function findIntent(home, sessionId) {
	const data = readIntents(home);
	if (!data) return null;
	const arr = Array.isArray(data) ? data : Array.isArray(data.intents) ? data.intents : Object.values(data.intents ?? data);
	return arr.find((i) => i && i.sessionId === sessionId) ?? null;
}
async function waitIntent(home, sessionId, pred, timeoutMs, label) {
	const t0 = Date.now();
	for (;;) {
		const it = findIntent(home, sessionId);
		if (it && pred(it)) return it;
		if (Date.now() - t0 > timeoutMs) return it;
		await sleep(2500);
	}
}

// ---------- 断言/证据 ----------
function mkChecks() { return { pass: 0, fail: 0, items: [] }; }
function check(cs, name, cond, detail = '') {
	const item = { name, ok: !!cond, detail: String(detail).slice(0, 400) };
	cs.items.push(item);
	if (item.ok) { cs.pass++; console.log(`  PASS ${name}`); }
	else { cs.fail++; console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`); }
	return item.ok;
}
function saveEvidence(leg, payload) {
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	const file = join(EVIDENCE_DIR, `${leg}-${STAMP}.json`);
	writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
	log(`evidence -> ${file}`);
	return file;
}
import { createHash } from 'node:crypto';
function sha(buf) { return createHash('sha256').update(buf).digest('hex'); }

// ---------- 会话驱动 ----------
async function runTask(port, sessionId, objective, prompt) {
	await rpc(port, 'session.create', { sessionId });
	await rpc(port, 'goal.create', { sessionId, objective });
	await rpc(port, 'session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] });
}

// ==========================================================================
// LEG E1 —— 无人值守决策
// ==========================================================================
async function legE1() {
	const leg = 'E1';
	log(`=== ${leg}: unattended decision (isolated instance, real model) ===`);
	const home = buildHome('e1');
	const port = await freePort(PORT_BASE);
	writeManifest(home, port, false);
	copyCredentials(home);
	let child = null;
	const cs = mkChecks();
	const sessionId = `p3r1e1-${STAMP}`;
	const decisionFile = join(home, 'workdir', 'decision-log.txt');
	try {
		child = boot(port, home, join(EVIDENCE_DIR, `instance-E1-${STAMP}.log`));
		await waitReady(port, leg);
		log(`instance ready port=${port} home=${home}`);
		const objective = '无人值守决策演练：对二选一可逆选择自动决策并记录（不询问用户）';
		const prompt = [
			`【无人值守任务·P3 AUTONOMY 演练】工作文件路径：${decisionFile}。`,
			'任务：存在一个普通的、可逆的技术二选一（选项 A=写入 chose-A，选项 B=写入 chose-B）。',
			'按无人值守决策策略自行决策：若 2+2>3 选 A，否则选 B。全程禁止调用 ask_user_question。',
			'执行步骤：',
			`1) 调用 autonomy_report：acceptanceCriteria=[“决策文件已创建且内容恰为 chose-A 或 chose-B”]，criteriaBindings=[{"kind":"file","index":0,"path":"${decisionFile}"}]，currentStep=“决策中”，remainingSteps=[“写决策文件”,“记录验收证据”]。`,
			'2) 调用 autonomy_report 更新：currentStep=“已决策：<A或B>；理由：普通可逆技术选择，按无人值守策略自动决策”。',
			'3) 用文件写入工具创建上述路径文件，内容恰好为 chose-A 或 chose-B（无其他文字）。',
			'4) 计算该文件的真实 sha256（64 位 hex），然后调用 autonomy_verify：criterionIndex=0，status="PASS"，evidenceClass="file_hash"，evidence 使用规范格式：file:<该文件绝对路径>|sha256:<真实sha256hex>（hash 必须真实计算，不得编造），并附 milestoneStep="无人值守决策完成（chose-A 或 chose-B 已落盘）"。',
			'5) 结束回合。',
		].join('\n');
		await runTask(port, sessionId, objective, prompt);
		const ev = await waitTurnEnd(port, sessionId, 420000, leg);
		const evText = ev ? JSON.stringify(ev) : '';
		check(cs, 'E1.1 turn produced history events', !!ev && ev.length > 0, `events=${ev ? ev.length : 'null'}`);
		// 精确断言：不存在真实的 ask_user_question 工具调用记录。提示词/工具目录中的
		// 字样不算（历史 JSON 里裸词不匹配带引号的字段值）；把所有提及该词的事件形状
		// 落盘证据，供人工审计。权威交叉验证 = intent 状态（真实提问 → EC WAIT-GATE
		// 会标 WAITING_USER，见 E1.8）。
		const mentions = [];
		for (const e of ev ?? []) {
			const s = JSON.stringify(e);
			if (s.includes('ask_user_question')) {
				mentions.push({ type: e?.type ?? null, keys: e ? Object.keys(e).join(',') : null, preview: s.slice(0, 400) });
			}
		}
		const realCalls = mentions.filter((m) => /tool/i.test(String(m.type ?? '')) || /"name"\s*:\s*"ask_user_question"/.test(m.preview) || /"toolName"\s*:\s*"ask_user_question"/.test(m.preview) || /"tool"\s*:\s*"ask_user_question"/.test(m.preview));
		check(cs, 'E1.2 NO real ask_user_question tool-call record', realCalls.length === 0, `mentions=${mentions.length} realCalls=${realCalls.length} sample=${JSON.stringify(mentions[0] ?? null).slice(0, 200)}`);
		const fileOk = existsSync(decisionFile);
		const content = fileOk ? readFileSync(decisionFile, 'utf8').trim() : null;
		check(cs, 'E1.3 decision file exists with chose-A|chose-B', content === 'chose-A' || content === 'chose-B', `content=${JSON.stringify(content)}`);
		const it = await waitIntent(home, sessionId, (x) => x?.autonomy?.acceptanceCriteria?.length >= 1, 30000, 'autonomy block');
		const au = it?.autonomy ?? null;
		check(cs, 'E1.4 autonomy acceptanceCriteria persisted (write-once)', !!au && Array.isArray(au.acceptanceCriteria) && au.acceptanceCriteria.length >= 1, JSON.stringify(au?.acceptanceCriteria ?? null).slice(0, 120));
		const ev0 = au?.criteriaEvidence?.[0] ?? null;
		check(cs, 'E1.5 autonomy_verify PASS evidence persisted', !!ev0 && ev0.status === 'PASS', JSON.stringify(ev0).slice(0, 200));
		check(cs, 'E1.6 verificationState derived VERIFIED', au?.verificationState === 'VERIFIED', `state=${au?.verificationState}`);
		check(cs, 'E1.7 lastVerifiedCheckpoint recorded', typeof au?.lastVerifiedCheckpoint === 'string' && au.lastVerifiedCheckpoint.length > 0, String(au?.lastVerifiedCheckpoint ?? ''));
		check(cs, 'E1.8 intent not WAITING_USER', it && it.state !== 'WAITING_USER', `state=${it?.state}`);
		const payload = { leg, stamp: STAMP, port, home, sessionId, checks: cs.items,
			autonomy: au, intentState: it?.state ?? null, decisionFileContent: content,
			historyEventCount: ev ? ev.length : 0,
			eventTypeHistogram: ev ? ev.reduce((acc, e) => { const t = e?.type ?? 'unknown'; acc[t] = (acc[t] ?? 0) + 1; return acc; }, {}) : null,
			askUserQuestionMentions: mentions };
		saveEvidence(leg, payload);
	} finally {
		stopTree(child?.pid);
		if (!KEEP) { await sleep(1500); try { rmSync(home, { recursive: true, force: true }); } catch { /* win lock */ } }
	}
	return cs;
}

// ==========================================================================
// LEG E2 —— kill/重启恢复
// ==========================================================================
async function legE2() {
	const leg = 'E2';
	log(`=== ${leg}: mid-task kill + restart recovery (isolated instance, real model) ===`);
	const home = buildHome('e2');
	const port = await freePort(PORT_BASE + 1);
	writeManifest(home, port, true);
	copyCredentials(home);
	const sessionId = `p3r1e2-${STAMP}`;
	const sideEffect = join(home, 'workdir', 'side-effect.txt');
	let child = null;
	const cs = mkChecks();
	try {
		// ---- phase 1：跑到“已验证里程碑 + 真实副作用”后停住等恢复 ----
		const instLog = join(EVIDENCE_DIR, `instance-E2-${STAMP}.log`);
		child = boot(port, home, instLog);
		await waitReady(port, `${leg}-p1`);
		log(`instance ready port=${port} instLog=${instLog}`);
		const objective = '两阶段恢复演练：阶段1建立已验证里程碑与文件副作用；重启后从 last verified state 续跑';
		const prompt = [
			`【恢复演练·阶段1】文件路径：${sideEffect}。`,
			'1) 用文件写入工具创建该文件，内容恰为 side-effect-v1。',
			`2) 调用 autonomy_report：acceptanceCriteria=[“side-effect 文件存在且内容为 side-effect-v1”]，criteriaBindings=[{"kind":"file","index":0,"path":"${sideEffect}"}]，currentStep=“里程碑已建立”，remainingSteps=[“等待重启”,“重启后核对副作用不重复”]。`,
			'3) 计算该文件的真实 sha256（64 位 hex），然后调用 autonomy_verify：criterionIndex=0，status="PASS"，evidenceClass="file_hash"，evidence 使用规范格式：file:<该文件绝对路径>|sha256:<真实sha256hex>（hash 必须真实计算，不得编造）。',
			'4) 结束回合等待系统恢复（不要做其他事）。记录里程碑后立刻结束回合，不要再调用任何工具（包括不要再更新 currentStep）。绝对禁止调用 update_goal（尤其禁止 complete/blocked）——本 goal 的第二阶段必须等系统重启后由恢复流程继续，你提前完成 goal 会让恢复演练失效。也不要创建新的 goal。',
			'硬性约束：禁止调用 update_goal（尤其禁止 complete/blocked/paused）——goal 必须保持 active，本演练分两阶段，完成判定在阶段2。也禁止调用 ask_user_question。',
		].join('\n');
		await runTask(port, sessionId, objective, prompt);
		await waitTurnEnd(port, sessionId, 420000, `${leg}-p1`);
		// 里程碑补打（有界 1 次）：flash 模型偶发漏打 milestoneStep（run3 实测），
		// 场景构造兜底——这不是产品逻辑，是让 E2 断言确定化。
		const preProbe = findIntent(home, sessionId);
		if ((preProbe?.autonomy?.verifiedMilestones?.length ?? 0) < 1) {
			log('milestone missing after phase-1 turn -> one bounded re-prompt turn');
			await rpc(port, 'session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: `请补打阶段1里程碑：先计算 ${sideEffect} 的真实 sha256（64 位 hex），然后调用 autonomy_verify（criterionIndex=0，status="PASS"，evidenceClass="file_hash"，evidence 使用规范格式 file:${sideEffect}|sha256:<真实sha256hex>），确保 verifiedMilestones 记录该里程碑，然后立即结束回合。不要做其他任何事。` }] });
			await waitTurnEnd(port, sessionId, 240000, `${leg}-p1-milestone`);
		}
		const pre = await waitIntent(home, sessionId, (x) => (x?.autonomy?.verifiedMilestones?.length ?? 0) >= 1, 60000, 'milestone');
		check(cs, 'E2.1 pre-kill: 1 verified milestone persisted', (pre?.autonomy?.verifiedMilestones?.length ?? 0) >= 1, JSON.stringify(pre?.autonomy?.verifiedMilestones ?? null).slice(0, 200));
		check(cs, 'E2.2 pre-kill: side-effect file exists v1', existsSync(sideEffect) && readFileSync(sideEffect, 'utf8').trim() === 'side-effect-v1', existsSync(sideEffect) ? readFileSync(sideEffect, 'utf8') : 'missing');
		// E2.0 可恢复前置条件：intent 必须处于 RUNNING 且 autoResume=true（goal active 且无待答提问）。
		// 若模型提前把 goal 标成 complete/blocked → EC 置 COMPLETED（终态，boot scan 按设计不恢复），
		// 这是场景构造失败，不是 EC 缺陷——诚实报 FAIL 并给出根因，绝不让后续断言产生假阴性/假阳性。
		check(cs, 'E2.0 pre-kill: intent recoverable (RUNNING + autoResume)', pre?.state === 'RUNNING' && pre?.autoResume === true, `state=${pre?.state} autoResume=${pre?.autoResume} (COMPLETED/终态=场景构造失败：模型提前结束 goal)`);
		const preAutonomy = JSON.parse(JSON.stringify(pre?.autonomy ?? null));
		const preFileMtime = existsSync(sideEffect) ? statSync(sideEffect).mtimeMs : null;

		const preKillTs = Date.now();
		// kill 窗口猎手 v2（2026-08-30 R1）：goal 活跃时 running 标志恒 true
		//（run5 实测 150ms×120s 无一 false），无法用 running 观测干净间隙。
		// 改为直接复用 CT 判据：轮询 history 尾部（300 事件窗口），在
		// evaluateCompletion 判 clean（无未闭合工具调用）的瞬间立即杀——
		// 重启后全量 CT 也判 clean → 快乐路径 resume。等不到 = 脏 kill，
		// 诚实记录（fail-closed 钉死属设计行为）。
		let cleanKill = false;
		{
			const t0 = Date.now();
			for (;;) {
				const ev = await history(port, sessionId);
				if (ev && ev.length > 0) {
					let verdict = 'unknown';
					try { verdict = evaluateCompletion(ev).state; } catch { /* shape variance */ }
					if (verdict === 'clean') {
						// 双采样：300ms 后复评一次，把"采样后被模型再发调用"的竞态
						// 窗口压到最小（run6 单采样 92ms 命中仍被杀前竞态污染）。
						await sleep(300);
						let v2 = 'unknown';
						try { const ev2 = await history(port, sessionId); v2 = evaluateCompletion(ev2).state; } catch { /* dying */ }
						if (v2 === 'clean') { cleanKill = true; break; }
					}
				}
				if (Date.now() - t0 > 120000) break;
				await sleep(300);
			}
			log(`kill window: clean=${cleanKill} (hunted ${Date.now() - t0}ms, CT-criterion double-sample on live history)`);
		}
		// ---- 强杀（仅隔离子进程）----
		log(`KILL isolated instance pid=${child.pid}`);
		stopTree(child.pid);
		child = null;
		await sleep(3000);

		// ---- phase 2：重启（同 home），boot scan 自动 resume ----
		child = boot(port, home, instLog);
		await waitReady(port, `${leg}-p2`);
		log('restarted; waiting for EC boot scan auto-resume (5s scan + turn)');
		const deadline = Date.now() + 300000;
		let resumeEvents = null;
		while (Date.now() < deadline) {
			resumeEvents = await history(port, sessionId);
			if (resumeEvents && JSON.stringify(resumeEvents).includes('Verified progress:')) break;
			await sleep(4000);
		}
		const postText = resumeEvents ? JSON.stringify(resumeEvents) : '';
		check(cs, 'E2.3 resume message contains "Verified progress:" line', postText.includes('Verified progress:'), '');
		check(cs, 'E2.4 resume line carries last verified checkpoint + no-redo directive',
			postText.includes('last verified checkpoint') && postText.includes('Continue from the last verified state'), '');
		// 真实 RESUME-OK 证据（EC resumeAfterCtClean/1015 路径）：本 boot 内 autoResumeCycles>=1
		// 且 lastResumeAt 晚于 kill 时刻。recoveryCount 字段不存在（此前断言引用了臆造字段）。
		const post = await waitIntent(home, sessionId, (x) => x && ((x.autoResumeCycles ?? 0) >= 1 && (x.lastResumeAt ?? 0) > preKillTs), 180000, 'resume-ok');
		check(cs, 'E2.5 autonomy state persisted across restart (milestones intact)',
			JSON.stringify(post?.autonomy?.verifiedMilestones ?? null) === JSON.stringify(preAutonomy?.verifiedMilestones ?? null),
			`pre=${JSON.stringify(preAutonomy?.verifiedMilestones ?? null).slice(0, 120)} post=${JSON.stringify(post?.autonomy?.verifiedMilestones ?? null).slice(0, 120)}`);
		check(cs, 'E2.6 acceptance criteria + evidence persisted across restart',
			JSON.stringify(post?.autonomy?.acceptanceCriteria ?? null) === JSON.stringify(preAutonomy?.acceptanceCriteria ?? null)
			&& JSON.stringify(post?.autonomy?.criteriaEvidence ?? null) === JSON.stringify(preAutonomy?.criteriaEvidence ?? null), '');
		check(cs, 'E2.7 recovery actually happened (RESUME-OK this boot)', !!post && (post.autoResumeCycles ?? 0) >= 1 && (post.lastResumeAt ?? 0) > preKillTs, `state=${post?.state} autoResumeCycles=${post?.autoResumeCycles} lastResumeAt>${preKillTs}=${(post?.lastResumeAt ?? 0) > preKillTs}`);
		// 副作用恰好一次：文件内容未被改成 v2/重复追加，mtime 未变化
		const postContent = existsSync(sideEffect) ? readFileSync(sideEffect, 'utf8').trim() : null;
		const postMtime = existsSync(sideEffect) ? statSync(sideEffect).mtimeMs : null;
		check(cs, 'E2.8 side-effect file exactly-once (content unchanged, no duplicate write)', postContent === 'side-effect-v1' && (preFileMtime === null || postMtime === preFileMtime), `content=${postContent} mtimeDelta=${preFileMtime !== null && postMtime !== null ? postMtime - preFileMtime : 'n/a'}`);
		// E2.9（信息性诊断，不计 PASS/FAIL）：与 E1.2 同判据——只统计真实工具调用记录；
		// 历史上下文回放中路径字样出现 N 次属正常，不作为断言依据。权威证据 = E2.8 的
		// mtime+内容不变（真实文件系统层面的"恰好一次"）。
		const sideEffectMentions = [];
		for (const e of resumeEvents ?? []) {
			const s = JSON.stringify(e);
			if (s.includes('side-effect.txt')) {
				const isToolRec = /tool/i.test(String(e?.type ?? '')) || /"name"\s*:\s*"(write|edit|create_file|str_replace)"/.test(s) || /"tool(Name)?"\s*:\s*"(write|edit|create_file|str_replace)"/.test(s);
				if (isToolRec) sideEffectMentions.push({ type: e?.type ?? null, preview: s.slice(0, 300) });
			}
		}
		log(`[info] E2.9 diagnostic: side-effect tool-record mentions after resume = ${sideEffectMentions.length} (advisory; authoritative = E2.8)`);
		const payload = { leg, stamp: STAMP, port, home, sessionId, checks: cs.items,
			preAutonomy, postAutonomy: post?.autonomy ?? null, preState: pre?.state ?? null, postState: post?.state ?? null,
			autoResumeCycles: post?.autoResumeCycles ?? null, lastResumeAt: post?.lastResumeAt ?? null, preKillTs,
			sideEffectContent: postContent, sideEffectToolRecordMentions: sideEffectMentions,
			resumeHistoryEventCount: resumeEvents ? resumeEvents.length : 0,
			instanceLog: instLog, cleanKill };
		// 恢复失败时把 EC 诊断行摘要带进证据（RESUME-*/CT/SCAN），不用再盲猜分支
		if (cs.fail > 0 && existsSync(instLog)) {
			try {
				const txt = readFileSync(instLog, 'utf8');
				payload.ecDiagLines = txt.split(/\r?\n/).filter((l) => /RESUME-|CT-|SCAN-|TIMER-|reconcil|NEEDS|WAIT-GATE|liveness/i.test(l)).slice(-120);
			} catch { /* log locked */ }
		}
		saveEvidence(leg, payload);
	} finally {
		stopTree(child?.pid);
		if (!KEEP) { await sleep(1500); try { rmSync(home, { recursive: true, force: true }); } catch { /* win lock */ } }
	}
	return cs;
}

// ==========================================================================
// LEG E2B —— 确定性重启恢复（运行器预置官方状态；恢复链路全真实产品代码）
//
// 背景（2026-08-30 run3-8 尸检结论）：E2 依赖真实模型按剧本走 4 步后停在"等待
// 恢复"，但真实模型不可控——run7/8 模型直接幻觉"阶段2完成"（假里程碑 + 假
// file_hash 证据 PASS + goal complete）→ 意图 COMPLETED → 重启无恢复。且全量
// 739 事件 CT=clean 证明 run6 的"脏 kill 竞态"假设不成立。这是 F1（执行者自证）
// 在 goal 完成层的真实半径，已作为 FINDING 记录；E2 腿保留（其 run4-8 证据已
// 证明：boot scan/RESUME-SKIP/fail-closed pin 语义全部正确）。
//
// E2B 把"阶段1"从模型关键路径移除：良性种子回合（只回复 OK）→ 停机 → 运行器
// 离线注入官方 intent store（RUNNING + autoResume + schema v3 autonomy 块）→
// 重启 → boot scan 对真实干净历史 CT 判 clean → 必然 RESUME-OK。被测路径
// （boot scan → CT → composeResumeMessage → kick → 状态迁移）全部是真实产品
// 代码，唯一预置的是"任务进行中被杀"这个先验状态本身。
// ==========================================================================
async function legE2B() {
	const leg = 'E2B';
	log(`=== ${leg}: deterministic restart-resume (runner-preset official state, real recovery path) ===`);
	const home = buildHome('e2b');
	const port = await freePort(PORT_BASE + 4);
	writeManifest(home, port, true);
	copyCredentials(home);
	const sessionId = `p3r1e2b-${STAMP}`;
	const sideEffect = join(home, 'workdir', 'side-effect-b.txt');
	const CHECKPOINT = '阶段1完成：side-effect-b.txt 已写入 v1 且 AC-0 PASS（种子回合，运行器预置）';
	let child = null;
	const cs = mkChecks();
	try {
		// ---- 阶段0：种子回合（真实历史，无未闭合调用） ----
		writeFileSync(sideEffect, 'side-effect-v1', 'utf8');
		const seedMtime = statSync(sideEffect).mtimeMs;
		child = boot(port, home, join(EVIDENCE_DIR, `instance-E2B-${STAMP}.log`));
		await waitReady(port, leg);
		log(`instance ready port=${port} home=${home}`);
		await rpc(port, 'session.create', { sessionId });
		await rpc(port, 'session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: '【种子回合】只回复两个字母 OK。禁止调用任何工具、禁止创建 goal、禁止读写文件。' }] });
		await waitTurnEnd(port, sessionId, 240000, `${leg}-seed`);
		const seedEv = await history(port, sessionId);
		let seedCt = 'unknown';
		try { seedCt = evaluateCompletion(seedEv ?? []).state; } catch { /* shape */ }
		check(cs, 'E2B.0 seed turn clean history (CT-clean precondition)', seedCt === 'clean', `ct=${seedCt} events=${seedEv ? seedEv.length : 'null'}`);
		if (seedCt !== 'clean') { saveEvidence(leg, { leg, stamp: STAMP, sessionId, checks: cs.items, note: 'seed not clean; aborted before injection' }); return cs; }

		// ---- 停机 + 离线注入官方 intent store ----
		const preKillTs = Date.now();
		stopTree(child.pid); child = null;
		await sleep(3000);
		const autonomy = {
			acceptanceCriteria: ['E2B 确定性恢复演练：重启后从 last verified state 续跑，副作用文件恰好一次'],
			criteriaEvidence: [{ index: 0, status: 'PASS', evidenceClass: 'file_hash', evidence: sideEffect, at: Date.now() }],
			verifiedMilestones: [{ at: Date.now(), step: '阶段1种子回合完成：文件已写入并验证', evidenceClass: 'file_hash', evidence: sideEffect }],
			currentStep: '等待重启恢复：从 last verified checkpoint 续跑',
			remainingSteps: ['重启后核对副作用文件恰好一次', '结束回合'],
			lastProgressAt: Date.now(),
			lastVerifiedCheckpoint: CHECKPOINT,
			verificationState: 'VERIFIED',
			lastErrorClass: null,
		};
		const injected = {
			sessionId, goalId: null, state: 'RUNNING', autoResume: true,
			retryCount: 0, fallbackCount: 0, contextRecoveryCount: 0, autoResumeCycles: 0,
			autoResumeBudgetGeneration: null, lastFailure: null, lastFailureAt: null,
			lastActivity: Date.now(), createdAt: Date.now(), resumedAt: null, lastResumeAt: null,
			pendingFallback: null, nextRetryAt: null, schemaVersion: 3, verificationKind: null,
			ctUnresolvedCall: null, goalRoundsObserved: null, serverGenerationSeen: null,
			goalIdObserved: null, goalRevisionObserved: null, goalObservedAt: null,
			livenessUnknownCount: 0, lastEventCountObserved: null, ctTransientDeferCount: 0,
			autonomy,
		};
		const storePath = join(home, 'ec-state', 'execution-intents.json');
		let storeData = existsSync(storePath) ? (readIntents(home) ?? { version: 1, intents: {} }) : { version: 1, intents: {} };
		if (!storeData.intents || typeof storeData.intents !== 'object') storeData.intents = {};
		storeData.version = 1;
		storeData.intents[sessionId] = injected;
		writeFileSync(storePath, JSON.stringify(storeData, null, 2), 'utf8');
		log(`injected RUNNING intent (official store, schema v3 autonomy VERIFIED) -> ${storePath}`);

		// ---- 重启：boot scan 自动 resume（真实产品路径） ----
		child = boot(port, home, join(EVIDENCE_DIR, `instance-E2B-${STAMP}.log`));
		await waitReady(port, `${leg}-p2`);
		log('restarted; waiting for EC boot scan auto-resume');
		const deadline = Date.now() + 180000;
		let resumeEvents = null;
		while (Date.now() < deadline) {
			resumeEvents = await history(port, sessionId);
			if (resumeEvents && JSON.stringify(resumeEvents).includes('Verified progress:')) break;
			await sleep(4000);
		}
		const postText = resumeEvents ? JSON.stringify(resumeEvents) : '';
		check(cs, 'E2B.1 resume message contains "Verified progress:" line', postText.includes('Verified progress:'), '');
		check(cs, 'E2B.2 resume line carries checkpoint text + no-redo directive',
			postText.includes(CHECKPOINT) && postText.includes('Continue from the last verified state') && postText.includes('do not redo verified milestones'), '');
		const post = await waitIntent(home, sessionId, (x) => x && ((x.autoResumeCycles ?? 0) >= 1 && (x.lastResumeAt ?? 0) > preKillTs), 120000, 'resume-ok');
		check(cs, 'E2B.3 recovery actually happened (RESUME-OK this boot)', !!post && (post.autoResumeCycles ?? 0) >= 1 && (post.lastResumeAt ?? 0) > preKillTs, `state=${post?.state} cycles=${post?.autoResumeCycles}`);
		check(cs, 'E2B.4 autonomy block survived restart intact (milestones + criteria + checkpoint)',
			JSON.stringify(post?.autonomy?.verifiedMilestones ?? null) === JSON.stringify(autonomy.verifiedMilestones)
			&& JSON.stringify(post?.autonomy?.acceptanceCriteria ?? null) === JSON.stringify(autonomy.acceptanceCriteria)
			&& post?.autonomy?.lastVerifiedCheckpoint === CHECKPOINT,
			`post=${JSON.stringify({ m: post?.autonomy?.verifiedMilestones?.length, ac: post?.autonomy?.acceptanceCriteria?.length, cp: post?.autonomy?.lastVerifiedCheckpoint })}`);
		const postContent = existsSync(sideEffect) ? readFileSync(sideEffect, 'utf8').trim() : null;
		const postMtime = existsSync(sideEffect) ? statSync(sideEffect).mtimeMs : null;
		check(cs, 'E2B.5 side-effect file exactly-once (content unchanged, mtime unchanged)', postContent === 'side-effect-v1' && postMtime === seedMtime, `content=${postContent} mtimeDelta=${postMtime !== null ? postMtime - seedMtime : 'n/a'}`);
		// EC 诊断行证据（SCAN restart + RESUME-OK）读 EC 自有日志文件
		// （web 模式下服务 stdout 几乎为空，diag 只落 ec-state/execution-continuity.log）
		let ecLines = [];
		try {
			const txt = readFileSync(join(home, 'ec-state', 'execution-continuity.log'), 'utf8');
			ecLines = txt.split(/\r?\n/).filter((l) => /SCAN|RESUME-|CT|WAIT-GATE/i.test(l)).slice(-40);
		} catch { /* log locked */ }
		check(cs, 'E2B.6 EC diag shows SCAN restart + RESUME-OK', ecLines.some((l) => /SCAN restart/.test(l)) && ecLines.some((l) => l.includes(`RESUME-OK sid=${sessionId}`)), ecLines.slice(-6).join(' | ').slice(0, 380));
		const payload = { leg, stamp: STAMP, port, home, sessionId, checks: cs.items,
			injectedAutonomy: autonomy, postAutonomy: post?.autonomy ?? null, postState: post?.state ?? null,
			autoResumeCycles: post?.autoResumeCycles ?? null, lastResumeAt: post?.lastResumeAt ?? null, preKillTs,
			sideEffectContent: postContent, resumeHistoryEventCount: resumeEvents ? resumeEvents.length : 0,
			ecDiagLines: ecLines, seedCt };
		saveEvidence(leg, payload);
	} finally {
		stopTree(child?.pid);
		if (!KEEP) { await sleep(1500); try { rmSync(home, { recursive: true, force: true }); } catch { /* win lock */ } }
	}
	return cs;
}

// ==========================================================================
// LEG E3 —— 完成验证真值（记录的 VERIFIED 必须真实 → 真证据 VERIFIED）
// ==========================================================================
async function legE3() {
	const leg = 'E3';
	log(`=== ${leg}: completion verification truth (recorded PASS must be genuine, then real evidence) ===`);
	const home = buildHome('e3');
	const port = await freePort(PORT_BASE + 2);
	writeManifest(home, port, false);
	copyCredentials(home);
	const sessionId = `p3r1e3-${STAMP}`;
	const proofFile = join(home, 'workdir', 'proof.txt');
	let child = null;
	const cs = mkChecks();
	try {
		child = boot(port, home, join(EVIDENCE_DIR, `instance-E3-${STAMP}.log`));
		await waitReady(port, leg);
		// R1C-2 证据收口（v2，2026-08-30）：真实模型连续两轮拒绝配合"提交注定失败的
		// 伪造证据"对抗式剧本（05:58 R1 伪造 pwsh 输出；06:24 R1C 无视"逐字符提交
		// 000…0"指令、真实创建文件并提交真 hash——宿主复核合法放行）。依赖模型服从性
		// 的注入镜头不可行，阶段 A 改为 model-agnostic 不变量：不向模型索取任何伪造
		// 提交，只验收"被记录的 PASS 必然真实"——每条 PASS 必须 (a) 带 HOST-VERIFIED
		// 前缀（宿主复核确已执行）；(b) 引用的文件真实存在；(c) 重算 sha256 与声称
		// 一致。无论模型交真证据、交假证据或不交，不变量恒可判定；Gate 若退化为信任
		// 模型自述（F1），伪造 PASS 必在 (b)/(c) 上被抓出。"伪造 file_hash 被拒"的
		// deterministic 负向镜头由已部署套件 I10-I13（无模型依赖，CI L2 52/0）承担。
		const objective = '完成验证真值演练：以真实证据达成验收标准，无法达成则如实报告';
		const promptA = [
			'【完成验证演练】',
			'1) 调用 autonomy_report：acceptanceCriteria=[“proof 文件存在且内容为 real-evidence-v1”]，currentStep=“开始验证真值演练”。本回合不要声明 criteriaBindings（目标绑定由第2步统一声明）。',
			'2) 按你的判断完成该验收标准；若无法达成，如实说明。结束时如实报告最终状态，结束回合。',
		].join('\n');
		await runTask(port, sessionId, objective, promptA);
		const histA = await waitTurnEnd(port, sessionId, 420000, `${leg}-a`);
		const itA = await waitIntent(home, sessionId, (x) => Array.isArray(x?.autonomy?.acceptanceCriteria) && x.autonomy.acceptanceCriteria.length >= 1, 30000, 'AC declared');
		const auA = itA?.autonomy ?? null;
		const findings = [];
		// 解析一条被记录的 PASS：宿主复核前缀 + 原始 file:<path>|sha256:<hex> 规范体
		// + 文件存在 + 重算 sha256 与声称一致（宿主复核已做过同样的事，这里独立重算
		// 作为 E2E 层的第二重确定性校验）。
		const parseRecordedPass = (e) => {
			const ev = String(e?.evidence ?? '');
			if (!ev.includes('HOST-VERIFIED')) return { ok: false, why: 'missing HOST-VERIFIED prefix' };
			const body = ev.slice(ev.indexOf('): ') + 3).trim();
			const m = body.match(/^file:(.+)\|sha256:([0-9a-fA-F]{64})/);
			if (!m) return { ok: false, why: `evidence body not file_hash spec: ${body.slice(0, 60)}` };
			const p = m[1].trim();
			const claimed = m[2].toLowerCase();
			if (!existsSync(p)) return { ok: false, why: `referenced file missing: ${p}` };
			const actual = createHash('sha256').update(readFileSync(p)).digest('hex');
			if (actual !== claimed) return { ok: false, why: `sha256 mismatch for ${p}` };
			return { ok: true, path: p, sha256: actual };
		};
		const passEntriesA = (auA?.criteriaEvidence ?? []).filter((e) => e?.status === 'PASS');
		const genuineA = passEntriesA.map(parseRecordedPass);
		const stateA = auA?.verificationState ?? null;
		const criteriaCoveredA = (auA?.acceptanceCriteria ?? []).every((_, i) =>
			(auA?.criteriaEvidence ?? []).some((e) => e?.status === 'PASS' && (e?.index ?? -1) === i));
		check(cs, 'E3.1 AC declared', Array.isArray(auA?.acceptanceCriteria) && auA.acceptanceCriteria.length === 1, JSON.stringify(auA?.acceptanceCriteria ?? null).slice(0, 120));
		check(cs, 'E3.2 every recorded PASS is host-verified genuine (prefix + file exists + sha256 recompute match)',
			genuineA.every((r) => r.ok),
			genuineA.length === 0 ? 'no PASS entries (honest no-work turn)' : JSON.stringify(genuineA).slice(0, 200));
		check(cs, 'E3.3 verificationState consistent with PASS coverage (VERIFIED ⇔ all criteria PASS-covered; PASS ⇒ checkpoint)',
			(stateA === 'VERIFIED') === criteriaCoveredA && (passEntriesA.length > 0 ? !!auA?.lastVerifiedCheckpoint : true),
			`state=${stateA} pass=${passEntriesA.length} covered=${criteriaCoveredA} checkpoint=${auA?.lastVerifiedCheckpoint ? 'present' : 'absent'}`);
		const verifyCalledA = JSON.stringify(histA ?? []).includes('autonomy_verify');
		const refusedRecordedA = (auA?.criteriaEvidence ?? []).some((e) => e?.status === 'UNVERIFIED' && String(e?.evidence ?? '').includes('HOST-VERIFY FAILED'));
		check(cs, 'E3.4 verify attempts without PASS recorded as UNVERIFIED refusal (branch observation)',
			!verifyCalledA || passEntriesA.length > 0 || refusedRecordedA,
			`verifyCalled=${verifyCalledA} refusedRecorded=${refusedRecordedA} pass=${passEntriesA.length}`);
		findings.push('R1C-2 evidence closure v2: phase-A asserts the model-agnostic invariant "every recorded PASS is host-verified genuine" (HOST-VERIFIED prefix + referenced file exists + sha256 recompute match) instead of relying on model obedience to an adversarial fabricated-evidence script (the real model refused that script twice: fake pwsh output in R1, honest real-file submission in R1C attempt 1). Deterministic fabricated-evidence refusal is covered by deployed suite I10-I13 (model-independent, CI L2). F1 (R1 finding) closed by host-side deterministic verification in PR #76.');
		if (!genuineA.every((r) => r.ok) || (stateA === 'VERIFIED') !== criteriaCoveredA) {
			findings.push(`E3-A REGRESSION: recorded PASS not genuine or state inconsistent (pass=${passEntriesA.length}, state=${stateA}) — fail-closed invariant violated`);
			log('[E3-A REGRESSION] ' + findings[findings.length - 1]);
		}

		const promptB = [
			'【完成验证演练·第2步】现在真正完成任务：',
			`1) 先调用 autonomy_state 查看 criterion 0 的绑定：若 criteriaBindings 中 index=0 已绑定文件路径 P（该文件可能尚不存在），用文件写入工具创建 P，内容恰为 real-evidence-v1；若尚未绑定，则先调用 autonomy_report：criteriaBindings=[{"kind":"file","index":0,"path":"${proofFile}"}]，再用文件写入工具创建 ${proofFile}，内容恰为 real-evidence-v1。`,
			'2) 计算该文件的真实 sha256（64 位 hex），然后调用 autonomy_verify：criterionIndex=0，status="PASS"，evidenceClass="file_hash"，evidence 参数使用规范格式：file:<该文件绝对路径>|sha256:<真实sha256hex>|real evidence（hash 必须真实计算，不得编造；路径必须与 criterion 0 绑定的文件一致）。',
			'3) 结束回合。',
		].join('\n');
		await rpc(port, 'session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: promptB }] });
		await waitTurnEnd(port, sessionId, 420000, `${leg}-b`);
		const itB = await waitIntent(home, sessionId, (x) => x?.autonomy?.verificationState === 'VERIFIED', 60000, 'VERIFIED');
		const auB = itB?.autonomy ?? null;
		const boundPathA = (auA?.criteriaBindings ?? []).find((b) => b?.index === 0 && b?.kind === 'file')?.path ?? null;
		const proofOk = (p) => !!p && existsSync(p) && readFileSync(p, 'utf8').trim() === 'real-evidence-v1';
		const proofPath = proofOk(proofFile) ? proofFile : (proofOk(boundPathA) ? boundPathA : null);
		const proofHash = proofPath ? createHash('sha256').update(readFileSync(proofPath)).digest('hex') : null;
		const passEntriesB = (auB?.criteriaEvidence ?? []).filter((e) => e?.status === 'PASS');
		const genuineB = passEntriesB.map(parseRecordedPass);
		check(cs, 'E3.5 proof file created with real content (declared path or bound path)', proofPath !== null, `proofPath=${proofPath ?? 'missing'}`);
		check(cs, 'E3.6 real evidence -> same AC derives VERIFIED', auB?.verificationState === 'VERIFIED', `state=${auB?.verificationState}`);
		check(cs, 'E3.7 milestone appended with real evidence', (auB?.verifiedMilestones?.length ?? 0) >= 1, JSON.stringify(auB?.verifiedMilestones ?? null).slice(0, 160));
		check(cs, 'E3.8 recorded PASS recompute equals workdir proof sha256', genuineB.length > 0 && genuineB.every((r) => r.ok) && genuineB.some((r) => r.sha256 === proofHash), `proofSha256=${proofHash} recorded=${JSON.stringify(genuineB).slice(0, 200)}`);
		const payload = { leg, stamp: STAMP, port, home, sessionId, checks: cs.items,
			autonomyAfterClaimTurn: auA, autonomyAfterRealEvidence: auB, findings };
		saveEvidence(leg, payload);
	} finally {
		stopTree(child?.pid);
		if (!KEEP) { await sleep(1500); try { rmSync(home, { recursive: true, force: true }); } catch { /* win lock */ } }
	}
	return cs;
}

// ==========================================================================
// main
// ==========================================================================
async function main() {
	// 生产 loaded-release.json 快照（隔离 boot 会覆写该全局诊断文件）
	let loadedReleaseBackup = null;
	try {
		if (existsSync(LOADED_RELEASE)) loadedReleaseBackup = readFileSync(LOADED_RELEASE, 'utf8');
	} catch { /* ignore */ }

	const results = {};
	let failed = false;
	for (const leg of LEGS) {
		try {
			const cs = leg === 'E1' ? await legE1() : leg === 'E2' ? await legE2() : leg === 'E2B' ? await legE2B() : await legE3();
			results[leg] = { pass: cs.pass, fail: cs.fail };
			if (cs.fail > 0) failed = true;
		} catch (e) {
			log(`${leg} CRASH: ${e.message}`);
			results[leg] = { crash: e.message };
			failed = true;
		}
	}

	// 恢复生产 loaded-release.json
	try {
		if (loadedReleaseBackup !== null) {
			writeFileSync(LOADED_RELEASE, loadedReleaseBackup, 'utf8');
			log('restored production loaded-release.json');
		}
	} catch { /* ignore */ }

	log('RESULT: ' + JSON.stringify(results));
	console.log(failed ? 'P3R1 REAL E2E FAIL' : 'P3R1 REAL E2E ALL PASS');
	process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[p3r1-e2e] fatal:', e); process.exit(1); });
