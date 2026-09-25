// learn-gap-veto.mjs —— P4 R2 AC5：Fake Gap Guard（伪能力缺口守卫）
//
// ─────────────────────────────────────────────────────────────────────────────
// Authority 边界（合同 AC5 + 实现原则 4 + 任务书 §20）：
//
//   **本模块不包含任何失败分类逻辑。** 失败分类的唯一 Authority 是 P2.6 的
//   failure-classifier-core.mjs（Failure Taxonomy V1）。本模块只做一件事：
//   拿 P2.6 的分类结果，判定「这次失败是否**允许**成为一个能力缺口（capability gap）」。
//
//   即：分类器是**否决器（VETO）**，不是提名器（NOMINATE）。
//   合同 AC5 原文是「Failure Classification 能**阻止**错误学习」——否决语义。
//
//   为什么必须这样：P2.6 的 9 个类**全部**是 provider / 传输 / 环境 / 凭据 /
//   计费 / 路由故障分类，**没有一类是「能力缺口」**。生产实测 1,257 条真实记录
//   （~/.dsh/p26-failure-classifier.log）中**零条**是真实能力缺口。
//   把分类器当提名器用 = 把环境抖动学成 Skill 缺陷 = R1 的方向性错误。
//
//   fail-closed：分类缺失 / 未知 / 证据不足 → **一律否决**。宁可漏学，不可误学。
// ─────────────────────────────────────────────────────────────────────────────

import {
  classifyFailureV1,
  normalizedSignatureOf,
  FAILURE_CLASS,
  TAXONOMY_VERSION,
} from './failure-classifier-core.mjs';

/** 守卫版本（与 P2.6 TAXONOMY_VERSION 独立演进；签名里两者都带）。 */
export const GAP_VETO_VERSION = 1;

/** 重复阈值：同一 (taskType, normalizedSignature) 至少独立出现 N 次才可能建 gap。 */
export const REPEAT_THRESHOLD = 2;

/**
 * 硬否决集：**任何情况下**都不得成为能力缺口。
 *
 * 判据说明（每条都可回溯到任务书 §21 Fake Gap Guard 列表）：
 *   - provider outage      → PROVIDER_OVERLOADED / NETWORK_TIMEOUT_5XX(PROVIDER_OUTAGE)
 *   - quota                → QUOTA_EXHAUSTED
 *   - 502 / timeout / DNS  → NETWORK_TIMEOUT_5XX
 *   - network disconnect   → NETWORK_TIMEOUT_5XX
 *   - local env missing    → MODEL_ROUTE_UNAVAILABLE
 *   - credential issue     → AUTH_PERMISSION_FAILURE
 *   外加：瞬时限流（SHORT_WINDOW_RATE_LIMIT）与上下文溢出（CONTEXT_LIMIT）——
 *   前者重试即可，后者属 compaction 范畴，都不是「缺能力」。
 */
export const HARD_VETO_CLASSES = Object.freeze([
  FAILURE_CLASS.SHORT_WINDOW_RATE_LIMIT,     // retryableSameRoute=true，重试即可
  FAILURE_CLASS.NETWORK_TIMEOUT_5XX,         // 网络 / 5xx / 传输
  FAILURE_CLASS.PROVIDER_OVERLOADED,         // 服务繁忙，有界退避
  FAILURE_CLASS.QUOTA_EXHAUSTED,             // 计费 / 额度
  FAILURE_CLASS.AUTH_PERMISSION_FAILURE,     // 凭据 / 权限（属配置，非能力）
  FAILURE_CLASS.MODEL_ROUTE_UNAVAILABLE,     // 路由 / 模型名（属配置，非能力）
  FAILURE_CLASS.CONTEXT_LIMIT,               // 上下文溢出（属 compaction 范畴）
]);

