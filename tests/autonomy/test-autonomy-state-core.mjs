// test-autonomy-state-core.mjs — P3 AUTONOMY R1 纯逻辑单测（repo 直连，无外部依赖）
//
// 覆盖 autonomy-state-core.mjs：
//   C1  emptyAutonomy 默认形状
//   C2  sanitizeAutonomy 白名单裁剪（未知字段丢弃）+ lastProgressAt/lastErrorClass
//   C3  acceptanceCriteria write-once（二次设置拒绝、原值保留）
//   C4  acceptanceCriteria 校验（>12 条 / 空串 / >500 / 非字符串 拒绝）
//   C5  remainingSteps / currentStep 上限与裁剪
//   C6  verifiedMilestones 整表替换 + FIFO 上限（保留最新 50）
//   C7  upsertCriterionResult：插入、按 index 覆盖、非法拒绝、PASS 缺证据拒绝
//   C8  deriveVerificationState：null / UNVERIFIED / PARTIAL / VERIFIED / FAILED
//   C9  buildResumeProgressLine：空 → null；有里程碑 → 尾注"不重做已验证里程碑"
//   C10 verificationState 枚举钳制（非法值 → null）
//   C11 证据机器规范解析（P3 R1 Correction）：parseFileHashEvidence / parseSystemApiEvidence
//   C12 hostVerifyEvidence 宿主侧确定性复核（io 注入）：file_hash / system_api / fail-closed
//   C13 criteriaBindings sanitize + write-once merge（R1C-2）：canon 存储、字段/端口/
//       绝对路径校验、长度强耦合、改绑拒绝、幂等重申、null 清空拒绝、none 绑定

import {
  emptyAutonomy,
  sanitizeAutonomy,
  upsertCriterionResult,
  deriveVerificationState,
  buildResumeProgressLine,
  parseFileHashEvidence,
  parseSystemApiEvidence,
  hostVerifyEvidence,
  canonPath,
  HOST_VERIFIABLE_CLASSES,
  AUTONOMY_SCHEMA_VERSION,
  MAX_ACCEPTANCE_ITEMS,
  MAX_MILESTONES,
} from "../../plugins/autonomy-state-core.mjs";

let pass = 0, fail = 0;
function assert(c, n, d = "") { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + " " + d); } }
function section(t) { console.log(`\n=== ${t} ===`); }

section("C1: emptyAutonomy default shape");
{
  const a = emptyAutonomy();
  assert(a.acceptanceCriteria === null, "acceptanceCriteria null");
  assert(a.criteriaEvidence === null, "criteriaEvidence null");
  assert(Array.isArray(a.verifiedMilestones) && a.verifiedMilestones.length === 0, "verifiedMilestones empty array");
  assert(a.currentStep === null && a.remainingSteps === null, "step fields null");
  assert(a.lastProgressAt === null && a.lastVerifiedCheckpoint === null, "timestamps null");
  assert(a.verificationState === null && a.lastErrorClass === null, "state fields null");
  assert(AUTONOMY_SCHEMA_VERSION === 4, "schema version is 4 (R1C-2: bindings + completion-verification kind)", `got ${AUTONOMY_SCHEMA_VERSION}`);
}

section("C2: sanitize whitelist + trims");
{
  const r = sanitizeAutonomy({
    currentStep: "  running regression tests  ",
    lastErrorClass: "TIMEOUT_NETWORK",
    lastProgressAt: 12345,
    rogueField: "must be dropped",
  }, null);
  assert(r.ok === true, "patch accepted");
  assert(r.value.currentStep === "running regression tests", "currentStep trimmed");
  assert(r.value.lastErrorClass === "TIMEOUT_NETWORK", "lastErrorClass stored");
  assert(r.value.lastProgressAt === 12345, "lastProgressAt stored");
  assert(!("rogueField" in r.value), "unknown field dropped");
}

