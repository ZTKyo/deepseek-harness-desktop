#!/usr/bin/env node
// goal-recovery.mjs 鈥斺€?DSH 閲嶅惎鍚庢椿璺?goal 鐨勪唬闄呴殧绂汇€佸箓绛夋仮澶?
//
// 鑳屾櫙锛欴SH 鐨?goal 鑷姩缁窇鏄繘绋嬪唴瀛樻€侊紙goal-round-driver锛夛紝鏈嶅姟閲嶅惎鍚?
// 涓㈠け锛屼换鍔′笉浼氳嚜鍔ㄧ户缁€傛湰鑴氭湰鍦ㄦ湇鍔℃仮澶嶅悗锛?
//   1) 閫氳繃 session.list 鎵惧嚭 phase=active 鐨?goal 浼氳瘽锛坓oal 鎶曞奖鎸佷箙鍖栧湪浼氳瘽閲岋級
//   2) 浠?(server generation, session, goal, revision) 鐨勫搱甯屼綔涓哄師瀛?ledger 閿?
//   3) 鍏堣皟鐢?goal.resume锛涘彧鏈?grace 鍚庢槑纭湭 running 鎵嶅叆闃熶竴娆￠€氱敤 continue
//   4) 瀵瑰凡 armed/running銆佹湭鐭ョ姸鎬佹垨涓柇 claim fail closed锛岀粷涓嶈嚜鍔ㄩ噸鏀?
//
// 鐢ㄦ硶锛?
//   node goal-recovery.mjs [--port 3080] [--check] [--dry-run] [--state-dir <鐩綍>]
//     [--generation <fixture-generation>] [--grace-ms <姣>] [--message <閫氱敤娑堟伅>]
//     --check    鍙娴嬶細鏈夋椿璺?goal 浼氳瘽鏃?exit 0锛涘惁鍒?exit 1
//     --dry-run  鎵撳嵃灏嗘墽琛岀殑鍔ㄤ綔锛屼笉瀹為檯璋冪敤
//     榛樿琛屼负   鎵ц鍙?ledger 绾︽潫鐨勬仮澶?
//
// 渚濊禆锛歂ode >= 18锛堝唴缃?fetch锛夈€侫PI 鍗忚涓庢祻瑙堝櫒涓€鑷达紙loopback锛屾棤闇€璁よ瘉锛夈€?
// 閫€鍑虹爜锛? = 鎴愬姛/鏃犳椿璺?goal锛? = 鏈夋椿璺?goal 闇€瑕佷汉宸ュ鏍革紱2 = API/浠ｉ檯璇佹嵁涓嶅彲鐢?

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import os from "node:os";
import { pathToFileURL } from "node:url";

