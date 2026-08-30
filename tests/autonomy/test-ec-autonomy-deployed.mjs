// test-ec-autonomy-deployed.mjs — P3 AUTONOMY R1 EC 集成测试（导入已部署 execution-continuity.mjs）
//
// 前置：deploy 已把 plugins/execution-continuity.mjs + plugins/autonomy-state-core.mjs
// 复制到 ~/.dsh/profiles/web/（服务未重启时运行中代码不受影响，仅磁盘新版本可测）。
//
// 覆盖：
//   I1  ensure() 迁移：新建 intent → autonomy=empty 默认 + schemaVersion=3；幂等
//   I2  旧 v2 数据迁移：无 autonomy 字段的既有 intent → 迁移后旧字段原样保留
//   I3  applyAutonomyPatch：白名单写入 + persist 落盘（重开 store 可读回）
//   I4  acceptanceCriteria write-once 经工具路径二次设置 → 抛错（immutable）
//   I5  工具执行路径：autonomy_report → autonomy_verify（criterion PASS）→
//       verificationState 派生（PARTIAL→VERIFIED→FAILED）+ milestone/checkpoint
//   I6  autonomy_state 读回快照
//   I7  composeResumeMessage：无 autonomy → 基线文案不变；有 → 注入验证进度行
//   I8  持久化往返：verify 产物经新 IntentStore 实例读回（重启模拟）
//   I9  无 exec.agent.session.id → 工具抛错（fail-soft，不入恢复链路）

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const DEPLOYED = "C:/Users/Administrator/.dsh/profiles/web/execution-continuity.mjs";
const MOD = await import(pathToFileURL(DEPLOYED).href);

let pass = 0, fail = 0;
function assert(c, n, d = "") { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + " " + d); } }
function section(t) { console.log(`\n=== ${t} ===`); }

// mock ctx（同 verify-waiting-user-gate 模式 + tools 服务捕获注册的工具）
function makeMockCtx(withTools = true) {
  const listeners = [];
  const registered = [];
  const services = {
    agents: {}, goals: { get: () => ({ id: "g1", phase: "active" }) },
    sessions: { get: () => undefined },
    llm: { providers: { opencode: { models: [{ id: "deepseek-v4-flash", contextWindow: 1000000 }] } } },
  };
  if (withTools) services.tools = { register: (t) => registered.push(t) };
  const raw = {
    logger: { info() {}, warn() {}, error() {} },
    _listeners: listeners, _registered: registered,
    get(n) { return services[n]; }, read(n) { return services[n]; },
    on(e, h) { listeners.push({ e, h }); return () => {}; },
    effect(g) { const i = g(); i.next(); const s = i.next(); if (typeof s.value === "function") raw._dispose = s.value; },
  };
  return new Proxy(raw, { get(t, p, r) { if (p in t) return Reflect.get(t, p, r); if (p in services) return services[p]; return undefined; } });
}
const fakeExec = (sid) => ({ agent: { session: { id: sid } } });

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ec-autonomy-"));

section("I1: ensure() migration — new intent gets v3 autonomy");
{
  const plugin = MOD.apply(makeMockCtx(), { stateDir, enableAutoResume: false });
  const { store, emptyAutonomy } = plugin._test;
  const it = store.ensure("sess-i1");
  assert(it.schemaVersion === 3, "schemaVersion bumped to 3", `got ${it.schemaVersion}`);
  assert(it.autonomy && typeof it.autonomy === "object", "autonomy sub-object exists");
  const def = emptyAutonomy();
  assert(it.autonomy.acceptanceCriteria === null && it.autonomy.verifiedMilestones.length === 0, "empty defaults");
  const it2 = store.ensure("sess-i1");
  assert(it2.autonomy === it.autonomy, "ensure idempotent (same object)");
}

