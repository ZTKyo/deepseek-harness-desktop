// production-load-probe.mjs — 生产「已加载代码」行为判别探针（只读；可重复运行）
//
// 背景（2026-09-28 AC2 教训）：DSH 的 profile 插件（cordis.patch.yml 里的 ./learn.mjs 等）
//   只在**服务进程启动时**装载一次。部署到 ~/.dsh/profiles/web 的新字节**不会**被运行中的
//   进程采用（无 watcher / 无 HMR；改动 learn.mjs 或 cordis.patch.yml 的 mtime 均不触发重挂载）。
//   因此「source == deployed」不等于「deployed == loaded」——必须用**运行时行为**判定，
//   不能用文件 mtime / 启动时间之类的代理证据（历史上一轮正是用 mtime<启动时间 代理证据
//   误判为已装载）。
//
// 判别原理（确定性，不依赖模型自述）：
//   deployed learn.mjs 的 learn_recall 在「经验库无命中」分支**必然**给输出挂 researchDirective 键
//   （见 plugins/learn.mjs：res.items.length===0 ⇒ openResearchLeg(...) ⇒ out.researchDirective=...）。
//   部署前版本无此键。故：
//     · 活进程 learn_recall 输出**含** researchDirective ⇒ 新版已装载
//     · 活进程 learn_recall 输出**不含**           ⇒ 仍跑旧版（部署字节未装载，需要重启服务）
//   证据取自**官方会话日志**（~/.dsh/sessions/<cwd>/<sid>/session.jsonl.zstd 里的 tool/result），
//   不是模型转述。
//
// 用法：
//   node production-load-probe.mjs                # 完整探针（新建会话 → 调 learn_recall → 判定）
//   node production-load-probe.mjs --keep        # 同上（探针会话本来就保留，供审计）
//   PROBE_PORT=3080 可覆盖端口
//
// 退出码：0 = 新版已装载；3 = 仍是旧版（未装载）；2 = 探针本身失败（无法判定）
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createZstdDecompress } from 'node:zlib';

const PORT = Number(process.env.PROBE_PORT || 3080);
const HOME = process.env.USERPROFILE;
const PROFILE = path.join(HOME, '.dsh', 'profiles', 'web');
const SESS_ROOT = path.join(HOME, '.dsh', 'sessions');
const SRC_DIR = path.join(HOME, 'Desktop', 'sdeepseek harness', '_p4r2-inject-fix', 'plugins');
const PROMPT =
  '只做一件事：调用一次 learn_recall 工具，query 用「探针：如何为本机新增只读诊断插件」。' +
  '然后把完整返回 JSON 原样贴出，最后单独一行输出 RESEARCH_DIRECTIVE_PRESENT 或 RESEARCH_DIRECTIVE_ABSENT。';

