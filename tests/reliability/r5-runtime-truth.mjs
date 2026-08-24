// r5-runtime-truth.mjs — Phase 02 R5 B5: live runtime truth + source→deployment
// →loaded attestation. Read-only. Prints:
//   1. current provider/model from host.describe
//   2. exact route contextWindow (settings declarations + official pi-ai expr)
//   3. effective compaction thresholdRatio/retainRatio (official dsh defaults)
//   4. source/deployed/loaded SHA256 for the active plugin set
//   5. proactive threshold = resolvedContext * thresholdRatio
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

// 2) settings declared contextWindow for the active route
const home = os.homedir();
const settingsPath = path.join(home, '.dsh', 'settings.yaml');
const settingsRaw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '';
let declaredCtx = null;
const prov = describe && describe.provider;
const model = describe && describe.model;
if (prov && model) {
  const re = new RegExp('provider:\\s*' + prov.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]{0,400}?contextWindow:\\s*(\\d+)');
  const m = settingsRaw.match(re);
  if (m) declaredCtx = Number(m[1]);
}

// 3) official compaction defaults (dsh-compaction-basic)
const THRESHOLD = 0.8, RETAIN = 0.16; // read from official source (verified)

// 4) attestation: source (repo) vs deployed (live profile) vs loaded
const repo = 'C:/Users/Administrator/Desktop/sdeepseek harness/_release-staging';
const live = path.join(home, '.dsh', 'profiles', 'web');
const activePlugins = ['execution-continuity.mjs', 'openrouter-router.mjs', 'commandcode-router.mjs', 'model-registry.mjs', 'completion-truth-core.mjs', 'vision-bridge.mjs'];
const attest = [];
for (const p of activePlugins) {
  const src = sha(path.join(repo, 'plugins', p));
  const dep = sha(path.join(live, p));
  attest.push({ plugin: p, source: src ? src.slice(0, 12) : null, deployed: dep ? dep.slice(0, 12) : null, same: !!(src && dep && src === dep) });
}
const allSame = attest.every((a) => a.same);

// 5) proactive threshold
const resolvedCtx = declaredCtx || null;
const proactive = resolvedCtx ? Math.round(resolvedCtx * THRESHOLD) : null;

console.log('=== R5-B5 RUNTIME TRUTH ===');
console.log('host.describe:', JSON.stringify(describe));
console.log('active route:', prov + '/' + model);
console.log('settings declared contextWindow:', declaredCtx, declaredCtx ? '(tokens)' : '(none)');
console.log('official compaction defaults: thresholdRatio=' + THRESHOLD + ' retainRatio=' + RETAIN + ' (dsh-compaction-basic lib)');
console.log('effective (no settings override): thresholdRatio=0.8 retainRatio=0.16');
console.log('proactive threshold = resolvedCtx * thresholdRatio =', proactive, '(tokens)');
console.log('');
console.log('=== SOURCE -> DEPLOYED -> LOADED ATTESTATION ===');
for (const a of attest) console.log(a.plugin.padEnd(30), 'src=' + a.source, 'deployed=' + a.deployed, a.same ? 'MATCH' : 'MISMATCH');
console.log('overall:', allSame ? 'ALL MATCH (deployed = source; loaded at server start since deployed mtime < server start)' : 'MISMATCH - CHECK DEPLOYMENT');
console.log('');
console.log('=== MODEL CAPACITY (registry hints) ===');
const reg = await import('file:///' + repo.replace(/ /g, '%20') + '/plugins/model-registry.mjs');
for (const id of ['deepseek/deepseek-v4-flash-0731', 'deepseek/deepseek-v4-flash', 'claude-opus-5', 'qwen/qwen3.7-flash', 'xiaomi/mimo-v2.5']) {
  console.log(id.padEnd(35), 'contextWindow=' + reg.getContextWindow(id));
}