section("I2: legacy v2 intent migrates, old fields intact");
{
  // 预写一个 v2 形状 store（无 autonomy 字段），由 store 加载触发迁移
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ec-autonomy-v2-"));
  fs.writeFileSync(path.join(dir2, "execution-intents.json"), JSON.stringify({
    version: 1,
    intents: {
      "sess-legacy": {
        sessionId: "sess-legacy", goalId: "g-legacy", state: "RUNNING", autoResume: true,
        retryCount: 2, lastActivity: 111, createdAt: 100, schemaVersion: 2, verificationKind: null,
      },
    },
  }));
  const plugin2 = MOD.apply(makeMockCtx(), { stateDir: dir2, enableAutoResume: false });
  const it = plugin2._test.store.ensure("sess-legacy"); // 迁移在 touch（ensure）时发生；get() 只读原样
  assert(it && it.schemaVersion === 3, "legacy migrated to v3");
  assert(it.autonomy && it.autonomy.verifiedMilestones.length === 0, "autonomy defaults added");
  assert(it.goalId === "g-legacy" && it.retryCount === 2 && it.lastActivity === 111, "legacy fields untouched");
  const untouched = plugin2._test.store.get("sess-legacy");
  assert(untouched.schemaVersion === 3, "migration persisted in loaded data");
}

section("I3: applyAutonomyPatch whitelist + persist round-trip");
{
  const plugin = MOD.apply(makeMockCtx(), { stateDir, enableAutoResume: false });
  const { applyAutonomyPatch, store } = plugin._test;
  const r = applyAutonomyPatch("sess-i3", { currentStep: "deploying bridge", remainingSteps: ["restart", "smoke"], rogue: 1 });
  assert(r.ok === true, "patch accepted");
  assert(!("rogue" in r.value), "rogue dropped");
  const raw = JSON.parse(fs.readFileSync(path.join(stateDir, "execution-intents.json"), "utf8"));
  assert(raw.intents["sess-i3"].autonomy.currentStep === "deploying bridge", "persisted to disk");
  const reopen = MOD.apply(makeMockCtx(), { stateDir, enableAutoResume: false })._test.store;
  const back = reopen.get("sess-i3").autonomy;
  assert(back.currentStep === "deploying bridge" && back.remainingSteps.join() === "restart,smoke", "reloaded from disk");
  assert(typeof store !== "undefined", "store exposed");
}

section("I4+I5: tool surface — report/verify/state via captured register()");
{
  const ctx = makeMockCtx(true);
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: false });
  const tools = ctx._registered;
  const report = tools.find((t) => t && t.name === "autonomy_report");
  const verify = tools.find((t) => t && t.name === "autonomy_verify");
  const state = tools.find((t) => t && t.name === "autonomy_state");
  assert(!!report && !!verify && !!state, "3 autonomy tools registered", `got ${tools.map((t) => t && t.name).join(",")}`);
  if (report && verify && state) {
    const sid = "sess-tools";
    // report: 进度 + write-once 验收标准
    const r1 = await report.execute({ currentStep: "e2e smoke", acceptanceCriteria: ["6 suites green", "server healthy"] }, fakeExec(sid));
    assert(r1.ok === true && r1.autonomy.acceptanceCriteria.length === 2, "report stores criteria");
    let threw = false;
    try { await report.execute({ acceptanceCriteria: ["second set"] }, fakeExec(sid)); } catch { threw = true; }
    assert(threw === true, "second criteria set throws (write-once via tool)");
    // verify: criterion 0 PASS + milestone
    const v1 = await verify.execute({ status: "PASS", evidenceClass: "system_api", evidence: "suites 6/6", criterionIndex: 0, milestoneStep: "core merged" }, fakeExec(sid));
    assert(v1.ok === true && v1.verificationState === "PARTIAL", "1/2 criteria PASS -> PARTIAL", `got ${v1.verificationState}`);
    assert(v1.autonomy.verifiedMilestones.length === 1 && v1.autonomy.lastVerifiedCheckpoint === "core merged", "milestone + checkpoint set");
    // verify: criterion 1 PASS -> VERIFIED
    const v2 = await verify.execute({ status: "PASS", evidenceClass: "file_hash", evidence: "hash match", criterionIndex: 1 }, fakeExec(sid));
    assert(v2.verificationState === "VERIFIED", "all criteria PASS -> VERIFIED", `got ${v2.verificationState}`);
    // verify: criterion 1 改判 FAIL -> FAILED（upsert 后写覆盖）
    const v3 = await verify.execute({ status: "FAIL", evidenceClass: "git", evidence: "dirty tree", criterionIndex: 1 }, fakeExec(sid));
    assert(v3.verificationState === "FAILED", "criterion FAIL -> FAILED", `got ${v3.verificationState}`);
    // state: 读回
    const s1 = await state.execute({}, fakeExec(sid));
    assert(s1.ok === true && s1.state === "RUNNING" && s1.autonomy.verificationState === "FAILED", "state snapshot readable");
    assert(s1.autonomy.criteriaEvidence.filter((e) => e.status === "PASS").length === 1, "evidence ledger correct after upsert");
    // PASS 缺证据 → 抛错
    threw = false;
    try { await verify.execute({ status: "PASS", evidenceClass: "git", evidence: "" }, fakeExec(sid)); } catch { threw = true; }
    assert(threw === true, "PASS without evidence throws");
    // 无会话上下文 → 抛错
    threw = false;
    try { await state.execute({}, {}); } catch { threw = true; }
    assert(threw === true, "missing exec.agent.session throws (fail-soft)");
  }
}

