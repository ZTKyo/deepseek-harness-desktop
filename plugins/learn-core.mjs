// learn-core.mjs —— P4 LEARN R1 纯函数核心（零 IO / 零依赖）
//
// Authority 边界（P4 契约）：
//   - 只决定"从原始会话中提炼出什么可复用的经验（experience）"，以及"哪些经验可被召回"。
//   - 绝不成为第二 Task DB / Goal DB / Recovery Engine / Router / compaction authority。
//   - 原始会话（Official Session）永远是唯一 Truth Source：经验必须携带 sourceEventSeqs 回源锚点。
//   - 绝不解析原始会话：抽取一律复用 P2.5 的官方提取器（messageOfEvent / recursiveText），
//     由调用方（插件壳）注入 —— 本模块内不存在第二个 raw-session parser。
//   - 提案 ≠ 激活：propose() 产出的经验永远是 PROPOSED；只有显式人工 approve() 才可能被召回。
//   - 经验库损坏/缺失 → fail-closed（validateStore 返回 null，调用方重建），绝不静默信任坏状态。
//   - 学习永不写入 runtime state / goals / credentials / policy（assertWriteAllowed）。
//
// 本模块全部为确定性纯函数；IO 与钩子注册在 learn.mjs 插件壳内。
//
// AC1 硬保证：原始会话的抽取**直接 import P2.5 的官方提取器**（context-memory-core.mjs）。
// 本模块物理上不存在第二个 raw-session parser —— 不是"约定不重复实现"，而是"没有可重复的代码"。

import {
  messageOfEvent as p25MessageOfEvent,
  recursiveText as p25RecursiveText,
  isPluginSourced as p25IsPluginSourced,
} from './context-memory-core.mjs';

/**
 * P2.5 官方提取器集合（唯一权威）。buildLearnDigest 默认即用这一组；
 * 显式传入仅用于单测注入，生产路径永远是这里导入的实现。
 */
export const P25_EXTRACTORS = Object.freeze({
  messageOfEvent: p25MessageOfEvent,
  recursiveText: p25RecursiveText,
  isPluginSourced: p25IsPluginSourced,
});

/** 经验库 schema 版本（与 store 持久化解耦，便于未来迁移）。 */
export const LEARN_SCHEMA_VERSION = 1;

/** 经验条目上限（防止无界增长）。 */
export const MAX_EXPERIENCES = 200;
/** 单条经验正文上限（字符）。 */
export const MAX_BODY_LEN = 4000;
/** 单条经验标题上限。 */
export const MAX_TITLE_LEN = 200;
/** 标签数量上限。 */
export const MAX_TAGS = 16;
/** 单个标签长度上限。 */
export const MAX_TAG_LEN = 64;
/** 单条经验回源锚点数量上限。 */
export const MAX_SOURCE_SEQS = 64;
/** 审批/证据/理由文本上限。 */
export const MAX_APPROVER_LEN = 200;
export const MAX_EVIDENCE_LEN = 2000;
export const MAX_REASON_LEN = 1000;
/** 遥测环形缓冲上限。 */
export const MAX_TELEMETRY = 500;
/** 召回返回条数上限。 */
export const MAX_RECALL_LIMIT = 20;

/** 经验生命周期状态。提案 → 审批 → （可选）退役；REJECTED 为终态。 */
export const EXPERIENCE_STATES = ['PROPOSED', 'APPROVED', 'REJECTED', 'RETIRED'];
/** 状态迁移白名单：任何未列出的迁移一律拒绝（fail-closed）。 */
export const ALLOWED_TRANSITIONS = {
  PROPOSED: ['APPROVED', 'REJECTED'],
  APPROVED: ['RETIRED'],
  REJECTED: [],   // 终态：不得复活（复活必须重新 propose，留下新痕迹）
  RETIRED: [],    // 终态
};
/** 晋升资格判定。注意：ELIGIBLE ≠ PROMOTED —— 晋升永远需要显式调用，绝无自动晋升。 */
export const PROMOTION_STATES = ['NONE', 'ELIGIBLE', 'PROMOTED', 'BLOCKED'];

/** 遥测事件类型（可观测性契约）。 */
export const TELEMETRY_KINDS = ['PROPOSED', 'APPROVED', 'REJECTED', 'RECALLED', 'PROMOTION_BLOCKED', 'PROMOTION_ELIGIBLE', 'STORE_REBUILT', 'WRITE_DENIED'];

/** 学习允许写入的目标（白名单）；其余一律拒绝。 */
export const LEARN_WRITE_TARGETS = ['experience-store', 'telemetry', 'audit-log'];
/**
 * 学习被禁止写入的目标（显式红线，用于给出可读的拒绝原因）。
 * 这些是 runtime 状态/目标/凭据/策略 —— 学习产物绝不能覆盖它们。
 */
