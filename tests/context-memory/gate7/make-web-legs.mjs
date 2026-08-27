#!/usr/bin/env node
// Build the failopen/envkill WEB-leg homes from the baseline template:
// identical preset/persona/plugins, per-leg baked stateDir, clean runtime dirs.
// baseline home itself stays untouched (it is the golden template).
// profiles\node_modules is NOT copied per leg — each leg's home junctions to
// the baseline copy (it is read-only at runtime and contains junctions into
// the npm global cache; copying would explode / hang on the cache tree).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const GATE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_HOME = path.join(GATE, 'legs', 'baseline', 'home');
const NM = 'node_modules';

function resetDir(p) { fs.rmSync(p, { recursive: true, force: true }); fs.mkdirSync(p, { recursive: true }); }

// robocopy clones the tree excluding runtime leftovers and the shared
// node_modules (junctioned below). Exit codes 0-7 are success for robocopy.
function cloneHome(src, dst) {
  try {
    execFileSync('robocopy', [
      src, dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/NP',
      '/XD',
      path.join(src, 'sessions'), path.join(src, 'storages'),
      path.join(src, 'profiles', NM),
    ], { stdio: 'pipe' });
  } catch (e) {
    const code = e.status;
    if (code === undefined || code > 7) throw e; // real failure
  }
}

function linkNodeModules(legHome) {
  const link = path.join(legHome, 'profiles', NM);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  execFileSync('cmd', ['/c', 'mklink', '/J', link, path.join(BASELINE_HOME, 'profiles', NM)], { stdio: 'pipe' });
}

for (const leg of ['failopen', 'envkill', 'missing']) {
  const legDir = path.join(GATE, 'legs', leg);
  const home = path.join(legDir, 'home');
  resetDir(home);
  cloneHome(BASELINE_HOME, home);
  linkNodeModules(home);
  const yml = path.join(home, '.agent-presets', 'cm-drill', 'agent.cordis.yml');
  let t = fs.readFileSync(yml, 'utf8');
  const want = path.join(legDir, 'state').replace(/\\/g, '/');
  if (!/stateDir: '/.test(t)) throw new Error(`${yml}: no stateDir row found`);
  t = t.replace(/stateDir: '[^']+'/g, `stateDir: '${want}'`);
  fs.writeFileSync(yml, t);
  resetDir(path.join(legDir, 'workdir'));
  resetDir(path.join(legDir, 'state'));
  console.log(`[fixtures] ${leg}: home ready, stateDir=${want}`);
}
console.log('[fixtures] done');