section("I7: composeResumeMessage — additive progress line");
{
  const { composeResumeMessage, emptyAutonomy } = MOD.apply(makeMockCtx(), { stateDir, enableAutoResume: false })._test;
  const baseRestart = "[execution-continuity] The local DSH server restarted while this task was running.";
  const m1 = composeResumeMessage("restart", null);
  assert(m1.startsWith(baseRestart) && !m1.includes("Verified progress"), "no autonomy -> base message unchanged");
  const m2 = composeResumeMessage("interruption", emptyAutonomy());
  assert(m2.includes("recoverable provider/network interruption") && !m2.includes("Verified progress"), "empty autonomy -> no injection (legacy behavior)");
  const m3 = composeResumeMessage("restart", {
    currentStep: "e2e", verifiedMilestones: [{ step: "core merged", evidenceClass: "git", evidence: "clean" }],
    acceptanceCriteria: ["a"], criteriaEvidence: [{ index: 0, status: "PASS" }], lastVerifiedCheckpoint: "ckpt-1",
  });
  assert(m3.startsWith(baseRestart) && m3.includes("Verified progress:"), "progress line injected");
  assert(m3.includes("milestones verified: 1") && m3.includes("do not redo verified milestones"), "redo-avoidance present");
}

section("I8: persistence round-trip across store instances (restart simulation)");
{
  const a = MOD.apply(makeMockCtx(), { stateDir, enableAutoResume: false })._test;
  a.applyAutonomyPatch("sess-i8", { currentStep: "phase B", acceptanceCriteria: ["x done"] });
  await a.composeResumeMessage; // no-op reference
  const verifyTools = (() => {
    const c = makeMockCtx(true);
    MOD.apply(c, { stateDir, enableAutoResume: false });
    return c._registered.find((t) => t.name === "autonomy_verify");
  })();
  await verifyTools.execute({ status: "PASS", evidenceClass: "git", evidence: "merged", criterionIndex: 0, milestoneStep: "phase A done", checkpoint: "ckpt-A" }, fakeExec("sess-i8"));
  const reopened = MOD.apply(makeMockCtx(), { stateDir, enableAutoResume: false })._test.store;
  const back = reopened.get("sess-i8").autonomy;
  assert(back.currentStep === "phase B", "currentStep survived");
  assert(back.verificationState === "VERIFIED", "verificationState survived");
  assert(back.verifiedMilestones.length === 1 && back.verifiedMilestones[0].step === "phase A done", "milestone survived");
  assert(back.lastVerifiedCheckpoint === "ckpt-A", "checkpoint survived");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exitCode = 1;
