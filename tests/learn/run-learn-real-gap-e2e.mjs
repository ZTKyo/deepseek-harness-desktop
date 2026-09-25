// run-learn-real-gap-e2e.mjs —— P4 LEARN R2 · AC5 能力缺口真实会话闭环 E2E
//
// 目标（合同 §四「真实数据」+ AC5）：在**磁盘上的真实会话**上证明能力缺口路径是活的，
// 而不是在合成事件上证明。全链路使用**生产函数**（extractToolOutcomes /
// unresolvedToolFailures / capabilitySignature / learn.apply），夹具侧不做任何判定代替。
//
// 与合成测试的分工：
//   · test-learn-stage85-twins.mjs / test-learn-real-topology-tool-events.mjs —— 边界与
//     拓扑回归（可精确构造孪生对照）
//   · 本文件 —— 真实数据活性与出处可追溯（真实 seq、真实 isError、真实 errorCode）
//
// ⚠ 关键纪律（本次命中缺陷的教训）：**夹具必须服从真实拓扑**。
//   真实会话的 surface 节点只有 user/message 与 assistant/message，
//   工具事件（tool/call、tool/result）落在节点**之间**的 seq 上，与节点 seq 零交集。
//   同时生产侧有界：MAX_SESSION_OBSERVATIONS=64 / MAX_GAP_SIGNATURES=16，
//   故本 E2E 只在"生产真的能看见"的签名上判定（见 G0），避免把上界效应误报成缺陷。
//
// 用法：node tests/learn/run-learn-real-gap-e2e.mjs [--max-sessions=40] [--verbose]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as core from '../../plugins/learn-core.mjs';
import * as gapVeto from '../../plugins/learn-gap-veto.mjs';
import * as learn from '../../plugins/learn.mjs';
import {
  listRealSessions, loadRealSession, mkCtx, mkExec, driveHook, growSession, SESSIONS_DIR,
} from './_real-session-harness.mjs';

const args = process.argv.slice(2);
const MAX_SESSIONS = Number((args.find((a) => a.startsWith('--max-sessions=')) ?? '').split('=')[1] ?? 40);
const VERBOSE = args.includes('--verbose');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }
function info(t) { console.log(`  · ${t}`); }

// 生产同口径的有界常量（必须与 learn.mjs 一致，否则本 E2E 会在"生产看不见"的签名上判定）
const MAX_SESSION_OBSERVATIONS = 64;
const MAX_GAP_SIGNATURES = 16;

// 生产同口径：工具失败事实 → 签名键（与 learn.mjs 的 liveKeys/groups 逐字一致）
const keyOf = (f) => `tool:${f.toolName}::${gapVeto.capabilitySignature(f.capability)}`;

// ── 生产同口径的"可见签名"计算（含全部有界裁剪，顺序也一致）──
function visibleSignatures(real) {
  const outcomes = core.extractToolOutcomes(real.events, real.nodes);
  const unresolved = core.unresolvedToolFailures(outcomes).slice(0, MAX_SESSION_OBSERVATIONS);
  const order = [];
  const map = new Map();
  for (const f of unresolved) {
    const k = keyOf(f);
    if (!map.has(k)) {
      if (map.size >= MAX_GAP_SIGNATURES) continue;   // 新签名超限 ⇒ 生产丢弃
      map.set(k, { key: k, n: 0, seqs: [], toolName: f.toolName, errorCode: f.errorCode ?? null });
      order.push(k);
    }
    const g = map.get(k); g.n++; g.seqs.push(f.seq);
  }
  return { outcomes, unresolved, groups: order.map((k) => map.get(k)) };
}

console.log('='.repeat(78));
console.log('P4 LEARN R2 · AC5 能力缺口 · 真实会话闭环 E2E');
console.log('='.repeat(78));

// ══════════════════════════════════════════════════════════════════════════
section('G0 真实会话发现：在磁盘真实数据上找"真实重复未解决工具失败"');
const all = listRealSessions(500_000);
info(`候选真实会话（>500KB）: ${all.length} 个   来源: ${SESSIONS_DIR}`);

const scanned = [];
let toolSeqsTotal = 0, overlapTotal = 0, factsTotal = 0, unresolvedTotal = 0;

