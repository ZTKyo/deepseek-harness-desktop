// P4.5 A1 — K1 dispose probe (PORTED from _p4_5-sandbox\tools\p45-k1-dispose-probe.mjs).
//
// Original design (kept intact: four groups A/B/C/D, bus self-test, honest NOT_EXERCISABLE path):
//   A = the pattern our layers use: a disposer registered inside apply(ctx), then fiber.dispose()
//   B = ctx.effect() idiomatic disposer (control: must fire)
//   C = apply() returns a disposer (control: must fire)
//   D = ctx.on('x') + ctx.emit('x') bus self-test (control: proves the harness can observe firing)
//
// What this port changes, and why it is STRONGER evidence than the original:
//   * the original group A reproduced the SHAPE with a synthetic plugin; this port loads the REAL
//     layer bytes from --layer-root and observes the REAL cleanup effect (the global patch the layer
//     promises to undo). "fired" therefore means "the layer actually restored global state", not
//     "a counter in a stub went up".
//   * A1 = keepalive-patch.mjs  -> undici global dispatcher restored?
//   * A2 = commandcode-router.mjs (CMD_ZDR=1) -> globalThis.fetch restored?
//   * byte integrity: every copied module is sha256-compared with its source, so the verdict is
//     about the real layer, not a paraphrase (same discipline as p45-layer-attach-probe.mjs).
//
// Read-only w.r.t. the product: writes only under _p4_5-wt\.p45-tmp\ and the requested --out.
// The child process never touches ~/.dsh (ROUTER_DIAGNOSTICS is force-disabled) and opens no port.
//
// Usage: node tools/layers/k1-dispose-probe.mjs --layer-root <dir> [--label <name>] --out <json>
//        [--substrate <_p4_5-sandbox\install>] [--work <dir>] [--timeout-ms 45000]
// Exit: 0 = probe completed (verdict inside the artifact) - 2 usage - 3 interlock - 4 setup
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WT = path.resolve(HERE, '..', '..');                       // _p4_5-wt
const WORKSPACE = path.resolve(WT, '..');
const SANDBOX = path.join(WORKSPACE, '_p4_5-sandbox');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const LAYER_ROOT = path.resolve(arg('--layer-root', path.join(WT, 'plugins')));
const LABEL = String(arg('--label', path.basename(LAYER_ROOT)));
const OUT = arg('--out', null);
const SUBSTRATE = path.resolve(arg('--substrate', path.join(SANDBOX, 'target-newest')));
const WORK = path.resolve(arg('--work', path.join(WT, '.p45-tmp', 'k1-probe', LABEL)));
const TIMEOUT = Number(arg('--timeout-ms', '45000'));

if (!OUT) { console.error('usage: --layer-root <dir> --out <json> [--label <name>] [--substrate <dir>]'); process.exit(2); }

