// openrouter-router-core.mjs —— 三模型『model=auto』确定性路由核心（单一真源）
//
// 纯模块：不做网络、不读配置以外的 I/O、不调用 LLM、无随机性。
// 同一输入永远产生同一 RoutingDecision（确定性，可重复测试）。
// 被三处复用：1) openrouter-router.mjs（服务内插件，agent/request 钩子）
//            2) openrouter-router-doctor.mjs（诊断/自测脚本，Layer A/B/C）
//            3) 单元测试（Node 直接 import）。
//
// 路由优先级（与需求一致，Rule 0 最先）：
//   Rule 0 explicit override  显式指定 model=qwen/deepseek/mimo（仍做 capability 检查）
//   Rule 1 strict JSON schema 严格 JSON → DeepSeek（qwen 不支持 structured outputs）
//   Rule 2 multimodal         含 image/audio/video → MiMo（audio 必须 MiMo）
//   Rule 3 long context       estimated_context_tokens >= 阈值 → MiMo
//   Rule 4 complex            复杂/agentic/tool/调试/多文件/高失败成本 → DeepSeek
//   Rule 5 simple             简单/低风险/高吞吐 → Qwen
//   Rule 6 default            无法确定 → DeepSeek

// 昂贵模型保护：automatic_first_choice = false
// 被选中时会在 RoutingDecision 中标记 expensive=true，由调用方决定是否拦截
const EXPENSIVE_IDS = Object.freeze([
  "deepseek/deepseek-v4-pro",
]);

export const ALIASES = Object.freeze({ qwen: "qwen", deepseek: "deepseek", mimo: "mimo" });

// 路由模式 allowlist：auto + 三个 routing alias。
// 任何不在其中的非空 requestedMode 视为「显式 concrete model id」→ exact passthrough。
// 这是修复 explicit model identity 丢失的最小泛化（不硬编码任何具体模型）。
export const KNOWN_ROUTING_MODES = Object.freeze(new Set(["auto", "qwen", "deepseek", "mimo"]));

// 默认三模型 ID（可用环境变量覆盖，见 resolveConfig）
export const DEFAULT_MODEL_IDS = Object.freeze({
  qwen: "qwen/qwen3.7-flash",
  deepseek: "deepseek/deepseek-v4-flash-0731",
  mimo: "xiaomi/mimo-v2.5",
});

// capability 表（2026-08-19 经 OpenRouter /models 实测核对）
// input_modalities / structured(OpenAI 兼容 response_format json_schema)
export const CAPABILITY = Object.freeze({
  qwen: { input: ["text", "image", "video"], structured: false, audio: false },
  deepseek: { input: ["text"], structured: true, audio: false },
  mimo: { input: ["text", "audio", "image", "video"], structured: true, audio: true },
});

// 跨模型 fallback 链（capability-aware）
const CHAINS = Object.freeze({
  qwen: ["qwen", "deepseek", "mimo"], // 简单任务主链；深链兜底
  deepseek: ["deepseek", "mimo", "qwen"], // 主力主链
  mimo: ["mimo", "qwen"], // 多模态/长上下文：mimo → qwen（同能力族）
});

// 简单任务关键词（Rule 5）——中英文，覆盖需求列出的任务型
const SIMPLE_WORDS = [
  "summary", "summarize", "summarise", "摘要", "总结", "概括",
  "translate", "translation", "翻译",
  "classify", "classification", "分类",
  "extract", "抽取", "提取",
  "rewrite", "改写", "重写",
  "format", "格式化", "排版",
  "concatenate", "join the", "连接", "拼接",
  "simple qa", "simple", "简单", "简单问答", "归纳", "简述", "tell me the key points",
  "batch", "批处理", "批量",
  "由逗号连接", "用逗号连接",
];
// 复杂/agentic 任务关键词（Rule 4）——优先级高于 simple。
// 注意：普通“函数/工具”作名词不强制 complex；只有明确的操作形式才算。
const COMPLEX_WORDS = [
  "debug", "bug", "调试", "修复", "排查", "报错", "出错", "crash", "异常",
  "refactor", "重构",
  "repo", "repository", "多文件", "跨文件", "项目级", "repo 级",
  "tool_call", "tool calling", "调用工具", "调用函数", "工具调用", "使用工具",
  "shell", "terminal", "终端", "powershell", "cmd", "执行命令", "跑命令",
  "agent", "multi-step", "多步", "规划", "planning", "分解为步骤",
  "test", "测试用例", "验证", "verification", "unit test", "回归测试",
  "架构", "architecture", "设计", "迁移", "migration",
  "数据库", "database", "sql", "deploy", "部署", "上线",
  "get_router_test_value", "安全测试工具",
];

