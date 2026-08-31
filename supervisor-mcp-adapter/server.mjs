#!/usr/bin/env node
// supervisor-mcp-adapter/server.mjs
//
// P2.75 TX-B —— ChatGPT Client Binding：thin MCP adapter（零依赖，Node >= 18）。
//
// 定位：把 DSH supervisor-bridge（v0.2.2，http://127.0.0.1:3080/supervisor/*，Bearer 鉴权）
// 以 1:1 语义暴露为 MCP（Model Context Protocol）server，供 ChatGPT Custom MCP App 扫描
// 与调用 9 个 supervisor 工具（5 READ + 4 MUTATION）。
//
// 设计铁律（与 P2.75 评审结论一致）：
//   - 纯适配层：不做业务校验的"第二实现"——入参校验权威在 supervisor-bridge-core；
//     adapter 只做 JSON 形状映射（snake_case → bridge camelCase）与错误透传。
//   - 零副作用重放靠 bridge 的 idempotencyKey/commandId 幂等（R1/R1.1/R1.2 已封板），
//     adapter 不缓存任何 mutation 状态（stateless）。
//   - 不落盘、不打印任何 token；日志只含方法/工具名与状态码。
//
// 传输：MCP "Streamable HTTP"（protocolVersion 2025-06-18），POST /mcp 单条 JSON-RPC，
// 以 application/json 回应（不支持 server-initiated SSE → GET /mcp 405）。
//
// 启动：node server.mjs
//   PORT=8091 HOST=127.0.0.1 BRIDGE_BASE=http://127.0.0.1:3080
//   MCP_REQUIRE_AUTH=1（默认开）
//   入口 token（ChatGPT → adapter）：MCP_TOKEN=<显式>（优先）或 MCP_TOKEN_FILE（默认
//     ~/.dsh/supervisor-mcp/token，独立于 bridge token；启动时缺失则自动生成 64-hex 并写盘）
//   上游 token（adapter → bridge）：BRIDGE_TOKEN=<显式>（优先）或 BRIDGE_TOKEN_FILE
//     （默认 ~/.dsh/supervisor-bridge/token）——与入口 token 分离，不得复用同一文件

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const ADAPTER_VERSION = '0.3.0';
const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'dsh-supervisor-bridge';

const PORT = Number(process.env.PORT || 8091);
const HOST = process.env.HOST || '127.0.0.1';
const BRIDGE_BASE = (process.env.BRIDGE_BASE || 'http://127.0.0.1:3080').replace(/\/+$/, '');
// 入口 token 与上游 token 的存放文件分离（BLOCKER B，R1.1）：
//   入口（ChatGPT→adapter）默认 ~/.dsh/supervisor-mcp/token
//   上游（adapter→bridge）默认 ~/.dsh/supervisor-bridge/token
// 两者默认不再指向同一文件；MCP_TOKEN/MCP_TOKEN_FILE 只控制入口，BRIDGE_TOKEN/BRIDGE_TOKEN_FILE 只控制上游。
const TOKEN_FILE = process.env.MCP_TOKEN_FILE || join(homedir(), '.dsh', 'supervisor-mcp', 'token');
const BRIDGE_TOKEN_FILE = process.env.BRIDGE_TOKEN_FILE || join(homedir(), '.dsh', 'supervisor-bridge', 'token');
const REQUIRE_AUTH = process.env.MCP_REQUIRE_AUTH !== '0';
// P2.8：Widget 只读通道——独立 WATCHDOG token（默认 ~/.dsh/watchdog/token，与入口/上游 token 三分离）。
// 该 token 由宿主 watchdog 插件首次启动时生成；adapter 只读同文件做入口鉴权，并原样透传给 3080。
const WATCHDOG_TOKEN_FILE = process.env.WATCHDOG_TOKEN_FILE || join(homedir(), '.dsh', 'watchdog', 'token');
const WATCHDOG_REQUIRE_AUTH = process.env.WATCHDOG_REQUIRE_AUTH !== '0';

