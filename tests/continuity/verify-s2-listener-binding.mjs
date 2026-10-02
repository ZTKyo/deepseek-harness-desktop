// verify-s2-listener-binding.mjs — S2 (silent listener no-op) verification.
//
// Claim under test (AL1 finding, S2 scope):
//   The execution-continuity second-layer fallback `ctx.on('session/event', (payload) => { const ev =
//   payload?.event; ... })` read `undefined` on BOTH official substrates — the listener was INERT and
//   nothing in the health surface said so.
//
// What this file proves, in order:
//   1. INERT (the defect is real) — the OLD single-parameter body, replayed against the official
//      0.2.0-rc.2 argument list, yields no event and therefore no action. Same for the OLD
//      `agent/created` two-argument carrier form.
//   2. BOUND (the fix works) — with the shared shape picker, the SAME official argument list drives
//      the real plugin handler to a real state transition (RECOVERY_QUEUED), and the 0.1.1
//      carrier-first form does the same, so both bases are covered.
//   3. FAIL-SAFE (a future base switch cannot be silent) — an argument shape matching nothing is
//      reported as LISTENER_BINDING_FAILED instead of returning quietly.
//
// Exit 0 = all checks PASS. No network, no service, no production state dir touched.
import { apply } from "../../plugins/execution-continuity.mjs";
import {
  pickSessionEvent, pickAgentError, pickAgentCreated, createBindingDiagnostics, SHAPE, BINDING_STATE,
} from "../../plugins/event-shape-compat.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let ok = true;
const check = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) ok = false; };

const SID = "s2-sess-1";
const OVERFLOW_ERROR = { code: "quota_limit_reached", message: "Input token exceed the limit, current token count: 999999" };
const turnEndError = () => ({ type: "turn/end", data: { reason: { kind: "error", error: OVERFLOW_ERROR } } });

// ── 1. INERT: the old bindings, replayed exactly as they were written ─────────
// Old body: ctx.on('session/event', (payload) => { const ev = payload && payload.event; if (!ev || ...) return; })
const oldSessionEventHandler = (...args) => {
  const payload = args[0];                       // 0.2.0-rc.2 delivers (session, event) here
  const ev = payload && payload.event;           // undefined on both substrates
  return ev ?? null;
};
const officialArgs = [{ id: SID }, turnEndError()];
const legacyArgs = [{ /* carrier */ }, { id: SID }, turnEndError()];
check("INERT proof: old (payload) session/event handler sees NO event on official (session,event) args",
  oldSessionEventHandler(...officialArgs) === null);
check("INERT proof: old (payload) session/event handler sees NO event on 0.1.1 (carrier,session,event) args",
  oldSessionEventHandler(...legacyArgs) === null);

// Old context-memory binding: ctx.on('agent/created', (carrier, _eventName, payload) => { const {agent} = payload })
const oldAgentCreatedHandler = (...args) => { const { agent } = args[2] ?? {}; return agent ?? null; };
check("INERT proof: old (carrier,name,payload) agent/created handler sees NO agent on official (payload) arg",
  oldAgentCreatedHandler({ agent: { id: "a1" }, source: "s" }) === null);

// ── 2. The picker accepts every real substrate shape ─────────────────────────
const pOfficial = pickSessionEvent(officialArgs);
check("pick session/event official (session,event) -> positional2",
  pOfficial.shape === SHAPE.POSITIONAL2 && pOfficial.event?.type === "turn/end" && pOfficial.session?.id === SID);
const pLegacy = pickSessionEvent(legacyArgs);
check("pick session/event 0.1.1 (carrier,session,event) -> carrier-first",
  pLegacy.shape === SHAPE.CARRIER_FIRST && pLegacy.event?.type === "turn/end" && pLegacy.session?.id === SID);
const pWrapped = pickSessionEvent([{}, "session/event", { sessionId: SID, event: turnEndError() }]);
check("pick session/event named-wrapper (carrier,'session/event',{sessionId,event}) -> payload-wrapped",
  pWrapped.shape === SHAPE.PAYLOAD_WRAPPED && pWrapped.event?.type === "turn/end");
check("pick session/event object-wrapper ({session,event}) -> payload-wrapped",
  pickSessionEvent([{ session: { id: SID }, event: turnEndError() }]).shape === SHAPE.PAYLOAD_WRAPPED);
const pUnknown = pickSessionEvent(["nonsense", 42]);
check("pick session/event unknown shape -> UNKNOWN + observed descriptor (never silent)",
  pUnknown.shape === SHAPE.UNKNOWN && pUnknown.event === undefined && Array.isArray(pUnknown.observed));

check("pick agent/error official (payload) -> payload-arg0",
  pickAgentError([{ agent: {}, turn: 1, step: 2, error: new Error("x") }]).shape === SHAPE.PAYLOAD_ARG0);
check("pick agent/error 0.1.1 carrier-first -> carrier-first",
  pickAgentError([{}, "agent/error", { agent: {}, error: new Error("x") }]).shape === SHAPE.CARRIER_FIRST);
