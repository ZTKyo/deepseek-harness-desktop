// 只读工具：解出本会话官方日志的 (seq, type) 序列，用于给出 learn_propose 的真实 provenance。
// 复用仓库既有共享解码器 tests/learn/_real-session-harness.mjs（不新建第二套 zstd 解码）。
// 用法：node _seq-probe.mjs <session.jsonl.zstd> [tailN]
import { loadRealSession } from '<WORKSPACE_URL>/_p4r2-inject-fix/tests/learn/_real-session-harness.mjs';

const file = process.argv[2];
const tailN = Number(process.argv[3] ?? 60);
const find = process.argv[4] ?? '';
const real = loadRealSession(file);
const seqs = Object.keys(real.events).map(Number).filter(Number.isInteger).sort((a, b) => a - b);

console.log(`file=${file}`);
console.log(`frames=${real.frames} events=${seqs.length} parseErrors=${real.parseErrors ?? 0} minSeq=${seqs[0]} maxSeq=${seqs[seqs.length - 1]}`);

const one = (v, n = 150) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s ?? '').replace(/\s+/g, ' ').slice(0, n);
};

if (find === '@calls') {
  const minSeq = Number(process.argv[5] ?? 0);
  const only = process.argv[6] ?? '';
  const re = only ? new RegExp(only, 'i') : null;
  console.log(`\n=== seq>=${minSeq} 的 tool/call 事件${only ? ` (name~/​${only}/i)` : ''} ===`);
  let n = 0;
  for (const seq of seqs) {
    if (seq < minSeq) continue;
    const e = real.events[seq];
    if (e.type !== 'tool/call') continue;
    const d = e.data ?? {};
    const nm = String(d.name ?? '');
    if (re && !re.test(nm)) continue;
    n++;
    console.log(`${seq}\t${nm}\t${one(d.args ?? d.arguments ?? d.input, 190)}`);
  }
  console.log(`calls=${n}`);
} else if (find) {
  const re = new RegExp(find, 'i');
  console.log(`\n=== 命中 /${find}/i 的事件 ===`);
  let hits = 0;
  for (const seq of seqs) {
    const e = real.events[seq];
    const j = JSON.stringify(e.data ?? {});
    if (!re.test(j)) continue;
    hits++;
    const d = e.data ?? {};
    const label = [e.type, d.name ? `name=${d.name}` : '', d.toolName ? `tool=${d.toolName}` : ''].filter(Boolean).join(' ');
    const m = j.match(re);
    const at = Math.max(0, (m?.index ?? 0) - 60);
    console.log(`${seq}\t${label}\t…${j.slice(at, at + 200).replace(/\s+/g, ' ')}…`);
  }
  console.log(`hits=${hits}`);
}

console.log(`\n=== 末尾 ${tailN} 个事件 ===`);
for (const seq of seqs.slice(-tailN)) {
  const e = real.events[seq];
  const d = e.data ?? {};
  const bits = [];
  if (d.name) bits.push(`name=${d.name}`);
  if (d.toolName) bits.push(`tool=${d.toolName}`);
  if (d.callId) bits.push(`call=${String(d.callId).slice(0, 20)}`);
  if (d.content !== undefined) bits.push(`content=${one(d.content, 90)}`);
  if (d.args !== undefined) bits.push(`args=${one(d.args, 130)}`);
  if (d.output !== undefined) bits.push(`output=${one(d.output, 130)}`);
  console.log(`${seq}\t${e.type}\t${bits.join(' ')}`);
}
