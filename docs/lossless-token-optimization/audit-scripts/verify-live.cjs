// 验证真实运行会话的 shadow 协议与可回源性
// 用法: node verify-live.cjs <sessionDir>
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

console.log('=== 会话事件类型统计 ===');
const types = {};
for (const e of events) types[e.type] = (types[e.type] || 0) + 1;
console.log(JSON.stringify(types, null, 1));

console.log('\n=== compaction/prune (shadow) 事件 ===');
for (const e of events) if (e.type === 'compaction/prune') console.log(' ', JSON.stringify(e.data));

console.log('\n=== 原始 vs 替换（可回源验证） ===');
for (const seq of [261, 264, 393, 396]) {
  const e = events.find(x => x.seq === seq);
  if (!e) { console.log('seq', seq, 'NOT FOUND'); continue; }
  const t = e.data?.message?.content?.[0]?.content?.[0]?.text ?? '';
  console.log(`seq ${seq}: ${t.length} chars | marker=${t.includes('pruned')} | callId=${e.data?.message?.source?.callId}`);
}

console.log('\n=== surface 替换记录（sourceEventSeqs） ===');
for (const e of events) {
  if (e.type === 'tool/result' && e.sourceEventSeqs && e.sourceEventSeqs.length > 0 && e.surfaceOp && e.surfaceOp.op === 'replace') {
    console.log(`seq ${e.seq} replaces ${e.sourceEventSeqs.join(',')} (${e.surfaceOp.start}-${e.surfaceOp.end})`);
  }
}

console.log('\n=== 会话健康检查 ===');
const turnEnds = events.filter(e => e.type === 'turn/end');
console.log('turn/end count:', turnEnds.length, '| reasons:', turnEnds.map(e => e.data?.reason?.kind).join(', '));
const errors = events.filter(e => e.type === 'assistant/message' && e.data?.message?.content?.some(b => b.type === 'text' && b.text.includes('Error')));
console.log('assistant messages mentioning Error:', errors.length);
