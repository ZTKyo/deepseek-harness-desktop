// test-learn-r2-b1-approval-gate.mjs —— R2 外部评审 BLOCKER-1 回归门（人工审批是跨会话的唯一途径）
//
// ── 这个套件锁死的**唯一**命题 ──────────────────────────────────────────────
//   「机器验证通过」**不等于**「可跨会话传播」：
//   Layer B（跨会话全局库）只接受 APPROVED + VERIFIED + 审批来源完整，
//   缺「人工审批」这一位 ⇒ 一律 DENY，且**不落盘**、**不可被其它会话召回**。
//
// ── 为什么需要这个门（真实缺陷，不是假想）──────────────────────────────────
//   独立评审探针 attack-AC4-approval-bypass.mjs 在 pristine HEAD 3a9f30f 上实证：
//     A1 publication=published            ← 未审批的候选被发表到全局库
//     A2 全局库条目数=1                    ← 污染真实跨会话库
//     A3 FAIL 全局条目 approvals=[]        ← 条目零人工审批
//     A4 FAIL 会话 B 召回到了该条目         ← "人工审批是唯一可召回途径"在代码上不成立
//   根因**不在**闸门本身，而在状态机：`applyVerification` 会把已 APPROVED 的经验
//   降级成 VERIFIED_EXPERIENCE（迁移表允许 APPROVED→VERIFIED_EXPERIENCE），
//   于是「APPROVED + VERIFIED」在系统里**根本无法共存**，闸门只能退化为"只看 VERIFIED"。
//   故本门同时锁住两件事：
//     ① 授权门（state 必须 APPROVED）—— 修 BLOCKER-1 的漏洞面；
//     ② 审批粘性（重新验证不得撤销授权）—— 修根因，且保证合法路径不被误杀。
//
// ── 防"把闸门焊死"的假通过（本套件最重要的设计）────────────────────────────
//   只断言"攻击被拒"是不够的——把 publish 一律拒掉也能让它变绿。
//   故 B 组必须证明**合法路径依然通**：真实 auto-propose → 人工批准 → 发表 →
//   **另一个会话真的召回到了它**。A 组（拒绝）与 B 组（放行）必须同时成立，
//   才说明边界画在了"人工审批"上，而不是"焊死"。
//
// 运行：node tests/learn/test-learn-r2-b1-approval-gate.mjs
// 纪律：只读真实会话；一切状态目录指向 os.tmpdir()，绝不触碰生产 ~/.dsh。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadRealSession, listRealSessions, mkCtx, mkExec, growSession,
  mkHostApproval, mkTurnSession, appendHostApprovalFact,
} from './_real-session-harness.mjs';
import {
  GLOBAL_STORE_KIND, GLOBAL_STORE_SCHEMA_VERSION, emptyGlobalStore,
  makeExperience, approve, applyVerification, canPublish, isRecallable,
  candidateDigest, validHumanApproval, HUMAN_APPROVAL_ACTOR,
} from '../../plugins/learn-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_URL = pathToFileURL(join(HERE, '..', '..', 'plugins', 'learn.mjs')).href;

let pass = 0; let fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; failures.push(name + ' :: ' + e.message); console.log('  FAIL  ' + name + ' — ' + e.message); }
}
async function acheck(name, fn) {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; failures.push(name + ' :: ' + e.message); console.log('  FAIL  ' + name + ' — ' + e.message); }
}

