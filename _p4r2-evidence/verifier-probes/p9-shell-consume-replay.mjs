// P9 插件壳（learn.mjs 工具层）单次消费 / 回放探针 —— 独立只读验证者自建
// 与前序 p7/p8（直接调 core.*）的区别：这里一律经由 apply() 返回的**真实工具实现**
// (toolSpecs['learn_review'].execute) 与**本实例台账**的 live 授权面（canPublishFor /
// validHumanApprovalFor）来驱动，以覆盖"工具层 + 单次消费/回放"这条此前未覆盖的路径。
//
// 用法：
//   node p9-shell-consume-replay.mjs base          # 诚实流：工具层发布#1 + 工具层回放#2
//   node p9-shell-consume-replay.mjs dupgrant      # 篡改：追加一条重复 grant（克隆候选）
//   node p9-shell-consume-replay.mjs dupconsume    # 篡改：给同一 grant 追加第二次 consume
//   node p9-shell-consume-replay.mjs dropconsume   # 篡改：删除 consume（grant 未消费）
//   node p9-shell-consume-replay.mjs forge         # 篡改：追加完整伪造 grant+consume
// 冻结副本由 VFY_FROZEN 指定；状态一律写在 os.tmpdir()，不触碰任何仓库文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadCore, loadShell, mkCtx, say } from './_vfy-lib.mjs';

const phase = process.argv[2] || 'base';
const BASE = path.join(os.tmpdir(), 'vfy9-base');
const STATE = phase === 'base' ? BASE : path.join(os.tmpdir(), `vfy9-${phase}`);
const SID = 'vfy9-sess-A';
const REF = 'vfy9ref0123456789';
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const J = (v) => JSON.stringify(v);
const out = (k, v) => say(`[${phase}] ${k}: ${typeof v === 'string' ? v : J(v)}`);

const core = await loadCore();
const { apply } = await loadShell();

/** 宿主替身：ApprovalService 把 asked/decided 写进 agent.session，并返回 allowed-once。 */
function hostSeam(seedEvents = []) {
  const session = { id: SID, events: seedEvents.slice() };
  const seen = [];
  const approval = {
    async request({ agent, toolName, reason, callId }) {
      const id = REF;
      seen.push({ toolName, reason, callId });
      agent.session.events.push({ type: 'approval/asked', data: { id, toolName, reason, callId, requestedAt: Date.now() } });
      agent.session.events.push({ type: 'approval/decided', data: { id, outcome: 'allowed-once', decidedAt: Date.now() } });
      return 'allowed-once';
    },
  };
  return { session, seen, approval, sessions: { get: (id) => (id === SID ? session : null) } };
}

/** 造一条"已确定性验证"的候选经验并落盘（PROPOSED，尚未批准）。 */
function seedStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const proof = path.join(dir, 'proof.txt');
  fs.writeFileSync(proof, 'vfy9 proof artifact\n', 'utf8');
  const made = core.makeExperience({
    title: 'VFY9 shell-path experience', body: 'probe body for shell-path consume/replay',
    sourceEventSeqs: [301, 302], originSessionId: SID, createdAt: Date.now(),
  });
  let store = core.emptyStore();
  store.sessionId = SID;
  const pr = core.propose(store, made.value);
  store = pr.value;
  const vr = core.applyVerification(store, pr.experience.id,
    { class: 'file_hash', path: proof, sha256: sha(proof) }, { fileHash: sha }, Date.now());
  store = vr.value;
  fs.writeFileSync(path.join(dir, `${SID}.json`), J(store));
  return { expId: pr.experience.id, proof };
}

const LEDGER_FILE = (d) => path.join(d, '_human-approvals.jsonl');
const readLedger = (d) => core.parseApprovalLedgerText(fs.readFileSync(LEDGER_FILE(d), 'utf8'));
/** 用内存台账重建记录集（append 负责链式摘要），返回可落盘的 JSONL 文本。 */
function writeLedger(dir, records, appends = []) {
  const led = core.createMemoryApprovalLedger({ id: 'vfy9-tamper', records });
  const made = [];
  for (const a of appends) {
    const r = led.append(a.body, { at: Date.now() });
    if (!r.ok) throw new Error('tamper append failed: ' + r.reason);
    made.push(r.record);
  }
  const all = led.records();
  fs.writeFileSync(LEDGER_FILE(dir), all.map(core.serializeApprovalRecord).join(''), 'utf8');
  const reparsed = core.parseApprovalLedgerText(fs.readFileSync(LEDGER_FILE(dir), 'utf8'));
  return { count: all.length, chain: core.verifyApprovalLedgerChain(reparsed.records), made };
}

