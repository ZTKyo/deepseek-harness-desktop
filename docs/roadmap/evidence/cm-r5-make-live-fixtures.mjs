// make-live-fixtures.mjs — R5-1 REAL live-leg fixture builder (READ-ONLY).
// Decodes the OFFICIAL raw session log (zstd frames) into {seq,type,data} events,
// copies the production CM store, then runs the STRICT recall verifier against both.
// Usage: node make-live-fixtures.mjs <session.jsonl.zstd> <store.json> <core.mjs> <outDir>
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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

const [, , logFile, storeFile, coreFile, outDir] = process.argv;
if (!logFile || !storeFile || !coreFile || !outDir) {
  console.error("usage: node make-live-fixtures.mjs <log.zstd> <store.json> <core.mjs> <outDir>");
  process.exit(64);
}
fs.mkdirSync(outDir, { recursive: true });

console.log("[1/3] decoding raw log ...");
const events = [];
let scanned = 0, skipped = 0;
for (const line of decodeLines(logFile)) {
  scanned++;
  let o; try { o = JSON.parse(line); } catch { skipped++; continue; }
  if (typeof o?.seq !== "number") { skipped++; continue; }
  events.push({ seq: o.seq, type: o.type, data: o.data });
}
const evPath = path.join(outDir, "live-events.json");
fs.writeFileSync(evPath, JSON.stringify(events));
console.log(`  scanned=${scanned} indexed=${events.length} skipped=${skipped}`);

console.log("[2/3] copying store (read-only source) ...");
const stCopy = path.join(outDir, "live-store.json");
fs.copyFileSync(storeFile, stCopy);

console.log("[3/3] running STRICT verifier ...");
const { runStrictRecall } = await import(new URL("./cm-r5-recall-verifier-snapshot.mjs", import.meta.url).href);
const core = await import(new URL("file:///" + coreFile.replace(/\\/g, "/")).href);
const store = JSON.parse(fs.readFileSync(stCopy, "utf8"));
const t0 = Date.now();
const report = runStrictRecall({ events, store, core, kPerClass: 3 });
report.logSeqRange = [events[0]?.seq, events[events.length - 1]?.seq];
report.scannedLines = scanned;
report.elapsedMs = Date.now() - t0;
const outJson = path.join(outDir, "R5_RECALL_STRICT_LIVE.json");
fs.writeFileSync(outJson, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ SUMMARY: report.SUMMARY, ok: report.ok, claimNodesFound: report.claimNodesFound, schemaAnomalies: report.schemaAnomalies, classes: report.classes.map((c) => `${c.classId}:${c.poolSize}/${c.sampled}:${c.ok ? "PASS" : "FAIL"}`), timeline: report.timeline.reason, chain: report.sideEffectChain, elapsedMs: report.elapsedMs }, null, 1));
process.exit(report.ok ? 0 : 2);
