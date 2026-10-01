// test-release-artifact-verifier.mjs — R2 controls for EXTERNAL REVIEW FINDING B
//
// WHY THIS EXISTS
//   The R1 external review reproduced the blocker: on the SAME commit, the release-artifact
//   verifier said `IDENTICAL` / exit 0 in an LF checkout and `DRIFT` / exit 1 in a CRLF
//   checkout. The verdict depended on the checkout, not on the content — so the artifact
//   gate could not be trusted across environments. The fix separates
//     canonicalBodySha256 (EOL-normalized: CRLF/CR -> LF)  = the ONLY verdict input
//     rawFileSha256       (raw bytes)                       = forensic only
//
//   This script proves the fixed behaviour by running the REAL verifier against REAL
//   byte-controlled variants of the REAL artifact in a throwaway copy of the tree:
//     EOL stability : LF / CRLF / CR / mixed / cross-file mismatch  -> exit 0 IDENTICAL
//     tamper        : body drift, deleted section, non-EOL whitespace change,
//                     stale header hash, missing header hash, malformed header,
//                     self-conflicting hashes, extra trailing newline -> exit 1 DRIFT
//
//   Every mutation asserts that it actually landed, so a no-op cannot pass vacuously.
//   The template tree in the repository is never written to.
//
// Run: node tests/roadmap/test-release-artifact-verifier.mjs
// exit 0 = all controls behaved as required, exit 1 = a control misbehaved (fail-closed).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const TOOL_REL = path.join('tools', 'verify-release-artifact.mjs');
const DIR_REL = path.join('docs', 'roadmap', 'reports', 'PHASE_04_LEARNING', 'R3_FINAL_CLOSURE');
const AUTH_REL = path.join(DIR_REL, 'EXTERNAL_REVIEW_REMEDIATION_CLOSURE_R1.md');
const RELEASE_REL = path.join(DIR_REL, 'P4_REMEDIATION_CLOSURE_20261001-0425.md');

for (const rel of [TOOL_REL, AUTH_REL, RELEASE_REL]) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    console.log(`FAIL  missing required file: ${rel} (run from the repository root)`);
    process.exit(1);
  }
}

const toLf = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const toCrlf = (s) => toLf(s).replace(/\n/g, '\r\n');
const toCr = (s) => toLf(s).replace(/\n/g, '\r');

// ── throwaway copy of the tree ───────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-artifact-'));
const SKIP_DIRS = new Set(['.git', 'node_modules']);
fs.cpSync(ROOT, TMP, { recursive: true, filter: (src) => !SKIP_DIRS.has(path.basename(src)) });

const P = (rel) => path.join(TMP, rel);
const write = (rel, text) => fs.writeFileSync(P(rel), text, 'utf8');

// Pristine (LF) content of both artifacts, normalised so the test controls the EOLs itself.
const authLf = toLf(fs.readFileSync(path.join(ROOT, AUTH_REL), 'utf8'));
const relLf = toLf(fs.readFileSync(path.join(ROOT, RELEASE_REL), 'utf8'));
const restore = () => { write(AUTH_REL, authLf); write(RELEASE_REL, relLf); };

