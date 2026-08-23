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

// Phase 02 R4 (Step 4): extract ALL tool-calls in an event (a single
// assistant/message can contain several). Each call is evaluated independently;
// a sibling call's result must never prove this call's completion.
function extractCalls(event) {
  const data = event && event.data ? event.data : {};
  if (event.type === "tool/result") return [];
  if (event.type !== "assistant/message") return [];
  const content = data.message && Array.isArray(data.message.content) ? data.message.content : [];
  const out = [];
  for (const tc of content) {
    if (!tc || (tc.type !== "tool-call" && tc.type !== "function_call")) continue;
    const name = String(tc.name || tc.function?.name || "");
    const id = tc.id || tc.tool_call_id || tc.call_id || tc.function?.call_id || null;
    out.push({
      name,
      id,
      turn: data.turn ?? null,
      // unknown/empty identity is FAIL-CLOSED for side effects
      hasIdentity: !!(name && name.trim()) && !!id,
    });
  }
  return out;
}

// Phase 02 R4 (Step 4): EXACT callId/resultId match ONLY. The same-turn fallback
// is REMOVED — with multiple tool-calls in one turn, another tool's result must
// never "prove" completion for an unknown side effect. Without a reliable call
// identity, we fail-closed (no match).
function resultMatches(call, event) {
  if (!event || event.type !== "tool/result") return false;
  const d2 = event.data || {};
  const rid = d2.tool_call_id || d2.toolCallId || d2.call_id || d2.id ||
    (d2.message && d2.message.source && d2.message.source.callId) ||
    (d2.result && (d2.result.tool_call_id || d2.result.call_id));
  // exact callId match only; no same-turn fallback
  return !!(call.id && rid && String(rid) === String(call.id));
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
    const calls = extractCalls(events[i]);
    if (calls.length === 0) continue;
    sawEvent = true;
    for (const call of calls) {
      // Phase 02 R4 (Step 4): empty tool name is treated as an unknown mutating
      // identity -> fail-closed (isSideEffect("") must be TRUE for side-effect
      // purposes; the allowlist check below only covers KNOWN read-only tools).
      const readOnly = call.name && SAFE_RESULTLESS.has(call.name);
      if (readOnly) continue; // read-only: safe
      // Unknown/empty identity side effect -> fail-closed. Without a stable
      // call identity we cannot prove completion — never let a same-turn result
      // of another call stand in for it.
      if (!call.hasIdentity) {
        return { state: "needs_verification", detail: `${call.name || "(empty tool name)"} without reliable identity` };
      }
      const hasResult = events.some((ev) => resultMatches(call, ev));
      if (!hasResult) {
        return { state: "needs_verification", detail: `${call.name} (id=${call.id || "?"}) without result` };
      }
      // has result -> completed; continue with older events
    }
  }
  if (!sawEvent) {
    // No tool-calls at all: nothing outstanding — clean.
    return { state: "clean" };
  }
  return { state: "clean" };
}

export default { evaluateCompletion, isSideEffect };
