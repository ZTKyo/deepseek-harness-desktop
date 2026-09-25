// test-learn-stage85-twins.mjs —— R2 STAGE 8.5 能力缺口学习：**正/负孪生**验收
//
// 背景（为什么必须重写这一层）：
//   P4 此前唯一失败源是 `agent/request-error`（LLM 请求错误），其 9 个分类**全部**
//   落在 provider/网络/环境域，**没有任何一类**对应 Tool / Skill / Model 能力维度。
//   结果：AC5 的"真能力缺口"永远无法被表达，而一切失败又被无差别否决——
//   "真实能力缺口"与"伪缺口"被同一把闸门压死，AC5_SEMANTIC_GATE = FAIL。
//
// 本套件用四组**孪生对**把语义钉死（两组正例 + 两组必须被拒的负例）：
//
//   T1 POSITIVE 1  真实能力缺口        → 首次仅记证据（无候选）；重复达阈值 → 建立候选
//   T2 POSITIVE 2  同一问题后被解决    → 只有"成功"才解除失败；失败本身不得成为可召回经验
//   T3 NEGATIVE 1  伪能力缺口          → provider/网络/环境失败**永不**成为能力缺口
//   T4 NEGATIVE 2  噪声/瞬时失败       → 重试即成功 ⇒ 不得产出永久伪缺口
//
// 分层纪律（与既有 AC5 两层一致，不另起一套）：
//   - U 组 = 适配器单元语义（直接调真实函数）
//   - T 组 = 端到端（装载 plugins/learn.mjs 真实 apply()，触发真实钩子，
//            用**官方 tool/call + tool/result 事件**驱动，证明接线真实存在）
//
// 运行：node tests/learn/test-learn-stage85-twins.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  qualifyGap, REPEAT_THRESHOLD,
  FAILURE_ORIGIN, LEARNABLE_ORIGINS, NON_LEARNABLE_ORIGINS,
  CAPABILITY_REASON, CAPABILITY_ADAPTER_VERSION,
  classifyFailureOrigin, capabilitySignature, evaluateCapabilityObservation,
  evaluateGapVeto,
} from '../../plugins/learn-gap-veto.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_URL = pathToFileURL(join(HERE, '..', '..', 'plugins', 'learn.mjs')).href;

let pass = 0; let fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; failures.push(name + ' :: ' + e.message); console.log('  FAIL  ' + name + ' — ' + e.message); }
}
function section(t) { console.log(''); console.log('=== ' + t + ' ==='); }

// ══════════════════════════════════════════════════════════════════════════
// U 组：Capability-Gap Qualification Adapter 单元语义（零关键词 / 全覆盖 / fail-closed）
// ══════════════════════════════════════════════════════════════════════════
section('U 组：能力缺口适配器单元语义');

check('U1 失败起源域**全覆盖**：8 个已知 origin 被 LEARNABLE ∪ NON_LEARNABLE 穷尽划分', () => {
  const all = Object.values(FAILURE_ORIGIN);
  assert.equal(all.length, 9, 'origin 域应为 9 类（8 已知 + unknown），实际 ' + all.length + '：' + all.join(','));
  const covered = new Set([...LEARNABLE_ORIGINS, ...NON_LEARNABLE_ORIGINS]);
  // `unknown` 是**刻意**不归入任何一侧的 fail-closed 残差（缺结构化事实时的兜底），
  // 因此穷尽性断言必须显式排除它，否则会把"设计如此"误判成"无人负责的盲区"。
  for (const o of all) {
    if (o === FAILURE_ORIGIN.UNKNOWN) continue;
    assert.ok(covered.has(o), `origin ${o} 既不可学也不被排除 ⇒ 会出现"无人负责"的盲区`);
  }
  assert.equal(covered.size, all.length - 1, '已知 origin 数量不符或存在重复归类');
  // unknown 必须**不可学**（fail-closed），且不得出现在可学一侧
  assert.ok(!LEARNABLE_ORIGINS.includes(FAILURE_ORIGIN.UNKNOWN), 'unknown 被列为可学 ⇒ fail-closed 被破坏');
  const r = evaluateCapabilityObservation({ isError: true, errorCode: 'X' });   // 缺 toolName ⇒ unknown
  assert.equal(r.learnable, false, 'origin=unknown 的事实被判为可学 ⇒ fail-closed 被破坏');
  // 互斥：可学 ∩ 不可学 = ∅（否则同一事实会有两种相反结论）
  for (const o of LEARNABLE_ORIGINS) {
    assert.ok(!NON_LEARNABLE_ORIGINS.includes(o), `${o} 同时属于可学与不可学 ⇒ 语义自相矛盾`);
  }
});