// 两个 token 职责分离（不得混用）：
//   bridgeToken   —— adapter → supervisor-bridge 的上游鉴权（BRIDGE_TOKEN / BRIDGE_TOKEN_FILE）
//   adapterToken  —— ChatGPT → adapter 的入口鉴权（MCP_TOKEN / MCP_TOKEN_FILE，REQUIRE_AUTH=1 时必需）
function bridgeToken() {
	const explicit = process.env.BRIDGE_TOKEN;
	if (typeof explicit === 'string' && explicit.trim().length >= 32) return explicit.trim();
	try {
		const raw = readFileSync(BRIDGE_TOKEN_FILE, 'utf8').trim();
		if (raw.length >= 32) return raw;
		console.error(`[adapter] bridge token file too short (${raw.length} bytes at ${BRIDGE_TOKEN_FILE})`);
		return null;
	} catch (e) {
		console.error(`[adapter] bridge token file unreadable: ${BRIDGE_TOKEN_FILE} (${e.code ?? e.message})`);
		return null;
	}
}
// 入口 token 缺失时自动生成（64 hex，>=32B），确保 MCP_REQUIRE_AUTH=1 默认可用且不依赖 bridge token 文件。
// entropy source = crypto.randomBytes（CSPRNG，R1.2 Blocker A）；哈希混合不能把可预测源（时间/PID 等）变成密码学安全随机数，
// 故 token 熵只允许来自 CSPRNG。exclusive-create（'wx'）+ 0600 语义保持不变。
function ensureAdapterToken() {
	const explicit = process.env.MCP_TOKEN;
	if (typeof explicit === 'string' && explicit.trim().length >= 32) return explicit.trim();
	try {
		const raw = readFileSync(TOKEN_FILE, 'utf8').trim();
		if (raw.length >= 32) return raw;
	} catch { /* missing → generate below */ }
	try {
		const generated = randomBytes(32).toString('hex');
		mkdirSync(dirname(TOKEN_FILE), { recursive: true });
		writeFileSync(TOKEN_FILE, generated + '\n', { mode: 0o600, flag: 'wx' });
		console.error(`[adapter] generated adapter token at ${TOKEN_FILE} (0600, not in git)`);
		return generated;
	} catch (e) {
		console.error(`[adapter] failed to persist adapter token: ${String(e?.message ?? e)}`);
		return null;
	}
}
const ADAPTER_TOKEN = REQUIRE_AUTH ? ensureAdapterToken() : null;
if (REQUIRE_AUTH && !ADAPTER_TOKEN) {
	console.error('[adapter] MCP_REQUIRE_AUTH=1 but no adapter token (MCP_TOKEN / MCP_TOKEN_FILE) — refusing to start');
	process.exit(1);
}

function checkAuth(header) {
	if (!REQUIRE_AUTH) return true;
	if (typeof ADAPTER_TOKEN !== 'string') return false;
	const m = /^Bearer\s+(.+)$/.exec(String(header ?? '').trim());
	if (!m) return false;
	const given = Buffer.from(m[1], 'utf8');
	const want = Buffer.from(ADAPTER_TOKEN, 'utf8');
	if (given.length !== want.length) {
		timingSafeEqual(given.subarray(0, 1), want.subarray(0, 1)); // 平滑时序
		return false;
	}
	return timingSafeEqual(given, want);
}

// ---------------------------------------------------------------------------
// 9 工具定义（与 supervisor-bridge.mjs 路由 1:1；schema 反映 core 校验器形状）
// ---------------------------------------------------------------------------

const SESSION_ID_PATTERN = '^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const KEY_PATTERN = '^[A-Za-z0-9_-]{8,128}$';
const SG_ID_PATTERN = '^sg-[A-Za-z0-9_-]{4,120}$';
const COMMAND_BASE = '^(owner label, 1-100 chars of [A-Za-z0-9_-]):g(1-999999999):';

const targetProps = {
	session_id: { type: 'string', pattern: SESSION_ID_PATTERN, description: 'Target harness session id (session-xxxxxxxx-…). Provide session_id OR supervisor_goal_id.' },
	supervisor_goal_id: { type: 'string', pattern: SG_ID_PATTERN, description: 'Target supervisor goal id (sg-…). Provide session_id OR supervisor_goal_id.' },
};

