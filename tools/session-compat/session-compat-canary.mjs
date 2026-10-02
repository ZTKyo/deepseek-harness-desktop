#!/usr/bin/env node
// P4.5 — canary for the session-format compatibility overlay (B8-C1/C2 adapter, verdict NEEDS_OVERLAY).
// The dispatch label for this work was "K4"; the program's K1–K4 risk list reserves K4 for the
// HMR/dependency-pin leg, so this file is labelled by substance and the old label is kept for traceability.
//
// PURPOSE
//   The overlay patches a released codec by insertion. This canary answers one question, against a
//   REAL installed build, at the module's PUBLIC API boundary (no private-function peeking, no mocks):
//     "is this build the patched one, and does it still refuse everything it must refuse?"
//   It is also the routing/allow-list check: it hashes the file it actually loaded and reports which
//   build it is talking to, so a green canary can never be the result of running against the wrong
//   tree (or against the pristine build that the overlay was supposed to fix).
//
// LEDGER ASSERTION (the drift guard, added 2026-10-02 after the comment-text drift incident)
//   The applier keeps an append-only ledger beside each install (.p45-compat-ledger.jsonl) recording
//   the sha256 it left on disk. A patched build must be backed by that record:
//       sha256(installed codec) === last ledger line's currentSha256 for this file
//   A patched build with no ledger, a malformed ledger, or a recorded hash that no longer matches the
//   bytes on disk fails LOUDLY (exit 1, verdict LEDGER_*). This is what catches the case where the
//   tool's inserted comment text drifts from the audited artifact: the port then produces a different
//   sha256 than the recorded c9bb15f3…, and the mismatch is reported instead of passing silently.
//   A pristine build does not require a ledger (it was never patched), but if a ledger exists and
//   contradicts the bytes, that is still a failure.
//
// SAFETY
//   * refuses to run without DSH_P45_SESSION_COMPAT_CANARY=1 (same discipline as the other P4.5 canaries),
//   * the target install must pass the sandbox interlock (never the live installation, never ~/.dsh),
//   * read-only with respect to the install; the only writes are --json / --out evidence under the
//     sandbox root, and NOTHING is written unless asked,
//   * every fixture is synthetic and in-memory; no session artifact is read or modified.
//
// USAGE
//   DSH_P45_SESSION_COMPAT_CANARY=1 node tools/session-compat/session-compat-canary.mjs \
//       --install <dir> [--expect auto|patched|pristine] [--ledger <file>] [--json <file>] [--out <dir>]
//   --ledger <file>  override the ledger path (default <install>/.p45-compat-ledger.jsonl); use it for
//                    an install tree that was copied from where the record was written
//
// EXIT
//   0 = the build matches --expect, every control behaved as required, and the ledger agrees
//   1 = a control failed, the build does not match --expect, or the ledger contradicts the bytes
//   2 = usage · 3 = interlock refusal · 4 = the codec could not be loaded from that install
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { interlockCheck, KNOWN, PKG, LIB_REL, ledgerPathFor, readLedger } from './apply-descriptor-compat-overlay.mjs';

const EXIT = { OK: 0, CONTROL_FAILED: 1, USAGE: 2, INTERLOCK: 3, NO_CODEC: 4 };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- synthetic fixtures (shapes taken from RELEASED_V0_EVENT_DISPOSITIONS of 0.2.0-rc.2) --------
// subagent/descriptor : required mode, version, provider (optional: label, agentProvider, agentModel,
//                       agentReasoningEffort, persona, toolFilter) — `mode` must be "continuable".
// user/message        : required role, id, content (array), source — and NO optional members at all,
//                       which is exactly why the legacy carried `message` member was refused.
const descriptor = (version, extra = {}) => ({ type: 'subagent/descriptor', seq: 6, data: { mode: 'continuable', version, provider: 'p1', label: 'worker-1', ...extra } });
const userMessage = (extra = {}) => ({ type: 'user/message', seq: 3, data: { role: 'user', id: 'm1', content: [{ type: 'text', text: 'hello' }], source: { kind: 'human' }, ...extra } });
const CARRIED = { role: 'user', id: 'm1', content: [{ type: 'text', text: 'hello' }], source: { kind: 'human' } };

