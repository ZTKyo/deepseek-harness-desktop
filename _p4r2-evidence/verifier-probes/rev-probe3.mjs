// rev-probe3.mjs —— 独立审查探针（第三组）：R2→R3 修复 delta 的真实性
//   ① H1 审批粘性（R2 外部评审 BLOCKER-1 的根因）：APPROVED 遇机器 PASS 必须保持 APPROVED
//   ② H2 晋升路径未被粘性逻辑破坏：PROPOSED 遇机器 PASS 仍升为 VERIFIED_EXPERIENCE
//   ③ H3 APPROVED 遇机器 FAIL 也不得被撤销授权
//   ④ H4 真实宿主服务放行后的落账逐项核对 + H5 单次消费不可重复

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
const record = (id, verdict, detail) => {
  results.push({ id, verdict, detail });
  console.log(`  [${verdict}] ${id} :: ${detail}`);
};
const mkSessionsSvc = (reg) => ({ get: (sid) => (sid && reg.has(sid) ? reg.get(sid) : null) });
const mkSession = (sid) => {
  const events = [{ type: 'turn/start', data: {} }];
  return { id: sid, events, surface: { nodes: [] }, append(type, data) { const e = { type, data }; events.push(e); return e; } };
};
const EXEC = (s, c) => ({ agent: { session: s }, callId: c });
const EVIDENCE = ['manual review:', 'the human was asked', 'and allowed once'].join(' ');

