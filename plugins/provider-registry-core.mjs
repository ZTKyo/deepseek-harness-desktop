// provider-registry-core.mjs —— Provider Registry + Global Role Policy（唯一真源）
//
// 设计原则：
//   1. 所有 Provider 都在此注册，区分 OFFICIAL_DIRECT 与 MULTI_MODEL_RELAY
//   2. Global Role Policy（角色 → 别名/模型指针）在此定义
//   3. 角色指针可被一句话切换（如「主力换成 X」），但需验证后生效
//   4. 本模块不做网络/不做 I/O / 不调用 LLM，纯数据模块
//   5. router-core.mjs / Inspector / Doctor 均从本模块导入角色信息
//
// 依赖：无（纯 ESM，零第三方）

// ─────────────────────────────────────────────
// Provider 类型常量
// ─────────────────────────────────────────────
export const ProviderType = Object.freeze({
  OFFICIAL_DIRECT: 'OFFICIAL_DIRECT',     // 官方直连 API（DeepSeek / MiMo / etc）
  MULTI_MODEL_RELAY: 'MULTI_MODEL_RELAY', // 多模型中转（OpenRouter / OpenCode Go / etc）
});

// ─────────────────────────────────────────────
// 模型生命周期状态
// ─────────────────────────────────────────────
export const ModelState = Object.freeze({
  DISCOVERED: 'DISCOVERED',
  CANDIDATE: 'CANDIDATE',
  CANARY: 'CANARY',
  ACTIVE: 'ACTIVE',
  DEPRIORITIZED: 'DEPRIORITIZED',
  DRAINING: 'DRAINING',
  DISABLED: 'DISABLED',
  SUSPENDED_BY_COST: 'SUSPENDED_BY_COST',
  REMOVED: 'REMOVED',
});

// ─────────────────────────────────────────────
// Provider 生命周期状态
// ─────────────────────────────────────────────
export const ProviderState = Object.freeze({
  ACTIVE: 'ACTIVE',
  DRAINING: 'DRAINING',
  DISABLED: 'DISABLED',
  REMOVED: 'REMOVED',
});

// ─────────────────────────────────────────────
// 核心角色常量（Global Role Policy）
// ─────────────────────────────────────────────
export const Role = Object.freeze({
  PRIMARY: 'PRIMARY',                     // 主力推理（复杂/编码/debug/默认）
  AUXILIARY: 'AUXILIARY',                 // 辅助（长上下文/轻量多模态）
  VISION: 'VISION',                       // 视觉/多模态专属
  CHEAP_WORKER: 'CHEAP_WORKER',           // 廉价执行（摘要/分类/提取/批量）
  STRONG_ESCALATION: 'STRONG_ESCALATION', // 强力升级（仅在 PRIMARY 质量失败≥2次后）
  RESEARCH_WORKER: 'RESEARCH_WORKER',     // 研究型 Worker
  FINAL_SYNTHESIS: 'FINAL_SYNTHESIS',     // 最终汇总
  COMPLEX_DEBUG: 'COMPLEX_DEBUG',         // 复杂调试专属
});

