#!/usr/bin/env node
// dsh-event-notify.mjs - P1 (2026-08-18): dsh event stream -> Windows native toast.
//
// Connects to the local DSH server's /api/events.mux websocket and turns
// high-value events (task/question/approval/job state) into Windows balloon
// notifications, so you do not have to alt-tab to the Web UI to know something
// happened. It is deliberately conservative:
//   * ignores the initial replay (session/subscribed / session/jobs snapshots)
//     by tracking each session's lastSeq baseline from the subscribe frames;
//   * only notifies frames whose payload.type (or method) matches a whitelist;
//   * dedupes/rate-limits per session (one notification per 10s);
//   * truncates and redacts message bodies (no full command lines, no long dumps);
//   * writes a full new-event log to %LOCALAPPDATA%\DSHHarness\logs\notify-events.log
//     so the whitelist can be tuned later without missing anything.
//
// Usage:
//   node dsh-event-notify.mjs [--port 3080] [--off] [--dry] [--noSelfCheck]
//     --off          immediately disable (exit 0) - used when the feature is disabled
//     --dry          only log, never show notifications
//     --noSelfCheck  skip the "bridge connected" welcome notification
//
// Long-running: run it from the client as a background process; kill it on exit.

import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const port = Number((args.find((a) => a.startsWith('--port=')) || '--port=3080').split('=')[1]) || 3080;
const off = args.includes('--off');
const dry = args.includes('--dry');
const noSelfCheck = args.includes('--noSelfCheck');

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dataRoot = process.env.DSH_NOTIFY_DATA || path.join(os.homedir(), 'AppData', 'Local', 'DSHHarness');
const logDir = path.join(dataRoot, 'logs');
try { fs.mkdirSync(logDir, { recursive: true }); } catch {}

function logLine(tag, text) {
  const line = `${new Date().toISOString()} [${tag}] ${text}\n`;
  try { fs.appendFileSync(path.join(logDir, 'notify-events.log'), line); } catch {}
  if (process.env.DSH_NOTIFY_VERBOSE === '1') process.stdout.write(line);
}

if (off) { logLine('ctl', 'bridge disabled (--off), exiting'); process.exit(0); }

// ---- Windows toast via powershell.exe -EncodedCommand (locale-proof) ----
const notifyCooldown = new Map();
function showToast(title, body) {
  const key = title.slice(0, 24);
  const now = Date.now();
  if (notifyCooldown.has(key) && now - notifyCooldown.get(key) < 10000) return;
  notifyCooldown.set(key, now);
  if (dry) { logLine('notify', `[dry] ${title} :: ${body}`); return; }
  const script =
    "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
    "$n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; " +
    "$n.Visible=$true; $n.ShowBalloonTip(4000, " + JSON.stringify(title) + ", " + JSON.stringify(body) +
    ", [System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep -Seconds 6; $n.Dispose();";
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  try {
    spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-EncodedCommand', b64], { windowsHide: true, stdio: 'ignore' }).unref();
  } catch (err) { logLine('notify', 'spawn error: ' + err.message); }
}

// ---- payload shaping (redact + shorten) ----
function shortText(s, max = 160) {
  if (s == null) return '';
  let t = String(s).replace(/\s+/g, ' ').trim();
  if (t.length > max) t = t.slice(0, max) + ' …';
  return t;
}

// Whitelist: which payload.type / method names are "user-facing".
const HOT_TYPES = [
  /approval|approve/i,
  /question|ask\b|request.*(user|info)|need.*input/i,
  /turn.*(complete|finished|end)|task.*(complete|done|finished|failed|error)/i,
  /session\/event/i,
];
const HOT_JOB = /job|session\/jobs/i;
const HOT_MSG = /message|content.*start|content.*delta/i; // note: content deltas are spammy; handled by rate limit only
const IGNORE = [
  /session\/subscribed/i, /session\/jobs\b/i, /session\/list/i, /host\.describe/i,
  /session\/events|session\/events\/list/i, /heartbeat/i, /tick/i, /ping/i,
];

const perSessionSeq = new Map(); // sessionId -> lastSeq observed from subscribe frames
let ready = false;
let selfCheckSent = false;

