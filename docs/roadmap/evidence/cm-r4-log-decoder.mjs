// cm-r4-probe.mjs v2 — multi-frame-aware read-only decoder/analyzer for DSH
// session logs (.jsonl.zstd, one independent zstd frame per append batch).
// Walks every frame precisely (magic/header/block headers/checksum), decodes
// each with node:zlib zstdDecompressSync, then extracts request/header routes,
// provider usage records, model switches, and consecutive-step pressure pairs.
// Usage: node cm-r4-probe.mjs <file1.jsonl.zstd> [more...]
import fs from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const FRAME_MAGIC = 0xfd2fb528;

/** Parse exact frame byte ranges of a concatenated-zstd buffer. */
function parseFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const m = buf.readUInt32LE(off);
    if (m === FRAME_MAGIC) {
      let p = off + 4;
      const fhd = buf[p++];
      const singleSegment = (fhd >> 5) & 1;
      const checksum = (fhd >> 2) & 1;
      const didSize = fhd & 3;
      const fcsCode = (fhd >> 6) & 3;
      if (!singleSegment) p += 1;                       // window descriptor
      p += [0, 1, 2, 4][didSize];                        // dictionary id
      p += fcsCode === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsCode]; // content size
      for (;;) {                                         // walk blocks
        if (p + 3 > buf.length) throw new Error(`truncated block header at ${p}`);
        const bh = buf.readUIntLE(p, 3); p += 3;
        const last = bh & 1;
        const btype = (bh >> 1) & 3;
        const bsize = bh >> 3;
        if (btype === 3) throw new Error("reserved block type");
        if (btype !== 1) p += bsize;                     // raw/compressed: skip
        if (last) break;
      }
      if (checksum) p += 4;
      frames.push([off, p]);
      off = p;
    } else if ((m & 0xfffffff0) === 0x184d2a50) {         // skippable frame
      off += 8 + buf.readUInt32LE(off + 4);
    } else break;
  }
  return frames;
}

function decodeLines(file) {
  const buf = fs.readFileSync(file);
  const frames = parseFrames(buf);
  if (!frames.length) throw new Error("no zstd frames found");
  let text = "";
  for (const [s, e] of frames) text += zstdDecompressSync(buf.subarray(s, e)).toString("utf8");
  return { frames: frames.length, rawTailBytes: buf.length - frames[frames.length - 1][1], lines: text.split("\n").filter((l) => l.trim()) };
}

function analyze(file) {
  try {
    var { frames, rawTailBytes, lines } = decodeLines(file);
  } catch (e) {
    return { file, fatal: String(e) };
  }
  const headers = [];
  const usages = [];
  const typeCounts = new Map();
  let route = null;
  let parsed = 0, bad = 0;
  let eventShapeKeys = null;
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); parsed++; } catch { bad++; continue; }
    if (!eventShapeKeys && o.type && o.type !== "session") eventShapeKeys = Object.keys(o);
    if (o.type === "session") continue;
    typeCounts.set(o.type, (typeCounts.get(o.type) ?? 0) + 1);
    if (o.type === "request/header") {
      const cfg = o.data?.header?.config ?? {};
      route = `${cfg.provider ?? "?"}/${cfg.model ?? "?"}`;
      headers.push({ seq: o.seq, time: o.time, key: route });
    }
    let u = null, src = null, tu = null, ts = null;
    if (o.type === "assistant/message" && o.data?.usage && typeof o.data.usage === "object") {
      u = o.data.usage; src = "message"; tu = o.data?.turn; ts = o.data?.step;
    } else if (o.type === "assistant/chunk" && o.data?.chunk?.type === "usage" && typeof o.data.chunk.usage === "object") {
      u = o.data.chunk.usage; src = "chunk"; tu = o.data?.chunk?.turn; ts = o.data?.chunk?.step;
    }
    if (u && typeof u.inputTokens === "number") {
      usages.push({
        seq: o.seq, time: o.time, src, turn: tu, step: ts,
        input: u.inputTokens,
        cR: u.cacheReadTokens ?? 0,
        cW: u.cacheWriteTokens ?? 0,
        out: u.outputTokens ?? 0,
        pressure: u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
        route,
      });
    }
  }
  const switches = [];
  for (let i = 1; i < headers.length; i++)
    if (headers[i].key !== headers[i - 1].key)
      switches.push({ atSeq: headers[i].seq, from: headers[i - 1].key, to: headers[i].key });
  let eqPairs = 0, neqPairs = 0;
  const crossings = [];
  for (let i = 1; i < usages.length; i++) {
    const prev = usages[i - 1], cur = usages[i];
    prev.pressure === cur.pressure ? eqPairs++ : neqPairs++;
    if (prev.route !== cur.route)
      crossings.push({
        betweenRoutes: `${prev.route} -> ${cur.route}`,
        prevPressure: prev.pressure, curPressure: cur.pressure,
        eq: prev.pressure === cur.pressure,
        grewBy: cur.pressure - prev.pressure,
        pairTurnStep: `${prev.turn}/${prev.step} -> ${cur.turn}/${cur.step}`,
        seqs: [prev.seq, cur.seq],
      });
  }
  return {
    file, frames, rawTailBytes, totalLines: lines.length, parsed, bad,
    eventShapeKeys, distinctRoutes: [...new Set(headers.map((h) => h.key))],
    headerCount: headers.length, usageCount: usages.length,
    typeCounts: Object.fromEntries([...typeCounts.entries()].sort()),
    switches: switches.slice(0, 24),
    pairStats: { eqPairs, neqPairs },
    crossings: crossings.slice(0, 40),
    usageFirst3: usages.slice(0, 3),
    usageLast3: usages.slice(-3).map((u) => ({ seq: u.seq, turn: u.turn, step: u.step, src: u.src, pressure: u.pressure, input: u.input, cR: u.cR, cW: u.cW, out: u.out, route: u.route })),
  };
}

const files = process.argv.slice(2);
if (!files.length) { console.error("no files"); process.exit(1); }
const out = [];
for (const f of files) out.push(analyze(f));
process.stdout.write(JSON.stringify(out, null, 1));