if (phase === 'base') {
  fs.rmSync(BASE, { recursive: true, force: true });
  const { expId } = seedStore(BASE);
  const host = hostSeam();
  const { ctx, logs } = mkCtx({ sessions: host.sessions, approval: host.approval });
  const api = await apply(ctx, { stateDir: BASE });
  out('shell_tool_surface', { names: api.toolNames, warn: logs.filter((l) => /tool surface|ledger/i.test(l)).slice(0, 2) });

  const exec1 = { agent: { session: host.session }, callId: 'c1' };
  let r1 = null; let e1 = null;
  try {
    r1 = await api.toolSpecs['learn_review'].execute(
      { experienceId: expId, action: 'approve', evidence: 'vfy9 probe: real host approval via shell tool layer' }, exec1);
  } catch (err) { e1 = String(err?.message ?? err); }
  out('T1_shell_publish_1', { ok: r1?.ok ?? null, publication: r1?.publication ?? null, state: r1?.state ?? null, error: e1 });
  out('T1_approval_reason', host.seen[0]?.reason ?? null);
  const led1 = readLedger(BASE);
  out('T1_ledger_after_publish', {
    records: led1.records.length, types: led1.records.map((r) => r.body.type),
    chain: core.verifyApprovalLedgerChain(led1.records).ok,
  });

  // ── 回放：同一条经验，经**同一个工具**再发一次 ──
  const exec2 = { agent: { session: host.session }, callId: 'c2' };
  let r2 = null; let e2 = null;
  try {
    r2 = await api.toolSpecs['learn_review'].execute(
      { experienceId: expId, action: 'approve', evidence: 'vfy9 probe: replay attempt #2' }, exec2);
  } catch (err) { e2 = String(err?.message ?? err); }
  out('T2_shell_publish_2_REPLAY', { ok: r2?.ok ?? null, publication: r2?.publication ?? null, error: e2 });
  const led2 = readLedger(BASE);
  out('T2_ledger_after_replay', {
    records: led2.records.length, types: led2.records.map((r) => r.body.type),
    consumes: led2.records.filter((r) => r.body.type === 'consume').length,
    chain: core.verifyApprovalLedgerChain(led2.records).ok,
  });

  // ── 壳实例自身的 live 授权面（生产 publish 走的同一判定）──
  const store = JSON.parse(fs.readFileSync(path.join(BASE, `${SID}.json`), 'utf8'));
  const exp = store.experiences.find((e) => e.id === expId);
  out('T3_shell_canPublishFor_after_consume', api.canPublishFor(exp));
  out('T3_shell_validHumanApprovalFor', api.validHumanApprovalFor(exp));
  // 克隆候选：同摘要、同 attestation，仅 id 不同
  const clone = { ...exp, id: 'vfy9-clone-0001', approval: { ...exp.approval, candidateId: 'vfy9-clone-0001' } };
  out('T4_shell_canPublishFor_CLONE', api.canPublishFor(clone));
  fs.writeFileSync(path.join(BASE, '_vfy9-fact.json'), J({ expId, cloneId: clone.id, sid: SID, ref: REF }), 'utf8');
  // ★ 持久化诚实流的宿主事件：篡改相位必须让**宿主事实层通过**，否则"拒"无法隔离到台账/消费层
  fs.writeFileSync(path.join(BASE, '_vfy9-host-events.json'), J(host.session.events), 'utf8');
} else {
  // 篡改相位：从 base 复制状态 → 改台账 → 全新 apply → 壳 live 授权面判定
  if (!fs.existsSync(LEDGER_FILE(BASE))) throw new Error('base 相位未运行：缺少 ' + LEDGER_FILE(BASE));
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.cpSync(BASE, STATE, { recursive: true });
  const fact = JSON.parse(fs.readFileSync(path.join(BASE, '_vfy9-fact.json'), 'utf8'));
  const parsed = readLedger(STATE);
  const grant = parsed.records.find((r) => r.body.type === 'grant');
  const consume = parsed.records.find((r) => r.body.type === 'consume');
  if (!grant || !consume) throw new Error('base 台账缺少 grant/consume');
  const g = grant.body;
  const store0 = JSON.parse(fs.readFileSync(path.join(STATE, `${SID}.json`), 'utf8'));
  const exp = store0.experiences.find((e) => e.id === fact.expId);
  const atkId = 'vfy9-attacker-0001';
  const atExp = { ...exp, id: atkId, approval: { ...exp.approval, candidateId: atkId } };
  let tamper = null; let verdicts = {};

  if (phase === 'dupgrant') {
    // 攻击：把同一份批准原样复刻成**新 grant**（新 recordId），指向克隆候选，并配一条自己的 consume
    const kept = parsed.records.filter((r) => r.body.type !== 'grant' && r.body.type !== 'consume');
    tamper = writeLedger(STATE, kept, [{ body: { ...g, candidateId: atkId } }]);
    const gid = tamper.made[0].recordId;
    // 再给这条克隆 grant 配上它自己的 consume（于是"克隆候选"看起来授权完备）
    const cur = readLedger(STATE);
    tamper = writeLedger(STATE, cur.records, [{ body: { ...consume.body, recordId: gid, candidateId: atkId } }]);
  } else if (phase === 'dupconsume') {
    // 攻击：给**原 grant** 追加第二次 consume（消费方=克隆候选）→ 原始经验也应判废
    tamper = writeLedger(STATE, parsed.records, [{ body: { ...consume.body, candidateId: atkId } }]);
  } else if (phase === 'dropconsume') {
    // 攻击：删除 consume，只留 grant
    tamper = writeLedger(STATE, parsed.records.filter((r) => r.body.type !== 'consume'), []);
  } else if (phase === 'forge') {
    // 攻击：完整伪造 grant+consume（宿主日志里**没有**这个 approvalRef）
    const FORGED = 'vfy9forgedref000001';
    const kept = parsed.records.filter((r) => r.body.type !== 'grant' && r.body.type !== 'consume');
    tamper = writeLedger(STATE, kept, [{ body: { ...g, candidateId: atkId, approvalRef: FORGED, hostSessionId: SID } }]);
    const gid = tamper.made[0].recordId;
    const cur = readLedger(STATE);
    tamper = writeLedger(STATE, cur.records, [{ body: { ...consume.body, recordId: gid, candidateId: atkId } }]);
  } else {
    throw new Error('未知相位: ' + phase);
  }
  out('tamper_ledger', { count: tamper.count, chain: tamper.chain });

  const hostEventsFile = path.join(BASE, '_vfy9-host-events.json');
  const seedEvents = fs.existsSync(hostEventsFile) ? JSON.parse(fs.readFileSync(hostEventsFile, 'utf8')) : [];
  const host = hostSeam(seedEvents);
  out('host_fact_seeded', { events: seedEvents.length, asked: seedEvents.filter((e) => e.type === 'approval/asked').length });
  const { ctx, logs } = mkCtx({ sessions: host.sessions, approval: host.approval });
  const api = await apply(ctx, { stateDir: STATE });
  out('shell_applied', { names: api.toolNames, warn: logs.filter((l) => /ledger/i.test(l)).slice(0, 3) });
  out('ledgerStatus', api.approvalLedgerStatus());

  const st = JSON.parse(fs.readFileSync(path.join(STATE, `${SID}.json`), 'utf8'));
  const expNow = st.experiences.find((e) => e.id === fact.expId);
  const atkNow = { ...expNow, id: atkId, approval: { ...expNow.approval, candidateId: atkId } };
  verdicts = {
    honest_exp: api.canPublishFor(expNow),
    honest_exp_human: api.validHumanApprovalFor(expNow),
    attacker_exp: api.canPublishFor(atkNow),
    attacker_exp_human: api.validHumanApprovalFor(atkNow),
  };
  out('SHELL_VERDICTS', verdicts);
}
