// rev-probe.mjs —— 独立审查探针（不属于仓库；写在 %TEMP%，只读导入仓库模块）
//
// 目的：不复用仓库 tests/learn/_real-session-harness.mjs 的夹具（避免"用交付方自己的
//   夹具证明交付方"），自己搭伪 ctx + 自己造合成会话，从**插件壳工具层**与**核心纯函数层**
//   两条路径独立复现审批边界。真实宿主 ApprovalService 按生产同口径解析（不用自造替身）。
//
// 纪律：不写仓库、不碰 ~/.dsh、不碰运行中服务；全部状态落在 %TEMP% 的 mkdtemp。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const REPO = 'C:\\Users\\Administrator\\Desktop\\sdeepseek harness\\_p4r2';
const PLUGIN_URL = pathToFileURL(path.join(REPO, 'plugins', 'learn.mjs')).href;
const CORE_URL = pathToFileURL(path.join(REPO, 'plugins', 'learn-core.mjs')).href;
const core = await import(CORE_URL);

let gen = 0;
const results = [];
const log = (s) => console.log(s);

function record(id, verdict, detail) {
  results.push({ id, verdict, detail });
  console.log(`  [${verdict}] ${id} :: ${detail}`);
}

// ─── 真实宿主 ApprovalService 解析（与生产/apiproxy 同一份包，不自造替身）──────
export function resolveHarnessPackage(rel) {
  const cands = [];
  try { cands.push(createRequire(import.meta.url).resolve(rel)); } catch {}
  const appdata = process.env.APPDATA;
  if (appdata) {
    cands.push(path.join(appdata, 'npm', 'node_modules', '@deepseek-ai', 'dsh',
      'node_modules', '@deepseek-ai', ...rel.split('/')) + '/lib/index.js');
  }
  for (const c of cands) { try { if (fs.existsSync(c)) return pathToFileURL(c).href; } catch {} }
  return null;
}

/** 起真实宿主批准通道。answerer 省略 ⇒ 不注册 answerer（= 无人类可答 ⇒ fail-closed）。 */
async function mkHostApproval({ policy = 'ask', answerer } = {}) {
  const cordisUrl = resolveHarnessPackage('cordis');
  const approvalUrl = resolveHarnessPackage('dsh-user-approval');
  if (!cordisUrl || !approvalUrl) return { svc: null, available: false, seen: [] };
  const { Context } = await import(cordisUrl);
  const { ApprovalService } = await import(approvalUrl);
  const app = new Context();
  app.plugin(ApprovalService, { policy });
  await new Promise((r) => setTimeout(r, 60));
  const seen = [];
  if (answerer !== undefined) {
    app.on('approval/request', (req, next) => {
      seen.push({ toolName: req.toolName, reason: req.reason, callId: req.callId ?? null });
      if (answerer === null) return next();
      return typeof answerer === 'function' ? answerer(req, next) : answerer;
    });
  }
  const svc = app.get('approval');
  return { svc, available: typeof svc?.request === 'function', seen, app };
}

// ─── 伪 ctx（只给插件真正用到的能力）─────────────────────────────────────────
function mkCtx({ approval, sessions }) {
  const hooks = new Map();
  const logs = [];
  const ctx = {
    logger: { info: (m) => logs.push('I ' + m), warn: (m) => logs.push('W ' + m) },
    on: (ev, fn) => { if (!hooks.has(ev)) hooks.set(ev, []); hooks.get(ev).push(fn); },
    tools: { register: () => { throw new Error('probe: ctx.tools.register must not be used'); } },
    get: (n) => (n === 'approval' ? approval : undefined),
    sessions,
  };
  return { ctx, hooks, logs };
}

