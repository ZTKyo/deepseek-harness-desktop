#!/usr/bin/env node
// P4.5 — reproducible applier for the dsh-session-format-v0-to-v1 compatibility overlay.
// Scope: the B8-C1/C2 historical-session adapter (verdict NEEDS_OVERLAY). The dispatch label for this
// work was "K4"; the program's K1–K4 risk list reserves K4 for the HMR/dependency-pin leg, so this
// file is labelled by substance (B8-C1/C2) and the old label is kept here only for traceability.
//
// WHAT THIS IS
//   The overlay is a small, audited set of insertions into the released v0->v1 session codec
//   (node_modules/@deepseek-ai/dsh-session-format-v0-to-v1/lib/index.js). It exists because an
//   installed 0.2.0-rc.2 candidate refuses three things that live production sessions contain:
//     1. a v2 `subagent/descriptor` ("uses unsupported descriptor version 2") — v2->v3 is additive,
//     2. a `message` member carried on `user/message` (an older build stamped it; production's own
//        read path returns event.data with no member allow-list, so it reads those sessions verbatim),
//     3. the payload-semantics check tripping on that same carried member.
//   This tool is the ONLY sanctioned way to apply it: it is idempotent, refuses any target outside an
//   explicitly sandboxed root, never touches node_modules of the live service, and verifies its own
//   work byte-for-byte before reporting success.
//
// WHY IT IS SAFE BY CONSTRUCTION
//   * every rule is an INSERTION keyed by an exact anchor line; a missing or ambiguous anchor makes
//     the whole run fail (exit 4) and nothing is written,
//   * all rules are validated in memory first, then written once, then re-read and re-hashed,
//   * a pristine backup (sha256 recorded) is written before any mutation; a failed post-write check
//     restores it (exit 5),
//   * the live service install and ~/.dsh are hard-denied even if someone points --install at them,
//   * every state-changing run appends one line to an APPEND-ONLY ledger beside the install
//     (`.p45-compat-ledger.jsonl`), recording {time, install, target, rule ids, pristine sha256,
//     patched sha256, the sha256 the run left on disk, result}; existing lines are never rewritten
//     or reordered, and the canary asserts the installed bytes still match the last recorded sha256.
//     This is the guard against the 2026-10-02 defect where the tool's inserted comment text drifted
//     from the audited artifact (pristine + tool produced 97d36fcf…, not the recorded c9bb15f3…).
//
// USAGE
//   node tools/session-compat/apply-descriptor-compat-overlay.mjs --install <dir> [--dry-run] [--json <file>]
//   node tools/session-compat/apply-descriptor-compat-overlay.mjs --target <path/to/lib/index.js> [--check]
//   node tools/session-compat/apply-descriptor-compat-overlay.mjs --install <dir> --rollback
//   --install <dir>   a sandboxed install root (…/node_modules/…/lib/index.js is resolved under it)
//   --target  <file>  the exact file to patch (still subject to the sandbox interlock)
//   --dry-run         validate + report the diff, write nothing (also writes no ledger line)
//   --check           verify only: exit 0 when all 6 rules are present and intact, 6 when not
//   --rollback        restore the pristine backup over the target, byte-for-byte, and verify it
//   --ledger <file>   override the ledger path (default: <install>/.p45-compat-ledger.jsonl)
//   --json <file>     write the machine-readable report (same content as stdout summary)
//   --force           allow patching (or rolling back to a backup of) a file whose sha256 is neither
//                     the recorded pristine nor the recorded patched value (still sandbox-interlocked)
//
// EXIT CODES
//   0 OK (patched | already patched | dry-run validated | --check intact | rolled back)
//   2 usage / bad arguments
//   3 interlock refusal (target or ledger outside the sandbox, or the live install)
//   4 anchor problem (missing/ambiguous) or non-uniform line endings — nothing written
//   5 post-write verification failed and the original was restored
//   6 --check: overlay not present / not intact
//   7 --rollback: no usable pristine backup (missing, or not the recorded pristine bytes)
//   8 the patch was applied but the ledger line could not be written (install is UNRECORDED)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const EXIT = { OK: 0, USAGE: 2, INTERLOCK: 3, ANCHOR: 4, ROLLBACK: 5, NOT_PATCHED: 6, NO_BACKUP: 7, LEDGER: 8 };

