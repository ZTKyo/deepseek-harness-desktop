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
// R2 (2026-10-01) — EXTERNAL REVIEW FINDING A: PER-AC VERDICT PARITY
//   R1 shipped this gate validating the index's OWN per-AC verdicts (B1/B2) and the
//   authority document only as an AGGREGATE sentence (C5). Reproduced consequence: with
//   `acVerdicts.AC10 = FAIL` while the authority document still claims all-PASS, the gate
//   stayed GREEN (45 PASS / exit 0) — the index's per-AC verdicts were never tied to the
//   authority. That is the blocker this section closes.
//
//   The authority document ALREADY carries a per-AC verdict table (§「当前 AC 状态（唯一口径）」);
//   it is located through the index field `authorityRequirements.acVerdictTableHeading`
//   (a stable header-row anchor, not a line number). R2 makes the gate PARSE it:
//     B4 the table anchor exists in the authority document (fail-closed if absent),
//     B5 the table covers exactly AC1..AC10 (missing AC ⇒ RED, unknown AC ⇒ RED),
//     B6 every parsed verdict is a member of `acVerdictVocabulary` (malformed ⇒ RED),
//     B7 index.acVerdicts == authority per-AC verdicts  ← the Finding A fix,
//     B8 the declared all-PASS summary sentence agrees with the PARSED table,
//     B9 a VERIFIED status claim is impossible while any parsed AC verdict is not PASS.
//
//   NO CIRCULAR AUTHORITY: the authority table lives in a different file, is authored by
//   hand and is NEVER generated from the index, so the two sides are independent
//   assertions that must agree. Nothing here hard-codes "AC must always be PASS": only
//   the verdict tokens are compared, and B8/B9 are derived from the parsed table, so a
//   legitimate synchronised status change (index + authority updated together) still
//   passes — it is consistency that is enforced, not permanent greenness.
//
// Run: node tests/roadmap/validate-p4-status-consistency.mjs
// exit 0 = PASS, exit 1 = FAIL (fail-closed on every uncertain condition).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

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
for (const k of ['p4Status', 'canonicalSealHeading', 'remediationSectionMarker', 'overviewRowPrefix', 'acStatusSentence', 'authorityDoc', 'acVerdictTableHeading']) {
  check(`A3 authorityRequirements.${k} present`, typeof auth[k] === 'string' && auth[k].length > 0);
}
check('A4 stalenessMarkerToken present', typeof idx.stalenessMarkerToken === 'string' && idx.stalenessMarkerToken.length > 0);

// ── B. AC1..AC10: exactly one current status each ────────────────────────────
const acKeys = Object.keys(idx.acVerdicts || {}).sort();
const expectedAc = Array.from({ length: 10 }, (_, i) => `AC${i + 1}`).sort();
check('B1 acVerdicts covers exactly AC1..AC10',
  JSON.stringify(acKeys) === JSON.stringify(expectedAc),
  `got ${acKeys.join(',')}`);
// The verdict vocabulary is DECLARED in the index (not hard-coded here) and is applied to
// BOTH sides (index verdicts and the authority table), so the two can never be scored
// against different words. Missing vocabulary ⇒ fail-closed.
const AC_VOCAB = Array.isArray(idx.acVerdictVocabulary)
  ? idx.acVerdictVocabulary.filter((v) => typeof v === 'string' && v.trim().length > 0)
  : [];
check('B2a acVerdictVocabulary is declared and non-trivial (fail-closed)',
  AC_VOCAB.length >= 2, `vocabulary=${JSON.stringify(idx.acVerdictVocabulary)}`);
const badVerdicts = acKeys.filter((k) => !AC_VOCAB.includes(idx.acVerdicts[k]));
check(`B2 every AC verdict is one of ${AC_VOCAB.join('/')}`, badVerdicts.length === 0, badVerdicts.join(','));
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

