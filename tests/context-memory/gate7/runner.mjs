#!/usr/bin/env node
// Gate-7 drill runner: boot an isolated real DSH instance for one leg and drive
// a short deterministic task inside it. Never touches the production home tree.
// Usage: node runner.mjs <legId> [--smoke] [--env-kill]
// Artifacts: legs/<leg>/{boot.log,result.json,workdir/**}
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME_ROOT = process.env.USERPROFILE || os.homedir();
const BIN = path.join(HOME_ROOT, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

const LEG = process.argv[2];
if (!LEG) throw new Error('usage: node runner.mjs <legId> [--smoke] [--env-kill]');
const SMOKE = process.argv.includes('--smoke');
const ENV_KILL = process.argv.includes('--env-kill');

const legDir = (...rel) => path.join(HERE, 'legs', LEG, ...rel);
const manifest = JSON.parse(fs.readFileSync(legDir('manifest.json'), 'utf8'));
const homeDir = path.join(legDir(), 'home');

// --- extract provider keys in-process (never printed, never logged) --------
function loadKeys() {
  const raw = fs.readFileSync(path.join(HOME_ROOT, '.dsh', '.credentials.yaml'), 'utf8');
  const map = {};
  let inCreds = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^(refs|credentials)\s*:\s*$/.test(line)) { inCreds = true; continue; }
    if (!inCreds) continue;
    const m = line.match(/^ {2}([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/);
    if (m) {
      let v = m[2].trim();
      v = v.replace(/^["']|["']$/g, '');
      if (v) map[m[1]] = v;
    }
  }
  return map;
}
const KEYS = loadKeys();

// --- task ------------------------------------------------------------------
const TASK_SMOKE = '这是一个启动冒烟测试。不需要使用任何工具，直接回复四个字符：SMOK';
const TASK_DRILL = [
  '这是多步文件演练任务，严格按顺序完成，不许合并步骤：',
  '1. 依次创建 5 个文件：a.txt、b.txt、c.txt、d.txt、e.txt，每个文件内容都是三个字符 G71；',
  '2. 全部创建完后，再把这 5 个文件名逐行写入 index.txt；',
  '3. 最后回复一行：CM-DRILL-DONE。',
].join('');
const TASK = SMOKE ? TASK_SMOKE : TASK_DRILL;

// seed workdir input file (drill only)
if (!SMOKE) {
  const note = 'CONTEXT-MEMORY GATE7 DRILL NOTE. ' +
    'The quick brown fox jumps over the lazy dog. '.repeat(3) +
    'State store isolation is verified by path, never by luck.';
  fs.writeFileSync(path.join(legDir('workdir'), 'note.txt'), note);
}

// --- env for the child ------------------------------------------------------
const childEnv = { ...process.env };
delete childEnv.NODE_OPTIONS;
delete childEnv.BASH_ENV;
delete childEnv.PYTHONPATH;
childEnv.DSH_HOME = homeDir;
for (const k of ['ZHIPU_API_KEY', 'OPENROUTER_API_KEY', 'AGENTROUTER_API_KEY']) {
  if (KEYS[k]) childEnv[k] = KEYS[k];
}
if (ENV_KILL) childEnv.CM_DISABLED = 'true';

// --- spawn -----------------------------------------------------------------
const bootLog = fs.openSync(legDir('boot.log'), 'w');
const t0 = Date.now();
const TIMEOUT_MS = SMOKE ? 180_000 : 300_000;

console.log(`[runner] leg=${LEG} smoke=${SMOKE} envKill=${ENV_KILL} home=${homeDir}`);
const child = spawn(process.execPath, [BIN, '--profile', 'headless', TASK], {
  cwd: legDir('workdir'),
  env: childEnv,
  stdio: ['ignore', bootLog, bootLog],
});
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, TIMEOUT_MS);

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else child.kill('SIGKILL');
}

const code = await new Promise((resolve) => child.on('exit', (c, s) => resolve(c ?? s)));
clearTimeout(timer);
fs.closeSync(bootLog);

// --- artifact inventory ----------------------------------------------------
const stateFiles = fs.existsSync(manifest.stateDir)
  ? fs.readdirSync(manifest.stateDir)
  : [];
const sessionsRoot = path.join(homeDir, 'sessions');
const sessionFiles = [];
(function walk(d, prefix) {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, `${prefix}${e.name}/`);
    else sessionFiles.push(`${prefix}${e.name}`);
  }
})(sessionsRoot, '');

const result = {
  leg: LEG, smoke: SMOKE, envKill: ENV_KILL,
  exitCodeOrSignal: code, timedOut,
  elapsedMs: Date.now() - t0,
  stateDirExists: fs.existsSync(manifest.stateDir),
  stateFiles,
  sessionFiles,
};
fs.writeFileSync(legDir('result.json'), JSON.stringify(result, null, 2));
console.log('[runner] ' + JSON.stringify(result));
if (timedOut) console.log(`[runner] TIMEOUT after ${TIMEOUT_MS}ms — see boot.log tail`);
process.exit(timedOut ? 3 : 0);
