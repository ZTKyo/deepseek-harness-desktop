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

import { createHash } from 'node:crypto';
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
export const LEARN_SCHEMA_VERSION = 2;
/**
 * Layer B（跨会话共享「已验证经验」库）schema 版本。
 * 与 Layer A（会话本地库）**独立演进**：迁移其中一方不影响另一方。
 */
export const GLOBAL_STORE_SCHEMA_VERSION = 1;
/** 全局已验证库条目上限（有界，绝不无限增长）。 */
export const MAX_GLOBAL_EXPERIENCES = 500;
/** 单条经验序列化后的最大体积（字节）——防止"整段聊天 / 全量日志 / 巨大 tool output"混入。 */
export const MAX_EXPERIENCE_JSON_BYTES = 16000;
/** 单条验证证据序列化后的最大体积（字节）。 */
export const MAX_EVIDENCE_JSON_BYTES = 4000;

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

// ── F2（R2 外部评审）：`sessionStoreMaxFiles` 的**下限**必须是一次真实的 config validation ──
//
// 根因（R2 独立评审实测）：`LEARN_SESSION_STORE_MAX_FILES` 的下限曾被写成 `1`，于是
// `=63` 被**静默接受**。但磁盘上限 < 64 时它本来就不是硬约束——活跃会话受设计保护
// （"active 全保留"），而活跃集本身有 LRU 上限 `MAX_IN_MEMORY_SESSIONS = 64`，
// 故 limit < 64 的真实占用是 `max(limit, 活跃数)`，永远达不到请求的那个数字。
// 静默接受一个**不可能被兑现**的配置值，等于给运维一个假承诺（"我配了 63，最多 63 个文件"），
// 因此这里把它判为 **config validation failure**（而不是悄悄钳制）。
//
// 取值依据：`64` 不是新造的数字，而是本插件既有的 per-session 内存口径
// （`learn.mjs` §B2 的 `MAX_IN_MEMORY_SESSIONS = 64`，§15 亦以 `MAX_TRACKED_SESSIONS`
// 复用同一数字）。磁盘上限低于该口径时两个口径互相矛盾，故以它为**最小受支持值**。
export const MIN_SESSION_STORE_MAX_FILES = 64;
/**
 * 诊断文本的**规范片段**：判定"这是一次真实的配置校验失败而非静默钳制"时，
 * 逐字比对的锚点。改动它等于改变对外可取证承诺，必须同步更新测试与报告。
 */
export const SESSION_STORE_MAX_FILES_MIN_DIAGNOSTIC =
  `minimum supported sessionStoreMaxFiles is ${MIN_SESSION_STORE_MAX_FILES}`;

/**
 * 校验一个 `sessionStoreMaxFiles` 取值（纯函数，无副作用，供 config 载入层与测试共用）。
 *
 * 返回（与仓库既有结构化返回同一风格）：
 *   合法 → `{ ok: true,  value, reason: null, diagnostic: null }`
 *   非法 → `{ ok: false, value: null, reason: '<稳定错误码>', diagnostic: '<可取证诊断文本>' }`
 *
 * `reason` 是稳定错误码（可被断言）；`diagnostic` 是人类可读文本，**必然包含**
 * `SESSION_STORE_MAX_FILES_MIN_DIAGNOSTIC`（= `minimum supported sessionStoreMaxFiles is 64`）。
 */
export function validateSessionStoreMaxFiles(raw) {
  const n = Number(raw);
  if (typeof raw === 'boolean' || raw === null || !Number.isInteger(n)) {
    return {
      ok: false,
      value: null,
      reason: 'session_store_max_files_not_an_integer',
      diagnostic: `config validation failure: sessionStoreMaxFiles=${JSON.stringify(raw ?? null)} is not an integer; `
        + `${SESSION_STORE_MAX_FILES_MIN_DIAGNOSTIC} (requested value rejected, not silently clamped)`,
    };
  }
  if (n < MIN_SESSION_STORE_MAX_FILES) {
    return {
      ok: false,
      value: null,
      reason: 'session_store_max_files_below_minimum',
      diagnostic: `config validation failure: sessionStoreMaxFiles=${n} is not supported; `
        + `${SESSION_STORE_MAX_FILES_MIN_DIAGNOSTIC} (requested value rejected, not silently clamped)`,
    };
  }
  return { ok: true, value: n, reason: null, diagnostic: null };
}

/**
 * 经验生命周期状态。
 *
 * 合同【实现原则 3】：经验必须经**真实成功验证**后才能标记 VERIFIED_EXPERIENCE。
 * 因此本状态机把"被验证"做成**独立可达状态**，而**不是**审批的同义词：
 *   PROPOSED ──(确定性验证 PASS)──▶ VERIFIED_EXPERIENCE ──(人工审批)──▶ APPROVED ──▶ RETIRED
 *      └──────(人工审批，未经验证)──▶ APPROVED（仍然合法，但**不可发布到跨会话全局库**）
 *
 * 核心不变量：HUMAN APPROVAL ≠ DETERMINISTIC VERIFICATION。
 * 两者是两条**独立**通道：审批决定"人是否同意"，验证决定"机器能否复算成功"。
 * 没有真实 success evidence ⇒ verification.status 永远不可能是 VERIFIED（fail-closed）。
 */
export const EXPERIENCE_STATES = ['PROPOSED', 'VERIFIED_EXPERIENCE', 'APPROVED', 'REJECTED', 'RETIRED'];
/** 状态迁移白名单：任何未列出的迁移一律拒绝（fail-closed）。 */
export const ALLOWED_TRANSITIONS = {
  PROPOSED: ['VERIFIED_EXPERIENCE', 'APPROVED', 'REJECTED'],
  // 自迁移 VERIFIED_EXPERIENCE → VERIFIED_EXPERIENCE 即"复用后重新验证"：
  // 合同【复用规则】第 5 步要求复用必须重新验证，重新验证本身**必须可表达**。
  VERIFIED_EXPERIENCE: ['VERIFIED_EXPERIENCE', 'APPROVED', 'RETIRED'],
  // 已批准经验在复用后重新验证，同样是合法迁移（验证与审批是两条独立通道）。
  APPROVED: ['VERIFIED_EXPERIENCE', 'RETIRED'],
  REJECTED: [],   // 终态：不得复活（复活必须重新 propose，留下新痕迹）
  RETIRED: [],    // 终态
};
/** 晋升资格判定。注意：ELIGIBLE ≠ PROMOTED —— 晋升永远需要显式调用，绝无自动晋升。 */
export const PROMOTION_STATES = ['NONE', 'ELIGIBLE', 'PROMOTED', 'BLOCKED'];