function commandIdProp(kind) {
	return {
		command_id: {
			type: 'string',
			pattern: `^[A-Za-z0-9_-]{1,100}:g[0-9]{1,9}:${kind}:[0-9]{1,9}$`,
			description: `Idempotency command id, format <owner>:g<generation>:${kind}:<seq>. The embedded generation MUST equal the generation parameter. Reusing the same command_id replays the recorded outcome with zero side effects.`,
		},
	};
}
const generationProp = { generation: { type: 'integer', minimum: 1, maximum: 999999999, description: 'Supervisor generation this command belongs to; MUST match the generation embedded in command_id. Get the current generation from supervisor_get_goal / get_state first.' } };

const TOOLS = [
	{
		name: 'supervisor_health',
		title: 'Supervisor bridge health',
		description: 'Read-only. Liveness + identity of the DSH supervisor bridge (plugin version, sha256 identity, ledger state). Use first to verify the control plane is reachable.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { readOnlyHint: true },
		bridge: { path: '/supervisor/health', method: 'GET' },
	},
	{
		name: 'supervisor_get_state',
		title: 'List harness sessions',
		description: 'Read-only. List all harness sessions with sanitized state + per-session goal projection summary + ledger state. Use to discover session_id values before deeper reads.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { readOnlyHint: true },
		bridge: { path: '/supervisor/get_state', method: 'POST' },
	},
	{
		name: 'supervisor_get_goal',
		title: 'Get goal projection',
		description: 'Read-only. Full goal projection for one session (objective, revision, status, current generation) plus supervisor control state when a receipt exists. Call before any mutation to learn generation.',
		inputSchema: { type: 'object', properties: { session_id: { type: 'string', pattern: SESSION_ID_PATTERN, description: 'Harness session id (session-…).' } }, required: ['session_id'], additionalProperties: false },
		annotations: { readOnlyHint: true },
		bridge: { path: '/supervisor/get_goal', method: 'POST', map: (p) => ({ sessionId: p.session_id }) },
	},
	{
		name: 'supervisor_get_evidence',
		title: 'Get evidence bundle',
		description: 'Read-only. Sanitized recent session history + evidence bundle (evidenceId, criteria) for review decisions. Returns up to max_messages events (default 50, max 200).',
		inputSchema: { type: 'object', properties: { session_id: { type: 'string', pattern: SESSION_ID_PATTERN, description: 'Harness session id (session-…).' }, max_messages: { type: 'integer', minimum: 1, maximum: 200, description: 'Max recent messages to include (default 50).' } }, required: ['session_id'], additionalProperties: false },
		annotations: { readOnlyHint: true },
		bridge: { path: '/supervisor/get_evidence', method: 'POST', map: (p) => ({ sessionId: p.session_id, maxMessages: p.max_messages }) },
	},
	{
		name: 'supervisor_get_snapshot',
		title: 'Get metadata-only snapshot',
		description: 'Read-only. Metadata-only snapshot of all receipts/sessions (no raw text) — cheap overview for the control loop.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { readOnlyHint: true },
		bridge: { path: '/supervisor/get_snapshot', method: 'POST' },
	},
	{
		name: 'supervisor_dispatch_goal',
		title: 'Dispatch a supervised goal',
		description: 'MUTATION (idempotent). Create a harness session and dispatch a goal under supervision. idempotency_key MUST be stable per logical dispatch (8-128 chars [A-Za-z0-9_-]); replaying the same key with the same payload returns the original receipt with zero side effects; a DIFFERENT payload under the same key is rejected (409 idempotency_conflict). acceptance_criteria: 1-12 strings, each <=500 chars.',
		inputSchema: {
			type: 'object',
			properties: {
				idempotency_key: { type: 'string', pattern: KEY_PATTERN, description: 'Stable idempotency key for this logical dispatch ([A-Za-z0-9_-]{8,128}).' },
				objective: { type: 'string', minLength: 4, maxLength: 8000, description: 'Goal objective, 4-8000 chars.' },
				initial_instruction: { type: 'string', maxLength: 8000, description: 'Optional first instruction injected into the new session.' },
				max_goal_rounds: { type: 'integer', minimum: 1, maximum: 64, description: 'Optional max automatic goal rounds (default per harness config).' },
				supervisor_goal_id: { type: 'string', pattern: SG_ID_PATTERN, description: 'Optional explicit supervisor goal id (sg-…); defaults to a deterministic id derived from idempotency_key.' },
				acceptance_criteria: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 500 }, description: 'Optional 1-12 acceptance criteria strings used later by supervisor_review_goal.' },
			},
			required: ['idempotency_key', 'objective'],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, idempotentHint: true },
		bridge: {
			path: '/supervisor/dispatch_goal',
			method: 'POST',
			map: (p) => ({
				idempotencyKey: p.idempotency_key,
				objective: p.objective,
				initialInstruction: p.initial_instruction,
				maxGoalRounds: p.max_goal_rounds,
				supervisorGoalId: p.supervisor_goal_id,
				acceptanceCriteria: p.acceptance_criteria,
			}),
			timeoutMs: 120000,
		},
	},
	{
		name: 'supervisor_send_correction',
		title: 'Send correction to a goal',
		description: 'MUTATION (idempotent per command_id). Send a steering correction (mode "steer" applies to the running session; "queue" stores it) to a supervised goal, up to the per-goal correction limit (409 corrections_exhausted when used up). command_id format <owner>:g<gen>:CORRECTION:<seq>; generation must match get_goal.',
		inputSchema: {
			type: 'object',
			properties: { ...targetProps, ...commandIdProp('CORRECTION'), ...generationProp, text: { type: 'string', minLength: 1, maxLength: 8000, description: 'Correction text.' }, mode: { type: 'string', enum: ['steer', 'queue'], description: 'steer = steer now (default); queue = queue for next round.' } },
			required: ['command_id', 'generation', 'text'],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, idempotentHint: true },
		bridge: { path: '/supervisor/send_correction', method: 'POST', map: (p) => ({ sessionId: p.session_id, supervisorGoalId: p.supervisor_goal_id, commandId: p.command_id, generation: p.generation, text: p.text, mode: p.mode }) },
	},
	{
		name: 'supervisor_cancel_goal',
		title: 'Cancel / pause / complete a goal',
		description: 'MUTATION (idempotent per command_id). Control action on a supervised goal: action "pause" (default), "complete" (mark complete), or "clear" (clear receipt). command_id format <owner>:g<gen>:CANCEL:<seq>.',
		inputSchema: {
			type: 'object',
			properties: { ...targetProps, ...commandIdProp('CANCEL'), ...generationProp, action: { type: 'string', enum: ['pause', 'complete', 'clear'], description: 'Control action (default pause).' } },
			required: ['command_id', 'generation'],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		bridge: { path: '/supervisor/cancel_goal', method: 'POST', map: (p) => ({ sessionId: p.session_id, supervisorGoalId: p.supervisor_goal_id, commandId: p.command_id, generation: p.generation, action: p.action }) },
	},
	{
		name: 'supervisor_review_goal',
		title: 'Review (approve/reject) a goal',
		description: 'MUTATION (idempotent per command_id). Record supervisor verdict PASS or FAIL for a goal in AWAITING_REVIEW state (409 invalid_control_state otherwise). criteria_results: [{criterion, result: pass|fail|unknown}] matching acceptance criteria; evidence_id should be the evidenceId observed via supervisor_get_evidence. command_id format <owner>:g<gen>:REVIEW:<seq>.',
		inputSchema: {
			type: 'object',
			properties: {
				...targetProps,
				...commandIdProp('REVIEW'),
				...generationProp,
				verdict: { type: 'string', enum: ['PASS', 'FAIL'], description: 'Review verdict.' },
				criteria_results: { type: 'array', maxItems: 12, items: { type: 'object', properties: { criterion: { type: 'string', maxLength: 500 }, result: { type: 'string', enum: ['pass', 'fail', 'unknown'] } }, required: ['criterion', 'result'], additionalProperties: false }, description: 'Optional per-criterion results.' },
				evidence_id: { type: 'string', pattern: '^ev-[A-Za-z0-9_.:-]{1,190}$', description: 'Optional evidenceId this verdict is based on.' },
			},
			required: ['command_id', 'generation', 'verdict'],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, idempotentHint: true },
		bridge: { path: '/supervisor/review_goal', method: 'POST', map: (p) => ({ sessionId: p.session_id, supervisorGoalId: p.supervisor_goal_id, commandId: p.command_id, generation: p.generation, verdict: p.verdict, criteriaResults: p.criteria_results, evidenceId: p.evidence_id }) },
	},
];

