// redaction-aware-secret-audit.mjs
// P4 External Review remediation — D11 (2026-10-01)
//
// PROBLEM THIS SOLVES (measured, not theorised):
//   The P4 audit used `containsSecret()` / raw pattern counting. The redaction
//   pipeline's OWN output token `[REDACTED:<family>]` can be re-matched by a
//   family pattern. Concrete instance:
//       postgres://user:pw@db/x   --(redactSecrets)-->   postgres://[REDACTED:uri-credential]@db/x
//   The `uri-credential` pattern is /(?<=:\/\/)[^\s/?#]+(?=@)/ — the placeholder
//   contains `:` and sits between `://` and `@`, so it looks exactly like
//   `user:pass@`. The auditor therefore kept reporting a "leak" that was its own
//   marker, and the reported count never converged to zero.
//
// FIX DISCIPLINE (this must NOT become a way to hide real secrets):
//   1. NO family is removed, NO pattern is weakened, NO whole-line exemption.
//   2. The exemption is FRAGMENT-LEVEL and applies to exactly ONE token shape:
//      the marker this program itself generates, `[REDACTED:<family>]`.
//   3. A match is classified PLACEHOLDER only if the matched substring STOPS
//      matching the very same pattern once the markers inside it are removed.
//      If it still matches, the substring carries its own secret payload and is
//      reported as REAL — so a marker sitting next to a genuine secret on the
//      same line can never hide that genuine secret.
//   4. Every audit result must satisfy the invariant raw == placeholder + real.
//
// OUTPUT CONTRACT (mandatory from 2026-10-01 onward):
//   RAW MATCH             — every pattern match found in the original text.
//   REDACTION PLACEHOLDER — matches that exist only because of a marker.
//   REAL SECRET           — matches carrying their own secret payload.
//   ONLY `REAL SECRET` may be quoted as a leak finding. `RAW MATCH` alone is
//   NOT a leak statement.
//
// Usage (read-only; never writes, never mutates):
//   node tests/reliability/redaction-aware-secret-audit.mjs <path> [<path> ...]
//   node tests/reliability/redaction-aware-secret-audit.mjs --json <path> ...
//   node tests/reliability/redaction-aware-secret-audit.mjs            # default: production learn store
// exit 0 = REAL SECRET == 0, exit 1 = REAL SECRET > 0, exit 2 = usage/target problem.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SECRET_PATTERNS } from '../../plugins/learn-core.mjs';

/**
 * The one and only token shape this auditor exempts.
 * Deliberately RESTRICTED to the exact names of real families: a marker regex of
 * the loose form `[REDACTED:<anything>]` would let a hand-written marker whose
 * family field is itself a key-shaped string mask a genuine key. Restricting the
 * alternation to `SECRET_PATTERNS[].name` keeps the exemption precisely equal to
 * "a token this program itself emits via redactionToken()".
 */
export const REDACTION_PLACEHOLDER_RE = new RegExp(
  '\\[REDACTED:(?:' + SECRET_PATTERNS.map((p) => p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\]',
  'g',
);

/** Hard bound so a pathological pattern cannot hang the audit. */
const MAX_SPANS_PER_PATTERN = 20000;

/** Default read-only target: the production (or profile) learning store dir. */
export function defaultProductionStoreDir() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'DSHHarness', 'state', 'learn');
}

export function hasPlaceholderMarker(s) {
  if (typeof s !== 'string' || s === '') return false;
  return new RegExp(REDACTION_PLACEHOLDER_RE.source).test(s);
}

/** Replace each marker with same-length blanks (offsets/structure preserved). */
export function maskRedactionPlaceholders(text) {
  if (typeof text !== 'string') return '';
  return text.replace(new RegExp(REDACTION_PLACEHOLDER_RE.source, 'g'), (m) => ' '.repeat(m.length));
}

/** Remove markers entirely (used for the payload test in rule 3). */
export function stripRedactionPlaceholders(text) {
  if (typeof text !== 'string') return '';
  return text.replace(new RegExp(REDACTION_PLACEHOLDER_RE.source, 'g'), '');
}

function freshRe(p) {
  const flags = p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g';
  return new RegExp(p.re.source, flags);
}

function spansOf(text, p) {
  const re = freshRe(p);
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ index: m.index, text: m[0] });
    if (m[0] === '') re.lastIndex += 1; // zero-length guard
    if (out.length >= MAX_SPANS_PER_PATTERN) break;
  }
  return out;
}

/**
 * Classify a single match span.
 * PLACEHOLDER  <=> the span contains a marker AND loses the match once markers are removed.
 * REAL         <=> it keeps matching on its own payload (marker present or not).
 */
