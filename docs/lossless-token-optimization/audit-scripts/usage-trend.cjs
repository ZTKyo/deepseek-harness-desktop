// 按模型/会话统计 usage 趋势（只读审计）—— 识别每轮 input 增长曲线与 cache 命中
// 用法: node usage-trend.cjs <sessionsRoot> [--top N]
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
  const frames = scanFrames(buf);
  const parts = [];
  for (const f of frames) { try { parts.push(zstdDecompressSync(buf.subarray(f.start, f.end))); } catch {} }
  return Buffer.concat(parts).toString('utf8');
}

function collect(root) {
  const out = [];
  const walk = (d, depth) => { if (depth > 5) return; let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const en of es) { const full = path.join(d, en.name); if (en.isDirectory()) walk(full, depth + 1); else if (en.name.endsWith('.jsonl.zstd')) { let s; try { s = fs.statSync(full).size; } catch { continue; } out.push({ path: full, size: s }); } } };
  walk(root, 0);
  return out.sort((a, b) => b.size - a.size);
}

const root = process.argv[2];
if (!root) { console.error('usage: node usage-trend.cjs <sessionsRoot>'); process.exit(1); }
const files = collect(root);
const top = parseInt(process.argv[3] === '--top' ? process.argv[4] : '6', 10) || 6;

const sessionSummaries = [];
for (const f of files.slice(0, 120)) { // 扫描最多 120 个文件（含小会话），找有 usage 的
  let text; try { text = decodeAll(f.path); } catch { continue; }
  const lines = text.split('\n').filter(l => l.trim());
  let usageCount = 0, totalInput = 0, totalCache = 0, totalOutput = 0, totalReasoning = 0;
  const perCall = [];
  let model = null, provider = null;
  let lastTurn = 0;
  const inputByTurn = new Map();
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'assistant/message' && e.data?.usage) {
      const u = e.data.usage;
      const input = u.inputTokens ?? u.prompt_tokens ?? 0;
      const cache = u.cacheReadTokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
      const output = u.outputTokens ?? u.completion_tokens ?? 0;
      const reasoning = u.reasoningTokens ?? 0;
      totalInput += input; totalCache += cache; totalOutput += output; totalReasoning += reasoning;
      usageCount++;
      perCall.push({ input, cache, output, reasoning });
      const t = e.data?.turn ?? lastTurn; lastTurn = t;
      if (!inputByTurn.has(t)) inputByTurn.set(t, { calls: 0, input: 0, cache: 0 });
      inputByTurn.get(t).input += input; inputByTurn.get(t).cache += cache; inputByTurn.get(t).calls++;
    }
    if (e.type === 'assistant/message') {
      const src = e.data?.message?.source;
      if (src && (src.provider || src.model)) { if (!model) model = src.model; if (!provider) provider = src.provider; }
    }
    if (e.type === 'request/context') {
      if (e.data?.provider) provider = e.data.provider;
      if (e.data?.model) model = e.data.model;
    }
  }
  if (usageCount === 0) continue;
  const turns = [...inputByTurn.entries()].sort((a, b) => a[0] - b[0]);
  const nonCached = totalInput - totalCache;
  sessionSummaries.push({
    file: f.path, usageCount, totalInput, totalCache, totalOutput, totalReasoning,
    nonCached, cacheHitPct: totalInput > 0 ? (100 * totalCache / totalInput).toFixed(1) : 'n/a',
    model, provider, turns: turns.map(([t, v]) => ({ turn: t, input: v.input, cache: v.cache, calls: v.calls }))
  });
}

sessionSummaries.sort((a, b) => b.totalInput - a.totalInput);
console.log('sessions with usage data:', sessionSummaries.length, '\n');
for (const s of sessionSummaries.slice(0, top)) {
  console.log(`=== ${path.basename(path.dirname(s.file))} ===`);
  console.log(`model=${s.model} provider=${s.provider} calls=${s.usageCount}`);
  console.log(`total input=${s.totalInput} cacheRead=${s.totalCache} nonCached=${s.nonCached} output=${s.totalOutput} reasoning=${s.totalReasoning} cacheHit=${s.cacheHitPct}%`);
  console.log(`avg input/call=${Math.round(s.totalInput / s.usageCount)} avg nonCached/call=${Math.round(s.nonCached / s.usageCount)}`);
  // 每 turn 曲线
  const curve = s.turns.map(t => `T${t.turn}:${t.input}i/${t.cache}c`).join(' ');
  console.log('turn curve:', curve.slice(0, 1500));
  console.log('');
}
