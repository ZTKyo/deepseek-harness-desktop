// §8 A–F 生命周期实测（独立只读验证者自建探针）
// 用法：node p8-lifecycle.mjs 1   （phase1：造合法批准 + 落盘）
//       node p8-lifecycle.mjs 2   （phase2：全新进程重启后判定）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadCore, loadShell, mkCtx, hostSessionStore, say } from './_vfy-lib.mjs';

const phase = process.argv[2] || '1';
const STATE = process.env.VFY_STATE || path.join(os.tmpdir(), '_vfy-p8-state');
const SID = 'vfy-sess-A';
const REF = 'vfyref0123456789';
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const out = (k, v) => say(`[${phase}] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

const core = await loadCore();

if (phase === '1') {
  fs.mkdirSync(STATE, { recursive: true });
  const proofFile = path.join(STATE, 'proof-artifact.txt');
  fs.writeFileSync(proofFile, 'vfy probe artifact v1\n', 'utf8');

  const made = core.makeExperience({
    title: 'VFY probe experience', body: 'probe body for lifecycle measurement',
    sourceEventSeqs: [101, 102], originSessionId: SID, createdAt: Date.now(),
  });
  let store = core.emptyStore();
  store.sessionId = SID;
  const pr = core.propose(store, made.value);
  store = pr.value;
  out('experience', { id: pr.experience.id, state: pr.experience.state });

  const vr = core.applyVerification(store, pr.experience.id,
    { class: 'file_hash', path: proofFile, sha256: sha(proofFile) }, { fileHash: sha }, Date.now());
  out('applyVerification', { ok: vr.ok, error: vr.error ?? null, status: vr.experience?.verification?.status });
  store = vr.value;
  let expV = vr.experience;

  const digest = core.candidateDigest(expV);
  out('candidateDigest', digest);
  out('canPublish_BEFORE_approval', core.canPublish(expV));

  const reason = `learn_review: publish candidate digest=${digest}`;
  const host = hostSessionStore(SID, REF, reason);
  const sess = host.session;
  const ledger = core.createMemoryApprovalLedger({ id: 'vfy-file-ledger', getSession: host.sessions.get });
  const ap = core.approve(store, expV.id, {
    session: sess, approvalRef: REF, evidence: 'vfy probe: legal host-shaped approval', ledger, at: Date.now(),
  });
  out('approve', { ok: ap.ok, error: ap.error ?? null, state: ap.experience?.state ?? null, att: ap.experience?.approval ?? null });
  if (ap.ok) { store = ap.value; expV = ap.experience; }
  out('canPublish_after_approval', core.canPublish(expV));

  const recs = ledger.records();
  fs.writeFileSync(path.join(STATE, '_vfy-host-fact.json'), JSON.stringify({ sid: SID, ref: REF, reason }), 'utf8');
  fs.writeFileSync(path.join(STATE, '_human-approvals.jsonl'), recs.map(core.serializeApprovalRecord).join(''), 'utf8');
  fs.writeFileSync(path.join(STATE, `${SID}.json`), JSON.stringify(store), 'utf8');
  out('persisted', { ledgerRecords: recs.length, files: fs.readdirSync(STATE) });
} else {
  const { apply } = await loadShell();
  const fact = JSON.parse(fs.readFileSync(path.join(STATE, '_vfy-host-fact.json'), 'utf8'));
  const host = hostSessionStore(fact.sid, fact.ref, fact.reason);
  const { ctx, logs } = mkCtx({ sessions: host.sessions });
  const api = await apply(ctx, { stateDir: STATE });
  out('shell_applied', { ok: !!api, ledgerLog: logs.filter((l) => /ledger|approval/i.test(l)).slice(0, 2) });
  const parsed = core.parseApprovalLedgerText(fs.readFileSync(path.join(STATE, '_human-approvals.jsonl'), 'utf8'));
  out('ledger_reparsed', { ok: parsed.ok, records: parsed.records.length, chain: core.verifyApprovalLedgerChain(parsed.records) });
  out('attached_ledgers', core.attachedApprovalLedgers());

  const store = JSON.parse(fs.readFileSync(path.join(STATE, `${SID}.json`), 'utf8'));
  const exp = store.experiences[0];
  out('exp_after_restart', { state: exp.state, verification: exp.verification?.status, att: exp.approval?.ledgerRecordId, ref: exp.approval?.ref, session: exp.approval?.hostSessionId ?? null });

  out('A_C_canPublish_after_restart', core.canPublish(exp));
  out('A_validHumanApproval', core.validHumanApproval(exp));
  // B：真正的跨会话——在"会话 A"批准并发布到全局库，再从"会话 B"召回
  const memLedger = core.createMemoryApprovalLedger({ id: 'reparse', records: parsed.records, getSession: host.sessions.get });
  const pub = core.publishToGlobal(core.emptyGlobalStore(), exp, { at: Date.now(), ledger: memLedger });
  out('B_publishToGlobal_from_session_A', { ok: pub.ok, error: pub.error ?? pub.reason ?? null, id: pub.value?.experiences?.[0]?.id ?? pub.value?.id ?? null });
  const g = pub.value ?? core.emptyGlobalStore();
  const otherStore = core.emptyStore();
  otherStore.sessionId = 'vfy-sess-B-other';
  const rec = core.recall(otherStore, 'VFY probe', { global: g, env: core.environmentDescriptor ?? {}, now: Date.now(), ledger: memLedger });
  out('B_recall_from_session_B', { ok: rec.ok, items: (rec.items ?? []).map((i) => i.id ?? i.experience?.id), blocked: rec.blocked ?? null, considered: rec.considered ?? null });
  out('B_approval_is_session_scoped', { any_session_field_in_grant: Object.keys(parsed.records[0].body), no_session_context_needed: core.validHumanApproval(exp).ok });
  out('D_body_changed_canPublish', core.canPublish({ ...exp, body: exp.body + ' TAMPERED' }));
  out('D_title_changed_canPublish', core.canPublish({ ...exp, title: exp.title + ' X' }));

  // 与插件壳一致：`if (res.value) store = commit(...)` —— 失败路径同样落盘（learn.mjs L1515）
  let expE = exp;
  const bad = core.applyVerification(store, exp.id,
    { class: 'file_hash', path: path.join(STATE, 'proof-artifact.txt'), sha256: 'f'.repeat(64) }, { fileHash: sha }, Date.now());
  out('E_applyVerification_fail', { ok: bad.ok, error: bad.error ?? null, status: bad.experience?.verification?.status ?? bad.value?.experiences?.[0]?.verification?.status });
  if (bad.value) expE = bad.experience ?? bad.value.experiences[0];
  out('E_state', { state: expE.state, verification: expE.verification?.status });
  out('E_canPublish_after_invalidation', core.canPublish(expE));
  out('E_validHumanApproval_still_ok', core.validHumanApproval(expE));

  const storeE = bad.ok ? bad.value : store;
  const good = core.applyVerification(storeE, exp.id,
    { class: 'file_hash', path: path.join(STATE, 'proof-artifact.txt'), sha256: sha(path.join(STATE, 'proof-artifact.txt')) },
    { fileHash: sha }, Date.now());
  out('F_applyVerification_ok', { ok: good.ok, status: good.experience?.verification?.status });
  const expF = good.experience ?? expE;
  out('F_state_after_reverify', { state: expF.state, canPublish: core.canPublish(expF) });
}
