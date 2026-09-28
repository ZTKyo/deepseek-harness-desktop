// _extract-reports.mjs —— 从解码后的会话日志抽取重要记录（人类授权/子代理报告/我的关键结论）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const lines = fs.readFileSync(path.join(os.tmpdir(), 's76decoded.txt'), 'utf8').split('\n').filter(Boolean);
const ev = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const outDir = process.argv[2] || path.join(process.cwd(), '_reports');
fs.mkdirSync(outDir, { recursive: true });

const getText = (e) => {
  const c = e.data?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(' ');
  if (c && typeof c === 'object') return c.text || '';
  return '';
};

const wanted = [];
for (const e of ev) {
  if (e.type !== 'user/message') continue;
  const t = getText(e);
  if (/^Background subagent .* reported:/.test(t)) wanted.push({ seq: e.seq, kind: 'subagent-report', t });
}
console.log('子代理报告数 =', wanted.length);
const index = [];
for (const w of wanted) {
  const head = w.t.replace(/^Background subagent (\w[\w-]*) reported:\s*/, '');
  const title = (head.match(/^#+\s*(.{0,60})/) || [, head.slice(0, 60)])[1].replace(/[\\/:*?"<>|\r\n\t]/g, '_');
  const f = path.join(outDir, `seq${w.seq}-${w.sub || ''}${title.trim().slice(0, 50)}.txt`);
  fs.writeFileSync(f, w.t, 'utf8');
  index.push(`seq ${w.seq}  ${w.t.length}  ${path.basename(f)}`);
}
fs.writeFileSync(path.join(outDir, 'INDEX.txt'), index.join('\n'), 'utf8');
console.log(index.join('\n'));
