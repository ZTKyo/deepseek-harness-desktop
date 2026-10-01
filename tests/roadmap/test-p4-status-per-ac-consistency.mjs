// test-p4-status-per-ac-consistency.mjs — R2 controls for EXTERNAL REVIEW FINDING A
//
// WHY THIS EXISTS
//   The R1 external review reproduced a real bypass: with
//   `docs/roadmap/P4_STATUS.json` -> acVerdicts.AC10 = "FAIL" while the authority
//   document still claimed AC1-AC10 all PASS, `validate-p4-status-consistency.mjs`
//   stayed GREEN (45 PASS / exit 0). A gate whose failure mode is silently agreeing
//   with a tampered index is not a gate. Claiming "we fixed it" is not evidence, so
//   this script re-runs the REAL gate against REAL tampered copies of the REAL tree:
//
//     positive : untouched tree                     -> exit 0 (GREEN)
//     negative : index / authority tampered 6 ways  -> exit 1 (RED) with the right assertion
//     positive : legitimate synchronised change     -> exit 0 (proves the gate is NOT
//                hard-coded to "AC must always be PASS"; it enforces CONSISTENCY)
//
//   Every mutation is applied to a throwaway copy under the OS temp dir. The template
//   tree in the repository is never written to. Each mutation asserts that its own text
//   replacement actually happened, so a silently-no-op case fails the test instead of
//   passing vacuously.
//
// Run: node tests/roadmap/test-p4-status-per-ac-consistency.mjs
// exit 0 = all controls behaved as required, exit 1 = a control did not (fail-closed).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const GATE_REL = path.join('tests', 'roadmap', 'validate-p4-status-consistency.mjs');
const INDEX_REL = path.join('docs', 'roadmap', 'P4_STATUS.json');
const AUTH_REL = path.join('docs', 'roadmap', 'CURRENT_STATUS.md');

const ALL_PASS_SENTENCE = 'AC1–AC10 全部 PASS';
const VERIFIED_STATUS = 'VERIFIED (ENGINEERING-COMPLETE) / AWAITING EXTERNAL REVIEW';

for (const rel of [GATE_REL, INDEX_REL, AUTH_REL]) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    console.log(`FAIL  missing required file: ${rel} (run from the repository root)`);
    process.exit(1);
  }
}

// ── throwaway copy of the tree ───────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-per-ac-'));
const SKIP_DIRS = new Set(['.git', 'node_modules']);
fs.cpSync(ROOT, TMP, {
  recursive: true,
  filter: (src) => {
    const base = path.basename(src);
    if (SKIP_DIRS.has(base)) return false;
    return true;
  },
});

const P = (rel) => path.join(TMP, rel);
const readFile = (rel) => fs.readFileSync(P(rel), 'utf8');
const writeFile = (rel, text) => fs.writeFileSync(P(rel), text, 'utf8');

const pristine = { index: readFile(INDEX_REL), auth: readFile(AUTH_REL) };
const restore = () => {
  writeFile(INDEX_REL, pristine.index);
  writeFile(AUTH_REL, pristine.auth);
};

