// 检查缓存击穿步前方的事件序列（诊断 cache breaker）
// 用法: node cache-breach-audit.cjs <sessionDir>
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
const file = path.join(dir, 'session.jsonl.zstd');
const text = decodeAll(file);
const lines = text.split('\n').filter(l => l.trim());
const events = [];
for (const l of lines) { try { events.push(JSON.parse(l)); } catch {} }

function brief(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'turn/start': return 'turn/start';
    case 'turn/end': return 'turn/end ' + JSON.stringify(d.reason?.kind);
    case 'step/start': return 'step/start';
    case 'step/end': return 'step/end';
    case 'user/message': return 'user/message src=' + (d.source?.kind || d.source?.plugin || d.message?.source?.kind || '') + ' len=' + String(JSON.stringify(d).length);
    case 'assistant/message': return 'assistant/message usage=' + JSON.stringify(d.usage) + ' tc=' + (d.message?.content?.filter(b => b.type === 'tool-call').length || 0) + ' src=' + (d.message?.source?.model || '');
    case 'tool/call': return 'tool/call ' + d.name;
    case 'tool/result': return 'tool/result';
    case 'request/header': return 'request/header reason=' + d.reason;
    case 'request/context': return 'request/context ' + d.provider + '/' + d.model + ' ctx=' + d.contextWindow;
    case 'compaction/prune': return 'compaction/prune';
    case 'compaction/start': case 'compaction/end': case 'compaction/summary': return e.type;
    default: return e.type;
  }
}

const targets = process.argv[3] ? process.argv[3].split(',').map(Number) : [23, 396, 1359, 1717, 2928, 2939];
for (const t of targets) {
  const idx = events.findIndex(e => e.seq === t);
  if (idx < 0) { console.log('seq', t, 'not found'); continue; }
  console.log('\n======== 击穿步 seq ' + t + ' (turn ' + events[idx].data?.turn + ' step ' + events[idx].data?.step + ') 前方 ========');
  const start = Math.max(0, idx - 16);
  for (let i = start; i <= idx; i++) {
    const e = events[i];
    console.log('  seq=' + e.seq + ' ' + brief(e));
  }
}