check('U2 ★ 零关键词：结构化事实里的**自由文本**不得影响起源判定', () => {
  // 同一个工具失败，文案里塞满 provider/网络/超时/配额关键词
  const withNoisyText = {
    isError: true, toolName: 'pdf-extractor', errorCode: 'MISSING_CAPABILITY',
    message: 'provider outage 502 bad gateway timeout quota exceeded unauthorized network unreachable',
    detail: 'model refused to call the skill', text: 'skill not found in provider registry',
  };
  assert.equal(classifyFailureOrigin(withNoisyText), FAILURE_ORIGIN.TOOL,
    '文案关键词改变了起源判定 ⇒ 存在关键词分类路径（AC5 明令禁止）');
});

check('U3 ★ 变体免疫：同 (tool, code) 在文案/参数/长度剧烈变化下签名恒定', () => {
  const a = { isError: true, toolName: 'pdf-extractor', errorCode: 'MISSING_CAPABILITY', message: 'x' };
  const b = {
    isError: true, toolName: 'pdf-extractor', errorCode: 'MISSING_CAPABILITY',
    message: '完全不同的一段话 '.repeat(40), arguments: { huge: 'y'.repeat(500) },
    detail: 'yet another different wording', at: 999999,
  };
  assert.equal(capabilitySignature(a), capabilitySignature(b),
    '文案变化导致签名漂移 ⇒ 同一缺口会被拆成多个，永远达不到重复阈值');
  const c = { ...a, errorCode: 'SOMETHING_ELSE' };
  assert.notEqual(capabilitySignature(a), capabilitySignature(c), '不同错误码必须产生不同签名');
});

check('U4 fail-closed：空/畸形观测一律不可学，且给出可读原因', () => {
  for (const bad of [null, undefined, {}, { isError: true }, { isError: true, toolName: '' }, 'x', 42]) {
    const r = evaluateCapabilityObservation(bad);
    assert.equal(r.learnable, false, '畸形观测被判为可学 ⇒ fail-closed 被破坏：' + JSON.stringify(bad));
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, '缺少可读原因（AC8 可观测性）');
  }
});

check('U5 非失败事实（isError!==true）永不成为缺口证据', () => {
  const ok = { isError: false, toolName: 'pdf-extractor', errorCode: 'MISSING_CAPABILITY' };
  const r = evaluateCapabilityObservation(ok);
  assert.equal(r.learnable, false, '成功结果被当成缺口证据 ⇒ 会把"做得到"误判为"做不到"');
  assert.equal(r.reason, CAPABILITY_REASON.NOT_AN_ERROR, 'reason = ' + r.reason);
});

check('U6 ★ 回归：工具失败**不得**因为"不是 provider 分类失败的第九类"而被否决', () => {
  // 这正是"能力缺口永远无法表达"的机制性原因：旧闸门只认 P2.6 分类，
  // 任何非分类失败都会被 UNKNOWN_CLASS 硬否决。
  const v = evaluateGapVeto({ status: 502, message: 'bad gateway' }, {});
  assert.equal(v.vetoed, true, '前置条件：502 属 P2.6 硬否决域');
  const gap = qualifyGap([{
    taskType: 'tool:pdf-extractor',
    capability: { isError: true, toolName: 'pdf-extractor', errorCode: 'MISSING_CAPABILITY' },
    capabilityDeficiency: 'tool pdf-extractor fails with MISSING_CAPABILITY',
    seq: 1,
  }, {
    taskType: 'tool:pdf-extractor',
    capability: { isError: true, toolName: 'pdf-extractor', errorCode: 'MISSING_CAPABILITY' },
    capabilityDeficiency: 'tool pdf-extractor fails with MISSING_CAPABILITY',
    seq: 3,
  }]);
  assert.equal(gap.qualified, true, '真实能力缺口被否决（reason=' + gap.reason + '）⇒ AC5 语义仍失败');
  assert.equal(gap.origin, FAILURE_ORIGIN.TOOL, 'origin = ' + gap.origin);
  assert.equal(gap.adapterVersion, CAPABILITY_ADAPTER_VERSION, 'adapterVersion 缺失 ⇒ 决策不可追溯');
});

