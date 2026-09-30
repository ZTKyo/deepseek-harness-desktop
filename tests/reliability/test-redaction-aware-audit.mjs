// test-redaction-aware-audit.mjs
// P4 External Review remediation — D11 regression (2026-10-01)
//
// Proves BOTH directions of the redaction-aware audit contract:
//   (1) the program's own `[REDACTED:<family>]` marker is never reported as a
//       real secret residual (the measured false positive), and
//   (2) NO sensitivity was lost — every family still reports a genuine secret.
//
// CASE A  clean text                     -> raw 0 / placeholder 0 / real 0
// CASE B  redaction output               -> real 0 (marker not re-reported)
//          B1 uri-credential (the measured instance; naive counter must be >0,
//             which is the negative control proving the fix is not vacuous)
//          B2 generic-assignment / generic-bearer / pem-private-key
//          B3 marker adjacent to a GENUINE secret on the SAME line -> real >= 1
// CASE C  sensitivity preserved          -> every family sample still real >= 1
// CASE D  production store, read-only    -> real 0 (SKIP-with-reason if absent)
//
// INVARIANT asserted on every input: raw === placeholder + real.
//
// Nothing here writes to disk. CASE D only reads. No secret-shaped literal
// exists in this source: every fixture is assembled by concatenation (same
// discipline as tests/reliability/secret-scan-check.mjs CI_MOCK_LITERALS).

import fs from 'node:fs';
import { SECRET_PATTERNS, redactSecrets } from '../../plugins/learn-core.mjs';
import {
  auditText,
  auditTargets,
  defaultProductionStoreDir,
  REDACTION_PLACEHOLDER_RE,
  formatTotals,
} from './redaction-aware-secret-audit.mjs';

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(label + (detail ? ' :: ' + detail : ''));
    console.log(`  FAIL ${label}${detail ? ' :: ' + detail : ''}`);
  }
}
function rep(ch, n) { return ch.repeat(n); }

// ── fixtures (concatenated on purpose) ───────────────────────────────────────
const PEM_BEGIN = '-----BEGIN ' + 'PRIVATE KEY' + '-----';
const PEM_END = '-----END ' + 'PRIVATE KEY' + '-----';
const PEM_SAMPLE = PEM_BEGIN + '\n' + 'MIIB' + rep('A', 40) + '\n' + PEM_END;

const SAMPLES = [
  ['notion', 'ntn_' + rep('A', 20)],
  ['openrouter', 'sk-or-v1-' + rep('a', 24)],
  ['openai', 'sk-' + rep('a', 24)],
  ['anthropic', 'sk-ant-' + rep('a', 20)],
  ['slack', 'xoxb-' + rep('a', 20)],
  ['github', 'ghp_' + rep('a', 24)],
  ['jwt', 'eyJ' + rep('a', 24) + '.' + rep('b', 12) + '.' + rep('c', 12)],
  ['telegram', '1234567890' + ':' + rep('A', 35)],
  ['aws', 'AKIA' + rep('A', 16)],
  ['google', 'AIza' + rep('a', 35)],
  ['stripe', 'sk_' + 'live_' + rep('a', 20)],
  ['gitlab', 'glpat-' + rep('a', 22)],
  ['huggingface', 'hf_' + rep('a', 32)],
  ['npm', 'npm_' + rep('a', 36)],
  ['pem-private-key', PEM_SAMPLE],
  ['slack-webhook', 'https://hooks.slack.com/services/' + rep('a', 24)],
  ['uri-credential', 'postgres://' + 'user' + ':' + 'pw123456' + '@' + 'db.example.com/app'],
  ['generic-assignment', 'api_key' + '=' + rep('A', 20)],
  ['generic-bearer', 'Bearer ' + rep('A', 24)],
];

/** Naive (pre-fix) counter: raw pattern match count, no marker awareness. */
function naiveCount(text, family) {
  const p = SECRET_PATTERNS.find((x) => x.name === family);
  if (!p) throw new Error('unknown family ' + family);
  const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
  let n = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    n++;
    if (m[0] === '') re.lastIndex += 1;
  }
  return n;
}

function assertInvariant(label, text) {
  const r = auditText(text);
  ok(r.raw === r.placeholder + r.real, `INVARIANT raw==ph+real [${label}]`,
    `raw=${r.raw} ph=${r.placeholder} real=${r.real}`);
  return r;
}

console.log('=== D11 redaction-aware secret audit — regression ===');
console.log(`families under test: ${SECRET_PATTERNS.length}`);
ok(REDACTION_PLACEHOLDER_RE.source.includes('uri-credential'),
  'marker regex is restricted to real family names (uri-credential present)');

// ── CASE A ───────────────────────────────────────────────────────────────────
console.log('\n[CASE A] clean text -> all three counters 0');
{
  const A = 'ordinary log line: task finished, 42 items, no credentials here';
  const r = assertInvariant('A', A);
  ok(r.raw === 0 && r.placeholder === 0 && r.real === 0, 'CASE A counters all zero',
    `raw=${r.raw} ph=${r.placeholder} real=${r.real}`);
}

