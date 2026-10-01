// learn-store-census.mjs — READ-ONLY, point-in-time census of the production learn store.
//
// WHY THIS EXISTS (P4 R2 / external review Finding E, 2026-10-01):
//   The D12 correction claimed, as a seal-time fact, "3 个 `schemaVersion=1` 旧库与含 `[REDACTED:`
//   标记的历史库 mtime 未变 / 全部早于重启". The external reviewer could not reconcile those
//   numbers with the seal-time state ("描述过宽 / 数字对不上"). Root cause (measured, not guessed):
//   the numbers were quoted WITHOUT (a) a measurement timestamp, (b) a category definition and
//   (c) a timezone convention — while the directory itself GROWS (every session adds a store file)
//   and contains BOTH session libraries and index files. Two honest censuses of the same directory
//   can therefore disagree (4 vs 3 `schemaVersion=1` files) purely because one counted index files
//   and the other did not; two archived lists of it can also disagree by 8 hours purely because one
//   printed UTC and the other local time. A number that is quoted without its category, its
//   timestamp and its timezone is not evidence — it is a rumour with digits.
//
// WHAT IT DOES: prints every count with its category definition, the measurement instant in BOTH
//   UTC and local time, and the per-file mtime of the `schemaVersion=1` bucket and of every file
//   carrying a `[REDACTED:*]` marker — so any claim written into the roadmap documents can be
//   re-derived or falsified later by anyone, on any date.
//
// SAFETY / BOUNDARIES:
//   * READ-ONLY: opens store files for reading only, never writes, never mutates, never touches
//     the learning plugins or the running service.
//   * It prints counts, schemaVersion values and mtimes — never file content (the store can hold
//     redacted-but-sensitive text).
//   * The census is a POINT-IN-TIME observation, never a constant. A missing/unreadable store
//     fails closed (`exit 2`, `TARGET UNAVAILABLE`) — "could not read" is never rendered as zero.
//
// USAGE:
//   node tools/learn-store-census.mjs                  # human-readable census of the live store
//   node tools/learn-store-census.mjs --json           # machine-readable, same data
//   node tools/learn-store-census.mjs --dir <path>     # census an explicit directory
//   node tools/learn-store-census.mjs --self-test      # OFFLINE fixture check (no store, no network)
//
// EXIT: 0 = census produced (or self-test all-PASS) | 1 = self-test FAIL | 2 = target unavailable.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const AS_JSON = has('--json');
const SELF_TEST = has('--self-test');

const DEFAULT_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'DSHHarness', 'state', 'learn');
const DIR = valOf('--dir', DEFAULT_DIR);

// Restart boundary used by the D12 narrative (2026-09-28). Kept as a named constant so the
// "before/after the restart" split is explicit and reviewable instead of implicit.
const RESTART_BOUNDARY_UTC = '2026-09-28T00:00:00Z';
const MARKER_RE = /\[REDACTED:[a-z0-9-]+\]/i;

// ── timezone discipline ──────────────────────────────────────────────────────────────────────
// Every instant is printed twice, explicitly labelled: an 8-hour "mismatch" between two archived
// listings of this directory was purely a UTC-vs-local convention difference, not drift.
const LOCAL_OFFSET_MIN = -new Date().getTimezoneOffset();
const pad = (n, w = 2) => String(n).padStart(w, '0');
export const isoUtc = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
export const isoLocal = (ms) => {
  const sign = LOCAL_OFFSET_MIN >= 0 ? '+' : '-';
  const abs = Math.abs(LOCAL_OFFSET_MIN);
  return new Date(ms + LOCAL_OFFSET_MIN * 60000).toISOString().replace('T', ' ').slice(0, 19)
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};

