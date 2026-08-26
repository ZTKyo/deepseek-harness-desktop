// context-memory.mjs —— P2.5 CONTEXT MEMORY / Observational Memory（Minimal V1）
//
// 定位（唯一职责）：决定"当前这一轮模型应该看到什么上下文"。
//   - Recent Window：最近 N 个表面节点永不投影，保持 raw
//   - Observation：把 Window 之前的旧区段增量投影为结构化观察块（单活快照节点）
//   - Reflection：观察块自身增长时有界去重/归纳（bounded）
//   - Recall：一切替换节点带 sourceEventSeqs 官方回源；store 内保留 refs 索引
//   - Provider-switch activation：Router 决定切换后（仅观察，绝不决定）激活投影
//
// Authority 契约（不可破坏，详见 AUDIT_R1.md）：
//   Official Session = 唯一 Truth Source（本插件只用官方 append/shadow-price 协议，
//   原始事件永不删除）；Official Goal / EC / Router / compaction-basic 各归其主，
//   本插件不碰 compactNow、不碰 request-error retry、不发 ec/recovery-requirement、
//   不读写 goal 状态、不改写任何路由字段。
//
// Fail-open：任何内部错误只静默跳过本轮投影，原始上下文照常放行；store 损坏 →
//   重建为空 store（从 raw 重新学习），任务永不因投影问题停止。
//
// 单开关：config.enabled=false 或环境变量 CM_DISABLED=true ⇒ 不注册任何钩子。
// 删除挂载行即整体回滚（零数据迁移、零 schema 变更）。
//
// 零第三方依赖（node:std only）。挂载位：autonomous 预设 compaction 组内、
// tool-output-offload 之后、compaction-basic 之前（pre-compaction 位）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  estimateTokens,
  messageOfEvent,
  recursiveText,
  selectProjectionRange,
  buildObservation,
  reflect,
  renderObservationText,
  detectSwitch,
  deriveRequestedModeSafe,
  validateStore,
  emptyObs,
} from './context-memory-core.mjs';

export const name = 'context-memory';

const DEFAULTS = {
  enabled: true,
  recentWindowNodes: 40,      // Recent Window：末尾 N 个表面节点保持 raw
  activationThresholdTokens: 50000, // 表面估算 token 超过此值 → 持续投影（早于 compaction 0.6 压力线）
  minNewNodes: 6,             // 新落入 Window 之前的节点数达到该值才再次投影（防每步抖动）
  capsPerSection: 24,         // Reflection：每段条目上限
  capsTotalChars: 6000,       // Reflection：观察文本总字符上限（bounded）
  maxRefsEntries: 64,         // store 内 refs 索引环形上限（bounded persistence）
  stateDir: path.join(process.env.LOCALAPPDATA || os.homedir(), 'DSHHarness', 'state', 'context-memory'),
};

