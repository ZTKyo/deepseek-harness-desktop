// test-ox-relay-failover.mjs — stealth/ox-alpha multi-relay same-model fallback
// deterministic tests (T1-T9). No real API keys, no network, no ~/.dsh.
//
// Imports the REPO CANONICAL sources (docs/execution-economy/plugins/), then
// drives the host plugin against a mock ctx to simulate the real
// agent/request + agent/request-error waterfall with dsh-llm-retry composition.
//
// Run: node tests/router/test-ox-relay-failover.mjs (from repo root)
// Exit: 0 = all PASS, 1 = any FAIL.

import { fileURLToPath } from "node:url";
import path from "node:path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginsDir = path.resolve(__dirname, "../../docs/execution-economy/plugins");
const core = await import("file:///" + path.join(pluginsDir, "ox-relay-core.mjs").split("\\").join("/"));
const { apply: applyPlugin } = await import("file:///" + path.join(pluginsDir, "ox-relay-failover.mjs").split("\\").join("/"));

const OX = "stealth/ox-alpha";
let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log("PASS  " + name + (detail ? "  " + detail : "")); pass++; }
  else { console.log("FAIL  " + name + (detail ? "  " + detail : "")); fail++; }
}

// ---- minimal mock ctx / agent / session ----
function makeHarness(chainEnv) {
  const handlers = {};
  const effects = [];
  const ctx = {
    on(event, cb) { handlers[event] = cb; },
    effect(fn) { effects.push(fn); },
    logger: { info() {}, warn() {} },
    effects,
  };
  const agent = { session: { id: "sess-1", events: [], append(type, data) { this.events.push({ type, data }); } } };
  const saved = process.env.OX_RELAY_CHAIN;
  if (chainEnv !== undefined) process.env.OX_RELAY_CHAIN = chainEnv;
  else delete process.env.OX_RELAY_CHAIN;
  const plugin = applyPlugin(ctx, {});
  if (chainEnv !== undefined) process.env.OX_RELAY_CHAIN = saved;
  return { ctx, plugin, agent, handlers, effects };
}
function cleanupHarness(h) { for (const fn of h.effects) { const d = fn(); if (typeof d === "function") d(); } }

const requestHandler = (h) => h.handlers["agent/request"];
const errorHandler = (h) => h.handlers["agent/request-error"];

async function doRequest(h, turn, seed) {
  return requestHandler(h)({ agent: h.agent, turn }, async () => ({ ...seed }));
}
async function doError(h, provider, failure, terminalAction = undefined) {
  return errorHandler(h)({ agent: h.agent, provider, failure }, async () => terminalAction);
}

function sessionEvents(h) { return h.agent.session.events.filter((e) => e.type === "ox-relay/failover"); }

// -------------------- core: failure classification --------------------
console.log("== core: failure classification ==");
check("RATE_LIMIT is provider failure", core.isProviderFailure({ code: "RATE_LIMIT", message: "429" }));
check("SERVER is provider failure", core.isProviderFailure({ code: "SERVER", message: "500" }));
check("TIMEOUT is provider failure", core.isProviderFailure({ code: "TIMEOUT", message: "timeout" }));
check("TRANSPORT is provider failure", core.isProviderFailure({ code: "TRANSPORT", message: "ECONNRESET" }));
check("message-based 429 classified", core.classifyFailure({ message: "Error: 429 Too Many Requests" }) === "RATE_LIMIT");
check("message-based econnreset classified", core.classifyFailure({ message: "fetch failed: connect ECONNRESET" }) === "TRANSPORT");
check("AUTH not provider failure", !core.isProviderFailure({ code: "AUTH", message: "401 unauthorized" }));
check("QUOTA not provider failure", !core.isProviderFailure({ code: "QUOTA", message: "insufficient quota" }));
check("UNKNOWN_MODEL not provider failure", !core.isProviderFailure({ code: "UNKNOWN_MODEL", message: "model not found" }));
check("EMPTY_RESPONSE not provider failure", !core.isProviderFailure({ code: "EMPTY_RESPONSE", message: "empty" }));
check("ABORTED not provider failure", !core.isProviderFailure({ code: "ABORTED", message: "aborted" }));
check("no-fallback category AUTH", core.isNoFallbackFailure({ code: "AUTH" }));
check("no-fallback category UNKNOWN_MODEL", core.isNoFallbackFailure({ code: "UNKNOWN_MODEL" }));