function mkCtx({ approval, sessions }) {
  const hooks = new Map();
  return {
    ctx: {
      logger: { info: () => {}, warn: () => {} },
      on: (e, f) => { if (!hooks.has(e)) hooks.set(e, []); hooks.get(e).push(f); },
      tools: { register: () => { throw new Error('no'); } },
      get: (n) => (n === 'approval' ? approval : undefined),
      sessions,
    }, hooks,
  };
}
async function newInstance(tag, { approvalSvc, sessionsSvc, dir }) {
  const d = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `rev3-${tag}-`));
  const h = mkCtx({ approval: approvalSvc, sessions: sessionsSvc });
  const mod = await import(`${PLUGIN_URL}?rev3=${++gen}`);
  const api = mod.apply(h.ctx, { stateDir: d, globalStorePath: path.join(d, '_g.json'), autoPropose: false });
  return { api, dir: d };
}
async function mkHostApproval() {
  const ap = process.env.APPDATA;
  const base = path.join(ap, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
  const cu = path.join(base, 'cordis', 'lib', 'index.js');
  const au = path.join(base, 'dsh-user-approval', 'lib', 'index.js');
  if (!fs.existsSync(cu) || !fs.existsSync(au)) return { available: false };
  const { Context } = await import(pathToFileURL(cu).href);
  const { ApprovalService } = await import(pathToFileURL(au).href);
  const app = new Context();
  app.plugin(ApprovalService, { policy: 'ask' });
  await new Promise((r) => setTimeout(r, 60));
  app.on('approval/request', () => 'allowed-once');
  return { available: true, svc: app.get('approval') };
}
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

console.log('=== 独立审查探针 3：R2->R3 delta ===');
console.log('');
const T = path.join(os.tmpdir(), '_rev-p4r2', 'sticky-target.txt');
fs.writeFileSync(T, 'sticky v1\n', 'utf8');
const T_SHA = sha(T);

// ── H1/H2/H3：状态机粘性与晋升（纯函数层，隔离"审批粘性"这一处改动）────────
{
  const base = core.makeExperience({ title: 'h1 base', body: 'b', sourceEventSeqs: [1] }).value;
  const approved = {
    ...base,
    state: 'APPROVED',
    approvedBy: core.HUMAN_APPROVAL_ACTOR,
    approvalEvidence: EVIDENCE,
    approvedAt: 1_760_000_000_000,
    approval: {
      schema: core.HUMAN_APPROVAL_SCHEMA, channel: core.HUMAN_APPROVAL_CHANNEL,
      actor: core.HUMAN_APPROVAL_ACTOR, outcome: core.HUMAN_APPROVAL_GRANT,
      ref: 'rev-h1-ref-00000001', candidateId: base.id,
      candidateDigest: core.candidateDigest(base), approvedAt: 1_760_000_000_000,
      ledgerRecordId: 'hap-0123456789abcdef',
    },
  };
  const store = { ...core.emptyStore('s'), experiences: [approved] };
  const ev = { class: 'file_hash', path: T, sha256: T_SHA, note: 'sticky' };

  const res = core.applyVerification(store, base.id, ev, { fileHash: (p) => sha(p) }, Date.now());
  const after = (res.value ?? store).experiences.find((e) => e.id === base.id);
  record('H1-approved-stays-approved-on-pass', (res.ok && after.state === 'APPROVED') ? 'PASS' : 'FAIL',
    `verifyOk=${res.ok} err=${res.error} method=${res.method} state=${after.state} (expect APPROVED)`);

  const prop = core.makeExperience({ title: 'h2 proposed', body: 'b', sourceEventSeqs: [2] }).value;
  const store2 = { ...core.emptyStore('s'), experiences: [prop] };
  const res2 = core.applyVerification(store2, prop.id, ev, { fileHash: (p) => sha(p) }, Date.now());
  const after2 = (res2.value ?? store2).experiences.find((e) => e.id === prop.id);
  record('H2-proposed-promotes-to-verified', (res2.ok && after2.state === 'VERIFIED_EXPERIENCE') ? 'PASS' : 'FAIL',
    `verifyOk=${res2.ok} state=${after2.state} (expect VERIFIED_EXPERIENCE)`);

  const res3 = core.applyVerification(store, base.id,
    { class: 'file_hash', path: T, sha256: 'f'.repeat(64) }, { fileHash: (p) => sha(p) }, Date.now());
  const after3 = (res3.value ?? store).experiences.find((e) => e.id === base.id);
  record('H3-approved-survives-fail', (after3.state === 'APPROVED') ? 'PASS' : 'FAIL',
    `verifyOk=${res3.ok} err=${res3.error} state=${after3.state} vstatus=${after3.verification?.status} (expect APPROVED / REVALIDATION_REQUIRED)`);
}

// ── H4/H5：真实宿主服务放行后的落账与单次消费 ──────────────────────────────
{
  const ha = await mkHostApproval();
  if (!ha.available) record('H4-approval-ledger-bookkeeping', 'SKIP', 'no dsh-user-approval');
  else {
    const SID = 'rev3-h4';
    const sess = mkSession(SID);
    const reg = new Map([[SID, sess]]);
    const inst = await newInstance('h4', { approvalSvc: ha.svc, sessionsSvc: mkSessionsSvc(reg) });
    const prop = await inst.api.invokeTool('learn_propose',
      { title: 'h4 lesson', body: 'body h4', sourceEventSeqs: [1, 2, 3] }, EXEC(sess, 'h4'));
    const rev = await inst.api.invokeTool('learn_review',
      { experienceId: prop.experienceId, action: 'approve', evidence: EVIDENCE }, EXEC(sess, 'h4b'));
    const exp = inst.api.getStore(SID).experiences.find((e) => e.id === prop.experienceId);
    const st = inst.api.approvalLedgerStatus ? inst.api.approvalLedgerStatus() : null;
    const ap = core.approvalProvenance(exp);
    const chev = exp.approval ? core.candidateDigest(exp) === exp.approval.candidateDigest : false;
    record('H4-approval-ledger-bookkeeping',
      (rev.ok && exp.state === 'APPROVED' && ap.ok && chev) ? 'PASS' : 'FAIL',
      `state=${exp.state} provenance=${ap.ok}/${ap.reason} ref=${exp.approval?.ref} actor=${exp.approval?.actor} outcome=${exp.approval?.outcome} digestBound=${chev} ledger=${JSON.stringify(st)}`);

    const led = inst.api.approvalLedger();
    const recs = typeof led?.records === 'function' ? led.records() : [];
    const grant = recs.find((r) => r && r.body && r.body.type === 'grant');
    if (!grant) record('H5-double-consume-invalidates', 'SKIP', `no grant; recs=${recs.length}`);
    else {
      const extra = core.makeApprovalRecord(recs, {
        type: 'consume', recordId: grant.recordId, candidateId: exp.id,
        digest: core.candidateDigest(exp), consumedAt: Date.now(),
      }).record;
      const led2 = core.createMemoryApprovalLedger({ id: 'dup', records: [...recs, extra], getSession: (s) => reg.get(s) });
      const v2 = core.validHumanApproval(exp, led2);
      record('H5-double-consume-invalidates', v2.ok === false ? 'PASS' : 'FAIL',
        `ok=${v2.ok} reason=${v2.reason} recs=${recs.length}->${recs.length + 1}`);
    }
  }
}

console.log('');
const c = {};
for (const r of results) c[r.verdict] = (c[r.verdict] ?? 0) + 1;
console.log('  汇总: ' + JSON.stringify(c));
fs.writeFileSync(path.join(os.tmpdir(), '_rev-p4r2', 'rev-probe3-result.json'), JSON.stringify(results, null, 2), 'utf8');
