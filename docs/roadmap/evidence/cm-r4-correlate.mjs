// cm-r4-correlate.mjs — P2.5 R4-4 final correlation (read-only):
//   A) observation injection nodes  "[context-memory observation vXxx]"
//   B) shadow projection declarations  surfaceOp:{op,start,end}
//   C) store refs  {v,startSeq,endSeq}
// Cross-checks B vs C per version; reports coverage, exactness, overlaps.
// Usage: node cm-r4-correlate.mjs <session.jsonl.zstd> <store.json>
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
if (!logFile || !storeFile) { console.error("usage: node cm-r4-correlate.mjs <log.zstd> <store.json>"); process.exit(1); }

const store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
const refByV = new Map((store.refs ?? []).map((r) => [r.v, r]));

function nodeText(o) {
  const cands = [];
  const push = (m) => { if (Array.isArray(m?.content)) cands.push(m.content); };
  push(o.data);
  push(o.data?.message);
  return cands.map((b) => b.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("")).join(" ");
}

const injections = [];   // {evSeq, v}
const replacements = []; // {evSeq, op, start, end}
let lines = 0;
for (const line of decodeLines(logFile)) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  lines++;
  const so = o.surfaceOp;
  if (so && typeof so === "object" && so.op)
    replacements.push({ evSeq: o.seq, op: so.op, start: so.start, end: so.end });
  const t = nodeText(o);
  const m = t.match(/\[context-memory observation v(\d+)\]/);
  if (m) injections.push({ evSeq: o.seq, v: Number(m[1]) });
}

// For each injection, collect nearby (±25 events) replacement declarations.
const WINDOW = 25;
let windowed = 0;
const rows = [];
for (const inj of injections) {
  const near = replacements.filter((r) => Math.abs(r.evSeq - inj.evSeq) <= WINDOW * 40); // seq-space window
  // nearest by |seq distance|
  let best = null, bestD = Infinity;
  for (const r of near) { const d = Math.abs(r.evSeq - inj.evSeq); if (d < bestD) { bestD = d; best = r; } }
  const ref = refByV.get(inj.v) ?? null;
  let verdict = "NO-REPL-NEARBY";
  if (best) {
    windowed++;
    if (!ref) verdict = "NO-REF";
    else {
      const bLo = Math.min(best.start, best.end), bHi = Math.max(best.start, best.end);
      const rLo = Math.min(ref.startSeq, ref.endSeq), rHi = Math.max(ref.startSeq, ref.endSeq);
      verdict = bLo === rLo && bHi === rHi ? "EXACT"
        : (bLo >= rLo && bHi <= rHi ? "DECL-IN-REF" : (bHi - bLo === rHi - rLo ? "SPAN-EQUAL" : "MISMATCH"));
    }
  }
  rows.push({ v: inj.v, injEvSeq: inj.evSeq, replEvSeq: best?.evSeq ?? null,
    decl: best ? `${best.start}..${best.end}` : null, ref: ref ? `${ref.startSeq}..${ref.endSeq}` : null, verdict });
}

const count = (v) => rows.filter((r) => r.verdict === v).length;
const mismatchRows = rows.filter((r) => r.verdict === "MISMATCH" || r.verdict === "NO-REF").slice(0, 12);

// replacement declarations total integrity: how many decls at all, distinct spans, overlap check
const sortedDecls = [...replacements].sort((a, b) => Math.min(a.start, a.end) - Math.min(b.start, b.end));
let overlaps = 0;
for (let i = 1; i < sortedDecls.length; i++) {
  const pLo = Math.min(sortedDecls[i - 1].start, sortedDecls[i - 1].end), pHi = Math.max(sortedDecls[i - 1].start, sortedDecls[i - 1].end);
  const cLo = Math.min(sortedDecls[i].start, sortedDecls[i].end);
  if (cLo <= pHi) overlaps++;
}

console.log(JSON.stringify({
  logLines: lines,
  storeVersion: store.version, storeRefCount: store.refs?.length ?? 0,
  injectionNodes: injections.length,
  distinctVersionsInjected: [...new Set(injections.map((i) => i.v))].sort((a, b) => a - b),
  replacementDecls: replacements.length,
  declOpKinds: [...new Set(replacements.map((r) => r.op))],
  declOverlaps: overlaps,
  correlation: {
    total: rows.length,
    EXACT: count("EXACT"), SPAN_EQUAL: count("SPAN-EQUAL"), DECL_IN_REF: count("DECL-IN-REF"),
    MISMATCH: count("MISMATCH"), NO_REF: count("NO-REF"), NO_REPL_NEARBY: count("NO-REPL-NEARBY"),
  },
  firstInjection: rows[0] ?? null,
  latest6: rows.slice(-6),
  mismatchSamples: mismatchRows,
}, null, 1));