// ---------------------------------------------------------------------------
// Bridge 转发
// ---------------------------------------------------------------------------

async function callBridge(tool, params) {
	const spec = tool.bridge;
	const url = `${BRIDGE_BASE}${spec.path}`;
	const token = bridgeToken();
	const headers = { Authorization: `Bearer ${token}` };
	let body;
	if (spec.method === 'GET') {
		// GET 健康检查也带 Authorization（bridge 对 GET /supervisor/health 同样校验）
	} else {
		headers['Content-Type'] = 'application/json';
		body = JSON.stringify(spec.map ? spec.map(params ?? {}) : {});
	}
	const ctrl = AbortSignal.timeout(spec.timeoutMs ?? 30000);
	const res = await fetch(url, { method: spec.method, headers, body, signal: ctrl });
	let json = null;
	try { json = await res.json(); } catch { /* 非 JSON 响应 → 走通用错误 */ }
	if (!res.ok || (json && json.ok === false)) {
		const payload = json ?? { ok: false, error: `bridge_http_${res.status}` };
		return { isError: true, status: res.status, payload };
	}
	return { isError: false, status: res.status, payload: json ?? { ok: true } };
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC 处理
// ---------------------------------------------------------------------------

function jsonRpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function jsonRpcError(id, code, message, data) { return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }; }