console.log("== core: chain / invariant / fail-closed ==");
check("default chain has 2 real relays", core.DEFAULT_RELAY_CHAIN.length === 2 && core.DEFAULT_RELAY_CHAIN[0] === "ox-relay-a" && core.DEFAULT_RELAY_CHAIN[1] === "ox-relay-b");
check("resolveChain default", JSON.stringify(core.resolveChain({})) === JSON.stringify(["ox-relay-a", "ox-relay-b"]));
check("resolveChain env override", JSON.stringify(core.resolveChain({ OX_RELAY_CHAIN: "x,y,z" })) === JSON.stringify(["x", "y", "z"]));
check("nextProvider A->B", core.nextProvider("ox-relay-a", ["ox-relay-a", "ox-relay-b"], ["ox-relay-a"]) === "ox-relay-b");
check("nextProvider B->null (end of 2-chain)", core.nextProvider("ox-relay-b", ["ox-relay-a", "ox-relay-b"], ["ox-relay-a", "ox-relay-b"]) === null);
check("nextProvider unknown failing -> first chain", core.nextProvider("weird", ["ox-relay-a", "ox-relay-b"], []) === "ox-relay-a");
check("record always has logical_model=ox-alpha", core.buildAttemptRecord({ model: OX, provider: "ox-relay-a", attempt: 1 }).logical_model === OX);
check("record final_model always ox-alpha", core.buildAttemptRecord({ model: OX, provider: "ox-relay-b", attempt: 2 }).final_model === OX);
const closed = core.failClosedError([{ provider: "ox-relay-a", failure_kind: "RATE_LIMIT" }, { provider: "ox-relay-b", failure_kind: "SERVER" }]);
check("fail-closed message includes exhausted marker", closed.message.includes("all ox-alpha relay attempts exhausted"), closed.message);
check("fail-closed message lists provider=kinds", closed.message.includes("ox-relay-a=RATE_LIMIT") && closed.message.includes("ox-relay-b=SERVER"));
check("fail-closed code", closed.code === "OX_ALPHA_RELAYS_EXHAUSTED");

// -------------------- T1: A success -> no fallback --------------------
console.log("");
console.log("== T1: A success -> no fallback ==");
{
  const h = makeHarness("ox-relay-a,ox-relay-b");
  const out = await doRequest(h, 1, { provider: "ox-relay-a", model: OX });
  check("request passes through with same provider+model", out.provider === "ox-relay-a" && out.model === OX, JSON.stringify(out));
  const evs = sessionEvents(h);
  check("attempt 1 recorded", evs.length === 1 && evs[0].data.attempt === 1 && evs[0].data.provider === "ox-relay-a");
  check("no armedNext after success", h.plugin.diagnostics().sessions["sess-1"].armedNext === null);
  cleanupHarness(h);
}

// -------------------- T2: A fail -> B success --------------------
console.log("");
console.log("== T2: A fail -> B success ==");
{
  const h = makeHarness("ox-relay-a,ox-relay-b");
  await doRequest(h, 1, { provider: "ox-relay-a", model: OX });
  const act = await doError(h, "ox-relay-a", { code: "RATE_LIMIT", message: "429 overloaded" });
  check("provider failure returns retry", act && act.kind === "retry");
  check("armedNext = ox-relay-b", h.plugin.diagnostics().sessions["sess-1"].armedNext === "ox-relay-b");
  const out2 = await doRequest(h, 1, { provider: "ox-relay-a", model: OX });
  check("retry rewrites provider to B, model unchanged", out2.provider === "ox-relay-b" && out2.model === OX, JSON.stringify(out2));
  const used = h.plugin.diagnostics().sessions["sess-1"].usedProviders;
  check("usedProviders = [A, B]", JSON.stringify(used) === JSON.stringify(["ox-relay-a", "ox-relay-b"]));
  check("attempt 2 recorded", sessionEvents(h).some((e) => e.data.attempt === 2 && e.data.provider === "ox-relay-b"));
  cleanupHarness(h);
}

