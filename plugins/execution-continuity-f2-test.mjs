// execution-continuity-f2-test.mjs — P3 R1 F2 修复定向离线测试（2026-08-30）
//
// 背景（E2 真机证据 2026-08-30）：liveness 巡检在回合活跃期间把"goal 轮次无进展"
// 当僵尸信号，CT 门在模型自己的在途 pwsh 调用上评估（result 落盘前 414ms），
// 永久钉死 NEEDS_VERIFICATION，恢复路径被焊死。修复：
//   F2a liveness 引入会话事件数增量（回合内活跃信号）——由真机 E2E 覆盖
//   F2b runCtGate 对"活跃会话在途调用"改为有界瞬态 defer（cap 10 后才永久钉）
//   F2c resumeViaApi 活跃守卫（newBoot 旁路）——由真机 E2E 覆盖
//
// 本套件覆盖 F2b 决策层 + 新增字段迁移。运行：
//   node execution-continuity-f2-test.mjs ；退出码 0 = 全部 PASS。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ec-f2-test-"));
const MOD = await import(pathToFileURL(path.join(__dirname, "execution-continuity.mjs")));

function pathToFileURL(p) { return new URL("file:///" + p.replace(/\\/g, "/")); }

let pass = 0;
let fail = 0;
const failures = [];
function assert(cond, name, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name + (detail ? ` :: ${detail}` : "")); console.log(`  FAIL  ${name} ${detail}`); }
}
function section(title) { console.log(`\n=== ${title} ===`); }

function makeMockCtx(sessionEvents /* Map<sid, events[]> */) {
  const logLines = [];
  const services = {
    agents: {},
    goals: { get: () => ({ id: "g1", phase: "active" }) },
    llm: { providers: { opencode: { models: [{ id: "deepseek-v4-flash", contextWindow: 1000000 }] } } },
  };
  const sessionsService = {
    get: (sid) => (sessionEvents.has(sid) ? { sessionId: sid, events: sessionEvents.get(sid) } : null),
  };
  return {
    logger: {
      info: (m) => logLines.push(`INFO ${m}`),
      warn: (m) => logLines.push(`WARN ${m}`),
      error: (m) => logLines.push(`ERROR ${m}`),
    },
    _logLines: logLines,
    _services: services,
    // 插件直读 ctx.sessions（与 completionTruth 一致）
    sessions: sessionsService,
    get(name) { return services[name] === undefined ? undefined : services[name]; },
    read(name) { return services[name]; },
    on() { return () => {}; },
    effect(generator) { const it = generator(); it.next(); it.next(); return; },
  };
}

// 事件构造：一个 pwsh side-effect tool-call（无 result）→ CT needs_verification
function callWithoutResult(callId = "call_f2_1") {
  return [
    { type: "assistant/message", time: Date.now() - 500, data: { message: { content: [{ type: "tool-call", id: callId, name: "pwsh", input: { command: "echo hi" } }] } } },
  ];
}
function callWithResult(callId = "call_f2_2") {
  return [
    { type: "assistant/message", time: Date.now() - 5000, data: { message: { content: [{ type: "tool-call", id: callId, name: "pwsh", input: { command: "echo hi" } }] } } },
    { type: "tool/result", time: Date.now() - 4000, data: { message: { source: { kind: "tool", callId }, content: [{ type: "tool-result", toolCallId: callId, output: "ok" }] } } },
  ];
}

section("UT-F2.1: needs_verification on ACTIVELY RUNNING session -> bounded transient defer (NOT pinned)");
{
  const sid = "f2-live-1";
  const events = new Map([[sid, callWithoutResult()]]);
  const ctx = makeMockCtx(events);
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: false });
  const { store, STATE, runCtGate } = plugin._test;
  store.setState(sid, STATE.RECOVERY_QUEUED, { nextRetryAt: Date.now() - 1000 });
  const it = store.get(sid);
  const proceed = await runCtGate(sid, it, true);
  assert(proceed === false, "gate refuses resume (transient defer)");
  assert(it.state === STATE.WAITING_NETWORK, `state=WAITING_NETWORK :: got ${it.state}`);
  assert(it.ctTransientDeferCount === 1, `ctTransientDeferCount=1 :: got ${it.ctTransientDeferCount}`);
  assert(it.verificationKind === "EVIDENCE_DEFER", `verificationKind=EVIDENCE_DEFER :: got ${it.verificationKind}`);
}