export const PKG = '@deepseek-ai/dsh-session-format-v0-to-v1';
export const LIB_REL = path.join('node_modules', ...PKG.split('/'), 'lib', 'index.js');

// Recorded, evidence-grade hashes for the two states this tool is expected to see.
export const KNOWN = {
  pristineSha256: '1b3bff6aaf28ca62a864cf97b9aa9aa45ab76de5e459f7881ba4bc8de73490b1',
  patchedSha256: 'c9bb15f34806a1c7dbd0f08bee431db1cef0e312acec08dddf4bdc4f8b9474f9',
};

export const MARKER = '// COMPAT OVERLAY (P4.5):';

// The overlay rule set. Anchors and inserted text are byte-exact (EOL is taken from the target file).
// `\u2014` (em dash) and `\u2026` (ellipsis) are written as escapes so this file stays pure ASCII
// while producing the exact bytes of the recorded overlay.
export const RULES = [
  {
    id: 'subagent-descriptor.v2-admitted-as-v3',
    why: 'a v2 subagent/descriptor is losslessly admissible as v3 (v3 only adds the optional agentReasoningEffort)',
    anchor: '\tif (event.type === "subagent/descriptor" && data["version"] !== 3) {',
    where: 'before',
    expectAnchorCount: 1,
    insert: [
      '\t// COMPAT OVERLAY (P4.5): accept a v2 subagent descriptor as v3. Lossless \u2014 v3 only adds the',
      '\t// optional `agentReasoningEffort` field, which the v0 disposition already lists as optional.',
      '\t// Versions other than 2 keep hitting the upstream branch below (fail closed, never widened).',
      '\tif (event.type === "subagent/descriptor" && data["version"] === 2) data["version"] = 3;',
    ],
  },
  {
    id: 'user-message.carry-legacy-member',
    why: 'withhold the carried legacy `message` member for the strict key check only (v0 path, JSON object only)',
    anchor: '\tconst versionOptional = version === 1 && event.type === "session-log-deepseek/delivery-accepted" ? [...disposition.optional, "sessionFormatVersion"] : disposition.optional;',
    where: 'before',
    expectAnchorCount: 1,
    insert: [
      '\t// COMPAT OVERLAY (P4.5): an older build also stamped the `message` member onto user/message (the',
      '\t// member name this same v0 table REQUIRES for tool/result). The user/message disposition lists no',
      '\t// optional members, so the candidate refused a session production reads verbatim (its read path',
      '\t// returns event.data with no member allow-list). Withhold that one member only for the strict key',
      '\t// check below, then re-attach it (rule user-message.carry-legacy-member.restore) so the migrated',
      '\t// event carries it exactly as production does: no drop, no invented member. v0 path only, JSON',
      '\t// object only \u2014 every other unexpected member still fails closed.',
      '\tconst legacyCarriedMessage = version === 0 && event.type === "user/message" && releasedIsRecord(data["message"]) ? data["message"] : void 0;',
      '\tif (legacyCarriedMessage !== void 0) delete data["message"];',
    ],
  },
  {
    id: 'user-message.carry-legacy-member.restore',
    why: 're-attach the admitted legacy member so the migrated event carries it verbatim',
    anchor: '\tassertReleasedPayloadSemantics(event, version);',
    where: 'after',
    expectAnchorCount: 1,
    insert: [
      '\t// COMPAT OVERLAY (P4.5): re-attach the admitted legacy member so the emitted (migrated) event',
      '\t// carries it verbatim; the stored v0 artifact itself was never modified.',
      '\tif (legacyCarriedMessage !== void 0) data["message"] = legacyCarriedMessage;',
    ],
  },
  {
    id: 'user-message.payload-semantics.withhold',
    why: 'the payload object doubles as the message for user/message, so the carried member also trips the message-shape check',
    anchor: '\t\t\tmessageValue(data, label, version, "user");',
    where: 'before',
    expectAnchorCount: 1,
    insert: [
      '\t\t\t// COMPAT OVERLAY (P4.5): for user/message the payload object doubles as the message, so the',
      '\t\t\t// legacy `message` member also trips the message-shape check below. Withhold that one member',
      '\t\t\t// for the duration of the check and re-attach it immediately after (rule \u2026semantics-restore).',
      '\t\t\tconst legacyPayloadMessage = event.type === "user/message" && releasedIsRecord(data["message"]) ? data["message"] : void 0;',
      '\t\t\tif (legacyPayloadMessage !== void 0) delete data["message"];',
    ],
  },
  {
    id: 'user-message.payload-semantics.restore',
    why: 're-attach the member right after validation; the event keeps its documented member set plus the legacy one',
    anchor: '\t\t\tmessageValue(data, label, version, "user");',
    where: 'after',
    expectAnchorCount: 1,
    insert: [
      '\t\t\t// COMPAT OVERLAY (P4.5): re-attach the admitted legacy member; validation only, the event keeps',
      '\t\t\t// its documented member set plus the one legacy member production also reads.',
      '\t\t\tif (legacyPayloadMessage !== void 0) data["message"] = legacyPayloadMessage;',
    ],
  },
  {
    id: 'subagent-descriptor.in-memory-v3',
    why: 'the emitted (in-memory) event must also carry v3, or downstream v3-only readers reject it',
    anchor: '\tif (message.type !== "assistant/chunk") assertReleasedEventPayload(message, 0);',
    where: 'before',
    expectAnchorCount: 1,
    insert: [
      '\t// COMPAT OVERLAY (P4.5): the emitted event must also carry v3, otherwise the in-memory value',
      '\t// stays v2 and downstream v3-only readers would reject it. Stored session bytes are untouched.',
      '\tif (message.type === "subagent/descriptor" && message.data && message.data.version === 2) message.data.version = 3;',
    ],
  },
];

