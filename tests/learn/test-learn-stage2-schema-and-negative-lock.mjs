// ════════════════════════════════════════════════════════════════════════════
// R2 STAGE 2 — SILENT DEAD-PATH REGRESSION LOCK
//
// 本套件锁两件事，两件都是「曾经真实失效过、且失效时是静默的」：
//
//   Part S — Ground Truth Schema Lock（真实会话）
//     真实工具事实是否被 100% 识别。判据不是"我以为的字段名"，而是**真实会话里
//     实际出现的字段路径**：任何漂移都必须让本套件失败，而不是变成 0 个候选的静默死路径。
//     含**对照实验**（S5）：把真实字段改名后提取结果必须为 0 —— 证明"提取到东西"
//     不是巧合，而是真的读了正确字段。
//
//   Part N — 负例 / 正例锁（任务书 STAGE 2 明确要求）
//     negative：工具成功 / provider 中断 / 网络超时 / 凭据失败 / 无关工具失败
//               ⇒ **不得**产出能力候选（且必须**留痕为"被否决"**，不得静默丢弃）
//     positive：真实能力缺口重复出现 ⇒ **必须**产出候选（防"静默零候选"）
//
// 复用（不新建第二套）：
//   - 会话解码：tests/learn/_real-session-harness.mjs（共享解码器）
//   - 结构化事实：plugins/learn-core.mjs 的 extractToolOutcomes / unresolvedToolFailures
//   - 适配器：plugins/learn-gap-veto.mjs（唯一 Failure Authority 是 P2.6，本套件不重判）
// ════════════════════════════════════════════════════════════════════════════
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as core from '../../plugins/learn-core.mjs';
import * as gapVeto from '../../plugins/learn-gap-veto.mjs';
import {
  FAILURE_ORIGIN, LEARNABLE_ORIGINS, NON_LEARNABLE_ORIGINS, CAPABILITY_REASON,
  CAPABILITY_ADAPTER_VERSION, NON_CAPABILITY_CODES,
  evaluateCapabilityObservation, capabilitySignature, qualifyGap, evaluateGapVeto,
} from '../../plugins/learn-gap-veto.mjs';
import { loadRealSession, listRealSessions, mkCtx, driveHook } from './_real-session-harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PLUGIN_URL = new URL('../../plugins/learn.mjs', import.meta.url).href;

let pass = 0; const failures = [];
function check(label, fn) {
  try { fn(); pass++; console.log(`  ✓ ${label}`); }
  catch (e) { failures.push({ label, msg: e?.message ?? String(e) }); console.log(`  ✗ ${label}\n      ${e?.message ?? e}`); }
}
function section(t) { console.log(`\n${'═'.repeat(6)} ${t}`); }

// ════════════════════════════════════════════════════════════════════════════
// Part S — Ground Truth Schema Lock（真实会话）
// ════════════════════════════════════════════════════════════════════════════
section('S. Ground Truth Schema Lock（真实会话：字段路径漂移 ⇒ 立即失败）');

const CANDIDATES = listRealSessions(500_000).slice(0, 12);
const realSessions = [];
for (const c of CANDIDATES) {
  try {
    const s = loadRealSession(c.p);
    const hasTool = s.events.some((e) => e && (e.type === 'tool/call' || e.type === 'tool/result'));
    if (hasTool) realSessions.push(s);
  } catch { /* 坏文件跳过；由 S1 的计数下限兜底 */ }
}

console.log(`  真实会话候选=${CANDIDATES.length}  含工具事实=${realSessions.length}`);

// ── 形状统计（**从真实数据推导**，不预设我认为的形状）─────────────────────────
const callShape = { total: 0, okCallId: 0, okName: 0, okArgsPresent: 0, okArgsString: 0, argsTypes: new Set(), onNode: 0 };
const resShape = {
  total: 0, okSourceKind: 0, okSourceCallId: 0, okContentArr: 0, okContentType: 0,
  okCallIdMatch: 0, okIsErrorBool: 0, onNode: 0,
  errTrue: 0, errObj: 0, errCodeStr: 0, errTrueNoErrObj: 0, errFalseWithCode: 0,
};
const codeHistogram = new Map();
let beyondUpper = 0;   // seq > max(nodeSeq)：按观察上界设计不提取（实测存在的唯一差额来源）