// ---- interlocks (never write outside the lanes, never probe a production tree) -----------------
const under = (p, root) => { const r = path.resolve(root).toLowerCase(); const q = path.resolve(p).toLowerCase(); return q === r || q.startsWith(r + path.sep); };
if (!under(OUT, SANDBOX) && !under(OUT, path.join(WT, '.p45-tmp'))) { console.error('REFUSING: --out must be under _p4_5-sandbox or _p4_5-wt\\.p45-tmp\\: ' + OUT); process.exit(3); }
if (!under(WORK, path.join(WT, '.p45-tmp'))) { console.error('REFUSING: --work must be under _p4_5-wt\\.p45-tmp\\: ' + WORK); process.exit(3); }
if (!under(LAYER_ROOT, WT) && !under(LAYER_ROOT, SANDBOX)) { console.error('REFUSING: --layer-root outside the lanes: ' + LAYER_ROOT); process.exit(3); }
if (!under(SUBSTRATE, SANDBOX) || /\.dsh[\\/]/i.test(SUBSTRATE) || /AppData/i.test(SUBSTRATE)) { console.error('REFUSING: --substrate is not a sandbox install: ' + SUBSTRATE); process.exit(3); }
const CORDIS_DIR = path.join(SUBSTRATE, 'node_modules', '@deepseek-ai', 'cordis');
if (!fs.existsSync(CORDIS_DIR)) { console.error('REFUSING: substrate has no @deepseek-ai/cordis: ' + CORDIS_DIR); process.exit(4); }

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ---- work root: flat copy of the layer + a junction to the real substrate dependency tree ------
fs.mkdirSync(WORK, { recursive: true });
const TARGETS = ['keepalive-patch.mjs', 'commandcode-router.mjs'];
const integrity = {};
const files = fs.readdirSync(LAYER_ROOT).filter((f) => f.endsWith('.mjs'));
for (const f of files) {
  const src = path.join(LAYER_ROOT, f);
  const dst = path.join(WORK, f);
  fs.copyFileSync(src, dst);
  if (TARGETS.includes(f)) integrity[f] = { source: src, sourceSha256: sha(src), copySha256: sha(dst), identical: sha(src) === sha(dst) };
}
const link = path.join(WORK, 'node_modules');
if (!fs.existsSync(link)) {
  try { fs.symlinkSync(path.join(SUBSTRATE, 'node_modules'), link, 'junction'); }
  catch (e) { console.error('REFUSING: could not junction substrate node_modules: ' + e.message); process.exit(4); }
}
const missing = TARGETS.filter((f) => !fs.existsSync(path.join(WORK, f)));
if (missing.length) { console.error('REFUSING: layer-root is missing ' + missing.join(', ')); process.exit(4); }
const bytesOk = Object.values(integrity).every((v) => v.identical);
if (!bytesOk) { console.error('REFUSING: copied bytes differ from source — verdict would not be about the real layer'); process.exit(4); }

