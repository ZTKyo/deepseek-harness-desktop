// verify-history-preserved.mjs — P4 External Review remediation, D1 (2026-10-01)
//
// WHY: the D1 remediation required that historical claims be *annotated, never
// rewritten* ("本文下方正文逐字保留历史原样"). Reviewers must not have to eyeball
// a diff to trust that. This gate proves it mechanically:
//
//   For every document registered in docs/roadmap/P4_STATUS.json, every non-empty
//   line of its HEAD revision must still exist in the working tree, as a prefix
//   of some working-tree line (allowing indentation to be normalised).
//
// A prefix match is the correct relation here: the sanctioned edit shape is
// "keep the line, append an inline marker" or "insert a banner around it".
// A line that was reworded or deleted has no matching prefix and fails.
//
// Run: node tests/roadmap/verify-history-preserved.mjs [ref]
//   ref defaults to HEAD. exit 0 = PASS, 1 = FAIL (fail-closed).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const REF = process.argv[2] || 'HEAD';
const INDEX = path.join(ROOT, 'docs', 'roadmap', 'P4_STATUS.json');

if (!fs.existsSync(INDEX)) {
  console.log(`FAIL  parity index missing: ${INDEX}`);
  process.exit(1);
}
const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const targets = (idx.supersededDocs || []).map((e) => e.path);

console.log(`=== history preservation check (baseline ref: ${REF}) ===`);
console.log(`registered documents: ${targets.length}`);

let pass = 0;
let fail = 0;
let totalLines = 0;
let skipped = [];

const norm = (s) => s.replace(/\s+/g, ' ').trim();

for (const rel of targets) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.log(`FAIL  ${rel} — missing in working tree`);
    fail++;
    continue;
  }
  // Reading the HEAD blob must succeed; otherwise we cannot prove anything.
  const res = spawnSync('git', ['show', `${REF}:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0 || typeof res.stdout !== 'string' || res.stdout.length === 0) {
    console.log(`FAIL  ${rel} — cannot read ${REF}:${rel} (${(res.stderr || '').trim().split('\n')[0] || 'no output'})`);
    fail++;
    continue;
  }
  const headLines = res.stdout.split(/\r?\n/);
  const wtNorm = fs.readFileSync(abs, 'utf8').split(/\r?\n/).map(norm);
  const wtSet = new Set(wtNorm.filter((l) => l.length > 0));
  // Also keep a prefix index so "line + appended marker" matches.
  const wtPrefixOk = (h) => {
    if (wtSet.has(h)) return true;
    for (const w of wtSet) if (w.startsWith(h)) return true;
    return false;
  };

  const lost = [];
  let checked = 0;
  for (let i = 0; i < headLines.length; i++) {
    const h = norm(headLines[i]);
    if (!h) continue;
    checked++;
    // A markdown table separator row (|---|) can legitimately be reformatted by a
    // surrounding edit; every other line must survive verbatim.
    if (/^\|[\s:|-]+\|$/.test(h)) { skipped.push(`${rel}:${i + 1}`); continue; }
    if (!wtPrefixOk(h)) lost.push(`${i + 1}: ${h.slice(0, 110)}`);
  }
  totalLines += checked;
  if (lost.length === 0) {
    pass++;
    console.log(`PASS  preserved verbatim [${rel}] — ${checked} HEAD lines all present`);
  } else {
    fail++;
    console.log(`FAIL  ${rel} — ${lost.length}/${checked} HEAD line(s) no longer present:`);
    for (const l of lost.slice(0, 8)) console.log(`        ${l}`);
  }
}

console.log(`\nDOCUMENTS: ${pass + fail}  PASS: ${pass}  FAIL: ${fail}  HEAD LINES CHECKED: ${totalLines}`);
if (skipped.length > 0) console.log(`NOTES: ${skipped.length} table-separator row(s) exempted from the prefix rule`);
if (fail > 0) {
  console.log('HISTORY PRESERVATION: FAILED — the D1 rule is "annotate, never rewrite".');
  process.exit(1);
}
console.log('HISTORY PRESERVATION: PASSED (historical text intact; changes are additive only)');