/** 遥测事件类型（可观测性契约）。 */
export const TELEMETRY_KINDS = [
  // ── Experience 面（R1/R2 既有，顺序与含义不得改动）──
  'PROPOSED', 'APPROVED', 'REJECTED', 'RECALLED', 'PROMOTION_BLOCKED', 'PROMOTION_ELIGIBLE',
  'STORE_REBUILT', 'WRITE_DENIED', 'GAP_VETOED',
  // ── Candidate 面（R2 STAGE 6-7 新增；与 Experience 共用本遥测权威，禁第二套）──
  'CANDIDATE_PROPOSED',        // 由**合格 gap**建立候选
  'CANDIDATE_STAGE',           // 候选在生命周期中前进一个阶段
  'CANDIDATE_REJECTED',        // 候选被拒（保留最小失败记录）
  'CANDIDATE_PROMOTED',        // 候选走完全部阶段且获人工批准后晋升
  'STABLE_OVERWRITE_DENIED',   // AC7：试图直接覆盖 Stable 被拒
  'RESEARCH_BOUNDED_EXHAUSTED',// AC2/AC8：自主研究达到有界上限（禁无限重试）
  // ── 能力缺口面（R2 STAGE 8.5 新增；**追加**到同一遥测权威，不新建第二套）──
  'CAPABILITY_GAP_OBSERVED',   // 观察到未解决的**能力**失败，但尚未达到重复阈值（无候选）
  'CAPABILITY_GAP_QUALIFIED',  // 未解决能力失败重复达到阈值 ⇒ 合格缺口 ⇒ 建立候选
  'CAPABILITY_GAP_VETOED',     // R2 STAGE 2：能力失败被**码级否决**（网络/凭据/瞬态/调用方误用/无码）
                               // ⇒ 明确不建立候选。**必须留痕**：否则码级否决一旦误杀真实缺口，
                               //    外界只会看到"什么都没发生"——即本阶段要消灭的**静默死路径**。
  'CAPABILITY_GAP_RESOLVED',   // 先前观测到的缺口被**成功解决**（或不再重复）⇒ 撤销，不留悬空证据
  // ── 验证 / 适用性 / 跨会话全局库面（P4 R2 CONTRACT COMPLETION 新增）──
  // 追加到**同一**遥测权威，不新建第二套。顺序与含义一经确定不得改动。
  'VERIFIED',                  // 经验通过**确定性验证**（机器可校验证据）⇒ verification.status=VERIFIED
  'VERIFICATION_FAILED',       // 验证未通过（含"无真实成功证据"）⇒ 永不标记 VERIFIED_EXPERIENCE
  'REVALIDATED',               // 合同【复用规则】第 5 步：复用后**重新验证**通过
  'REVALIDATION_REQUIRED',     // 复用后重新验证失败 ⇒ 必须重新验证，禁止继续无条件优先召回
  'APPLICABILITY_BLOCKED',     // 适用性检查判定不可直接复用（STALE / INCOMPATIBLE / 未验证）
  'GLOBAL_PUBLISHED',          // 已验证经验发布到**跨会话全局库**
  'GLOBAL_PUBLISH_DENIED',     // 未验证 / 未批准 / 超界 / 含密钥 ⇒ 拒绝发布（留痕，不留静默死路径）
  'GLOBAL_REJECTED',           // 载入时发现全局库畸形或被伪造 ⇒ fail-closed 整体拒绝
  'GLOBAL_RECALLED',           // 从**跨会话**全局库真实召回（区别于同会话召回）
  // ── F1 人类批准边界面（P4 R2 F1 修复新增；**追加**到同一遥测权威，不新建第二套）──
  'HUMAN_APPROVAL_REQUESTED',  // 已向**宿主人类批准通道**发起一次批准请求（留痕，可审计）
  'HUMAN_APPROVAL_GRANTED',    // 宿主通道返回"人类已批准"且宿主日志事实成立 ⇒ 才可能 mint APPROVED
  'HUMAN_APPROVAL_DENIED',     // 通道拒绝/取消/不可用，或**无宿主事实**（自述审批）⇒ 绝不 mint APPROVED
  'HUMAN_APPROVAL_UNAVAILABLE',// 部署中不存在宿主批准通道（ctx.get('approval') 缺席）⇒ fail-closed 拒绝
  'APPROVAL_EXPIRED',          // 持久化审批的进程内签章不可验证（跨进程重启）⇒ 需人类重新批准
];

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
//    secret-scan-check.mjs 保持一致，并由 tests/learn/test-learn-r3-secrets.mjs
//    做覆盖平价校验（§A 家族名平价 + §B~§H 通用形态与真实落盘脱敏）。
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
  // 通用形态 1：URI userinfo（DB / broker / 服务的连接串）
  //   PRE-MERGE R-3：此前完全缺失。口令内的 "@" 与 userinfo/host 分隔符的 "@" 同形，
  //   故从 "://" 之后**贪婪**取到 authority 内最后一个 "@"（authority 不含 "/"），
  //   这样 postgres://user:s3cr3tP@ss@host 会整段命中，而不是只截到第一个 "@" 把 "ss@host" 泄漏出去。
  //   用 lookbehind 不消费 scheme、lookahead 不消费 "@"，因此输出形如
  //   postgres://[REDACTED:uri-credential]@host/db —— scheme、@ 分隔符与 host 全部保留，便于诊断。
  { name: 'uri-credential', re: /(?<=:\/\/)[^\s/?#]+(?=@)/g },
  // 通用形态 2：显式凭据赋值 与 Bearer/Authorization 头
  //   PRE-MERGE R-3：原值字符集为 [A-Za-z0-9_\-./+]{12,}（纯字母数字），遇到
  //   ! @ # $ % ^ & * ( ) 等常见口令符号即断 → 含符号的口令整体漏脱敏。
  //   现按**分隔符**取值：引号内取到闭合引号，无引号取到空白/分号/逗号/引号为止。
  //   仍要求 keyword 后紧跟 [:]=（不允许插入其他词），故 "token count = 5"、
  //   "the password field is required" 这类普通说明文本不会被误脱敏。
  //   另外补 api_token（此前因 \btoken\b 在 "api_token" 中无词边界而漏掉）。
  { name: 'generic-assignment', re: /\b(?:api[_-]?key|apikey|api[_-]?token|secret|password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*(?:"[^"\r\n]{4,}"|'[^'\r\n]{4,}'|[^\s;,'"]{8,})/gi },
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
  // R3：数量也必须受限（此前只限单个 tag 长度，未限个数 → 可持久化无界 tags）。
  // 先排序再截断 ⇒ 保留哪 MAX_TAGS 个是确定的（幂等、顺序无关）。
  return [...set].sort().slice(0, MAX_TAGS);
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
      // ── 合同【Experience Store】逐字字段清单 ──────────────────────────────
      // 合同要求"每条经验**只保留**（即必须包含）的字段清单"。这些键**必须默认存在**
      // （哪怕值为 null/空数组）——字段"可空"≠字段"不存在"，缺键即合同不达标。
      // 定义收敛在 contractFieldsFromDraft() 一处：本函数与 v1 迁移**共用同一份**，
      // 杜绝"两处字段表各自漂移"（那正是本轮合同缺口的成因之一）。
      ...contractFieldsFromDraft(draft),
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
    // ★ F1：APPROVED 还必须携带**宿主事实 attestation**（结构 + 对象绑定）。
    // 无 attestation 的 APPROVED（= R1/R2 历史的"自述审批"、或手写文件伪造的审批痕迹）
    // 在此**结构性判废** ⇒ 载入边界即失效，绝不进入召回/发布路径。
    const prov = approvalProvenance(raw);
    if (!prov.ok) return { error: `approved_without_host_attestation:${prov.reason}` };
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
  // ── 合同字段（新增）────────────────────────────────────────────────────────
  // 缺席合法（兼容 R1/R2 旧记录与迁移前形态），但**一旦出现**就必须结构合法
  // （fail-closed：不部分信任、不放行畸形结构）。
  const cfErr = validateContractFields(raw);
  if (cfErr) return { error: cfErr };
  const ver = raw.verification;
  // 不变量（合同【实现原则 3】）：声称 VERIFIED 必须具备**可机器校验**的方法 + 证据 + 时间戳。
  // 没有真实 success evidence ⇒ 结构上就不可能被判定为 VERIFIED。
  if (isPlainObject(ver) && ver.status === 'VERIFIED') {
    if (!VERIFICATION_METHODS.includes(ver.method)) return { error: 'verified_without_machine_checkable_method' };
    if (!isPlainObject(ver.evidence)) return { error: 'verified_without_evidence' };
    if (!Number.isSafeInteger(ver.verifiedAt) || ver.verifiedAt <= 0) return { error: 'verified_without_timestamp' };
    if (!Number.isSafeInteger(raw.lastVerifiedAt) || raw.lastVerifiedAt <= 0) return { error: 'verified_without_last_verified_at' };
  }
  // 不变量：state=VERIFIED_EXPERIENCE 必须**确实经过**确定性验证。
  // 注意语义分工：state 记录"曾经通过验证"（历史事实），verification.status 记录"当前是否仍然有效"。
  // 复用后重新验证失败会把 status 降为 REVALIDATION_REQUIRED，而 state 保持 VERIFIED_EXPERIENCE
  // （历史不可篡改）——此时它**不再可发布**（canPublish 要求 status=VERIFIED）、
  // 跨会话适用性检查也返回 REVALIDATION_REQUIRED，因此不会被无条件优先复用。
  if (raw.state === 'VERIFIED_EXPERIENCE' &&
    (!isPlainObject(ver) || !['VERIFIED', 'REVALIDATION_REQUIRED'].includes(ver.status))) {
    return { error: 'verified_state_without_verification' };
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
/** 稳定排序比较器：createdAt 升序 → id 升序（完全确定性，与输入顺序无关）。 */
const byCreatedThenId = (a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function withExperience(store, exp) {
  const next = store.experiences.filter((e) => e.id !== exp.id);
  next.push(exp);
  // 稳定排序：按 createdAt 升序、id 升序 → 确定性
  next.sort(byCreatedThenId);
  let kept = next.slice(-MAX_EXPERIENCES);
  // R-6：容量淘汰必须「保留刚写入的这条」。当 exp.createdAt 为 0（调用方未传时间戳）时它会排到
  // 最前，被 slice(-N) 直接裁掉 → 新提案"写成功但库里没有"，属静默数据丢失。此处改为淘汰最旧的
  // 一条给它腾位，保证任何返回 ok:true 的写入都一定存在于返回的 store 中，绝不静默丢失。
  if (kept.length >= MAX_EXPERIENCES && !kept.some((e) => e.id === exp.id)) {
    kept = next.slice(-(MAX_EXPERIENCES - 1)).concat(exp).sort(byCreatedThenId);
  }
  return { ...store, experiences: kept };
}

/**
 * 提案一条经验。已存在同 id → 幂等返回原条目（不复活 REJECTED）。
 * 注意：本函数永远不产生 APPROVED 状态。
 */
export function propose(store, draft) {
  // R3：畸形 store 必须返回结构化错误（此前直接读 store.experiences 抛 TypeError）
  if (!isPlainObject(store) || !Array.isArray(store.experiences)) {
    return { ok: false, error: 'invalid_store' };
  }
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
 * R-5：畸形 store 的统一前置校验。
 * 此前只有 propose/recall 做了结构化返回，approve/reject/retire 直接读
 * store.experiences → 畸形入参抛 TypeError 而非结构化错误（R3 加固只做了 6 个
 * 函数中的 3 个）。此处收敛为单一助手，三个函数共用，避免再次漏做。
 * 返回 { exp } 或 { error }（error 可直接作为函数返回值）。
 */
function findExperience(store, id) {
  if (!isPlainObject(store) || !Array.isArray(store.experiences)) {
    return { error: { ok: false, error: 'invalid_store' } };
  }
  const exp = store.experiences.find((e) => e.id === id);
  if (!exp) return { error: { ok: false, error: 'experience_not_found' } };
  return { exp };
}

/**
 * 审批证据的前置校验（**唯一口径**：`approve()` 与工具层共用，避免出现两套会漂移的规则）。
 * 目的：不合格的批准请求（缺证据 / 证据含密钥）**在请求人类之前**就被拒绝，
 * 不制造无意义的中断（人类不会被叫起来点一个注定失败的批准）。
 */
export function validateApprovalEvidence(evidence) {
  const note = cleanStr(evidence, MAX_EVIDENCE_LEN);
  if (!note) return { ok: false, error: 'approval_requires_evidence' };
  if (containsSecret(evidence)) return { ok: false, error: 'approval_evidence_contains_secret' };
  return { ok: true, note };
}

/**
 * 人工审批：PROPOSED → APPROVED。
 *
 * ★ F1：授权来源**只能**是宿主人类批准通道产生的事实（见 §22-bis）。
 * 调用方必须传入 `opts.session`（官方会话日志载体，含 events）+ `opts.approvalRef`
 * （宿主 `approval/asked` 的事件 id）。**自述字段（approver/evidence）不再具有授权力**：
 * 它们只作为人类可读备注保存，`approvedBy` 一律写为固定的宿主标签。
 * 缺少宿主事实 ⇒ 返回 `approval_not_host_proven:*`，绝不"降级为自述审批"。
 */
export function approve(store, id, opts = {}) {
  const found = findExperience(store, id);
  if (found.error) return found.error;
  const exp = found.exp;
  const ev = validateApprovalEvidence(opts.evidence);
  if (!ev.ok) return { ok: false, error: ev.error };
  const note = ev.note;
  // ★ F1：授权是"人类在宿主通道上真实发生过的决定 + 它落进了持久审批台账"，因此需要可解释的前置判定：
  //   · 已经有 live 授权（台账里存在已消费的 grant）⇒ 幂等拒绝（不重复消费宿主事实）；
  //   · 已是 APPROVED 但 live 授权已失效（例如台账缺失/换机/被撤销）⇒ 允许**重新批准**：
  //     内容摘要必须仍与当初被批准的一致（approvalProvenance 通过），
  //     再由一次**新的**宿主人类批准事实重新落账并消费。
  //     这条路径是必需的：否则经验会卡在"不可召回、不可发布、也不可再批准"的死角，
  //     插件只能提示"需要人类重新批准"，却没有任何通道能做到。
  //   · 其余状态沿用状态机白名单。
  const ledger = opts.ledger && typeof opts.ledger.append === 'function'
    ? opts.ledger
    : (APPROVAL_LEDGERS.length > 0 ? APPROVAL_LEDGERS[APPROVAL_LEDGERS.length - 1] : null);
  if (!ledger) return { ok: false, error: 'approval_ledger_unavailable' };   // fail-closed：没有台账就没有授权载体
  const liveNow = validHumanApproval(exp, ledger);
  if (liveNow.ok) return { ok: false, error: 'already_human_approved' };
  if (exp.state === 'APPROVED') {
    const prov = approvalProvenance(exp);
    if (!prov.ok) return { ok: false, error: `approval_not_host_proven:${prov.reason}` };
  } else if (!canTransition(exp.state, 'APPROVED')) {
    return { ok: false, error: `illegal_transition:${exp.state}->APPROVED` };
  }
  // ★ F1：先铸造宿主 attestation（内部即完成宿主日志事实校验 + 内容绑定 + 台账落账/单次消费）
  const minted = mintHumanApproval(exp, {
    session: opts.session,
    approvalRef: opts.approvalRef,
    at: opts.at,
    ledger,
  });
  if (!minted.ok) return { ok: false, error: minted.error };
  const att = minted.value;
  const updated = {
    ...exp,
    state: 'APPROVED',
    approvedAt: att.approvedAt,
    approvedBy: HUMAN_APPROVAL_ACTOR,   // 固定宿主标签：不接受调用方自由文本
    approvalEvidence: note,
    approval: att,                      // 宿主事实 attestation（唯一授权凭据）
  };
  const checked = sanitizeExperience(updated);
  if (checked.error) return { ok: false, error: checked.error };
  // 自检：刚铸造的凭据必须能通过 live authority（防止铸造与校验口径漂移）
  const live = validHumanApproval(updated, ledger);
  if (!live.ok) return { ok: false, error: `approval_attestation_selfcheck_failed:${live.reason}` };
  return { ok: true, value: withExperience(store, updated), experience: updated };
}

/** 人工驳回：PROPOSED → REJECTED（终态，不得复活）。 */
export function reject(store, id, opts = {}) {
  const found = findExperience(store, id);
  if (found.error) return found.error;
  const exp = found.exp;
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
  const found = findExperience(store, id);
  if (found.error) return found.error;
  const exp = found.exp;
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

/**
 * 单条经验是否可被**召回**（= 检索面，不等于"可直接复用"）。
 *   · APPROVED            —— 人工激活
 *   · VERIFIED_EXPERIENCE —— 机器验证通过（合同【实现原则 3】的独立通道）
 * 提案（PROPOSED）与被驳回/退役的一律不可召回（提案 ≠ 激活）。
 *
 * 注意：跨会话全局库**只包含**「已人工批准 + 已确定性验证 + 审批来源完整」的条目
 * （见 isPublishable / validateGlobalStore），因此"全局可召回"**必然蕴含**"人工审批过"。
 * 单凭 VERIFIED（本会话机器验证）**不足以**跨会话——它只在本会话 Layer A 内可召回。
 */
export function isRecallable(exp, ledger) {
  if (!isPlainObject(exp)) return false;
  // ★ F1：APPROVED 的召回资格**必须**由 live authority 判定（持久结构 + 对象绑定 + 持久台账 grant）。
  // 手写文件伪造的审批痕迹、或台账里查不到的批准 ⇒ 不可召回（fail-closed）。
  if (exp.state === 'APPROVED') return validHumanApproval(exp, ledger).ok;
  return exp.state === 'VERIFIED_EXPERIENCE';
}

/**
 * 从经验库确定性召回 —— 同会话（Layer A）+ 可选跨会话全局已验证库（Layer B）。
 *
 * 规则：
 *   - 候选集 = 本会话中 isRecallable 的条目；若显式传入 opts.global，则并入全局库中
 *     isRecallable 且本会话不存在的条目（跨会话复用）。
 *   - **跨会话条目必须先过适用性检查**（合同【实现原则 5】/【复用规则】）：
 *     不适用（STALE / INCOMPATIBLE / 未验证）⇒ 不进入可复用结果，落入 `blocked` 留痕。
 *   - 打分 = 查询词与（标题+正文+标签）词集的命中数 / 查询词数（0..1，可解释）；
 *   - 排序 = 分数降序 → 同会话优先 → id 升序（全序，保证同一输入永远同一输出）；
 *   - score 为 0 的条目不入结果（避免噪声召回）。
 *
 * @returns {{ok:boolean, items:Array, considered:number, excluded:number, blocked?:Array}}
 */
export function recall(store, query, opts = {}) {
  // R3：畸形 store 必须返回结构化错误（此前直接读 store.experiences 抛 TypeError）
  if (!isPlainObject(store) || !Array.isArray(store.experiences)) {
    return { ok: false, error: 'invalid_store', items: [], considered: 0, excluded: 0 };
  }
  const limit = Number.isInteger(opts.limit) && opts.limit > 0
    ? Math.min(opts.limit, MAX_RECALL_LIMIT)
    : 5;
  const qText = typeof query === 'string' ? query : (isPlainObject(query) ? query.text : '');
  const qTokens = tokenize(qText);
  const qTags = normalizeTags(isPlainObject(query) ? query.tags : []);
  const ledger = opts.ledger && typeof opts.ledger.records === 'function' ? opts.ledger : undefined;
  const approved = store.experiences.filter((e) => isRecallable(e, ledger));
  const excluded = store.experiences.length - approved.length;
  // Layer B：跨会话全局已验证库（只在显式传入时参与 ⇒ 不传时行为与 R2 完全一致）
  const globalExps = isPlainObject(opts.global) && Array.isArray(opts.global.experiences)
    ? opts.global.experiences : [];
  const localIds = new Set(approved.map((e) => e.id));
  const fromGlobal = globalExps.filter((e) => isRecallable(e, ledger)).filter((e) => !localIds.has(e.id));
  if (qTokens.length === 0 && qTags.length === 0) {
    return {
      ok: true, items: [], considered: approved.length + fromGlobal.length, excluded,
      reason: 'empty_query', blocked: [],
    };
  }
  const now = Number.isSafeInteger(opts.now) && opts.now > 0 ? opts.now : 0;
  const env = isPlainObject(opts.env) ? opts.env : null;
  const blocked = [];
  const scored = [];
  const consider = (exp, scope) => {
    let applicability = null;
    if (scope === 'global') {
      // 合同【复用规则】：跨会话召回**必须**先检查适用性，绝不盲用。
      applicability = isApplicableNow(exp, env, { now });
      if (applicability.status !== 'APPLICABLE') {
        blocked.push({ id: exp.id, scope, applicability });
        return;
      }
    }
    const hay = new Set([...tokenize(exp.title), ...tokenize(exp.body), ...exp.tags]);
    let hits = 0;
    for (const t of qTokens) if (hay.has(t)) hits += 1;
    let score = qTokens.length > 0 ? hits / qTokens.length : 0;
    if (qTags.length > 0) {
      const tagHits = qTags.filter((t) => exp.tags.includes(t)).length;
      score += tagHits / qTags.length;   // 标签命中加权
    }
    if (score > 0) scored.push({ exp, score, scope, applicability });
  };
  for (const e of approved) consider(e, 'session');
  for (const e of fromGlobal) consider(e, 'global');
  scored.sort((a, b) => (b.score - a.score)
    || (a.scope === b.scope ? 0 : a.scope === 'session' ? -1 : 1)
    || (a.exp.id < b.exp.id ? -1 : a.exp.id > b.exp.id ? 1 : 0));
  const items = scored.slice(0, limit).map(({ exp, score, scope, applicability }) => ({
    id: exp.id,
    title: exp.title,
    body: exp.body,
    tags: exp.tags,
    score: Math.round(score * 1000) / 1000,
    scope,   // 'session' = 本会话；'global' = 跨会话复用（Layer B）
    // 回源锚点：召回结果永远可回溯到原始会话（Official Session 是唯一 Truth Source）
    sourceEventSeqs: exp.sourceEventSeqs.slice(),
    originSessionId: exp.originSessionId,
    approvedBy: exp.approvedBy,
    // ── 合同【复用规则】要求召回结果自带"适用性"与"重新验证"信息 ──
    taskType: exp.taskType ?? null,
    applicableVersions: exp.applicableVersions ?? null,
    applicableEnvironment: exp.applicableEnvironment ?? null,
    staleConditions: exp.staleConditions ?? null,
    expiresAt: exp.expiresAt ?? null,
    lastVerifiedAt: exp.lastVerifiedAt ?? null,
    verificationStatus: isPlainObject(exp.verification) ? exp.verification.status : 'UNVERIFIED',
    verificationMethod: isPlainObject(exp.verification) ? exp.verification.method : null,
    successRate: exp.successRate ?? null,
    reuseCount: Number.isInteger(exp.reuseCount) ? exp.reuseCount : 0,
    // 复用执行面（§10/§11：复用方法 + 失败时如何回退）
    successfulMethod: exp.successfulMethod ?? null,
    failedOrUnsafeMethods: Array.isArray(exp.failedOrUnsafeMethods) ? exp.failedOrUnsafeMethods.slice() : [],
    rollback: exp.rollback ?? null,
    applicability,
  }));
  return { ok: true, items, considered: approved.length + fromGlobal.length, excluded, blocked };
}

/** 记录一次召回（更新命中条目的召回统计）。 */
export function recordRecall(store, ids, at) {
  // R3：畸形 store 安全返回（此前 store.experiences.map 抛 TypeError）
  if (!isPlainObject(store) || !Array.isArray(store.experiences)) return store;
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
/**
 * 未闭合的注入块（截断日志）：从标记处一直切到结尾。
 *
 * R3 对抗评审修正：R2 原实现是 `/<system-reminder>[\s\S]*$/i`（任意位置命中即吞到结尾），
 * 实测会**吞掉真人发言**：用户只是**讨论/引用**这个标签时（"我注意到日志里有
 * <system-reminder> 这个标签，它后面的报错都没被记录"），81% 的文本被删掉。
 *
 * 收紧为"标签独占一行"（标签后只允许空白再换行）——这是真注入块的排版形态。
 * 实证（两个真实会话、官方提取器口径、2174 次出现）：
 *   - 真注入 720 次 = 行首 **且** 标签独占一行（两者 100% 重合，lsOnly=0/aloneOnly=0）
 *   - 引用/讨论 1454 次 = 行中 **且** 标签后紧跟行内文字（neither=1454）
 * 普通工作会话 21/21 真实注入全部保留；引用文本不再被吞。
 */
export const INJECTED_OPEN_RE = /^[ \t]*<system-reminder>[ \t]*\r?\n[\s\S]*$/im;

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

// ─────────────────────────────────────────────────────────────────────────────
// R2 STAGE 8.5 — 工具失败的**结构化**事实抽取
//
// 背景（AC5 语义偏差的根因）：
//   P4 此前唯一的失败来源是 `agent/request-error`，其签名是
//     {agent, turn, step, provider, failure: LlmFailure, retryPolicy, signal}
//   —— 它是 **LLM 请求**错误，本质属 provider 域，P2.6 的 9 个分类全部落在
//   "环境/供应商/网络"（重试、配额、凭据、路由、上下文），**没有任何一类**
//   对应合同要求的 Tool / Skill / Model 能力维度。结果：真实能力缺口永远
//   无法被表达，而 fake gap 被无差别否决 —— 两者都被同一把闸门压死。
//
// 工具失败走的是**另一条**官方事件流，且带完整结构化事实，无需任何关键词：
//   tool/call.data    = { turn, step, callId, name, arguments }
//   tool/result.data  = { turn, step,
//                         message: { source: {kind:'tool', callId},
//                                    content: [{type:'tool-result', toolCallId, content, isError}] },
//                         error?: { name, code }, meta? }
//
// AC1 纪律：与 buildLearnDigest 消费**同一个** events 数组，且同样以**官方
//   surface.nodes 为规范节点集**——不复用第二套 canonicalization。
//   （tool/call 名表在整份事件流上建立，因为它在正式语义里每次调用只追加一次；
//     tool/result 事实**只**取自 canonical 节点，否则 compaction-pruner 追加的
//     影子替换事件会让同一次失败被重复计数、污染重复阈值。）
// ─────────────────────────────────────────────────────────────────────────────

/** 结构化抽取的硬上限（§15 有界性：绝不随会话长度无界增长）。 */
export const MAX_TOOL_FACTS = 256;

/**
 * 从原始事件流抽取工具调用结果的结构化事实。纯函数、零关键词、确定性（按 seq 升序）。
 *
 * @param {Array} events          session.events（官方原始事件数组，按 seq 索引）
 * @param {Array<number>} nodeSeqs session.surface.nodes（官方规范节点 seq 列表）
 *   ⚠ nodeSeqs **只用于确定观察上界**（= 当前 surface 覆盖到的事件范围），
 *     **不是**被扫描的集合本身。命中缺陷（2026-09-25 实测）：
 *     工具事件（tool/call、tool/result）**从不落在 surface 节点 seq 上**——节点只有
 *     user/message 与 assistant/message（真实会话 77 个 tool/result 与节点 seq 零交集）。
 *     首版实现直接遍历 nodeSeqs 找工具事件 ⇒ 生产恒零事实 ⇒ 能力缺口路径是死代码。
 *     因此观察面改为**事件范围 [0, maxNode]**：观察面=全会话（解决判定可回溯），
 *     触发面=调用方按水位决定（见 learn.mjs 的 hasFresh）。
 * @returns {{calls:Array, failures:Array, successes:Array}}
 *   failures[i] = {seq, callId, toolName, errorCode, errorName, isError:true,
 *                  capability:{toolName, errorCode, errorName, isError:true}}
 *   —— `capability` 直接可作 qualifyGap 的 `capability` 观测输入；
 *      来源域（tool / unknown）由 Capability-Gap Qualification Adapter 判定，
 *      本函数**不**替它下结论（toolName 缺失 ⇒ 适配器判 unknown ⇒ fail-closed 否决）。
 */
export function extractToolOutcomes(events, nodeSeqs) {
  const empty = { calls: [], failures: [], successes: [] };
  if (!Array.isArray(events) || !Array.isArray(nodeSeqs)) return empty;

  // ① tool/call 名表（callId → tool name），整份事件流，bounds 有界
  const names = new Map();
  for (let seq = 0; seq < events.length; seq++) {
    const ev = events[seq];
    if (!ev || ev.type !== 'tool/call') continue;
    const d = isPlainObject(ev.data) ? ev.data : null;
    if (!d) continue;
    const callId = typeof d.callId === 'string' ? d.callId : '';
    if (!callId || typeof d.name !== 'string' || !d.name) continue;
    if (names.size >= MAX_TOOL_FACTS && !names.has(callId)) continue;
    names.set(callId, d.name);
  }

  // ② 观察上界：当前 surface 覆盖到的事件范围（**不是**被扫描的集合）
  const canonical = [...new Set(Array.isArray(nodeSeqs) ? nodeSeqs : [])]
    .filter((q) => Number.isInteger(q) && q >= 0 && q < events.length)
    .sort((a, b) => a - b);
  const upper = canonical.length ? canonical[canonical.length - 1] : -1;

  const calls = [];
  const failures = [];
  const successes = [];

  // ③ 扫**事件范围**（工具事件不在节点 seq 上，故必须按 seq 连续区间扫描）
  for (let seq = 0; seq <= upper; seq++) {
    const ev = events[seq];
    if (!ev || typeof ev.type !== 'string') continue;
    const d = isPlainObject(ev.data) ? ev.data : null;
    if (!d) continue;

    if (ev.type === 'tool/call') {
      if (calls.length < MAX_TOOL_FACTS) {
        calls.push({
          seq,
          callId: typeof d.callId === 'string' ? d.callId : '',
          toolName: typeof d.name === 'string' ? d.name : '',
        });
      }
      continue;
    }
    if (ev.type !== 'tool/result') continue;

    const blocks = Array.isArray(d.message?.content) ? d.message.content : [];
    const block = blocks.find((b) => isPlainObject(b) && b.type === 'tool-result');
    if (!block) continue;
    // ★ 唯一失败判据：官方结构化布尔字段（不是关键词、不是文案）
    const isErr = block.isError === true;
    const callId = typeof d.message?.source?.callId === 'string' && d.message.source.callId
      ? d.message.source.callId
      : (typeof block.toolCallId === 'string' ? block.toolCallId : '');
    const toolName = names.get(callId) || '';
    if (!isErr) {
      if (successes.length < MAX_TOOL_FACTS) successes.push({ seq, callId, toolName });
      continue;
    }
    if (failures.length >= MAX_TOOL_FACTS) continue;
    const errorCode = typeof d.error?.code === 'string' ? d.error.code : '';
    const errorName = typeof d.error?.name === 'string' ? d.error.name : '';
    failures.push({
      seq, callId, toolName, errorCode, errorName, isError: true,
      capability: { toolName, errorCode, errorName, isError: true },
    });
  }

  return { calls, failures, successes };
}

/**
 * 计算**未解决**的工具失败：同一工具在更晚的 seq 上出现**成功**即视为已解决。
 *
 * 这是"deterministic verification"在本层的结构化实现——判据是官方的
 * `isError === false` 事实，不需要任何关键词或人工判断。
 * 已解决的失败**不是**能力缺口（说明我们有能力做到，只是当时没做到）。
 *
 * @param {{failures:Array, successes:Array}} outcomes - extractToolOutcomes 输出
 * @returns {Array} failures 的子集（按 seq 升序）
 */
export function unresolvedToolFailures(outcomes) {
  const fs = Array.isArray(outcomes?.failures) ? outcomes.failures : [];
  const ss = Array.isArray(outcomes?.successes) ? outcomes.successes : [];
  return fs.filter((f) => {
    if (!f || f.isError !== true) return false;
    const tool = typeof f.toolName === 'string' ? f.toolName : '';
    if (!tool) return false;  // 工具身份缺失 ⇒ 无从判定"同一能力"，保守排除
    return !ss.some((s) => s && s.seq > f.seq && s.toolName === tool);
  });
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
 * R3 对抗评审（真实会话 116 条信号人工核对，precision 20.7%）新增第 3 条纪律：
 *
 * 3) **否定必须显式排除**。R2 的词表是纯关键词，`没有报错` / `not broken` / `not fixed`
 *    全部被当成正向信号（实测 6/6 反向表述误判），而规范 §9 明确要求它们不能产生信号。
 *    这里加一层**有界的**否定作用域判定（见 isNegated）：只要求否定词**紧贴**关键词之前
 *    （中间只允许少量虚词），不引入句法分析，只覆盖"紧贴否定"这一最常见形态。
 *
 * 仍然只是启发式：本函数只决定"是否值得生成一条待人工审批的候选"，
 * 绝不构成激活，也绝不因误判改变任何行为（误报代价 = 一条被驳回的提案）。
 *
 * R3 已知边界（不修，如实记录）：假设句（"如果它报错就重试"）、文档/字段名描述
 * （"「failure」字段表示失败状态"）、引用块（"用户说'我这边报错了'，我怎么回？"）
 * 与真实陈述在**词形上不可区分**，纯关键词方案无法排除——需句法/语义层，超出最小修复范围。
 */
export const SIGNAL_PATTERNS = Object.freeze([
  // resolution 最强：出现"已修复/已解决"时，同一轮里的 error 字样通常是在描述被修掉的东西
  {
    kind: 'resolution',
    latin: /\b(fixed|resolved|works now|passing|solved|green)\b/i,
    cjk: /(已修复|修复了|修复完成|修好了|修好|解决了|已解决|测试通过|全部通过|通过测试|跑通|搞定|成功)/,
  },
  {
    kind: 'correction',
    latin: /\b(instead|rather than|should be|actually|correction|corrected)\b/i,
    cjk: /(改为|应该|纠正|更正|不是.{0,12}而是)/,
  },
  // ⛔ R2 AC5：此处**曾**有第三个 kind 'failure'（关键词表：error/failed/超时/报错/…）。
  //    它在 R2 被**整体删除**，原因有二，均为合同级硬约束：
  //      (1) 它是**第二套 Failure Authority** —— 合同 §四「强制复用条款」与任务书 §20
  //          明确禁止 P4 自建失败分类；P2.6 failure-classifier-core.mjs 是唯一 Authority。
  //      (2) 它**方向性错误**：实测双向失效 —— 真能力缺口漏检（"REAL capability gap"
  //          → hasSignal=false），环境故障误检（"网络请求超时，连接失败" → failure），
  //          导致 provider 502 / quota / DNS 故障照样被学成 Skill 缺陷。
  //    失败证据现在只能来自 P2.6 的分类结果（见 learningSignals 的 opts.classifiedFailures
  //    与 plugins/learn-gap-veto.mjs 的否决闸门）。**不要把它加回来。**
]);

/**
 * 否定作用域判定（R3）。返回 true 表示该命中处于否定语境、应被忽略。
 *
 * 有界设计（刻意保守，避免把真实失败也否掉）：
 *   - CJK：看命中前最多 6 个字符，要求**结尾**是「否定词 + 少量虚词」。
 *     这样 "没有报错"/"已经不报错了"/"还没修好"/"根本没有报错"/"会不会报错" 被否掉，
 *     而 "这里报错了"、"我不确定，但是报错了"（否定词离得远、后面不是否定词）仍是失败。
 *     第一版曾用"窗口内遇标点即结束"，实测在 "运行了一下，没有报错" 上误判
 *     （逗号在否定词之前却被当成作用域结束）——改为结尾锚定后与标点无关。
 *   - Latin：只看命中前 2 个词；出现否定词即否掉，但 "not only X" 例外（only 紧邻时不算否定）。
 *     这样 "no error"/"not broken"/"not fixed"/"never failed"/"no longer failing" 被否掉，
 *     而 "the build failed" 仍是失败。
 */
const NEG_CJK_TAIL_RE = /(没有|没|不|未|别|勿)(?:了|再|也|都|会|曾|过|太|很|还|经常|偶尔|真的|完全|根本){0,2}$/;
const NEG_LATIN_RE = /\b(no|not|never|nor|none|without|isn't|aren't|don't|doesn't|didn't|won't|can't|cannot)\b/i;

export function isNegated(text, idx, isCjk) {
  if (typeof text !== 'string' || idx <= 0) return false;
  if (isCjk) {
    const win = text.slice(Math.max(0, idx - 6), idx);
    return NEG_CJK_TAIL_RE.test(win);
  }
  const words = text.slice(0, idx).split(/\s+/).filter(Boolean).slice(-2);
  if (!words.length) return false;
  if (words[words.length - 1].toLowerCase() === 'only') return false;   // "not only failed"
  return words.some((w) => NEG_LATIN_RE.test(w));
}

/** 是否存在**未被否定**的命中（逐个匹配检查，否定掉一个继续找下一个）。 */
export function hasNonNegatedMatch(re, text, isCjk) {
  if (typeof text !== 'string' || !text) return false;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(text)) !== null) {
    if (!isNegated(text, m.index, isCjk)) return true;
    if (m.index === g.lastIndex) g.lastIndex += 1;      // 防零宽死循环
  }
  return false;
}

/**
 * 判定摘要中是否存在可学习的信号（纠正/解决模式）。纯启发式、确定性。
 *
 * ⛔ R2 AC5 边界变更：本函数**不再自行判定"是不是失败"**。
 *   - `signals` 只可能含 `resolution` / `correction` 两类**叙述性**信号（来自 SIGNAL_PATTERNS）。
 *   - 失败证据必须由调用方以 `opts.classifiedFailures` 注入，且**只能来自 P2.6 分类结果**
 *     （见 plugins/learn-gap-veto.mjs）。本函数对分类结果不做二次解释，只做区间配对。
 *
 * @param {object} digest
 * @param {object} [opts]
 * @param {Array<{seq:number, classification:string, normalizedSignature?:string,
 *                vetoed?:boolean, vetoReason?:string|null}>} [opts.classifiedFailures]
 *        由调用方从 P2.6 Authority 取得的、落在本 digest 窗口内的真实失败分类。
 * @returns {{hasSignal:boolean, signals:Array<{kind:string,seq:number,role:string}>,
 *            resolved:boolean, failureSeqs:number[], unresolvedFailureSeqs:number[],
 *            vetoedFailureSeqs:number[], vetoedCount:number, kinds:string[]}}
 *   - signals：每条发言最多一个 kind（取最强语义），按 seq 升序；
 *   - resolved：存在失败且其**之后**出现 resolution ⇒ true（失败-解决配对）；
 *   - unresolvedFailureSeqs：没有被后续 resolution 覆盖的失败 seq（真正的"缺口"）；
 *   - vetoedFailureSeqs：被 P2.6 分类**否决**的失败 seq（这些**绝不允许**产生 gap）。
 */
export function learningSignals(digest, opts = {}) {
  const empty = {
    hasSignal: false, signals: [], resolved: false,
    failureSeqs: [], unresolvedFailureSeqs: [], vetoedFailureSeqs: [], vetoedCount: 0, kinds: [],
  };
  if (!isPlainObject(digest) || !Array.isArray(digest.turns)) return empty;

  const signals = [];
  for (const t of digest.turns) {
    // R3：turns 里的非对象元素必须跳过（此前 t.text 在 null 元素上抛 TypeError）
    if (!isPlainObject(t)) continue;
    const text = typeof t.text === 'string' ? t.text : '';
    for (const p of SIGNAL_PATTERNS) {          // 已按语义强度排序 → 首个命中即最强
      // R3：必须排除否定语境（"没有报错" 不是失败），逐个匹配检查而非一次性 test
      if (hasNonNegatedMatch(p.latin, text, false) || hasNonNegatedMatch(p.cjk, text, true)) {
        signals.push({ kind: p.kind, seq: t.seq, role: t.role });
        break;
      }
    }
  }
  // 稳定按 seq 升序（与调用方传入的 turns 顺序解耦）
  signals.sort((a, b) => (a.seq - b.seq) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  // 失败证据 = 调用方注入的 P2.6 分类结果（**不是**关键词命中）
  const injected = Array.isArray(opts.classifiedFailures) ? opts.classifiedFailures : [];
  const failureSeqs = [...new Set(
    injected.filter((f) => isPlainObject(f) && Number.isInteger(f.seq)).map((f) => f.seq),
  )].sort((a, b) => a - b);
  const vetoedFailureSeqs = [...new Set(
    injected
      .filter((f) => isPlainObject(f) && Number.isInteger(f.seq) && f.vetoed === true)
      .map((f) => f.seq),
  )].sort((a, b) => a - b);

  // 失败-解决配对：只看 seq 更晚的 resolution（一次 resolution 覆盖它之前的全部失败）
  const resolutionSeqs = signals.filter((s) => s.kind === 'resolution').map((s) => s.seq);
  const lastResolution = resolutionSeqs.length ? resolutionSeqs[resolutionSeqs.length - 1] : null;
  const unresolvedFailureSeqs = failureSeqs.filter((q) => lastResolution === null || q > lastResolution);

  return {
    hasSignal: signals.length > 0,
    signals,
    resolved: failureSeqs.length > 0 && unresolvedFailureSeqs.length === 0,
    failureSeqs,
    unresolvedFailureSeqs,
    vetoedFailureSeqs,
    vetoedCount: vetoedFailureSeqs.length,
    kinds: [...new Set(signals.map((s) => s.kind))].sort(),
  };
}

/**
 * R2 AC5：**否决闸门**（唯一允许阻止"错误学习"的入口）。
 *
 * 语义：只要本窗口内存在**任一**被 P2.6 否决的失败，就**不得**产出候选经验/gap。
 * fail-closed 由 learn-gap-veto.mjs 保证（无分类/未知分类/taxonomy 不兼容 → 一律否决）。
 *
 * @returns {{blocked:boolean, reason:string, vetoedSeqs:number[], vetoedCount:number}}
 */
export function gapVetoGate(signals) {
  const seqs = isPlainObject(signals) && Array.isArray(signals.vetoedFailureSeqs)
    ? signals.vetoedFailureSeqs
    : [];
  if (seqs.length === 0) {
    return { blocked: false, reason: 'no vetoed failure in window', vetoedSeqs: [], vetoedCount: 0 };
  }
  return {
    blocked: true,
    reason: `vetoed failure(s) in window: seq ${seqs.join(',')}`,
    vetoedSeqs: seqs,
    vetoedCount: seqs.length,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 11. 合同【Experience Store】字段 —— 有界的结构化字段（不放聊天/日志/巨大输出）
// ═════════════════════════════════════════════════════════════════════════════

export const MAX_TASK_TYPE_LEN = 64;
export const MAX_TRIGGER_LEN = 200;
export const MAX_SYMPTOM_LEN = 200;
export const MAX_SYMPTOMS = 12;
export const MAX_ROOTCAUSE_LEN = 1000;
export const MAX_METHOD_LEN = 1000;
export const MAX_FAILED_METHODS = 8;
export const MAX_SOURCE_LINKS = 8;
export const MAX_LINK_LEN = 300;
export const MAX_COMMIT_LEN = 80;
export const MAX_PLUGIN_VERSION_LEN = 40;
export const MAX_RESEARCH_LEN = 300;
export const MAX_VERIFICATION_HISTORY = 8;

const VERSION_RE = /^[A-Za-z0-9._+-]{1,40}$/;

/** 任务类型白名单（开放但规范化：未知类型必须显式给出，不静默丢弃）。 */
export function normTaskType(v) {
  const t = cleanStr(v, MAX_TASK_TYPE_LEN);
  if (!t) return null;
  return t.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, MAX_TASK_TYPE_LEN) || null;
}

/** 规范化字符串数组：去空、脱敏、去重、稳定排序、有界（确定性，与输入顺序无关）。 */
export function normStrList(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return [];
  const set = new Set();
  for (const item of v) {
    const c = cleanStr(item, maxLen);
    if (c) set.add(c);
  }
  return [...set].sort().slice(0, maxItems);
}

function normVersion(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || !VERSION_RE.test(t)) return null;
  return t;
}

/** 适用版本：**只**是版本字符串，绝不含环境细节之外的任何内容。 */
export function normApplicableVersions(v) {
  const d = isPlainObject(v) ? v : {};
  return {
    dsh: normVersion(d.dsh),
    node: normVersion(d.node),
    plugin: normVersion(d.plugin),
  };
}

/** 适用环境：平台/架构 + 必需配置项清单（有界、可判定）。 */
export function normApplicableEnvironment(v) {
  const d = isPlainObject(v) ? v : {};
  return {
    platform: cleanStr(d.platform, 32),
    arch: cleanStr(d.arch, 32),
    requirements: normStrList(d.requirements, 12, 120),
  };
}

/** 陈旧条件：到期时间/最大验证龄（合同 stale/expiry conditions 的可判定部分）。 */
export function normStaleConditions(v) {
  const d = isPlainObject(v) ? v : {};
  return {
    maxAgeMs: Number.isSafeInteger(d.maxAgeMs) && d.maxAgeMs > 0 ? d.maxAgeMs : null,
    note: cleanStr(d.note, MAX_RESEARCH_LEN),
  };
}

/** 回退方案（合同 rollback）：有界的过程记录，不是日志。 */
export function normRollback(v) {
  const d = isPlainObject(v) ? v : {};
  const steps = normStrList(d.steps, 8, MAX_METHOD_LEN);
  const note = cleanStr(d.note, MAX_METHOD_LEN);
  if (steps.length === 0 && !note) return null;
  return { steps, note };
}

// ── 验证语义（合同【实现原则 3】）─────────────────────────────────────────────
//
// 核心不变量：HUMAN APPROVAL ≠ DETERMINISTIC VERIFICATION。
// "验证"在本实现里只有一种含义：**用机器可复算的证据，证明该经验来源的真实任务确实成功过**。
// 软判断（模型说成功、散文描述、截图观感）**永远不能**独立产生 VERIFIED —— 见 EVIDENCE_CLASSES。

/** 验证状态。UNVERIFIED 是唯一出生态。 */
export const VERIFICATION_STATUSES = ['UNVERIFIED', 'VERIFIED', 'REVALIDATION_REQUIRED'];

/**
 * 可产生 VERIFIED 的证据类别白名单 —— **只有机器可校验的**。
 *   · file_hash        —— 文件内容哈希（host 可独立复算）
 *   · system_api       —— 本机 API 状态码/响应包含（host 可独立复算）
 *   · session_outcome  —— 在**官方原始会话**中重新抽取工具结果，证明来源窗口内任务真实成功过
 * 注意：`session_outcome` 复算的是原始事件里的结构化 `isError` 布尔，**不是**经验自己的文字，
 * 因此它不是同义反复，也无法被伪造（伪造会在逐项复算时 mismatch）。
 */
export const EVIDENCE_CLASSES = ['file_hash', 'system_api', 'session_outcome'];
/** 软证据类别：仅可作为**观测**记录，永远不能单独产生 VERIFIED（与 host autonomy_verify 同一纪律）。 */
export const SOFT_EVIDENCE_CLASSES = ['ai_judgment', 'prose', 'screenshot', 'browser_state', 'git'];
/** 验证方法白名单 = 可机器校验的类别（显式导出，防被静默放宽）。 */
export const VERIFICATION_METHODS = EVIDENCE_CLASSES.slice();

/** 出生态验证记录：未验证、无方法、无证据、无时间。 */
export function emptyVerification() {
  return {
    status: 'UNVERIFIED',
    method: null,
    evidence: null,
    verifiedAt: null,
    reverifyCount: 0,
    lastReverifiedAt: null,
    lastReverifyResult: null,
    lastReverifyError: null,
  };
}

const SHA256_RE = /^[0-9a-f]{64}$/i;

/** 规范化验证证据记录（fail-closed：非白名单类别 / 畸形 / 超界 / 含密钥 ⇒ null）。 */
export function normEvidence(ev) {
  if (!isPlainObject(ev)) return null;
  const cls = cleanStr(ev.class, 40);
  if (!EVIDENCE_CLASSES.includes(cls)) return null;
  const json = JSON.stringify(ev);
  if (json.length > MAX_EVIDENCE_JSON_BYTES) return null;
  if (containsSecret(json)) return null;
  if (cls === 'file_hash') {
    const p = cleanStr(ev.path, 400);
    const sha = typeof ev.sha256 === 'string' ? ev.sha256.trim() : '';
    if (!p || !SHA256_RE.test(sha)) return null;
    return { class: 'file_hash', path: p, sha256: sha.toLowerCase(), note: cleanStr(ev.note, MAX_RESEARCH_LEN) };
  }
  if (cls === 'system_api') {
    const port = ev.port;
    const apiPath = typeof ev.path === 'string' ? ev.path : '';
    const status = ev.expectStatus;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (!apiPath.startsWith('/') || apiPath.length > 300) return null;
    if (!Number.isInteger(status) || status < 100 || status > 599) return null;
    return {
      class: 'system_api', port, path: apiPath, expectStatus: status,
      expectContains: cleanStr(ev.expectContains, 200),
      note: cleanStr(ev.note, MAX_RESEARCH_LEN),
    };
  }
  // session_outcome
  const sessionId = cleanStr(ev.sessionId, MAX_TITLE_LEN);
  const sessionName = cleanStr(ev.sessionName, 200);
  const win = Array.isArray(ev.window) ? ev.window : [];
  const anchors = normalizeSourceSeqs(ev.anchors);
  const factsDigest = typeof ev.factsDigest === 'string' ? ev.factsDigest.trim() : '';
  if (!sessionId || !sessionName) return null;
  if (win.length !== 2 || !Number.isInteger(win[0]) || !Number.isInteger(win[1]) ||
    win[0] < 0 || win[1] < win[0]) return null;
  if (anchors.length === 0) return null;
  if (!/^[0-9a-f]{8}$/.test(factsDigest)) return null;
  const ints = ['toolCalls', 'toolSuccesses', 'toolFailures'];
  for (const k of ints) if (!Number.isInteger(ev[k]) || ev[k] < 0) return null;
  return {
    class: 'session_outcome',
    sessionId,
    sessionName,
    window: [win[0], win[1]],
    anchors,
    toolCalls: ev.toolCalls,
    toolSuccesses: ev.toolSuccesses,
    toolFailures: ev.toolFailures,
    factsDigest,
    observedAt: Number.isSafeInteger(ev.observedAt) && ev.observedAt > 0 ? ev.observedAt : 0,
  };
}

/**
 * 合同字段统一默认（makeExperience 与 v1 迁移**共用同一份**定义 —— 杜绝两处字段表漂移）。
 */
export function contractFieldsFromDraft(draft) {
  const d = isPlainObject(draft) ? draft : {};
  return {
    taskType: normTaskType(d.taskType),
    trigger: cleanStr(d.trigger, MAX_TRIGGER_LEN),
    symptoms: normStrList(d.symptoms, MAX_SYMPTOMS, MAX_SYMPTOM_LEN),
    applicableVersions: normApplicableVersions(d.applicableVersions),
    applicableEnvironment: normApplicableEnvironment(d.applicableEnvironment),
    rootCause: cleanStr(d.rootCause, MAX_ROOTCAUSE_LEN),
    successfulMethod: cleanStr(d.successfulMethod, MAX_METHOD_LEN),
    failedOrUnsafeMethods: normStrList(d.failedOrUnsafeMethods, MAX_FAILED_METHODS, MAX_METHOD_LEN),
    verificationEvidence: normEvidence(d.verificationEvidence),
    rollback: normRollback(d.rollback),
    sourceLinks: normStrList(d.sourceLinks, MAX_SOURCE_LINKS, MAX_LINK_LEN),
    sourceCommit: cleanStr(d.sourceCommit, MAX_COMMIT_LEN),
    staleConditions: normStaleConditions(d.staleConditions),
    expiresAt: Number.isSafeInteger(d.expiresAt) ? d.expiresAt : null,
    lastVerifiedAt: null,
    verification: emptyVerification(),
    reuseCount: 0,
    reuseSuccessCount: 0,
    reuseFailCount: 0,
    successRate: null,
    lastUsedAt: null,
    verificationHistory: [],
    migratedFromV1: false,
  };
}

/**
 * 校验合同字段（fail-closed）。
 * 纪律：**缺席合法**（兼容 R1/R2 旧记录与迁移前形态），但一旦出现就必须结构合法。
 * @returns {string|null} 错误码（null = 通过）
 */
export function validateContractFields(raw) {
  if (!isPlainObject(raw)) return 'invalid_experience';
  const optStr = (k, max) => {
    const v = raw[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || v.length > max) return `invalid_${k}`;
    return null;
  };
  const optList = (k, maxItems) => {
    const v = raw[k];
    if (v === undefined || v === null) return null;
    if (!Array.isArray(v) || v.length > maxItems) return `invalid_${k}`;
    if (!v.every((x) => typeof x === 'string')) return `invalid_${k}`;
    return null;
  };
  for (const [k, max] of [['taskType', MAX_TASK_TYPE_LEN], ['trigger', MAX_TRIGGER_LEN],
    ['rootCause', MAX_ROOTCAUSE_LEN], ['successfulMethod', MAX_METHOD_LEN],
    ['sourceCommit', MAX_COMMIT_LEN]]) {
    const e = optStr(k, max);
    if (e) return e;
  }
  for (const [k, n] of [['symptoms', MAX_SYMPTOMS], ['failedOrUnsafeMethods', MAX_FAILED_METHODS],
    ['sourceLinks', MAX_SOURCE_LINKS], ['verificationHistory', MAX_VERIFICATION_HISTORY]]) {
    const e = optList(k, n);
    if (e) return e;
  }
  if (raw.expiresAt !== undefined && raw.expiresAt !== null &&
    (!Number.isSafeInteger(raw.expiresAt) || raw.expiresAt < 0)) return 'invalid_expiresAt';
  if (raw.lastVerifiedAt !== undefined && raw.lastVerifiedAt !== null &&
    (!Number.isSafeInteger(raw.lastVerifiedAt) || raw.lastVerifiedAt < 0)) return 'invalid_lastVerifiedAt';
  for (const [k, n] of [['reuseCount', 0], ['reuseSuccessCount', 0], ['reuseFailCount', 0]]) {
    if (raw[k] === undefined || raw[k] === null) continue;
    if (!Number.isInteger(raw[k]) || raw[k] < n) return `invalid_${k}`;
  }
  if (raw.successRate !== undefined && raw.successRate !== null) {
    if (typeof raw.successRate !== 'number' || !Number.isFinite(raw.successRate) ||
      raw.successRate < 0 || raw.successRate > 1) return 'invalid_successRate';
  }
  if (raw.verification !== undefined && raw.verification !== null) {
    const v = raw.verification;
    if (!isPlainObject(v)) return 'invalid_verification';
    if (!VERIFICATION_STATUSES.includes(v.status)) return 'invalid_verification_status';
    if (v.method !== null && v.method !== undefined && !VERIFICATION_METHODS.includes(v.method)) {
      return 'invalid_verification_method';
    }
    if (v.evidence !== null && v.evidence !== undefined && normEvidence(v.evidence) === null) {
      return 'invalid_verification_evidence';
    }
  }
  for (const [k, norm] of [['applicableVersions', normApplicableVersions],
    ['applicableEnvironment', normApplicableEnvironment], ['staleConditions', normStaleConditions]]) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    if (!isPlainObject(v)) return `invalid_${k}`;
    if (JSON.stringify(v).length > 2000) return `oversized_${k}`;
  }
  if (raw.verificationEvidence !== undefined && raw.verificationEvidence !== null &&
    normEvidence(raw.verificationEvidence) === null) return 'invalid_verificationEvidence';
  if (raw.rollback !== undefined && raw.rollback !== null) {
    if (!isPlainObject(raw.rollback)) return 'invalid_rollback';
    if (JSON.stringify(raw.rollback).length > MAX_EVIDENCE_JSON_BYTES) return 'oversized_rollback';
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// 12. 确定性验证（合同【实现原则 3】）—— 机器可复算，软判断永不产生 VERIFIED
// ═════════════════════════════════════════════════════════════════════════════

/**
 * 复算一条证据记录（纯判定，不改变任何状态）。
 * resolvers 由**调用方注入真实 host 能力**（文件哈希 / 本机 API / 官方会话重算）；
 * 核心模块内**没有第二套**验证器，也不依赖模型判断。
 *
 * @returns {{ok:boolean, method?:string, checked?:object, error?:string}}
 */
export function verifyEvidenceRecord(evidence, resolvers = {}) {
  const ev = normEvidence(evidence);
  if (!ev) return { ok: false, error: 'invalid_or_non_machine_checkable_evidence' };
  const R = isPlainObject(resolvers) ? resolvers : {};

  if (ev.class === 'file_hash') {
    if (typeof R.fileHash !== 'function') return { ok: false, error: 'no_file_hash_resolver' };
    let got = null;
    try { got = R.fileHash(ev.path); } catch { got = null; }
    if (typeof got !== 'string' || !SHA256_RE.test(got)) return { ok: false, error: 'file_hash_unresolvable' };
    if (got.toLowerCase() !== ev.sha256.toLowerCase()) return { ok: false, error: 'file_hash_mismatch' };
    return { ok: true, method: 'file_hash', checked: { path: ev.path } };
  }

  if (ev.class === 'system_api') {
    if (typeof R.systemApi !== 'function') return { ok: false, error: 'no_system_api_resolver' };
    let r = null;
    try { r = R.systemApi(ev); } catch { r = null; }
    if (!isPlainObject(r) || r.ok !== true) {
      return { ok: false, error: (isPlainObject(r) && typeof r.error === 'string') ? r.error : 'system_api_unreachable' };
    }
    if (r.status !== ev.expectStatus) return { ok: false, error: 'system_api_status_mismatch', observed: r.status };
    if (ev.expectContains && !String(r.body ?? '').includes(ev.expectContains)) {
      return { ok: false, error: 'system_api_body_mismatch' };
    }
    return { ok: true, method: 'system_api', checked: { status: r.status } };
  }

  // session_outcome：回**官方原始会话**重新抽取，逐项复算必须完全一致
  if (typeof R.sessionOutcome !== 'function') return { ok: false, error: 'no_session_outcome_resolver' };
  let r = null;
  try { r = R.sessionOutcome(ev); } catch { r = null; }
  if (!isPlainObject(r) || r.ok !== true) {
    return { ok: false, error: (isPlainObject(r) && typeof r.error === 'string') ? r.error : 'session_unreadable' };
  }
  const o = r.observed;
  if (!isPlainObject(o)) return { ok: false, error: 'no_observation' };
  if (o.anchorsFound !== ev.anchors.length) {
    return { ok: false, error: 'anchors_not_found_in_session', expected: ev.anchors.length, observed: o.anchorsFound };
  }
  if (o.toolCalls !== ev.toolCalls) return { ok: false, error: 'tool_call_count_mismatch', observed: o.toolCalls };
  if (o.toolSuccesses !== ev.toolSuccesses) return { ok: false, error: 'tool_success_count_mismatch', observed: o.toolSuccesses };
  if (o.toolFailures !== ev.toolFailures) return { ok: false, error: 'tool_failure_count_mismatch', observed: o.toolFailures };
  if (o.factsDigest !== ev.factsDigest) return { ok: false, error: 'facts_digest_mismatch' };
  // ★ 合同【实现原则 3】：没有**真实成功证据** ⇒ 永不 VERIFIED
  if (o.toolSuccesses < 1) return { ok: false, error: 'no_success_evidence' };
  return { ok: true, method: 'session_outcome', checked: { toolCalls: o.toolCalls, toolSuccesses: o.toolSuccesses } };
}

/**
 * 追加一条验证历史（不可变）。
 *
 * ★ 口径铁律（2026-09-25 实测修正）：`verificationHistory` 的 schema 是
 *   **有界字符串数组**（validateExperience 用 optList 逐项要求 typeof === 'string'）。
 *   本函数此前推的是**对象**，导致 `sanitizeExperience` 返回 `invalid_verificationHistory`
 *   ⇒ applyVerification 走"无 value"的早退分支 ⇒ 验证结果**静默不落盘**（状态永远是
 *   UNVERIFIED、发布被拒、跨会话复用整条合同闭环不可达）。现统一编码为**单行字符串**：
 *       `<PASS|FAIL>|<method|->|<at>|<error|->`
 *   既保住审计信息（结果/方法/时间/错误码），又满足字符串数组的 schema 契约。
 *   ⚠ 这里绝不放宽 schema 去迁就生产者——那是"让校验器屈服于实现"，反了。
 */
function pushVerificationHistory(exp, entry) {
  // 历史里若混入历史版本的对象条目，取字符串项即可自愈（绝不把非法条目继续往下传）
  const prev = (Array.isArray(exp.verificationHistory) ? exp.verificationHistory : [])
    .filter((x) => typeof x === 'string');
  const result = entry && entry.result === 'PASS' ? 'PASS' : 'FAIL';
  const method = entry && typeof entry.method === 'string' && VERIFICATION_METHODS.includes(entry.method)
    ? entry.method : '-';
  const ts = Number.isSafeInteger(entry && entry.at) && entry.at > 0 ? entry.at : 0;
  const err = entry && typeof entry.error === 'string' && entry.error
    ? entry.error.replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 96) || '-'
    : '-';
  const line = `${result}|${method}|${ts}|${err}`;
  return [...prev, line].slice(-MAX_VERIFICATION_HISTORY);
}

/**
 * 对一条经验执行确定性验证（不可变更新）。
 * 通过 ⇒ state 迁移到 VERIFIED_EXPERIENCE、verification.status=VERIFIED、写入 lastVerifiedAt。
 * 失败 ⇒ 绝不标记 VERIFIED；若此前已验证则降级为 REVALIDATION_REQUIRED（不再被无条件优先召回）。
 */
export function applyVerification(store, id, evidence, resolvers = {}, at = 0) {
  const found = findExperience(store, id);
  if (found.error) return found.error;
  const exp = found.exp;
  if (exp.state === 'REJECTED' || exp.state === 'RETIRED') {
    return { ok: false, error: `cannot_verify_${exp.state.toLowerCase()}` };
  }
  const ts = Number.isSafeInteger(at) && at > 0 ? at : 0;
  const prev = isPlainObject(exp.verification) ? { ...emptyVerification(), ...exp.verification } : emptyVerification();
  const res = verifyEvidenceRecord(evidence, resolvers);

  if (!res.ok) {
    const status = prev.status === 'VERIFIED' ? 'REVALIDATION_REQUIRED' : 'UNVERIFIED';
    const updated = {
      ...exp,
      verification: {
        ...prev, status,
        lastReverifiedAt: ts, lastReverifyResult: 'FAIL', lastReverifyError: res.error,
      },
      verificationHistory: pushVerificationHistory(exp, { at: ts, result: 'FAIL', method: null, error: res.error }),
    };
    const checked = sanitizeExperience(updated);
    if (checked.error) return { ok: false, error: checked.error };
    return { ok: false, error: res.error, value: withExperience(store, updated), experience: updated, status };
  }

  const record = normEvidence(evidence);
  // ★★ B1 根因修复（R2 外部评审 BLOCKER-1）：**人工审批必须粘性**。
  //
  // 旧实现 `canTransition(exp.state,'VERIFIED_EXPERIENCE') ? 'VERIFIED_EXPERIENCE' : exp.state`
  // 对 APPROVED 也成立（迁移表 APPROVED: ['VERIFIED_EXPERIENCE','RETIRED']），于是
  //     APPROVED ──确定性验证 PASS──▶ VERIFIED_EXPERIENCE
  // 把**人工授权**这一位擦掉了：已批准的经验一旦重新验证，就退回"仅机器验证"。
  // 后果是「APPROVED + VERIFIED」在状态机里**根本无法共存** ⇒ 发布闸门只能退化为
  // "只看 VERIFIED" ⇒ 零人工审批的经验被全新会话召回（BLOCKER-1）。
  //
  // 语义纠正（与合同 §1 状态机一致）：
  //   · PROPOSED ──验证 PASS──▶ VERIFIED_EXPERIENCE 是**晋升**（获得机器证据）；
  //   · APPROVED ──验证 PASS──▶ 保持 APPROVED 是**必须**（重新拿证据 ≠ 撤回授权）。
  // 授权只能由人撤销（reject/retire），绝不可被"再验证一次"隐式撤销。
  const nextState = exp.state === 'APPROVED'
    ? 'APPROVED'
    : (canTransition(exp.state, 'VERIFIED_EXPERIENCE') ? 'VERIFIED_EXPERIENCE' : exp.state);
  const updated = {
    ...exp,
    state: nextState,
    verification: {
      status: 'VERIFIED',
      method: res.method,
      evidence: record,
      verifiedAt: ts,
      reverifyCount: (Number.isInteger(prev.reverifyCount) ? prev.reverifyCount : 0) + 1,
      lastReverifiedAt: ts,
      lastReverifyResult: 'PASS',
      lastReverifyError: null,
    },
    lastVerifiedAt: ts,
    verificationEvidence: record,
    verificationHistory: pushVerificationHistory(exp, { at: ts, result: 'PASS', method: res.method, error: null }),
  };
  const checked = sanitizeExperience(updated);
  if (checked.error) return { ok: false, error: checked.error };
  return { ok: true, method: res.method, value: withExperience(store, updated), experience: updated };
}

/**
 * 合同【复用规则】第 5 步 + §11：复用之后的**重新验证**结果登记。
 * 成功 ⇒ 刷新 lastVerifiedAt / successRate / lastUsedAt（经验继续可用）。
 * 失败 ⇒ 标记 REVALIDATION_REQUIRED（**不得**继续无条件优先召回），并记录失败计数。
 */
export function recordReuseOutcome(store, id, outcome = {}) {
  const found = findExperience(store, id);
  if (found.error) return found.error;
  const exp = found.exp;
  const at = Number.isSafeInteger(outcome.at) && outcome.at > 0 ? outcome.at : 0;
  const success = outcome.success === true;
  const verify = isPlainObject(outcome.verification) ? outcome.verification : null;
  const prev = isPlainObject(exp.verification) ? { ...emptyVerification(), ...exp.verification } : emptyVerification();
  const reuseCount = (Number.isInteger(exp.reuseCount) ? exp.reuseCount : 0) + 1;
  const okCount = (Number.isInteger(exp.reuseSuccessCount) ? exp.reuseSuccessCount : 0) + (success ? 1 : 0);
  const failCount = (Number.isInteger(exp.reuseFailCount) ? exp.reuseFailCount : 0) + (success ? 0 : 1);
  const base = { ...exp, reuseCount, reuseSuccessCount: okCount, reuseFailCount: failCount, lastUsedAt: at };
  base.successRate = Math.round((okCount / reuseCount) * 1000) / 1000;

  let next = base;
  if (success) {
    next = {
      ...base,
      lastVerifiedAt: at,
      verification: {
        ...prev,
        status: prev.status === 'VERIFIED' ? 'VERIFIED' : prev.status,
        lastReverifiedAt: at,
        lastReverifyResult: verify && verify.ok === true ? 'PASS' : 'PASS',
        lastReverifyError: null,
      },
      verificationHistory: pushVerificationHistory(exp, { at, result: 'PASS', method: verify?.method ?? prev.method ?? null, error: null }),
    };
  } else {
    // 复用失败：旧经验**不得**继续被当作 Truth
    const status = prev.status === 'VERIFIED' || exp.state === 'VERIFIED_EXPERIENCE'
      ? 'REVALIDATION_REQUIRED' : prev.status;
    next = {
      ...base,
      verification: {
        ...prev, status,
        lastReverifiedAt: at, lastReverifyResult: 'FAIL',
        lastReverifyError: typeof outcome.reason === 'string' ? outcome.reason.slice(0, 200) : 'reuse_failed',
      },
      verificationHistory: pushVerificationHistory(exp, {
        at, result: 'FAIL', method: verify?.method ?? prev.method ?? null,
        error: typeof outcome.reason === 'string' ? outcome.reason.slice(0, 200) : 'reuse_failed',
      }),
    };
  }
  const checked = sanitizeExperience(next);
  if (checked.error) return { ok: false, error: checked.error };
  return { ok: true, value: withExperience(store, next), experience: next, success };
}

// ═════════════════════════════════════════════════════════════════════════════
// 13. 适用性检查（合同【实现原则 5】：复用前必须重新检查当前版本/环境是否仍适用）
// ═════════════════════════════════════════════════════════════════════════════

/** 适用性判定结果（四态，互斥）。 */
export const APPLICABILITY_STATUSES = ['APPLICABLE', 'STALE', 'INCOMPATIBLE', 'REVALIDATION_REQUIRED'];

function checkOneVersion(required, actual, name) {
  if (required === null || required === undefined) return null;   // 未声明约束 ⇒ 不阻断
  if (actual === null || actual === undefined || actual === '') {
    // fail-closed：经验声明了版本约束，而当前环境无法确定版本 ⇒ 不能证明适用
    return { status: 'REVALIDATION_REQUIRED', reason: `${name}_version_unknown` };
  }
  if (String(required) !== String(actual)) {
    return { status: 'INCOMPATIBLE', reason: `${name}_version_mismatch` };
  }
  return null;
}

/**
 * 合同【实现原则 5】的适用性检查（函数名不必是 isApplicableNow，语义必须存在 —— 此处同名提供）。
 *
 * 检查项：经验是否真实通过验证 → 过期/陈旧 → DSH·runtime·插件版本 → 平台/架构 → 必需配置/环境。
 * 输出四态：APPLICABLE / STALE / INCOMPATIBLE / REVALIDATION_REQUIRED。
 *
 * @param {object} exp  经验条目
 * @param {object} env  当前环境 {dshVersion, nodeVersion, pluginVersion, platform, arch, available[]}
 */
export function isApplicableNow(exp, env = {}, opts = {}) {
  const checks = {};
  if (!isPlainObject(exp)) return { ok: false, status: 'INCOMPATIBLE', reason: 'invalid_experience', checks };
  const e = isPlainObject(env) ? env : {};
  const now = Number.isSafeInteger(opts.now) && opts.now > 0 ? opts.now : 0;
  const ver = isPlainObject(exp.verification) ? { ...emptyVerification(), ...exp.verification } : emptyVerification();

  // ① 必须先经过真实、确定性的验证（未验证的经验不得进入复用面）
  checks.verificationStatus = ver.status;
  if (ver.status === 'REVALIDATION_REQUIRED') {
    return { ok: false, status: 'REVALIDATION_REQUIRED', reason: 'reverification_failed', checks };
  }
  if (ver.status !== 'VERIFIED') {
    return { ok: false, status: 'REVALIDATION_REQUIRED', reason: 'never_verified', checks };
  }
  checks.lastVerifiedAt = Number.isSafeInteger(exp.lastVerifiedAt) ? exp.lastVerifiedAt : null;

  // ② 过期 / 陈旧条件
  checks.expiresAt = Number.isSafeInteger(exp.expiresAt) ? exp.expiresAt : null;
  if (checks.expiresAt !== null && now > 0 && now >= checks.expiresAt) {
    return { ok: false, status: 'STALE', reason: 'expired', checks };
  }
  const sc = isPlainObject(exp.staleConditions) ? exp.staleConditions : {};
  const maxAgeMs = Number.isSafeInteger(sc.maxAgeMs) ? sc.maxAgeMs : null;
  checks.maxAgeMs = maxAgeMs;
  checks.ageMs = (maxAgeMs !== null && checks.lastVerifiedAt !== null && now > 0)
    ? now - checks.lastVerifiedAt : null;
  if (maxAgeMs !== null && checks.ageMs !== null && checks.ageMs > maxAgeMs) {
    return { ok: false, status: 'STALE', reason: 'verification_too_old', checks };
  }

  // ③ 版本（DSH / runtime / 相关插件）
  const av = isPlainObject(exp.applicableVersions) ? exp.applicableVersions : {};
  checks.requiredDshVersion = av.dsh ?? null; checks.envDshVersion = e.dshVersion ?? null;
  checks.requiredNodeVersion = av.node ?? null; checks.envNodeVersion = e.nodeVersion ?? null;
  checks.requiredPluginVersion = av.plugin ?? null; checks.envPluginVersion = e.pluginVersion ?? null;
  for (const [req, act, name] of [[av.dsh, e.dshVersion, 'dsh'], [av.node, e.nodeVersion, 'node'],
    [av.plugin, e.pluginVersion, 'plugin']]) {
    const r = checkOneVersion(req ?? null, act ?? null, name);
    if (r) return { ok: false, ...r, checks };
  }

  // ④ 平台 / 架构
  const ae = isPlainObject(exp.applicableEnvironment) ? exp.applicableEnvironment : {};
  checks.requiredPlatform = ae.platform ?? null; checks.envPlatform = e.platform ?? null;
  if (ae.platform && e.platform && String(ae.platform) !== String(e.platform)) {
    return { ok: false, status: 'INCOMPATIBLE', reason: 'platform_mismatch', checks };
  }
  if (ae.arch && e.arch && String(ae.arch) !== String(e.arch)) {
    return { ok: false, status: 'INCOMPATIBLE', reason: 'arch_mismatch', checks };
  }

  // ⑤ 必需配置 / 环境项
  const reqs = Array.isArray(ae.requirements) ? ae.requirements : [];
  checks.requirements = reqs;
  if (reqs.length > 0) {
    const avail = Array.isArray(e.available) ? e.available.map(String) : null;
    if (avail === null) {
      return { ok: false, status: 'REVALIDATION_REQUIRED', reason: 'requirements_not_verifiable', checks };
    }
    const missing = reqs.filter((r) => !avail.includes(String(r)));
    checks.missingRequirements = missing;
    if (missing.length > 0) return { ok: false, status: 'INCOMPATIBLE', reason: 'missing_requirements', checks };
  }
  return { ok: true, status: 'APPLICABLE', reason: 'ok', checks };
}

// ═════════════════════════════════════════════════════════════════════════════
// 14. Layer B：跨会话「全局已验证经验库」（只有 APPROVED + VERIFIED + 完整审批来源能进）
// ═════════════════════════════════════════════════════════════════════════════

export const GLOBAL_STORE_KIND = 'global-verified-experience-store';

export function emptyGlobalStore(at = 0) {
  return {
    schemaVersion: GLOBAL_STORE_SCHEMA_VERSION,
    kind: GLOBAL_STORE_KIND,
    version: 0,
    updatedAt: Number.isSafeInteger(at) && at > 0 ? at : 0,
    experiences: [],
    telemetry: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 22-bis. F1 —— 宿主人类批准边界（HUMAN APPROVAL BOUNDARY）
//
// 根因（P4 R2 外部评审 F1）：`approve()` 的授权来源是**调用方自己填的字符串**
// （`opts.approver` / `opts.evidence`）。任何能触达该函数（经 `learn_review` 工具）的主体
// 都能凭自述把自己写成"人类已批准"，随后经 publish 进入跨会话全局库。
// 也就是说："人类批准"此前是**自述（claim）**，不是**可证明的宿主事实（fact）**。
//
// 本节唯一职责：把 APPROVED 的授权来源收敛到**宿主已有的人类批准通道**
// （Cordis `ctx.get('approval')` → `approval/request` 瀑布 → 人类作答 → 宿主把
// `approval/asked` / `approval/decided` 写入**官方会话日志**）。
// 判据不是"谁说了什么"，而是"宿主日志里有没有这次人类批准"。
//
// 三个必要条件（缺任一 ⇒ 不是人类批准 ⇒ 绝不 mint APPROVED）：
//   ① 宿主事实：`approvalRef` 必须在**真实会话日志**中同时存在
//      `approval/asked{id, toolName:'learn_review'}` 与
//      `approval/decided{id, outcome:'allowed-once'}`——这两条**只有宿主 ApprovalService 会写**。
//      该事实在**人类作答的那一刻**被写入宿主控制的**持久审批台账**（见 ② ）。
//   ② 持久审批台账（append-only，落盘）：`approve()` 只在宿主事实成立时向台账追加
//      `grant`（记录 candidateId / digest / approvedAt / trustedSource / hostActor /
//      approvalRef / hostSessionId / schemaVersion）+ `consume`（单次消费标记）。
//      台账**不随进程重启消失**，因此"合法批准"在重启后仍可验证（§8 A/C）；
//      代价是权威从"进程内密钥"变成"宿主控制的落盘台账"（残余风险见报告 §6）。
//   ③ 对象绑定：attestation 记录被批准经验的 id、内容摘要 candidateDigest 与
//      `ledgerRecordId`；审批后被改写的经验 ⇒ 摘要不符 ⇒ 授权失效（不能"批一个、发另一个"）。
//
// 本节唯一 authority 是 `validHumanApproval()`；approve / recall / publish 全部经由它判定，
// **不新增第二套审批机制**（合同禁止重复系统）。
// ─────────────────────────────────────────────────────────────────────────────

export const HUMAN_APPROVAL_SCHEMA = 'learn-human-approval/v1';
export const HUMAN_APPROVAL_CHANNEL = 'host-approval-seam';   // = 宿主 ctx.get('approval')
export const HUMAN_APPROVAL_ACTOR = 'host-approved-human';    // 固定标签：不接受调用方自由文本
export const HUMAN_APPROVAL_GRANT = 'allowed-once';           // 宿主词表中唯一的"授予"
export const HUMAN_APPROVAL_HOST_TOOL = 'learn_review';       // 宿主日志中必须出现的工具名
export const HUMAN_APPROVAL_OUTCOMES = Object.freeze(['allowed-once', 'rejected', 'cancelled', 'unavailable']);
export const MAX_APPROVAL_REF_LEN = 128;

// ── 持久审批台账（F1 R1 的权威载体）──────────────────────────────────────────
// 文件：`<stateDir>/_human-approvals.jsonl`（append-only，一行一条记录，永不原地改写）。
// 记录形态：{ seq, prev, body, chain }，chain = sha256(['ledger/v1', seq, prev, body])
//   · grant     —— 人类批准事实落账（唯一能授权的记录类型）
//   · consume   —— 该 grant 被**消费一次**（单次消费标记：未被消费的 grant 不构成授权）
//   · supersede —— 新批准取代旧批准（例如内容变化后重新批准）
//   · revoke    —— 显式撤销
// 链式摘要使"改写/删除历史记录"可被检测（verifyApprovalLedgerChain）；任何断链 ⇒ 整本台账
// 判不可信（fail-closed）。追加式伪造（攻击者自己写一条新链）**不能**由链本身阻止——
// 这正是 §6 实测项，残余风险与 OS 级隔离缺口在报告里如实记录。
export const HUMAN_APPROVAL_LEDGER_SCHEMA = 'learn-human-approval-ledger/v1';
export const APPROVAL_LEDGER_FILE = '_human-approvals.jsonl';
export const APPROVAL_RECORD_TYPES = Object.freeze(['grant', 'consume', 'supersede', 'revoke']);

const APPROVAL_REF_RE = /^[A-Za-z0-9_-]{8,128}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const LEDGER_RECORD_ID_RE = /^hap-[0-9a-f]{16}$/;
/** 宿主日志里 `approval/asked.reason` 中的内容摘要标记（由发起方写入，宿主原样落盘）。 */
const REASON_DIGEST_RE = /digest=([0-9a-f]{64})/;

/** 从宿主日志的请求 reason 里取出"人类当时被问的是哪份内容"的摘要；取不到返回 null。 */
function extractReasonDigest(reason) {
  if (typeof reason !== 'string') return null;
  const m = REASON_DIGEST_RE.exec(reason);
  return m ? m[1] : null;
}

/** 台账记录的链式摘要（含 seq 与 prev ⇒ 改写/删除/换序都会断链）。 */
function ledgerChainHash(seq, prev, body) {
  return createHash('sha256')
    .update(JSON.stringify([HUMAN_APPROVAL_LEDGER_SCHEMA, seq, prev, body]))
    .digest('hex');
}

/** 记录 id 由链式摘要派生（确定性；不同 seq/prev/body ⇒ 不同 id）。 */
function ledgerRecordId(chain) {
  return `hap-${chain.slice(0, 16)}`;
}

/**
 * 构造一条台账记录（**纯函数**：不读不写文件，不修改入参）。
 * @returns {{ok:boolean, reason?:string, record?:object}}
 */
export function makeApprovalRecord(records, body, opts = {}) {
  const list = Array.isArray(records) ? records : null;
  if (!list) return { ok: false, reason: 'invalid_ledger_records' };
  if (!isPlainObject(body) || !APPROVAL_RECORD_TYPES.includes(body.type)) {
    return { ok: false, reason: 'invalid_record_type' };
  }
  const seq = list.length + 1;
  const prev = list.length === 0 ? '' : (list[list.length - 1].chain ?? '');
  const chain = ledgerChainHash(seq, prev, body);
  return { ok: true, record: { seq, prev, body, chain, recordId: ledgerRecordId(chain) } };
}

/** 解析台账文本（JSONL）。缺文件 ⇒ 空台账；任何一行畸形 ⇒ 整本判不可信（fail-closed）。 */
export function parseApprovalLedgerText(text) {
  if (text === '' || text === undefined || text === null) return { ok: true, records: [], reason: 'empty_ledger' };
  if (typeof text !== 'string') return { ok: false, reason: 'ledger_not_text', records: [] };
  const records = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;                                  // 末尾空行合法
    let rec;
    try { rec = JSON.parse(line); } catch { return { ok: false, reason: `ledger_line_unparsable:${i + 1}`, records: [] }; }
    if (!isPlainObject(rec) || !isPlainObject(rec.body)) return { ok: false, reason: `ledger_line_malformed:${i + 1}`, records: [] };
    records.push(rec);
  }
  return { ok: true, records, reason: 'ok' };
}

/** 序列化一条台账记录为 JSONL 行（含换行）。 */
export function serializeApprovalRecord(record) {
  return `${JSON.stringify(record)}\n`;
}

/** 台账完整性：seq/prev/chain 三者的链式自洽（任何断链 ⇒ 不可信）。 */
export function verifyApprovalLedgerChain(records) {
  if (!Array.isArray(records)) return { ok: false, reason: 'invalid_ledger_records' };
  let prev = '';
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    if (!isPlainObject(rec) || !isPlainObject(rec.body)) return { ok: false, reason: `ledger_record_malformed:${i + 1}` };
    if (rec.seq !== i + 1) return { ok: false, reason: `ledger_seq_mismatch:${i + 1}` };
    if ((rec.prev ?? '') !== prev) return { ok: false, reason: `ledger_prev_mismatch:${i + 1}` };
    if (!APPROVAL_RECORD_TYPES.includes(rec.body.type)) return { ok: false, reason: `ledger_type_unknown:${i + 1}` };
    const chain = ledgerChainHash(rec.seq, rec.prev ?? '', rec.body);
    if (chain !== rec.chain) return { ok: false, reason: `ledger_chain_mismatch:${i + 1}` };
    if (rec.recordId !== ledgerRecordId(chain)) return { ok: false, reason: `ledger_record_id_mismatch:${i + 1}` };
    prev = chain;
  }
  return { ok: true, reason: 'ok', length: records.length };
}

/** 台账中某条 grant 的当前状态（含消费/取代/撤销）。 */
export function approvalGrantView(records, recordId) {
  if (!Array.isArray(records)) return { ok: false, reason: 'invalid_ledger_records' };
  if (typeof recordId !== 'string' || !LEDGER_RECORD_ID_RE.test(recordId)) {
    return { ok: false, reason: 'approval_ledger_record_id_invalid' };
  }
  const grant = records.find((r) => r?.recordId === recordId) ?? null;
  if (!grant) return { ok: false, reason: 'approval_ledger_record_unknown' };
  if (grant.body.type !== 'grant') return { ok: false, reason: 'approval_ledger_record_not_grant' };
  const consumes = records.filter((r) => r?.body?.type === 'consume' && r.body.recordId === recordId);
  const supersededBy = records.find((r) => r?.body?.type === 'supersede' && r.body.recordId === recordId) ?? null;
  const revoked = records.find((r) => r?.body?.type === 'revoke' && r.body.recordId === recordId) ?? null;
  return {
    ok: true, reason: 'ok', grant,
    consumes,
    consumedBy: consumes.length > 0 ? (consumes[0].body.consumedBy ?? consumes[0].body.candidateId ?? null) : null,
    supersededBy: supersededBy ? (supersededBy.body.byRecordId ?? null) : null,
    revoked: revoked !== null,
  };
}

/**
 * 台账 → 授权判定（**纯函数**，可单测）。
 * 只认"存在、未被消费、未取代、未撤销，且与 attestation 逐字段一致"的 grant。
 */
export function approvalAuthorityFromLedger(records, exp) {
  const chain = verifyApprovalLedgerChain(records);
  if (!chain.ok) return { ok: false, reason: 'approval_ledger_chain_broken' };
  const att = isPlainObject(exp) && isPlainObject(exp.approval) ? exp.approval : null;
  if (!att) return { ok: false, reason: 'approval_missing_host_attestation' };
  const view = approvalGrantView(records, att.ledgerRecordId);
  if (!view.ok) return view;
  const g = view.grant.body;
  if (g.schemaVersion !== HUMAN_APPROVAL_LEDGER_SCHEMA) return { ok: false, reason: 'approval_ledger_schema_unknown' };
  if (g.trustedSource !== HUMAN_APPROVAL_CHANNEL) return { ok: false, reason: 'approval_ledger_source_untrusted' };
  if (g.hostActor !== HUMAN_APPROVAL_ACTOR) return { ok: false, reason: 'approval_ledger_actor_not_host' };
  if (g.candidateId !== exp.id || g.candidateId !== att.candidateId) return { ok: false, reason: 'approval_ledger_candidate_mismatch' };
  if (g.digest !== att.candidateDigest) return { ok: false, reason: 'approval_ledger_digest_mismatch' };
  if (g.approvalRef !== att.ref) return { ok: false, reason: 'approval_ledger_ref_mismatch' };
  if (g.approvedAt !== att.approvedAt) return { ok: false, reason: 'approval_ledger_timestamp_mismatch' };
  if (view.revoked) return { ok: false, reason: 'approval_ledger_grant_revoked' };
  if (view.supersededBy) return { ok: false, reason: 'approval_ledger_grant_superseded' };
  // ★ 单次消费：grant 必须**恰好被消费一次**，且消费方就是这条经验（内容摘要一致）。
  if (view.consumes.length === 0) return { ok: false, reason: 'approval_ledger_grant_not_consumed' };
  if (view.consumes.length > 1) return { ok: false, reason: 'approval_ledger_grant_consumed_twice' };
  const c = view.consumes[0].body;
  if (c.candidateId !== exp.id || c.digest !== att.candidateDigest) {
    return { ok: false, reason: 'approval_ledger_consumed_by_other' };
  }
  // 台账 **不是** authority 本身：把命中的 grant 交给调用方做宿主事实复验（见 validHumanApproval）。
  return { ok: true, reason: 'ok', grant: g };
}

/**
 * 宿主事实复验器（**本轮 F1 R1 的信任锚**）。
 *
 * 为什么必须有它：F1 R1 把"合法批准在重启后仍可验证"改为持久台账承载后，台账文件本身
 * 落在插件 stateDir 内 —— 一个具备文件写权限的调用方理论上可以**自行追加**一条格式完全
 * 合法（链式摘要自洽）的 grant+consume。**链式摘要只能检测改写/删除，不能阻止追加伪造。**
 * 因此授权不能止于台账：任何 grant 还必须能被**宿主侧事实**复核 —— 即宿主自己写下的
 * `approval/asked` + `approval/decided` 事件对（含"人类当时被问的是哪份内容"的摘要）。
 *
 * 该复验在**每次授权判定**时执行（publish / 载入 / 召回共用同一个 `validHumanApproval`），
 * 而不是只在铸造时执行一次 ⇒ 伪造的台账记录在判定点即被拒（fail-closed）。
 * 台账仍然必要：它承载**单次消费 / 取代 / 撤销 / 重启后仍在**这些宿主事实没有的状态。
 *
 * @param {(sid:string)=>object|null} getSession 宿主提供的会话读取器（生产：`ctx.sessions.get`）
 * @returns {(grant:object)=>{ok:boolean, reason:string}} 复验器；直接返回它可被挂到台账句柄上
 */
export function makeHostFactVerifier(getSession) {
  if (typeof getSession !== 'function') return null;
  return function verifyHostFact(grant) {
    if (!isPlainObject(grant)) return { ok: false, reason: 'approval_host_fact_invalid_grant' };
    const sid = typeof grant.hostSessionId === 'string' && grant.hostSessionId ? grant.hostSessionId : null;
    if (!sid) return { ok: false, reason: 'approval_host_fact_no_session' };
    let session = null;
    try { session = getSession(sid); } catch { session = null; }
    if (!session) return { ok: false, reason: 'approval_host_fact_session_unavailable' };
    const rec = hostApprovalRecord(session, grant.approvalRef);
    if (!rec.ok) return { ok: false, reason: `approval_host_fact_${rec.reason}` };
    // 人类被问的必须是**这条台账 grant 声称的那份内容**（否则等于"批一个、记另一个"）。
    if (rec.digest !== grant.digest) return { ok: false, reason: 'approval_host_fact_digest_mismatch' };
    return { ok: true, reason: 'ok' };
  };
}

// ── 台账句柄（读写适配层）──────────────────────────────────────────────────
// learn-core 保持"纯函数核心"：本层只做**内存记录集**的读写；文件 IO 在插件壳（learn.mjs）。
// 句柄接口：{ id, records() -> 记录数组, append(body, opts) -> {ok, record|reason} }

/** 已挂载的台账集合（读取时**全部**参与判定 ⇒ 多实例/热重载不会互相作废已批记录）。 */
let APPROVAL_LEDGERS = [];

/** 挂载一本台账（插件 apply() 调用）。返回卸载函数。 */
export function attachApprovalLedger(handle) {
  if (!isPlainObject(handle) || typeof handle.records !== 'function') return () => {};
  APPROVAL_LEDGERS = APPROVAL_LEDGERS.filter((h) => h.id !== handle.id).concat([handle]);
  return () => detachApprovalLedger(handle);
}

/** 卸载台账（测试/热重载用）。 */
export function detachApprovalLedger(handle) {
  const before = APPROVAL_LEDGERS.length;
  APPROVAL_LEDGERS = APPROVAL_LEDGERS.filter((h) => h !== handle && h.id !== handle?.id);
  return before !== APPROVAL_LEDGERS.length;
}

/** 当前已挂载台账（诊断用；不含任何密钥——台账里本来就没有密钥）。 */
export function attachedApprovalLedgers() {
  return APPROVAL_LEDGERS.map((h) => ({ id: h.id, length: (() => { try { return h.records().length; } catch { return -1; } })() }));
}

/** 纯内存台账句柄（单测 / 纯函数环境；与文件台账共用同一套 append/chain 语义）。 */
export function createMemoryApprovalLedger(opts = {}) {
  const id = typeof opts.id === 'string' && opts.id ? opts.id : 'memory';
  let records = Array.isArray(opts.records) ? opts.records.slice() : [];
  // 宿主事实复验器（可选）：传 `getSession`（宿主会话读取器）或直接传 `verifyHostFact`。
  // 不挂 ⇒ 该台账**单独不构成授权**（validHumanApproval 判 approval_host_fact_unverifiable）。
  const verifyHostFact = typeof opts.verifyHostFact === 'function'
    ? opts.verifyHostFact
    : makeHostFactVerifier(opts.getSession);
  return {
    id,
    ...(verifyHostFact ? { verifyHostFact } : {}),
    records: () => records,
    append(body, appendOpts = {}) {
      const made = makeApprovalRecord(records, body, appendOpts);
      if (!made.ok) return made;
      records = records.concat([made.record]);
      return { ok: true, record: made.record };
    },
    _set(recs) { records = Array.isArray(recs) ? recs.slice() : []; },
  };
}

/** 取本次判定使用的台账集合：显式传入优先，否则用已挂载的全部台账。 */
function ledgersFor(explicit) {
  if (explicit && typeof explicit.records === 'function') return [explicit];
  return APPROVAL_LEDGERS;
}

/**
 * 参与"被批准对象"绑定的内容字段：只取**人类在审批时看到并认可的实质内容**。
 *
 * 刻意**排除**以下两类（否则绑定会误伤正常流程）：
 *   ① 自变状态：state / promotion / recallCount / lastRecalledAt / 审批痕迹自身；
 *   ② 审批后由**其它子系统**合法写入的机器验证簿记：`lastVerifiedAt`、`verificationEvidence`
 *      （`applyVerification()` 每次重新验证都会改写它们）——B1 的"审批粘性"要求
 *      APPROVED 经验重新验证后**保持 APPROVED**，若把它们纳入摘要，重新验证会反手
 *      把授权判废（实测已发生过：approval_content_changed），等于把 BLOCKER-1 换个入口复发。
 * `sourceEventSeqs` 必须纳入：它是经验"来自哪几轮真实对话"的回源锚点（AC1），
 * 审批后被改写即等于换了一个来源，人类认可的就不再是同一条经验。
 */
const APPROVAL_BOUND_FIELDS = Object.freeze([
  'id', 'title', 'body', 'tags', 'sourceEventSeqs', 'originSessionId', 'createdAt',
  'taskType', 'trigger', 'symptoms', 'rootCause', 'successfulMethod', 'failedOrUnsafeMethods',
  'applicableVersions', 'applicableEnvironment', 'sourceLinks', 'sourceCommit',
  'staleConditions', 'expiresAt', 'rollback',
]);

/** 被批准对象的确定性内容摘要（SHA-256）。审批后内容被改写 ⇒ 摘要变化 ⇒ 授权失效。 */
export function candidateDigest(exp) {
  if (!isPlainObject(exp)) return null;
  const pick = {};
  for (const k of APPROVAL_BOUND_FIELDS) pick[k] = exp[k] === undefined ? null : exp[k];
  return createHash('sha256').update(JSON.stringify(pick)).digest('hex');
}

/**
 * 从**官方会话日志**判定一次宿主人类批准是否真的发生过（唯一事实来源）。
 * 只认宿主 ApprovalService 写入的持久事件对；调用方（含 self-report）无法"声明"批准过。
 */
export function hostApprovalRecord(session, approvalRef) {
  if (!isPlainObject(session) || !Array.isArray(session.events)) return { ok: false, reason: 'no_session_log' };
  if (typeof approvalRef !== 'string' || !APPROVAL_REF_RE.test(approvalRef)) return { ok: false, reason: 'invalid_approval_ref' };
  let asked = null;
  let decided = null;
  for (const ev of session.events) {
    if (!isPlainObject(ev) || !isPlainObject(ev.data)) continue;
    if (ev.data.id !== approvalRef) continue;
    if (ev.type === 'approval/asked') asked = ev.data;
    else if (ev.type === 'approval/decided') decided = ev.data;
  }
  if (!asked) return { ok: false, reason: 'approval_ref_not_in_host_log' };
  if (asked.toolName !== HUMAN_APPROVAL_HOST_TOOL) return { ok: false, reason: 'approval_ref_tool_mismatch' };
  if (!decided) return { ok: false, reason: 'approval_undecided' };
  if (decided.outcome !== HUMAN_APPROVAL_GRANT) return { ok: false, reason: `approval_not_granted:${decided.outcome}` };
  // ★ F1（**事实内容绑定**）：人类作答的那次请求必须点名"被批准的内容摘要"。
  //   发起方（learn_review）把 candidateDigest 写进请求 reason，宿主 ApprovalService 原样
  //   落进 `approval/asked.reason`——于是**人类到底批的是哪份内容**这件事，由宿主日志本身
  //   作证，而不是由插件再说一遍。缺摘要 ⇒ 无法绑定对象（可能是一条旧事实被拿来复用）⇒ 拒。
  const digest = extractReasonDigest(asked.reason);
  if (!digest) return { ok: false, reason: 'approval_reason_not_content_bound' };
  return { ok: true, reason: 'ok', ref: approvalRef, digest };
}

/**
 * 唯一的 attestation 铸造点（**仅供 approve() 内部调用**；不对外导出 ⇒ 不存在第二个铸造面）。
 * 必须先通过①宿主日志事实校验，再向②持久审批台账追加 grant + consume（单次消费）；
 * 失败即拒绝铸造（返回错误码，绝不"降级为自述"）。
 */
function mintHumanApproval(exp, opts = {}) {
  const ledger = opts.ledger && typeof opts.ledger.append === 'function' ? opts.ledger : null;
  if (!ledger) return { ok: false, error: 'approval_ledger_unavailable' };
  const record = hostApprovalRecord(opts.session, opts.approvalRef);
  if (!record.ok) return { ok: false, error: `approval_not_host_proven:${record.reason}` };
  const digest = candidateDigest(exp);
  if (!digest) return { ok: false, error: 'approval_digest_unavailable' };
  // ★ 人类批准的那一刻，被问的就是**这份内容**吗？（防"拿一条旧批准去洗白别的内容"）
  if (record.digest !== digest) return { ok: false, error: 'approval_not_host_proven:host_log_digest_mismatch' };
  const at = Number.isSafeInteger(opts.at) && opts.at > 0 ? opts.at : Date.now();
  const hostSessionId = typeof opts.session?.id === 'string' && opts.session.id ? opts.session.id : null;
  // ② 人类批准事实落账（只有走到这里才会写台账；台账记录本身**不含**任何人类自述字段）。
  const granted = ledger.append({
    type: 'grant',
    schemaVersion: HUMAN_APPROVAL_LEDGER_SCHEMA,
    candidateId: exp.id,
    digest,
    approvedAt: at,
    trustedSource: HUMAN_APPROVAL_CHANNEL,
    hostActor: HUMAN_APPROVAL_ACTOR,
    approvalRef: record.ref,
    hostSessionId,
  }, { at });
  if (!granted.ok) return { ok: false, error: `approval_ledger_append_failed:${granted.reason}` };
  // ★ 单次消费标记：grant 未被消费 ⇒ 不构成授权；二次消费同一条 grant ⇒ 判废。
  const consumed = ledger.append({
    type: 'consume',
    recordId: granted.record.recordId,
    candidateId: exp.id,
    digest,
    consumedAt: at,
  }, { at });
  if (!consumed.ok) return { ok: false, error: `approval_ledger_append_failed:${consumed.reason}` };
  const base = {
    schema: HUMAN_APPROVAL_SCHEMA,
    channel: HUMAN_APPROVAL_CHANNEL,
    actor: HUMAN_APPROVAL_ACTOR,
    outcome: HUMAN_APPROVAL_GRANT,
    ref: record.ref,
    candidateId: exp.id,
    candidateDigest: digest,
    approvedAt: at,
    ledgerRecordId: granted.record.recordId,
  };
  return { ok: true, value: base };
}

/**
 * **持久结构 + 对象绑定**判定（不含进程内签章 ⇒ 可在载入/发布前判定）。
 * 用途：① `sanitizeExperience`/`isPublishable` 在**载入边界**拒绝"无 attestation 的 APPROVED"
 *（含 R1/R2 历史"自述审批"记录）；② `canPublish` 的第一道门。
 */
export function approvalProvenance(exp) {
  if (!isPlainObject(exp)) return { ok: false, reason: 'invalid_experience' };
  const att = isPlainObject(exp.approval) ? exp.approval : null;
  if (!att) return { ok: false, reason: 'approval_missing_host_attestation' };
  if (att.schema !== HUMAN_APPROVAL_SCHEMA) return { ok: false, reason: 'approval_schema_unknown' };
  if (att.channel !== HUMAN_APPROVAL_CHANNEL) return { ok: false, reason: 'approval_channel_untrusted' };
  if (att.actor !== HUMAN_APPROVAL_ACTOR) return { ok: false, reason: 'approval_actor_not_host' };
  if (att.outcome !== HUMAN_APPROVAL_GRANT) return { ok: false, reason: `approval_outcome_not_granted:${att.outcome}` };
  if (typeof att.ref !== 'string' || !APPROVAL_REF_RE.test(att.ref)) return { ok: false, reason: 'approval_ref_invalid' };
  if (att.candidateId !== exp.id) return { ok: false, reason: 'approval_candidate_mismatch' };
  if (typeof att.candidateDigest !== 'string' || !SHA256_HEX_RE.test(att.candidateDigest)) return { ok: false, reason: 'approval_digest_invalid' };
  if (!Number.isSafeInteger(att.approvedAt) || att.approvedAt <= 0) return { ok: false, reason: 'approval_timestamp_invalid' };
  if (typeof att.ledgerRecordId !== 'string' || !LEDGER_RECORD_ID_RE.test(att.ledgerRecordId)) return { ok: false, reason: 'approval_ledger_record_id_invalid' };
  if (typeof exp.approvedBy !== 'string' || exp.approvedBy !== HUMAN_APPROVAL_ACTOR) return { ok: false, reason: 'approval_actor_field_mismatch' };
  if (typeof exp.approvalEvidence !== 'string' || !exp.approvalEvidence) return { ok: false, reason: 'approval_missing_evidence' };
  if (exp.approvedAt !== att.approvedAt) return { ok: false, reason: 'approval_timestamp_mismatch' };
  const now = candidateDigest(exp);
  if (now !== att.candidateDigest) return { ok: false, reason: 'approval_content_changed' };
  return { ok: true, reason: 'ok' };
}

/**
 * **唯一 live authority**：这条经验是否确实由宿主通道上的人类批准过。
 * = 持久结构/对象绑定（`approvalProvenance`） + **持久审批台账**中的已消费 grant。
 *
 * 与 F1 R1 的差别（本轮规格要求）：
 *   · 旧实现靠"进程内 HMAC 密钥"，跨进程重启后签章不可验证 ⇒ 合法批准在重启后失效（违反 §8 A/C）；
 *   · 现实现靠"人类批准那一刻写入的落盘台账"，**同一台账**在重启后仍能验证 ⇒ A/C 成立；
 *     内容变化 / 换候选 / 重复消费 / 撤销 / 取代 / 台账断链 ⇒ 一律失效（fail-closed）。
 */
export function validHumanApproval(exp, ledger) {
  const structure = approvalProvenance(exp);
  if (!structure.ok) return structure;
  const ledgers = ledgersFor(ledger);
  if (ledgers.length === 0) return { ok: false, reason: 'approval_ledger_unavailable' };
  let first = null;
  for (const h of ledgers) {
    let recs;
    try { recs = h.records(); } catch { recs = null; }
    if (!Array.isArray(recs)) {
      // 台账读不出来（缺文件以外的 IO 故障 / 畸形行）⇒ 该台账判不可信，绝不"部分信任"。
      if (first === null) first = { ok: false, reason: 'approval_ledger_unreadable' };
      continue;
    }
    const verdict = approvalAuthorityFromLedger(recs, exp);
    if (verdict.ok) {
      // ★ 台账 ≠ authority：命中 grant 后还必须由**宿主事实**复核（见 makeHostFactVerifier）。
      //   缺复验器 ⇒ 拒（fail-closed）：否则"自己写一本台账"就等于自己发批准。
      const corroborated = corroborateHostFact(h, verdict.grant);
      if (corroborated.ok) return { ok: true, reason: 'ok' };
      if (first === null) first = corroborated;
      continue;
    }
    if (first === null) first = verdict;
  }
  return first ?? { ok: false, reason: 'approval_ledger_unavailable' };
}

/** 用**产生该 verdict 的那本台账**所挂的宿主事实复验器复核 grant（fail-closed）。 */
function corroborateHostFact(handle, grant) {
  const verify = handle && typeof handle.verifyHostFact === 'function' ? handle.verifyHostFact : null;
  if (!verify) return { ok: false, reason: 'approval_host_fact_unverifiable' };
  let v = null;
  try { v = verify(grant); } catch { v = null; }
  if (!v || v.ok !== true) {
    const reason = v && typeof v.reason === 'string' && v.reason ? v.reason : 'approval_host_fact_unreconciled';
    return { ok: false, reason };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * 审批来源完整性（B1 唯一 authority 的第三个必要条件）。
 *
 * 语义分工（R2 外部评审 BLOCKER-1 根因）：
 *   · `verification.status==='VERIFIED'` = **机器**用确定性证据证明了"任务结果"；
 *   · `state==='APPROVED'`               = **人**授权该经验离开会话本地作用域成为共享知识。
 * 二者**不可互相替代**：只有 VERIFIED 的经验仍是"本会话的结论"，绝不因此获得
 * 跨会话传播权（那正是"零人工审批经验被全新会话召回"这一 BLOCKER 的成因）。
 *
 * ★ F1（本轮修复）：审批痕迹的**授权来源**不再是调用方自由文本（旧的
 * `approvedBy`/`approvalEvidence` 自述即可通过），而是 §22-bis 的宿主事实 attestation。
 * 本函数已收敛为 `approvalProvenance()`（持久结构 + 对象绑定），见上节定义——
 * 历史"自述审批"记录（无 `approval` attestation）在此**结构性**判废，
 * 因此任何含此类条目的全局库在载入时即被整体拒绝（保持"绝不部分信任"不变量）。
 */

/**
 * 单条经验是否满足"可进全局库"的全部硬条件（唯一判定入口，publish 与 validate 共用）。
 *
 * ★ B1：**唯一授权** = APPROVED（人工授权） **且** verification.status===VERIFIED（机器证据）
 *   **且** 审批来源完整。VERIFIED alone ≠ 全局可召回；APPROVED alone（未 VERIFIED）同样拒。
 * 因此 `validateGlobalStore` 在**载入时**即 fail-closed 拒绝任何缺审批的条目（含历史
 * VERIFIED_EXPERIENCE-only 条目）——载入被判废、由调用方重建，绝不"部分信任"。
 */
export function isPublishable(exp) {
  if (!isPlainObject(exp)) return false;
  if (exp.state !== 'APPROVED') return false;                  // ★ 人工授权是唯一出口
  if (!approvalProvenance(exp).ok) return false;               // ★ 审批来源必须完整
  const ver = isPlainObject(exp.verification) ? exp.verification : null;
  if (!ver || ver.status !== 'VERIFIED') return false;
  if (!VERIFICATION_METHODS.includes(ver.method)) return false;
  if (!isPlainObject(ver.evidence)) return false;
  if (!Number.isSafeInteger(exp.lastVerifiedAt) || exp.lastVerifiedAt <= 0) return false;
  if (!Array.isArray(exp.sourceEventSeqs) || exp.sourceEventSeqs.length === 0) return false;
  return true;
}

/**
 * 可发布性判定 + 可读原因（"为什么被拒"必须可解释，不留静默死路径）。
 *
 * ★ B1 授权门（唯一 authority）：全局发布/全局召回**同时**要求
 *   ① `state==='APPROVED'`（人工授权离开会话本地作用域）
 *   ② `verification.status==='VERIFIED'`（确定性机器证据证明任务结果）
 *   ③ 审批来源完整（approver + evidence + 时间戳）
 *   任意一项缺失 ⇒ DENY。判定顺序保证"被拒原因"指向真正缺的那一项。
 */
export function canPublish(exp, ledger) {
  if (!isPlainObject(exp)) return { ok: false, reason: 'invalid_experience' };
  if (exp.state === 'PROPOSED') return { ok: false, reason: 'proposed_never_published' };
  if (exp.state === 'REJECTED') return { ok: false, reason: 'rejected_never_published' };
  if (exp.state === 'RETIRED') return { ok: false, reason: 'retired_never_published' };
  // ★ ① 人工授权：VERIFIED_EXPERIENCE（= 机器验证通过但无人审批）绝不可发布。
  //   这是"human approval is the only route by which an Experience becomes
  //   cross-session reusable"在**代码**上的落点（不是靠文档措辞）。
  if (exp.state !== 'APPROVED') return { ok: false, reason: `not_human_approved:${exp.state}` };
  const ver = isPlainObject(exp.verification) ? exp.verification : null;
  // ★ ② 确定性验证：仅有审批、没有机器证据同样拒（APPROVED alone ≠ publishable）。
  if (!ver || ver.status !== 'VERIFIED') return { ok: false, reason: `not_verified:${ver ? ver.status : 'missing'}` };
  if (!VERIFICATION_METHODS.includes(ver.method)) return { ok: false, reason: 'method_not_machine_checkable' };
  if (!isPlainObject(ver.evidence)) return { ok: false, reason: 'no_evidence_record' };
  if (!Number.isSafeInteger(exp.lastVerifiedAt) || exp.lastVerifiedAt <= 0) return { ok: false, reason: 'no_last_verified_at' };
  // ★ ③ 内容级硬约束（回源锚点 / 有界性 / 密钥红线）。
  //   刻意排在"live 人类批准"之前：attestation 的对象绑定会让**任何**内容改动都判废
  //   （approval_content_changed），若把内容级检查放在其后，这些更具体的拒绝原因就会被
  //   绑定错误掩盖（"为什么被拒"指向错的那一项）。此处全部是 DENY 分支，
  //   调整顺序只改变**可读原因**，不改变"什么能通过"（通过集合完全一致）。
  if (!Array.isArray(exp.sourceEventSeqs) || exp.sourceEventSeqs.length === 0) return { ok: false, reason: 'no_provenance_anchors' };
  const json = JSON.stringify(exp);
  if (json.length > MAX_EXPERIENCE_JSON_BYTES) return { ok: false, reason: 'record_too_large' };
  if (containsSecret(json)) return { ok: false, reason: 'contains_secret' };
  // ★ ④ 审批来源完整（可审计）+ **live 人类批准**（F1）：畸形/失效审批痕迹一律拒；
  //   仅有"结构上像审批"的痕迹（手写文件伪造、台账里不存在的批准）同样拒——
  //   发布动作必须坐落在**持久审批台账中真实落账的人类批准**之上。
  const ap = validHumanApproval(exp, ledger);
  if (!ap.ok) return { ok: false, reason: ap.reason };
  return { ok: true, reason: 'verified_approvable_experience' };
}

/**
 * 全局库校验（fail-closed）：结构不符 / 含未验证条目 / 重复 id / 超界 / 含密钥 ⇒ 整体判废。
 * 绝不"部分信任"——一个坏条目就让整库不可用，由调用方重建（并留 GLOBAL_REJECTED 痕迹）。
 */
export function validateGlobalStore(raw) {
  try {
    if (!isPlainObject(raw)) return null;
    if (raw.schemaVersion !== GLOBAL_STORE_SCHEMA_VERSION) return null;
    if (raw.kind !== GLOBAL_STORE_KIND) return null;
    if (!Number.isSafeInteger(raw.version) || raw.version < 0) return null;
    if (!Array.isArray(raw.experiences)) return null;
    if (raw.experiences.length > MAX_GLOBAL_EXPERIENCES) return null;
    if (!Array.isArray(raw.telemetry)) return null;
    if (raw.telemetry.length > MAX_TELEMETRY) return null;
    const seen = new Set();
    for (const e of raw.experiences) {
      if (!isPublishable(e)) return null;          // ★ 全局库**只**含已验证条目
      if (sanitizeExperience(e).error) return null;
      if (seen.has(e.id)) return null;
      seen.add(e.id);
      const json = JSON.stringify(e);
      if (json.length > MAX_EXPERIENCE_JSON_BYTES) return null;
      if (containsSecret(json)) return null;
    }
    for (const t of raw.telemetry) {
      if (!isPlainObject(t) || typeof t.kind !== 'string' || !TELEMETRY_KINDS.includes(t.kind)) return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/** 内容签名：同一条经验在不同会话被重复学出时用于**去重**（不让全局库被同义条目淹没）。 */
export function publishSignature(exp) {
  if (!isPlainObject(exp)) return '';
  return stableHash(`${exp.taskType ?? ''}|${exp.title}|${exp.successfulMethod ?? ''}`);
}

/**
 * 发布到全局库：**确定性 + 幂等 + 去重 + 密钥安全 + 有界**。
 * 未验证 / 未批准 / 超界 / 含密钥 ⇒ 拒绝并给出可读原因（调用方必须留遥测痕迹）。
 */
export function publishToGlobal(global, exp, opts = {}) {
  const g = isPlainObject(global) && Array.isArray(global.experiences) && global.kind === GLOBAL_STORE_KIND
    ? global : emptyGlobalStore();
  const at = Number.isSafeInteger(opts.at) && opts.at > 0 ? opts.at : 0;
  const verdict = canPublish(exp, opts.ledger);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, value: g };
  const idx = g.experiences.findIndex((e) => e.id === exp.id);
  if (idx >= 0) {
    const existing = g.experiences[idx];
    if (JSON.stringify(existing) === JSON.stringify(exp)) {
      return { ok: true, idempotent: true, value: g, experience: existing };
    }
    if ((exp.lastVerifiedAt ?? 0) >= (existing.lastVerifiedAt ?? 0)) {
      const next = [...g.experiences];
      next[idx] = exp;
      return { ok: true, updated: true, value: { ...g, experiences: next, version: g.version + 1, updatedAt: at }, experience: exp };
    }
    return { ok: false, reason: 'stale_overwrite_denied', value: g };
  }
  const sig = publishSignature(exp);
  const dup = g.experiences.find((e) => publishSignature(e) === sig && (e.lastVerifiedAt ?? 0) >= (exp.lastVerifiedAt ?? 0));
  if (dup) return { ok: true, deduplicated: true, value: g, experience: dup };
  if (g.experiences.length >= MAX_GLOBAL_EXPERIENCES) return { ok: false, reason: 'global_store_full', value: g };
  const next = [...g.experiences, exp].sort((a, b) =>
    ((b.lastVerifiedAt ?? 0) - (a.lastVerifiedAt ?? 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ok: true, published: true, value: { ...g, experiences: next, version: g.version + 1, updatedAt: at }, experience: exp };
}

/** 从全局库召回（= 跨会话复用面）。复用 recall 的唯一实现，不另建第二套打分器。 */
export function globalRecall(globalStore, query, opts = {}) {
  const empty = emptyStore('__global__');
  return recall(empty, query, { ...opts, global: globalStore });
}

// ═════════════════════════════════════════════════════════════════════════════
// 15. §19 旧库迁移：v1 → v2，**默认 historical/unverified**（绝不批量升级为已验证）
// ═════════════════════════════════════════════════════════════════════════════

/**
 * 把 v1（R1/R2 形态）会话本地库迁移到 v2。
 * 纪律（§19）：旧数据的审批结论仍然有效（那是**人工**决定，不因 schema 变更而作废），
 * 但**验证状态一律为 UNVERIFIED**——除非有现成的机器可校验证据能在之后被真实验证。
 * 本函数**不会**、也不允许把任何条目升级成 VERIFIED。
 */
export function migrateStoreV1(raw) {
  if (!isPlainObject(raw) || raw.schemaVersion !== 1) return null;
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) return null;
  if (!Array.isArray(raw.experiences) || raw.experiences.length > MAX_EXPERIENCES) return null;
  const experiences = [];
  for (const e of raw.experiences) {
    if (!isPlainObject(e)) return null;
    const upgraded = {
      ...contractFieldsFromDraft({}),
      ...e,
      verification: emptyVerification(),   // ★ 绝不继承、绝不推断"已验证"
      lastVerifiedAt: null,
      verificationEvidence: null,
      migratedFromV1: true,
    };
    // 迁移后仍必须满足全部不变量（含 APPROVED 需审批人+证据）
    if (sanitizeExperience(upgraded).error) return null;
    experiences.push(upgraded);
  }
  return {
    schemaVersion: LEARN_SCHEMA_VERSION,
    sessionId: raw.sessionId,
    version: 0,
    experiences,
    telemetry: Array.isArray(raw.telemetry) ? raw.telemetry : [],
    updatedAt: Number.isSafeInteger(raw.updatedAt) ? raw.updatedAt : 0,
  };
}
