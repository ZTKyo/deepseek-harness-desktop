// run-learn-real-e2e.mjs —— P4 LEARN R1 端到端验收（E1–E4）
//
// 与单测的区别（这是本文件存在的理由）：单测用合成事件；本 E2E 用**真实原始会话**
// （~/.dsh/sessions/*/session.jsonl.zstd，经共享解码器读出官方 append 事件），
// 驱动**真实插件壳**（plugins/learn.mjs 的 apply() 返回的真实 execute 函数），
// 覆盖 E1 自动候选 → E2 人工审批 → E3 确定性召回 → E4 故障注入/写入边界/持久化。
//
// 关键保真点：钩子按**真实会话生长方式**驱动（逐节点推进 pre-step），而不是一次性
// 灌入整段历史——否则水位的"只学新内容"语义会被绕过，测的就不是真实路径了。
//
// 复用而非复制：会话解码走 docs/roadmap/evidence/cm-r4-log-decoder.mjs（同一实现），
// 抽取走 plugins/learn-core.mjs（其内部复用 P2.5 官方提取器）。
//
// 用法：node tests/learn/run-learn-real-e2e.mjs [session.jsonl.zstd]
//   exit 0 = 全部 PASS；exit 1 = 有 FAIL（并打印失败清单）
// 只读真实会话；只写 os.tmpdir() 下的临时目录；不触碰任何生产状态/配置/会话数据。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as learn from '../../plugins/learn.mjs';
import * as core from '../../plugins/learn-core.mjs';
// 真实会话驱动器（加载/伪 ctx/钩子推进）统一复用共享模块，避免出现第二套真实会话解析
import {
  loadRealSession, listRealSessions, SESSIONS_DIR, mkCtx, mkExec, driveHook, growSession,
  mkHostApproval,
} from './_real-session-harness.mjs';

// ─── 断言与计数 ───────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const FAKE_SECRET = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2';

// ─── （真实会话加载/mkCtx/mkExec/driveHook/growSession 已提取至 _real-session-harness.mjs）───

// ─── （伪 ctx / 伪 exec / 钩子推进已提取至 _real-session-harness.mjs）───

// ─── 真实会话候选清单（listRealSessions / SESSIONS_DIR 已提取至 _real-session-harness.mjs）───

// ─── （growSession 已提取至 _real-session-harness.mjs）───

// ─── 主流程 ──────────────────────────────────────────────────────────────
const argFile = process.argv[2];
const candidates = argFile ? [{ p: argFile, size: fs.statSync(argFile).size }] : listRealSessions();
if (!candidates.length) { console.error('FATAL: no real session file found under ' + SESSIONS_DIR); process.exit(1); }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-learn-e2e-'));
console.log(`real session candidates: ${candidates.length} (from ${SESSIONS_DIR})`);
console.log(`temp stateDir: ${tmpDir}`);

section('E0 真实会话加载（官方 append 事件，无合成数据）');
// 从最大的几个里挑一个真实会话做主证据（信息量足够）
const main = candidates[Math.min(candidates.length - 1, Math.max(0, candidates.length - 3))];
const real = loadRealSession(main.p);
console.log(`main real session: ${real.file}`);
check('zstd frames decoded', real.frames > 0, `frames=${real.frames}`);
check('real events parsed', real.events.filter(Boolean).length > 100, `events=${real.events.filter(Boolean).length}`);
check('real surface nodes present', real.nodes.length >= 40, `nodes=${real.nodes.length}`);
check('zero JSON parse errors', real.parseErrors === 0, `bad=${real.parseErrors}`);
check('event shape is official {type,seq,time,data}', (() => {
  const e = real.events[real.nodes[0]];
  return e && typeof e.type === 'string' && Number.isInteger(e.seq) && e.data !== undefined;
})(), JSON.stringify(Object.keys(real.events[real.nodes[0]] ?? {})));

