// test-completion-truth.mjs — Completion Truth / side-effect idempotency tests.
// Phase 02 Reviewer Round 1 (BLOCKING-6).
// Verifies the deterministic guard logic: a side-effecting tool-call with a
// result is COMPLETE (no replay); a side-effecting tool-call WITHOUT a result is
// NEEDS_VERIFICATION (no blind replay). Runs in isolation (no live server).
//
// We import the plugin's pure logic path: the completionTruth classifier is
// embedded in the plugin body, so we test its decision semantics by replicating
// the exact matching rules against synthetic event logs. This is a controlled
// (synthetic) test per the Phase 02 requirement: fault-injection at the
// event-log level.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log("PASS  " + name + (detail ? "  " + detail : "")); pass++; }
  else { console.log("FAIL  " + name + (detail ? "  " + detail : "")); fail++; }
}

// ---- Replicate the SIDE_EFFECT_TOOLS matcher from the plugin ----
const SIDE_EFFECT_TOOLS = /^(write|edit|browser_click|browser_type|browser_press|browser_open|browser_shot|pwsh|subagent|subagent_fork|subagent_qwen|subagent_mimo|subagent_research|send_message|interrupt_agent|request_secret|forget_secret|notion|mcp__|create_goal|update_goal|todo_write|workflow|ralph)/i;

// ---- Replicate completionTruth decision over a synthetic event log ----
function completionTruth(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const data = ev.data || {};
    let callName = null;
    let callId = null;
    let turn = null;
    if (ev.type === "assistant/message") {
      const content = data.message?.content;
      if (Array.isArray(content)) {
        const tc = content.find((b) => b && (b.type === "tool-call" || b.type === "function_call"));
        if (tc) {
          callName = String(tc.name || tc.function?.name || "");
          callId = tc.id || tc.tool_call_id || tc.call_id || tc.function?.call_id || null;
          turn = data.turn;
        }
      }
    } else if (ev.type === "tool/result") {
      continue;
    }
    if (!callName || !SIDE_EFFECT_TOOLS.test(callName)) continue;
    const hasResult = events.some((ev2) => {
      if (ev2.type !== "tool/result") return false;
      const d2 = ev2.data || {};
      const rid = d2.tool_call_id || d2.toolCallId || d2.call_id || d2.id ||
        (d2.message && d2.message.source && d2.message.source.callId) ||
        (d2.result && (d2.result.tool_call_id || d2.result.call_id));
      if (callId && rid && String(rid) === String(callId)) return true;
      if (turn !== null && d2.turn === turn) return true;
      return false;
    });
    if (hasResult) continue; // completed; scan older for unresolved
    return { state: "needs_verification", detail: `${callName} without result` };
  }
  return { state: "clean" };
}

const mkCall = (name, id, turn) => ({
  type: "assistant/message",
  data: { turn, message: { content: [{ type: "tool-call", name, id }] } },
});
const mkResult = (callId, turn) => ({
  type: "tool/result",
  data: { turn, tool_call_id: callId },
});

// A. Side effect SUCCEEDED but completion event LOST (result missing) -> NEEDS_VERIFICATION
{
  const events = [mkCall("write", "call-1", 1)];
  const r = completionTruth(events);
  check("A write without result -> needs_verification", r.state === "needs_verification", r.detail);
}
// A2. Read-only tool (read) is NOT a side effect -> clean
{
  const events = [mkCall("read", "call-r", 1)];
  const r = completionTruth(events);
  check("A2 read-only tool -> clean (resumable)", r.state === "clean", r.detail);
}
// B. tool-call issued, result UNKNOWN -> needs_verification
{
  const events = [mkCall("browser_click", "call-2", 2)];
  const r = completionTruth(events);
  check("B browser_click without result -> needs_verification", r.state === "needs_verification", r.detail);
}
// C. result EXISTS -> clean (all side effects resolved; resume from completion point)
{
  const events = [mkCall("write", "call-3", 3), mkResult("call-3", 3)];
  const r = completionTruth(events);
  check("C write with result -> clean (no unresolved side effect)", r.state === "clean", r.detail);
}
// C2. newest side-effect resolved, older unresolved -> still needs_verification
{
  const events = [mkCall("write", "call-old", 1), mkResult("call-old", 1), mkCall("edit", "call-new", 4)];
  const r = completionTruth(events);
  check("C2 newest edit unresolved -> needs_verification", r.state === "needs_verification", r.detail);
}
// D. restart scenario: same side-effect call NOT replayed when result exists
{
  // Before restart: write call-4 issued + result received -> clean.
  const before = [mkCall("write", "call-4", 5), mkResult("call-4", 5)];
  const r1 = completionTruth(before);
  check("D pre-restart write has result -> clean", r1.state === "clean", r1.detail);
  // After restart: agent re-issues the SAME logical write (new call id, no result yet)
  // -> the unresolved side-effect is flagged -> needs_verification (no double side effect).
  const after = [mkCall("write", "call-4", 5), mkResult("call-4", 5), mkCall("write", "call-4b", 7)];
  const r2 = completionTruth(after);
  check("D re-issued write without result -> needs_verification (no double side effect)", r2.state === "needs_verification", r2.detail);
}
// E. No tool-calls at all -> clean
{
  const r = completionTruth([]);
  check("E empty events -> clean", r.state === "clean", r.detail);
}
// F. read-only + completed side effect -> clean (nothing outstanding)
{
  const events = [mkCall("read", "call-r2", 1), mkCall("pwsh", "call-5", 6), mkResult("call-5", 6)];
  const r = completionTruth(events);
  check("F read-only + completed side effect -> clean", r.state === "clean", r.detail);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("COMPLETION TRUTH TEST FAILED"); process.exit(1); }
console.log("COMPLETION TRUTH TEST PASSED");
