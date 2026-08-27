// p26-peek.mjs — inspect raw assistant/message & chunk block types in a session log.
import fs from "node:fs";
import { zstdDecompressSync } from "node:zlib";
const logFile = process.argv[2];
const MAGIC = 0xfd2fb528;
function parseFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const m = buf.readUInt32LE(off);
    if (m === MAGIC) {
      let p = off + 4;
      const fhd = buf[p++];
      const single = (fhd >> 5) & 1, cks = (fhd >> 2) & 1, did = fhd & 3, fcs = (fhd >> 6) & 3;
      if (!single) p += 1;
      p += [0, 1, 2, 4][did];
      p += [0, 2, 4, 8][fcs];
      for (;;) {
        const bh = buf.readUIntLE(p, 3); p += 3;
        const last = bh & 1, bt = (bh >> 1) & 3, bs = bh >> 3;
        if (bt !== 1) p += bs;
        if (last) break;
      }
      if (cks) p += 4;
      frames.push([off, p]);
      off = p;
    } else if ((m & 0xfffffff0) === 0x184d2a50) off += 8 + buf.readUInt32LE(off + 4);
    else break;
  }
  return frames;
}
const buf = fs.readFileSync(logFile);
let text = "";
for (const [s, e] of parseFrames(buf)) text += zstdDecompressSync(buf.subarray(s, e)).toString("utf8");
const events = [];
for (const line of text.split("\n")) {
  if (!line.trim()) continue;
  try { const o = JSON.parse(line); if (typeof o?.seq === "number") events.push(o); } catch {}
}
// histogram of assistant/message content block types + chunk types
const msgBlocks = {}; const chunkTypes = {}; const sources = {};
let firstMsg = null; let thinkChunkSample = null; let finishKinds = {};
for (const e of events) {
  if (e.type === "assistant/message") {
    const c = e.data?.message?.content;
    if (Array.isArray(c)) for (const b of c) msgBlocks[b?.type ?? "?"] = (msgBlocks[b?.type ?? "?"] ?? 0) + 1;
    else msgBlocks["(non-array:" + typeof c + ")"] = (msgBlocks["(non-array:" + typeof c + ")"] ?? 0) + 1;
    const src = e.data?.message?.source;
    const key = src ? `${src.provider}/${src.model}` : "(none)";
    sources[key] = (sources[key] ?? 0) + 1;
    if (!firstMsg && Array.isArray(c)) firstMsg = { seq: e.seq, blocks: c.map(b => ({ type: b?.type, keys: Object.keys(b ?? {}) })), source: e.data?.message?.source };
  } else if (e.type === "assistant/chunk") {
    const ck = e.data?.chunk;
    const ct = ck?.type ?? "?";
    chunkTypes[ct] = (chunkTypes[ct] ?? 0) + 1;
    if (ct === "thinking_delta" && !thinkChunkSample) thinkChunkSample = { seq: e.seq };
    if (ck?.type === "finish" || ck?.reason) {
      const k = ck?.reason?.kind ?? ck?.type;
      finishKinds[k] = (finishKinds[k] ?? 0) + 1;
    }
  }
}
console.log("assistant/message content block types:", JSON.stringify(msgBlocks));
console.log("assistant/chunk types:", JSON.stringify(chunkTypes));
console.log("finish kinds:", JSON.stringify(finishKinds));
console.log("msg sources:", JSON.stringify(sources));
console.log("first msg:", JSON.stringify(firstMsg));
console.log("first thinking_delta chunk seq:", thinkChunkSample?.seq ?? "NONE IN ENTIRE LOG");