// -------------------- T3: A fail -> B fail -> C success --------------------
console.log("");
console.log("== T3: A fail -> B fail -> C success ==");
{
  const h = makeHarness("ox-relay-a,ox-relay-b,ox-relay-c");
  await doRequest(h, 1, { provider: "ox-relay-a", model: OX });
  const a1 = await doError(h, "ox-relay-a", { code: "SERVER", message: "500" });
  check("A fail -> retry", a1?.kind === "retry");
  const o2 = await doRequest(h, 1, { provider: "ox-relay-a", model: OX });
  check("attempt2 provider B", o2.provider === "ox-relay-b" && o2.model === OX);
  const b1 = await doError(h, "ox-relay-b", { code: "TIMEOUT", message: "timeout" });
  check("B fail -> retry", b1?.kind === "retry");
  const o3 = await doRequest(h, 1, { provider: "ox-relay-a", model: OX });
  check("attempt3 provider C", o3.provider === "ox-relay-c" && o3.model === OX);
  const used = h.plugin.diagnostics().sessions["sess-1"].usedProviders;
  check("usedProviders = [A, B, C]", JSON.stringify(used) === JSON.stringify(["ox-relay-a", "ox-relay-b", "ox-relay-c"]));
  const evs = sessionEvents(h);
  check("attempt 1/2/3 all recorded with model=ox-alpha", evs.filter((e) => e.data.attempt >= 1 && e.data.attempt <= 3).every((e) => e.data.logical_model === OX && e.data.final_model === OX));
  cleanupHarness(h);
}

// -------------------- T4: all fail -> fail closed --------------------
console.log("");
console.log("== T4: A/B/C all fail -> fail closed ==");
{
  const h = makeHarness("ox-relay-a,ox-relay-b,ox-relay-c");
  await doRequest(h, 1, { provider: "ox-relay-a", model: OX });
  await doError(h, "ox-relay-a", { code: "RATE_LIMIT", message: "429" });
  await doRequest(h, 1, { provider: "ox-relay-a", model: OX });
  await doError(h, "ox-relay-b", { code: "SERVER", message: "500" });
  await doRequest(h, 1, { provider: "ox-relay-a", model: OX });
  let thrown = null;
  try { await doError(h, "ox-relay-c", { code: "TRANSPORT", message: "ECONNRESET" }); } catch (e) { thrown = e; }
  check("last relay failure throws fail-closed error", thrown !== null && thrown.code === "OX_ALPHA_RELAYS_EXHAUSTED");
  check("fail-closed message has exhausted marker", thrown && thrown.message.includes("all ox-alpha relay attempts exhausted"), thrown && thrown.message);
  check("fail-closed mentions all relays", thrown && thrown.message.includes("ox-relay-a") && thrown.message.includes("ox-relay-b") && thrown.message.includes("ox-relay-c"));
  check("fail-closed lists each provider's failure kind", thrown && thrown.message.includes("ox-relay-a=RATE_LIMIT") && thrown.message.includes("ox-relay-b=SERVER") && thrown.message.includes("ox-relay-c=TRANSPORT"), thrown && thrown.message);
  check("no fallback to other model in message", thrown && !/deepseek|mimo|qwen/i.test(thrown.message));
  const evs = sessionEvents(h);
  check("relays-exhausted event recorded", evs.some((e) => e.data.relay_exhausted === true));
  cleanupHarness(h);
}