// ═══ E1：真实会话 → 自动候选（PROPOSED，永不可召回）═══════════════════════
section('E1 自动学习：真实会话 → 候选经验（PROPOSED，携带真实出处）');
const SID = 'real-e2e-' + Date.now();
// F1（2026-09-25）：唯一激活通道 = **宿主人类批准**。故本 E2E 起一个真实宿主
// ApprovalService（cordis + @deepseek-ai/dsh-user-approval），测试只负责"当人类"作答；
// 人类答案由 `humanVerdict` 驱动，用于分别验证"人类拒绝 ⇒ 不得 APPROVED"与
// "人类批准 ⇒ APPROVED"。无该通道的实例另行建立，用于证明 fail-closed。
let humanVerdict = 'rejected';
const humanAnswers = [];
const approval = await mkHostApproval({ answerer: (req) => { humanAnswers.push(humanVerdict); return humanVerdict; } });
const e1 = mkCtx({ approval: approval.svc ?? undefined });
const api1 = learn.apply(e1.ctx, { stateDir: tmpDir, minNewNodes: 4, minTurnsForLearning: 4, maxDigestTurns: 40 });
check('plugin exposes real tool specs', api1.toolNames.length === 6, api1.toolNames.join(','));
// P4 R2 合同完成：新增 learn_verify（合同【实现原则 3】确定性验证入口）⇒ 精确集合断言 6 项。
check('all 6 tool names correct', JSON.stringify([...api1.toolNames].sort()) === JSON.stringify(
  ['learn_promote', 'learn_propose', 'learn_recall', 'learn_review', 'learn_status', 'learn_verify']));

// 阶段 1：首次 pre-step 只建立水位（不回填历史）
await driveHook(e1.hooks, { id: SID, events: real.events, surface: { nodes: real.nodes.slice(0, 24) } });
check('phase1 establishes watermark only (no history backfill)', api1.getStore(SID).experiences.length === 0,
  `experiences=${api1.getStore(SID).experiences.length}`);

// 阶段 2：按真实生长方式推进，直到自动产出候选
const grown = await growSession(api1, e1.hooks, real, SID, 24);
console.log(`  (grew session node-by-node: ${grown.steps} pre-step calls)`);
const s1 = api1.getStore(SID);
check('auto-proposed at least one candidate from real session', s1.experiences.length >= 1,
  `experiences=${s1.experiences.length}; logs=${e1.logs.slice(-3).join(' | ')}`);

if (s1.experiences.length === 0) {
  console.log('\nFATAL: no candidate produced from real session — cannot continue E1-E3.');
  console.log('plugin logs:');
  for (const l of e1.logs) console.log('  ' + l);
  process.exit(1);
}

const autoEx = s1.experiences[0];
check('candidate state is PROPOSED (never auto-active)', s1.experiences.every((e) => e.state === 'PROPOSED'),
  s1.experiences.map((e) => e.state).join(','));
check('candidate carries real provenance seqs', Array.isArray(autoEx.sourceEventSeqs) && autoEx.sourceEventSeqs.length >= 4,
  `seqs=${JSON.stringify(autoEx.sourceEventSeqs)}`);
check('every provenance seq points at a REAL event', autoEx.sourceEventSeqs.every((q) => {
  const ev = real.events[q];
  return ev && Number.isInteger(ev.seq) && ev.seq === q;
}));
check('provenance seqs are real surface nodes', autoEx.sourceEventSeqs.every((q) => real.nodes.includes(q)));
// 标题经 oneLine() 折叠过空白（\s+ → ' '），而原始 turn 文本含换行 ⇒ 两侧都做同样的空白
// 规范化后再比较。此断言此前是"碰巧通过"：一旦信号轮换成含换行的发言（R2 修好中文关键词后
// 就会发生），换行 vs 空格必然导致 includes() 假失败。
const normWs = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const titleKey = normWs(autoEx.title).slice(0, 40);
const titleFromRealTurn = (key) => real.nodes.some((q) => {
  const d = core.buildLearnDigest(real.events, [q]);
  return d.ok && d.digest.turns[0] && normWs(d.digest.turns[0].text).includes(key);
});
check('title derived from real utterance (not invented)', typeof autoEx.title === 'string' && autoEx.title.length > 0
  && titleKey.length > 0 && titleFromRealTurn(titleKey),
  `title=${JSON.stringify(autoEx.title.slice(0, 60))}`);
check('NEGATIVE CONTROL: an invented title is rejected by that same check',
  !titleFromRealTurn(normWs('THIS TITLE WAS NEVER UTTERED ANYWHERE IN THIS SESSION ZZZQ').slice(0, 40)));
check('origin session recorded', autoEx.originSessionId === SID);
check('candidate body quotes real turns with seq anchors', /\[\d+\]\s+(user|assistant):/.test(autoEx.body),
  JSON.stringify(autoEx.body.slice(0, 120)));
