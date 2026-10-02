// model-selection-guard.mjs — 模型选择状态完整性守卫（host 插件）
//
// 目标：
//   修复「非法 (provider, model) pair 进入 Agent Request」的架构缺口。
//
// 实现要点（2026-08-22 v2 修正）：
//   v1 的问题：`ctx.on("agent/request", ...)` 注册在 host 全局上下文，
//   但 `agent/request` 是在 **agent 的 scoped 上下文** 上 dispatch 的
//   （cordis 的 dispatch 只收集当前 ctx 的 hooks），导致守卫从未被调用。
//   v2 修正：监听 **全局** `agent/created` 事件（在全局 ctx.events 上 emit，
//   见 dsh-agent/lib/index.js:666-673），拿到 agent 后向 `agent.ctx`
//   （agent 的 scoped 上下文，与 installModelSelection 同 scope）注册
//   `agent/request` 监听器，确保被 agent 的 dispatch 真正调用。
//
// 行为：
//   1. 在 agent/request waterfall 中先 `await next()` 拿到所有下游改写者
//      （openrouter-router / installModelSelection 等）处理后的最终 config；
//   2. 用 ctx.llm.resolveModelInfo 验证最终 (provider, model) 的合法性
//      （唯一真源，不新增白名单、不做 provider 前缀猜测）；
//   3. 非法 pair → 整体回退到 settings agent-default-model（也验证其合法）；
//      default 非法 → fail-loud 原样返回，让上层如实报错（不静默猜模型）；
//   4. 合法 pair 原样放行，不影响任何既有路由/fallback/价格策略。
//
// 挂载：~/.dsh/profiles/web/cordis.patch.yml（insert 段）
// 纯 ESM，零第三方依赖。

import { decideRoute } from './model-selection-guard-core.mjs';
import { pickAgentCreated, createBindingDiagnostics } from './event-shape-compat.mjs';

export const name = 'model-selection-guard';
export const inject = ['llm'];

/** 从 settings 读取默认模型选择（agent-default-model 真源）。 */
function readDefaultSelection(ctx, config) {
  if (config.fallbackProvider && config.fallbackModel) {
    return { provider: config.fallbackProvider, model: config.fallbackModel };
  }
  try {
    const sel = ctx.agentDefaultModel?.currentSelection?.();
    if (sel && typeof sel.provider === 'string' && sel.model && typeof sel.model === 'string') {
      return { provider: sel.provider, model: sel.model };
    }
  } catch {}
  try {
    const ns = ctx.settings?.get?.('agent-default-model');
    if (ns && typeof ns.provider === 'string' && ns.model) {
      return { provider: ns.provider, model: ns.model };
    }
  } catch {}
  return { provider: '', model: '' };
}

export function apply(ctx, config = {}) {
  const resolveModelInfo = (provider, model, signal) => ctx.llm.resolveModelInfo(provider, model, signal);

  // S1 listener binding: dual-substrate shape tolerance + fail-safe diagnostics.
  // Startup self-check proves the picker logic itself handles BOTH official dispatch forms; the
  // first real agent/created then records which form the RUNNING substrate actually used, so a
  // base switch can never silently disable this guard again (§4.4 / §5 of the P4.5 alignment task).
  const shapes = createBindingDiagnostics({ plugin: 'model-selection-guard', logger: ctx.logger });
  const selfTest = shapes.selfTest();

  /** 为单个 agent 的 scoped 上下文注册 agent/request 校验监听器（同一 agent 只装一次）。 */
  const guardedAgents = new WeakSet();
  const installGuardForAgent = (agent) => {
    if (!agent || typeof agent.ctx?.on !== 'function') {
      // A recognised payload shape that still carries no usable agent is a substrate change, not a
      // success: report it instead of returning silently.
      if (agent) shapes.providerUnavailable('agent/created', 'payload carried no usable agent (agent.ctx.on missing)');
      return;
    }
    if (guardedAgents.has(agent)) return; // no duplicate registration on repeated events
    guardedAgents.add(agent);
    const dispose = agent.ctx.on('agent/request', async (payload, next) => {
      const proposedConfig = await next();
      if (!proposedConfig || typeof proposedConfig !== 'object') return proposedConfig;
      const defaultSelection = readDefaultSelection(ctx, config);
      const { config: finalConfig, action, reason } = await decideRoute(
        resolveModelInfo,
        proposedConfig,
        defaultSelection,
        ctx.logger,
        payload?.signal,
      );
      if (action === 'replaced') {
        try { ctx.logger?.info?.(`[model-selection-guard] ${reason}`); } catch {}
      }
      return finalConfig;
    });
    return dispose;
  };

  // 全局 agent/created：agent 注册时向它的 scoped ctx 注入守卫。
  // `agent/created` delivers its payload as ARGUMENT 0 on 0.2.0-rc.2 (wrapper `{ agent, source, signal }`)
  // and as the THIRD argument on 0.1.1 (carrier-first emit form). Accepting only one of the two is what
  // silently inactivated the guard; the picker accepts both and reports the shape it matched.
  const disposeCreated = ctx.on('agent/created', (...args) => {
    let picked;
    try {
      picked = pickAgentCreated(args);
    } catch (error) {
      shapes.report('agent/created', 'picker-threw', false, []);
      return;
    }
    if (!picked.agent) {
      shapes.report('agent/created', picked.shape, false, picked.observed);
      return;
    }
    shapes.report('agent/created', picked.shape, true);
    try {
      installGuardForAgent(picked.agent);
    } catch (error) {
      try { ctx.logger?.warn?.(`[model-selection-guard] install failed: ${String(error?.message ?? error)}`); } catch {}
    }
  });

  return {
    _test: {
      installGuardForAgent,
      readDefaultSelection: () => readDefaultSelection(ctx, config),
      decideRoute,
      pickAgentCreated,
      bindingState: () => shapes.state(),
      selfTest,
      dispose: () => { try { disposeCreated?.(); } catch {} },
    },
  };
}