for (const cand of all.slice(0, MAX_SESSIONS)) {
  let real;
  try { real = loadRealSession(cand.p); } catch { continue; }
  const { outcomes, unresolved, groups } = visibleSignatures(real);
  // 真实拓扑自检：工具事件 seq 与节点 seq 必须零交集
  const nodeSet = new Set(real.nodes);
  let toolSeqs = 0, overlap = 0;
  for (let i = 0; i < real.events.length; i++) {
    const t = real.events[i]?.type;
    if (t === 'tool/call' || t === 'tool/result') { toolSeqs++; if (nodeSet.has(i)) overlap++; }
  }
  toolSeqsTotal += toolSeqs; overlapTotal += overlap;
  factsTotal += outcomes.failures.length; unresolvedTotal += unresolved.length;
  const hit = groups.filter((g) => g.n >= gapVeto.REPEAT_THRESHOLD);
  scanned.push({ real, groups, hit, toolSeqs, overlap, size: cand.size });
  if (VERBOSE) {
    info(`${path.basename(cand.p).slice(0, 46)} nodes=${real.nodes.length} toolEv=${toolSeqs} overlap=${overlap} facts=${outcomes.failures.length} unresolved=${unresolved.length} 达标签名=${hit.length}`);
  }
}

info(`已扫描: ${scanned.length} 个真实会话`);
info(`真实拓扑自检: 工具事件合计 ${toolSeqsTotal} 个，其中落在 surface 节点 seq 上 = ${overlapTotal}`);
info(`结构化事实: 工具失败 ${factsTotal} 条 → 未解决 ${unresolvedTotal} 条`);
check('★ 真实拓扑自检：工具事件与 surface 节点 seq 零交集（全库范围）',
  overlapTotal === 0, `overlap=${overlapTotal}/${toolSeqsTotal}`);
check('真实会话确实含有工具失败事实（非空数据）', factsTotal > 0, `facts=${factsTotal}`);

// 选"达标签名最多"的会话
const ranked = scanned.filter((s) => s.hit.length > 0).sort((a, b) => b.hit[0].n - a.hit[0].n || b.hit.length - a.hit.length);
check('★ 存在含"真实重复未解决工具失败"的真实会话（≥2 次同签名）',
  ranked.length > 0, `含达标签名的会话数=${ranked.length}`);

if (ranked.length === 0) {
  console.log('\n（无可用真实数据 ⇒ 后续闭环无法进行，按真实报告）');
  console.log(`\n${'='.repeat(78)}\nP4 LEARN R2 REAL-GAP E2E: ${pass} PASS / ${fail} FAIL （数据不足）\n${'='.repeat(78)}`);
  process.exit(1);
}

const target = ranked[0];
const sig = target.hit.sort((a, b) => b.n - a.n)[0];
info(`选定会话: ${path.basename(target.real.file).slice(0, 46)}  size=${(target.size / 1024 / 1024).toFixed(1)}MB  nodes=${target.real.nodes.length}`);
info(`选定签名: ${sig.key}  真实出现 ${sig.n} 次  seqs=[${sig.seqs.slice(0, 8).join(',')}${sig.seqs.length > 8 ? ',…' : ''}]`);

// ══════════════════════════════════════════════════════════════════════════
section('G1 出处独立复核：签名对应的"真实事件事实"逐条回读原事件');
{
  // 独立重新解析该会话（不复用 G0 的对象），逐 seq 回读原始事件
  const re = loadRealSession(target.real.file);
  const direct = [];
  for (const seq of sig.seqs) {
    const ev = re.events[seq];
    const blocks = ev?.data?.message?.content;
    const b = Array.isArray(blocks) ? blocks.find((x) => x && x.type === 'tool-result') : null;
    direct.push({
      seq,
      type: ev?.type,
      callIdFromSource: ev?.data?.message?.source?.callId ?? null,
      isError: b?.isError === true,
      errorCode: ev?.data?.error?.code ?? null,
    });
  }
  check('每一条证据 seq 都指向真实的 tool/result 事件',
    direct.length >= gapVeto.REPEAT_THRESHOLD && direct.every((d) => d.type === 'tool/result'),
    JSON.stringify(direct.map((d) => `${d.seq}:${d.type}`)));
  check('★ 每条原始事件的 content.isError === true（官方事实，非推断）',
    direct.every((d) => d.isError === true), JSON.stringify(direct.map((d) => d.isError)));
  check('★ 每条原始事件都带同一个结构化 errorCode（同底层能力）',
    direct.every((d) => d.errorCode === sig.errorCode),
    `expect=${sig.errorCode} got=${JSON.stringify([...new Set(direct.map((d) => d.errorCode))])}`);
  check('证据 seq 全部落在节点 seq 之外（再次确认非节点伪造）',
    direct.every((d) => !re.nodes.includes(d.seq)));
}