// ── B4..B9. PER-AC authority parity (R2 — external review Finding A) ─────────
// Placed after section C so the authority text is read only once. Header comment above
// documents the authority model and why this is not a circular check.
function parseAuthorityPerAc(text, headerAnchor) {
  const ls = String(text).split(/\r?\n/);
  const hi = ls.findIndex((l) => l.trim() === String(headerAnchor).trim());
  if (hi < 0) return { headerFound: false, rows: [] };
  const rows = [];
  for (let i = hi + 1; i < ls.length; i++) {
    const line = ls[i].trim();
    if (!line.startsWith('|')) break;              // end of the table
    if (/^\|[\s:|-]+\|$/.test(line)) continue;     // separator row
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const ac = (cells[0] || '').replace(/[*_`]/g, '').trim();
    if (!/^AC\d{1,2}$/.test(ac)) continue;
    const rawCell = cells[2] || '';                // column 3 = 当前状态
    const verdict = (rawCell.replace(/[*_`]/g, '').match(/^[A-Z][A-Z_]*/) || [null])[0];
    rows.push({ ac, verdict, rawCell, line: i + 1 });
  }
  return { headerFound: true, rows };
}

const parsedAuth = authText === null
  ? { headerFound: false, rows: [] }
  : parseAuthorityPerAc(authText, auth.acVerdictTableHeading);
check('B4 authority document carries the per-AC verdict table (stable header anchor)',
  parsedAuth.headerFound === true, `anchor not found: ${auth.acVerdictTableHeading}`);
const authAcKeys = parsedAuth.rows.map((r) => r.ac).sort();
check('B5 authority per-AC table covers exactly AC1..AC10',
  JSON.stringify(authAcKeys) === JSON.stringify(expectedAc),
  `got ${authAcKeys.join(',') || '(none)'}`);
const badAuthVerdicts = parsedAuth.rows.filter((r) => !AC_VOCAB.includes(r.verdict));
check(`B6 every authority AC verdict is one of ${AC_VOCAB.join('/')}`,
  badAuthVerdicts.length === 0,
  badAuthVerdicts.map((r) => `${r.ac}=${JSON.stringify(r.rawCell)}`).join('；'));
const authVerdictOf = (ac) => (parsedAuth.rows.find((r) => r.ac === ac) || {}).verdict;
const perAcDiffs = expectedAc.filter((ac) => idx.acVerdicts && ac in idx.acVerdicts
  && authVerdictOf(ac) !== undefined && idx.acVerdicts[ac] !== authVerdictOf(ac));
check('B7 FINDING A — index acVerdicts equals the authority per-AC verdicts',
  perAcDiffs.length === 0,
  perAcDiffs.map((ac) => `${ac}: index=${idx.acVerdicts[ac]} authority=${authVerdictOf(ac)}`).join('；'));
const derivedAllPass = expectedAc.every((ac) => authVerdictOf(ac) === 'PASS');
const sentenceClaimsAllPass = /全部\s*PASS|全\s*PASS/.test(auth.acStatusSentence || '');
check('B8 declared AC summary sentence agrees with the parsed per-AC table',
  sentenceClaimsAllPass === derivedAllPass,
  `sentence claims all-pass=${sentenceClaimsAllPass} vs parsed table all-pass=${derivedAllPass}`);
const nonPassAc = expectedAc.filter((ac) => authVerdictOf(ac) !== undefined && authVerdictOf(ac) !== 'PASS');
check('B9 P4 status claim is coherent with the parsed per-AC verdicts',
  !(nonPassAc.length > 0 && /VERIFIED/.test(auth.p4Status || '')),
  `p4Status="${auth.p4Status}" while ${nonPassAc.join(',') || '(none)'} != PASS`);

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
// F4（2026-10-02 相位推进，用户明确授权启动 P4.5）：本条原断言 PHASE_04.5 未开始——那是 P4 收口时点的
// 相位不变量，已在其收口时验证；P4.5 正式启动后该断言必然失败，且失败原因与判定正确性无关。
// 改为**相位一致性**断言（收紧而非放宽）：索引自报 started 必须与 p4_5Readiness.started 一致、state 必须属于
// 合法相位集合、且 P5 必须继续锁死（F3 未动）。历史相位状态保留在 _p4_5ReadinessHistory。
const readiness = idx.p4_5Readiness || {};
check('F4 PHASE_04.5 phase-consistent (readiness self-report matches postP4State; P5 stays locked)',
  readiness.started === post.p4_5Started
    && (readiness.state === 'IN_PROGRESS' || readiness.state === 'READY_TO_START')
    && post.phase05Started === false,
  `readiness.started=${readiness.started} postP4State.p4_5Started=${post.p4_5Started} state=${readiness.state} phase05Started=${post.phase05Started}`);