export const PROTECTED_TARGETS = [
  'runtime-state', 'session', 'sessions', 'goal', 'goals', 'credentials',
  'policy', 'settings', 'config', 'profile', 'profiles', 'autonomy-state',
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. 密钥脱敏（AC3）：运行时脱敏，覆盖 Security-Hardening 的 9 个规范家族
//    （notion/openai/openrouter/slack/github/jwt/anthropic/telegram/aws）
//    外加通用 "KEY=值" / Bearer 形态。families 名称与 tests/reliability/
//    secret-scan-check.mjs 保持一致，并由 test-learn-no-secrets.mjs 做覆盖平价校验。
// ─────────────────────────────────────────────────────────────────────────────

/** 运行时脱敏模式表。name 与仓库规范扫描器 secret-scan-check.mjs 的家族名对齐。 */
export const SECRET_PATTERNS = [
  { name: 'notion', re: /ntn_[A-Za-z0-9]{16,}/g },
  { name: 'openrouter', re: /\bsk-or-v1-[A-Za-z0-9]{16,}\b/g },   // 必须先于 openai 匹配
  { name: 'openai', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g },
  { name: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'telegram', re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g },
  { name: 'aws', re: /\bAKIA[A-Z0-9]{16}\b/g },
  // 通用形态：显式凭据赋值 与 Bearer/Authorization 头
  { name: 'generic-assignment', re: /\b(?:api[_-]?key|apikey|secret|password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?([A-Za-z0-9_\-./+]{12,})["']?/gi },
  { name: 'generic-bearer', re: /\bBearer\s+([A-Za-z0-9_\-./+=]{16,})/gi },
];

/** 脱敏占位符（保留家族名，便于审计"这里曾有密钥"而不泄露值）。 */
export function redactionToken(family) {
  return `[REDACTED:${family}]`;
}

/**
 * 对任意文本做密钥脱敏。非字符串 → 原样返回（调用方负责类型）。
 * 确定性：同一输入永远得到同一输出。
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text === '') return typeof text === 'string' ? text : '';
  let out = text;
  for (const p of SECRET_PATTERNS) {
    // 每次替换都重建 lastIndex，避免 /g 正则的跨调用状态污染
    out = out.replace(new RegExp(p.re.source, p.re.flags), redactionToken(p.name));
  }
  return out;
}

/** 文本中是否含密钥形态（用于 fail-closed 拒收，而非静默改写）。 */
export function containsSecret(text) {
  if (typeof text !== 'string' || text === '') return false;
  for (const p of SECRET_PATTERNS) {
    if (new RegExp(p.re.source, p.re.flags).test(text)) return true;
  }
  return false;
}

/** 列出命中的密钥家族名（审计用；不含任何密钥值）。 */
export function secretFamiliesIn(text) {
  if (typeof text !== 'string' || text === '') return [];
  const hits = [];
  for (const p of SECRET_PATTERNS) {
    if (new RegExp(p.re.source, p.re.flags).test(text)) hits.push(p.name);
  }
  return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 基础工具
// ─────────────────────────────────────────────────────────────────────────────

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 清洗字符串：去首尾空白 + 截断 + 脱敏。 */
function cleanStr(v, max) {
  if (typeof v !== 'string') return null;
  const t = redactSecrets(v.trim());
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

/** 确定性哈希（FNV-1a 32bit，十六进制）—— 用于生成稳定 id，无 crypto 依赖。 */
export function stableHash(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 规范化标签：小写、去空白、去重、稳定排序（保证确定性）。 */
export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const set = new Set();
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const c = redactSecrets(t.trim().toLowerCase());
    if (!c) continue;
    set.add(c.length > MAX_TAG_LEN ? c.slice(0, MAX_TAG_LEN) : c);
  }
  return [...set].sort();
}

/** 规范化回源锚点：非负整数、去重、升序（确定性）。 */
export function normalizeSourceSeqs(seqs) {
  if (!Array.isArray(seqs)) return [];
  const set = new Set();
  for (const s of seqs) {
    if (Number.isInteger(s) && s >= 0) set.add(s);
  }
  return [...set].sort((a, b) => a - b).slice(0, MAX_SOURCE_SEQS);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 经验条目：构造 / 清洗 / 校验
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造一条经验条目（永远以 PROPOSED 出生 —— 提案 ≠ 激活）。
 * @returns {{ok:boolean, value?:object, error?:string}}
 */
export function makeExperience(draft) {
  if (!isPlainObject(draft)) return { ok: false, error: 'invalid_draft' };
  const title = cleanStr(draft.title, MAX_TITLE_LEN);
  const body = cleanStr(draft.body, MAX_BODY_LEN);
  if (!title) return { ok: false, error: 'missing_title' };
  if (!body) return { ok: false, error: 'missing_body' };
  const sourceEventSeqs = normalizeSourceSeqs(draft.sourceEventSeqs);
  if (sourceEventSeqs.length === 0) return { ok: false, error: 'missing_source_seqs' };
  const tags = normalizeTags(draft.tags);
  // 稳定 id：由"来源会话 + 回源锚点 + 标题"派生 → 同一证据重复提案得到同一 id（幂等）
  const originSessionId = cleanStr(draft.originSessionId, MAX_TITLE_LEN) ?? 'unknown';
  const id = `exp-${stableHash(`${originSessionId}|${sourceEventSeqs.join(',')}|${title}`)}`;
  return {
    ok: true,
    value: {
      id,
      state: 'PROPOSED',          // 出生即提案，绝无例外
      title,
      body,
      tags,
      sourceEventSeqs,
      originSessionId,
      createdAt: Number.isSafeInteger(draft.createdAt) ? draft.createdAt : 0,
      approvedAt: null,
      approvedBy: null,
      approvalEvidence: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      retiredAt: null,
      promotion: 'NONE',
      promotionEvidence: null,
      recallCount: 0,
      lastRecalledAt: null,
    },
  };
}

/** 校验单条经验（fail-closed：任何字段不合法 → error）。 */
export function sanitizeExperience(raw) {
  if (!isPlainObject(raw)) return { error: 'invalid_experience' };
  if (typeof raw.id !== 'string' || !raw.id) return { error: 'invalid_experience_id' };
  if (!EXPERIENCE_STATES.includes(raw.state)) return { error: 'invalid_experience_state' };
  if (typeof raw.title !== 'string' || !raw.title || raw.title.length > MAX_TITLE_LEN) return { error: 'invalid_experience_title' };
  if (typeof raw.body !== 'string' || !raw.body || raw.body.length > MAX_BODY_LEN) return { error: 'invalid_experience_body' };
  if (!Array.isArray(raw.tags) || raw.tags.length > MAX_TAGS) return { error: 'invalid_experience_tags' };
  if (!Array.isArray(raw.sourceEventSeqs) || raw.sourceEventSeqs.length === 0 ||
    raw.sourceEventSeqs.length > MAX_SOURCE_SEQS ||
    !raw.sourceEventSeqs.every((s) => Number.isInteger(s) && s >= 0)) {
    return { error: 'invalid_experience_source_seqs' };
  }
  if (!PROMOTION_STATES.includes(raw.promotion)) return { error: 'invalid_promotion_state' };
  // 不变量：APPROVED 必须有审批人与证据（人工审批边界不可绕过）
  if (raw.state === 'APPROVED') {
    if (typeof raw.approvedBy !== 'string' || !raw.approvedBy) return { error: 'approved_without_approver' };
    if (typeof raw.approvalEvidence !== 'string' || !raw.approvalEvidence) return { error: 'approved_without_evidence' };
  }
  // 不变量：PROPOSED 不得携带任何审批/晋升痕迹
  if (raw.state === 'PROPOSED') {
    if (raw.approvedAt !== null || raw.approvedBy !== null) return { error: 'proposed_with_approval_trace' };
    if (raw.promotion !== 'NONE') return { error: 'proposed_with_promotion' };
  }
  // 不变量：PROMOTED 必须是 APPROVED 且带晋升证据
  if (raw.promotion === 'PROMOTED') {
    if (raw.state !== 'APPROVED') return { error: 'promoted_without_approval' };
    if (typeof raw.promotionEvidence !== 'string' || !raw.promotionEvidence) return { error: 'promoted_without_evidence' };
  }
  return { value: raw };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 经验库 store：空骨架 / 校验（fail-closed）
// ─────────────────────────────────────────────────────────────────────────────

export function emptyStore(sessionId) {
  return {
    schemaVersion: LEARN_SCHEMA_VERSION,
    sessionId: typeof sessionId === 'string' && sessionId ? sessionId : 'unknown',
    version: 0,
    experiences: [],
    telemetry: [],
    updatedAt: 0,
  };
}

/**
 * 校验经验库。损坏/结构不符 → 返回 null（调用方 fail-closed 重建，绝不静默信任）。
 * 与 P2.5 validateStore 同一纪律。
 */
export function validateStore(raw) {
  try {
    if (!isPlainObject(raw)) return null;
    if (raw.schemaVersion !== LEARN_SCHEMA_VERSION) return null;
    if (typeof raw.sessionId !== 'string' || !raw.sessionId) return null;
    if (!Number.isSafeInteger(raw.version) || raw.version < 0) return null;
    if (!Array.isArray(raw.experiences)) return null;
    if (raw.experiences.length > MAX_EXPERIENCES) return null;
    if (!Array.isArray(raw.telemetry)) return null;
    if (raw.telemetry.length > MAX_TELEMETRY) return null;
    // 逐条校验：任何一条坏了，整个 store 判废（fail-closed，不部分信任）
    for (const e of raw.experiences) {
      if (sanitizeExperience(e).error) return null;
    }
    for (const t of raw.telemetry) {
      if (!isPlainObject(t) || typeof t.kind !== 'string' || !TELEMETRY_KINDS.includes(t.kind)) return null;
    }
    return raw;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 提案 / 审批（人工审批边界）—— 全部为不可变更新，返回新 store
// ─────────────────────────────────────────────────────────────────────────────

/** 内部：不可变追加/替换。 */
function withExperience(store, exp) {
  const next = store.experiences.filter((e) => e.id !== exp.id);
  next.push(exp);
  // 稳定排序：按 createdAt 升序、id 升序 → 确定性
  next.sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ...store, experiences: next.slice(-MAX_EXPERIENCES) };
}

/**
 * 提案一条经验。已存在同 id → 幂等返回原条目（不复活 REJECTED）。
 * 注意：本函数永远不产生 APPROVED 状态。
 */
export function propose(store, draft) {
  const made = makeExperience(draft);
  if (!made.ok) return { ok: false, error: made.error };
  const exp = made.value;
  const existing = store.experiences.find((e) => e.id === exp.id);
  if (existing) {
    return { ok: true, value: store, experience: existing, deduped: true };
  }
  const next = withExperience(store, exp);
  return { ok: true, value: next, experience: exp, deduped: false };
}

/** 检查状态迁移是否合法。 */
export function canTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * 人工审批：PROPOSED → APPROVED。
 * 硬性要求：审批人 + 非空证据。缺少任一项 → 拒绝（审批边界不可绕过）。
 */
export function approve(store, id, opts = {}) {
  const exp = store.experiences.find((e) => e.id === id);
  if (!exp) return { ok: false, error: 'experience_not_found' };
  const approver = cleanStr(opts.approver, MAX_APPROVER_LEN);
  const evidence = cleanStr(opts.evidence, MAX_EVIDENCE_LEN);
  if (!approver) return { ok: false, error: 'approval_requires_approver' };
  if (!evidence) return { ok: false, error: 'approval_requires_evidence' };
  if (containsSecret(opts.evidence)) return { ok: false, error: 'approval_evidence_contains_secret' };
  if (!canTransition(exp.state, 'APPROVED')) return { ok: false, error: `illegal_transition:${exp.state}->APPROVED` };
  const updated = {
    ...exp,
    state: 'APPROVED',
    approvedAt: Number.isSafeInteger(opts.at) ? opts.at : 0,
    approvedBy: approver,
    approvalEvidence: evidence,
  };
  const checked = sanitizeExperience(updated);
  if (checked.error) return { ok: false, error: checked.error };
  return { ok: true, value: withExperience(store, updated), experience: updated };
}

/** 人工驳回：PROPOSED → REJECTED（终态，不得复活）。 */
export function reject(store, id, opts = {}) {
  const exp = store.experiences.find((e) => e.id === id);
  if (!exp) return { ok: false, error: 'experience_not_found' };
  const approver = cleanStr(opts.approver, MAX_APPROVER_LEN);
  const reason = cleanStr(opts.reason, MAX_REASON_LEN);
  if (!approver) return { ok: false, error: 'rejection_requires_approver' };
  if (!reason) return { ok: false, error: 'rejection_requires_reason' };
  if (!canTransition(exp.state, 'REJECTED')) return { ok: false, error: `illegal_transition:${exp.state}->REJECTED` };
  const updated = {
    ...exp,
    state: 'REJECTED',
    rejectedAt: Number.isSafeInteger(opts.at) ? opts.at : 0,
    rejectedBy: approver,
    rejectionReason: reason,
  };
  const checked = sanitizeExperience(updated);
  if (checked.error) return { ok: false, error: checked.error };
  return { ok: true, value: withExperience(store, updated), experience: updated };
}

/** 退役：APPROVED → RETIRED（终态）。 */
export function retire(store, id, opts = {}) {
  const exp = store.experiences.find((e) => e.id === id);
  if (!exp) return { ok: false, error: 'experience_not_found' };
  if (!canTransition(exp.state, 'RETIRED')) return { ok: false, error: `illegal_transition:${exp.state}->RETIRED` };
  const updated = { ...exp, state: 'RETIRED', retiredAt: Number.isSafeInteger(opts.at) ? opts.at : 0 };
  const checked = sanitizeExperience(updated);
  if (checked.error) return { ok: false, error: checked.error };
  return { ok: true, value: withExperience(store, updated), experience: updated };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. 确定性召回（AC4）—— 只召回 APPROVED
// ─────────────────────────────────────────────────────────────────────────────

/** 确定性分词：小写、按非字母数字切分、去短词。无 locale 依赖。 */
export function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/u)) {
    if (!raw) continue;
    // 拉丁词至少 3 字符；CJK 单字保留（中文无空格切分）
    if (/^[a-z0-9]+$/.test(raw)) {
      if (raw.length >= 3) out.push(raw);
    } else {
      out.push(raw);
    }
  }
  return out;
}

/** 单条经验是否可被召回：只有 APPROVED 可以（提案 ≠ 激活）。 */
export function isRecallable(exp) {
  return isPlainObject(exp) && exp.state === 'APPROVED';
}

/**
 * 从经验库确定性召回。
 * 规则：
 *   - 候选集 = state === APPROVED 的条目（其余一律不可见）；
 *   - 打分 = 查询词与（标题+正文+标签）词集的命中数 / 查询词数（0..1，可解释）；
 *   - 排序 = 分数降序 → id 升序（全序，保证同一输入永远同一输出）；
 *   - score 为 0 的条目不入结果（避免噪声召回）。
 * @returns {{ok:boolean, items:Array, considered:number, excluded:number}}
 */
export function recall(store, query, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0
    ? Math.min(opts.limit, MAX_RECALL_LIMIT)
    : 5;
  const qText = typeof query === 'string' ? query : (isPlainObject(query) ? query.text : '');
  const qTokens = tokenize(qText);
  const qTags = normalizeTags(isPlainObject(query) ? query.tags : []);
  const approved = store.experiences.filter(isRecallable);
  const excluded = store.experiences.length - approved.length;
  if (qTokens.length === 0 && qTags.length === 0) {
    return { ok: true, items: [], considered: approved.length, excluded, reason: 'empty_query' };
  }
  const scored = [];
  for (const exp of approved) {
    const hay = new Set([...tokenize(exp.title), ...tokenize(exp.body), ...exp.tags]);
    let hits = 0;
    for (const t of qTokens) if (hay.has(t)) hits += 1;
    let score = qTokens.length > 0 ? hits / qTokens.length : 0;
    if (qTags.length > 0) {
      const tagHits = qTags.filter((t) => exp.tags.includes(t)).length;
      score += tagHits / qTags.length;   // 标签命中加权
    }
    if (score > 0) scored.push({ exp, score });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.exp.id < b.exp.id ? -1 : a.exp.id > b.exp.id ? 1 : 0));
  const items = scored.slice(0, limit).map(({ exp, score }) => ({
    id: exp.id,
    title: exp.title,
    body: exp.body,
    tags: exp.tags,
    score: Math.round(score * 1000) / 1000,
    // 回源锚点：召回结果永远可回溯到原始会话（Official Session 是唯一 Truth Source）
    sourceEventSeqs: exp.sourceEventSeqs.slice(),
    originSessionId: exp.originSessionId,
    approvedBy: exp.approvedBy,
  }));
  return { ok: true, items, considered: approved.length, excluded };
}

/** 记录一次召回（更新命中条目的召回统计）。 */
export function recordRecall(store, ids, at) {
  const set = new Set(Array.isArray(ids) ? ids : []);
  const ts = Number.isSafeInteger(at) ? at : 0;
  const experiences = store.experiences.map((e) =>
    set.has(e.id) ? { ...e, recallCount: e.recallCount + 1, lastRecalledAt: ts } : e);
  return { ...store, experiences };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 晋升（AC11）—— 资格判定与晋升是两个动作；绝无自动晋升
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 晋升资格判定（纯判定，不改变任何状态）。
 * 条件：APPROVED + 带审批证据 + 至少被真实召回一次。
 * 注意：返回 ELIGIBLE 不代表晋升 —— 晋升必须显式调用 promote()。
 */
export function promotionEligibility(exp) {
  if (!isPlainObject(exp)) return { eligible: false, state: 'BLOCKED', reason: 'invalid_experience' };
  if (exp.promotion === 'PROMOTED') return { eligible: false, state: 'PROMOTED', reason: 'already_promoted' };
  if (exp.state !== 'APPROVED') return { eligible: false, state: 'NONE', reason: `not_approved:${exp.state}` };
  if (typeof exp.approvalEvidence !== 'string' || !exp.approvalEvidence) {
    return { eligible: false, state: 'BLOCKED', reason: 'no_approval_evidence' };
  }
  if (!Number.isInteger(exp.recallCount) || exp.recallCount < 1) {
    return { eligible: false, state: 'BLOCKED', reason: 'never_recalled' };
  }
  return { eligible: true, state: 'ELIGIBLE', reason: 'approved_with_evidence_and_recall' };
}

/**
 * 显式晋升。要求：资格成立 + 显式晋升证据（人工提供的依据）。
 * 绝不自动调用；绝不因"资格满足"而自行晋升。
 */
export function promote(store, id, opts = {}) {
  const exp = store.experiences.find((e) => e.id === id);
  if (!exp) return { ok: false, error: 'experience_not_found' };
  const elig = promotionEligibility(exp);
  if (!elig.eligible) return { ok: false, error: `not_eligible:${elig.reason}` };
  const evidence = cleanStr(opts.evidence, MAX_EVIDENCE_LEN);
  if (!evidence) return { ok: false, error: 'promotion_requires_evidence' };
  if (containsSecret(opts.evidence)) return { ok: false, error: 'promotion_evidence_contains_secret' };
  const updated = { ...exp, promotion: 'PROMOTED', promotionEvidence: evidence };
  const checked = sanitizeExperience(updated);
  if (checked.error) return { ok: false, error: checked.error };
  return { ok: true, value: withExperience(store, updated), experience: updated };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. 写入边界（AC10）—— 学习产物绝不能覆盖 runtime state / goals / credentials / policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 判定学习是否可以写入某目标。
 * @returns {{allowed:boolean, reason:string}}
 */
export function assertWriteAllowed(target) {
  const t = typeof target === 'string' ? target.trim().toLowerCase() : '';
  if (!t) return { allowed: false, reason: 'empty_target' };
  if (PROTECTED_TARGETS.includes(t)) return { allowed: false, reason: `protected_target:${t}` };
  // 前缀/包含式防护：runtime-state.json / goal-store / credentials.yaml 等一律拒绝
  for (const p of PROTECTED_TARGETS) {
    if (t.includes(p)) return { allowed: false, reason: `protected_target:${p}` };
  }
  if (!LEARN_WRITE_TARGETS.includes(t)) return { allowed: false, reason: `not_in_whitelist:${t}` };
  return { allowed: true, reason: 'ok' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. 遥测（AC8）—— 结构化 + 脱敏 + 有界环形缓冲
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造一条遥测事件。所有自由文本一律脱敏；超出上限的字段被截断。
 * 确定性：不含随机数/时间戳（时间由调用方传入）。
 */
export function telemetryEvent(kind, payload = {}, at = 0) {
  if (!TELEMETRY_KINDS.includes(kind)) return { ok: false, error: 'invalid_telemetry_kind' };
  const p = isPlainObject(payload) ? payload : {};
  const ev = {
    kind,
    at: Number.isSafeInteger(at) ? at : 0,
    experienceId: typeof p.experienceId === 'string' ? p.experienceId.slice(0, 64) : null,
    detail: typeof p.detail === 'string' ? redactSecrets(p.detail).slice(0, 500) : null,
    count: Number.isInteger(p.count) ? p.count : null,
    reason: typeof p.reason === 'string' ? redactSecrets(p.reason).slice(0, 200) : null,
  };
  return { ok: true, value: ev };
}

/** 追加遥测（有界环形缓冲）。 */
export function appendTelemetry(store, ev) {
  const checked = isPlainObject(ev) && TELEMETRY_KINDS.includes(ev.kind);
  if (!checked) return store;
  const next = [...store.telemetry, ev];
  return { ...store, telemetry: next.slice(-MAX_TELEMETRY) };
}

/** 遥测摘要（只读聚合，供运维观察）。 */
export function telemetrySummary(store) {
  const counts = {};
  for (const k of TELEMETRY_KINDS) counts[k] = 0;
  for (const t of store.telemetry) {
    if (counts[t.kind] === undefined) counts[t.kind] = 0;
    counts[t.kind] += 1;
  }
  const byState = {};
  for (const s of EXPERIENCE_STATES) byState[s] = 0;
  for (const e of store.experiences) {
    if (byState[e.state] === undefined) byState[e.state] = 0;
    byState[e.state] += 1;
  }
  return {
    total: store.telemetry.length,
    counts,
    experiences: store.experiences.length,
    byState,
    promoted: store.experiences.filter((e) => e.promotion === 'PROMOTED').length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. 原始会话 → 学习摘要（AC1 / AC6）
//     抽取一律复用 P2.5 官方提取器（由调用方注入），本模块内无第二个 raw parser。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从原始会话事件构建学习摘要（纯函数）。
 *
 * 抽取一律走 P2.5 官方提取器（默认 P25_EXTRACTORS，即 context-memory-core.mjs 的导入值）。
 * extractors 参数只为单测注入而存在；生产调用方不传即得到唯一权威实现。
 *
 * @param {Array} events        session.events（官方原始事件数组，按 seq 索引）
 * @param {Array<number>} nodeSeqs  session.surface.nodes（官方 surface 节点 seq 列表）
 * @param {{messageOfEvent:Function, recursiveText:Function, isPluginSourced:Function}} [extractors]
 * @returns {{ok:boolean, digest?:object, error?:string}}
 */
/**
 * Harness 注入内容标记（R2 对抗评审新增）。
 *
 * 实证：R1 的真实会话摘要里，27 个信号中有 4 个来自 `<system-reminder>` 注入块
 * （工作区指令 / skill catalog），它们被当成"失败信号"并生成候选，标题就是注入文本本身。
 * `isPluginSourced` 只能覆盖**部分**此类事件（实测同一会话内有的被标记、有的没有），
 * 因此这里做一层与来源标记无关的**内容级**防御。
 */
export const INJECTED_BLOCK_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
/** 未闭合的注入块（截断日志）：从标记处一直切到结尾。 */
export const INJECTED_OPEN_RE = /<system-reminder>[\s\S]*$/i;

/**
 * 剥离 harness 注入块，返回剩余的真实发言文本。
 * 只剥块、不剥整轮：注入块常常是**追加**在真实用户消息后面的，整轮丢弃会连真人发言一起丢。
 */
export function stripInjectedContent(text) {
  if (typeof text !== 'string' || !text) return '';
  let out = text.replace(INJECTED_BLOCK_RE, '');
  out = out.replace(INJECTED_OPEN_RE, '');
  return out.trim();
}

export function buildLearnDigest(events, nodeSeqs, extractors = P25_EXTRACTORS) {
  if (!Array.isArray(events)) return { ok: false, error: 'events_not_array' };
  if (!Array.isArray(nodeSeqs)) return { ok: false, error: 'nodes_not_array' };
  if (!isPlainObject(extractors) ||
    typeof extractors.messageOfEvent !== 'function' ||
    typeof extractors.recursiveText !== 'function' ||
    typeof extractors.isPluginSourced !== 'function') {
    return { ok: false, error: 'missing_official_extractors' };
  }
  const { messageOfEvent, recursiveText, isPluginSourced } = extractors;

  // R2 对抗评审：调用方传入的 nodeSeqs 必须先**规范化**（去重 + 升序），否则
  //   - 重复 seq（如 [0,0,0,1]）会把同一轮发言算 3 次、放大信号与回源锚点；
  //   - 乱序 seq（如 [1,0]）会让信号顺序随调用方顺序漂移，破坏"确定性"契约。
  // 官方 surface.nodes 本身有序且唯一，这里是**防御性**规范化，不依赖调用方纪律。
  const canonical = [...new Set(nodeSeqs.filter((q) => Number.isInteger(q) && q >= 0 && q < events.length))]
    .sort((a, b) => a - b);

  const turns = [];
  let injectedSkipped = 0;
  for (const seq of canonical) {
    const ev = events[seq];
    if (!ev || typeof ev.type !== 'string') continue;
    const msg = messageOfEvent(ev);          // ← P2.5 官方提取路径
    if (!msg) continue;
    const raw = recursiveText(msg.content ?? msg);   // ← P2.5 官方递归文本提取
    if (!raw) continue;
    const role = ev.type === 'user/message' ? 'user' : 'assistant';
    // 插件注入的投影不算原始人类/模型发言（防反馈回路）—— 与 P2.5 同一纪律
    if (isPluginSourced(msg)) continue;
    // 内容级防御：剥掉 harness 注入块；剥完为空 ⇒ 整轮都不是真实发言，跳过
    const text = stripInjectedContent(raw);
    if (!text) { injectedSkipped += 1; continue; }
    turns.push({ seq, role, text: redactSecrets(text) });
  }
  return {
    ok: true,
    digest: {
      turnCount: turns.length,
      turns,
      injectedSkipped,
      firstSeq: turns.length ? turns[0].seq : null,
      lastSeq: turns.length ? turns[turns.length - 1].seq : null,
      sourceEventSeqs: turns.map((t) => t.seq),
    },
  };
}

/**
 * 学习信号模式表。R2 对抗评审修正了两个实证缺陷，纪律固化在这里：
 *
 * 1) **CJK 绝不能用 `\b`**。`\b` 基于 ASCII 的 `\w`（[A-Za-z0-9_]），中文字符不是词字符，
 *    纯中文文本里永远构不成词边界 ⇒ `\b报错\b` 在"这里报错了"里**永不匹配**。
 *    R1 的原实现把中英文混在同一条 `\b(...)\b` 里，导致中文分支 100% 失效
 *    （实测：报错/失败/崩溃/已修复/测试通过 全部 signals=[]）。因此拉丁词与 CJK 词
 *    **分成两个字段**：latin 保留 `\b`，cjk 不加边界。
 *
 * 2) **数组顺序 = 语义优先级（resolution > correction > failure）**，不是"谁写在前面谁赢"。
 *    R1 用 `break` 取首个命中，而 failure 恰好排在首位 ⇒ "fixed the error"、"resolved the
 *    failure" 这类**已经解决**的发言被判成 failure（语义反转）。现在取**最强**语义。
 *
 * 仍然只是启发式：本函数只决定"是否值得生成一条待人工审批的候选"，
 * 绝不构成激活，也绝不因误判改变任何行为（误报代价 = 一条被驳回的提案）。
 */
export const SIGNAL_PATTERNS = Object.freeze([
  // resolution 最强：出现"已修复/已解决"时，同一轮里的 error 字样通常是在描述被修掉的东西
  {
    kind: 'resolution',
    latin: /\b(fixed|resolved|works now|passing|solved|green)\b/i,
    cjk: /(已修复|修复了|修复完成|解决了|已解决|测试通过|全部通过|通过测试|跑通|搞定|成功)/,
  },
  {
    kind: 'correction',
    latin: /\b(instead|rather than|should be|actually|correction|corrected)\b/i,
    cjk: /(改为|应该|纠正|更正|不是.{0,12}而是)/,
  },
  // failure 最弱：只在没有更强语义时才算失败
  {
    kind: 'failure',
    latin: /\b(error|failed|failure|exception|crash|rejected|broken)\b/i,
    cjk: /(报错|失败|崩溃|错误|异常|超时|无法|不能|挂了|坏了)/,
  },
]);

/**
 * 判定摘要中是否存在可学习的信号（失败/纠正/解决模式）。纯启发式、确定性。
 *
 * @returns {{hasSignal:boolean, signals:Array<{kind:string,seq:number,role:string}>,
 *            resolved:boolean, unresolvedFailureSeqs:number[], kinds:string[]}}
 *   - signals：每条发言最多一个 kind（取最强语义），按 seq 升序；
 *   - resolved：存在 failure 且其**之后**出现 resolution ⇒ true（失败-解决配对）；
 *   - unresolvedFailureSeqs：没有被后续 resolution 覆盖的 failure seq（真正的"缺口"）。
 */
export function learningSignals(digest) {
  if (!isPlainObject(digest) || !Array.isArray(digest.turns)) {
    return { hasSignal: false, signals: [], resolved: false, unresolvedFailureSeqs: [], kinds: [] };
  }
  const signals = [];
  for (const t of digest.turns) {
    const text = typeof t.text === 'string' ? t.text : '';
    for (const p of SIGNAL_PATTERNS) {          // 已按语义强度排序 → 首个命中即最强
      if (p.latin.test(text) || p.cjk.test(text)) {
        signals.push({ kind: p.kind, seq: t.seq, role: t.role });
        break;
      }
    }
  }
  // 稳定按 seq 升序（与调用方传入的 turns 顺序解耦）
  signals.sort((a, b) => (a.seq - b.seq) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  // 失败-解决配对：只看 seq 更晚的 resolution（一次 resolution 覆盖它之前的全部 failure）
  const failureSeqs = signals.filter((s) => s.kind === 'failure').map((s) => s.seq);
  const resolutionSeqs = signals.filter((s) => s.kind === 'resolution').map((s) => s.seq);
  const lastResolution = resolutionSeqs.length ? resolutionSeqs[resolutionSeqs.length - 1] : null;
  const unresolvedFailureSeqs = failureSeqs.filter((q) => lastResolution === null || q > lastResolution);

  return {
    hasSignal: signals.length > 0,
    signals,
    resolved: failureSeqs.length > 0 && unresolvedFailureSeqs.length === 0,
    unresolvedFailureSeqs,
    kinds: [...new Set(signals.map((s) => s.kind))].sort(),
  };
}