for (const s of realSessions) {
  const nodeSet = new Set(s.nodes);
  const callIds = new Set();
  const canonical = [...new Set(s.nodes)].filter((q) => Number.isInteger(q) && q >= 0 && q < s.events.length).sort((a, b) => a - b);
  const upper = canonical.length ? canonical[canonical.length - 1] : -1;
  for (const e of s.events) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'tool/call') {
      callShape.total++;
      if (nodeSet.has(e.seq)) callShape.onNode++;
      if (e.seq > upper) beyondUpper++;
      const d = e.data ?? {};
      if (typeof d.callId === 'string' && d.callId.trim()) { callShape.okCallId++; callIds.add(d.callId); }
      if (typeof d.name === 'string' && d.name.trim()) callShape.okName++;
      if ('arguments' in d) {
        callShape.okArgsPresent++;
        callShape.argsTypes.add(typeof d.arguments);
        if (typeof d.arguments === 'string') callShape.okArgsString++;
      }
    } else if (e.type === 'tool/result') {
      resShape.total++;
      if (nodeSet.has(e.seq)) resShape.onNode++;
      const d = e.data ?? {};
      const src = d.message?.source ?? {};
      const c0 = Array.isArray(d.message?.content) ? d.message.content[0] : null;
      if (src.kind === 'tool') resShape.okSourceKind++;
      if (typeof src.callId === 'string' && src.callId.trim()) resShape.okSourceCallId++;
      if (Array.isArray(d.message?.content)) resShape.okContentArr++;
      if (c0 && c0.type === 'tool-result') resShape.okContentType++;
      if (c0 && typeof c0.toolCallId === 'string' && c0.toolCallId === src.callId) resShape.okCallIdMatch++;
      if (c0 && typeof c0.isError === 'boolean') resShape.okIsErrorBool++;
      if (c0 && c0.isError === true) {
        resShape.errTrue++;
        if (d.error && typeof d.error === 'object') resShape.errObj++; else resShape.errTrueNoErrObj++;
        const code = d.error?.code;
        if (typeof code === 'string' && code.trim()) {
          resShape.errCodeStr++;
          codeHistogram.set(code.trim(), (codeHistogram.get(code.trim()) ?? 0) + 1);
        }
      }
      if (c0 && c0.isError === false && typeof d.error?.code === 'string' && d.error.code.trim()) {
        resShape.errFalseWithCode++;
      }
    }
  }
}

console.log(`  tool/call   : ${callShape.total} 条（callId=${callShape.okCallId} name=${callShape.okName} arguments 存在=${callShape.okArgsPresent} 类型=${[...callShape.argsTypes].join('/')}）`);
console.log(`  tool/result : ${resShape.total} 条（isError 布尔=${resShape.okIsErrorBool} callId 配对=${resShape.okCallIdMatch}）`);
console.log(`  真实失败    : isError=true ${resShape.errTrue} 条，带结构化 code ${resShape.errCodeStr} 条，无 error 对象 ${resShape.errTrueNoErrObj} 条`);
console.log(`  真实拓扑    : tool/call 落在节点 seq 上 ${callShape.onNode} 条；tool/result ${resShape.onNode} 条`);
console.log(`  观察上界外  : tool/call seq > max(nodeSeq) ${beyondUpper} 条（按设计不提取）`);

// ── S1：样本量下限（防"没有数据所以通过"的假绿；门槛取自真实数据规模）─────────
check(`S1 ★ 样本量下限：真实工具事实必须真的被读到（call=${callShape.total} result=${resShape.total} 失败=${resShape.errTrue}）`, () => {
  assert.ok(realSessions.length >= 3, `含工具事实的真实会话不足 3 个（实际 ${realSessions.length}）⇒ 本套件无法举证`);
  assert.ok(callShape.total >= 100, `真实 tool/call 过少（${callShape.total}）⇒ 样本不足以锁定 schema`);
  assert.ok(resShape.total >= 100, `真实 tool/result 过少（${resShape.total}）⇒ 样本不足以锁定 schema`);
  assert.ok(resShape.errTrue >= 20, `真实失败样本过少（${resShape.errTrue}）⇒ 负例锁无据`);
});

// ── S2：★ Ground Truth Schema —— 官方字段路径 100% 命中 ───────────────────
check('S2 ★ bring-up：tool/call 官方字段路径 100% 命中（callId / name / arguments）', () => {
  assert.equal(callShape.okCallId, callShape.total, `data.callId 命中 ${callShape.okCallId}/${callShape.total} ⇒ 字段漂移（静默死路径风险）`);
  assert.equal(callShape.okName, callShape.total, `data.name 命中 ${callShape.okName}/${callShape.total} ⇒ 字段漂移`);
  assert.equal(callShape.okArgsPresent, callShape.total, `data.arguments 缺失 ${callShape.total - callShape.okArgsPresent} 条 ⇒ 字段漂移`);
  // ground truth（2026-09-25 实测 560/560）：arguments 是 **JSON 字符串**，不是对象。
  // 本断言是"事实锁"：它记录真实形状，任何类型变化都会被立刻发现（提取器当前不读该字段）。
  assert.equal(callShape.okArgsString, callShape.total,
    `data.arguments 为字符串 ${callShape.okArgsString}/${callShape.total}，实测类型集合={${[...callShape.argsTypes].join(',')}} ⇒ 与已记录的真实形状不一致`);
});

