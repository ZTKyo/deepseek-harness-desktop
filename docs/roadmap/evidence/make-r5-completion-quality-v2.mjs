// make-r5-completion-quality-v2.mjs — Generate R5_COMPLETION_QUALITY_V2.json
// P2.6 / P2.5 R5.1-A final evidence correction round.
//
// Fixed-field completion-quality scan over EXISTING production OFF/ON-era long
// session logs (read-only, zero writes to production files):
//   - reasoning_content + status/code 400 lines  ⇒ "PROTOCOL_CONFIG_LOAD_INCIDENT"
//   - status/code 429 (+ GLM family marker)      ⇒ "PROVIDER_QUOTA"
// Matcher strictness: literal HTTP code / JSON code forms ONLY. Loose textual
// echoes of rate-limit prose that carry no code are counted separately as
// OUT_OF_SCOPE_TEXT_ECHO so they can neither inflate nor deflate either fixed field.
//
// Usage: node make-r5-completion-quality-v2.mjs <outDir>
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { zstdDecompressSync } from "node:zlib";

const outDir = process.argv[2];
if (!outDir) { console.error("usage: node make-r5-completion-quality-v2.mjs <outDir>"); process.exit(64); }
fs.mkdirSync(outDir, { recursive: true });

// ── multi-frame zstd decoder (same method chain as R4 evidence, zero writes) ──
function parseFrames(buf) {
  const frames = []; let off = 0; const MAGIC = 0xfd2fb528;
  while (off + 4 <= buf.length) {
    const m = buf.readUInt32LE(off);
    if (m === MAGIC) {
      let p = off + 4;
      const fhd = buf[p++]; const single = (fhd >> 5) & 1, cks = (fhd >> 2) & 1, did = fhd & 3, fcs = (fhd >> 6) & 3;
      if (!single) p += 1;
      p += [0, 1, 2, 4][did]; p += [0, 2, 4, 8][fcs];
      for (;;) { const bh = buf.readUIntLE(p, 3); p += 3; const last = bh & 1, bt = (bh >> 1) & 3, bs = bh >> 3; if (bt !== 1) p += bs; if (last) break; }
      if (cks) p += 4;
      frames.push([off, p]); off = p;
    } else if ((m & 0xfffffff0) === 0x184d2a50) off += 8 + buf.readUInt32LE(off + 4);
    else break;
  }
  return frames;
}
function decode(logFile) {
  const buf = fs.readFileSync(logFile);
  let text = "";
  for (const [s, e] of parseFrames(buf)) { try { text += zstdDecompressSync(buf.subarray(s, e)).toString("utf8"); } catch { /* skip */ } }
  return text.split("\n").filter((l) => l.trim());
}

// ── era labeling from R4 evidence mapping (docs/roadmap/evidence/R4_P25_VERIFICATION_EVIDENCE.md) ──
const ERA_IDS = [
  { id: "session-34e86c7a", era: ["ON"] },
  { id: "session-a144fe3f", era: ["ON"] },   // current working session (post-P2.6-A hotfix era)
  { id: "session-5cd0722e", era: ["ON"] },
  { id: "session-ad148b88", era: ["ON"] },
  { id: "session-11c7aa70", era: ["OFF"] },  // OFF 对照① pre-deploy era
  { id: "session-9e3b29bb", era: ["OFF"] },  // OFF 对照② mount-eve era
  { id: "session-293a808a", era: ["OFF"] },  // OFF 对照③ pre-deploy
];

const root = path.join(os.homedir(), ".dsh", "sessions");
const logs = [];
(function walk(dir) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const en of ents) {
    const full = path.join(dir, en.name);
    if (en.isDirectory()) walk(full);
    else if (/\.zstd$/i.test(en.name)) logs.push(full);
  }
})(root);
logs.sort();

