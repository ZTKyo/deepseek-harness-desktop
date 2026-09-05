import { hasPendingQuestion } from "../../plugins/execution-continuity.mjs";

// 用真实 DSH 结构（assembler.js + repair.js 确认）
const pendingQ = { events: [
  { type: "turn/start", seq: 1, data: { turn: 5 } },
  { type: "assistant/message", seq: 2, data: { turn: 5, step: 1, message: { content: [{ type: "tool-call", id: "call_xyz", name: "ask_user_question", arguments: "{}" }] } } },
]};
const answeredReal = { events: [
  { type: "turn/start", seq: 1, data: { turn: 5 } },
  { type: "assistant/message", seq: 2, data: { turn: 5, step: 1, message: { content: [{ type: "tool-call", id: "call_xyz", name: "ask_user_question", arguments: "{}" }] } } },
  { type: "tool/result", seq: 3, data: { turn: 5, step: 1, message: { source: { kind: "tool", callId: "call_xyz" } } } },
]};
const answeredLegacy = { events: [
  { type: "assistant/message", seq: 2, data: { turn: 5, step: 1, message: { content: [{ type: "function_call", function: { name: "ask_user_question" } }] } } },
  { type: "tool/result", seq: 3, data: { turn: 5, step: 1, toolCallId: "call_abc" } },
]};
const noQ = { events: [ { type: "assistant/message", seq: 1, data: { turn: 1, message: { content: [{ type: "text", text: "hi" }] } } } ] };

const r1 = hasPendingQuestion(pendingQ);
const r2 = hasPendingQuestion(answeredReal);
const r3 = hasPendingQuestion(answeredLegacy);
const r4 = hasPendingQuestion(noQ);
console.log("real pending Q detected:", r1, "(expect true)");
console.log("real answered (source.callId):", r2, "(expect false)");
console.log("legacy answered (toolCallId):", r3, "(expect false)");
console.log("no question:", r4, "(expect false)");
const pass = r1 === true && r2 === false && r3 === false && r4 === false;
console.log(pass ? "PASS: hasPendingQuestion matches real DSH structure" : "FAIL");
process.exit(pass ? 0 : 1);
