// test-learn-real-topology-tool-events.mjs —— P4 LEARN R2 · 真实事件拓扑回归测试
//
// 存在理由（2026-09-25 命中缺陷固化）：
//   首版 extractToolOutcomes(events, nodeSeqs) 直接遍历 **nodeSeqs** 去找工具事件，
//   但真实会话的 surface 节点**只有** user/message 与 assistant/message：
//     实测真实会话（77 个 tool/result）里，工具事件 seq 与节点 seq **零交集**
//     → outcomes.failures 恒为空 → 能力缺口路径在生产是**死代码**。
//   合成夹具之所以没抓到，是因为夹具把 tool/result 事件当成了 surface 节点
//   （真实 DSH 永不产生的拓扑）—— 夹具迁就实现而非现实。
//
// 本测试的**全部夹具都采用真实拓扑**：节点 seq 与工具事件 seq 严格分离。
// 任何"依赖工具事件落在节点 seq 上"的实现都会在这里失败。
//
// 判据来源（官方结构化契约，非关键词）：
//   dsh-agent-loop: session.append("tool/call", {turn,step,callId,name,arguments})
//                   session.append("tool/result", {turn,step,message,error?})
//   dsh-llm:        createToolResultMessage → message.source={kind:'tool',callId},
//                   content=[{type:'tool-result',toolCallId,content,isError}]
//   （已由 _diag-s85-real-shape.mjs 在真实会话上实测 77/77 一致）
//
// 用法：node tests/learn/test-learn-real-topology-tool-events.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as core from '../../plugins/learn-core.mjs';
import * as learn from '../../plugins/learn.mjs';
import { mkCtx, driveHook } from './_real-session-harness.mjs';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

// ══════════════════════════════════════════════════════════════════════════
// 真实拓扑构造器：节点（user/assistant 消息）与工具事件（call/result）分离
// ══════════════════════════════════════════════════════════════════════════
function realTopologySession(spec) {
  // spec = [{turn, userText, tools:[{name, isError, errorCode, errorName}]}...]
  const events = [];
  const nodes = [];
  let seq = 0;
  const push = (type, data) => { events[seq] = { type, seq, time: 1790000000000 + seq, data }; return seq++; };
  push('session', { id: 'x' });
  for (const turn of spec) {
    nodes.push(push('user/message', { content: [{ type: 'text', text: turn.userText }] }));
    push('step/start', { turn: turn.turn, step: 1 });
    for (const t of turn.tools) {
      const callId = `call_${turn.turn}_${t.name}_${Math.random().toString(36).slice(2, 8)}`;
      // ★ 工具事件：不是节点，绝不进 nodes
      push('tool/call', { turn: turn.turn, step: 1, callId, name: t.name, arguments: '{}' });
      const block = {
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: t.isError ? 'boom' : 'ok' }],
        isError: t.isError === true,
      };
      const data = {
        turn: turn.turn, step: 1,
        message: { source: { kind: 'tool', callId }, content: [block] },
      };
      if (t.isError === true && t.errorCode) data.error = { name: t.errorName ?? 'ToolError', code: t.errorCode };
      push('tool/result', data);
    }
    push('step/end', { turn: turn.turn, step: 1 });
    nodes.push(push('assistant/message', { content: [{ type: 'text', text: turn.assistantText ?? 'done' }] }));
  }
  // 真实拓扑自检：节点 seq 与工具事件 seq 必须零交集
  const toolSeqs = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i] && (events[i].type === 'tool/call' || events[i].type === 'tool/result')) toolSeqs.push(i);
  }
  const overlap = toolSeqs.filter((q) => nodes.includes(q));
  return { events, nodes, toolSeqs, overlap };
}

