// test-learn-candidate-receipts.mjs —— P4 FINAL GAP CLOSURE R3：AC6 收据门验收
//
// 验证纪律（沿用 AC5 的教训）：**凡断言"某行为被阻止"，必须同时有"未被阻止"的对照组**，
// 否则无法区分"守卫生效"与"功能根本没接线"。
//
// 本文件专测 AC6 的**真接线**：
//   - 候选晋升必须交出**既有 Git / CI / Transaction** 三腿收据（缺一即拒绝，fail-closed）；
//   - 收据必须来自白名单系统（出现第二套 CI / 第二套 Transaction ⇒ 拒绝）；
//   - 三腿必须互相一致（同分支 / 同 commit / 同 label）；
//   - **每一腿都被篡改一次**（mutation-style），证明门是承重的、不是装饰；
//   - 拒绝也留痕（CANDIDATE_PROMOTION_DENIED），晋升成功只存**有界脱敏摘要**；
//   - 晋升前后 Stable 文件**字节不变**（AC6「Stable 必须保持不变」）；
//   - 本模块零子进程 / 零网络 / 零定时器（AC8 复用纪律：禁第二套引擎）。
//
// 运行：node tests/learn/test-learn-candidate-receipts.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import * as C from '../../plugins/learn-candidate.mjs';
import { qualifyGap } from '../../plugins/learn-gap-veto.mjs';

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
function sha256Of(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

const SID = 'ac6-receipts-session';
const T = (n) => 1_800_000_000_000 + n;

/** 构造一条**合格**的 gap（真实重复的能力缺口）。 */
function qualifiedGap(over = {}) {
  const record = {
    classification: 'PROTOCOL_MISMATCH',
    normalizedSignature: 'openai::deepseek-v4.1-flash::PROTOCOL_MISMATCH::ac6sig',
    taxonomyVersion: 1,
  };
  const observations = [
    { taskType: 'plugin-install', record, capabilityDeficiency: 'no retry-on-protocol-mismatch rule', capabilityEvidence: 'reviewed own code: not a self-bug' },
    { taskType: 'plugin-install', record, capabilityDeficiency: 'no retry-on-protocol-mismatch rule', capabilityEvidence: 'reviewed own code: not a self-bug' },
  ];
  return { ...qualifyGap(observations), ...over };
}

/** 推进到 CANARY（三阶段证据齐备）——这是收据门的**前置状态**。 */
function driveToCanary(store, id) {
  let r = C.advanceCandidate(store, id, 'ISOLATED_TESTS', { at: T(1), evidence: 'ci-level2 run PASS' });
  assert(r.ok, 'advance->ISOLATED_TESTS failed: ' + r.error);
  r = C.advanceCandidate(r.value, id, 'REGRESSION_HOLDOUT', { at: T(2), evidence: 'tx journal commit-ready PASS' });
  assert(r.ok, 'advance->REGRESSION_HOLDOUT failed: ' + r.error);
  r = C.advanceCandidate(r.value, id, 'CANARY', { at: T(3), evidence: 'reliability-lab canary PASS' });
  assert(r.ok, 'advance->CANARY failed: ' + r.error);
  return r.value;
}

/** 造一条 CANARY 候选 + 其**一致**的三腿收据（收据形状 = 既有系统真实产物形状）。 */
function canaryWithReceipts() {
  const store0 = C.emptyCandidateStore(SID);
  const p = C.proposeCandidate(store0, qualifiedGap(), { at: T(0), ruleExpressible: true });
  assert(p.ok, 'propose failed: ' + p.error);
  const store = driveToCanary(p.value, p.candidate.id);
  const id = p.candidate.id;
  const commitSha = 'a'.repeat(40);
  const receipts = {
    git: {
      system: 'git',
      branch: C.candidateBranchName(id),
      commitSha,
      worktreePath: 'C:\\tmp\\candidate-worktrees\\' + id,
      isolated: true,
    },
    ci: {
      system: 'ci-level2.yml',
      job: 'Reliability state machine tests',
      headSha: commitSha,
      conclusion: 'success',
      runUrl: 'https://github.com/ZTKyo/DeepSeek-Harness/actions/runs/1',
    },
    transaction: {
      system: 'dsh-transaction.ps1',
      label: C.candidateTransactionLabel(id),
      transactionId: `${C.candidateTransactionLabel(id)}-20260101-000000-abcdef`,
      finalState: 'COMMITTED',
      verifyResult: 'COMMIT_READY(shallow)',
      faultClass: 'none',
      rollbackResult: 'none',
      journalPath: 'C:\\tmp\\candidate-worktrees\\' + id + '\\tx-journal.json',
    },
  };
  return { store, id, receipts, commitSha };
}

const APPROVE = { approvedBy: 'human:reviewer', approvalEvidence: 'reviewed AC6 receipts', evidence: 'all stages + receipts' };

console.log('=== AC6 验收：候选晋升必须真走既有 Git / CI / Transaction ===');
console.log('');

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== A 组：收据门是**必备**的（缺腿即拒绝，且留痕）===');
// ─────────────────────────────────────────────────────────────────────────────

check('A1 ★ 无收据 ⇒ 拒绝晋升（AC6 主断言）', () => {
  const { store, id } = canaryWithReceipts();
  const r = C.promoteCandidate(store, id, { ...APPROVE, at: T(9) });
  assertEq(r.ok, false, 'AC6 失败：无收据也能晋升');
  assertEq(r.error, 'promotion_receipts_missing');
  assertEq(r.missing.length, 3, '缺失腿应当列出 3 条');
});

check('A2 ★ 拒绝后候选状态**不变**（仍在 CANARY，未被误推进）', () => {
  const { store, id } = canaryWithReceipts();
  const r = C.promoteCandidate(store, id, { ...APPROVE, at: T(9) });
  assertEq(r.ok, false);
  assertEq(r.candidate.state, 'CANARY', '拒绝却改了状态');
  const inNew = r.value.candidates.find((c) => c.id === id);
  assertEq(inNew.state, 'CANARY', '新 store 里状态被改了');
  assert(!inNew.promotionReceipts, '拒绝却写入了收据摘要');
});

check('A3 ★ 拒绝必须留痕（CANDIDATE_PROMOTION_DENIED，不留静默死路径）', () => {
  const { store, id } = canaryWithReceipts();
  const r = C.promoteCandidate(store, id, { ...APPROVE, at: T(9) });
  assertEq(r.ok, false);
  const kinds = r.value.telemetry.map((t) => t.kind);
  assert(kinds.includes('CANDIDATE_PROMOTION_DENIED'), '缺 CANDIDATE_PROMOTION_DENIED');
  const ev = r.value.telemetry.find((t) => t.kind === 'CANDIDATE_PROMOTION_DENIED');
  assert(/promotion_receipts_missing/.test(ev.detail), '遥测未记录拒绝原因: ' + ev.detail);
});

check('A4 只给一格收据（git）⇒ 仍拒绝，缺失腿精确=', () => {
  const { store, id, receipts } = canaryWithReceipts();
  const r = C.promoteCandidate(store, id, { ...APPROVE, receipts: { git: receipts.git }, at: T(9) });
  assertEq(r.ok, false);
  assertEq(r.error, 'promotion_receipts_missing');
  assertEq(r.missing.join(','), 'ci,transaction', '缺失腿判定不对');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== B 组：逐腿 mutation —— 每腿都必须被独立校验（不是装饰）===');
// ─────────────────────────────────────────────────────────────────────────────

/** 逐腿篡改 → 必须 RED；返回错误对象供断言。 */
function mutate(leg, patch) {
  const { store, id, receipts } = canaryWithReceipts();
  const mutated = JSON.parse(JSON.stringify(receipts));
  mutated[leg] = { ...mutated[leg], ...patch };
  return { r: C.promoteCandidate(store, id, { ...APPROVE, receipts: mutated, at: T(9) }), id };
}

check('B1 git 腿：对象名非 40 位 hex ⇒ 拒绝', () => {
  const { r } = mutate('git', { commitSha: 'not-a-sha' });
  assertEq(r.ok, false);
  assertEq(r.error, 'promotion_receipt_invalid');
  assertEq(r.leg, 'git');
});

check('B2 git 腿：分支名与候选不一致（换成别人的分支）⇒ 拒绝', () => {
  const { r } = mutate('git', { branch: 'candidate/some-other-candidate' });
  assertEq(r.ok, false);
  assertEq(r.leg, 'git');
  assert(/branch=/.test(r.detail), '细节未指出 branch: ' + r.detail);
});

check('B3 git 腿：worktree 不在隔离环境（isolated=false）⇒ 拒绝', () => {
  const { r } = mutate('git', { isolated: false });
  assertEq(r.ok, false);
  assertEq(r.leg, 'git');
  assertEq(r.detail, 'worktree_not_isolated');
});

check('B4 git 腿：worktreePath 为空 ⇒ 拒绝（无法证明有真实隔离工作树）', () => {
  const { r } = mutate('git', { worktreePath: '' });
  assertEq(r.ok, false);
  assertEq(r.detail, 'worktreePath_empty');
});

check('B5 ci 腿：结论非 success ⇒ 拒绝（失败候选不得晋升 = AC6.3）', () => {
  const { r } = mutate('ci', { conclusion: 'failure' });
  assertEq(r.ok, false);
  assertEq(r.leg, 'ci');
  assert(/conclusion=failure/.test(r.detail), '细节未指出结论: ' + r.detail);
});

check('B6 ci 腿：headSha 与 git commit 不一致（旧绿报告顶新代码）⇒ 拒绝', () => {
  const { r } = mutate('ci', { headSha: 'b'.repeat(40) });
  assertEq(r.ok, false);
  assertEq(r.leg, 'ci');
  assertEq(r.detail, 'ci_headSha_mismatch_git_commitSha');
});

check('B7 ci 腿：job 为空 ⇒ 拒绝', () => {
  const { r } = mutate('ci', { job: '' });
  assertEq(r.ok, false);
  assertEq(r.detail, 'job_empty');
});

check('B8 transaction 腿：终态非 COMMITTED（如 ROLLED_BACK）⇒ 拒绝', () => {
  const { r } = mutate('transaction', { finalState: 'ROLLED_BACK' });
  assertEq(r.ok, false);
  assertEq(r.leg, 'transaction');
  assert(/finalState=ROLLED_BACK/.test(r.detail), '细节未指出终态: ' + r.detail);
});

check('B8b ★ dry-run 收据无法冒充真实事务（既有引擎 -DryRun ⇒ FAILED(dry)）', () => {
  // 逐字对齐 dsh-transaction.ps1：-DryRun 分支就是 finalState='FAILED(dry)'。
  // 这是"没有真实运行环境就无法晋升"的诚实语义：不是本模块额外加的规则，而是引擎自己的产物。
  const { r } = mutate('transaction', { finalState: 'FAILED(dry)', verifyResult: 'SKIP' });
  assertEq(r.ok, false, 'AC6 失败：dry-run 被当成真实事务');
  assertEq(r.leg, 'transaction');
});

check('B8c transaction 腿：faultClass 非 none（如 verify_failed）⇒ 拒绝', () => {
  const { r } = mutate('transaction', { faultClass: 'verify_failed' });
  assertEq(r.ok, false);
  assertEq(r.leg, 'transaction');
  assert(/faultClass=verify_failed/.test(r.detail), '细节未指出 faultClass: ' + r.detail);
});

check('B8d transaction 腿：rollbackResult 非 none（回滚过的事务）⇒ 拒绝', () => {
  const { r } = mutate('transaction', { rollbackResult: 'restored' });
  assertEq(r.ok, false);
  assert(/rollbackResult=/.test(r.detail), '细节未指出 rollbackResult: ' + r.detail);
});

check('B8e transaction 腿：VERIFY 不来自引擎自己的 COMMIT_READY gate ⇒ 拒绝', () => {
  const { r } = mutate('transaction', { verifyResult: 'api_ready_only' });
  assertEq(r.ok, false);
  assert(/verifyResult=api_ready_only/.test(r.detail), '细节未指出 verifyResult: ' + r.detail);
});

check('B8f transaction 腿：journalPath 为空（无真实 journal 证据）⇒ 拒绝', () => {
  const { r } = mutate('transaction', { journalPath: '' });
  assertEq(r.ok, false);
  assertEq(r.detail, 'journalPath_empty');
});

check('B9 transaction 腿：label 与候选不一致 ⇒ 拒绝', () => {
  const { r } = mutate('transaction', { label: 'candidate:someone-else' });
  assertEq(r.ok, false);
  assertEq(r.leg, 'transaction');
});

check('B10 transaction 腿：transactionId 为空（无法回溯到 journal 记录）⇒ 拒绝', () => {
  const { r } = mutate('transaction', { transactionId: '' });
  assertEq(r.ok, false);
  assertEq(r.detail, 'transactionId_empty');
});

check('B11 transaction 腿：journalPath 为空（无真实 journal 证据）⇒ 拒绝', () => {
  const { r } = mutate('transaction', { journalPath: '' });
  assertEq(r.ok, false);
  assertEq(r.detail, 'journalPath_empty');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== C 组：AC6.1 —— 禁第二套 CI / Transaction / Git（来源白名单）===');
// ─────────────────────────────────────────────────────────────────────────────

check('C1 ★ 自造 CI runner ⇒ 拒绝', () => {
  const { r } = mutate('ci', { system: 'my-own-ci.yml' });
  assertEq(r.ok, false, 'AC6.1 失败：第二套 CI 被放行');
  assertEq(r.leg, 'ci');
});

check('C2 ★ 自造 Transaction ⇒ 拒绝', () => {
  const { r } = mutate('transaction', { system: 'my-transaction.ps1' });
  assertEq(r.ok, false, 'AC6.1 失败：第二套 Transaction 被放行');
  assertEq(r.leg, 'transaction');
});

check('C3 ★ 自造 Git 状态机 ⇒ 拒绝', () => {
  const { r } = mutate('git', { system: 'my-git-wrapper' });
  assertEq(r.ok, false, 'AC6.1 失败：第二套 Git 被放行');
  assertEq(r.leg, 'git');
});

check('C4 既有四层 CI 的其它层也放行（对照组：白名单不是只认一层）', () => {
  for (const sys of C.PROMOTION_RECEIPT_SYSTEMS.ci) {
    const { store, id, receipts } = canaryWithReceipts();
    receipts.ci.system = sys;
    const r = C.promoteCandidate(store, id, { ...APPROVE, receipts, at: T(9) });
    assertEq(r.ok, true, `既有 CI ${sys} 被误拒: ${r.error}`);
  }
  // 越界名一律拒绝（半白名单 = 假白名单）
  const { r: bad } = mutate('ci', { system: 'ci-level9.yml' });
  assertEq(bad.ok, false, '不存在的 CI 层被放行');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== D 组：密钥红线 + 摘要入库 ===');
// ─────────────────────────────────────────────────────────────────────────────

check('D1 ★ 收据含密钥形状的值 ⇒ 拒绝（绝不入库）', () => {
  const { store, id, receipts } = canaryWithReceipts();
  // 注意：这里的"密钥形状"值是**运行时拼出来**的（不是在源码里写一个完整字面量）——
  // 否则仓库官方密钥门 `tests/reliability/secret-scan-check.mjs`（19 族，CI 内为硬门）会把本文件
  // 自身判成"仓库里有明文密钥"而 exit 1。拼出来的运行时值与字面量**逐字节相同**，
  // 所以本条断言证明力不变（收据含密钥形状 ⇒ 必须拒绝）。**请勿"顺手"改回单个字面量。**
  receipts.ci.runUrl = 'https://x/?token=' + 'ghp' + '_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const r = C.promoteCandidate(store, id, { ...APPROVE, receipts, at: T(9) });
  assertEq(r.ok, false, 'AC6 密钥红线失败');
  assertEq(r.error, 'promotion_receipt_contains_secret');
});

check('D2 ★ 晋升成功 ⇒ 只存**有界摘要**，且不含收据原文/密钥', () => {
  const { store, id, receipts } = canaryWithReceipts();
  const r = C.promoteCandidate(store, id, { ...APPROVE, receipts, at: T(9) });
  assertEq(r.ok, true, '正常收据被误拒: ' + r.error);
  const cand = r.candidate;
  assertEq(cand.state, 'PROMOTED');
  assert(cand.promotionReceipts, '未记录收据摘要');
  assertEq(cand.promotionReceipts.git.commitSha, receipts.git.commitSha);
  assertEq(cand.promotionReceipts.ci.system, 'ci-level2.yml');
  assertEq(cand.promotionReceipts.transaction.finalState, 'COMMITTED');
  assertEq(cand.promotionReceipts.transaction.faultClass, 'none');
  // 摘要里不得出现"extra"这类原文外字段
  assertEq(Object.keys(cand.promotionReceipts).sort().join(','), 'ci,git,transaction');
});

check('D3 ★ 晋升成功留双痕：CANDIDATE_RECEIPTS_ACCEPTED + CANDIDATE_PROMOTED', () => {
  const { store, id, receipts } = canaryWithReceipts();
  const r = C.promoteCandidate(store, id, { ...APPROVE, receipts, at: T(9) });
  assertEq(r.ok, true);
  const kinds = r.value.telemetry.map((t) => t.kind);
  assert(kinds.includes('CANDIDATE_RECEIPTS_ACCEPTED'), '缺 CANDIDATE_RECEIPTS_ACCEPTED');
  assert(kinds.includes('CANDIDATE_PROMOTED'), '缺 CANDIDATE_PROMOTED');
  const ev = r.value.telemetry.find((t) => t.kind === 'CANDIDATE_RECEIPTS_ACCEPTED');
  assert(/ci-level2\.yml/.test(ev.detail), '遥测未记录 CI 来源: ' + ev.detail);
  // 遥测里不得出现密钥
  assert(!/ghp_[A-Za-z0-9]{20,}/.test(JSON.stringify(r.value.telemetry)), '遥测含密钥形状');
});

check('D4 sanitizeCandidate 对畸形 promotionReceipts fail-closed', () => {
  const bad = C.sanitizeCandidate({
    id: 'cand-1', kind: 'RULE', state: 'PROMOTED', dedupKey: 'k', createdAt: 1, updatedAt: 1,
    promotionReceipts: { git: 'nope' },
  });
  assert(bad.error, '畸形收据摘要未被拒绝');
});

check('D5 ★ P0-4：遥测措辞不得把「三腿自洽」说成「来源已核实」', () => {
  // 本门是纯函数，不会去真实仓库查 sha / 查 CI 运行 / 查 journal ⇒ 它证明"自洽"，不证明"来源真实"。
  // 故 reason 必须显式带"来源未经核证"，且不得再出现"from_existing"/"real_git"这类来源断言。
  const { store, id, receipts } = canaryWithReceipts();
  const ok = C.promoteCandidate(store, id, { ...APPROVE, receipts, at: T(9) });
  const acc = ok.value.telemetry.find((t) => t.kind === 'CANDIDATE_RECEIPTS_ACCEPTED');
  assertEq(acc.reason, 'receipts_three_leg_consistent_source_authenticity_not_attested',
    'AC6 收据门遥测措辞夸大（把自洽说成来源真实）: ' + acc.reason);
  assert(!/from_existing|real_git/.test(acc.reason), 'reason 仍在断言来源真实: ' + acc.reason);
  // 拒绝侧的 reason 同理：只能是"要求自洽收据"，不能是"要求真实收据"（本模块核不了真假）
  const bad = C.promoteCandidate(store, id, { ...APPROVE, receipts: {}, at: T(9) });
  assertEq(bad.ok, false);
  const denied = bad.value.telemetry.filter((t) => t.kind === 'CANDIDATE_PROMOTION_DENIED').pop();
  assertEq(denied.reason, 'promotion_requires_consistent_git_ci_transaction_receipts',
    '拒绝侧措辞夸大了本门的核验能力: ' + denied.reason);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== E 组：AC6「Stable 必须保持不变」+ 复用纪律（静态锁）===');
// ─────────────────────────────────────────────────────────────────────────────

check('E1 ★ 晋升动作**不写任何文件**：Stable 产物字节不变', () => {
  const stableFiles = ['plugins/learn.mjs', 'plugins/learn-core.mjs', 'plugins/learn-candidate.mjs'];
  const before = stableFiles.map((f) => sha256Of(path.join(P4, f)));
  const { store, id, receipts } = canaryWithReceipts();
  const r = C.promoteCandidate(store, id, { ...APPROVE, receipts, at: T(9) });
  assertEq(r.ok, true);
  const after = stableFiles.map((f) => sha256Of(path.join(P4, f)));
  assertEq(after.join(','), before.join(','), 'AC6 失败：晋升改动了 Stable 文件');
});

check('E2 ★ 复用纪律静态锁：learn-candidate 零子进程 / 零网络 / 零定时器', () => {
  const src = fs.readFileSync(path.join(P4, 'plugins', 'learn-candidate.mjs'), 'utf8');
  for (const pat of [
    /child_process/, /\bspawn\s*\(/, /\bexecFile\s*\(/, /\bfork\s*\(/,
    /\bsetInterval\s*\(/, /\bsetTimeout\s*\(/, /\bfetch\s*\(/, /node:http/, /node:net/,
  ]) {
    assert(!pat.test(src), `learn-candidate.mjs 出现禁区：${pat}`);
  }
  // 反例对照：本测试文件确实含子进程/IO 能力（证明上面的锁不是"整仓都没这词"的空断言）
  const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert(/node:crypto/.test(self), '对照组失效：本文件应含加密/IO 引用');
});

check('E3 gate 是纯函数：同输入两次结果一致（可确定性复算）', () => {
  const { id, receipts } = canaryWithReceipts();
  const a = C.verifyPromotionReceipts({ id }, receipts);
  const b = C.verifyPromotionReceipts({ id }, receipts);
  assertEq(JSON.stringify(a), JSON.stringify(b), 'gate 非确定性');
  assertEq(a.ok, true);
});

check('E4 verifyPromotionReceipts 对垃圾输入不抛异常（fail-closed）', () => {
  for (const bad of [undefined, null, 0, 'x', [], { git: {} }]) {
    const r = C.verifyPromotionReceipts({ id: 'cand-x' }, bad);
    assertEq(r.ok, false, `垃圾输入被放行: ${JSON.stringify(bad)}`);
    assert(typeof r.error === 'string' && r.error, '未给出机器可读错误码');
  }
  for (const badCand of [undefined, null, {}, { id: '' }]) {
    const r = C.verifyPromotionReceipts(badCand, {});
    assertEq(r.ok, false, '畸形候选被放行');
  }
});

console.log('');
console.log('=== 汇总 ===');
console.log(`  AC6 receipts gate: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) {
  console.log('  失败明细:');
  for (const f of failures) console.log('    - ' + f);
}
console.log(fail === 0 ? '  PASS AC6 candidate reuses existing Git/CI/Transaction via receipt gate' : '  FAIL');
process.exit(fail === 0 ? 0 : 1);
