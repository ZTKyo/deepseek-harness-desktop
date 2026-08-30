// test-ec-autonomy-deployed.mjs — P3 AUTONOMY R1 EC 集成测试（导入已部署 execution-continuity.mjs）
//
// 前置：deploy 已把 plugins/execution-continuity.mjs + plugins/autonomy-state-core.mjs
// 复制到 ~/.dsh/profiles/web/（服务未重启时运行中代码不受影响，仅磁盘新版本可测）。
//
// 覆盖：
//   I1  ensure() 迁移：新建 intent → autonomy=empty 默认 + schemaVersion=4；幂等
//   I2  旧 v2 数据迁移：无 autonomy 字段的既有 intent → 迁移后旧字段原样保留
//   I3  applyAutonomyPatch：白名单写入 + persist 落盘（重开 store 可读回）
//   I4  acceptanceCriteria write-once 经工具路径二次设置 → 抛错（immutable）
//   I5  工具执行路径：autonomy_report → autonomy_verify（criterion PASS，git 证据）→
//       verificationState 派生（PARTIAL→VERIFIED→FAILED）+ milestone/checkpoint
//       （host-verifiable 类 file_hash/system_api 的确定性复核行为见 I10-I13）
//   I6  autonomy_state 读回快照
//   I7  composeResumeMessage：无 autonomy → 基线文案不变；有 → 注入验证进度行
//   I8  持久化往返：verify 产物经新 IntentStore 实例读回（重启模拟）
//   I9  无 exec.agent.session.id → 工具抛错（fail-soft，不入恢复链路）
//   I10 host 确定性复核（P3 R1 Correction）：伪造 file_hash PASS → 降级 UNVERIFIED，
//       不建里程碑、不写 checkpoint、verificationState≠VERIFIED（fail-closed）
//   I11 真实文件 file_hash 规范（file:<path>|sha256:<hex>）→ PASS + HOST-VERIFIED
//   I12 prose file_hash PASS → format_invalid 降级（fail-closed）
//   I13 system_api 真实回环服务：200+contains → PASS；status 不符 → 降级；不可达 → 降级
//   I14 FAIL 方向不做宿主复核（照单记录 FAIL —— 只会阻断 VERIFIED，无升级风险）
//   I15 软证据 PASS 一律拒收（R1C-2 Blocker B）：SOFT-EVIDENCE 前缀 + UNVERIFIED，
//       不建里程碑/不写 checkpoint；FAIL 方向不受影响
//   I16 R1C-2 绑定门禁：未绑定 file_hash PASS（即使证据真实）→ target_unbound；
//       事后声明绑定（write-once）→ 同证据 PASS → VERIFIED
//   I17 绑定门禁·错目标：真实文件但非绑定目标 → target_binding_mismatch；
//       kind 不匹配（api 绑定提交 file_hash）→ target_binding_mismatch
//   I18 绑定门禁·api：expectStatus 与绑定不符 → target_binding_mismatch（先于网络，
//       确定性）；与绑定全等 + 真实回环请求 → PASS → VERIFIED
//   I19 绑定 write-once：同 index 改绑 → immutable_criteria_binding:<n> 抛错；
//       相同值重复声明幂等放行

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const DEPLOYED = "C:/Users/Administrator/.dsh/profiles/web/execution-continuity.mjs";
const MOD = await import(pathToFileURL(DEPLOYED).href);