// ── G. stable document anchors (D: hand-written line numbers drift, anchors do not) ─
// Finding D：文档里的手写行号指针会随改动整体偏移（实测 A10 更正表 +34）且无门可察。
// 修法不是"把行号改对一次"，而是**不许再手写行号**：定位改用锚点（标题/唯一文本/代码标识），
// 真实行号由 tools/check-doc-anchors.mjs 当场算出。本节断言锚点全部解析、禁令全部生效。
const anchorRegistry = Array.isArray(idx.docAnchors) ? idx.docAnchors : [];
const banRegistry = Array.isArray(idx.linePointerBans) ? idx.linePointerBans : [];
check('G1 registry declares document anchors', anchorRegistry.length >= 10, `anchors=${anchorRegistry.length}`);
check('G1 registry declares line-pointer bans', banRegistry.length >= 1, `bans=${banRegistry.length}`);
const anchorTool = path.join(ROOT, 'tools', 'check-doc-anchors.mjs');
const anchorRun = fs.existsSync(anchorTool)
  ? spawnSync(process.execPath, [anchorTool], { cwd: ROOT, encoding: 'utf8' })
  : null;
const anchorOut = anchorRun ? `${anchorRun.stdout || ''}${anchorRun.stderr || ''}` : '';
check('G2 anchor gate exits 0 (every anchor resolves; no hand-written line pointer)',
  anchorRun !== null && anchorRun.status === 0,
  anchorRun === null
    ? 'tool missing: tools/check-doc-anchors.mjs'
    : anchorOut.split('\n').filter((l) => l.includes('FAIL')).slice(0, 6).join(' | '));
const anchorCensus = anchorOut.match(/DOC ANCHORS:\s*(\d+)\s+RESOLVED:\s*(\d+)\s+BANS:\s*(\d+)\s+FAIL:\s*(\d+)/);
check('G3 anchor gate reports a parseable census', anchorCensus !== null, 'no summary line');
if (anchorCensus) {
  check('G4 every registered anchor resolved (no anchor silently disappeared)',
    Number(anchorCensus[2]) === anchorRegistry.length && Number(anchorCensus[4]) === 0,
    `RESOLVED=${anchorCensus[2]}/${anchorRegistry.length} FAIL=${anchorCensus[4]}`);
  check('G5 every registered line-pointer ban was actually checked',
    Number(anchorCensus[3]) === banRegistry.length,
    `BANS=${anchorCensus[3]}/${banRegistry.length}`);
} else {
  check('G4 every registered anchor resolved (no anchor silently disappeared)', false, 'no census');
  check('G5 every registered line-pointer ban was actually checked', false, 'no census');
}
for (const a of anchorRegistry) {
  check(`G6[${a.id || 'missing-id'}] anchor declares a resolvable kind`,
    ['heading', 'line', 'code'].includes(a.kind), `kind=${a.kind}`);
}

// G7：**负控**——"这道门能不能真的变红"必须可复现。门如果永远 PASS，就等于装饰品。
// 负控用临时目录 fixture + 临时注册表（绝不触碰仓库任何真实文档）跑三条用例：
//   ① 裸行号指针必须红 ② 同一行带锚点必须绿 ③ 被禁区块之外不误杀。
const negTool = path.join(ROOT, 'tests', 'roadmap', 'test-anchor-gate-negative-control.mjs');
const negRun = fs.existsSync(negTool)
  ? spawnSync(process.execPath, [negTool], { cwd: ROOT, encoding: 'utf8' })
  : null;