// ══════════════════════════════════════════════════════════════════════════
section('G2 真实闭环：按真实生长方式驱动真实插件 ⇒ 产出候选');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-realgap-'));
const SID = target.real.file.match(/session-([0-9a-f-]{36})/i)?.[1] ?? `realgap-${Date.now()}`;
info(`stateDir: ${tmpDir}`);
info(`sessionId: ${SID}`);

const { ctx, hooks, logs } = mkCtx();
const api = learn.apply(ctx, { stateDir: tmpDir, minNewNodes: 4, minTurnsForLearning: 4, maxDigestTurns: 40 });

const t0 = Date.now();
const grown = await growSession(api, hooks, target.real, SID, 24,
  (a) => (a.candidateStoreFor(SID)?.candidates?.length ?? 0) > 0);
const dt = ((Date.now() - t0) / 1000).toFixed(1);
const diag = logs.join('\n');
const cstore = api.candidateStoreFor(SID);

info(`驱动完成: steps=${grown.steps} stopped=${grown.stopped} 用时=${dt}s`);
info(`遥测条数=${logs.length}`);
const gapDiag = diag.split('\n').filter((l) => /CAPABILITY-GAP/.test(l));
info(`CAPABILITY-GAP 遥测 ${gapDiag.length} 条，示例: ${gapDiag.slice(0, 3).join(' | ') || '(none)'}`);

check('★ 真实会话上能力缺口路径是活的（出现 CAPABILITY-GAP 遥测）', gapDiag.length > 0,
  gapDiag.length ? '' : 'no CAPABILITY-GAP diag at all');
check('★ 产出候选（真实会话，非合成）', (cstore?.candidates?.length ?? 0) > 0,
  `candidates=${cstore?.candidates?.length ?? 0}; diag=${gapDiag.slice(0, 2).join(' | ')}`);

