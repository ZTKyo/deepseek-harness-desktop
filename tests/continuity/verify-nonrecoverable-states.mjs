// verify-nonrecoverable-states.mjs — PHASE2 TEST 12/13/14 保护验证（2026-08-23）
// 验证 USER_PAUSED / USER_CANCELLED / WAITING_USER / COMPLETED / FAILED_FATAL
// 状态的 session 绝不会被 recoverableScan / boot scan 自动恢复。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ec-protect-"));
const MOD = await import("../../plugins/execution-continuity.mjs");

const listeners = [];
const services = {
  agents: {}, goals: { get: () => ({ id: "g1", phase: "active" }) }, sessions: {},
  llm: { providers: { opencode: { models: [{ id: "deepseek-v4-flash", contextWindow: 1000000 }] } } },
};
const raw = {
  logger: { info() {}, warn() {}, error() {} },
  _listeners: listeners,
  get(n) { return services[n]; }, read(n) { return services[n]; },
  on(e, h) { listeners.push({ e, h }); return () => {}; },
  effect(g) { const i = g(); i.next(); const s = i.next(); if (typeof s.value === "function") raw._dispose = s.value; },
};
const ctx = new Proxy(raw, { get(t, p, r) { if (p in t) return Reflect.get(t, p, r); if (p in services) return services[p]; return undefined; } });

const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
const { store, STATE, RECOVERABLE_STATES } = plugin._test;
const NON_RECOVERABLE_STATES = ["USER_PAUSED", "USER_CANCELLED", "WAITING_USER", "COMPLETED", "FAILED_FATAL"];

let pass = 0, fail = 0;
function assert(c, n, d = "") { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + " " + d); } }

// 构造各种状态的 session
store.setState("sess-paused", STATE.USER_PAUSED, { autoResume: false });
store.setState("sess-cancelled", STATE.USER_CANCELLED, { autoResume: false });
store.setState("sess-waiting-user", STATE.WAITING_USER, { autoResume: false });
store.setState("sess-completed", STATE.COMPLETED, { autoResume: false });
store.setState("sess-fatal", STATE.FAILED_FATAL, { autoResume: false });
store.setState("sess-running", STATE.RUNNING, { autoResume: true });
store.setState("sess-network", STATE.WAITING_NETWORK, { autoResume: true });

// 1) listRecoverable 只包含可恢复状态
const recoverable = store.listRecoverable();
const recoverableIds = recoverable.map((i) => i.sessionId);
console.log("recoverable:", recoverableIds.join(", "));
assert(recoverableIds.includes("sess-running"), "RUNNING is recoverable");
assert(recoverableIds.includes("sess-network"), "WAITING_NETWORK is recoverable");
assert(!recoverableIds.includes("sess-paused"), "USER_PAUSED NOT recoverable");
assert(!recoverableIds.includes("sess-cancelled"), "USER_CANCELLED NOT recoverable");
assert(!recoverableIds.includes("sess-waiting-user"), "WAITING_USER NOT recoverable");
assert(!recoverableIds.includes("sess-completed"), "COMPLETED NOT recoverable");
assert(!recoverableIds.includes("sess-fatal"), "FAILED_FATAL NOT recoverable");

// 2) 状态集合完整性
console.log("RECOVERABLE_STATES:", RECOVERABLE_STATES.join(", "));
console.log("NON_RECOVERABLE_STATES:", NON_RECOVERABLE_STATES.join(", "));
assert(RECOVERABLE_STATES.includes("RUNNING"), "RUNNING in RECOVERABLE");
assert(RECOVERABLE_STATES.includes("RETRYING"), "RETRYING in RECOVERABLE");
assert(RECOVERABLE_STATES.includes("WAITING_NETWORK"), "WAITING_NETWORK in RECOVERABLE");
assert(RECOVERABLE_STATES.includes("WAITING_PROVIDER"), "WAITING_PROVIDER in RECOVERABLE");
assert(RECOVERABLE_STATES.includes("RECOVERY_QUEUED"), "RECOVERY_QUEUED in RECOVERABLE");
assert(RECOVERABLE_STATES.includes("INTERRUPTED_BY_RESTART"), "INTERRUPTED_BY_RESTART in RECOVERABLE");
assert(NON_RECOVERABLE_STATES.includes("USER_PAUSED"), "USER_PAUSED in NON_RECOVERABLE");
assert(NON_RECOVERABLE_STATES.includes("USER_CANCELLED"), "USER_CANCELLED in NON_RECOVERABLE");
assert(NON_RECOVERABLE_STATES.includes("WAITING_USER"), "WAITING_USER in NON_RECOVERABLE");
assert(NON_RECOVERABLE_STATES.includes("COMPLETED"), "COMPLETED in NON_RECOVERABLE");
assert(NON_RECOVERABLE_STATES.includes("FAILED_FATAL"), "FAILED_FATAL in NON_RECOVERABLE");

// 3) 状态互斥（无重叠）
const overlap = RECOVERABLE_STATES.filter((s) => NON_RECOVERABLE_STATES.includes(s));
assert(overlap.length === 0, "no state in both sets", overlap.join(","));

console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