section("C3: acceptanceCriteria write-once");
{
  const first = sanitizeAutonomy({ acceptanceCriteria: ["tests pass", "server healthy"] }, null);
  assert(first.ok && first.value.acceptanceCriteria.length === 2, "first set accepted");
  const second = sanitizeAutonomy({ acceptanceCriteria: ["overwrite attempt"] }, first.value);
  assert(second.ok === false && second.errors.includes("immutable_acceptance_criteria"), "second set rejected (immutable)");
  assert(second.value === undefined && first.value.acceptanceCriteria.length === 2, "rejection carries no value; original criteria preserved in state");
}

section("C4: acceptanceCriteria validation");
{
  assert(sanitizeAutonomy({ acceptanceCriteria: [] }, null).ok === false, "empty list rejected");
  const tooMany = Array.from({ length: MAX_ACCEPTANCE_ITEMS + 1 }, (_, i) => `c${i}`);
  assert(sanitizeAutonomy({ acceptanceCriteria: tooMany }, null).ok === false, ">12 rejected");
  assert(sanitizeAutonomy({ acceptanceCriteria: ["ok", "  "] }, null).ok === false, "blank item rejected");
  assert(sanitizeAutonomy({ acceptanceCriteria: ["x".repeat(501)] }, null).ok === false, ">500 chars rejected");
  assert(sanitizeAutonomy({ acceptanceCriteria: ["fine", 42] }, null).ok === false, "non-string rejected");
}

section("C5: step fields caps");
{
  const r = sanitizeAutonomy({ currentStep: "s".repeat(400) }, null);
  assert(r.value.currentStep.length === 300, "currentStep clipped to 300");
  const r2 = sanitizeAutonomy({ remainingSteps: Array.from({ length: 20 }, (_, i) => `step ${i}`) }, null);
  assert(r2.ok && r2.value.remainingSteps.length === 12, "remainingSteps capped at 12");
  const r3 = sanitizeAutonomy({ remainingSteps: ["", "   "] }, null);
  assert(r3.ok && r3.value.remainingSteps === null, "all-blank remainingSteps -> null");
  const r4 = sanitizeAutonomy({ currentStep: "   " }, null);
  assert(r4.ok && r4.value.currentStep === null, "blank currentStep -> null");
}

section("C6: verifiedMilestones replace + FIFO cap");
{
  const ms = Array.from({ length: MAX_MILESTONES + 10 }, (_, i) => ({ step: `m${i}`, evidenceClass: "system_api", evidence: `e${i}`, at: i }));
  const r = sanitizeAutonomy({ verifiedMilestones: ms }, null);
  assert(r.ok && r.value.verifiedMilestones.length === MAX_MILESTONES, `capped at ${MAX_MILESTONES}`);
  assert(r.value.verifiedMilestones[0].step === "m10", "FIFO keeps newest (oldest dropped)");
  const bad = sanitizeAutonomy({ verifiedMilestones: [{ step: "x", evidenceClass: "not_a_class", evidence: "y" }] }, null);
  assert(bad.ok === false, "invalid evidenceClass rejected");
  const noStep = sanitizeAutonomy({ verifiedMilestones: [{ evidenceClass: "git", evidence: "y" }] }, null);
  assert(noStep.ok === false, "milestone without step rejected");
}