check('S3 ★ bring-up：tool/result 官方字段路径 100% 命中（message.source.callId + content[].tool-result）', () => {
  assert.equal(resShape.okSourceKind, resShape.total, `message.source.kind==='tool' 命中 ${resShape.okSourceKind}/${resShape.total}`);
  assert.equal(resShape.okSourceCallId, resShape.total, `message.source.callId 命中 ${resShape.okSourceCallId}/${resShape.total}`);
  assert.equal(resShape.okContentArr, resShape.total, `message.content 非数组 ${resShape.total - resShape.okContentArr} 条`);
  assert.equal(resShape.okContentType, resShape.total, `content[0].type==='tool-result' 命中 ${resShape.okContentType}/${resShape.total}`);
  assert.equal(resShape.okCallIdMatch, resShape.total, `content[0].toolCallId 与 source.callId 不一致 ${resShape.total - resShape.okCallIdMatch} 条 ⇒ 配对键漂移`);
  assert.equal(resShape.okIsErrorBool, resShape.total, `content[0].isError 非布尔 ${resShape.total - resShape.okIsErrorBool} 条`);
});

// ── S4：结构事实 + 真正的核心不变量 ────────────────────────────────────────
check('S4 ★ 结构事实：isError=true 绝大多数带结构化 error 对象（实测例外已记录，不靠文案判失败）', () => {
  // 实测真相（2026-09-25）：28 条真实失败里有 2 条 data 完全没有 error 键
  // （data 键仅 {message,step,turn}，content[0].content 为对象）。
  // ⇒ 不能断言"100% 必有 error 对象"（那是**我当时想象的**形状，不是事实）。
  // 允许缺口的比例上限设为 15%，既记录真实例外，又能在结构真实劣化时报警。
  const missingRatio = resShape.errTrue ? resShape.errTrueNoErrObj / resShape.errTrue : 0;
  assert.ok(missingRatio <= 0.15,
    `isError=true 缺 error 对象比例 ${(missingRatio * 100).toFixed(1)}%（${resShape.errTrueNoErrObj}/${resShape.errTrue}）⇒ 结构化事实退化，学习路径将被迫退回关键词判失败`);
  assert.ok(resShape.errCodeStr >= resShape.errTrue * 0.8,
    `带结构化 error.code 的比例过低（${resShape.errCodeStr}/${resShape.errTrue}）⇒ 码级判定基础不牢`);
});

check('S5 结构不变量：工具成功（isError=false）不得携带结构化错误码', () => {
  assert.equal(resShape.errFalseWithCode, 0, `成功结果携带 error.code ${resShape.errFalseWithCode} 条 ⇒ 会把"做得到"误判为失败`);
});

// ── S6：Extractor 反向锁 —— 亮路径必须识别真实事实 ──────────────────────────
// ⚠ 实测真相（2026-09-25）：extractToolOutcomes 返回 {calls, failures, successes}，
//   **没有 results 字段**；三者各自受 MAX_TOOL_FACTS=256 上限约束；观察面受
//   max(nodeSeq) 上界约束。断言必须按这些**真实约束**写，否则不是假绿就是假红。
const CAP = core.MAX_TOOL_FACTS;
const boundOf = (s) => {
  const c = [...new Set(s.nodes)].filter((q) => Number.isInteger(q) && q >= 0 && q < s.events.length).sort((a, b) => a - b);
  return c.length ? c[c.length - 1] : -1;
};
// 与提取器**逐字一致**的真实计数（含 block.find 取第一个 tool-result 的语义）
const truthOf = (s) => {
  const upper = boundOf(s);
  let realCalls = 0, realErr = 0, realOk = 0;
  for (const e of s.events) {
    if (!e || e.seq > upper) continue;
    if (e.type === 'tool/call') { realCalls++; continue; }
    if (e.type !== 'tool/result') continue;
    const blocks = Array.isArray(e.data?.message?.content) ? e.data.message.content : [];
    const b = blocks.find((x) => x && typeof x === 'object' && x.type === 'tool-result');
    if (!b) continue;
    if (b.isError === true) realErr++; else realOk++;
  }
  return { realCalls, realErr, realOk, upper };
};
const perSession = realSessions.map((s) => {
  const t = truthOf(s);
  const o = core.extractToolOutcomes(s.events, s.nodes);
  return {
    ...t, calls: o.calls.length, failures: o.failures.length, successes: o.successes.length,
    unresolved: core.unresolvedToolFailures(o).length,
  };
});
const agg = perSession.reduce((a, x) => ({
  calls: a.calls + x.calls, failures: a.failures + x.failures, successes: a.successes + x.successes,
  realCalls: a.realCalls + x.realCalls, realErr: a.realErr + x.realErr, unresolved: a.unresolved + x.unresolved,
}), { calls: 0, failures: 0, successes: 0, realCalls: 0, realErr: 0, unresolved: 0 });
console.log(`  extractToolOutcomes 汇总：calls=${agg.calls}/${agg.realCalls}（真实，含上限 ${CAP}）failures=${agg.failures}/${agg.realErr} successes=${agg.successes} unresolved=${agg.unresolved}`);