let pass = 0, fail = 0;
const sha256Hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
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
  assert(it.schemaVersion === 4, "schemaVersion bumped to 4", `got ${it.schemaVersion}`);
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
  assert(it && it.schemaVersion === 4, "legacy migrated to v4");
  assert(it.autonomy && it.autonomy.verifiedMilestones.length === 0, "autonomy defaults added");
  assert(it.goalId === "g-legacy" && it.retryCount === 2 && it.lastActivity === 111, "legacy fields untouched");
  const untouched = plugin2._test.store.get("sess-legacy");
  assert(untouched.schemaVersion === 4, "migration persisted in loaded data");
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
    const proof0 = path.join(stateDir, "proof-tools-0.txt");
    const proof1 = path.join(stateDir, "proof-tools-1.txt");
    fs.writeFileSync(proof0, "tools-proof-0", "utf8");
    fs.writeFileSync(proof1, "tools-proof-1", "utf8");
    // report: 进度 + write-once 验收标准 + R1C-2 绑定（host 类 PASS 的前置条件）
    const r1 = await report.execute({
      currentStep: "e2e smoke",
      acceptanceCriteria: ["6 suites green", "server healthy"],
      criteriaBindings: [
        { kind: "file", index: 0, path: proof0 },
        { kind: "file", index: 1, path: proof1 },
      ],
    }, fakeExec(sid));
    assert(r1.ok === true && r1.autonomy.acceptanceCriteria.length === 2, "report stores criteria");
    assert((r1.autonomy.criteriaBindings?.length ?? 0) === 2, "report stores bindings alongside criteria");
    let threw = false;
    try { await report.execute({ acceptanceCriteria: ["second set"] }, fakeExec(sid)); } catch { threw = true; }
    assert(threw === true, "second criteria set throws (write-once via tool)");
    // verify: criterion 0 PASS（file_hash 宿主复核 + 绑定匹配）+ milestone
    const v1 = await verify.execute({ status: "PASS", evidenceClass: "file_hash", evidence: `file:${proof0}|sha256:${sha256Hex(fs.readFileSync(proof0))}`, criterionIndex: 0, milestoneStep: "core merged" }, fakeExec(sid));
    assert(v1.ok === true && v1.verificationState === "PARTIAL", "1/2 criteria PASS -> PARTIAL", `got ${v1.verificationState}`);
    assert(v1.autonomy.verifiedMilestones.length === 1 && v1.autonomy.lastVerifiedCheckpoint === "core merged", "milestone + checkpoint set");
    // verify: criterion 1 PASS（file_hash）-> VERIFIED
    const v2 = await verify.execute({ status: "PASS", evidenceClass: "file_hash", evidence: `file:${proof1}|sha256:${sha256Hex(fs.readFileSync(proof1))}`, criterionIndex: 1 }, fakeExec(sid));
    assert(v2.verificationState === "VERIFIED", "all criteria PASS -> VERIFIED", `got ${v2.verificationState}`);
    // verify: criterion 1 改判 FAIL（git 类 FAIL 方向无门禁）-> FAILED（upsert 后写覆盖）
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
  const proofI8 = path.join(stateDir, "proof-i8.txt");
  fs.writeFileSync(proofI8, "i8-proof", "utf8");
  // R1C-2：PASS 用宿主可复核类（file_hash）+ 绑定，保证 VERIFIED 真实落账
  a.applyAutonomyPatch("sess-i8", {
    currentStep: "phase B",
    acceptanceCriteria: ["x done"],
    criteriaBindings: [{ kind: "file", index: 0, path: proofI8 }],
  });
  await a.composeResumeMessage; // no-op reference
  const verifyTools = (() => {
    const c = makeMockCtx(true);
    MOD.apply(c, { stateDir, enableAutoResume: false });
    return c._registered.find((t) => t.name === "autonomy_verify");
  })();
  await verifyTools.execute({ status: "PASS", evidenceClass: "file_hash", evidence: `file:${proofI8}|sha256:${sha256Hex(fs.readFileSync(proofI8))}`, criterionIndex: 0, milestoneStep: "phase A done", checkpoint: "ckpt-A" }, fakeExec("sess-i8"));
  const reopened = MOD.apply(makeMockCtx(), { stateDir, enableAutoResume: false })._test.store;
  const back = reopened.get("sess-i8").autonomy;
  assert(back.currentStep === "phase B", "currentStep survived");
  assert(back.verificationState === "VERIFIED", "verificationState survived");
  assert(back.verifiedMilestones.length === 1 && back.verifiedMilestones[0].step === "phase A done", "milestone survived");
  assert(back.lastVerifiedCheckpoint === "ckpt-A", "checkpoint survived");
}

// ── P3 R1 Correction（外审 Round 1 blocker）：宿主侧确定性复核门禁 ──
// （sha256Hex 定义已前移至文件顶部，供 I4+I5 段使用）
function httpServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