// ---- child: runs with the substrate's dependency resolution, exercises the four groups ---------
const CHILD = `
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const base = process.cwd();
const req = createRequire(pathToFileURL(base + '/__probe.js').href);
const cordis = await req('@deepseek-ai/cordis');
const result = { cordisVersion: (req('@deepseek-ai/cordis/package.json') || {}).version || null, trials: [], undiciResolvable: true, cwd: base };
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
function rec(label) { const t = { label, registered: false, fired: false, count: 0, applicable: true, error: null, notes: [] }; result.trials.push(t); return t; }
const last = () => result.trials[result.trials.length - 1];
const url = (f) => pathToFileURL(base + '/' + f).href;

// (D) FIRST — bus sanity: can this harness observe a firing at all?
try {
  const t = rec("D: ctx.on('k1/self-test') + ctx.emit('k1/self-test')  [bus sanity control]");
  const root = new cordis.Context();
  root.on('k1/self-test', () => { t.count++; t.fired = true; });
  t.registered = true;
  if (typeof root.emit === 'function') root.emit('k1/self-test'); else t.notes.push('ctx.emit is not a function');
  await tick();
  if (typeof root.dispose === 'function') await root.dispose();
} catch (e) { last().error = String((e && e.message) || e).slice(0, 300); }

// (B) control — ctx.effect() disposer registered inside apply(ctx), then the fiber is disposed
try {
  const t = rec('B: ctx.effect() disposer inside apply(ctx) + fiber.dispose()  [idiomatic control]');
  const root = new cordis.Context();
  const plugin = { name: 'k1-probe-b', apply(ctx) { t.registered = true; if (typeof ctx.effect === 'function') ctx.effect(() => () => { t.count++; t.fired = true; }); else t.notes.push('ctx.effect is not a function'); } };
  const fiber = root.plugin(plugin);
  await tick();
  if (fiber && typeof fiber.dispose === 'function') await fiber.dispose(); else t.notes.push('fiber had no dispose()');
  if (typeof root.dispose === 'function') await root.dispose();
  await tick();
} catch (e) { last().error = String((e && e.message) || e).slice(0, 300); }

// (C) control — apply() RETURNS a disposer (the other documented cordis shape)
try {
  const t = rec('C: apply() returns a disposer + fiber.dispose()  [documented control]');
  const root = new cordis.Context();
  const plugin = { name: 'k1-probe-c', apply(ctx) { t.registered = true; return () => { t.count++; t.fired = true; }; } };
  const fiber = root.plugin(plugin);
  await tick();
  if (fiber && typeof fiber.dispose === 'function') await fiber.dispose(); else t.notes.push('fiber had no dispose()');
  if (typeof root.dispose === 'function') await root.dispose();
  await tick();
} catch (e) { last().error = String((e && e.message) || e).slice(0, 300); }

// (A1) THE REAL LAYER: keepalive-patch.mjs — its cleanup promise is "restore the previous dispatcher"
try {
  const t = rec('A1: REAL keepalive-patch.mjs + fiber.dispose()  [undoes the global undici patch?]');
  let undici = null;
  try { undici = req('undici'); } catch (e) { t.notes.push('undici not resolvable: ' + String(e.message).slice(0, 120)); }
  if (!undici) { t.applicable = false; }
  else {
    const prev = undici.getGlobalDispatcher();
    const mod = await import(url('keepalive-patch.mjs'));
    t.registered = typeof mod.apply === 'function';
    const root = new cordis.Context();
    const fiber = root.plugin(mod);
    await tick(80);
    const afterApply = undici.getGlobalDispatcher();
    const patchApplied = afterApply !== prev;
    t.applied = patchApplied;
    t.notes.push('patchAppliedAfterApply=' + patchApplied);
    if (!patchApplied) t.applicable = false;
    if (fiber && typeof fiber.dispose === 'function') await fiber.dispose(); else t.notes.push('fiber had no dispose()');
    if (typeof root.dispose === 'function') await root.dispose();
    await tick(80);
    const afterDispose = undici.getGlobalDispatcher();
    const restored = afterDispose === prev;
    t.notes.push('restoredAfterDispose=' + restored);
    if (restored) { t.count++; t.fired = true; }
  }
} catch (e) { last().error = String((e && e.message) || e).slice(0, 300); }

// (A2) THE REAL LAYER: commandcode-router.mjs with CMD_ZDR=1 — cleanup promise is "restore globalThis.fetch"
try {
  const t = rec('A2: REAL commandcode-router.mjs (CMD_ZDR=1) + fiber.dispose()  [undoes the global fetch wrap?]');
  const originalFetch = globalThis.fetch;
  const mod = await import(url('commandcode-router.mjs'));
  t.registered = typeof mod.apply === 'function';
  const root = new cordis.Context();
  const fiber = root.plugin(mod);
  await tick(120);
  const wrapped = globalThis.fetch !== originalFetch;
  const nameOk = wrapped && String(globalThis.fetch && globalThis.fetch.name) === 'commandcodeZdrFetch';
  t.notes.push('fetchWrappedAfterApply=' + wrapped, 'wrapperName=' + String(globalThis.fetch && globalThis.fetch.name));
  t.applied = wrapped;
  if (!wrapped) t.applicable = false;
  if (wrapped && !nameOk) t.notes.push('WARNING: fetch was replaced but the wrapper is not the layer\\'s commandcodeZdrFetch');
  if (fiber && typeof fiber.dispose === 'function') await fiber.dispose(); else t.notes.push('fiber had no dispose()');
  if (typeof root.dispose === 'function') await root.dispose();
  await tick(120);
  const restored = globalThis.fetch === originalFetch;
  t.notes.push('restoredAfterDispose=' + restored);
  if (restored) { t.count++; t.fired = true; }
} catch (e) { last().error = String((e && e.message) || e).slice(0, 300); }

console.log(JSON.stringify(result));
`;
// (guard: the child must not contain the placeholder above)
const CHILD_SRC = CHILD.replace(/\n  if \(!wrapured\(\)\) \{ \/\* placeholder removed \*\/ \}/, '');

const r = await new Promise((resolve) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SRC], {
    cwd: WORK,
    windowsHide: true,
    env: { ...process.env, CMD_ZDR: '1', ROUTER_DIAGNOSTICS: '', ROUTER_DIAGNOSTICS_FILE: '' },
  });
  let so = '', se = '';
  const timer = setTimeout(() => { try { child.kill(); } catch { } }, TIMEOUT);
  child.stdout.on('data', (d) => { so += d; });
  child.stderr.on('data', (d) => { se += d; });
  child.on('close', (code) => {
    clearTimeout(timer);
    let parsed = null;
    try { parsed = JSON.parse(so.trim().split(/\r?\n/).filter(Boolean).pop()); } catch { }
    resolve({ code, result: parsed, stderr: se.slice(-900), stdoutTail: so.slice(-400) });
  });
});

