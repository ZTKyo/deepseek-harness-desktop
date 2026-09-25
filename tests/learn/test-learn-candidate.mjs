// test-learn-candidate.mjs —— P4 R2 STAGE 6-7 验收（AC6 / AC7 / AC8 / AC9 + 生命周期）
//
// 验证纪律（沿用 AC5 的教训）：**凡断言"某行为被阻止"，必须同时有"未被阻止"的对照组**，
// 否则无法区分"守卫生效"与"功能根本没跑"。
//
// 运行：node tests/learn/test-learn-candidate.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as C from '../../plugins/learn-candidate.mjs';
import * as L from '../../plugins/learn-core.mjs';
import { qualifyGap, evaluateClassifiedRecord, VETO_REASON } from '../../plugins/learn-gap-veto.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P4 = path.resolve(HERE, '..', '..');

let pass = 0; let fail = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail += 1;
    failures.push(`${name} :: ${e.message}`);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const SID = 'stage67-test-session';
const T = (n) => 1_700_000_000_000 + n;

/** 构造一条**合格**的 gap（真实重复的能力缺口）。 */
function qualifiedGap(over = {}) {
  const record = {
    classification: 'PROTOCOL_MISMATCH',
    normalizedSignature: 'openai::deepseek-v4.1-flash::PROTOCOL_MISMATCH::sig123',
    taxonomyVersion: 1,
  };
  const observations = [
    { taskType: 'plugin-install', record, capabilityDeficiency: 'no retry-on-protocol-mismatch rule', capabilityEvidence: 'reviewed own code: not a self-bug' },
    { taskType: 'plugin-install', record, capabilityDeficiency: 'no retry-on-protocol-mismatch rule', capabilityEvidence: 'reviewed own code: not a self-bug' },
  ];
  const g = qualifyGap(observations);
  return { ...g, ...over };
}

/** 把一个候选推进到 CANARY（三个阶段证据齐备）。 */
function driveToCanary(store, id) {
  let r = C.advanceCandidate(store, id, 'ISOLATED_TESTS', { at: T(1), evidence: 'ci-level2 run 1234 PASS' });
  assert(r.ok, 'advance->ISOLATED_TESTS failed: ' + r.error);
  r = C.advanceCandidate(r.value, id, 'REGRESSION_HOLDOUT', { at: T(2), evidence: 'tx journal commit-ready PASS' });
  assert(r.ok, 'advance->REGRESSION_HOLDOUT failed: ' + r.error);
  r = C.advanceCandidate(r.value, id, 'CANARY', { at: T(3), evidence: 'reliability-lab canary 30min PASS' });
  assert(r.ok, 'advance->CANARY failed: ' + r.error);
  return r.value;
}

console.log('=== STAGE 6-7 验收：Candidate Lifecycle + Autonomous Research ===');
console.log('');

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== A 组：AC7 — Candidate 无法直接覆盖 Stable（核心）===');
// ─────────────────────────────────────────────────────────────────────────────

check('A1 ★ 非 Stable 目标放行（对照组：证明守卫不是一律拒绝）', () => {
  const r = C.stableOverwriteGuard('plugins/learn-candidate.mjs', { mode: 'promotion' });
  assertEq(r.allowed, true, 'AC7 守卫误伤了非 Stable 目标');
  assertEq(r.reason, 'not_a_stable_target');
});

check('A2 ★ direct 模式覆盖 Stable → 一律拒绝（AC7 主断言）', () => {
  const r = C.stableOverwriteGuard('stable/plugins/learn.mjs', { mode: 'direct' });
  assertEq(r.allowed, false, 'AC7 失败：候选可直接覆盖 Stable');
  assertEq(r.reason, 'ac7_direct_stable_overwrite_forbidden');
});

check('A3 ★ 即使候选已走完全部阶段 + 有人批准，direct 仍必须拒绝', () => {
  let store = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store, qualifiedGap(), { at: T(0), ruleExpressible: true });
  store = driveToCanary(p.value, p.candidate.id);
  const r = C.stableOverwriteGuard('production/plugins/x.mjs', {
    mode: 'direct', candidate: store.candidates[0],
    approvedBy: 'user', approvalEvidence: 'ok',
  });
  assertEq(r.allowed, false, 'AC7 失败：带批准的 direct 覆盖被放行');
});

