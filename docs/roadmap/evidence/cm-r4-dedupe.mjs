// cm-r4-dedupe.mjs — R4-5 double-write detector (read-only):
// A shadow projection write is legit only once per distinct replaced range.
// Duplicate identical surfaceOp{op,start,end} declarations OR an observation
// header emitted twice within ONE request turn = duplication defect.
// Usage: node cm-r4-dedupe.mjs <session.jsonl.zstd>
import fs from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const MAGIC = 0xfd2fb528;
function parseFrames(buf) {
  const frames = []; let off = 0;
  while (off + 4 <= buf.length) {
    const m = buf.readUInt32LE(off);
    if (m === MAGIC) {
      let p = off + 4;
      const fhd = buf[p++], single = (fhd >> 5) & 1, cks = (fhd >> 2) & 1, did = fhd & 3, fcs = (fhd >> 6) & 3;
      if (!single) p += 1;
      p += [0, 1, 2, 4][did];
      p += fcs === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcs];
      for (;;) {
        const bh = buf.readUIntLE(p, 3); p += 3;
        const last = bh & 1, bt = (bh >> 1) & 3, bs = bh >> 3;
        if (bt !== 1) p += bs;
        if (last) break;
      }
      if (cks) p += 4;
      frames.push([off, p]); off = p;
    } else if ((m & 0xfffffff0) === 0x184d2a50) off += 8 + buf.readUInt32LE(off + 4);
    else break;
  }
  return frames;
}
function decodeLines(file) {
  const buf = fs.readFileSync(file);
  let text = "";
  for (const [s, e] of parseFrames(buf)) text += zstdDecompressSync(buf.subarray(s, e)).toString("utf8");
  return text.split("\n").filter((l) => l.trim());
}

const logFile = process.argv[2];
function nodeText(o) {
  const out = [];
  const push = (m) => { if (Array.isArray(m?.content)) out.push(m.content.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("")); };
  push(o.data); push(o.data?.message);
  return out.join(" ");
}

const declKeyCounts = new Map();
let turns = 0, lastTurnSeq = -1, curTurnObsHeaders = 0, dupInTurn = 0;
for (const line of decodeLines(logFile)) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  // turn boundary: user/message events start a request turn
  if (o.type === "user/message" && o.data?.message?.role === "user" && !nodeText(o).includes("observation")) {
    if (curTurnObsHeaders > 1) dupInTurn++;
    turns++; curTurnObsHeaders = 0; lastTurnSeq = o.seq;
  }
  const so = o.surfaceOp;
  if (so && typeof so === "object" && so.op === "replace") {
    const k = `${so.start}->${so.end}`;
    declKeyCounts.set(k, (declKeyCounts.get(k) ?? 0) + 1);
  }
  if (/\[context-memory observation v\d+\]/.test(nodeText(o))) curTurnObsHeaders++;
}
if (curTurnObsHeaders > 1) dupInTurn++;

const dups = [...declKeyCounts.entries()].filter(([, n]) => n > 1);
console.log(JSON.stringify({
  totalReplaceDecls: [...declKeyCounts.values()].reduce((a, b) => a + b, 0),
  distinctReplacedRanges: declKeyCounts.size,
  duplicatedRanges: dups.length,
  dupSamples: dups.slice(0, 8),
  userRequestTurnsSeen: turns,
  turnsWithMultipleObservationHeaders: dupInTurn,
}, null, 1));
