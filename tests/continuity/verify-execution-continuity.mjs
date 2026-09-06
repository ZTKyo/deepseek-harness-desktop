// verify-execution-continuity.mjs —— Execution Continuity Bootstrap 单元验证
// 覆盖：错误分类器、预算、断路器、兼容回退、Intent store、WAITING_USER 保护。
import { apply, RECOVERABLE_STATES, NON_RECOVERABLE_STATES } from "../../plugins/execution-continuity.mjs";
import {
  classifyFailure, hasBudget, backoffDelay, compatibleFallback, modelSupports, createCircuitBreaker, CATEGORY,
} from "../../plugins/execution-continuity-core.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let ok = true;
const check = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) ok = false; };

// ── 1. 分类器 ──────────────────────────────────────────────────────────────
const f = classifyFailure;
check("ctx overflow: 'Input token exceed the limit'", f({ code: "quota_limit_reached", message: "Input token exceed the limit, current token count: 999999" }).category === CATEGORY.CONTEXT_OVERFLOW);
check("timeout", f({ message: "ETIMEDOUT" }).category === CATEGORY.RETRYABLE_TRANSIENT);
check("429 rate limit", f({ code: "429", message: "Rate limit exceeded" }).category === CATEGORY.RATE_LIMIT);
check("retry-after honored", f({ code: "429", providerRetryAfterMs: 15000 }).providerRetryAfterMs === 15000);
check("5xx provider outage", f({ code: "503", message: "Service Unavailable" }).category === CATEGORY.PROVIDER_OUTAGE);
check("quota exhausted", f({ code: "quota_limit_reached", message: "usage limit reached" }).category === CATEGORY.QUOTA_EXHAUSTED);
check("model unavailable", f({ message: "model not found: foo/bar" }).category === CATEGORY.MODEL_UNAVAILABLE);
check("401 auth", f({ code: "401", message: "unauthorized" }).category === CATEGORY.AUTH);
check("400 invalid request", f({ code: "400", message: "Invalid request body." }).category === CATEGORY.INVALID_REQUEST);
check("unknown", f({ code: "999", message: "weird thing" }).category === CATEGORY.UNKNOWN);

// ── 2. 预算 ────────────────────────────────────────────────────────────────
check("retry budget: 0<3 true", hasBudget("retry", { retryCount: 0 }));
check("retry budget: 3>=3 false", !hasBudget("retry", { retryCount: 3 }));
check("fallback budget: 2>=2 false", !hasBudget("fallback", { fallbackCount: 2 }));
check("context budget: 1<2 true", hasBudget("context-recovery", { contextRecoveryCount: 1 }));
check("auto-resume budget: 10>=10 false", !hasBudget("auto-resume", { autoResumeCycles: 10 }));

// ── 3. backoff ─────────────────────────────────────────────────────────────
const b1 = backoffDelay(0, undefined, 0);
check("backoff retry0 in [700,1300]", b1 >= 700 && b1 <= 1300);
const b2 = backoffDelay(5, undefined, 0);
check("backoff retry5 > retry0", b2 > b1);
const b3 = backoffDelay(0, undefined, 60000);
check("backoff honors Retry-After cap 60s", b3 === 60000);

// ── 4. 断路器 ──────────────────────────────────────────────────────────────
const cb = createCircuitBreaker(60000, 3);
check("breaker: fresh allows", cb.canUse("p", "m"));
cb.recordFailure("p", "m"); cb.recordFailure("p", "m");
check("breaker: 2 failures still allows", cb.canUse("p", "m"));
cb.recordFailure("p", "m");
check("breaker: 3 failures trips", !cb.canUse("p", "m"));
cb.recordSuccess("p", "m");
check("breaker: success resets", cb.canUse("p", "m"));

// ── 5. 兼容回退 ────────────────────────────────────────────────────────────
// The canonical registry expresses non-text modalities only; text is the
// baseline and must not be requested as a missing capability.
check("modelSupports: deepseek flash tools ok", modelSupports("deepseek-v4-flash", { tools: true }));
check("modelSupports: qwen rejects structuredJson", !modelSupports("qwen3.7-plus", { structuredJson: true }));
check("compatibleFallback picks larger ctx", compatibleFallback("deepseek-v4-flash-free", { contextWindow: 1000000 }, ["deepseek-v4-flash-free", "deepseek/deepseek-v4-flash-0731", "qwen3.7-plus"]) === "deepseek/deepseek-v4-flash-0731");

// ── 6. Intent store + WAITING_USER 保护 ───────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ec-test-"));
try {
  const logger = { info() {}, warn() {}, error() {} };
  const ctx = {
    logger,
    on: () => () => {},
    effect: () => () => {},
    agents: { resume: async () => ({ session: { events: [] } }), get: () => null, list: () => [] },
    goals: { get: () => null, resume: () => {} },
    sessions: { flush: async () => {} },
    compaction: { compactNow: async () => ({ ok: true }) },
    llm: { providers: {} },
  };
  const plugin = apply(ctx, { stateDir: tmp });
  const store = plugin._test.store;

  store.setState("sess-A", "RUNNING");
  store.setState("sess-B", "INTERRUPTED_BY_RESTART");
  store.setState("sess-C", "USER_PAUSED");
  store.setState("sess-D", "USER_CANCELLED");
  store.setState("sess-E", "COMPLETED");
  store.setState("sess-F", "FAILED_FATAL");

  const rec = store.listRecoverable().map((i) => i.sessionId).sort();
  check("recoverable set = A,B", JSON.stringify(rec) === JSON.stringify(["sess-A", "sess-B"]));

  // WAITING_USER 保护
  const agentWithPendingQ = { session: { id: "x", events: [{ type: "assistant/message", data: { turn: 1, message: { content: [{ type: "tool-call", name: "ask_user_question" }] } } }] } };
  check("hasPendingQuestion detects", plugin._test.hasPendingQuestion(agentWithPendingQ.session) === true);
  const agentAnswered = { session: { id: "x", events: [
    { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "tool-call", name: "ask_user_question" }] } } },
    { type: "tool/result", data: { turn: 1 } },
  ] } };
  check("hasPendingQuestion after answer false", plugin._test.hasPendingQuestion(agentAnswered.session) === false);

  // 状态常量
  check("RECOVERABLE_STATES excludes paused/cancelled", !RECOVERABLE_STATES.includes("USER_PAUSED") && !RECOVERABLE_STATES.includes("USER_CANCELLED"));
  check("NON_RECOVERABLE includes waiting-user", NON_RECOVERABLE_STATES.includes("WAITING_USER"));

  // 持久化重读
  const store2 = plugin._test.store.constructor === Object ? null : null;
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, "execution-intents.json"), "utf8"));
  check("intent store persisted to disk", raw.intents["sess-A"].state === "RUNNING");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);
