#!/usr/bin/env node
// P4.5 — test suite for the session-format compatibility overlay tooling (B8-C1/C2 adapter, NEEDS_OVERLAY).
// The dispatch label for this work was "K4"; the program's K1–K4 risk list reserves K4 for the
// HMR/dependency-pin leg, so this file is labelled by substance and the old label is kept for traceability.
//
// Two layers, both against real files (no mocks):
//   A. the applier   : anchor discipline, interlock, idempotency, dry-run, rollback safety,
//                      and the byte-exactness of the patch it produces (pristine 1B3BFF6A… -> patched C9BB15F3…),
//   B. the canary    : for BOTH instantiations of the codec (patched and pristine) the same synthetic
//                      fixture set must produce the counterfactual verdict — admitted on the patched
//                      build, refused on the pristine build — while every fail-closed control holds on
//                      both, and the routing assertion must reject a mismatched --expect.
//
// Everything is written under .p45-tmp/ (inside the worktree, which the tools' interlock allows).
// Nothing here touches the live installation or ~/.dsh.
//
// Usage: node tests/session-compat/run-session-compat-tests.mjs [--json <file>]
// Exit 0 = all assertions passed (or explicitly skipped with a recorded reason), 1 = a failure.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WT = path.resolve(HERE, '..', '..');
const TOOLS = path.join(WT, 'tools', 'session-compat');
const APPLIER = path.join(TOOLS, 'apply-descriptor-compat-overlay.mjs');
const CANARY = path.join(TOOLS, 'session-compat-canary.mjs');
const TMP = path.join(WT, '.p45-tmp', 'session-compat-tests');
const SANDBOX = 'C:\\Users\\Administrator\\Desktop\\sdeepseek harness\\_p4_5-sandbox';
const PRISTINE_INSTALL = path.join(SANDBOX, 'target-stable');
const PATCHED_INSTALL = path.join(SANDBOX, 'target-newest');
const PRISTINE_SHA = '1b3bff6aaf28ca62a864cf97b9aa9aa45ab76de5e459f7881ba4bc8de73490b1';
const PATCHED_SHA = 'c9bb15f34806a1c7dbd0f08bee431db1cef0e312acec08dddf4bdc4f8b9474f9';
const LIB_REL = path.join('node_modules', '@deepseek-ai', 'dsh-session-format-v0-to-v1', 'lib', 'index.js');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const shaBuf = (b) => crypto.createHash('sha256').update(b).digest('hex');