/*
 * P4.5 K3 — STRICT, FAIL-CLOSED PROJECTION READ PATH.
 *
 * WHAT CHANGED (and why this file is safe to import)
 *   Before: the read path was fail-OPEN by construction — every `|| {}` and `? :` shortcut turned
 *   "I could not read the projection" into "there is no active goal", so an unreadable/cold/malformed
 *   session.list row silently made the stuck-safety check report "nothing to do".
 *   Now: absence of evidence is a REFUSAL (exit 3), never an empty active set.
 *
 * CONTRACT ON BOTH SUPPORTED BASES (verified from the real package sources, see
 * docs/roadmap/reports/PHASE_04_5_ALIGNMENT/K3_FINDINGS.md):
 *   0.1.1-rc.2 and 0.2.0-rc.2 both register the `goal` session projection, and BOTH publish the same
 *   WIRE shape:  values.goal === null  |  { goal: { id, revision, objective, phase, blockedReason?,
 *   maxGoalRounds }, roundsStarted, createdAt, updatedAt }.
 *   The STATE shape changed (v4 -> v6); the wire/view shape did not. So
 *     projections.values.goal.goal.phase
 *   remains the correct read path on both bases, and `key present + null` ("no goal") stays a
 *   distinct, trustworthy signal from `key absent` (cold miss / swallowed column error -> REFUSE).
 *
 * HARDENING RULES
 *   R1 envelope : result / value / items must all be present and well typed, else REFUSE.
 *   R2 projection: every row must carry projections.values with an OWN `goal` key, else REFUSE.
 *   R3 shape    : goal must be null or an object whose .goal has id:string, revision:positive int,
 *                 phase in {active,paused,blocked,complete}; unknown phase is drift, never "inactive".
 *   R4 WAIT-GATE: a session with a pending real user question is NEVER resume-eligible; an UNKNOWN
 *                 wait state is ALSO not eligible. (No weaker than execution-continuity.)
 *   R5 side effect: this module never resumes anything on a refusal path. `applyResume()` is the only
 *                 place a resume can happen and it requires an INJECTED sink, so this CLI can never
 *                 become a second recovery authority (Phase 02 R2/R4: recovery decisions belong to
 *                 Execution Continuity).
 *   R6 honesty  : `--check` exits 3 (not 1) when the projection could not be read — "I do not know"
 *                 must never be reported as "nothing to do".
 *
 * EXIT CODES (guardian contract preserved: 0 = active, 1 = inactive, anything else = unknown)
 *   0 OK                : --check read the projection and >=1 active-phase goal exists
 *   1 NOTHING_TO_DO     : --check read the projection, no active goal
 *   2 API_UNAVAILABLE   : the HTTP API never became ready / transport error
 *   3 REFUSED           : fail-closed — envelope or projection unreadable (guardian sees "unknown")
 *   4 AUTONOMY_DISABLED : usage error, or an autonomous recovery surface was requested
 *   5 RESUME_FAILED     : a resume was attempted through applyResume() and failed
 *
 * CLI:  node goal-recovery.mjs [--check] [--port N] [--json] [--require-eligible]
 *                              [--plan|--dry-run] [--events-file F]
 *                              [--state-dir D] [--generation G] [--grace-ms N] [--message M]
 *   --check             read-only active-goal projection (guardian stuck-safety)
 *   --plan / --dry-run  print the full eligibility plan; never resumes
 *   --json              machine-readable output for --check / --plan
 *   --require-eligible  --check exits 0 only when >=1 candidate passes the R4 WAIT-GATE
 *   --events-file F     offline event streams ({ sessionId: [events] }) for the WAIT-GATE probe
 *   The stateless --session/--action executor and the autonomous scan->claim->resume engine remain
 *   REMOVED / fail-closed (exit 4): both were deleted by Phase 02 R2/R4 because they duplicated EC's
 *   recovery authority. Only the read-only surface survives; the resume path lives in the exported,
 *   sink-injected applyResume() so the sole authority (EC) can drive it.
 */

export const REASON = Object.freeze({
  ENVELOPE_MALFORMED: "ENVELOPE_MALFORMED",
  ITEMS_MALFORMED: "ITEMS_MALFORMED",
  ITEM_NOT_OBJECT: "ITEM_NOT_OBJECT",
  ITEM_ID_MISSING: "ITEM_ID_MISSING",
  PROJECTION_BLOCK_MISSING: "PROJECTION_BLOCK_MISSING",
  PROJECTION_VALUES_MISSING: "PROJECTION_VALUES_MISSING",
  GOAL_COLUMN_MISSING: "GOAL_COLUMN_MISSING",
  GOAL_SHAPE_MALFORMED: "GOAL_SHAPE_MALFORMED",
  GOAL_PHASE_UNKNOWN: "GOAL_PHASE_UNKNOWN",
  WAIT_STATE_UNKNOWN: "WAIT_STATE_UNKNOWN",
  WAITING_USER: "RECOVERY_BLOCKED_WAITING_USER",
  GOAL_NOT_ACTIVE: "GOAL_NOT_ACTIVE",
  ELIGIBLE: "RESUME_ELIGIBLE",
  NO_ACTIVE_GOAL: "NO_ACTIVE_GOAL",
});

export const EXIT = Object.freeze({
  OK: 0,
  NOTHING_TO_DO: 1,
  API_UNAVAILABLE: 2,
  REFUSED: 3,
  AUTONOMY_DISABLED: 4,
  RESUME_FAILED: 5,
});

const PHASES = new Set(["active", "paused", "blocked", "complete"]);
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const refuse = (reason, detail, sessionId = null) => ({ ok: false, reason, detail, sessionId });

