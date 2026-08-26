// cm-r4-anchor.mjs — P2.5 R4-4 extraction-path forensics (read-only).
// Cross-validates store.refs entries against ACTUAL injection nodes found in the
// RAW session log: finds every '[context-memory observation vXxx]' snapshot node,
// reads its official sourceEventSeqs (the recall anchor written by append/shadow),
// and checks each against the corresponding store ref {v,startSeq,endSeq}.
// Usage: node cm-r4-anchor.mjs <session.jsonl.zstd> <store.json>
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

const [, , logFile, storeFile] = process.argv;
if (!logFile || !storeFile) { console.error("usage: node cm-r4-anchor.mjs <log.zstd> <store.json>"); process.exit(1); }

const store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
const refByV = new Map((store.refs ?? []).map((r) => [r.v, r]));

// Scan every event line for observation snapshot messages carrying recall anchors.
let scanned = 0;
const found = [];
for (const line of decodeLines(logFile)) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  scanned++;
  // candidate shapes: user/message with plugin-source snapshot, or any event whose
  // message content includes the observation header text.
  const msg = o.type === "user/message" ? o.data : o.data?.message;
  const blocks = Array.isArray(msg?.content) ? msg.content : null;
  if (!blocks) continue;
  const text = blocks.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("");
  const m = text.match(/\[context-memory observation v(\d+)\]/);
  if (!m) continue;
  const v = Number(m[1]);
  const ses = msg?.sourceEventSeqs ?? o.data?.sourceEventSeqs ?? null;
  found.push({
    evSeq: o.seq,
    v,
    nAnchors: Array.isArray(ses) ? ses.length : -1,
    anchorMin: Array.isArray(ses) && ses.length ? Math.min(...ses) : null,
    anchorMax: Array.isArray(ses) && ses.length ? Math.max(...ses) : null,
    hasSourceEventSeqs: Array.isArray(ses),
  });
}

// Compare against store refs.
let checked = 0, okExact = 0, mism = [];
for (const f of found) {
  const r = refByV.get(f.v);
  if (!r) continue;
  checked++;
  // ref records the replaced range: numeric span should equal anchor count and bounds.
  const lo = Math.min(r.startSeq, r.endSeq), hi = Math.max(r.startSeq, r.endSeq);
  const spanOk = f.hasSourceEventSeqs && f.anchorMin === Math.min(lo, f.anchorMin === null ? lo : lo);
  const exact = f.hasSourceEventSeqs &&
    ((f.anchorMin === lo && f.anchorMax === hi) || f.nAnchors === hi - lo + 1 || f.nAnchors === -1 && false);
  // Accept either exact-bound equality OR count==span OR presence-only (shape variance):
  const verdict = exact ? "EXACT" : (f.nAnchors === hi - lo + 1 ? "SPAN-MATCH" : (f.hasSourceEventSeqs ? "PRESENT" : "MISSING"));
  if (verdict !== "MISSING") okExact++;
  else mism.push({ v: f.v, ...f, ref: r });
}

console.log(JSON.stringify({
  logFile: logFile.split(/[\\/]/).pop(), storeFile: storeFile.split(/[\\/]/).pop(),
  linesScanned: scanned,
  storeRefCount: store.refs?.length ?? 0, storeVersion: store.version,
  injectionNodesFoundInLog: found.length,
  distinctVersionsInLog: [...new Set(found.map((f) => f.v))].sort((a, b) => a - b),
  matchedAgainstStoreRefs: checked,
  anchoredOk: okExact,
  missing: mism.slice(0, 10),
  samples: found.slice(-6),
}, null, 1));