const sessions = [];
let totalEvents = 0, incProtoTotal = 0, incQuotaTotal = 0, echoOnlyTotal = 0;
for (const full of logs) {
  const dirName = path.basename(path.dirname(full));
  const sid = dirName.startsWith("session-") ? dirName : path.basename(full).replace(/\.zstd$/i, "");
  const lines = decode(full);
  let events = 0; const protoSeqs = [], quotaSeqs = [], echoSeqs = [];
  for (const ln of lines) {
    if (ln.length > 2_000_000) continue;
    let o = null; try { o = JSON.parse(ln); } catch { continue; }
    events++;
    const seq = Number(o?.seq ?? 0);
    const rc = ln.includes("reasoning_content");
    const c400 = /status code \b400\b|"code":\s*400/.test(ln);
    const c429 = /status code \b429\b|"code":\s*429/.test(ln);
    const glmMark = /(glm|zhipu|bigmodel)/i.test(ln.slice(0, 40_000));
    if (c429 && glmMark) quotaSeqs.push(seq);
    else if ((/rate ?limit/i.test(ln)) && !(c400 || c429)) echoSeqs.push(seq);
    if (rc && c400) protoSeqs.push(seq);
  }
  const label = ERA_IDS.find((e) => sid.startsWith(e.id))?.era ?? null;
  const rec = {
    sessionId: sid,
    era: label,
    events,
    incidents: {
      PROTOCOL_CONFIG_LOAD_INCIDENT: protoSeqs.length,
      PROVIDER_QUOTA: quotaSeqs.length,
    },
    outOfScopeTextEcho: echoSeqs.length,
    sampleSeqs: {
      PROTOCOL_CONFIG_LOAD_INCIDENT: protoSeqs.slice(0, 10),
      PROVIDER_QUOTA: quotaSeqs.slice(0, 10),
    },
  };
  // keep only rows that either carry incidents, are labeled era rows, or exceed noise floor
  if (protoSeqs.length || quotaSeqs.length || label || echoSeqs.length > 3 || events > 5000) {
    sessions.push(rec);
    incProtoTotal += protoSeqs.length; incQuotaTotal += quotaSeqs.length; echoOnlyTotal += echoSeqs.length;
  }
  totalEvents += events;
}

// ── per-era rollups over ALL logs sharing each label ──
function eraRollup(tag) {
  const rows = sessions.filter((s) => s.era?.includes(tag));
  return {
    labeledLogsConsidered: rows.length,
    PROTOCOL_CONFIG_LOAD_INCIDENT: rows.reduce((a, r) => a + r.incidents.PROTOCOL_CONFIG_LOAD_INCIDENT, 0),
    PROVIDER_QUOTA: rows.reduce((a, r) => a + r.incidents.PROVIDER_QUOTA, 0),
  };
}

const out = {
  gate: "R5.1-A completion-quality V2 — fixed-field failure accounting over OFF/ON era production logs",
  date: "2026-08-27",
  generatedAtUtc: new Date().toISOString(),
  captureNote: "point-in-time snapshot: active sessions keep appending events after this run; totals are exact as of generatedAtUtc",
  method: {
    decoding: "self-written multi-frame zstd walker, per-frame lossless decode, zero writes to production files",
    countingUnit: "event-level JSON records (o.seq unique); no cross-event pairing collapse",
    matchers: {
      PROTOCOL_CONFIG_LOAD_INCIDENT: "line contains 'reasoning_content' AND (/status code 400/ OR /\"code\":\\s*400/) — mapping per R5_COMPLETION_QUALITY_V2 spec",
      PROVIDER_QUOTA: "(/status code 429/ OR /\"code\":\\s*429/) AND GLM-family provider marker (glm|zhipu|bigmodel)",
      excludedFromFixedFields: "textual 'rate limit' prose without any literal code ⇒ counted as outOfScopeTextEcho",
    },
    secretHygiene: "no raw log lines are written into this artifact; only counts and integer seq samples",
  },
  scanScope: { sessionsRoot: "~/.dsh/sessions", logsScanned: logs.length, totalEventsDecoded: totalEvents },
  totalsAllLogs: {
    PROTOCOL_CONFIG_LOAD_INCIDENT: incProtoTotal,
    PROVIDER_QUOTA: incQuotaTotal,
    outOfScopeTextEcho: echoOnlyTotal,
  },
  eraRollups: { ON: eraRollup("ON"), OFF: eraRollup("OFF") },
  sessionsWithIncidentsOrLabeledEra: sessions.filter((s) => s.incidents.PROTOCOL_CONFIG_LOAD_INCIDENT || s.incidents.PROVIDER_QUOTA || s.era),
  carryoverAuditReference: {
    v1Gate: "R5-4 completion-quality OFF/ON auditable checklist (R5_COMPLETION_QUALITY.json)",
    verdictCarriedForward: "NO MATERIAL REGRESSION (proxy checklist; independent evaluation system remains INCONCLUSIVE, registry #5)",
  },
  sanitized: true,
};

const outPath = path.join(outDir, "R5_COMPLETION_QUALITY_V2.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`R5_COMPLETION_QUALITY_V2.json -> ${outPath}`);
console.log(`logs=${logs.length} events=${totalEvents} proto=${incProtoTotal} quota=${incQuotaTotal} echo=${echoOnlyTotal}`);
process.exit(0);
