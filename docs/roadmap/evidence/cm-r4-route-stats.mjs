// cm-r4-stats.mjs v3 — per-route usage quality stats on decoded DSH logs.
// Read-only. Reuses the same multi-frame decoder as probe v2.
import fs from "node:fs";
import { zstdDecompressSync } from "node:zlib";

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
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const pct95 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : null; };

function analyze(file) {
  const lines = decodeLines(file);
  let route = null;
  let sampleConfig = null;
  const byRoute = new Map();
  let lastPressureByRoute = new Map();
  let growthsAll = [];
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "session") continue;
    if (o.type === "request/header") {
      route = `${o.data?.header?.config?.provider}/${o.data?.header?.config?.model}`;
      if (!sampleConfig) sampleConfig = o.data?.header?.config;
    }
    let u = null;
    if (o.type === "assistant/message" && typeof o.data?.usage?.inputTokens === "number") u = o.data.usage;
    if (!u) continue;
    const pressure = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    let st = byRoute.get(route);
    if (!st) { st = { n: 0, nonzero: 0, pressures: [], growths: [], cachedShareSum: 0 }; byRoute.set(route, st); }
    st.n++;
    if (pressure > 0) {
      st.nonzero++;
      st.pressures.push(pressure);
      const lp = lastPressureByRoute.get(route);
      if (lp != null && pressure >= lp) { st.growths.push(pressure - lp); growthsAll.push(pressure - lp); }
      const total = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
      if (total > 0) st.cachedShareSum += ((u.cacheReadTokens ?? 0)) / total;
      lastPressureByRoute.set(route, pressure);
    }
  }
  const routes = {};
  for (const [r, st] of byRoute) {
    routes[r] = {
      samples: st.n,
      nonZeroPressure: st.nonzero,
      usablePct: Math.round((st.nonzero / st.n) * 100),
      avgPressure: st.pressures.length ? Math.round(st.pressures.reduce((a, b) => a + b, 0) / st.pressures.length) : null,
      medianPressure: median(st.pressures),
      p95Pressure: pct95(st.pressures),
      avgStepGrowth: st.growths.length ? Math.round(st.growths.reduce((a, b) => a + b, 0) / st.growths.length) : null,
      avgCacheReadShare: st.cachedShareSum ? Math.round((st.cachedShareSum / Math.max(st.n, 1)) * 100) + "%" : "0%",
    };
  }
  const maxSeq = lines.reduce((m, l) => { try { const s = JSON.parse(l).seq; return s > m ? s : m; } catch { return m; } }, 0);
  return { file: file.split(/[\\/]/).pop(), events: lines.length, maxSeq, routes, sampleCallConfig: sampleConfig, overallAvgStepGrowth: growthsAll.length ? Math.round(growthsAll.reduce((a, b) => a + b, 0) / growthsAll.length) : null };
}

const files = process.argv.slice(2);
const out = [];
for (const f of files) out.push(analyze(f));
process.stdout.write(JSON.stringify(out, null, 1));
