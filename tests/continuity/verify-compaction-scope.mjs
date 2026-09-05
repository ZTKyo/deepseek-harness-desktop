// verify-compaction-scope.mjs — P1-B agent-scoped compaction 修复测试（2026-08-23）
//
// C1: host ctx 无 compaction + agent ctx 有 → agent-scoped lookup 成功
// C2: CONTEXT_OVERFLOW + agent compaction available → compactNow 调用一次 → retry
// C3: agent compaction unavailable → COMPACTION_UNAVAILABLE → safe fallback, Host survives
// C4: compactNow throws → catch/isolate → no Host crash
// C5: 多 agent：Agent A 有 compaction，Agent B 没有 → 状态不互相污染（无全局缓存）

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ec-ctxscope-"));
const MOD = await import("../../plugins/execution-continuity.mjs");

let pass = 0, fail = 0;
function assert(c, n, d = "") { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + " " + d); } }
function section(t) { console.log(`\n=== ${t} ===`); }

// makeAgent: agent with scoped ctx (compaction optional)
function makeAgent(compaction) {
  const services = {};
  if (compaction !== undefined) services.compaction = compaction;
  const actx = {
    get(n, strict) { return services[n] === undefined ? undefined : services[n]; },
    read(n) { return services[n]; },
  };
  // 无 compaction 时属性访问会 undefined（不 throw，模拟非 inject 属性）
  Object.defineProperty(actx, "compaction", { get: () => services.compaction, configurable: true });
  return { ctx: actx, session: { id: "sess-" + Math.random().toString(36).slice(2, 8) } };
}