function loadCodec(install) {
  const entry = path.join(path.resolve(install), LIB_REL);
  if (!fs.existsSync(entry)) return { error: 'codec entry not found: ' + entry };
  return { entry, bytes: fs.readFileSync(entry) };
}

/** Run one control. `spec` carries the expectation for EACH build so the same fixture set is a true
 *  counterfactual: on the pristine build the positive fixtures must be refused, on the patched build
 *  the very same fixtures must be accepted, and the negative fixtures must be refused by both. */
function control(mod, name, kind, event, version, spec, after) {
  const before = clone(event);
  let outcome, detail = '';
  try {
    mod.assertReleasedEventPayload(event, version);
    outcome = 'accept';
  } catch (e) {
    outcome = 'refuse';
    detail = String(e && e.message ? e.message : e);
  }
  const expect = spec.expectOn[spec.buildState] || spec.expectOn.patched;
  const passed = outcome === expect;
  const result = { name, kind, expect, outcome, passed, detail, event: clone(event) };
  if (passed && typeof after === 'function') {
    const inv = after(before, clone(event), outcome);
    result.invariant = inv;
    if (inv && inv.passed === false) result.passed = false;
  }
  return result;
}

/** Members must never be dropped or invented: the only permitted change is data.version 2 -> 3. */
function memberInvariant(before, after) {
  const bk = Object.keys(before.data).sort();
  const ak = Object.keys(after.data).sort();
  const added = ak.filter((k) => !bk.includes(k));
  const removed = bk.filter((k) => !ak.includes(k));
  const changed = bk.filter((k) => k !== 'version' && JSON.stringify(before.data[k]) !== JSON.stringify(after.data[k]));
  const versionChanged = before.data.version !== after.data.version;
  const passed = added.length === 0 && removed.length === 0 && changed.length === 0;
  return { passed, addedMembers: added, removedMembers: removed, changedMembers: changed, versionChanged, versionBefore: before.data.version, versionAfter: after.data.version };
}

