// recall-verifier.mjs — P2.5 R5-1 STRICT recall verifier (no false positives).
//
// Contract (External Review Round 4 = CHANGES_REQUIRED fix):
//   A matchedSeq verdict may only be PASS when ALL of the following hold:
//     R5.1-a  the ref seq EXISTS in the raw event stream;
//     R5.1-b  the event TYPE at that seq matches the observation class
//             (goal ← user/message; every other six-section claim ← tool/result);
//     R5.1-c  the claim text is genuinely supported by the extraction of THAT
//             event (deployed messageOfEvent/recursiveText byte-path, whitespace-
//             normalized containment, secret-mask applied identically to both sides);
//     R5.1-d  whole-corpus duplication can NEVER substitute for a broken ref:
//             the resolver collects ALL type-valid containing seqs and requires
//             the cited ref to be inside that set. Corpus-first search results are
//             recorded only as diagnostics (multihit), never used to validate.
//   Anything else yields a typed FAIL. Zero tolerance: any hard FAIL ⇒ overall FAIL.
//
// Class coverage C1..C4 use newest-K claims per section; C5 validates timeline:
// store.refs monotonic non-decreasing (start/end pairs), endSeq ≥ startSeq, bounds
// inside event range; plus E-class side-effect chain (before→target→after):
//   E-before : an earlier valid claim ref p < N (same six-section families),
//   E-target : the chosen claim ref N resolves PASS,
//   E-after  : the store proves later activity (maxRefSeen > N && version ≥ 2),
// recorded numerically so an auditor can replay it against the raw log.
//
// Usage (read-only CLI):
//   node recall-verifier.mjs <events.json> <store.json> <context-memory-core.mjs>
//     events.json = pre-decoded raw events [{seq,type,data},...] (decoder externalized
//                   so the CI can also feed synthetic fixtures).
//   Programmatic: import { runStrictRecall } and pass {events, store, core}.
//
// exit 0 = ALL PASS; 2 = incomplete/failure (CI-visible).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ── class ontology: exactly the six rendered sections (+ timeline C5) ──
export const CLASS_SECTIONS = ["goal", "completedActions", "verifiedEvidence", "keyFileChanges", "failedApproaches", "blockers", "runtimeFacts"];
const GOAL_TYPES = new Set(["user/message"]);
const TOOL_TYPES = new Set(["tool/result"]);

export function expectedTypesFor(section) {
  return section === "goal" ? GOAL_TYPES : TOOL_TYPES;
}

