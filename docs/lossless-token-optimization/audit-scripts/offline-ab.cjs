// 离线 A/B：对真实会话模拟 tool-output-offload 插件效果
// BEFORE：历史真实行为（大 tool/result 全程驻留 surface）
// AFTER：假设每 step 前裁剪超 8192 字符的 tool/result（head 4096 + tail 1024）
// 指标：每步 deriveMessages 的字符总量（近似 token = chars/4）、峰值、平均值、累计重发量
// 用法: node offline-ab.cjs <sessionDir>
const { zstdDecompressSync } = require('node:zlib');
const fs = require('fs');
const path = require('path');
const ZSTD_MAGIC = 4247762216;
function scanFrames(buffer) { const frames = []; let o = 0;
  while (o < buffer.length) { const start = o; if (buffer.length - o < 4) break; if (buffer.readUInt32LE(o) !== ZSTD_MAGIC) break; o += 4; if (o === buffer.length) break;
    const d = buffer.readUInt8(o); o += 1; const csf = d >>> 6, ss = (d & 32) !== 0, chk = (d & 4) !== 0, df = d & 3; const db = df === 3 ? 4 : df; const csb = csf === 0 ? (ss ? 1 : 0) : 1 << csf; const rhb = (ss ? 0 : 1) + db + csb;
    if (buffer.length - o < rhb) break; o += rhb;
    for (;;) { if (buffer.length - o < 3) return frames; const bh = buffer.readUIntLE(o, 3); o += 3; const last = (bh & 1) !== 0, bt = (bh >>> 1) & 3, bs = bh >>> 3; if (bt === 3) throw Error('bad'); const pb = bt === 1 ? 1 : bs; if (buffer.length - o < pb) return frames; o += pb; if (last) break; }
    if (chk) { if (buffer.length - o < 4) break; o += 4; } frames.push({ start, end: o }); } return frames; }
function decodeAll(fp) { const buf = fs.readFileSync(fp); const parts = []; for (const f of scanFrames(buf)) { try { parts.push(zstdDecompressSync(buf.subarray(f.start, f.end))); } catch {} } return Buffer.concat(parts).toString('utf8'); }

const dir = process.argv[2];
const text = decodeAll(path.join(dir, 'session.jsonl.zstd'));
const lines = text.split('\n').filter(l => l.trim());
const events = [];
for (const l of lines) { try { events.push(JSON.parse(l)); } catch {} }

const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n';
const THRESHOLD = 8192, HEAD = 4096, TAIL = 1024;

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
function messageChars(m) { return Array.isArray(m?.content) ? m.content.reduce((a, b) => a + recursiveChars(b), 0) : 0; }
function pruneMessage(message) {
  const total = messageChars(message);
  if (total <= THRESHOLD) return null;
  const state = { removedStart: HEAD, removedEnd: total - TAIL, consumed: 0, markerInserted: false };
  function rec(block, st) {
    if (block == null || typeof block === 'string') return block;
    if (Array.isArray(block)) return block.map(b => rec(b, st));
    if (typeof block === 'object') {
      if (typeof block.text === 'string') {
        const pts = Array.from(block.text);
        const bs = st.consumed, be = bs + pts.length;
        const he = Math.min(pts.length, Math.max(0, st.removedStart - bs));
        const ts = Math.min(pts.length, Math.max(0, st.removedEnd - bs));
        const mk = bs < st.removedEnd && be > st.removedStart && !st.markerInserted ? PRUNE_MARKER : '';
        if (mk) st.markerInserted = true;
        st.consumed = be;
        return { ...block, text: pts.slice(0, he).join('') + mk + pts.slice(ts).join('') };
      }
      if (Array.isArray(block.content)) return { ...block, content: block.content.map(b => rec(b, st)) };
      return block;
    }
    return block;
  }
  const content = message.content.map(b => rec(b, state));
  if (!state.markerInserted) return null;
  const after = messageChars({ content });
  if (after >= total) return null;
  return { ...message, content };
}

// 重建 surface 序列：按事件顺序维护"当前 surface 上的消息"
// BEFORE：不裁剪，直接按 append 顺序累积 surface 消息
// AFTER：遇到 tool/result 后（下一步前）若超阈值则替换为裁剪版
const surfaceBefore = []; // {kind:'user'|'assistant'|'tool', message, seq}
const surfaceAfter = [];
let prunedTotal = 0, prunedCount = 0;
const steps = []; // 记录每个 assistant/message 步时的 surface 总字符