// -------------------- T5: model identity invariant across attempts --------------------
console.log("");
console.log("== T5: every attempt model stays stealth/ox-alpha ==");
{
  const h = makeHarness("ox-relay-a,ox-relay-b,ox-relay-c");
  const seen = [];
  await doRequest(h, 1, { provider: "ox-relay-a", model: OX });
  await doError(h, "ox-relay-a", { code: "RATE_LIMIT", message: "429" });
  const o2 = await doRequest(h, 1, { provider: "ox-relay-a", model: OX });
  await doError(h, "ox-relay-b", { code: "SERVER", message: "500" });
  const o3 = await doRequest(h, 1, { provider: "ox-relay-a", model: OX });
  seen.push(o2.model, o3.model);
  for (const e of sessionEvents(h)) seen.push(e.data.logical_model, e.data.final_model, e.data.requested_model);
  check("all request/event models == stealth/ox-alpha", seen.every((m) => m === OX), JSON.stringify(seen));
  const diag = h.plugin.diagnostics().sessions["sess-1"];
  check("diagnostics never shows a different model", diag.lastModel === OX);
  cleanupHarness(h);
}

// -------------------- T6: UNKNOWN_MODEL no fallback --------------------
console.log("");
console.log("== T6: UNKNOWN_MODEL -> no cross-model / no cross-provider fallback ==");
{
  const h = makeHarness("ox-relay-a,ox-relay-b");
  await doRequest(h, 1, { provider: "ox-relay-a", model: OX });
  const act = await doError(h, "ox-relay-a", { code: "UNKNOWN_MODEL", message: "model stealth/ox-alpha not found" });
  check("UNKNOWN_MODEL returns no retry", act === undefined || act.kind !== "retry");
  check("armedNext stays null", h.plugin.diagnostics().sessions["sess-1"].armedNext === null);
  check("usedProviders unchanged (no provider switch)", JSON.stringify(h.plugin.diagnostics().sessions["sess-1"].usedProviders) === JSON.stringify(["ox-relay-a"]));
  check("no-fallback event recorded", sessionEvents(h).some((e) => e.data.failure_kind === "UNKNOWN_MODEL"));
  cleanupHarness(h);
}

// -------------------- T7: auth/access handled by definition --------------------
console.log("");
console.log("== T7: auth/access failure handled by definition (no silent switch) ==");
{
  const h = makeHarness("ox-relay-a,ox-relay-b");
  await doRequest(h, 1, { provider: "ox-relay-a", model: OX });
  const act401 = await doError(h, "ox-relay-a", { code: "AUTH", message: "401 unauthorized_client_error" });
  check("AUTH returns no retry", act401 === undefined || act401.kind !== "retry");
  const act402 = await doError(h, "ox-relay-a", { code: "QUOTA", message: "payment required: insufficient balance" });
  check("QUOTA returns no retry", act402 === undefined || act402.kind !== "retry");
  check("armedNext still null", h.plugin.diagnostics().sessions["sess-1"].armedNext === null);
  cleanupHarness(h);
}

// -------------------- T8: bounded retries --------------------
console.log("");
console.log("== T8: bounded retries (no retry explosion) ==");
{
  // llm-retry 语义：内建层返回 {kind:'retry'} 时，插件必须原样放行且不 arm 下一个 relay
  const h = makeHarness("ox-relay-a,ox-relay-b");
  await doRequest(h, 1, { provider: "ox-relay-a", model: OX });
  const act = await doError(h, "ox-relay-a", { code: "RATE_LIMIT", message: "429" }, { kind: "retry" });
  check("llm-retry retry passes through unchanged", act && act.kind === "retry");
  check("llm-retry in-budget does NOT arm next relay", h.plugin.diagnostics().sessions["sess-1"].armedNext === null);
  cleanupHarness(h);

  // 单次失败只产生一次 arm（每 provider 最多 1 次跨 relay 推进）
  const h2 = makeHarness("ox-relay-a,ox-relay-b");
  await doRequest(h2, 1, { provider: "ox-relay-a", model: OX });
  await doError(h2, "ox-relay-a", { code: "SERVER", message: "500" });
  const diag = h2.plugin.diagnostics().sessions["sess-1"];
  check("retry count bounded: armedNext only ever B", diag.armedNext === "ox-relay-b");
  cleanupHarness(h2);
}

