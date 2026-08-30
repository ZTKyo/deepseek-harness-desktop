// smoke-watchdog-host.mjs — Phase 02.8 宿主级冒烟：在宿主外用 stub ctx 实例化 watchdog
// 插件，验证 ① 插件可加载 ② 只读路由已注册 ③ 真实回环轮询产出脱敏 last-snapshot.json。
// 只读安全：对 bridge 仅调用 get_snapshot / get_state（只读权威面），不触发任何 mutation。
// 运行：node tests/watchdog/smoke-watchdog-host.mjs

import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const snapFile = join(home, 'watchdog', 'last-snapshot.json');

// 清掉旧产物，确保读到的是本次冒烟写出的
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
apply(ctx, { pollMs: 3000, stallAfterMs: 1_800_000, alertPs1: null, pushOnStateChange: true });

assert.equal(routes.length, 2, `expected 2 registered routes, got ${routes.length}`);
assert.ok(routes.some((r) => r.path === '/watchdog/health'));
assert.ok(routes.some((r) => r.path === '/watchdog/status'));
console.log('PASS plugin applied + 2 read-only routes registered');

// session/event 心跳不抛错
assert.equal(typeof eventHandler, 'function');
eventHandler({ id: 'session-00000000-0000-4000-8000-000000000000' }, { type: 'turn/start' });
console.log('PASS session/event heartbeat hook accepts events');

// 轮询至 snapshot 落盘（首次 poll 在 5s 后，pollMs 3s；上限 25s）
let snap = null;
for (let i = 0; i < 25 && !snap; i++) {
	await new Promise((r) => setTimeout(r, 1000));
	try { snap = JSON.parse(readFileSync(snapFile, 'utf8')); } catch { /* not yet */ }
}
assert.ok(snap, `last-snapshot.json not written within 25s; logs=${JSON.stringify(logs.slice(-3))}`);
assert.equal(snap.kind, 'dsh-watchdog-snapshot');
assert.equal(snap.schemaVersion, 1);
assert.ok(['IDLE', 'RUNNING', 'STALLED', 'RECOVERING', 'AWAITING_REVIEW', 'BLOCKED', 'VERIFIED', 'OFFLINE', 'UNKNOWN'].includes(snap.state), `state=${snap.state}`);
assert.equal(snap.cost.quota, 'UNAVAILABLE');
const json = JSON.stringify(snap);
for (const banned of ['Bearer', 'authorization', 'sk-', 'password']) assert.ok(!json.includes(banned), `leak: ${banned}`);
console.log(`PASS polled snapshot written: state=${snap.state} reason=${snap.stateReason} task=${snap.task.name ?? '(none)'}`);
console.log('SMOKE-OK');
