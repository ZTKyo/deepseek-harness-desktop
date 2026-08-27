// make-r5-recall5-exact-v2.mjs — P2.5 R5.1-A: dual-gate (strict-provenance × semantic)
// recall generator replacing make-r5-recall5-exact.mjs (Round-5 rejected artifacts).
//
// ROOT CAUSES FIXED vs v1 (which Round 5 flagged as semantic false-positive risk):
//   1. v1 passed C1..C4 items as "PASS" WITHOUT running the strict verifier
//      (resolveClaim) on them. v2 runs resolveClaim on EVERY sampled claim of
//      EVERY class; strict pass is a hard precondition.
//   2. v1 had NO semantic layer: a `<system-reminder>`-wrapped injection inside a
//      user/message envelope verified byte-identical to genuine user wording.
//      v2 adds per-class semantic gates (see SEMANTIC GATES below).
//   3. v1 printed verdict strings like "5/5 PASS" regardless of actual outcome and
//      hard-coded C5 eventType="N/A"/result="PASS" without building a raw chain.
//      v2 computes an honest verdictSummary ("N PASS + M PROVENANCE_GAP [+ K FAIL]")
//      and builds the C5 chain from REAL raw events with numeric ordering +
//      duplicateSideEffectCount, mirroring §15/Timeline+SideEffectChain semantics.
//
// SEMANTIC GATES (mirrored verbatim by make-r5-recall-final-neg.mjs — single source
// of truth; negative regression edits MUST keep both in sync via import):
//   USER_WORDING (goal ← user/message):
//     - event text matching INJECTION_RX (system-reminder/workspace instruction/
//       AGENTS.md directive envelopes) ⇒ FAIL_injection_wrapped_not_direct_user_wording.
//   TOOL_OUTPUT (completedActions/runtimeFacts/verifiedEvidence ← tool/result):
//     - TODO_RX ("Updated todo list…") noise ⇒ FAIL_todo_noise_not_tool_output;
//     - ≥3 unified-diff hunk lines ⇒ FAIL_looks_like_patch_evidence.
//   ERROR_RECORD (failedApproaches/blockers):
//     - claim text lacks error wording ⇒ FAIL_claim_lacks_error_evidence;
//     - backing event text lacks error evidence ⇒ FAIL_ref_event_lacks_error_evidence.
//   FILE_OPERATION (keyFileChanges):
//     - TODO_RX noise ⇒ FAIL_false_file_evidence_todo_noise (the Round-5 C4 killer);
//     - no real file-op signature (≥3 diff hunks, or explicit create/update marker
//       together with a concrete path token) ⇒ FAIL_no_file_op_signature.
//
// Usage: node make-r5-recall5-exact-v2.mjs <live-events.json> <live-store.json>
//            <context-memory-core.mjs> <outDir> [logPathForMetadata]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const [, , eventsFile, storeFile, coreFile, outDir, metaLogPath] = process.argv;

const SNAP_URL = pathToFileURL(path.resolve(import.meta.dirname, "cm-r5-recall-verifier-snapshot.mjs")).href;
const {
  CLASS_SECTIONS, expectedTypesFor, normalizeText, containment,
  extractEventText, pickNewestK, resolveClaim, checkTimeline,
} = await import(SNAP_URL);

