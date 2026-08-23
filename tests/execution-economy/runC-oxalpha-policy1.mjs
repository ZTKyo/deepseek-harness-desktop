// runA-oxalpha-baseline.mjs 鈥?ox-alpha continuation baseline (Run A)
// Drives: create OX_ROUTE -> point primary -> session.create -> prompt
// (13-step harmless file task) -> poll up to 10 min -> record -> cleanup.
// Machine-first only. No manual continue. try/finally cleanup.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const PORT = 3080;
const LOG = path.join(os.tmpdir(), 'runC-log.txt');
const log = (s) => { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + s + '\n'); console.log(s); };

function rpc(method, payload, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'a-' + Math.random().toString(16).slice(2), method, payload });
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/' + method, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => { try { resolve(JSON.parse(d).result); } catch { resolve({ ok: false }); } });
    });
    req.on('error', () => resolve({ ok: false, error: 'conn' }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body); req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log('START');
  // snapshot primary
  const primSnap = await rpc('settings.describe', { ns: 'agent-default-model' });
  const prim = primSnap.value.namespaces.find((x) => x.ns === 'agent-default-model').value;
  log('primary: ' + prim.provider + '/' + prim.model);

  const route = 'openrouter-continuation-policy-' + Math.random().toString(16).slice(2, 10);
  const profile = { displayName: 'Cont Test C', apiKeyEnv: 'OPENROUTER_API_KEY', api: 'openai-completions',
    baseURL: 'https://openrouter.ai/api/v1', timeoutMs: 120000,
    models: [{ id: 'stealth/ox-alpha', name: 'Ox Alpha cont', contextWindow: 1048576, maxTokens: 131072, input: ['text', 'image'] }] };
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-cont-c-'));
  let sid = null;
  try {
    const m = await rpc('settings.mutate', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', route], value: profile }] });
    log('route: ' + route + ' created=' + m.ok);
    await sleep(2500);
    await rpc('settings.mutate', { ns: 'agent-default-model', ops: [{ op: 'set', path: ['provider'], value: route }, { op: 'set', path: ['model'], value: 'stealth/ox-alpha' }] });
    await sleep(2000);

    const policy = fs.readFileSync(path.join('C:/Users/Administrator/Desktop/sdeepseek harness/_release-staging/tests/execution-economy', 'continuation-policy.txt'), 'utf8');
const baseTask = fs.readFileSync(path.join(os.tmpdir(), 'ee-cont-task.txt'), 'utf8');
const task = policy + '\n\n--- TASK ---\n\n' + baseTask;
    const sc = await rpc('session.create', { cwd: ws });
    sid = sc.value && sc.value.sessionId;
    log('session: ' + sid + ' ok=' + sc.ok + (sc.error ? ' ' + JSON.stringify(sc.error).slice(0, 150) : ''));
    const pr = await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: task }] }, 30000);
    log('prompt ok: ' + pr.ok + (pr.error ? ' ' + JSON.stringify(pr.error).slice(0, 200) : ''));

    // poll up to 10 min
    const deadline = Date.now() + 10 * 60 * 1000;
    let turnEnd = null, tools = 0, steps = 0, chunks = 0, headers = [];
    while (Date.now() < deadline && !turnEnd) {
      await sleep(10000);
      const h = await rpc('session.history', { sessionId: sid });
      if (h.ok && h.value) {
        let nt = 0;
        for (const e of h.value.events || []) {
          if (e.event.type === 'turn/end') turnEnd = e.event.data;
          if (e.event.type === 'tool/call') nt++;
          if (e.event.type === 'step/start') steps++;
          if (e.event.type === 'assistant/chunk') chunks++;
          if (e.event.type === 'request/header') { const c = e.event.data.header.config || {}; headers.push(c.provider + '/' + c.model); }
        }
        if (nt > tools) { tools = nt; log('progress: tools=' + tools + ' at ' + new Date().toISOString().slice(11, 19)); }
      }
    }
    log('turnEnd: ' + (turnEnd ? turnEnd.reason.kind : 'TIMEOUT') + ' tools=' + tools + ' steps=' + steps + ' chunks=' + chunks);
    log('headers: ' + (headers.join(' | ') || '(none)'));

    // last assistant message
    const h2 = await rpc('session.history', { sessionId: sid });
    let lastAsst = '', futureTense = false;
    if (h2.ok && h2.value) {
      const ams = (h2.value.events || []).filter((e) => e.event.type === 'assistant/message');
      if (ams.length) {
        const blocks = ams[ams.length - 1].event.data.message.content || [];
        lastAsst = blocks.filter((b) => b.text).map((b) => b.text).join(' ');
        futureTense = /I will|Next I|I'll proceed|I am going|I will proceed|鎺ヤ笅鏉ユ垜浼殀涓嬩竴姝ユ垜浼殀鎴戠幇鍦ㄥ皢|鎴戜細缁х画|Let me|鍗冲皢|鍑嗗/i.test(lastAsst);
      }
    }
    log('lastAsst futureTense=' + futureTense);
    log('lastAsst: ' + lastAsst.slice(0, 600));
  } finally {
    await rpc('settings.mutate', { ns: 'llm-pi-ai', ops: [{ op: 'unset', path: ['providers', route] }] });
    await rpc('settings.mutate', { ns: 'agent-default-model', ops: [{ op: 'set', path: ['provider'], value: prim.provider }, { op: 'set', path: ['model'], value: prim.model }] });
    fs.rmSync(ws, { recursive: true, force: true });
    log('CLEANUP DONE');
  }
}
main().catch((e) => log('ERROR: ' + e.message));

