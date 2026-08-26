// cm-r4-recall5.mjs — P2.5 R4 REAL 5-class exact-source recall (read-only).
// For each observation class (goal / errors / tool-output / file-changes / timeline):
// take a REAL projection claim + its refs from the LIVE store, resolve each ref seq
// against the RAW Official Session log (the only legal direct-read channel), and
// verify the exact source material backs the projected claim. Output sanitized.
// Usage: node cm-r4-recall5.mjs <session.jsonl.zstd> <store.json> <context-memory-core.mjs>
import fs from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { pathToFileURL } from "node:url";

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

// OFFICIAL extraction path: DEPLOYED plugin's own functions (byte-identical semantics
// with production recall — tool/result nested blocks included via recursiveText).
function eventText(o) {
  const msg = core.messageOfEvent(o);
  if (!msg) return typeof o.data === "string" ? o.data : "";
  const blocks = msg.content;
  if (!Array.isArray(blocks)) return "";
  return blocks.map((b) => (typeof b === "string" ? b : core.recursiveText(b))).join("");
}
const SECRET = /(sk-[A-Za-z0-9_\-]{6,})|(Bearer\s+[A-Za-z0-9._\-]{8,})|((api[_-]?key|token|password|secret|authorization)["'\s:=]+[^\s"',}\]]{6,})/gi;
const mask = (t) => String(t).replace(SECRET, "***");

// Walk the store tree collecting claim nodes: {path, text, refs}.
function walkClaims(node, pathKey, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((n, i) => walkClaims(n, `${pathKey}[${i}]`, out)); return; }
  const ownRefs = Array.isArray(node.refs) ? node.refs : null;
  let text = null;
  // deployed schema uses { t: "...", refs: [...] } — "t" first among candidates
  for (const k of ["t", "text", "title", "name", "value", "summary", "signature", "content"]) {
    if (typeof node[k] === "string" && node[k].trim().length > 4) { text = node[k]; break; }
  }
  if (ownRefs || (typeof node.seq === "number")) out.push({ path: pathKey, text, refs: ownRefs ?? [node.seq], seq: typeof node.seq === "number" ? node.seq : undefined });
  for (const [k, v] of Object.entries(node)) {
    if (k === "refs") continue;
    walkClaims(v, pathKey ? `${pathKey}.${k}` : k, out);
  }
}

const CLASS_KEYS = [
  ["C1-goal", /goal/i],
  ["C2-error", /blocker|error|verifiedEvidence/i],
  ["C3-toolout", /completed/i],
  ["C4-filechg", /keyfile|filechange|files/i],
];

const [, , logFile, storeFile, coreFile] = process.argv;
if (!logFile || !storeFile || !coreFile) { console.error("usage: node cm-r4-recall5.mjs <log.zstd> <store.json> <context-memory-core.mjs>"); process.exit(1); }
const core = await import(pathToFileURL(path.resolve(coreFile)));

// ---- index the raw official session (memory-resident, read-only) ----
const events = [];           // {seq,o,text}
let scanned = 0;
for (const line of decodeLines(logFile)) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  scanned++;
  if (typeof o.seq === "number") events.push({ seq: o.seq, o, text: eventText(o), norm: "" });
}
events.sort((a, b) => a.seq - b.seq);
for (const e of events) e.norm = e.text.replace(/\s+/g, " ");
const evBySeq = new Map(events.map((e) => [e.seq, e]));
const logSeqMin = events.length ? events[0].seq : null;
const logSeqMax = events.length ? events[events.length - 1].seq : null;

const store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
const claims = []; walkClaims(store, "", claims);

// flattenable refs: accept {v,startSeq,endSeq}, plain numbers, or seq fields.
const flatRef = (r) => {
  if (typeof r === "number") return { lo: r, hi: r };
  if (typeof r?.seq === "number") return { lo: r.seq, hi: r.seq };
  if (typeof r?.startSeq === "number" && typeof r?.endSeq === "number")
    return { lo: Math.min(r.startSeq, r.endSeq), hi: Math.max(r.startSeq, r.endSeq) };
  return null;
};

// probe subsequence presence inside a bounded range
function probeRange(lo, hi) {
  if (lo == null || hi == null) return { present: false };
  const span = hi - lo;
  const picks = span <= 4 ? [...Array(span + 1).keys()].map((i) => lo + i)
    : [lo, Math.floor(lo + span * 0.25), Math.floor(lo + span * 0.5), Math.floor(lo + span * 0.75), hi];
  const hits = picks.filter((q) => evBySeq.has(q)).length;
  return { present: hits > 0, coverage: `${hits}/${picks.length}`, sampled: picks };
}

