// rev-probe4.mjs —— 独立审查探针（第四组）：回源锚点（AC1）在审批边界的绑定强度
//   I1 审批后改 sourceEventSeqs ⇒ 必须 approval_content_changed（锚点被内容绑定）
//   I2 审批后改 body           ⇒ 必须 approval_content_changed
//   I3 对照：未改动            ⇒ 必须 ok（绑定不得误伤正常流程）
//   I4 锚点校验的**不对称性**：file_hash 类证据不校验锚点；只有 session_outcome 类校验
//   I5 发布面（canPublish）是否校验"锚点必须真实存在" ⇒ 记录事实（不预设结论）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const REPO = 'C:\\Users\\Administrator\\Desktop\\sdeepseek harness\\_p4r2';
const PLUGIN_URL = pathToFileURL(path.join(REPO, 'plugins', 'learn.mjs')).href;
const core = await import(pathToFileURL(path.join(REPO, 'plugins', 'learn-core.mjs')).href);

let gen = 0;
const results = [];
const record = (id, verdict, detail) => { results.push({ id, verdict, detail }); console.log(`  [${verdict}] ${id} :: ${detail}`); };
const mkSessionsSvc = (reg) => ({ get: (sid) => (sid && reg.has(sid) ? reg.get(sid) : null) });
const mkSession = (sid, seed = []) => {
  const events = [...seed];
  return { id: sid, events, surface: { nodes: [] }, append(t, d) { const e = { type: t, data: d }; events.push(e); return e; } };
};
const EXEC = (s, c) => ({ agent: { session: s }, callId: c });
const EVIDENCE = ['manual review:', 'the human was asked', 'and allowed once'].join(' ');

async function newInstance(tag, { approvalSvc, sessionsSvc, dir }) {
  const d = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `rev4-${tag}-`));
  const hooks = new Map();
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on: (e, f) => { if (!hooks.has(e)) hooks.set(e, []); hooks.get(e).push(f); },
    tools: { register: () => { throw new Error('no'); } },
    get: (n) => (n === 'approval' ? approvalSvc : undefined),
    sessions: sessionsSvc,
  };
  const mod = await import(`${PLUGIN_URL}?rev4=${++gen}`);
  const api = mod.apply(ctx, { stateDir: d, globalStorePath: path.join(d, '_g.json'), autoPropose: false });
  return { api, dir: d };
}

const T = path.join(os.tmpdir(), '_rev-p4r2', 'anchor-probe.txt');
fs.writeFileSync(T, 'anchor probe v1\n', 'utf8');
const T_SHA = crypto.createHash('sha256').update(fs.readFileSync(T)).digest('hex');

console.log('=== 独立审查探针 4：回源锚点绑定强度 ===');
console.log('');

// ── 造一条真实的 PROPOSED → 手写自洽台账 + 植入宿主日志事件对 → APPROVED（同 G1 的构造）──
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4-i-'));
const SID = 'rev4-anchor-session';
const sess0 = mkSession(SID, [{ type: 'turn/start', data: {} }]);
const inst0 = await newInstance('i0', { sessionsSvc: mkSessionsSvc(new Map([[SID, sess0]])), dir: DIR });
const prop = await inst0.api.invokeTool('learn_propose',
  { title: 'REV anchor lesson', body: 'anchor body', sourceEventSeqs: [11, 22, 33] }, EXEC(sess0, 'i'));
const base = inst0.api.getStore(SID).experiences.find((e) => e.id === prop.experienceId);
const goodDigest = core.candidateDigest(base);

const recs = [];
const g = core.makeApprovalRecord(recs, {
  type: 'grant', schemaVersion: core.HUMAN_APPROVAL_LEDGER_SCHEMA, candidateId: base.id, digest: goodDigest,
  approvedAt: 1_760_000_000_000, trustedSource: core.HUMAN_APPROVAL_CHANNEL,
  hostActor: core.HUMAN_APPROVAL_ACTOR, approvalRef: 'rev4-anchor-ref-000001', hostSessionId: SID });
