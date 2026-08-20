// 集成验证：插件协议与 dsh 官方 surface 校验的兼容性
// 用真实 dsh-session 构造 session，注入大 tool/result，跑插件裁剪，验证：
//   1. 裁剪后的替换能通过 assertToolResultRewrite（只改 content）
//   2. compaction/prune shadow 事件格式正确
//   3. 回放 fold 不抛错
const { createRequire } = require('node:module');
const req = createRequire(process.env.USERPROFILE + '/.dsh/profiles/web/x.js');

async function main() {
  const sessionMod = await import('file:///' + (process.env.USERPROFILE + '/.dsh/profiles/node_modules/@deepseek-ai/dsh-session/lib/index.js').replace(/\\/g, '/'));
  const { Session } = sessionMod;

  // 构造一个 session（官方 create 工厂）
  const session = Session.create(
    'test-session-1',
    [],
    { version: 0, id: 'test-session-1', createdAt: Date.now(), cwd: 'C:\\test' }
  );

  // 追加一个 tool/call（真实流程：tool/result 前必有 tool/call）
  const callEvent = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: 'call_test_1',
    name: 'pwsh',
    arguments: '{"command":"test"}'
  });
  const callSeq = callEvent.seq;

  // 追加一个大 tool/result（真实嵌套结构，引用 call seq）
  const bigText = 'HEAD ' + 'x'.repeat(30000) + ' TAIL';
  const toolResultEvent = session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      source: { kind: 'tool', callId: 'call_test_1' },
      content: [{
        type: 'tool-result',
        toolCallId: 'call_test_1',
        content: [{ type: 'text', text: bigText }]
      }],
      role: 'user',
      id: 'msg_test_1'
    }
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] });

  console.log('appended tool/result at seq:', toolResultEvent.seq);
  console.log('surface nodes:', [...session.surface.nodes]);
  console.log('deriveMessages count:', session.deriveMessages().length);

  // 模拟插件逻辑：找到 tool/result，递归测量，裁剪，走 shadow 协议
  const seq = toolResultEvent.seq;
  const event = session.events[seq];
  const message = event.data.message;

  // 递归测量
  function recursiveChars(block) {
    if (block == null) return 0;
    if (typeof block === 'string') return block.length;
    if (Array.isArray(block)) return block.reduce((a, b) => a + recursiveChars(b), 0);
    if (typeof block === 'object') {
      if (typeof block.text === 'string') return block.text.length;
      if (Array.isArray(block.content)) return block.content.reduce((a, b) => a + recursiveChars(b), 0);
    }
    return 0;
  }
  const total = recursiveChars(message);
  console.log('recursive chars:', total, '(should be > 8192)');

  // 递归裁剪
  const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n';
  const HEAD = 4096, TAIL = 1024;
  function recursivePrune(block, state) {
    if (block == null || typeof block === 'string') return block;
    if (Array.isArray(block)) return block.map((b) => recursivePrune(b, state));
    if (typeof block === 'object') {
      if (typeof block.text === 'string') {
        const points = Array.from(block.text);
        const blockStart = state.consumed;
        const blockEnd = blockStart + points.length;
        const headEnd = Math.min(points.length, Math.max(0, state.removedStart - blockStart));
        const tailStart = Math.min(points.length, Math.max(0, state.removedEnd - blockStart));
        const marker = blockStart < state.removedEnd && blockEnd > state.removedStart && !state.markerInserted ? PRUNE_MARKER : '';
        if (marker.length > 0) state.markerInserted = true;
        state.consumed = blockEnd;
        return { ...block, text: points.slice(0, headEnd).join('') + marker + points.slice(tailStart).join('') };
      }
      if (Array.isArray(block.content)) return { ...block, content: block.content.map((b) => recursivePrune(b, state)) };
      return block;
    }
    return block;
  }
  const state = { removedStart: HEAD, removedEnd: total - TAIL, consumed: 0, markerInserted: false };
  const newContent = message.content.map((b) => recursivePrune(b, state));
  const prunedMessage = { ...message, content: newContent };
  const afterChars = recursiveChars(prunedMessage);
  console.log('after chars:', afterChars, '| has marker:', JSON.stringify(prunedMessage).includes(PRUNE_MARKER));

  // 走 shadow 协议
  session.append('compaction/prune', {
    shadowedRange: { start: seq, end: seq },
    shadowedSeqs: [seq],
    shadowedTokenCount: 10000
  });
  const replacement = session.append('tool/result', {
    ...event.data,
    message: prunedMessage
  }, {
    surfaceOp: { op: 'replace', start: seq, end: seq },
    sourceEventSeqs: [seq]
  });
  console.log('replacement seq:', replacement.seq);

  // 验证 surface 折叠结果（回放校验）
  const surface = [...session.surface.nodes];
  console.log('surface nodes after replace:', surface);
  const derived = session.deriveMessages();
  console.log('deriveMessages count after:', derived.length);
  const last = derived[derived.length - 1];
  const lastChars = recursiveChars(last);
  console.log('last message chars (should be ~5140):', lastChars);
  console.log('marker in derived:', JSON.stringify(derived).includes(PRUNE_MARKER));

  const pass = total > 8192 && afterChars < total && afterChars < 6000 && lastChars === afterChars && surface.length === 1;
  console.log('\nOVERALL:', pass ? 'PASS — 协议兼容，裁剪生效，可回源' : 'FAIL');
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