function sanitizeFileId(sid) {
  return String(sid ?? 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

/** 构造与官方 createUserMessage 同构的 user 消息（零依赖手动构造；MessageId 为运行时直通）。 */
function makeObservationMessage(text) {
  return {
    role: 'user',
    id: crypto.randomUUID(),
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'snapshot',
      sections: [{ name, text }],
    },
  };
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  // ── 单开关（EC 双通道惯例）──
  if (cfg.enabled === false || process.env.CM_DISABLED === 'true') {
    try { ctx.logger?.info?.('[context-memory] disabled by switch; not registering hooks'); } catch {}
    return {};
  }

  const stores = new Map();      // sid -> store
  const routes = new Map();      // sid -> last {provider,model}
  const installedAgents = new WeakSet();

  // ── store 持久化（原子写 tmp+rename，IntentStore 同款）──
  function emptyStore(sid) {
    return { schemaVersion: 1, sessionId: sid, version: 0, active: false, watermark: 0, lastRoute: null, obs: emptyObs(), refs: [] };
  }
  function storePath(sid) { return path.join(cfg.stateDir, sanitizeFileId(sid) + '.json'); }
  function loadStore(sid) {
    try {
      const p = storePath(sid);
      if (!fs.existsSync(p)) return null;
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      const ok = validateStore(parsed);
      if (!ok) throw new Error('invalid store structure');
      return ok;
    } catch {
      return null; // 损坏 → 调用方走重建（fail-open）
    }
  }
  function saveStore(store) {
    try {
      fs.mkdirSync(cfg.stateDir, { recursive: true });
      const p = storePath(store.sessionId);
      const tmp = p + '.tmp-' + crypto.randomUUID();
      fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
      fs.renameSync(tmp, p);
      return true;
    } catch {
      return false; // 持久化失败不影响内存态，更不阻塞任务
    }
  }
  function getStore(sid) {
    let s = stores.get(sid);
    if (!s) {
      s = loadStore(sid) ?? emptyStore(sid); // 缺失/损坏 → 空 store 从 raw 重新学习
      stores.set(sid, s);
    }
    return s;
  }

  // ── token 估算（tokenMeter 可用则用之，否则 chars/4 兜底）──
  function meterEstimate(meter, evt) {
    if (!evt) return 0;
    const msg = messageOfEvent(evt);
    if (!msg) return 0;
    if (typeof meter?.estimateMessage === 'function') {
      try { const v = meter.estimateMessage(msg); if (Number.isFinite(v)) return v; } catch {}
    }
    return estimateTokens(recursiveText(msg.content));
  }

  // ── 核心：每 step 前的投影决策（幂等、有界、fail-open）──
  function maybeProject(session, meter) {
    if (!session || typeof session.append !== 'function' || !session.surface?.nodes) return null;
    const events = session.events;
    if (!Array.isArray(events)) return null;
    const sid = session.id;
    if (!sid) return null;
    const nodes = [...session.surface.nodes];
    if (nodes.length <= cfg.recentWindowNodes) return null;

    const store = getStore(sid);

    // 未激活（无切换且未达阈值）→ 只等待，不动表面
    if (!store.active) {
      let est = 0;
      for (const seq of nodes) est += meterEstimate(meter, events[seq]);
      if (est < cfg.activationThresholdTokens) return null;
    }

    const range = selectProjectionRange(nodes, events, { recentWindow: cfg.recentWindowNodes });
    if (!range) return null;
    const freshEnd = Math.max(range.endSeq, 0);
    const newNodes = range.nodeSeqs.filter((q) => q > store.watermark).length;
    if (freshEnd <= store.watermark || newNodes < cfg.minNewNodes) return null; // 无足够增量

    // 增量投影：跳过插件注入节点（含自身旧快照），合并进既有 obs
    const obs = reflect(buildObservation(events, range.nodeSeqs, store.obs), {
      perSection: cfg.capsPerSection, totalChars: cfg.capsTotalChars,
    });
    const text = renderObservationText(obs, {
      version: store.version + 1,
      sessionId: sid,
      startSeq: range.startSeq,
      endSeq: range.endSeq,
      switchActivated: store.active && store.lastSwitchAt &&
        Date.now() - store.lastSwitchAt < 5 * 60 * 1000,
    });

    // 官方 shadow-price 协议：先 compaction/prune 影事件，再替换节点（sourceEventSeqs 全覆盖）
    const shadowedTokenCount = range.nodeSeqs.reduce((a, q) => a + meterEstimate(meter, events[q]), 0);
    session.append('compaction/prune', {
      shadowedRange: { start: range.startSeq, end: range.endSeq },
      shadowedSeqs: range.nodeSeqs.slice(),
      ...(shadowedTokenCount > 0 ? { shadowedTokenCount } : {}),
    });
    session.append('user/message', makeObservationMessage(text), {
      surfaceOp: { op: 'replace', start: range.startSeq, end: range.endSeq },
      sourceEventSeqs: range.nodeSeqs.slice(),
    });

    // 更新 store（bounded）
    store.version += 1;
    store.obs = obs;
    store.watermark = range.endSeq;
    store.refs.push({ v: store.version, startSeq: range.startSeq, endSeq: range.endSeq, at: Date.now() });
    while (store.refs.length > cfg.maxRefsEntries) store.refs.shift();
    saveStore(store);
    try {
      ctx.logger?.info?.(`[context-memory] projected ${range.nodeSeqs.length} older node(s)` +
        ` into observation v${store.version} (seq ${range.startSeq}-${range.endSeq}, ~${shadowedTokenCount} tokens shadowed)`);
    } catch {}
    return { version: store.version, range };
  }

  // ── 钩子 1：agent/pre-step（compaction 组内注册序=执行序，先投影后测压）──
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (signal?.aborted) return next();
    try {
      maybeProject(agent?.session, ctx.get ? ctx.get('tokenMeter') : undefined);
    } catch {
      /* fail-open：投影永不阻断任务 */
    }
    return next();
  });

  // ── 钩子 2：provider-switch 观察者（只读 route 结果；双保险挂载，WeakSet 去重）──
  const observeRoute = async (payload, next) => {
    let resolved;
    try { resolved = await next(); } catch (e) { throw e; }
    try {
      const sid = payload?.agent?.session?.id;
      if (sid && resolved && typeof resolved === 'object') {
        const route = { provider: String(resolved.provider ?? ''), model: String(resolved.model ?? '') };
        const requestedModel = payload?.config?.model ?? payload?.model ?? payload?.requestedModel;
        const mode = deriveRequestedModeSafe(requestedModel);
        const prev = routes.get(sid);
        routes.set(sid, route);
        if (prev && detectSwitch(prev, route, mode)) {
          const store = getStore(sid);
          if (!store.active) {
            store.active = true;
            store.lastSwitchAt = Date.now();
            saveStore(store);
          }
          try {
            ctx.logger?.info?.(`[context-memory] provider/model switch observed` +
              ` (${prev.provider}/${prev.model} -> ${route.provider}/${route.model}); projection activated`);
          } catch {}
        }
      }
    } catch { /* 观察者永不影响请求链 */ }
    return resolved;
  };
  try { ctx.on('agent/request', observeRoute); } catch {}
  try {
    ctx.on('agent/created', (_carrier, _eventName, payload) => {
      const a = payload?.agent;
      if (a?.ctx?.on && !installedAgents.has(a)) {
        try { installedAgents.add(a); a.ctx.on('agent/request', observeRoute); } catch {}
      }
    });
  } catch {}

  return {
    _test: {
      maybeProject,
      getStore,
      saveStore,
      loadStore,
      observeRoute,
      cfg,
      core: { estimateTokens, messageOfEvent, selectProjectionRange, buildObservation, reflect, renderObservationText, detectSwitch, deriveRequestedModeSafe, validateStore, emptyObs },
    },
  };
}
