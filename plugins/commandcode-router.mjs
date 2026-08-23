// commandcode-router.mjs —— Command Code 双模型路由 宿主插件
//
// 机制（与既有 openrouter-router 同构、互不干预）：
//  - 监听 agent/request 瀑布：只在 resolved.provider === 'commandcode' 时介入，
//    把 auto / 具体模型统一决策成本次真正要发的模型（requestModel）。
//    其他 provider（openrouter / opencode / xiaomi / agentrouter 直连）一律原样放过。
//  - 监听 agent/request-error：先让既有 dsh-llm-retry 完成「同模型重试」；它放弃后，
//    再按分类做【一次】跨模型单跳回落（Muse ⇄ DeepSeek V4 Flash，双向）。
//  - 自动回落只写内存里的 armedFallback / temporaryPrimary，
//    【绝不】写 settings.yaml、preferredModel、会话默认或任何持久化模型选择。
//  - 每个 turn 结构性复位 → 不可能出现「一次回落后整个会话被锁死」的粘滞问题。
//
// 环境变量（都可缺省）：
//   CMD_ZDR=1              为 api.commandcode.ai 注入 x-cmd-zdr: 1（零数据保留/不训练）
//                          默认关闭：本 Harness 目前没有全局 ZDR/No-Training 设置，
//                          不擅自开启（强制 ZDR 时无可用上游会 422 cmd_zdr_no_providers）。
//   ROUTER_DIAGNOSTICS=true 把非敏感的路由/回落决定追加到 ~/.dsh/router-diagnostics.log
//   ROUTER_DIAGNOSTICS_FILE 自定义该日志路径
//
// 安全：不记录任何 key/token；日志只有模型 id、分类、原因、会话 id。

import fs from 'node:fs';
import path from 'node:path';
import {
  PROVIDER, AUTO, MUSE, DEEPSEEK, DISPLAY,
  newState, applyTurnBoundary, applyManualSwitch, resolvePreferred,
  decideRequestModel, decideFallback, classifyFailure, normalizeModel, snapshot,
} from './commandcode-router-core.mjs';

export const name = 'commandcode-router';

// ─────────────────────────────────────────────
// 诊断日志（复用既有 sink，不新建第二套）
// ─────────────────────────────────────────────
function diagnosticsPath() {
  const custom = process.env.ROUTER_DIAGNOSTICS_FILE;
  if (custom && custom.length > 0) return custom;
  return path.join(process.env.USERPROFILE || 'C:/Users/Administrator', '.dsh', 'router-diagnostics.log');
}
let fileLogEnabled = false;
function logDiag(sid, fields) {
  if (!fileLogEnabled) return;
  try {
    fs.appendFileSync(
      diagnosticsPath(),
      new Date().toISOString() + ' ' + JSON.stringify({ router: 'commandcode', sid, ts: Date.now(), ...fields }) + '\n',
    );
  } catch {}
}

/** 从 request-error payload 提取失败的模型名（与 openrouter-router 同形） */
function resolvedModelOf(payload) {
  try {
    return payload?.resolved?.model ?? payload?.model ?? payload?.request?.model ?? null;
  } catch {
    return null;
  }
}

// 尽力把回落状态送进 agent-inspector 的审计流（非聊天内容；失败不影响路由）
let recordRouting = null;
async function loadInspectorBridge(ctx) {
  try {
    const mod = await import('./agent-inspector.mjs');
    if (typeof mod.recordRouting === 'function') recordRouting = mod.recordRouting;
  } catch (e) {
    try { ctx?.logger?.info?.('[commandcode-router] inspector bridge unavailable (non-fatal)'); } catch {}
  }
}
function audit(sid, fields) {
  try { recordRouting?.(sid, fields); } catch {}
}

