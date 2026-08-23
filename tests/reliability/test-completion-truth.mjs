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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("COMPLETION TRUTH TEST FAILED"); process.exit(1); }
console.log("COMPLETION TRUTH TEST PASSED");