function parseArgs(argv) {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const opts = {
    port: 3080,
    check: false,
    plan: false,
    dryRun: false,
    json: false,
    requireEligible: false,
    message: null,
    stateDir: path.join(localAppData, "DSHHarness", "state"),
    generation: null,
    graceMs: 15000,
    eventsFile: null,
    // Legacy executor options: kept in the parser ONLY so they can be rejected explicitly
    // (fail-closed) instead of being silently ignored.
    executorSession: null,
    executorAction: "resume",
    executorGoalRef: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]) || 3080;
    else if (a === "--check") opts.check = true;
    else if (a === "--plan" || a === "--dry-run") { opts.plan = true; opts.dryRun = true; }
    else if (a === "--json") opts.json = true;
    else if (a === "--require-eligible") opts.requireEligible = true;
    else if (a === "--message") opts.message = argv[++i];
    else if (a === "--state-dir") opts.stateDir = argv[++i] || opts.stateDir;
    else if (a === "--generation") opts.generation = argv[++i] || null;
    else if (a === "--grace-ms") opts.graceMs = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--events-file") opts.eventsFile = argv[++i] || null;
    else if (a === "--session") opts.executorSession = argv[++i] || null;
    else if (a === "--action") opts.executorAction = argv[++i] || "resume";
    else if (a === "--goal-ref") opts.executorGoalRef = argv[++i] || null;
  }
  return opts;
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let rpcSeq = 0;
async function rpc(method, payload, base) {
  const rpcId = `goal-recovery-${Date.now()}-${++rpcSeq}`;
  const res = await fetch(`${base}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: new URL(base).host },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${method}`);
  return res.json();
}

/** Wait until the API is answering (the service may still be initialising right after a restart).
 *  The budget is --grace-ms (default 15000): bounded, so a dead API is reported promptly instead of
 *  hanging the guardian's stuck-safety probe. */
