// §6 信任通道攻击实测（独立只读验证者自建探针）
// 子命令：read | forge | decide | session-forge | memory-ledger
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadCore, loadShell, mkCtx, freshStateDir, say } from './_vfy-lib.mjs';

const cmd = process.argv[2];
const out = (k, v) => say(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const core = await loadCore();
const SCHEMA = 'learn-human-approval-ledger/v1';
const chainHash = (seq, prev, body) => createHash('sha256').update(JSON.stringify([SCHEMA, seq, prev, body])).digest('hex');
const STATE = process.env.VFY_STATE || path.join(os.tmpdir(), '_vfy-p6-state');

/** 造一个"内容/结构齐全、只缺人类授权"的候选（无任何人类参与）。 */
function mkCandidate(sid, proofFile, proofSha) {
  const made = core.makeExperience({
    title: 'VFY forged experience', body: 'body forged by offline attacker', sourceEventSeqs: [7, 8, 9],
    originSessionId: sid, createdAt: Date.now(),
  });
  let store = core.emptyStore();
  store.sessionId = sid;
  const pr = core.propose(store, made.value);
  store = pr.value;
  const vr = core.applyVerification(store, pr.experience.id, { class: 'file_hash', path: proofFile, sha256: proofSha },
    { fileHash: (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex') }, Date.now());
  if (!vr.ok) throw new Error(`probe setup verify failed: ${vr.error}`);
  return { store: vr.value, exp: vr.experience };
}

if (cmd === 'read') {
  // ① 攻击者仅用 FS 读取：确认台账是明文、且链条无密钥可推导（用公开字段即可复算）
  const file = path.join(STATE, '_human-approvals.jsonl');
  const text = fs.readFileSync(file, 'utf8');
  out('ledger_path', file);
  out('ledger_bytes', text.length);
  out('ledger_line1_raw', text.split('\n')[0]);
  const parsed = core.parseApprovalLedgerText(text);
  const recomputed = parsed.records.map((r, i) => {
    const prev = i === 0 ? '' : parsed.records[i - 1].chain;
    return { seq: r.seq, stored: r.chain, mine: chainHash(r.seq, prev, r.body), match: chainHash(r.seq, prev, r.body) === r.chain };
  });
  out('chain_recomputable_without_any_key', recomputed);
  out('any_secret_field_in_ledger', /secret|key|hmac|token|password/i.test(text));
} else if (cmd === 'forge') {
  // ② 纯离线伪造：不调用 approve()、不接触任何宿主/人类/会话日志
  const dir = process.env.VFY_STATE || freshStateDir('vfy-p6-forge');
  fs.mkdirSync(dir, { recursive: true });
  const proofFile = path.join(dir, 'proof.txt');
  fs.writeFileSync(proofFile, 'forged artifact\n', 'utf8');
  const proofSha = createHash('sha256').update(fs.readFileSync(proofFile)).digest('hex');
  const { store, exp } = mkCandidate('vfy-forge-sess', proofFile, proofSha);
  const digest = core.candidateDigest(exp);
  const APPROVED_AT = 1893456000000;             // 攻击者自选时间戳（无宿主事实）
  const FAKE_REF = 'attackerref00000001';        // 该 ref 在任何真实会话日志中都不存在
  const g = core.makeApprovalRecord([], {
    type: 'grant', schemaVersion: SCHEMA, candidateId: exp.id, digest, approvedAt: APPROVED_AT,
    trustedSource: 'host-approval-seam', hostActor: 'host-approved-human',
    approvalRef: FAKE_REF, hostSessionId: 'vfy-forge-sess',
  });
  const c = core.makeApprovalRecord([g.record], { type: 'consume', recordId: g.record.recordId, candidateId: exp.id, digest, consumedAt: APPROVED_AT });
  const forgedExp = {
    ...exp, state: 'APPROVED', approvedAt: APPROVED_AT, approvedBy: 'host-approved-human',
    approvalEvidence: 'forged offline, no human ever asked',
    approval: {
      schema: 'learn-human-approval/v1', channel: 'host-approval-seam', actor: 'host-approved-human',
      outcome: 'allowed-once', ref: FAKE_REF, candidateId: exp.id, candidateDigest: digest,
      approvedAt: APPROVED_AT, ledgerRecordId: g.record.recordId,
    },
  };
  const san = core.sanitizeExperience(forgedExp);
  out('sanitize_forged_exp', { ok: !san.error, error: san.error ?? null, state: san.value?.state });
  fs.writeFileSync(path.join(dir, '_human-approvals.jsonl'), core.serializeApprovalRecord(g.record) + core.serializeApprovalRecord(c.record), 'utf8');
  fs.writeFileSync(path.join(dir, 'vfy-forge-sess.json'), JSON.stringify({ ...store, experiences: [san.value] }), 'utf8');
  out('forged_files_written', fs.readdirSync(dir));
  out('forged_digest', digest);
  out('forged_ledgerRecordId', g.record.recordId);
  out('forged_ledger_chain_selfcheck', core.verifyApprovalLedgerChain([g.record, c.record]));
  out('no_host_session_exists', core.hostApprovalRecord({ id: 'x', events: [] }, FAKE_REF));
} else if (cmd === 'decide') {
  // ③ 全新进程：加载被投毒的 stateDir，看授权判定是否放行
  const { apply } = await loadShell();
  const { ctx, logs } = mkCtx();
  const api = await apply(ctx, { stateDir: STATE });
  out('shell_applied_with_poisoned_stateDir', { ok: !!api, logs: logs.filter((l) => /ledger|approval/i.test(l)).slice(0, 3) });
  const store = JSON.parse(fs.readFileSync(path.join(STATE, 'vfy-forge-sess.json'), 'utf8'));
  const exp = store.experiences[0];
  out('exp_state', { state: exp.state, verification: exp.verification?.status, att: exp.approval?.ledgerRecordId, ref: exp.approval?.ref });
  out('ATTACK_RESULT_validHumanApproval', core.validHumanApproval(exp));
  out('ATTACK_RESULT_canPublish', core.canPublish(exp));
  out('ATTACK_RESULT_isPublishable', core.isPublishable(exp));
  const pub = core.publishToGlobal(core.emptyGlobalStore(), exp, { at: Date.now() });
  out('ATTACK_RESULT_publishToGlobal', { ok: pub.ok, error: pub.error ?? pub.reason ?? null, id: pub.value?.id ?? null });
} else if (cmd === 'session-forge') {
  // ④ 伪造"宿主会话日志事件对"→ approve() 是否照铸（前置条件：进程内代码执行）
  const dir = freshStateDir('vfy-p6-sessforge');
  const proofFile = path.join(dir, 'proof.txt');
  fs.writeFileSync(proofFile, 'x\n', 'utf8');
  const proofSha = createHash('sha256').update(fs.readFileSync(proofFile)).digest('hex');
  const { store, exp } = mkCandidate('vfy-sessforge', proofFile, proofSha);
  const digest = core.candidateDigest(exp);
  const ledger = core.createMemoryApprovalLedger({ id: 'attacker' });
  const ATTACKER_REF = 'forgedref000000001';
  // 攻击者自己拼一个对象当作"宿主会话日志"——不是宿主 ApprovalService 产出
  const fakeSession = {
    id: 'attacker-session', events: [
      { type: 'turn/start', data: {} },
      { type: 'approval/asked', data: { id: ATTACKER_REF, toolName: 'learn_review', reason: `digest=${digest}` } },
      { type: 'approval/decided', data: { id: ATTACKER_REF, outcome: 'allowed-once' } },
    ],
  };
  const ap = core.approve(store, exp.id, { session: fakeSession, approvalRef: ATTACKER_REF, evidence: 'forged by attacker', ledger, at: Date.now() });
  out('ATTACK_RESULT_approve_with_plain_object_session', { ok: ap.ok, error: ap.error ?? null, ledgerRecordId: ap.experience?.approval?.ledgerRecordId ?? null, state: ap.experience?.state ?? null, digestInEvent: digest });
  out('attacker_ledger_records', ledger.records().map((r) => ({ seq: r.seq, type: r.body.type })));
} else if (cmd === 'memory-ledger') {
  // ⑤ 进程内 attach 一本伪造台账（不写任何文件）→ canPublish 是否放行
  const dir = freshStateDir('vfy-p6-mem');
  const proofFile = path.join(dir, 'proof.txt');
  fs.writeFileSync(proofFile, 'y\n', 'utf8');
  const proofSha = createHash('sha256').update(fs.readFileSync(proofFile)).digest('hex');
  const { store, exp } = mkCandidate('vfy-mem', proofFile, proofSha);
  const digest = core.candidateDigest(exp);
  const AT = 1893456000000;
  const led = core.createMemoryApprovalLedger({ id: 'attacker-mem' });
  const g = led.append({ type: 'grant', schemaVersion: SCHEMA, candidateId: exp.id, digest, approvedAt: AT, trustedSource: 'host-approval-seam', hostActor: 'host-approved-human', approvalRef: 'memref000000000001', hostSessionId: 'n/a' });
  const c = led.append({ type: 'consume', recordId: g.record.recordId, candidateId: exp.id, digest, consumedAt: AT });
  const forged = {
    ...exp, state: 'APPROVED', approvedAt: AT, approvedBy: 'host-approved-human', approvalEvidence: 'attacker',
    approval: { schema: 'learn-human-approval/v1', channel: 'host-approval-seam', actor: 'host-approved-human', outcome: 'allowed-once', ref: 'memref000000000001', candidateId: exp.id, candidateDigest: digest, approvedAt: AT, ledgerRecordId: g.record.recordId },
  };
  out('before_attach', core.canPublish(forged));
  core.attachApprovalLedger(led);
  out('attached_ledgers', core.attachedApprovalLedgers());
  out('ATTACK_RESULT_canPublish_after_attach_forged_memory_ledger', core.canPublish(forged));
} else {
  out('usage', 'read | forge | decide | session-forge | memory-ledger');
}