check('telemetry recorded PROPOSED', api1.summaryFor(SID).counts?.PROPOSED >= 1,
  JSON.stringify(api1.summaryFor(SID).counts));

// AC2 直证：PROPOSED 不可召回
const recallBefore = api1.recallFor(SID, autoEx.title);
check('PROPOSED is NOT recallable (proposal ≠ activation)', recallBefore.items.length === 0,
  `items=${recallBefore.items.length}`);

// ═══ E2：人工审批边界 ═════════════════════════════════════════════════════
section('E2 人工审批边界（唯一激活通道）');
const exec1 = mkExec(SID);
const tool = (name, args) => api1.invokeTool(name, args, exec1);

const prop2 = await tool('learn_propose', {
  title: 'Real-session lesson: walk zstd frames before trusting event counts',
  body: 'When counting session events, walk zstd frames precisely; a truncated frame silently drops lines and understates the log.',
  tags: ['verification'],
  sourceEventSeqs: real.nodes.slice(-6),
});
check('explicit propose via real tool returns PROPOSED', prop2.state === 'PROPOSED', JSON.stringify(prop2));

const prop3 = await tool('learn_propose', {
  title: 'Real-session lesson: never trust a single green run',
  body: 'Repeat the acceptance run after a refactor; identical output is the only regression proof.',
  tags: ['verification'],
  sourceEventSeqs: real.nodes.slice(-8),
});
check('second explicit proposal created', prop3.ok === true && prop3.experienceId !== prop2.experienceId);

let threw = null;
// F1：唯一授权来源 = 宿主人类批准通道。没有该通道的实例（=部署中没装/没启用该通道）
// 必须 fail-closed —— 绝不允许"填个 approver 字符串"就换来 APPROVED。
const e1NoHost = mkCtx();
const apiNoHost = learn.apply(e1NoHost.ctx, { stateDir: tmpDir, minNewNodes: 4, minTurnsForLearning: 4 });
threw = null;
try {
  await apiNoHost.invokeTool('learn_review', {
    experienceId: prop2.experienceId, action: 'approve', approver: 'human', evidence: 'looks right',
  }, mkExec(SID));
} catch (e) { threw = e.message; }
check('approve WITHOUT host human channel rejected (fail-closed)', threw !== null && /approval_unavailable/.test(threw),
  threw ?? 'did not throw');
check('…and that attempt changed nothing', apiNoHost.getStore(SID).experiences.find((e) => e.id === prop2.experienceId)?.state === 'PROPOSED');

// F1-B/C：人类在真实通道里**拒绝** ⇒ 即使 agent 自填 approver/evidence 也不得 APPROVED
humanVerdict = 'rejected';
threw = null;
try {
  await tool('learn_review', {
    experienceId: prop2.experienceId, action: 'approve', approver: 'human:trust-me', evidence: 'agent says it is fine',
  });
} catch (e) { threw = e.message; }
check('approve DENIED when the human answer is a rejection', threw !== null && /approval_not_granted/.test(threw), threw ?? 'did not throw');
check('…self-declared approver string bought nothing', api1.getStore(SID).experiences.find((e) => e.id === prop2.experienceId)?.state === 'PROPOSED',
  api1.getStore(SID).experiences.find((e) => e.id === prop2.experienceId)?.state);

// 注意顺序：下面两条都让"人类同意"，以便把失败原因**隔离**到证据校验本身
// （实测发现：插件是**先问人类、再校验证据**，所以人类答"拒绝"时，证据类用例会被
//  approval_not_granted 抢先掩盖 —— 这里显式对齐，避免断言虚过）。
humanVerdict = 'allowed-once';
threw = null;
try { await tool('learn_review', { experienceId: prop2.experienceId, action: 'approve', evidence: '   ' }); } catch (e) { threw = e.message; }
check('approve with EMPTY evidence rejected (证据仍是硬要求)', threw !== null && /evidence/i.test(threw), threw ?? 'did not throw');

threw = null;
try { await tool('learn_review', { experienceId: prop2.experienceId, action: 'approve', evidence: `verified with ${FAKE_SECRET}` }); } catch (e) { threw = e.message; }
check('approve with SECRET in evidence rejected', threw !== null && /secret/i.test(threw), threw ?? 'did not throw');

