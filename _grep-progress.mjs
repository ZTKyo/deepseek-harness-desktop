// _grep-progress.mjs —— 在解码后的会话里定位 AC2/AC6/AC10 的真实进度证据（只读）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const lines = fs.readFileSync(path.join(os.tmpdir(), 's76decoded.txt'), 'utf8').split('\n').filter(Boolean);
const ev = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const from = Number(process.argv[2] || 300000);
const pats = process.argv[3] ? new RegExp(process.argv[3]) : /AC2|ac2/;

const flat = (x) => {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map(flat).join(' ');
  if (typeof x === 'object') return Object.entries(x).map(([k, v]) => (k === 'content' || k === 'text' || k === 'arguments' || k === 'result' || k === 'input' ? flat(v) : '')).join(' ');
  return '';
};

const out = [];
for (const e of ev) {
  if (e.seq < from) continue;
  const t = flat(e.data).replace(/\s+/g, ' ');
  if (!t || !pats.test(t)) continue;
  out.push(`[seq ${e.seq}][${e.type}] ${t.slice(0, 260)}`);
}
console.log(`命中 ${out.length} 条（seq >= ${from}，pattern=${pats}）`);
console.log(out.slice(-70).join('\n\n'));