section("C7: upsertCriterionResult");
{
  const empty = null;
  const r1 = upsertCriterionResult(empty, { index: 0, status: "PASS", evidenceClass: "system_api", evidence: "all 6 suites green" });
  assert(r1.ok && r1.value.length === 1 && r1.value[0].status === "PASS", "insert PASS");
  const r2 = upsertCriterionResult(r1.value, { index: 0, status: "FAIL", evidenceClass: "git", evidence: "dirty tree" });
  assert(r2.ok && r2.value.length === 1 && r2.value[0].status === "FAIL", "same index overwritten (upsert)");
  const r3 = upsertCriterionResult(r1.value, { index: 1, status: "PASS", evidenceClass: "file_hash", evidence: "sha ok" });
  assert(r3.ok && r3.value.length === 2 && r3.value[0].index === 0 && r3.value[1].index === 1, "second index appended, sorted");
  assert(upsertCriterionResult(r1.value, { index: 99, status: "PASS", evidenceClass: "git", evidence: "x" }).ok === false, "index out of range rejected");
  assert(upsertCriterionResult(r1.value, { index: 0, status: "MAYBE", evidenceClass: "git", evidence: "x" }).ok === false, "invalid status rejected");
  assert(upsertCriterionResult(r1.value, { index: 0, status: "PASS", evidenceClass: "tarot", evidence: "x" }).ok === false, "invalid evidenceClass rejected");
  assert(upsertCriterionResult(r1.value, { index: 0, status: "PASS", evidenceClass: "git", evidence: "  " }).ok === false, "PASS without evidence rejected");
  const un = upsertCriterionResult(r1.value, { index: 0, status: "UNVERIFIED", evidenceClass: "ai_judgment", evidence: null });
  assert(un.ok === true, "UNVERIFIED without evidence allowed");
}

section("C8: deriveVerificationState");
{
  const criteria = ["a", "b", "c"];
  assert(deriveVerificationState(null, null) === null, "no criteria -> null");
  assert(deriveVerificationState(criteria, []) === "UNVERIFIED", "no evidence -> UNVERIFIED");
  const onePass = [{ index: 0, status: "PASS" }];
  assert(deriveVerificationState(criteria, onePass) === "PARTIAL", "1/3 pass -> PARTIAL");
  const allPass = [{ index: 0, status: "PASS" }, { index: 1, status: "PASS" }, { index: 2, status: "PASS" }];
  assert(deriveVerificationState(criteria, allPass) === "VERIFIED", "all pass -> VERIFIED");
  const withFail = [{ index: 0, status: "PASS" }, { index: 1, status: "FAIL" }];
  assert(deriveVerificationState(criteria, withFail) === "FAILED", "any fail -> FAILED");
  const dup = [{ index: 0, status: "FAIL" }, { index: 0, status: "PASS" }];
  assert(deriveVerificationState(criteria, dup) === "PARTIAL", "upsert semantics: last write per index wins (0=PASS, 1/2 unverified -> PARTIAL)");
  assert(deriveVerificationState(["only"], [{ index: 0, status: "PASS" }]) === "VERIFIED", "single criterion pass -> VERIFIED");
}

section("C9: buildResumeProgressLine");
{
  assert(buildResumeProgressLine(null) === null, "null -> null");
  assert(buildResumeProgressLine(emptyAutonomy()) === null, "empty -> null (no injection, legacy behavior)");
  const stepOnly = { currentStep: "fixing router", verifiedMilestones: [] };
  const line1 = buildResumeProgressLine(stepOnly);
  assert(line1 && line1.includes('current step "fixing router"'), "step present");
  assert(!line1.includes("do not redo"), "no milestones -> no redo tail");
  const full = {
    currentStep: "e2e verify",
    verifiedMilestones: [{ step: "core merged", evidenceClass: "git", evidence: "clean tree" }],
    acceptanceCriteria: ["a", "b"],
    criteriaEvidence: [{ index: 0, status: "PASS" }],
    lastVerifiedCheckpoint: "p3r1 checkpoint A",
  };
  const line2 = buildResumeProgressLine(full);
  assert(line2.includes('current step "e2e verify"'), "step");
  assert(line2.includes("milestones verified: 1"), "milestone count");
  assert(line2.includes('acceptance 1/2 PASS'), "acceptance progress");
  assert(line2.includes('last verified checkpoint: "p3r1 checkpoint A"'), "checkpoint");
  assert(line2.includes("do not redo verified milestones"), "redo-avoidance tail present");
}

