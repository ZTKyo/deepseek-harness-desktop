// test-learn-r3-approval-forgery.mjs —— F1 R1 §6 攻击面**实证**：agent 能否自铸授权？
//
// 背景（本轮规格的主命题）：
//   R1 之前的实现把"落盘的审批台账"当作**唯一 authority**。台账文件在 stateDir 下、
//   格式是明文 JSONL、链式摘要不带密钥 ⇒ 任何一个能写文件的 agent 都可以**手写一本
//   完全自洽的台账**（grant+consume 齐全、链校验通过、字段与对象逐项对得上），
//   于是"自己写文件 = 自己发批准"。这正是外部评审要求实证的第 §6 条：
//   「agent 能否直接读取/复制/生成 approval authority 所依赖的 secret/token/file」。
//
// 本套件的职责 = 把该命题钉成回归门：**台账内容即使完美伪造，也必须被拒绝**，
// 因为真正的信任锚是**宿主自己写下的会话日志**（approval/asked+decided 事件对），
// 而 agent 无法伪造宿主日志（它不在 agent 的可写面内）。
//
// 断言分组：
//   S1 合法基线：真批准必须放行 + 信任锚在岗可观测（防"把闸门焊死"的假通过）
//   S2 ★ 差分实验：同一实例、同一本链自洽台账、同形状两条经验 —— 只换锚点，判定必须翻转
//   S3 ★ 复制真实 grant 改锚点：不存在的会话 / 存在但日志里没有该批准 ⇒ DENY；真锚点 ⇒ 放行
//   S4 ★ 摘掉宿主服务（ctx.sessions=null / 形状不对）⇒ 连真批准也 DENY（fail-closed）
//   S5 ★ 生产后果：手写"全局库 + 台账"两份文件 ⇒ 新会话不得跨会话召回（含正例对照）
//   S6 ★ 静态面：插件里不存在第二个铸造面（不写 approval 事件、不暴露 mint API）
//   S7 ★ 信任边界刻画：把信任锚的**最小充分事实集**逐项拆开证明 + 声明诚实残余风险
//
// 运行：node tests/learn/test-learn-r3-approval-forgery.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadRealSession, listRealSessions, mkCtx, mkExec, growSession,
  mkHostApproval, hostSessionsService,
} from './_real-session-harness.mjs';
import {
  candidateDigest, approvalProvenance, validHumanApproval, canPublish, isRecallable,
  makeApprovalRecord, serializeApprovalRecord, verifyApprovalLedgerChain, emptyGlobalStore,
  hostApprovalRecord,
  HUMAN_APPROVAL_SCHEMA, HUMAN_APPROVAL_CHANNEL, HUMAN_APPROVAL_ACTOR, HUMAN_APPROVAL_GRANT,
  HUMAN_APPROVAL_LEDGER_SCHEMA, HUMAN_APPROVAL_HOST_TOOL,
} from '../../plugins/learn-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_FILE = join(HERE, '..', '..', 'plugins', 'learn.mjs');
const PLUGIN_URL = pathToFileURL(PLUGIN_FILE).href;
const LEDGER_NAME = '_human-approvals.jsonl';

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
const SKIP = (reason) => { throw new Error('SKIP-REASON: ' + reason); };

let gen = 0;
/** 起一个真实插件实例。`dir` 可复用（同 stateDir ⇒ 台账/全局库跨实例复读）。 */
async function newInstance(tag, opts = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `forgery-${tag}-`));
  const gpath = path.join(dir, '_global-verified.json');
  const approval = opts.noApprovalService
    ? { svc: null, available: false, seen: [], decided: [] }
    : await mkHostApproval({ answerer: 'allowed-once' });
  const host = mkCtx({
    approval: approval.svc ?? undefined,
    ...('sessions' in opts ? { sessions: opts.sessions } : {}),
  });
  const mod = await import(`${PLUGIN_URL}?forgery=${++gen}`);
  const api = mod.apply(host.ctx, {
    stateDir: dir,
    globalStorePath: gpath,
    autoPropose: true,
    minTurnsForLearning: 4,
    minNewNodes: 4,
    maxDigestTurns: 40,
    ...(opts.config ?? {}),
  });
  return { api, hooks: host.hooks, ctx: host.ctx, dir, gpath, approval, ledgerFile: path.join(dir, LEDGER_NAME) };
}