recs.push(g.record);
recs.push(core.makeApprovalRecord(recs, { type: 'consume', recordId: g.record.recordId, candidateId: base.id, digest: goodDigest, consumedAt: 1 }).record);
fs.writeFileSync(path.join(DIR, '_human-approvals.jsonl'), recs.map(core.serializeApprovalRecord).join(''), 'utf8');

const sessA = mkSession(SID, [{ type: 'turn/start', data: {} }]);
sessA.append('approval/asked', { id: 'rev4-anchor-ref-000001', toolName: 'learn_review',
  reason: `learn_review: approve experience ${base.id} digest=${goodDigest}` });
sessA.append('approval/decided', { id: 'rev4-anchor-ref-000001', outcome: 'allowed-once' });
const reg = new Map([[SID, sessA]]);

const approved = {
  ...base, state: 'APPROVED', approvedBy: core.HUMAN_APPROVAL_ACTOR, approvalEvidence: EVIDENCE,
  approvedAt: 1_760_000_000_000,
  verification: { status: 'VERIFIED', method: 'file_hash',
    evidence: { class: 'file_hash', path: T, sha256: T_SHA }, verifiedAt: 1_760_000_000_001, reverifyCount: 0 },
  lastVerifiedAt: 1_760_000_000_001,
  approval: { schema: core.HUMAN_APPROVAL_SCHEMA, channel: core.HUMAN_APPROVAL_CHANNEL,
    actor: core.HUMAN_APPROVAL_ACTOR, outcome: core.HUMAN_APPROVAL_GRANT, ref: 'rev4-anchor-ref-000001',
    candidateId: base.id, candidateDigest: goodDigest, approvedAt: 1_760_000_000_000,
    ledgerRecordId: g.record.recordId },
};
const inst = await newInstance('i1', { sessionsSvc: mkSessionsSvc(reg), dir: DIR });
const led = inst.api.approvalLedger();

// ── I3 对照：未改动必须放行 ───────────────────────────────────────────────
{
  const cp = core.canPublish(approved, led);
  record('I3-control-unchanged-publishable', cp.ok ? 'PASS' : 'FAIL', `canPublish=${JSON.stringify(cp)}`);
}

// ── I1 审批后改 sourceEventSeqs ⇒ 必须 approval_content_changed ────────────
{
  const tampered = { ...approved, sourceEventSeqs: [444, 555, 666] };
  const ap = core.approvalProvenance(tampered);
  const cp = core.canPublish(tampered, led);
  record('I1-anchors-tamper-after-approval', (ap.ok === false && ap.reason === 'approval_content_changed') ? 'PASS' : 'FAIL',
    `approvalProvenance=${ap.reason} canPublish=${JSON.stringify(cp)}`);
}

// ── I2 审批后改 body ⇒ 必须 approval_content_changed ──────────────────────
{
  const tampered = { ...approved, body: approved.body + ' [TAMPERED]' };
  const ap = core.approvalProvenance(tampered);
  const cp = core.canPublish(tampered, led);
  record('I2-body-tamper-after-approval', (ap.ok === false && ap.reason === 'approval_content_changed') ? 'PASS' : 'FAIL',
    `approvalProvenance=${ap.reason} canPublish=${JSON.stringify(cp)}`);
}