// ══════════════════════════════════════════════════════════════════════════
section('RT0 夹具自检：必须是真实拓扑（节点与工具事件零交集）');
{
  const s = realTopologySession([
    { turn: 1, userText: 'run it', tools: [{ name: 'grep', isError: true, errorCode: 'SEARCH_FAILED' }] },
  ]);
  check('nodes contain only user/assistant messages', s.nodes.every((q) => {
    const t = s.events[q].type;
    return t === 'user/message' || t === 'assistant/message';
  }), s.nodes.map((q) => s.events[q].type).join(','));
  check('tool events exist in the event stream', s.toolSeqs.length >= 2, `toolSeqs=${s.toolSeqs.length}`);
  check('★ tool event seqs ∩ node seqs = ∅ (真实拓扑)', s.overlap.length === 0, `overlap=${JSON.stringify(s.overlap)}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('RT1 真实拓扑下抽取结构化失败事实（旧实现恒为空 = 死代码）');
{
  const s = realTopologySession([
    { turn: 1, userText: 'search logs', tools: [{ name: 'grep', isError: true, errorCode: 'SEARCH_FAILED' }] },
    { turn: 2, userText: 'search again', tools: [{ name: 'grep', isError: true, errorCode: 'SEARCH_FAILED' }] },
  ]);
  const o = core.extractToolOutcomes(s.events, s.nodes);
  check('calls extracted from real topology', o.calls.length === 2, `calls=${o.calls.length}`);
  check('★ failures extracted from real topology (2)', o.failures.length === 2, `failures=${o.failures.length}`);
  check('failures carry toolName', o.failures.every((f) => f.toolName === 'grep'),
    JSON.stringify(o.failures.map((f) => f.toolName)));
  check('failures carry structured errorCode', o.failures.every((f) => f.errorCode === 'SEARCH_FAILED'),
    JSON.stringify(o.failures.map((f) => f.errorCode)));
  check('failures carry official isError=true', o.failures.every((f) => f.isError === true));
  check('capability observation is directly consumable', o.failures.every((f) =>
    f.capability && f.capability.toolName === 'grep' && f.capability.errorCode === 'SEARCH_FAILED'),
    JSON.stringify(o.failures[0]?.capability));
  check('no success recorded (both failed)', o.successes.length === 0, `successes=${o.successes.length}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('RT2 真实拓扑下的"已解决"判定（后续成功 ⇒ 不再是缺口）');
{
  const s = realTopologySession([
    { turn: 1, userText: 'search logs', tools: [{ name: 'grep', isError: true, errorCode: 'SEARCH_FAILED' }] },
    { turn: 2, userText: 'search again', tools: [{ name: 'grep', isError: false }] },
  ]);
  const o = core.extractToolOutcomes(s.events, s.nodes);
  check('one failure + one success extracted', o.failures.length === 1 && o.successes.length === 1,
    `f=${o.failures.length} s=${o.successes.length}`);
  const un = core.unresolvedToolFailures(o);
  check('★ later success on same tool ⇒ failure is RESOLVED (not a gap)', un.length === 0,
    `unresolved=${un.length}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('RT3 观察上界：surface 尚未覆盖到的工具事件不得被计入');
{
  const s = realTopologySession([
    { turn: 1, userText: 'a', tools: [{ name: 'grep', isError: true, errorCode: 'SEARCH_FAILED' }] },
    { turn: 2, userText: 'b', tools: [{ name: 'grep', isError: true, errorCode: 'SEARCH_FAILED' }] },
  ]);
  // 只用第 1 个节点当观察面（第 1 轮结束）
  const firstNodeOnly = [s.nodes[0]];
  const o = core.extractToolOutcomes(s.events, firstNodeOnly);
  check('observation horizon bounds the scan (0 failures before any tool ran)',
    o.failures.length === 0, `failures=${o.failures.length}`);
  const bothNodes = [s.nodes[0], s.nodes[1]];
  const o2 = core.extractToolOutcomes(s.events, bothNodes);
  check('horizon up to turn-1 assistant message sees exactly 1 failure',
    o2.failures.length === 1, `failures=${o2.failures.length}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('RT4 端到端活性：真实拓扑驱动插件 ⇒ 重复真实缺口产出候选（证明非死代码）');
{
  const s = realTopologySession([
    { turn: 1, userText: 'grep for the symbol', tools: [{ name: 'grep', isError: true, errorCode: 'SEARCH_FAILED', errorName: 'SearchError' }] },
    { turn: 2, userText: 'grep again', tools: [{ name: 'grep', isError: true, errorCode: 'SEARCH_FAILED', errorName: 'SearchError' }] },
    { turn: 3, userText: 'grep once more', tools: [{ name: 'grep', isError: true, errorCode: 'SEARCH_FAILED', errorName: 'SearchError' }] },
    { turn: 4, userText: 'ok summary', tools: [] },
  ]);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-rt-'));
  const { ctx, hooks, logs } = mkCtx();
  const api = learn.apply(ctx, {
    stateDir: tmpDir, minNewNodes: 1, minTurnsForLearning: 1, maxDigestTurns: 40,
  });
  const SID = 'rt-' + Date.now();
  const sess = (n) => ({ id: SID, events: s.events, surface: { nodes: s.nodes.slice(0, n) } });
  // 首步只建水位
  await driveHook(hooks, sess(1));
  for (let n = 2; n <= s.nodes.length; n++) await driveHook(hooks, sess(n));

  const diag = logs.join('\n');
  check('telemetry proves the gap path is LIVE (saw a capability-gap diag)',
    /CAPABILITY-GAP/.test(diag), diag.split('\n').filter((l) => /CAPABILITY-GAP/.test(l)).slice(0, 3).join(' | ') || '(none)');
  check('no tool-name-missing veto (toolName present in real topology)',
    !/reason=tool_name_missing/.test(diag), '(saw tool_name_missing)');

  // 候选存于独立候选 store（Stable 不被直接覆盖）
  const cstore = api.candidateStoreFor(SID);
  if (cstore) {
    check('★ candidate produced from REAL topology repeated gap', cstore.candidates.length >= 1,
      `candidates=${cstore.candidates.length}; diag=${diag.split('\n').filter((l) => /CAPABILITY-GAP/.test(l)).slice(0, 2).join(' | ')}`);
    if (cstore.candidates.length) {
      const c = cstore.candidates[0];
      check('candidate state is PROPOSED (never auto-active)', c.state === 'PROPOSED', String(c.state));
      check('candidate taskType is tool-origin', String(c.taskType ?? '').startsWith('tool:'),
        String(c.taskType));
      check('stable experience store NOT overwritten',
        api.getStore(SID).experiences.filter((e) => e.state === 'ACTIVE').length === 0,
        `active=${api.getStore(SID).experiences.filter((e) => e.state === 'ACTIVE').length}`);
    }
  } else {
    check('plugin exposes candidate store accessor', false, 'candidateStoreFor missing');
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('RT5 真实拓扑下的否决：无 toolName 的工具失败不得产出候选（fail-closed）');
{
  // 模拟"工具身份缺失"：tool/result 有 isError，但对应的 tool/call 名表缺失
  const events = [];
  let seq = 0;
  const push = (type, data) => { events[seq] = { type, seq, data }; return seq++; };
  push('session', {});
  const n1 = push('user/message', { content: [{ type: 'text', text: 'a' }] });
  push('step/start', { turn: 1, step: 1 });
  for (let i = 0; i < 3; i++) {
    // 只有 result，没有 call（名字表无法建立）
    push('tool/result', {
      turn: 1, step: 1,
      message: { source: { kind: 'tool', callId: `orphan_${i}` }, content: [{ type: 'tool-result', toolCallId: `orphan_${i}`, content: [{ type: 'text', text: 'x' }], isError: true }] },
      error: { name: 'Unknown', code: 'SOME_CODE' },
    });
  }
  push('step/end', { turn: 1, step: 1 });
  const n2 = push('assistant/message', { content: [{ type: 'text', text: 'done' }] });
  const nodes = [n1, n2];

  const o = core.extractToolOutcomes(events, nodes);
  check('orphan failures have empty toolName', o.failures.length === 3 && o.failures.every((f) => f.toolName === ''),
    `failures=${o.failures.length}`);
  const un = core.unresolvedToolFailures(o);
  check('★ unresolvedToolFailures drops tool-name-missing facts (fail-closed)', un.length === 0,
    `unresolved=${un.length}`);
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${'='.repeat(64)}`);
console.log(`P4 LEARN R2 REAL-TOPOLOGY REGRESSION: ${pass} PASS / ${fail} FAIL`);
if (fail) console.log('FAILED: ' + failures.join(' ; '));
console.log('='.repeat(64));
process.exit(fail ? 1 : 0);
