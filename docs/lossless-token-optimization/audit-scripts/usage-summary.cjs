// 按模型统计 usage（修正语义）—— OpenCode/CommandCode 系: input=新增非缓存, cacheRead=缓存命中
// 总上下文/次 = input + cacheRead；cacheHit = cacheRead/(input+cacheRead)
// 用法: node usage-summary.cjs <sessionsRoot> [--model <name>] [--session <id>]
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
  return out;
}

const root = process.argv[2];
const modelFilter = process.argv[3] === '--model' ? process.argv[4] : null;
const sessionFilter = process.argv[3] === '--session' ? process.argv[4] : null;
const files = collect(root);

const perModel = new Map(); // model -> {calls, input, cache, output, reasoning, sessions:Set, perCallInput:[]}
const perSession = [];

for (const f of files) {
  let text; try { text = decodeAll(f.path); } catch { continue; }
  const lines = text.split('\n').filter(l => l.trim());
  const calls = [];
  let model = null, provider = null;
  const seen = new Set();
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'assistant/message') {
      const src = e.data?.message?.source;
      if (src?.model) { if (!model) model = src.model; if (!provider) provider = src.provider; }
      const u = e.data?.usage;
      if (u && e.data?.message?.source?.provider) {
        const key = e.seq;
        if (seen.has(key)) continue; seen.add(key);
        const input = u.inputTokens ?? u.prompt_tokens ?? 0;
        const cache = u.cacheReadTokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
        const output = u.outputTokens ?? u.completion_tokens ?? 0;
        const reasoning = u.reasoningTokens ?? 0;
        calls.push({ input, cache, output, reasoning, turn: e.data?.turn });
      }
    }
    if (e.type === 'request/context') { if (e.data?.provider) provider = e.data.provider; if (e.data?.model) model = e.data.model; }
  }
  if (calls.length === 0) continue;
  const totalInput = calls.reduce((a, c) => a + c.input, 0);
  const totalCache = calls.reduce((a, c) => a + c.cache, 0);
  const totalOutput = calls.reduce((a, c) => a + c.output, 0);
  const totalReasoning = calls.reduce((a, c) => a + c.reasoning, 0);
  const totalCtx = totalInput + totalCache;
  perSession.push({ file: f.path, model, provider, calls: calls.length, totalInput, totalCache, totalOutput, totalReasoning, totalCtx, perCallInput: calls.map(c => c.input) });
  if (!model) continue;
  if (!perModel.has(model)) perModel.set(model, { provider, calls: 0, input: 0, cache: 0, output: 0, reasoning: 0, sessions: new Set(), perCallInput: [] });
  const m = perModel.get(model);
  m.calls += calls.length; m.input += totalInput; m.cache += totalCache; m.output += totalOutput; m.reasoning += totalReasoning;
  m.sessions.add(path.basename(path.dirname(f.path)));
  m.perCallInput.push(...calls.map(c => c.input));
}

console.log('===== PER-MODEL SUMMARY (all sessions with usage) =====\n');
for (const [model, m] of perModel) {
  if (modelFilter && !model.includes(modelFilter)) continue;
  const ctx = m.input + m.cache;
  const hit = ctx > 0 ? (100 * m.cache / ctx).toFixed(1) : 'n/a';
  const sorted = [...m.perCallInput].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  console.log(`MODEL: ${model}  (provider: ${m.provider})`);
  console.log(`  sessions=${m.sessions.size}  calls=${m.calls}`);
  console.log(`  total context (input+cache) = ${ctx.toLocaleString()} tokens`);
  console.log(`  total input(new)  = ${m.input.toLocaleString()}  avg/call=${Math.round(m.input / m.calls).toLocaleString()}`);
  console.log(`  total cacheRead   = ${m.cache.toLocaleString()}  avg/call=${Math.round(m.cache / m.calls).toLocaleString()}`);
  console.log(`  total output      = ${m.output.toLocaleString()}  avg/call=${Math.round(m.output / m.calls).toLocaleString()}`);
  console.log(`  reasoning tokens  = ${m.reasoning.toLocaleString()}`);
  console.log(`  cacheHit% = ${hit}%   median input/call=${med.toLocaleString()}  p90 input/call=${p90.toLocaleString()}`);
  console.log('');
}

if (sessionFilter) {
  console.log(`\n===== SESSION ${sessionFilter} =====`);
  for (const s of perSession) {
    if (!s.file.includes(sessionFilter)) continue;
    const hit = s.totalCtx > 0 ? (100 * s.totalCache / s.totalCtx).toFixed(1) : 'n/a';
    console.log(`${path.basename(path.dirname(s.file))} | ${s.model} | calls=${s.calls} | ctx=${s.totalCtx.toLocaleString()} | input=${s.totalInput.toLocaleString()} | cache=${s.totalCache.toLocaleString()} | cacheHit=${hit}% | output=${s.totalOutput.toLocaleString()}`);
  }
}
