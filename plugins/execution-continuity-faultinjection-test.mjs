// execution-continuity-faultinjection-test.mjs — PHASE2 故障注入测试（2026-08-23）
//
// 在 mock ctx 上验证 agent/request-error 恢复决策路径，覆盖任务书 TEST 2-9：
//   TEST 2  TIMEOUT/ETIMEDOUT → RETRYABLE_TRANSIENT → bounded retry
//   TEST 3  ECONNRESET/socket hang up → RETRYABLE_TRANSIENT → bounded retry
//   TEST 4  429 + Retry-After → RATE_LIMIT → bounded backoff
//   TEST 5  500/502/503/504 → PROVIDER_OUTAGE → fallback
//   TEST 6  quota → QUOTA_EXHAUSTED → fallback（不撞同一 provider）
//   TEST 7  model not found → MODEL_UNAVAILABLE → fallback
//   TEST 8  reasoning_content → REASONING_PROTOCOL_ERROR → repair retry, not blind
//   TEST 9  Input token exceed → CONTEXT_OVERFLOW → COMPACTION_UNAVAILABLE → fallback/FAILED_RECOVERABLE
//
// 运行：node execution-continuity-faultinjection-test.mjs
// 退出码 0 = 全 PASS

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ec-faultinject-"));
const MOD = await import(pathToFileURL(path.join(__dirname, "execution-continuity.mjs")).href);