let n = 0;
async function rpc(method, payload = {}, timeoutMs = 90000) {
  const rpcId = `loadprobe-${Date.now()}-${++n}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: ctl.signal,
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
    return { status: res.status, body };
  } finally { clearTimeout(t); }
}

// 多帧 zstd：DSH 会话日志是逐帧追加的，按 zstd magic 切帧后逐帧解压
async function decodeSession(file) {
  const buf = fs.readFileSync(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const idx = [];
  for (let i = 0; (i = buf.indexOf(magic, i)) >= 0; i += 4) idx.push(i);
  const texts = [];
  for (let k = 0; k < idx.length; k++) {
    const part = buf.subarray(idx[k], k + 1 < idx.length ? idx[k + 1] : buf.length);
    try { texts.push((await new Promise((res, rej) => {
      const dec = createZstdDecompress();
      const chunks = [];
      dec.on('data', (c) => chunks.push(c));
      dec.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
      dec.on('error', rej);
      dec.end(part);
    }))); } catch { /* 坏帧跳过 */ }
  }
  return texts.join('');
}

const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const line = (s = '') => console.log(s);

// ---------- ① 部署面（静态）----------
line('===== ① 部署面：源 / 生产 profile 的 learn 插件字节 =====');
for (const f of ['learn.mjs', 'learn-core.mjs', 'learn-candidate.mjs', 'learn-gap-veto.mjs']) {
  const s = path.join(SRC_DIR, f), d = path.join(PROFILE, f);
  const hs = fs.existsSync(s) ? sha256(s) : 'MISSING';
  const hd = fs.existsSync(d) ? sha256(d) : 'MISSING';
  const mt = fs.existsSync(d) ? fs.statSync(d).mtime.toISOString().slice(11, 19) : '?';
  const ac2 = fs.existsSync(d) ? (fs.readFileSync(d, 'utf8').includes('researchDirective') ? 'AC2-marked' : 'no-AC2-marker') : '-';
  line(`   ${f.padEnd(22)} src=${hs.slice(0, 12)} dep=${hd.slice(0, 12)} mtime=${mt}Z ${hs === hd ? 'SAME' : 'DIFF'} ${ac2}`);
}
line('   注：mtime/字节只能证明「已部署」，**不能**证明「已装载」——见 ③。');

// ---------- ② 健康 ----------
line('\n===== ② 生产健康 =====');
for (const p of ['/', '/health']) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { signal: AbortSignal.timeout(5000) });
    line(`   GET ${p} -> HTTP ${r.status}`);
  } catch (e) { line(`   GET ${p} -> 失败 ${e.name}`); }
}

// ---------- ③ 运行时行为判定 ----------
line('\n===== ③ 运行时行为判定（探针会话 → learn_recall → 官方日志取证）=====');
const created = await rpc('session.create', { agentPreset: 'autonomous' }, 60000);
const sid = created.body?.result?.value?.sessionId;
if (!sid) {
  line('   session.create 失败：' + JSON.stringify(created.body).slice(0, 300));
  line('VERDICT=PROBE_FAILED');
  process.exit(2);
}
line(`   probe sessionId = ${sid}`);
const sent = await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: PROMPT }] }, 120000);
line(`   prompt rpc http=${sent.status} ok=${JSON.stringify(sent.body?.result?.ok)}`);

const t0 = Date.now();
let settled = false;
while (Date.now() - t0 < 240000) {
  await new Promise((r) => setTimeout(r, 8000));
  const l = await rpc('session.list', {}, 60000);
  const item = (l.body?.result?.value?.items ?? []).find((x) => x.sessionId === sid);
  if (!item) continue;
  const st = item.projections?.values?.sessionStats ?? {};
  line(`   t+${Math.round((Date.now() - t0) / 1000)}s running=${item.running} turns=${st.turns ?? '?'} steps=${st.steps ?? '?'}`);
  if (item.running === false && (st.turns ?? 0) >= 1) { settled = true; break; }
}

let logfile = null;
for (const d of fs.readdirSync(SESS_ROOT)) {
  const p = path.join(SESS_ROOT, d, sid, 'session.jsonl.zstd');
  if (fs.existsSync(p)) { logfile = p; break; }
}
if (!logfile) { line('   找不到探针会话日志：' + sid); line('VERDICT=PROBE_FAILED'); process.exit(2); }
const text = await decodeSession(logfile);
const lines = text.split('\n').filter((x) => x.trim() !== '');
let verdict = 'UNKNOWN';
let raw = '';
for (const l of lines) {
  let o; try { o = JSON.parse(l); } catch { continue; }
  if (o.type !== 'tool/result') continue;
  const t = JSON.stringify(o.data);
  if (!t.includes('"items"') && !t.includes('\\"items\\"')) continue;
  raw = t;
  verdict = t.includes('researchDirective') ? 'NEW_CODE_LOADED' : 'OLD_CODE_STILL_LOADED';
}
line(`   log=${logfile}  events=${lines.length} settled=${settled}`);
line('   learn_recall 生产实时输出：' + raw.slice(raw.indexOf('items'), raw.indexOf('items') + 220));

line('\n===== ④ 判定 =====');
line(`   VERDICT=${verdict}`);
line('   NEW_CODE_LOADED        ⇒ 生产活进程跑的是已部署字节（deployed==loaded 成立）');
line('   OLD_CODE_STILL_LOADED  ⇒ 部署字节未被装载（profile 插件只在服务启动时装载；需重启服务）');
process.exit(verdict === 'NEW_CODE_LOADED' ? 0 : 3);