export const INSERTED_LINES = RULES.reduce((n, r) => n + r.insert.length, 0);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** One hash over the whole rule inventory (ids, anchors, every inserted line, in order).
 *  Any edit to the aligned comment text moves it, so the test suite can freeze the audited value
 *  and fail loudly if the port's inserted text ever drifts again (the 97d36fcf… defect). */
export const RULE_FINGERPRINT = sha256(Buffer.from(JSON.stringify(RULES.map((r) => [r.id, r.where, r.expectAnchorCount, r.anchor, r.insert])), 'utf8'));

// ---------------------------------------------------------------------------------------------
// Append-only ledger
// ---------------------------------------------------------------------------------------------
// Every run that is allowed to touch the tree appends exactly one line here and never rewrites an
// existing one. The ledger answers one question at audit time: "do the bytes now on disk still match
// what the tool recorded leaving there?". The canary asserts it (see session-compat-canary.mjs).
export const LEDGER_NAME = '.p45-compat-ledger.jsonl';
export const LEDGER_VERSION = 1;

/** Ledger for an install lives at the install ROOT (outside node_modules), so re-installing
 *  node_modules cannot silently drop the record of how the codec got there. */
export function ledgerPathFor({ install, target }, explicit = null) {
  if (explicit) return path.resolve(explicit);
  const root = install ? path.resolve(install) : path.dirname(path.resolve(target));
  return path.join(root, LEDGER_NAME);
}

/** Read a JSONL ledger. A malformed line is reported, never skipped silently. */
export function readLedger(file) {
  if (!fs.existsSync(file)) return { path: file, present: false, entries: [], error: null, bytes: 0 };
  const text = fs.readFileSync(file, 'utf8');
  const entries = [];
  let error = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { entries.push(JSON.parse(lines[i])); }
    catch (e) { error = 'line ' + (i + 1) + ' is not valid JSON (' + e.message + ')'; break; }
  }
  return { path: file, present: true, entries, error, bytes: Buffer.byteLength(text, 'utf8') };
}