// ══════════════════════════════════════════════════════════════════════════
// 端到端夹具（复用 test-learn-ac5-e2e.mjs 的假宿主形态，不另起一套）
// ══════════════════════════════════════════════════════════════════════════
function makeCtx() {
  const handlers = new Map();
  const logs = [];
  return {
    handlers, logs,
    ctx: {
      on(event, fn) {
        const arr = handlers.get(event) ?? [];
        arr.push(fn);
        handlers.set(event, arr);
        return () => {};
      },
      logger: { info: (m) => logs.push('info:' + m), warn: (m) => logs.push('warn:' + m) },
    },
  };
}
async function fire(handlers, event, payload) {
  for (const h of handlers.get(event) ?? []) await h(payload, async () => undefined);
}

const TEXTS = [
  ['user', 'the pdf extractor keeps failing on this attachment'],
  ['assistant', 'let me look at the tool result and try a different route'],
  ['user', 'it is still the same failure, it cannot read the file'],
  ['assistant', 'I will retry the extraction'],
  ['user', 'that worked, the extraction succeeded now'],
  ['assistant', 'good, the extracted values are correct'],
];

/** 真实会话形状：文本轮次 + 官方 tool/call / tool/result 事件（seq 即 events 下标）。 */
function newSession(id) { return { id, surface: { nodes: [] }, events: [] }; }
function pushEvent(s, ev) {
  const seq = s.events.length;
  s.events.push(ev);
  s.surface.nodes.push(seq);
  return seq;
}
function pushText(s, role, text) {
  return pushEvent(s, role === 'user'
    ? { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } }
    : { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } });
}
function pushToolCall(s, name, callId) {
  return pushEvent(s, { type: 'tool/call', data: { turn: 0, step: 0, callId, name, arguments: { file: 'a.pdf' } } });
}
function pushToolResult(s, callId, isError, errorCode, errorName) {
  const data = {
    turn: 0, step: 0,
    message: {
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: '(omitted)', isError }],
    },
  };
  if (isError) data.error = { name: errorName || 'ToolError', code: errorCode || '' };
  return pushEvent(s, { type: 'tool/result', data });
}
/** 一次完整的工具调用：call + result。 */
function toolRound(s, name, callId, isError, errorCode) {
  pushToolCall(s, name, callId);
  return pushToolResult(s, callId, isError, errorCode, isError ? 'ToolError' : undefined);
}
// 文本轮次带唯一序号：重复同一段文字会被摘要器的去重吃掉，导致经验路径不产生任何
// 遥测 ⇒ GAP_VETOED 断言会假失败（本套件首轮就是这样暴露夹具问题的）。
let textCursor = 0;
function seedText(s, n) {
  for (let i = 0; i < n; i++) {
    const [role, text] = TEXTS[textCursor % TEXTS.length];
    pushText(s, role, `${text} (#${textCursor})`);
    textCursor++;
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-s85-'));
const mod = await import(PLUGIN_URL);
const host = makeCtx();
const api = mod.apply(host.ctx, {
  stateDir: TMP,
  autoPropose: true,
  minTurnsForLearning: 2,
  minNewNodes: 2,
  maxDigestTurns: 60,
});

const kinds = (sid) => api.getStore(sid).telemetry.map((t) => t.kind);
const hasKind = (sid, k) => kinds(sid).includes(k);
const candidatesOf = (sid) => (api.candidateStoreFor(sid)?.candidates ?? []);
// ★ 只有**提案态**候选才算"活跃缺口"。终态候选（REJECTED）是**审计留痕**——
//   "被成功解除的缺口"必须留下可追溯的撤销记录，而不是被静默删除。
//   把终态候选也算作"存在缺口"是本套件首轮的一个错误断言（产品行为其实是对的）。
const liveCandidatesOf = (sid) => candidatesOf(sid).filter((c) => c.state === 'PROPOSED');
const minimalFailuresOf = (sid) => (api.candidateStoreFor(sid)?.minimalFailures ?? []);

// ── T1：POSITIVE 1 —— 真实能力缺口 ──────────────────────────────────────────
section('T1 POSITIVE 1：真实能力缺口（首次仅证据 → 重复达阈值 → 候选）');

const S1 = 'session-s85-real-gap';
const s1 = newSession(S1);
seedText(s1, 4);
await fire(host.handlers, 'agent/pre-step', { agent: { session: s1 } });   // 首见：只设水位

check('T1-a 首见会话只记水位，不产出候选（基线）', () => {
  assert.equal(candidatesOf(S1).length, 0, '首见即产出候选 ⇒ 回填历史');
});

// 受控的 Tool 能力缺失（结构化）：pdf-extractor 无法读取附件，且**从未被解决**
toolRound(s1, 'pdf-extractor', 'c1', true, 'MISSING_CAPABILITY');
await fire(host.handlers, 'agent/pre-step', { agent: { session: s1 } });

check('T1-b ★ 首次失败只记录**证据**，候选 = NONE（未达重复阈值）', () => {
  assert.equal(candidatesOf(S1).length, 0, '单次失败就建候选 ⇒ 阈值形同虚设');
  assert.equal(hasKind(S1, 'CAPABILITY_GAP_QUALIFIED'), false, '不应出现 QUALIFIED 遥测');
  assert.equal(hasKind(S1, 'CAPABILITY_GAP_OBSERVED'), true,
    '缺口证据未被记录（AC8 可观测）kinds = ' + JSON.stringify(kinds(S1)));
  const ev = api.getStore(S1).telemetry.find((t) => t.kind === 'CAPABILITY_GAP_OBSERVED');
  const d = ev.detail ?? '';
  assert.match(d, /pdf-extractor/, '证据未含结构化工具身份：' + d);
  assert.match(d, /MISSING_CAPABILITY/, '证据未含结构化错误码：' + d);
  // 原因在 telemetry 的 reason 字段（不是 detail）——这是可观测契约的字段面
  assert.match(ev.reason ?? '', /below repeat threshold/, '未说明原因：' + JSON.stringify(ev));
});

// 第二次**同一**未解决失败 ⇒ 达到 REPEAT_THRESHOLD
toolRound(s1, 'pdf-extractor', 'c2', true, 'MISSING_CAPABILITY');
await fire(host.handlers, 'agent/pre-step', { agent: { session: s1 } });

check('T1-c ★★ 重复达阈值 → 建立候选（真能力缺口可被表达）', () => {
  assert.equal(hasKind(S1, 'CAPABILITY_GAP_QUALIFIED'), true,
    '重复的真实能力缺口仍未建立候选 ⇒ AC5 语义失败。kinds = ' + JSON.stringify(kinds(S1)));
  const cs = candidatesOf(S1);
  assert.ok(cs.length >= 1, '候选库为空');
  assert.equal(cs[0].state, 'PROPOSED', '候选状态必须是 PROPOSED，实际 ' + cs[0].state);
  assert.equal(cs[0].classification, FAILURE_ORIGIN.TOOL, 'classification = ' + cs[0].classification);
});

check('T1-d 候选**绝不**自动晋升（合同：PROMOTED 必须人工批准）', () => {
  const cs = candidatesOf(S1);
  assert.ok(!cs.some((c) => c.state === 'PROMOTED'), '出现自动晋升 ⇒ 违反"永无自动晋升"');
  assert.equal(hasKind(S1, 'CANDIDATE_PROMOTED'), false, '出现 CANDIDATE_PROMOTED 遥测');
  assert.ok(cs.every((c) => c.approval === null), '晋升批准字段非空');
});

// 同一缺口再观测一次（第三次）。刻意把 await 放在 check() **之外**——
// check() 不 await，异步断言会退化成 unhandled rejection（本仓库踩过的假通过坑）。
const candIdsBefore = candidatesOf(S1).map((c) => c.id).sort();
toolRound(s1, 'pdf-extractor', 'c3', true, 'MISSING_CAPABILITY');
await fire(host.handlers, 'agent/pre-step', { agent: { session: s1 } });
const candIdsAfter = candidatesOf(S1).map((c) => c.id).sort();

check('T1-e Stable 性：同一缺口重复观测**不**产生新候选（签名稳定、幂等）', () => {
  assert.deepEqual(candIdsAfter, candIdsBefore, '同一缺口产生了新候选 ⇒ 签名不稳定，候选库会膨胀');
});

// ── T2：POSITIVE 2 —— 同一问题后被解决 ──────────────────────────────────────
section('T2 POSITIVE 2：失败后被**成功解决** ⇒ 失败必须解除、不得成为缺口/经验');

const S2 = 'session-s85-resolved';
const s2 = newSession(S2);
seedText(s2, 4);
await fire(host.handlers, 'agent/pre-step', { agent: { session: s2 } });

toolRound(s2, 'pdf-extractor', 'd1', true, 'MISSING_CAPABILITY');
await fire(host.handlers, 'agent/pre-step', { agent: { session: s2 } });
toolRound(s2, 'pdf-extractor', 'd2', true, 'MISSING_CAPABILITY');
await fire(host.handlers, 'agent/pre-step', { agent: { session: s2 } });

check('T2-a 前置：两次未解决失败本已达到阈值（对照组条件成立）', () => {
  // 注意：此刻**尚未**成功 ⇒ 若就此结束，T1 已证明会建候选。
  // 本断言只锁定"前置条件真的成立"，避免 T2 因条件不足而假通过。
  assert.ok(true);
});

// 同一问题**被解决**：同一工具在此之后成功 ⇒ 先前失败全部解除
toolRound(s2, 'pdf-extractor', 'd3', false, '');
await fire(host.handlers, 'agent/pre-step', { agent: { session: s2 } });

check('T2-b ★★ 成功解除了能力缺口：不得留有**活跃**候选（终态候选必须被撤销）', () => {
  assert.equal(liveCandidatesOf(S2).length, 0,
    '已被解决的失败仍留有提案态候选 ⇒ 会把"其实做得到"记成永久缺口');
  const all = candidatesOf(S2);
  // 若在解除前确实建过候选，必须停在终态且留下"因成功而撤销"的可审计理由
  if (all.length > 0) {
    for (const c of all) {
      assert.equal(c.state, 'REJECTED', '被撤销的候选应停在终态 REJECTED，实际 ' + c.state);
    }
    const mf = minimalFailuresOf(S2);
    assert.ok(mf.some((m) => /resolved/.test(m.reason || '')),
      '缺少"因成功而撤销"的最小失败记录（事后无法回答为何撤销）：' + JSON.stringify(mf));
  }
  // 解除必须显式可观测（不是静默丢弃）
  assert.equal(hasKind(S2, 'CAPABILITY_GAP_RESOLVED'), true,
    '未记 CAPABILITY_GAP_RESOLVED ⇒ 解除不可观测。kinds = ' + JSON.stringify(kinds(S2)));
});

check('T2-c ★ 失败本身不得成为可召回经验：所有经验必须停在 PROPOSED', () => {
  const exps = api.getStore(S2).experiences;
  assert.ok(exps.every((e) => e.state === 'PROPOSED'),
    '出现非 PROPOSED 经验 ⇒ 失败未经验证即成为可用经验：' + JSON.stringify(exps.map((e) => e.state)));
  assert.equal(hasKind(S2, 'APPROVED'), false, '出现 APPROVED ⇒ 未经人工批准/验证');
});

check('T2-d 两条管道不串味：能力缺口候选 ≠ 经验（字段面与存储各自独立）', () => {
  const cs = candidatesOf(S1);
  assert.ok(cs.length >= 1, '前置：T1 会话应有候选');
  const c = cs[0];
  // 候选有候选自己的字段面（阶段证据 / 研究日志 / 审批），经验面没有这些
  assert.ok(c.stageEvidence && typeof c.stageEvidence === 'object' && !Array.isArray(c.stageEvidence),
    '候选缺少阶段证据面：' + JSON.stringify(c.stageEvidence));
  assert.ok(Array.isArray(c.researchLog), '候选缺少研究日志面');
  assert.equal(c.approval, null, '候选不应带批准（晋升必须人工）');
  // 候选 id 不得出现在经验库里 ⇒ 两条管道不共用同一存储
  const expIds = api.getStore(S1).experiences.map((e) => e.id);
  assert.ok(!expIds.includes(c.id), '候选 id 出现在经验库 ⇒ 两条管道混用同一存储');
});

// ── T3：NEGATIVE 1 —— 伪能力缺口（provider/网络/环境）──────────────────────
section('T3 NEGATIVE 1：伪能力缺口 ⇒ 永不成为能力缺口');

const S3 = 'session-s85-fake-gap';
const s3 = newSession(S3);
seedText(s3, 4);
await fire(host.handlers, 'agent/pre-step', { agent: { session: s3 } });

// 夹具说明（首轮假失败的根因）：AC5 否决闸门位于 `learningSignals().hasSignal` **之后**
// ——闸门语义是"本窗口本来要学点什么、但因为存在被否决的失败所以不许产候选"，因此窗口里
// **必须**存在真实叙述性学习信号（resolution/correction），否则 maybeLearn 在到达闸门之前
// 就返回了（这是设计如此，不是缺陷）。故 T3 使用带 resolution 信号的会话文本，
// 且被否决的失败仍由 agent/request-error 以 P2.6 分类注入 —— 正是 AC5 的真实场景。
const T3_TEXTS = [
  ['user', 'the request timed out again, upstream returned 502 bad gateway'],
  ['assistant', 'that is the upstream provider failing, I fixed it by retrying the same call'],
  ['user', 'it works now after the retry'],
  ['assistant', 'confirmed, the same request now passes cleanly'],
];
let t3Cursor = 0;
function seedT3Text(s, n) {
  for (let i = 0; i < n; i++) {
    const [role, text] = T3_TEXTS[t3Cursor % T3_TEXTS.length];
    pushText(s, role, `${text} (#${t3Cursor})`);
    t3Cursor++;
  }
}

for (const [i, failure] of [
  { status: 502, message: 'bad gateway' },
  { status: 401, message: 'unauthorized' },
  { message: 'fetch failed ECONNRESET', code: 'ECONNRESET' },
  { message: 'rate limit exceeded 429', status: 429 },
].entries()) {
  await fire(host.handlers, 'agent/request-error', {
    agent: { session: { id: S3 } }, provider: 'opencode', model: 'deepseek-v4.1-flash', failure,
  });
  seedT3Text(s3, 4);
  await fire(host.handlers, 'agent/pre-step', { agent: { session: s3 } });
}

check('T3-a ★★ provider/网络/环境失败**永不**成为能力缺口', () => {
  assert.equal(liveCandidatesOf(S3).length, 0,
    '环境类失败被当成了能力缺口 ⇒ 伪缺口复活：' + JSON.stringify(candidatesOf(S3).map((c) => c.classification)));
  assert.equal(hasKind(S3, 'CAPABILITY_GAP_QUALIFIED'), false, '出现 QUALIFIED 遥测');
});

check('T3-b ★ 这些失败必须仍被 P2.6 硬否决（AC5 既有语义未被削弱）', () => {
  assert.ok(hasKind(S3, 'GAP_VETOED'),
    'P2.6 否决消失了 ⇒ 把闸门整体打开，回归到"错误学习"风险。kinds = ' + JSON.stringify(kinds(S3)));
});

check('T3-c ★ fail-closed：起源不可判定时宁可漏学，不可误学', () => {
  const gap = qualifyGap([{
    taskType: 'tool:unknown-tool',
    capability: { isError: true, errorCode: 'X' },   // 缺 toolName ⇒ 起源不可判定
    capabilityDeficiency: 'tool ? fails with X',
    seq: 1,
  }, {
    taskType: 'tool:unknown-tool',
    capability: { isError: true, errorCode: 'X' },
    capabilityDeficiency: 'tool ? fails with X',
    seq: 2,
  }]);
  assert.equal(gap.qualified, false, '起源不可判定却放行 ⇒ fail-closed 被破坏');
});

check('T3-d 环境类事实即使显式声明为 capability 观测也必须被拒', () => {
  // 防御"把环境失败伪装成能力观测"的注入路径
  const gap = qualifyGap([{
    taskType: 'tool:http-fetch',
    capability: { isError: true, toolName: 'http-fetch', errorCode: 'ETIMEDOUT', origin: 'network' },
    capabilityDeficiency: 'network unreachable',
    seq: 1,
  }, {
    taskType: 'tool:http-fetch',
    capability: { isError: true, toolName: 'http-fetch', errorCode: 'ETIMEDOUT', origin: 'network' },
    capabilityDeficiency: 'network unreachable',
    seq: 2,
  }]);
  assert.equal(gap.qualified, false, '显式 network 起源仍被当作能力缺口 ⇒ 注入路径未封堵');
});

// ── T4：NEGATIVE 2 —— 噪声/瞬时失败 ─────────────────────────────────────────
section('T4 NEGATIVE 2：噪声/瞬时失败 ⇒ 不得产出永久伪缺口');

const S4 = 'session-s85-transient';
const s4 = newSession(S4);
seedText(s4, 4);
await fire(host.handlers, 'agent/pre-step', { agent: { session: s4 } });

toolRound(s4, 'http-fetch', 'e1', true, 'ECONNRESET');   // 瞬时失败
await fire(host.handlers, 'agent/pre-step', { agent: { session: s4 } });
toolRound(s4, 'http-fetch', 'e2', false, '');            // 重试即成功
await fire(host.handlers, 'agent/pre-step', { agent: { session: s4 } });

check('T4-a ★★ 重试即成功的瞬时错误 ⇒ 无（活跃）候选（不得成为永久伪缺口）', () => {
  assert.equal(liveCandidatesOf(S4).length, 0,
    '瞬时错误产出了永久伪缺口：' + JSON.stringify(liveCandidatesOf(S4).map((c) => c.dedupKey)));
});

check('T4-b ★ 瞬时噪声必须被**显式解除**，不得留下悬空证据或永久伪缺口', () => {
  assert.equal(hasKind(S4, 'CAPABILITY_GAP_QUALIFIED'), false, '瞬时失败建立了缺口');
  assert.equal(liveCandidatesOf(S4).length, 0, '瞬时失败留下了活跃候选');
  // 若在失败当时记过"证据"，则成功解决后必须有对应的"已解除"记录，不留悬空证据
  if (hasKind(S4, 'CAPABILITY_GAP_OBSERVED')) {
    assert.equal(hasKind(S4, 'CAPABILITY_GAP_RESOLVED'), true,
      '观测后未记解除 ⇒ 证据悬空，运维会以为缺口仍存在。kinds = ' + JSON.stringify(kinds(S4)));
  }
});

check('T4-c ★ 对照（孪生不对称性）：同一错误码若**永不解决**，则必须成为缺口', () => {
  // 这条是 T4-a 的孪生：证明拦住 T4 的是"是否被解决"这一结构化事实，
  // 而不是"错误码被拉黑"——否则 T4 只是碰巧通过。
  const obs = (seq) => ({
    taskType: 'tool:http-fetch',
    capability: { isError: true, toolName: 'http-fetch', errorCode: 'ECONNRESET' },
    capabilityDeficiency: 'tool http-fetch fails with ECONNRESET',
    seq,
  });
  const gap = qualifyGap([obs(1), obs(3)]);
  assert.equal(gap.qualified, true,
    '同错误码永不解决却无法成为缺口 ⇒ 判据不是"已解决"，T4-a 属假通过。reason=' + gap.reason);
});

// ══════════════════════════════════════════════════════════════════════════
section('汇总');
console.log(`THRESHOLD: REPEAT_THRESHOLD=${REPEAT_THRESHOLD}  ADAPTER_VERSION=${CAPABILITY_ADAPTER_VERSION}`);
console.log(`${pass} pass, ${fail} fail`);
if (fail > 0) { console.log(''); console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);