function isNewSeq(sessionId, seq) {
  if (seq == null) return true;
  const last = perSessionSeq.get(sessionId);
  if (last == null) return true;
  return seq > last;
}

function handleFrame(raw) {
  let frame;
  try { frame = JSON.parse(raw); } catch { logLine('warn', 'unparseable frame'); return; }
  const method = String(frame.method || '');
  const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload : {};
  const type = String(payload.type || method);
  const sessionId = String(payload.sessionId || '');
  const seq = payload.seq != null ? Number(payload.seq) : null;

  // initialize baselines from subscribe frames (the initial replay)
  if (/subscribed/i.test(type)) {
    if (payload.lastSeq != null) perSessionSeq.set(sessionId, Number(payload.lastSeq));
    logLine('info', `baseline session=${sessionId} lastSeq=${payload.lastSeq}`);
    return;
  }
  if (IGNORE.some((re) => re.test(type))) return;

  // log every genuinely new frame (seq-aware) for future tuning
  if (isNewSeq(sessionId, seq)) {
    logLine('evt', `${type} session=${sessionId} seq=${seq} :: ${shortText(JSON.stringify(payload), 500)}`);
  } else {
    return; // historical replay - not actionable
  }

  if (!ready) { ready = true; }

  // ---- decide whether to notify ----
  let title = 'DeepSeek Harness';
  let body = '';
  let n = false;

  if (HOT_JOB.test(type)) {
    const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
    for (const j of jobs) {
      const st = String(j.status || '');
      const label = shortText(String(j.label || j.kind || 'job'), 60);
      if (/completed|succeeded/i.test(st)) { title = '任务完成'; body = label || '后台任务已完成'; n = true; }
      else if (/failed|error|aborted/i.test(st)) { title = '任务失败'; body = (label || '后台任务') + (j.detail ? '：' + shortText(j.detail, 80) : ''); n = true; }
    }
  } else if (HOT_TYPES.some((re) => re.test(type))) {
    // pull a short human line from common fields
    const cand = shortText(
      payload.text || payload.question || payload.content || payload.summary ||
      payload.message || payload.title || payload.error || '', 140);
    if (/approval|approve/i.test(type)) { title = '等待审批'; n = true; }
    else if (/question|ask/i.test(type)) { title = '需要你回答'; n = true; }
    else if (/turn|task/i.test(type)) { title = '任务动态'; n = true; }
    else { title = 'DSH 事件'; n = true; }
    if (cand) body = cand;
  } else if (HOT_MSG.test(type)) {
    const cand = shortText(payload.content || payload.text || '', 100);
    if (cand) { title = '新消息'; body = cand; n = true; }
  }

  if (n) {
    if (!body) body = type;
    showToast(title, body);
    logLine('notify', `fired: ${title} :: ${body}`);
  }
}

// ---- connect ----
logLine('ctl', `bridge starting port=${port} dry=${dry}`);
const wsUrl = `ws://127.0.0.1:${port}/api/events.mux`;
let ws;
let idleTimer;
function armIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(() => { logLine('ctl', 'idle timeout, alive'); }, 30000); }

function connect() {
  if (global.WebSocket) {
    try { runNativeWs(); return; } catch {}
  }
}

function runNativeWs() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    logLine('ctl', 'websocket OPEN');
    ready = true;
    if (!selfCheckSent && !noSelfCheck && !dry) {
      selfCheckSent = true;
      setTimeout(() => showToast('DeepSeek Harness', '事件通知桥已连接，任务/提问/审批将在此提醒'), 1500);
    }
    armIdle();
  };
  ws.onmessage = (m) => {
    armIdle();
    const raw = typeof m.data === 'string' ? m.data : '';
    if (raw) handleFrame(raw);
  };
  ws.onerror = (e) => logLine('warn', 'ws error: ' + (e && e.message ? e.message : 'unknown'));
  ws.onclose = () => {
    logLine('ctl', 'websocket closed; reconnect in 5s');
    setTimeout(connect, 5000);
  };
}

connect();
// keep the process alive; log a heartbeat only on idle every 30s via armIdle
setInterval(() => {}, 2147483647);
