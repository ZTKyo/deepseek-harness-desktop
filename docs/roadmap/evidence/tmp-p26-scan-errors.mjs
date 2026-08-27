// p26-scan-errors.mjs — scan DSH zstd session logs for DeepSeek 400 / reasoning_content errors.
import fs from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";

const root = path.join(process.env.USERPROFILE ?? "", ".dsh", "sessions");
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
function decode(logFile) {
  const buf = fs.readFileSync(logFile);
  let text = "";
  for (const [s, e] of parseFrames(buf)) {
    try { text += zstdDecompressSync(buf.subarray(s, e)).toString("utf8"); } catch { /* skip bad frame */ }
  }
  return text.split("\n").filter((l) => l.trim());
}
// collect candidate files
const files = [];
(function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(zstd|jsonl)$/i.test(e.name)) {
      const st = fs.statSync(full);
      files.push({ full, mtime: st.mtimeMs, size: st.size });
    }
  }
})(root);
files.sort((a, b) => b.mtime - a.mtime);
const newest = files.slice(0, Number(process.argv[2] ?? 8));
console.log(`total=${files.length} scanning=${newest.length}`);
const NEEDLES = [/reasoning_content/i, /\b400\b/, /must be passed back/i, /PROTOCOL_MISMATCH/i];
let shown = 0;
for (const f of newest) {
  const lines = decode(f.full);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 4_000_000) continue;
    if (!NEEDLES.some((n) => n.test(line))) continue;
    // extract compact context
    let o = null;
    try { o = JSON.parse(line); } catch { /* non-json */ }
    let summary = "";
    if (o && typeof o === "object") {
      const d = o.data ?? o;
      const pieces = [];
      const grab = (v, k) => {
        if (pieces.length >= 6 || v == null) return;
        if (typeof v === "string") {
          if (/error|status|reasoning|400|message/i.test(k) && v.length < 500) pieces.push(`${k}=${JSON.stringify(v.slice(0, 300))}`);
        } else if (typeof v === "object") {
          for (const [k2, v2] of Object.entries(v).slice(0, 30)) grab(v2, k2);
        }
      };
      for (const [k, v] of Object.entries(d).slice(0, 30)) grab(v, k);
      summary = `${o.type ?? "?"} ${pieces.join(" | ")}`.slice(0, 420);
    } else {
      const idx = line.search(/reasoning_content|must be passed back/i);
      summary = line.slice(Math.max(0, idx - 80), idx + 260);
    }
    if (summary.trim()) hits.push({ seq: o?.seq, line: i + 1, summary });
  }
  console.log(`=== ${path.basename(path.dirname(f.full))}/${path.basename(f.full)} (${(f.size / 1048576).toFixed(1)}MB, ${lines.length} lines, ${hits.length} raw-line hits)`);
  for (const h of hits.slice(0, 5)) {
    if (shown >= 26) break;
    console.log(`  seq=${h.seq} ln=${h.line}: ${h.summary}`);
    shown++;
  }
  if (shown >= 26) break;
}