async function waitForApi(base, budgetMs = 15000, delayMs = 250) {
  const deadline = Date.now() + Math.max(0, budgetMs);
  for (;;) {
    try {
      await rpc("host.describe", {}, base);
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/* -- R1: session.list envelope --------------------------------------------------------------- */
export function readSessionListEnvelope(body) {
  if (!isObj(body)) return refuse(REASON.ENVELOPE_MALFORMED, "response body is not an object");
  const result = body.result;
  if (!isObj(result)) return refuse(REASON.ENVELOPE_MALFORMED, "body.result is missing or not an object");
  if (has(result, "error") && result.error !== null && result.error !== undefined) {
    return refuse(REASON.ENVELOPE_MALFORMED, "result carries an error member: " + JSON.stringify(result.error).slice(0, 200));
  }
  const value = result.value;
  if (!isObj(value)) return refuse(REASON.ENVELOPE_MALFORMED, "result.value is missing or not an object");
  if (!has(value, "items")) return refuse(REASON.ITEMS_MALFORMED, "result.value.items key is absent");
  if (!Array.isArray(value.items)) return refuse(REASON.ITEMS_MALFORMED, "result.value.items is not an array");
  return { ok: true, items: value.items };
}

/* -- R2 + R3: per-row projection read (strict) ---------------------------------------------- */
export function extractGoalView(item) {
  if (!isObj(item)) return refuse(REASON.ITEM_NOT_OBJECT, "row is not an object");
  const sessionId = typeof item.sessionId === "string" && item.sessionId.length > 0 ? item.sessionId : null;
  if (sessionId === null) return refuse(REASON.ITEM_ID_MISSING, "row has no usable sessionId");

  const projections = item.projections;
  if (!isObj(projections)) return refuse(REASON.PROJECTION_BLOCK_MISSING, "row carries no projections block (swallowed column error or cold miss)", sessionId);
  const values = projections.values;
  if (!isObj(values)) return refuse(REASON.PROJECTION_VALUES_MISSING, "projections.values is missing or not an object", sessionId);
  if (!has(values, "goal")) return refuse(REASON.GOAL_COLUMN_MISSING, 'projections.values has no own "goal" key (drift / partial hint row)', sessionId);

  const g = values.goal;
  const out = {
    sessionId,
    running: item.running === true,
    agentAvailable: item.agentAvailable === true,
    asOfSeq: Number.isInteger(projections.asOfSeq) ? projections.asOfSeq : null,
    hasGoal: g !== null,
    goal: null,
  };
  if (g === null) return { ok: true, ...out };                      // trustworthy "no goal"
  if (!isObj(g)) return refuse(REASON.GOAL_SHAPE_MALFORMED, "goal projection is neither null nor an object", sessionId);

  const inner = g.goal;
  if (!isObj(inner)) return refuse(REASON.GOAL_SHAPE_MALFORMED, 'goal projection has no object "goal" member', sessionId);
  if (typeof inner.id !== "string" || inner.id.length === 0) return refuse(REASON.GOAL_SHAPE_MALFORMED, "goal.id is not a non-empty string", sessionId);
  if (!Number.isInteger(inner.revision) || inner.revision < 1) return refuse(REASON.GOAL_SHAPE_MALFORMED, "goal.revision is not a positive integer", sessionId);
  if (typeof inner.phase !== "string") return refuse(REASON.GOAL_SHAPE_MALFORMED, "goal.phase is not a string", sessionId);
  if (!PHASES.has(inner.phase)) return refuse(REASON.GOAL_PHASE_UNKNOWN, "goal.phase is not one of active/paused/blocked/complete: " + inner.phase, sessionId);
  if (!Number.isFinite(g.createdAt) || !Number.isFinite(g.updatedAt)) return refuse(REASON.GOAL_SHAPE_MALFORMED, "goal projection lacks numeric createdAt/updatedAt", sessionId);
  if (!Number.isInteger(g.roundsStarted) || g.roundsStarted < 0) return refuse(REASON.GOAL_SHAPE_MALFORMED, "goal.roundsStarted is not a non-negative integer", sessionId);

  out.goal = {
    id: inner.id,
    revision: inner.revision,
    phase: inner.phase,
    objective: typeof inner.objective === "string" ? inner.objective : null,
    maxGoalRounds: Number.isInteger(inner.maxGoalRounds) ? inner.maxGoalRounds : null,
    roundsStarted: g.roundsStarted,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
  return { ok: true, ...out };
}

/* -- aggregate: every row strict, any bad row poisons the whole listing --------------------- */
export function activeGoalSessions(body) {
  const env = readSessionListEnvelope(body);
  if (!env.ok) return env;
  const rows = [];
  for (const item of env.items) {
    const row = extractGoalView(item);
    if (!row.ok) return row;                       // R1/R2/R3: refuse, never skip silently
    rows.push(row);
  }
  const active = rows.filter((r) => r.hasGoal && r.goal.phase === "active");
  return { ok: true, rows, active, reason: active.length ? REASON.ELIGIBLE : REASON.NO_ACTIVE_GOAL };
}

/* -- R4: WAIT-GATE (no weaker than execution-continuity.hasPendingQuestion) -----------------
 * Ported from execution-continuity.mjs (same event vocabulary) and extended with the
 * question/requested -> question/answered|resolved pair used by the interaction frames.
 * Difference vs EC: EC's `catch { return false }` FAILS OPEN on an exception; here an unevaluable
 * event stream reports `unknown`, and an unknown wait state is never resume-eligible. */
export function evaluatePendingQuestion(events) {
  if (!Array.isArray(events)) return { state: "unknown", detail: "event stream is not an array" };
  try {
    let askedTurn = null;
    let askedCallId = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i] || {};
      const data = ev.data || {};
      if (ev.type === "assistant/message") {
        const content = data.message?.content;
        if (Array.isArray(content)) {
          const q = content.find((b) => b && (b.type === "tool-call" || b.type === "function_call") && String(b.name || b.function?.name || "").includes("ask_user_question"));
          if (q) {
            askedTurn = data.turn;
            askedCallId = q.id || q.tool_call_id || q.call_id || q.function?.call_id || null;
            break;
          }
        }
      }
    }
    if (askedTurn !== null) {
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i] || {};
        if (ev.type !== "tool/result") continue;
        const d = ev.data || {};
        if (askedCallId) {
          const rid = d.tool_call_id || d.toolCallId || d.call_id || d.id ||
            (d.message && d.message.source && d.message.source.callId) ||
            (d.result && (d.result.tool_call_id || d.result.call_id));
          if (rid && String(rid) === String(askedCallId)) return { state: "none", detail: "ask_user_question answered by tool/result " + askedCallId };
        }
        if (d.turn === askedTurn) return { state: "none", detail: "ask_user_question answered in turn " + String(askedTurn) };
      }
      return { state: "pending", detail: "ask_user_question without matching tool/result (turn " + String(askedTurn) + ")" };
    }
    let pendingQ = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i] || {};
      if (ev.type === "question/resolved" || ev.type === "question/answered" || ev.type === "question/cancelled") return { state: "none", detail: "question " + ev.type };
      if (ev.type === "question/requested") { pendingQ = ev.data?.rpcId ?? ev.data?.id ?? "unknown"; break; }
    }
    if (pendingQ !== null) return { state: "pending", detail: "question/requested without resolved (" + String(pendingQ) + ")" };
    return { state: "none", detail: "no question in stream" };
  } catch (e) {
    return { state: "unknown", detail: "pending-question evaluation threw: " + String(e && e.message ? e.message : e) };
  }
}

