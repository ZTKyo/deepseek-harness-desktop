#!/usr/bin/env node
// goal-recovery.mjs —— DSH 重启后活跃 goal 的代际隔离、幂等恢复
//
// 背景：DSH 的 goal 自动续跑是进程内存态（goal-round-driver），服务重启后
// 丢失，任务不会自动继续。本脚本在服务恢复后：
//   1) 通过 session.list 找出 phase=active 的 goal 会话（goal 投影持久化在会话里）
//   2) 以 (server generation, session, goal, revision) 的哈希作为原子 ledger 键
//   3) 先调用 goal.resume；只有 grace 后明确未 running 才入队一次通用 continue
//   4) 对已 armed/running、未知状态或中断 claim fail closed，绝不自动重放
//
// 用法：
//   node goal-recovery.mjs [--port 3080] [--check] [--dry-run] [--state-dir <目录>]
//     [--generation <fixture-generation>] [--grace-ms <毫秒>] [--message <通用消息>]
//     --check    只检测：有活跃 goal 会话时 exit 0；否则 exit 1
//     --dry-run  打印将执行的动作，不实际调用
//     默认行为   执行受 ledger 约束的恢复
//
// 依赖：Node >= 18（内置 fetch）。API 协议与浏览器一致（loopback，无需认证）。
// 退出码：0 = 成功/无活跃 goal；1 = 有活跃 goal 需要人工复核；2 = API/代际证据不可用

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import os from "node:os";

function parseArgs(argv) {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const opts = {
    port: 3080,
    check: false,
    dryRun: false,
    message: null,
    stateDir: path.join(localAppData, "DSHHarness", "state"),
    generation: null,
    graceMs: 15000,
    // Phase 02 R1 (BLOCKING-2): stateless executor mode. When --session is
    // provided, this script ONLY executes the given action for that session
    // (resume / continue). It does NOT scan all active goals, does NOT decide
    // which goal to recover, and does NOT claim ownership of recovery policy.
    // The recovery DECISION belongs to Execution Continuity (EC); Guardian
    // calls this as a pure executor with an explicit session + goal ref.
    executorSession: null,
    executorAction: "resume",
    executorGoalRef: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]) || 3080;
    else if (a === "--check") opts.check = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--message") opts.message = argv[++i];
    else if (a === "--state-dir") opts.stateDir = argv[++i] || opts.stateDir;
    else if (a === "--generation") opts.generation = argv[++i] || null;
    else if (a === "--grace-ms") opts.graceMs = Math.max(0, Number(argv[++i]) || 0);
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

/** 等待 API 就绪（服务刚重启时可能还在初始化）。 */
async function waitForApi(base, tries = 15, delayMs = 2000) {
  for (let i = 1; i <= tries; i++) {
    try {
      await rpc("host.describe", {}, base);
      return true;
    } catch {
      if (i < tries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

/** 列出所有 phase=active 的 goal 会话。 */
async function activeGoalSessions(base) {
  const resp = await rpc("session.list", {}, base);
  const result = resp && resp.result;
  if (!result || result.ok !== true) {
    throw new Error(result && result.error ? `session.list: ${result.error.message}` : "session.list failed");
  }
  const items = result.value && result.value.items ? result.value.items : [];
  const out = [];
  for (const it of items) {
    const goal = it.projections && it.projections.values && it.projections.values.goal;
    if (goal && goal.goal && goal.goal.phase === "active") {
      out.push({
        sessionId: it.sessionId,
        ref: { id: goal.goal.id, revision: goal.goal.revision },
        running: it.running === true
      });
    }
  }
  return out;
}

/** goal.resume：重新武装自动续跑（DSH 原生 goal 驱动恢复）。 */
async function resumeGoal(base, sessionId, ref) {
  const resp = await rpc("goal.resume", { sessionId, ref }, base);
  const result = resp && resp.result;
  if (!result || result.ok !== true) {
    throw new Error(result && result.error ? `goals.resume: ${result.error.message}` : "goals.resume failed");
  }
  return result.value;
}

/** session.prompt 兜底：排队注入"继续"消息（不打断运行中的 turn）。 */
async function promptContinue(base, sessionId, customMessage) {
  const text = customMessage ||
    "[goal-recovery] The local DSH server restarted while this goal was active. Use get_goal to check its state and continue only if it is not already progressing.";
  const resp = await rpc("session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text }]
  }, base);
  const result = resp && resp.result;
  if (!result || result.ok !== true) {
    throw new Error(result && result.error ? `session.prompt: ${result.error.message}` : "session.prompt failed");
  }
  return result.value;
}

function isAlreadyArmed(error) {
  return /already active and armed|already armed|already running/i.test(String(error && error.message ? error.message : error));
}

async function main() {
  const opts = parseArgs(process.argv);
  const base = `http://127.0.0.1:${opts.port}`;

  if (!(await waitForApi(base))) {
    console.error(`[goal-recovery] API not ready on ${base} after retries`);
    process.exit(2);
  }

  // ── Phase 02 R1 (BLOCKING-2): STATELESS EXECUTOR MODE ─────────────────
  // When --session is given, this script is a pure executor: it does NOT scan
  // active goals, does NOT decide which goal to recover, and does NOT own any
  // recovery policy. The caller (Guardian after a restart, or EC) has already
  // decided the session+goal to act on. We only perform the requested action.
  if (opts.executorSession) {
    const sessionId = opts.executorSession;
    const goalRef = opts.executorGoalRef || sessionId;
    console.log(`[goal-recovery] executor mode session=${sessionId} action=${opts.executorAction}`);
    if (opts.executorAction === "continue") {
      try {
        await promptContinue(base, sessionId, opts.message);
        console.log(`[goal-recovery] executor: continue queued for ${sessionId}`);
        process.exit(0);
      } catch (e) {
        console.error(`[goal-recovery] executor: continue failed: ${e.message}`);
        process.exit(3);
      }
    }
    // default action: resume
    try {
      await resumeGoal(base, sessionId, goalRef);
      console.log(`[goal-recovery] executor: resume sent for ${sessionId}`);
      process.exit(0);
    } catch (e) {
      if (isAlreadyArmed(e)) {
        console.log(`[goal-recovery] executor: already armed, no-op ${sessionId}`);
        process.exit(0);
      }
      console.error(`[goal-recovery] executor: resume failed: ${e.message}`);
      process.exit(3);
    }
  }

  // ── Phase 02 R2 (BLOCKING-2): no autonomous recovery path ────────────────
  // The default (no --session, no --check) autonomous scan->claim->resume engine
  // is REMOVED / fail-closed. Goal recovery decisions belong solely to EC.
  // Surviving surface:
  //   1. --check            : read-only active-goal projection (Guardian stuck-safety)
  //   2. --session ...      : explicit stateless executor (resume / continue)
  // Anything else -> fail-closed (exit 4, no action).
  if (opts.check) {
    try {
      const sessions = await activeGoalSessions(base);
      console.log(`[goal-recovery] active goal count=${sessions.length}`);
      return sessions.length > 0 ? 0 : 1;
    } catch (e) {
      console.error(`[goal-recovery] check failed: ${e.message}`);
      process.exit(2);
    }
  }

  // Reaching here with no --session means an autonomous recovery was requested
  // without an explicit target: fail-closed. EC is the only recovery authority.
  console.error("[goal-recovery] autonomous recovery path is disabled (BLOCKING-2); use --session <id> --action <resume|continue> or --check");
  process.exit(4);
}

main().then((code) => {
  process.exitCode = code;
}).catch(() => {
  console.error("[goal-recovery] unexpected failure; no further action taken");
  process.exitCode = 2;
});
