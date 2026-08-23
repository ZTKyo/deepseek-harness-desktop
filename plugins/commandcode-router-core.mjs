// commandcode-router-core.mjs —— Command Code 双模型回落 决策核心（单一真源 / 纯函数）
//
// 设计目标（全部来自任务要求，2026-08-21 主力反转）：
//   1. AUTO 默认 preferredModel = DeepSeek V4 Flash（普通任务默认主力）
//   2. DeepSeek ⇄ Muse Spark 1.2 双向单跳回落（谁是主力，另一个就是它的 fallback）
//   3. 自动回落【绝不】永久改变会话默认模型 —— 状态拆成 preferredModel / requestModel
//   4. 每个 turn 最多一次跨模型回落（防乒乓）；回落后再失败就报错，不再来回切
//   5. 优先级：手动覆盖 > preferredModel > 自动回落
//   6. 新 turn 结构性复位 → 下一个新任务重新优先 DeepSeek（不可能被锁死）
//
// 本模块【无 I/O、无随机、无副作用】：只做决策，便于确定性单测。
// 实际 hook / fetch / 日志在 commandcode-router.mjs。

export const PROVIDER = 'commandcode';
export const AUTO = 'auto';
// 模型 ID 经 GET https://api.commandcode.ai/provider/v1/models 实时验证（大小写敏感、点号版本号）
export const MUSE = 'meta/muse-spark-1.2-contributor';
export const DEEPSEEK = 'deepseek/deepseek-v4-flash';

/** 本 provider 参与自动回落的模型集合（刻意只有两个：MiMo/Qwen/其他第三模型不在默认链里） */
export const CHAIN_MODELS = Object.freeze([MUSE, DEEPSEEK]);

/** 双向单跳伙伴表：谁失败就换成对方 */
export const PARTNER = Object.freeze({
  [MUSE]: DEEPSEEK,
  [DEEPSEEK]: MUSE,
});

// ─────────────────────────────────────────────
// 失败分类
// ─────────────────────────────────────────────
// 传输/提供方类瞬时失败 → 允许跨模型回落（先由 dsh-llm-retry 做过同模型重试）
const PROVIDER_FAILURE_RE =
  /(429|5\d{2}|timeout|timed\s*out|etimedout|econnreset|econnrefused|econnaborted|enotfound|eai_again|socket\s*hang\s*up|network|fetch\s*failed|rate\s*limit|overloaded|server_error|api_error|stream|premature|aborted)/i;
// 「模型真不可用」→ 回落并设置临时主力（区域限制/权限/下线/配额窗口/强制 ZDR 无上游）
const UNAVAILABLE_RE =
  /(403|404|upgrade_required|model[_ -]?not[_ -]?found|no\s*such\s*model|not\s*available|unavailable|retired|deprecated|decommissioned|insufficient[_ ]quota|quota|region|unsupported_country|cmd_zdr_no_providers|422)/i;
// 质量类失败（可靠自动信号）→ 先 1 次自我纠正，再跨模型
const QUALITY_FAILURE_RE =
  /(tool[_ ]error|tool[_ ]failed|invalid[_ ]response|malformed|json[_ ]parse|structured[_ ]output|empty[_ ]response|empty response|no[_ ]content|zero[_ ]tokens|no[_ ]output|returned an empty|capability|not[_ ]supported|function[_ ]call)/i;
// 明确「不该换模型」的失败：用户/请求本身的问题，换模型也一样错
const NON_ROUTING_RE =
  /(401|authentication|invalid[_ ]api[_ ]key|context[_-]window|too[_ ]many[_ ]tokens|max_tokens|invalid_request_error|400)/i;

function failureText(failure) {
  if (!failure) return '';
  const parts = [failure.message, failure.code, failure.type, failure.status, failure.statusCode];
  return parts.filter((x) => x !== undefined && x !== null).map(String).join(' ');
}

/**
 * 失败分类 → 'non-routing' | 'unavailable' | 'provider' | 'quality' | 'other'
 * 顺序有意义：non-routing 最先（换模型无意义），unavailable 先于 provider（403/422 也含数字码）。
 */