section("C10: verificationState clamp");
{
  const r = sanitizeAutonomy({ verificationState: "GOLDEN" }, null);
  assert(r.ok && r.value.verificationState === null, "invalid enum -> null");
  const r2 = sanitizeAutonomy({ verificationState: "PARTIAL" }, null);
  assert(r2.ok && r2.value.verificationState === "PARTIAL", "valid enum stored");
}

section("C11: machine-checkable evidence spec parsers (P3 R1 Correction)");
{
  assert(Array.isArray(HOST_VERIFIABLE_CLASSES) && HOST_VERIFIABLE_CLASSES.join(",") === "system_api,file_hash", "HOST_VERIFIABLE_CLASSES = system_api,file_hash");

  // file_hash 合法样例
  const ok1 = parseFileHashEvidence("file:C:\\work\\proof.txt|sha256:ABCD0123abcd4567ABCD0123abcd4567ABCD0123abcd4567ABCD0123abcd4567|note here");
  assert(ok1.ok && ok1.value.path === "C:\\work\\proof.txt", "file_hash: valid spec, path parsed");
  assert(ok1.ok && ok1.value.sha256 === "abcd0123abcd4567abcd0123abcd4567abcd0123abcd4567abcd0123abcd4567", "file_hash: hex normalized lowercase");
  assert(ok1.ok && ok1.value.note === "note here", "file_hash: note preserved");
  const ok2 = parseFileHashEvidence("  file:/abs/proof|sha256:" + "a".repeat(64) + "  ");
  assert(ok2.ok && ok2.value.path === "/abs/proof" && ok2.value.note === null, "file_hash: posix path + no note, trims");

  // file_hash 非法样例（fail-closed）
  const bad = [
    ["the file looks good and exists", "prose"],
    ["file:proof.txt|sha256:" + "a".repeat(64), "relative path"],
    ["file:C:\\x\\y.txt|sha256:short", "bad hex"],
    ["file:C:\\x\\y.txt", "missing sha256 segment"],
    ["C:\\x\\y.txt|sha256:" + "a".repeat(64), "missing file: prefix"],
    [null, "non-string"],
  ];
  for (const [e, why] of bad) assert(parseFileHashEvidence(e).ok === false, `file_hash reject: ${why}`);
  assert(String(parseFileHashEvidence("file:C:\\x|sha256:zz").reason).startsWith("format_invalid"), "file_hash reject reason format_invalid*");
}

section("C11b: system_api spec parser");
{
  const ok1 = parseSystemApiEvidence("api:port=33311|path=/api/autonomy/state|expectStatus=200|expectContains=verificationState");
  assert(ok1.ok && ok1.value.port === 33311 && ok1.value.path === "/api/autonomy/state", "system_api: valid spec");
  assert(ok1.ok && ok1.value.expectStatus === 200 && ok1.value.expectContains === "verificationState", "system_api: expect fields parsed");
  const ok2 = parseSystemApiEvidence("api:port=8080|path=/x|expectStatus=204|expectContains=a=b|note with spaces");
  assert(ok2.ok && ok2.value.expectContains === "a=b" && ok2.value.note === "note with spaces", "system_api: '=' inside value + note");
  const bad = [
    ["api:port=0|path=/x|expectStatus=200", "port 0"],
    ["api:port=99999|path=/x|expectStatus=200", "port too big"],
    ["api:port=8080|path=x|expectStatus=200", "path no leading slash"],
    ["api:port=8080|path=/x|expectStatus=99", "status <100"],
    ["api:port=8080|path=/x", "missing expectStatus"],
    ["not api at all", "missing api: prefix"],
  ];
  for (const [e, why] of bad) assert(parseSystemApiEvidence(e).ok === false, `system_api reject: ${why}`);
}

