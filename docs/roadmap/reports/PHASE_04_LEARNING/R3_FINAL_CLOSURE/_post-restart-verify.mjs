// 重启后一键复核（只读）：AC1 修复是否真正装载 + 存量泄漏是否被自愈清除。
// 用法（先取服务启动时间，再跑本脚本）：
//   node _post-restart-verify.mjs "2026-09-28 00:17:40"
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const serverStart = process.argv[2] ? new Date(process.argv[2].replace(' ', 'T')) : null;
const SRC = path.join(process.env.USERPROFILE, 'Desktop', 'sdeepseek harness', '_p4r2-inject-fix', 'plugins');
const DST = path.join(process.env.USERPROFILE, '.dsh', 'profiles', 'web');
const LOGS = path.join(process.env.LOCALAPPDATA, 'DSHHarness', 'logs');
const STATE = path.join(process.env.LOCALAPPDATA, 'DSHHarness', 'state', 'learn');
const PLUGINS = ['learn.mjs', 'learn-core.mjs', 'learn-candidate.mjs', 'learn-gap-veto.mjs'];
const sha12 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
const line = (s = '') => console.log(s);

// ---------- 1 健康检查 ----------
line('===== ① 服务健康（HTTP） =====');
for (const p of ['/', '/health', '/api/health', '/watchdog/health']) {
  try {
    const r = await fetch(`http://127.0.0.1:3080${p}`, { signal: AbortSignal.timeout(4000) });
    line(`   GET ${p} -> HTTP ${r.status}`);
  } catch (e) { line(`   GET ${p} -> 失败 ${e.name}`); }
}

// ---------- 2 重启台账 / 日志 ----------
line('\n===== ② 重启台账与日志 =====');
const att = path.join(LOCALAPPDATA_x(), 'state', 'restart-attempts');
function LOCALAPPDATA_x() { return path.join(process.env.LOCALAPPDATA, 'DSHHarness'); }
try {
  const files = fs.readdirSync(att).map((f) => path.join(att, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const j = JSON.parse(fs.readFileSync(files[0], 'utf8'));
  line(`   最新 attempt=${j.attemptId} state=${j.state} terminal=${j.terminalState} pid=${j.pid} ts=${j.ts}`);
  line(`   详情=${(j.detail || '').trim() || '(空)'}`);
} catch (e) { line('   台账读取失败：' + e.message); }
try {
  const log = fs.readFileSync(path.join(LOGS, 'restart-apply-patch.log'), 'utf8').split('\n').filter(Boolean).slice(-16);
  line('   --- restart-apply-patch.log 尾部 ---');
  for (const l of log) line('   ' + l);
} catch (e) { line('   日志读取失败：' + e.message); }

// ---------- 3 装载判定（部署字节 + 替换时间 vs 服务启动时间）----------
line('\n===== ③ 装载判定：source == deployed 且 mtime < 服务启动时间 =====');
for (const n of PLUGINS) {
  const s = path.join(SRC, n), d = path.join(DST, n);
  const hs = fs.existsSync(s) ? sha12(s) : 'MISSING';
  const hd = fs.existsSync(d) ? sha12(d) : 'MISSING';
  const mt = fs.existsSync(d) ? fs.statSync(d).mtime : null;
  let verdict = hs === hd ? 'SAME' : 'DIFF';
  if (serverStart && mt) verdict += mt < serverStart ? ' + mtime<start（该字节已装载）' : ' + ⚠mtime>start（启动后被改写：装载的可能是旧字节）';
  line(`   ${n.padEnd(24)} src=${hs} dep=${hd} mtime=${mt ? mt.toISOString().slice(11, 19) : '?'} ${verdict}`);
}
if (!serverStart) line('   ⚠ 未提供服务启动时间：请用 pwsh 取 PID/StartTime 后重跑本脚本并传入');

// ---------- 4 存量泄漏（19 族，只打印家族名与次数）----------
line('\n===== ④ 生产 learn 状态目录：家族密钥泄漏复核（只读） =====');
try {
  const { SECRET_PATTERNS } = await import(new URL('file:///' + path.join(SRC, 'learn-core.mjs').replace(/\\/g, '/')).href);
  const files = fs.readdirSync(STATE).filter((f) => f.endsWith('.json')).map((f) => path.join(STATE, f));
  const by = new Map();
  let total = 0;
  for (const fp of files) {
    const txt = fs.readFileSync(fp, 'utf8');
    for (const p of SECRET_PATTERNS) { p.re.lastIndex = 0; const m = txt.match(p.re); if (m && m.length) { by.set(p.name, (by.get(p.name) || 0) + m.length); total += m.length; } }
  }
  line(`   家族数=${SECRET_PATTERNS.length}  扫描文件=${files.length}`);
  line(total === 0 ? '   ✅ 零命中：存量泄漏已被自愈迁移清除 / 无新泄漏' : '   ⚠ 命中：' + [...by].map(([k, v]) => `${k}=${v}`).join(', '));
  line(`   LEAK_AUDIT=${total === 0 ? 'CLEAN' : 'HITS_FOUND'}`);
} catch (e) { line('   泄漏复核失败：' + e.message); }

// ---------- 5 新服务日志签名 ----------
line('\n===== ⑤ 新服务日志（重复注册/崩溃签名扫描） =====');
try {
  const txt = fs.readFileSync(path.join(LOGS, 'dsh-server-3080.log'), 'utf8');
  const tail = txt.split('\n').slice(-400).join('\n');
  const sig = [
    ['重复注册', /already registered|duplicate (tool|plugin)|DuplicatePlugin/i],
    ['插件加载失败', /failed to (load|mount) plugin|Cannot find module/i],
    ['learn 相关错误', /learn[^\n]{0,60}(error|fail)/i],
    ['未捕获异常', /Uncaught|UnhandledPromiseRejection/i],
  ];
  for (const [name, re] of sig) line(`   ${name}: ${re.test(tail) ? '⚠ 命中' : '无'}`);
  const learnLines = tail.split('\n').filter((l) => /learn\.mjs|learn 工具|learn\b.*tool/i.test(l)).slice(-5);
  if (learnLines.length) { line('   --- 含 learn 的日志行 ---'); for (const l of learnLines) line('   ' + l.trim().slice(0, 200)); }
  line(`   日志(mtime=${fs.statSync(path.join(LOGS, 'dsh-server-3080.log')).mtime.toISOString().slice(11, 19)}, size=${txt.length})`);
} catch (e) { line('   服务日志读取失败：' + e.message); }
line('\n（本脚本只读；判定"已装载"用的是 mtime<启动时间 代理证据，已在报告中如实标注）');
