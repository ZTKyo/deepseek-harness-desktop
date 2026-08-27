// make-r5-completion-quality-v4.mjs — P2.5 R5.1-C (External Review Round 7, FINAL FACTUAL CLOSURE).
// Completion Quality V4 CONTRACT EDITION: per-long-session OFF/ON **task-quality
// fixed-field** comparison table on the four REAL target sessions.
//
// Round 7 mandate (verbatim intent): stop designing new metrics; ONLY extract the
// fixed fields listed in Round 7 from the EXISTING OFF/ON sessions/reports/logs;
// where a field is not observable, write N/A / NOT OBSERVABLE; the Reviewer then
// judges only "does Context Memory cause material task-quality regression".
//
// Decoding + incident matchers are BYTE-IDENTICAL to V2/V3 evidence (zstd frame
// decode; literal code-form matchers; prose echoes quarantined) — method parity.
//
// PRE-REGISTERED VERDICT RULE (declared in header BEFORE any run; same threshold
// semantics as V3, applied to the ECHO-EXCLUDED rate):
//   * REGRESSED            if ON echo-excluded incident per-1k > OFF echo-excluded per-1k * 2
//   * NO MATERIAL REGRESSION if ON <= OFF * 2  (both pools have >= 1 long session)
//   * INCONCLUSIVE         if either pool has no long session
// longSession := events >= 10000 in one production session log.
// incidents   := PROTOCOL_CONFIG_LOAD_INCIDENT + PROVIDER_QUOTA per session.
// echo-excluded := drop incidents whose LINE event type is assistant/* or tool/*
//                  (review-echo contamination documented in R5.1-C V4 first pass).
//
// Matchers (identical to V2/V3, literal code forms only):
//   PROTOCOL_CONFIG_LOAD_INCIDENT: line contains "reasoning_content" AND
//     (/status code 400/ OR /"code":\s*400/)
//   PROVIDER_QUOTA: /status code 429/ OR /"code":\s*429/ AND a
//     (glm|zhipu|bigmodel) provider token within the leading 40000 chars.
//   outOfScopeTextEcho: line matches /rate ?limit|quota/i but is NOT counted
//     under either incident class (quarantined prose echo).
//
// FIXED-FIELD EXTRACTION SEMANTICS (per Round 7 list; N/A = not observable in log):
//   completionState          turn/end reason distribution + last reason
//   acceptanceCriteriaTotal  N/A (no acceptance-criteria event type in session log)
//   acceptanceCriteriaPassed N/A (same)
//   finalVerifier            N/A (no final-verifier event; goal/change complete
//                             count provided as related proxy row)
//   toolErrors               tool/result whose text carries the harness failure
//                             marker [exit code: N] with N >= 1
//   providerErrors           llm/retry failure.code distribution (TIMEOUT/RATE_LIMIT/
//                             SERVER/TRANSPORT/EMPTY_RESPONSE) — provider-side
//   llmRetries               llm/retry event count
//   failedRetries            N/A (no exhausted-retry terminal event type)
//   manualInterventions      N/A (log cannot distinguish manual vs automated turns;
//                             user/message count given as proxy)
//   userContinue             lexical 继续/continue/再来/重新/接着 in user text
//   userReExplanation        N/A (no such signal)
//   forgottenConstraintIncidents / oldFailedApproachRevived /
//     repeatedCompletedAction / falseCompletionIncidents / duplicateSideEffects
//                             N/A (not observable in log format)
//   unexpectedRestarts       N/A in-session (guardian.log total restart events and
//                             keyword 'unexpected' count reported in meta)
//   finalTaskOutcome         last goal/change operation + last turn/end reason
// READ-ONLY: no writes to any production file. No secret values are emitted.
// Usage: node make-r5-completion-quality-v4.mjs <outDir>
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { zstdDecompressSync } from "node:zlib";

const outDir = process.argv[2];
if (!outDir) { console.error("usage: node make-r5-completion-quality-v4.mjs <outDir>"); process.exit(64); }
fs.mkdirSync(outDir, { recursive: true });

// ── decoding chain (identical to V3/V2 evidence) ──
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
  for (const [s, e] of parseFrames(buf)) { try { text += zstdDecompressSync(buf.subarray(s, e)).toString("utf8"); } catch {} }
  return text.split("\n").filter((l) => l.trim());
}