// -------------------- T9: primary/settings isolation + state hygiene --------------------
console.log("");
console.log("== T9: primary/settings isolation + state hygiene ==");
{
  // 插件不改任何全局/primary 状态：只维护每会话内存态；turn 切换结构性复位
  const h = makeHarness("ox-relay-a,ox-relay-b");
  await doRequest(h, 1, { provider: "ox-relay-a", model: OX });
  await doError(h, "ox-relay-a", { code: "RATE_LIMIT", message: "429" });
  check("armed before new turn", h.plugin.diagnostics().sessions["sess-1"].armedNext === "ox-relay-b");
  // 新 turn 到来 -> 复位
  const out2 = await doRequest(h, 2, { provider: "ox-relay-a", model: OX });
  const diag = h.plugin.diagnostics().sessions["sess-1"];
  check("new turn resets armedNext", diag.armedNext === null);
  check("new turn resets usedProviders", JSON.stringify(diag.usedProviders) === JSON.stringify(["ox-relay-a"]));
  check("primary provider untouched by plugin", out2.provider === "ox-relay-a" && out2.model === OX);
  cleanupHarness(h);

  // 不同 session 状态隔离
  const h2 = makeHarness("ox-relay-a,ox-relay-b");
  const agent2 = { session: { id: "sess-other", events: [], append(type, data) { this.events.push({ type, data }); } } };
  await requestHandler(h2)({ agent: h2.agent, turn: 1 }, async () => ({ provider: "ox-relay-a", model: OX }));
  await errorHandler(h2)({ agent: h2.agent, provider: "ox-relay-a", failure: { code: "RATE_LIMIT", message: "429" } }, async () => undefined);
  await requestHandler(h2)({ agent: agent2, turn: 1 }, async () => ({ provider: "ox-relay-a", model: OX }));
  const d2 = h2.plugin.diagnostics().sessions;
  check("session A armed", d2["sess-1"].armedNext === "ox-relay-b");
  check("session B independent (no arm)", d2["sess-other"].armedNext === null);
  cleanupHarness(h2);

  // dispose 清空状态（无残留）
  const h3 = makeHarness("ox-relay-a,ox-relay-b");
  await requestHandler(h3)({ agent: h3.agent, turn: 1 }, async () => ({ provider: "ox-relay-a", model: OX }));
  cleanupHarness(h3);
  check("dispose clears session state", h3.plugin.diagnostics().sessions === null || Object.keys(h3.plugin.diagnostics().sessions).length === 0 || h3.plugin.state.size === 0);
}

// -------------------- non-ox-alpha requests never touched --------------------
console.log("");
console.log("== non-ox-alpha requests never touched (invariant guard) ==");
{
  const h = makeHarness("ox-relay-a,ox-relay-b");
  await requestHandler(h)({ agent: h.agent, turn: 1 }, async () => ({ provider: "ox-relay-a", model: "deepseek/deepseek-v4-flash" }));
  const diag = h.plugin.diagnostics().sessions["sess-1"];
  check("other model request: no tracking", diag.lastModel === null && diag.usedProviders.length === 0);
  const out = await requestHandler(h)({ agent: h.agent, turn: 1 }, async () => ({ provider: "openrouter", model: "deepseek/deepseek-v4-flash-0731" }));
  check("other model passes through untouched", out.provider === "openrouter" && out.model === "deepseek/deepseek-v4-flash-0731");
  cleanupHarness(h);
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
