// redteam-r3-injection-positions.mjs —— 实证：真实发言里 <system-reminder> 出现在什么位置
//
// 目的：决定"未闭合注入块剥离"规则是否应该收紧。
// 只对**真实发言文本**（走官方提取器）统计，不看 JSON 编码后的字节。
//
// 两个判别特征：
//   - atLineStart   ：标签位于行首（前面是换行或串首）
//   - tagAloneOnLine：标签独占一行（后面紧跟换行），即真注入块的排版形态
// 真注入 = 两个特征都满足；引用/讨论 = 标签后紧跟行内文字。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decodeLines } from '../../docs/roadmap/evidence/cm-r4-log-decoder.mjs';
import { P25_EXTRACTORS } from '../../plugins/learn-core.mjs';

// 注意：必须用**原始文本**统计。buildLearnDigest 返回的 turns 已经被 stripInjectedContent
// 剥过，用它统计会恒为 0（本探针第一版就踩了这个坑）。
const { messageOfEvent, recursiveText } = P25_EXTRACTORS;

const TARGETS = [
  'session-9e3b29bb-3f36-4659-9162-18ad928a7f49', // 普通工作会话
  'session-a144fe3f-1042-4466-b70b-a10642fae037', // 本审计会话（自指：讨论注入过滤本身）
];
const base = path.join(os.homedir(), '.dsh', 'sessions', '--C-Users-Administrator-Desktop-sdeepseek~0020harness--');

const stats = {
  turnsWithTag: 0, occurrences: 0,
  lineStart: 0, midLine: 0, closed: 0, unclosed: 0,
  tagAlone: 0, tagInline: 0,
  bothLSandAlone: 0, lsOnly: 0, aloneOnly: 0, neither: 0,
};
const perSession = [];
const midSamples = [];

for (const d of TARGETS) {
  const f = path.join(base, d, 'session.jsonl.zstd');
  if (!fs.existsSync(f)) { console.log('missing ' + d); continue; }
  const { lines } = decodeLines(f);
  const ps = { dir: d.slice(0, 22), occ: 0, lineStart: 0, midLine: 0, midUser: 0, midAssistant: 0, alone: 0, inline: 0 };
  perSession.push(ps);

  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || (o.type !== 'user/message' && o.type !== 'assistant/message')) continue;
    const msg = messageOfEvent(o);
    if (!msg) continue;
    const s = recursiveText(msg.content ?? msg);
    if (!s || !s.includes('<system-reminder>')) continue;
    const role = o.type === 'user/message' ? 'user' : 'assistant';
    stats.turnsWithTag++;

    let i = -1;
    while ((i = s.indexOf('<system-reminder>', i + 1)) !== -1) {
      stats.occurrences++; ps.occ++;
      const atLineStart = i === 0 || s[i - 1] === '\n';
      const after = s.slice(i + 17, i + 19);
      const tagAloneOnLine = after.startsWith('\n') || after.startsWith('\r\n');
      const closed = s.slice(i).includes('</system-reminder>');

      if (tagAloneOnLine) { stats.tagAlone++; ps.alone++; } else { stats.tagInline++; ps.inline++; }
      if (atLineStart && tagAloneOnLine) stats.bothLSandAlone++;
      else if (atLineStart) stats.lsOnly++;
      else if (tagAloneOnLine) stats.aloneOnly++;
      else stats.neither++;

      if (atLineStart) { stats.lineStart++; ps.lineStart++; }
      else {
        stats.midLine++; ps.midLine++;
        if (role === 'user') ps.midUser++; else ps.midAssistant++;
        if (midSamples.length < 8) midSamples.push({ role, ctx: s.slice(Math.max(0, i - 55), i + 35) });
      }
      if (closed) stats.closed++; else stats.unclosed++;
    }
  }
}

console.log('=== real turn text: position of <system-reminder> ===');
console.log(JSON.stringify(stats, null, 2));
console.log('');
console.log('=== per session (midLine split by role) ===');
for (const ps of perSession) console.log('  ' + JSON.stringify(ps));
console.log('');
console.log('=== mid-line samples (the "discussion/quote" candidates) ===');
for (let i = 0; i < midSamples.length; i++) {
  console.log('  [' + i + '] ' + midSamples[i].role + '  ' + JSON.stringify(midSamples[i].ctx));
}