function runGate() {
  const r = spawnSync(process.execPath, [GATE_REL], { cwd: TMP, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// ── the throwaway tree must be able to PROVE what history is ─────────────────
// The gate runs the document anchor gate, whose frozen-line exemption is judged against
// `git show HEAD:<file>`. A copy without a HEAD makes that unresolvable, so the gate goes red
// for a reason that has nothing to do with the case under test — and then every RED case would
// pass for the WRONG reason (false green) while the two legal cases (A0/A7) would fail.
// So: initialise a real one-commit repo inside the copy.
const git = (args) => spawnSync('git', args, { cwd: TMP, encoding: 'utf8' });
git(['init', '-q']);
git(['add', '-A']);
git(['-c', 'user.email=per-ac@local', '-c', 'user.name=per-ac', 'commit', '-q', '-m', 'throwaway baseline']);

// Baseline gate run: the environment itself must be GREEN, otherwise the controls below
// measure the environment instead of the case.
const baseline = runGate();
if (baseline.code !== 0) {
  console.log('FAIL  the throwaway baseline is not GREEN — every RED case below would then pass for the wrong reason');
  console.log(baseline.out.split(/\r?\n/).filter((l) => /^(FAIL|  - )/.test(l)).slice(0, 12).join('\n'));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp only */ }
  process.exit(1);
}

// Replace `from` with `to` in the given file text, asserting the edit really landed.
function mutate(rel, from, to, label) {
  const before = readFile(rel);
  if (!from.test) {
    if (!before.includes(from)) throw new Error(`${label}: expected text not found in ${rel}`);
    writeFile(rel, before.replace(from, to));
    return;
  }
  if (!from.test(before)) throw new Error(`${label}: expected pattern not found in ${rel}`);
  const after = before.replace(from, to);
  if (after === before) throw new Error(`${label}: replacement was a no-op in ${rel}`);
  writeFile(rel, after);
}

const setIndexVerdict = (ac, to, label) =>
  mutate(INDEX_REL, `"${ac}": "PASS"`, `"${ac}": "${to}"`, label);

const setAuthorityVerdict = (ac, to, label) =>
  mutate(
    AUTH_REL,
    new RegExp(`^([ \\t]*\\| ${ac} \\|[^\\n]*?\\| )\\*\\*PASS\\*\\*( \\|)`, 'm'),
    `$1**${to}**$2`,
    label,
  );

const cases = [
  {
    id: 'A0', name: 'untouched tree stays GREEN', expect: 0,
    apply: () => {},
  },
  {
    id: 'A1', name: 'index AC10 PASS->FAIL, authority untouched (the reproduced exploit)',
    expect: 1, wantAssertion: 'B7',
    apply: () => setIndexVerdict('AC10', 'FAIL', 'A1'),
  },
  {
    id: 'A2', name: 'index AC3 PASS->PARTIAL, authority untouched',
    expect: 1, wantAssertion: 'B7',
    apply: () => setIndexVerdict('AC3', 'PARTIAL', 'A2'),
  },
  {
    id: 'A3a', name: 'index is missing AC7',
    expect: 1, wantAssertion: 'B1',
    apply: () => mutate(INDEX_REL, /,\n\s*"AC7": "PASS"/, '', 'A3a'),
  },
  {
    id: 'A3b', name: 'authority table is missing its AC7 row',
    expect: 1, wantAssertion: 'B5',
    apply: () => mutate(AUTH_REL, /^[ \t]*\| AC7 \|[^\n]*$/m, '', 'A3b'),
  },
  {
    id: 'A4a', name: 'index carries an unknown extra AC11 key',
    expect: 1, wantAssertion: 'B1',
    apply: () => mutate(INDEX_REL, '"AC10": "PASS"', '"AC10": "PASS",\n    "AC11": "PASS"', 'A4a'),
  },
  {
    id: 'A4b', name: 'authority table carries an unknown extra AC11 row',
    expect: 1, wantAssertion: 'B5',
    apply: () => mutate(AUTH_REL, /^([ \t]*\| AC10 \|[^\n]*)$/m, '$1\n| AC11 | bogus | **PASS** | none |', 'A4b'),
  },
  {
    id: 'A5a', name: 'index verdict is not a legal token (AC5 = GREEN)',
    expect: 1, wantAssertion: 'B2',
    apply: () => setIndexVerdict('AC5', 'GREEN', 'A5a'),
  },
  {
    id: 'A5b', name: 'authority verdict is not a legal token (AC5 = GREEN)',
    expect: 1, wantAssertion: 'B6',
    apply: () => setAuthorityVerdict('AC5', 'GREEN', 'A5b'),
  },
  {
    id: 'A6', name: 'both sides agree on AC10=PARTIAL but the summary still claims all-PASS',
    expect: 1, wantAssertion: 'B8',
    apply: () => {
      setIndexVerdict('AC10', 'PARTIAL', 'A6 index');
      setAuthorityVerdict('AC10', 'PARTIAL', 'A6 authority');
    },
  },
  {
    id: 'A7', name: 'legitimate synchronised change (AC10=PARTIAL everywhere) stays GREEN',
    expect: 0,
    apply: () => {
      setIndexVerdict('AC10', 'PARTIAL', 'A7 index verdict');
      setAuthorityVerdict('AC10', 'PARTIAL', 'A7 authority verdict');
      mutate(INDEX_REL, ALL_PASS_SENTENCE, 'AC1–AC10：AC10 = PARTIAL，其余 PASS', 'A7 index sentence');
      mutate(AUTH_REL, ALL_PASS_SENTENCE, 'AC1–AC10：AC10 = PARTIAL，其余 PASS', 'A7 authority sentence');
      mutate(INDEX_REL, VERIFIED_STATUS, 'PARTIAL (ENGINEERING-COMPLETE) / AWAITING EXTERNAL REVIEW', 'A7 index p4Status');
      mutate(AUTH_REL, new RegExp(VERIFIED_STATUS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
        'PARTIAL (ENGINEERING-COMPLETE) / AWAITING EXTERNAL REVIEW', 'A7 authority p4Status');
    },
  },
];

console.log('=== Finding A controls: per-AC verdict consistency (real gate, throwaway tree) ===');
console.log(`tree under test: ${TMP}\n`);

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
  if (!applied) {
    console.log(`ERROR ${c.id}  ${c.name}`);
    continue;
  }
  const { code, out } = runGate();
  const codeOk = code === c.expect;
  const assertionOk = !c.wantAssertion || out.includes(`FAIL  ${c.wantAssertion}`);
  const good = codeOk && assertionOk;
  if (good) ok++;
  else {
    problems.push(`${c.id}: exit=${code} (expected ${c.expect})`
      + (c.wantAssertion && !assertionOk ? `, assertion ${c.wantAssertion} did not fire` : ''));
  }
  const verdictWord = code === 0 ? 'GREEN' : 'RED';
  console.log(`${good ? 'PASS ' : 'FAIL '} ${c.id}  expected=${c.expect === 0 ? 'GREEN' : 'RED'} actual=${verdictWord}(exit ${code})`
    + (c.wantAssertion ? ` assert=${c.wantAssertion}${assertionOk ? ' fired' : ' DID-NOT-FIRE'}` : '')
    + `  :: ${c.name}`);
}
restore();

console.log(`\nCONTROLS: ${cases.length}  AS-REQUIRED: ${ok}  MISBEHAVED: ${cases.length - ok}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp only */ }
if (problems.length > 0) {
  console.log('PROBLEMS:');
  for (const p of problems) console.log(`  - ${p}`);
  console.log('FINDING A CONTROLS: FAILED — a tamper case was not caught (or a legal case was rejected).');
  process.exit(1);
}
console.log('FINDING A CONTROLS: PASSED (per-AC tampering is caught; consistency, not permanent greenness, is enforced)');
process.exit(0);