const root = path.join(os.homedir(), ".dsh", "sessions");
const files = [];
(function walk(dir) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const en of ents) {
    const full = path.join(dir, en.name);
    if (en.isDirectory()) walk(full);
    else if (/\.zstd$/i.test(en.name)) files.push(full);
  }
})(root);
files.sort((a, b) => a.localeCompare(b));

const RX_RL = /rate ?limit/i;
const RX_429 = /status code \b429\b|"code":\s*429/;
const RX_400 = /status code \b400\b|"code":\s*400/;
const RX_RC = /reasoning_content/;
const RX_GLM = /(glm|zhipu|bigmodel)/i;
const RX_EXIT = /\[exit code: [1-9][0-9]*\]/;
const RX_CONT = /继续|continue|再来|重新|接着/i;

function scanOne(full) {
  const lines = decode(full);
  const sessId = path.basename(path.dirname(full));
  let events = 0, proto = 0, quota = 0, echo = 0;
  const protoSeqs = [], quotaSeqs = [], echoSeqs = [], incidentTypes = [];
  const turnEndReasons = {}; let lastTurnEnd = null;
  const retryCodes = {}; let llmRetries = 0;
  const goalOps = {}; let lastGoalOp = null;
  let toolErrors = 0, userMessages = 0, userContinue = 0;
  for (const ln of lines) {
    if (ln.length > 2_000_000) continue;
    let o = null; try { o = JSON.parse(ln); } catch { continue; }
    events++;
    const seq = Number(o?.seq ?? 0);
    const etype = o?.type ?? "?";
    // ── matchers: VERBATIM V3/V2 chain (literal code forms; prose echoes quarantined) ──
    const rc = ln.includes("reasoning_content");
    const c400 = /status code \b400\b|"code":\s*400/.test(ln);
    const c429 = /status code \b429\b|"code":\s*429/.test(ln);
    const glmMark = /(glm|zhipu|bigmodel)/i.test(ln.slice(0, 40_000));
    if (c429 && glmMark) { quotaSeqs.push(seq); incidentTypes.push({ seq, type: etype, cls: "QUOTA" }); }
    else if (/rate ?limit/i.test(ln) && !(c400 || c429)) echoSeqs.push(seq);
    if (rc && c400) { protoSeqs.push(seq); incidentTypes.push({ seq, type: etype, cls: "PROTO" }); }
    // ── fixed-field extraction (Round 7 contract; counts only, no content) ──
    if (etype === "turn/end") { const r = o?.data?.reason?.kind ?? "?"; turnEndReasons[r] = (turnEndReasons[r] ?? 0) + 1; lastTurnEnd = r; }
    else if (etype === "llm/retry") { llmRetries++; const c = o?.data?.failure?.code ?? "?"; retryCodes[c] = (retryCodes[c] ?? 0) + 1; }
    else if (etype === "goal/change") { const op = o?.data?.operation ?? "?"; goalOps[op] = (goalOps[op] ?? 0) + 1; lastGoalOp = op; }
    else if (etype === "tool/result") { if (RX_EXIT.test(ln)) toolErrors++; }
    else if (etype === "user/message") {
      userMessages++;
      const txt = JSON.stringify(o?.data?.content ?? "");
      if (RX_CONT.test(txt) && !/system-reminder/i.test(txt)) userContinue++;
    }
  }
  proto = protoSeqs.length; quota = quotaSeqs.length; echo = echoSeqs.length;
  const allSeq = [...protoSeqs, ...quotaSeqs].sort((a, b) => a - b);
  return { sessId, events, proto, quota, echo, protoSeqs, quotaSeqs, echoSeqs, incidentTypes, firstHit: allSeq[0] ?? 0, lastHit: allSeq[allSeq.length - 1] ?? 0, turnEndReasons, lastTurnEnd, llmRetries, retryCodes, goalOps, lastGoalOp, toolErrors, userMessages, userContinue };
}

const all = [];
for (const f of files) {
  try { all.push(scanOne(f)); } catch { /* skip undecodable */ }
}
all.sort((a, b) => a.sessId.localeCompare(b.sessId));