check('S6 ★★ 核心（防静默 0 候选）：提取器必须逐会话识别全部真实工具事实', () => {
  for (const [i, x] of perSession.entries()) {
    assert.equal(x.calls, Math.min(x.realCalls, CAP),
      `会话#${i}（上界=${x.upper}）提取 call=${x.calls} ≠ 真实（上限内）=${Math.min(x.realCalls, CAP)} ⇒ 提取器漏读`);
    assert.equal(x.failures, Math.min(x.realErr, CAP),
      `会话#${i} 提取失败=${x.failures} ≠ 真实 isError=true（上限内）=${Math.min(x.realErr, CAP)} ⇒ 失败提取静默失效`);
  }
  assert.ok(agg.successes > 0, '成功事实为 0 ⇒ 解决判定无从生效，失败将永久堆积（伪缺口）');
  assert.ok(agg.unresolved > 0, '未解决失败为 0 ⇒ 能力学习路径在当前真实数据上完全静默');
});

// ── S7：★ 对照实验（差分锁：漂移必须让提取归零）────────────────────────────
check('S7 ★★ 对照实验：把提取器真正读取的字段改名后必须归零（证明 S6 不是恒真式）', () => {
  const s = perSession.map((x, i) => ({ x, s: realSessions[i] })).sort((a, b) => b.x.realErr - a.x.realErr)[0].s;
  const base = core.extractToolOutcomes(s.events, s.nodes);
  assert.ok(base.calls.length > 0, '基线提取为 0 ⇒ 对照实验无意义');
  assert.ok(base.failures.length > 0, '基线失败为 0 ⇒ 未选中含失败的真实会话，对照实验覆盖不到失败判据');
  const drift = [];
  for (const e of s.events) {
    if (!e) continue;
    const c = JSON.parse(JSON.stringify(e));
    if (c.type === 'tool/call' && c.data) { c.data.call_id = c.data.callId; delete c.data.callId; }        // ① 名表键（callId→toolName 的配对）
    if (c.type === 'tool/result') {
      const src = c.data?.message?.source;
      if (src) { src.call_id = src.callId; delete src.callId; }                                            // ② 结果侧配对键
      for (const b of (Array.isArray(c.data?.message?.content) ? c.data.message.content : [])) {
        if (b && b.type === 'tool-result') { b.kind = b.type; delete b.type; b.is_err = b.isError; delete b.isError; }  // ③ 块类型 + 失败布尔
      }
    }
    drift[c.seq] = c;
  }
  const o = core.extractToolOutcomes(drift, s.nodes);
  // 提取器的 calls 是"出现即记"表（callId 是否有效不影响是否入表）——实测语义，故不拿条数当判据。
  // 真正该断言的**后果链**：配对键被毁 ⇒ 名表塌陷（names 需要 callId）⇒ 失败/成功判据全失 ⇒ 学习路径静默。
  assert.ok(o.calls.every((c) => c.callId === ''),
    `改名后 still ${o.calls.filter((c) => c.callId !== '').length} 个 call 仍有 callId ⇒ 提取器读的不是 data.callId`);
  assert.equal(o.failures.length, 0, `改名后仍提取到 ${o.failures.length} 个失败 ⇒ 失败判据并非官方结构化字段（isError/type）`);
  assert.equal(o.successes.length, 0, `改名后仍提取到 ${o.successes.length} 个成功 ⇒ 成功判据并非官方结构化字段`);
  assert.equal(core.unresolvedToolFailures(o).length, 0,
    '改名后仍存在"未解决失败" ⇒ 与配对键无关，S6 的通过可能有假');
  // 反向：剔除漂移的同一会话必须恢复——证明差异只来自字段改名本身
  assert.ok(core.extractToolOutcomes(s.events, s.nodes).failures.length > 0, '基线复算失败 ⇒ 对照实验不成立');
});

// ── S8：★ 真实拓扑 —— 工具事件永不出现在 node seq 上 ──────────────────────
check('S8 ★ 真实拓扑：tool/call 与 tool/result 一律不落在节点 seq 上（历史死路径根因）', () => {
  const totalOnNode = callShape.onNode + resShape.onNode;
  assert.equal(totalOnNode, 0,
    `真实数据中工具事件落在节点 seq 上 ${totalOnNode} 条 ⇒ 与既有认识矛盾，需重新审查触发面判据`);
});