/* -- R4/R5: the single decision point used by every resume path ----------------------------- */
export function evaluateRecoveryEligibility(row, waitState) {
  if (!row || row.ok !== true) return { eligible: false, reason: row?.reason ?? REASON.ITEM_NOT_OBJECT, detail: row?.detail ?? "no row", sessionId: row?.sessionId ?? null };
  if (!row.hasGoal) return { eligible: false, reason: REASON.GOAL_NOT_ACTIVE, detail: "session carries no goal (null projection)", sessionId: row.sessionId };
  if (row.goal.phase !== "active") return { eligible: false, reason: REASON.GOAL_NOT_ACTIVE, detail: "goal phase is " + row.goal.phase, sessionId: row.sessionId };
  const ws = waitState && typeof waitState === "object" ? waitState.state : null;
  if (ws === "pending") return { eligible: false, reason: REASON.WAITING_USER, detail: waitState.detail ?? "pending user question", sessionId: row.sessionId };
  if (ws !== "none") return { eligible: false, reason: REASON.WAIT_STATE_UNKNOWN, detail: (waitState && waitState.detail) || "wait state could not be determined", sessionId: row.sessionId };
  return { eligible: true, reason: REASON.ELIGIBLE, detail: "goal " + row.goal.id + " rev " + row.goal.revision + " active, no pending question", sessionId: row.sessionId, goal: row.goal, running: row.running === true };
}

/* -- full pipeline (used by the CLI and by the fixture tests) ------------------------------- */
export function planRecovery(body, waitProbe) {
  const agg = activeGoalSessions(body);
  if (!agg.ok) return { refused: true, reason: agg.reason, detail: agg.detail, sessionId: agg.sessionId, decisions: [] };
  const decisions = agg.active.map((row) => evaluateRecoveryEligibility(row, waitProbe(row)));
  return { refused: false, reason: agg.reason, detail: agg.active.length + " active goal row(s)", decisions, activeCount: agg.active.length, rowCount: agg.rows.length };
}

/* -- R5: apply — the ONLY place a resume side effect may happen ----------------------------- */
export async function applyResume(plan, requestResume) {
  if (plan.refused) return { attempted: 0, results: [], refused: true, reason: plan.reason };
  const results = [];
  let attempted = 0;
  for (const d of plan.decisions) {
    if (!d.eligible) { results.push({ ...d, resumed: false }); continue; }
    attempted += 1;
    try {
      await requestResume(d);
      results.push({ ...d, resumed: true });
    } catch (e) {
      results.push({ ...d, resumed: false, reason: "RESUME_FAILED", detail: String(e && e.message ? e.message : e) });
    }
  }
  return { attempted, results, refused: false, reason: plan.reason };
}

/* -- offline / live wait-state source -------------------------------------------------------
 * The CLI deliberately does NOT invent an events RPC: without a verified events source the wait
 * state is `unknown`, which blocks every candidate (R4, fail-closed). `--events-file` supplies a
 * real stream for offline runs; Execution Continuity (the sole recovery authority) supplies its own
 * probe when it drives applyResume() in-process. */
async function loadEventsBySession(file) {
  if (!file) return null;
  const text = await fs.readFile(path.resolve(file), "utf8");
  const parsed = JSON.parse(text);
  if (!isObj(parsed)) throw new Error("--events-file must contain a JSON object keyed by sessionId");
  return parsed;
}