// ── 每个场景一个**全新模块实例**（cache-busting）────────────────────────────
// 理由：learn.mjs 的 per-session 结构与全局库单例都是模块级状态。若多个场景共用
// 一个实例，"A 组没落盘"可能是被 B 组的库状态掩盖的假通过。逐个实例化 ⇒ 场景之间
// 物理隔离，断言才指向真实行为。
//
// ★ F1（2026-09-26）：B 组的"合法路径"必须经过**宿主人类批准通道**才有意义。
//   这里起的是**真实**宿主 ApprovalService（cordis + @deepseek-ai/dsh-user-approval）：
//   事件对由宿主代码写入，测试只负责"当人类"作答。若解析不到已安装的 Harness 包，
//   则**显式 SKIP 并说明**（绝不"跳过即通过"）。
let gen = 0;
async function newInstance(tag, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `b1-${tag}-`));
  const gpath = path.join(dir, '_global-verified.json');
  const approval = await mkHostApproval({ answerer: 'allowed-once' });
  const host = mkCtx({ approval: approval.svc ?? undefined });
  const mod = await import(`${PLUGIN_URL}?b1=${++gen}`);
  const api = mod.apply(host.ctx, {
    stateDir: dir,
    globalStorePath: gpath,
    autoPropose: true,
    minTurnsForLearning: 4,
    minNewNodes: 4,
    maxDigestTurns: 40,
    ...opts,
  });
  return { api, hooks: host.hooks, dir, gpath, approval };
}

function readGlobalFile(gpath) {
  if (!fs.existsSync(gpath)) return null;
  try { return JSON.parse(fs.readFileSync(gpath, 'utf8')); } catch { return null; }
}
const idsOf = (hits) => (Array.isArray(hits?.items) ? hits.items.map((i) => i.id) : []);
const hasTel = (store, kind) => (store?.telemetry ?? []).some((t) => t.kind === kind);
const telReasons = (store, kind) => (store?.telemetry ?? []).filter((t) => t.kind === kind).map((t) => t.reason);

console.log('=== R2 BLOCKER-1 回归门：人工审批是跨会话传播的唯一途径 ===');
console.log('  插件 = ' + PLUGIN_URL);

// ── 真实会话（唯一能产出 machine-checkable evidence 的路径）─────────────────
const cands = listRealSessions(500_000);
assert.ok(cands.length > 0, '无真实会话候选（无法建立 machine-checkable 证据面）');
const real = loadRealSession(cands[0].p);
console.log(`  真实会话 = ${path.basename(path.dirname(cands[0].p))} nodes=${real.nodes.length}`);
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// A 组：攻击面 —— 未经人工审批的「已验证」候选**不得**跨会话传播
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- A 组：未审批 + 机器验证通过 ⇒ 必须 DENY（BLOCKER-1 漏洞面）---');
const A = await newInstance('attack');
const SID_A = 'b1-attack-session-A';
const SID_B = 'b1-attack-session-B';
let attackExp = null;

await acheck('A0 真实会话驱动产出自动候选（PROPOSED，零审批）', async () => {
  const g = await growSession(A.api, A.hooks, real, SID_A);
  assert.equal(g.store.experiences.length > 0, true, 'auto-propose 未产出候选（前置不成立，后续断言无意义）');
  attackExp = g.store.experiences[0];
  assert.equal(attackExp.state, 'PROPOSED', 'state=' + attackExp.state);
  // 零审批：真实 schema 用扁平三字段（不是 approvals 数组）
  assert.equal(attackExp.approvedBy ?? null, null, 'auto-propose 不得自带 approvedBy');
  assert.equal(attackExp.approvalEvidence ?? null, null, 'auto-propose 不得自带 approvalEvidence');
  assert.equal(attackExp.approvedAt ?? null, null, 'auto-propose 不得自带 approvedAt');
});

let verifyRes = null;
await acheck('A1 learn_verify 本身 PASS（攻击成立的前提：证据是真的）', async () => {
  verifyRes = await A.api.invokeTool('learn_verify', { experienceId: attackExp.id }, mkExec(SID_A));
  assert.equal(verifyRes.ok, true, 'verify 未通过（error=' + (verifyRes.error ?? '-') + '）—— 本组前提不成立');
  assert.equal(verifyRes.verificationStatus, 'VERIFIED', 'vstatus=' + verifyRes.verificationStatus);
});

