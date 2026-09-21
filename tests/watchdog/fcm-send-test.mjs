// fcm-send-test.mjs —— Phase 02.8 R2 C：FCM 服务端激活受控测试（tests/watchdog）
//
// 目的：验证 FCM_SERVICE_ACCOUNT_JSON（Secret Store）→ OAuth2 token → FCM HTTP v1
//       messages:send → topic=watchdog 全链路真实可达（与 plugins/watchdog.mjs
//       fcmAccessToken / watchdog-core.buildFcmRequest 同一线格式）。
// 安全：凭据从 env FCM_SA_JSON 或 ~/.dsh/.credentials.yaml 读取（与插件同 regex 口径）；
//       绝不打印 SA 内容 / private key / access token；输出仅结构化结论 + FCM message name。
// 用法：node tests/watchdog/fcm-send-test.mjs
//       （可选 --project dsh-watchdog 覆盖 project id；默认从 SA JSON project_id 取）
// 红线：只向 FCM API 发起只读性质的测试发送（data-message wake，载荷与
//       buildFcmPushPayload 白名单同构）；不写仓库、不落盘凭据。

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
// js-yaml 与 dsh 主程序同一份（repo 依赖树里没有；dsh 运行时用它解析 yaml 配置）
function loadYaml() {
	const candidates = [
		join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
		join(ROOT, 'package.json'),
	];
	for (const pkgPath of candidates) {
		if (!existsSync(pkgPath)) continue;
		try { return createRequire(pkgPath)('js-yaml'); } catch { /* try next */ }
	}
	throw new Error('js-yaml not found (dsh install or repo node_modules)');
}
const yaml = loadYaml();

const SA_REF = 'FCM_SERVICE_ACCOUNT_JSON';
const OAUTH_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

function maskErr(e) {
	const m = String(e?.message ?? e);
	// 防御性脱敏：任何响应体/错误里出现 key/token 片段一律截断为固定标记
	return m.includes('private_key') || m.includes('access_token') ? '<redacted>' : m.slice(0, 160);
}

function loadServiceAccountJson() {
	if (process.env.FCM_SA_JSON) return process.env.FCM_SA_JSON;
	const credPath = join(homedir(), '.dsh', '.credentials.yaml');
	if (!existsSync(credPath)) throw new Error('credentials store not found (~/.dsh/.credentials.yaml)');
	const doc = yaml.load(readFileSync(credPath, 'utf8'));
	const v = doc?.refs?.[SA_REF] ?? doc?.credentials?.[SA_REF] ?? doc?.[SA_REF];
	if (!v) throw new Error(`${SA_REF} not configured`);
	return v;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function getAccessToken(sa) {
	const now = Math.floor(Date.now() / 1000);
	const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const claims = b64url(JSON.stringify({
		iss: sa.client_email,
		scope: SCOPE,
		aud: OAUTH_URL,
		iat: now,
		exp: now + 3600,
	}));
	const signer = crypto.createSign('RSA-SHA256');
	signer.update(`${header}.${claims}`);
	const sig = signer.sign(sa.private_key, 'base64url');
	const jwt = `${header}.${claims}.${sig}`;
	const res = await fetch(OAUTH_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			assertion: jwt,
		}),
	});
	if (!res.ok) throw new Error(`oauth http ${res.status}`);
	const j = await res.json();
	if (!j.access_token) throw new Error('oauth: no access_token');
	return j.access_token;
}

// 与 watchdog-core.buildFcmPushPayload 白名单同构的测试载荷（data 值全为字符串）
function buildTestPayload() {
	const seq = Date.now() % 100000;
	return {
		v: '1',
		ev: 'state_change',
		eid: `fcm-${seq}`,
		rev: '',
		gen: '',
		wake: 'true',
		ts: new Date().toISOString(),
	};
}

let exitCode = 0;
try {
	const raw = loadServiceAccountJson();
	const sa = JSON.parse(raw);
	if (sa.type !== 'service_account' || !sa.private_key || !sa.client_email || !sa.project_id) {
		throw new Error('SA JSON missing required fields');
	}
	const projectId = process.argv.includes('--project')
		? process.argv[process.argv.indexOf('--project') + 1]
		: sa.project_id;
	console.log(`[fcm-test] SA ok: type=service_account project_id=${projectId} client_email=${sa.client_email}`);

	const token = await getAccessToken(sa);
	console.log('[fcm-test] OAuth2 token: OK (masked)');

	const body = { message: { topic: 'watchdog', data: buildTestPayload(), android: { priority: 'HIGH', ttl: '900s' } } };
	const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const respText = await res.text();
	// FCM 成功响应含 message name（projects/*/messages/*）；失败含 error.status
	let detail = '';
	try {
		const j = JSON.parse(respText);
		detail = j.name ? `message=${j.name}` : `error=${j.error?.status ?? respText.slice(0, 80)}`;
	} catch { detail = respText.slice(0, 80); }
	if (res.ok) {
		console.log(`[fcm-test] FCM send: OK http=200 ${detail}`);
		console.log('FCM SERVER-SIDE ACTIVATION PASS');
	} else {
		console.log(`[fcm-test] FCM send: FAIL http=${res.status} ${detail}`);
		exitCode = 1;
	}
} catch (e) {
	console.log(`[fcm-test] FAIL: ${maskErr(e)}`);
	exitCode = 1;
}
process.exit(exitCode);