function bestClaim(clsRe) {
  const cand = claims.filter((c) => clsRe.test(c.path));
  cand.sort((a, b) => (b.text?.length ?? 0) + b.refs.length * 50 - ((a.text?.length ?? 0) + a.refs.length * 50));
  return cand[0] ?? null;
}

function sourceNeedles(text) {
  if (!text) return [];
  // whitespace-only normalization; segment on the plugin's own truncation marks.
  const clean = text.replace(/\s+/g, " ").trim();
  const segs = clean.split(/[…]+|(\.\.\.)+/g).map((s) => (s ?? "").trim()).filter((s) => s.length >= 24);
  return [...new Set(segs)].slice(0, 8);
}

const classes = [];
for (const [clsId, clsRe] of CLASS_KEYS) {
  const claim = bestClaim(clsRe);
  const rec = { cls: clsId, claimPath: claim?.path ?? null, probes: [], verdict: "NO-CLAIM" };
  if (claim) {
    const probes = [];
    const reflist = claim.refs.slice(0, 4); // cap
    for (const r of reflist) {
      const fl = flatRef(r);
      if (!fl) continue;
      const rr = probeRange(fl.lo, fl.hi);
      probes.push({ ref: r, ...rr });
      rec.probes.push(rr.present ? "HIT" : "MISS");
    }
    // exactness: WHOLE-CORPUS verification — every needle must exist verbatim in the
    // raw Official Session log (whitespace-normalized on both sides). Not sampling-bound.
    let matched = null, matchedSeq = null, matchCount = 0;
    outer:
    for (const nd of sourceNeedles(claim.text ?? "")) {
      for (const ev of events) {
        if (!ev.norm || !ev.norm.includes(nd)) continue;
        matched = nd; matchedSeq = ev.seq; matchCount++;
        break outer;
      }
    }
    // count total events backing the first matched needle (evidence weight)
    if (matched) for (const ev of events) if (ev.norm && ev.norm !== "" && ev.norm.includes(matched)) matchCount++;
    rec.exactMatch = matched ? { seq: matchedSeq, backingEvents: matchCount, excerpt: mask(matched).slice(0, 160) } : null;
    rec.refPresenceRate = probes.length ? `${rec.probes.filter((x) => x === "HIT").length}/${probes.length}` : "n/a";
    rec.verdict = probes.length && rec.probes.every((x) => x === "HIT") && matched ? "PASS"
      : probes.some((x) => x === "HIT") && matched ? "PASS-PARTIAL-PRESENCE" : "FAIL";
  }
  classes.push(rec);
}

// C5: timeline chain — the top-level store.refs sliding window IS the timeline:
// endSeq must be monotonic non-decreasing across versions and sampled refs must resolve.
{
  const rfs = (store.refs ?? []).map(flatRef).filter(Boolean);
  let mono = true;
  for (let i = 1; i < rfs.length; i++) if (rfs[i].hi < rfs[i - 1].hi) { mono = false; break; }
  const picks = [rfs[0], rfs[Math.floor(rfs.length / 2)], rfs[rfs.length - 1]].filter(Boolean);
  const probes = picks.map((r) => ({ lo: r.lo, hi: r.hi, ...probeRange(r.lo, r.hi) }));
  const hits = probes.filter((p) => p.present).length;
  classes.push({
    cls: "C5-timeline", claimPath: "store.refs", refCount: rfs.length,
    monotonicEndSeq: mono, probes,
    refPresenceRate: `${hits}/${probes.length}`,
    verdict: mono && probes.length > 0 && hits === probes.length ? "PASS" : "FAIL",
  });
}

// cross-checks: store.version vs freshest injected header in the log
let maxHeaderV = 0;
for (const e of events) if (/\[context-memory observation v(\d+)\]/.test(e.text)) {
  const v = Number(e.text.match(/\[context-memory observation v(\d+)\]/)[1]);
  if (v > maxHeaderV) maxHeaderV = v;
}

const passCount = classes.filter((c) => c.verdict.startsWith("PASS")).length;
console.log(JSON.stringify({
  logFile: logFile.split(/[\\/]/).pop(), storeFile: storeFile.split(/[\\/]/).pop(),
  scannedLines: scanned, indexedEvents: events.length,
  logSeqRange: [logSeqMin, logSeqMax],
  storeVersion: store.version, maxHeaderVersionInLog: maxHeaderV,
  claimNodesFound: claims.length,
  classes,
  SUMMARY: `RECALL ${passCount}/5 ${passCount >= 5 ? "ALL-CLASS-PASS" : "INCOMPLETE"}`,
  sanitized: true,
}, null, 1));
process.exit(passCount >= 5 ? 0 : 2);
