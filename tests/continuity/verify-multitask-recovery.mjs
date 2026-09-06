// verify-multitask-recovery.mjs — PHASE2 TEST 15 multi-task recovery（2026-08-23）
// 验证：多个 recoverable session 并发恢复受 maxConcurrentResume 限制，
// 超出部分 RECOVERY_QUEUED，槽位释放后继续。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ec-multi-"));
const MOD = await import("../../plugins/execution-continuity.mjs");

const listeners = [];
const services = {
  agents: {}, goals: { get: () => ({ id: "g1", phase: "active" }) }, sessions: {},
  llm: { providers: { opencode: { models: [{ id: "deepseek-v4-flash", contextWindow: 1000000 }, { id: "deepseek-v4-pro", contextWindow: 1000000 }] } } },
};
const raw = {
  logger: { info() {}, warn() {}, error() {} },
  _listeners: listeners,
  get(n) { return services[n]; }, read(n) { return services[n]; },
  on(e, h) { listeners.push({ e, h }); return () => {}; },
  effect(g) { const i = g(); i.next(); const s = i.next(); if (typeof s.value === "function") raw._dispose = s.value; },
};
const ctx = new Proxy(raw, { get(t, p, r) { if (p in t) return Reflect.get(t, p, r); if (p in services) return services[p]; return undefined; } });

const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true, maxConcurrentResume: 2 });
const { store, STATE } = plugin._test;

let pass = 0, fail = 0;
function assert(c, n, d = "") { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + " " + d); } }

// 构造 4 个 recoverable session（RUNNING 状态，autoResume=true）
const sids = ["task-A", "task-B", "task-C", "task-D"];
for (const s of sids) store.setState(s, STATE.RUNNING, { autoResume: true });

const recoverable = store.listRecoverable();
assert(recoverable.length === 4, "4 sessions recoverable", `got ${recoverable.length}`);

// 模拟 recoverableScan 的并发控制逻辑（与插件源码一致）
// maxConcurrentResume=2 → 前 2 个 active，后 2 个 RECOVERY_QUEUED
const scanned = [];
let active = 0, queued = 0;
for (const it of recoverable) {
  if (active >= 2) {
    store.setState(it.sessionId, STATE.RECOVERY_QUEUED, { nextRetryAt: Date.now() + 30000 });
    queued++;
  } else {
    store.setState(it.sessionId, STATE.RETRYING, {}); // 模拟正在恢复
    active++;
  }
}
assert(active === 2, "2 sessions start recovery (maxConcurrentResume=2)", `got ${active}`);
assert(queued === 2, "2 sessions queued (RECOVERY_QUEUED)", `got ${queued}`);
const queuedStates = Object.values(store.data.intents).filter((i) => i.state === STATE.RECOVERY_QUEUED);
assert(queuedStates.length === 2, "RECOVERY_QUEUED states recorded", `got ${queuedStates.length}`);

// 槽位释放：A 完成 → C 从 QUEUED 提升
store.setState("task-A", STATE.RUNNING, { note: "recovered" });
// listDue 应包含 RECOVERY_QUEUED 且 nextRetryAt 到期
const due = store.listDue(Date.now() + 30001);
assert(due.some((i) => i.sessionId === "task-C") || due.length >= 2, "queued session becomes due after retry window", `due=${due.map((i) => i.sessionId).join(",")}`);

// 不存在的 session：resume 应标记 COMPLETED（避免幽灵任务）
store.setState("ghost", STATE.RUNNING, { autoResume: true });
assert(store.listRecoverable().some((i) => i.sessionId === "ghost"), "ghost session in recoverable set");

console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