// ════════════════════════════════════════════════════════════════════════════
// Part N — 负例 / 正例锁
// ════════════════════════════════════════════════════════════════════════════
section('N. 负例锁（不得产出候选）与正例锁（必须产出候选）');

// 真实 error.code 总体（由 Part S 的真实数据导出 + 已实测过的全集）
const REAL_NON_CAPABILITY = [
  'TOOL_TIMEOUT', 'WEB_ABORTED', 'WEB_PROVIDER_CREDENTIAL_MISSING', 'UNKNOWN_TOOL',
  'ABORTED', 'ABORTED_BEFORE_DISPATCH', 'ASK_CANCELLED', 'NOT_RESUMABLE',
  'INVALID_ARGS', 'GOAL_ALREADY_EXISTS', 'GOAL_NOT_FOUND', 'GOAL_STALE_REVISION',
  'GOAL_TOOL_AUTHORITY_REQUIRED', 'GOAL_TOOL_INVALID_UPDATE',
];
const REAL_CAPABILITY = [
  'FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_EDIT_NOT_FOUND', 'TOOL_OUTCOME_UNKNOWN',
  'SEARCH_FAILED', 'FS_NOT_FOUND', 'FS_NOT_TEXT', 'INVALID_TOOL_OUTPUT',
  'SEARCH_RAW_OUTPUT_OVERFLOW', 'SEARCH_INVALID_PATTERN', 'FS_AMBIGUOUS_EDIT',
];

check('N1 ★ 负例（网络超时/凭据/provider 中断/取消/调用方误用/无关工具失败）逐个不得成为能力候选', () => {
  const bad = [];
  for (const code of REAL_NON_CAPABILITY) {
    const v = evaluateCapabilityObservation({ isError: true, toolName: 'glob', errorCode: code, errorName: 'ToolError' });
    if (v.learnable !== false) bad.push(`${code}→learnable(true)`);
    else if (v.reason !== CAPABILITY_REASON.NON_CAPABILITY_CODE) bad.push(`${code}→reason=${v.reason}`);
  }
  assert.equal(bad.length, 0, '存在 Fake Gap 放行：' + bad.join(', '));
});

check('N2 ★ 负例：无结构化错误码的失败不得成为能力候选（fail-closed，且防签名塌缩）', () => {
  for (const [label, s] of [
    ['空串', { isError: true, toolName: 'glob', errorCode: '' }],
    ['纯空格', { isError: true, toolName: 'glob', errorCode: '   ' }],
    ['缺字段', { isError: true, toolName: 'glob' }],
    ['null', { isError: true, toolName: 'glob', errorCode: null }],
    ['非字符串', { isError: true, toolName: 'glob', errorCode: 42 }],
  ]) {
    const v = evaluateCapabilityObservation(s);
    assert.equal(v.learnable, false, `${label}：无码失败被判为可学 ⇒ 同工具所有无码失败会并成一桶并凑满阈值`);
    assert.equal(v.reason, CAPABILITY_REASON.MISSING_ERROR_CODE, `${label}：reason=${v.reason}`);
  }
  // 无码与不同的有码失败**签名不同**（证明塌缩点已被闸门挡在门外）
  assert.notEqual(capabilitySignature({ isError: true, toolName: 'glob' }),
    capabilitySignature({ isError: true, toolName: 'glob', errorCode: 'SEARCH_FAILED' }));
});

check('N3 ★ 正例（防静默停学）：真实能力码必须仍可成为候选', () => {
  const bad = [];
  for (const code of REAL_CAPABILITY) {
    const v = evaluateCapabilityObservation({ isError: true, toolName: 'glob', errorCode: code });
    if (v.learnable !== true) bad.push(`${code}→${v.reason}`);
  }
  assert.equal(bad.length, 0, '真实能力缺口被误杀（静默停学）：' + bad.join(', '));
});

check('N4 ★ 否决不静默：码级否决必须给出可读原因码（AC8 可观测性）', () => {
  const v = evaluateCapabilityObservation({ isError: true, toolName: 'glob', errorCode: 'TOOL_TIMEOUT' });
  assert.equal(typeof v.reason, 'string');
  assert.ok(v.reason.length > 0, '否决原因为空 ⇒ 事后无法回答"为什么没学习"');
  assert.ok(Object.values(CAPABILITY_REASON).filter(Boolean).includes(v.reason), `原因码不在枚举内：${v.reason}`);
});

check('N5 ★ 名单卫生：否决表与真能力码互不重叠，且不可变', () => {
  for (const c of REAL_CAPABILITY) assert.ok(!NON_CAPABILITY_CODES.has(c), `${c} 同时出现在否决表与真能力码中 ⇒ 语义自相矛盾`);
  assert.ok(Object.isFrozen(NON_CAPABILITY_CODES), '否决表未冻结 ⇒ 可被运行时篡改');
  assert.equal(CAPABILITY_ADAPTER_VERSION, 2, '适配器版本未随语义变更 bump ⇒ 新旧候选签名不可区分');
});

