// test-completion-truth.mjs — Completion Truth / side-effect idempotency tests.
// Phase 02 Reviewer Round 2 (BLOCKING-5): the test imports the PRODUCTION pure
// module (plugins/completion-truth-core.mjs) — NO duplicated algorithm.
// Verifies fail-closed semantics:
//   - side-effect tool-call WITHOUT result -> needs_verification
//   - read-only tool -> clean
//   - result present -> clean (no unresolved side effect)
//   - unknown/mutating tool without result -> needs_verification
//   - events unavailable -> needs_verification (fail-closed)
import { evaluateCompletion } from '../../plugins/completion-truth-core.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log("PASS  " + name + (detail ? "  " + detail : "")); pass++; }
  else { console.log("FAIL  " + name + (detail ? "  " + detail : "")); fail++; }
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
check("A write without result -> needs_verification", evaluateCompletion([mkCall("write", "call-1", 1)]).state === "needs_verification");
// A2. Read-only tool (read) is NOT a side effect -> clean
check("A2 read-only tool -> clean", evaluateCompletion([mkCall("read", "call-r", 1)]).state === "clean");
// B. tool-call issued, result UNKNOWN -> needs_verification
check("B browser_click without result -> needs_verification", evaluateCompletion([mkCall("browser_click", "call-2", 2)]).state === "needs_verification");
// C. result EXISTS -> clean (no unresolved side effect)
check("C write with result -> clean", evaluateCompletion([mkCall("write", "call-3", 3), mkResult("call-3", 3)]).state === "clean");
// C2. newest side-effect resolved, older unresolved -> needs_verification
check("C2 newest edit unresolved -> needs_verification", evaluateCompletion([mkCall("write", "call-old", 1), mkResult("call-old", 1), mkCall("edit", "call-new", 4)]).state === "needs_verification");
// D. restart: same side-effect NOT replayed when result exists; re-issue without result flagged
check("D pre-restart write has result -> clean", evaluateCompletion([mkCall("write", "call-4", 5), mkResult("call-4", 5)]).state === "clean");
check("D re-issued write without result -> needs_verification", evaluateCompletion([mkCall("write", "call-4", 5), mkResult("call-4", 5), mkCall("write", "call-4b", 7)]).state === "needs_verification");
// E. No tool-calls -> clean
check("E empty events -> clean", evaluateCompletion([]).state === "clean");
// F. read-only + completed side effect -> clean
check("F read-only + completed side effect -> clean", evaluateCompletion([mkCall("read", "call-r2", 1), mkCall("pwsh", "call-5", 6), mkResult("call-5", 6)]).state === "clean");
// G. UNKNOWN mutating tool (not in read-only allowlist) without result -> needs_verification (fail-closed)
check("G unknown tool without result -> needs_verification", evaluateCompletion([mkCall("some_new_mutating_tool", "call-u", 9)]).state === "needs_verification");
// H. events unavailable (not an array) -> needs_verification (fail-closed)
check("H events unavailable -> needs_verification", evaluateCompletion(null).state === "needs_verification");
// ── Phase 02 R4 (Step 4): exact-identity collision tests ──
// I. TWO tool-calls in the SAME turn; result matches ONLY the other call ->
//    the unresolved side effect must NOT be "proven" by the sibling result.
{
  const events = [
    { type: "assistant/message", data: { turn: 10, message: { content: [
      { type: "tool-call", name: "write", id: "call-w" },
      { type: "tool-call", name: "read", id: "call-r" },
    ] } } },
    { type: "tool/result", data: { turn: 10, tool_call_id: "call-r" } }, // read result, same turn
  ];
  check("I same-turn sibling result does NOT prove write -> needs_verification", evaluateCompletion(events).state === "needs_verification");
}
// I2. Two side-effect calls same turn; result for call-A only -> call-B unresolved
{
  const events = [
    { type: "assistant/message", data: { turn: 11, message: { content: [
      { type: "tool-call", name: "write", id: "call-a" },
      { type: "tool-call", name: "edit", id: "call-b" },
    ] } } },
    { type: "tool/result", data: { turn: 11, tool_call_id: "call-a" } },
  ];
  check("I2 call-b unresolved despite same-turn call-a result -> needs_verification", evaluateCompletion(events).state === "needs_verification");
}
// I3. exact result match (different turn) still works
{
  const events = [mkCall("write", "call-x", 1), mkResult("call-x", 2)];
  check("I3 exact callId match across turns -> clean", evaluateCompletion(events).state === "clean");
}
// I4. WRONG result id (no match) -> needs_verification
{
  const events = [mkCall("write", "call-y", 1), mkResult("call-z", 1)];
  check("I4 wrong result id -> needs_verification", evaluateCompletion(events).state === "needs_verification");
}
// I5. side-effect call WITHOUT id (missing identity) -> needs_verification
{
  const events = [{ type: "assistant/message", data: { turn: 3, message: { content: [{ type: "tool-call", name: "write" }] } } }];
  check("I5 missing call id -> needs_verification (fail-closed)", evaluateCompletion(events).state === "needs_verification");
}
// I6. EMPTY tool name -> needs_verification (fail-closed)
{
  const events = [{ type: "assistant/message", data: { turn: 4, message: { content: [{ type: "tool-call", name: "", id: "call-e" }] } } }];
  check("I6 empty tool name -> needs_verification (fail-closed)", evaluateCompletion(events).state === "needs_verification");
}
// I7. read-only call WITHOUT id is still safe (not a side effect)
{
  const events = [{ type: "assistant/message", data: { turn: 5, message: { content: [{ type: "tool-call", name: "read" }] } } }];
  check("I7 read-only without id -> clean (safe)", evaluateCompletion(events).state === "clean");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("COMPLETION TRUTH TEST FAILED"); process.exit(1); }
console.log("COMPLETION TRUTH TEST PASSED");