section("UT-F2.2: transient defer is bounded (cap 10 -> permanent NEEDS_VERIFICATION at call #11)");
{
  const sid = "f2-live-2";
  const events = new Map([[sid, callWithoutResult("call_f2_cap")]]);
  const ctx = makeMockCtx(events);
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: false });
  const { store, STATE, runCtGate } = plugin._test;
  store.setState(sid, STATE.RECOVERY_QUEUED, { nextRetryAt: Date.now() - 1000 });
  let pinnedAt = -1;
  for (let i = 1; i <= 11 && pinnedAt < 0; i++) {
    const it = store.get(sid);
    await runCtGate(sid, it, true);
    if (it.state === STATE.NEEDS_VERIFICATION) pinnedAt = i;
    else assert(it.state === STATE.WAITING_NETWORK && it.ctTransientDeferCount === i, `call #${i} defers (count=${it.ctTransientDeferCount})`);
  }
  assert(pinnedAt === 11, `pin happens exactly at call #11 :: got #${pinnedAt}`);
}

section("UT-F2.3: needs_verification on DEAD/stale session -> immediate permanent pin (fail-closed unchanged)");
{
  const sid = "f2-dead-1";
  const evs = callWithoutResult("call_f2_dead").map((e) => ({ ...e, time: Date.now() - 10 * 60 * 1000 }));
  const ctx = makeMockCtx(new Map([[sid, evs]]));
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: false });
  const { store, STATE, runCtGate } = plugin._test;
  store.setState(sid, STATE.RECOVERY_QUEUED, { nextRetryAt: Date.now() - 1000 });
  const it = store.get(sid);
  const proceed = await runCtGate(sid, it, false);
  assert(proceed === false, "gate refuses resume");
  assert(it.state === STATE.NEEDS_VERIFICATION, `state=NEEDS_VERIFICATION :: got ${it.state}`);
  assert(it.verificationKind === "UNRESOLVED_SIDE_EFFECT", `verificationKind=UNRESOLVED_SIDE_EFFECT :: got ${it.verificationKind}`);
  assert((it.ctTransientDeferCount || 0) === 0, "no transient defer counted for dead session");
}

section("UT-F2.4: clean CT resets transient counter (result lands during defer window)");
{
  const sid = "f2-clean-1";
  const events = new Map([[sid, callWithoutResult("call_f2_clean")]]);
  const ctx = makeMockCtx(events);
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: false });
  const { store, STATE, runCtGate } = plugin._test;
  store.setState(sid, STATE.RECOVERY_QUEUED, { nextRetryAt: Date.now() - 1000 });
  const it1 = store.get(sid);
  await runCtGate(sid, it1, true);
  assert(it1.state === STATE.WAITING_NETWORK && it1.ctTransientDeferCount === 1, "precondition: deferred once");
  // 模拟 result 落盘：同一事件数组追加 tool/result（插件每次调用都读同一数组引用）
  const evs = events.get(sid);
  evs.push({ type: "tool/result", time: Date.now(), data: { message: { source: { kind: "tool", callId: "call_f2_clean" }, content: [{ type: "tool-result", toolCallId: "call_f2_clean", output: "ok" }] } } });
  const it2 = store.get(sid);
  const proceed = await runCtGate(sid, it2, true);
  assert(proceed === true, "CT clean -> proceed");
  assert((it2.ctTransientDeferCount || 0) === 0, `transient counter reset :: got ${it2.ctTransientDeferCount}`);
}

section("UT-F2.5: legacy intent gains new fields (additive migration, no crash)");
{
  const sid = "f2-legacy-1";
  const ctx = makeMockCtx(new Map());
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: false });
  const { store, STATE } = plugin._test;
  store.setState(sid, STATE.RUNNING, { note: "legacy shape" });
  const it = store.get(sid);
  assert(it.lastEventCountObserved === null, `lastEventCountObserved migrated to null :: got ${JSON.stringify(it.lastEventCountObserved)}`);
  assert(it.ctTransientDeferCount === 0, `ctTransientDeferCount migrated to 0 :: got ${JSON.stringify(it.ctTransientDeferCount)}`);
}

console.log("\n============================================================");
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
if (failures.length) { console.log("FAILURES:"); for (const f of failures) console.log("  - " + f); }
process.exitCode = fail === 0 ? 0 : 1;