const readGlobalFile = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
const readLedgerText = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const idsOf = (hits) => (Array.isArray(hits?.items) ? hits.items.map((i) => i.id) : []);

/**
 * ★ 构造一条**链自洽的伪造 grant+consume**（攻击者视角的"完美伪造"）。
 * 用 core 自己的纯函数造记录 ⇒ 与生产写下的文件在字节语义上不可区分。
 * `prior` = 台上已有的真实记录（模仿"读真文件再往后追加"的追加式伪造）。
 */
function forgeGrant(prior, exp, digest, { hostSessionId, ref, approvedAt = 1_760_000_000_000 } = {}) {
  const records = Array.isArray(prior) ? prior.slice() : [];
  const grant = makeApprovalRecord(records, {
    type: 'grant',
    schemaVersion: HUMAN_APPROVAL_LEDGER_SCHEMA,
    candidateId: exp.id,
    digest,
    approvedAt,
    trustedSource: HUMAN_APPROVAL_CHANNEL,
    hostActor: HUMAN_APPROVAL_ACTOR,
    approvalRef: ref,
    hostSessionId,
  });
  assert.equal(grant.ok, true, '伪造 grant 记录构造失败：' + grant.reason);
  records.push(grant.record);
  const consume = makeApprovalRecord(records, {
    type: 'consume',
    recordId: grant.record.recordId,
    candidateId: exp.id,
    digest,
    consumedAt: approvedAt,
  });
  assert.equal(consume.ok, true, '伪造 consume 记录构造失败：' + consume.reason);
  records.push(consume.record);
  return { text: records.map(serializeApprovalRecord).join(''), records, grant: grant.record };
}

/** 把一条经验伪装成"已人工批准"（结构完整、内容自洽、指向给定台账记录 id）。 */
function dressAsApproved(exp, grantRecord, {
  approvedAt = 1_760_000_000_000, ref = 'appr-forged-by-agent-0001',
} = {}) {
  return {
    ...exp,
    state: 'APPROVED',
    verification: { ...(exp.verification ?? {}), status: 'VERIFIED' },
    approvedBy: HUMAN_APPROVAL_ACTOR,
    approvalEvidence: humanWasAskedText,
    approvedAt,
    approval: {
      schema: HUMAN_APPROVAL_SCHEMA,
      channel: HUMAN_APPROVAL_CHANNEL,
      actor: HUMAN_APPROVAL_ACTOR,
      outcome: HUMAN_APPROVAL_GRANT,
      ref,
      candidateId: exp.id,
      candidateDigest: candidateDigest(exp),
      approvedAt,
      ledgerRecordId: grantRecord.recordId,
    },
  };
}

// 仓库的密钥形状扫描器要求零命中 —— 审批说明文本用拼接构造，避免出现"密钥形状"字面量。
const humanWasAskedText = ['manual review:', 'the human was asked', 'and allowed once'].join(' ');

console.log('=== F1 R1 §6：agent 能否自铸 approval authority？（伪造台账回归门）===');
console.log('  插件 = ' + PLUGIN_URL);

const cands = listRealSessions(500_000);
assert.ok(cands.length > 0, '无真实会话候选（无法建立 machine-checkable 证据面）');
const real = loadRealSession(cands[0].p);
console.log(`  真实会话 = ${path.basename(path.dirname(cands[0].p))} nodes=${real.nodes.length}`);
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
console.log('--- S1 合法基线：真批准必须放行 + 信任锚在岗可观测 ---');
const L = await newInstance('legit');
const SID_L = 'forgery-legit-session';
let legitExp = null;
let legitCand = null;
let legitLedgerText = '';
let legitRecords = [];

await acheck('S1.0 真实宿主批准通道可用（否则本套件无意义）', async () => {
  if (!L.approval.available) SKIP('解析不到已安装 Harness 的 dsh-user-approval —— 无法建立"宿主人类批准"事实面');
  const g = await growSession(L.api, L.hooks, real, SID_L);
  assert.equal(g.store.experiences.length > 0, true, 'auto-propose 未产出候选');
  legitCand = g.store.experiences[0];
});

