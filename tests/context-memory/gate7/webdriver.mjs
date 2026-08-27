#!/usr/bin/env node
// Gate-7 WEB-LEG driver: boots an isolated dsh web instance and drives a real
// multi-turn session through its HTTP RPC so context-memory's pre-step hooks
// actually fire (one-shot CLI never exceeds the surface window).
// Usage: node webdriver.mjs <legId> [--prompt-rounds N]
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const LEG = process.argv[2];
if (!LEG) throw new Error('usage: node webdriver.mjs <legId>');
const FLAG = '--prompt-rounds';
const FLAG_AT = process.argv.indexOf(FLAG);
const ROUNDS = FLAG_AT >= 0 ? Number(process.argv[FLAG_AT + 1]) : 4;
if (!Number.isInteger(ROUNDS) || ROUNDS < 1) throw new Error('bad --prompt-rounds');
const HOME_ROOT = process.env.USERPROFILE || os.homedir();
const BIN = path.join(HOME_ROOT, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const GATE = path.join(HOME_ROOT, 'Desktop', 'sdeepseek harness', '_release-staging', 'tests', 'context-memory', 'gate7');
const LEG_DIR = path.join(GATE, 'legs', LEG);
const HOME = path.join(LEG_DIR, 'home');
const WORKDIR = path.join(LEG_DIR, 'workdir');
const STATE = path.join(LEG_DIR, 'state');
const PORTS = { baseline: 3188, failopen: 3189, envkill: 3190, missing: 3191 };
const PORT = PORTS[LEG] || 3200;
const BASE = `http://127.0.0.1:${PORT}`;

fs.rmSync(WORKDIR, { recursive: true, force: true });
fs.mkdirSync(WORKDIR, { recursive: true });
fs.writeFileSync(path.join(WORKDIR, 'note.txt'), 'Hello from note.txt', 'utf8'); // seed so drill can read it
fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });

// mirror runner.mjs credential whitelist
function loadKeys() {
  const out = {};
  const raw = fs.readFileSync(path.join(HOME_ROOT, '.dsh', '.credentials.yaml'), 'utf8');
  let inCreds = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^(refs|credentials)\s*:\s*$/.test(line)) { inCreds = true; continue; }
    if (!inCreds) continue;
    const m = line.match(/^\s{2}([A-Z0-9_]+)\s*:\s*(.+?)\s*$/);
    if (m && /^[A-Z]/.test(m[1]) && !/^REFS?_/.test(m[1])) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const KEYS = loadKeys();

const childEnv = { ...process.env };
delete childEnv.NODE_OPTIONS; delete childEnv.BASH_ENV; delete childEnv.PYTHONPATH;
childEnv.DSH_HOME = HOME;
for (const k of Object.keys(KEYS)) childEnv[k] = KEYS[k];
childEnv.DSH_CREDENTIALS_PATH = path.join(HOME_ROOT, '.dsh', '.credentials.yaml');
if (LEG === 'envkill') childEnv.CM_DISABLED = 'true'; // kill-switch leg: plugin must not mount

async function rpc(method, payload, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}

async function waitForReady(deadlineMs = 60000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(BASE);
      if (!r.ok) throw new Error('root not ok');
    } catch { await sleep(800); continue; }
    // RPC route may mount slightly after the root handler — poll session.list
    // so the first session.create never hits a 404 race.
    try {
      const rr = await rpc('session.list', {}, 8000);
      if (rr?.result?.value) return true;
    } catch {}
    await sleep(800);
  }
  throw new Error('server not ready within deadline');
}

/** wait for one turn: poll session.list -> running true then false (+grace) */
async function waitIdle(sessionId, _sinceTs, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  let sawRunning = false;
  while (Date.now() < end) {
    await sleep(2000);
    let r;
    try { r = await rpc('session.list', {}, 15000); } catch { continue; }
    const item = r?.result?.value?.items?.find(x => x.sessionId === sessionId);
    if (!item) continue;
    if (item.running === true) sawRunning = true;
    if (sawRunning && item.running === false) {
      await sleep(2500); // persistence grace
      return true;
    }
  }
  return sawRunning ? 'timeout-after-start' : 'never-started';
}

/** last N history event types for diagnosis */
async function histTail(sessionId, n = 8) {
  try {
    const r = await rpc('session.history', { sessionId }, 15000);
    return (r?.result?.value?.events ?? []).slice(-n)
      .map(e => `${e.event?.type}@${e.event?.seq}`).join(',');
  } catch (e) { return `histErr:${String(e).slice(0, 80)}`; }
}

