// keepalive-patch.mjs - Extend Node fetch keepAliveTimeout from 4s to 60s
// Verified: COLD 1316ms -> WARM 248ms, AFTER 6s idle still 258ms (was 1478ms before) on direct fetch
import { createRequire } from 'node:module';
export const name = 'keepalive-patch';
export function apply(ctx) {
  let Agent, setGlobalDispatcher, getGlobalDispatcher;
  try {
    const req = createRequire(import.meta.url);
    const undici = req('undici');
    Agent = undici.Agent;
    setGlobalDispatcher = undici.setGlobalDispatcher;
    getGlobalDispatcher = undici.getGlobalDispatcher;
  } catch (e) {
    ctx.logger?.warn?.('[keepalive-patch] undici not resolvable: ' + String(e.message));
    return;
  }
  const prev = getGlobalDispatcher();
  const agent = new Agent({ keepAliveTimeout: 60000, keepAliveMaxTimeout: 600000, timeout: 300000, connections: 50, pipelining: 1 });
  try { setGlobalDispatcher(agent); ctx.logger?.info?.('[keepalive-patch] Node fetch keepAliveTimeout 4s -> 60s (connections=50)'); } catch (e) { ctx.logger?.warn?.('[keepalive-patch] setGlobalDispatcher failed: ' + String(e.message)); return; }
  ctx.on('dispose', () => { try { setGlobalDispatcher(prev); } catch {} });
  return { diagnostics: () => ({ keepAliveTimeoutMs: 60000, keepAliveMaxTimeoutMs: 600000, previousDispatcher: prev?.constructor?.name || String(prev) }) };
}