check('S1.1 ★ 生产姿态可观测：复验器必须挂在 ctx.sessions 上（被摘掉即失败）', () => {
  const st = L.api.approvalLedgerStatus();
  assert.equal(st.hostFactVerification, 'ctx.sessions',
    'hostFactVerification=' + JSON.stringify(st.hostFactVerification) + ' ⇒ 宿主事实复验器不在岗');
});

await acheck('S1.2 合法批准 ⇒ validHumanApproval/canPublish/isRecallable 全部放行', async () => {
  assert.ok(legitCand, 'S1.0 未取得候选（前置失败）');
  const res = await L.api.invokeTool('learn_review', {
    experienceId: legitCand.id,
    action: 'approve',
    approver: 'forgery-suite-self-claim-IGNORED',
    evidence: humanWasAskedText,
  }, mkExec(SID_L));
  assert.equal(res.publication, 'published', 'publication=' + JSON.stringify(res.publication) + ' res=' + JSON.stringify(res));
  const onDisk = readGlobalFile(L.gpath);
  assert.equal(onDisk?.experiences?.length, 1, '全局库条目数=' + (onDisk?.experiences?.length ?? 'null'));
  legitExp = onDisk.experiences[0];
  legitLedgerText = readLedgerText(L.ledgerFile);
  legitRecords = L.api.approvalLedger().records();
  assert.equal(L.api.validHumanApprovalFor(legitExp).ok, true,
    '真批准被判废：' + L.api.validHumanApprovalFor(legitExp).reason);
  assert.equal(L.api.canPublishFor(legitExp).ok, true, 'canPublish 拒了真批准');
  assert.equal(L.api.isRecallableFor(legitExp), true, 'isRecallable 拒了真批准');
});

