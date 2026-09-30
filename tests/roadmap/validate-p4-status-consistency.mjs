// validate-p4-status-consistency.mjs — P4 External Review remediation, D1 (2026-10-01)
//
// WHY THIS EXISTS
//   The audited defect was not a missing status: it was that the SAME fact (P4
//   verdict / per-AC status) was asserted with different values in different
//   documents of the same commit tree, and nothing could catch the drift. A
//   prose-only fix ("we annotated the files once") decays at the next edit.
//   This gate converts the contradiction class from "someone must notice" into
//   "CI fails", reusing the project's existing fail-closed idiom
//   (tests/learn/gate-registry.json + validate-gate-registry.mjs).
//
// NOT A SECOND STATUS SYSTEM
//   `docs/roadmap/P4_STATUS.json` is explicitly a PARITY INDEX, not an authority.
//   The authority remains `docs/roadmap/CURRENT_STATUS.md`. This validator
//   enforces parity in BOTH directions:
//     - the authority document must literally contain the index's canonical
//       strings (so the index cannot drift away from the authority), and
//     - every superseded document must carry the dated staleness marker on any
//       line that still repeats a superseded claim (so a historical claim can
//       never sit in the tree unmarked).
//
// Run: node tests/roadmap/validate-p4-status-consistency.mjs
// exit 0 = PASS, exit 1 = FAIL (fail-closed on every uncertain condition).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const INDEX_PATH = path.join(ROOT, 'docs', 'roadmap', 'P4_STATUS.json');

// A banner is recognised as covering the whole file when the marker token occurs
// within this many lines of the top (banner placement). Otherwise the marker must
// sit on the SAME line as the superseded claim (inline annotation).
const BANNER_WINDOW_LINES = 40;

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function readText(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
}
function lines(rel) {
  const t = readText(rel);
  return t === null ? null : t.split(/\r?\n/);
}

console.log('=== P4 status consistency (D1 parity lock) ===');

// ── A. index integrity ───────────────────────────────────────────────────────
if (!fs.existsSync(INDEX_PATH)) {
  console.log(`FAIL  A1 parity index missing at ${INDEX_PATH}`);
  process.exit(1);
}
let idx;
try {
  idx = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
} catch (e) {
  console.log(`FAIL  A1 parity index is not valid JSON — ${e.message}`);
  process.exit(1);
}
check('A1 parity index parses', true);
check('A2 index declares version 1', idx.version === 1, `version=${idx.version}`);

const auth = idx.authorityRequirements || {};
for (const k of ['p4Status', 'canonicalSealHeading', 'remediationSectionMarker', 'overviewRowPrefix', 'acStatusSentence', 'authorityDoc']) {
  check(`A3 authorityRequirements.${k} present`, typeof auth[k] === 'string' && auth[k].length > 0);
}
check('A4 stalenessMarkerToken present', typeof idx.stalenessMarkerToken === 'string' && idx.stalenessMarkerToken.length > 0);

// ── B. AC1..AC10: exactly one current status each ────────────────────────────
const acKeys = Object.keys(idx.acVerdicts || {}).sort();
const expectedAc = Array.from({ length: 10 }, (_, i) => `AC${i + 1}`).sort();
check('B1 acVerdicts covers exactly AC1..AC10',
  JSON.stringify(acKeys) === JSON.stringify(expectedAc),
  `got ${acKeys.join(',')}`);
const badVerdicts = acKeys.filter((k) => !['PASS', 'PARTIAL', 'FAIL'].includes(idx.acVerdicts[k]));
check('B2 every AC verdict is one of PASS/PARTIAL/FAIL', badVerdicts.length === 0, badVerdicts.join(','));
check('B3 AC verdicts are declared for one audited baseline',
  typeof idx.auditedBaseline === 'string' && /^[0-9a-f]{40}$/.test(idx.auditedBaseline),
  `auditedBaseline=${idx.auditedBaseline}`);

// ── C. authority parity (both directions) ────────────────────────────────────
const authText = readText(auth.authorityDoc);
check('C1 authority document exists', authText !== null, auth.authorityDoc);
if (authText !== null) {
  check('C2 authority document contains the canonical P4 status string',
    authText.includes(auth.p4Status), `missing: ${auth.p4Status}`);
  check('C3 authority document contains the canonical seal heading',
    authText.includes(auth.canonicalSealHeading), `missing: ${auth.canonicalSealHeading}`);
  const remed = authText.indexOf(auth.remediationSectionMarker);
  check('C4 authority document contains the remediation section marker',
    remed >= 0, `missing: ${auth.remediationSectionMarker}`);
  check('C5 remediation section declares the single AC status sentence',
    remed >= 0 && authText.slice(remed).includes(auth.acStatusSentence),
    `missing after marker: ${auth.acStatusSentence}`);
  const overview = (authText.split(/\r?\n/) || []).filter((l) => l.startsWith(auth.overviewRowPrefix));
  check('C6 exactly one phase-04 overview row exists', overview.length === 1, `rows=${overview.length}`);
  check('C7 the phase-04 overview row carries the canonical P4 status string',
    overview.length === 1 && overview[0].includes(auth.p4Status),
    'row does not contain the canonical string');
  // The 2026-09-23 rollback record must survive remediation untouched.
  check('C8 historical 2026-09-23 rollback record still present (history not deleted)',
    authText.includes('2026-09-23') && /NOT VERIFIED \/ ROLLED BACK \/ AWAITING REDESIGN/.test(authText),
    'rollback record missing from the authority document');
}