check('N6 ★ P2.6 域硬否决不变：provider 中断 / 网络超时 / 凭据失败仍被否决', () => {
  const cases = [
    [{ status: 502, message: 'bad gateway' }, {}, 'provider 5xx'],
    [{ status: 504, message: 'gateway timeout' }, {}, '网络超时'],
    [{ status: 401, message: 'unauthorized' }, {}, '凭据失败'],
  ];
  for (const [failure, opts, label] of cases) {
    const v = evaluateGapVeto(failure, opts);
    assert.equal(v.vetoed, true, `${label} 未被硬否决`);
  }
  // 能力适配器侧的对应面：非可学来源一律不可学
  for (const origin of NON_LEARNABLE_ORIGINS) {
    const v = evaluateCapabilityObservation({ origin, isError: true, toolName: 'glob', errorCode: 'SEARCH_FAILED' });
    assert.equal(v.learnable, false, `origin=${origin} 被判可学 ⇒ 外部/瞬态来源重新成为"缺能力"`);
    assert.equal(v.reason, CAPABILITY_REASON.NOT_LEARNABLE_ORIGIN);
  }
  assert.ok(!LEARNABLE_ORIGINS.includes(FAILURE_ORIGIN.UNKNOWN), 'unknown 被列为可学 ⇒ fail-closed 被破坏');
});

// ── N7–N10：端到端（真实拓扑 + 真插件 hook）────────────────────────────────
// 夹具纪律：tool/call 与 tool/result **不**进入 surface.nodes（真实拓扑，S8 已证），
// 因此每次工具失败后追加一个真实文本节点来推动水位——这正是真实会话的生长方式。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-stage2-'));
const mod = await import(PLUGIN_URL);
const host = mkCtx();
const api = mod.apply(host.ctx, {
  stateDir: TMP, autoPropose: true,
  minTurnsForLearning: 2, minNewNodes: 2, maxDigestTurns: 60,
});

let textSeq = 0;
function newSession(id) { return { id, surface: { nodes: [] }, events: [] }; }
function pushText(s, role, text) {
  const seq = s.events.length;
  s.events.push(role === 'user'
    ? { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } }
    : { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } });
  s.surface.nodes.push(seq);            // 只有文本消息是节点（真实拓扑）
  return seq;
}
function pushToolCall(s, name, callId) {
  const seq = s.events.length;
  s.events.push({ type: 'tool/call', data: { turn: 0, step: 0, callId, name, arguments: { pattern: 'x' } } });
  return seq;                            // ★ 刻意**不**入 surface.nodes
}
function pushToolResult(s, callId, isError, errorCode) {
  const seq = s.events.length;
  const data = { turn: 0, step: 0, message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: '(omitted)', isError }] } };
  if (isError) data.error = { name: 'ToolError', code: errorCode || '' };
  s.events.push({ type: 'tool/result', data });
  return seq;                            // ★ 刻意**不**入 surface.nodes
}
function toolRound(s, name, callId, isError, errorCode) {
  pushToolCall(s, name, callId);
  pushToolResult(s, callId, isError, errorCode);
  return pushText(s, 'assistant', `round ${textSeq++} after tool ${name}`);  // 推动水位（真实生长）
}
const kinds = (sid) => api.getStore(sid).telemetry.map((t) => t.kind);
const hasKind = (sid, k) => kinds(sid).includes(k);
const liveCandidatesOf = (sid) => (api.candidateStoreFor(sid)?.candidates ?? []).filter((c) => c.state === 'PROPOSED');

async function seed(sid) {
  const s = newSession(sid);
  for (let i = 0; i < 6; i++) pushText(s, i % 2 === 0 ? 'user' : 'assistant', `seed turn ${textSeq++} about the tool behaviour`);
  await driveHook(host.hooks, s);          // 首见：只设水位
  return s;
}

// ── N7：负例（真实绿：成功）→ 不得产出候选 ─────────────────────────────────
{
  const sid = 'session-stage2-n-all-success';
  const s = await seed(sid);
  toolRound(s, 'glob', 'k1', false, ''); await driveHook(host.hooks, s);
  toolRound(s, 'glob', 'k2', false, ''); await driveHook(host.hooks, s);
  toolRound(s, 'glob', 'k3', false, ''); await driveHook(host.hooks, s);
  check('N7 ★ 负例：工具成功不得产出能力候选（把"做得到"当成"做不到"）', () => {
    assert.equal(liveCandidatesOf(sid).length, 0, '成功结果建立了能力候选');
    assert.equal(hasKind(sid, 'CAPABILITY_GAP_QUALIFIED'), false, '出现 CAPABILITY_GAP_QUALIFIED');
    assert.equal(hasKind(sid, 'CAPABILITY_GAP_OBSERVED'), false, '成功结果被记为缺口证据');
  });
}

