// runB-deepseek-control.mjs — DeepSeek continuation control (Run B)
// Same task, same driver, model = deepseek/deepseek-v4-flash-0731 on a
// dedicated route (no router interference). Machine-first, no manual continue.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3080;
const LOG = path.join(os.tmpdir(), 'runB-log.txt');
const log = (s) => { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + s + '\n'); console.log(s); };

function rpc(method, payload, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'b-' + Math.random().toString(16).slice(2), method, payload });
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
  const primSnap = await rpc('settings.describe', { ns: 'agent-default-model' });
  const prim = primSnap.value.namespaces.find((x) => x.ns === 'agent-default-model').value;
  log('primary: ' + prim.provider + '/' + prim.model);

  const route = 'openrouter-continuation-deepseek-' + Math.random().toString(16).slice(2, 10);
  const profile = { displayName: 'Cont DeepSeek Ctrl', apiKeyEnv: 'OPENROUTER_API_KEY', api: 'openai-completions',
    baseURL: 'https://openrouter.ai/api/v1', timeoutMs: 60000,
    models: [{ id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash (ctrl)', contextWindow: 1310720, maxTokens: 393216 }] };
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-cont-b-'));
  let sid = null;
  try {
    const m = await rpc('settings.mutate', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', route], value: profile }] });
    log('route: ' + route + ' created=' + m.ok);
    await sleep(2500);
    await rpc('settings.mutate', { ns: 'agent-default-model', ops: [{ op: 'set', path: ['provider'], value: route }, { op: 'set', path: ['model'], value: 'deepseek/deepseek-v4-flash-0731' }] });
    await sleep(2000);

    const task = fs.readFileSync(path.join(os.tmpdir(), 'ee-cont-task.txt'), 'utf8');
    const sc = await rpc('session.create', { cwd: ws });
    sid = sc.value && sc.value.sessionId;
    log('session: ' + sid + ' ok=' + sc.ok);
    const pr = await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: task }] }, 30000);
    log('prompt ok: ' + pr.ok + (pr.error ? ' ' + JSON.stringify(pr.error).slice(0, 200) : ''));

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

    const h2 = await rpc('session.history', { sessionId: sid });
    let lastAsst = '', futureTense = false;
    if (h2.ok && h2.value) {
      const ams = (h2.value.events || []).filter((e) => e.event.type === 'assistant/message');
      if (ams.length) {
        const blocks = ams[ams.length - 1].event.data.message.content || [];
        lastAsst = blocks.filter((b) => b.text).map((b) => b.text).join(' ');
        futureTense = /I will|Next I|I'll proceed|I am going|I will proceed|接下来我会|下一步我会|我现在将|我会继续|Let me|即将|准备/i.test(lastAsst);
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
