#!/usr/bin/env node
// probe.mjs: boot a leg web server, drive 1 round, dump FULL session history to a file.
// Usage: node probe.mjs <legId> [rounds]
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const LEG = process.argv[2];
const ROUNDS = Number(process.argv[3] || 1);
const HOME_ROOT = process.env.USERPROFILE || os.homedir();
const BIN = path.join(HOME_ROOT, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const GATE = path.join(HOME_ROOT, 'Desktop', 'sdeepseek harness', '_release-staging', 'tests', 'context-memory', 'gate7');
const LEG_DIR = path.join(GATE, 'legs', LEG);
const HOME = path.join(LEG_DIR, 'home');
const WORKDIR = path.join(LEG_DIR, 'workdir');
const STATE = path.join(LEG_DIR, 'state');
const PORTS = { baseline: 3188, failopen: 3189, envkill: 3190 };
const PORT = PORTS[LEG] || 3200;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(LEG_DIR, 'probe-history.jsonl');

fs.rmSync(WORKDIR, { recursive: true, force: true }); fs.mkdirSync(WORKDIR, { recursive: true });
fs.writeFileSync(path.join(WORKDIR, 'note.txt'), 'Hello from note.txt', 'utf8');
fs.rmSync(STATE, { recursive: true, force: true }); fs.mkdirSync(STATE, { recursive: true });

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
if (LEG === 'envkill') childEnv.CM_DISABLED = 'true';

async function rpc(method, payload, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}
async function waitRpc(deadlineMs = 60000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try { const r = await rpc('session.list', {}, 8000); if (r?.result?.value) return true; } catch {}
    await sleep(800);
  }
  throw new Error('RPC not ready within deadline');
}

const srv = spawn(process.execPath, [BIN, 'web', '--port', String(PORT)], { cwd: WORKDIR, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
srv.stdout.on('data', d => log += String(d));
srv.stderr.on('data', d => log += '[e]' + String(d));

try {
  await waitRpc();
  const created = await rpc('session.create', { cwd: WORKDIR, agentPreset: 'cm-drill' });
  if (!created?.result?.ok) throw new Error('create rejected: ' + JSON.stringify(created?.result).slice(0, 200));
  const sessionId = created.result.value.sessionId;
  console.log('sessionId', sessionId);
  if (LEG === 'failopen') fs.writeFileSync(path.join(STATE, `${sessionId}.json`), '{not-valid-json!!', 'utf8');

  for (let i = 0; i < ROUNDS; i++) {
    const f = String.fromCharCode(97 + i);
    const t0 = Date.now();
    const pr = await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: `创建文件 ${f}.txt 内容为 "${f}"，然后读取 note.txt 并把它的第一行附在回复结尾。这是第 ${i + 1}/${ROUNDS} 轮。` }] });
    if (!pr?.result?.ok) throw new Error(`prompt rejected: ${JSON.stringify(pr?.result).slice(0, 200)}`);
    // wait idle
    for (;;) {
      await sleep(2000);
      const r = await rpc('session.list', {}, 15000);
      const item = r?.result?.value?.items?.find(x => x.sessionId === sessionId);
      if (!item) continue;
      if (item.running === false) { await sleep(2500); break; }
    }
    console.log(`round ${i + 1} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  const hist = await rpc('session.history', { sessionId }, 20000);
  const events = hist?.result?.value?.events ?? [];
  fs.writeFileSync(OUT, events.map(e => JSON.stringify(e)).join('\n'), 'utf8');
  console.log('events', events.length, '->', OUT);
  // summarize types
  const types = {};
  for (const e of events) { const t = e.event?.type || '(no type)'; types[t] = (types[t] || 0) + 1; }
  console.log('typeCounts', JSON.stringify(types));
  // assistant messages (text + tool calls)
  for (const e of events) {
    const t = e.event?.type;
    if (t === 'assistant' || t === 'assistant/chunk') {
      const txt = e.event?.message?.content;
      if (Array.isArray(txt)) {
        for (const p of txt) {
          if (p.type === 'text') console.log('  [assistant text]', String(p.text).slice(0, 300));
          if (p.type === 'tool_use') console.log('  [TOOL_CALL]', p.name, JSON.stringify(p.input).slice(0, 200));
        }
      }
    }
    if (t === 'tool/call') console.log('  [tool/call]', e.event?.name || e.event?.toolName, JSON.stringify(e.event?.input || {}).slice(0, 150));
    if (t === 'llm/error' || t === 'llm/retry') console.log('  [' + t + ']', JSON.stringify(e.event).slice(0, 250));
  }
} catch (e) {
  console.log('PROBE FAIL', String(e));
  console.log(log.slice(-1500));
} finally {
  try { srv.kill(); } catch {}
  try { spawn('taskkill', ['/PID', String(srv.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
}
