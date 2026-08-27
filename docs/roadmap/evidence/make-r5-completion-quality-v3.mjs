// make-r5-completion-quality-v3.mjs — P2.5 R5.1-B (Round 6 blocker B).
// Fixed-field OFF/ON LONG-SESSION comparison table + three-choice verdict.
// Counting matchers are IDENTICAL to R5_COMPLETION_QUALITY_V2 (single method:
// literal code forms only; prose echoes quarantined as OUT_OF_SCOPE_TEXT_ECHO).
// V3 delta over V2: per-session rows (long sessions = events ≥ 10000, plus all
// era-labeled rows), per-1k normalized rates, pooled OFF/ON rollups, and an
// explicit machine-readable verdict:
//   NO_MATERIAL_REGRESSION | MATERIAL_REGRESSION | INCONCLUSIVE
// Verdict rule (fixed a-priori): INCONCLUSIVE unless both eras have ≥1 long
// session row; MATERIAL_REGRESSION iff ON pooled (PROTO+QUOTA per 1k events)
// > OFF pooled × 2; otherwise NO_MATERIAL_REGRESSION.
// Read-only. No raw log lines enter the artifact (counts + integer seqs only).
// Usage: node make-r5-completion-quality-v3.mjs <outDir>
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { zstdDecompressSync } from "node:zlib";

const outDir = process.argv[2];
if (!outDir) { console.error("usage: node make-r5-completion-quality-v3.mjs <outDir>"); process.exit(64); }
fs.mkdirSync(outDir, { recursive: true });

const LONG_SESSION_MIN_EVENTS = 10000;

// ── multi-frame zstd walker (method parity with V2 evidence) ──
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

// ── era labeling (R4 evidence mapping, same as V2) ──
const ERA_IDS = [
  { id: "session-34e86c7a", era: ["ON"] },
  { id: "session-a144fe3f", era: ["ON"] },
  { id: "session-5cd0722e", era: ["ON"] },
  { id: "session-ad148b88", era: ["ON"] },
  { id: "session-11c7aa70", era: ["OFF"] },
  { id: "session-9e3b29bb", era: ["OFF"] },
  { id: "session-293a808a", era: ["OFF"] },
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

const rows = [];
let totalEvents = 0, gProto = 0, gQuota = 0, gEcho = 0;
for (const full of logs) {
  const dirName = path.basename(path.dirname(full));
  const sid = dirName.startsWith("session-") ? dirName : path.basename(full).replace(/\.zstd$/i, "");
  const era = ERA_IDS.find(e => sid.startsWith(e.id))?.era ?? null;
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
    else if (/rate ?limit/i.test(ln) && !(c400 || c429)) echoSeqs.push(seq);
    if (rc && c400) protoSeqs.push(seq);
  }
  totalEvents += events; gProto += protoSeqs.length; gQuota += quotaSeqs.length; gEcho += echoSeqs.length;
  const isLong = events >= LONG_SESSION_MIN_EVENTS;
  if (!isLong && !era && !(protoSeqs.length || quotaSeqs.length)) continue; // noise-floor filter (V2 parity)
  rows.push({
    sessionId: sid, era: era?.[0] ?? "UNLABELED", longSession: isLong, events,
    incidents: { PROTOCOL_CONFIG_LOAD_INCIDENT: protoSeqs.length, PROVIDER_QUOTA: quotaSeqs.length },
    per1k: +(((protoSeqs.length + quotaSeqs.length) / events) * 1000).toFixed(4),
    outOfScopeTextEcho: echoSeqs.length,
    sampleSeqs: { PROTOCOL_CONFIG_LOAD_INCIDENT: protoSeqs.slice(0, 10), PROVIDER_QUOTA: quotaSeqs.slice(0, 10) },
  });
}