// ── N8：负例（网络超时）→ 不得产出候选，且必须留痕为"被否决" ───────────────
{
  const sid = 'session-stage2-n-timeout';
  const s = await seed(sid);
  toolRound(s, 'web-search', 't1', true, 'TOOL_TIMEOUT'); await driveHook(host.hooks, s);
  toolRound(s, 'web-search', 't2', true, 'TOOL_TIMEOUT'); await driveHook(host.hooks, s);
  toolRound(s, 'web-search', 't3', true, 'TOOL_TIMEOUT'); await driveHook(host.hooks, s);
  check('N8 ★★ 负例（端到端）：网络超时 3 次不得产出能力候选', () => {
    assert.equal(liveCandidatesOf(sid).length, 0, '网络超时建立了能力候选 ⇒ Fake Gap');
    assert.equal(hasKind(sid, 'CAPABILITY_GAP_QUALIFIED'), false, '出现 CAPABILITY_GAP_QUALIFIED');
    assert.equal(hasKind(sid, 'GAP_VETOED'), false, 'P2.6 路径的 GAP_VETOED 不应出现（本失败在能力路径）');
  });
  check('N8-b ★★ 否决不静默：必须在遥测里留下"被否决"的证据（防静默死路径）', () => {
    assert.equal(hasKind(sid, 'CAPABILITY_GAP_VETOED'), true,
      '码级否决没有任何遥测 ⇒ 一旦误杀真实缺口，外界只会看到"什么都没发生"。kinds=' + JSON.stringify(kinds(sid)));
    const ev = api.getStore(sid).telemetry.find((t) => t.kind === 'CAPABILITY_GAP_VETOED');
    assert.match(ev.detail ?? '', /TOOL_TIMEOUT|NON_CAPABILITY_CODE/, '留痕未含结构化原因：' + JSON.stringify(ev));
    assert.match(ev.reason ?? '', new RegExp(`adapter=v${CAPABILITY_ADAPTER_VERSION}`), '留痕未写明适配器版本：' + JSON.stringify(ev));
  });
}

// ── N9：负例（多签名非能力失败，真正到达闸门）→ 不得产出候选，且**每个签名都留痕** ──
// 设计要点：4 个**不同**码各 1 次只会停在"低于阈值"（到不了闸门）；
// 故此处让两个非能力码**各达阈值**（2 次），才能真正检验"到达闸门后被否决且留痕"。
{
  const sid = 'session-stage2-n-multi-noncap';
  const s = await seed(sid);
  for (const [i, code] of [
    'WEB_PROVIDER_CREDENTIAL_MISSING', 'WEB_ABORTED',
    'WEB_PROVIDER_CREDENTIAL_MISSING', 'WEB_ABORTED',
  ].entries()) {
    toolRound(s, 'web-fetch', `m${i}`, true, code); await driveHook(host.hooks, s);
  }
  check('N9 ★★ 负例（端到端）：凭据失败 + provider 中断 各达阈值 4 次不得产出候选', () => {
    assert.equal(liveCandidatesOf(sid).length, 0, '非能力类目建立了能力候选');
    assert.equal(hasKind(sid, 'CAPABILITY_GAP_QUALIFIED'), false, '出现 CAPABILITY_GAP_QUALIFIED');
  });
  check('N9-b ★★ 否决不静默（多签名）：两个被否决的签名必须各自留痕', () => {
    const vetos = api.getStore(sid).telemetry.filter((t) => t.kind === 'CAPABILITY_GAP_VETOED');
    assert.ok(vetos.length >= 2,
      `被否决的两个签名只留痕 ${vetos.length} 条 ⇒ 多签名场景下部分否决是静默的。kinds=${JSON.stringify(kinds(sid))}`);
    const joined = vetos.map((v) => `${v.detail ?? ''}${v.reason ?? ''}`).join(' | ');
    assert.match(joined, /WEB_PROVIDER_CREDENTIAL_MISSING/, '缺 WEB_PROVIDER_CREDENTIAL_MISSING 的留痕：' + joined);
    assert.match(joined, /WEB_ABORTED/, '缺 WEB_ABORTED 的留痕：' + joined);
  });
}