// Lazy runtime loader — imported modules (NEG regression) never touch real files.
async function loadRuntime() {
  if (!eventsFile || !storeFile || !coreFile || !outDir) {
    console.error("usage: node make-r5-recall5-exact-v2.mjs <events.json> <store.json> <core.mjs> <outDir> [logPath]");
    process.exit(64);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const CORE = await import(pathToFileURL(path.resolve(coreFile)).href);
  const events = JSON.parse(fs.readFileSync(eventsFile, "utf8"));
  const store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
  return { CORE, events, store };
}

// ── sanitization (same secret surface as production snapshot) ──
const SECRET_RX = /(sk-[A-Za-z0-9_\-]{6,})|(Bearer\s+[A-Za-z0-9._\-]{8,})|((api[_-]?key|token|password|secret|authorization)["'\s:=]+[^\s"',}\]]{6,})/gi;
function mask(s) { return String(s ?? "").replace(SECRET_RX, "***"); }
function excerpt(t, max = 160) { const s = mask(normalizeText(t)); return s.length > max ? s.slice(0, max) + "…" : s; }

// ── walk claims (canonical shape: store.obs.<section>, goal singleton) ──
export function walkStoreClaims(storeLike) {
  const out = [];
  const root = storeLike.obs ?? storeLike;
  const pushSection = (section, node) => {
    if (node == null) return;
    if (section === "goal") {
      if (typeof node.t === "string" && Array.isArray(node.refs)) out.push({ section, text: node.t, refs: node.refs.slice(), index: 0 });
      return;
    }
    if (!Array.isArray(node)) return;
    node.forEach((entry, i) => {
      if (entry && typeof entry.t === "string" && Array.isArray(entry.refs)) out.push({ section, text: entry.t, refs: entry.refs.slice(), index: i });
    });
  };
  for (const k of CLASS_SECTIONS) pushSection(k, root[k]);
  return out;
}

// ── semantic layer (single source of truth; neg script imports these) ──
export const INJECTION_RX = /<system-reminder>|<system_warning>|<workspace[-_ ]instruction|instructions from|AGENTS\.md|global directive|developer message/i;
export const TODO_RX = /updated todo list/i;
export const ERR_RX_EVENT = /\[exit code: [1-9]|\berror\b|fail(?:ed)?|\bcrash\b|timeout|reject(?:ed)?|denied|refused|not found|unreachable|\bHTTP \d{3}\b|"status"\s*:\s*4\d\d|validation_error|EPERM|EACCES/i;
export const ERR_RX_CLAIM = /error|fail|crash|timeout|reject|denied|refused|exit code|not found|unreachable/i;
export const FILE_PATH_RX = /[A-Za-z]:\\[^\s"'`]+\.\w{1,5}|(^|[\s`(])((?:docs|plugins|tests|DSH-Client|apps)\/[\w\-./]+\.\w{1,5})|<path>[A-Za-z]:[^<]*?\.[A-Za-z0-9]{1,5}<\/path>/;
// R5.1-A: third alternative accepts the DSH tool-receipt shape "<path>C:\...\name.md</path>"
// where the directory chain contains SPACES (e.g. workspace "...\\sdeepseek harness\\..."),
// which the bare token class cannot span. Registered in R5_1_FINAL_EVIDENCE_CORRECTION.md.
export const OP_MARKER_RX = /\b(created|updated|deleted|edited|wrote|renamed)\b.{0,80}?(file|file:?|\.mjs|\.js|\.json|\.yaml|\.yml|\.md|\.ps1|\.cmd)|files? changed|create mode\s|successfully updated/i;

function diffLineCount(text) { const m = String(text ?? "").match(/^[+-]{1,3} \S/gm); return m ? m.length : 0; }

export function semanticGate(section, claimText, evtText) {
  // Section → semantic family
  const family =
    section === "goal" ? "USER_WORDING" :
    section === "failedApproaches" || section === "blockers" ? "ERROR_RECORD" :
    section === "completedActions" || section === "runtimeFacts" || section === "verifiedEvidence" ? "TOOL_OUTPUT" :
    "FILE_OPERATION";
  const evt = String(evtText ?? "");
  const claim = String(claimText ?? "");
  switch (family) {
    case "USER_WORDING": {
      if (INJECTION_RX.test(evt) || INJECTION_RX.test(claim))
        return { ok: false, reason: "FAIL_injection_wrapped_not_direct_user_wording" };
      return { ok: true, reason: "PASS_direct_user_wording" };
    }
    case "TOOL_OUTPUT": {
      if (TODO_RX.test(evt) || TODO_RX.test(claim)) return { ok: false, reason: "FAIL_todo_noise_not_tool_output" };
      if (diffLineCount(evt) >= 3) return { ok: false, reason: "FAIL_looks_like_patch_evidence" };
      return { ok: true, reason: "PASS_machine_result_shape" };
    }
    case "ERROR_RECORD": {
      if (!ERR_RX_CLAIM.test(claim)) return { ok: false, reason: "FAIL_claim_lacks_error_evidence" };
      if (!ERR_RX_EVENT.test(evt)) return { ok: false, reason: "FAIL_ref_event_lacks_error_evidence" };
      return { ok: true, reason: "PASS_error_evidenced_in_both_claim_and_raw_event" };
    }
    default: { // FILE_OPERATION
      if (TODO_RX.test(evt) || TODO_RX.test(claim)) return { ok: false, reason: "FAIL_false_file_evidence_todo_noise" };
      const strong = diffLineCount(evt) >= 3 || (FILE_PATH_RX.test(evt) && OP_MARKER_RX.test(evt));
      if (!strong) return { ok: false, reason: "FAIL_no_file_op_signature" };
      return { ok: true, reason: "PASS_real_file_op_signature" };
    }
  }
}

// Multi-ref aware: every backing ref's extracted text must clear its gate.
export function semanticGateAll(section, claimText, refs, mapFn) {
  let lastFail = null;
  for (const r of refs) {
    const evtText = mapFn(r);
    const g = semanticGate(section, claimText, evtText);
    if (!g.ok) { lastFail = { ...g, ref: r }; break; }
  }
  return lastFail ?? { ok: true, reason: "PASS_all_refs_semantic_clear" };
}

// ── C5: timeline over deployed refs (corroboration) + RAW side-effect chain ──
export const SIDE_EFFECT_FAMILIES = ["RESTART", "PROVIDER_SWITCH", "CONFIG_CHANGE", "STATE_RENAME", "CONTROLLED_OP", "FILE_WRITE"];
export function sideEffectFamily(text) {
  const t = String(text ?? "");
  if (/restart|restarting server|server start|listening on|boot sequence|ready in|守护自动恢复|guardian.*(拉起|restart)/i.test(t)) return "RESTART";
  if (/provider switch|switch(?:ed)? (?:to )?(?:provider|model|routing)|routed to|fallback to/i.test(t)) return "PROVIDER_SWITCH";
  if (/settings\.yaml|cordis\.patch\.yml|YAML (?:校验|valid)|hot publish|热发布|config update/i.test(t)) return "CONFIG_CHANGE";
  if (/\brename[d]?\b|\bmv\b |\bmoved?\b/i.test(t) && FILE_PATH_RX.test(t)) return "STATE_RENAME";
  if (/pull request #\d+|PR #\d+|\bmerged?\b.*(\b[0-9a-f]{7,40}\b|into main)|git push|\bgit tag\b|checkpoint/i.test(t)) return "CONTROLLED_OP";
  const dlc = diffLineCount(t);
  if (dlc >= 3 || (FILE_PATH_RX.test(t) && OP_MARKER_RX.test(t))) return "FILE_WRITE";
  return null;
}

export function evaluateSideEffectChain(resolvedPassRefs, events, getSeqText /* (seq)=>text|null */) {
  // targets: distinct seqs cited by strictly-resolved claims that ARE side effects
  const cand = [...new Set(resolvedPassRefs)].sort((a, b) => a - b)
    .filter((s) => SIDE_EFFECT_FAMILIES.includes(sideEffectFamily(getSeqText(s))));
  if (cand.length === 0) return { ok: false, reason: "FAIL_no_side_effect_target_found" };
  const t = cand[cand.length - 1]; // newest
  const beforePool = resolvedPassRefs.filter((s) => s < t).sort((a, b) => a - b);
  const b = beforePool[beforePool.length - 1];
  const afterCandidates = [];
  for (const e of events) {
    const s = Number(e.seq);
    if (!(s > t)) continue;
    const fam = sideEffectFamily(getSeqText(s));
    if (fam) afterCandidates.push(s);
  }
  afterCandidates.sort((x, y) => x - y);
  const a = afterCandidates[0];
  if (!Number.isFinite(b)) return { ok: false, reason: "FAIL_chain_before_missing", targetEvent: t };
  if (!Number.isFinite(a)) return { ok: false, reason: "FAIL_chain_after_missing", targetEvent: t };
  if (!(b < t && t < a)) return { ok: false, reason: "FAIL_chain_order_violation", beforeEvent: b, targetEvent: t, afterEvent: a };
  const tHead = normalizeText(mask(getSeqText(t))).slice(0, 80);
  const duplicateSideEffectCount = cand.filter((s) =>
    s !== t && sideEffectFamily(getSeqText(s)) === sideEffectFamily(getSeqText(t)) &&
    normalizeText(mask(getSeqText(s))).slice(0, 80) === tHead).length;
  return {
    ok: true, reason: "PASS_raw_side_effect_chain",
    beforeEvent: b, targetEvent: t, afterEvent: a,
    eventType: evTypeOf(events, t), sideEffectFamily: sideEffectFamily(getSeqText(t)),
    duplicateSideEffectCount,
  };
}
function evTypeOf(events, seq) { const e = events.find((x) => Number(x.seq) === Number(seq)); return e ? String(e.type) : "N/A"; }

// Class-level outcome with honest PROVENANCE_GAP (allowed ONLY for error-record
// classes whose entire pool is empty — documented natural state, never dressed up).
export function evaluateClass(outcomes) {
  if (outcomes.length === 0) return "PROVENANCE_GAP";
  return outcomes.every((o) => o.finalResult === "PASS") ? "PASS" : "FAIL";
}
export const GAP_ALLOWED_SECTIONS = new Set(["failedApproaches", "blockers"]); // error-record pools

// ─────────────────────────────── MAIN ───────────────────────────────
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { CORE, events, store } = await loadRuntime();
  const evBySeq = new Map(events.map((e) => [Number(e.seq), e]));
  const extractCache = new Map();
  const textOf = (evt) => {
    const k = Number(evt.seq);
    if (!extractCache.has(k)) extractCache.set(k, extractEventText(evt, CORE));
    return extractCache.get(k);
  };
  const walked = walkStoreClaims(store);
  console.log(`walked ${walked.length} claims from store`);

  const shared = { evBySeq, extractCache };
  const resolvedPassRefs = [];
  const classesOut = [];

  const GROUPS = [
    { id: "C1", label: "USER_ORIGINAL_WORDING", sections: ["goal"], k: 3 },
    { id: "C2", label: "ORIGINAL_ERROR_RECORD", sections: ["failedApproaches", "blockers"], k: 3 },
    { id: "C3", label: "TOOL_RUNTIME_EVIDENCE", sections: ["completedActions", "runtimeFacts", "verifiedEvidence"], k: 3 },
    { id: "C4", label: "PATCH_FILE_EVIDENCE", sections: ["keyFileChanges"], k: 3 },
  ];

  for (const g of GROUPS) {
    const pool = walked.filter((c) => g.sections.includes(c.section));
    const picked = pickNewestK(pool, g.k);
    const outcomes = picked.map((claim) => {
      const strict = resolveClaim(claim, events, CORE, shared);
      const sem = strict.ok
        ? semanticGateAll(claim.section, claim.text, claim.refs, (r) => textOf(evBySeq.get(Number(r))))
        : { ok: false, reason: strict.reason };
      const finalResult = strict.ok && sem.ok ? "PASS" : "FAIL";
      if (finalResult === "PASS") for (const r of claim.refs) resolvedPassRefs.push(Number(r));
      const firstRefEvt = evBySeq.get(Number(claim.refs[0]));
      return {
        class: g.id, sourceSessionId: store.sessionId ?? "unknown",
        claimPath: `${claim.section}[${claim.index}]`,
        claim: excerpt(claim.text, 200),
        refs: claim.refs.map(String),
        matchedSeq: claim.refs.map(String),
        eventType: firstRefEvt ? String(firstRefEvt.type) : "MISSING",
        semanticType: { goal: "USER_WORDING", failedApproaches: "ERROR_RECORD", blockers: "ERROR_RECORD", completedActions: "TOOL_OUTPUT", runtimeFacts: "TOOL_OUTPUT", verifiedEvidence: "TOOL_OUTPUT", keyFileChanges: "FILE_OPERATION" }[claim.section],
        excerptOrFingerprint: excerpt(textOf(firstRefEvt)),
        strictSourceResult: { ok: strict.ok, reason: strict.reason, multihit: strict.multihit === true, hits: Array.isArray(strict.hits) ? strict.hits.length : undefined },
        semanticResult: { ok: sem.ok, reason: sem.reason, ...(sem.ref !== undefined ? { failRef: sem.ref } : {}) },
        finalResult,
      };
    });
    const verdict = evaluateClass(outcomes);
    const gapOk = verdict === "PROVENANCE_GAP" && g.sections.every((s) => GAP_ALLOWED_SECTIONS.has(s));
    classesOut.push({
      classId: g.id, label: g.label, sections: g.sections,
      poolSize: pool.length, sampled: outcomes.length,
      verdict, gapAccepted: gapOk || undefined,
      items: outcomes,
    });
  }

  // C5 — dual corroboration: deployed refs-window timeline (existing primitive)
  const tl = checkTimeline(store, events);
  // ...plus RAW three-event side-effect chain (§15 semantics)
  const chain = evaluateSideEffectChain([...new Set(resolvedPassRefs)].sort((a, b) => a - b), events, (s) => { const e = evBySeq.get(s); return e ? textOf(e) : null; });
  const c5Ok = tl.ok === true && chain.ok === true;
  const c5Verdict = c5Ok ? "PASS"
    : (!chain.ok && /after_missing|no_side_effect/.test(chain.reason) && tl.ok) ? "PROVENANCE_GAP" : "FAIL";
  classesOut.push({
    classId: "C5", label: "TIMELINE_SIDE_EFFECT",
    sections: ["refs-windows", "raw-chain"],
    poolSize: Array.isArray(store.refs) ? store.refs.length : 0, sampled: 1,
    verdict: c5Verdict,
    timeline: { ok: tl.ok, reason: tl.reason },
    items: [{
      class: "C5", sourceSessionId: store.sessionId ?? "unknown",
      claimPath: "store.refs + raw-log-side-effect-chain",
      claim: "before < TARGET(real side effect) < after enforced on RAW event numbers",
      refs: [], matchedSeq: [],
      eventType: chain.eventType ?? "N/A",
      semanticType: "TIMELINE_SIDE_EFFECT",
      excerptOrFingerprint: chain.ok ? excerpt(evBySeq.get(chain.targetEvent) ? textOf(evBySeq.get(chain.targetEvent)) : "", 120) : "",
      strictSourceResult: { ok: c5Ok, reason: c5Ok ? "PASS_refs_windows_and_raw_chain" : `timeline=${tl.reason} chain=${chain.reason}` },
      semanticResult: { ok: chain.ok, reason: chain.reason, ...(chain.sideEffectFamily ? { sideEffectFamily: chain.sideEffectFamily } : {}), ...(Number.isFinite(chain.duplicateSideEffectCount) ? { duplicateSideEffectCount: chain.duplicateSideEffectCount } : {}) },
      finalResult: c5Ok ? "PASS" : c5Verdict === "PROVENANCE_GAP" ? "GAP" : "FAIL",
      beforeEvent: chain.beforeEvent !== undefined ? { seq: chain.beforeEvent } : undefined,
      targetEvent: chain.targetEvent !== undefined ? { seq: chain.targetEvent } : undefined,
      afterEvent: chain.afterEvent !== undefined ? { seq: chain.afterEvent } : undefined,
      duplicateSideEffectCount: Number.isFinite(chain.duplicateSideEffectCount) ? chain.duplicateSideEffectCount : undefined,
    }],
  });

  // ── honest verdict summary ──
  const nPass = classesOut.filter((c) => c.verdict === "PASS").length;
  const nGap = classesOut.filter((c) => c.verdict === "PROVENANCE_GAP").length;
  const nFail = classesOut.filter((c) => c.verdict === "FAIL").length;
  const parts = [];
  if (nPass) parts.push(`${nPass} PASS`);
  if (nGap) parts.push(`${nGap} PROVENANCE_GAP`);
  if (nFail) parts.push(`${nFail} FAIL`);
  const verdictSummary = parts.join(" + ") || "NO_DATA";
  const unacceptedGap = nGap > 0 && classesOut.some((c) => c.verdict === "PROVENANCE_GAP" && !c.gapAccepted);
  const ok = nFail === 0 && !unacceptedGap;

  let logSha = null, storeSha = null;
  try { logSha = crypto.createHash("sha256").update(fs.readFileSync(eventsFile)).digest("hex"); } catch {}
  try { storeSha = crypto.createHash("sha256").update(fs.readFileSync(storeFile)).digest("hex"); } catch {}

  const redactHome = (p) => String(p ?? "").replace(new RegExp(os.homedir().replace(/\\/g, "\\\\"), "g"), "~");
  const st = fs.statSync(storeFile);
  const output = {
    spec: "P2.6 R5.1-A recall v2 — dual-gate strict×semantic, honest packaging",
    generatedAt: new Date().toISOString(),
    generator: "make-r5-recall5-exact-v2.mjs",
    strictPrimitives: "cm-r5-recall-verifier-snapshot.mjs (resolveClaim/containment/checkTimeline)",
    sourceLog: {
      sessionId: store.sessionId ?? null,
      logPathRedacted: redactHome(metaLogPath ?? null),
      decodedEvents: events.length,
    },
    inputHashes: { logSha256: logSha, storeSha256: storeSha },
    storeMeta: { version: store.version, watermark: store.watermark, active: store.active, refsCount: Array.isArray(store.refs) ? store.refs.length : 0 },
    counts: { walked: walked.length, classesSampled: classesOut.reduce((n, c) => n + c.sampled, 0) },
    classes: classesOut,
    verdictSummary,
    ok,
    sanitized: true,
    note: ok
      ? (nGap > 0
        ? "All applicable classes PASS under dual gate; PROVENANCE_GAP counts only classes whose pool is naturally empty (original-error record), reported honestly instead of dressing up as 5/5."
        : "All 5 semantic classes resolved from live store under strict+semantic gates.")
      : "One or more classes FAILED under dual gate — artifact honestly reports failure.",
  };

  const outPath = path.join(outDir, "R5_RECALL5_EXACT_V2.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 1));
  console.log(`\nR5_RECALL5_EXACT_V2.json written: ${outPath}`);
  console.log(JSON.stringify({
    sessionId: output.sourceLog.sessionId,
    verdictSummary, ok,
    classes: classesOut.map((c) => `${c.classId}:${c.verdict}${c.gapAccepted ? "(accepted-gap)" : ""}`),
    chain: { ok: chain.ok, reason: chain.reason, before: chain.beforeEvent, target: chain.targetEvent, after: chain.afterEvent, dups: chain.duplicateSideEffectCount },
    timeline: { ok: tl.ok, reason: tl.reason },
  }, null, 1));
  process.exit(ok ? 0 : 2);
}
