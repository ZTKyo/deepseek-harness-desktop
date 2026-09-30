// check-l3-paths-coverage.mjs — D4 evidence (read-only, regenerable)
//
// The required status context "DSH boot + readiness smoke" is produced by
// .github/workflows/ci-level3.yml, which is currently gated by a WORKFLOW-LEVEL
// `paths:` filter. GitHub evaluates that filter at the event level: if none of
// the paths match, no run is created at all, so the required context is never
// reported and a pull request waits forever on "Waiting for status to be
// reported" (documented GitHub behaviour; see the governance record).
//
// This tool answers mechanically: which tracked files live OUTSIDE that filter,
// i.e. which changes can produce a permanently stuck pull request under the
// current configuration?
//
// GitHub glob semantics implemented here: `*` matches any run of characters
// except `/`; `**` matches across `/`; `?` matches one character except `/`.
//
// Run: node tools/check-l3-paths-coverage.mjs [--json]
// Read-only: never writes to the repository.

import fs from 'node:fs';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const WORKFLOW = '.github/workflows/ci-level3.yml';

const raw = fs.readFileSync(WORKFLOW, 'utf8');
const lines = raw.split(/\r?\n/);

// Extract the workflow-level `paths:` block (between `on:` and the first job key).
let inOn = false;
let inPaths = false;
const patterns = [];
for (const line of lines) {
  if (/^on:\s*$/.test(line)) { inOn = true; continue; }
  if (!inOn) continue;
  if (/^jobs:\s*$/.test(line)) break;
  const m = /^(\s*)paths:\s*$/.exec(line);
  if (m) { inPaths = true; continue; }
  if (inPaths) {
    const item = /^\s*-\s*'?([^'#]+?)'?\s*(?:#.*)?$/.exec(line);
    if (item) { patterns.push(item[1].trim()); continue; }
    if (/^\s*\S/.test(line) && !/^\s*#/.test(line)) inPaths = false;
  }
}

if (patterns.length === 0) {
  console.log(`NOTE  ${WORKFLOW} has no workflow-level paths filter — required context always reports (no lockout).`);
  process.exit(0);
}

const toRegex = (p) => {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') { out += '.*'; i++; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp(`^${out}$`);
};
const regexes = patterns.map(toRegex);

const ls = spawnSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (ls.status !== 0) { console.log('FAIL  git ls-files failed'); process.exit(1); }
const tracked = ls.stdout.split(/\r?\n/).filter((f) => f.length > 0);

const outside = tracked.filter((f) => !regexes.some((r) => r.test(f)));
const pct = ((outside.length / tracked.length) * 100).toFixed(1);

// Group by top-level area for a readable report.
const byArea = new Map();
for (const f of outside) {
  const key = f.includes('/') ? f.split('/').slice(0, 2).join('/') : '(repo root)';
  byArea.set(key, (byArea.get(key) || 0) + 1);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    workflow: WORKFLOW,
    patterns,
    trackedTotal: tracked.length,
    outsideTotal: outside.length,
    outsidePercent: Number(pct),
    byArea: Object.fromEntries([...byArea.entries()].sort((a, b) => b[1] - a[1])),
    outsideSample: outside.slice(0, 40),
  }, null, 2));
  process.exit(0);
}

console.log(`=== ci-level3 paths-filter coverage (D4) ===`);
console.log(`workflow          : ${WORKFLOW}`);
console.log(`paths patterns    : ${patterns.length}`);
console.log(`tracked files     : ${tracked.length}`);
console.log(`OUTSIDE the filter: ${outside.length} (${pct}%)  <-- changes here never create an L3 run`);
console.log(`\nby area (outside only):`);
for (const [k, v] of [...byArea.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}
console.log(`\nsample (first 25 outside):`);
for (const f of outside.slice(0, 25)) console.log(`  ${f}`);
console.log(`\nNOTE  Any pull request whose file set lies entirely in this list cannot report the required`);
console.log(`      context "DSH boot + readiness smoke" and stays unmergeable by configuration.`);