// ── N9-c：低于阈值（到不了闸门）→ 无候选但必须**可见**（走 OBSERVED，不得全静默）──
{
  const sid = 'session-stage2-n-below-threshold';
  const s = await seed(sid);
  toolRound(s, 'web-fetch', 'b1', true, 'INVALID_ARGS'); await driveHook(host.hooks, s);
  check('N9-c ★ 低于阈值的非能力失败：无候选但必须可见（不得全静默）', () => {
    assert.equal(liveCandidatesOf(sid).length, 0, '单次失败建立了候选');
    assert.equal(hasKind(sid, 'CAPABILITY_GAP_QUALIFIED'), false, '出现 CAPABILITY_GAP_QUALIFIED');
    const vis = hasKind(sid, 'CAPABILITY_GAP_OBSERVED') || hasKind(sid, 'CAPABILITY_GAP_VETOED');
    assert.ok(vis, '既无 OBSERVED 也无 VETOED ⇒ 该失败完全不可见（静默死路径）。kinds=' + JSON.stringify(kinds(sid)));
  });
}

// ── N10：正例（真能力缺口）→ 必须产出候选（反静默零）──────────────────────
{
  const sid = 'session-stage2-p-real-gap';
  const s = await seed(sid);
  toolRound(s, 'grep', 'p1', true, 'SEARCH_FAILED'); await driveHook(host.hooks, s);
  const afterFirst = liveCandidatesOf(sid).length;
  toolRound(s, 'grep', 'p2', true, 'SEARCH_FAILED'); await driveHook(host.hooks, s);
  check('N10 ★★ 正例（端到端）：真实能力缺口重复达阈值必须产出候选', () => {
    assert.equal(afterFirst, 0, '单次失败就建候选 ⇒ 重复阈值形同虚设');
    assert.equal(hasKind(sid, 'CAPABILITY_GAP_QUALIFIED'), true,
      '真实能力缺口未建立候选 ⇒ 静默零候选（本阶段最危险的回归）。kinds=' + JSON.stringify(kinds(sid)));
    const cs = liveCandidatesOf(sid);
    assert.ok(cs.length >= 1, '候选库为空');
    assert.equal(cs[0].state, 'PROPOSED', '候选状态必须是 PROPOSED（永无自动晋升）');
    assert.equal(cs[0].classification, FAILURE_ORIGIN.TOOL, 'classification=' + cs[0].classification);
    assert.ok(!hasKind(sid, 'CANDIDATE_PROMOTED'), '出现自动晋升');
  });
  check('N10-b 签名含适配器版本 ⇒ 决策可追溯', () => {
    const ev = api.getStore(sid).telemetry.find((t) => t.kind === 'CAPABILITY_GAP_QUALIFIED');
    assert.ok(ev, '缺少 CAPABILITY_GAP_QUALIFIED 遥测');
    assert.match(ev.detail ?? '', new RegExp(`v${CAPABILITY_ADAPTER_VERSION}`), 'QUALIFIED 留痕未含适配器版本：' + JSON.stringify(ev));
  });
}

// ── N11：qualifyGap 组级否决（任一被否决 ⇒ 整组不成立）────────────────────
check('N11 ★ 组级否决：混入一条非能力失败 ⇒ 整组不得成立（不得选择性忽略）', () => {
  const good = { taskType: 'tool:grep', capability: { isError: true, toolName: 'grep', errorCode: 'SEARCH_FAILED' }, capabilityDeficiency: 'tool grep fails with SEARCH_FAILED', seq: 1 };
  const bad = { taskType: 'tool:grep', capability: { isError: true, toolName: 'grep', errorCode: 'TOOL_TIMEOUT' }, capabilityDeficiency: 'tool grep fails with TOOL_TIMEOUT', seq: 2 };
  assert.equal(qualifyGap([good, { ...good, seq: 3 }]).qualified, true, '纯真缺口组被误否决');
  const q = qualifyGap([good, bad]);
  assert.equal(q.qualified, false, '混入非能力失败后仍成立 ⇒ 否决门可被绕过');
  assert.ok(q.vetoedCount >= 1, 'vetoedCount 未记录');
  assert.ok((q.vetoReasons ?? []).includes(CAPABILITY_REASON.NON_CAPABILITY_CODE), 'vetoReasons 未给出可断言原因码：' + JSON.stringify(q.vetoReasons));
});

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(72)}`);
// ⚠ 汇总行必须使用回归跑 run-learn-all-tests.mjs 认识的摘要格式之一
//   （"N PASS / M FAIL"），否则套件即使全绿也会被判 NO-SUMMARY ⇒ FAIL。
if (failures.length === 0) {
  console.log(`STAGE 2 LOCK（Ground Truth Schema + 负例/正例）：${pass} PASS / 0 FAIL`);
  console.log(`${'═'.repeat(72)}`);
  process.exit(0);
} else {
  console.log(`STAGE 2 LOCK（Ground Truth Schema + 负例/正例）：${pass} PASS / ${failures.length} FAIL`);
  for (const f of failures) console.log(`  ✗ ${f.label}\n      ${f.msg}`);
  console.log(`${'═'.repeat(72)}`);
  process.exit(1);
}
