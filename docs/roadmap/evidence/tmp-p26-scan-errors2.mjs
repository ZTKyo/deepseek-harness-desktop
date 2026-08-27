// p26-scan-errors2.mjs — extract error-typed events and exact DeepSeek-style messages.
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
    try { text += zstdDecompressSync(buf.subarray(s, e)).toString("utf8"); } catch { /* skip */ }
  }
  return text.split("\n").filter((l) => l.trim());
}
const files = [];
(function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.zstd$/i.test(e.name)) files.push({ full, mtime: fs.statSync(full).mtimeMs });
  }
})(root);
files.sort((a, b) => b.mtime - a.mtime);
const newest = files.slice(0, Number(process.argv[2] ?? 10));
const TYPE_RE = /error|failure|fail|reject|fault/i;
const TEXT_RE = /(must be passed back|Invalid request|status code 400|"code":? ?400|error_type|api_error|invalid_format)/i;
for (const f of newest) {
  const lines = decode(f.full);
  const label = `${path.basename(path.dirname(f.full)).slice(0, 30)}/${path.basename(f.full)}`;
  const errs = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 2_000_000) continue;
    let o = null;
    try { o = JSON.parse(line); } catch { continue; }
    const t = String(o?.type ?? "");
    if (!TYPE_RE.test(t)) {
      // also catch error payloads inside non-error events by exact needle
      if (!TEXT_RE.test(line.slice(0, 20000))) continue;
    }
    const d = o?.data ?? {};
    const msg =
      d.errorMessage ?? d.error?.message ?? d.message ?? d.reason ??
      (TEXT_RE.test(line.slice(0, 20000))
        ? (line.match(/.{0,120}(?:must be passed back|Invalid request[^"]*|status code \d+)[^"]{0,160}/)?.[0] ?? "")
        : "");
    errs.push({ seq: o?.seq, type: t || "?", ln: i + 1, msg: String(msg).slice(0, 380) });
    if (errs.length > 60) break;
  }
  console.log(`=== ${label}: ${errs.length} candidate(s)`);
  for (const e of errs.slice(0, 8)) console.log(`  seq=${e.seq} [${e.type}] ${JSON.stringify(e.msg)}`);
}