async function newInstance(tag, { approvalSvc, sessionsSvc, config } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rev-${tag}-`));
  const host = mkCtx({ approval: approvalSvc, sessions: sessionsSvc });
  const mod = await import(`${PLUGIN_URL}?rev=${++gen}`);
  const api = mod.apply(host.ctx, {
    stateDir: dir,
    globalStorePath: path.join(dir, '_global-verified.json'),
    autoPropose: false,
    ...(config ?? {}),
  });
  return { api, ctx: host.ctx, hooks: host.hooks, logs: host.logs, dir };
}

/** 合成会话（不读 ~/.dsh/sessions）。events 由调用方给，append 模拟"可被写"的会话。 */
function mkSession(sid, seed = []) {
  const events = [...seed];
  return {
    id: sid,
    events,
    surface: { nodes: [] },
    append(type, data) { const e = { type, data }; events.push(e); return e; },
  };
}

/** 只读宿主会话服务替身：从注册表按 sid 取。 */
function mkSessionsSvc(registry) {
  return { get: (sid) => (sid && registry.has(sid) ? registry.get(sid) : null) };
}

const EXEC = (session, callId) => ({ agent: { session }, callId });

async function probe(tag, fn) {
  try { await fn(); } catch (e) { record(tag, 'PROBE-ERROR', String(e?.stack ?? e)); }
}

const EVIDENCE = ['manual review:', 'the human was asked', 'and allowed once'].join(' ');
const approveArgs = (id) => ({ experienceId: id, action: 'approve', evidence: EVIDENCE });

// ═══════════════════════════════════════════════════════════════════════════
log('=== 独立审查探针：审批边界（Point 1 / Point 2）===');
const hostApprovalUrl = resolveHarnessPackage('dsh-user-approval');
log('  真实宿主 ApprovalService 可解析 = ' + (hostApprovalUrl ? 'YES' : 'NO'));
log('');

// ── P0：基线正例 —— 真人类批准必须放行（否则"焊死闸门"也能假通过）──────────
await probe('P0-positive-control', async () => {
  const ha = await mkHostApproval({ answerer: 'allowed-once' });
  if (!ha.available) { record('P0-positive-control', 'SKIP', '无法解析 dsh-user-approval，正例不可建立'); return; }
  const SID = 'rev-p0';
  const sess = mkSession(SID, [{ type: 'turn/start', data: {} }]);
  const reg = new Map([[SID, sess]]);
  const inst = await newInstance('p0', { approvalSvc: ha.svc, sessionsSvc: mkSessionsSvc(reg) });
  const prop = await inst.api.invokeTool('learn_propose',
    { title: 'rev lesson p0', body: 'body for positive control', sourceEventSeqs: [1, 2, 3] }, EXEC(sess, 'c-p0'));
  const rev = await inst.api.invokeTool('learn_review', approveArgs(prop.experienceId), EXEC(sess, 'c-p0b'));
  const st = inst.api.getStore(SID).experiences.find((e) => e.id === prop.experienceId);
  const ok = rev.ok && st.state === 'APPROVED' && rev.verificationStatus === 'VERIFIED';
  record('P0-positive-control', ok ? 'PASS' : 'FAIL',
    `state=${st.state} pub=${rev.publication} vstatus=${rev.verificationStatus}`);
});

// ── P1：无宿主 approval 服务 ⇒ 工具层必须拒（0 人类铸 APPROVED）────────────
await probe('P1-no-host-service', async () => {
  const SID = 'rev-p1';
  const sess = mkSession(SID, [{ type: 'turn/start', data: {} }]);
  const reg = new Map([[SID, sess]]);
  const inst = await newInstance('p1', { approvalSvc: undefined, sessionsSvc: mkSessionsSvc(reg) });
  const prop = await inst.api.invokeTool('learn_propose',
    { title: 'rev lesson p1', body: 'body p1', sourceEventSeqs: [1, 2, 3] }, EXEC(sess, 'c-p1'));
  let err = null;
  try { await inst.api.invokeTool('learn_review', approveArgs(prop.experienceId), EXEC(sess, 'c-p1b')); }
  catch (e) { err = String(e.message); }
  const st = inst.api.getStore(SID).experiences.find((e) => e.id === prop.experienceId);
  const tel = inst.api.summaryFor(SID);
  const g = inst.api.globalStore();
  const ledgerExists = fs.existsSync(path.join(inst.dir, '_human-approvals.jsonl'));
  const ok = err !== null && st.state !== 'APPROVED' && g.experiences.length === 0 && !ledgerExists;
  record('P1-no-host-service', ok ? 'PASS' : 'FAIL',
    `err="${err}" state=${st.state} globalN=${g.experiences.length} ledgerWritten=${ledgerExists} tel=${JSON.stringify(tel?.kinds ?? tel)}`);
});

// ── P2：agent 自造"宿主事件对"（自己会话里塞 asked/decided）+ 无服务 ⇒ 拒 ────
await probe('P2-self-planted-events-no-service', async () => {
  const SID = 'rev-p2';
  const sess = mkSession(SID, [{ type: 'turn/start', data: {} }]);
  const reg = new Map([[SID, sess]]);
  const inst = await newInstance('p2', { approvalSvc: undefined, sessionsSvc: mkSessionsSvc(reg) });
  const prop = await inst.api.invokeTool('learn_propose',
    { title: 'rev lesson p2', body: 'body p2', sourceEventSeqs: [1, 2, 3] }, EXEC(sess, 'c-p2'));
  const exp = inst.api.getStore(SID).experiences.find((e) => e.id === prop.experienceId);
  // 攻击者"自己写宿主日志"：asked(带真实内容摘要) + decided(allowed-once)
  const dg = core.candidateDigest(exp);
  const REF = 'rev-planted-ref-0001';
  sess.append('approval/asked', { id: REF, toolName: 'learn_review', callId: 'c-p2b',
    reason: `learn_review: approve experience ${exp.id} digest=${dg}` });
  sess.append('approval/decided', { id: REF, outcome: 'allowed-once' });
  let err = null;
  try { await inst.api.invokeTool('learn_review', approveArgs(exp.id), EXEC(sess, 'c-p2b')); }
  catch (e) { err = String(e.message); }
  const st = inst.api.getStore(SID).experiences.find((e) => e.id === exp.id);
  const ok = err !== null && st.state !== 'APPROVED';
  record('P2-self-planted-events-no-service', ok ? 'PASS' : 'FAIL',
    `err="${err}" state=${st.state}`);
});

// ── P3：自造事件对 + 真服务但人类拒绝/无 answerer ⇒ 拒 ──────────────────────
await probe('P3-planted-events-but-host-says-no', async () => {
  const ha = await mkHostApproval({ answerer: null });   // 服务在岗，但无人可答
  if (!ha.available) { record('P3-planted-events-but-host-says-no', 'SKIP', '无 dsh-user-approval'); return; }
  const SID = 'rev-p3';
  const sess = mkSession(SID, [{ type: 'turn/start', data: {} }]);
  const reg = new Map([[SID, sess]]);
  const inst = await newInstance('p3', { approvalSvc: ha.svc, sessionsSvc: mkSessionsSvc(reg) });
  const prop = await inst.api.invokeTool('learn_propose',
    { title: 'rev lesson p3', body: 'body p3', sourceEventSeqs: [1, 2, 3] }, EXEC(sess, 'c-p3'));
  const exp = inst.api.getStore(SID).experiences.find((e) => e.id === prop.experienceId);
  const dg = core.candidateDigest(exp);
  const REF = 'rev-planted-ref-0002';
  sess.append('approval/asked', { id: REF, toolName: 'learn_review', callId: 'c-p3b',
    reason: `learn_review: approve experience ${exp.id} digest=${dg}` });
  sess.append('approval/decided', { id: REF, outcome: 'allowed-once' });
  let err = null;
  try { await inst.api.invokeTool('learn_review', approveArgs(exp.id), EXEC(sess, 'c-p3b')); }
  catch (e) { err = String(e.message); }
  const st = inst.api.getStore(SID).experiences.find((e) => e.id === exp.id);
  const ok = err !== null && st.state !== 'APPROVED';
  record('P3-planted-events-but-host-says-no', ok ? 'PASS' : 'FAIL',
    `err="${err}" state=${st.state}`);
});

// ── P4：手写自洽台账（grant+consume 链自洽）+ 宿主日志无此批准 ⇒ 拒 ─────────
await probe('P4-handwritten-ledger-no-host-log', async () => {
  const SID = 'rev-p4';
  const sessEmpty = mkSession(SID, [{ type: 'turn/start', data: {} }]);
  const reg = new Map([[SID, sessEmpty]]);
  // 先在"干净"实例里拿到一条真实形状的 PROPOSED 经验
  const inst = await newInstance('p4', { approvalSvc: undefined, sessionsSvc: mkSessionsSvc(reg) });
  const prop = await inst.api.invokeTool('learn_propose',
    { title: 'rev lesson p4', body: 'body p4', sourceEventSeqs: [1, 2, 3] }, EXEC(sessEmpty, 'c-p4'));
  const exp = inst.api.getStore(SID).experiences.find((e) => e.id === prop.experienceId);

  // 攻击者：用 core 自己的纯函数造一本链完全自洽的台账
  const records = [];
  const g = core.makeApprovalRecord(records, {
    type: 'grant', schemaVersion: core.HUMAN_APPROVAL_LEDGER_SCHEMA,
    candidateId: exp.id, digest: core.candidateDigest(exp), approvedAt: 1, 
    trustedSource: core.HUMAN_APPROVAL_CHANNEL, hostActor: core.HUMAN_APPROVAL_ACTOR,
    approvalRef: 'rev-planted-ref-0003', hostSessionId: SID,
  });
  records.push(g.record);
  const c = core.makeApprovalRecord(records, {
    type: 'consume', recordId: g.record.recordId, candidateId: exp.id,
    digest: core.candidateDigest(exp), consumedAt: 1,
  });
  records.push(c.record);
  const chain = core.verifyApprovalLedgerChain(records);
  const dressed = {
    ...exp, state: 'APPROVED', approvedBy: core.HUMAN_APPROVAL_ACTOR,
    approvalEvidence: EVIDENCE, approvedAt: 1,
    verification: { status: 'VERIFIED', method: 'read', evidence: { note: 'x' } },
    lastVerifiedAt: 1,
    approval: {
      schema: core.HUMAN_APPROVAL_SCHEMA, channel: core.HUMAN_APPROVAL_CHANNEL,
      actor: core.HUMAN_APPROVAL_ACTOR, outcome: core.HUMAN_APPROVAL_GRANT,
      ref: 'rev-planted-ref-0003', candidateId: exp.id,
      candidateDigest: core.candidateDigest(exp), approvedAt: 1,
      ledgerRecordId: g.record.recordId,
    },
  };
  const hand = core.createMemoryApprovalLedger({ id: 'attack', records, getSession: (sid) => reg.get(sid) });
  const v = core.validHumanApproval(dressed, hand);
  const ok = chain.ok && v.ok === false;
  record('P4-handwritten-ledger-no-host-log', ok ? 'PASS' : 'FAIL',
    `chainOk=${chain.ok} verdict.ok=${v.ok} reason=${v.reason}`);
});

// ── P5：手写台账 + **同时**植入宿主日志事件对（攻击者有宿主存储写权限）─────
await probe('P5-handledger-plus-planted-hostlog-RESIDUAL', async () => {
  const SID = 'rev-p5';
  const sess = mkSession(SID, [{ type: 'turn/start', data: {} }]);
  const reg = new Map([[SID, sess]]);
  const inst = await newInstance('p5', { approvalSvc: undefined, sessionsSvc: mkSessionsSvc(reg) });
  const prop = await inst.api.invokeTool('learn_propose',
    { title: 'rev lesson p5', body: 'body p5', sourceEventSeqs: [1, 2, 3] }, EXEC(sess, 'c-p5'));
  const exp = inst.api.getStore(SID).experiences.find((e) => e.id === prop.experienceId);
  const dg = core.candidateDigest(exp);
  const REF = 'rev-planted-ref-0004';
  // 攻击者具备宿主会话存储写权限 ⇒ 植入四项齐备的事件对
  sess.append('approval/asked', { id: REF, toolName: 'learn_review',
    reason: `learn_review: approve experience ${exp.id} digest=${dg}` });
  sess.append('approval/decided', { id: REF, outcome: 'allowed-once' });
  const records = [];
  const g = core.makeApprovalRecord(records, {
    type: 'grant', schemaVersion: core.HUMAN_APPROVAL_LEDGER_SCHEMA, candidateId: exp.id,
    digest: dg, approvedAt: 1, trustedSource: core.HUMAN_APPROVAL_CHANNEL,
    hostActor: core.HUMAN_APPROVAL_ACTOR, approvalRef: REF, hostSessionId: SID,
  });
  records.push(g.record);
  records.push(core.makeApprovalRecord(records, {
    type: 'consume', recordId: g.record.recordId, candidateId: exp.id, digest: dg, consumedAt: 1,
  }).record);
  const hand = core.createMemoryApprovalLedger({ id: 'attack', records, getSession: (sid) => reg.get(sid) });
  const v = core.validHumanApproval({
    ...exp, state: 'APPROVED', approvedBy: core.HUMAN_APPROVAL_ACTOR, approvalEvidence: EVIDENCE,
    approvedAt: 1, verification: { status: 'VERIFIED', method: 'read', evidence: {} }, lastVerifiedAt: 1,
    approval: {
      schema: core.HUMAN_APPROVAL_SCHEMA, channel: core.HUMAN_APPROVAL_CHANNEL,
      actor: core.HUMAN_APPROVAL_ACTOR, outcome: core.HUMAN_APPROVAL_GRANT, ref: REF,
      candidateId: exp.id, candidateDigest: dg, approvedAt: 1, ledgerRecordId: g.record.recordId,
    },
  }, hand);
  record('P5-handledger-plus-planted-hostlog-RESIDUAL', v.ok ? 'ACCEPTED' : 'DENIED',
    `verdict.ok=${v.ok} reason=${v.reason}  （ok=true ⇒ 交付声明的"残余风险"复现成立）`);
});

// ── P6：台账改写/重复消费/替换 ref 的判定（纯函数层逐项）────────────────────
await probe('P6-ledger-integrity-matrix', async () => {
  const SID = 'rev-p6';
  const sess = mkSession(SID, [{ type: 'turn/start', data: {} }]);
  const reg = new Map([[SID, sess]]);
  const inst = await newInstance('p6', { approvalSvc: undefined, sessionsSvc: mkSessionsSvc(reg) });
  const prop = await inst.api.invokeTool('learn_propose',
    { title: 'rev lesson p6', body: 'body p6', sourceEventSeqs: [1, 2, 3] }, EXEC(sess, 'c-p6'));
  const exp = inst.api.getStore(SID).experiences.find((e) => e.id === prop.experienceId);
  const dg = core.candidateDigest(exp);
  const REF = 'rev-planted-ref-0005';
  sess.append('approval/asked', { id: REF, toolName: 'learn_review',
    reason: `learn_review: approve experience ${exp.id} digest=${dg}` });
  sess.append('approval/decided', { id: REF, outcome: 'allowed-once' });
  const base = [];
  const g = core.makeApprovalRecord(base, {
    type: 'grant', schemaVersion: core.HUMAN_APPROVAL_LEDGER_SCHEMA, candidateId: exp.id,
    digest: dg, approvedAt: 1, trustedSource: core.HUMAN_APPROVAL_CHANNEL,
    hostActor: core.HUMAN_APPROVAL_ACTOR, approvalRef: REF, hostSessionId: SID,
  });
  base.push(g.record);
  const con = core.makeApprovalRecord(base, {
    type: 'consume', recordId: g.record.recordId, candidateId: exp.id, digest: dg, consumedAt: 1 });
  base.push(con.record);
  const dress = (att) => ({
    ...exp, state: 'APPROVED', approvedBy: core.HUMAN_APPROVAL_ACTOR, approvalEvidence: EVIDENCE,
    approvedAt: 1, verification: { status: 'VERIFIED', method: 'read', evidence: {} }, lastVerifiedAt: 1,
    approval: {
      schema: core.HUMAN_APPROVAL_SCHEMA, channel: core.HUMAN_APPROVAL_CHANNEL,
      actor: core.HUMAN_APPROVAL_ACTOR, outcome: core.HUMAN_APPROVAL_GRANT, ref: REF,
      candidateId: exp.id, candidateDigest: dg, approvedAt: 1, ledgerRecordId: g.record.recordId,
      ...(att ?? {}),
    },
  });
  const mkLed = (recs) => core.createMemoryApprovalLedger({ id: 'm', records: recs, getSession: (s) => reg.get(s) });

  const rows = [];
  rows.push(['baseline(应 ok)', core.validHumanApproval(dress(), mkLed(base)).ok]);
  // ① 改动历史记录一个字节
  const tampered = JSON.parse(JSON.stringify(base));
  tampered[0].body.digest = 'b'.repeat(64);
  rows.push(['tampered-record', core.validHumanApproval(dress(), mkLed(tampered)).ok]);
  // ② 删除 consume（未消费 ⇒ 不构成授权）
  rows.push(['no-consume', core.validHumanApproval(dress(), mkLed([base[0]])).ok]);
  // ③ 重复 consume
  rows.push(['double-consume', core.validHumanApproval(dress(), mkLed(base.concat([con.record]))).ok]);
  // ④ 换 candidate（把批准对象换成另一条经验 id）
  rows.push(['other-candidate', core.validHumanApproval({ ...dress(), id: 'exp-other-0001' }, mkLed(base)).ok]);
  // ⑤ attestation 摘要被改（内容绑定失效）
  rows.push(['content-changed', core.validHumanApproval(dress({ candidateDigest: 'c'.repeat(64) }), mkLed(base)).ok]);
  // ⑥ 无复验器的台账（缺宿主事实锚 ⇒ 不可复验）
  rows.push(['no-verifier', core.validHumanApproval(dress(), core.createMemoryApprovalLedger({ id: 'x', records: base })).ok]);
  const base_ok = rows[0][1] === true && rows.slice(1).every((r) => r[1] === false);
  record('P6-ledger-integrity-matrix', base_ok ? 'PASS' : 'FAIL', JSON.stringify(rows));
});

// ── P7：审批粘性 —— APPROVED 经确定性重验证后必须仍 APPROVED ────────────────
await probe('P7-approval-stickiness', async () => {
  const ha = await mkHostApproval({ answerer: 'allowed-once' });
  if (!ha.available) { record('P7-approval-stickiness', 'SKIP', '无 dsh-user-approval'); return; }
  const SID = 'rev-p7';
  const sess = mkSession(SID, [{ type: 'turn/start', data: {} }]);
  const reg = new Map([[SID, sess]]);
  const inst = await newInstance('p7', { approvalSvc: ha.svc, sessionsSvc: mkSessionsSvc(reg) });
  const prop = await inst.api.invokeTool('learn_propose',
    { title: 'rev lesson p7', body: 'body p7', sourceEventSeqs: [1, 2, 3] }, EXEC(sess, 'c-p7'));
  const rev = await inst.api.invokeTool('learn_review', approveArgs(prop.experienceId), EXEC(sess, 'c-p7b'));
  const before = inst.api.getStore(SID).experiences.find((e) => e.id === prop.experienceId);
  // 事后再跑一次机器验证（应改写 lastVerifiedAt/evidence，但**不得**撤销 APPROVED）
  const again = core.applyVerification(inst.api.getStore(SID), prop.experienceId,
    before.verificationEvidence, {}, Date.now());
  const after = again.ok ? again.value.experiences.find((e) => e.id === prop.experienceId) : null;
  const stillApproved = after ? after.state === 'APPROVED' : false;
  const stillValid = after ? (() => { try { return core.approvalProvenance(after).ok; } catch { return false; } })() : false;
  record('P7-approval-stickiness', (rev.ok && stillApproved && stillValid) ? 'PASS' : 'FAIL',
    `before=${before.state} after=${after?.state} provenanceOk=${stillValid}`);
});

// ── P8：provenance 伪造 —— 提案时用会话里不存在的 sourceEventSeqs ───────────
await probe('P8-fabricated-provenance', async () => {
  const ha = await mkHostApproval({ answerer: 'allowed-once' });
  if (!ha.available) { record('P8-fabricated-provenance', 'SKIP', '无 dsh-user-approval'); return; }
  const SID = 'rev-p8';
  const sess = mkSession(SID, [{ type: 'turn/start', data: {} }]);
  const reg = new Map([[SID, sess]]);
  const inst = await newInstance('p8', { approvalSvc: ha.svc, sessionsSvc: mkSessionsSvc(reg) });
  let propErr = null; let prop = null;
  try {
    prop = await inst.api.invokeTool('learn_propose',
      { title: 'rev lesson p8', body: 'body p8', sourceEventSeqs: [900001, 900002] }, EXEC(sess, 'c-p8'));
  } catch (e) { propErr = String(e.message); }
  let rev = null;
  if (prop) rev = await inst.api.invokeTool('learn_review', approveArgs(prop.experienceId), EXEC(sess, 'c-p8b'));
  record('P8-fabricated-provenance', 'INFO',
    `proposeErr=${propErr} proposeOk=${!!prop} publish=${rev?.publication} vstatus=${rev?.verificationStatus}`);
});

log('');
log('=== 汇总 ===');
const counts = {};
for (const r of results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
log('  ' + JSON.stringify(counts));
const bad = results.filter((r) => r.verdict === 'FAIL' || r.verdict === 'PROBE-ERROR');
if (bad.length) { log('  ⚠ 非预期：'); for (const b of bad) log(`    - ${b.id}: ${b.detail}`); }
fs.writeFileSync(path.join(os.tmpdir(), '_rev-p4r2', 'rev-probe-result.json'),
  JSON.stringify(results, null, 2), 'utf8');
process.exit(bad.length ? 1 : 0);