check('A2 ★ 未审批 ⇒ publication 必须是 denied:not_human_approved（不得是 published）', () => {
  assert.ok(String(verifyRes.publication).startsWith('denied:not_human_approved'),
    'publication=' + verifyRes.publication + '（期望 denied:not_human_approved:*）');
});

check('A3 ★ 全局库**不落盘**该条目（跨会话库零污染）', () => {
  const onDisk = readGlobalFile(A.gpath);
  const mem = A.api.globalStore();
  assert.equal(onDisk?.experiences?.length ?? 0, 0, '磁盘全局库条目数=' + (onDisk?.experiences?.length ?? 0));
  assert.equal(mem.experiences.length, 0, '内存全局库条目数=' + mem.experiences.length);
});

await acheck('A4 ★ 另一个会话**召回不到**它（"人工审批是唯一可召回途径"成立）', async () => {
  const q = String(attackExp.title ?? '').slice(0, 40) || 'experience';
  const hits = await A.api.recallFor(SID_B, q, { limit: 5 });
  assert.equal(idsOf(hits).includes(attackExp.id), false,
    '会话 B 召回到了未审批条目 ' + attackExp.id + '（跨会话泄露）');
});

await acheck('A5 被拒必须**留痕**（GLOBAL_PUBLISH_DENIED，不得静默跳过）', async () => {
  const g = A.api.globalStore();
  assert.equal(hasTel(g, 'GLOBAL_PUBLISH_DENIED'), true,
    'telemetry kinds=' + JSON.stringify((g.telemetry ?? []).map((t) => t.kind)));
  const reasons = telReasons(g, 'GLOBAL_PUBLISH_DENIED');
  assert.ok(reasons.some((r) => String(r).startsWith('not_human_approved')),
    'DENY 原因=' + JSON.stringify(reasons) + '（应可解释为 not_human_approved:*）');
});