section("I10: fabricated file_hash PASS fails closed (downgrade to UNVERIFIED, no milestone/checkpoint)");
{
  const ctx = makeMockCtx(true);
  const plugin = MOD.apply(ctx, { stateDir, enableAutoResume: false });
  const report = ctx._registered.find((t) => t.name === "autonomy_report");
  const verify = ctx._registered.find((t) => t.name === "autonomy_verify");
  const sid = "sess-i10";
  // R1C-2：绑定指向同一（不存在的）目标 → 门禁放行 → 真正的宿主复核 ENOENT -> file_missing
  await report.execute({ acceptanceCriteria: ["proof exists"], criteriaBindings: [{ kind: "file", index: 0, path: path.join(stateDir, "nope-does-not-exist.txt") }] }, fakeExec(sid));
  const v = await verify.execute({
    status: "PASS", evidenceClass: "file_hash",
    evidence: `file:${path.join(stateDir, "nope-does-not-exist.txt")}|sha256:${"f".repeat(64)}|model claims it wrote this`,
    criterionIndex: 0, milestoneStep: "fake milestone", checkpoint: "fake ckpt",
  }, fakeExec(sid));
  const rec = v.autonomy.criteriaEvidence[0];
  assert(v.ok === true, "tool call itself succeeds (recorded, not thrown)");
  assert(rec.status === "UNVERIFIED", "claimed PASS downgraded to UNVERIFIED", JSON.stringify(rec));
  assert(String(rec.evidence).startsWith("HOST-VERIFY FAILED (file_missing"), "host verify failure reason recorded", rec.evidence);
  assert(v.autonomy.verifiedMilestones.length === 0, "no milestone appended by fake claim");
  assert(v.autonomy.lastVerifiedCheckpoint === null, "no checkpoint written by fake claim");
  assert(v.verificationState === "UNVERIFIED" && v.verificationState !== "VERIFIED", "verificationState != VERIFIED");
}

section("I11: real file + real sha256 spec -> PASS with HOST-VERIFIED record");
{
  const ctx = makeMockCtx(true);
  MOD.apply(ctx, { stateDir, enableAutoResume: false });
  const report = ctx._registered.find((t) => t.name === "autonomy_report");
  const verify = ctx._registered.find((t) => t.name === "autonomy_verify");
  const sid = "sess-i11";
  await report.execute({ acceptanceCriteria: ["proof exists"] }, fakeExec(sid));
  const proofPath = path.join(stateDir, "proof-i11.txt");
  fs.writeFileSync(proofPath, "real-evidence-v1", "utf8");
  const realHash = sha256Hex(fs.readFileSync(proofPath));
  // R1C-2：PASS 前先声明绑定（write-once per index）
  await report.execute({ criteriaBindings: [{ kind: "file", index: 0, path: proofPath }] }, fakeExec(sid));
  const v = await verify.execute({
    status: "PASS", evidenceClass: "file_hash",
    evidence: `file:${proofPath}|sha256:${realHash}`,
    criterionIndex: 0, milestoneStep: "real proof verified", checkpoint: "ckpt-i11",
  }, fakeExec(sid));
  const rec = v.autonomy.criteriaEvidence[0];
  assert(rec.status === "PASS" && v.verificationState === "VERIFIED", "real evidence -> PASS -> VERIFIED", JSON.stringify(rec));
  assert(String(rec.evidence).startsWith("HOST-VERIFIED (sha256="), "HOST-VERIFIED prefix recorded (host-side verification ran)", rec.evidence.slice(0, 80));
  assert(v.autonomy.verifiedMilestones.length === 1, "milestone appended with real evidence");
  assert(v.autonomy.lastVerifiedCheckpoint === "ckpt-i11", "checkpoint written on PASS");
}

section("I12: prose file_hash PASS -> format_invalid fail-closed");
{
  const ctx = makeMockCtx(true);
  MOD.apply(ctx, { stateDir, enableAutoResume: false });
  const report = ctx._registered.find((t) => t.name === "autonomy_report");
  const verify = ctx._registered.find((t) => t.name === "autonomy_verify");
  const sid = "sess-i12";
  await report.execute({ acceptanceCriteria: ["x"] }, fakeExec(sid));
  const v = await verify.execute({ status: "PASS", evidenceClass: "file_hash", evidence: "I definitely wrote the file, hash looks right", criterionIndex: 0, milestoneStep: "prose milestone" }, fakeExec(sid));
  const rec = v.autonomy.criteriaEvidence[0];
  assert(rec.status === "UNVERIFIED" && String(rec.evidence).includes("format_invalid"), "prose -> UNVERIFIED + format_invalid", rec.evidence);
  assert(v.autonomy.verifiedMilestones.length === 0 && v.autonomy.lastVerifiedCheckpoint === null, "no milestone/checkpoint from prose");
}