// ─────────────────────────────────────────────
// 默认 Provider 注册表（唯一真源）
// ─────────────────────────────────────────────
export const DEFAULT_PROVIDERS = Object.freeze({
  openrouter: Object.freeze({
    id: 'openrouter',
    displayName: 'OpenRouter',
    type: ProviderType.MULTI_MODEL_RELAY,
    state: ProviderState.ACTIVE,
    supportsAutoRouter: true,
    settingsKey: 'openrouter',       // settings.yaml 中的 key
    envKey: 'OPENROUTER_API_KEY',    // 凭据环境变量
    baseURL: 'https://openrouter.ai/api/v1',
    models: Object.freeze({
      'qwen/qwen3.7-flash': Object.freeze({ id: 'qwen/qwen3.7-flash', name: 'Qwen3.7-Flash', state: ModelState.ACTIVE, roles: [Role.CHEAP_WORKER] }),
      'deepseek/deepseek-v4-flash-0731': Object.freeze({ id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek-V4-Flash', state: ModelState.ACTIVE, roles: [Role.PRIMARY] }),
      'xiaomi/mimo-v2.5': Object.freeze({ id: 'xiaomi/mimo-v2.5', name: 'MiMo-V2.5', state: ModelState.ACTIVE, roles: [Role.AUXILIARY, Role.VISION] }),
      // Ox Alpha（2026-08-20 发布，stealth/ox-alpha）：专为编码/长时程 agent/生产级任务设计的
      // 推理模型；输入 text+image+video、1M 上下文、最大输出 131k；当前定价 0。
      // 接入方式：作为可选项（GUI 手动选择 + 手动调用），不改动默认角色指针与 auto-router 三模型链。
      // 实测（2026-08-21）：OpenRouter chat/completions 200 OK，正常生成。
      'stealth/ox-alpha': Object.freeze({ id: 'stealth/ox-alpha', name: 'Ox Alpha', state: ModelState.ACTIVE, roles: [Role.AUXILIARY] }),
    }),
  }),

  opencode: Object.freeze({
    id: 'opencode',
    displayName: 'OpenCode Go',
    type: ProviderType.MULTI_MODEL_RELAY,
    state: ProviderState.ACTIVE,
    supportsAutoRouter: false,   // 当前默认不建 auto-router（直连为主）
    settingsKey: 'opencode',
    envKey: 'OPENCODE_API_KEY',
    baseURL: 'https://opencode.ai/zen/go/v1',
    models: Object.freeze({
      'deepseek-v4-flash': Object.freeze({ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', state: ModelState.ACTIVE, roles: [Role.PRIMARY] }),
      'deepseek-v4-pro': Object.freeze({ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', state: ModelState.ACTIVE, roles: [Role.STRONG_ESCALATION] }),
      'deepseek-v4-flash-vision-exp': Object.freeze({ id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp', state: ModelState.ACTIVE, roles: [Role.VISION] }),
      'mimo-v2.5': Object.freeze({ id: 'mimo-v2.5', name: 'MiMo-V2.5', state: ModelState.ACTIVE, roles: [Role.VISION] }),
    }),
  }),

  xiaomi: Object.freeze({
    id: 'xiaomi',
    displayName: '小米 MiMo',
    type: ProviderType.OFFICIAL_DIRECT,
    state: ProviderState.ACTIVE,
    supportsAutoRouter: false,
    settingsKey: 'xiaomi',
    envKey: 'MIMO_API_KEY',
    models: Object.freeze({
      'mimo-v2.5': Object.freeze({ id: 'mimo-v2.5', name: 'MiMo-V2.5', state: ModelState.ACTIVE, roles: [Role.VISION] }),
      'mimo-v2.5-pro': Object.freeze({ id: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro', state: ModelState.ACTIVE, roles: [] }),
      'mimo-v2.5-pro-ultraspeed': Object.freeze({ id: 'mimo-v2.5-pro-ultraspeed', name: 'MiMo-V2.5-Pro-Ultraspeed', state: ModelState.ACTIVE, roles: [] }),
    }),
  }),

  'opencode-qwen': Object.freeze({
    id: 'opencode-qwen',
    displayName: 'OpenCode Qwen',
    type: ProviderType.OFFICIAL_DIRECT,
    state: ProviderState.ACTIVE,
    supportsAutoRouter: false,
    settingsKey: 'opencode-qwen',
    envKey: 'OPENCODE_API_KEY',
    models: Object.freeze({
      'qwen3.7-plus': Object.freeze({ id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', state: ModelState.ACTIVE, roles: [Role.VISION] }),
    }),
  }),

  'opencode-free': Object.freeze({
    id: 'opencode-free',
    displayName: 'OpenCode Free',
    type: ProviderType.OFFICIAL_DIRECT,
    state: ProviderState.ACTIVE,
    supportsAutoRouter: false,
    settingsKey: 'opencode-free',
    envKey: 'OPENCODE_API_KEY',
    models: Object.freeze({
      'deepseek-v4-flash-free': Object.freeze({ id: 'deepseek-v4-flash-free', name: 'DeepSeek-V4-Flash-Free', state: ModelState.ACTIVE, roles: [] }),
    }),
  }),

  'agentrouter-openai': Object.freeze({
    id: 'agentrouter-openai',
    displayName: 'AgentRouter',
    type: ProviderType.MULTI_MODEL_RELAY,
    state: ProviderState.ACTIVE,
    supportsAutoRouter: true,
    settingsKey: 'agentrouter-openai',
    envKey: 'AGENTROUTER_API_KEY',
    models: Object.freeze({
      'gpt-5.6-sol': Object.freeze({ id: 'gpt-5.6-sol', name: 'ChatGPT 5.6 Sol', state: ModelState.ACTIVE, roles: [Role.STRONG_ESCALATION] }),
    }),
  }),

  'agentrouter-anthropic': Object.freeze({
    id: 'agentrouter-anthropic',
    displayName: 'AgentRouter',
    type: ProviderType.MULTI_MODEL_RELAY,
    state: ProviderState.ACTIVE,
    supportsAutoRouter: true,
    settingsKey: 'agentrouter-anthropic',
    envKey: 'AGENTROUTER_API_KEY',
    models: Object.freeze({
      'claude-opus-5': Object.freeze({ id: 'claude-opus-5', name: 'Claude Opus 5', state: ModelState.ACTIVE, roles: [Role.STRONG_ESCALATION] }),
      'claude-opus-4-8': Object.freeze({ id: 'claude-opus-4-8', name: 'Claude Opus 4.8', state: ModelState.ACTIVE, roles: [Role.STRONG_ESCALATION] }),
    }),
  }),

  // Command Code（2026-08-20 接入；2026-08-21 起 DeepSeek 为主力 / Muse 为质量型 fallback）
  // 模型 ID 经 GET https://api.commandcode.ai/provider/v1/models 实时验证，大小写敏感。
  // 只登记「真实存在的模型」；settings.yaml 里另有一个 'auto' 占位条目仅供 UI 选定/展示，
  // 它不是真模型，故刻意不进本注册表（本表是真实模型目录，role 指针只能指向真模型）。
  // 角色说明：DeepSeek V4 Flash = PRIMARY（默认主力）；Muse = AUXILIARY，
  // 在本机语义下即「PRIMARY 的质量型单跳 fallback」（枚举无 FALLBACK 项，不新增冻结枚举值）。
  // 真正的 DeepSeek ⇄ Muse 双向单跳回落行为由 commandcode-router.mjs 承载（行为真源）。
  commandcode: Object.freeze({
    id: 'commandcode',
    displayName: 'Command Code',
    type: ProviderType.MULTI_MODEL_RELAY,
    state: ProviderState.ACTIVE,
    supportsAutoRouter: true,
    settingsKey: 'commandcode',
    envKey: 'CMD_API_KEY',
    baseURL: 'https://api.commandcode.ai/provider/v1',
    models: Object.freeze({
      'meta/muse-spark-1.2-contributor': Object.freeze({ id: 'meta/muse-spark-1.2-contributor', name: 'Muse Spark 1.2 Contributor', state: ModelState.ACTIVE, roles: [Role.AUXILIARY] }),
      'deepseek/deepseek-v4-flash': Object.freeze({ id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', state: ModelState.ACTIVE, roles: [Role.PRIMARY] }),
      'deepseek/deepseek-v4-flash-vision-exp': Object.freeze({ id: 'deepseek/deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp', state: ModelState.ACTIVE, roles: [Role.VISION] }),
    }),
  }),

  // B.AI（2026-08-20 接入）。端点 https://api.b.ai/v1 已实测：deepseek-v4-flash
  // 流式/非流式均 200 正常；deepseek-v4-pro 需账户充值（403 access_denied），不登记。
  // 无专属 auto-router，plain OpenAI 兼容中转；不改变 DEFAULT_ROLE_POLICY 任何指针。
  bai: Object.freeze({
    id: 'bai',
    displayName: 'B.AI',
    type: ProviderType.MULTI_MODEL_RELAY,
    state: ProviderState.ACTIVE,
    supportsAutoRouter: false,
    settingsKey: 'bai',
    envKey: 'BAI_API_KEY',
    baseURL: 'https://api.b.ai/v1',
    models: Object.freeze({
      'deepseek-v4-flash': Object.freeze({ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', state: ModelState.ACTIVE, roles: [Role.PRIMARY] }),
      'deepseek-v4-flash-vision-exp': Object.freeze({ id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp', state: ModelState.ACTIVE, roles: [Role.VISION] }),
    }),
  }),
});

// ─────────────────────────────────────────────
// 默认 Global Role Policy（角色 → 别名指针）
// ─────────────────────────────────────────────
// 角色指针是可变的（可被"一句话切换"修改），但默认值稳定。
// 「指针」= { provider, modelId } 对。
export const DEFAULT_ROLE_POLICY = Object.freeze({
  // 与 settings.yaml agent-default-model 真源对齐
  // （2026-08-21 定稿：PRIMARY = B.AI DeepSeek V4 Flash，普通文本/代码/Agent 任务默认主力）
  [Role.PRIMARY]: Object.freeze({ provider: 'bai', modelId: 'deepseek-v4-flash', alias: 'deepseek' }),
  [Role.AUXILIARY]: Object.freeze({ provider: 'openrouter', modelId: 'xiaomi/mimo-v2.5', alias: 'mimo' }),
  [Role.VISION]: Object.freeze({ provider: 'opencode', modelId: 'mimo-v2.5', alias: 'mimo' }),
  [Role.CHEAP_WORKER]: Object.freeze({ provider: 'openrouter', modelId: 'qwen/qwen3.7-flash', alias: 'qwen' }),
  [Role.STRONG_ESCALATION]: Object.freeze({ provider: 'opencode', modelId: 'deepseek-v4-pro', alias: 'deepseek' }),
  [Role.RESEARCH_WORKER]: Object.freeze({ provider: 'openrouter', modelId: 'deepseek/deepseek-v4-flash-0731', alias: 'deepseek' }),
  [Role.FINAL_SYNTHESIS]: Object.freeze({ provider: 'openrouter', modelId: 'deepseek/deepseek-v4-flash-0731', alias: 'deepseek' }),
  [Role.COMPLEX_DEBUG]: Object.freeze({ provider: 'openrouter', modelId: 'deepseek/deepseek-v4-flash-0731', alias: 'deepseek' }),
});

// ─────────────────────────────────────────────
// 昂贵模型列表（automatic_first_choice = false）
// ─────────────────────────────────────────────
export const EXPENSIVE_MODELS = Object.freeze([
  'deepseek-v4-pro',
  'claude-opus-5',
  'claude-opus-4-8',
  'gpt-5.6-sol',
]);

// ─────────────────────────────────────────────
// 显式 Router（provider → 是否拥有自己的 Auto Router）
// ─────────────────────────────────────────────
export const AUTO_ROUTERS = Object.freeze({
  openrouter: Object.freeze({
    provider: 'openrouter',
    coreModule: 'openrouter-router-core.mjs',  // 现有单一真源
    supports: true,
  }),
  // Command Code（2026-08-20）：Muse ⇄ DeepSeek V4 Flash 双向单跳回落。
  // 与 openrouter 的三模型链彼此独立、互不干预（各自只拦自己的 provider）。
  commandcode: Object.freeze({
    provider: 'commandcode',
    coreModule: 'commandcode-router.mjs',
    supports: true,
  }),
  // 未来中转 API 接入时在此注册：
  // opencode: { provider: 'opencode', coreModule: 'opencode-router-core.mjs', supports: true },
});

// ─────────────────────────────────────────────
// 查询函数
// ─────────────────────────────────────────────

/** 获取所有注册的 provider */
export function listProviders() {
  return Object.values(DEFAULT_PROVIDERS);
}

/** 按 ID 获取 provider */
export function getProvider(id) {
  return DEFAULT_PROVIDERS[id] ?? null;
}

/** 获取 provider 的所有 active 模型 */
export function getActiveModels(providerId) {
  const p = getProvider(providerId);
  if (!p) return [];
  return Object.values(p.models).filter(m => m.state === ModelState.ACTIVE);
}

/** 获取所有 MULTI_MODEL_RELAY 类型的 provider */
export function getRelayProviders() {
  return listProviders().filter(p => p.type === ProviderType.MULTI_MODEL_RELAY && p.state === ProviderState.ACTIVE);
}

/** 获取所有 OFFICIAL_DIRECT 类型的 provider */
export function getDirectProviders() {
  return listProviders().filter(p => p.type === ProviderType.OFFICIAL_DIRECT && p.state === ProviderState.ACTIVE);
}

/** 获取某个角色当前指向的 { provider, modelId, alias } */
export function getRolePointer(role) {
  return DEFAULT_ROLE_POLICY[role] ?? null;
}

/** 检查某个模型是否属于昂贵模型 */
export function isExpensive(modelId) {
  return EXPENSIVE_MODELS.includes(modelId);
}

/** 获取某个 provider 的 auto-router 配置（如果有） */
export function getAutoRouter(providerId) {
  return AUTO_ROUTERS[providerId] ?? null;
}

/** 一句话切换角色指针（返回新指针，不持久化） */
export function switchRolePointer(role, providerId, modelId) {
  const provider = getProvider(providerId);
  if (!provider) return { ok: false, reason: `provider "${providerId}" not found` };
  const model = provider.models[modelId];
  if (!model) return { ok: false, reason: `model "${modelId}" not found in provider "${providerId}"` };
  if (model.state !== ModelState.ACTIVE) return { ok: false, reason: `model "${modelId}" state is ${model.state}, not ACTIVE` };
  if (isExpensive(modelId)) return { ok: false, reason: `model "${modelId}" is expensive — use explicit escalation instead of role switch`, expensive: true };
  // 返回新指针（调用方决定是否持久化到 settings/preset）
  return { ok: true, pointer: Object.freeze({ provider: providerId, modelId, alias: model.roles[0] === Role.CHEAP_WORKER ? 'qwen' : model.roles.includes(Role.VISION) ? 'mimo' : 'deepseek' }) };
}

// ═════════════════════════════════════════════
// Provider / Model 生命周期管理（正式生命周期）
// ═════════════════════════════════════════════
// 状态转换规则：
//   模型：DISCOVERED → CANDIDATE → CANARY → ACTIVE
//        ACTIVE → DRAINING → DISABLED → REMOVED
//        ACTIVE → DEPRIORITIZED → SUSPENDED_BY_COST（促销期结束时）
//        SUSPENDED_BY_COST → CANARY → ACTIVE（重新打折时）
//   Provider：ACTIVE → DRAINING → DISABLED → REMOVED

/** 运行时模型状态覆盖表（内存，不修改常量 DEFAULT_PROVIDERS） */
const modelStateOverride = new Map(); // key: "providerId/modelId" → ModelState
const providerStateOverride = new Map(); // key: providerId → ProviderState
/** 模型健康/质量统计（用于生命周期门槛判断） */
export const modelHealth = new Map(); // key → { successRate, retryRate, latencyMs, costPerTask, lastSeen }

const providerModelKey = (pid, mid) => `${pid}/${mid}`;

/** 读取模型当前生效状态（常量默认 + 运行时覆盖） */
export function getModelState(providerId, modelId) {
  const ov = modelStateOverride.get(providerModelKey(providerId, modelId));
  if (ov) return ov;
  const p = getProvider(providerId);
  return p?.models?.[modelId]?.state ?? null;
}

/** 读取 Provider 当前生效状态 */
export function getProviderState(providerId) {
  const ov = providerStateOverride.get(providerId);
  if (ov) return ov;
  return getProvider(providerId)?.state ?? null;
}

/** 模型上报健康数据：successRate(0-1) / retryRate / latencyMs / costPerTask(USD) */
export function reportModelHealth(providerId, modelId, data) {
  const key = providerModelKey(providerId, modelId);
  const prev = modelHealth.get(key) ?? {};
  const merged = {
    ...prev,
    ...data,
    lastSeen: Date.now(),
    reports: (prev.reports ?? 0) + 1,
  };
  modelHealth.set(key, merged);
  return merged;
}

/** 生命周期转换（非法转换返回 { ok:false, reason }） */
const MODEL_TRANSITIONS = {
  DISCOVERED: ['CANDIDATE', 'REMOVED'],
  CANDIDATE: ['CANARY', 'DISCOVERED', 'REMOVED'],
  CANARY: ['ACTIVE', 'CANDIDATE', 'SUSPENDED_BY_COST', 'REMOVED'],
  ACTIVE: ['DRAINING', 'DEPRIORITIZED', 'SUSPENDED_BY_COST', 'DISABLED', 'REMOVED'],
  DEPRIORITIZED: ['SUSPENDED_BY_COST', 'ACTIVE', 'DISABLED', 'REMOVED'],
  SUSPENDED_BY_COST: ['CANARY', 'ACTIVE', 'DISABLED', 'REMOVED'],
  DRAINING: ['DISABLED', 'REMOVED', 'ACTIVE'],
  DISABLED: ['REMOVED', 'ACTIVE', 'CANARY'],
  REMOVED: ['DISCOVERED'],
};
export function transitionModel(providerId, modelId, toState) {
  const key = providerModelKey(providerId, modelId);
  const from = getModelState(providerId, modelId);
  if (from === null) return { ok: false, reason: `model "${modelId}" not found in provider "${providerId}"` };
  const allowed = MODEL_TRANSITIONS[from] ?? [];
  if (!allowed.includes(toState)) return { ok: false, reason: `invalid transition ${from} → ${toState} (allowed: ${allowed.join('→')})` };
  modelStateOverride.set(key, toState);
  return { ok: true, from, to: toState };
}

const PROVIDER_TRANSITIONS = {
  ACTIVE: ['DRAINING', 'DISABLED', 'REMOVED'],
  DRAINING: ['DISABLED', 'REMOVED', 'ACTIVE'],
  DISABLED: ['REMOVED', 'ACTIVE'],
  REMOVED: ['ACTIVE'],
};
export function transitionProvider(providerId, toState) {
  const from = getProviderState(providerId);
  if (from === null) return { ok: false, reason: `provider "${providerId}" not found` };
  const allowed = PROVIDER_TRANSITIONS[from] ?? [];
  if (!allowed.includes(toState)) return { ok: false, reason: `invalid provider transition ${from} → ${toState}` };
  providerStateOverride.set(providerId, toState);
  return { ok: true, from, to: toState };
}

// ═════════════════════════════════════════════
// Economy Pool（廉价模型池 · 动态竞争）
// ═════════════════════════════════════════════
// 核心设计：
//   - 廉价池不是"最便宜获胜"，而是"通过最低门槛后按 CPST（Cost Per Successful Task）竞争"
//   - 免费但经常失败的模型不能进廉价池
//   - 需要 hysteresis：廉价角色切换必须达到显著优势阈值 + 连续确认，防价格抖动抽风
//   - 廉价池为空 → 简单任务 fallback PRIMARY（质量优先）

/** Economy Pool 配置（可被环境变量覆盖） */
export function economyConfig() {
  return Object.freeze({
    // 最低门槛
    minSuccessRate: Number(process.env.ECONOMY_MIN_SUCCESS_RATE || 0.85),   // 成功率 ≥85%
    maxRetryRate: Number(process.env.ECONOMY_MAX_RETRY_RATE || 0.15),       // 重试率 ≤15%
    maxLatencyMs: Number(process.env.ECONOMY_MAX_LATENCY_MS || 30000),      // 延迟 ≤30s
    // hysteresis：切换/降级需要达到的显著优势阈值 + 连续确认次数
    advantageThresholdPct: Number(process.env.ECONOMY_ADVANTAGE_PCT || 15), // CPST 优势 ≥15% 才切换
    confirmCount: Number(process.env.ECONOMY_CONFIRM_COUNT || 3),           // 连续 3 次检查确认
  });
}

export const economyState = { candidates: [] }; // 动态缓存

/** 计算 Cost Per Successful Task（CPST） */
export function computeCpst(pricePerTask, successRate, retryRate) {
  // 有效任务成本 = 基础价格折算 + 重试成本；按成功任务分摊
  const p = Number(pricePerTask) || 0;
  const s = Number(successRate) || 0;
  const r = Number(retryRate) || 0;
  if (s <= 0) return Infinity;
  // 每次尝试成本 ≈ p * (1 + r)（重试增加成本）；成功任务数占比 s
  // CPST = 总尝试成本 / 成功任务数 = p * (1 + r) / s
  return (p * (1 + r)) / s;
}

/**
 * Economy Pool 最低门槛检查：不通过的模型不能进入廉价池。
 * @returns { { pass: boolean, reasons: string[], cpst: number|null } }
 */
export function checkEconomyEligibility(providerId, modelId) {
  const h = modelHealth.get(providerModelKey(providerId, modelId));
  const cfg = economyConfig();
  const reasons = [];
  if (!h || typeof h.successRate !== 'number') reasons.push('no health data (canary required first)');
  else {
    if (h.successRate < cfg.minSuccessRate) reasons.push(`success rate ${h.successRate} < ${cfg.minSuccessRate}`);
    if ((h.retryRate ?? 0) > cfg.maxRetryRate) reasons.push(`retry rate ${h.retryRate} > ${cfg.maxRetryRate}`);
    if ((h.latencyMs ?? 0) > cfg.maxLatencyMs) reasons.push(`latency ${h.latencyMs}ms > ${cfg.maxLatencyMs}ms`);
  }
  // 免费但经常失败：CPST 检查（成本低但成功率差 → CPST 高 → 不选）
  let cpst = null;
  if (h && typeof h.costPerTask === 'number' && typeof h.successRate === 'number') {
    cpst = computeCpst(h.costPerTask, h.successRate, h.retryRate ?? 0);
  }
  const state = getModelState(providerId, modelId);
  if (state !== ModelState.ACTIVE && state !== ModelState.CANARY) reasons.push(`model state ${state} not eligible`);
  return { pass: reasons.length === 0, reasons, cpst };
}

/** Economy Pool 候选注册（一个 provider 下所有标记为 CHEAP_WORKER 且通过门槛的模型） */
export function getEconomyPool() {
  const cfg = economyConfig();
  const pool = [];
  for (const p of listProviders()) {
    for (const mid of Object.keys(p.models ?? {})) {
      const m = p.models[mid];
      if (!m.roles.includes(Role.CHEAP_WORKER)) continue;
      const elig = checkEconomyEligibility(p.id, mid);
      if (elig.pass) {
        pool.push({
          provider: p.id,
          modelId: mid,
          state: getModelState(p.id, mid),
          cpst: elig.cpst ?? Infinity,
        });
      }
    }
  }
  // 按 CPST 升序（成本/成功任务 最低优先），但必须通过门槛
  pool.sort((a, b) => a.cpst - b.cpst);
  economyState.candidates = pool;
  return pool;
}

/**
 * 选择廉价 Worker：返回最优廉价模型或 null（池为空时由调用方 fallback PRIMARY）。
 * hysteresis：只接受"显著优势"的候选，且需要 confirmCount 次连续确认。
 */
export const economyWinner = { candidate: null, confirmStreak: 0, lastCheck: 0 };

export function selectEconomyWorker(now = Date.now()) {
  const cfg = economyConfig();
  const pool = getEconomyPool();
  if (pool.length === 0) {
    economyWinner.candidate = null;
    economyWinner.confirmStreak = 0;
    return { ok: false, poolEmpty: true, fallbackToPrimary: true, reason: 'economy pool empty → PRIMARY (quality first)' };
  }
  const best = pool[0];
  // hysteresis：如果候选变化，需要连续 confirmCount 次检查确认才切换
  const key = `${best.provider}/${best.modelId}`;
  const prevKey = economyWinner.candidate ? `${economyWinner.candidate.provider}/${economyWinner.candidate.modelId}` : null;
  if (prevKey === key) {
    economyWinner.confirmStreak = Math.min(economyWinner.confirmStreak + 1, 99);
  } else {
    economyWinner.confirmStreak = 1;
  }
  economyWinner.lastCheck = now;
  if (economyWinner.confirmStreak < cfg.confirmCount) {
    // 未到连续确认次数：保持旧候选（防抖动）
    if (economyWinner.candidate) {
      return { ok: true, candidate: economyWinner.candidate, hysteresis: true, confirmStreak: economyWinner.confirmStreak, reason: `hysteresis: ${key} needs ${cfg.confirmCount} confirms, keeping previous` };
    }
  }
  economyWinner.candidate = best;
  return { ok: true, candidate: best, hysteresis: false, confirmStreak: economyWinner.confirmStreak, cpst: best.cpst };
}

/** 促销期结束：ACTIVE/ACTIVE → DEPRIORITIZED → SUSPENDED_BY_COST（不删除模型） */
export function suspendByCost(providerId, modelId) {
  let r = transitionModel(providerId, modelId, 'DEPRIORITIZED');
  if (r.ok) r = transitionModel(providerId, modelId, 'SUSPENDED_BY_COST');
  return r;
}

/** 重新打折：SUSPENDED_BY_COST → CANARY → ACTIVE */
export function restoreFromCostSuspend(providerId, modelId) {
  let r = transitionModel(providerId, modelId, 'CANARY');
  if (r.ok) r = transitionModel(providerId, modelId, 'ACTIVE');
  return r;
}
