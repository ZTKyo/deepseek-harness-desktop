// completion-truth-core.mjs — Deterministic Completion Truth (pure module).
// Phase 02 Reviewer Round 2 (BLOCKING-5): the side-effect idempotency decision
// lives HERE as a pure, importable module. The production plugin (EC) AND the
// tests import this exact module — no duplicated algorithm, no renamed copy.
//
// Contract:
//   evaluateCompletion(events) -> { state: "clean" | "needs_verification", detail? }
//     - "clean"               : no unresolved side-effecting tool-call
//                               (every side-effect call has a matching result, or none exist)
//     - "needs_verification"  : a side-effecting tool-call is present WITHOUT a
//                               matching result, OR events are unreadable/parse-error,
//                               OR an unknown mutating tool is seen. Fail-closed.
//
// Side-effect policy is a conservative ALLOWLIST: tools KNOWN to be read-only /
// idempotent are excluded from the side-effect set; everything else is treated
// as potentially mutating and therefore requires a matching result before a
// resume may proceed.

// Read-only / idempotent tools (safe to resume without a result).
const READONLY_TOOLS = [
  "read", "grep", "glob", "web_search", "browser_info", "browser_labels",
  "browser_shot", "list_agents", "job_list", "job_output", "get_goal",
  "secret_status", "ask_user_question", "skill",
];

// Tools whose result is KNOWN benign/verifiable or which are lookups:
// (ask_user_question is a prompt, not a side effect on external state.)
const SAFE_RESULTLESS = new Set(READONLY_TOOLS);

function isSideEffect(callName) {
  if (!callName) return false;
  return !SAFE_RESULTLESS.has(callName);
}

function extractCall(event) {
  const data = event && event.data ? event.data : {};
  if (event.type === "tool/result") return null;
  if (event.type !== "assistant/message") return null;
  const content = data.message && Array.isArray(data.message.content) ? data.message.content : [];
  const tc = content.find((b) => b && (b.type === "tool-call" || b.type === "function_call"));
  if (!tc) return null;
  return {
    name: String(tc.name || tc.function?.name || ""),
    id: tc.id || tc.tool_call_id || tc.call_id || tc.function?.call_id || null,
    turn: data.turn ?? null,
  };
}

function resultMatches(call, event) {
  if (!event || event.type !== "tool/result") return false;
  const d2 = event.data || {};
  const rid = d2.tool_call_id || d2.toolCallId || d2.call_id || d2.id ||
    (d2.message && d2.message.source && d2.message.source.callId) ||
    (d2.result && (d2.result.tool_call_id || d2.result.call_id));
  if (call.id && rid && String(rid) === String(call.id)) return true;
  if (call.turn !== null && d2.turn === call.turn) return true;
  return false;
}

/**
 * Evaluate completion truth over an event log.
 * @param {Array} events - session event log (assistant/message + tool/result entries)
 * @returns {{state: string, detail?: string}}
 */
export function evaluateCompletion(events) {
  if (!Array.isArray(events)) {
    return { state: "needs_verification", detail: "events unavailable (not an array)" };
  }
  let sawEvent = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const call = extractCall(events[i]);
    if (!call) continue;
    sawEvent = true;
    if (!isSideEffect(call.name)) continue; // read-only: safe
    const hasResult = events.some((ev) => resultMatches(call, ev));
    if (!hasResult) {
      return { state: "needs_verification", detail: `${call.name} (id=${call.id || "?"}) without result` };
    }
    // has result -> completed; scan older for any unresolved side-effect
  }
  if (!sawEvent) {
    // No tool-calls at all: nothing outstanding — clean.
    return { state: "clean" };
  }
  return { state: "clean" };
}

export default { evaluateCompletion, isSideEffect };