const trials = (r.result && r.result.trials) || [];
const busWorks = trials.some((t) => t.label.startsWith('D:') && t.fired);
const aTrials = trials.filter((t) => /^A\d?:/.test(t.label));
const aApplicable = aTrials.filter((t) => t.applicable !== false);
const aFired = aApplicable.filter((t) => t.fired);
const controlFired = trials.some((t) => (t.label.startsWith('B:') || t.label.startsWith('C:')) && t.fired);

let verdict, classification, explanation;
if (!busWorks) {
  verdict = 'NOT_EXERCISABLE'; classification = 'DEFER';
  explanation = 'the self-test event did not fire either, so this probe cannot distinguish a dead cleaner from a broken harness — no verdict is claimed';
} else if (!aApplicable.length) {
  verdict = 'NOT_EXERCISABLE'; classification = 'DEFER';
  explanation = 'the bus works, but no real-layer trial could be applied (see per-trial notes/errors), so no verdict is claimed about the layers';
} else if (!aFired.length) {
  verdict = 'K1_REPRODUCED_dispose_listener_is_dead'; classification = 'NEEDS_OVERLAY';
  explanation = 'the real layer patched global state but disposing its fiber did NOT undo the patch: the cleanup registered inside apply(ctx) never ran, while groups B/C/D prove this harness does observe firing';
} else if (aFired.length < aApplicable.length) {
  verdict = 'K1_PARTIAL'; classification = 'NEEDS_OVERLAY';
  explanation = 'some real layers cleaned up on dispose and some did not — partial repair, not a fix';
} else {
  verdict = 'K1_NOT_REPRODUCED_listener_is_live'; classification = 'FIXED_UPSTREAM';
  explanation = 'every applicable real layer restored its global state when its fiber was disposed';
}

const artifact = {
  generatedAt: new Date().toISOString(),
  probe: "A1/K1 — is a cleanup registered inside apply(ctx) dead on cordis 4.0.4? (ported probe, group A = real layer bytes)",
  label: LABEL,
  layerRoot: LAYER_ROOT,
  sourceByteIntegrity: integrity,
  sourceBytesAllIdentical: bytesOk,
  substrateRoot: path.join(SUBSTRATE, 'node_modules'),
  cordisVersion: r.result && r.result.cordisVersion,
  executed: true,
  childExitCode: r.code,
  childStderrTail: r.stderr || '',
  trials: trials.map((t) => ({ label: t.label, registered: t.registered, applicable: t.applicable !== false, fired: t.fired, count: t.count, error: t.error, notes: t.notes })),
  busSelfTestFired: busWorks,
  realLayerTrialsApplicable: aApplicable.length,
  realLayerTrialsFired: aFired.length,
  controlDisposersFire: controlFired,
  verdict, classification, explanation,
  honestLimits: [
    'groups A1/A2 observe the cleanup EFFECT (global dispatcher / global fetch restored), not an internal counter — a layer whose "cleanup" had no observable effect would read as not-fired even if its disposer ran.',
    'this probes the substrate bus directly; it does not prove that no dsh wrapper intercepts cleanup at a layer above cordis — a live host boot would settle that fully.',
    'the CMD_ZDR=1 child env is probe-only and in-process: no request is issued and no product configuration is read or written.',
  ],
};

fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2), 'utf8');
console.log(JSON.stringify({
  stage: 'K1_DISPOSE_PROBE_COMPLETE', label: LABEL, out: path.resolve(OUT), verdict, classification,
  busSelfTestFired: busWorks, realLayerTrialsApplicable: aApplicable.length, realLayerTrialsFired: aFired.length,
  controlDisposersFire: controlFired, cordisVersion: artifact.cordisVersion, sourceBytesAllIdentical: bytesOk,
  trials: artifact.trials.map((t) => ({ label: t.label.slice(0, 68), applicable: t.applicable, fired: t.fired, count: t.count, notes: t.notes, error: t.error })),
}, null, 2));
process.exit(0);