/** Append one line. Append-only by construction: existing bytes are never touched. */
export function appendLedger(file, entry) { fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8'); return entry; }

/** The ledger line for one run. `currentSha256` is the hash the run observed on disk afterwards
 *  (verified by re-reading the file) — that is the field the canary compares against. */
export function ledgerLine({ install, target, result, before, after, forced, dryRun, detail, extra = {} }) {
  const targetRel = install ? path.relative(path.resolve(install), path.resolve(target)).replace(/\\/g, '/') : path.basename(target);
  return {
    ledgerVersion: LEDGER_VERSION,
    at: new Date().toISOString(),
    tool: 'apply-descriptor-compat-overlay',
    backend: 'repo-port',
    result,
    install: install ? path.resolve(install) : null,
    target: path.resolve(target),
    targetRel,
    ruleIds: RULES.map((r) => r.id),
    ruleCount: RULES.length,
    insertedLines: INSERTED_LINES,
    ruleFingerprint: RULE_FINGERPRINT,
    pristineSha256: KNOWN.pristineSha256,
    patchedSha256: KNOWN.patchedSha256,
    bytesBefore: before ? before.bytes : null,
    bytesAfter: after ? after.bytes : null,
    sha256Before: before ? before.sha256 : null,
    currentSha256: after ? after.sha256 : (before ? before.sha256 : null),
    dryRun: !!dryRun,
    forced: !!forced,
    ruleSetSha256: sha256(Buffer.from(buildPatched.toString(), 'utf8')),
    ...(detail ? { detail } : {}),
    ...extra,
  };
}

/** Sandbox interlock: this tool may only ever touch a disposable sandbox copy of the codec. */
export function interlockCheck(target) {
  const abs = path.resolve(target);
  const low = abs.toLowerCase().replace(/\\/g, '/');
  const deny = [
    '/appdata/roaming/npm/node_modules/@deepseek-ai/dsh/',
    '/.dsh/sessions/',
    '/.dsh/storages/',
  ];
  for (const d of deny) if (low.includes(d)) return { ok: false, why: 'target is part of the live installation or user data (' + d + ')' };
  const allow = ['_p4_5-sandbox', '_p4_5-wt', '_p4_5-install'];
  const hit = allow.find((a) => low.includes(a));
  if (!hit) return { ok: false, why: 'target is outside every sandbox root (expected one of: ' + allow.join(', ') + ')' };
  return { ok: true, root: hit, abs };
}

/** Split preserving EOL style; refuses mixed/unusual endings rather than guessing. */
export function splitLines(raw) {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const uniform = lines.join(eol) === raw;
  return { eol, lines, uniform, hadFinalNewline: raw.endsWith('\n') };
}

/** Validate + build the patched content in memory. Never writes. */
export function buildPatched(raw) {
  if (raw.includes(MARKER)) {
    const ids = RULES.filter((r) => raw.includes(r.id.split('.').slice(0, 2).join('.'))).length;
    return { alreadyPatched: true, sha256: sha256(Buffer.from(raw, 'utf8')), rules: RULES.map((r) => ({ id: r.id, present: raw.includes(r.insert[r.insert.length - 1].trim()) })), ids };
  }
  const { eol, lines, uniform } = splitLines(raw);
  if (!uniform) return { error: 'target has mixed line endings; refusing to guess an EOL style', reason: 'MIXED_EOL' };
  const anchors = [];
  for (const rule of RULES) {
    const idx = [];
    for (let i = 0; i < lines.length; i++) if (lines[i] === rule.anchor) idx.push(i);
    if (idx.length !== rule.expectAnchorCount) {
      return { error: `rule ${rule.id}: anchor line matched ${idx.length} times, expected ${rule.expectAnchorCount}`, reason: 'ANCHOR_COUNT', rule: rule.id };
    }
    anchors.push({ rule, at: idx[0] });
  }
  // Apply bottom-up so earlier insertions never shift later anchor indices.
  const ordered = [...anchors].sort((a, b) => (b.at - a.at) || (a.rule.where === 'after' ? -1 : 1));
  const inserted = [];
  let out = [...lines];
  for (const { rule, at } of ordered) {
    const pos = rule.where === 'after' ? at + 1 : at;
    out = [...out.slice(0, pos), ...rule.insert, ...out.slice(pos)];
    inserted.push({ id: rule.id, at, where: rule.where, lines: rule.insert.length });
  }
  const patched = out.join(eol);
  const missing = RULES.filter((r) => !patched.includes(r.insert[r.insert.length - 1].trim()));
  if (missing.length) return { error: 'post-build check: rules did not take: ' + missing.map((m) => m.id).join(', '), reason: 'REPLACEMENT_NOT_TAKEN' };
  const markerCount = patched.split(MARKER).length - 1;
  if (markerCount !== RULES.length) return { error: `post-build check: expected ${RULES.length} overlay markers, found ${markerCount}`, reason: 'MARKER_COUNT' };
  return {
    alreadyPatched: false,
    eol: eol === '\r\n' ? 'CRLF' : 'LF',
    inserted: inserted.sort((a, b) => a.at - b.at),
    addedLines: out.length - lines.length,
    pristineSha256: sha256(Buffer.from(raw, 'utf8')),
    patchedSha256: sha256(Buffer.from(patched, 'utf8')),
    patched,
  };
}

export function resolveTarget(argv) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const install = arg('--install');
  const target = arg('--target');
  if (install && target) return { error: 'pass either --install or --target, not both' };
  if (install) { const abs = path.resolve(install); return { target: path.join(abs, LIB_REL), install: abs }; }
  if (target) { const abs = path.resolve(target); return { target: abs, install: null }; }
  return { error: 'missing --install <dir> or --target <file>' };
}