export function classifyFailure(failure) {
  const t = failureText(failure);
  if (!t) return 'other';
  // 401/400/上下文超限等：换模型解决不了，交给既有错误链
  if (NON_ROUTING_RE.test(t) && !/(429|5\d{2})/.test(t)) return 'non-routing';
  if (UNAVAILABLE_RE.test(t)) return 'unavailable';
  if (PROVIDER_FAILURE_RE.test(t)) return 'provider';
  if (QUALITY_FAILURE_RE.test(t)) return 'quality';
  return 'other';
}

// ─────────────────────────────────────────────
// 模型规范化
// ─────────────────────────────────────────────
/** 把任意输入收敛成本 provider 的合法模型；auto/未知 → null（由调用方决定默认） */
export function normalizeModel(m) {
  const s = m === null || m === undefined ? '' : String(m).trim();
  if (!s) return null;
  if (s === AUTO) return null;                  // 占位符不是真模型
  if (s === MUSE || s === DEEPSEEK) return s;   // 精确匹配（大小写敏感，勿转小写）
  return null;                                  // 未登记 → 交给调用方兜底
}

/**
 * preferredModel = 用户意图。
 * intent 来自会话级选择（agent.options.model）；baseline 是本 turn 起始时的解析模型。
 * 两者都拿不到合法模型时 → DeepSeek（AUTO 默认主力）。
 */
export function resolvePreferred(intent, baseline) {
  return normalizeModel(intent) ?? normalizeModel(baseline) ?? DEEPSEEK;
}

/** 伙伴模型（双向） */
export function partnerOf(model) {
  return PARTNER[model] ?? (model === MUSE ? DEEPSEEK : MUSE);
}

// ─────────────────────────────────────────────
// 会话状态
// ─────────────────────────────────────────────
/**
 * 状态刻意把「意图」与「本次请求」分开：
 *   preferredModel  —— 用户意图，只有手动切换 / 会话默认能改它；自动回落【绝不】写它
 *   requestModel    —— 本次实际发出的模型，可被回落临时改写
 *   armedFallback   —— 一次性：下一次请求用它（消费即清空）
 *   temporaryPrimary—— 仅「模型真不可用」时设置，新 turn 即清空（不可能锁死会话）
 */
export function newState() {
  return {
    turnKey: null,
    baselineModel: null,
    lastIntent: null,
    preferredModel: DEEPSEEK,
    requestModel: DEEPSEEK,
    armedFallback: null,
    temporaryPrimary: null,
    fallbackUsedThisTurn: false,
    selfCorrectedThisTurn: false,
    fallbackCount: 0,
    lastFallbackReason: null,
    lastClassification: null,
  };
}

/**
 * turn 边界复位 —— 防粘滞的结构性保证。
 * 每个新 turn：清掉一次性回落、防乒乓计数、自我纠正标记、临时主力，
 * 并把该 turn 起始的解析模型记为 baseline（此刻还没发生任何回落，故它是真实默认/选择）。
 * 返回是否发生了复位。
 */
export function applyTurnBoundary(state, turnKey, resolvedModel) {
  const key = turnKey === null || turnKey === undefined ? '-' : String(turnKey);
  if (state.turnKey === key) return false;
  state.turnKey = key;
  state.baselineModel = normalizeModel(resolvedModel);
  state.armedFallback = null;
  state.temporaryPrimary = null;      // 新任务重新优先 preferred（DeepSeek 恢复即可用）
  state.fallbackUsedThisTurn = false;
  state.selfCorrectedThisTurn = false;
  return true;
}

/**
 * 手动切换检测 —— 手动覆盖优先级最高。
 * 会话级选择变化时，清空全部自动回落状态（陈旧的 fallback 不得影响手动选择）。
 * 返回是否识别为手动切换。
 */