section("C12: hostVerifyEvidence — injected io, fail-closed semantics");
{
  const enc = (s) => new TextEncoder().encode(s);
  // --- file_hash ---
  const data = enc("real-evidence-v1");
  const sha = await (async () => (await import("node:crypto")).createHash("sha256").update(data).digest("hex"))();
  const io = {
    readFile: async (p) => { if (p === "C:\\t\\proof.txt") return data; const e = new Error("nope"); e.code = "ENOENT"; throw e; },
    sha256Hex: async (d) => (await import("node:crypto")).createHash("sha256").update(d).digest("hex"),
    fetchImpl: async () => ({ status: 200, text: async () => "verificationState=VERIFIED" }),
  };
  const v1 = await hostVerifyEvidence("file_hash", `file:C:\\t\\proof.txt|sha256:${sha}`, io);
  assert(v1.verified === true && String(v1.detail).startsWith("sha256="), "file_hash: hash match -> verified");
  const v2 = await hostVerifyEvidence("file_hash", `file:C:\\t\\proof.txt|sha256:${"0".repeat(64)}`, io);
  assert(v2.verified === false && v2.reason === "hash_mismatch", "file_hash: wrong hash -> hash_mismatch");
  assert(String(v2.detail).includes("actual=" + sha), "hash_mismatch detail carries actual hash");
  const v3 = await hostVerifyEvidence("file_hash", "file:C:\\t\\missing.txt|sha256:" + sha, io);
  assert(v3.verified === false && v3.reason === "file_missing", "file_hash: ENOENT -> file_missing");
  const v4 = await hostVerifyEvidence("file_hash", "the model says the file exists", io);
  assert(v4.verified === false && String(v4.reason).startsWith("format_invalid"), "file_hash: prose -> format_invalid (fail-closed)");
  const v5 = await hostVerifyEvidence("git", "merged", io);
  assert(v5.verified === false && v5.reason === "class_not_host_verifiable", "non-host class refused by verifier guard");

  // --- system_api ---
  const v6 = await hostVerifyEvidence("system_api", "api:port=12345|path=/api/state|expectStatus=200|expectContains=verificationState", io);
  assert(v6.verified === true && String(v6.detail).includes("host-verified"), "system_api: status+contains match -> verified");
  const v7 = await hostVerifyEvidence("system_api", "api:port=12345|path=/api/state|expectStatus=201", io);
  assert(v7.verified === false && v7.reason === "status_mismatch", "system_api: status mismatch");
  const v8 = await hostVerifyEvidence("system_api", "api:port=12345|path=/api/state|expectStatus=200|expectContains=NOT-PRESENT", io);
  assert(v8.verified === false && v8.reason === "contains_mismatch", "system_api: contains mismatch");
  const ioFail = { ...io, fetchImpl: async () => { throw Object.assign(new Error("connect refused"), { cause: { code: "ECONNREFUSED" } }); } };
  const v9 = await hostVerifyEvidence("system_api", "api:port=1|path=/x|expectStatus=200", ioFail);
  assert(v9.verified === false && v9.reason === "request_failed", "system_api: unreachable -> request_failed");
  const v10 = await hostVerifyEvidence("system_api", "prose about an api call", io);
  assert(v10.verified === false && String(v10.reason).startsWith("format_invalid"), "system_api: prose -> format_invalid");
}

