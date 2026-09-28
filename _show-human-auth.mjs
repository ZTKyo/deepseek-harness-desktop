// _show-human-auth.mjs —— 取回人类原文授权（逐字），确认本轮边界
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const lines = fs.readFileSync(path.join(os.tmpdir(), 's76decoded.txt'), 'utf8').split('\n').filter(Boolean);
const ev = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const lo = Number(process.argv[2] || 255700);
const hi = Number(process.argv[3] || 256100);
const getText = (e) => {
  const c = e.data?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('\n');
  if (c && typeof c === 'object') return c.text || '';
  return '';
};
for (const e of ev) {
  if (e.seq < lo || e.seq > hi) continue;
  if (e.type !== 'user/message') continue;
  const t = getText(e);
  if (!t || /^\[context-memory/.test(t) || /^Background subagent/.test(t) || /^\[No human input/.test(t)) continue;
  console.log(`\n========== seq ${e.seq} (len=${t.length}) ==========\n${t}`);
}
