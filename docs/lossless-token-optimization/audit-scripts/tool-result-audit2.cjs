// 分析单个会话中 tool/result 的真实内容大小（嵌套结构）与 pruner 收益
// 用法: node tool-result-audit2.cjs <sessionDir>
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

function textLenOf(content) {
  if (!content) return 0;
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) return content.reduce((a, b) => a + textLenOf(b), 0);
  if (typeof content === 'object') {
    if (content.type === 'text' && typeof content.text === 'string') return content.text.length;
    if (content.type === 'tool-result' && Array.isArray(content.content)) return content.content.reduce((a, b) => a + textLenOf(b), 0);
    return 0;
  }
  return 0;
}

const dir = process.argv[2];
const file = path.join(dir, 'session.jsonl.zstd');
const text = decodeAll(file);
const lines = text.split('\n').filter(l => l.trim());
const events = [];
for (const l of lines) { try { events.push(JSON.parse(l)); } catch {} }

const results = [];
for (const e of events) {
  if (e.type === 'tool/result') {
    const n = textLenOf(e.data?.message?.content);
    const s = JSON.stringify(e.data?.message?.content ?? {});
    results.push({ seq: e.seq, turn: e.data?.turn, step: e.data?.step, n, hasMarker: s.includes('tool result middle pruned') });
  }
}
results.sort((a, b) => b.n - a.n);
console.log('=== tool/result sizes ===');
console.log('total results:', results.length, '| with prune marker:', results.filter(r => r.hasMarker).length);
const total = results.reduce((a, r) => a + r.n, 0);
console.log('total chars:', total.toLocaleString(), '| avg:', Math.round(total / results.length).toLocaleString());
const over8192 = results.filter(r => r.n > 8192);
const over2048 = results.filter(r => r.n > 2048);
console.log('>8192 chars:', over8192.length, '| sum:', over8192.reduce((a, r) => a + r.n, 0).toLocaleString());
console.log('>2048 chars:', over2048.length, '| sum:', over2048.reduce((a, r) => a + r.n, 0).toLocaleString());
console.log('\ntop 15 largest:');
for (const r of results.slice(0, 15)) console.log(`  seq=${r.seq} turn=${r.turn} step=${r.step} chars=${r.n.toLocaleString()} marker=${r.hasMarker}`);
// 若 >8192 结果未被 prune，说明 pruner 可能没启用或阈值未触发
const unprunedBig = over8192.filter(r => !r.hasMarker);
if (unprunedBig.length > 0 && over8192.length > 0) console.log(`\n!! ${unprunedBig.length}/${over8192.length} results >8192 chars were NOT pruned`);
