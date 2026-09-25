// 临时诊断探针：能力缺口路径（candidateStores/gapObservedKeys/gapVetoedKeys）能否被真实会话驱动。不属于交付物。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const H = pathToFileURL('C:/Users/Administrator/Desktop/sdeepseek harness/_p4r2/tests/learn/_real-session-harness.mjs').href;
const PLUGIN = pathToFileURL('C:/Users/Administrator/Desktop/sdeepseek harness/_p4r2/plugins/learn.mjs').href;
const { mkCtx, listRealSessions, loadRealSession } = await import(H);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-gap-'));
const mod = await import(PLUGIN + '?gap=1');
const host = mkCtx();
const api = mod.apply(host.ctx, { stateDir: dir, globalStorePath: path.join(dir, '_g.json') });
const real = loadRealSession(listRealSessions(500_000)[0].p);
const fire = async (ev, p) => { for (const fn of host.hooks.get(ev) ?? []) await fn(p, async () => undefined); };
const slice = (s, n) => ({ id: s, events: real.events, surface: { nodes: real.nodes.slice(0, n) } });

console.log('footprint@0 =', JSON.stringify(api._memoryFootprint()));
for (let i = 0; i < 3; i++) {
  await fire('agent/pre-step', { agent: { session: slice('gap-a-' + i, 3) } });
  await fire('agent/pre-step', { agent: { session: slice('gap-a-' + i, real.nodes.length) } });
  console.log(`after sid gap-a-${i}:`, JSON.stringify(api._memoryFootprint()));
}
console.log('real.nodes =', real.nodes.length, 'events =', real.events.length);
console.log('注意：真实会话是否含未解决工具失败 =', JSON.stringify(api.getStore('gap-a-0').experiences.map((e) => e.state).slice(0, 3)));
fs.rmSync(dir, { recursive: true, force: true });
