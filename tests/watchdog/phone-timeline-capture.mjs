#!/usr/bin/env node
// phone-timeline-capture.mjs —— Phase 02.8 PHONE-2/3/4 延迟时间线采集器
// 用途：在 probe goal 状态切换 / OFFLINE 注入 / 恢复 期间，双侧同步采样：
//   侧A（权威）：adapter http://127.0.0.1:8091/watchdog/status（Bearer token，
//                token 从 ~/.dsh/.credentials.yaml WATCHDOG_TOKEN 读取，绝不打印）
//   侧B（手机）：adb run-as com.dsh.watchdog.widget cat shared_prefs/dsh_watchdog_diag.xml
//                （last_push_received_at / last_push_event_id / last_fetch_trigger /
//                  last_fetch_updated_at / last_fetch_error_at）
// 输出：JSONL（每行一个采样点 + 检测到的状态跃迁事件），脱敏（无 token、无 event id 原文全串保留但仅本地文件）。
// 用法：node phone-timeline-capture.mjs [--duration 120] [--interval 2000] [--out <path>]
//      不传 --out 时写到 tests/watchdog/out/phone-timeline-<ts>.jsonl

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
function argOf(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const durationSec = parseInt(argOf('--duration', '120'), 10);
const intervalMs = Math.max(800, parseInt(argOf('--interval', '2000'), 10));
const outArg = argOf('--out', null);

// ---- token（侧A）----
function readWatchdogToken() {
  if (process.env.WATCHDOG_TOKEN) return process.env.WATCHDOG_TOKEN.trim();
  const f = process.env.WATCHDOG_TOKEN_FILE || join(homedir(), '.dsh', 'watchdog', 'token');
  return readFileSync(f, 'utf8').trim(); // 与 adapter server.mjs 同源；值绝不打印
}

const ADB = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe')
  : 'adb';

function sampleAdapter(token) {
  try {
    const res = execFileSync('node', ['-e', `
      const http=require('http');
      const req=http.get({host:'127.0.0.1',port:8091,path:'/watchdog/status',headers:{Authorization:'Bearer '+process.env.T}},r=>{
        let b='';r.on('data',c=>b+=c);r.on('end',()=>{const code=r.statusCode;console.log(JSON.stringify({code,body:code===200?JSON.parse(b):null}))});
      });
      req.on('error',e=>console.log(JSON.stringify({code:0,body:null,err:String(e.message).slice(0,60)})));
      req.setTimeout(6000,()=>{req.destroy();console.log(JSON.stringify({code:0,body:null,err:'timeout'}))});
    `], { env: { ...process.env, T: token }, timeout: 8000, encoding: 'utf8' });
    const j = JSON.parse(res.trim().split(/\r?\n/).pop());
    if (j.code !== 200 || !j.body) return { http: j.code, state: null, err: j.err || null };
    return {
      http: 200,
      state: j.body.state,
      taskName: j.body.task?.name ?? null,
      revision: j.body.task?.revision ?? 0,
      goalIdShort: (j.body.task?.goalId ?? '').slice(0, 8),
      generatedAt: j.body.generatedAt,
      model: j.body.model ? `${j.body.model.provider}/${j.body.model.model}` : null,
      otherGoals: Array.isArray(j.body.otherGoals) ? j.body.otherGoals.length : 0,
    };
  } catch (e) {
    return { http: 0, state: null, err: String(e.message).slice(0, 60) };
  }
}

function samplePhoneDiag() {
  try {
    const xml = execFileSync(ADB,
      ['shell', 'run-as com.dsh.watchdog.widget cat shared_prefs/dsh_watchdog_diag.xml'],
      { timeout: 8000, encoding: 'utf8' });
    const pick = (k) => {
      const m = xml.match(new RegExp(`<string name="${k}">([^<]*)</string>`));
      return m ? m[1] : null;
    };
    return {
      reachable: true,
      last_push_received_at: pick('last_push_received_at'),
      last_push_event_id: pick('last_push_event_id'),
      last_fetch_trigger: pick('last_fetch_trigger'),
      last_fetch_updated_at: pick('last_fetch_updated_at'),
      last_fetch_error_at: pick('last_fetch_error_at'),
    };
  } catch (e) {
    return { reachable: false, err: String(e.message).slice(0, 60) };
  }
}

const outPath = outArg || (() => {
  const d = join(process.cwd(), 'out');
  mkdirSync(d, { recursive: true });
  return join(d, `phone-timeline-${Date.now()}.jsonl`);
})();
mkdirSync(outPath.slice(0, outPath.lastIndexOf('\\') > 0 ? outPath.lastIndexOf('\\') : outPath.lastIndexOf('/')) || '.', { recursive: true });
writeFileSync(outPath, '');

let prevState = null;
let samples = 0;
const t0 = Date.now();
console.log(`[timeline] capturing ${durationSec}s every ${intervalMs}ms -> ${outPath}`);
while ((Date.now() - t0) / 1000 < durationSec) {
  const ts = Date.now();
  const a = sampleAdapter(readWatchdogToken());
  const p = samplePhoneDiag();
  const rec = { t: ts, adapter: a, phone: p };
  appendFileSync(outPath, JSON.stringify(rec) + '\n');
  samples++;
  if (a.state !== prevState) {
    const ev = { t: ts, event: 'state_transition', from: prevState, to: a.state };
    appendFileSync(outPath, JSON.stringify(ev) + '\n');
    console.log(`[${new Date(ts).toISOString()}] STATE ${String(prevState)} -> ${a.state} (http=${a.http}${p.reachable ? `, push_at=${p.last_push_received_at}` : ', phone unreachable'})`);
    prevState = a.state;
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}
console.log(`[timeline] done: ${samples} samples -> ${outPath}`);
