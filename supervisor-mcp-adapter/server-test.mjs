// supervisor-mcp-adapter/server-test.mjs
// 自测：in-process mock bridge + MCP 协议全链路（9 工具 + 鉴权 + 错误映射）。
// 运行：node server-test.mjs
// 退出码 0 = 全部 PASS；任何 FAIL 退出码 1。

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

let passCount = 0, failCount = 0;
function ok(cond, label, extra = '') {
	if (cond) { passCount += 1; console.log(`  PASS ${label}`); }
	else { failCount += 1; console.log(`  FAIL ${label} ${extra}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// mock bridge（模拟 supervisor-bridge v0.2.2 的 9 端点）
// ---------------------------------------------------------------------------

const mockCalls = []; // { path, auth, body }
const TOKEN = 'mock-bridge-token-0123456789abcdef0123456789abcdef';
const SESSION = 'session-11111111-2222-3333-4444-555555555555';

function mockBridge() {
	const server = createServer((req, res) => {
		let raw = '';
		req.on('data', (c) => { raw += c; });
		req.on('end', () => {
			const auth = String(req.headers.authorization ?? '');
			mockCalls.push({ path: req.url, auth, method: req.method, body: raw ? JSON.parse(raw) : null });
			if (auth !== `Bearer ${TOKEN}`) {
				res.writeHead(401, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
				return;
			}
			const reply = (obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
			if (req.url === '/supervisor/health') return reply({ ok: true, plugin: 'supervisor-bridge', version: '0.2.2-mock' });
			if (req.url === '/supervisor/get_state') return reply({ ok: true, sessions: [{ sessionId: SESSION }], ledger: { state: 'ACTIVE', receipts: 1 } });
			if (req.url === '/supervisor/get_goal') return reply({ ok: true, sessionId: SESSION, goal: { objective: 'demo' }, supervisor: { generation: 2, controlState: 'DISPATCHED' } });
			if (req.url === '/supervisor/get_evidence') return reply({ ok: true, sessionId: SESSION, events: [], evidenceId: 'ev-mock-001' });
			if (req.url === '/supervisor/get_snapshot') return reply({ ok: true, receipts: 1, sessions: 1 });
			if (req.url === '/supervisor/dispatch_goal') return reply({ ok: true, dispatched: true, duplicate: false, supervisorGoalId: 'sg-mock-0001', generation: 1, session: { sessionId: SESSION, running: true } });
			if (req.url === '/supervisor/send_correction') return reply({ ok: true, accepted: true, commandId: 'chatgpt:g2:CORRECTION:1', generation: 2, correctionsLeft: 2 });
			if (req.url === '/supervisor/cancel_goal') return reply({ ok: true, cancelled: true, action: 'pause' });
			if (req.url === '/supervisor/review_goal') return reply({ ok: true, reviewed: true, verdict: 'PASS' });
			reply({ ok: false, error: 'mock_no_route' }, 404);
		});
	});
	return server;
}

// ---------------------------------------------------------------------------
// MCP 客户端助手
// ---------------------------------------------------------------------------

function mcpPost(base, payload, extraHeaders = {}) {
	return fetch(`${base}/mcp`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extraHeaders },
		body: JSON.stringify(payload),
	});
}
async function mcpCall(base, name, args) {
	const res = await mcpPost(base, { jsonrpc: '2.0', id: `t-${Math.random().toString(36).slice(2)}`, method: 'tools/call', params: { name, arguments: args } });
	return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
	const bridge = mockBridge();
	await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
	const bridgePort = bridge.address().port;
	const BRIDGE_BASE = `http://127.0.0.1:${bridgePort}`;

	process.env.PORT = '0';
	process.env.HOST = '127.0.0.1';
	process.env.BRIDGE_BASE = BRIDGE_BASE;
	process.env.MCP_REQUIRE_AUTH = '0';
	process.env.BRIDGE_TOKEN = TOKEN; // adapter → mock bridge 的上游鉴权（与入口鉴权分离）

	const { httpServer, TOOLS } = await import('./server.mjs');
	await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
	const port = httpServer.address().port;
	const BASE = `http://127.0.0.1:${port}`;
	console.log(`mock bridge :${bridgePort}  adapter :${port}`);

	// --- 1. initialize / initialized ---
	let res = await mcpPost(BASE, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
	let body = await res.json();
	ok(res.status === 200 && body.result?.protocolVersion === '2025-06-18', 'initialize → 2025-06-18');
	ok(body.result?.serverInfo?.name === 'dsh-supervisor-bridge', 'serverInfo.name');
	ok(typeof body.result?.instructions === 'string' && body.result.instructions.length > 20, 'instructions present');

	res = await mcpPost(BASE, { jsonrpc: '2.0', method: 'notifications/initialized' });
	ok(res.status === 202, 'notifications/initialized → 202');

	// --- 2. tools/list ---
	res = await mcpPost(BASE, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
	body = await res.json();
	const tools = body.result?.tools ?? [];
	const names = tools.map((t) => t.name);
	ok(names.length === 9, `tools/list → 9 tools (got ${names.length})`, JSON.stringify(names));
	ok(JSON.stringify(names.sort()) === JSON.stringify(['supervisor_cancel_goal', 'supervisor_dispatch_goal', 'supervisor_get_evidence', 'supervisor_get_goal', 'supervisor_get_snapshot', 'supervisor_get_state', 'supervisor_health', 'supervisor_review_goal', 'supervisor_send_correction']), 'tool name set matches bridge 1:1');
	const readOnlyCount = tools.filter((t) => t.annotations?.readOnlyHint === true).length;
	ok(readOnlyCount === 5, `5 read-only hints (got ${readOnlyCount})`);
	ok(tools.every((t) => t.inputSchema?.type === 'object'), 'all inputSchema type=object');

	// --- 3. READ 工具 5 个 ---
	let r = await mcpCall(BASE, 'supervisor_health', {});
	ok(r.body.result?.isError === false && r.body.result?.structuredContent?.version === '0.2.2-mock', 'supervisor_health passthrough', JSON.stringify(r.body).slice(0, 200));
	ok(mockCalls.at(-1).auth === `Bearer ${TOKEN}`, 'bridge Authorization header forwarded');

	r = await mcpCall(BASE, 'supervisor_get_state', {});
	ok(r.body.result?.structuredContent?.ok === true && Array.isArray(r.body.result.structuredContent.sessions), 'supervisor_get_state');

	r = await mcpCall(BASE, 'supervisor_get_goal', { session_id: SESSION });
	ok(r.body.result?.structuredContent?.supervisor?.generation === 2, 'supervisor_get_goal');
	ok(mockCalls.at(-1).body?.sessionId === SESSION, 'get_goal snake→camel sessionId');

	r = await mcpCall(BASE, 'supervisor_get_evidence', { session_id: SESSION, max_messages: 7 });
	ok(mockCalls.at(-1).body?.maxMessages === 7, 'get_evidence max_messages→maxMessages=7');

	r = await mcpCall(BASE, 'supervisor_get_snapshot', {});
	ok(r.body.result?.structuredContent?.receipts === 1, 'supervisor_get_snapshot');

	// --- 4. MUTATION 工具 4 个 ---
	r = await mcpCall(BASE, 'supervisor_dispatch_goal', { idempotency_key: 'chatgpt-e2e-0001', objective: 'test objective text', max_goal_rounds: 3, acceptance_criteria: ['build passes', 'tests green'] });
	const dBody = mockCalls.at(-1).body;
	ok(r.body.result?.isError === false && r.body.result?.structuredContent?.dispatched === true, 'supervisor_dispatch_goal happy path');
	ok(dBody?.idempotencyKey === 'chatgpt-e2e-0001' && dBody?.objective === 'test objective text' && dBody?.maxGoalRounds === 3 && JSON.stringify(dBody?.acceptanceCriteria) === JSON.stringify(['build passes', 'tests green']), 'dispatch snake→camel mapping', JSON.stringify(dBody));

	r = await mcpCall(BASE, 'supervisor_send_correction', { session_id: SESSION, command_id: 'chatgpt:g2:CORRECTION:1', generation: 2, text: ' focus on tests', mode: 'steer' });
	const cBody = mockCalls.at(-1).body;
	ok(r.body.result?.structuredContent?.accepted === true, 'supervisor_send_correction happy path');
	ok(cBody?.commandId === 'chatgpt:g2:CORRECTION:1' && cBody?.generation === 2 && cBody?.text === ' focus on tests' && cBody?.sessionId === SESSION && cBody?.mode === 'steer', 'correction mapping (pure passthrough, bridge trims)', JSON.stringify(cBody));

	r = await mcpCall(BASE, 'supervisor_cancel_goal', { session_id: SESSION, command_id: 'chatgpt:g2:CANCEL:2', generation: 2 });
	ok(mockCalls.at(-1).body?.commandId === 'chatgpt:g2:CANCEL:2' && mockCalls.at(-1).body?.action === undefined, 'cancel omits unset action (bridge defaults to pause)');
	ok(r.body.result?.structuredContent?.cancelled === true, 'supervisor_cancel_goal happy path');

	r = await mcpCall(BASE, 'supervisor_review_goal', { session_id: SESSION, command_id: 'chatgpt:g2:REVIEW:1', generation: 2, verdict: 'PASS', criteria_results: [{ criterion: 'build passes', result: 'pass' }], evidence_id: 'ev-mock-001' });
	const rvBody = mockCalls.at(-1).body;
	ok(r.body.result?.structuredContent?.reviewed === true, 'supervisor_review_goal happy path');
	ok(rvBody?.verdict === 'PASS' && rvBody?.evidenceId === 'ev-mock-001' && rvBody?.criteriaResults?.[0]?.result === 'pass', 'review mapping', JSON.stringify(rvBody));

	// --- 5. 错误映射 ---
	r = await mcpCall(BASE, 'supervisor_get_goal', { session_id: 'session-deadbeef-2222-3333-4444-555555555555' });
	// mock: 该路径会正常返回；改为显式触发 bridge 4xx → 用不存在的路由模拟
	res = await mcpPost(BASE, { jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'supervisor_nonexistent', arguments: {} } });
	body = await res.json();
	ok(body.error?.code === -32602 && Array.isArray(body.error?.data?.available) && body.error.data.available.length === 9, 'unknown tool → -32602 + available list');

	// bridge 4xx 透传为 isError（借 mock 401 分支：错误 token 无法从 adapter 触发；
	// 直接用 mock 的 404 路由：get_goal 传非法 session_id 仍会打到 mock —— 改测 bridge 关停场景）
	bridge.closeAllConnections?.();
	await new Promise((r) => bridge.close(r));
	await sleep(120);
	r = await mcpCall(BASE, 'supervisor_get_state', {});
	ok(r.body.result?.isError === true && r.body.result?.structuredContent?.error === 'bridge_unreachable', 'bridge down → isError + bridge_unreachable', JSON.stringify(r.body).slice(0, 200));

	// --- 6. 协议杂项 ---
	res = await fetch(`${BASE}/mcp`);
	ok(res.status === 405, 'GET /mcp → 405');
	res = await fetch(`${BASE}/healthz`);
	body = await res.json();
	ok(res.status === 200 && body.tools === 9 && body.bridge === 'unreachable', 'healthz: tools=9 + bridge down reported');
	res = await mcpPost(BASE, { jsonrpc: '2.0', id: 3, method: 'resources/list' });
	body = await res.json();
	ok(Array.isArray(body.result?.resources) && body.result.resources.length === 0, 'resources/list → empty (tools-only server)');

	await new Promise((r) => httpServer.close(r));
	httpServer.closeAllConnections?.();

	// --- 7. 鉴权（独立子进程：REQUIRE_AUTH=1 + 显式 token） ---
	const authPort = 8092;
	const child = spawn(process.execPath, [join(HERE, 'server.mjs')], {
		env: { ...process.env, PORT: String(authPort), HOST: '127.0.0.1', BRIDGE_BASE, MCP_REQUIRE_AUTH: '1', MCP_TOKEN: 'a'.repeat(64) },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let childLogs = '';
	child.stdout.on('data', (d) => { childLogs += d; });
	child.stderr.on('data', (d) => { childLogs += d; });
	await sleep(700);
	const ABASE = `http://127.0.0.1:${authPort}`;
	res = await mcpPost(ABASE, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
	ok(res.status === 401, 'no auth → 401');
	res = await mcpPost(ABASE, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }, { Authorization: 'Bearer wrong-token-wrong-token-wrong-token-wrongtoken' });
	ok(res.status === 401, 'wrong bearer → 401');
	res = await mcpPost(ABASE, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }, { Authorization: `Bearer ${'a'.repeat(64)}` });
	body = await res.json();
	ok(res.status === 200 && body.result?.protocolVersion === '2025-06-18', 'correct bearer → initialize 200');
	child.kill();
	await Promise.race([once(child, 'exit'), sleep(3000)]);
	child.kill('SIGKILL');

	console.log(`\n== RESULT: ${passCount} PASS, ${failCount} FAIL ==`);
	process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
