// 独立验证工具库（只读验证者自建；不写入仓库任何文件）
// 冻结副本路径由 FROZEN 环境变量给出，默认 C:\Users\ADMINI~1\AppData\Local\Temp\_vfy-frozen
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FROZEN = process.env.VFY_FROZEN || path.join(os.tmpdir(), '_vfy-frozen');
export const CORE = path.join(FROZEN, 'plugins', 'learn-core.mjs');
export const SHELL = path.join(FROZEN, 'plugins', 'learn.mjs');

export const loadCore = () => import(pathToFileURL(CORE).href);
export const loadShell = () => import(pathToFileURL(SHELL).href);

export function freshStateDir(tag = 'vfy') {
  const d = path.join(os.tmpdir(), `${tag}-state-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 伪 ctx：只提供插件真正使用的两个能力（logger / on / tools 陷阱 / get）——自建，非抄测试。 */
export function mkCtx(extra = {}) {
  const logs = [];
  const hooks = new Map();
  return {
    logs,
    hooks,
    ctx: {
      logger: { info: (m) => logs.push('INFO ' + m), warn: (m) => logs.push('WARN ' + m), error: (m) => logs.push('ERR ' + m) },
      on: (ev, fn) => { if (!hooks.has(ev)) hooks.set(ev, []); hooks.get(ev).push(fn); },
      tools: { register: () => { throw new Error('ctx.tools.register must not be used in repo probes'); } },
      get: (n) => (n === 'approval' ? (extra.approval ?? null) : (extra.services && n in extra.services ? extra.services[n] : undefined)),
      sessions: extra.sessions,
    },
  };
}

/** 宿主会话存储替身（验证者扮演宿主；agent 侧无法伪造此对象）。 */
export function hostSessionStore(sid, ref, reason, outcome = 'allowed-once') {
  const session = hostShapedSession(sid, ref, reason, outcome);
  return { session, sessions: { get: (id) => (id === sid ? session : null) } };
}

/** 宿主风格会话日志（approval/asked + approval/decided 事件对）。 */
export function hostShapedSession(sid, approvalRef, reason, outcome = 'allowed-once') {
  return {
    id: sid,
    events: [
      { type: 'turn/start', data: {} },
      { type: 'approval/asked', data: { id: approvalRef, toolName: 'learn_review', reason, requestedAt: Date.now() } },
      { type: 'approval/decided', data: { id: approvalRef, outcome, decidedAt: Date.now() } },
    ],
  };
}

/** 打印 + 便于日志留痕 */
export function say(...a) { console.log(...a); }
export function head(s, n = 400) { return String(s ?? '').slice(0, n); }
