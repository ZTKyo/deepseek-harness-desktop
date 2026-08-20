// 查找会话中的 Error 消息（回归检查）
// 用法: node find-errors.cjs <sessionDir>
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
for (const l of lines) {
  let e; try { e = JSON.parse(l); } catch { continue; }
  if (e.type === 'assistant/message') {
    const blocks = e.data?.message?.content ?? [];
    for (const b of blocks) {
      if (b?.type === 'text' && b.text.toLowerCase().includes('error')) {
        console.log(`seq=${e.seq} turn=${e.data?.turn}:`, b.text.slice(0, 300).replace(/\n/g, ' '));
        console.log('---');
      }
    }
  }
  if (e.type === 'tool/result' && e.data?.message?.isError) {
    console.log(`tool/result seq=${e.seq} isError=true`);
  }
}