// F1-H：真实人类批准（宿主通道作答 allowed-once）⇒ APPROVED，且记录的是宿主 actor 而非调用方字符串
const appr = await tool('learn_review', { experienceId: prop2.experienceId, action: 'approve', approver: 'human:e2e', evidence: 'confirmed reusable against real session data' });
check('approve WITH real host human approval succeeds', appr.state === 'APPROVED', JSON.stringify(appr));
check('host human channel really was the path', approval.seen.length >= 1 && humanAnswers.length >= 1,
  `seen=${approval.seen.length} answers=${JSON.stringify(humanAnswers)}`);
const stored2 = api1.getStore(SID).experiences.find((e) => e.id === prop2.experienceId);
check('approver identity = TRUSTED HOST ACTOR (not the caller string)', stored2?.approvedBy === core.HUMAN_APPROVAL_ACTOR,
  `approvedBy=${JSON.stringify(stored2?.approvedBy)}`);
check('caller-supplied approver string was NOT what got recorded', stored2?.approvedBy !== 'human:e2e');
check('approval evidence recorded', !!stored2?.approvalEvidence);
check('live human approval validates', core.validHumanApproval(stored2).ok === true, core.validHumanApproval(stored2).reason);

const rej = await tool('learn_review', { experienceId: prop3.experienceId, action: 'reject', approver: 'human:e2e', reason: 'too generic to be reusable' });
check('reject succeeds', rej.state === 'REJECTED', JSON.stringify(rej));

threw = null;
try { await tool('learn_review', { experienceId: prop3.experienceId, action: 'approve', approver: 'human:e2e', evidence: 'changed my mind' }); } catch (e) { threw = e.message; }
check('rejection is TERMINAL (cannot be revived)', threw !== null, threw ?? 'did not throw');

threw = null;
try { await tool('learn_review', { experienceId: 'nope', action: 'approve', approver: 'h', evidence: 'x' }); } catch (e) { threw = e.message; }
check('unknown experienceId rejected', threw !== null, threw ?? 'did not throw');

// ═══ E3：确定性召回 ═══════════════════════════════════════════════════════
section('E3 确定性召回（只召回 APPROVED，同一输入同一输出）');
const q = 'walk zstd frames before trusting event counts';
const r1 = await tool('learn_recall', { query: q });
check('approved experience is recallable', r1.items.length >= 1, `items=${r1.items.length}`);
check('recall returns the approved id', r1.items.some((i) => i.id === prop2.experienceId));
check('recall item carries provenance for official re-source', r1.items.every((i) => Array.isArray(i.sourceEventSeqs) && i.sourceEventSeqs.length > 0));
check('recall provenance points at real events', r1.items[0].sourceEventSeqs.every((s) => !!real.events[s]));
check('rejected experience NOT recallable', !r1.items.some((i) => i.id === prop3.experienceId));
check('PROPOSED (auto candidate) NOT recallable', !r1.items.some((i) => i.id === autoEx.id));

const r2 = await tool('learn_recall', { query: q });
check('recall is DETERMINISTIC (identical output for identical input)', JSON.stringify(r1.items) === JSON.stringify(r2.items));
const r3 = await tool('learn_recall', { query: 'completely unrelated zebra quantum banana' });
check('irrelevant query recalls nothing', r3.items.length === 0, `items=${r3.items.length}`);
check('recall telemetry recorded', api1.summaryFor(SID).counts?.RECALLED >= 1, JSON.stringify(api1.summaryFor(SID).counts));

section('E3b 晋升只做资格判定，绝不自动晋升');
const promoted = await tool('learn_promote', { experienceId: prop2.experienceId, evidence: 'recalled successfully in real E2E and remains correct' });
check('explicit promotion succeeds when eligible', promoted.promotion === 'PROMOTED', JSON.stringify(promoted));
threw = null;
try { await tool('learn_promote', { experienceId: autoEx.id, evidence: 'want it durable' }); } catch (e) { threw = e.message; }
check('promotion BLOCKED for non-approved experience', threw !== null, threw ?? 'did not throw');
check('blocked promotion recorded in telemetry', api1.summaryFor(SID).counts?.PROMOTION_BLOCKED >= 1,
  JSON.stringify(api1.summaryFor(SID).counts));

// ═══ E4：故障注入 / fail-closed / 写入边界 / 持久化 ═══════════════════════
section('E4 故障注入与 fail-closed');
const e4 = mkCtx();
const api4 = learn.apply(e4.ctx, { stateDir: tmpDir });
const reloaded = api4.getStore(SID);
const liveStore = api1.getStore(SID);   // 当前真实状态（E1 的 s1 只是当时的快照）
check('store survives plugin restart (persisted)', reloaded.experiences.length === liveStore.experiences.length,
  `live=${liveStore.experiences.length} reloaded=${reloaded.experiences.length}`);