check('A4 ★ Stable 路径变体不可绕过（大小写 / 中间段 / 前缀）', () => {
  for (const t of ['STABLE/x.mjs', 'a/production/b.mjs', 'RELEASE', 'x/lastgood/y.json', 'verified-lastgood.json']) {
    const r = C.stableOverwriteGuard(t, { mode: 'direct' });
    assertEq(r.allowed, false, `变体绕过成功: ${t}`);
  }
});

check('A5 走正规通道但候选未走完管线 → 拒绝', () => {
  const store = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store, qualifiedGap(), { at: T(0), ruleExpressible: true });
  const r = C.stableOverwriteGuard('stable/x', {
    mode: 'promotion', candidate: p.candidate, approvedBy: 'user', approvalEvidence: 'ok',
  });
  assertEq(r.allowed, false);
  assert(r.reason.startsWith('candidate_not_pipeline_complete'), r.reason);
});

check('A6 ★ 管线走完但**无人工批准** → 拒绝（HUMAN APPROVAL 是必要条件）', () => {
  const store0 = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store0, qualifiedGap(), { at: T(0), ruleExpressible: true });
  const store = driveToCanary(p.value, p.candidate.id);
  const r = C.stableOverwriteGuard('stable/x', { mode: 'promotion', candidate: store.candidates[0] });
  assertEq(r.allowed, false);
  assertEq(r.reason, 'missing_human_approval');
});