export function apply(ctx) {
  fileLogEnabled = String(process.env.ROUTER_DIAGNOSTICS || '').toLowerCase() === 'true';
  const zdr = String(process.env.CMD_ZDR || '') === '1';
  const state = new Map();
  const getState = (sid) => {
    let s = state.get(sid);
    if (!s) { s = newState(); state.set(sid, s); }
    return s;
  };

  loadInspectorBridge(ctx);

  // ── 可选：为 api.commandcode.ai 注入 ZDR 头（与 agentrouter-wire 同手法） ──
  // 只在显式开启时包装 fetch；默认完全不碰全局 fetch。
  if (zdr) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function commandcodeZdrFetch(input, init) {
      try {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (url.startsWith('https://api.commandcode.ai')) {
          const headers = new Headers(init?.headers ?? (typeof input === 'object' ? input?.headers : undefined));
          headers.set('x-cmd-zdr', '1');
          init = { ...(init ?? {}), headers };
        }
      } catch {}
      return originalFetch.call(this, input, init);
    };
    ctx.on('dispose', () => { globalThis.fetch = originalFetch; });
    try { ctx.logger?.info?.('[commandcode-router] ZDR enabled: x-cmd-zdr:1 for api.commandcode.ai'); } catch {}
  }

  // ─────────────────────────────────────────────
  // agent/request：决定本次真正要发的模型
  // ─────────────────────────────────────────────
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next();
    if (!resolved) return resolved;
    // 严格只管自己的 provider —— 绝不干预其他任何 provider 的既有行为
    if (resolved.provider !== PROVIDER) return resolved;

    const sid = payload?.agent?.session?.id ?? '?';
    const st = getState(sid);
    try {
      // turn 边界复位（防粘滞的结构性保证）。
      // baseline 取本 turn 起始时的解析模型 —— 此刻尚未发生任何回落，故它是真实默认/选择。
      const turnReset = applyTurnBoundary(st, payload?.turn, resolved.model);

      // 用户意图 = 会话级选择（agent.options.model）。
      // 【绝不】用 resolved.model 当意图：后续 step 里它可能是「上一步我路由出的模型」，
      // 会被误判成用户显式指定 → 这正是 sticky fallback bug 的成因。
      const intentRaw = payload?.agent?.options?.model;
      const intent = intentRaw && String(intentRaw).length > 0 ? String(intentRaw) : null;
      const manualSwitch = applyManualSwitch(st, intent);

      // 优先级：手动覆盖 > preferredModel > 自动回落
      st.preferredModel = resolvePreferred(intent, st.baselineModel);
      const { model: requestModel, source } = decideRequestModel(st);

      if (manualSwitch) {
        logDiag(sid, { type: 'manual-switch', to: requestModel, cleared: 'armedFallback+temporaryPrimary' });
        audit(sid, { type: 'cc-manual-switch', preferredModel: st.preferredModel, requestModel });
      }
      if (turnReset) {
        logDiag(sid, { type: 'turn-reset', turn: st.turnKey, baseline: st.baselineModel, preferred: st.preferredModel });
      }
      if (source === 'fallback' || source === 'temporary-primary') {
        logDiag(sid, { type: 'request-model', source, model: requestModel, preferred: st.preferredModel });
        audit(sid, {
          type: 'cc-fallback-active',
          source,
          preferredModel: st.preferredModel,
          requestModel,
          display: DISPLAY[requestModel] ?? requestModel,
          note: 'automatic fallback — session default unchanged',
        });
      }
      if (fileLogEnabled) {
        logDiag(sid, {
          type: 'decision',
          request_id: `${payload?.turn ?? '-'}.${payload?.step ?? '-'}`,
          requested_model: resolved.model,
          preferred_model: st.preferredModel,
          request_model: requestModel,
          source,
        });
      }

      // Command Code provider/v1 无文档化的 reasoning_effort 参数 → 一律剥离，避免 400
      const { reasoningEffort: _effort, ...rest } = resolved;
      return { ...rest, provider: PROVIDER, model: requestModel };
    } catch (e) {
      // 路由失败绝不阻断请求：auto 兜底到 DeepSeek，其余原样放过
      logDiag(sid, { type: 'route-error', error: String(e && e.message) });
      if (resolved.model === AUTO) return { ...resolved, provider: PROVIDER, model: DEEPSEEK };
      return resolved;
    }
  });

  // ─────────────────────────────────────────────
  // agent/request-error：一次跨模型单跳回落（双向）
  // ─────────────────────────────────────────────
  ctx.on('agent/request-error', async (payload, next) => {
    // 先让既有 dsh-llm-retry 做「同模型重试」；它要求重试就尊重它
    const action = await next();
    if (action && action.kind === 'retry') return action;
    if (!payload) return action;
    if (payload.provider !== PROVIDER) return action;

    const sid = payload.agent?.session?.id ?? '?';
    const st = getState(sid);
    const failure = payload.failure;
    const failedModel = resolvedModelOf(payload);

    const d = decideFallback({ state: st, failedModel, failure });
    logDiag(sid, {
      type: 'fallback-decision',
      failed_model: normalizeModel(failedModel) ?? failedModel,
      classification: d.classification,
      retry: d.retry,
      armed: d.armed,
      stop: d.stop ?? false,
      reason: d.reason,
      // 关键不变量：无论如何 preferredModel 都没被改
      preferred_model_unchanged: st.preferredModel,
    });
    if (d.armed) {
      audit(sid, {
        type: 'cc-fallback',
        from: normalizeModel(failedModel) ?? failedModel,
        to: d.armed,
        fromDisplay: DISPLAY[normalizeModel(failedModel)] ?? failedModel,
        toDisplay: DISPLAY[d.armed] ?? d.armed,
        classification: d.classification,
        preferredModel: st.preferredModel,
        note: 'temporary for this request only — session default unchanged',
      });
    }
    if (d.stop) {
      audit(sid, { type: 'cc-fallback-exhausted', classification: d.classification, reason: d.reason });
    }
    if (d.retry) return { kind: 'retry' };
    return action;
  });

  ctx.effect(() => () => { state.clear(); }, 'commandcode-router: reset state');

  return {
    state,
    /** 供诊断/UI 读取：每个会话的 preferred vs request 拆分状态 */
    diagnostics: () => ({
      provider: PROVIDER,
      models: { primary: DEEPSEEK, fallback: MUSE },
      display: DISPLAY,
      zdr,
      diagnosticsLog: fileLogEnabled ? diagnosticsPath() : null,
      activeSessions: [...state.keys()],
      sessions: Object.fromEntries([...state.entries()].map(([sid, s]) => [sid, snapshot(s)])),
      invariants: {
        autoFallbackNeverWritesPreferred: true,
        maxCrossModelFallbacksPerTurn: 1,
        resetsOnNewTurn: true,
      },
    }),
    _test: { getState, state, classifyFailure, decideFallback, decideRequestModel },
  };
}