section("C13: criteriaBindings sanitize + write-once merge (R1C-2)");
{
  assert(emptyAutonomy().criteriaBindings === null, "emptyAutonomy: criteriaBindings null");
  const fileSpec = process.platform === "win32" ? "C:\\tmp\\proof-i13.txt" : "/tmp/proof-i13.txt";
  const r1 = sanitizeAutonomy({
    acceptanceCriteria: ["file proof", "api healthy", "manual item"],
    criteriaBindings: [
      { index: 0, kind: "file", path: fileSpec },
      { index: 1, kind: "api", port: 8080, path: "/api/state", expectStatus: 200, expectContains: "VERIFIED" },
      { index: 2, kind: "none", note: "human visual check only" },
    ],
  }, null);
  assert(r1.ok === true, "valid file+api+none bindings accepted", JSON.stringify(r1.errors ?? []));
  assert(r1.value.criteriaBindings.length === 3, "three bindings stored");
  const b0 = r1.value.criteriaBindings[0];
  assert(b0.path === canonPath(fileSpec), "file binding path canonized (case/resolution normalized)", JSON.stringify(b0));
  const b2 = r1.value.criteriaBindings[2];
  assert(b2.kind === "none" && b2.note === "human visual check only", "none binding keeps note");

  // 绑定数组长度与 criteria 强耦合：逐条校验用例必须传满 3 条，否则先撞 bindings_length_mismatch
  const goodBindings = () => [
    { index: 0, kind: "file", path: fileSpec },
    { index: 1, kind: "api", port: 8080, path: "/api/state", expectStatus: 200, expectContains: "VERIFIED" },
    { index: 2, kind: "none", note: "human visual check only" },
  ];
  const reject = (mutate, errSub, label) => {
    const bs = goodBindings();
    mutate(bs);
    const r = sanitizeAutonomy({ criteriaBindings: bs }, r1.value);
    assert(r.ok === false && r.errors.some((e) => String(e).includes(errSub)), label, JSON.stringify(r.errors ?? []));
  };
  reject((bs) => { bs[0].path = "./relative/path.txt"; }, "not_absolute", "relative path rejected");
  reject((bs) => { bs[0].extra = 1; }, "invalid_binding_field:extra", "unknown field on file binding rejected");
  reject((bs) => { bs[1].port = 0; }, "invalid_criteria_binding_port", "port=0 rejected");
  reject((bs) => { bs[1].port = 70000; }, "invalid_criteria_binding_port", "port=70000 rejected");
  reject((bs) => { bs[1].path = "x"; }, "invalid_criteria_binding_path", "api path without leading slash rejected");
  reject((bs) => { bs[1].expectStatus = 99; }, "invalid_criteria_binding_expect_status", "expectStatus=99 rejected");
  reject((bs) => { bs[0].kind = "sftp"; }, "invalid_criteria_binding_kind", "unknown kind rejected");
  reject((bs) => { bs[0].path = process.platform === "win32" ? "C:\\tmp\\other.txt" : "/tmp/other.txt"; }, "immutable_criteria_binding:0", "re-binding index 0 to a different target rejected");
  const rLen = sanitizeAutonomy({ criteriaBindings: [{ index: 9, kind: "none" }] }, r1.value);
  assert(rLen.ok === false && rLen.errors.includes("bindings_length_mismatch"), "length != criteria count rejected", JSON.stringify(rLen.errors ?? []));
  const rNull = sanitizeAutonomy({ criteriaBindings: null }, r1.value);
  assert(rNull.ok === false && rNull.errors.includes("immutable_criteria_bindings"), "null bindings when set -> rejected", JSON.stringify(rNull.errors ?? []));
  const bindNoCriteria = sanitizeAutonomy({ criteriaBindings: [{ index: 0, kind: "none" }] }, null);
  assert(bindNoCriteria.ok === false && bindNoCriteria.errors.includes("bindings_require_criteria"), "bindings without criteria ever set -> bindings_require_criteria", JSON.stringify(bindNoCriteria.errors ?? []));
  const rSame = sanitizeAutonomy({
    criteriaBindings: [
      { index: 0, kind: "file", path: fileSpec },
      { index: 1, kind: "api", port: 8080, path: "/api/state", expectStatus: 200, expectContains: "VERIFIED" },
      { index: 2, kind: "none", note: "human visual check only" },
    ],
  }, r1.value);
  assert(rSame.ok === true, "re-declaring the IDENTICAL bindings accepted (idempotent)", JSON.stringify(rSame.errors ?? []));
  assert(rSame.value.criteriaBindings.length === 3, "bindings preserved after idempotent re-declare");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exitCode = 1;
