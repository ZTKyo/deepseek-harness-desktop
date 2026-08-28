// r8-attestation-check.mjs — Phase 02 R8 (R8-4): STRICT source/deployed/loaded
// attestation gate. Compares every ACTIVE plugin (from loaded-release.json
// manifest, not a hard-coded list) across source (repo) / deployed (profile) /
// loaded (manifest). Missing manifest, missing any active plugin entry, or any
// hash mismatch => FAIL (exit 1). This is the Reviewer truth script — it must
// FAIL on a mismatch fixture.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };

const home = os.homedir();
const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
// Canonical source of truth = the repo checkout (NOT _release-staging, which is
// a stale deploy-time snapshot and caused a false DIFF in the 2026-08-28 P2.6 R1
// run). Override only for fixture drills.
const repo = process.argv[2] || 'C:/Users/Administrator/Desktop/sdeepseek harness/deepseek-harness-desktop';
const live = path.join(home, '.dsh', 'profiles', 'web');
const manifestPath = path.join(local, 'DSHHarness', 'state', 'loaded-release.json');

let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log('PASS  ' + name + (detail ? '  ' + detail : '')); }
  else { console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); fail++; }
};

let loaded = null;
try { loaded = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
check('manifest exists', !!loaded, manifestPath);
if (!loaded) { console.log('ATTESTATION FAILED'); process.exit(1); }

check('manifest has serverGeneration (true per-boot identity)', typeof loaded.serverGeneration === 'string' && loaded.serverGeneration.length > 0, `gen=${loaded.serverGeneration}`);
const plugins = loaded.plugins || {};
const names = Object.keys(plugins);
check('manifest has plugin entries', names.length >= 8, `count=${names.length}`);
let allOk = true;
for (const p of names) {
  const src = sha(path.join(repo, 'plugins', p));
  const dep = sha(path.join(live, p));
  const loadedHash = plugins[p] && plugins[p].sha256;
  const sMatch = !!(src && dep && src === dep);
  const lMatch = !!(dep && loadedHash && dep === loadedHash);
  check(`source==deployed==loaded ${p}`, sMatch && lMatch, `src=${src ? src.slice(0, 8) : 'null'} dep=${dep ? dep.slice(0, 8) : 'null'} loaded=${loadedHash ? loadedHash.slice(0, 8) : 'null'}`);
  if (!(sMatch && lMatch)) allOk = false;
}
check('overall source==deployed==loaded ALL MATCH', allOk);

console.log('');
if (fail > 0) { console.log(`ATTESTATION FAILED (${fail})`); process.exit(1); }
console.log('ATTESTATION PASSED (all active plugins source==deployed==loaded)');