section("I13: system_api real loopback — PASS on match, downgrade on mismatch/unreachable");
{
  const ctx = makeMockCtx(true);
  MOD.apply(ctx, { stateDir, enableAutoResume: false });
  const report = ctx._registered.find((t) => t.name === "autonomy_report");
  const verify = ctx._registered.find((t) => t.name === "autonomy_verify");
  const sid = "sess-i13";
  const srv = await httpServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("verificationState=VERIFIED"); });
  const port = srv.address().port;
  // R1C-2：三个子场景各用独立 criterion + 绑定（绑定在声明时固定 port/path/期望，
  // 门禁通过后由真实宿主复核给出 status_mismatch / request_failed）
  await report.execute({
    acceptanceCriteria: ["api ok (match)", "api status mismatch", "api unreachable"],
    criteriaBindings: [
      { kind: "api", index: 0, port, path: "/ok", expectStatus: 200, expectContains: "verificationState" },
      { kind: "api", index: 1, port, path: "/ok", expectStatus: 201 },
      { kind: "api", index: 2, port, path: "/ok", expectStatus: 200 },
    ],
  }, fakeExec(sid));
  const vOk = await verify.execute({
    status: "PASS", evidenceClass: "system_api",
    evidence: `api:port=${port}|path=/ok|expectStatus=200|expectContains=verificationState`,
    criterionIndex: 0, milestoneStep: "api checked", checkpoint: "ckpt-i13",
  }, fakeExec(sid));
  assert(vOk.autonomy.criteriaEvidence.find((e) => e.index === 0).status === "PASS" && vOk.verificationState === "PARTIAL", "matching 200+contains -> PASS (1/3 -> PARTIAL)", JSON.stringify(vOk.autonomy.criteriaEvidence));
  assert(String(vOk.autonomy.criteriaEvidence.find((e) => e.index === 0).evidence).startsWith("HOST-VERIFIED"), "HOST-VERIFIED recorded for system_api");
  const vBad = await verify.execute({
    status: "PASS", evidenceClass: "system_api",
    evidence: `api:port=${port}|path=/ok|expectStatus=201`,
    criterionIndex: 1,
  }, fakeExec(sid));
  const recBad = vBad.autonomy.criteriaEvidence.find((e) => e.index === 1);
  assert(recBad.status === "UNVERIFIED" && String(recBad.evidence).includes("status_mismatch"), "wrong expected status -> downgraded (real host verify)", recBad.evidence);
  assert(vBad.verificationState === "PARTIAL", "state PARTIAL (1 pass kept, mismatch upsert isolated to its own criterion)");
  await new Promise((r) => srv.close(r));
  const vDead = await verify.execute({
    status: "PASS", evidenceClass: "system_api",
    evidence: `api:port=${port}|path=/ok|expectStatus=200`,
    criterionIndex: 2,
  }, fakeExec(sid));
  const recDead = vDead.autonomy.criteriaEvidence.find((e) => e.index === 2);
  assert(recDead.status === "UNVERIFIED" && String(recDead.evidence).includes("request_failed"), "unreachable -> downgraded (request_failed)", recDead.evidence);
}

section("I14: FAIL direction not host-gated (recorded as-is)");
{
  const ctx = makeMockCtx(true);
  MOD.apply(ctx, { stateDir, enableAutoResume: false });
  const report = ctx._registered.find((t) => t.name === "autonomy_report");
  const verify = ctx._registered.find((t) => t.name === "autonomy_verify");
  const sid = "sess-i14";
  await report.execute({ acceptanceCriteria: ["x"] }, fakeExec(sid));
  const v = await verify.execute({ status: "FAIL", evidenceClass: "file_hash", evidence: "hash mismatch found during build", criterionIndex: 0 }, fakeExec(sid));
  assert(v.autonomy.criteriaEvidence[0].status === "FAIL", "FAIL recorded unchanged (no host gate on fail direction)");
  assert(v.verificationState === "FAILED", "FAIL -> FAILED");
}