function makeHostCtx(agents) {
  const listeners = [];
  const services = {
    agents: {}, goals: { get: () => ({ id: "g1", phase: "active" }) },
    sessions: { get: () => undefined },
    llm: { providers: { opencode: { models: [{ id: "deepseek-v4-flash", contextWindow: 1000000 }, { id: "deepseek-v4-pro", contextWindow: 1000000 }] } } },
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

section("C1: agent-scoped compaction lookup succeeds when host has none");
{
  const compactNowCalls = [];
  const agent = makeAgent({ compactNow: async () => { compactNowCalls.push("called"); return { ok: true }; } });
  const ctx = makeHostCtx([agent]);
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  const { getCompaction, compactionAvailable } = plugin._test;
  // host-only: 无 agent → 无 compaction
  assert(compactionAvailable(ctx) === false, "host ctx alone: compaction unavailable");
  // agent-scoped: 有 agent → compaction available
  assert(compactionAvailable(ctx, agent) === true, "agent-scoped: compaction available");
  const comp = getCompaction(ctx, agent);
  assert(comp !== null && typeof comp.compactNow === "function", "getCompaction returns agent compaction");
}

section("C2: CONTEXT_OVERFLOW → EC does NOT hand-call compactNow (official compaction owns it); EC records needLargerContext requirement → retry");
{
  const compactNowCalls = [];
  const agent = makeAgent({ compactNow: async () => { compactNowCalls.push("called"); return { ok: true }; } });
  const ctx = makeHostCtx([agent]);
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  const handler = ctx._listeners.find((l) => l.e === "agent/request-error").h;
  const outcome = await handler(
    { agent, failure: { code: "400", message: "Input token exceed the limit" }, provider: "opencode", model: "deepseek-v4-flash" },
    async () => ({ kind: "no-retry" })
  );
  assert(outcome && outcome.kind === "retry", "CONTEXT_OVERFLOW -> retry action", JSON.stringify(outcome));
  // Phase 02 R4 (Step 5): EC must NOT hand-call compactNow(undefined) — the
  // official compaction-basic owns the compact->retry layer.
  assert(compactNowCalls.length === 0, "compactNow NOT hand-called by EC (official compaction owns it)", `got ${compactNowCalls.length}`);
  const it = plugin._test.store.get(agent.session.id);
  assert(it && it.state === "RETRYING", "session RETRYING after overflow", it ? `got ${it.state}` : "no intent");
  // EC records a needLargerContext recovery requirement for the Router.
  assert(it && it.pendingFallback && it.pendingFallback.needLargerContext === true,
    "EC records needLargerContext requirement (Router decides model)", it && it.pendingFallback ? it.pendingFallback.reason : "none");
}

section("C3: agent compaction unavailable → COMPACTION_UNAVAILABLE → safe fallback, Host survives");
{
  const agent = makeAgent(undefined); // 无 compaction
  const ctx = makeHostCtx([agent]);
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  const handler = ctx._listeners.find((l) => l.e === "agent/request-error").h;
  const outcome = await handler(
    { agent, failure: { code: "400", message: "Input token exceed the limit" }, provider: "opencode", model: "deepseek-v4-flash" },
    async () => ({ kind: "no-retry" })
  );
  // compaction 不可用 → 仍 retry（走 larger-context fallback 或 budget 内 retry）
  assert(outcome && outcome.kind === "retry", "no compaction -> retry (fallback path)", JSON.stringify(outcome));
  assert(plugin.diagnostics().ready === true, "Host survives (fail-open)");
}

section("C4: compactNow throws → catch/isolate → no Host crash");
{
  const agent = makeAgent({ compactNow: async () => { throw new Error("compact engine exploded"); } });
  const ctx = makeHostCtx([agent]);
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  const handler = ctx._listeners.find((l) => l.e === "agent/request-error").h;
  let threw = false;
  let outcome;
  try {
    outcome = await handler(
      { agent, failure: { code: "400", message: "Input token exceed the limit" }, provider: "opencode", model: "deepseek-v4-flash" },
      async () => ({ kind: "no-retry" })
    );
  } catch { threw = true; }
  assert(threw === false, "compactNow throw isolated (handler did not throw)");
  assert(outcome && outcome.kind === "retry", "handler still returns retry after compact throw", JSON.stringify(outcome));
  assert(plugin.diagnostics().ready === true, "Host survives compact throw");
}

section("C5: multi-agent isolation — A has compaction, B does not, no cross-pollution");
{
  const compactNowCalls = [];
  const agentA = makeAgent({ compactNow: async () => { compactNowCalls.push("A"); return { ok: true }; } });
  const agentB = makeAgent(undefined); // 无 compaction
  const ctx = makeHostCtx([agentA, agentB]);
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  const { getCompaction, compactionAvailable } = plugin._test;
  assert(compactionAvailable(ctx, agentA) === true, "agent A has compaction");
  assert(compactionAvailable(ctx, agentB) === false, "agent B has no compaction (not polluted by A)");
  const compB = getCompaction(ctx, agentB);
  assert(compB === null || compB === undefined, "getCompaction(agentB) returns none");
  // A 的 compact 不受 B 影响
  const handler = ctx._listeners.find((l) => l.e === "agent/request-error").h;
  await handler(
    { agent: agentA, failure: { code: "400", message: "Input token exceed the limit" }, provider: "opencode", model: "deepseek-v4-flash" },
    async () => ({ kind: "no-retry" })
  );
  // Phase 02 R4 (Step 5): EC does NOT hand-call compactNow (0 calls expected);
  // A's requirement is recorded per-session and does NOT pollute agent B.
  assert(compactNowCalls.length === 0, "EC does not hand-call compactNow (official compaction owns it)", `got ${compactNowCalls.length}`);
  const itA = plugin._test.store.get(agentA.session.id);
  assert(itA && itA.pendingFallback && itA.pendingFallback.needLargerContext === true, "agent A requirement recorded", itA && itA.pendingFallback ? itA.pendingFallback.reason : "none");
  const itB = plugin._test.store.get(agentB.session.id);
  assert(!itB || !itB.pendingFallback, "agent B has no requirement (no cross-pollution)");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