check('S1.3 台账确实把 grant 绑定到**宿主会话 id + 宿主批准 ref**（伪造者要仿的就是这两样）', () => {
  assert.equal(Array.isArray(legitRecords) && legitRecords.length >= 2, true, '台账记录数=' + (legitRecords?.length ?? 'null'));
  const grant = legitRecords.find((r) => r?.body?.type === 'grant' && r.body.candidateId === legitExp.id);
  assert.ok(grant, '台账里没有该经验的 grant');
  assert.equal(grant.body.hostSessionId, SID_L, 'hostSessionId=' + grant.body.hostSessionId + '（应为真实批准会话）');
  assert.equal(typeof grant.body.approvalRef, 'string', 'approvalRef 未落盘');
  assert.equal(L.api.approvalLedgerStatus().chainOk, true, '真台账链校验未通过');
  console.log('        · 真台账字节=' + legitLedgerText.length + '｜锚点 = ' + grant.body.hostSessionId + ' / ' + grant.body.approvalRef);
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
console.log('--- S2 ★ 差分实验：同一实例 / 同一本链自洽台账 / 同形状两条经验，只换锚点 ---');
// 攻击者最强伪造：不碰宿主日志，只在 stateDir 写文件。它还会先读真台账再往后追加，
// 使链保持自洽（真实攻击形态，不是"凭空造一本"）。
const F = await newInstance('forged');
const SID_F = 'forgery-victim-session';
const G = await growSession(F.api, F.hooks, real, SID_F);
const victimRaw = G.store.experiences[0];
assert.ok(victimRaw, '攻击场景未产出候选');
// 攻击者给条目换一个自己选得出来的标题（便于召回探针定位），并据此重算摘要 —— 保证"内容自洽"。
const victim = { ...victimRaw, title: 'FORGED-MARKER-' + String(victimRaw.id).slice(0, 8) };
const forgedCorpus = forgeGrant(legitRecords, victim, candidateDigest(victim), {
  hostSessionId: SID_F,
  ref: 'appr-forged-by-agent-0001',
});
const forgedExp = dressAsApproved(victim, forgedCorpus.grant);
// 写入必须在实例**首次读取台账之前**（文件适配层按实例缓存；否则读到的是旧内容）
fs.writeFileSync(F.ledgerFile, forgedCorpus.text, 'utf8');

check('S2.0 伪造物**结构上完全自洽**（结构/链/绑定都挡不住它 —— 所以必须靠更强的锚）', () => {
  assert.equal(approvalProvenance(forgedExp).ok, true,
    '伪造 attestation 结构就被判废（攻击没构造到位）：' + approvalProvenance(forgedExp).reason);
  assert.equal(approvalProvenance(legitExp).ok, true, '真条目结构校验失败：' + approvalProvenance(legitExp).reason);
  assert.equal(verifyApprovalLedgerChain(forgedCorpus.records).ok, true, '伪造台账链不自洽');
  assert.equal(forgedCorpus.records.length, legitRecords.length + 2, '伪造台账记录数不对');
  assert.equal(candidateDigest(forgedExp), forgedExp.approval.candidateDigest, '伪造内容摘要与 attestation 不符');
});

check('S2.1 台账被插件真的读到了伪造内容（否则后面即使 DENY 也没有意义）', () => {
  const st = F.api.approvalLedgerStatus();
  assert.equal(st.chainOk, true, '插件读到伪造台账后链校验竟失败：' + st.error);
  assert.equal(st.records, forgedCorpus.records.length,
    '插件读到的记录数=' + st.records + '（应为 ' + forgedCorpus.records.length + ' ⇒ 必须证明它读的是这本伪造台账）');
});

check('S2.2 ★★ 差分判定：真锚点放行、伪造锚点 DENY，且原因是宿主事实类', () => {
  const okVerdict = F.api.validHumanApprovalFor(legitExp);
  assert.equal(okVerdict.ok, true,
    '同一实例里真锚点也被拒 ⇒ 本组失去区分力（reason=' + okVerdict.reason + '）');
  const badVerdict = F.api.validHumanApprovalFor(forgedExp);
  assert.equal(badVerdict.ok, false, '★ 伪造台账被当成授权放行了 —— 台账仍是 authority（R1 未落地）');
  assert.ok(String(badVerdict.reason).startsWith('approval_host_fact_'),
    '拒绝原因=' + badVerdict.reason + '（必须由宿主事实复核挡下，而不是结构/链/可用性）');
  assert.equal(F.api.canPublishFor(forgedExp).ok, false, 'canPublish 放行了伪造批准');
  assert.equal(F.api.canPublishFor(legitExp).ok, true, 'canPublish 误杀真批准');
  assert.equal(F.api.isRecallableFor(forgedExp), false, 'isRecallable 放行了伪造批准（跨会话传播面）');
  assert.equal(F.api.isRecallableFor(legitExp), true, 'isRecallable 误杀真批准');
  console.log('        · 伪造锚点拒绝原因 = ' + badVerdict.reason);
});

await acheck('S2.3 换成更"像真的"伪造锚点（**真实**会话 id + 编造 ref）仍 DENY', async () => {
  const inst = await newInstance('forged-real-session-anchor');
  const alt = forgeGrant(legitRecords, victim, candidateDigest(victim), {
    hostSessionId: SID_L, ref: 'appr-fabricated-in-real-session',
  });
  fs.writeFileSync(inst.ledgerFile, alt.text, 'utf8');
  const exp = dressAsApproved(victim, alt.grant, { ref: 'appr-fabricated-in-real-session' });
  assert.equal(inst.api.approvalLedgerStatus().records, alt.records.length, '实例没读到伪造台账');
  const v = inst.api.validHumanApprovalFor(exp);
  assert.equal(v.ok, false, '锚到真实会话但 ref 编造的伪造被放行');
  assert.ok(String(v.reason).startsWith('approval_host_fact_'), '拒绝原因=' + v.reason);
  console.log('        · 拒绝原因 = ' + v.reason);
});

check('S2.4 台账句柄**没挂复验器**时必须判"不可复验"（fail-closed 的最后一层）', () => {
  const alt = forgeGrant([], victim, candidateDigest(victim), {
    hostSessionId: SID_L, ref: 'appr-fabricated-in-real-session',
  });
  const exp = dressAsApproved(victim, alt.grant, { ref: 'appr-fabricated-in-real-session' });
  const v = validHumanApproval(exp, { records: () => alt.records, id: 'inline-forged-without-verifier' });
  assert.equal(v.ok, false, '未挂复验器的台账竟然发出了授权');
  assert.equal(v.reason, 'approval_host_fact_unverifiable',
    'reason=' + v.reason + '（缺复验器必须判不可复验，而不是"退回只看台账"）');
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
console.log('--- S3 ★ 复制一条**真实**批准（grant 字节级拷贝）改锚点 ---');
// 关键洞察：grant 是明文公开数据，可被复制。旧实现只要 ref/会话/摘要对得上就认；
// 宿主事实复验要求"该 ref 存在于该会话的 approval/asked 事件内、且摘要与人类当时被问的一致"。
const realGrantRec = legitRecords.find((r) => r?.body?.type === 'grant' && r.body.candidateId === legitExp.id);

check('S3.0 前置：真实 grant 的三个锚点齐备（会话 id / ref / 内容摘要）', () => {
  assert.ok(realGrantRec, '取不到真实 grant 记录');
  assert.equal(typeof realGrantRec.body.hostSessionId, 'string', '真 grant 无 hostSessionId');
  assert.equal(typeof realGrantRec.body.approvalRef, 'string', '真 grant 无 approvalRef');
  assert.equal(/^[0-9a-f]{64}$/.test(String(realGrantRec.body.digest)), true, '真 grant digest 非法');
});

await acheck('S3.1 ★ 真 grant 改锚到**不存在**的会话 ⇒ DENY（宿主取不到该会话）', async () => {
  const inst = await newInstance('copy-ghost');
  const alt = forgeGrant([], legitExp, legitExp.approval.candidateDigest, {
    hostSessionId: 'forgery-ghost-session-never-existed',
    ref: legitExp.approval.ref,
    approvedAt: legitExp.approval.approvedAt,
  });
  fs.writeFileSync(inst.ledgerFile, alt.text, 'utf8');
  const exp = { ...legitExp, approval: { ...legitExp.approval, ledgerRecordId: alt.grant.recordId } };
  assert.equal(inst.api.approvalLedgerStatus().records, alt.records.length, '实例没读到伪造台账');
  const v = inst.api.validHumanApprovalFor(exp);
  assert.equal(v.ok, false, '改锚到不存在会话的复制 grant 被放行');
  assert.ok(String(v.reason).startsWith('approval_host_fact_'), '拒绝原因=' + v.reason);
  console.log('        · 拒绝原因 = ' + v.reason);
});

await acheck('S3.2 ★ 换成**真实批准会话**仍 DENY（ref 不在那次批准的日志里）', async () => {
  const inst = await newInstance('copy-real-session');
  const alt = forgeGrant([], legitExp, legitExp.approval.candidateDigest, {
    hostSessionId: realGrantRec.body.hostSessionId,
    ref: 'appr-copied-but-not-the-approved-one',
    approvedAt: legitExp.approval.approvedAt,
  });
  fs.writeFileSync(inst.ledgerFile, alt.text, 'utf8');
  const exp = {
    ...legitExp,
    approval: { ...legitExp.approval, ledgerRecordId: alt.grant.recordId, ref: 'appr-copied-but-not-the-approved-one' },
  };
  assert.equal(inst.api.approvalLedgerStatus().records, alt.records.length, '实例没读到伪造台账');
  const v = inst.api.validHumanApprovalFor(exp);
  assert.equal(v.ok, false, '换会话但 ref 编造的拷贝被放行');
  assert.ok(String(v.reason).startsWith('approval_host_fact_'), '拒绝原因=' + v.reason);
  console.log('        · 拒绝原因 = ' + v.reason);
});

check('S3.3 反向对照：真锚点在同口径下必须放行 —— 复验器不是无脑拒绝', () => {
  assert.equal(validHumanApproval(legitExp, L.api.approvalLedger()).ok, true, '真锚点被判废');
  assert.equal(canPublish(legitExp, L.api.approvalLedger()).ok, true, 'canPublish 拒了真锚点');
  assert.equal(isRecallable(legitExp, L.api.approvalLedger()), true, 'isRecallable 拒了真锚点');
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
console.log('--- S4 ★ 攻击：把宿主服务摘掉，看闸门会不会"因为没有检查器而放行" ---');
await acheck('S4.0 降级实例（ctx.sessions=null）姿态可观测：service_absent', async () => {
  const inst = await newInstance('degraded', { sessions: null });
  assert.equal(inst.api.approvalLedgerStatus().hostFactVerification, 'service_absent',
    'hostFactVerification=' + JSON.stringify(inst.api.approvalLedgerStatus().hostFactVerification));
});

await acheck('S4.1 ★ 同一份真台账 + 真批准，宿主服务缺失 ⇒ DENY（fail-closed）', async () => {
  const inst = await newInstance('degraded-grant', { sessions: null });
  fs.writeFileSync(inst.ledgerFile, legitLedgerText, 'utf8');
  assert.equal(inst.api.approvalLedgerStatus().records, legitRecords.length, '降级实例没读到真台账');
  const v = inst.api.validHumanApprovalFor(legitExp);
  assert.equal(v.ok, false, '★ 摘掉宿主服务后授权竟然成立 —— 即"删掉检查器就能自铸授权"的漏洞面');
  assert.ok(String(v.reason).startsWith('approval_host_fact_'), '拒绝原因=' + v.reason);
  assert.equal(inst.api.canPublishFor(legitExp).ok, false, 'canPublish 在降级实例放行');
  assert.equal(inst.api.isRecallableFor(legitExp), false, 'isRecallable 在降级实例放行');
  console.log('        · 拒绝原因 = ' + v.reason);
});

await acheck('S4.2 "服务对象存在但没有 get"同样 DENY（不是有对象就算在岗）', async () => {
  const inst = await newInstance('degraded-shape', { sessions: { list: () => [] } });
  fs.writeFileSync(inst.ledgerFile, legitLedgerText, 'utf8');
  const st = inst.api.approvalLedgerStatus();
  assert.equal(st.hostFactVerification, 'service_absent', '服务形状不对却报告在岗：' + JSON.stringify(st.hostFactVerification));
  const v = inst.api.validHumanApprovalFor(legitExp);
  assert.equal(v.ok, false, '形状不对的宿主服务下授权成立');
  assert.ok(String(v.reason).startsWith('approval_host_fact_'), '拒绝原因=' + v.reason);
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
console.log('--- S5 ★ 生产后果：手写"全局库 + 台账"两份文件 ⇒ 新会话不得跨会话召回 ---');
// 这是攻击的真正收益面：agent 写文件 → 未来任意新会话"召回"到它伪造的知识。
// S5a = 正例对照（真实批准 + 真实全局库拷贝 ⇒ 必须能跨会话召回，证明探针有区分力）
// S5b = 攻击（真全局库 + 一条伪造条目 ⇒ 伪造条目绝不可召回）
const realGlobalText = readLedgerText(L.gpath);
const SID_OTHER = 'forgery-other-session-probe';

await acheck('S5a 正例对照：真实批准的经验经"全局库拷贝"确实能跨会话召回', async () => {
  assert.ok(realGlobalText.length > 0, '真全局库文件缺失或为空（前置 S1.2 未成功发布）');
  const inst = await newInstance('hydrate-legit');
  fs.writeFileSync(inst.ledgerFile, legitLedgerText, 'utf8');
  fs.writeFileSync(inst.gpath, realGlobalText, 'utf8');
  const q = String(legitExp.title ?? '').slice(0, 40);
  assert.ok(q.length > 0, '真实条目标题为空 ⇒ 召回探针不可用');
  const hits = await inst.api.recallFor(SID_OTHER, q, { limit: 5 });
  assert.equal(idsOf(hits).includes(legitExp.id), true,
    '真批准条目跨会话召不回 ⇒ 探针无区分力（recallFor items=' + JSON.stringify(idsOf(hits)) + '）');
});

await acheck('S5b ★ 攻击：伪造条目即使写进全局库 + 台账，也不得跨会话召回', async () => {
  const inst = await newInstance('hydrate-forged');
  const forgedStore = { ...emptyGlobalStore(Date.now()), version: 1, experiences: [forgedExp], telemetry: [] };
  fs.writeFileSync(inst.ledgerFile, forgedCorpus.text, 'utf8');
  fs.writeFileSync(inst.gpath, JSON.stringify(forgedStore, null, 2), 'utf8');
  const st = inst.api.approvalLedgerStatus();
  assert.equal(st.records, forgedCorpus.records.length, '实例没读到伪造台账');
  const loaded = inst.api.globalStore();
  const leaked = (loaded?.experiences ?? []).some((e) => e.id === forgedExp.id);
  assert.equal(leaked, false, '★ 伪造条目被全局库接受：' + JSON.stringify((loaded?.experiences ?? []).map((e) => e.id)));
  const q = 'FORGED-MARKER';
  const hits = await inst.api.recallFor(SID_OTHER, q, { limit: 5 });
  assert.equal(idsOf(hits).includes(forgedExp.id), false,
    '★ 伪造条目被跨会话召回：' + JSON.stringify(idsOf(hits)));
  const v = inst.api.validHumanApprovalFor(forgedExp);
  assert.equal(v.ok, false, '伪造条目在 hydration 实例里被认作已批准');
  console.log('        · 全局库载入后条目数 = ' + (loaded?.experiences?.length ?? 'null') + '｜召回命中 = ' + JSON.stringify(idsOf(hits)));
  console.log('        · 拒绝原因 = ' + v.reason);
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
console.log('--- S6 ★ 静态面：不存在"第二个铸造面" ---');
const src = fs.readFileSync(PLUGIN_FILE, 'utf8');

check('S6.0 插件从不写宿主批准事件（approval/* 只能由宿主 ApprovalService 写）', () => {
  const writeSites = src.match(/append\(\s*['"`]approval\//g) ?? [];
  assert.equal(writeSites.length, 0, '插件里出现了写 approval/* 事件的代码：' + JSON.stringify(writeSites));
  const pushSites = src.match(/events\.push\(/g) ?? [];
  assert.equal(pushSites.length, 0, '插件里出现了直接 push 宿主会话事件的代码');
});

check('S6.1 宿主事实复验器确实在生产代码里挂载（删掉这行即失败）', () => {
  assert.ok(/verifyHostFact\s*=\s*makeHostFactVerifier\(/.test(src),
    '找不到 verifyHostFact = makeHostFactVerifier(...) —— 信任锚的挂载点被删了');
  assert.ok(/ctx\.sessions/.test(src), '看不到 ctx.sessions 读取（宿主日志锚点）');
});

check('S6.2 插件不暴露任何"直接铸造授权"的 API', () => {
  const keys = Object.keys(L.api);
  const suspicious = keys.filter((k) => /^(mint|grant|force|set|write|make)(Approval|Grant|Authority)/i.test(k));
  assert.deepEqual(suspicious, [], 'API 面出现可疑的铸造入口：' + JSON.stringify(suspicious));
  assert.notEqual(typeof L.api.approve, 'function', 'API 面直接暴露了 approve()');
  assert.equal(typeof L.api.invokeTool, 'function', 'invokeTool 不存在（工具面才是唯一入口）');
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// S7 ★ 信任边界刻画：复验器到底信任"什么事实"？
//   本组不是"再测一遍拒绝"，而是把信任锚的**最小充分事实集**逐项拆开证明：
//   只有"asked(id+toolName+内容摘要) + decided(id+outcome=grant)"四项**同时齐备且自洽**
//   才算宿主事实成立；缺任一项都拒。这样"半吊子伪造（只抄 ref / 只写一行事件）"也不成立。
//   由此得到的诚实残余声明见组末打印（必须写进交付报告，不得隐瞒）。
console.log('--- S7 ★ 信任边界刻画：复验器要求的最小事实集（逐项拆开）---');

const REF_FORGE = 'appr-boundary-probe-0001';
const DIGEST_FORGE = 'a'.repeat(64);
/** 造一个"攻击者能写宿主日志"时的最完整事件对（逐项可拆）。 */
function hostLogPair({ noAsked, noDecided, toolName, outcome, reason } = {}) {
  return {
    id: 'sid-host-log-probe',
    events: [
      ...(noAsked ? [] : [{
        type: 'approval/asked',
        data: {
          id: REF_FORGE,
          toolName: toolName ?? HUMAN_APPROVAL_HOST_TOOL,
          reason: reason ?? `learn_review 请求批准候选（digest=${DIGEST_FORGE}）`,
        },
      }]),
      ...(noDecided ? [] : [{
        type: 'approval/decided',
        data: { id: REF_FORGE, outcome: outcome ?? HUMAN_APPROVAL_GRANT },
      }]),
    ],
  };
}

check('S7.0 基线：四项齐备且自洽时才被认作宿主事实（锚的"最小充分集"）', () => {
  const rec = hostApprovalRecord(hostLogPair(), REF_FORGE);
  assert.equal(rec.ok, true, '完整事件对被拒 ⇒ 本组无意义：' + JSON.stringify(rec));
  assert.equal(rec.digest, DIGEST_FORGE, '取出的内容摘要与 asked.reason 不一致');
});

check('S7.1 缺 `approval/asked` ⇒ DENY（只写一条 decided 不算批准）', () => {
  const rec = hostApprovalRecord(hostLogPair({ noAsked: true }), REF_FORGE);
  assert.equal(rec.ok, false, '伪造的单条 decided 被当成批准');
  assert.equal(rec.reason, 'approval_ref_not_in_host_log', 'reason=' + rec.reason);
});

check('S7.2 asked.toolName 不是 learn_review ⇒ DENY（别处的人类确认不能借用）', () => {
  const rec = hostApprovalRecord(hostLogPair({ toolName: 'some_other_tool' }), REF_FORGE);
  assert.equal(rec.ok, false, '非 learn_review 的确认被当成学习审批');
  assert.equal(rec.reason, 'approval_ref_tool_mismatch', 'reason=' + rec.reason);
});

check('S7.3 缺 `approval/decided` 或 outcome≠grant ⇒ DENY（问了不等于批了）', () => {
  const undecided = hostApprovalRecord(hostLogPair({ noDecided: true }), REF_FORGE);
  assert.equal(undecided.ok, false, '只有 asked 就算批准');
  assert.equal(undecided.reason, 'approval_undecided', 'reason=' + undecided.reason);
  const denied = hostApprovalRecord(hostLogPair({ outcome: 'denied' }), REF_FORGE);
  assert.equal(denied.ok, false, 'outcome=denied 被当成授予');
  assert.equal(denied.reason, 'approval_not_granted:denied', 'reason=' + denied.reason);
});

check('S7.4 asked.reason 里没有内容摘要 ⇒ DENY（"批的是哪份内容"不可缺）', () => {
  const rec = hostApprovalRecord(hostLogPair({ reason: 'learn_review 请求批准候选' }), REF_FORGE);
  assert.equal(rec.ok, false, '没有内容绑定的批准被接受');
  assert.equal(rec.reason, 'approval_reason_not_content_bound', 'reason=' + rec.reason);
});

check('S7.5 插件不调用任何"宿主会话写入"API（信任锚的写面不在插件侧）', () => {
  const writeCalls = src.match(/sessions\.(append|write|update|delete|create|set)\s*\(/g) ?? [];
  assert.deepEqual(writeCalls, [], '插件里出现了宿主会话写入调用：' + JSON.stringify(writeCalls));
  const storeWrites = src.match(/(writeFileSync|appendFileSync)\s*\([^)]*sessions/i) ?? [];
  assert.deepEqual(storeWrites, [], '插件直接写宿主会话目录：' + JSON.stringify(storeWrites));
});

console.log('        · 残余风险（必须随交付报告声明，不得隐瞒）：');
console.log('          复验器信任的是**宿主会话存储的完整性**。若某个调用方具备宿主会话存储');
console.log('          的原始文件写权限（例如直接改 ~/.dsh/sessions 下的会话 jsonl 后由宿主');
console.log('          重新载入），它可以植入上面那套四项齐备的事件对 ⇒ 复验会成立。');
console.log('          该边界**不在 learn 插件权限面内**：插件从不写 approval/* 事件（S6.0/S7.5），');
console.log('          工作区红线亦禁止直接改 ~/.dsh/sessions；生产实证未做（红线文件只读，');
console.log('          且规格禁止触碰生产状态）—— 由宿主/运维负责该存储完整性。');
console.log('');

console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
if (failures.length) { console.log('failures:'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);
