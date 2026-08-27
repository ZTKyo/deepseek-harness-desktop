// make-r5-recall5-exact-v3.mjs — P2.5 R5.1-B: Recall 5-class REPRESENTATIVE gate (Round 6 contract).
// Replaces v2's per-item all-must-pass packaging per Round 6 BLOCKER 1/C4 semantics:
//   - C2 ORIGINAL_ERROR_RECORD: cross-session representative allowed ("可以跨真实 Session 选代表样本").
//     Main live store (34e86c7a) failed C2 with a Temp-dir listing blocker — semantic gate correctly
//     rejected it; V3 resolves C2 from ANOTHER real production store (c4cc512e) whose blockers[0]
//     "Error: tool call timed out after 60000ms" → own ref 52405 → raw error event. NO production change.
//   - C4 PATCH_FILE_EVIDENCE: required representative PASS + noise diagnostics SEPARATELY
//     (noiseVerdict=HARDENING_DEBT); noise no longer fails the class.
//   - C1/C3/C5: unchanged dual-gate logic on the main live store (Round 6 accepted status preserved).
// Single source of truth preserved: imports the SAME snapshot primitives + v2 semantic gates.
//
// Usage: node make-r5-recall5-exact-v3.mjs <main-events> <main-store> <c2-events> <c2-store>
//                                          <core.mjs> <outDir> [metaLogPath]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const [, , eventsFile, storeFile, c2EventsFile, c2StoreFile, coreFile, outDir, metaLogPath] = process.argv;
if (!eventsFile || !storeFile || !c2EventsFile || !c2StoreFile || !coreFile || !outDir) {
  console.error("usage: node make-r5-recall5-exact-v3.mjs <main-events> <main-store> <c2-events> <c2-store> <core.mjs> <outDir> [logPath]");
  process.exit(64);
}
fs.mkdirSync(outDir, { recursive: true });

// resolve companion modules relative to THIS script (they live side-by-side in evidence/),
// never relative to the fixtures dir.
const SNAP_URL = new URL("./cm-r5-recall-verifier-snapshot.mjs", import.meta.url).href;
const V2_URL = new URL("./make-r5-recall5-exact-v2.mjs", import.meta.url).href;
const {
  CLASS_SECTIONS, pickNewestK, resolveClaim, checkTimeline, extractEventText,
} = await import(SNAP_URL);
const {
  walkStoreClaims, semanticGateAll, evaluateSideEffectChain,
  FILE_PATH_RX, OP_MARKER_RX,
} = await import(V2_URL);
const CORE = await import(pathToFileURL(path.resolve(coreFile)).href);

const events = JSON.parse(fs.readFileSync(eventsFile, "utf8"));
const store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
const c2Events = JSON.parse(fs.readFileSync(c2EventsFile, "utf8"));
const c2Store = JSON.parse(fs.readFileSync(c2StoreFile, "utf8"));