section("I15: soft-evidence PASS rejected (SOFT-EVIDENCE prefix, UNVERIFIED, no milestone) — R1C-2");
{
  const ctx = makeMockCtx(true);
  MOD.apply(ctx, { stateDir, enableAutoResume: false });
  const report = ctx._registered.find((t) => t.name === "autonomy_report");
  const verify = ctx._registered.find((t) => t.name === "autonomy_verify");
  const sid = "sess-i15";
  await report.execute({ acceptanceCriteria: ["visual check"] }, fakeExec(sid));
  const v = await verify.execute({ status: "PASS", evidenceClass: "ai_judgment", evidence: "screenshot reviewed, layout correct", criterionIndex: 0, milestoneStep: "ui verified" }, fakeExec(sid));
  const rec = v.autonomy.criteriaEvidence[0];
  assert(rec.status === "UNVERIFIED" && String(rec.evidence).startsWith("SOFT-EVIDENCE"), "soft PASS downgraded to UNVERIFIED with SOFT-EVIDENCE prefix", JSON.stringify(rec));
  assert(v.verificationState === "UNVERIFIED", "verificationState stays UNVERIFIED", v.verificationState);
  assert(v.autonomy.verifiedMilestones.length === 0 && v.autonomy.lastVerifiedCheckpoint === null, "no milestone/checkpoint from soft evidence");
  const vFail = await verify.execute({ status: "FAIL", evidenceClass: "ai_judgment", evidence: "layout wrong", criterionIndex: 0 }, fakeExec(sid));
  assert(vFail.autonomy.criteriaEvidence[0].status === "FAIL" && vFail.verificationState === "FAILED", "FAIL direction unaffected by soft gate -> FAILED");
}

section("I16: R1C-2 binding gate — unbound file_hash PASS -> target_unbound; declared binding -> PASS");
{
  const ctx = makeMockCtx(true);
  MOD.apply(ctx, { stateDir, enableAutoResume: false });
  const report = ctx._registered.find((t) => t.name === "autonomy_report");
  const verify = ctx._registered.find((t) => t.name === "autonomy_verify");
  const sid = "sess-i16";
  await report.execute({ acceptanceCriteria: ["proof exists"] }, fakeExec(sid));
  const proofPath = path.join(stateDir, "proof-i16.txt");
  fs.writeFileSync(proofPath, "binding-gate-v1", "utf8");
  const ev = `file:${proofPath}|sha256:${sha256Hex(fs.readFileSync(proofPath))}`;
  const vUnbound = await verify.execute({ status: "PASS", evidenceClass: "file_hash", evidence: ev, criterionIndex: 0 }, fakeExec(sid));
  const recU = vUnbound.autonomy.criteriaEvidence[0];
  assert(recU.status === "UNVERIFIED" && String(recU.evidence).includes("target_unbound"), "unbound -> UNVERIFIED target_unbound (even with genuinely valid evidence)", recU.evidence);
  assert(vUnbound.verificationState !== "VERIFIED" && vUnbound.autonomy.verifiedMilestones.length === 0, "no VERIFIED/milestone while unbound");
  const rBind = await report.execute({ criteriaBindings: [{ kind: "file", index: 0, path: proofPath }] }, fakeExec(sid));
  assert(rBind.ok === true && (rBind.autonomy.criteriaBindings?.length ?? 0) === 1, "binding declared after the fact (write-once per index, before any PASS)");
  const vBound = await verify.execute({ status: "PASS", evidenceClass: "file_hash", evidence: ev, criterionIndex: 0, milestoneStep: "bound and verified", checkpoint: "ckpt-i16" }, fakeExec(sid));
  assert(vBound.autonomy.criteriaEvidence[0].status === "PASS" && vBound.verificationState === "VERIFIED", "bound + real evidence -> PASS -> VERIFIED", JSON.stringify(vBound.autonomy.criteriaEvidence[0]));
}

section("I17: R1C-2 binding gate — wrong target / wrong kind -> target_binding_mismatch");
{
  const ctx = makeMockCtx(true);
  MOD.apply(ctx, { stateDir, enableAutoResume: false });
  const report = ctx._registered.find((t) => t.name === "autonomy_report");
  const verify = ctx._registered.find((t) => t.name === "autonomy_verify");
  const sid = "sess-i17";
  const fileA = path.join(stateDir, "bound-i17.txt");
  const fileB = path.join(stateDir, "other-i17.txt");
  fs.writeFileSync(fileA, "bound-content", "utf8");
  fs.writeFileSync(fileB, "other-content", "utf8");
  await report.execute({
    acceptanceCriteria: ["A verified", "api verified"],
    criteriaBindings: [
      { kind: "file", index: 0, path: fileA },
      { kind: "api", index: 1, port: 59999, path: "/health", expectStatus: 200 },
    ],
  }, fakeExec(sid));
  const evB = `file:${fileB}|sha256:${sha256Hex(fs.readFileSync(fileB))}`;
  const vWrongFile = await verify.execute({ status: "PASS", evidenceClass: "file_hash", evidence: evB, criterionIndex: 0 }, fakeExec(sid));
  assert(vWrongFile.autonomy.criteriaEvidence[0].status === "UNVERIFIED" && String(vWrongFile.autonomy.criteriaEvidence[0].evidence).includes("target_binding_mismatch"), "genuine hash of a DIFFERENT real file -> UNVERIFIED target_binding_mismatch", vWrongFile.autonomy.criteriaEvidence[0].evidence);
  const evA = `file:${fileA}|sha256:${sha256Hex(fs.readFileSync(fileA))}`;
  const vA = await verify.execute({ status: "PASS", evidenceClass: "file_hash", evidence: evA, criterionIndex: 0 }, fakeExec(sid));
  assert(vA.autonomy.criteriaEvidence[0].status === "PASS", "evidence for the BOUND file -> PASS");
  const vKind = await verify.execute({ status: "PASS", evidenceClass: "file_hash", evidence: evA, criterionIndex: 1 }, fakeExec(sid));
  const recK = vKind.autonomy.criteriaEvidence.find((e) => e.index === 1);
  assert(recK && recK.status === "UNVERIFIED" && String(recK.evidence).includes("target_binding_mismatch"), "file_hash PASS against an api-bound criterion -> UNVERIFIED", recK?.evidence);
}