check('every experience id survives restart',
  liveStore.experiences.every((e) => reloaded.experiences.some((r) => r.id === e.id)));
check('APPROVED state survives restart', reloaded.experiences.find((e) => e.id === prop2.experienceId)?.state === 'APPROVED');
check('PROMOTED state survives restart', reloaded.experiences.find((e) => e.id === prop2.experienceId)?.promotion === 'PROMOTED');
check('REJECTED state survives restart', reloaded.experiences.find((e) => e.id === prop3.experienceId)?.state === 'REJECTED');

const sp = api4.storePath(SID);
const goodBytes = fs.readFileSync(sp);
fs.writeFileSync(sp, '{"version":999,"experiences":[{"state":"APPROVED"}],"garbage":true', 'utf8');
const e4b = mkCtx();
const api4b = learn.apply(e4b.ctx, { stateDir: tmpDir });
const rebuilt = api4b.getStore(SID);
check('corrupt store rejected (no partial trust)', rebuilt.experiences.length === 0, `experiences=${rebuilt.experiences.length}`);
check('corrupt store rebuilt to a valid empty store', core.validateStore(rebuilt) !== null);
check('STORE_REBUILT telemetry recorded', api4b.summaryFor(SID).counts?.STORE_REBUILT >= 1,
  JSON.stringify(api4b.summaryFor(SID).counts));
fs.writeFileSync(sp, goodBytes);

const denied = ['runtime-state', 'goals', 'credentials', 'policy', 'settings', 'config', 'session', 'autonomy', 'router'];
check('protected write targets denied', denied.every((k) => core.assertWriteAllowed(k).allowed === false), denied.join(','));
check('experience-store target allowed', core.assertWriteAllowed('experience-store').allowed === true);
check('unknown target denied (fail-closed)', core.assertWriteAllowed('some-random-thing').allowed === false);
check('null/empty target denied', core.assertWriteAllowed(null).allowed === false && core.assertWriteAllowed('').allowed === false);

const e4c = mkCtx();
const api4c = learn.apply(e4c.ctx, { stateDir: tmpDir });
await api4c.invokeTool('learn_propose', {
  title: 'lesson with a leaked credential',
  body: `the key ${FAKE_SECRET} must never be stored`,
  tags: ['security'],
  sourceEventSeqs: real.nodes.slice(-3),
}, mkExec(SID));
const diskBytes = fs.readFileSync(sp, 'utf8');
check('raw secret NEVER written to disk', !diskBytes.includes(FAKE_SECRET));
check('secret redaction applied in stored body', !diskBytes.includes(FAKE_SECRET));

const e4d = mkCtx();
learn.apply(e4d.ctx, { stateDir: tmpDir, enabled: false });
check('kill switch registers NO hooks', (e4d.hooks.get('agent/pre-step') ?? []).length === 0);
process.env.LEARN_DISABLED = 'true';
const e4e = mkCtx();
learn.apply(e4e.ctx, { stateDir: tmpDir });
check('LEARN_DISABLED=true registers NO hooks', (e4e.hooks.get('agent/pre-step') ?? []).length === 0);
delete process.env.LEARN_DISABLED;

const e4f = mkCtx();
learn.apply(e4f.ctx, { stateDir: tmpDir });
let hookThrew = null;
try {
  await driveHook(e4f.hooks, null);
  await driveHook(e4f.hooks, { id: 'x', events: null, surface: null });
  await driveHook(e4f.hooks, { id: 'x', events: [], surface: { nodes: [] } });
  await driveHook(e4f.hooks, { id: 'x', events: [{}], surface: { nodes: [999999] } });
} catch (e) { hookThrew = e.message; }
check('malformed sessions do not throw (fail-open)', hookThrew === null, hookThrew ?? '');

// ─── 汇总 ────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(64)}`);
console.log(`P4 LEARN R1 REAL-SESSION E2E: ${pass} PASS / ${fail} FAIL`);
if (fail) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
}
console.log(`main real session: ${path.basename(path.dirname(real.file))} (${real.nodes.length} surface nodes, ${real.frames} zstd frames)`);
console.log(`temp stateDir (safe to delete): ${tmpDir}`);
console.log('='.repeat(64));
process.exit(fail ? 1 : 0);