const ERR_PARSE = -32700, ERR_INVALID_REQUEST = -32600, ERR_METHOD_NOT_FOUND = -32601, ERR_INVALID_PARAMS = -32602;

async function handleRpc(msg) {
	const { id, method, params } = msg ?? {};
	switch (method) {
		case 'initialize':
			return jsonRpcResult(id, {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: SERVER_NAME, version: ADAPTER_VERSION },
				instructions: 'Thin MCP adapter over the DSH supervisor-bridge control plane. 9 tools: 5 read-only (health/get_state/get_goal/get_evidence/get_snapshot) and 4 mutations (dispatch_goal/send_correction/cancel_goal/review_goal). All mutations are idempotent by idempotency_key / command_id; always fetch current generation via supervisor_get_goal before correcting, cancelling, or reviewing.',
			});
		case 'notifications/initialized':
		case 'notifications/cancelled':
			return undefined; // notification → 202
		case 'ping':
			return jsonRpcResult(id, {});
		case 'tools/list':
			return jsonRpcResult(id, {
				tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
			});
		case 'tools/call': {
			const name = params?.name;
			const tool = TOOLS.find((t) => t.name === name);
			if (!tool) {
				return jsonRpcError(id, ERR_INVALID_PARAMS, `Unknown tool: ${String(name)}`, { available: TOOLS.map((t) => t.name) });
			}
			const args = params?.arguments ?? {};
			try {
				const { isError, payload } = await callBridge(tool, args);
				const text = JSON.stringify(payload, null, 2);
				log(`tool=${name} isError=${isError} bytes=${text.length}`);
				return jsonRpcResult(id, {
					content: [{ type: 'text', text }],
					structuredContent: typeof payload === 'object' && payload !== null ? payload : { payload },
					isError,
				});
			} catch (e) {
				const detail = e?.name === 'TimeoutError' ? 'bridge_timeout' : 'bridge_unreachable';
				log(`tool=${name} EXC ${detail}: ${String(e?.message ?? e).slice(0, 160)}`);
				return jsonRpcResult(id, {
					content: [{ type: 'text', text: JSON.stringify({ ok: false, error: detail, detail: String(e?.message ?? e).slice(0, 200) }, null, 2) }],
					structuredContent: { ok: false, error: detail },
					isError: true,
				});
			}
		}
		case 'resources/list':
		case 'prompts/list':
			return jsonRpcResult(id, method === 'resources/list' ? { resources: [] } : { prompts: [] });
		default:
			if (String(method ?? '').startsWith('notifications/')) return undefined;
			return jsonRpcError(id, ERR_METHOD_NOT_FOUND, `Method not supported: ${String(method)}`);
	}
}