check("pick agent/error malformed -> UNKNOWN",
  pickAgentError([{}, "agent/error"]).shape === SHAPE.UNKNOWN);
check("pick agent/created official (payload) -> payload-arg0",
  pickAgentCreated([{ agent: { id: "a1" }, source: "s" }]).agent?.id === "a1");
check("pick agent/created 0.1.1 carrier-first -> carrier-first",
  pickAgentCreated([{}, "agent/created", { agent: { id: "a2" } }]).agent?.id === "a2");

// ── 3. BOUND: the real plugin handler acts on BOTH official shapes ───────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s2-bind-"));
try {
  const handlers = {};
  const logs = [];
  const ctx = {
    logger: { info: (m) => logs.push(`info:${m}`), warn: (m) => logs.push(`warn:${m}`), error: (m) => logs.push(`error:${m}`) },
    on: (name, fn) => { (handlers[name] ||= []).push(fn); return () => {}; },
    effect: () => () => {},
    agents: { resume: async () => ({ session: { events: [] } }), get: () => null, list: () => [] },
    goals: { get: () => null, resume: () => {} },
    sessions: { flush: async () => {} },
    compaction: { compactNow: async () => ({ ok: true }) },
    llm: { providers: {} },
  };
  const plugin = apply(ctx, { stateDir: tmp, enableAutoResume: false });
  const store = plugin._test.store;

  check("S2 self-test at startup passes (both substrate shapes + malformed rejection)",
    plugin._test.shapeSelfTest?.pass === true);
  check("S2 self-test logged explicitly (not silent)",
    logs.some((l) => l.includes("picker self-test PASS")));

  const fire = (args) => { for (const h of handlers["session/event"] || []) h(...args); };

  // (a) official 0.2.0-rc.2 shape must now drive the previously-dead fallback
  fire(officialArgs);
  check("BOUND: official (session,event) turn/end error -> RECOVERY_QUEUED",
    store.ensure(SID).state === "RECOVERY_QUEUED");

  // (b) 0.1.1 carrier-first shape must drive it as well (rollback-safe)
  const SID2 = "s2-sess-2";
  fire([{}, { id: SID2 }, turnEndError()]);
  check("BOUND: 0.1.1 (carrier,session,event) turn/end error -> RECOVERY_QUEUED",
    store.ensure(SID2).state === "RECOVERY_QUEUED");

  // (c) binding state is observable for probes — the running substrate's real shape is logged
  const bind = plugin._test.bindingState();
  check("BINDING STATE: session/event bound and reported as the matched shape",
    bind["session/event"]?.state === BINDING_STATE.RECOGNIZED &&
    [SHAPE.POSITIONAL2, SHAPE.CARRIER_FIRST].includes(bind["session/event"]?.shape));

  // (d) an unknown shape is a VISIBLE failure, never a silent no-op
  const SID3 = "s2-sess-3";
  fire(["totally", "unknown", 7]);
  const bindAfter = plugin._test.bindingState();
  check("FAIL-SAFE: unknown session/event shape reported LISTENER_BINDING_FAILED",
    bindAfter["session/event"]?.state === BINDING_STATE.LISTENER_BINDING_FAILED);
  check("FAIL-SAFE: unknown shape performs NO state transition (no false success)",
    store.ensure(SID3).state !== "RECOVERY_QUEUED");
  check("FAIL-SAFE: the failure is logged with the observed shape",
    logs.some((l) => l.startsWith("warn:") && l.includes("LISTENER_BINDING_FAILED") && l.includes("observed=")));
  check("PRIVACY: binding diagnostics carry shapes only (no session ids / no payload values)",
    (() => {
      // Only the lines emitted by the shape-diagnostics module are in scope here (the plugin's own
      // pre-existing diag lines legitimately carry a session id, which is not a secret).
      const shapeLines = logs.filter((l) => l.includes("[execution-continuity]") &&
        (l.includes("event binding") || l.includes("LISTENER_BINDING_FAILED") || l.includes("picker self-test")));
      const leaked = shapeLines.filter((l) => l.includes(SID) || l.includes("quota_limit_reached") || l.includes("999999"));
      if (leaked.length) console.log("  leaked:", leaked);
      return shapeLines.length >= 2 && leaked.length === 0;
    })());

  // (e) agent/error listener also binds on the official payload-arg0 shape
  for (const h of handlers["agent/error"] || []) {
    h({ agent: { session: { id: "s2-agent" } }, turn: 1, step: 1, error: new Error("boom") });
  }
  const agentIntent = store.ensure("s2-agent");
  check("BOUND: agent/error official payload-arg0 -> failure recorded on the intent",
    agentIntent.lastFailure?.category === "agent-error");
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
}

console.log(ok ? "\nS2 LISTENER BINDING: ALL PASS" : "\nS2 LISTENER BINDING: FAILURES PRESENT");
process.exit(ok ? 0 : 1);