const negOut = negRun ? `${negRun.stdout || ''}${negRun.stderr || ''}` : '';
check('G7 anchor-gate negative control passes (the ban is falsifiable, not decorative)',
  negRun !== null && negRun.status === 0,
  negRun === null
    ? 'test missing: tests/roadmap/test-anchor-gate-negative-control.mjs'
    : negOut.split('\n').filter((l) => l.includes('FAIL')).slice(0, 4).join(' | '));

// ── H：Finding E（D12 自愈作用域口径）——点值必须可复算，限定必须写在纸上 ──────────────
// E 的缺陷不是"数字算错"，而是**数字没有限定**：没有类别定义（「3 个旧库」对 4 个
// `schemaVersion=1` 文件）、没有测量时点（目录随会话增长）、没有时区（本地 +08:00 与 UTC 差 8 小时）。
// 修法两件：①口径写进权威文档；②点值由**只读**工具当场复算。
// 本节断言工具存在、工具自身**可证伪**（离线自检，不读生产、不联网）、
// 以及"读不到"绝不渲染成 0（fail-closed），最后断言更正文字里的三点限定确实在文件里。
const censusTool = path.join(ROOT, 'tools', 'learn-store-census.mjs');
check('H1 read-only learn-store census tool exists (Finding E: the numbers must be re-derivable)',
  fs.existsSync(censusTool), 'tool missing: tools/learn-store-census.mjs');
const censusSelf = fs.existsSync(censusTool)
  ? spawnSync(process.execPath, [censusTool, '--self-test'], { cwd: ROOT, encoding: 'utf8' })
  : null;
const censusSelfOut = censusSelf ? `${censusSelf.stdout || ''}${censusSelf.stderr || ''}` : '';
const censusSummary = censusSelfOut.match(/SELF-TEST:\s*(\d+)\s+assertions\s+PASS:\s*(\d+)\s+FAIL:\s*(\d+)/);
check('H2 census self-test PASSES offline (bucket logic + timezone labels are falsifiable)',
  censusSelf !== null && censusSelf.status === 0 && censusSummary !== null
    && Number(censusSummary[3]) === 0 && Number(censusSummary[1]) >= 14,
  censusSelf === null
    ? 'self-test did not run'
    : (censusSummary ? `assertions=${censusSummary[1]} FAIL=${censusSummary[3]}` : 'no SELF-TEST summary line'));
const censusMissing = fs.existsSync(censusTool)
  ? spawnSync(process.execPath, [censusTool, '--dir', path.join(ROOT, 'no-such-store-dir-E')], { cwd: ROOT, encoding: 'utf8' })
  : null;
const censusMissingOut = censusMissing ? `${censusMissing.stdout || ''}${censusMissing.stderr || ''}` : '';
check('H3 unreadable store fails closed (exit 2 + TARGET UNAVAILABLE; "cannot read" is never rendered as 0)',
  censusMissing !== null && censusMissing.status === 2 && /TARGET UNAVAILABLE/.test(censusMissingOut),
  censusMissing === null
    ? 'not run'
    : `status=${censusMissing.status} announced=${/TARGET UNAVAILABLE/.test(censusMissingOut)}`);
// 口径必须写在纸上：更正段要同时给出 类别（4 = 3 + 1 索引）、测量时点（**带时区**）、
// 以及「点值非常量」这一条，三者缺一即 RED —— 少了任何一条，就退回 E 被发现时的状态。
const statusDocPath = path.join(ROOT, 'docs', 'roadmap', 'CURRENT_STATUS.md');
const statusDoc = fs.existsSync(statusDocPath) ? fs.readFileSync(statusDocPath, 'utf8') : '';
const a10Path = path.join(ROOT, 'docs', 'roadmap', 'reports', 'PHASE_04_LEARNING', 'R3_FINAL_CLOSURE', 'A10_CONTRACT_MATRIX.md');
const a10Doc = fs.existsSync(a10Path) ? fs.readFileSync(a10Path, 'utf8') : '';
const eEvidencePath = path.join(ROOT, 'docs', 'roadmap', 'reports', 'PHASE_04_LEARNING', 'R3_FINAL_CLOSURE', 'evidence', 'E_D12_STORE_CENSUS_20261001.md');
const eQual = {
  'category (4 = 3 old libs + 1 index)': /共 4 个/.test(statusDoc),
  'measurement instant WITH timezone': /2026-10-01 \d{2}:\d{2}:\d{2}\+08:00/.test(statusDoc),
  'point-in-time wording': /点值/.test(statusDoc),
  'explicitly not a constant': /非常量/.test(statusDoc),
};
check('H4 authority document carries the dated E correction',
  /E 更正（External Review Finding E/.test(statusDoc), 'CURRENT_STATUS.md missing the E correction block');
