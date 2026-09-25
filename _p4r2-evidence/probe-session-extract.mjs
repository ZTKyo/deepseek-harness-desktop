// 只读提取父会话里"退回补齐"指令原文（不修改会话文件）。
import fs from 'node:fs';
import zlib from 'node:zlib';

const F = process.argv[2];
const NEEDLE = process.argv[3] ?? '';
const buf = fs.readFileSync(F);
console.log('file bytes =', buf.length);

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offsets = [];
for (let i = 0; i + 4 <= buf.length; i++) { if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i); }
console.log('frames =', offsets.length);

let text = '';
if (offsets.length <= 1) {
  text = zlib.zstdDecompressSync(buf).toString('utf8');
} else {
  // 追加式 jsonl.zstd：多帧拼接，必须逐帧解压（整体解压只会得到第一帧）
  const parts = [];
  let bad = 0;
  for (let k = 0; k < offsets.length; k++) {
    const s = offsets[k]; const e = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8')); } catch { bad++; }
  }
  console.log('逐帧解压完成，失败帧 =', bad);
  text = parts.join('');
}
console.log('decoded chars =', text.length);
const lines = text.split('\n').filter(Boolean);
console.log('lines =', lines.length);

for (let i = 0; i < lines.length; i++) {
  if (!lines[i].includes(NEEDLE)) continue;
  console.log('\n===== line ' + i + ' (含 "' + NEEDLE + '") =====');
  let obj = null; try { obj = JSON.parse(lines[i]); } catch { }
  const raw = obj ? JSON.stringify(obj) : lines[i];
  const idx = raw.indexOf(NEEDLE);
  console.log(raw.slice(Math.max(0, idx - 400), idx + 6000));
}