let pass = 0, fail = 0;
const failures = [];
function assert(cond, name, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name + (detail ? ` :: ${detail}` : "")); console.log(`  FAIL  ${name} ${detail}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

function makeMockCtx({ withCompaction = false } = {}) {
  const listeners = [];
  const services = {};
  if (withCompaction) services.compaction = { compactNow: async () => ({ ok: true }) };
  services.agents = {};
  services.goals = { get: () => ({ id: "g1", phase: "active" }) };
  services.sessions = {};
  services.llm = {
    providers: {
      opencode: { models: [{ id: "deepseek-v4-flash", contextWindow: 1000000 }, { id: "deepseek-v4-pro", contextWindow: 1000000 }] },
      openrouter: { models: [{ id: "deepseek/deepseek-v4-flash-0731", contextWindow: 1310720 }, { id: "xiaomi/mimo-v2.5", contextWindow: 1050000 }] },
    },
  };
  const raw = {
    logger: { info() {}, warn() {}, error() {} },
    _listeners: listeners,
    get(name) { return services[name] === undefined ? undefined : services[name]; },
    read(name) { return services[name]; },
    on(event, handler) { listeners.push({ event, handler }); return () => { const i = listeners.findIndex((l) => l.event === event && l.handler === handler); if (i >= 0) listeners.splice(i, 1); }; },
    effect(generator) {
      const it = generator();
      const first = it.next();
      if (!first.done) { const second = it.next(); raw._dispose = typeof second.value === "function" ? second.value : () => {}; }
    },
  };
  return new Proxy(raw, {
    get(t, p, r) { if (p in t) return Reflect.get(t, p, r); if (p in services) return services[p]; return undefined; },
  });
}

const { classifyFailure, CATEGORY, hasBudget } = await import(pathToFileURL(path.join(__dirname, "execution-continuity-core.mjs")).href);

async function runRequestError(ctx, sid, failure, provider, model) {
  const handler = ctx._listeners.find((l) => l.event === "agent/request-error")?.handler;
  if (!handler) throw new Error("no agent/request-error handler");
  return await handler(
    { agent: { session: { id: sid } }, failure, provider, model },
    async () => ({ kind: "no-retry" })
  );
}

// ═══════════════════════════════════════════════════════════════════════
section("TEST 2+3: TIMEOUT / TRANSPORT → RETRYABLE_TRANSIENT → bounded retry");
{
  const ctx = makeMockCtx();
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  // 每个 fault 用独立 session + 独立 (provider,model) 避免 circuit breaker 干扰
  const cases = [
    ["ETIMEDOUT", { code: "ETIMEDOUT", message: "connect ETIMEDOUT" }],
    ["ECONNRESET", { code: "ECONNRESET", message: "socket hang up" }],
    ["ECONNREFUSED", { code: "ECONNREFUSED", message: "connect ECONNREFUSED" }],
    ["keepalive", { code: "ECONNRESET", message: "other side closed" }],
  ];
  for (const [name, f] of cases) {
    const cls = classifyFailure(f);
    assert(cls.category === CATEGORY.RETRYABLE_TRANSIENT, `${name} -> RETRYABLE_TRANSIENT`, `got ${cls.category}`);
    const outcome = await runRequestError(ctx, "sess-" + name, f, "opencode", "deepseek-v4-flash-" + name);
    assert(outcome && outcome.kind === "retry", `${name} recovery -> retry action`, JSON.stringify(outcome));
  }
  const diag = plugin.diagnostics();
  assert(diag.ready === true, "plugin survives timeout storms");
  // Circuit breaker：同一 (provider,model) 连续失败达到阈值 → canUse=false（断路器正确行为）
  const { createCircuitBreaker } = await import(pathToFileURL(path.join(__dirname, "execution-continuity-core.mjs")).href);
  const br = createCircuitBreaker(60000, 3);
  br.recordFailure("p", "m"); br.recordFailure("p", "m"); br.recordFailure("p", "m");
  assert(br.canUse("p", "m") === false, "circuit breaker opens after 3 consecutive failures");
}

// ═══════════════════════════════════════════════════════════════════════
section("TEST 4: 429 + Retry-After → RATE_LIMIT → bounded backoff");
{
  const ctx = makeMockCtx();
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  const f = { code: "429", message: "rate limit exceeded", providerRetryAfterMs: 5000 };
  const cls = classifyFailure(f);
  assert(cls.category === CATEGORY.RATE_LIMIT, "429 -> RATE_LIMIT", `got ${cls.category}`);
  assert(cls.providerRetryAfterMs === 5000, "Retry-After respected (5000ms)", `got ${cls.providerRetryAfterMs}`);
  const outcome = await runRequestError(ctx, "sess-429", f, "opencode", "deepseek-v4-flash");
  assert(outcome && outcome.kind === "retry", "429 recovery -> retry with backoff", JSON.stringify(outcome));
  assert(plugin.diagnostics().ready === true, "plugin survives 429");
}

// ═══════════════════════════════════════════════════════════════════════
section("TEST 5: 5xx → PROVIDER_OUTAGE → compatible fallback");
{
  const ctx = makeMockCtx();
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  for (const code of ["500", "502", "503", "504"]) {
    const cls = classifyFailure({ code, message: "server error" });
    assert(cls.category === CATEGORY.PROVIDER_OUTAGE, `${code} -> PROVIDER_OUTAGE`, `got ${cls.category}`);
  }
  // 触发 fallback：fallbackCount 预算内 → 应 arm pendingFallback 并返回 retry
  const outcome = await runRequestError(ctx, "sess-5xx", { code: "503", message: "service unavailable" }, "opencode", "deepseek-v4-flash");
  assert(outcome && outcome.kind === "retry", "5xx recovery -> retry (fallback armed)", JSON.stringify(outcome));
  const it = plugin.diagnostics().intents["sess-5xx"];
  assert(it && it.state === "RETRYING", "5xx -> session RETRYING", it ? `got ${it.state}` : "no intent");
  // pendingFallback armed（BLOCKING-1: requirement-only — no provider/model decision by EC;
  // Router decides the actual fallback model on the next agent/request）
  const itRaw = plugin._test.store.get("sess-5xx");
  assert(itRaw && itRaw.pendingFallback && itRaw.pendingFallback.requirement === true && !itRaw.pendingFallback.provider,
    "5xx -> pendingFallback requirement armed (no EC model decision)", itRaw && itRaw.pendingFallback ? JSON.stringify(itRaw.pendingFallback) : "none");
}

// ═══════════════════════════════════════════════════════════════════════
section("TEST 6: quota → QUOTA_EXHAUSTED → fallback (not same-provider blind retry)");
{
  const ctx = makeMockCtx();
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  const f = { message: "You have exceeded your quota. Please check your plan and billing details." };
  const cls = classifyFailure(f);
  assert(cls.category === CATEGORY.QUOTA_EXHAUSTED, "quota -> QUOTA_EXHAUSTED", `got ${cls.category}`);
  const outcome = await runRequestError(ctx, "sess-quota", f, "opencode", "deepseek-v4-flash");
  assert(outcome && outcome.kind === "retry", "quota recovery -> retry (fallback armed)", JSON.stringify(outcome));
  const itRaw = plugin._test.store.get("sess-quota");
  assert(itRaw && itRaw.pendingFallback && itRaw.pendingFallback.requirement === true && !itRaw.pendingFallback.provider,
    "quota -> requirement armed (no EC model decision; not same-provider blind retry)", itRaw && itRaw.pendingFallback ? JSON.stringify(itRaw.pendingFallback) : "none");
}

// ═══════════════════════════════════════════════════════════════════════
section("TEST 7: model unavailable → MODEL_UNAVAILABLE → fallback");
{
  const ctx = makeMockCtx();
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  const f = { code: "404", message: "model not found: some-model" };
  const cls = classifyFailure(f);
  assert(cls.category === CATEGORY.MODEL_UNAVAILABLE, "model not found -> MODEL_UNAVAILABLE", `got ${cls.category}`);
  const outcome = await runRequestError(ctx, "sess-model", f, "opencode", "deepseek-v4-flash");
  assert(outcome && outcome.kind === "retry", "model unavailable -> retry (fallback armed)", JSON.stringify(outcome));
}

// ═══════════════════════════════════════════════════════════════════════
section("TEST 8: reasoning_content → REASONING_PROTOCOL_ERROR → repair retry (not blind)");
{
  const ctx = makeMockCtx();
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  const f = { code: "400", message: "The `reasoning_content` in the thinking mode must be passed back to the API." };
  const cls = classifyFailure(f);
  assert(cls.category === CATEGORY.REASONING_PROTOCOL_ERROR, "reasoning_content -> REASONING_PROTOCOL_ERROR", `got ${cls.category}`);
  // 第一次：budget 内 → repair retry（不是 FAILED_FATAL 盲停）
  const outcome = await runRequestError(ctx, "sess-reason", f, "opencode", "deepseek-v4-flash");
  assert(outcome && outcome.kind === "retry", "reasoning -> retry (repair attempt)", JSON.stringify(outcome));
  const it = plugin.diagnostics().intents["sess-reason"];
  assert(it && it.state === "RETRYING", "reasoning -> RETRYING", it ? `got ${it.state}` : "no intent");
}

// ═══════════════════════════════════════════════════════════════════════
section("TEST 9: Input token exceed → CONTEXT_OVERFLOW → COMPACTION_UNAVAILABLE → safe fallback");
{
  const ctx = makeMockCtx({ withCompaction: false }); // compaction absent（web 平面）
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  const f = { code: "400", message: "Input token exceed the limit" };
  const cls = classifyFailure(f);
  assert(cls.category === CATEGORY.CONTEXT_OVERFLOW, "Input token exceed -> CONTEXT_OVERFLOW", `got ${cls.category}`);
  // 触发 handler：compaction 不可用 → COMPACT-UNAVAILABLE 路径 → 仍 retry（fallback/larger-context）
  const outcome = await runRequestError(ctx, "sess-ctx", f, "opencode", "deepseek-v4-flash");
  assert(outcome && outcome.kind === "retry", "ctx overflow -> retry (COMPACT-UNAVAILABLE path)", JSON.stringify(outcome));
  assert(plugin.diagnostics().compactionAvailable === false, "compactionAvailable=false (degraded, not crash)");
  assert(plugin.diagnostics().ready === true, "Host survives context overflow without compaction");
}

// ═══════════════════════════════════════════════════════════════════════
section("TEST 10: budgets bounded — no infinite retry (纯预算逻辑验证)");
{
  const ctx = makeMockCtx();
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: true });
  const { store, STATE } = plugin._test;
  // 直接构造 intent 并验证 hasBudget 边界（不经 handler 的 sleep，避免超时）
  store.setState("sess-budget", STATE.RUNNING, {});
  const it = store.get("sess-budget");
  // retry budget = 3
  it.retryCount = 3;
  assert(hasBudget("retry", it, { ...(await import(pathToFileURL(path.join(__dirname, "execution-continuity-core.mjs")).href)).DEFAULT_BUDGETS, sameModelRetries: 3 }) === false,
    "retryCount=3 >= sameModelRetries=3 -> no more retry budget");
  it.retryCount = 2;
  assert(hasBudget("retry", it, { ...(await import(pathToFileURL(path.join(__dirname, "execution-continuity-core.mjs")).href)).DEFAULT_BUDGETS, sameModelRetries: 3 }) === true,
    "retryCount=2 < sameModelRetries=3 -> retry budget remains");
  // fallback budget = 2
  it.fallbackCount = 2;
  const budgets = (await import(pathToFileURL(path.join(__dirname, "execution-continuity-core.mjs")).href)).DEFAULT_BUDGETS;
  assert(hasBudget("fallback", it, budgets) === false, "fallbackCount=2 >= 2 -> no more fallback");
  // auto-resume budget = 10
  it.autoResumeCycles = 10;
  assert(hasBudget("auto-resume", it, budgets) === false, "autoResumeCycles=10 >= 10 -> no more auto-resume");
  assert(plugin.diagnostics().ready === true, "plugin survives budget exhaustion (no crash)");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
console.log("ALL FAULT-INJECTION TESTS PASSED");
process.exit(0);
