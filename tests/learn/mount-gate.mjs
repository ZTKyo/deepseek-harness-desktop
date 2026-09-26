#!/usr/bin/env node
/**
 * 挂载级门禁（mount gate）—— 真实加载器 / 真实宿主 / 真实 Cordis inject 语义
 *
 * 为什么需要它（2026-09-26 生产事故）：
 *   learn.mjs 在 apply 期**裸访问未注入的服务** `ctx.sessions`（inject 只声明了 tools），
 *   Cordis 对未注入服务的裸属性访问**直接抛** `cannot get property "sessions" without inject`，
 *   访问发生在 apply 期 ⇒ **整棵 profile boot 失败、服务起不来**（生产实测：日志 270 次，
 *   重启事务连续 83 次 FAILED）。既有两层验证都抓不到：
 *     · tests 里的 apply() 隔离测试用普通对象 mock ctx（无 inject 守卫）⇒ 假绿；
 *     · restart-dsh-server-delayed.ps1 -PreflightOnly 只查"引用文件存在 + YAML 合法"⇒ 放行。
 *   本门禁补上缺的那一层：**用真实 dsh profile 启动 + 真实 loader** 去挂载候选插件。
 *
 * 观测方式（吃过两次坑后的定稿）：
 *   ① 不用日志里插件自己的 diag 行做判定 —— `ctx.logger.info` 不落到进程 stdout（实测）。
 *   ② 不"HTTP 200 就立刻读日志" —— 崩溃/告警日志常在进程退出**之后**才落盘（实测：会造成假 PASS）。
 *   ③ 改为在同一 patch 里先挂一个**探针插件**（只 inject tools，与 learn 同形上下文），
 *      它包裹 `ctx.tools.register` 记录注册名，并把结果写 JSON 文件交给门禁读 ⇒ 客观、可重复。
 *
 * 隔离设计：不 boot 生产 web profile（会连带第二个 telegram 轮询/守护），而是新建临时 profile
 *   `~/.dsh/profiles/_mountgate-<slug>/`（只声明 dsh-base + dsh-web-app 基座；cordis.patch.yml
 *   只挂 探针 + learn；候选插件**整个插件目录**拷入；learn 的 stateDir 指向临时目录）；
 *   结束删除临时 profile（--keep 保留）。
 *
 * 断言：
 *   A1 无 loader 失败签名（failed to apply/import loader entry / plugin tree failed to load）
 *   A2 探针捕获到**恰好 6 个** learn_* 工具名且**无重复**（= apply 跑到底、工具面就位）
 *   A3 同形上下文里 `ctx.get('sessions')` 解析到服务（= 修复后 sessions 真能在岗，
 *      不是把"起不来"换成"F1 人类批准信任锚静默失效"）
 *   A4 日志无 `tool surface unavailable` / `expected 6 tool specs, collected` 告警
 *   A5 全程未触碰生产：3080 监听者 PID 前后一致
 *
 * 用法：node tests/learn/mount-gate.mjs --plugin <learn.mjs 绝对路径> [--expect pass|fail]
 *        [--port 3099] [--timeout 90] [--slug name] [--keep]
 *   --expect fail = 反例自证：要求出现失败签名 + inject 事故签名
 * 退出码：0 符合预期；1 不符合；2 参数/环境错误
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const HOME = os.homedir();
const PROFILES = path.join(HOME, '.dsh', 'profiles');
const WEB_PROFILE = path.join(PROFILES, 'web');
const DSH_BIN = path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const NODE_RUNTIME = path.join(REPO, 'DSH-Client', 'node-runtime', 'node.exe');
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
const EXPECTED_TOOLS = ['learn_propose', 'learn_review', 'learn_recall', 'learn_promote', 'learn_verify', 'learn_status'];

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);
const PLUGIN = opt('plugin', null);
const EXPECT = opt('expect', 'pass');
const PORT = Number(opt('port', '3099'));
const TIMEOUT = Number(opt('timeout', '90'));
const SLUG = opt('slug', 'candidate').replace(/[^a-zA-Z0-9_-]/g, '');
const KEEP = flag('keep');

const say = (...a) => console.log(...a);
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const failEnv = (m) => { say('ENV_ERROR: ' + m); process.exit(2); };

if (!PLUGIN) failEnv('缺少 --plugin <learn.mjs 绝对路径>');
if (!fs.existsSync(PLUGIN)) failEnv('插件文件不存在: ' + PLUGIN);
if (!fs.existsSync(DSH_BIN)) failEnv('找不到 dsh bin: ' + DSH_BIN);
if (PORT === 3080) failEnv('禁止使用生产端口 3080（本门禁只跑隔离端口）');
if (!['pass', 'fail'].includes(EXPECT)) failEnv('--expect 只能是 pass|fail');

function prodPid() {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command',
      "(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)"],
      { encoding: 'utf8' }).trim();
  } catch { return ''; }
}
function cmdlineOf(pid) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CommandLine)`],
      { encoding: 'utf8' }).trim();
  } catch { return ''; }
}
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const scratch = path.join(os.tmpdir(), `dsh-mountgate-${SLUG}-${stamp}`);
const stateDir = path.join(scratch, 'state');
const probeOut = path.join(scratch, 'probe.json');
const logPath = path.join(scratch, 'boot.log');
const resultPath = path.join(scratch, 'result.json');
const profileName = `_mountgate-${SLUG}`;
const profileDir = path.join(PROFILES, profileName);
fs.mkdirSync(stateDir, { recursive: true });

const prodBefore = prodPid();
say('=== mount gate (isolated profile) ===');
say(`  plugin      : ${PLUGIN}`);
say(`  sha256      : ${sha256(PLUGIN)}`);
say(`  expect      : ${EXPECT}`);
say(`  port        : ${PORT}   (production 3080 PID before = ${prodBefore || 'n/a'})`);
say(`  scratch     : ${scratch}`);

// ---- 1) 临时 profile ----
fs.rmSync(profileDir, { recursive: true, force: true });
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
  name: `dsh-profile-${profileName.replace(/^_/, '')}`, private: true,
  dependencies: { undici: '^8.10.0' },
  dsh: { profile: { bundles: BUNDLES } },
}, null, 2) + '\n', 'utf8');
if (!fs.existsSync(path.join(PROFILES, 'node_modules', 'undici'))) {
  const src = path.join(WEB_PROFILE, 'node_modules');
  if (fs.existsSync(path.join(src, 'undici'))) {
    try { fs.symlinkSync(src, path.join(profileDir, 'node_modules'), 'junction'); say('  deps        : junction -> web/node_modules'); } catch (e) { say('  deps        : junction 失败 ' + e.message); }
  }
}

// 候选插件 + **整个插件目录**（相对依赖闭包）拷入临时 profile
const copied = [];
const pluginDir = path.dirname(PLUGIN);
let pluginCount = 0;
for (const ent of fs.readdirSync(pluginDir, { withFileTypes: true })) {
  if (!ent.isFile() || !ent.name.endsWith('.mjs')) continue;
  const src = path.join(pluginDir, ent.name);
  const dstName = ent.name === path.basename(PLUGIN) ? 'learn.mjs' : ent.name;
  fs.copyFileSync(src, path.join(profileDir, dstName));
  pluginCount++;
  copied.push({ name: dstName, sha256: sha256(src) });
}
if (!fs.existsSync(path.join(pluginDir, 'learn-core.mjs'))) failEnv(`候选目录缺少必要依赖: ${path.join(pluginDir, 'learn-core.mjs')}`);

// 探针插件（只 inject tools，与 learn 同形上下文）
fs.writeFileSync(path.join(profileDir, '_mountgate-probe.mjs'), `
import fs from 'node:fs';
export const name = 'mountgate-probe';
export const inject = ['tools'];
export function apply(ctx, cfg) {
  const out = cfg.out;
  const seen = [];
  let wrapped = false, wrapError = null;
  try {
    const orig = ctx.tools.register.bind(ctx.tools);
    ctx.tools.register = (spec) => { try { seen.push(spec?.name ?? '(anon)'); } catch {} return orig(spec); };
    wrapped = true;
  } catch (e) { wrapError = String(e?.message ?? e); }
  let sessionsViaGet = 'unknown';
  try { const s = ctx.get('sessions'); sessionsViaGet = s ? (typeof s.get === 'function' ? 'resolved' : 'present-no-get') : 'absent'; } catch (e) { sessionsViaGet = 'threw:' + String(e?.message ?? e); }
  const toolsKeys = (() => { try { return Object.keys(ctx.tools ?? {}); } catch { return null; } })();
  const dump = () => { try { fs.writeFileSync(out, JSON.stringify({ wrapped, wrapError, seen, sessionsViaGet, toolsKeys, at: Date.now() }, null, 2)); } catch {} };
  dump(); setTimeout(dump, 3000); setTimeout(dump, 8000);
}
`, 'utf8');

const yml = [
  '# mount gate generated patch (isolated profile): probe first, then the candidate',
  '- insert:',
  '    - id: mountgate-probe',
  "      name: './_mountgate-probe.mjs'",
  '      config:',
  `        out: '${probeOut.replace(/\\/g, '/')}'`,
  '    - id: learn',
  "      name: './learn.mjs'",
  '      config:',
  '        enabled: true',
  '        autoPropose: true',
  '        minTurnsForLearning: 4',
  '        minNewNodes: 4',
  '        maxDigestTurns: 40',
  `        stateDir: '${stateDir.replace(/\\/g, '/')}'`,
  '',
].join('\n');
fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), yml, 'utf8');

// ---- 2) 真实启动 ----
const nodeExe = fs.existsSync(NODE_RUNTIME) ? NODE_RUNTIME : process.execPath;
say(`  launch      : ${path.basename(nodeExe)} bin.js --profile ${profileName} --port ${PORT} --no-open  (${pluginCount} 个插件文件已就位)`);
const fd = fs.openSync(logPath, 'a');
const child = spawn(nodeExe, [DSH_BIN, '--profile', profileName, '--port', String(PORT), '--no-open'], { stdio: ['ignore', fd, fd], windowsHide: true });
const childPid = child.pid;
say(`  child pid   : ${childPid}`);

const FAIL_SIG = /failed to (apply|import) loader entry|plugin tree failed to load|without inject/;
const readLog = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '');
const readProbe = () => { try { return JSON.parse(fs.readFileSync(probeOut, 'utf8')); } catch { return null; } };

let ready = false; let exited = null; let signal = 'timeout';
child.on('exit', (code) => { exited = code; });
const deadline = Date.now() + TIMEOUT * 1000;
while (Date.now() < deadline) {
  const t = readLog();
  if (FAIL_SIG.test(t)) { signal = 'failure-signature'; break; }
  const p = readProbe();
  if (p && Array.isArray(p.seen) && p.seen.length >= EXPECTED_TOOLS.length) { signal = 'probe-recorded'; break; }
  if (exited !== null) { signal = `process-exited(${exited})`; break; }
  try { const r = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: 'manual' }); if (r.status === 200) ready = true; } catch {}
  await new Promise((r) => setTimeout(r, 800));
}
await new Promise((r) => setTimeout(r, 2500));   // 崩溃日志常晚于进程退出才落盘（实测坑）
const text = readLog();
const probe = readProbe();
say(`  readiness   : ${ready ? 'HTTP 200' : (exited !== null ? `process exited (code=${exited})` : '未起服务')}`);
say(`  signal      : ${signal}`);

// ---- 3) 判定 ----
const has = (re) => re.test(text);
const seen = probe?.seen ?? [];
const learnTools = seen.filter((n) => typeof n === 'string' && n.startsWith('learn_'));
const dupes = learnTools.filter((n, i) => learnTools.indexOf(n) !== i);
const checks = [
  { id: 'A1', desc: 'no loader failure signature', pass: !FAIL_SIG.test(text) },
  { id: 'A2', desc: `probe captured exactly ${EXPECTED_TOOLS.length} learn_* tools, no duplicates (got ${learnTools.length})`,
    pass: learnTools.length === EXPECTED_TOOLS.length && dupes.length === 0 && EXPECTED_TOOLS.every((n) => learnTools.includes(n)) },
  { id: 'A3', desc: `sessions resolvable via ctx.get in same-shape ctx (got ${probe?.sessionsViaGet ?? 'n/a'})`, pass: probe?.sessionsViaGet === 'resolved' },
  { id: 'A4', desc: 'no tool-surface warnings in log', pass: !has(/tool surface unavailable/) && !has(/expected 6 tool specs, collected/) },
];
const injectSignature = has(/cannot get property "sessions" without inject/);

// ---- 4) 收尾（先证明要杀的是本门禁自己拉起的进程）----
const cl = cmdlineOf(childPid);
const safeToKill = cl.includes(`--profile ${profileName}`) && !cl.includes('3080');
say(`  kill guard  : pid=${childPid} safeToKill=${safeToKill}${cl ? '' : ' (进程已自行退出)'}`);
if (safeToKill) killTree(childPid);
try { fs.closeSync(fd); } catch {}
const prodAfter = prodPid();

const allPass = checks.every((c) => c.pass);
const verdict = EXPECT === 'pass'
  ? ((allPass && ready) ? 'PASS' : 'FAIL')
  : ((!checks[0].pass && injectSignature) ? 'PASS' : 'FAIL');

const result = {
  slug: SLUG, plugin: PLUGIN, pluginSha256: sha256(PLUGIN), expect: EXPECT, verdict,
  port: PORT, ready, childExited: exited, signal, injectSignature, checks, probe, learnTools, dupes,
  copiedCount: copied.length, copied,
  prodPidBefore: prodBefore, prodPidAfter: prodAfter, prodUntouched: prodBefore === prodAfter,
  logPath, probeOut, resultPath, scratch, at: new Date().toISOString(),
};
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');

say('--- checks ---');
for (const c of checks) say(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.id}  ${c.desc}`);
say(`  probe.wrapped=${probe?.wrapped} sessionsViaGet=${probe?.sessionsViaGet} seen=[${seen.join(', ')}]`);
say(`  injectSignature(事故签名) = ${injectSignature}`);
say(`  production 3080 PID: before=${prodBefore} after=${prodAfter} untouched=${prodBefore === prodAfter}`);
if (!allPass) {
  const tail = text.split(/\r?\n/).filter((l) => /error|failed/i.test(l)).slice(-5);
  for (const l of tail) say('  | ' + l.slice(0, 170));
}
say(`--- verdict: ${verdict} (expect=${EXPECT}) ---`);
say(`  result json : ${resultPath}`);
if (!KEEP) { try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {} }
else say(`  tmp profile kept : ${profileDir}`);
process.exit(verdict === 'PASS' ? 0 : 1);
