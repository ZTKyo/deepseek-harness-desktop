// smoke-watchdog-host.mjs — Phase 02.8 宿主级冒烟：在宿主外用 stub ctx 实例化 watchdog
// 插件，验证 ① 插件可加载 ② 只读路由已注册 ③ 真实回环轮询产出脱敏 last-snapshot.json。
// 只读安全：对 bridge 仅调用 get_snapshot / get_state（只读权威面），不触发任何 mutation。
// 运行：node tests/watchdog/smoke-watchdog-host.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

// 隔离写盘：smoke 实例与真实 3080 宿主 watchdog 写同一 last-snapshot.json 会产生
// schemaVersion 竞态（宿主旧代码写 v1 会先到）。指到临时目录，只验证本实例产物。
const realHome = join(homedir(), '.dsh');
const smokeHome = mkdtempSync(join(tmpdir(), 'dsh-watchdog-smoke-'));
process.env.DSH_HOME = smokeHome;
const snapFile = join(smokeHome, 'watchdog', 'last-snapshot.json');

// 清掉旧产物，确保读到的是本次冒烟写出的（DSH_HOME 已隔离，防御性保留）
try { rmSync(snapFile); } catch { /* absent */ }

const routes = [];
let eventHandler = null;
const logs = [];
const ctx = {
	on(_ev, fn) { eventHandler = fn; },
	logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
	webServer: { port: 3080, register: (r) => routes.push(r) },
};

const { apply } = await import('../../plugins/watchdog.mjs');
apply(ctx, { pollMs: 3000, stallAfterMs: 1_800_000, alertPs1: null, pushOnStateChange: true, bridgeTokenFile: join(realHome, 'supervisor-bridge', 'token') });

assert.equal(routes.length, 3, `expected 3 registered routes, got ${routes.length}`);
assert.ok(routes.some((r) => r.path === '/watchdog/health'));
assert.ok(routes.some((r) => r.path === '/watchdog/status'));
assert.ok(routes.some((r) => r.path === '/watchdog/events')); // R2 B：退役探针路由（410），非 SSE
console.log('PASS plugin applied + 3 routes registered (health/status + retired events 410 probe)');

// R2 B：旧 SSE 入口 = 可判定退役信号（401 未授权 → 410 watchdog_sse_removed），而非 404/挂起
const goneRoute = routes.find((r) => r.path === '/watchdog/events');
const wdToken = readFileSync(join(smokeHome, 'watchdog', 'token'), 'utf8').trim(); // apply() 同步生成
let cap = null;
const fakeRes = { writeHead: (c, h) => { cap = { code: c, headers: h }; }, end: (b) => { if (cap) cap.body = b; } };
await goneRoute.handler({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, fakeRes);
assert.equal(cap.code, 401, `bad bearer → 401, got ${cap.code}`);
cap = null;
await goneRoute.handler({ method: 'GET', headers: { authorization: `Bearer ${wdToken}` } }, fakeRes);
assert.equal(cap.code, 410, `valid bearer → 410, got ${cap.code}`);
assert.ok(String(cap.body).includes('watchdog_sse_removed'), `body=${String(cap.body).slice(0, 120)}`);
assert.equal(String(cap.headers?.['cache-control'] ?? ''), 'no-store');
console.log('PASS retired SSE route: 401 (bad bearer) / 410 watchdog_sse_removed (valid bearer)');

// session/event 心跳不抛错
assert.equal(typeof eventHandler, 'function');
eventHandler({ id: 'session-00000000-0000-4000-8000-000000000000' }, { type: 'turn/start' });
console.log('PASS session/event heartbeat hook accepts events');

// 轮询至 snapshot 落盘（pollMs 3000 会被 normalizeConfig 钳到下限 10s；上限 25s）
let snap = null;
for (let i = 0; i < 25 && !snap; i++) {
	await new Promise((r) => setTimeout(r, 1000));
	try { snap = JSON.parse(readFileSync(snapFile, 'utf8')); } catch { /* not yet */ }
}
assert.ok(snap, `last-snapshot.json not written within 25s; logs=${JSON.stringify(logs.slice(-3))}`);
assert.equal(snap.kind, 'dsh-watchdog-snapshot');
assert.equal(snap.schemaVersion, 2);
assert.ok(['IDLE', 'RUNNING', 'STALLED', 'RECOVERING', 'AWAITING_REVIEW', 'BLOCKED', 'VERIFIED', 'OFFLINE', 'UNKNOWN'].includes(snap.state), `state=${snap.state}`);
assert.equal(snap.cost.quota, 'UNAVAILABLE');
assert.ok(snap.model?.default, 'model.default block missing (R1 B2)');
assert.equal(snap.model.actual?.model, 'UNKNOWN');
assert.ok(snap.recoveryBudget, 'recoveryBudget block missing (R1 B3)');
// R2（External Review B）：freshness 策略 = FCM data-message 唤醒 + 兜底轮询（SSE 长连接已移除）
assert.equal(snap.freshness?.policy, 'poll+fcm');
assert.equal(snap.push?.channel, 'sse'); // schema 兼容保留；语义 = 唤醒+拉取（push.fcm=true）
const json = JSON.stringify(snap);
for (const banned of ['Bearer', 'authorization', 'sk-', 'password']) assert.ok(!json.includes(banned), `leak: ${banned}`);
console.log(`PASS polled snapshot written: state=${snap.state} reason=${snap.stateReason} task=${snap.task.name ?? '(none)'}`);
if (process.env.WD_SMOKE_DEBUG === '1' && snap.state === 'OFFLINE') console.log('LOGS', JSON.stringify(logs, null, 1));
console.log('SMOKE-OK');
try { rmSync(smokeHome, { recursive: true, force: true }); } catch { /* best effort */ }