section("I18: R1C-2 api binding — spec/binding mismatch pre-network; matching + real loopback -> VERIFIED");
{
  const ctx = makeMockCtx(true);
  MOD.apply(ctx, { stateDir, enableAutoResume: false });
  const report = ctx._registered.find((t) => t.name === "autonomy_report");
  const verify = ctx._registered.find((t) => t.name === "autonomy_verify");
  const sid = "sess-i18";
  const srv = await httpServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok=i18"); });
  const port = srv.address().port;
  try {
    await report.execute({
      acceptanceCriteria: ["api endpoint healthy"],
      criteriaBindings: [{ kind: "api", index: 0, port, path: "/ok", expectStatus: 200, expectContains: "ok=i18" }],
    }, fakeExec(sid));
    const vMismatch = await verify.execute({ status: "PASS", evidenceClass: "system_api", evidence: `api:port=${port}|path=/ok|expectStatus=201`, criterionIndex: 0 }, fakeExec(sid));
    assert(vMismatch.autonomy.criteriaEvidence[0].status === "UNVERIFIED" && String(vMismatch.autonomy.criteriaEvidence[0].evidence).includes("target_binding_mismatch"), "expectStatus mismatch vs binding -> UNVERIFIED (deterministic, before any request)", vMismatch.autonomy.criteriaEvidence[0].evidence);
    const vOk = await verify.execute({ status: "PASS", evidenceClass: "system_api", evidence: `api:port=${port}|path=/ok|expectStatus=200|expectContains=ok=i18`, criterionIndex: 0, milestoneStep: "api bound verified", checkpoint: "ckpt-i18" }, fakeExec(sid));
    assert(vOk.autonomy.criteriaEvidence[0].status === "PASS" && vOk.verificationState === "VERIFIED", "binding-matching real loopback request -> PASS -> VERIFIED", JSON.stringify(vOk.autonomy.criteriaEvidence[0]));
  } finally { await new Promise((r) => srv.close(r)); }
}

section("I19: R1C-2 binding write-once — re-binding a set index to a different target is rejected");
{
  const ctx = makeMockCtx(true);
  MOD.apply(ctx, { stateDir, enableAutoResume: false });
  const report = ctx._registered.find((t) => t.name === "autonomy_report");
  const sid = "sess-i19";
  const fileA = path.join(stateDir, "i19-a.txt");
  fs.writeFileSync(fileA, "i19", "utf8");
  await report.execute({ acceptanceCriteria: ["x"], criteriaBindings: [{ kind: "file", index: 0, path: fileA }] }, fakeExec(sid));
  const fileC = path.join(stateDir, "i19-c.txt");
  fs.writeFileSync(fileC, "i19c", "utf8");
  let threw = null;
  try { await report.execute({ criteriaBindings: [{ kind: "file", index: 0, path: fileC }] }, fakeExec(sid)); } catch (e) { threw = e; }
  assert(!!threw && String(threw.message).includes("immutable_criteria_binding:0"), "re-binding index 0 to a different path throws immutable_criteria_binding:0", String(threw?.message ?? "no-throw"));
  const rSame = await report.execute({ criteriaBindings: [{ kind: "file", index: 0, path: fileA }] }, fakeExec(sid));
  assert(rSame.ok === true, "re-declaring the IDENTICAL binding is accepted (idempotent)");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exitCode = 1;