const results = [];
let failures = 0;
function check(name, passed, detail = '') {
  results.push({ name, passed: !!passed, detail: String(detail) });
  if (!passed) failures++;
  console.log((passed ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   :: ' + detail : ''));
}
function skip(name, reason) { results.push({ name, passed: null, skipped: true, detail: reason }); console.log('SKIP  ' + name + '   :: ' + reason); }

function runNode(script, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function fresh(dir) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); return dir; }

// ---------------------------------------------------------------------------------------------
// A. applier
// ---------------------------------------------------------------------------------------------
const recordedPristine = path.join(PATCHED_INSTALL, 'node_modules', '@deepseek-ai', 'dsh-session-format-v0-to-v1', 'lib', 'index.js.pre-p4_5-compat.bak');
const recordedPatched = path.join(PATCHED_INSTALL, LIB_REL);

fresh(TMP);

// --- A0: fixtures exist ----------------------------------------------------------------------
if (!fs.existsSync(recordedPristine) || !fs.existsSync(recordedPatched)) {
  skip('A: applier byte-exactness against the recorded codec', 'recorded sandbox artifacts not found under ' + PATCHED_INSTALL);
} else {
  const pristineRaw = fs.readFileSync(recordedPristine, 'utf8');
  const patchedRaw = fs.readFileSync(recordedPatched, 'utf8');
  check('A1 recorded pristine fixture still hashes to the recorded pristine value', shaBuf(Buffer.from(pristineRaw, 'utf8')) === PRISTINE_SHA, shaBuf(Buffer.from(pristineRaw, 'utf8')));
  check('A2 recorded patched fixture still hashes to the recorded patched value', shaBuf(Buffer.from(patchedRaw, 'utf8')) === PATCHED_SHA, shaBuf(Buffer.from(patchedRaw, 'utf8')));

  // --- A3 dry-run: reports the anticipated hash and writes nothing ---------------------------
  const dryRoot = path.join(TMP, 'dry');
  fs.mkdirSync(path.join(dryRoot, 'node_modules', '@deepseek-ai', 'dsh-session-format-v0-to-v1', 'lib'), { recursive: true });
  const dryTarget = path.join(dryRoot, LIB_REL);
  fs.writeFileSync(dryTarget, pristineRaw, 'utf8');
  const dry = runNode(APPLIER, ['--install', dryRoot, '--dry-run', '--json', path.join(TMP, 'dry-report.json')]);
  check('A3 dry-run exits 0', dry.code === 0, 'exit=' + dry.code);
  check('A4 dry-run leaves the target byte-identical', sha(dryTarget) === PRISTINE_SHA, sha(dryTarget));
  check('A5 dry-run writes no backup file', !fs.existsSync(dryTarget + '.pre-p4_5-compat.bak'), 'backup must not be created in a dry run');
  const dryReport = fs.existsSync(path.join(TMP, 'dry-report.json')) ? JSON.parse(fs.readFileSync(path.join(TMP, 'dry-report.json'), 'utf8')) : null;
  check('A6 dry-run reports 6 rule sites and 27 inserted lines', dryReport && dryReport.insertions.length === 6 && dryReport.addedLines === 27, dryReport ? JSON.stringify({ sites: dryReport.insertions.length, added: dryReport.addedLines }) : 'no report');

  // --- A7 real apply: byte-exact, backed up, idempotent ---------------------------------------
  const applyRoot = path.join(TMP, 'apply');
  fs.mkdirSync(path.join(applyRoot, 'node_modules', '@deepseek-ai', 'dsh-session-format-v0-to-v1', 'lib'), { recursive: true });
  const applyTarget = path.join(applyRoot, LIB_REL);
  fs.writeFileSync(applyTarget, pristineRaw, 'utf8');
  const apply = runNode(APPLIER, ['--install', applyRoot, '--json', path.join(TMP, 'apply-report.json')]);
  check('A7 apply exits 0', apply.code === 0, 'exit=' + apply.code + ' err=' + apply.err.trim().slice(0, 200));
  check('A8 applied file hashes to the recorded patched value', sha(applyTarget) === PATCHED_SHA, sha(applyTarget));
  check('A9 applied file is byte-identical to the recorded patched codec', fs.readFileSync(applyTarget).equals(fs.readFileSync(recordedPatched)), 'buffer comparison');
  check('A10 backup holds the pristine bytes', fs.existsSync(applyTarget + '.pre-p4_5-compat.bak') && sha(applyTarget + '.pre-p4_5-compat.bak') === PRISTINE_SHA, 'backup sha');
  const second = runNode(APPLIER, ['--install', applyRoot]);
  check('A11 re-apply is idempotent (exit 0, bytes unchanged)', second.code === 0 && sha(applyTarget) === PATCHED_SHA, 'exit=' + second.code + ' sha=' + sha(applyTarget));
  check('A12 re-apply reports ALREADY_PATCHED', /ALREADY PATCHED/.test(second.out), second.out.trim().split('\n')[0]);

  // --- A13 --check ----------------------------------------------------------------------------
  const checkPatched = runNode(APPLIER, ['--install', applyRoot, '--check']);
  check('A13 --check on a patched tree exits 0', checkPatched.code === 0, 'exit=' + checkPatched.code);
  const checkPristine = runNode(APPLIER, ['--install', dryRoot, '--check']);
  check('A14 --check on a pristine tree exits 6 (overlay absent)', checkPristine.code === 6, 'exit=' + checkPristine.code);

  // --- A15 rollback safety: a tampered anchor must not produce a partial patch ---------------
  const badRoot = path.join(TMP, 'bad-anchor');
  fs.mkdirSync(path.join(badRoot, 'node_modules', '@deepseek-ai', 'dsh-session-format-v0-to-v1', 'lib'), { recursive: true });
  const badTarget = path.join(badRoot, LIB_REL);
  fs.writeFileSync(badTarget, pristineRaw.replace('\t\t\tmessageValue(data, label, version, "user");', '\t\t\tmessageValue(data, label, version, "user"); // tampered'), 'utf8');
  const badBefore = sha(badTarget);
  const bad = runNode(APPLIER, ['--install', badRoot]);
  check('A15 a missing anchor exits 4 and writes nothing', bad.code === 4 && sha(badTarget) === badBefore, 'exit=' + bad.code);
  check('A16 the refusal names the anchor problem', /anchor line matched 0 times/.test(bad.err), bad.err.trim().split('\n').slice(-2).join(' | ').slice(0, 200));

  // --- A17 ambiguous anchor ------------------------------------------------------------------
  const dupRoot = path.join(TMP, 'dup-anchor');
  fs.mkdirSync(path.join(dupRoot, 'node_modules', '@deepseek-ai', 'dsh-session-format-v0-to-v1', 'lib'), { recursive: true });
  const dupTarget = path.join(dupRoot, LIB_REL);
  const dupLine = '\tassertReleasedPayloadSemantics(event, version);';
  fs.writeFileSync(dupTarget, pristineRaw.replace(dupLine, dupLine + '\n' + dupLine), 'utf8');
  const dup = runNode(APPLIER, ['--install', dupRoot]);
  check('A17 an ambiguous anchor exits 4 and writes nothing', dup.code === 4, 'exit=' + dup.code);
  check('A18 the refusal reports the anchor count', /matched 2 times, expected 1/.test(dup.err), dup.err.trim().split('\n').slice(-2).join(' | ').slice(0, 200));

  // --- A19 unrecorded pristine ---------------------------------------------------------------
  const oddRoot = path.join(TMP, 'unrecorded');
  fs.mkdirSync(path.join(oddRoot, 'node_modules', '@deepseek-ai', 'dsh-session-format-v0-to-v1', 'lib'), { recursive: true });
  const oddTarget = path.join(oddRoot, LIB_REL);
  // A build that still has every anchor but is not byte-identical to the recorded pristine artifact:
  // appending a line changes the fingerprint without disturbing any anchor.
  fs.writeFileSync(oddTarget, pristineRaw + '\n// unrecorded-build-marker (test fixture)\n', 'utf8');
  const oddBefore = sha(oddTarget);
  const odd = runNode(APPLIER, ['--install', oddRoot]);
  check('A19 an unrecorded build is refused (exit 4) and left untouched', odd.code === 4 && sha(oddTarget) === oddBefore, 'exit=' + odd.code);
  const oddForced = runNode(APPLIER, ['--install', oddRoot, '--force']);
  check('A20 --force overrides the unrecorded-build refusal (exit 0, 6 markers)',
    oddForced.code === 0 && (fs.readFileSync(oddTarget, 'utf8').split('// COMPAT OVERLAY (P4.5):').length - 1) === 6,
    'exit=' + oddForced.code);

  // --- A21 mixed line endings ------------------------------------------------------------------
  const mixedRoot = path.join(TMP, 'mixed-eol');
  fs.mkdirSync(path.join(mixedRoot, 'node_modules', '@deepseek-ai', 'dsh-session-format-v0-to-v1', 'lib'), { recursive: true });
  const mixedTarget = path.join(mixedRoot, LIB_REL);
  const mixedLines = pristineRaw.split('\n');
  mixedLines[10] = mixedLines[10] + '\r';
  fs.writeFileSync(mixedTarget, mixedLines.join('\n'), 'utf8');
  const mixedBefore = sha(mixedTarget);
  const mixed = runNode(APPLIER, ['--install', mixedRoot]);
  check('A21 a CRLF-contaminated file is refused (exit 4) and left untouched', mixed.code === 4 && sha(mixedTarget) === mixedBefore, 'exit=' + mixed.code);

  // --- A24-A28 ledger: the record must describe the bytes that are actually on disk -------------
  const LEDGER = '.p45-compat-ledger.jsonl';
  const readLedger = (dir) => {
    const p = path.join(dir, LEDGER);
    if (!fs.existsSync(p)) return null;
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    return { path: p, lines, parsed: lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }) };
  };

  const applyLedger = readLedger(applyRoot);
  check('A24 the real apply wrote the record, and the idempotent re-run appended a confirming line',
    !!applyLedger && applyLedger.parsed.every(Boolean) && applyLedger.parsed.map((l) => l.result).join(',') === 'PATCHED,ALREADY_PATCHED',
    applyLedger ? applyLedger.parsed.map((l) => l.result).join(',') : 'no ledger at ' + path.join(applyRoot, LEDGER));
  const a24 = applyLedger && applyLedger.parsed[0];
  check('A25 the patch line records the patched state that is actually on disk',
    !!a24 && a24.result === 'PATCHED' && a24.currentSha256 === sha(applyTarget) && a24.currentSha256 === PATCHED_SHA
      && !!applyLedger && applyLedger.parsed[1].currentSha256 === PATCHED_SHA,
    a24 ? 'result=' + a24.result + ' currentSha256=' + a24.currentSha256 + ' actual=' + sha(applyTarget) : 'no line');
  check('A26 the patch line carries the rule set and the before/after hashes',
    !!a24 && a24.pristineSha256 === PRISTINE_SHA && a24.patchedSha256 === PATCHED_SHA
      && Array.isArray(a24.ruleIds) && a24.ruleIds.length === 6 && a24.insertedLines === 27
      && a24.targetRel === 'node_modules/@deepseek-ai/dsh-session-format-v0-to-v1/lib/index.js'
      && /^[0-9a-f]{64}$/.test(a24.ruleFingerprint || '') && a24.backupCreated === true && a24.dryRun === false
      && !!applyLedger && applyLedger.parsed[1].wroteNothing === true && applyLedger.parsed[1].insertedLines === 0,
    a24 ? JSON.stringify({ rules: a24.ruleIds && a24.ruleIds.length, added: a24.insertedLines, fp: (a24.ruleFingerprint || '').slice(0, 12), backup: a24.backupCreated }) : 'no line');
  check('A27 a dry run writes no ledger line', !fs.existsSync(path.join(dryRoot, LEDGER)), path.join(dryRoot, LEDGER));
  check('A28 a refused run writes no ledger line (a refusal must leave no trace)',
    !fs.existsSync(path.join(badRoot, LEDGER)) && !fs.existsSync(path.join(dupRoot, LEDGER)) && !fs.existsSync(path.join(mixedRoot, LEDGER)),
    'bad-anchor / dup-anchor / mixed-eol must have no ledger; the --force (-A20) run on the unrecorded build is a write, so it is expected to have one');

  // --- A29-A31 rollback: restore the recorded pristine bytes, and record that it happened -------
  const rb = runNode(APPLIER, ['--install', applyRoot, '--rollback']);
  check('A29 --rollback restores the recorded pristine bytes exactly',
    rb.code === 0 && sha(applyTarget) === PRISTINE_SHA, 'exit=' + rb.code + ' sha=' + sha(applyTarget));
  const afterRollback = readLedger(applyRoot);
  const a30 = afterRollback && afterRollback.parsed[afterRollback.parsed.length - 1];
  check('A30 --rollback appends a ledger line describing the restored bytes',
    !!a30 && a30.result === 'ROLLED_BACK' && a30.currentSha256 === PRISTINE_SHA && a30.currentSha256 === sha(applyTarget),
    a30 ? 'result=' + a30.result + ' currentSha256=' + a30.currentSha256 + ' actual=' + sha(applyTarget) : 'no line');
  const reapply = runNode(APPLIER, ['--install', applyRoot]);
  const afterReapply = readLedger(applyRoot);
  const a31 = afterReapply && afterReapply.parsed[afterReapply.parsed.length - 1];
  check('A31 re-applying after a rollback restores the patched bytes and the record follows them',
    reapply.code === 0 && sha(applyTarget) === PATCHED_SHA && !!a31 && a31.result === 'PATCHED' && a31.currentSha256 === PATCHED_SHA,
    'exit=' + reapply.code + ' sha=' + sha(applyTarget) + ' lastResult=' + (a31 ? a31.result : 'none'));
  check('A32 the ledger is append-only history: patch → re-confirm → rollback → patch',
    !!afterReapply && afterReapply.parsed.map((l) => l.result).join(',') === 'PATCHED,ALREADY_PATCHED,ROLLED_BACK,PATCHED'
      && afterReapply.parsed.every((l) => /^[0-9a-f]{64}$/.test(l.currentSha256 || '')),
    afterReapply ? afterReapply.parsed.map((l) => l.result).join(',') : 'no ledger');

  // --- A33-A34 marker set alone is not proof: a foreign patched file must not be laundered --------
  const foreignRoot = fresh(path.join(TMP, 'foreign'));
  const foreignTarget = path.join(foreignRoot, LIB_REL);
  fs.mkdirSync(path.dirname(foreignTarget), { recursive: true });
  fs.writeFileSync(foreignTarget, patchedRaw + '\n// hand-edited after patching (test fixture)\n', 'utf8');
  const foreignBefore = sha(foreignTarget);
  const f1 = runNode(APPLIER, ['--install', foreignRoot]);
  check('A33 a file carrying all 6 markers but different bytes is refused (exit 4), untouched and unrecorded',
    f1.code === 4 && sha(foreignTarget) === foreignBefore && /markers are present but sha256/.test(f1.out + f1.err) && !fs.existsSync(path.join(foreignRoot, LEDGER)),
    'exit=' + f1.code + ' sha=' + sha(foreignTarget).slice(0, 12) + ' ledger=' + fs.existsSync(path.join(foreignRoot, LEDGER)));
  const f2 = runNode(APPLIER, ['--install', foreignRoot, '--force']);
  const foreignLedger = readLedger(foreignRoot);
  const a34 = foreignLedger && foreignLedger.parsed[foreignLedger.parsed.length - 1];
  check('A34 --force records those foreign bytes honestly (wroteNothing, not claimed as the audited build)',
    f2.code === 0 && !!a34 && a34.result === 'ALREADY_PATCHED' && a34.currentSha256 === foreignBefore
      && a34.wroteNothing === true && a34.recordedBytesAreAuditedBuild === false,
    'exit=' + f2.code + ' ' + (a34 ? JSON.stringify({ result: a34.result, audited: a34.recordedBytesAreAuditedBuild, wrote: a34.wroteNothing }) : 'no line'));
}

