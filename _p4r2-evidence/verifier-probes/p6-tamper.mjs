// §6(b) 篡改矩阵：对 _human-approvals.jsonl 做 6 类攻击，每类在【全新进程】里判定
// 用法：node p6-tamper.mjs setup            造一份合法批准状态（base）
//       node p6-tamper.mjs apply <case>    复制 base → case 目录并施加篡改
//       node p6-tamper.mjs judge <case>    全新进程读取被篡改目录，判定 canPublish
// 关键：smart 类篡改会**重算链**（链无密钥 → 攻击者也能算），以证明链保护强度
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadCore, loadShell, mkCtx, hostSessionStore, say } from './_vfy-lib.mjs';

const BASE = path.join(os.tmpdir(), '_vfy-p6t-base');
const CASES = path.join(os.tmpdir(), '_vfy-p6t-cases');
const SID = 'vfy-sess-T';
const REF = 'vfyrefTAMPER0001';
const FACT = '_vfy-host-fact.json';
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const core = await loadCore();
const LEDGER = (d) => path.join(d, '_human-approvals.jsonl');

const cmd = process.argv[2] || 'setup';
const arg = process.argv[3];

/** 重算整本台账的链（攻击者同样能做：无密钥、纯公开字段）
 *  记录形状必须与实现完全一致，含 recordId = 'hap-' + chain 前 16 hex。 */
function rechain(records) {
  let prev = '';
  return records.map((r, i) => {
    const seq = i + 1;
    const chain = createHash('sha256').update(JSON.stringify(['learn-human-approval-ledger/v1', seq, prev, r.body])).digest('hex');
    const out = { seq, prev, body: r.body, chain, recordId: `hap-${chain.slice(0, 16)}` };
    prev = chain;
    return out;
  });
}
function writeLedger(dir, records) {
  fs.writeFileSync(LEDGER(dir), records.map(core.serializeApprovalRecord).join(''), 'utf8');
}
function readLedgerRaw(dir) {
  return core.parseApprovalLedgerText(fs.readFileSync(LEDGER(dir), 'utf8')).records;
}
function readStore(dir) { return JSON.parse(fs.readFileSync(path.join(dir, `${SID}.json`), 'utf8')); }
function writeStore(dir, store) { fs.writeFileSync(path.join(dir, `${SID}.json`), JSON.stringify(store), 'utf8'); }