// ── CASE B ───────────────────────────────────────────────────────────────────
console.log('\n[CASE B] redaction output must NOT be re-reported as a real secret');
const redactedForms = {};
for (const [family, sample] of SAMPLES) {
  const red = redactSecrets(sample);
  redactedForms[family] = red;
  const r = assertInvariant(`B/${family}`, red);
  ok(r.real === 0, `CASE B real==0 after redaction [${family}]`,
    `raw=${r.raw} ph=${r.placeholder} real=${r.real} redacted=${red.slice(0, 40)}`);
  // A redacted form must be a fixed point of the redaction pipeline itself.
  ok(redactSecrets(red) === red, `redaction is a fixed point [${family}]`);
}

console.log('\n[CASE B1] measured instance (uri-credential in a URI) — with negative control');
{
  const sample = redactedForms['uri-credential'];
  const naive = naiveCount(sample, 'uri-credential');
  const r = auditText(sample);
  ok(naive >= 1, 'negative control: naive counter DOES reproduce the false positive',
    `naive=${naive} on ${sample}`);
  ok(r.real === 0, 'CASE B1 fixed auditor reports real==0', `real=${r.real}`);
  ok(r.placeholder >= 1, 'CASE B1 counts the match as a placeholder', `ph=${r.placeholder}`);
  ok(naive === r.placeholder, 'CASE B1 placeholder count equals the naive over-count',
    `naive=${naive} ph=${r.placeholder}`);
}

console.log('\n[CASE B2] other generic families after redaction');
for (const family of ['generic-assignment', 'generic-bearer', 'pem-private-key', 'stripe', 'google']) {
  const r = auditText(redactedForms[family]);
  ok(r.real === 0, `CASE B2 real==0 [${family}]`, `real=${r.real} raw=${r.raw}`);
}

console.log('\n[CASE B3] marker next to a GENUINE secret on the same line -> real >= 1');
{
  const line = 'dsn=postgres://' + '[REDACTED:uri-credential]' + '@db.example.com/app'
    + ' api_key' + '=' + rep('A', 20);
  const r = assertInvariant('B3', line);
  ok(r.real >= 1, 'CASE B3 genuine secret on the same line is still reported',
    `real=${r.real} ph=${r.placeholder}`);
  ok(r.byFamily['generic-assignment'] && r.byFamily['generic-assignment'].real >= 1,
    'CASE B3 the real hit is attributed to its own family');
}

// ── CASE C ───────────────────────────────────────────────────────────────────
console.log('\n[CASE C] sensitivity preserved — every family still detected');
let cReal = 0;
for (const [family, sample] of SAMPLES) {
  const r = assertInvariant(`C/${family}`, sample);
  const own = r.byFamily[family];
  ok(!!own && own.real >= 1, `CASE C family still detected [${family}]`,
    own ? `raw=${own.raw} ph=${own.placeholder} real=${own.real}` : 'family absent from result');
  if (own && own.real >= 1) cReal++;
}
ok(cReal === SECRET_PATTERNS.length,
  'CASE C coverage equals the full family table',
  `${cReal}/${SECRET_PATTERNS.length}`);
{
  // The exemption must be structural, not a whitelist: a doc-style example key
  // is reported and requires human adjudication; only the exact marker is exempt.
  const example = 'sk-' + rep('example', 4);
  const r = auditText(example);
  ok(r.real >= 1, 'CASE C doc-style example key is reported (human adjudication required)',
    `real=${r.real}`);
}
{
  // A marker-shaped token whose family is NOT real must not be exempted.
  const fake = '[REDACTED:' + 'sk-' + rep('a', 24) + ']';
  const r = auditText(fake);
  ok(r.real >= 1, 'CASE C fake marker does not mask a genuine key', `real=${r.real}`);
}

// ── CASE D ───────────────────────────────────────────────────────────────────
console.log('\n[CASE D] production learning store, read-only');
{
  const dir = process.env.D11_AUDIT_TARGET || defaultProductionStoreDir();
  if (!fs.existsSync(dir)) {
    console.log(`  SKIP (HUMAN-ENV / CI): production store not available at ${dir}`);
    console.log('  NOTE: a SKIP is NOT a PASS — the real-data audit must be run on the operator host.');
  } else {
    const totals = auditTargets([dir]);
    console.log(formatTotals(totals, 'CASE D production store'));
    console.log(`files scanned = ${totals.files}`);
    ok(totals.real === 0, 'CASE D REAL SECRET == 0 on production store',
      `real=${totals.real} raw=${totals.raw} ph=${totals.placeholder}`);
    ok(totals.raw === totals.placeholder + totals.real, 'CASE D invariant holds on production data');
    ok(totals.files > 0, 'CASE D actually scanned files (not a vacuous pass)', `files=${totals.files}`);
    for (const h of totals.realHits.slice(0, 20)) {
      console.log(`  REAL ${h.family} @ ${h.file}:${h.line} (masked ${h.preview})`);
    }
  }
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log('\n=== SUMMARY ===');
console.log(`ASSERTIONS: ${pass + fail}  PASS: ${pass}  FAIL: ${fail}`);
if (fail > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('D11 REDACTION-AWARE AUDIT: ALL PASS');
