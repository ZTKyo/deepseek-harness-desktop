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
 *   A5 【记录项，**不是**判定项】全程未触碰生产：127.0.0.1:3080 的监听者（`pid:proc`）前后一致。
 *      为何不算进 verdict：生产服务可能因 guardian 自愈重启等**无关原因**变化，硬判定会抖动；
 *      真正"不碰生产"的保证是下面的 kill-guard：只杀命令行含本门禁 profile 名且不含 3080 的进程。
 *      另注：3080 上可能同时有 tailscaled 在 Tailscale 地址上代理监听，故只取 loopback 行。
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

// ⚠️ 只认 127.0.0.1 上的监听者：Windows 上 3080 可能**同时**被 tailscaled 在 Tailscale 地址
// （fd7a:…、100.x）上代理监听；旧实现用 `| Select-Object -First 1` 会随机抓到 tailscaled，
// 于是"生产 PID 前后一致"变成了**空检查**（由独立复核 REVIEW_R2_INDEPENDENT §5-② 发现）。
// 现在只取 loopback 行并带上进程名（形如 "3780:node"）；无监听时返回空串（= 本机无生产服务）。
function prodListener() {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command',
      "$c = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -First 1; if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; \"$($c.OwningProcess):$($p.ProcessName)\" }"],
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

const prodBefore = prodListener();
say('=== mount gate (isolated profile) ===');
say(`  plugin      : ${PLUGIN}`);
say(`  sha256      : ${sha256(PLUGIN)}`);
say(`  expect      : ${EXPECT}`);
say(`  port        : ${PORT}   (production 127.0.0.1:3080 listener before = ${prodBefore || 'n/a'})`);
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

// 相对依赖闭包预检（实测踩过）：候选目录必须自带其 .mjs 相对 import 的**全部兄弟文件**。
// 否则 boot 会因「别的文件缺失」而失败，而 `--expect fail` 仍判"抓到了"⇒ **假阳性**
// （本次实测：候选目录只放 learn* 时，根因变成缺 context-memory-core.mjs，与事故本身无关）。
{
  const missing = new Set();
  for (const f of fs.readdirSync(pluginDir).filter((n) => n.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(pluginDir, f), 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]\.\/([\w.\-]+)['"]/g)) {
      const dep = m[1];
      const ok = [dep, `${dep}.mjs`, `${dep}/index.mjs`].some((c) => fs.existsSync(path.join(pluginDir, c)));
      if (!ok) missing.add(`${f} -> ./${dep}`);
    }
  }
  if (missing.size) {
    failEnv(`候选目录相对依赖闭包不完整（会以**错误原因**失败 ⇒ 假阳性）:\n    ` + [...missing].join('\n    '));
  }
}

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
// ⚠️ 覆盖边界（阴性对照实测结论，勿误读）：A1/A2 证明"能不能挂载/注册"，A3 只证明
// "宿主 sessions 服务在本 profile 上下文里可解析（装载级前置条件）"，**不**证明 learn 自身
// 的 sessions 接线正确——实测：把 learn 的 `ctx.get('sessions')` 改坏成 `'sessionsX'`，
// 本门禁仍全绿（A3 是探针自己查 ctx.get，与 learn 内部无关；A2 只数工具个数）。
// 该类"内部接线语义回归"属合同测试层职责（如 test-learn-r2-b1-approval-gate.mjs）；本次**未**
// 验证该测试对 sessionsX 变体的敏感性——在裸 shell 跑它会因缺真实宿主会话而失败
// （approval_host_fact_session_unavailable，即 learn 对"宿主事实不可复验"的 fail-closed 行为，
// 两个版本都一样），必须在 harness 内运行才有效。
// 本门禁负责的缺陷类是**装载/boot 失败**（A1/A2 对该类敏感：事故版本与语法坏版本均被抓）。
const seen = probe?.seen ?? [];
const learnTools = seen.filter((n) => typeof n === 'string' && n.startsWith('learn_'));
const dupes = learnTools.filter((n, i) => learnTools.indexOf(n) !== i);
const checks = [
  { id: 'A1', desc: 'no loader failure signature', pass: !FAIL_SIG.test(text) },
  { id: 'A2', desc: `probe captured exactly ${EXPECTED_TOOLS.length} learn_* tools, no duplicates (got ${learnTools.length})`,
    pass: learnTools.length === EXPECTED_TOOLS.length && dupes.length === 0 && EXPECTED_TOOLS.every((n) => learnTools.includes(n)) },
  { id: 'A3', desc: `host sessions service resolvable via ctx.get in this profile ctx (got ${probe?.sessionsViaGet ?? 'n/a'})`, pass: probe?.sessionsViaGet === 'resolved' },
  { id: 'A4', desc: 'no tool-surface warnings in log', pass: !has(/tool surface unavailable/) && !has(/expected 6 tool specs, collected/) },
];
const injectSignature = has(/cannot get property "sessions" without inject/);

// ---- 4) 收尾（先证明要杀的是本门禁自己拉起的进程）----
const cl = cmdlineOf(childPid);
const safeToKill = cl.includes(`--profile ${profileName}`) && !cl.includes('3080');
say(`  kill guard  : pid=${childPid} safeToKill=${safeToKill}${cl ? '' : ' (进程已自行退出)'}`);
if (safeToKill) killTree(childPid);
try { fs.closeSync(fd); } catch {}
const prodAfter = prodListener();

const allPass = checks.every((c) => c.pass);
const verdict = EXPECT === 'pass'
  ? ((allPass && ready) ? 'PASS' : 'FAIL')
  : ((!checks[0].pass && injectSignature) ? 'PASS' : 'FAIL');

const result = {
  slug: SLUG, plugin: PLUGIN, pluginSha256: sha256(PLUGIN), expect: EXPECT, verdict,
  port: PORT, ready, childExited: exited, signal, injectSignature, checks, probe, learnTools, dupes,
  copiedCount: copied.length, copied,
  prodPidBefore: prodBefore, prodPidAfter: prodAfter, prodUntouched: prodBefore === prodAfter,
  prodListenerAddr: '127.0.0.1:3080', prodPresent: Boolean(prodBefore),
  logPath, probeOut, resultPath, scratch, at: new Date().toISOString(),
};
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');

say('--- checks ---');
for (const c of checks) say(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.id}  ${c.desc}`);
say(`  probe.wrapped=${probe?.wrapped} sessionsViaGet=${probe?.sessionsViaGet} seen=[${seen.join(', ')}]`);
say(`  injectSignature(事故签名) = ${injectSignature}`);
say(`  production 127.0.0.1:3080 listener: before=${prodBefore || 'n/a'} after=${prodAfter || 'n/a'} untouched=${prodBefore === prodAfter} (pid:proc 形式；勿用 tailscaled 的 5648 误判)`);
if (!allPass) {
  const tail = text.split(/\r?\n/).filter((l) => /error|failed/i.test(l)).slice(-5);
  for (const l of tail) say('  | ' + l.slice(0, 170));
}
say(`--- verdict: ${verdict} (expect=${EXPECT}) ---`);
say(`  result json : ${resultPath}`);
if (!KEEP) { try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {} }
else say(`  tmp profile kept : ${profileDir}`);
process.exit(verdict === 'PASS' ? 0 : 1);