console.log(`[web] leg=${LEG} port=${PORT} home=${HOME}`);
const srv = spawn(process.execPath, [BIN, 'web', '--port', String(PORT)], {
  cwd: WORKDIR, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLogTail = [];
srv.stdout.on('data', d => { srvLogTail.push(String(d)); if (srvLogTail.length > 40) srvLogTail.shift(); });
srv.stderr.on('data', d => { srvLogTail.push('[e]' + String(d)); if (srvLogTail.length > 40) srvLogTail.shift(); });

const report = { leg: LEG, port: PORT, rounds: ROUNDS, ok: false };
try {
  await waitForReady();
  report.readyMs = Date.now() - t0();
  // create session bound to the gate workdir; explicit preset when present
  let created = null, createErr = null;
  for (const payload of [
    { cwd: WORKDIR, agentPreset: 'cm-drill' },
    { cwd: WORKDIR },
  ]) {
    try { created = await rpc('session.create', payload); break; }
    catch (e) { createErr = e.message; }
  }
  if (!created) throw new Error(`session.create failed: ${createErr}`);
  const value = created.result;
  if (!created.result?.ok) throw new Error(`create rejected: ${JSON.stringify(created.result).slice(0, 300)}`);
  const sessionId = created.result.value.sessionId;
  report.sessionId = sessionId;

  // failopen leg: seed a CORRUPT store file for this session before any prompt.
  // A damaged store must not block the task (plugin re-learns from raw events).
  if (LEG === 'failopen') {
    fs.writeFileSync(path.join(STATE, `${sessionId}.json`), '{not-valid-json!!', 'utf8');
    report.failopenSeeded = true;
  }
  const MISSING_AT = Math.floor(ROUNDS / 2); // missing leg: move state mid-session

  const prompts = [];
  for (let i = 0; i < ROUNDS; i++) {
    const f = String.fromCharCode(97 + i); // a b c d
    prompts.push(`创建文件 ${f}.txt 内容为 "${f}"，然后读取 note.txt 并把它的第一行附在回复结尾。这是第 ${i + 1}/${ROUNDS} 轮。`);
  }

  for (let i = 0; i < prompts.length; i++) {
    const before = Date.now();
    const pr = await rpc('session.prompt', {
      sessionId, mode: 'queue',
      content: [{ type: 'text', text: prompts[i] }],
    });
    if (!pr?.result?.ok) throw new Error(`prompt ${i + 1} rejected: ${JSON.stringify(pr?.result).slice(0, 200)}`);
    const s = await waitIdle(sessionId, before);
    console.log(`[web] round ${i + 1}/${prompts.length} settle=${s} in ${((Date.now() - before) / 1000).toFixed(0)}s`);
    report[`round${i + 1}`] = String(s);
    if (s !== true) { report.histTailAfterRound = i + 1; break; }
    // missing leg: move state dir away mid-session (after MISSING_AT rounds)
    if (LEG === 'missing' && i + 1 === MISSING_AT) {
      await sleep(2000);
      const stash = path.join(path.dirname(STATE), `state.moved-${Date.now()}`);
      fs.renameSync(STATE, stash);
      fs.mkdirSync(STATE, { recursive: true });
      report.missingMoved = true;
      report.missingStash = stash;
      console.log(`[web] missing drill: state dir moved -> ${stash}`);
    }
  }

  await sleep(3000);
  report.histTail = await histTail(sessionId);

  // verify created files a-d exist in workdir
  const expected = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
  const actual = fs.readdirSync(WORKDIR);
  report.workdirOk = expected.every(f => actual.includes(f));
  report.workdirUnexpected = actual.filter(f => !expected.includes(f) && f !== 'note.txt');

  await sleep(3000);
  const files = fs.existsSync(STATE)
    ? fs.readdirSync(STATE).filter(f => !f.startsWith('.'))
    : [];
  report.stateFiles = files;
  report.workdirFiles = fs.readdirSync(WORKDIR);
  report.serverAlive = srv.exitCode === null && !srv.killed;
  // leg-aware pass semantics:
  //  baseline/failopen -> at least one store file must exist (plugin active)
  //  envkill           -> CM_DISABLED, zero store files is the expected outcome
  //  failopen          -> corrupted seeded store must have been rebuilt (v>=1)
  //  missing           -> store was moved mid-session; plugin must have rebuilt
  //                       from raw events (>=1 store file again), server alive,
  //                       zero damage (no stray workdir files)
  let stateOk = LEG === 'envkill' ? files.length === 0 : files.length >= 1;
  if (LEG === 'failopen') {
    const p = path.join(STATE, `${sessionId}.json`);
    report.failopenRecovered = false;
    try {
      const store = JSON.parse(fs.readFileSync(p, 'utf8'));
      report.failopenRecovered = store.version >= 1 && store.sessionId === sessionId;
    } catch {}
  }
  if (LEG === 'missing') {
    const p = path.join(STATE, `${sessionId}.json`);
    report.missingRebuilt = false;
    try {
      const store = JSON.parse(fs.readFileSync(p, 'utf8'));
      report.missingRebuilt = store.version >= 1 && store.sessionId === sessionId;
    } catch {}
    report.missingMoved = report.missingMoved === true;
    report.missingStash = report.missingStash || null;
  }
  report.stateOk = stateOk;
  report.ok = stateOk && report.serverAlive && report.workdirOk &&
    (LEG !== 'failopen' || report.failopenRecovered === true) &&
    (LEG !== 'missing' || report.missingRebuilt === true);
  console.log(`[web] RESULT ${JSON.stringify(report)}`);
} catch (e) {
  report.error = String(e);
  report.logTail = srvLogTail.join('').slice(-2000);
  console.log(`[web] FAIL ${JSON.stringify(report)}`);
} finally {
  try { srv.kill(); } catch {}
  try { spawn('taskkill', ['/PID', String(srv.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
}
process.exitCode = report.ok ? 0 : 1;
function t0() { return t0._ ||= Date.now(); }