await acheck('A6 非回归：本会话 Layer A 仍可召回该 VERIFIED_EXPERIENCE（合同实现原则 3 未被误杀）', async () => {
  const q = String(attackExp.title ?? '').slice(0, 40) || 'experience';
  const hits = await A.api.recallFor(SID_A, q, { limit: 5 });
  assert.equal(idsOf(hits).includes(attackExp.id), true,
    '本会话也召不回自己的 VERIFIED_EXPERIENCE —— 过度封锁，破坏了 Layer A 独立通道');
  assert.equal(isRecallable({ state: 'VERIFIED_EXPERIENCE' }), true, 'isRecallable 语义被改动');
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// B 组：合法路径 —— 人工审批后**必须**能跨会话传播（防"把闸门焊死"的假通过）
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- B 组：人工审批 ⇒ 必须放行且**跨会话真的召回得到**（防焊死）---');
const B = await newInstance('legit');
const SID_L1 = 'b1-legit-session-A';
const SID_L2 = 'b1-legit-session-B';
let legitExp = null;

await acheck('B0 真实会话驱动产出自动候选', async () => {
  const g = await growSession(B.api, B.hooks, real, SID_L1);
  assert.equal(g.store.experiences.length > 0, true, 'auto-propose 未产出候选');
  legitExp = g.store.experiences[0];
});

let reviewRes = null;
await acheck('B1 learn_review approve ⇒ publication=published（合法路径通，且**真的**走了宿主人类通道）', async () => {
  assert.equal(B.approval.available, true,
    'SKIP-REASON: 解析不到已安装 Harness 的 dsh-user-approval —— 本组无法建立"宿主人类批准"证据面');
  // 调用方**故意**填 approver 自由文本：F1 之后它不得成为授权来源（身份由宿主决定）。
  reviewRes = await B.api.invokeTool('learn_review', {
    experienceId: legitExp.id,
    action: 'approve',
    approver: 'b1-gate-reviewer-ATTEMPTED-SELF-CLAIM',
    evidence: 'manual review: lesson re-derived from the official session log and judged reusable',
  }, mkExec(SID_L1));
  assert.equal(reviewRes.publication, 'published', 'publication=' + reviewRes.publication + '（合法路径被误杀）');
  assert.ok(B.approval.seen.length >= 1,
    '宿主 ApprovalService 未收到任何 approval/request ⇒ 批准没走人类通道，seen=' + JSON.stringify(B.approval.seen));
  assert.equal(B.approval.decided.length >= 1, true, '人类作答未发生 decided=' + JSON.stringify(B.approval.decided));
});

check('B2 落盘条目带完整人工审批来源 + APPROVED + VERIFIED', () => {
  const onDisk = readGlobalFile(B.gpath);
  assert.equal(onDisk?.experiences?.length, 1, '磁盘全局库条目数=' + (onDisk?.experiences?.length ?? 'null'));
  const e = onDisk.experiences[0];
  assert.equal(e.state, 'APPROVED', 'state=' + e.state + '（审批粘性：重新验证不得降级）');
  assert.equal(e.verification?.status, 'VERIFIED', 'vstatus=' + e.verification?.status);
  // 审批来源是**扁平三字段**（approvedBy / approvalEvidence / approvedAt）——不是 approvals 数组。
  // 注意：评审探针 A3 读的是 `g0.approvals ?? []`，该字段在 schema 中**不存在**，故 A3 恒 FAIL、
  // 永远不可能变绿；本套件按真实 schema 断言，避免继承同一误判。
  assert.equal(e.approvedBy, HUMAN_APPROVAL_ACTOR,
    'approvedBy=' + JSON.stringify(e.approvedBy ?? null) + '（★F1：必须是宿主固定标签，调用方自由文本不得成为身份）');
  assert.equal(typeof e.approvalEvidence, 'string', 'approvalEvidence=' + JSON.stringify(e.approvalEvidence ?? null));
  assert.ok(e.approvalEvidence.length > 0, 'approvalEvidence 为空');
  assert.equal(Number.isSafeInteger(e.approvedAt) && e.approvedAt > 0, true, 'approvedAt=' + JSON.stringify(e.approvedAt ?? null));
  // ★F1：授权凭据必须是"本进程内可验证的宿主事实签章"，不只是几个可伪造的字段
  assert.equal(validHumanApproval(e).ok, true,
    'validHumanApproval 拒了刚落盘的批准：' + validHumanApproval(e).reason);
  assert.equal(canPublish(e).ok, true, 'canPublish 拒了合法条目：' + canPublish(e).reason);
  assert.equal(canPublish(e).reason, 'verified_approvable_experience');
});

await acheck('B3 ★ 另一个会话**召回到了**这条已审批经验（AC4 正向要求成立）', async () => {
  const q = String(legitExp.title ?? '').slice(0, 40) || 'experience';
  const hits = await B.api.recallFor(SID_L2, q, { limit: 5 });
  assert.equal(idsOf(hits).includes(legitExp.id), true,
    '会话 B 召不回已审批经验 —— 过度封锁（cross-session reuse 被破坏）');
});

await acheck('B4 工具面一致：learn_recall 在另一会话同样可见（测试路径 == 生产路径）', async () => {
  const q = String(legitExp.title ?? '').slice(0, 40) || 'experience';
  const r = await B.api.invokeTool('learn_recall', { query: q, limit: 5 }, mkExec(SID_L2));
  const ids = Array.isArray(r?.items) ? r.items.map((i) => i.id) : [];
  assert.equal(ids.includes(legitExp.id), true, 'learn_recall items=' + JSON.stringify(ids));
});

await acheck('B5 审批后再验证一次：授权**不被撤销**（根因修复的核心断言）', async () => {
  const v = await B.api.invokeTool('learn_verify', { experienceId: legitExp.id }, mkExec(SID_L1));
  assert.equal(v.ok, true, 're-verify 失败：' + (v.error ?? '-'));
  assert.equal(v.state, 'APPROVED',
    'state=' + v.state + ' —— 重新验证把 APPROVED 降级了（根因复发：APPROVED+VERIFIED 无法共存）');
  assert.ok(String(v.publication) !== 'not_applicable', 'publication=' + v.publication);
  const e = readGlobalFile(B.gpath).experiences[0];
  assert.equal(e.state, 'APPROVED', '落盘条目 state=' + e.state);
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// C 组：存量污染 —— 旧格式（VERIFIED_EXPERIENCE-only）全局库必须整体判废
// ═══════════════════════════════════════════════════════════════════════════
// 修前版本会把这种条目写进真实全局库；升级后若"部分信任"它，BLOCKER-1 就等于没修。
// 夹具纪律：用 A 组**真实攻击产物**（state=VERIFIED_EXPERIENCE + VERIFIED + 零审批）
// 构造，不手搓——保证它确实是旧闸门会放行的形状。
console.log('--- C 组：存量污染库必须整体判废（fail-closed 隔离，不部分信任）---');
const C = await newInstance('legacy');
const SID_C = 'b1-legacy-session-B';
let legacyEntry = null;

await acheck('C0 取 A 组真实攻击产物作为"旧格式条目"', async () => {
  legacyEntry = A.api.getStore(SID_A).experiences.find((e) => e.id === attackExp.id);
  assert.ok(legacyEntry, '未取到 A 组条目');
  assert.equal(legacyEntry.state, 'VERIFIED_EXPERIENCE', 'state=' + legacyEntry.state);
  assert.equal(legacyEntry.verification?.status, 'VERIFIED', 'vstatus=' + legacyEntry.verification?.status);
  assert.equal(legacyEntry.approvedBy ?? null, null, '该夹具不应带审批（approvedBy=' + JSON.stringify(legacyEntry.approvedBy ?? null) + '）');
});

check('C1 该旧格式条目**确实**过不了 canPublish（这就是旧库的病）', () => {
  const v = canPublish(legacyEntry);
  assert.equal(v.ok, false, '旧格式条目竟仍可发布 ⇒ 闸门未修好');
  assert.equal(v.reason, 'not_human_approved:VERIFIED_EXPERIENCE', 'reason=' + v.reason);
});

await acheck('C2 含该条目的存量全局库被整体判废 + 记 GLOBAL_REJECTED（不部分信任）', async () => {
  const legacyStore = {
    ...emptyGlobalStore(Date.now()),
    schemaVersion: GLOBAL_STORE_SCHEMA_VERSION,
    kind: GLOBAL_STORE_KIND,
    version: 1,
    experiences: [legacyEntry],
    telemetry: [],
  };
  fs.mkdirSync(path.dirname(C.gpath), { recursive: true });
  fs.writeFileSync(C.gpath, JSON.stringify(legacyStore), 'utf8');

  const loaded = C.api.globalStore();
  assert.equal(loaded.experiences.length, 0,
    '存量库被部分信任：仍载入 ' + loaded.experiences.length + ' 条旧格式条目');
  assert.equal(hasTel(loaded, 'GLOBAL_REJECTED'), true,
    '未留 GLOBAL_REJECTED 痕迹，kinds=' + JSON.stringify((loaded.telemetry ?? []).map((t) => t.kind)));
});

await acheck('C3 存量污染条目跨会话召回不到（隔离生效）', async () => {
  const q = String(legacyEntry.title ?? '').slice(0, 40) || 'experience';
  const hits = await C.api.recallFor(SID_C, q, { limit: 5 });
  assert.equal(idsOf(hits).includes(legacyEntry.id), false, '存量污染条目仍被召回 ' + legacyEntry.id);
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// D 组：状态机不变量（纯函数层，锁死根因，不依赖真实会话）
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- D 组：状态机不变量 —— 审批粘性（根因锁）---');
check('D1 APPROVED --确定性验证 PASS--> 仍为 APPROVED（授权不被重新验证撤销）', () => {
  const SHA = 'b'.repeat(64);
  const evidence = { class: 'file_hash', path: 'C:/p4r2/plugins/learn-core.mjs', sha256: SHA };
  const resolvers = { fileHash: () => SHA };
  const draft = makeExperience({
    title: 'B1 sticky approval invariant',
    body: 're-verifying an approved experience must not revoke human authorisation',
    sourceEventSeqs: [31, 32],
    originSessionId: 'sess-b1-sticky',
  });
  assert.equal(draft.ok, true, 'fixture draft 失败');
  const s0 = { ...draft.value.store, experiences: [draft.value] };
  // ★F1：纯函数层测试也必须提供**宿主事实**（asked/decided 事件对 + 内容摘要绑定），
  //   否则 approve() 一律 approval_not_host_proven:* —— 这正是新边界的应有行为。
  const sess = mkTurnSession('sess-b1-sticky');
  const ref = 'b1-sticky-approval-ref';
  appendHostApprovalFact(sess, { ref, digest: candidateDigest(draft.value), outcome: 'allowed-once' });
  const ap = approve(s0, draft.value.id, { evidence: 'manual review note', at: 1000, session: sess, approvalRef: ref });
  assert.equal(ap.ok, true, 'approve 失败：' + (ap.error ?? '-'));
  assert.equal(ap.experience.state, 'APPROVED', 'state=' + ap.experience.state);
  assert.equal(ap.experience.approvedBy, HUMAN_APPROVAL_ACTOR, 'approvedBy=' + ap.experience.approvedBy);
  const av = applyVerification(ap.value, draft.value.id, evidence, resolvers, 2000);
  assert.equal(av.ok, true, 'applyVerification 失败：' + (av.error ?? '-'));
  assert.equal(av.experience.state, 'APPROVED',
    'state=' + av.experience.state + ' —— 被降级为 VERIFIED_EXPERIENCE（BLOCKER-1 根因复发）');
  assert.equal(av.experience.verification.status, 'VERIFIED', 'vstatus=' + av.experience.verification.status);
  assert.equal(validHumanApproval(av.experience).ok, true,
    '重新验证后 live 授权失效：' + validHumanApproval(av.experience).reason);
  assert.equal(canPublish(av.experience).ok, true, 'canPublish 拒了：' + canPublish(av.experience).reason);
});

check('D2 PROPOSED --确定性验证 PASS--> VERIFIED_EXPERIENCE（晋升路径未被粘性逻辑破坏）', () => {
  const SHA = 'c'.repeat(64);
  const evidence = { class: 'file_hash', path: 'C:/p4r2/plugins/learn-core.mjs', sha256: SHA };
  const resolvers = { fileHash: () => SHA };
  const draft = makeExperience({
    title: 'B1 promotion path intact',
    body: 'an unapproved proposal that verifies must still become VERIFIED_EXPERIENCE',
    sourceEventSeqs: [41, 42],
    originSessionId: 'sess-b1-promote',
  });
  assert.equal(draft.ok, true, 'fixture draft 失败');
  const s0 = { ...draft.value.store, experiences: [draft.value] };
  const av = applyVerification(s0, draft.value.id, evidence, resolvers, 3000);
  assert.equal(av.ok, true, 'applyVerification 失败：' + (av.error ?? '-'));
  assert.equal(av.experience.state, 'VERIFIED_EXPERIENCE', 'state=' + av.experience.state);
  assert.equal(canPublish(av.experience).ok, false, '未审批却可发布 ⇒ 闸门被破坏');
  assert.equal(canPublish(av.experience).reason, 'not_human_approved:VERIFIED_EXPERIENCE');
});
console.log('');

console.log('='.repeat(74));
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