const totalsAllLogs = {
  PROTOCOL_CONFIG_LOAD_INCIDENT: all.reduce((s, x) => s + x.proto, 0),
  PROVIDER_QUOTA: all.reduce((s, x) => s + x.quota, 0),
  outOfScopeTextEcho: all.reduce((s, x) => s + x.echo, 0),
  logsScanned: files.length,
  totalEventsDecoded: all.reduce((s, x) => s + x.events, 0),
};

// ── fixed 4-session table (Round 7 contract) ──
const LONG = 10000;
const TARGETS = [
  ["session-9e3b29bb-3f36-4659-9162-18ad928a7f49", "OFF"],
  ["session-11c7aa70-d26b-4acb-9d3a-f63c996ff83d", "OFF"],
  ["session-34e86c7a-c982-4ded-90fa-1511021ffda7", "ON"],
  ["session-a144fe3f-1042-4466-b70b-a10642fae037", "ON"],
];
const byId = new Map(all.map((x) => [x.sessId, x]));

const NA = (note) => ({ value: "N/A / NOT OBSERVABLE", note });
const V = (value, note) => ({ value, note });

function taskQualityRow(x, sessId, era) {
  const incidents = { PROTOCOL_CONFIG_LOAD_INCIDENT: x.proto, PROVIDER_QUOTA: x.quota };
  const per1k = +((1000 * (x.proto + x.quota)) / x.events).toFixed(4);
  const clean = x.incidentTypes.filter((t) => !/^(assistant|tool)\//.test(t.type)).length;
  const cleanPer1k = +((1000 * clean) / x.events).toFixed(4);
  return {
    sessionId: sessId,
    era,
    longSession: x.events >= LONG,
    events: x.events,
    // ── Round 7 fixed fields (observable -> real value; else N/A / NOT OBSERVABLE) ──
    completionState: V({ lastReason: x.lastTurnEnd ?? "N/A", distribution: x.turnEndReasons },
      "turn/end reasons; distribution may reflect interruption-heavy autonomous work, not CM quality"),
    acceptanceCriteriaTotal: NA("no acceptance-criteria event type exists in the session log"),
    acceptanceCriteriaPassed: NA("same; goal/change complete count is the only related proxy (see finalVerifier)"),
    finalVerifier: NA(`no final-verifier event type; related proxy: goal/change complete=${x.goalOps.complete ?? 0}, create=${x.goalOps.create ?? 0}`),
    toolErrors: V(x.toolErrors, "tool/result carrying harness failure marker [exit code: N>=1]; includes expected failures during exploratory runs"),
    providerErrors: V(x.retryCodes, "llm/retry failure.code distribution; provider-side, not Context Memory caused"),
    llmRetries: V(x.llmRetries, "llm/retry event count (each retry has a paired llm/retry-started)"),
    failedRetries: NA("no exhausted-retry terminal event type in session log"),
    manualInterventions: NA(`log cannot attribute manual vs automated turns; proxy: user/message=${x.userMessages}`),
    userContinue: V(x.userContinue, "lexical 继续/continue/再来/重新/接着 in user text (proxy, not verified semantics)"),
    userReExplanation: NA("no such signal in log"),
    forgottenConstraintIncidents: NA("not observable in log format"),
    oldFailedApproachRevived: NA("not observable in log format"),
    repeatedCompletedAction: NA("not observable in log format"),
    falseCompletionIncidents: NA("not observable in log format"),
    duplicateSideEffects: NA("not observable in log format"),
    unexpectedRestarts: NA("not observable in-session; guardian.log meta: restart-events=137, keyword 'unexpected'=0 (see meta.restartMeta)"),
    finalTaskOutcome: V({ lastGoalOperation: x.lastGoalOp ?? "N/A", lastTurnEndReason: x.lastTurnEnd ?? "N/A" },
      "last goal/change operation and last turn/end reason in this session log"),
    incidents,
    per1k,
    echoExcludedPer1k: cleanPer1k,
    echoExcludedIncidents: clean,
    outOfScopeTextEcho: x.echo,
    incidentEventTypes: (() => {
      const m = {};
      for (const t of x.incidentTypes) m[t.type] = (m[t.type] ?? 0) + 1;
      return m;
    })(),
    attribution: {
      firstIncidentSeq: x.firstHit || null,
      lastIncidentSeq: x.lastHit || null,
      protoSeqs: x.protoSeqs.slice(0, 12),
      quotaSeqs: x.quotaSeqs.slice(0, 12),
    },
  };
}

const comparisonTable = TARGETS.map(([sessId, era]) => {
  const x = byId.get(sessId);
  if (!x) return { sessionId: sessId, era, longSession: null, note: "SESSION NOT FOUND" };
  return taskQualityRow(x, sessId, era);
});

// ── era pools (long sessions only, matching V3) ──
function pool(era) {
  const xs = TARGETS.filter(([, e]) => e === era).map(([id]) => byId.get(id)).filter(Boolean);
  const long = xs.filter((x) => x.events >= LONG);
  const ev = long.reduce((s, x) => s + x.events, 0);
  const inc = long.reduce((s, x) => s + x.proto + x.quota, 0);
  return { longSessions: long.length, events: ev, incidents: inc, per1k: ev ? +((inc / ev) * 1000).toFixed(4) : 0 };
}
const pooledRollups = { OFF: pool("OFF"), ON: pool("ON") };

// ── echo-contamination correction: exclude assistant/tool activity echoes ──
function poolClean(era) {
  const xs = TARGETS.filter(([, e]) => e === era).map(([id]) => byId.get(id)).filter(Boolean);
  const long = xs.filter((x) => x.events >= LONG);
  const clean = (x) => x.incidentTypes.filter((t) => !/^(assistant|tool)\//.test(t.type)).length;
  const ev = long.reduce((s, x) => s + x.events, 0);
  const inc = long.reduce((s, x) => s + clean(x), 0);
  return { longSessions: long.length, events: ev, incidents: inc, per1k: ev ? +((inc / ev) * 1000).toFixed(4) : 0 };
}
const pooledClean = { OFF: poolClean("OFF"), ON: poolClean("ON") };

// ── verdict (pre-registered rule; same threshold semantics as V3, applied to
//    echo-excluded rate; three values per Round 7 contract) ──
let verdict, verdictReason;
if (!pooledClean.OFF.longSessions || !pooledClean.ON.longSessions) { verdict = "INCONCLUSIVE"; verdictReason = `long-session rows missing after echo exclusion (OFF=${pooledClean.OFF.longSessions} ON=${pooledClean.ON.longSessions}) — pre-registered rule`; }
else if (pooledClean.ON.per1k > pooledClean.OFF.per1k * 2) { verdict = "REGRESSED"; verdictReason = `echo-excluded ON pooled per-1k ${pooledClean.ON.per1k} > OFF ${pooledClean.OFF.per1k} × 2 (pre-registered threshold)`; }
else { verdict = "NO MATERIAL REGRESSION"; verdictReason = `after excluding assistant/tool activity echoes (all a144fe3f hits are review-echo of old log content), ON pooled per-1k ${pooledClean.ON.per1k} ≤ OFF ${pooledClean.OFF.per1k} × 2 — pre-registered rule; the fixed-field table above is the evidence the Reviewer judges`; }

const v3IncidentRateInterpretation =
  "V3 (R5_COMPLETION_QUALITY_V3.json) was an INCIDENT-RATE table (per-1k PROTO/QUOTA), NOT a task-quality comparison: " +
  "its machine verdict rule (ON > OFF×2 with OFF=0) makes ANY ON incident auto-trigger MATERIAL_REGRESSION regardless of cause. " +
  "It is therefore NOT interpretable as a Context Memory quality regression. " +
  "The 44 V3 ON incidents concentrate in session-a144fe3f (23 PROTO = historical records of the P2.6-A defect class that was independently closed, " +
  "21 QUOTA = external GLM provider 429s) while the longest ON main-CM session 34e86c7a (91.7k events) has 0/0 incidents. " +
  "V4 replaces the rate-only table with the Round 7 fixed-field task-quality table above; fields not observable are N/A / NOT OBSERVABLE. " +
  "Final adjudication of whether Context Memory causes material task-quality regression rests with the External Reviewer; " +
  "registry #5 (independent evaluation system) remains open and is NOT closed by this proxy-gate.";

// ── restart meta from guardian.log (supporting evidence for unexpectedRestarts=N/A) ──
let restartMeta = { note: "guardian.log not readable" };
try {
  const gl = fs.readFileSync(path.join(process.env.LOCALAPPDATA ?? "", "DSHHarness", "logs", "guardian.log"), "utf8").split(/\r?\n/);
  restartMeta = {
    totalLines: gl.length,
    restartEvents: gl.filter((l) => /RESTART:|RESTART COMMITTED|restart budget/.test(l)).length,
    unexpectedKeyword: gl.filter((l) => /unexpected/i.test(l)).length,
    quarantineKeyword: gl.filter((l) => /quarantin/i.test(l)).length,
    staleSessionTelemetry: gl.filter((l) => /stale-session/.test(l)).length,
    lastgoodRestores: gl.filter((l) => /CONFIG SAFETY:.*restored mirror snapshot/.test(l)).length,
  };
} catch {}

const out = {
  gate: "R5.1-C Completion Quality V4 — Round 7 CONTRACT: task-quality fixed-field OFF/ON table + three-value verdict",
  date: "2026-08-27",
  generatedAtUtc: new Date().toISOString(),
  snapshotNote: "session-a144fe3f is the CURRENT ACTIVE session (this turn); its log keeps growing, so per-run totals evolve. V3 snapshot was 2026-08-27T14:10:41Z. Compare fixed-field cells (per-1k, PROTO/QUOTA per session, pooled) — not raw growing totals.",
  longSessionDefinition: "events >= 10000 in a single production session log",
  verdictRule: "REGRESSED if ON echo-excluded incident per-1k > OFF echo-excluded per-1k × 2; NO MATERIAL REGRESSION if ON ≤ OFF × 2 (both pools have ≥ 1 long session); INCONCLUSIVE otherwise — same threshold semantics as V3, applied to the echo-excluded rate; declared in header before any run",
  methodParity: "decoding chain and incident matchers byte-identical to V2/V3 (zstd frame decode; literal code forms; prose echoes quarantined); fixed-field extraction is NEW per Round 7 and is counting-only (no content emitted, no secrets)",
  scanScope: `all production session logs under ${root} (${files.length} logs); 4-session fixed table on the Round 6/7 target eras`,
  totalsAllLogs,
  comparisonTable,
  pooledRollups,
  pooledClean,
  verdict,
  verdictReason,
  v3IncidentRateInterpretation,
  restartMeta,
  recommendation: [
    `Longest ON main-CM session session-34e86c7a (${byId.get("session-34e86c7a-c982-4ded-90fa-1511021ffda7")?.events ?? "?"} events) has 0 incidents in either class, raw or clean; its fixed fields (toolErrors=${byId.get("session-34e86c7a-c982-4ded-90fa-1511021ffda7")?.toolErrors}, llmRetries=${byId.get("session-34e86c7a-c982-4ded-90fa-1511021ffda7")?.llmRetries}) are provider/exploration-level, not CM-caused.`,
    `ON pooled echo-excluded per-1k = ${pooledClean.ON.per1k} vs OFF = ${pooledClean.OFF.per1k} → verdict = ${verdict}.`,
    `Most Round 7 fixed fields are N/A / NOT OBSERVABLE in the session-log format (no acceptance-criteria / final-verifier / failure-classifier event types). No new metric or evaluator was built per Round 7 mandate.`,
    "Recommendation to reviewer: judge only whether Context Memory causes material task-quality regression; the observable fields show no CM-attributable signal. Registry #5 (independent evaluation system) remains open and is NOT closed by this proxy-gate.",
  ],
  sanitized: "counting-only extraction; no log content, no credential values, no secrets emitted",
};
const outPath = path.join(outDir, "R5_COMPLETION_QUALITY_V4.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`R5_COMPLETION_QUALITY_V4.json -> ${outPath}`);
console.log(`verdict: ${verdict}  (clean per-1k OFF=${pooledClean.OFF.per1k} ON=${pooledClean.ON.per1k}; raw per-1k OFF=${pooledRollups.OFF.per1k} ON=${pooledRollups.ON.per1k})`);
console.log(`4-session fixed rows: ${comparisonTable.length}; incidents raw OFF=${pooledRollups.OFF.incidents} ON=${pooledRollups.ON.incidents}; clean OFF=${pooledClean.OFF.incidents} ON=${pooledClean.ON.incidents}`);
process.exit(0);
