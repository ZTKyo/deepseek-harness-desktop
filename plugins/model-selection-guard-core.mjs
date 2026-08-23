// model-selection-guard-core.mjs — 模型选择合法性校验核心（纯函数，可测试）
//
// 职责：
//   1. 验证 (provider, model) pair 在当前 Registry 中是否有效
//   2. 非法 pair 时回退到合法默认选择
//   3. 永不做前缀猜测，永远复用 ctx.llm.resolveModelInfo 作为唯一真源
//
// 设计原则：
//   - ModelSelection 是不可分割的原子对象
//   - provider + model 必须作为一个整体验证
//   - 非法 pair 整体拒绝，旧状态不变
//   - 回退由明确配置决定（settings agent-default-model），不猜模型

/**
 * 验证一个 (provider, model) pair 在当前 Registry 中是否有效。
 * 复用 ctx.llm.resolveModelInfo 作为唯一真源（不新增白名单，不做前缀猜测）。
 *
 * @param {function} resolveModelInfo - 签名 (provider, model, signal?) => Promise<modelInfo>
 * @param {string} provider
 * @param {string} model
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ valid: boolean, info?: object, error?: string }>}
 */
export async function validateSelection(resolveModelInfo, provider, model, signal) {
  if (!provider || !model) {
    return { valid: false, error: 'provider and model must be non-empty strings' };
  }
  try {
    const info = await resolveModelInfo(provider, model, signal);
    if (!info || typeof info.id !== 'string') {
      return { valid: false, error: `resolveModelInfo returned no valid model info for (${provider}, ${model})` };
    }
    return { valid: true, info };
  } catch (e) {
    // 包括 UNKNOWN_MODEL、NO_ADAPTER 等 LlmError
    const message = e?.message ?? String(e);
    return { valid: false, error: message };
  }
}

/**
 * 决策最终路由：校验 proposed (provider, model)，非法则回退到合法默认。
 *
 * 规则：
 *   - 合法 pair → passthrough（原样放行，不干预）
 *   - 非法 pair → 回退到 defaultSelection（也验证其合法性）
 *     - default 合法 → 返回替换后的 config + action='replaced'
 *     - default 非法 → 返回原 config + action='failed'（让上层报错）
 *   - 缺 provider/model → passthrough（由上游 buildRequest 报错）
 *
 * @param {function} resolveModelInfo - 签名 (provider, model, signal?) => Promise<modelInfo>
 * @param {{ provider: string, model: string, [key: string]: any }} proposedConfig - waterfall 输出的最终 config
 * @param {{ provider: string, model: string }} defaultSelection - settings agent-default-model
 * @param {{ warn?: Function, error?: Function, info?: Function }} [logger]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ config: object, action: 'passthrough'|'replaced'|'failed', reason?: string }>}
 */
export async function decideRoute(resolveModelInfo, proposedConfig, defaultSelection, logger, signal) {
  const { provider, model } = proposedConfig || {};

  // 缺 provider/model：由上游 buildRequest 报错，不干预
  if (!provider || !model) {
    return { config: proposedConfig, action: 'passthrough' };
  }

  // 验证 proposed pair
  const { valid, error } = await validateSelection(resolveModelInfo, provider, model, signal);
  if (valid) {
    return { config: proposedConfig, action: 'passthrough' };
  }

  // 非法 pair：记录警告
  const errMsg = `[model-selection-guard] invalid selection (provider="${provider}", model="${model}"): ${error}. Falling back to default (provider="${defaultSelection?.provider}", model="${defaultSelection?.model}").`;
  logger?.warn?.(errMsg);

  // 验证 default 的合法性
  if (!defaultSelection?.provider || !defaultSelection?.model) {
    logger?.error?.(`[model-selection-guard] defaultSelection is incomplete (provider="${defaultSelection?.provider}", model="${defaultSelection?.model}"). Cannot fall back.`);
    return { config: proposedConfig, action: 'failed', reason: 'defaultSelection incomplete' };
  }

  const { valid: defaultValid, error: defaultError } = await validateSelection(
    resolveModelInfo, defaultSelection.provider, defaultSelection.model, signal
  );

  if (!defaultValid) {
    logger?.error?.(`[model-selection-guard] default selection also invalid (provider="${defaultSelection.provider}", model="${defaultSelection.model}"): ${defaultError}. Routing rejected.`);
    return { config: proposedConfig, action: 'failed', reason: 'defaultSelection invalid' };
  }

  // 返回替换后的 config（仅替换 provider/model，保留原 config 的其他字段如 reasoningEffort、maxTokens）
  return {
    config: { ...proposedConfig, provider: defaultSelection.provider, model: defaultSelection.model },
    action: 'replaced',
    reason: `invalid selection (${provider}, ${model}) replaced by default (${defaultSelection.provider}, ${defaultSelection.model})`,
  };
}