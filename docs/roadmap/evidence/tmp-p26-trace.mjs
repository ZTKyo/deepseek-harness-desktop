// p26-trace.mjs — correlate thinking-bearing assistant msgs, surfaceOp replaces, and 400 errors.
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
        const bh = buf.readUIntLE(p, 3);
        p += 3;
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
console.log(`events=${events.length} seq=[${events[0]?.seq}..${events.at(-1)?.seq}]`);

const ERR_RE = /must be passed back/i;
// 1) index thinking-bearing assistant msgs and replace ops
const thinkMsgs = []; // {seq, turn, step}
const replaces = []; // {seq, start, end, type}
const errors = []; // {seq, turn?, step?}
const reqStarts = []; // {seq, ts}
for (const e of events) {
  const t = String(e.type ?? "");
  if (t === "assistant/message") {
    const msg = e.data?.message;
    const hasThink = Array.isArray(msg?.content) && msg.content.some((b) => b?.type === "reasoning");
    thinkMsgs.push({ seq: e.seq, turn: e.data?.turn, step: e.data?.step, hasThink });
  } else if (t !== "assistant/chunk" && e.surfaceOp && typeof e.surfaceOp === "object") {
    replaces.push({ seq: e.seq, start: e.surfaceOp.start, end: e.surfaceOp.end, type: t });
  } else if (t === "request/header") {
    reqStarts.push({ seq: e.seq });
  } else if (t === "assistant/chunk") {
    // cheap scan on serialized chunk for error finish
    if (ERR_RE.test(JSON.stringify(e.data ?? {}).slice(0, 60000))) errors.push({ seq: e.seq });
  }
}
console.log(`thinkMsgs=${thinkMsgs.filter(m=>m.hasThink).length}/${thinkMsgs.length} replaces=${replaces.length} errors=${errors.length}`);
// 2) for each error, walk back: nearest replaces covering a thinking msg
function coveredByReplace(seq, beforeSeq) {
  return replaces.filter((r) => r.seq < beforeSeq && r.start <= seq && seq <= r.end).slice(-3);
}
for (const err of errors.slice(0, 12)) {
  const priorMsgs = thinkMsgs.filter((m) => m.seq < err.seq).slice(-6);
  const lines = [];
  lines.push(`--- ERROR seq=${err.seq}`);
  for (const m of priorMsgs.reverse()) {
    const reps = coveredByReplace(m.seq, err.seq);
    if (m.hasThink || reps.length) {
      lines.push(`  thinkMsg seq=${m.seq} hasThink=${m.hasThink} turn=${m.turn}/${m.step}${reps.length ? " SHADOWED-BY " + reps.map(r=>`#${r.seq}[${r.start}-${r.end}]${r.type}`).join(",") : ""}`);
    }
  }
  console.log(lines.join("\n"));
}