check('H5 the E correction states category + timestamped-and-timezoned instant + "point-in-time, not a constant"',
  Object.values(eQual).every(Boolean),
  Object.entries(eQual).filter(([, ok]) => !ok).map(([k]) => k).join(' | ') || 'all present');
check('H6 A10 carries the same E correction, and the evidence artifact exists on disk',
  /E 更正（2026-10-01/.test(a10Doc) && fs.existsSync(eEvidencePath),
  `a10=${/E 更正（2026-10-01/.test(a10Doc)} evidence=${fs.existsSync(eEvidencePath)}`);
// H7：**控制套件必须"有归宿"**。五个 R2 控制（Finding A 的逐 AC 一致性、Finding B 的发布件
// 判定、E 的点值口径、C 的数字钉住、D 的行号禁令）若只躺在 tests/roadmap/ 而没有任何 CI 航道
// 调用，就是"写了一堆不会跑的门"——
// 上一轮实测确实如此：A/B 两个控制当时**未被任何 workflow 引用**（本文档所在地 tests/roadmap
// 也不在 ci-level3 的 paths 过滤内，见 D4），评审无法从 CI 侧看到它们存在。故此处断言：
// 这五个控制文件**存在**，且**至少被某个 workflow 真实调用**（扫全部 .github/workflows/*.yml，
// 不绑定具体航道，允许后续迁移）。注意**不**在这里 spawn 它们——E 控制会跑本校验器（在临时副本里），
// 若本校验器再 spawn 控制就形成递归；实际执行由 ci-level1.yml 的独立步骤负责。
const controlSuites = [
  ['test-anchor-gate-negative-control.mjs', 'D 的行号禁令负控'],
  ['test-p4-status-per-ac-consistency.mjs', 'Finding A 的逐 AC 一致性负控'],
  ['test-release-artifact-verifier.mjs', 'Finding B 的发布件判定负控'],
  ['test-finding-e-negative-control.mjs', 'E 的点值口径负控'],
  ['test-finding-c-number-pinning.mjs', 'Finding C 的数字钉住负控'],
];
const wfDir = path.join(ROOT, '.github', 'workflows');
const wfText = fs.existsSync(wfDir)
  ? fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => fs.readFileSync(path.join(wfDir, f), 'utf8')).join('\n')
  : '';
const missingControl = controlSuites.filter(([f]) => !fs.existsSync(path.join(ROOT, 'tests', 'roadmap', f)));
const unownedControl = controlSuites.filter(([f]) => !wfText.includes(f));
check('H7 every roadmap control suite exists AND is invoked by some CI workflow (no unowned control)',
  missingControl.length === 0 && unownedControl.length === 0,
  `missing=[${missingControl.map(([f]) => f).join(',')}] unowned=[${unownedControl.map(([f]) => f).join(',')}]`);

