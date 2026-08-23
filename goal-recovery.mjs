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

/** 绛夊緟 API 灏辩华锛堟湇鍔″垰閲嶅惎鏃跺彲鑳借繕鍦ㄥ垵濮嬪寲锛夈€?*/
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

/** 鍒楀嚭鎵€鏈?phase=active 鐨?goal 浼氳瘽銆?*/
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

async function main() {
  const opts = parseArgs(process.argv);
  const base = `http://127.0.0.1:${opts.port}`;

  if (!(await waitForApi(base))) {
    console.error(`[goal-recovery] API not ready on ${base} after retries`);
    process.exit(2);
  }

  // 鈹€鈹€ Phase 02 R4 (Step 2): executor surface removed 鈥?no production caller 鈹€鈹€
  // The stateless --session/--action executor had NO production caller (Guardian
  // is no-op; EC owns recovery). Per Reviewer Step 2, the executor is deleted;
  // only the read-only --check projection remains. --session/--action are now
  // rejected (fail-closed) so no dead surface can become a second authority.

  // 鈹€鈹€ Phase 02 R2 (BLOCKING-2): no autonomous recovery path 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // The default (no --session, no --check) autonomous scan->claim->resume engine
  // is REMOVED / fail-closed. Goal recovery decisions belong solely to EC.
  // Surviving surface:
  //   1. --check            : read-only active-goal projection (Guardian stuck-safety)
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
  console.error("[goal-recovery] autonomous recovery path is disabled (BLOCKING-2/R4); only --check read-only is supported");
  process.exit(4);
}

main().then((code) => {
  process.exitCode = code;
}).catch(() => {
  console.error("[goal-recovery] unexpected failure; no further action taken");
  process.exitCode = 2;
});
