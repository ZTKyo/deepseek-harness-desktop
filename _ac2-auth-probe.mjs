// _ac2-auth-probe.mjs —— 取回本会话**真人原文**（GUI/Telegram 输入），确认 AC2 修复授权范围。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const lines = fs.readFileSync(path.join(os.tmpdir(), 's76decoded.txt'), 'utf8').split('\n').filter(Boolean);
const ev = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const um = ev.filter((e) => e.type === 'user/message');

// 统计 content 形状
const shapes = new Map();
const texts = [];
for (const e of um) {
  const c = e.data?.content;
  const kind = typeof c === 'string' ? 'string' : Array.isArray(c) ? 'array' : typeof c;
  shapes.set(`${kind}|src=${e.data?.source}`, (shapes.get(`${kind}|src=${e.data?.source}`) || 0) + 1);
  let t = '';
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) t = c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(' ');
  else if (c && typeof c === 'object') t = c.text || '';
  texts.push({ seq: e.seq, src: e.data?.source, t: (t || '').replace(/\s+/g, ' ').trim() });
}
console.log('content 形状分布 =', [...shapes.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  '));
const real = texts.filter((r) => r.t && r.t.length > 1 && !/^\[context-memory|^<system-reminder|^\[background job|^\[notice|^密钥「|<task-notification/.test(r.t));
console.log('过滤后消息数 =', real.length);

const kw = /AC2|研究腿|注入|授权|扩范围|药丸|A10|AC6|AC10|缺口/;
const hits = real.filter((x) => kw.test(x.t));
console.log(`\n==== 命中关键词（${hits.length} 条）· 全部列出 seq + 前 500 字 ====`);
for (const r of hits) console.log(`[seq ${r.seq}][src ${r.src}] ${r.t.slice(0, 500)}\n`);
console.log('==== 最后 8 条真实消息 ====');
for (const r of real.slice(-8)) console.log(`[seq ${r.seq}][src ${r.src}] ${r.t.slice(0, 500)}\n`);