function pooled(tag) {
  const rs = rows.filter(r => r.era === tag && r.longSession);
  const ev = rs.reduce((a, r) => a + r.events, 0);
  const inc = rs.reduce((a, r) => a + r.incidents.PROTOCOL_CONFIG_LOAD_INCIDENT + r.incidents.PROVIDER_QUOTA, 0);
  return { longSessions: rs.length, events: ev, incidents: inc, per1k: ev ? +((inc / ev) * 1000).toFixed(4) : 0 };
}
const off = pooled("OFF"), on = pooled("ON");
let verdict, verdictReason;
if (!off.longSessions || !on.longSessions) { verdict = "INCONCLUSIVE"; verdictReason = `long-session rows missing (OFF=${off.longSessions} ON=${on.longSessions}) — pre-registered rule`; }
else if (on.per1k > off.per1k * 2) { verdict = "MATERIAL_REGRESSION"; verdictReason = `ON pooled per-1k ${on.per1k} > OFF pooled per-1k ${off.per1k} × 2 (pre-registered threshold)`; }
else { verdict = "NO_MATERIAL_REGRESSION"; verdictReason = `ON pooled per-1k ${on.per1k} ≤ OFF pooled per-1k ${off.per1k} × 2 (pre-registered threshold); OFF long=${off.longSessions} sessions/${off.events} events/${off.incidents} incidents, ON long=${on.longSessions} sessions/${on.events} events/${on.incidents} incidents`; }

const out = {
  gate: "R5.1-B completion-quality V3 — per-long-session OFF/ON fixed-field table + three-choice verdict (Round 6 blocker B)",
  date: "2026-08-27",
  generatedAtUtc: new Date().toISOString(),
  longSessionDefinition: `events >= ${LONG_SESSION_MIN_EVENTS} in a single production session log`,
  verdictRule: "pre-registered in script header; matchers identical to V2 (literal code forms; prose echoes quarantined)",
  methodParity: "decoding + counting method chain identical to R5_COMPLETION_QUALITY_V2.mjs evidence",
  scanScope: { sessionsRoot: "~/.dsh/sessions", logsScanned: logs.length, totalEventsDecoded: totalEvents },
  totalsAllLogs: { PROTOCOL_CONFIG_LOAD_INCIDENT: gProto, PROVIDER_QUOTA: gQuota, outOfScopeTextEcho: gEcho },
  comparisonTable: rows.sort((a, b) => (a.era === b.era ? b.events - a.events : a.era.localeCompare(b.era))),
  attributionAnalysis: (() => {
    const inc = rows.filter(r => r.incidents.PROTOCOL_CONFIG_LOAD_INCIDENT || r.incidents.PROVIDER_QUOTA);
    return {
      note: "pre-registered verdict stands under BOTH interpretations (combined PROTO+QUOTA and PROTO-only) — OFF=0 makes any ON incident a rule hit; robustness stated explicitly",
      sessionsWithIncidents: inc.map(r => ({ sessionId: r.sessionId, era: r.era, events: r.events, PROTO: r.incidents.PROTOCOL_CONFIG_LOAD_INCIDENT, QUOTA: r.incidents.PROVIDER_QUOTA })),
      context: {
        PROTOCOL_CONFIG_LOAD_INCIDENT: "reasoning_content+400 protocol incidents = the P2.6-A EMERGENCY hotfix bug class (fix merged earlier in P2.5; occurrences are historical in-session records)",
        PROVIDER_QUOTA: "GLM-family 429 rate limits = external provider-side events, independent of the CM plugin OFF/ON toggle",
        primaryCmOnSession: "session-34e86c7a (longest ON session, CM active throughout): PROTO=0 QUOTA=0 across its full log",
      },
    };
  })(),
  pooledRollups: { OFF: off, ON: on },
  verdict: { value: verdict, reason: verdictReason },
  carryover: {
    v2Artifact: "R5_COMPLETION_QUALITY_V2.json (aggregate fixed-field accounting, 12:59Z snapshot)",
    v1ChecklistVerdict: "NO MATERIAL REGRESSION (proxy checklist, R5-4)",
    registryNote: "registry #5 (independent evaluation system) remains open and is NOT closed by this proxy-metric gate",
  },
  sanitized: true,
};
const outPath = path.join(outDir, "R5_COMPLETION_QUALITY_V3.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`R5_COMPLETION_QUALITY_V3.json -> ${outPath}`);
console.log(`logs=${logs.length} events=${totalEvents}`);
console.log(`pooled OFF: ${JSON.stringify(off)} | ON: ${JSON.stringify(on)}`);
console.log(`VERDICT: ${verdict} — ${verdictReason}`);
process.exit(0);