const SECRET_RX = /(sk-[A-Za-z0-9_\-]{6,})|(Bearer\s+[A-Za-z0-9._\-]{8,})|((api[_-]?key|token|password|secret|authorization)["'\s:=]+[^\s"',}\]]{6,})/gi;
const mask = s => String(s ?? "").replace(SECRET_RX, "***");
const norm = s => String(s ?? "").replace(/\s+/g, " ").trim();
const excerpt = (t, max = 160) => { const s = mask(norm(t)); return s.length > max ? s.slice(0, max) + "…" : s; };
const sha256 = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const redactHome = p => String(p ?? "").replace(new RegExp(os.homedir().replace(/\\/g, "\\\\"), "g"), "~");

function bind(eventsArr, storeObj) {
  const evBySeq = new Map(eventsArr.map(e => [Number(e.seq), e]));
  const extractCache = new Map();
  const textOf = evt => { const k = Number(evt.seq); if (!extractCache.has(k)) extractCache.set(k, extractEventText(evt, CORE)); return extractCache.get(k); };
  return { evBySeq, textOf, shared: { evBySeq, extractCache } };
}
const main = bind(events, store);
const c2 = bind(c2Events, c2Store);

const SEM_TYPE = { goal: "USER_WORDING", failedApproaches: "ERROR_RECORD", blockers: "ERROR_RECORD", completedActions: "TOOL_OUTPUT", runtimeFacts: "TOOL_OUTPUT", verifiedEvidence: "TOOL_OUTPUT", keyFileChanges: "FILE_OPERATION" };

function itemFor(claim, ctx, eventsArr, cls) {
  const strict = resolveClaim(claim, eventsArr, CORE, ctx.shared);
  const sem = strict.ok
    ? semanticGateAll(claim.section, claim.text, claim.refs, r => ctx.textOf(ctx.evBySeq.get(Number(r))))
    : { ok: false, reason: strict.reason };
  const firstRefEvt = ctx.evBySeq.get(Number(claim.refs[0]));
  return {
    class: cls, sourceSessionId: store.sessionId,
    claimPath: `${claim.section}[${claim.index}]`,
    claimFingerprint: excerpt(claim.text, 200),
    refs: claim.refs.map(String),
    matchedSeq: claim.refs.map(String),
    eventType: firstRefEvt ? String(firstRefEvt.type) : "MISSING",
    semanticType: SEM_TYPE[claim.section],
    excerptOrFingerprint: excerpt(ctx.textOf(firstRefEvt)),
    strictSourceResult: { ok: strict.ok, reason: strict.reason, multihit: strict.multihit === true },
    semanticResult: { ok: sem.ok, reason: sem.reason, ...(sem.ref !== undefined ? { failRef: sem.ref } : {}) },
    representativeResult: strict.ok && sem.ok ? "PASS" : "FAIL",
  };
}

// ── C1 / C3: main store, unchanged dual gate, newest-K=3 ──
const walked = walkStoreClaims(store);
const resolvedPassRefs = [];
const classesOut = [];
const GROUPS = [
  { id: "C1", label: "USER_ORIGINAL_WORDING", sections: ["goal"] },
  { id: "C3", label: "TOOL_RUNTIME_EVIDENCE", sections: ["completedActions", "runtimeFacts", "verifiedEvidence"] },
];
for (const g of GROUPS) {
  const pool = walked.filter(c => g.sections.includes(c.section));
  const items = pickNewestK(pool, 3).map(claim => {
    const it = itemFor(claim, main, events, g.id);
    if (it.representativeResult === "PASS") for (const r of claim.refs) resolvedPassRefs.push(Number(r));
    return it;
  });
  classesOut.push({
    classId: g.id, label: g.label, sections: g.sections,
    poolSize: pool.length, sampled: items.length,
    sourceSessionId: store.sessionId,
    verdict: items.some(i => i.representativeResult === "PASS") ? "PASS" : "FAIL",
    representativeResult: items.some(i => i.representativeResult === "PASS") ? "PASS" : "FAIL",
    items,
  });
}

// ── C4: representative PASS + SEPARATE noise diagnostics (Round 6 semantics) ──
{
  const pool = walked.filter(c => c.section === "keyFileChanges");
  const items = pickNewestK(pool, 3).map(claim => itemFor(claim, main, events, "C4"));
  const reps = items.filter(i => i.representativeResult === "PASS");
  const noise = items.filter(i => i.representativeResult !== "PASS");
  if (reps.length) for (const r of reps[0].refs.map(Number)) resolvedPassRefs.push(r);
  classesOut.push({
    classId: "C4", label: "PATCH_FILE_EVIDENCE", sections: ["keyFileChanges"],
    poolSize: pool.length, sampled: items.length,
    sourceSessionId: store.sessionId,
    // Round 6: class passes on ≥1 strictly legal real representative; noise reported separately.
    verdict: reps.length ? "PASS" : "FAIL",
    representativeResult: reps.length ? "PASS" : "FAIL",
    noiseCount: noise.length,
    noiseExamplesSanitized: noise.map(n => ({ claimPath: n.claimPath, claimFingerprint: n.claimFingerprint, strictSourceResult: n.strictSourceResult, semanticResult: n.semanticResult })),
    noiseVerdict: noise.length ? "HARDENING_DEBT" : "CLEAN",
    items,
  });
}

// ── C2: cross-session representative from a REAL production store (Round 6 authorization) ──
{
  const c2Walked = walkStoreClaims(c2Store);
  const pool = c2Walked.filter(c => c.section === "failedApproaches" || c.section === "blockers");
  const items = pickNewestK(pool, 3).map(claim => {
    const it = itemFor(claim, c2, c2Events, "C2");
    it.sourceSessionId = c2Store.sessionId; // cross-session representative
    return it;
  });
  const reps = items.filter(i => i.representativeResult === "PASS");
  classesOut.push({
    classId: "C2", label: "ORIGINAL_ERROR_RECORD", sections: ["failedApproaches", "blockers"],
    poolSize: pool.length, sampled: items.length,
    sourceSessionId: c2Store.sessionId,
    verdict: reps.length ? "PASS" : "FAIL",
    representativeResult: reps.length ? "PASS" : "FAIL",
    representative: reps[0] ?? null,
    crossSessionRepresentative: reps.length ? true : undefined,
    mainStoreC2Status: "semantic gate correctly rejected Temp-dir listing (FAIL_claim_lacks_error_evidence) — verifier working as designed",
    items,
  });
}

// ── C5: timeline (deployed refs windows) + RAW side-effect chain on MAIN session ──
const tl = checkTimeline(store, events);
const chain = evaluateSideEffectChain([...new Set(resolvedPassRefs)].sort((a, b) => a - b), events,
  s => { const e = main.evBySeq.get(s); return e ? main.textOf(e) : null; });
const c5Ok = tl.ok === true && chain.ok === true;
classesOut.push({
  classId: "C5", label: "TIMELINE_SIDE_EFFECT", sections: ["refs-windows", "raw-chain"],
  poolSize: Array.isArray(store.refs) ? store.refs.length : 0, sampled: 1,
  sourceSessionId: store.sessionId,
  verdict: c5Ok ? "PASS" : "FAIL",
  representativeResult: c5Ok ? "PASS" : "FAIL",
  timeline: { ok: tl.ok, reason: tl.reason },
  items: [{
    class: "C5", sourceSessionId: store.sessionId,
    claimPath: "store.refs + raw-log-side-effect-chain",
    claimFingerprint: "before < TARGET(real side effect) < after enforced on RAW event numbers",
    refs: [], matchedSeq: [],
    eventType: chain.eventType ?? "N/A",
    semanticType: "TIMELINE_SIDE_EFFECT",
    excerptOrFingerprint: chain.ok && chain.targetEvent && main.evBySeq.get(chain.targetEvent) ? excerpt(main.textOf(main.evBySeq.get(chain.targetEvent)), 120) : "",
    strictSourceResult: { ok: c5Ok, reason: c5Ok ? "PASS_refs_windows_and_raw_chain" : `timeline=${tl.reason} chain=${chain.reason}` },
    semanticResult: { ok: chain.ok, reason: chain.reason, ...(chain.sideEffectFamily ? { sideEffectFamily: chain.sideEffectFamily } : {}), ...(Number.isFinite(chain.duplicateSideEffectCount) ? { duplicateSideEffectCount: chain.duplicateSideEffectCount } : {}) },
    representativeResult: c5Ok ? "PASS" : "FAIL",
    beforeEvent: chain.beforeEvent !== undefined ? { seq: chain.beforeEvent } : undefined,
    targetEvent: chain.targetEvent !== undefined ? { seq: chain.targetEvent } : undefined,
    afterEvent: chain.afterEvent !== undefined ? { seq: chain.afterEvent } : undefined,
    duplicateSideEffectCount: Number.isFinite(chain.duplicateSideEffectCount) ? chain.duplicateSideEffectCount : undefined,
  }],
});

// ── verdict: 5/5 REPRESENTATIVE PASS required (Round 6 FINAL GATE B) ──
const nPass = classesOut.filter(c => c.representativeResult === "PASS").length;
const ok = nPass === 5;
const output = {
  spec: "P2.6 R5.1-B recall v3 — 5-class REPRESENTATIVE gate (Round 6 contract) + separated noise diagnostics",
  generatedAt: new Date().toISOString(),
  generator: "make-r5-recall5-exact-v3.mjs",
  strictPrimitives: "cm-r5-recall-verifier-snapshot.mjs (resolveClaim/containment/checkTimeline)",
  semanticPrimitives: "make-r5-recall5-exact-v2.mjs (semanticGateAll — single source of truth, imported)",
  round6Authorization: "C2 cross-session representative + C4 representative/noise split are the Round 6 BLOCKER-1 contract",
  sources: {
    main: {
      sessionId: store.sessionId, storeVersion: store.version, active: store.active,
      storePathRedacted: redactHome(storeFile), storeSha256: sha256(storeFile),
      eventsPathRedacted: redactHome(eventsFile), eventsSha256: sha256(eventsFile),
      decodedEvents: events.length,
      ...(metaLogPath ? { rawLogRedacted: redactHome(metaLogPath) } : {}),
    },
    c2RepresentativeSource: {
      sessionId: c2Store.sessionId, storeVersion: c2Store.version, active: c2Store.active,
      storePathRedacted: redactHome(c2StoreFile), storeSha256: sha256(c2StoreFile),
      eventsPathRedacted: redactHome(c2EventsFile), eventsSha256: sha256(c2EventsFile),
      decodedEvents: c2Events.length,
    },
  },
  classes: classesOut,
  verdictSummary: `${nPass}/5 REPRESENTATIVE PASS`,
  ok,
  conclusion: ok
    ? "All 5 semantic classes have at least one strictly legal REAL representative (own-ref → raw source) under dual strict×semantic gates. C4 todo noise quarantined as HARDENING_DEBT. C2 resolved cross-session per Round 6 authorization — production provenance fix NOT required."
    : `${5 - nPass} class(es) lack a strictly legal representative — artifact honestly reports failure.`,
};
const outPath = path.join(outDir, "R5_RECALL5_EXACT_V3.json");
fs.writeFileSync(outPath, JSON.stringify(output, null, 1));
console.log(`\nR5_RECALL5_EXACT_V3.json written: ${outPath}`);
console.log(JSON.stringify({
  verdictSummary: output.verdictSummary, ok,
  classes: classesOut.map(c => `${c.classId}:${c.representativeResult}${c.noiseVerdict ? `(noise=${c.noiseVerdict}/${c.noiseCount})` : ""}`),
  chain: { ok: chain.ok, reason: chain.reason, before: chain.beforeEvent, target: chain.targetEvent, after: chain.afterEvent, dups: chain.duplicateSideEffectCount },
  timeline: { ok: tl.ok, reason: tl.reason },
}, null, 1));
process.exit(ok ? 0 : 2);