// --- A22 interlock: the live installation must be refused --------------------------------
const liveTarget = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', LIB_REL);
const live = runNode(APPLIER, ['--target', liveTarget, '--check']);
check('A22 the live installation path is refused (exit 3)', live.code === 3, 'exit=' + live.code + ' :: ' + live.err.trim().split('\n')[0]);
const outside = runNode(APPLIER, ['--target', path.join(WT, '..', 'not-a-sandbox', 'index.js'), '--check']);
check('A23 a path outside every sandbox root is refused (exit 3)', outside.code === 3, 'exit=' + outside.code + ' :: ' + outside.err.trim().split('\n')[0]);

// ---------------------------------------------------------------------------------------------
// B. canary, against both real codec instantiations
// ---------------------------------------------------------------------------------------------
const patchedLib = path.join(PATCHED_INSTALL, LIB_REL);
const pristineLib = path.join(PRISTINE_INSTALL, LIB_REL);
if (!fs.existsSync(patchedLib) || !fs.existsSync(pristineLib)) {
  skip('B: canary counterfactual', 'sandbox installs not found (' + PATCHED_INSTALL + ' / ' + PRISTINE_INSTALL + ')');
} else {
  check('B0 sandbox patched install is the recorded patched build', sha(patchedLib) === PATCHED_SHA, sha(patchedLib));
  check('B1 sandbox pristine install is the recorded pristine build', sha(pristineLib) === PRISTINE_SHA, sha(pristineLib));

  const env = { DSH_P45_SESSION_COMPAT_CANARY: '1' };
  const outDir = path.join(TMP, 'canary-patched');
  const cp = runNode(CANARY, ['--install', PATCHED_INSTALL, '--expect', 'patched', '--out', outDir], env);
  const cpReport = fs.existsSync(path.join(outDir, 'canary-report.json')) ? JSON.parse(fs.readFileSync(path.join(outDir, 'canary-report.json'), 'utf8')) : null;
  check('B2 canary on the patched build exits 0', cp.code === 0, 'exit=' + cp.code);
  check('B3 canary reports ROUTED_PATCHED', cpReport && cpReport.verdict === 'ROUTED_PATCHED', cpReport ? cpReport.verdict : 'no report');
  check('B4 all controls behave as required on the patched build', cpReport && cpReport.controls.every((c) => c.passed), cpReport ? cpReport.controls.filter((c) => !c.passed).map((c) => c.name).join(' | ') : 'no report');
  check('B5 the patched build admits a v2 descriptor and rewrites it to v3 in place',
    !!cpReport && cpReport.controls[0].outcome === 'accept' && cpReport.controls[0].event.data.version === 3, cpReport ? 'version=' + cpReport.controls[0].event.data.version : 'no report');
  check('B6 the carried legacy member survives the migration exactly (no drop, no rewrite)',
    !!cpReport && cpReport.controls[1].invariant && cpReport.controls[1].invariant.carriedMemberPreserved === true, cpReport ? JSON.stringify(cpReport.controls[1].invariant) : 'no report');
  check('B7 no member is invented or dropped by the descriptor admission',
    !!cpReport && cpReport.controls[0].invariant && cpReport.controls[0].invariant.passed === true && cpReport.controls[0].invariant.addedMembers.length === 0 && cpReport.controls[0].invariant.removedMembers.length === 0,
    cpReport ? JSON.stringify(cpReport.controls[0].invariant) : 'no report');
  check('B8 the canary writes a human-readable log beside the report', fs.existsSync(path.join(outDir, 'canary.log')), path.join(outDir, 'canary.log'));

  const pristineJson = path.join(TMP, 'canary-pristine.json');
  const cpr = runNode(CANARY, ['--install', PRISTINE_INSTALL, '--expect', 'pristine', '--json', pristineJson], env);
  const cprReport = fs.existsSync(pristineJson) ? JSON.parse(fs.readFileSync(pristineJson, 'utf8')) : { controls: [] };
  check('B9 canary on the pristine build with --expect pristine exits 0 (counterfactual control)', cpr.code === 0, 'exit=' + cpr.code);
  check('B10 the pristine build refuses the v2 descriptor (the defect being fixed)', cprReport.controls && cprReport.controls[0].outcome === 'refuse' && /unsupported descriptor version 2/.test(cprReport.controls[0].detail || ''), cprReport.controls ? JSON.stringify(cprReport.controls[0]).slice(0, 180) : 'no report');
  check('B11 the pristine build refuses the carried legacy member (the second defect)', cprReport.controls && cprReport.controls[1].outcome === 'refuse', cprReport.controls ? cprReport.controls[1].detail : 'no report');
  check('B12 every fail-closed control still refuses on the pristine build', !!cprReport.controls && cprReport.controls.filter((c) => c.kind === 'negative').every((c) => c.outcome === 'refuse'), cprReport.controls ? cprReport.controls.filter((c) => c.kind === 'negative' && c.outcome !== 'refuse').map((c) => c.name).join(' | ') : 'no report');

  const mismatch = runNode(CANARY, ['--install', PRISTINE_INSTALL, '--expect', 'patched'], env);
  check('B13 the routing assertion rejects the pristine build when the patched build is required (exit 1)', mismatch.code === 1 && /ROUTING_MISMATCH/.test(mismatch.out), 'exit=' + mismatch.code);
  const mismatch2 = runNode(CANARY, ['--install', PATCHED_INSTALL, '--expect', 'pristine'], env);
  check('B14 the routing assertion rejects the patched build when the pristine build is required (exit 1)', mismatch2.code === 1 && /ROUTING_MISMATCH/.test(mismatch2.out), 'exit=' + mismatch2.code);

  const guard = runNode(CANARY, ['--install', PATCHED_INSTALL, '--expect', 'patched'], { DSH_P45_SESSION_COMPAT_CANARY: '' });
  check('B15 the canary refuses to run without its acknowledgement env guard (exit 2)', guard.code === 2, 'exit=' + guard.code);

  // --- B16-B20 ledger gate: a patched build must be backed by a record that matches its bytes ----
  check('B16 the canary confirms the patched build is backed by an agreeing ledger line',
    !!cpReport && cpReport.ledger && cpReport.ledger.verdict === 'LEDGER_AGREES' && cpReport.ledger.agrees === true,
    cpReport && cpReport.ledger ? cpReport.ledger.verdict + ' recorded=' + cpReport.ledger.recordedSha256 : 'no report');

  const relLib = 'node_modules/@deepseek-ai/dsh-session-format-v0-to-v1/lib/index.js';
  const ledgerLine = (currentSha256) => JSON.stringify({
    ledgerVersion: 1, at: new Date().toISOString(), tool: 'apply-descriptor-compat-overlay', result: 'PATCHED',
    install: PATCHED_INSTALL, targetRel: relLib, currentSha256,
  });
  const falsified = path.join(TMP, 'ledger-falsified.jsonl');
  fs.writeFileSync(falsified, ledgerLine('0'.repeat(64)) + '\n', 'utf8');
  const drift = runNode(CANARY, ['--install', PATCHED_INSTALL, '--expect', 'patched', '--ledger', falsified], env);
  check('B17 a record that disagrees with the installed bytes fails the canary loudly (exit 1)',
    drift.code === 1 && /LEDGER_MISMATCH/.test(drift.out) && /LEDGER DRIFT/.test(drift.out), 'exit=' + drift.code + ' :: ' + (drift.out.match(/VERDICT : [^\n]*/) || [''])[0]);

  const absent = runNode(CANARY, ['--install', PATCHED_INSTALL, '--expect', 'patched', '--ledger', path.join(TMP, 'no-such-ledger.jsonl')], env);
  check('B18 a patched build with no record at all fails the canary loudly (exit 1)',
    absent.code === 1 && /LEDGER_MISSING/.test(absent.out), 'exit=' + absent.code);

  const corrupt = path.join(TMP, 'ledger-corrupt.jsonl');
  fs.writeFileSync(corrupt, ledgerLine(PATCHED_SHA) + '\nthis is not json\n', 'utf8');
  const malformed = runNode(CANARY, ['--install', PATCHED_INSTALL, '--expect', 'patched', '--ledger', corrupt], env);
  check('B19 a damaged record fails the canary loudly instead of being ignored (exit 1)',
    malformed.code === 1 && /LEDGER_MALFORMED/.test(malformed.out), 'exit=' + malformed.code);

  const pristineNoLedger = runNode(CANARY, ['--install', PRISTINE_INSTALL, '--expect', 'pristine', '--ledger', path.join(TMP, 'no-such-ledger-2.jsonl')], env);
  check('B20 a pristine build needs no record (the requirement is on patched builds only)',
    pristineNoLedger.code === 0 && /LEDGER_ABSENT_NOT_REQUIRED|LEDGER_NO_ENTRY_NOT_REQUIRED/.test(pristineNoLedger.out), 'exit=' + pristineNoLedger.code);
}

// ---------------------------------------------------------------------------------------------
const jsonPath = (() => { const i = process.argv.indexOf('--json'); return i >= 0 ? process.argv[i + 1] : null; })();
const summary = {
  suite: 'session-compat',
  ranAt: new Date().toISOString(),
  total: results.length,
  passed: results.filter((r) => r.passed === true).length,
  failed: failures,
  skipped: results.filter((r) => r.skipped).length,
  results,
};
if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 1), 'utf8');
console.log('\n[suite] total=' + summary.total + ' passed=' + summary.passed + ' failed=' + summary.failed + ' skipped=' + summary.skipped);
process.exit(failures ? 1 : 0);