// ── D. superseded documents must carry the staleness marker ─────────────────
const superseded = Array.isArray(idx.supersededDocs) ? idx.supersededDocs : [];
check('D1 supersededDocs list is non-empty', superseded.length > 0, `n=${superseded.length}`);
let unmarkedLines = [];
for (const entry of superseded) {
  const ls = lines(entry.path);
  if (ls === null) {
    check(`D2 exists [${entry.path}]`, false, 'registered file missing from the tree (fail-closed)');
    continue;
  }
  const hasBanner = ls.slice(0, BANNER_WINDOW_LINES).some((l) => l.includes(idx.stalenessMarkerToken));
  check(`D2 carries staleness marker [${path.basename(entry.path)}]`, hasBanner,
    'no ' + idx.stalenessMarkerToken + ' within the first ' + BANNER_WINDOW_LINES + ' lines');
  for (const stale of entry.staleStrings || []) {
    for (let i = 0; i < ls.length; i++) {
      if (!ls[i].includes(stale)) continue;
      if (ls[i].includes(idx.stalenessMarkerToken)) continue;
      if (hasBanner) continue;
      unmarkedLines.push(`${entry.path}:${i + 1} :: ${stale}`);
    }
  }
}
check('D3 every superseded-claim line is marked or covered by a banner',
  unmarkedLines.length === 0, unmarkedLines.slice(0, 10).join(' | '));

// ── D-sweep. repo-wide census: no UNMARKED superseded claim anywhere ────────
// D2/D3 only police the registered list, so a NEW (or simply forgotten)
// document repeating a superseded headline would slip through. The sweep closes
// that hole: any .md under docs/roadmap carrying a superseded headline must be
// either registered above (hence marker-bearing) or explicitly exempted with a
// reason in sweepExemptDocs — otherwise this gate fails.
const SWEEP_ROOT = path.join(ROOT, 'docs', 'roadmap');
const SWEEP_TOKENS = [
  'P4 ≠ VERIFIED',
  'AC6 / AC10 = PARTIAL',
  'NOT VERIFIED / ROLLED BACK / AWAITING REDESIGN',
  'P4 = NOT VERIFIED',
];
const registered = new Set(superseded.map((e) => e.path.replace(/\\/g, '/')));
const exempt = new Map((idx.sweepExemptDocs || []).map((e) => [e.path.replace(/\\/g, '/'), e.reason]));

function walkMd(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walkMd(abs, out);
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) out.push(abs);
  }
  return out;
}

const sweepOffenders = [];
let sweptFiles = 0;
for (const abs of walkMd(SWEEP_ROOT)) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  const text = fs.readFileSync(abs, 'utf8');
  const hit = SWEEP_TOKENS.find((t) => text.includes(t));
  if (!hit) continue;
  sweptFiles++;
  if (registered.has(rel)) continue;
  if (exempt.has(rel)) continue;
  sweepOffenders.push(`${rel} :: "${hit}"`);
}
check('D4 sweep found the known superseded-claim census', sweptFiles >= 4, `files=${sweptFiles}`);
check('D5 no unregistered document repeats a superseded headline',
  sweepOffenders.length === 0,
  sweepOffenders.slice(0, 12).join(' | '));
for (const [p, reason] of exempt) {
  check(`D6 sweep exemption is justified [${path.basename(p)}]`,
    typeof reason === 'string' && reason.length >= 20, 'reason too short / missing');
}


// ── E. numbering disambiguation declarations ────────────────────────────────
for (const entry of idx.numberingDisambiguated || []) {
  const t = readText(entry.path);
  if (t === null) {
    check(`E1 exists [${entry.path}]`, false, 'registered file missing');
    continue;
  }
  check(`E1 declares its AC numbering system [${path.basename(entry.path)}]`,
    t.includes(entry.requiredToken), `missing token: ${entry.requiredToken}`);
}

// ── F. post-P4 locks (nothing may silently claim progress) ──────────────────
const post = idx.postP4State || {};
check('F1 POST_P4_VERIFIED_GOLDEN not frozen', post.postP4VerifiedGoldenFrozen === false, String(post.postP4VerifiedGoldenFrozen));
check('F2 P4 production not activated', post.p4ProductionActivated === false, String(post.p4ProductionActivated));
check('F3 PHASE_05 not started', post.phase05Started === false, String(post.phase05Started));
check('F4 PHASE_04.5 not started', post.p4_5Started === false, String(post.p4_5Started));

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\nASSERTIONS: ${pass + fail}  PASS: ${pass}  FAIL: ${fail}`);
if (fail > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  console.log('P4 STATUS CONSISTENCY: FAILED');
  process.exit(1);
}
console.log('P4 STATUS CONSISTENCY: PASSED');