// ── I4 锚点校验的不对称性：只有 session_outcome 类才回源校验 ──────────────
{
  const fileHashRes = core.verifyEvidenceRecord(
    { class: 'file_hash', path: T, sha256: T_SHA, anchors: [777888, 999000] },
    { fileHash: (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') });
  const sessOutRes = core.verifyEvidenceRecord(
    { class: 'session_outcome', sessionId: SID, sessionName: 'n', window: [0, 9], anchors: [777888, 999000],
      toolCalls: 0, toolSuccesses: 0, toolFailures: 0, factsDigest: 'x', observedAt: 1 },
    { sessionOutcome: () => ({ ok: true, observed: { anchorsFound: 0, toolCalls: 0, toolSuccesses: 0, toolFailures: 0, factsDigest: 'x' } }) });
  record('I4-anchor-check-asymmetry', (fileHashRes.ok === true && sessOutRes.ok === false) ? 'INFO' : 'INFO',
    `file_hash(带不存在锚点)=${JSON.stringify(fileHashRes)}  session_outcome(同样锚点)=${JSON.stringify(sessOutRes)}`);
}

// ── I5 发布面是否校验"锚点真实存在于会话"（记录事实）─────────────────────
{
  // approved 的锚点是 [11,22,33]，而会话里只有 turn/start + 两件批准事件（**没有** seq 11/22/33 对应的学习事件）
  const evSeqs = new Set(sessA.events.map((_, i) => i));
  const realInSession = approved.sourceEventSeqs.every((s) => evSeqs.has(s));
  const cp = core.canPublish(approved, led);
  record('I5-publish-face-anchor-existence', cp.ok && !realInSession ? 'OBSERVED-GAP' : 'INFO',
    `锚点=${JSON.stringify(approved.sourceEventSeqs)} 会话事件数=${sessA.events.length} 锚点真实存在=${realInSession} canPublish=${JSON.stringify(cp)}`);

  // 把锚点直接改成明显不存在的巨大 seq（重新签发一条合法授权以排除 digest 绑定干扰）
  const recs2 = [];
  const g2 = core.makeApprovalRecord(recs2, {
    type: 'grant', schemaVersion: core.HUMAN_APPROVAL_LEDGER_SCHEMA, candidateId: base.id, digest: 'x',
    approvedAt: 1, trustedSource: core.HUMAN_APPROVAL_CHANNEL, hostActor: core.HUMAN_APPROVAL_ACTOR,
    approvalRef: 'rev4-anchor-ref-000002', hostSessionId: SID });
  const bogus = { ...approved, sourceEventSeqs: [987654321, 987654322] };
  const d2 = core.candidateDigest(bogus);
  recs2[0] = core.makeApprovalRecord([], {
    type: 'grant', schemaVersion: core.HUMAN_APPROVAL_LEDGER_SCHEMA, candidateId: base.id, digest: d2,
    approvedAt: 1, trustedSource: core.HUMAN_APPROVAL_CHANNEL, hostActor: core.HUMAN_APPROVAL_ACTOR,
    approvalRef: 'rev4-anchor-ref-000002', hostSessionId: SID }).record;
  recs2.push(core.makeApprovalRecord(recs2, { type: 'consume', recordId: recs2[0].recordId, candidateId: base.id, digest: d2, consumedAt: 1 }).record);
  const bogusExp = { ...bogus, approval: { ...bogus.approval, candidateDigest: d2, ref: 'rev4-anchor-ref-000002', ledgerRecordId: recs2[0].recordId, approvedAt: 1 }, approvedAt: 1 };
  const led2 = core.createMemoryApprovalLedger({ id: 'b', records: recs2, getSession: (s) => reg.get(s) });
  bogusExp.approval.ledgerRecordId = recs2[0].recordId;
  const cp2 = core.canPublish(bogusExp, led2);
  const v2 = core.validHumanApproval(bogusExp, led2);
  record('I5b-nonexistent-anchors-reach-denial-reason', 'INFO',
    `锚点=987654321/987654322（不可能存在）validHumanApproval=${JSON.stringify(v2)} canPublish=${JSON.stringify(cp2)}`);
}

console.log('');
const c = {};
for (const r of results) c[r.verdict] = (c[r.verdict] ?? 0) + 1;
console.log('  汇总: ' + JSON.stringify(c));
fs.writeFileSync(path.join(os.tmpdir(), '_rev-p4r2', 'rev-probe4-result.json'), JSON.stringify(results, null, 2), 'utf8');