export function classifySpan(spanText, p) {
  if (!hasPlaceholderMarker(spanText)) return 'real';
  const stripped = stripRedactionPlaceholders(spanText);
  if (stripped === '' || stripped.trim() === '') return 'placeholder';
  const stillMatches = new RegExp(p.re.source, p.re.flags.replace(/g/g, '')).test(stripped);
  return stillMatches ? 'real' : 'placeholder';
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Mask a matched value so it can be printed without leaking it. */
function safePreview(matchText) {
  const t = String(matchText);
  if (t.length <= 12) return '[len=' + t.length + ']';
  return t.slice(0, 4) + '…[len=' + t.length + ']…' + t.slice(-2);
}

/**
 * Audit one text blob.
 * @returns {{raw:number, placeholder:number, real:number, byFamily:Object, realHits:Array}}
 */
export function auditText(text) {
  if (typeof text !== 'string') text = '';
  const byFamily = {};
  const realHits = [];
  let raw = 0;
  let placeholder = 0;
  let real = 0;
  for (const p of SECRET_PATTERNS) {
    const spans = spansOf(text, p);
    if (spans.length === 0) continue;
    let fRaw = 0;
    let fPh = 0;
    let fReal = 0;
    for (const s of spans) {
      const kind = classifySpan(s.text, p);
      fRaw++;
      if (kind === 'placeholder') fPh++;
      else {
        fReal++;
        realHits.push({
          family: p.name,
          line: lineOf(text, s.index),
          index: s.index,
          preview: safePreview(s.text),
        });
      }
    }
    raw += fRaw;
    placeholder += fPh;
    real += fReal;
    byFamily[p.name] = { raw: fRaw, placeholder: fPh, real: fReal };
  }
  return { raw, placeholder, real, byFamily, realHits };
}

/** Audit a file on disk (read-only). */
export function auditFile(absPath) {
  let content = '';
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch (e) {
    return { file: absPath, error: String((e && e.message) || e), raw: 0, placeholder: 0, real: 0, byFamily: {}, realHits: [] };
  }
  const r = auditText(content);
  return { file: absPath, ...r };
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.wav', '.mp3', '.exe', '.dll', '.zip', '.bin']);

export function collectFiles(targets) {
  const out = [];
  const visit = (p, depth) => {
    if (depth > 12) return;
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      let entries;
      try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
        visit(path.join(p, e.name), depth + 1);
      }
      return;
    }
    if (!st.isFile()) return;
    if (SKIP_EXT.has(path.extname(p).toLowerCase())) return;
    out.push(p);
  };
  for (const t of targets) visit(t, 0);
  return out;
}

/** Audit a set of files/dirs. */
export function auditTargets(targets) {
  const totals = { raw: 0, placeholder: 0, real: 0, files: 0, byFamily: {}, realHits: [] };
  for (const f of collectFiles(targets)) {
    const r = auditFile(f);
    if (r.error) continue;
    totals.files++;
    totals.raw += r.raw;
    totals.placeholder += r.placeholder;
    totals.real += r.real;
    for (const [k, v] of Object.entries(r.byFamily)) {
      const acc = totals.byFamily[k] || { raw: 0, placeholder: 0, real: 0 };
      acc.raw += v.raw; acc.placeholder += v.placeholder; acc.real += v.real;
      totals.byFamily[k] = acc;
    }
    for (const h of r.realHits) totals.realHits.push({ ...h, file: f });
  }
  return totals;
}

/** Canonical totals block — the ONLY wording allowed in reports. */
export function formatTotals(totals, label = 'AUDIT') {
  const lines = [];
  lines.push(`--- ${label} ---`);
  lines.push(`RAW MATCH              = ${totals.raw}`);
  lines.push(`REDACTION PLACEHOLDER  = ${totals.placeholder}`);
  lines.push(`REAL SECRET            = ${totals.real}`);
  lines.push(`INVARIANT raw==ph+real = ${totals.raw === totals.placeholder + totals.real ? 'HOLD' : 'VIOLATED'}`);
  const fams = Object.keys(totals.byFamily).sort();
  if (fams.length) {
    lines.push('BY FAMILY (raw/placeholder/real):');
    for (const f of fams) {
      const v = totals.byFamily[f];
      lines.push(`  ${f.padEnd(24)} ${v.raw}/${v.placeholder}/${v.real}`);
    }
  }
  return lines.join('\n');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const rest = argv.filter((a) => a !== '--json');
  const targets = rest.length ? rest : [defaultProductionStoreDir()];

  if (targets.length === 1 && !fs.existsSync(targets[0])) {
    const msg = `TARGET NOT AVAILABLE: ${targets[0]} (read-only audit cannot run; this is NOT a PASS)`;
    if (asJson) console.log(JSON.stringify({ ok: false, reason: 'target_unavailable', target: targets[0] }, null, 2));
    else console.log(msg);
    process.exit(2);
  }

  const totals = auditTargets(targets);
  if (asJson) {
    console.log(JSON.stringify({ ok: totals.real === 0, targets, ...totals }, null, 2));
  } else {
    console.log(formatTotals(totals, 'REDACTION-AWARE SECRET AUDIT'));
    console.log(`FILES SCANNED          = ${totals.files}`);
    for (const h of totals.realHits.slice(0, 50)) {
      console.log(`REAL ${h.family} @ ${h.file}:${h.line} (masked: ${h.preview})`);
    }
    if (totals.realHits.length > 50) console.log(`... (+${totals.realHits.length - 50} more REAL hits)`);
    if (totals.placeholder > 0 && totals.real === 0) {
      console.log('NOTE: all raw matches are this program\'s own [REDACTED:<family>] markers; REAL SECRET = 0.');
    }
    console.log(totals.real === 0 ? 'VERDICT: REAL SECRET COUNT = 0' : `VERDICT: REAL SECRET COUNT = ${totals.real}`);
  }
  process.exit(totals.real === 0 ? 0 : 1);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