export function census(dir, nowMs = Date.now()) {
  if (!fs.existsSync(dir)) return { ok: false, reason: 'dir_missing', dir };
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return { ok: false, reason: `unreadable: ${e && e.code ? e.code : 'unknown'}`, dir };
  }
  const rows = [];
  for (const name of names) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    let raw = '';
    try { raw = fs.readFileSync(p, 'utf8'); } catch { raw = ''; }
    let schemaVersion;
    try { schemaVersion = JSON.parse(raw).schemaVersion ?? null; } catch { schemaVersion = 'unparsable'; }
    rows.push({
      file: name,
      isSessionLib: /^session-/.test(name),
      bytes: st.size,
      mtimeUtc: isoUtc(st.mtimeMs),
      mtimeLocal: isoLocal(st.mtimeMs),
      mtimeMs: st.mtimeMs,
      schemaVersion,
      hasMarker: MARKER_RE.test(raw),
    });
  }
  rows.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const oldLibs = rows.filter((r) => r.schemaVersion === 1);
  const oldSessionLibs = oldLibs.filter((r) => r.isSessionLib);
  const marked = rows.filter((r) => r.hasMarker);
  const sessionLibs = rows.filter((r) => r.isSessionLib);
  const numeric = (r, op) => typeof r.schemaVersion === 'number' && op(r.schemaVersion);

  return {
    ok: true,
    dir,
    measuredAtUtc: isoUtc(nowMs),
    measuredAtLocal: isoLocal(nowMs),
    note: 'POINT-IN-TIME observation of a directory that grows: these counts are not constants, and '
      + 'they are only meaningful together with the category definition and timestamp printed here.',
    categoryDefinitions: {
      'all .json files in the store': 'every *.json in the store directory',
      'session libraries (name starts with session-)': 'files named session-*.json',
      'index / non-session files': '*.json whose name does not start with session- (e.g. _global-verified.json)',
      'schemaVersion=1 (ALL files)': 'JSON parses AND schemaVersion === 1, session lib or index alike (THIS is the bucket that the "3 个旧库" sentence depended on)',
      'schemaVersion=1 AND a session library': 'subset: old-schema files that are session libraries',
      'schemaVersion=1 AND an index file': 'subset: old-schema files that are index/non-session files',
      'schemaVersion=2+': 'JSON parses AND schemaVersion >= 2',
      'unparsable schemaVersion': 'JSON did not parse (counted, never silently dropped)',
      'containing a [REDACTED:*] marker': 'file text matches /\\[REDACTED:[a-z0-9-]+\\]/i (marker may be a healed value)',
      'marked AND a session library': 'subset: marker present AND name starts with session-',
      [`mtime >= ${RESTART_BOUNDARY_UTC} boundary`]: 'written at or after the 2026-09-28 restart boundary (UTC)',
    },
    categories: {
      'all .json files in the store': rows.length,
      'session libraries (name starts with session-)': sessionLibs.length,
      'index / non-session files': rows.length - sessionLibs.length,
      'schemaVersion=1 (ALL files)': oldLibs.length,
      'schemaVersion=1 AND a session library': oldSessionLibs.length,
      'schemaVersion=1 AND an index file': oldLibs.length - oldSessionLibs.length,
      'schemaVersion=2+': rows.filter((r) => numeric(r, (v) => v >= 2)).length,
      'unparsable schemaVersion': rows.filter((r) => r.schemaVersion === 'unparsable').length,
      'containing a [REDACTED:*] marker': marked.length,
      'marked AND a session library': marked.filter((r) => r.isSessionLib).length,
      [`mtime >= ${RESTART_BOUNDARY_UTC} boundary`]: rows.filter((r) => r.mtimeUtc >= RESTART_BOUNDARY_UTC.replace('Z', 'Z')).length,
    },
    schemaVersionHistogram: rows.reduce((acc, r) => { const k = String(r.schemaVersion); acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
    oldLibs: oldLibs.map((r) => ({ file: r.file, isSessionLib: r.isSessionLib, mtimeLocal: r.mtimeLocal, mtimeUtc: r.mtimeUtc, bytes: r.bytes, hasMarker: r.hasMarker })),
    markedFiles: marked.map((r) => ({ file: r.file, isSessionLib: r.isSessionLib, mtimeLocal: r.mtimeLocal, schemaVersion: r.schemaVersion })),
    oldest: rows.length ? { file: rows[0].file, mtimeLocal: rows[0].mtimeLocal, mtimeUtc: rows[0].mtimeUtc } : null,
    newest: rows.length ? { file: rows[rows.length - 1].file, mtimeLocal: rows[rows.length - 1].mtimeLocal, mtimeUtc: rows[rows.length - 1].mtimeUtc } : null,
  };
}

export function render(out) {
  const lines = [];
  if (!out.ok) { lines.push(`TARGET UNAVAILABLE (${out.reason}): ${out.dir}`); return lines; }
  lines.push(`DIR            : ${out.dir}`);
  lines.push(`MEASURED AT    : ${out.measuredAtUtc} (UTC)  =  ${out.measuredAtLocal} (local)`);
  lines.push('CATEGORIES     :');
  for (const [k, v] of Object.entries(out.categories)) lines.push(`  ${String(v).padStart(4)}  ${k}`);
  lines.push(`SCHEMA VERSION : ${JSON.stringify(out.schemaVersionHistogram)}`);
  lines.push(`OLDEST FILE    : ${out.oldest ? out.oldest.mtimeLocal + '  ' + out.oldest.file : '(none)'}`);
  lines.push(`NEWEST FILE    : ${out.newest ? out.newest.mtimeLocal + '  ' + out.newest.file : '(none)'}`);
  lines.push('schemaVersion=1 bucket (file / mtimeLocal / bytes / sessionLib / hasMarker):');
  if (!out.oldLibs.length) lines.push('  (empty)');
  for (const r of out.oldLibs) lines.push(`  ${r.file}  ${r.mtimeLocal}  ${r.bytes}  sessionLib=${r.isSessionLib}  marker=${r.hasMarker}`);
  lines.push(`files carrying a [REDACTED:*] marker: ${out.markedFiles.length}`);
  for (const r of out.markedFiles) lines.push(`  ${r.file}  ${r.mtimeLocal}  sessionLib=${r.isSessionLib}  schemaVersion=${r.schemaVersion}`);
  lines.push('');
  lines.push('BOUNDARY       : point-in-time; the store grows, so re-run to re-derive. Counts are signed by');
  lines.push('                 the category definition above, never quoted bare.');
  return lines;
}

// ── offline self-test (no store, no network, deterministic) ──────────────────────────────────
// Proves the bucket logic and the timezone labelling are FALSIFIABLE: a synthetic fixture is
// built, the census is run against it, and every count is asserted. Without this, the census
// would be an unfalsifiable printout — the same class of defect as the sentence it replaced.
function selfTest() {
  const results = [];
  const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-store-census-'));
  try {
    const w = (name, obj) => fs.writeFileSync(path.join(tmp, name), typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
    w('aaa-v1.json', { schemaVersion: 1, entries: [] });
    w('bbb-v1.json', { schemaVersion: 1, entries: [] });
    w('ccc-v1.json', { schemaVersion: 1, entries: [] });
    w('_global-verified.json', { schemaVersion: 1, verified: [] });
    w('session-x.json', { schemaVersion: 2, note: 'postgres://[REDACTED:uri-credential]@db/x' });
    w('session-y.json', { schemaVersion: 2 });
    w('broken.json', '{not json');

    const out = census(tmp, Date.UTC(2026, 9, 1, 4, 21, 50));
    check('self-test: census succeeds on the fixture', out.ok === true, JSON.stringify(out.reason || ''));
    check('self-test: schemaVersion=1 bucket = 4 (3 libs + 1 index)', out.categories['schemaVersion=1 (ALL files)'] === 4, String(out.categories['schemaVersion=1 (ALL files)']));
    check('self-test: old-schema SESSION libs = 0 (none starts with session-)', out.categories['schemaVersion=1 AND a session library'] === 0, String(out.categories['schemaVersion=1 AND a session library']));
    check('self-test: old-schema INDEX files = 4', out.categories['schemaVersion=1 AND an index file'] === 4, String(out.categories['schemaVersion=1 AND an index file']));
    check('self-test: schemaVersion=2+ = 2', out.categories['schemaVersion=2+'] === 2, String(out.categories['schemaVersion=2+']));
    check('self-test: unparsable = 1 (counted, not dropped)', out.categories['unparsable schemaVersion'] === 1, String(out.categories['unparsable schemaVersion']));
    check('self-test: total = 7 (nothing silently skipped)', out.categories['all .json files in the store'] === 7, String(out.categories['all .json files in the store']));
    check('self-test: marker bucket = 1', out.categories['containing a [REDACTED:*] marker'] === 1, String(out.categories['containing a [REDACTED:*] marker']));
    check('self-test: session libs = 2', out.categories['session libraries (name starts with session-)'] === 2, String(out.categories['session libraries (name starts with session-)']));
    check('self-test: UTC label carries Z', /Z$/.test(out.measuredAtUtc), out.measuredAtUtc);
    check('self-test: local label carries an explicit offset', /[+-]\d{2}:\d{2}$/.test(out.measuredAtLocal), out.measuredAtLocal);
    check('self-test: the two labels denote the SAME instant (no hidden drift)',
      Date.parse(out.measuredAtUtc) === Date.parse(out.measuredAtLocal), `${out.measuredAtUtc} vs ${out.measuredAtLocal}`);
    check('self-test: missing directory fails closed (never rendered as zero)',
      census(path.join(tmp, 'does-not-exist')).ok === false, '');

    // negative control: a census that used the WRONG bucket definition would report 3, not 4.
    const wrongBucketCount = out.oldLibs.filter((r) => !r.file.startsWith('_')).length;
    check('self-test: bucket definition is load-bearing (bare "3 个旧库" is reproducible only by dropping the index file)',
      wrongBucketCount === 3, String(wrongBucketCount));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return results;
}

// NB: fileURLToPath (not new URL().pathname) — the checkout path contains a space, which
// pathname would leave URL-encoded ("%20") and the equality test below would silently fail.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  if (SELF_TEST) {
    const results = selfTest();
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  — ' + r.detail}`);
    const fail = results.filter((r) => !r.ok).length;
    console.log(`\nSELF-TEST: ${results.length} assertions  PASS: ${results.length - fail}  FAIL: ${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  }
  const out = census(DIR);
  if (AS_JSON) console.log(JSON.stringify(out, null, 2));
  else for (const l of render(out)) console.log(l);
  process.exit(out.ok ? 0 : 2);
}
