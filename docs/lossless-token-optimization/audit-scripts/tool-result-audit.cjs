// 分析单个会话中 tool/result 的内容大小分布与 pruner 是否生效 + cache=0 轮次的调用内容
// 用法: node tool-result-audit.cjs <sessionDir 绝对路径>
const { zstdDecompressSync } = require('node:zlib');
const fs = require('fs');
const path = require('path');

const ZSTD_MAGIC = 4247762216;
function scanFrames(buffer) {
  const frames = []; let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buffer.length) break;
    const d = buffer.readUInt8(offset); offset += 1;
    const csf = d >>> 6, ss = (d & 32) !== 0, chk = (d & 4) !== 0, df = d & 3;
    const db = df === 3 ? 4 : df;
    const csb = csf === 0 ? (ss ? 1 : 0) : 1 << csf;
    const rhb = (ss ? 0 : 1) + db + csb;
    if (buffer.length - offset < rhb) break;
    offset += rhb;
    for (;;) {
      if (buffer.length - offset < 3) return frames;
      const bh = buffer.readUIntLE(offset, 3); offset += 3;
      const last = (bh & 1) !== 0, bt = (bh >>> 1) & 3, bs = bh >>> 3;
      if (bt === 3) throw new Error('bad block');
      const pb = bt === 1 ? 1 : bs;
      if (buffer.length - offset < pb) return frames;
      offset += pb;
      if (last) break;
    }
    if (chk) { if (buffer.length - offset < 4) break; offset += 4; }
    frames.push({ start, end: offset });
  }
  return frames;
}
function decodeAll(filePath) {
  const buf = fs.readFileSync(filePath);
  const parts = [];
  for (const f of scanFrames(buf)) { try { parts.push(zstdDecompressSync(buf.subarray(f.start, f.end))); } catch {} }
  return Buffer.concat(parts).toString('utf8');
}

const dir = process.argv[2];
if (!dir) { console.error('usage: node tool-result-audit.cjs <sessionDir>'); process.exit(1); }
const file = path.join(dir, 'session.jsonl.zstd');
if (!fs.existsSync(file)) { console.error('not found:', file); process.exit(1); }
const text = decodeAll(file);
const lines = text.split('\n').filter(l => l.trim());
const events = [];
for (const l of lines) { try { events.push(JSON.parse(l)); } catch {} }

// 1. tool/result 大小分布
const sizes = [];
const pruned = [];
for (const e of events) {
  if (e.type === 'tool/result') {
    const c = e.data?.message?.content;
    let n = 0;
    if (Array.isArray(c)) for (const b of c) if (b?.type === 'text') n += b.text.length;
    sizes.push({ seq: e.seq, n, name: e.data?.message?.source?.callId, hasPruneMarker: JSON.stringify(c).includes('tool result middle pruned') });
    if (JSON.stringify(c).includes('tool result middle pruned')) pruned.push(e.seq);
  }
}
sizes.sort((a, b) => b.n - a.n);
console.log('=== tool/result sizes (session', path.basename(dir), ') ===');
console.log('total tool/results:', sizes.length, '| pruned(has marker):', pruned.length);
console.log('top 20 largest:');
for (const s of sizes.slice(0, 20)) console.log(`  seq=${s.seq} chars=${s.n.toLocaleString()} pruned=${s.hasPruneMarker}`);
const total = sizes.reduce((a, s) => a + s.n, 0);
const over8192 = sizes.filter(s => s.n > 8192);
const over4096 = sizes.filter(s => s.n > 4096);
console.log(`total tool-result chars: ${total.toLocaleString()}`);
console.log(`results >8192 chars: ${over8192.length} (sum ${over8192.reduce((a,s)=>a+s.n,0).toLocaleString()})`);
console.log(`results >4096 chars: ${over4096.length} (sum ${over4096.reduce((a,s)=>a+s.n,0).toLocaleString()})`);
if (over8192.length > 0) {
  const avg = over8192.reduce((a, s) => a + s.n, 0) / over8192.length;
  console.log(`avg size of >8192 results: ${Math.round(avg).toLocaleString()} chars`);
}

// 2. assistant/message 中 usage.cacheReadTokens === 0 的调用（cache 全丢）
console.log('\n=== calls with cacheReadTokens === 0 (cache fully missed) ===');
let zeroCache = [];
for (const e of events) {
  if (e.type === 'assistant/message' && e.data?.usage) {
    const u = e.data.usage;
    const cache = u.cacheReadTokens ?? 0;
    const input = u.inputTokens ?? 0;
    if (cache === 0 && input > 1000) {
      zeroCache.push({ seq: e.seq, turn: e.data.turn, step: e.data.step, input });
    }
  }
}
console.log('count:', zeroCache.length);
for (const z of zeroCache.slice(0, 15)) console.log(`  seq=${z.seq} turn=${z.turn} step=${z.step} input=${z.input.toLocaleString()}`);

// 3. 每个 tool/call 用的工具名分布（看哪些工具产生大输出）
console.log('\n=== tool call names (top 20) ===');
const callNames = {};
for (const e of events) if (e.type === 'tool/call') {
  callNames[e.data.name] = (callNames[e.data.name] || 0) + 1;
}
const sorted = Object.entries(callNames).sort((a, b) => b[1] - a[1]);
for (const [n, c] of sorted.slice(0, 20)) console.log(`  ${n}: ${c}`);