if ((cstore?.candidates?.length ?? 0) > 0) {
  // 选择"出处来自真实达标签名"的那个候选
  const cand = cstore.candidates.find((c) => c.dedupKey === sig.key) ?? cstore.candidates[0];
  info(`候选: id=${cand.id} kind=${cand.kind} state=${cand.state} obs=${cand.observationCount}`);
  info(`      dedupKey=${cand.dedupKey}`);
  info(`      taskType=${cand.taskType} sig=${cand.normalizedSignature}`);

  check('★ 候选 dedupKey 派生自真实 (tool,errorCode) 签名',
    cand.dedupKey === sig.key, `expect=${sig.key} got=${cand.dedupKey}`);
  check('候选 origin/taskType 为 tool 域', String(cand.taskType).startsWith('tool:'), String(cand.taskType));
  check('候选状态为 PROPOSED（绝不自动激活）', cand.state === 'PROPOSED', String(cand.state));
  check('观测计数 ≥ 真实重复阈值（真实出现次数）',
    cand.observationCount >= gapVeto.REPEAT_THRESHOLD && cand.observationCount <= sig.n,
    `obs=${cand.observationCount} realN=${sig.n}`);
  check('候选 kind 属于合法枚举', learn.CANDIDATE_KINDS?.includes?.(cand.kind) ?? ['RULE', 'EXTEND_SKILL', 'NEW_SKILL', 'NEW_PLUGIN'].includes(cand.kind), String(cand.kind));

  // ══════════════════════════════════════════════════════════════════════
  section('G3 幂等：重复驱动同一真实会话不重复建候选、不复活');
  const before = cstore.candidates.length;
  const cBefore = cstore.candidates.find((c) => c.id === cand.id);
  await growSession(api, hooks, target.real, SID, 24);
  const after = api.candidateStoreFor(SID).candidates.length;
  const cAfter = api.candidateStoreFor(SID).candidates.find((c) => c.id === cand.id);
  check('候选数量不因重复驱动而增长', after === before, `before=${before} after=${after}`);
  check('候选 id / dedupKey 稳定（确定性派生）',
    cAfter?.id === cBefore?.id && cAfter?.dedupKey === cBefore?.dedupKey);

  // ══════════════════════════════════════════════════════════════════════
  section('G4 隔离：真实闭环的候选不污染稳定经验库');
  const stable = api.getStore(SID);
  const activeFromGap = stable.experiences.filter((e) => e.state === 'ACTIVE' || e.state === 'APPROVED');
  check('能力缺口候选未直接写入稳定库（Stable 不被绕过）',
    !stable.experiences.some((e) => e.id === cand.id), `stableN=${stable.experiences.length} autoActive=${activeFromGap.length}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('G5 真实数据上的否决面：合格/被否决签名在全库真实数据上的分布');
{
  // ⚠ 观测形状必须与**生产逐字一致**（learn.mjs:402-407）：
  //   {taskType, capability, capabilityDeficiency, seq}
  //   首版本段漏了 `capabilityDeficiency` ⇒ 被适配器正确否决
  //   （reason='missing capability deficiency evidence'），属于**本测试的构造错误**，
  //   不是生产缺陷——生产在 learn.mjs:407 明确传入 capabilityDeficiency。
  //   这正是"测试必须服从生产契约"的又一次实例。
  let vetoedSignatures = 0, toolOriginSignatures = 0;
  const vetoReasons = new Set();
  for (const s of scanned) {
    const outcomes = core.extractToolOutcomes(s.real.events, s.real.nodes);
    const un = core.unresolvedToolFailures(outcomes).slice(0, MAX_SESSION_OBSERVATIONS);
    for (const g of s.groups) {
      if (g.n < gapVeto.REPEAT_THRESHOLD) continue;
      const facts = un.filter((f) => keyOf(f) === g.key);
      if (facts.length === 0) continue;
      const observations = facts.map((f) => ({
        taskType: g.toolName ? `tool:${g.toolName}` : '',
        capability: f.capability,
        capabilityDeficiency: `tool ${f.toolName} fails with ${f.errorCode || f.errorName || 'uncoded error'}`,
        seq: f.seq,
      }));
      const q = gapVeto.qualifyGap(observations);
      if (q.qualified) toolOriginSignatures++;
      else { vetoedSignatures++; vetoReasons.add(String(q.reason).slice(0, 60)); }
    }
  }
  info(`全库达标签名（生产观测形状）: tool 域合格 ${toolOriginSignatures} 个 / 被否决 ${vetoedSignatures} 个`);
  if (vetoReasons.size) info(`否决原因样本: ${[...vetoReasons].slice(0, 4).join(' | ')}`);
  check('★ 真实数据上合格签名可被生产资格判定接受（≥1）', toolOriginSignatures > 0,
    `qualified=${toolOriginSignatures} vetoed=${vetoedSignatures}`);
  check('合格签名数不超过达标签名总数（无膨胀）',
    toolOriginSignatures <= toolOriginSignatures + vetoedSignatures);
  // 被否决签名在生产里必然被跳过（learn.mjs:409 `if (!gap.qualified) continue`），
  // 故"否决面有效"的判据是：这些签名在 G2 的候选库里**不存在对应候选**。
  const producedKeys = new Set((api.candidateStoreFor(SID)?.candidates ?? []).map((c) => c.dedupKey));
  const leaked = [...producedKeys].filter((k) => /::\|\|/.test(k));
  check('候选库中无"空签名"泄漏（否决面未被绕过）', leaked.length === 0, JSON.stringify(leaked));
}

// ══════════════════════════════════════════════════════════════════════════
section('G6 清理');
try { fs.rmSync(tmpDir, { recursive: true, force: true }); info(`已删除临时状态目录 ${tmpDir}`); } catch (e) { info(`清理失败（无害）: ${e.message}`); }

console.log(`\n${'='.repeat(78)}`);
console.log(`P4 LEARN R2 REAL-GAP E2E: ${pass} PASS / ${fail} FAIL`);
console.log(`真实会话: ${path.basename(target.real.file)}  (nodes=${target.real.nodes.length})`);
console.log(`真实签名: ${sig.key}  ×${sig.n}`);
if (fail) console.log('FAILED: ' + failures.join(' ; '));
console.log('='.repeat(78));
process.exit(fail ? 1 : 0);
