// 临时诊断探针：确认"落盘文件数上界"的机制（节流窗口 vs 真实泄漏）。不属于交付物。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGIN = pathToFileURL('C:/Users/Administrator/Desktop/sdeepseek harness/_p4r2/plugins/learn.mjs').href;
const { mkCtx, mkExec } = await import(pathToFileURL('C:/Users/Administrator/Desktop/sdeepseek harness/_p4r2/tests/learn/_real-session-harness.mjs').href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-slack-'));
const gpath = path.join(dir, '_global-verified.json');
const mod = await import(PLUGIN + '?probe=1');
const host = mkCtx();
const api = mod.apply(host.ctx, { stateDir: dir, globalStorePath: gpath });
const count = () => fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.includes('.tmp-') && path.resolve(dir, n) !== path.resolve(gpath)).length;

let max = 0; const trace = [];
for (let i = 0; i < 400; i++) {
  await api.invokeTool('learn_propose', { title: `p ${i}`, body: 'b', sourceEventSeqs: [i + 1] }, mkExec(`probe-${i}`));
  const c = count();
  if (c > max) max = c;
  if ((i + 1) % 16 === 0) trace.push(`w${i + 1}:${c}`);
}
console.log('policy =', JSON.stringify(api.retentionPolicy()));
console.log('每 16 次写入后的文件数:', trace.join(' '));
console.log('400 次写入期间实测最大文件数 =', max);
console.log('显式 prune 后 =', (api.pruneSessionStore(Date.now()), count()));
console.log('report =', JSON.stringify(api.pruneSessionStore(Date.now())));
console.log('footprint =', JSON.stringify(api._memoryFootprint()));
fs.rmSync(dir, { recursive: true, force: true });
