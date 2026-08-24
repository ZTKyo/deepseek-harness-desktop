// r5-runtime-truth.mjs — Phase 02 R5/R6: live runtime truth + source→deployment
// →loaded attestation. Read-only. Prints:
//   1. current provider/model from host.describe
//   2. exact route contextWindow (settings declarations + registry hints)
//   3. ACTIVE agent preset effective compaction config (thresholdRatio/
//      retainRatio/maxTokens) — read from ~/.dsh/.agent-presets/.../agent.cordis.yml
//      (NOT hard-coded defaults)
//   4. source/deployed SHA256 for the active plugin set
//   5. loaded release attestation: server runtime entryHash (dsh-runtime json)
//      + plugin file mtime vs server start (loaded-at-start inference)
//   6. proactive threshold = resolvedContext * thresholdRatio
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };

// 1) host.describe
let describe = null;
try {
  const res = await fetch('http://127.0.0.1:3080/api/host.describe', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'truth-1', method: 'host.describe', payload: {} }),
  });
  const body = await res.json();
  describe = body.result && body.result.value ? body.result.value : body.result;
} catch (e) { describe = { error: String(e.message) }; }

const home = os.homedir();

// 3) ACTIVE preset compaction config (authoritative for the autonomous preset)
let thresholdRatio = null, retainRatio = null, maxTokens = null;
const presetPaths = [
  path.join(home, '.dsh', '.agent-presets', 'autonomous', 'agent.cordis.yml'),
  path.join(home, '.dsh', '.agent-presets', 'agent.cordis.yml'),
];
let presetFile = null;
for (const p of presetPaths) { if (fs.existsSync(p)) { presetFile = p; break; } }
if (presetFile) {
  const raw = fs.readFileSync(presetFile, 'utf8');
  const tr = raw.match(/thresholdRatio:\s*([0-9.]+)/);
  const rr = raw.match(/retainRatio:\s*([0-9.]+)/);
  const mt = raw.match(/maxTokens:\s*(\d+)/);
  if (tr) thresholdRatio = Number(tr[1]);
  if (rr) retainRatio = Number(rr[1]);
  if (mt) maxTokens = Number(mt[1]);
}
// fallback: official dsh-compaction-basic defaults (only if preset not readable)
if (thresholdRatio === null) thresholdRatio = 0.8;
if (retainRatio === null) retainRatio = 0.16;

// 2) settings declared contextWindow for the active route
const settingsRaw = fs.existsSync(path.join(home, '.dsh', 'settings.yaml')) ? fs.readFileSync(path.join(home, '.dsh', 'settings.yaml'), 'utf8') : '';
let declaredCtx = null;
const prov = describe && describe.provider;
const model = describe && describe.model;
if (prov && model) {
  const re = new RegExp('provider:\\s*' + prov.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]{0,400}?contextWindow:\\s*(\\d+)');
  const m = settingsRaw.match(re);
  if (m) declaredCtx = Number(m[1]);
}

// 4) attestation: source (repo) vs deployed (live profile)
const repo = 'C:/Users/Administrator/Desktop/sdeepseek harness/_release-staging';
const live = path.join(home, '.dsh', 'profiles', 'web');
const activePlugins = ['execution-continuity.mjs', 'openrouter-router.mjs', 'commandcode-router.mjs', 'model-registry.mjs', 'completion-truth-core.mjs', 'vision-bridge.mjs', 'capacity-resolver.mjs'];
const attest = [];
for (const p of activePlugins) {
  const src = sha(path.join(repo, 'plugins', p));
  const dep = sha(path.join(live, p));
  attest.push({ plugin: p, source: src ? src.slice(0, 12) : null, deployed: dep ? dep.slice(0, 12) : null, same: !!(src && dep && src === dep) });
}
const allSame = attest.every((a) => a.same);

// 5) loaded release attestation
let runtime = null;
try { runtime = JSON.parse(fs.readFileSync(path.join(home, 'AppData', 'Local', 'DSHHarness', 'logs', 'dsh-runtime-3080.json'), 'utf8')); } catch {}
const serverStartMs = runtime && runtime.startedAt ? Date.parse(runtime.startedAt) : null;
const depMtimes = {};
for (const p of activePlugins) {
  const fp = path.join(live, p);
  try { depMtimes[p] = fs.statSync(fp).mtimeMs; } catch { depMtimes[p] = null; }
}
const allDeployedBeforeStart = Object.values(depMtimes).every((m) => m !== null && serverStartMs !== null && m < serverStartMs);

// 6) proactive threshold
const resolvedCtx = declaredCtx || null;
const proactive = resolvedCtx ? Math.round(resolvedCtx * thresholdRatio) : null;

console.log('=== R5-B6 RUNTIME TRUTH ===');
console.log('host.describe:', JSON.stringify(describe));
console.log('active route:', prov + '/' + model);
console.log('settings declared contextWindow:', declaredCtx, declaredCtx ? '(tokens)' : '(none)');
console.log('ACTIVE preset compaction file:', presetFile || '(none found)');
console.log('effective thresholdRatio:', thresholdRatio, 'retainRatio:', retainRatio, 'maxTokens:', maxTokens);
console.log('proactive threshold = resolvedCtx * thresholdRatio =', proactive, '(tokens)');
console.log('');
console.log('=== SOURCE -> DEPLOYED ATTESTATION ===');
for (const a of attest) console.log(a.plugin.padEnd(32), 'src=' + a.source, 'deployed=' + a.deployed, a.same ? 'MATCH' : 'MISMATCH');
console.log('overall source==deployed:', allSame ? 'ALL MATCH' : 'MISMATCH - CHECK DEPLOYMENT');
console.log('');
console.log('=== LOADED RELEASE ATTESTATION ===');
console.log('runtime entryHash:', runtime ? runtime.entryHash : '(no runtime json)');
console.log('server startedAt:', runtime ? runtime.startedAt : '(none)');
console.log('all plugin mtimes < server start (loaded=deployed):', allDeployedBeforeStart ? 'YES (loaded == deployed)' : 'NO - server may have loaded older/newer files');
console.log('');
console.log('=== MODEL CAPACITY (registry hints via resolver) ===');
const cap = await import('file:///' + repo.replace(/ /g, '%20') + '/plugins/capacity-resolver.mjs');
const resolver = cap.defaultCapacityResolver();
for (const [p, m] of [['commandcode', 'deepseek/deepseek-v4-flash'], ['opencode', 'deepseek-v4-flash'], ['openrouter', 'qwen/qwen3.7-flash'], ['openrouter', 'deepseek/deepseek-v4-flash-0731'], ['openrouter', 'claude-opus-5']]) {
  const r = resolver.resolve(p, m);
  console.log((p + '/' + m).padEnd(45), 'resolvedWindow=' + r.window, 'source=' + r.source);
}