/**
 * 条件否决集：默认**也**否决，只有在调用方提供**显式能力缺口证据**时才放行。
 *
 *   - PROTOCOL_MISMATCH：deterministic=true。可能是真缺口，也可能是**自身实现缺陷**
 *     （R1 正是这类）。故必须由调用方举证"已排除自身代码缺陷"。
 *   - UNKNOWN_PROVIDER_FAILURE：证据不足（生产仅 1 条）⇒ 默认否决。
 */
export const CONDITIONAL_VETO_CLASSES = Object.freeze([
  FAILURE_CLASS.PROTOCOL_MISMATCH,
  FAILURE_CLASS.UNKNOWN_PROVIDER_FAILURE,
]);

/** 全部已知分类（用于校验外部传入的分类值是否属于本 taxonomy）。 */
export const KNOWN_CLASSES = Object.freeze(Object.values(FAILURE_CLASS));

/** 否决原因码（可审计、可断言、不随文案抖动）。 */
export const VETO_REASON = Object.freeze({
  HARD_VETO: 'HARD_VETO_CLASS',                       // 硬否决集命中
  CONDITIONAL_NO_EVIDENCE: 'CONDITIONAL_VETO_NO_EVIDENCE', // 条件否决集 + 未举证
  UNKNOWN_CLASS: 'UNKNOWN_CLASSIFICATION',            // 分类值不属于本 taxonomy
  MISSING_CLASSIFICATION: 'MISSING_CLASSIFICATION',   // 无分类证据（fail-closed）
  TAXONOMY_VERSION_MISMATCH: 'TAXONOMY_VERSION_MISMATCH', // 证据来自不兼容的 taxonomy
  NOT_VETOED: null,                                    // 未被否决（可进入资格判定）
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 判定一条**已分类**的失败是否被否决。
 *
 * @param {object} record - 来自 P2.6 证据流的记录，或等价的 {classification, normalizedSignature, ...}
 * @param {object} [opts]
 * @param {string} [opts.capabilityEvidence] - 显式能力缺口证据（仅对条件否决集有意义）
 * @returns {{vetoed:boolean, reason:string|null, classification:string,
 *            normalizedSignature:string, taxonomyVersion:number, vetoVersion:number}}
 */
export function evaluateClassifiedRecord(record, opts = {}) {
  const vetoVersion = GAP_VETO_VERSION;
  const base = (vetoed, reason, classification, signature, taxonomyVersion) => ({
    vetoed, reason, classification, normalizedSignature: signature,
    taxonomyVersion, vetoVersion,
  });

  // fail-closed：无记录 / 非对象 → 否决
  if (!isPlainObject(record)) {
    return base(true, VETO_REASON.MISSING_CLASSIFICATION, '', '', TAXONOMY_VERSION);
  }

  const classification = typeof record.classification === 'string' ? record.classification : '';
  const signature = typeof record.normalizedSignature === 'string' ? record.normalizedSignature : '';
  const tv = Number.isFinite(record.taxonomyVersion) ? record.taxonomyVersion : TAXONOMY_VERSION;

  // fail-closed：无分类 → 否决
  if (!classification) {
    return base(true, VETO_REASON.MISSING_CLASSIFICATION, '', signature, tv);
  }
  // 证据来自不兼容的 taxonomy → 否决（不能拿旧版分类做新决策）
  if (tv !== TAXONOMY_VERSION) {
    return base(true, VETO_REASON.TAXONOMY_VERSION_MISMATCH, classification, signature, tv);
  }
  // 分类值不属于本 taxonomy → 否决（防伪造/防拼写漂移）
  if (!KNOWN_CLASSES.includes(classification)) {
    return base(true, VETO_REASON.UNKNOWN_CLASS, classification, signature, tv);
  }

  if (HARD_VETO_CLASSES.includes(classification)) {
    return base(true, VETO_REASON.HARD_VETO, classification, signature, tv);
  }
  if (CONDITIONAL_VETO_CLASSES.includes(classification)) {
    const ev = typeof opts.capabilityEvidence === 'string' ? opts.capabilityEvidence.trim() : '';
    if (!ev) {
      return base(true, VETO_REASON.CONDITIONAL_NO_EVIDENCE, classification, signature, tv);
    }
    return base(false, VETO_REASON.NOT_VETOED, classification, signature, tv);
  }
  // 理论上不可达（KNOWN_CLASSES 已穷尽）；保守起见仍否决
  return base(true, VETO_REASON.UNKNOWN_CLASS, classification, signature, tv);
}

/**
 * 从**原始 failure 对象**判定是否被否决。内部直接调用 P2.6 权威分类器
 * —— 这是"复用同一 Authority"，不是第二套分类器（本模块零分类逻辑）。
 *
 * @param {object} failure - agent/request-error payload.failure ({message, code, status?, providerRetryAfterMs?})
 * @param {object} [context] - {provider, model, nowMs, tzOffsetMinutes, capabilityEvidence}
 */
export function evaluateGapVeto(failure, context = {}) {
  const cls = classifyFailureV1(failure, context);
  return evaluateClassifiedRecord(cls, { capabilityEvidence: context.capabilityEvidence });
}

/**
 * 计算一条失败观测的**去重键**。签名一律取自 P2.6 的 normalizedSignatureOf()
 * —— 该函数**故意不含 message**（variant-proof），因此同一故障在不同文案下签名稳定。
 *
 * ⚠ 禁止自行拼接签名：那会引入与 P2.6 不一致的第二套口径。
 *
 * @param {string} taskType - 任务类型（由调用方给出，如 'plugin-install'）
 * @param {object} record   - 已分类记录
 * @returns {string} `${taskType}::${normalizedSignature}`
 */
export function gapDedupKey(taskType, record) {
  const tt = typeof taskType === 'string' && taskType ? taskType : '?';
  let sig = isPlainObject(record) && typeof record.normalizedSignature === 'string'
    ? record.normalizedSignature
    : '';
  if (!sig && isPlainObject(record)) {
    // 记录里没有签名时，用权威函数补算（仍不自己拼串）
    sig = normalizedSignatureOf(
      record.provider, record.model, record.classification,
      record.providerCode ?? null, record.httpStatus,
    );
  }
  return `${tt}::${sig}`;
}

/**
 * Gap 资格判定（合同 §七 + 任务书 §22）：**4 项全部满足**才建立 GAP RECORD。
 *
 *   1. same task type
 *   2. same normalized failure signature
 *   3. same underlying capability deficiency
 *   4. repeat threshold reached (≥ REPEAT_THRESHOLD)
 *
 * 并且：**每一条**观测都必须先通过否决闸门。只要有一条被否决，整组不成立。
 *
 * 观测有两种**互斥**形态（R2 STAGE 8.5 起）：
 *   A. P2.6 域（provider/网络/环境）：
 *      `{taskType, record|failure, capabilityDeficiency?, capabilityEvidence?}`
 *   B. P2.6 域外的**能力缺口**（工具/技能/模型）：
 *      `{taskType, capability: <结构化事实>, capabilityDeficiency?}`
 *      —— capability 走 Capability-Gap Qualification Adapter（零关键词）。
 *
 * @param {Array<{taskType:string, record?:object, failure?:object, capability?:object,
 *                capabilityDeficiency?:string, capabilityEvidence?:string}>} observations
 * @param {object} [opts]
 * @param {number} [opts.repeatThreshold]
 * @returns {{qualified:boolean, reason:string, dedupKey:string|null,
 *            taskType:string|null, normalizedSignature:string|null,
 *            classification:string|null, count:number, required:number,
 *            vetoedCount:number, vetoReasons:string[],
 *            origin:string|null, adapterVersion:number|null}}
 */
export function qualifyGap(observations, opts = {}) {
  const required = Number.isFinite(opts.repeatThreshold) && opts.repeatThreshold > 0
    ? opts.repeatThreshold
    : REPEAT_THRESHOLD;
  const out = {
    qualified: false, reason: '', dedupKey: null, taskType: null,
    normalizedSignature: null, classification: null,
    count: 0, required, vetoedCount: 0, vetoReasons: [],
    // R2 STAGE 8.5：能力观测（capability 路径）专属字段；P2.6 路径下保持 null
    origin: null, adapterVersion: null,
  };

  if (!Array.isArray(observations) || observations.length === 0) {
    out.reason = 'no observations';
    return out;
  }

  // ① 否决闸门：任何一条被否决 → 整组不成立
  //
  // 两种观测形态（互斥）：
  //   - {capability: <结构化事实>}  → 走 **Capability-Gap Qualification Adapter**
  //     （P2.6 域外的工具失败；零关键词）
  //   - {record|failure: ...}      → 走 P2.6 Authority（provider/网络/环境域，语义不变）
  const vetoes = [];
  for (const o of observations) {
    if (!isPlainObject(o)) { vetoes.push(VETO_REASON.MISSING_CLASSIFICATION); continue; }
    if (isPlainObject(o.capability)) {
      const cap = evaluateCapabilityObservation(o.capability, { capabilityEvidence: o.capabilityEvidence });
      if (!cap.learnable) vetoes.push(cap.reason || CAPABILITY_REASON.UNKNOWN_ORIGIN_NO_EVIDENCE);
      continue;
    }
    const v = isPlainObject(o.record)
      ? evaluateClassifiedRecord(o.record, { capabilityEvidence: o.capabilityEvidence })
      : evaluateGapVeto(o.failure, { capabilityEvidence: o.capabilityEvidence });
    if (v.vetoed) vetoes.push(v.reason || VETO_REASON.UNKNOWN_CLASS);
  }
  out.vetoedCount = vetoes.length;
  out.vetoReasons = [...new Set(vetoes)].sort();
  if (vetoes.length > 0) {
    out.reason = `vetoed (${out.vetoedCount}/${observations.length}): ${out.vetoReasons.join(',')}`;
    return out;
  }

  // ② same task type + same normalized signature（同时必须同 classification）
  const obsKey = (o) => {
    const tt = typeof o.taskType === 'string' ? o.taskType : '';
    if (isPlainObject(o.capability)) return `${tt || '?'}::${capabilitySignature(o.capability)}`;
    return gapDedupKey(tt, o.record);
  };
  const first = observations[0];
  const taskType = typeof first.taskType === 'string' ? first.taskType : '';
  const key = obsKey(first);
  const sameGroup = observations.every((o) => obsKey(o) === key);
  if (!sameGroup) {
    out.reason = 'mixed task type or normalized signature';
    return out;
  }
  const firstIsCapability = isPlainObject(first.capability);
  out.dedupKey = key;
  out.taskType = taskType;
  out.normalizedSignature = firstIsCapability
    ? capabilitySignature(first.capability)
    : (isPlainObject(first.record) ? (first.record.normalizedSignature || '') : '');
  out.classification = firstIsCapability
    ? classifyFailureOrigin(first.capability)
    : (isPlainObject(first.record) ? (first.record.classification || '') : '');
  out.count = observations.length;
  if (firstIsCapability) {
    out.origin = classifyFailureOrigin(first.capability);
    out.adapterVersion = CAPABILITY_ADAPTER_VERSION;
  }

  // ③ same underlying capability deficiency（必须显式举证且一致）
  const deficiencies = observations
    .map((o) => (typeof o.capabilityDeficiency === 'string' ? o.capabilityDeficiency.trim() : ''))
    .filter(Boolean);
  if (deficiencies.length !== observations.length) {
    out.reason = 'missing capability deficiency evidence';
    return out;
  }
  if (new Set(deficiencies).size !== 1) {
    out.reason = 'different underlying capability deficiency';
    return out;
  }

  // ④ repeat threshold
  if (observations.length < required) {
    out.reason = `below repeat threshold (${observations.length}/${required})`;
    return out;
  }

  out.qualified = true;
  out.reason = 'qualified';
  return out;
}

/**
 * 对 P2.6 证据流做**批量回放**，统计否决率。
 * 用于 AC5 的**真实数据验证**（生产 1,257 条真实记录必须 100% 否决）。
 *
 * @param {Array<object>} records - 证据流记录数组
 * @returns {{total:number, vetoed:number, allowed:number, vetoRate:number,
 *            byClassification:Object, byVetoReason:Object, allowedSamples:Array}}
 */
export function replayEvidenceRecords(records) {
  const byClassification = {};
  const byVetoReason = {};
  const allowedSamples = [];
  let total = 0;
  let vetoed = 0;

  for (const r of Array.isArray(records) ? records : []) {
    if (!isPlainObject(r)) continue;
    total += 1;
    const cls = typeof r.classification === 'string' && r.classification ? r.classification : '(none)';
    byClassification[cls] = (byClassification[cls] || 0) + 1;

    const v = evaluateClassifiedRecord(r);
    if (v.vetoed) {
      vetoed += 1;
      const reason = v.reason || 'UNKNOWN';
      byVetoReason[reason] = (byVetoReason[reason] || 0) + 1;
    } else if (allowedSamples.length < 20) {
      allowedSamples.push({ classification: cls, signature: r.normalizedSignature || '' });
    }
  }

  return {
    total,
    vetoed,
    allowed: total - vetoed,
    vetoRate: total === 0 ? 0 : vetoed / total,
    byClassification,
    byVetoReason,
    allowedSamples,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// R2 STAGE 8.5 — Capability-Gap Qualification Adapter
//
// 任务书 §3 的边界（必须严格遵守）：
//   - P2.6 是 **provider / 网络 / 环境域**的唯一 Failure Authority；本适配器
//     **不分类该域**，绝不重新解释 502/timeout/DNS/quota/凭据。
//   - 它只处理 P2.6 **看不见**的那一部分：**工具调用失败**（结构化
//     tool/call + tool/result 事实）。
//   - 它不是第二套 Failure Authority，只是一个**资格适配器**：
//     输入 = 结构化事实，输出 = "这条失败是否可能是一个真实能力缺口"。
//
// 判据**零关键词**：全部来自结构化字段（isError / error.code / tool.name）。
// 这一点是本轮修正的核心——旧实现用关键词判失败，既漏又错；这里不重复那个错误。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 适配器版本（与 TAXONOMY_VERSION / GAP_VETO_VERSION 独立演进）。
 *
 * v2（R2 STAGE 2 修复）：资格语义收紧——能力缺口必须由**结构化错误码**举证，
 *   且错误码不得属于「非能力」类目。v1 会把全部 25 个真实错误码（含超时/取消/
 *   凭据缺失/调用方误用）一律判为 learnable，见 NON_CAPABILITY_CODES 的说明。
 *   版本必须 bump：v1 生成的候选与新语义不可混谈（签名含本版本号）。
 */
export const CAPABILITY_ADAPTER_VERSION = 2;

/**
 * 合同【Failure Class】要求的 9 类来源。
 *
 * P2.6 的 9 个 classification 全部落在 ENVIRONMENT / PROVIDER / NETWORK 三域内
 * （provider outage、quota、502/timeout/DNS、网络断开、本机环境缺件、凭据），
 * 也就是说：**P2.6 域内的失败一律不是"我们缺能力"**。Tool / Skill / Model
 * 才是我们自己拥有、可被学习改进的能力维度——这正是旧实现缺失的部分。
 */
export const FAILURE_ORIGIN = Object.freeze({
  ENVIRONMENT: 'environment',
  PROVIDER: 'provider',
  NETWORK: 'network',
  USER: 'user',
  WEBSITE: 'website',
  TOOL: 'tool',
  SKILL: 'skill',
  MODEL: 'model',
  UNKNOWN: 'unknown',
});

/** 全部已知来源（用于校验外部传入值，防拼写漂移/伪造）。 */
export const KNOWN_ORIGINS = Object.freeze(Object.values(FAILURE_ORIGIN));

/** 可学习：我们自己拥有的能力维度（真实能力缺口只能出现在这里）。 */
export const LEARNABLE_ORIGINS = Object.freeze([
  FAILURE_ORIGIN.TOOL, FAILURE_ORIGIN.SKILL, FAILURE_ORIGIN.MODEL,
]);

/** 不可学习：外部/瞬态（环境、供应商、网络、用户、第三方站点）——永远不是"我们缺能力"。 */
export const NON_LEARNABLE_ORIGINS = Object.freeze([
  FAILURE_ORIGIN.ENVIRONMENT, FAILURE_ORIGIN.PROVIDER, FAILURE_ORIGIN.NETWORK,
  FAILURE_ORIGIN.USER, FAILURE_ORIGIN.WEBSITE,
]);

/**
 * ⛔ 非能力类目错误码（R2 STAGE 2 修复，Fake Gap Guard 的**码级**否决面）。
 *
 * 存在理由（实测缺陷，2026-09-25 命中）：
 *   修复前 `classifyFailureOrigin()` 只要看到 `isError === true` 且带 toolName 就判
 *   `origin = tool`，而 `origin ∈ LEARNABLE_ORIGINS` 即 **learnable = true**。
 *   实测把**真实会话中出现过的全部 25 个 error.code** 逐个喂给适配器：
 *     learnable = 25/25 —— 包括超时（TOOL_TIMEOUT）、provider/web 中断（WEB_ABORTED）、
 *     凭据缺失（WEB_PROVIDER_CREDENTIAL_MISSING）、用户中止（ABORTED / ASK_CANCELLED）、
 *     goal 工具调用方误用（GOAL_*）、参数错误（INVALID_ARGS）与未知工具（UNKNOWN_TOOL）。
 *   这直接违反任务书 §21 Fake Gap Guard 与 STAGE 2 负例要求：
 *     「provider 中断 / 网络超时 / 凭据失败 / 无关工具失败 ⇒ 不得产出能力候选」。
 *   即：P2.6 域（provider/网络/环境/凭据）有硬否决集守卫，但**工具域内部**同样存在
 *   非能力失败，而能力路径此前只判 origin、没有码级判定 ⇒ 那一整片是守卫盲区。
 *
 * 纪律（与 HARD_VETO_CLASSES 同源，逐条可回溯真实观测计数）：
 *   - 瞬态/超时     → 重试即可，不是「缺能力」（对应 NETWORK_TIMEOUT_5XX 的硬否决理由）
 *   - 中止/取消     → 用户或系统意志，不是能力
 *   - 凭据/配置     → 配置问题（对应 AUTH_PERMISSION_FAILURE / MODEL_ROUTE_UNAVAILABLE）
 *   - 调用方误用    → 参数或工具语义用错，不是「我们做不到」
 *
 * 刻意采用**否决表（denylist）而非许可表（allowlist）**：
 *   许可表会让任何**新的**真实能力缺口静默消失——那正是本阶段要消灭的"静默死路径"。
 *   否决表最坏情况是多产生一条**待人工审批**的提案（本项目已明确接受该代价：
 *   "误报代价 = 一条被驳回的提案"），永不静默停学。
 *   已知边界（如实记录，不掩饰）：本表由**真实错误码总体**推导（25 个 code / 27,101 条
 *   tool-result / 25 个真实会话），未来若出现新的瞬态码而不在本表内，它仍会被判 learnable；
 *   补充必须**基于实证观测**（先见到真实出现），而不是凭想象扩充本表。
 */
export const NON_CAPABILITY_CODES = Object.freeze(new Set([
  // 瞬态 / 超时
  'TOOL_TIMEOUT',
  // provider / web 中断
  'WEB_ABORTED',
  // 凭据 / 配置
  'WEB_PROVIDER_CREDENTIAL_MISSING', 'UNKNOWN_TOOL',
  // 用户 / 系统中止
  'ABORTED', 'ABORTED_BEFORE_DISPATCH', 'ASK_CANCELLED', 'NOT_RESUMABLE',
  // 调用方参数或工具语义误用
  'INVALID_ARGS',
  'GOAL_ALREADY_EXISTS', 'GOAL_NOT_FOUND', 'GOAL_STALE_REVISION',
  'GOAL_TOOL_AUTHORITY_REQUIRED', 'GOAL_TOOL_INVALID_UPDATE',
]));

/** 适配器否决/放行原因码（可断言、不随文案抖动）。 */
export const CAPABILITY_REASON = Object.freeze({
  LEARNABLE: null,                                // 可能的能力缺口（尚需 qualifyGap 的 4 项）
  NOT_LEARNABLE_ORIGIN: 'NOT_LEARNABLE_ORIGIN',   // 外部/瞬态来源，永不成为能力缺口
  UNKNOWN_ORIGIN_NO_EVIDENCE: 'UNKNOWN_ORIGIN_NO_EVIDENCE', // 来源未知且未举证（fail-closed）
  MISSING_STRUCTURED_FACT: 'MISSING_STRUCTURED_FACT',       // 无结构化事实（fail-closed）
  NOT_AN_ERROR: 'NOT_AN_ERROR',                   // 结构化事实表明这不是一次失败
  NON_CAPABILITY_CODE: 'NON_CAPABILITY_CODE',     // 码级否决：属环境/瞬态/用户/配置（STAGE 2）
  MISSING_ERROR_CODE: 'MISSING_ERROR_CODE',       // 无结构化错误码（fail-closed，STAGE 2）
});

/** 从结构化事实取工具身份（不读任何文本内容）。 */
function toolIdentityOf(structured) {
  for (const k of ['toolName', 'tool']) {
    const v = structured[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** 从结构化事实取错误码（不读任何文本内容）。 */
function errorCodeOf(structured) {
  const v = structured.errorCode;
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

/**
 * 判定一条结构化失败事实的**来源域**。零关键词、纯结构化：
 *   1. 调用方显式给出合法 origin → 采用（但非可学习来源仍会被否决）；
 *   2. 否则：`isError === true` 且带工具身份 ⇒ tool 域；
 *   3. 其余 ⇒ unknown（fail-closed，绝不猜成 provider —— 那是 P2.6 的域）。
 *
 * @param {object} structured - {origin?, toolName?/tool?, errorCode?, errorName?, isError?}
 * @returns {string} FAILURE_ORIGIN 之一
 */
export function classifyFailureOrigin(structured) {
  if (!isPlainObject(structured)) return FAILURE_ORIGIN.UNKNOWN;
  const explicit = typeof structured.origin === 'string' ? structured.origin.trim().toLowerCase() : '';
  if (KNOWN_ORIGINS.includes(explicit)) return explicit;
  if (structured.isError === true && toolIdentityOf(structured)) return FAILURE_ORIGIN.TOOL;
  return FAILURE_ORIGIN.UNKNOWN;
}

/**
 * 计算能力缺口的**规范化签名**（用于去重与"同一缺口"判定）。
 *
 * 与 P2.6 的 normalizedSignatureOf() 同一纪律：**故意不含 message/文案**，
 * 因此同一缺口在不同措辞下签名稳定（variant-proof）。
 *
 * @param {object} structured
 * @returns {string} `${origin}|${tool}|${errorCode}|v${CAPABILITY_ADAPTER_VERSION}`
 */
export function capabilitySignature(structured) {
  const origin = classifyFailureOrigin(structured);
  const tool = toolIdentityOf(isPlainObject(structured) ? structured : {}) || '-';
  const code = errorCodeOf(isPlainObject(structured) ? structured : {}) || '-';
  return `${origin}|${tool}|${code}|v${CAPABILITY_ADAPTER_VERSION}`;
}

/**
 * 对一条**结构化**失败事实做能力缺口资格判定（适配器核心）。
 *
 * @param {object} structured - 结构化事实（非文本）
 * @param {object} [opts]
 * @param {string} [opts.capabilityEvidence] - 显式举证（仅对 unknown 来源有意义）
 * @returns {{learnable:boolean, reason:string|null, origin:string,
 *            signature:string, adapterVersion:number}}
 */
export function evaluateCapabilityObservation(structured, opts = {}) {
  const adapterVersion = CAPABILITY_ADAPTER_VERSION;
  const base = (learnable, reason, origin, signature) =>
    ({ learnable, reason, origin, signature, adapterVersion });

  if (!isPlainObject(structured)) {
    return base(false, CAPABILITY_REASON.MISSING_STRUCTURED_FACT, FAILURE_ORIGIN.UNKNOWN, '');
  }

  // ★ 结构化事实**明确**表明这不是一次失败（isError === false）⇒ 永远不能成为缺口证据。
  //   必须**早于**起源判定：否则会落到 UNKNOWN 分支并以 UNKNOWN_ORIGIN_NO_EVIDENCE 上报，
  //   把"本来就不是失败"误报成"来源不明"，误导运维排查方向（AC8 可观测性）。
  //   注意只认**显式 false**；undefined / 缺失仍走 fail-closed 的 UNKNOWN 分支。
  if (structured.isError === false) {
    return base(false, CAPABILITY_REASON.NOT_AN_ERROR,
      classifyFailureOrigin(structured), capabilitySignature(structured));
  }

  const origin = classifyFailureOrigin(structured);
  const signature = capabilitySignature(structured);

  // unknown 是 fail-closed 残差：**只有**调用方显式举证时才可能放行（v1 语义，保持不变）。
  const unknownEvidenced = origin === FAILURE_ORIGIN.UNKNOWN
    && typeof opts.capabilityEvidence === 'string' && opts.capabilityEvidence.trim() !== '';
  if (origin === FAILURE_ORIGIN.UNKNOWN && !unknownEvidenced) {
    return base(false, CAPABILITY_REASON.UNKNOWN_ORIGIN_NO_EVIDENCE, origin, signature);
  }

  if (NON_LEARNABLE_ORIGINS.includes(origin)) {
    // 环境 / 供应商 / 网络 / 用户 / 第三方站点：重试或配置即可，**不是**缺能力。
    return base(false, CAPABILITY_REASON.NOT_LEARNABLE_ORIGIN, origin, signature);
  }

  // ── STAGE 2 码级否决（v2）──────────────────────────────────────────────
  // 到这里说明该事实**有可能**被判为可学；下面两道闸门是 v1 缺失的守卫盲区。
  // 位置纪律：必须在 UNKNOWN_ORIGIN_NO_EVIDENCE 与 NOT_LEARNABLE_ORIGIN **之后**，
  // 以保持既有失败原因语义（reason 优先级）完全不变。
  if (structured.isError !== true) {
    return base(false, CAPABILITY_REASON.NOT_AN_ERROR, origin, signature);
  }
  const code = errorCodeOf(structured);
  if (!code) {
    // fail-closed：无结构化错误码 ⇒ 无法区分「缺能力」与「未归类的瞬态失败」。
    // 且签名会退化为占位符 `-`，导致**同一工具下所有无码失败并成一个桶**
    // （实测无码失败占全部失败的 25.09%），极易凑满重复阈值而**凭空造出缺口**。
    return base(false, CAPABILITY_REASON.MISSING_ERROR_CODE, origin, signature);
  }
  if (NON_CAPABILITY_CODES.has(code)) {
    return base(false, CAPABILITY_REASON.NON_CAPABILITY_CODE, origin, signature);
  }

  if (unknownEvidenced || LEARNABLE_ORIGINS.includes(origin)) {
    return base(true, CAPABILITY_REASON.LEARNABLE, origin, signature);
  }

  // 理论上不可达（KNOWN_ORIGINS 已穷尽）；保守起见仍否决
  return base(false, CAPABILITY_REASON.UNKNOWN_ORIGIN_NO_EVIDENCE, FAILURE_ORIGIN.UNKNOWN, signature);
}