export function runCanary(argv) {
  const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const install = arg('--install');
  const expect = arg('--expect', 'auto');
  const jsonPath = arg('--json');
  const outDir = arg('--out');
  const ledgerArg = arg('--ledger');

  if (process.env.DSH_P45_SESSION_COMPAT_CANARY !== '1') {
    console.error('[canary] REFUSING: set DSH_P45_SESSION_COMPAT_CANARY=1 to acknowledge that this canary is being run deliberately.');
    return EXIT.USAGE;
  }
  if (!install) { console.error('[canary] usage: --install <dir> [--expect auto|patched|pristine] [--ledger <file>] [--json <file>] [--out <dir>]'); return EXIT.USAGE; }
  if (!['auto', 'patched', 'pristine'].includes(expect)) { console.error('[canary] --expect must be auto|patched|pristine'); return EXIT.USAGE; }

  const lock = interlockCheck(path.resolve(install));
  const report = {
    tool: 'session-compat-canary',
    version: 1,
    ranAt: new Date().toISOString(),
    install: path.resolve(install),
    expect,
    interlock: lock.ok ? { ok: true, root: lock.root } : { ok: false, why: lock.why },
    known: KNOWN,
    codec: null,
    build: null,
    ledger: null,
    controls: [],
    verdict: null,
    reasons: [],
  };
  const finish = (code) => {
    if (jsonPath) { try { fs.writeFileSync(jsonPath, JSON.stringify(report, null, 1), 'utf8'); } catch (e) { console.error('[canary] cannot write --json: ' + e.message); } }
    if (outDir) {
      try {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'canary-report.json'), JSON.stringify(report, null, 1), 'utf8');
        const lines = report.controls.map((c) => `${c.passed ? 'PASS' : 'FAIL'} expect=${c.expect} got=${c.outcome} ${c.name}${c.detail ? ' :: ' + c.detail : ''}`);
        fs.writeFileSync(path.join(outDir, 'canary.log'), [
          'session-compat-canary ' + report.ranAt,
          'install : ' + report.install,
          'codec   : ' + (report.codec && report.codec.entry),
          'sha256  : ' + (report.codec && report.codec.sha256),
          'build   : ' + report.build,
          'ledger  : ' + (report.ledger ? report.ledger.verdict + '  path=' + report.ledger.path + '  recorded=' + (report.ledger.recordedSha256 || '(none)') + '  actual=' + report.ledger.actualSha256 + '  agrees=' + report.ledger.agrees : '(not reached)'),
          'verdict : ' + report.verdict,
          ...lines,
        ].join('\n') + '\n', 'utf8');
      } catch (e) { console.error('[canary] cannot write --out: ' + e.message); }
    }
    return code;
  };

  if (!lock.ok) {
    report.verdict = 'INTERLOCK_REFUSED';
    report.reasons.push(lock.why);
    console.error('[canary] REFUSED: ' + lock.why);
    return finish(EXIT.INTERLOCK);
  }

  const loaded = loadCodec(install);
  if (loaded.error) {
    report.verdict = 'NO_CODEC';
    report.reasons.push(loaded.error);
    console.error('[canary] ' + loaded.error);
    return finish(EXIT.NO_CODEC);
  }
  report.codec = { entry: loaded.entry, sha256: sha256(loaded.bytes), bytes: loaded.bytes.length };

  // ---- ledger lookup: the last line the applier wrote for THIS file ---------------------------
  // Reading only; the canary never writes to the install or to the ledger.
  const ledgerFile = ledgerPathFor({ install: path.resolve(install), target: loaded.entry }, ledgerArg);
  const led = readLedger(ledgerFile);
  const relTarget = path.relative(path.resolve(install), loaded.entry).replace(/\\/g, '/').toLowerCase();
  const ledgerLines = led.entries.filter((e) => String(e.targetRel || '').toLowerCase() === relTarget);
  const lastLine = ledgerLines.length ? ledgerLines[ledgerLines.length - 1] : null;
  report.ledger = {
    path: ledgerFile,
    present: led.present,
    parseError: led.error,
    entries: led.entries.length,
    matchingEntries: ledgerLines.length,
    lastEntry: lastLine,
    recordedSha256: lastLine ? (lastLine.currentSha256 || null) : null,
    actualSha256: report.codec.sha256,
    agrees: lastLine ? lastLine.currentSha256 === report.codec.sha256 : null,
    recordedInstall: lastLine ? lastLine.install : null,
    installPathChanged: !!(lastLine && lastLine.install && path.resolve(lastLine.install).toLowerCase() !== path.resolve(install).toLowerCase()),
    verdict: null,
  };

  return import(pathToFileURL(loaded.entry).href).then((mod) => {
    const needed = ['assertReleasedEventPayload', 'assertReleasedPayloadSemantics', 'RELEASED_V0_EVENT_DISPOSITIONS'];
    const missing = needed.filter((k) => typeof mod[k] === 'undefined');
    if (missing.length) {
      report.verdict = 'NO_CODEC';
      report.reasons.push('the loaded module does not export: ' + missing.join(', ') + ' (not the codec this overlay was audited against)');
      console.error('[canary] ' + report.reasons[report.reasons.length - 1]);
      return finish(EXIT.NO_CODEC);
    }
    const umDisposition = mod.RELEASED_V0_EVENT_DISPOSITIONS['user/message'];
    const descDisposition = mod.RELEASED_V0_EVENT_DISPOSITIONS['subagent/descriptor'];
    report.dispositions = { userMessage: umDisposition, subagentDescriptor: descDisposition };

    report.build = report.codec.sha256 === KNOWN.patchedSha256 ? 'ROUTED_PATCHED'
      : report.codec.sha256 === KNOWN.pristineSha256 ? 'ROUTED_PRISTINE'
      : 'UNKNOWN_BUILD';

    const state = report.build === 'ROUTED_PATCHED' ? 'patched' : report.build === 'ROUTED_PRISTINE' ? 'pristine' : 'unknown';
    const POS = { buildState: state, expectOn: { patched: 'accept', pristine: 'refuse', unknown: 'accept' } };
    const NEG = { buildState: state, expectOn: { patched: 'refuse', pristine: 'refuse', unknown: 'refuse' } };
    const BOTH = { buildState: state, expectOn: { patched: 'accept', pristine: 'accept', unknown: 'accept' } };

    const controls = [];
    // --- positive controls: the overlay's whole purpose (accepted ONLY by the patched build) -----
    controls.push(control(mod, 'descriptor v2 is admitted (defect 1)', 'positive', descriptor(2), 0, POS, (b, a, outcome) => {
      if (outcome !== 'accept') return { passed: true, note: 'not admitted on this build; mutation invariant not applicable' };
      const inv = memberInvariant(b, a);
      inv.passed = inv.passed && a.data.version === 3 && inv.versionChanged === true;
      return inv;
    }));
    controls.push(control(mod, 'user/message keeps its carried legacy message member (defect 2)', 'positive', userMessage({ message: clone(CARRIED) }), 0, POS, (b, a, outcome) => {
      if (outcome !== 'accept') return { passed: true, note: 'not admitted on this build; mutation invariant not applicable' };
      const inv = memberInvariant(b, a);
      inv.carriedMemberPreserved = JSON.stringify(a.data.message) === JSON.stringify(CARRIED);
      inv.passed = inv.passed && inv.carriedMemberPreserved === true;
      return inv;
    }));
    controls.push(control(mod, 'payload-semantics still accepts the carried member (defect 3)', 'positive', userMessage({ message: clone(CARRIED) }), 0, POS));

    // --- negative controls: fail-closed must survive the overlay (refused by BOTH builds) --------
    controls.push(control(mod, 'descriptor v1 is still refused', 'negative', descriptor(1), 0, NEG));
    controls.push(control(mod, 'descriptor v4 is still refused', 'negative', descriptor(4), 0, NEG));
    controls.push(control(mod, 'descriptor v2 with an unexpected member is still refused', 'negative', descriptor(2, { bogusMember: 1 }), 0, NEG));
    controls.push(control(mod, 'user/message with a different unexpected member is still refused', 'negative', userMessage({ text: 'hello' }), 0, NEG));
    controls.push(control(mod, 'user/message with a non-record message member is still refused', 'negative', userMessage({ message: 'oops' }), 0, NEG));
    controls.push(control(mod, 'the v0-only admission is not widened to v1', 'negative', userMessage({ message: clone(CARRIED) }), 1, NEG));
    controls.push(control(mod, 'a clean user/message is still accepted (sanity)', 'both', userMessage(), 0, BOTH));

    // Apply the version rule to the payload-semantics entry point too (defect 3's sibling rule).
    const sem = userMessage({ message: clone(CARRIED) });
    const semExpect = POS.expectOn[POS.buildState];
    try {
      mod.assertReleasedPayloadSemantics(sem, 0);
      controls.push({ name: 'assertReleasedPayloadSemantics(user/message + carried member)', kind: 'positive', expect: semExpect, outcome: 'accept', passed: semExpect === 'accept', detail: '' });
    } catch (e) {
      controls.push({ name: 'assertReleasedPayloadSemantics(user/message + carried member)', kind: 'positive', expect: semExpect, outcome: 'refuse', passed: semExpect === 'refuse', detail: String(e && e.message ? e.message : e) });
    }

    report.controls = controls;
    const positives = controls.filter((c) => c.kind === 'positive');
    const negatives = controls.filter((c) => c.kind === 'negative');

    // Routing verdict against --expect.
    let routingOk = true;
    if (expect === 'patched' && report.build !== 'ROUTED_PATCHED') { routingOk = false; report.reasons.push('expected the patched codec (' + KNOWN.patchedSha256 + ') but loaded ' + report.codec.sha256 + ' (' + report.build + ')'); }
    if (expect === 'pristine' && report.build !== 'ROUTED_PRISTINE') { routingOk = false; report.reasons.push('expected the pristine codec (' + KNOWN.pristineSha256 + ') but loaded ' + report.codec.sha256 + ' (' + report.build + ')'); }
    if (expect === 'auto' && report.build === 'UNKNOWN_BUILD') { routingOk = false; report.reasons.push('the loaded codec matches neither the recorded pristine nor the recorded patched sha256'); }

    const positiveOk = positives.every((c) => c.passed);
    const negativeOk = negatives.every((c) => c.passed);
    const failed = controls.filter((c) => !c.passed);

    // ---- ledger gate ------------------------------------------------------------------------
    // A patched build MUST be backed by a ledger line that still matches the bytes on disk.
    // This is the drift guard: if the applier's inserted text ever diverges from the audited
    // artifact, the tool leaves a different sha256 on disk than the one recorded here and the
    // canary fails instead of reporting a cosmetically green build.
    const requireLedger = report.build === 'ROUTED_PATCHED';
    let ledgerOk = true;
    if (!report.ledger.present) {
      if (requireLedger) {
        ledgerOk = false;
        report.ledger.verdict = 'LEDGER_MISSING';
        report.reasons.push('no ledger at ' + report.ledger.path + ' — a patched install must carry the record of how it got that way (re-run the applier against this install to write one)');
      } else report.ledger.verdict = 'LEDGER_ABSENT_NOT_REQUIRED';
    } else if (report.ledger.parseError) {
      ledgerOk = false;
      report.ledger.verdict = 'LEDGER_MALFORMED';
      report.reasons.push('the ledger at ' + report.ledger.path + ' cannot be trusted: ' + report.ledger.parseError);
    } else if (!report.ledger.lastEntry) {
      if (requireLedger) {
        ledgerOk = false;
        report.ledger.verdict = 'LEDGER_NO_ENTRY_FOR_FILE';
        report.reasons.push('the ledger at ' + report.ledger.path + ' has no line for ' + relTarget + ' — the record does not describe this build');
      } else report.ledger.verdict = 'LEDGER_NO_ENTRY_NOT_REQUIRED';
    } else if (!report.ledger.agrees) {
      ledgerOk = false;
      report.ledger.verdict = 'LEDGER_MISMATCH';
      report.reasons.push('LEDGER DRIFT: the record says ' + (report.ledger.recordedSha256 || '(none)') + ' for ' + relTarget + ' but the installed codec hashes to ' + report.codec.sha256 + ' — the install no longer matches its own record');
    } else {
      report.ledger.verdict = 'LEDGER_AGREES';
      if (report.ledger.installPathChanged) report.ledger.warning = 'the recorded install path (' + report.ledger.recordedInstall + ') differs from ' + report.install + ' — the tree was copied after the record was written; the sha256 assertion still holds';
    }

    if (!ledgerOk) report.verdict = report.ledger.verdict;
    else if (!routingOk) report.verdict = 'ROUTING_MISMATCH';
    else if (!negativeOk) report.verdict = 'FAIL_CLOSED_BROKEN';
    else if (!positiveOk) report.verdict = POS.buildState === 'pristine' ? 'UNEXPECTED_ACCEPT_ON_PRISTINE' : 'OVERLAY_NOT_EFFECTIVE';
    else report.verdict = report.build;

    console.log('[canary] install : ' + report.install);
    console.log('[canary] codec   : ' + report.codec.entry);
    console.log('[canary] sha256  : ' + report.codec.sha256 + '  -> ' + report.build);
    console.log('[canary] ledger  : ' + report.ledger.verdict + '  (' + report.ledger.path + ')'
      + (report.ledger.present ? '  entries=' + report.ledger.entries + ' forThisFile=' + report.ledger.matchingEntries + ' recorded=' + (report.ledger.recordedSha256 || '(none)') : ''));
    for (const c of controls) console.log('[canary]   ' + (c.passed ? 'PASS' : 'FAIL') + '  [' + c.kind + '] expect=' + c.expect + ' got=' + c.outcome + '  ' + c.name + (c.detail ? '  :: ' + c.detail : ''));
    console.log('[canary] VERDICT : ' + report.verdict + (report.reasons.length ? '  (' + report.reasons.join('; ') + ')' : ''));

    const desired = expect === 'patched' ? 'ROUTED_PATCHED' : expect === 'pristine' ? 'ROUTED_PRISTINE' : report.build;
    if (failed.length) { console.error('[canary] ' + failed.length + ' control(s) failed: ' + failed.map((f) => f.name).join(' | ')); }
    if (!ledgerOk) { console.error('[canary] ledger assertion failed: ' + report.ledger.verdict + ' — see the reason above'); }
    const ok = routingOk && ledgerOk && failed.length === 0 && report.verdict === desired;
    return finish(ok ? EXIT.OK : EXIT.CONTROL_FAILED);
  }).catch((e) => {
    report.verdict = 'NO_CODEC';
    report.reasons.push('import failed: ' + (e && e.message ? e.message : String(e)));
    console.error('[canary] ' + report.reasons[report.reasons.length - 1]);
    return finish(EXIT.NO_CODEC);
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) { const r = runCanary(process.argv.slice(2)); if (r && typeof r.then === 'function') r.then((c) => process.exit(c)); else process.exit(r); }
