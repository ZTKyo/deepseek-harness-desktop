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

import {
  emptyAutonomy,
  sanitizeAutonomy,
  upsertCriterionResult,
  deriveVerificationState,
  buildResumeProgressLine,
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
  assert(AUTONOMY_SCHEMA_VERSION === 3, "schema version is 3");
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

console.log(`\n${"=".repeat(60)}`);
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exitCode = 1;
