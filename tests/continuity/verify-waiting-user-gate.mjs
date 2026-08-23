// verify-waiting-user-gate.mjs — P1-A WAITING_USER 保护真实接入测试（2026-08-23）
//
// 覆盖任务书 TEST W1-W6：
//   W1: Goal active + 未回答 ask_user_question → hasPendingQuestion=true → boot scan 跳过
//   W2: 同一 question 已有 answer → hasPendingQuestion=false → 可以恢复
//   W3: 无 question → 正常恢复
//   W4: USER_PAUSED → 不恢复
//   W5: USER_CANCELLED → 不恢复
//   W6: WAITING_USER + Server restart → 重启后仍 WAITING_USER，不自动插入"继续"
//
// 用真实 DSH event schema（assembler.js / repair.js 确认的结构）。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ec-waitgate-"));
const MOD = await import(pathToFileURL("C:/Users/Administrator/.dsh/profiles/web/execution-continuity.mjs").href);

let pass = 0, fail = 0;
function assert(c, n, d = "") { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + " " + d); } }
function section(t) { console.log(`\n=== ${t} ===`); }

// mock ctx：sessions.get 返回可注入的 session（含 events）
function makeMockCtx(sessionMap) {
  const listeners = [];
  const services = {
    agents: {}, goals: { get: () => ({ id: "g1", phase: "active" }) },
    sessions: { get: (id) => sessionMap.get(id) || undefined },
    llm: { providers: { opencode: { models: [{ id: "deepseek-v4-flash", contextWindow: 1000000 }] } } },
  };
  const raw = {
    logger: { info() {}, warn() {}, error() {} },
    _listeners: listeners,
    get(n) { return services[n]; }, read(n) { return services[n]; },
    on(e, h) { listeners.push({ e, h }); return () => {}; },
    effect(g) { const i = g(); i.next(); const s = i.next(); if (typeof s.value === "function") raw._dispose = s.value; },
  };
  return new Proxy(raw, { get(t, p, r) { if (p in t) return Reflect.get(t, p, r); if (p in services) return services[p]; return undefined; } });
}

// 真实 schema 事件构造
const pendingQEvents = [
  { type: "turn/start", seq: 1, data: { turn: 5 } },
  { type: "assistant/message", seq: 2, data: { turn: 5, step: 1, message: { content: [{ type: "tool-call", id: "call_q1", name: "ask_user_question", arguments: "{}" }] } } },
];
const answeredQEvents = [
  { type: "turn/start", seq: 1, data: { turn: 5 } },
  { type: "assistant/message", seq: 2, data: { turn: 5, step: 1, message: { content: [{ type: "tool-call", id: "call_q1", name: "ask_user_question", arguments: "{}" }] } } },
  { type: "tool/result", seq: 3, data: { turn: 5, step: 1, message: { source: { kind: "tool", callId: "call_q1" } } } },
];
const noQEvents = [
  { type: "turn/start", seq: 1, data: { turn: 1 } },
  { type: "assistant/message", seq: 2, data: { turn: 1, message: { content: [{ type: "text", text: "hi" }] } } },
];

section("W1: active goal + pending question → gate blocks resume");
{
  const sessionMap = new Map([["sess-w1", { events: pendingQEvents }]]);
  const ctx = makeMockCtx(sessionMap);
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  const { store, STATE, hasPendingQuestion } = plugin._test;
  // 验证 hasPendingQuestion 真实检测
  assert(hasPendingQuestion({ events: pendingQEvents }) === true, "hasPendingQuestion detects pending (real schema)");
  // 构造 recoverable intent 并调用 recoverableScan（内部会过 gate）
  store.setState("sess-w1", STATE.RUNNING, { autoResume: true });
  const scanCalls = [];
  // 直接验证 gate：把 resumeViaApi 短路——通过检查 scan 后状态不变
  // 由于 scan 是 async 且内部调 gate，这里模拟：手动调 gate 逻辑路径
  const it = store.get("sess-w1");
  const gate = plugin._test.checkUserWaitGate;
  assert(typeof gate === "function", "checkUserWaitGate exposed for test");
  if (gate) {
    const blocked = await gate("sess-w1", it, "test");
    assert(blocked === true, "gate blocks pending-question session", `got ${blocked}`);
    assert(it.state === STATE.WAITING_USER, "session marked WAITING_USER", `got ${it.state}`);
  }
}

section("W2: answered question → gate allows");
{
  const sessionMap = new Map([["sess-w2", { events: answeredQEvents }]]);
  const ctx = makeMockCtx(sessionMap);
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  const { store, STATE, hasPendingQuestion } = plugin._test;
  assert(hasPendingQuestion({ events: answeredQEvents }) === false, "hasPendingQuestion false after answer (real schema)");
  store.setState("sess-w2", STATE.RUNNING, { autoResume: true });
  const it = store.get("sess-w2");
  const gate = plugin._test.checkUserWaitGate;
  if (gate) {
    const blocked = await gate("sess-w2", it, "test");
    assert(blocked === false, "gate allows answered-question session", `got ${blocked}`);
  }
}

section("W3: no question → gate allows");
{
  const sessionMap = new Map([["sess-w3", { events: noQEvents }]]);
  const ctx = makeMockCtx(sessionMap);
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  const { store, STATE, hasPendingQuestion } = plugin._test;
  assert(hasPendingQuestion({ events: noQEvents }) === false, "hasPendingQuestion false when no question");
  store.setState("sess-w3", STATE.RUNNING, { autoResume: true });
  const it = store.get("sess-w3");
  const gate = plugin._test.checkUserWaitGate;
  if (gate) {
    const blocked = await gate("sess-w3", it, "test");
    assert(blocked === false, "gate allows no-question session", `got ${blocked}`);
  }
}

section("W4/W5: USER_PAUSED / USER_CANCELLED → never recoverable");
{
  const ctx = makeMockCtx(new Map());
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  const { store, STATE } = plugin._test;
  store.setState("sess-p", STATE.USER_PAUSED, { autoResume: false });
  store.setState("sess-c", STATE.USER_CANCELLED, { autoResume: false });
  const rec = store.listRecoverable();
  assert(!rec.some((i) => i.sessionId === "sess-p"), "USER_PAUSED not recoverable");
  assert(!rec.some((i) => i.sessionId === "sess-c"), "USER_CANCELLED not recoverable");
}

section("W6: WAITING_USER + restart → stays waiting, no auto continue");
{
  // 模拟：重启前 session 被 gate 设为 WAITING_USER（持久化）
  const ctx = makeMockCtx(new Map());
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  const { store, STATE } = plugin._test;
  store.setState("sess-w6", STATE.WAITING_USER, { autoResume: false });
  // "重启"：新插件实例（同一 stateDir 模拟持久化恢复）
  const plugin2 = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  const store2 = plugin2._test.store;
  const it = store2.get("sess-w6");
  assert(it && it.state === STATE.WAITING_USER, "WAITING_USER persisted across restart", it ? `got ${it.state}` : "missing");
  const rec2 = store2.listRecoverable();
  assert(!rec2.some((i) => i.sessionId === "sess-w6"), "WAITING_USER not in recoverable set after restart");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