for (const e of events) {
  if (e.type === 'user/message' && e.surfaceOp === 'append') {
    const m = e.data.message || e.data;
    surfaceBefore.push({ kind: 'user', message: m, seq: e.seq });
    surfaceAfter.push({ kind: 'user', message: m, seq: e.seq });
  } else if (e.type === 'assistant/message' && e.surfaceOp === 'append') {
    const m = e.data.message;
    const beforeChars = surfaceBefore.reduce((a, s) => a + messageChars(s.message), 0) + messageChars(m);
    const afterChars = surfaceAfter.reduce((a, s) => a + messageChars(s.message), 0) + messageChars(m);
    steps.push({ seq: e.seq, beforeChars, afterChars, turn: e.data.turn, step: e.data.step, usage: e.data.usage });
    surfaceBefore.push({ kind: 'assistant', message: m, seq: e.seq });
    surfaceAfter.push({ kind: 'assistant', message: m, seq: e.seq });
  } else if (e.type === 'tool/result' && e.surfaceOp === 'append') {
    const m = e.data.message;
    surfaceBefore.push({ kind: 'tool', message: m, seq: e.seq });
    const pruned = pruneMessage(m);
    if (pruned) {
      surfaceAfter.push({ kind: 'tool', message: pruned, seq: e.seq });
      prunedCount++;
      prunedTotal += messageChars(m) - messageChars(pruned);
    } else {
      surfaceAfter.push({ kind: 'tool', message: m, seq: e.seq });
    }
  }
  // compaction/prune + replace 事件：BEFORE 和 AFTER 都模拟真实行为
  // （BEFORE 会话中已有 prune 事件的话，surface 应该已经替换——但实测没有，
  //   所以这里简化：BEFORE 不做任何 replace 处理，AFTER 同样只对 append 的新结果裁剪）
}

// 统计
const beforeAvg = steps.reduce((a, s) => a + s.beforeChars, 0) / steps.length;
const afterAvg = steps.reduce((a, s) => a + s.afterChars, 0) / steps.length;
const beforeMax = Math.max(...steps.map(s => s.beforeChars));
const afterMax = Math.max(...steps.map(s => s.afterChars));
const beforeSum = steps.reduce((a, s) => a + s.beforeChars, 0);
const afterSum = steps.reduce((a, s) => a + s.afterChars, 0);
const totalBeforeCalls = steps.length;

console.log('=== 离线 A/B: ' + path.basename(dir) + ' ===');
console.log('model calls (steps):', totalBeforeCalls);
console.log('pruned oversized results:', prunedCount, '| total chars removed from surface:', prunedTotal.toLocaleString());
console.log('\n-- 每次模型调用的 surface 字符量 --');
console.log('BEFORE avg chars/call:', Math.round(beforeAvg).toLocaleString(), '| AFTER avg:', Math.round(afterAvg).toLocaleString(), '| reduction:', ((beforeAvg - afterAvg) / beforeAvg * 100).toFixed(1) + '%');
console.log('BEFORE max chars/call:', beforeMax.toLocaleString(), '| AFTER max:', afterMax.toLocaleString(), '| reduction:', ((beforeMax - afterMax) / beforeMax * 100).toFixed(1) + '%');
console.log('BEFORE total replay chars:', beforeSum.toLocaleString(), '| AFTER:', afterSum.toLocaleString(), '| reduction:', ((beforeSum - afterSum) / beforeSum * 100).toFixed(1) + '%');
console.log('estimated tokens (chars/4): BEFORE', Math.round(beforeSum / 4).toLocaleString(), '-> AFTER', Math.round(afterSum / 4).toLocaleString());
console.log('\n-- 每 turn 均值 --');
const byTurn = new Map();
for (const s of steps) {
  if (!byTurn.has(s.turn)) byTurn.set(s.turn, { b: 0, a: 0, n: 0 });
  const t = byTurn.get(s.turn); t.b += s.beforeChars; t.a += s.afterChars; t.n++;
}
for (const [t, v] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`T${t}: BEFORE ${Math.round(v.b / v.n).toLocaleString()} -> AFTER ${Math.round(v.a / v.n).toLocaleString()} chars/call (${v.n} calls)`);
}