export function run(argv) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const dryRun = argv.includes('--dry-run');
  const check = argv.includes('--check');
  const force = argv.includes('--force');
  const rollback = argv.includes('--rollback');
  const jsonPath = arg('--json');
  const ledgerArg = arg('--ledger');

  const resolved = resolveTarget(argv);
  if (resolved.error) { console.error('[overlay] ' + resolved.error); return EXIT.USAGE; }
  const target = resolved.target;
  const install = resolved.install;
  const lock = interlockCheck(target);
  const ledgerFile = ledgerPathFor({ install, target }, ledgerArg);
  const ledgerLock = interlockCheck(ledgerFile);

  const report = {
    tool: 'apply-descriptor-compat-overlay',
    version: 1,
    target,
    install,
    dryRun,
    check,
    rollback,
    interlock: lock.ok ? { ok: true, root: lock.root } : { ok: false, why: lock.why },
    known: KNOWN,
    rules: RULES.map((r) => ({ id: r.id, anchor: r.anchor, where: r.where, lines: r.insert.length, why: r.why })),
    insertedLines: INSERTED_LINES,
    ruleFingerprint: RULE_FINGERPRINT,
    result: null,
  };
  const finish = (code) => {
    if (jsonPath) {
      try { fs.writeFileSync(jsonPath, JSON.stringify(report, null, 1), 'utf8'); } catch (e) { console.error('[overlay] could not write --json report: ' + e.message); }
    }
    return code;
  };

  const info = (p) => (fs.existsSync(p) ? { sha256: sha256(fs.readFileSync(p)), bytes: fs.statSync(p).size } : null);

  // One ledger line per run that leaves (or re-confirms) a codec state on disk:
  //   PATCHED · ALREADY_PATCHED · PATCH_INCOMPLETE · ROLLED_BACK, plus the states where the tool
  //   wrote something and could not verify the outcome (WRITE_FAILED, POST_WRITE_MISMATCH,
  //   POST_WRITE_INCOMPLETE, ROLLBACK_WRITE_FAILED, ROLLBACK_VERIFY_FAILED).
  // A pure refusal records NOTHING: nothing changed, and the record must never look like the tool's
  // endorsement of bytes it did not write. Never a dry run. Never a read-only --check. Never when the
  // interlock refused — a refused run must leave the filesystem exactly as it found it, ledger included.
  const record = (result, beforeInfo, afterInfo, extra = {}) => {
    if (dryRun || check || !lock.ok || !ledgerLock.ok) return null;
    let entry;
    try {
      entry = ledgerLine({ install, target, result, before: beforeInfo, after: afterInfo, forced: force, dryRun: false, detail: extra.detail, extra: extra.extra || {} });
      appendLedger(ledgerFile, entry);
    } catch (e) {
      report.ledger = { path: ledgerFile, appended: false, error: e.message };
      console.error('[overlay] LEDGER WRITE FAILED: ' + e.message);
      console.error('[overlay] the tree changed but this run is now UNRECORDED — re-run once the ledger is writable.');
      return null;
    }
    report.ledger = { path: ledgerFile, appended: true, result, currentSha256: entry.currentSha256, line: fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').length };
    return entry;
  };
  if (!ledgerLock.ok) {
    report.ledger = { path: ledgerFile, appended: false, error: 'ledger path refused: ' + ledgerLock.why };
    console.error('[overlay] WARNING: ledger path is outside the sandbox (' + ledgerLock.why + ') — no ledger will be written.');
  }

  if (!lock.ok) {
    report.result = 'INTERLOCK_REFUSED';
    console.error('[overlay] REFUSED: ' + lock.why);
    console.error('[overlay] refused target: ' + target);
    return finish(EXIT.INTERLOCK);
  }
  if (!fs.existsSync(target)) {
    report.result = 'TARGET_MISSING';
    console.error('[overlay] target does not exist: ' + target);
    return finish(EXIT.ANCHOR);
  }

  const raw = fs.readFileSync(target, 'utf8');
  const before = sha256(Buffer.from(raw, 'utf8'));
  const beforeInfo = info(target);
  report.beforeSha256 = before;

  // --- --rollback: put the pristine backup back, byte for byte, and say so in the ledger --------
  if (rollback) {
    if (check) { console.error('[overlay] --rollback cannot be combined with --check'); return finish(EXIT.USAGE); }
    const backup = target + '.pre-p4_5-compat.bak';
    report.backup = backup;
    if (!fs.existsSync(backup)) {
      report.result = 'ROLLBACK_NO_BACKUP';
      console.error('[overlay] REFUSED: no pristine backup at ' + backup + ' — nothing to restore from');
      return finish(EXIT.NO_BACKUP);
    }
    const backupBuf = fs.readFileSync(backup);
    const backupSha = sha256(backupBuf);
    report.backupSha256 = backupSha;
    if (backupSha !== KNOWN.pristineSha256 && !force) {
      report.result = 'ROLLBACK_BACKUP_UNRECORDED';
      console.error('[overlay] REFUSED: the backup hashes to ' + backupSha + ', which is not the recorded pristine build (' + KNOWN.pristineSha256 + '); pass --force to restore it anyway');
      return finish(EXIT.NO_BACKUP);
    }
    if (dryRun) {
      report.result = 'ROLLBACK_DRY_RUN';
      console.log('[overlay] DRY RUN — would restore ' + backup + ' (' + backupSha + ') over ' + target + '; nothing written');
      return finish(EXIT.OK);
    }
    try { fs.writeFileSync(target, backupBuf); } catch (e) {
      report.result = 'ROLLBACK_WRITE_FAILED';
      console.error('[overlay] restore failed: ' + e.message);
      record('ROLLBACK_WRITE_FAILED', beforeInfo, info(target), { detail: e.message });
      return finish(EXIT.ROLLBACK);
    }
    const afterRollback = info(target);
    report.afterSha256 = afterRollback.sha256;
    if (afterRollback.sha256 !== backupSha) {
      report.result = 'ROLLBACK_VERIFY_FAILED';
      console.error('[overlay] ROLLBACK VERIFY FAILED: expected ' + backupSha + ', read ' + afterRollback.sha256);
      record('ROLLBACK_VERIFY_FAILED', beforeInfo, afterRollback, { detail: 'restored bytes do not hash to the backup' });
      return finish(EXIT.ROLLBACK);
    }
    report.result = 'ROLLED_BACK';
    record('ROLLED_BACK', beforeInfo, afterRollback, { extra: { restoredSha256: backupSha, restoredFrom: backup }, detail: 'restored from ' + path.basename(backup) });
    console.log('[overlay] ROLLED BACK :: ' + target);
    console.log('[overlay] restored    : ' + afterRollback.sha256 + '  (pristine backup ' + backupSha + ')');
    console.log('[overlay] ledger      : ' + ledgerFile);
    return finish(EXIT.OK);
  }

  if (check) {
    const intact = RULES.every((r) => raw.includes(r.insert[r.insert.length - 1].trim())) && (raw.split(MARKER).length - 1) === RULES.length;
    report.result = intact ? 'OVERLAY_INTACT' : 'OVERLAY_ABSENT_OR_INCOMPLETE';
    console.log('[overlay] ' + (intact ? 'INTACT' : 'NOT INTACT') + ' :: ' + target);
    console.log('[overlay] sha256=' + before + (before === KNOWN.patchedSha256 ? ' (recorded patched state)' : before === KNOWN.pristineSha256 ? ' (recorded pristine state)' : ' (unrecorded state)'));
    // Read-only ledger cross-check. --check never writes, not even a ledger line: it only reports
    // whether the record beside this install still describes the bytes that are actually there.
    const led = readLedger(ledgerFile);
    const relTarget = (install ? path.relative(install, target) : path.basename(target)).replace(/\\/g, '/').toLowerCase();
    const matching = led.entries.filter((e) => String(e.targetRel || '').toLowerCase() === relTarget);
    const last = matching.length ? matching[matching.length - 1] : null;
    report.ledger = {
      path: ledgerFile, present: led.present, parseError: led.error, entries: led.entries.length,
      matchingEntries: matching.length, recordedSha256: last ? last.currentSha256 : null,
      agrees: last ? last.currentSha256 === before : null,
    };
    console.log('[overlay] ledger      : ' + (led.present
      ? ledgerFile + ' :: ' + matching.length + ' entr(y|ies) for this file, last recorded ' + (last ? last.currentSha256 : '(none)') + ' -> ' + (last ? (last.currentSha256 === before ? 'AGREES' : 'DISAGREES') : 'no record for this file')
      : '(absent at ' + ledgerFile + ')'));
    return finish(intact ? EXIT.OK : EXIT.NOT_PATCHED);
  }

  const built = buildPatched(raw);
  if (built.error) {
    report.result = built.reason || 'BUILD_FAILED';
    report.error = built.error;
    console.error('[overlay] REFUSED: ' + built.error);
    console.error('[overlay] nothing was written; before sha256=' + before);
    return finish(EXIT.ANCHOR);
  }

  if (built.alreadyPatched) {
    const markers = raw.split(MARKER).length - 1;
    const incomplete = markers !== RULES.length;
    // A complete marker set is NOT by itself proof that these are the audited patched bytes. If the
    // hash says otherwise, this is a foreign or hand-edited patched file: refuse it instead of
    // stamping an ALREADY_PATCHED line onto it (that would launder unrecorded bytes into the record).
    if (!incomplete && !force && before !== KNOWN.patchedSha256) {
      report.result = 'ALREADY_PATCHED_UNRECORDED';
      report.overlayMarkers = markers;
      report.afterSha256 = before;
      console.error('[overlay] REFUSED: all ' + RULES.length + ' markers are present but sha256 ' + before);
      console.error('[overlay]           is not the recorded patched build (' + KNOWN.patchedSha256 + '); this file was patched by something else or edited afterwards.');
      console.error('[overlay] nothing was written and no ledger line was added; pass --force to record these bytes as they are.');
      return finish(EXIT.ANCHOR);
    }
    report.result = incomplete ? 'PATCH_INCOMPLETE' : 'ALREADY_PATCHED';
    report.overlayMarkers = markers;
    report.afterSha256 = before;
    console.log('[overlay] ' + (incomplete ? 'PATCH INCOMPLETE' : 'ALREADY PATCHED') + ' (' + markers + '/' + RULES.length + ' markers) :: ' + target);
    console.log('[overlay] before sha256=' + before + '  after sha256=' + before + ' (unchanged)');
    record(report.result, beforeInfo, beforeInfo, {
      extra: {
        expectedPristineSha256: built.pristineSha256, expectedPatchedSha256: built.patchedSha256,
        ruleIds: RULES.map((r) => r.id), insertedLines: 0, backupCreated: false, wroteNothing: true,
        recordedBytesAreAuditedBuild: before === KNOWN.patchedSha256,
      },
      detail: incomplete ? 'markers ' + markers + '/' + RULES.length
        : before === KNOWN.patchedSha256
          ? 'idempotent re-run; nothing written, the record now re-confirms these bytes as the audited patched build'
          : 'forced: nothing written, these bytes are NOT the audited patched build (recorded as they are)',
    });
    if (report.ledger && report.ledger.appended) console.log('[overlay] ledger      : ' + report.ledger.path + ' (line ' + report.ledger.line + ', currentSha256 ' + report.ledger.currentSha256 + ')');
    return finish(markers === RULES.length ? EXIT.OK : EXIT.NOT_PATCHED);
  }

  report.pristineSha256 = built.pristineSha256;
  report.patchedSha256 = built.patchedSha256;
  report.insertions = built.inserted;
  report.eol = built.eol;
  report.addedLines = built.addedLines;

  if (!force && before !== KNOWN.pristineSha256 && before !== KNOWN.patchedSha256) {
    report.result = 'UNRECORDED_PRISTINE';
    console.error('[overlay] REFUSED: sha256 ' + before + ' is neither the recorded pristine (' + KNOWN.pristineSha256 + ') nor the recorded patched state.');
    console.error('[overlay] this file is not the codec build this overlay was audited against; pass --force to override.');
    return finish(EXIT.ANCHOR);
  }

  console.log('[overlay] target      : ' + target);
  console.log('[overlay] pristine    : ' + built.pristineSha256);
  console.log('[overlay] anticipated : ' + built.patchedSha256);
  console.log('[overlay] insertions  : ' + built.inserted.length + ' rule sites, ' + built.addedLines + ' lines added (' + built.eol + ' EOL)');
  for (const i of built.inserted) console.log('[overlay]   + ' + String(i.lines).padStart(2) + ' lines @ line ' + (i.at + 1) + ' ' + i.where.toUpperCase() + '  ' + i.id);

  if (dryRun) {
    report.result = 'DRY_RUN';
    report.afterSha256 = before;
    console.log('[overlay] DRY RUN — nothing written; sha256 stays ' + before);
    console.log('[overlay] dry run — no ledger line is written either (' + ledgerFile + ')');
    return finish(EXIT.OK);
  }

  const backup = target + '.pre-p4_5-compat.bak';
  let wroteBackup = false;
  try {
    if (!fs.existsSync(backup)) { fs.writeFileSync(backup, raw, 'utf8'); wroteBackup = true; }
    fs.writeFileSync(target, built.patched, 'utf8');
  } catch (e) {
    report.result = 'WRITE_FAILED';
    report.error = e.message;
    console.error('[overlay] write failed: ' + e.message);
    record('WRITE_FAILED', beforeInfo, info(target), { detail: e.message });
    return finish(EXIT.ROLLBACK);
  }

  const reread = fs.readFileSync(target, 'utf8');
  const after = sha256(Buffer.from(reread, 'utf8'));
  report.afterSha256 = after;
  report.backup = backup;
  report.backupCreated = wroteBackup;
  report.backupSha256 = sha256(fs.readFileSync(backup));

  if (after !== built.patchedSha256) {
    report.result = 'POST_WRITE_MISMATCH';
    console.error('[overlay] POST-WRITE MISMATCH: expected ' + built.patchedSha256 + ', read ' + after);
    try { fs.writeFileSync(target, raw, 'utf8'); console.error('[overlay] original restored; sha256=' + sha256(Buffer.from(fs.readFileSync(target, 'utf8'), 'utf8'))); } catch (e) { console.error('[overlay] RESTORE FAILED: ' + e.message + ' — restore manually from ' + backup); }
    record('POST_WRITE_MISMATCH', beforeInfo, info(target), { detail: 'expected ' + built.patchedSha256 });
    return finish(EXIT.ROLLBACK);
  }
  const markers = reread.split(MARKER).length - 1;
  const missing = RULES.filter((r) => !reread.includes(r.insert[r.insert.length - 1].trim()));
  report.overlayMarkers = markers;
  if (markers !== RULES.length || missing.length) {
    report.result = 'POST_WRITE_INCOMPLETE';
    console.error('[overlay] POST-WRITE INCOMPLETE: markers=' + markers + '/' + RULES.length + ' missing=' + missing.map((m) => m.id).join(','));
    try { fs.writeFileSync(target, raw, 'utf8'); console.error('[overlay] original restored from backup ' + backup); } catch (e) { console.error('[overlay] RESTORE FAILED: ' + e.message); }
    record('POST_WRITE_INCOMPLETE', beforeInfo, info(target), { detail: 'markers ' + markers + '/' + RULES.length });
    return finish(EXIT.ROLLBACK);
  }

  report.result = 'PATCHED';
  console.log('[overlay] patched     : ' + after + (after === KNOWN.patchedSha256 ? '  (matches the recorded patched state)' : '  (NOT the recorded patched state)'));
  console.log('[overlay] backup      : ' + backup + (wroteBackup ? ' (new)' : ' (existing, reused)'));
  record('PATCHED', beforeInfo, info(target), { extra: { backup, backupCreated: wroteBackup } });
  if (report.ledger && report.ledger.appended) {
    console.log('[overlay] ledger      : ' + report.ledger.path + ' (line ' + report.ledger.line + ', currentSha256 ' + report.ledger.currentSha256 + ')');
    return finish(EXIT.OK);
  }
  // The patch is on disk and verified, but the record of it is not. That state is not "done".
  return finish(EXIT.LEDGER);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(run(process.argv.slice(2)));