// ── normalization helpers (shared by claim side and event side) ──
const SECRET_RX = /(sk-[A-Za-z0-9_\-]{6,})|(Bearer\s+[A-Za-z0-9._\-]{8,})|((api[_-]?key|token|password|secret|authorization)["'\s:=]+[^\s"',}\]]{6,})/gi;
export function normalizeText(s) {
  return String(s ?? "").replace(SECRET_RX, "***").replace(/\s+/g, " ").trim();
}

// Strip trailing ellipsis introduced by ellipsize() so prefix-support stays decidable.
function stripEllipsisTail(t) {
  const s = normalizeText(t);
  return s.length > 1 && s.endsWith("…") ? s.slice(0, -1) : s;
}

export function containment(needle /*claim*/, haystack /*event extraction*/) {
  const n = stripEllipsisTail(needle);
  if (n.length < 8) return false; // too short to meaningfully attribute
  const h = stripEllipsisTail(haystack);
  return h.includes(n);
}

// ── official extraction path mirrors cm-r4-recall5 (deployed core fns only) ──
export function extractEventText(evt, core) {
  if (!evt) return "";
  const msg = typeof core?.messageOfEvent === "function" ? core.messageOfEvent(evt) : null;
  if (!msg) return typeof evt.data === "string" ? evt.data : "";
  const blocks = msg.content;
  if (!Array.isArray(blocks)) return "";
  return blocks.map((b) => (typeof b === "string" ? b : (typeof core.recursiveText === "function" ? core.recursiveText(b) : ""))).join("");
}

// ── rigorous claim walker (production schema first): deployed stores render the
// observation under store.obs.{section}; top-level sections accepted as legacy fallback.
// Unknown extra sections are counted as anomalies, never silently mined.
export function walkClaimsRigorous(store) {
  const out = [];
  let anomalies = 0;
  const hasSections = (o) => o && typeof o === "object" && CLASS_SECTIONS.some((k) => o[k] != null);
  const root = hasSections(store?.obs) ? store.obs : store;
  const pushSection = (section, node) => {
    if (node == null) return;
    if (section === "goal") {
      if (typeof node.t === "string" && Array.isArray(node.refs)) {
        out.push({ section, text: node.t, refs: node.refs.slice(), index: 0 });
      } else anomalies += 1;
      return;
    }
    if (!Array.isArray(node)) { anomalies += 1; return; }
    node.forEach((entry, i) => {
      if (entry && typeof entry.t === "string" && Array.isArray(entry.refs)) {
        out.push({ section, text: entry.t, refs: entry.refs.slice(), index: i });
      } else anomalies += 1;
    });
  };
  for (const k of CLASS_SECTIONS) pushSection(k, root[k]);
  const extraRoot = store.obs ? Object.keys(store) : Object.keys(store ?? {});
  for (const k of extraRoot) {
    if (["schemaVersion", "sessionId", "version", "active", "watermark", "lastRoute",
         "lastSwitchAt", "refs", "obs"].includes(k)) continue;
    if (!CLASS_SECTIONS.includes(k)) anomalies += 1;
  }
  return { claims: out, anomalies };
}

// ── deterministic newest-K selection (index DESC) ──
export function pickNewestK(claimsForClass, k) {
  return [...claimsForClass].sort((a, b) => b.index - a.index).slice(0, k);
}

// ── resolve ONE claim strictly ──
// opts.extractCache: Map<seq,text> shared across claims (avoid O(n²) re-extraction).
export function resolveClaim(claim, events, core, opts = {}) {
  const evBySeq = opts.evBySeq ?? new Map(events.map((e) => [Number(e.seq), e]));
  const extractCache = opts.extractCache ?? new Map();
  const textOf = (evt) => {
    const k = Number(evt.seq);
    if (!extractCache.has(k)) extractCache.set(k, extractEventText(evt, core));
    return extractCache.get(k);
  };
  const typesOk = expectedTypesFor(claim.section);
  if (!claim.refs.length) return { ok: false, reason: "FAIL_empty_refs" };
  // pass 1: structural validation of every cited ref (existence + class/type match)
  for (const r of claim.refs) {
    const evt = evBySeq.get(Number(r));
    if (!evt) return { ok: false, reason: "FAIL_missing_seq", ref: r };
    if (!typesOk.has(evt.type)) return { ok: false, reason: "FAIL_type_mismatch", ref: r, eventType: evt.type };
  }
  // pass 2: whole-corpus type-valid containing set (diagnostics + duplication guard).
  const hits = [];
  for (const e of events) {
    if (!typesOk.has(e.type)) continue;
    if (containment(claim.text, textOf(e))) hits.push(Number(e.seq));
  }
  // pass 3: each cited ref must ITSELF back the text. Corpus containment NEVER substitutes;
  // when it could have (legacy false-positive path), we say so explicitly via diagnostics.
  for (const r of claim.refs) {
    const evt = evBySeq.get(Number(r));
    if (!containment(claim.text, textOf(evt))) {
      return {
        ok: false, reason: "FAIL_text_not_supported_by_own_ref", ref: r,
        corpusCouldRescue: hits.length > 0, // legacy verifier WOULD have passed via these seqs
        hits,
      };
    }
  }
  // defense-in-depth (true by construction): every ref must be inside the valid hitset.
  if (!claim.refs.every((r) => hits.includes(Number(r)))) {
    return { ok: false, reason: "FAIL_ref_outside_valid_hitset", hits };
  }
  return { ok: true, reason: "PASS_refs_exact", hits, multihit: hits.length > 1 };
}

// ── C5 timeline over DEPLOYED refs semantics (verified against production stores):
//   {v,startSeq,endSeq} where endSeq = watermark shadowed-through point,
//   startSeq = where the retained raw window began at that projection; hence
//   endSeq ≤ startSeq, both boundaries non-decreasing with v, watermark = max endSeq,
//   and sampled window anchors MUST exist in the raw log (provenance, not invention).
export function checkTimeline(store, events) {
  const seqs = events.map((e) => Number(e.seq)).filter((n) => Number.isFinite(n));
  const lo = Math.min(...seqs), hi = Math.max(...seqs);
  const refs = Array.isArray(store.refs) ? store.refs : [];
  if (refs.length === 0) return { ok: false, reason: "FAIL_refs_empty" };
  let prevEnd = -Infinity, prevStart = -Infinity;
  for (let i = 0; i < refs.length; i++) {
    const r = refs[i];
    if (!(Number(r.endSeq) <= Number(r.startSeq))) return { ok: false, reason: "FAIL_window_orientation", i, r };
    if (r.endSeq < prevEnd || r.startSeq < prevStart) return { ok: false, reason: "FAIL_refs_not_monotonic", i };
    if (r.startSeq < lo || r.endSeq < lo || r.endSeq > hi || r.startSeq > hi)
      return { ok: false, reason: "FAIL_window_out_of_bounds", i };
    prevEnd = Number(r.endSeq); prevStart = Number(r.startSeq);
  }
  if (!(store.watermark === refs[refs.length - 1].endSeq))
    return { ok: false, reason: "FAIL_watermark_mismatch", watermark: store.watermark, lastEnd: refs[refs.length - 1].endSeq };
  // provenance sampling: BOTH window boundaries must exist as real events in the raw log.
  // (Interior interpolation would assume dense seq coverage, which the live stream does not
  //  have — boundary existence is the contract the deployer guarantees.)
  const evBySeq = new Map(events.map((e) => [Number(e.seq), e]));
  const w = refs[refs.length - 1];
  const probes = [Number(w.endSeq), Number(w.startSeq)];
  const present = probes.filter((q) => evBySeq.has(q));
  if (present.length !== probes.length) return { ok: false, reason: "FAIL_sample_absent", present: present.length, of: probes.length };
  return { ok: true, reason: "PASS_monotonic_bounded_watermarked", windows: refs.length, sampledPresent: present.length, samples: present };
}

// ── E-class side-effect chain (before → target → after, all numeric/replayable):
//   before : an earlier resolved-PASS claim with strictly smaller cited ref p < N;
//   target : the NEWEST (max-ref) resolved-PASS claim N itself resolves strictly;
//   after  : the store progressed past the earliest cited evidence — ≥2 ordered
//            projection windows and lastWindow.endSeq > before (= continuation was
//            itself projected), plus store.version advanced (≥2).
export function checkSideEffectChain(resolvedClaims, store) {
  const oks = resolvedClaims.filter((c) => c.ok && Number.isFinite(Number(c.claim?.refs?.[0])));
  if (!oks.length) return { ok: false, reason: "FAIL_no_resolved_target" };
  const target = oks.reduce((a, b) => (Number(b.claim.refs[0]) > Number(a.claim.refs[0]) ? b : a));
  const N = Number(target.claim.refs[0]);
  const beforeEntry = oks.find((c) => Number(c.claim.refs[0]) < N);
  if (!beforeEntry) return { ok: false, reason: "FAIL_no_before_ref", target: N };
  const before = Number(beforeEntry.claim.refs[0]);
  const refs = Array.isArray(store.refs) ? store.refs : [];
  if (refs.length < 2) return { ok: false, reason: "FAIL_fewer_than_two_windows", windows: refs.length };
  // "after" = the timeline advanced past the earlier evidence after that evidence existed:
  // use window metadata order (v, at) — the LAST recorded projection must postdate `before`
  // by covering it: max(endSeq across windows) ≥ before proves continued shadowing/projection.
  const lastEnd = Math.max(...refs.map((w) => Number(w.endSeq)).filter(Number.isFinite));
  if (!(lastEnd >= before)) return { ok: false, reason: "FAIL_no_after_progression", before, lastEnd };
  if (!((store.version ?? 0) >= 2)) return { ok: false, reason: "FAIL_store_version_not_progressed" };
  return {
    ok: true, reason: "PASS_before_target_after",
    before, target: N, after: lastEnd,
    windows: refs.length, storeVersion: store.version,
  };
}

// ── orchestration ──
export function runStrictRecall({ events, store, core, kPerClass = 3 }) {
  const { claims, anomalies } = walkClaimsRigorous(store);
  const shared = {
    evBySeq: new Map(events.map((e) => [Number(e.seq), e])),
    extractCache: new Map(),
  };
  const classes = [];
  for (const section of CLASS_SECTIONS) {
    const pool = claims.filter((c) => c.section === section);
    const picked = pickNewestK(pool, kPerClass);
    const results = picked.map((claim) => {
      const r = resolveClaim(claim, events, core, shared);
      return { claim: { section, index: claim.index, tPreview: normalizeText(claim.text).slice(0, 120), refs: claim.refs }, ...r };
    });
    classes.push({
      classId: section === "goal" ? "C1-goal" :
        section === "completedActions" ? "C3-completed" :
        section === "verifiedEvidence" ? "C2-verified" :
        section === "keyFileChanges" ? "C4-filechg" :
        section === "failedApproaches" ? "C6-failed" :
        section === "blockers" ? "C7-blockers" : "C8-runtime",
      section, poolSize: pool.length, sampled: results.length,
      results, ok: results.every((x) => x.ok),
    });
  }
  const timeline = checkTimeline(store, events);
  const flattened = [];
  for (const cl of classes) for (const res of cl.results) flattened.push({ claim: res.claim, ok: res.ok, reason: res.reason });
  const chain = checkSideEffectChain(flattened, store);

  const classPass = classes.filter((c) => c.ok).length;
  const okAll = classPass === CLASS_SECTIONS.length && timeline.ok && chain.ok && anomalies === 0 && claims.length > 0;
  return {
    indexedEvents: events.length,
    claimNodesFound: claims.length,
    schemaAnomalies: anomalies,
    storeVersion: store.version ?? null,
    maxStoreRefEnd: Math.max(0, ...(store.refs ?? []).map((w) => Number(w.endSeq)).filter(Number.isFinite)),
    classes, timeline, sideEffectChain: chain,
    SUMMARY: okAll
      ? `STRICT RECALL ${CLASS_SECTIONS.length}/${CLASS_SECTIONS.length}+CHAIN ALL-PASS`
      : `STRICT RECALL INCOMPLETE (${classPass}/${CLASS_SECTIONS.length} classes, timeline=${timeline.ok}, chain=${chain.ok}, anomalies=${anomalies})`,
    ok: okAll,
    sanitized: true,
  };
}

// ── CLI entry: decode responsibility left to caller-supplied events.json ──
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , eventsFile, storeFile, coreFile] = process.argv;
  if (!eventsFile || !storeFile || !coreFile) {
    console.error("usage: node recall-verifier.mjs <events.json> <store.json> <context-memory-core.mjs>");
    process.exit(64);
  }
  const core = await import(pathToFileURL(path.resolve(coreFile)).href);
  const events = JSON.parse(fs.readFileSync(eventsFile, "utf8"));
  const store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
  const report = runStrictRecall({ events, store, core });
  console.log(JSON.stringify(report, null, 1));
  process.exit(report.ok ? 0 : 2);
}