if (cmd === 'setup') {
  fs.mkdirSync(BASE, { recursive: true });
  for (const f of fs.readdirSync(BASE)) fs.rmSync(path.join(BASE, f), { recursive: true, force: true });
  const proof = path.join(BASE, 'proof.txt');
  fs.writeFileSync(proof, 'vfy tamper probe artifact\n', 'utf8');
  const made = core.makeExperience({ title: 'VFY tamper target', body: 'legal body', sourceEventSeqs: [1, 2], originSessionId: SID, createdAt: Date.now() });
  let store = core.emptyStore(); store.sessionId = SID;
  const pr = core.propose(store, made.value); store = pr.value;
  const vr = core.applyVerification(store, pr.experience.id, { class: 'file_hash', path: proof, sha256: sha(proof) }, { fileHash: sha }, Date.now());
  store = vr.value;
  const digest = core.candidateDigest(vr.experience);
  const REASON = `learn_review: publish candidate digest=${digest}`;
  const host = hostSessionStore(SID, REF, REASON);
  const ledger = core.createMemoryApprovalLedger({ id: 'tamper-base', getSession: host.sessions.get });
  const ap = core.approve(store, vr.experience.id, { session: host.session, approvalRef: REF, evidence: 'legal', ledger, at: Date.now() });
  if (!ap.ok) { say(`setup FAILED: ${ap.error}`); process.exit(1); }
  fs.writeFileSync(path.join(BASE, FACT), JSON.stringify({ sid: SID, ref: REF, reason: REASON }), 'utf8');
  writeStore(BASE, ap.value);
  writeLedger(BASE, ledger.records());
  say(`setup ok: records=${ledger.records().length} expId=${vr.experience.id} digest=${digest} recordId=${ap.experience.approval.ledgerRecordId}`);
} else if (cmd === 'apply') {
  const dir = path.join(CASES, arg);
  fs.mkdirSync(CASES, { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(BASE, dir, { recursive: true });
  const recs = readLedgerRaw(dir);
  const store = readStore(dir);
  const exp = store.experiences[0];
  const att = exp.approval;
  let note = '';
  switch (arg) {
    case 'replay_drop_consume': // 只留 grant（去掉 consume），重算链
      writeLedger(dir, rechain(recs.filter((r) => r.body.type !== 'consume'))); note = 'dropped consume, rechained'; break;
    case 'insert_dup_grant': // 插入重复 grant
      writeLedger(dir, rechain([recs[0], recs[0], ...recs.slice(1)])); note = 'duplicated grant inserted, rechained'; break;
    case 'edit_digest_ledger_only': { // 只改台账里的 digest（attestation 不变），重算链
      const r = structuredClone(recs); r[0].body.digest = 'f'.repeat(64);
      writeLedger(dir, rechain(r)); note = 'ledger digest -> f*64 (attestation untouched)'; break; }
    case 'edit_digest_both': { // 台账 + attestation 同时改（完整一致性伪造）
      const r = structuredClone(recs); r[0].body.digest = 'f'.repeat(64);
      writeLedger(dir, rechain(r));
      store.experiences[0].approval = { ...att, candidateDigest: 'f'.repeat(64) };
      writeStore(dir, store); note = 'ledger+attestation digest -> f*64'; break; }
    case 'edit_approvedAt': { // 改 approvedAt（提前到 1970），重算链
      const r = structuredClone(recs); r[0].body.approvedAt = 0;
      writeLedger(dir, rechain(r)); note = 'approvedAt -> 0'; break; }
    case 'delete_grant_keep_consume': { // 删掉 grant 记录，只留 consume，重算链
      writeLedger(dir, rechain(recs.filter((r) => r.body.type !== 'grant'))); note = 'grant deleted, consume kept'; break; }
    case 'delete_file': { fs.rmSync(LEDGER(dir)); note = 'ledger file deleted'; break; }
    case 'ref_swap': { // 把 attestation 的 approvalRef 指向另一本台账里的 ref（本用例内改 ref）
      store.experiences[0].approval = { ...att, ref: 'otherref000000001' };
      writeStore(dir, store); note = 'attestation ref swapped'; break; }
    case 'forge_full': { // 决定性：改内容 + 伪造 grant/consume + 重写 attestation（两文件均在 agent 可写边界内）
      store.experiences[0] = { ...exp, body: `${exp.body} [ATTACKER-INSERTED CONTENT]` };
      const digest2 = core.candidateDigest(store.experiences[0]);
      const FORGED_REF = 'forgedrefNOHUMAN01';
      const AT = Date.now();
      const g = core.makeApprovalRecord([], {
        type: 'grant', schemaVersion: 'learn-human-approval-ledger/v1', candidateId: exp.id, digest: digest2, approvedAt: AT,
        trustedSource: 'host-approval-seam', hostActor: 'host-approved-human', approvalRef: FORGED_REF, hostSessionId: SID,
      });
      const c = core.makeApprovalRecord([g.record], {
        type: 'consume', schemaVersion: 'learn-human-approval-ledger/v1', recordId: g.record.recordId, candidateId: exp.id, digest: digest2, consumedAt: AT,
      });
      writeLedger(dir, [g.record, c.record]);
      store.experiences[0] = {
        ...store.experiences[0], approvedAt: AT, approvedBy: 'host-approved-human',
        approval: { ...att, candidateDigest: digest2, ref: FORGED_REF, ledgerRecordId: g.record.recordId, approvedAt: AT },
      };
      writeStore(dir, store);
      note = `content changed + forged grant/consume + attestation rewritten (newDigest=${digest2})`;
      break; }
    default: say(`unknown case ${arg}`); process.exit(1);
  }
  // 落盘后自检：链条是否仍可被"验证方"认可
  const after = core.parseApprovalLedgerText(fs.readFileSync(LEDGER(dir), 'utf8'));
  say(`[${arg}] applied: ${note} | lines=${after.ok ? after.records.length : 'PARSE_FAIL'} | chain=${after.ok ? JSON.stringify(core.verifyApprovalLedgerChain(after.records)) : 'n/a'}`);
} else if (cmd === 'judge') {
  const dir = path.join(CASES, arg);
  const { apply } = await loadShell();
  const fact = JSON.parse(fs.readFileSync(path.join(dir, FACT), 'utf8'));
  const host = hostSessionStore(fact.sid, fact.ref, fact.reason);
  const { ctx, logs } = mkCtx({ sessions: host.sessions });
  let applied = true;
  try { await apply(ctx, { stateDir: dir }); } catch { applied = false; }
  const store = readStore(dir);
  const exp = store.experiences[0];
  const raw = fs.existsSync(LEDGER(dir)) ? core.parseApprovalLedgerText(fs.readFileSync(LEDGER(dir), 'utf8')) : { ok: false, records: [], reason: 'missing' };
  const v = core.validHumanApproval(exp);
  const c = core.canPublish(exp);
  const g = core.emptyGlobalStore();
  const pub = c.ok ? core.publishToGlobal(g, exp, { at: Date.now(), ledger: core.attachedApprovalLedgers()[0] ?? null }) : { ok: false, error: 'skipped(canPublish denied)' };
  say(`[${arg}] JUDGE shell=${applied} ledger_parse=${raw.ok}(${raw.records.length}行) chain_ok=${raw.ok ? core.verifyApprovalLedgerChain(raw.records).ok : false}`);
  say(`[${arg}] validHumanApproval=${JSON.stringify(v)}`);
  say(`[${arg}] canPublish=${JSON.stringify(c)} publishToGlobal=${JSON.stringify(pub.ok ?? pub.error)}`);
  say(`[${arg}] VERDICT=${(v.ok && c.ok) ? 'APPROVAL FORGED ACCEPTED (VULNERABLE)' : 'DENIED (fail-closed)'}`);
}
