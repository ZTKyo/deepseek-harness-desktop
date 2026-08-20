// 解码 dsh 会话 jsonl.zstd（多帧容器）并统计事件类型与 usage 数据（只读审计工具）
// 用法: node decode-session.cjs <sessionsRoot> [--top N] [--pattern <substr>] [--list]
const { zstdDecompressSync } = require('node:zlib');
const fs = require('fs');
const path = require('path');

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528

function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('bad magic at ' + offset);
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return frames;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = blockHeader >>> 1 & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('reserved block type');
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return frames;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

function decodeAll(filePath) {
  const buf = fs.readFileSync(filePath);
  const frames = scanZstdFrames(buf);
  const parts = [];
  for (const f of frames) {
    try { parts.push(zstdDecompressSync(buf.subarray(f.start, f.end))); } catch (e) { /* torn frame */ }
  }
  return Buffer.concat(parts).toString('utf8');
}

function collectZstd(root) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 5) return;
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const en of entries) {
      const full = path.join(d, en.name);
      if (en.isDirectory()) walk(full, depth + 1);
      else if (en.name.endsWith('.jsonl.zstd')) {
        let sz; try { sz = fs.statSync(full).size; } catch { continue; }
        out.push({ path: full, size: sz });
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.size - a.size);
}

function analyze(filePath, label) {
  let text;
  try { text = decodeAll(filePath); } catch (e) { console.log(label, 'DECODE FAIL:', e.message); return; }
  const lines = text.split('\n').filter(l => l.trim());
  const types = {};
  let usageCount = 0, usageSample = null, toolResults = 0, toolResultBytes = 0;
  let chunkEvents = 0, reqHeaders = 0, reqContexts = 0, prunes = 0;
  let maxToolResultChars = 0;
  const usageByTurn = [];
  let lastTurn = 0;
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    types[e.type] = (types[e.type] || 0) + 1;
    if (e.type === 'assistant/message' && e.data?.usage) {
      usageCount++;
      if (!usageSample) usageSample = e.data.usage;
      usageByTurn.push({ turn: e.data?.turn ?? lastTurn, step: e.data?.step, usage: e.data.usage });
      lastTurn = e.data?.turn ?? lastTurn;
    }
    if (e.type === 'tool/result') {
      toolResults++;
      const c = e.data?.message?.content;
      if (Array.isArray(c)) for (const b of c) if (b?.type === 'text') {
        toolResultBytes += b.text.length;
        if (b.text.length > maxToolResultChars) maxToolResultChars = b.text.length;
      }
    }
    if (e.type === 'assistant/chunk') chunkEvents++;
    if (e.type === 'request/header') reqHeaders++;
    if (e.type === 'request/context') reqContexts++;
    if (e.type === 'compaction/prune') prunes++;
  }
  console.log(`\n=== ${label} ===`);
  console.log('compressed:', fs.statSync(filePath).size, 'decompressed events:', lines.length);
  console.log('event types:', JSON.stringify(types));
  console.log('assistant/message with usage:', usageCount);
  console.log('tool/result events:', toolResults, '| total text chars:', toolResultBytes, '| max single result chars:', maxToolResultChars);
  console.log('chunk events:', chunkEvents, '| request/header:', reqHeaders, '| request/context:', reqContexts, '| compaction/prune:', prunes);
  if (usageSample) {
    console.log('usage sample:', JSON.stringify(usageSample).slice(0, 500));
    const keys = new Set();
    for (const u of usageByTurn) for (const k of Object.keys(u.usage)) keys.add(k);
    console.log('usage field keys:', [...keys].join(', '));
    let totalInput = 0, totalCached = 0, totalOutput = 0, n = 0;
    for (const u of usageByTurn) {
      const input = u.usage.prompt_tokens ?? u.usage.input_tokens ?? 0;
      const cached = u.usage.prompt_tokens_details?.cached_tokens ?? u.usage.prompt_tokens_details?.cached ?? 0;
      const output = u.usage.completion_tokens ?? u.usage.output_tokens ?? 0;
      totalInput += input; totalCached += cached; totalOutput += output; n++;
    }
    if (n > 0) console.log(`usage totals: input=${totalInput} cached=${totalCached} nonCached=${totalInput - totalCached} output=${totalOutput} calls=${n} avgInput=${Math.round(totalInput / n)} avgNonCached=${Math.round((totalInput - totalCached) / n)} cacheHit=${(100 * totalCached / totalInput).toFixed(1)}%`);
  }
}

const root = process.argv[2];
if (!root) { console.error('usage: node decode-session.cjs <sessionsRoot> [--top N] [--pattern <substr>]'); process.exit(1); }
const files = collectZstd(root);
const top = parseInt(process.argv[3] === '--top' ? process.argv[4] : '3', 10) || 3;
const pat = process.argv[3] === '--pattern' ? process.argv[4] : (process.argv[5] === '--pattern' ? process.argv[6] : null);
let picked = files;
if (pat) picked = files.filter(f => f.path.includes(pat));
if (picked.length === 0) { console.log('no session files matched'); process.exit(0); }
console.log('session files found:', files.length, '| picking top', top, pat ? '(filter: ' + pat + ')' : '');
for (const f of picked.slice(0, top)) {
  analyze(f.path, f.path.split('\\').slice(-3).join('/'));
}
