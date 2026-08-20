// 确认 tool/result 消息的完整结构 + pruner 对真实结构的测量行为
// 用法: node inspect-toolresult.cjs <sessionDir> <seq>
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
const targetSeq = parseInt(process.argv[3] || '450', 10);
const text = decodeAll(path.join(dir, 'session.jsonl.zstd'));
const lines = text.split('\n').filter(l => l.trim());

// 用真实 pruner 的 measureContent 逻辑验证
function realMeasure(blocks) {
  let chars = 0;
  for (const block of blocks) if (block.type === 'text') chars += Array.from(block.text).length;
  return chars;
}
// 递归测量（应该支持嵌套）
function recursiveMeasure(block) {
  if (!block) return 0;
  if (typeof block === 'string') return block.length;
  if (Array.isArray(block)) return block.reduce((a, b) => a + recursiveMeasure(b), 0);
  if (typeof block === 'object') {
    if (typeof block.text === 'string') return block.text.length;
    if (Array.isArray(block.content)) return block.content.reduce((a, b) => a + recursiveMeasure(b), 0);
  }
  return 0;
}

for (const l of lines) {
  let e; try { e = JSON.parse(l); } catch { continue; }
  if (e.type === 'tool/result' && e.seq === targetSeq) {
    const msg = e.data.message;
    const top = msg.content;
    console.log('=== tool/result seq', targetSeq, '===');
    console.log('message keys:', Object.keys(msg));
    console.log('content[0].type:', top[0]?.type);
    console.log('top-level measureContent (real pruner):', realMeasure(top), 'chars');
    console.log('recursive measure:', recursiveMeasure(top), 'chars');
    console.log('=> pruner WOULD prune (8192 threshold):', recursiveMeasure(top) > 8192 ? 'YES (recursive)' : 'NO', '| with real top-only logic:', realMeasure(top) > 8192 ? 'YES' : 'NO');
    console.log('isError:', msg.isError, '| role:', msg.role, '| source:', JSON.stringify(msg.source).slice(0, 100));
    break;
  }
}