// 多模态 content block 类型（探测用）
export const MODALITY_TYPES = Object.freeze(["image", "audio", "video", "image_url", "input_audio"]);

function numEnv(env, key, dflt) {
  const v = (env && env[key]) ?? "";
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
function strEnv(env, key, dflt) {
  const v = (env && env[key] && String(env[key]).trim()) || "";
  return v.length > 0 ? v : dflt;
}

export function resolveConfig(env = {}) {
  return Object.freeze({
    longContextThreshold: numEnv(env, "ROUTER_LONG_CONTEXT_THRESHOLD", 120000),
    maxRetries: numEnv(env, "ROUTER_MAX_RETRIES", 1),
    maxEscalations: numEnv(env, "ROUTER_MAX_ESCALATIONS", 1),
    diagnostics: strEnv(env, "ROUTER_DIAGNOSTICS", "false") === "true",
    modelIds: Object.freeze({
      qwen: strEnv(env, "OPENROUTER_QWEN_MODEL", DEFAULT_MODEL_IDS.qwen),
      deepseek: strEnv(env, "OPENROUTER_DEEPSEEK_MODEL", DEFAULT_MODEL_IDS.deepseek),
      mimo: strEnv(env, "OPENROUTER_MIMO_MODEL", DEFAULT_MODEL_IDS.mimo),
    }),
  });
}

/** 修正 env 字符串型数值类型，返回可用 config（懒加载缓存由调用方决定）。 */
export function normalizeConfig(raw) {
  return raw;
}

/**
 * 确定性文本任务分类。
 * @param {string} text 最近用户消息/任务说明（可为空）
 * @returns {'simple'|'complex'|'unknown'}
 */
export function classifyTask(text = "") {
  const t = String(text ?? "").toLowerCase();
  if (t.length === 0) return "unknown";
  const has = (words) => words.some((w) => t.includes(w.toLowerCase()));
  if (has(COMPLEX_WORDS)) return "complex";
  if (has(SIMPLE_WORDS)) return "simple";
  return "unknown";
}

/** 从消息 content 块/列表探测多模态类型（image/audio/video）。 */
export function detectModalities(messages = []) {
  const found = new Set();
  const scanContent = (c) => {
    if (!c || typeof c !== "object") return;
    if (Array.isArray(c)) {
      for (const item of c) scanContent(item);
      return;
    }
    if (typeof c.type === "string") {
      const t = c.type.toLowerCase();
      if (t === "image" || t === "audio" || t === "video" || t === "image_url" || t === "input_audio") found.add(t === "input_audio" ? "audio" : t === "image_url" ? "image" : t);
      if (c.type === "text" && typeof c.text === "string") return;
    }
    for (const k of Object.keys(c)) {
      const v = c[k];
      if (v && typeof v === "object") scanContent(v);
      else if (typeof v === "string" && v.length > 0 && (k === "url" || k === "data" || k === "source")) {
        if (/^data:image\//i.test(v) || /^https?:\/\//i.test(v) && /\.(png|jpe?g|gif|webp)$/i.test(v)) found.add("image");
      }
    }
  };
  const arr = Array.isArray(messages) ? messages : [];
  for (const m of arr) {
    if (!m) continue;
    scanContent(m.content);
    if (m.content && typeof m.content === "object" && !Array.isArray(m.content)) scanContent(m.content);
  }
  return [...found];
}

export function detectStrictJson(text = "") {
  const t = String(text ?? "").toLowerCase();
  return /strict\s*json|严格\s*json|json\s*schema|response_format|"type"\s*:\s*"json_schema"|json_schema/.test(t);
}

/**
 * 构建 capability-aware fallback 链（主链样式按模型族固定，且过滤掉不支持当前模态的模型）。
 * @param {string} model alias
 * @param {string[]} modalities
 * @returns {string[]} alias chain
 */
export function fallbackChainFor(model, modalities = []) {
  const base = CHAINS[model] || CHAINS.deepseek;
  const mods = modalities || [];
  if (mods.length === 0) return [...base];
  return base.filter((m) => {
    const cap = CAPABILITY[m];
    return mods.every((mo) => cap.input.includes(mo));
  });
}

/**
 * 生成 RoutingDecision —— 唯一路由入口。
 * @param {object} request
 * @param {string} [request.requestedMode='auto'] 显式请求模型 'auto'|'qwen'|'deepseek'|'mimo'
 * @param {string[]} [request.modalities=[]] 已探测的多模态
 * @param {boolean} [request.strictJson=false]
 * @param {number} [request.estimatedContextTokens=0]
 * @param {string} [request.taskType='unknown'] 已分类任务型（缺省则按 text 关键字分类）
 * @param {string} [request.text=''] 最近用户消息文本
 * @param {boolean} [request.toolsActive=false]
 * @param {object} [env=process.env]
 * @param {object} [state={}] 可选：fallbackIndex/escalation 等（测试注入用）
 * @returns {object} RoutingDecision
 */
export function route(request = {}, env = {}) {
  const cfg = normalizeConfig(resolveConfig(env));
  const r = request || {};
  const modalities = Array.isArray(r.modalities) ? r.modalities.filter(Boolean) : [];
  const modSet = new Set(modalities.map((x) => String(x).toLowerCase()));
  const hasAudio = modSet.has("audio");
  const hasImageVideo = modSet.has("image") || modSet.has("video") || modSet.has("image_url");
  const multimodal = hasAudio || hasImageVideo;
  const strictJson = !!r.strictJson || detectStrictJson(r.text);
  const estimated = Number.isFinite(Number(r.estimatedContextTokens)) ? Number(r.estimatedContextTokens) : 0;
  let taskType = r.taskType || classifyTask(r.text || "");
  const toolsActive = !!r.toolsActive;

  // Rule 0：显式 override（仍在 capability 内检查）
  const explicit = r.requestedMode || "auto";
  if (explicit !== "auto") {
    // 显式 concrete model id（非 routing alias，如 stealth/ox-alpha / vendor/future-model）
    // → EXACT PASSTHROUGH：保留用户明确选择的模型，不进入 auto 路由，不静默替换。
    //   Provider / model resolution 自行验证该 id 是否有效；失败则如实失败。
    if (!KNOWN_ROUTING_MODES.has(explicit)) {
      return decision(explicit, explicit, "explicit_model_passthrough", "user explicit model id preserved (not auto-routed)", cfg, modalities, [explicit], explicit);
    }
    if (!CAPABILITY[explicit]) return decision("auto", "deepseek", "explicit_override_invalid", "unknown explicit alias -> deepseek", cfg, modalities, "deepseek");
    // audio 必须 MiMo；显式选 qwen/deepseek 而带 audio -> capability 强制 MiMo
    if (hasAudio && explicit !== "mimo") {
      return decision(explicit, "mimo", "capability_override", "audio requires mimo", cfg, modalities, fallbackChainFor("mimo", modalities));
    }
    // image/video + strict json：qwen 无 structured -> 若又要求严格 json 则 mimo
    if (multimodal && strictJson && explicit === "qwen") {
      return decision(explicit, "mimo", "capability_override", "multimodal+strict json needs mimo", cfg, modalities, fallbackChainFor("mimo", modalities));
    }
    return decision(explicit, explicit, "explicit_override", "user explicit " + explicit, cfg, modalities, fallbackChainFor(explicit, modalities));
  }

  // Rule 1：严格 JSON Schema → DeepSeek
  if (strictJson && !multimodal) {
    return decision("auto", "deepseek", "strict_json", "strict JSON schema needs deepseek", cfg, modalities, fallbackChainFor("deepseek", modalities));
  }
  // Rule 1 + 多模态并存：需要既支持模态又支持 structured 的模型 → MiMo
  if (strictJson && multimodal) {
    return decision("auto", "mimo", "strict_json_multimodal", "multimodal+strict json -> mimo", cfg, modalities, fallbackChainFor("mimo", modalities));
  }

  // Rule 2：多模态（audio 必须 MiMo）
  if (multimodal) {
    const target = hasAudio || hasImageVideo ? "mimo" : "mimo";
    return decision("auto", target, "multimodal", hasAudio ? "audio requires mimo" : "multimodal -> mimo", cfg, modalities, fallbackChainFor(target, modalities));
  }

  // Rule 3：长上下文
  if (estimated >= cfg.longContextThreshold) {
    return decision("auto", "mimo", "long_context", `estimated_context=${estimated}>=${cfg.longContextThreshold}`, cfg, modalities, fallbackChainFor("mimo", modalities));
  }

  // Rule 4：复杂 / agentic / tool
  if (toolsActive || taskType === "complex") {
    return decision("auto", "deepseek", "complex", taskType === "complex" ? "complex task" : "tool/agentic task", cfg, modalities, fallbackChainFor("deepseek", modalities));
  }

  // Rule 5：简单任务
  if (taskType === "simple") {
    return decision("auto", "qwen", "simple", "simple task", cfg, modalities, fallbackChainFor("qwen", modalities));
  }

  // Rule 6：无法确定 → DeepSeek
  return decision("auto", "deepseek", "default", "cannot classify", cfg, modalities, fallbackChainFor("deepseek", modalities));
}

function decision(requestedMode, selectedModel, ruleId, reason, cfg, modalities, chain, explicitId) {
  const selectedId = explicitId || cfg.modelIds[selectedModel];
  const chainArr = Array.isArray(chain) ? chain : [chain];
  return Object.freeze({
    requested_mode: requestedMode,
    selected_model: selectedModel,
    selected_model_id: selectedId,
    expensive: EXPENSIVE_IDS.includes(selectedId),
    reason,
    rule_id: ruleId,
    // 完整 fallback 链（alias 序列 + model id 序列）
    fallback_chain: [...chainArr],
    fallback_chain_ids: chainArr.map((a) => cfg.modelIds[a]).filter(Boolean),
    fallback_modalities: [...modalities],
  });
}

/** 质量升级：Qwen → DeepSeek（一次）；返回下一个 alias 或 null。 */
export function escalateOnce(current) {
  if (current === "qwen") return "deepseek";
  return null;
}

/**
 * 跨模型 fallback 决策：给定当前链位置，返回下一个 fallback alias；链末返回 null（停止，绝不无限循环）。
 * @param {string[]} chain alias 链
 * @param {number} currentIdx 当前已用的位置（=上一次 selected 在链中的下标）
 * @returns {string|null} 下一候选 alias 或 null
 */
export function nextFallback(chain, currentIdx) {
  if (!Array.isArray(chain) || chain.length === 0) return null;
  if (!Number.isInteger(currentIdx) || currentIdx < 0) return chain[0] ?? null;
  const n = currentIdx + 1;
  return n < chain.length ? chain[n] : null;
}

// ─────────────────────────────────────────────
// Expected vs Actual Model 验证
// ─────────────────────────────────────────────

/**
 * 验证 API 返回的实际模型是否与路由决策的预期模型匹配。
 * @param {string} expectedModelId 路由决策的 selected_model_id
 * @param {string|null} actualModelId API 响应中的 model 字段
 * @returns {{ match: boolean, expected: string, actual: string|null, detail: string }}
 */
export function verifyActualModel(expectedModelId, actualModelId) {
  if (!actualModelId) {
    return { match: false, expected: expectedModelId, actual: null, detail: 'response model field missing' };
  }
  // OpenRouter 有时在 model 字段返回请求的 model id，有时返回实际模型
  // 匹配策略：精确比较 / 一方包含另一方 / 提取模型名核心部分比较
  const normalize = (id) => {
    // 去掉 provider 前缀（如 "openai/" "openrouter/" "anthropic/"）取模型名
    const parts = id.split('/');
    return parts.length > 1 ? parts[parts.length - 1] : id;
  };
  const coreExpected = normalize(expectedModelId);
  const coreActual = normalize(actualModelId);
  const match = expectedModelId === actualModelId ||
    actualModelId.includes(expectedModelId) ||
    expectedModelId.includes(actualModelId) ||
    coreExpected === coreActual;
  return {
    match,
    expected: expectedModelId,
    actual: actualModelId,
    detail: match ? 'expected == actual' : `ROUTING MISMATCH: expected "${expectedModelId}" but got "${actualModelId}"`,
  };
}

// ─────────────────────────────────────────────
// 昂贵模型保护
// ─────────────────────────────────────────────

/**
 * 检查选定模型是否需要昂贵模型保护。
 * 返回 { allowed, expensive, reason, requiresEscalation }
 * expensive 模型只有在 explicit override 或 escalation 时才允许。
 */
export function expensiveGuard(selectedModelId, ruleId, explicitOverride = false) {
  const isExpensive = EXPENSIVE_IDS.includes(selectedModelId);
  if (!isExpensive) {
    return { allowed: true, expensive: false, reason: null, requiresEscalation: false };
  }
  // 显式指定（Rule 0 用户手动选）→ 允许但记录
  if (explicitOverride) {
    return { allowed: true, expensive: true, reason: 'user explicit override to expensive model', requiresEscalation: false };
  }
  // 自动路由选中昂贵模型 → 拦截（降级到 PRIMARY）
  return { allowed: false, expensive: true, reason: 'auto-router selected expensive model without explicit override — blocked', requiresEscalation: true };
}