check('A7 ★ 管线走完 + 人工批准 → 放行（对照组：证明 A6 不是焊死）', () => {
  const store0 = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store0, qualifiedGap(), { at: T(0), ruleExpressible: true });
  const store = driveToCanary(p.value, p.candidate.id);
  const r = C.stableOverwriteGuard('stable/x', {
    mode: 'promotion', candidate: store.candidates[0],
    approvedBy: 'operator', approvalEvidence: 'reviewed canary metrics, approved',
  });
  assertEq(r.allowed, true, '正规通道被误拒: ' + r.reason);
  assertEq(r.reason, 'pipeline_complete_with_human_approval');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('');
console.log('=== B 组：AC6 — 复用既有系统，不造第二套（实证文件存在）===');
// ─────────────────────────────────────────────────────────────────────────────

check('B1 ★ 委托表指向的既有系统文件**真实存在**（非纸面声明）', () => {
  const missing = [];
  for (const [stage, d] of Object.entries(C.STAGE_DELEGATION)) {
    assert(typeof d.file === 'string' && d.file, `${stage} 缺 file 字段`);
    const p = path.join(P4, d.file);
    if (!fs.existsSync(p)) missing.push(`${stage}: ${d.file}`);
  }
  assertEq(missing.length, 0, '被委托的既有系统不存在: ' + missing.join(' | '));
});

check('B2 ★ 委托目标覆盖全部 4 个执行阶段，且无自建系统', () => {
  for (const s of ['ISOLATED_TESTS', 'REGRESSION_HOLDOUT', 'CANARY', 'PROMOTED']) {
    assert(C.STAGE_DELEGATION[s], `缺少阶段委托: ${s}`);
    assert(C.STAGE_DELEGATION[s].system && C.STAGE_DELEGATION[s].entry, `${s} 委托信息不完整`);
  }
});

check('B3 ★ 静态锁：learn-candidate.mjs 内不得有任何进程/网络/git 执行（禁第二套引擎）', () => {
  const src = fs.readFileSync(path.join(P4, 'plugins', 'learn-candidate.mjs'), 'utf8');
  const banned = [
    /child_process/, /\bspawn\s*\(/, /\bexecSync\b/, /\bexecFile\b/,
    /\bfetch\s*\(/, /require\(['"]http/, /simple-git/, /\bgit\s+push\b/,
  ];
  const hit = banned.filter((re) => re.test(src));
  assertEq(hit.length, 0, '发现执行类调用: ' + hit.map(String).join(', '));
});

check('B4 ★ delegationPlan 声明的待执行阶段都带既有系统入口，且 buildsSecondSystem=false', () => {
  const store0 = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store0, qualifiedGap(), { at: T(0), ruleExpressible: true });
  const d = C.delegationPlan(p.candidate);
  assert(d.ok, 'delegationPlan failed');
  assertEq(d.plan.buildsSecondSystem, false);
  assertEq(d.plan.remaining.length, 4, '待执行阶段数应为 4');
  for (const r of d.plan.remaining) {
    assert(r.system && r.entry, `阶段 ${r.stage} 缺既有系统入口`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('');
console.log('=== C 组：AC8 — 无常驻 daemon，研究有界 ===');
// ─────────────────────────────────────────────────────────────────────────────

check('C1 ★ 静态锁：模块内无定时器 / 无事件循环（AC8 无常驻 daemon）', () => {
  const src = fs.readFileSync(path.join(P4, 'plugins', 'learn-candidate.mjs'), 'utf8');
  for (const re of [/setInterval\s*\(/, /setTimeout\s*\(/, /setImmediate\s*\(/, /while\s*\(\s*true\s*\)/]) {
    assert(!re.test(src), '发现常驻/循环结构: ' + re);
  }
});

check('C2 ★ 研究次数达上限后拒绝继续（禁无限重试）', () => {
  const store0 = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store0, qualifiedGap(), { at: T(0), ruleExpressible: true });
  let cand = p.candidate;
  assertEq(cand.maxAttempts, C.MAX_RESEARCH_ATTEMPTS);
  for (let i = 0; i < C.MAX_RESEARCH_ATTEMPTS; i += 1) {
    const r = C.recordResearchAttempt(cand, { at: T(i), outcome: 'NO_PROGRESS', detail: `try ${i}` });
    assert(r.ok, `第 ${i + 1} 次研究应被允许: ${r.error}`);
    cand = r.candidate;
  }
  assertEq(cand.attemptsUsed, C.MAX_RESEARCH_ATTEMPTS);
  assertEq(cand.exhausted, true);
  const over = C.recordResearchAttempt(cand, { at: T(99), outcome: 'PROGRESS' });
  assertEq(over.ok, false, 'AC8 失败：超过上限仍允许继续研究');
  assertEq(over.error, 'research_bounded_exhausted');
  assertEq(over.exhausted, true);
});

check('C3 ★ 对照组：未达上限时研究**必须**被允许（证明 C2 不是焊死）', () => {
  const store0 = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store0, qualifiedGap(), { at: T(0), ruleExpressible: true });
  const r = C.recordResearchAttempt(p.candidate, { at: T(1), outcome: 'PROGRESS', detail: 'found candidate rule' });
  assertEq(r.ok, true, '首次研究被误拒: ' + r.error);
  assertEq(r.candidate.attemptsUsed, 1);
  assertEq(r.exhausted, false);
});

check('C4 研究计划显式声明 daemon=false 且带上限', () => {
  const plan = C.researchPlan(qualifiedGap(), { ruleExpressible: true });
  assert(plan.ok, 'researchPlan failed');
  assertEq(plan.plan.daemon, false);
  assertEq(plan.plan.maxAttempts, C.MAX_RESEARCH_ATTEMPTS);
  assertEq(plan.plan.attemptsUsed, 0);
});

check('C5 未合格 gap 不得生成研究计划（AC5 闸门不可绕过）', () => {
  const bad = C.researchPlan({ qualified: false, reason: 'vetoed' });
  assertEq(bad.ok, false);
  assertEq(bad.error, 'gap_not_qualified');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('');
console.log('=== D 组：候选形态阶梯（Rule > Extend Skill > New Skill > New Plugin）===');
// ─────────────────────────────────────────────────────────────────────────────

check('D1 ★ 可规则化 → RULE（最优先，绝不跳到 Plugin）', () => {
  const r = C.chooseCandidateKind({ ruleExpressible: true, requiresRuntimeCapability: true });
  assertEq(r.kind, 'RULE', '阶梯优先级错误：可规则化却选了更重的形态');
});

check('D2 ★ 已有 skill 覆盖 → EXTEND_SKILL（不新建）', () => {
  const r = C.chooseCandidateKind({ existingSkill: 'plugin-install-skill' });
  assertEq(r.kind, 'EXTEND_SKILL');
});

check('D3 ★ 无既有 skill 且无需新运行时能力 → NEW_SKILL', () => {
  const r = C.chooseCandidateKind({ requiresRuntimeCapability: false });
  assertEq(r.kind, 'NEW_SKILL');
});

check('D4 ★ 确实需要新运行时能力 → NEW_PLUGIN（最后手段）', () => {
  const r = C.chooseCandidateKind({ requiresRuntimeCapability: true });
  assertEq(r.kind, 'NEW_PLUGIN');
});

check('D5 ★ 阶梯单调性：逐级放宽条件，形态只能变重不能变轻', () => {
  const ladder = [
    C.chooseCandidateKind({ ruleExpressible: true }).kind,
    C.chooseCandidateKind({ existingSkill: 's' }).kind,
    C.chooseCandidateKind({}).kind,
    C.chooseCandidateKind({ requiresRuntimeCapability: true }).kind,
  ];
  assertEq(ladder.join('>'), 'RULE>EXTEND_SKILL>NEW_SKILL>NEW_PLUGIN', '阶梯顺序错误: ' + ladder.join('>'));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('');
console.log('=== E 组：生命周期状态机（isolated tests → regression/holdout → canary）===');
// ─────────────────────────────────────────────────────────────────────────────

check('E1 ★ 不得跳阶段（PROPOSED → CANARY 非法）', () => {
  const store0 = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store0, qualifiedGap(), { at: T(0), ruleExpressible: true });
  const r = C.advanceCandidate(p.value, p.candidate.id, 'CANARY', { at: T(1), evidence: 'x' });
  assertEq(r.ok, false, '跳过 isolated tests 却成功');
  assert(r.error.startsWith('illegal_transition'), r.error);
});

check('E2 ★ 每个阶段都必须有证据（无证据不得前进）', () => {
  const store0 = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store0, qualifiedGap(), { at: T(0), ruleExpressible: true });
  const r = C.advanceCandidate(p.value, p.candidate.id, 'ISOLATED_TESTS', { at: T(1) });
  assertEq(r.ok, false);
  assertEq(r.error, 'stage_requires_evidence');
});

check('E3 ★ 完整正路径：三段推进全部成功且证据留档', () => {
  const store0 = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store0, qualifiedGap(), { at: T(0), ruleExpressible: true });
  const store = driveToCanary(p.value, p.candidate.id);
  const c = store.candidates[0];
  assertEq(c.state, 'CANARY');
  for (const s of ['ISOLATED_TESTS', 'REGRESSION_HOLDOUT', 'CANARY']) {
    assert(c.stageEvidence[s], `阶段证据缺失: ${s}`);
  }
});

check('E4 ★ 未走完管线不得晋升（PROMOTED 必须经 CANARY）', () => {
  const store0 = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store0, qualifiedGap(), { at: T(0), ruleExpressible: true });
  const r = C.promoteCandidate(p.value, p.candidate.id, { at: T(1), approvedBy: 'u', approvalEvidence: 'e' });
  assertEq(r.ok, false);
  assert(r.error.startsWith('not_ready'), r.error);
});

check('E5 ★ 走完管线但无人工批准 → 不得晋升', () => {
  const store0 = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store0, qualifiedGap(), { at: T(0), ruleExpressible: true });
  const store = driveToCanary(p.value, p.candidate.id);
  const r = C.promoteCandidate(store, p.candidate.id, { at: T(4) });
  assertEq(r.ok, false);
  assertEq(r.error, 'promotion_requires_human_approval');
});

check('E6 ★ 走完管线 + 人工批准 → 晋升成功（对照组）', () => {
  const store0 = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store0, qualifiedGap(), { at: T(0), ruleExpressible: true });
  const store = driveToCanary(p.value, p.candidate.id);
  const r = C.promoteCandidate(store, p.candidate.id, {
    at: T(4), approvedBy: 'operator', approvalEvidence: 'canary metrics reviewed', evidence: 'promote to rule',
  });
  assert(r.ok, '正规晋升失败: ' + r.error);
  assertEq(r.candidate.state, 'PROMOTED');
  assertEq(r.candidate.approval.by, 'operator');
});

check('E7 ★ advanceCandidate 不得用于 PROMOTED（必须走带批准的 promoteCandidate）', () => {
  const store0 = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store0, qualifiedGap(), { at: T(0), ruleExpressible: true });
  const store = driveToCanary(p.value, p.candidate.id);
  const r = C.advanceCandidate(store, p.candidate.id, 'PROMOTED', { at: T(4), evidence: 'x' });
  assertEq(r.ok, false);
  assertEq(r.error, 'use_promote_candidate');
});

check('E8 ★ 终态不可复活（PROMOTED / REJECTED 无出边）', () => {
  assertEq(C.CANDIDATE_TRANSITIONS.PROMOTED.length, 0);
  assertEq(C.CANDIDATE_TRANSITIONS.REJECTED.length, 0);
});

check('E9 ★ 拒绝候选只保留**最小失败记录**（不含候选正文，不挂载 Runtime）', () => {
  const store0 = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store0, qualifiedGap(), { at: T(0), ruleExpressible: true });
  const r = C.rejectCandidate(p.value, p.candidate.id, { at: T(1), reason: 'canary failed: regression detected' });
  assert(r.ok, 'reject failed: ' + r.error);
  assertEq(r.candidate.state, 'REJECTED');
  assertEq(r.value.minimalFailures.length, 1);
  const rec = r.value.minimalFailures[0];
  assertEq(Object.keys(rec).sort().join(','), 'at,candidateId,kind,reason', '最小记录字段过多: ' + Object.keys(rec).join(','));
  assert(!('stageEvidence' in rec) && !('researchLog' in rec), '最小记录泄漏了候选正文');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('');
console.log('=== F 组：与 AC5 闸门集成 + 确定性 / 幂等 / fail-closed ===');
// ─────────────────────────────────────────────────────────────────────────────

check('F1 ★ 未合格 gap 不得建候选（AC5 闸门不可绕过）', () => {
  const store = C.emptyCandidateStore(SID);
  const r = C.proposeCandidate(store, { qualified: false, reason: 'vetoed (2/2): HARD_VETO_CLASS' }, { at: T(0) });
  assertEq(r.ok, false);
  assertEq(r.error, 'gap_not_qualified');
});

check('F2 ★ 对照组：合格 gap 必须能建候选（证明 F1 不是焊死）', () => {
  const store = C.emptyCandidateStore(SID);
  const r = C.proposeCandidate(store, qualifiedGap(), { at: T(0), ruleExpressible: true });
  assertEq(r.ok, true, '合格 gap 被误拒: ' + r.error);
  assertEq(r.value.candidates.length, 1);
  assertEq(r.candidate.state, 'PROPOSED');
});

check('F3 ★ 被硬否决的失败观测**不可能**通过 qualifyGap（AC5 → AC7 链路闭合）', () => {
  // 用真实 P2.6 分类：502 属硬否决类
  const rec = evaluateClassifiedRecord({
    classification: 'NETWORK_TIMEOUT_5XX', normalizedSignature: 'sig-502', taxonomyVersion: 1,
  });
  assertEq(rec.vetoed, true, '502 应被硬否决');
  assertEq(rec.reason, VETO_REASON.HARD_VETO);
  const g = qualifyGap([
    { taskType: 't', record: { classification: 'NETWORK_TIMEOUT_5XX', normalizedSignature: 'sig-502', taxonomyVersion: 1 } },
    { taskType: 't', record: { classification: 'NETWORK_TIMEOUT_5XX', normalizedSignature: 'sig-502', taxonomyVersion: 1 } },
  ]);
  assertEq(g.qualified, false, '硬否决失败竟能建 gap');
  const p = C.proposeCandidate(C.emptyCandidateStore(SID), g, { at: T(0) });
  assertEq(p.ok, false, '硬否决失败竟能建候选');
});

check('F4 ★ 确定性：同一 dedupKey 永远得到同一 candidate id；重复提案幂等', () => {
  const id1 = C.candidateIdOf('plugin-install::sig123');
  const id2 = C.candidateIdOf('plugin-install::sig123');
  assertEq(id1, id2, 'id 不确定');
  assert(id1.startsWith('cand_'), 'id 形状错误: ' + id1);

  const store0 = C.emptyCandidateStore(SID);
  const a = C.proposeCandidate(store0, qualifiedGap(), { at: T(0), ruleExpressible: true });
  const b = C.proposeCandidate(a.value, qualifiedGap(), { at: T(5), ruleExpressible: true });
  assertEq(b.deduped, true, '重复提案未幂等');
  assertEq(b.value.candidates.length, 1, '重复提案产生了第二条候选');
});

check('F5 ★ fail-closed：损坏 store 必须判废（绝不部分信任）', () => {
  assertEq(C.validateCandidateStore(null), null);
  assertEq(C.validateCandidateStore({}), null);
  const good = C.emptyCandidateStore(SID);
  assert(C.validateCandidateStore(good) !== null, '空 store 应合法');
  assertEq(C.validateCandidateStore({ ...good, schemaVersion: 999 }), null, '版本不符应判废');
  const bad = { ...good, candidates: [{ id: 'x', kind: 'BOGUS', state: 'PROPOSED', dedupKey: 'k', createdAt: 0, updatedAt: 0 }] };
  assertEq(C.validateCandidateStore(bad), null, '非法 kind 应判废');
});

check('F6 ★ 含 secret 的阶段证据必须被拒（AC1 同纪律）', () => {
  const store0 = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store0, qualifiedGap(), { at: T(0), ruleExpressible: true });
  const r = C.advanceCandidate(p.value, p.candidate.id, 'ISOLATED_TESTS', {
    // 假密钥必须**运行时拼接**：仓库内不得落任何密钥形状字面量（与 test-learn-core.mjs /
    // redteam-r3-probe.mjs 同规范）。此前写成整段字面量，导致 CI L1 的 secret-scan 门槛
    // 直接判红（`SECRET openai @ tests\learn\test-learn-candidate.mjs:417`），PR 无法合并。
    at: T(1), evidence: 'token=sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789',
  });
  assertEq(r.ok, false, 'AC1 失败：含 secret 的证据被接受');
  assertEq(r.error, 'evidence_contains_secret');
});

check('F7 ★ AC9 有界：候选数超上限时**保留刚写入的这条**（不静默丢失）', () => {
  let store = C.emptyCandidateStore(SID);
  const cap = C.MAX_CANDIDATES;
  for (let i = 0; i < cap + 5; i += 1) {
    const g = { ...qualifiedGap(), dedupKey: `k-${i}` };
    const r = C.proposeCandidate(store, g, { at: T(i), ruleExpressible: true });
    assert(r.ok, `第 ${i} 次提案失败: ${r.error}`);
    store = r.value;
    assert(store.candidates.length <= cap, `候选数越界: ${store.candidates.length}`);
  }
  const lastId = C.candidateIdOf(`k-${cap + 4}`);
  assert(store.candidates.some((c) => c.id === lastId), 'AC9 失败：刚写入的候选被容量淘汰静默丢弃');
});

check('F8 遥测：候选事件真实记录且可观察（AC8）', () => {
  const store0 = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store0, qualifiedGap(), { at: T(0), ruleExpressible: true });
  const store = driveToCanary(p.value, p.candidate.id);
  const kinds = store.telemetry.map((t) => t.kind);
  assert(kinds.includes('CANDIDATE_PROPOSED'), '缺 CANDIDATE_PROPOSED');
  assertEq(kinds.filter((k) => k === 'CANDIDATE_STAGE').length, 3, '阶段遥测数不对');
  const sum = C.candidateSummary(store);
  assertEq(sum.daemon, false);
  assertEq(sum.secondSystem, false);
  assertEq(sum.byState.CANARY, 1);
});

check('F9 ★ 候选 store 与 experience store 分层（AC 不混用 authority）', () => {
  // 候选 store 不得含 experiences 字段；experience store 不得含 candidates
  const cs = C.emptyCandidateStore(SID);
  const es = L.emptyStore(SID);
  assert(!('experiences' in cs), '候选 store 混入了 experiences');
  assert(!('candidates' in es), 'experience store 混入了 candidates');
  assertEq(cs.schemaVersion, C.CANDIDATE_SCHEMA_VERSION);
  assertEq(es.schemaVersion, L.LEARN_SCHEMA_VERSION);
});

console.log('');
console.log('=== 汇总 ===');
console.log(`  STAGE 6-7: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) {
  console.log('  失败明细:');
  for (const f of failures) console.log('    - ' + f);
}
console.log(fail === 0 ? '  PASS STAGE 6-7 candidate lifecycle + bounded research' : '  FAIL');
process.exit(fail === 0 ? 0 : 1);
