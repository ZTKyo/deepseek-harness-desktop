// dsh-launcher.js - Observable runner for the dsh web server.
// Spawned by start-dsh-server.ps1; owns the dsh child until it exits, writes
// child lifecycle state, and sends stdout/stderr directly to an append-only
// log handle. It must not exit after a fixed delay: that hid child exits and
// left the old pipe relay without an observer.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
// Expected args: <nodeExe> <dshEntry> <port> <logFile>
const nodeExe = args[0];
const dshEntry = args[1];
const port = args[2] || '3080';
const logFile = args[3] || '';
const runtimeFile = args[4] || (logFile ? path.join(path.dirname(logFile), `dsh-runtime-${port}.json`) : '');

function now() { return new Date().toISOString(); }
function safeHashText(value) {
  try {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
  } catch (_) { return null; }
}
function writeRuntime(state) {
  if (!runtimeFile) return;
  const payload = {
    state,
    port: String(port),
    launcherPid: process.pid,
    childPid: child && child.pid ? child.pid : null,
    startedAt,
    updatedAt: now(),
    exitCode: exitCode === undefined ? null : exitCode,
    signal: exitSignal || null,
    entryHash: safeHashText(dshEntry)
  };
  const tmp = `${runtimeFile}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload) + '\n', 'utf8');
    try { fs.renameSync(tmp, runtimeFile); }
    catch (_) {
      try { fs.rmSync(runtimeFile, { force: true }); } catch (__) {}
      fs.renameSync(tmp, runtimeFile);
    }
  } catch (_) {
    // Lifecycle logging must never prevent the child from starting/exiting.
    try { fs.rmSync(tmp, { force: true }); } catch (__) {}
  }
}
function logLine(line) {
  if (!logFile) return;
  try { fs.appendFileSync(logFile, `${now()}  ${line}\n`, 'utf8'); } catch (_) {}
}

const startedAt = now();
let exitCode;
let exitSignal;
let child;

// Append a start marker (do NOT truncate: boot failures must stay visible)
if (logFile) {
  try { fs.appendFileSync(logFile, `\n===== dsh server runner start ${startedAt} (port ${port}, launcher ${process.pid}) =====\n`, 'utf8'); } catch (_) {}
}

// Mobile access via Tailscale serve (2026-08-16): the server stays on loopback
// (dsh web refuses --host 0.0.0.0 for safety) and `tailscale serve --http=3080`
// forwards the Tailscale IP's 3080 to 127.0.0.1:3080; the /api browser-trust
// fence accepts the Tailscale authority via --trusted-host.
// Reliability v1 (Stage D/E): non-normal boot modes use an isolated profile.
// R3 (Reviewer Round 2): three-way merge — keep BOTH the boot-mode profile
// wiring (baseline) AND the R1 runtime behavior (--no-open + trusted-host).
const bootMode = process.env.DSH_BOOT_MODE || 'normal';
const profileArgs = (bootMode === 'safe' || bootMode === 'experimental')
  ? ['--profile', bootMode]
  : [];
const trustedHosts = ['--trusted-host', '100.120.3.29:3080', '--trusted-host', 'ai-office-windows.tailab0bb5.ts.net:3080'];
child = spawn(nodeExe, [dshEntry, ...profileArgs, 'web', '--port', port, '--no-open', ...trustedHosts], {
  cwd: process.env.USERPROFILE,
  env: { ...process.env },
  stdio: ['ignore', logFile ? fs.openSync(logFile, 'a') : 'ignore', logFile ? fs.openSync(logFile, 'a') : 'ignore'],
  detached: false
});

writeRuntime('running');
logLine(`child spawned pid=${child.pid}`);

let finalized = false;
function finalize(code, signal) {
  if (finalized) return;
  finalized = true;
  exitCode = code;
  exitSignal = signal;
  writeRuntime('exited');
  logLine(`child exit code=${code === null ? 'null' : code} signal=${signal || 'none'}`);
  process.exit(typeof code === 'number' ? code : 1);
}

child.on('error', (error) => {
  logLine(`child spawn/error ${error && error.message ? error.message : String(error)}`);
  finalize(1, null);
});
child.on('exit', (code, signal) => finalize(code, signal));
process.on('SIGINT', () => { try { child.kill(); } catch (_) {} });
process.on('SIGTERM', () => { try { child.kill(); } catch (_) {} });