export function applyManualSwitch(state, intent) {
  const s = intent === null || intent === undefined ? null : String(intent);
  if (s === null || s === state.lastIntent) return false;
  const first = state.lastIntent === null;
  state.lastIntent = s;
  state.armedFallback = null;
  state.temporaryPrimary = null;
  state.fallbackUsedThisTurn = false;
  state.selfCorrectedThisTurn = false;
  return !first;   // 首次记录不算「切换」
}

/**
 * 决定本次请求实际使用的模型。
 * 优先级：armedFallback（一次性回落）> temporaryPrimary > preferredModel
 * 注意：这里会【消费】armedFallback，保证回落只生效一次。
 */
export function decideRequestModel(state) {
  let model = state.preferredModel;
  let source = 'preferred';
  if (state.temporaryPrimary) {
    model = state.temporaryPrimary;
    source = 'temporary-primary';
  }
  if (state.armedFallback) {
    model = state.armedFallback;
    source = 'fallback';
    state.armedFallback = null;   // 一次性消费
  }
  state.requestModel = model;
  return { model, source };
}

/**
 * 失败后决策：是否跨模型回落。
 * 【绝不】修改 preferredModel —— 这是「自动回落不得永久改变会话默认」的核心保证。
 *
 * 返回 { retry, armed, reason, classification, stop }
 *   retry=true  → 调用方应返回 { kind:'retry' }，下一次请求会用 armed 模型
 *   stop=true   → 已经回落过一次仍失败：停止切换，如实报错（防乒乓）
 */
export function decideFallback({ state, failedModel, failure }) {
  const classification = classifyFailure(failure);
  state.lastClassification = classification;

  // 换模型解决不了的失败：不介入
  if (classification === 'non-routing' || classification === 'other') {
    return { retry: false, armed: null, reason: `no-fallback:${classification}`, classification, stop: false };
  }

  const current = normalizeModel(failedModel) ?? state.requestModel ?? state.preferredModel;
  const partner = partnerOf(current);

  // 防乒乓：每个 turn 最多一次跨模型回落
  if (state.fallbackUsedThisTurn) {
    return {
      retry: false,
      armed: null,
      reason: 'fallback-exhausted: already switched once this turn — reporting error instead of ping-ponging',
      classification,
      stop: true,
    };
  }

  // 质量失败：先允许 1 次同模型自我纠正，之后才跨模型
  if (classification === 'quality' && !state.selfCorrectedThisTurn) {
    state.selfCorrectedThisTurn = true;
    return {
      retry: true,
      armed: null,                 // 不换模型，同模型再来一次
      reason: 'quality: one self-correction on the same model before switching',
      classification,
      stop: false,
    };
  }

  // 跨模型单跳回落（双向）
  state.armedFallback = partner;
  state.fallbackUsedThisTurn = true;
  state.fallbackCount += 1;
  state.lastFallbackReason = classification;
  // 「模型真不可用」→ 额外设临时主力，但 preferredModel 保持不变；新 turn 会清空
  if (classification === 'unavailable') state.temporaryPrimary = partner;

  return {
    retry: true,
    armed: partner,
    reason: `${classification}: single-hop fallback ${current} → ${partner}`,
    classification,
    stop: false,
    temporaryPrimary: state.temporaryPrimary ?? null,
  };
}

/** 供 UI / 诊断展示的简要快照（不含任何密钥） */
export function snapshot(state) {
  return {
    preferredModel: state.preferredModel,
    requestModel: state.requestModel,
    temporaryPrimary: state.temporaryPrimary,
    armedFallback: state.armedFallback,
    fallbackUsedThisTurn: state.fallbackUsedThisTurn,
    fallbackCount: state.fallbackCount,
    lastFallbackReason: state.lastFallbackReason,
    turnKey: state.turnKey,
  };
}

/** 展示名（UI 用） */
export const DISPLAY = Object.freeze({
  [MUSE]: 'Muse Spark 1.2 Contributor',
  [DEEPSEEK]: 'DeepSeek V4 Flash',
  [AUTO]: 'AUTO: DeepSeek → Muse',
});