function log(line) {
	console.log(`[adapter ${new Date().toISOString()}] ${line}`);
}

function readBody(req, limitBytes = 2 * 1024 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (c) => {
			size += c.length;
			if (size > limitBytes) { reject(Object.assign(new Error('body_too_large'), { statusCode: 413 })); req.destroy(); return; }
			chunks.push(c);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

async function healthz() {
	let bridge = 'unreachable';
	try {
		const token = bridgeToken();
		const res = await fetch(`${BRIDGE_BASE}/supervisor/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) });
		bridge = res.ok ? 'ok' : `http_${res.status}`;
	} catch { /* keep unreachable */ }
	return { ok: true, adapter: SERVER_NAME, version: ADAPTER_VERSION, protocol: PROTOCOL_VERSION, auth: REQUIRE_AUTH ? 'bearer' : 'none', bridge, tools: TOOLS.length };
}

// P2.8：Widget 只读代理（GET /watchdog/health | /watchdog/status）。
// 零缓存、零 mutation：入口用 WATCHDOG token 鉴权，上游用同一 token 打 3080 /watchdog/*。
async function proxyWatchdog(pathname) {
	const token = watchdogToken();
	if (!token) return { status: 503, body: { ok: false, error: 'watchdog_token_unavailable' } };
	try {
		const res = await fetch(`${BRIDGE_BASE}${pathname}`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(6000),
		});
		const body = await res.json().catch(() => ({ ok: false, error: 'bad_json' }));
		return { status: res.status, body };
	} catch (e) {
		return { status: 502, body: { ok: false, error: 'watchdog_upstream_unreachable', detail: String(e?.message ?? e).slice(0, 120) } };
	}
}

function watchdogToken() {
	const explicit = process.env.WATCHDOG_TOKEN;
	if (typeof explicit === 'string' && explicit.trim().length >= 32) return explicit.trim();
	try {
		const raw = readFileSync(WATCHDOG_TOKEN_FILE, 'utf8').trim();
		return raw.length >= 32 ? raw : null;
	} catch {
		return null;
	}
}

function checkWatchdogAuth(header) {
	if (!WATCHDOG_REQUIRE_AUTH) return false; // watchdog 只读面不提供无鉴权模式（fail-closed）
	const token = watchdogToken();
	if (!token) return false;
	const m = /^Bearer\s+(.+)$/.exec(String(header ?? '').trim());
	if (!m) return false;
	const given = Buffer.from(m[1], 'utf8');
	const want = Buffer.from(token, 'utf8');
	if (given.length !== want.length) {
		timingSafeEqual(given.subarray(0, 1), want.subarray(0, 1)); // 平滑时序
		return false;
	}
	return timingSafeEqual(given, want);
}

const httpServer = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
	try {
		if (url.pathname === '/healthz') {
			const body = JSON.stringify(await healthz());
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(body);
			return;
		}
		if (url.pathname === '/watchdog/health' || url.pathname === '/watchdog/status') {
			if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
			if (!checkWatchdogAuth(req.headers.authorization)) {
				log(`watchdog auth=fail ip=${req.socket.remoteAddress}`);
				res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="dsh-watchdog"' });
				res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
				return;
			}
			const out = await proxyWatchdog(url.pathname);
			res.writeHead(out.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			res.end(JSON.stringify(out.body));
			return;
		}
		// P2.8 R1 B1：watchdog SSE 事件流代理（GET /watchdog/events）。
		// 只读、长连接：入口与上游共用同一 WATCHDOG token；上游 text/event-stream 原样
		// 管道转发（状态变化事件 + 心跳注释）；客户端断开 → 中止上游。零缓存零 mutation。
		if (url.pathname === '/watchdog/events') {
			if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
			if (!checkWatchdogAuth(req.headers.authorization)) {
				log(`watchdog-sse auth=fail ip=${req.socket.remoteAddress}`);
				res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="dsh-watchdog"' });
				res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
				return;
			}
			const token = watchdogToken();
			if (!token) {
				res.writeHead(503, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: false, error: 'watchdog_token_unavailable' }));
				return;
			}
			const ac = new AbortController();
			req.on('close', () => ac.abort());
			let upstream;
			try {
				upstream = await fetch(`${BRIDGE_BASE}/watchdog/events`, {
					headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
					signal: ac.signal,
				});
			} catch (e) {
				res.writeHead(502, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: false, error: 'watchdog_upstream_unreachable', detail: String(e?.message ?? e).slice(0, 120) }));
				return;
			}
			if (!upstream.ok || !upstream.body) {
				res.writeHead(upstream.status === 401 ? 401 : 502, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: false, error: 'watchdog_sse_upstream_bad_status', status: upstream.status }));
				return;
			}
			log(`watchdog-sse client=connected ip=${req.socket.remoteAddress}`);
			res.writeHead(200, {
				'Content-Type': 'text/event-stream; charset=utf-8',
				'Cache-Control': 'no-store',
				'Connection': 'keep-alive',
				'X-Accel-Buffering': 'no',
			});
			try {
				await new Promise((resolve) => {
					const stream = Readable.fromWeb(upstream.body);
					stream.on('data', (chunk) => {
						try { res.write(chunk); } catch { /* closed */ }
					});
					stream.on('end', () => { try { res.end(); } catch { /* ignore */ } resolve(); });
					stream.on('error', () => { try { res.end(); } catch { /* ignore */ } resolve(); });
					res.on('close', () => { ac.abort(); try { stream.destroy(); } catch { /* ignore */ } resolve(); });
				});
			} finally {
				log(`watchdog-sse client=disconnected ip=${req.socket.remoteAddress}`);
			}
			return;
		}
		if (url.pathname !== '/mcp') {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: ERR_INVALID_REQUEST, message: 'not found; POST JSON-RPC to /mcp' } }));
			return;
		}
		if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST, DELETE' }); res.end(); return; }
		if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; } // stateless：无会话可终止
		if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST, DELETE' }); res.end(); return; }

		if (!checkAuth(req.headers.authorization)) {
			log(`auth=fail ip=${req.socket.remoteAddress}`);
			res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="dsh-supervisor-bridge"' });
			res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: ERR_INVALID_REQUEST, message: 'unauthorized' } }));
			return;
		}

		const raw = await readBody(req);
		let msg;
		try { msg = JSON.parse(raw); } catch {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(jsonRpcError(null, ERR_PARSE, 'invalid JSON')));
			return;
		}
		if (Array.isArray(msg)) {
			// 兼容批量（2025-03-26 批量语义已弃用：逐条串行处理，过滤 notification）
			const out = [];
			for (const m of msg) {
				if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') continue;
				const r = await handleRpc(m);
				if (r !== undefined && m.id !== undefined && m.id !== null) out.push(r);
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(out.length === 1 ? out[0] : out));
			return;
		}
		if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(jsonRpcError(msg?.id ?? null, ERR_INVALID_REQUEST, 'not a JSON-RPC 2.0 request')));
			return;
		}
		const result = await handleRpc(msg);
		if (result === undefined) {
			// notification → 202 Accepted，空 body（Streamable HTTP 规范）
			res.writeHead(202);
			res.end();
			return;
		}
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(result));
	} catch (e) {
		const status = e?.statusCode ?? 500;
		if (status >= 500) log(`EXC ${url.pathname}: ${String(e?.stack ?? e).slice(0, 300)}`);
		res.writeHead(status, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(jsonRpcError(null, ERR_INVALID_REQUEST, String(e?.message ?? e).slice(0, 200))));
	}
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	httpServer.listen(PORT, HOST, () => {
		log(`listening on http://${HOST}:${PORT}/mcp  auth=${REQUIRE_AUTH ? 'bearer' : 'none'}  bridge=${BRIDGE_BASE}  tools=${TOOLS.length}`);
		log(`adapter token source: ${process.env.MCP_TOKEN ? 'MCP_TOKEN env' : TOKEN_FILE}; bridge token source: ${process.env.BRIDGE_TOKEN ? 'BRIDGE_TOKEN env' : BRIDGE_TOKEN_FILE}`);
	});
}

export { httpServer, TOOLS, handleRpc, checkAuth, healthz, PROTOCOL_VERSION, ADAPTER_VERSION };