// ── I：Finding C（权威文档的"自述数字"必须被门钉住，而不是靠人记得同步）────────────────
// R1 外部评审 Finding C 原文：权威文档自述「43 断言 / 1420 行 / 55 豁免」与门**实测**
// 「45 / 1934 / 59」不符，**且没有任何门钉住这些数字**。把 43 改成 86 并不解决它——那仍然是
// 人工维护，下一次有人再加一条断言，数字又会过期。故这里把数字变成**门当场重算**的对象：
//   I1 权威文档必须存在**恰好一行**机器可核的数字口径行（形状缺失或重复 ⇒ RED，不猜）
//   I2 该行声明的**断言数** = 本门运行时的断言总数（本组自身恰好贡献 ASSERTION_GROUP_SIZE 条）
//   I3 该行声明的**历史文档数 / HEAD 行数 / 表格分隔行豁免数** = `verify-history-preserved.mjs`
//      **当场跑出来**的三个数（不读缓存、不读历史报告、不读人写的第二份数字）
// 任何一侧单独改动而另一侧未改 ⇒ RED。历史值（43 / 1420 / 55）作为"曾如此自述"的记录保留在
// 文档中，但**不参与比对**——否则人一改历史记录就红，等于逼人删历史（违反 D1「只标注不改写」）。
const assertionsBeforeI = pass + fail;   // 必须在 I 组之前读取（本组自己也会 +N）
const ASSERTION_GROUP_SIZE = 3;
const NUMERIC_MARKER = '【数字口径·机器可核】';
const markerHits = statusDoc.split(NUMERIC_MARKER).length - 1;
const numericDecl = statusDoc.match(
  /【数字口径·机器可核】断言数 (\d+) \/ 历史文档 (\d+)\/(\d+) \/ HEAD 行 (\d+) \/ 表格分隔行豁免 (\d+)/);
check('I1 authority document carries exactly one machine-checkable numeric declaration line (fail-closed shape)',
  markerHits === 1 && numericDecl !== null,
  `markerCount=${markerHits} parsed=${numericDecl !== null}`);
check('I2 the declared assertion count equals THIS gate\'s runtime assertion total (Finding C: pinned, not hand-maintained)',
  numericDecl !== null && Number(numericDecl[1]) === assertionsBeforeI + ASSERTION_GROUP_SIZE,
  numericDecl === null
    ? 'declaration line missing'
    : `declared=${numericDecl[1]} runtime=${assertionsBeforeI + ASSERTION_GROUP_SIZE}`);

const histGate = path.join(ROOT, 'tests', 'roadmap', 'verify-history-preserved.mjs');
const histRun = fs.existsSync(histGate)
  ? spawnSync(process.execPath, [histGate], { cwd: ROOT, encoding: 'utf8' })
  : null;
const histOut = histRun ? `${histRun.stdout || ''}${histRun.stderr || ''}` : '';
const histDocs = histOut.match(/DOCUMENTS:\s*(\d+)\s+PASS:\s*(\d+)\s+FAIL:\s*(\d+)\s+HEAD LINES CHECKED:\s*(\d+)/);
// 该 NOTES 行只在豁免数 > 0 时打印 ⇒ 缺失按 0 处理（在 detail 里显式给出，不静默）。
const histExemptMatch = histOut.match(/NOTES:\s*(\d+)\s+table-separator row\(s\) exempted/);
const histExempt = histExemptMatch ? Number(histExemptMatch[1]) : 0;
const histShapeOk = histRun !== null && histRun.status === 0 && histDocs !== null;
check('I3 the declared history-preservation numbers equal a freshly re-run history gate (documents / HEAD lines / exemptions)',
  histShapeOk && numericDecl !== null
    && Number(numericDecl[2]) === Number(histDocs[2])    // PASS documents
    && Number(numericDecl[3]) === Number(histDocs[1])    // total documents
    && Number(numericDecl[4]) === Number(histDocs[4])    // HEAD lines checked
    && Number(numericDecl[5]) === histExempt,
  histShapeOk
    ? `declared=${numericDecl ? `${numericDecl[2]}/${numericDecl[3]} lines=${numericDecl[4]} exempt=${numericDecl[5]}` : 'n/a'} `
      + `measured=${histDocs[2]}/${histDocs[1]} lines=${histDocs[4]} exempt=${histExempt}`
    : `history gate did not report (exit=${histRun ? histRun.status : 'not-run'})`);

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\nASSERTIONS: ${pass + fail}  PASS: ${pass}  FAIL: ${fail}`);
if (fail > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  console.log('P4 STATUS CONSISTENCY: FAILED');
  process.exit(1);
}
console.log('P4 STATUS CONSISTENCY: PASSED');