function runTool() {
  const r = spawnSync(process.execPath, [TOOL_REL], { cwd: TMP, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// Mutate the release file, asserting the edit really landed.
function mutateRelease(from, to, label, all = false) {
  const before = fs.readFileSync(P(RELEASE_REL), 'utf8');
  if (!before.includes(from)) throw new Error(`${label}: anchor text not found`);
  const after = all ? before.split(from).join(to) : before.replace(from, to);
  if (after === before) throw new Error(`${label}: replacement was a no-op`);
  write(RELEASE_REL, after);
}

const REAL_HASH = (relLf.match(/CANONICAL_BODY_SHA256\s*=\s*([0-9A-F]{64})/) || [])[1];
if (!REAL_HASH) {
  console.log('FAIL  could not read the recorded CANONICAL_BODY_SHA256 from the release artifact');
  process.exit(1);
}

// A section heading that really exists in the artifact body (used for the "deleted section" case).
const SECTION_ANCHOR = 'tools/verify-release-artifact.mjs';
if (!relLf.includes(SECTION_ANCHOR)) {
  console.log('FAIL  section anchor for the deletion control not found');
  process.exit(1);
}

const cases = [
  // ── EOL stability:行尾风格绝不能改变判定 ────────────────────────────────────
  { id: 'B0', name: 'untouched tree (LF) is IDENTICAL', expect: 0, want: 'IDENTICAL', apply: () => {} },
  { id: 'B1', name: 'both artifacts rewritten as CRLF', expect: 0, want: 'IDENTICAL',
    apply: () => { write(AUTH_REL, toCrlf(authLf)); write(RELEASE_REL, toCrlf(relLf)); } },
  { id: 'B2', name: 'both artifacts rewritten with classic CR only', expect: 0, want: 'IDENTICAL',
    apply: () => { write(AUTH_REL, toCr(authLf)); write(RELEASE_REL, toCr(relLf)); } },
  { id: 'B3', name: 'authority LF + release CRLF (cross-file style mismatch)', expect: 0, want: 'IDENTICAL',
    apply: () => { write(RELEASE_REL, toCrlf(relLf)); } },
  { id: 'B4', name: 'authority CRLF + release LF (reverse mismatch)', expect: 0, want: 'IDENTICAL',
    apply: () => { write(AUTH_REL, toCrlf(authLf)); } },
  { id: 'B5', name: 'mixed EOL inside one artifact (alternating LF/CRLF)', expect: 0, want: 'IDENTICAL',
    apply: () => {
      // Split WITHOUT creating a phantom extra line: the final '' element of the split must not
      // be re-terminated, or the "EOL-only" variant would actually add a real newline.
      const parts = relLf.split('\n');            // the final '' element is the post-last-EOL tail
      const mixed = parts.map((l, i) => {
        if (i === parts.length - 1) return l;     // never terminate the tail, or a newline is added
        return i % 2 === 0 ? `${l}\r\n` : `${l}\n`;
      }).join('');
      if (toLf(mixed) !== relLf) throw new Error('B5: the mixed-EOL variant changed the content, not just the endings');
      write(RELEASE_REL, mixed);
    } },

  // ── tamper controls: 真实内容差异必须 RED ──────────────────────────────────
  { id: 'B6', name: 'one real character changed in the body', expect: 1, want: 'body-drift',
    apply: () => mutateRelease('RELEASE ARTIFACT INTEGRITY', 'RELEASE ARTIFACT INTEGRITYY', 'B6') },
  { id: 'B7', name: 'a key body section deleted', expect: 1, want: 'body-drift',
    apply: () => mutateRelease(`${SECTION_ANCHOR}                                (交付物完整性校验：命名版正文==权威正文 + 头部哈希同步；含负对照)\n`, '', 'B7') },
  { id: 'B8', name: 'non-EOL whitespace change only (one double space collapsed in the body)', expect: 1, want: 'body-drift',
    apply: () => {
      const lines = fs.readFileSync(P(RELEASE_REL), 'utf8').split('\n');
      for (let i = 4; i < lines.length; i++) {
        if (/ {2}/.test(lines[i])) {
          lines[i] = lines[i].replace(/ {2}/, ' ');
          write(RELEASE_REL, lines.join('\n'));
          return;
        }
      }
      throw new Error('B8: no body line containing a double space was found');
    } },
  { id: 'B9', name: 'extra trailing newline appended to the body', expect: 1, want: 'body-drift',
    apply: () => write(RELEASE_REL, `${relLf}\n`) },
  { id: 'B10', name: 'recorded hash is stale (both header fields tampered alike)', expect: 1, want: 'header-hash-stale',
    apply: () => mutateRelease(REAL_HASH, 'A'.repeat(64), 'B10', true) },
  { id: 'B11', name: 'recorded hash is missing entirely', expect: 1, want: 'header-hash-missing',
    apply: () => mutateRelease(REAL_HASH, 'NONE', 'B11', true) },
  { id: 'B12', name: 'header comment block is malformed (opener removed)', expect: 1, want: 'header-shape',
    apply: () => mutateRelease('<!-- 发布命名版', '发布命名版', 'B12') },
  { id: 'B13', name: 'header gains a second, conflicting CANONICAL_BODY_SHA256', expect: 1, want: 'header-hash-self-conflict',
    apply: () => mutateRelease('<!-- 命名依据：', `<!-- CANONICAL_BODY_SHA256 = ${'B'.repeat(64)} -->\n<!-- 命名依据：`, 'B13') },
];

console.log('=== Finding B controls: release-artifact verifier (real tool, throwaway tree) ===');
console.log(`tree under test: ${TMP}`);
console.log(`recorded CANONICAL_BODY_SHA256 = ${REAL_HASH}\n`);

let ok = 0;
const problems = [];
for (const c of cases) {
  restore();
  let applied = true;
  try {
    c.apply();
  } catch (e) {
    applied = false;
    problems.push(`${c.id}: mutation failed — ${e.message}`);
  }
  if (!applied) { console.log(`ERROR ${c.id}  ${c.name}`); continue; }

  const { code, out } = runTool();
  const codeOk = code === c.expect;
  const wordOk = out.includes(c.want);
  const good = codeOk && wordOk;
  if (good) ok++;
  else {
    problems.push(`${c.id}: exit=${code} (expected ${c.expect})`
      + (wordOk ? '' : `, expected text "${c.want}" not in output`));
  }
  console.log(`${good ? 'PASS ' : 'FAIL '} ${c.id}  expected=${c.expect === 0 ? 'IDENTICAL(0)' : 'DRIFT(1)'}`
    + ` actual=${code === 0 ? 'IDENTICAL(0)' : 'DRIFT(1)'} reason~=${c.want}  :: ${c.name}`);
}
restore();

console.log(`\nCONTROLS: ${cases.length}  AS-REQUIRED: ${ok}  MISBEHAVED: ${cases.length - ok}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp only */ }
if (problems.length > 0) {
  console.log('PROBLEMS:');
  for (const p of problems) console.log(`  - ${p}`);
  console.log('FINDING B CONTROLS: FAILED — the verifier is not EOL-stable, or a tamper case slipped through.');
  process.exit(1);
}
console.log('FINDING B CONTROLS: PASSED (EOL style never changes the verdict; real content drift always does)');
process.exit(0);