async function main() {
  const opts = parseArgs(process.argv);
  const base = `http://127.0.0.1:${opts.port}`;

  const emit = (obj, human) => {
    if (opts.json) console.log(JSON.stringify(obj, null, 1));
    else console.log(human);
  };

  if (!opts.check && !opts.plan) {
    // Phase 02 R2/R4: no autonomous scan->claim->resume, no stateless executor surface.
    // Recovery decisions belong solely to Execution Continuity.
    if (opts.executorSession || opts.executorAction !== "resume" || opts.executorGoalRef) {
      if (!opts.json) {
        console.error("[goal-recovery] the stateless --session/--action executor was removed (Phase 02 R4); only --check/--plan are supported");
      } else {
        emit({ refused: true, reason: "AUTONOMY_DISABLED", detail: "stateless executor surface removed (Phase 02 R4)" }, "");
      }
      return EXIT.AUTONOMY_DISABLED;
    }
    const detail = opts.dryRun
      ? "no --check/--plan given"
      : "autonomous recovery path is disabled (Phase 02 R2/R4); only --check (read-only) and --plan are supported";
    if (opts.json) emit({ refused: true, reason: "AUTONOMY_DISABLED", detail }, "");
    else console.error("[goal-recovery] " + detail);
    return EXIT.AUTONOMY_DISABLED;
  }

  if (!(await waitForApi(base, opts.graceMs))) {
    if (opts.json) emit({ refused: true, reason: "API_UNAVAILABLE", detail: `API not ready on ${base} after retries` }, "");
    else console.error(`[goal-recovery] API not ready on ${base} after retries`);
    return EXIT.API_UNAVAILABLE;
  }

  let body;
  try {
    body = await rpc("session.list", {}, base);
  } catch (e) {
    const detail = String(e && e.message ? e.message : e);
    if (opts.json) emit({ refused: true, reason: "TRANSPORT_ERROR", detail }, "");
    else console.error(`[goal-recovery] session.list failed: ${detail}`);
    return EXIT.API_UNAVAILABLE;
  }

  let eventsBySession = null;
  if (opts.eventsFile) {
    try {
      eventsBySession = await loadEventsBySession(opts.eventsFile);
    } catch (e) {
      const detail = String(e && e.message ? e.message : e);
      if (opts.json) emit({ refused: true, reason: "EVENTS_SOURCE_UNREADABLE", detail }, "");
      else console.error(`[goal-recovery] --events-file unreadable: ${detail}`);
      return EXIT.REFUSED;
    }
  }
  const waitProbe = (row) => {
    if (!eventsBySession) return { state: "unknown", detail: "no verified events source: wait state cannot be established" };
    if (!has(eventsBySession, row.sessionId)) return { state: "unknown", detail: "no events recorded for " + row.sessionId };
    return evaluatePendingQuestion(eventsBySession[row.sessionId]);
  };

  const plan = planRecovery(body, waitProbe);
  if (plan.refused) {
    emit({ refused: true, reason: plan.reason, detail: plan.detail, sessionId: plan.sessionId },
      `[goal-recovery] REFUSED (${plan.reason}): ${plan.detail}${plan.sessionId ? " [session " + plan.sessionId + "]" : ""}`);
    return EXIT.REFUSED;
  }

  const eligible = plan.decisions.filter((d) => d.eligible);
  const blocked = plan.decisions.filter((d) => !d.eligible);

  if (opts.plan) {
    emit(
      { refused: false, mode: "plan", rowCount: plan.rowCount, activeCount: plan.activeCount, eligible: eligible.length, blocked, decisions: plan.decisions },
      "[goal-recovery] plan: rows=" + plan.rowCount + " active=" + plan.activeCount + " eligible=" + eligible.length +
        (blocked.length ? " blocked=[" + blocked.map((b) => b.sessionId + ":" + b.reason).join(", ") + "]" : "")
    );
    return eligible.length ? EXIT.OK : EXIT.NOTHING_TO_DO;
  }

  // --check : guardian stuck-safety. Exit 0 = an active-phase goal EXISTS (guardian "active"),
  // 1 = projection read OK and no active goal (guardian "inactive"). Never a resume side effect.
  emit(
    { refused: false, mode: "check", rowCount: plan.rowCount, activeCount: plan.activeCount, eligible: eligible.length, blocked, decisions: plan.decisions },
    `[goal-recovery] active goal count=${plan.activeCount}`
  );
  if (opts.requireEligible) return eligible.length > 0 ? EXIT.OK : EXIT.NOTHING_TO_DO;
  return plan.activeCount > 0 ? EXIT.OK : EXIT.NOTHING_TO_DO;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch(() => {
      console.error("[goal-recovery] unexpected failure; no further action taken");
      process.exitCode = EXIT.API_UNAVAILABLE;
    });
}
