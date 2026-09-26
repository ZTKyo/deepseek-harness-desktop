// learn.mjs —— P4 LEARN R1 插件壳（IO / 钩子 / 工具面）
//
// 定位（唯一职责）：把**真实原始会话**里出现过的失败/纠正/成功模式，提炼成**可复用的经验条目**，
// 并在**人工审批之后**允许其被确定性召回。仅此三件事。
//
// Authority 契约（不可破坏）：
//   - Official Session = 唯一 Truth Source。经验必须携带 sourceEventSeqs 官方回源锚点；
//     抽取一律复用 P2.5 官方提取器（learn-core 直接 import context-memory-core），
//     本插件内**不存在**第二个 raw-session parser。
//   - 提案 ≠ 激活：钩子自动产出的候选经验永远是 PROPOSED，永远不可被召回；
//     只有显式 `learn_review`（需审批人 + 证据）才可能变成 APPROVED。
//   - 绝不自动晋升：`promotionEligibility` 只做资格判定，`learn_promote` 必须显式调用且带证据。
//   - 绝不成为第二状态源：不读写 goal / autonomy / EC / router / compaction 任何状态；
//     不调用 compactNow、不发 recovery-requirement、不改任何路由字段。
//   - 写入边界：只写 cfg.stateDir 下的经验库（assertWriteAllowed 白名单）；
//     runtime-state / goals / credentials / policy 一律拒绝。
//   - Fail-open：任何内部错误只静默跳过本轮学习，任务永不因学习问题停止；
//     经验库损坏/结构不符 → validateStore 返回 null → 重建为空库（绝不在坏状态上继续）。
//
// 单开关：config.enabled=false 或环境变量 LEARN_DISABLED=true ⇒ 不注册任何钩子。
// 删除挂载行即整体回滚（零数据迁移、零 schema 变更）。
//
// 零第三方依赖（node:std only + 本仓库纯核心模块）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  LEARN_SCHEMA_VERSION,
  emptyStore,
  validateStore,
  propose,
  approve,
  reject,
  retire,
  recall,
  recordRecall,
  promotionEligibility,
  promote,
  assertWriteAllowed,
  telemetryEvent,
  appendTelemetry,
  telemetrySummary,
  buildLearnDigest,
  learningSignals,
  gapVetoGate,
  redactSecrets,
  containsSecret,
  stableHash,
  MAX_TITLE_LEN,
  // R2 STAGE 8.5：结构化工具事实抽取（AC5 能力缺口的唯一 P2.6 域外证据源）
  extractToolOutcomes,
  unresolvedToolFailures,
  // ── P4 R2 CONTRACT COMPLETION：验证 / 适用性 / Layer B 全局已验证库 ──
  emptyVerification,
  normEvidence,
  isApplicableNow,
  applyVerification,
  recordReuseOutcome,
  canPublish,
  publishToGlobal,
  validateGlobalStore,
  emptyGlobalStore,
  publishSignature,
  isPublishable,
  migrateStoreV1,
  GLOBAL_STORE_SCHEMA_VERSION,
  // ── F1：宿主人类批准边界（唯一授权来源；见 learn-core.mjs §22-bis）──
  attachApprovalLedger,
  detachApprovalLedger,
  APPROVAL_LEDGER_FILE,
  parseApprovalLedgerText,
  serializeApprovalRecord,
  makeApprovalRecord,
  verifyApprovalLedgerChain,
  candidateDigest,
  validateApprovalEvidence,
  // F1 R1：宿主事实复验器（台账**不是** authority；判授权点必须用宿主日志复核 grant）
  makeHostFactVerifier,
  HUMAN_APPROVAL_ACTOR,
  HUMAN_APPROVAL_CHANNEL,
  HUMAN_APPROVAL_GRANT,
  HUMAN_APPROVAL_HOST_TOOL,
  validHumanApproval,
  isRecallable,
  // ── F2：sessionStoreMaxFiles 的最小受支持值 + 纯校验函数（见 learn-core.mjs §F2）──
  MIN_SESSION_STORE_MAX_FILES,
  SESSION_STORE_MAX_FILES_MIN_DIAGNOSTIC,
  validateSessionStoreMaxFiles,
} from './learn-core.mjs';

// R2 AC5：失败分类的**唯一 Authority** 是 P2.6。本插件不自建分类逻辑，
// 只调用它的分类器 + 本仓库的否决闸门（learn-gap-veto.mjs）。
import {
  evaluateGapVeto, VETO_REASON,
  // R2 STAGE 8.5：能力缺口资格判定（Capability-Gap Qualification Adapter）
  // R2 STAGE 2：额外需要适配器版本号——被否决的能力缺口留痕时要写明判定版本（可追溯）。
  qualifyGap, capabilitySignature, REPEAT_THRESHOLD, CAPABILITY_ADAPTER_VERSION,
} from './learn-gap-veto.mjs';

// R2 STAGE 8.5：合格能力缺口 → 候选。**复用** R2 STAGE 6-7 的候选生命周期，
// 不新建第二套候选/自主研究机制（合同禁止重复系统）。
import { proposeCandidate, rejectCandidate, emptyCandidateStore } from './learn-candidate.mjs';

export const name = 'learn';
// The production web host exposes the tool registry through Cordis injection.
// Without this declaration, the first ctx.tools property access aborts host boot.
export const inject = ['tools'];

const DEFAULTS = {
  enabled: true,
  // 自动候选（PROPOSED，永不可召回）需要的最小真实轮次与信号门槛
  minTurnsForLearning: 4,
  minNewNodes: 4,             // 防每步抖动：新节点达到该值才尝试提炼
  maxDigestTurns: 40,         // 单次摘要最多纳入的真实轮次（bounded）
  autoPropose: true,          // 自动产出**候选**（不是激活）；false 则只能由工具显式提案
  stateDir: path.join(process.env.LOCALAPPDATA || os.homedir(), 'DSHHarness', 'state', 'learn'),
  // ── Layer B：跨会话「全局已验证经验库」──────────────────────────────────
  // 与 Layer A（会话本地库）**分开文件存放**：合同禁止把所有内容混进一个大 store。
  // 只有"通过确定性验证 + 已批准"的经验才可能进入；载入 fail-closed。
  globalStorePath: null,      // null ⇒ 取 stateDir 下的 _global-verified.json
  allowGlobalPublish: true,   // 可整体关闭跨会话发布（关闭后 Layer B 只读）
  // ── B2（R2 外部评审 BLOCKER-2）：会话本地派生状态的保留策略（有界，长期运行必需）──
  //
  // 语义边界（**必须**区分两层，绝不可混）：
  //   · session-local 临时态（Layer A 的 per-session 文件）= 可 expire / evict / 重建的**派生投影**；
  //   · Global VERIFIED+APPROVED 经验（Layer B）= **绝不**因会话清理被自动删除。
  //   清理只作用于 cfg.stateDir 下的 Layer A 文件，且逐文件做路径校验 + Global Store 排除。
  //
  // 取值依据：仓库内此前**没有**针对 learn 会话文件的 retention 数值；本插件既有的
  // per-session **内存**上限口径是 `MAX_TRACKED_SESSIONS = 64`（见 §15），磁盘口径沿用
  // 同一"有界但足够宽"的保守思路并放大到 200（单会话文件实测最大 456 KB ⇒ 200 × ~0.5 MB
  // ≈ 100 MB 上界，对桌面长期运行可接受），TTL 取 30 天（≥ 常规"一个月内还可能要回溯"
  // 的窗口，且远大于本插件自动候选所需的会话活跃期）。两项均可由环境变量覆盖。
  sessionStoreMaxFiles: 200,  // env LEARN_SESSION_STORE_MAX_FILES
  sessionStoreTtlDays: 30,    // env LEARN_SESSION_STORE_TTL_DAYS
};

// F1：单次载入最多留痕多少条"持久化审批在本进程不可验证"（APPROVAL_EXPIRED）——
// 有界，防止一个被塞满的历史库把遥测刷爆；留痕数量本身不构成任何授权。
const MAX_APPROVAL_EXPIRED_NOTICES = 8;

// dsh-tools 只在 web host plane 可用（secret-gate / execution-continuity 先例）；
// 从 repo 直接 import 本文件时解析失败 → 工具面禁用，钩子与召回路径照常（fail-open）。
let defineTool = null;
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
} catch {
  // defineTool stays null → tool registration skipped in apply().
}

function sanitizeFileId(sid) {
  const s = String(sid ?? 'unknown');
  const safe = s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  // R3 根因修复：清洗与截断都会撞名（'a b' vs 'a_b'；超长 sid 截断到 120 后同名）。撞名会让
  // 两个会话共用一个库文件并互相覆盖（互相丢数据）——仅靠 loadStore 的归属守卫只能拒绝载入、
  // 不能避免覆盖。故在"清洗确实改变了原 sid"时追加原 sid 的短哈希以消除撞名；
  // 未被改动的常规 sessionId（如 session-<uuid>）文件名保持原样 ⇒ 对既有库文件零迁移影响。
  if (safe === s) return safe;
  return `${safe}-${stableHash(s).slice(0, 8)}`;
}

/** 单行化 + 截断（用于从真实发言派生标题）。 */
function oneLine(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * F1：取**宿主刚写入**的那条人类批准事件 id（`approval/asked` 的 `data.id`）。
 *
 * 宿主 `ApprovalService.request()` 的顺序是：append `approval/asked` → 等 answerer →
 * append `approval/decided` → 返回 outcome。所以本函数被调用时，事件对**必然已完整**。
 * 匹配口径与宿主 apiproxy answerer 一致（按 `callId` 对齐，缺失即 null）；
 * 只认**已成对**的 asked（未决的 asked 属于并发的其它请求，不能当作本次授权）。
 * 拿不到 id ⇒ 授权来源不可绑定 ⇒ 上层 fail-closed。
 */
function lastHostApprovalRef(session, callId) {
  const events = session?.events;
  if (!Array.isArray(events)) return null;
  const decided = new Set();
  let fallback = null;   // 已配对、工具名正确、但 callId 不可比（宿主有值而 exec 没有）⇒ 备选
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (!ev || typeof ev.type !== 'string' || !ev.data) continue;
    if (ev.type === 'approval/decided') {
      if (typeof ev.data.id === 'string') decided.add(ev.data.id);
      continue;
    }
    if (ev.type !== 'approval/asked') continue;
    const id = ev.data.id;
    if (typeof id !== 'string' || !id) continue;
    if (ev.data.toolName !== HUMAN_APPROVAL_HOST_TOOL) continue;   // 只认本工具发起的那次
    if (!decided.has(id)) continue;                               // 未决的 asked 不构成授权
    const askedCallId = ev.data.callId ?? null;
    if (askedCallId === (callId ?? null)) return id;              // 精确对齐（与宿主 answerer 同口径）
    if (fallback === null) fallback = id;
  }
  return fallback;
}

/**
 * 持久审批台账句柄（文件适配层；链式/单次消费等**纯逻辑**都在 learn-core 中，
 * 本层只做"读文件 / 追加一行"，不引入第二套授权判定）。
 *
 * 文件：`<stateDir>/_human-approvals.jsonl`（append-only：一行一条记录，**绝不原地改写**，
 * 因此不需要原子替换/临时文件；同进程与跨进程重复追加都以 O_APPEND 语义落行）。
 * fail-closed：文件读不到 / 有畸形行 ⇒ 本台账判不可信（`records()` 抛出），绝不"部分信任"。
 */
function createFileApprovalLedger(file) {
  const abs = path.resolve(file);
  let cache = null;        // null ⇒ 尚未加载或加载失败
  let loadError = null;
  const load = () => {
    if (cache) return cache;
    try {
      const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      const parsed = parseApprovalLedgerText(text);
      if (!parsed.ok) { loadError = parsed.reason; cache = null; return null; }
      cache = parsed.records;
      return cache;
    } catch (err) {
      loadError = `ledger_read_failed:${err?.code ?? err?.message ?? 'unknown'}`;
      cache = null;
      return null;
    }
  };
  return {
    id: `file:${abs}`,
    file: abs,
    records() {
      const recs = load();
      if (recs === null) throw new Error(loadError ?? 'ledger_unreadable');
      return recs;
    },
    integrity() {
      try { return verifyApprovalLedgerChain(this.records()); } catch (err) { return { ok: false, reason: String(err?.message ?? err) }; }
    },
    append(body) {
      const recs = load();
      if (recs === null) return { ok: false, reason: loadError ?? 'ledger_unreadable' };
      const made = makeApprovalRecord(recs, body);
      if (!made.ok) return made;
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.appendFileSync(abs, serializeApprovalRecord(made.record), { encoding: 'utf8' });
      } catch (err) {
        return { ok: false, reason: `ledger_write_failed:${err?.code ?? err?.message ?? 'unknown'}` };
      }
      cache = recs.concat([made.record]);
      return { ok: true, record: made.record };
    },
  };
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  // B2：保留策略可配置（环境变量优先，其次 config，最后保守默认）。非法值回落到默认。
  const envPosInt = (name, fallback, min) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && Number.isInteger(n) && n >= min ? n : fallback;
  };
  cfg.sessionStoreTtlDays = envPosInt('LEARN_SESSION_STORE_TTL_DAYS', cfg.sessionStoreTtlDays, 0);
  const diag = (m) => { try { ctx.logger?.info?.(`[learn] ${m}`); } catch {} };
  const warn = (m) => { try { ctx.logger?.warn?.(`[learn] ${m}`); } catch {} };

  // ★ F2（R2 外部评审）：`sessionStoreMaxFiles` 的**下限**是一次真实的 config validation。
  //
  // 此前下限写作 `1` ⇒ `LEARN_SESSION_STORE_MAX_FILES=63` 被**静默接受**（实测：三值 63/64/65
  // 均无任何校验痕迹）。但如 `learn-core` 的 `validateSessionStoreMaxFiles` 所述，limit<64
  // 时该数字**不可能被兑现**（活跃集 LRU 上限 64），静默接受等于一句假承诺。
  //
  // 语义（fail-loud，非 fail-silent）：
  //   · 取值合法（≥64 的整数）→ 原样采用；
  //   · 取值非法 → 判为 **config validation failure**：把诊断文本真实写进 `ctx.logger.warn`
  //     并计入本实例的 `configValidationLog()`（可被测试/运维取证），随后才把有效值落到
  //     **最小受支持值 64**。请求过的值**被拒绝**——诊断里逐字写明这件事，绝不静默钳制。
  const configValidationLog = [];
  const noteConfigValidation = (diagnostic) => {
    configValidationLog.push(diagnostic);
    warn(diagnostic);
  };
  const readSessionStoreMaxFiles = () => {
    const rawEnv = process.env.LEARN_SESSION_STORE_MAX_FILES;
    const fromEnv = rawEnv !== undefined && rawEnv !== '';
    const requested = fromEnv ? rawEnv : cfg.sessionStoreMaxFiles;
    const verdict = validateSessionStoreMaxFiles(requested);
    if (verdict.ok) return verdict.value;
    noteConfigValidation(
      `${fromEnv ? 'LEARN_SESSION_STORE_MAX_FILES' : 'config.sessionStoreMaxFiles'}: ${verdict.diagnostic}; `
      + `effective sessionStoreMaxFiles = ${MIN_SESSION_STORE_MAX_FILES} (minimum supported)`,
    );
    return MIN_SESSION_STORE_MAX_FILES;
  };
  cfg.sessionStoreMaxFiles = readSessionStoreMaxFiles();

  // ── F1：宿主人类批准边界（唯一授权来源）────────────────────────────────
  //
  // 复用**宿主已有**的审批通道（Cordis `approval` 服务 → `approval/request` 瀑布 →
  // 人类作答 → 宿主把 `approval/asked` / `approval/decided` 写进官方会话日志），
  // **不新建第二套审批机制**（合同禁止重复系统；本仓库亦已有 user-approval 服务与 GUI 审批面）。
  //
  // 关键点：本插件只负责"发起一次真实的人类批准请求并拿到宿主 outcome"；
  // 授权凭据的**事实来源**是宿主写下的会话日志事件对（由 learn-core 的
  // `hostApprovalRecord()` 读取），因此即使插件代码被改写成"直接声明批准过"也无法产生授权。
  //
  // fail-closed 覆盖的四种情形（任何一种都 ⇒ 不产生 APPROVED）：
  //   · 部署中没有 approval 服务（ctx.get('approval') === undefined）→ unavailable；
  //   · 会话审批策略为 never（宿主 decide() 直接返回 rejected）→ rejected；
  //   · 没有可用 answerer（无人应答，宿主返回 unavailable）→ unavailable；
  //   · 人类拒绝 / 取消 → rejected / cancelled。
  // 另：把**内容摘要**（而非正文）作为 reason 送进宿主审计日志，避免正文/密钥进宿主日志。
  //
  // ★ F1 R1 修正：授权凭据不再是"进程内密钥签章"，而是**人类批准那一刻落账的持久台账**
  //   （<stateDir>/_human-approvals.jsonl）。因此：
  //     · 同一台账在进程重启后仍能验证合法批准 ⇒ §8 A/C 成立（重启不再把已批记录作废）；
  //     · 台账文件位于 stateDir 之内（结构自检，越界即 fail-closed 不挂载）；
  //     · 多实例/热重载：台账按**文件绝对路径**去重挂载，同一 stateDir 重挂不会作废既有批准。
  const approvalLedgerFile = path.resolve(cfg.stateDir, APPROVAL_LEDGER_FILE);
  // ★ F1 R1 信任锚：台账文件可被"自行追加"（链式摘要挡改写/删除，挡不住追加伪造），
  //   因此每次授权判定都必须用**宿主侧事实**复核命中的 grant —— 宿主自己写下的
  //   approval/asked+decided 事件对（含"人类当时被问的是哪份内容"的摘要）。
  //   读取口径与 execution-continuity 的 WAIT-GATE 完全一致：ctx.sessions.get(sid)，
  //   服务不可用 / 会话取不到 ⇒ 复验器判不可复验 ⇒ 授权 fail-closed 拒绝。
  //
  //   ★ R2 修复（2026-09-26 生产事故，根因）：`sessions` **不在本插件的 inject 声明里**
  //   （只 inject `tools`），而 Cordis 在按 inject 装载插件时会安装"服务访问守卫"——
  //   对**未注入服务的裸属性访问**直接抛 `cannot get property "sessions" without inject`
  //   （不是返回 undefined）。原写法 `!!(ctx.sessions && ...)` 里那个"防御式判空"
  //   **本身就抛错**，且发生在 apply 期 ⇒ **整棵 profile boot 失败、服务起不来**
  //   （生产实测：每次带本插件的启动都失败，日志 270 次，重启事务连续 83 次 FAILED）。
  //
  //   修法：与下方 `ctx.get?.('approval')` 完全同一惯例，改为**不抛错**的可选服务取值
  //   （`ctx.get(name)` 在无该服务时返回 undefined，已是本项目测试内的既有口径）。
  //   语义不变：取不到服务 ⇒ sessionsServiceAvailable=false ⇒ 复验器不可用 ⇒ 授权 fail-closed。
  //   刻意**不**把 `sessions` 写进 inject：本插件按设计容许宿主没有该服务（fail-closed 降级），
  //   写进 inject 会把"可选降级"升级为 boot 期硬依赖（对照 execution-continuity 曾因把
  //   compaction 写进 inject 造成 boot 硬依赖而被回退的历史处置）。
  const lookupSessionsService = () => {
    try {
      return (typeof ctx.get === 'function' ? ctx.get('sessions') : null) ?? null;
    } catch { return null; }
  };
  const sessionsServiceAvailable = (() => {
    const svc = lookupSessionsService();
    return !!(svc && typeof svc.get === 'function');
  })();
  const hostSessionById = (sid) => {
    try {
      const svc = lookupSessionsService();
      if (!svc || typeof svc.get !== 'function') return null;
      return svc.get(sid) ?? null;
    } catch { return null; }
  };
  const approvalLedger = (() => {
    const root = path.resolve(cfg.stateDir);
    if (path.dirname(approvalLedgerFile) !== root) {
      warn(`approval ledger path escapes stateDir (${approvalLedgerFile}); human approval disabled (fail-closed)`);
      return null;
    }
    const h = createFileApprovalLedger(approvalLedgerFile);
    // 复验器随台账一起挂载（判定点用"产生该 verdict 的那本台账"的复验器，见 validHumanApproval）。
    h.verifyHostFact = makeHostFactVerifier(hostSessionById);
    attachApprovalLedger(h);
    return h;
  })();
  diag(`human approval ledger = ${approvalLedger ? approvalLedgerFile : 'UNAVAILABLE (fail-closed)'}`
    + `｜host fact re-verification = ${approvalLedger && typeof approvalLedger.verifyHostFact === 'function' ? 'wired (ctx.sessions)' : 'UNAVAILABLE (fail-closed)'}`);

  const approvalService = () => {
    try { return ctx.get?.('approval') ?? null; } catch { return null; }
  };

  /**
   * 向宿主人类批准通道发起**一次真实请求**，并把 outcome 映射为 fail-closed 结果。
   * 返回 { ok, outcome, approvalRef, error }；只有 `allowed-once` 才是授权。
   */
  async function requestHumanApproval(exec, { toolName, reason }) {
    const svc = approvalService();
    if (!svc || typeof svc.request !== 'function') {
      return { ok: false, outcome: 'unavailable', approvalRef: null, error: 'approval_unavailable:no_host_approval_service' };
    }
    if (!exec || !exec.agent || !exec.agent.session) {
      // 没有可挂载宿主事实的会话 ⇒ 绝不放行（也就没有可审计的批准来源）。
      return { ok: false, outcome: 'unavailable', approvalRef: null, error: 'approval_unavailable:no_agent_session' };
    }
    let outcome;
    try {
      outcome = await svc.request({
        agent: exec.agent,
        toolName,
        ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
        reason,
        ...(exec.signal ? { signal: exec.signal } : {}),
      });
    } catch (err) {
      return { ok: false, outcome: 'unavailable', approvalRef: null, error: `approval_request_failed:${err?.message ?? String(err)}` };
    }
    if (outcome !== HUMAN_APPROVAL_GRANT) {
      return { ok: false, outcome: String(outcome), approvalRef: null, error: `approval_not_granted:${outcome}` };
    }
    // 宿主 `request()` 的顺序 = append `approval/asked` → decide → append `approval/decided`
    // → 返回 outcome；因此本行执行时事件对**必然已完整**。取与本次调用对齐（callId）
    // 的那条**已决** asked 的 id 作为 approvalRef。拿不到 ⇒ 授权来源不可绑定 ⇒ fail-closed。
    const ref = lastHostApprovalRef(exec.agent.session, exec.callId);
    if (!ref) {
      return { ok: false, outcome: String(outcome), approvalRef: null, error: 'approval_unavailable:host_fact_not_found' };
    }
    return { ok: true, outcome: String(outcome), approvalRef: ref, error: null };
  }

  // ── 单开关（EC 双通道惯例）──
  if (cfg.enabled === false || process.env.LEARN_DISABLED === 'true') {
    try { ctx.logger?.info?.('[learn] disabled by switch; not registering hooks'); } catch {}
    return {};
  }

  // ── 写入边界自检：stateDir 必须是学习白名单目标 ──
  // 经验库只允许写在自己的 stateDir 下；这里做一次结构性校验，拒绝明显越界配置。
  const stateDirCheck = assertWriteAllowed('experience-store');
  if (!stateDirCheck.allowed) {
    warn(`write boundary self-check failed (${stateDirCheck.reason}); not registering hooks`);
    return {};
  }

  const stores = new Map();     // sid -> store
  const watermarks = new Map(); // sid -> 已提炼到的表面节点 seq（防重复学习）

  // ═══════════════════════════════════════════════════════════════════════════
  // B2（R2 外部评审 BLOCKER-2）：进程内 per-session 状态**有界**的唯一实现
  // ═══════════════════════════════════════════════════════════════════════════
  // 单一口径：所有 per-session Map 共用同一个上限与同一个 LRU 淘汰器（不另造第二套）。
  // 数值沿用本文件既有的 `MAX_TRACKED_SESSIONS = 64`（§15 能力缺口路径）——即仓库内
  // 已存在的 per-session 内存上限口径，不发明新数字。
  const MAX_IN_MEMORY_SESSIONS = 64;

  // 活跃会话保护集：最近通过 `agent/pre-step` 见到的会话。淘汰**永不**触碰它们。
  const activeSessions = new Set();
  function touchActive(sid) {
    if (typeof sid !== 'string' || !sid) return;
    activeSessions.delete(sid);
    activeSessions.add(sid);
    while (activeSessions.size > MAX_IN_MEMORY_SESSIONS) {
      const oldest = activeSessions.values().next().value;
      activeSessions.delete(oldest);
    }
  }

  /**
   * LRU 淘汰：Map 的插入序即"最近使用序"（命中时由调用方 delete+set 刷新）。
   * ★ 淘汰语义（严格）：**只丢弃内存缓存对象**，绝不 unlink / 绝不改写磁盘上已持久化的
   *   经验（所有 commit 都是 write-through；丢弃内存副本后 getStore 会惰性重载，
   *   数据不丢）。尤其**不得**顺带删除已持久化的 VERIFIED/APPROVED 经验。
   * @param {Map} map 目标 Map
   * @param {number} limit 上限
   * @param {Set<string>} [protect] 受保护键（活跃会话），永不被淘汰
   * @returns {number} 实际淘汰条数
   */
  function evictLRU(map, limit, protect) {
    if (!(map instanceof Map) || map.size <= limit) return 0;
    let removed = 0;
    for (const k of [...map.keys()]) {
      if (map.size <= limit) break;
      if (protect && protect.has(k)) continue;
      map.delete(k);
      removed += 1;
    }
    return removed;
  }

  /** 记忆 + 刷新最近使用序 + 立即维持上限（所有 `stores.set` 的唯一入口）。 */
  function rememberStore(sid, store) {
    stores.delete(sid);
    stores.set(sid, store);
    evictLRU(stores, MAX_IN_MEMORY_SESSIONS, activeSessions);
  }

  /** 水位/失败缓冲同口径有界（此前 watermarks 无界：长期运行会随会话数线性增长）。 */
  function touchWatermark(sid, seq) {
    watermarks.delete(sid);
    watermarks.set(sid, seq);
    evictLRU(watermarks, MAX_IN_MEMORY_SESSIONS, activeSessions);
  }
  function touchPendingFailures(sid, arr) {
    pendingFailures.delete(sid);
    pendingFailures.set(sid, arr);
    evictLRU(pendingFailures, MAX_IN_MEMORY_SESSIONS, activeSessions);
  }

  /** 测试/诊断用：真实内存结构大小（不是 getter 输出的投影）。 */
  function memoryFootprint() {
    return {
      limit: MAX_IN_MEMORY_SESSIONS,
      stores: stores.size,
      watermarks: watermarks.size,
      pendingFailures: pendingFailures.size,
      sessionCache: sessionCache.size,
      activeSessions: activeSessions.size,
      gapWatermarks: gapWatermarks.size,
      gapObservedKeys: gapObservedKeys.size,
      gapVetoedKeys: gapVetoedKeys.size,
      candidateStores: candidateStores.size,
    };
  }

  // ── R2 AC5：真实失败分类缓冲（唯一来源 = P2.6 Authority）──
  // 与 P2.6 监听**同一个** `agent/request-error` 事件、调用**同一个**分类器
  // （evaluateGapVeto → classifyFailureV1）。这不是第二套分类器，是同一 Authority 的第二个消费者。
  // 有界：每会话最多 MAX_PENDING_FAILURES 条，超出丢弃最旧（防无界增长）。
  const pendingFailures = new Map(); // sid -> Array<{classification, normalizedSignature, vetoed, vetoReason, at}>
  const MAX_PENDING_FAILURES = 64;

  function recordFailure(payload) {
    const sid = payload?.agent?.session?.id || '';
    if (!sid) return;
    let verdict;
    try {
      verdict = evaluateGapVeto(payload?.failure, {
        provider: typeof payload?.provider === 'string' ? payload.provider : '',
        model: payload?.model || payload?.resolved?.model || '',
      });
    } catch (e) {
      // fail-closed：分类本身出错也必须视为"已否决"，绝不能因为分类器异常就放行
      verdict = {
        vetoed: true, reason: VETO_REASON.MISSING_CLASSIFICATION,
        classification: '', normalizedSignature: '',
      };
      warn(`gap veto classify error (fail-closed as vetoed): ${e && e.message ? e.message : String(e)}`);
    }
    const arr = pendingFailures.get(sid) ?? [];
    arr.push({
      classification: verdict.classification,
      normalizedSignature: verdict.normalizedSignature,
      vetoed: verdict.vetoed === true,
      vetoReason: verdict.reason ?? null,
      at: Date.now(),
    });
    if (arr.length > MAX_PENDING_FAILURES) arr.splice(0, arr.length - MAX_PENDING_FAILURES);
    pendingFailures.set(sid, arr);
    evictLRU(pendingFailures, MAX_IN_MEMORY_SESSIONS, activeSessions);
    if (verdict.vetoed) {
      diag(`GAP-VETO sid=${sid} cls=${verdict.classification || '(none)'} reason=${verdict.reason} (no candidate will be produced for this window)`);
    }
  }

  // ── store 持久化（原子写 tmp+rename；损坏 → null → 重建，fail-closed）──
  function storePath(sid) { return path.join(cfg.stateDir, sanitizeFileId(sid) + '.json'); }
  function loadStore(sid) {
    try {
      const p = storePath(sid);
      if (!fs.existsSync(p)) return null;
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      const ok = validateStore(parsed);      // 结构不符/损坏 → null（绝不部分信任）
      if (!ok) return null;
      // R3 隔离守卫：库归属必须与请求方一致，否则 fail-closed 拒绝载入。
      // 实证（redteam-r3-isolation.mjs）：sanitizeFileId 会把 'probe session X' 与
      // 'probe_session_X' 映射到同一文件，超长 sid 截断到 120 后同样撞名；若无此守卫，
      // 后请求方会静默继承前一方的经验（跨会话污染），且不产生任何 STORE_REBUILT 告警。
      if (ok.sessionId !== sid) return null;
      return ok;
    } catch {
      return null;
    }
  }
  function saveStore(store) {
    try {
      fs.mkdirSync(cfg.stateDir, { recursive: true });
      const p = storePath(store.sessionId);
      const tmp = p + '.tmp-' + crypto.randomUUID();
      fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
      fs.renameSync(tmp, p);
      // B2：有界落盘——写入是唯一的"文件可能变多"时机，故在此节流触发保留策略。
      // 节流（每 PRUNE_EVERY_N_WRITES 次写入一次 readdir）避免每次写入都扫目录。
      if ((writesSincePrune += 1) >= PRUNE_EVERY_N_WRITES) {
        writesSincePrune = 0;
        pruneSessionStore();
      }
      return true;
    } catch {
      return false; // 持久化失败不影响内存态，更不阻塞任务
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // B2：会话本地派生状态的**磁盘**保留策略（有界 + 清理安全）
  // ═══════════════════════════════════════════════════════════════════════════
  // 清理安全性（硬约束，逐文件校验，绝不靠"调用方自觉"）：
  //   ① 只允许处理 cfg.stateDir **直接子目录**下的 `<sid>.json` 会话库文件；
  //   ② 绝不触碰 Global Verified Store（Layer B 文件按**绝对路径**显式排除）；
  //   ③ 绝不触碰官方会话（~/.dsh/sessions/**）、Harness raw history、评审证据或
  //      stateDir 之外的任何路径 —— 它们根本不在 readdir 结果里，且路径校验兜底；
  //   ④ 清理前复用既有写入白名单闸门 assertWriteAllowed（不另造第二套白名单）。
  const PRUNE_EVERY_N_WRITES = 16;
  let writesSincePrune = 0;

  /** 该文件名是否为"可清理的会话本地派生文件"（fail-closed：不确定即 false）。 */
  function isSessionLocalFile(name) {
    if (typeof name !== 'string' || !name || !name.endsWith('.json')) return false;
    if (name.includes('.tmp-')) return false;             // 原子写的中间文件不在此处理
    const root = path.resolve(cfg.stateDir);
    const full = path.resolve(root, name);
    if (path.dirname(full) !== root) return false;        // 防目录穿越 / 子目录
    if (full === path.resolve(globalPath)) return false;  // ★ 绝不删 Layer B 全局库
    return true;
  }

  function removeSessionFile(entry, report) {
    try {
      // 二次路径校验（fail-closed）：任何一条不满足就放弃删除，绝不"尽力而为"
      const root = path.resolve(cfg.stateDir);
      const full = path.resolve(entry.full);
      if (path.dirname(full) !== root) return;
      if (!isSessionLocalFile(entry.name)) return;
      fs.unlinkSync(full);
      report.removed += 1;
      report.removedIds.push(entry.sid);
    } catch { /* fail-open：清理失败绝不影响任务 */ }
  }

  /**
   * 会话文件保留策略：**active sessions + 最近 N 个已关闭会话 + TTL**。
   *   ① TTL：非活跃且 mtime 早于 now - TTL 的会话本地文件可被清理；
   *   ② 数量：active 全保留，其余按 mtime 新→旧保留至 sessionStoreMaxFiles。
   * 返回可审计报告（scan/removed/kept），供测试与诊断核对。
   */
  function pruneSessionStore(now = Date.now()) {
    const report = { ok: true, reason: 'ok', scanned: 0, removed: 0, kept: 0, removedIds: [] };
    try {
      if (!assertWriteAllowed('experience-store').allowed) {
        report.ok = false; report.reason = 'write_boundary_denied'; return report;
      }
      const root = path.resolve(cfg.stateDir);
      if (!fs.existsSync(root)) return report;
      const names = fs.readdirSync(root).filter(isSessionLocalFile);
      report.scanned = names.length;
      const entries = names.map((name) => {
        const full = path.join(root, name);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { mtime = 0; }
        return {
          name, full,
          sid: name.slice(0, -'.json'.length),
          mtime,
          // 活跃保护：本进程最近见过（pre-step）或正在验证观察面缓存里
          active: activeSessions.has(name.slice(0, -'.json'.length)) || sessionCache.has(name.slice(0, -'.json'.length)),
        };
      });
      const ttlMs = cfg.sessionStoreTtlDays * 86400000;
      const deadline = ttlMs > 0 ? now - ttlMs : Number.NEGATIVE_INFINITY;
      // ① TTL 过期（仅非活跃）
      const survivors = [];
      for (const e of entries) {
        if (!e.active && ttlMs > 0 && e.mtime > 0 && e.mtime < deadline) removeSessionFile(e, report);
        else survivors.push(e);
      }
      // ② 数量上限（active 全保留 + 其余取最新）
      const limit = cfg.sessionStoreMaxFiles;
      if (survivors.length > limit) {
        const active = survivors.filter((e) => e.active);
        const idle = survivors.filter((e) => !e.active).sort((a, b) => b.mtime - a.mtime);
        const keep = new Set([
          ...active.map((e) => e.name),
          ...idle.slice(0, Math.max(0, limit - active.length)).map((e) => e.name),
        ]);
        for (const e of survivors) if (!keep.has(e.name)) removeSessionFile(e, report);
      }
      report.kept = report.scanned - report.removed;
      if (report.removed > 0) diag(`RETENTION pruned ${report.removed}/${report.scanned} session-local files (limit=${limit}, ttlDays=${cfg.sessionStoreTtlDays})`);
      return report;
    } catch (e) {
      report.ok = false;
      report.reason = `prune_error:${e && e.message ? e.message : String(e)}`;
      return report;
    }
  }
  function getStore(sid) {
    let s = stores.get(sid);
    if (!s) {
      const loaded = loadStore(sid);
      if (loaded) {
        s = loaded;
        // ★ F1：载入边界把"持久化审批在**本机审批台账**里查不到"显式留痕（不静默降级、不留死路径）。
        //   结构性凭据齐全但台账无对应 grant（台账被删/来自别的机器/被撤销/内容已改）⇒
        //   此时唯一正确动作 = 需人类重新批准；这里**只留痕、不删记录**（原始审批痕迹保持可审计），
        //   且因 getStore 命中缓存，每个会话每个进程只判一次。
        //   注意：**跨进程重启不再属于此类**——同一台账在重启后仍能验证（F1 R1 修正）。
        const expired = s.experiences
          .map((e) => ({ e, verdict: e.state === 'APPROVED' ? validHumanApproval(e, approvalLedger) : null }))
          .filter((x) => x.verdict && !x.verdict.ok)
          .slice(0, MAX_APPROVAL_EXPIRED_NOTICES)
          .map((x) => ({ ...x.e, _verdictReason: x.verdict.reason }));
        for (const e of expired) {
          s = appendTelemetry(s, telemetryEvent('APPROVAL_EXPIRED', {
            experienceId: e.id,
            reason: e._verdictReason,
            detail: 'persisted approval has no live grant in this host approval ledger; human re-approval required',
          }, Date.now()).value);
        }
        if (expired.length) diag(`APPROVAL-EXPIRED sid=${sid} count=${expired.length} (persisted approvals without live ledger grant; human re-approval required)`);
      } else {
        s = emptyStore(sid);
        // 只有在"文件存在但判废"时才记 STORE_REBUILT（首次创建不算重建）
        if (fs.existsSync(storePath(sid))) {
          s = appendTelemetry(s, telemetryEvent('STORE_REBUILT', { reason: 'invalid_or_corrupt_store' }, Date.now()).value);
          diag(`STORE-REBUILT sid=${sid} (corrupt/invalid store discarded, fail-closed)`);
        }
      }
    }
    // B2：命中即刷新 LRU 位置；写入后立即维持上限（淘汰只丢内存对象，磁盘数据不动）。
    rememberStore(sid, s);
    return s;
  }
  function commit(sid, next) {
    const withVersion = { ...next, version: (next.version ?? 0) + 1, updatedAt: Date.now() };
    rememberStore(sid, withVersion);
    saveStore(withVersion);
    return withVersion;
  }
  function tel(sid, kind, payload) {
    const ev = telemetryEvent(kind, payload, Date.now());
    if (!ev.ok) return stores.get(sid);
    return commit(sid, appendTelemetry(getStore(sid), ev.value));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // P4 R2 CONTRACT COMPLETION：验证 / 适用性 / Layer B 全局已验证库
  // 合同依据：§1 状态机（VERIFIED_EXPERIENCE 只能来自通过验证）、§5 证据与溯源、
  //           §11 发表闸门、§13 待验证与失效、§14 学习存储（Layer A 会话库 / Layer B 全局库）、
  //           §18 多会话隔离、§19 版本迁移、§21 经验反污染。
  // ═══════════════════════════════════════════════════════════════════════════

  // ── 官方会话观察面缓存（确定性验证的**唯一**事实来源）────────────────────
  // 设计前提（本次实测确认）：`invokeTool(name,args,exec)` 的 exec 只带
  // `{ agent: { session: { id } } }`，**不带事件**；而 `agent/pre-step` 钩子持有
  // **官方原始会话对象**（真实 events + surface.nodes）。
  // 因此这里只缓存**引用**（不复制、不落盘、有界），验证时从原始事件**独立复算**：
  // 复算输入是原始事件的 isError 布尔与 seq，**不读经验自身的文字**——所以这不是
  // "用经验证明经验"的同义反复，而是从官方原始会话重新取证。
  // 若某会话已不在缓存（例如另一进程/已过期）→ 解析器返回 unreachable，
  // 验证 fail-closed（拒绝 PASS），绝不因为"拿不到证据"而默认通过。
  const sessionCache = new Map(); // sid -> { events, nodeMax, at }
  const MAX_SESSION_CACHE = 8;
  function rememberSession(session) {
    const sid = session?.id;
    if (typeof sid !== 'string' || !sid) return;
    if (!Array.isArray(session.events)) return;
    sessionCache.set(sid, { events: session.events, nodeMax: session.surface?.nodes?.length ?? null, at: Date.now() });
    while (sessionCache.size > MAX_SESSION_CACHE) {
      let oldestKey = null; let oldestAt = Infinity;
      for (const [k, v] of sessionCache) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
      if (oldestKey === null) break;
      sessionCache.delete(oldestKey);
    }
  }

  /** 窗口内工具事实的确定性指纹（采集与验证**共用同一个函数**，保证可比）。 */
  function outcomeFactsDigest(lo, hi, anchors, calls, successes, failures) {
    const seqs = (arr) => arr.map((o) => o.seq).sort((a, b) => a - b).join(',');
    return stableHash(`${lo}-${hi}|${[...anchors].sort((a, b) => a - b).join(',')}|${seqs(calls)}|${seqs(successes)}|${seqs(failures)}`);
  }

  /** 从官方原始事件重算窗口事实（唯一判定路径；与提案期调用同一官方提取器）。 */
  function recomputeOutcome(events, ev) {
    const lo = ev.window[0]; const hi = ev.window[1];
    const out = extractToolOutcomes(events, [hi]);
    const inWin = (arr) => arr.filter((o) => o.seq >= lo && o.seq <= hi);
    const calls = inWin(out.calls);
    const successes = inWin(out.successes);
    const failures = inWin(out.failures);
    const anchorsFound = ev.anchors.filter((q) => events[q] != null).length;
    // 256 条上限饱和时窗口计数可能被截断 ⇒ 必须**显式**上报，不能对外宣称"无成功证据"
    const capSaturated = out.calls.length >= 256 || out.successes.length >= 256 || out.failures.length >= 256;
    return {
      ok: true,
      observed: {
        anchorsFound,
        toolCalls: calls.length,
        toolSuccesses: successes.length,
        toolFailures: failures.length,
        factsDigest: outcomeFactsDigest(lo, hi, ev.anchors, calls, successes, failures),
        capSaturated,
      },
    };
  }

  /** 真实 host 能力解析器（file_hash / session_outcome；system_api 由调用方预解析）。 */
  function makeResolvers() {
    return {
      fileHash: (p) => {
        try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
      },
      sessionOutcome: (ev) => {
        const cached = sessionCache.get(ev.sessionId);
        if (!cached || !Array.isArray(cached.events)) return { ok: false, error: 'session_events_unreachable' };
        return recomputeOutcome(cached.events, ev);
      },
    };
  }

  /**
   * system_api 证据的**预解析**（唯一异步点）：核心验证器是纯同步的，
   * 故这里先做只读 GET，再把结果以"已解析解析器"形式注入，避免死路径。
   */
  async function preResolveSystemApi(evidence) {
    const ev = (evidence && typeof evidence === 'object') ? evidence : null;
    if (!ev || ev.class !== 'system_api') return {};
    try {
      const url = `http://127.0.0.1:${ev.port}${ev.path}`;
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(4000) });
      const body = await res.text().catch(() => '');
      return { systemApi: () => ({ ok: true, status: res.status, body }) };
    } catch (e) {
      const msg = String(e?.name ?? e?.message ?? 'error');
      return { systemApi: () => ({ ok: false, error: `system_api_unreachable:${msg}` }) };
    }
  }

  // ── 运行环境描述符（适用性检查的输入）──────────────────────────────────
  const PLUGIN_VERSION = '2.0.0';
  function environmentDescriptor() {
    const dsh = process.env.DSH_VERSION;
    return {
      dshVersion: (typeof dsh === 'string' && dsh.trim()) ? dsh.trim() : null,
      nodeVersion: process.version ?? null,
      pluginVersion: PLUGIN_VERSION,
      platform: process.platform ?? null,
      arch: process.arch ?? null,
      // 依赖/工具可用性目前不参与判定（未知即不约束），保持 available 为空
      available: [],
    };
  }

  // ── Layer B：跨会话「全局已验证经验库」────────────────────────────────────
  // 与 Layer A（会话本地库）**分开文件**存放：合同 §14 禁止把一切混进一个大 store。
  // 写入闸门由核心 publishToGlobal 强制（PROPOSED/REJECTED/未批准/未验证一律拒绝）。
  const globalPath = cfg.globalStorePath || path.join(cfg.stateDir, '_global-verified.json');
  let globalStore = null;

  function loadGlobalStore() {
    if (globalStore) return globalStore;
    const reject = (reason) => {
      const base = emptyGlobalStore();
      const ev = telemetryEvent('GLOBAL_REJECTED', { reason, detail: `global store discarded fail-closed: ${reason}` }, Date.now());
      globalStore = ev.ok ? appendTelemetry(base, ev.value) : base;
      diag(`GLOBAL-REJECTED reason=${reason} (global store discarded fail-closed)`);
      return globalStore;
    };
    try {
      if (!fs.existsSync(globalPath)) { globalStore = emptyGlobalStore(); return globalStore; }
      const parsed = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
      const ok = validateGlobalStore(parsed);
      // 伪造/畸形 ⇒ **整体拒绝**，绝不留存"部分信任"的库（与 Layer A 同一纪律）
      if (!ok) return reject('invalid_or_forged_global_store');
      globalStore = ok;
      return globalStore;
    } catch {
      return reject('global_store_unreadable');
    }
  }

  function saveGlobalStore(store) {
    try {
      fs.mkdirSync(path.dirname(globalPath), { recursive: true });
      const tmp = `${globalPath}.tmp-${crypto.randomUUID()}`;
      fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
      fs.renameSync(tmp, globalPath);
      return true;
    } catch {
      return false; // 持久化失败不影响内存态，也不阻塞任务
    }
  }

  function commitGlobal(next) {
    const withVersion = { ...next, version: (next.version ?? 0) + 1, updatedAt: Date.now() };
    globalStore = withVersion;
    saveGlobalStore(withVersion);
    return withVersion;
  }

  function telGlobal(kind, payload) {
    const ev = telemetryEvent(kind, payload, Date.now());
    if (!ev.ok) return globalStore;
    return commitGlobal(appendTelemetry(loadGlobalStore(), ev.value));
  }

  /** 发表到 Layer B 的**唯一入口**：无论成功或拒绝都留痕（不留静默死路径）。 */
  function publishExperience(sid, exp) {
    const cur = loadGlobalStore();
    if (cfg.allowGlobalPublish === false) {
      telGlobal('GLOBAL_PUBLISH_DENIED', { experienceId: exp?.id, reason: 'global_publish_disabled', detail: 'allowGlobalPublish=false' });
      return { ok: false, reason: 'global_publish_disabled' };
    }
    const res = publishToGlobal(cur, exp, { at: Date.now(), ledger: approvalLedger });
    if (res.ok) {
      if (res.value && res.value !== cur) commitGlobal(res.value);
      telGlobal('GLOBAL_PUBLISHED', {
        experienceId: exp.id,
        detail: res.idempotent ? 'idempotent republish (same content signature)'
          : res.deduplicated ? 'deduplicated by content signature'
            : `published from session ${sid}`,
      });
      diag(`GLOBAL-PUBLISHED id=${exp.id}${res.idempotent ? ' (idempotent)' : res.deduplicated ? ' (dedup)' : ''}`);
    } else {
      telGlobal('GLOBAL_PUBLISH_DENIED', { experienceId: exp.id, reason: res.reason, detail: `refused publish: ${res.reason}` });
      diag(`GLOBAL-PUBLISH-DENIED id=${exp.id} reason=${res.reason}`);
    }
    return res;
  }

  // ── 核心：从真实原始会话提炼候选经验（自动，但永远只是 PROPOSED）──
  function maybeLearn(session) {
    if (!cfg.autoPropose) return null;
    if (!session || !session.surface?.nodes || !Array.isArray(session.events)) return null;
    const sid = session.id;
    if (!sid) return null;
    const nodes = [...session.surface.nodes];
    if (nodes.length === 0) return null;

    const wm = watermarks.get(sid);
    // 首次进入：只记录水位，不回填历史（避免启动即灌入陈旧候选）
    if (wm === undefined) { touchWatermark(sid, nodes[nodes.length - 1]); return null; }
    const fresh = nodes.filter((q) => Number.isInteger(q) && q > wm);
    if (fresh.length < cfg.minNewNodes) return null;

    // 只取最近 maxDigestTurns 个新节点（bounded）
    const window = fresh.slice(-cfg.maxDigestTurns);
    // 抽取走 P2.5 官方提取器（默认参数即 P25_EXTRACTORS，无第二个 parser）
    const built = buildLearnDigest(session.events, window);
    touchWatermark(sid, nodes[nodes.length - 1]);
    if (!built.ok) { warn(`digest failed: ${built.error}`); return null; }
    const digest = built.digest;
    if (digest.turnCount < cfg.minTurnsForLearning) return null;

    // ── R2 AC5：把本窗口内的真实失败分类注入信号判定（不再由关键词判失败）──
    // 关联口径：自上次提炼以来捕获的失败，即属本窗口。锚到 digest.lastSeq，
    // 使"失败→后续 resolution"的配对逻辑仍可用（这是窗口关联，不是 seq 精确对齐）。
    const drained = pendingFailures.get(sid) ?? [];
    touchPendingFailures(sid, []);
    const classifiedFailures = drained.map((f) => ({ ...f, seq: digest.lastSeq }));

    const sig = learningSignals(digest, { classifiedFailures });
    if (!sig.hasSignal) return null;

    // ── R2 AC5 否决闸门：任一被 P2.6 否决的失败 ⇒ 本窗口不得产出候选 ──
    const gate = gapVetoGate(sig);
    if (gate.blocked) {
      // ⚠ 可观测性修正（R2 E2E 实测发现）：telemetryEvent() 是**字段白名单**
      //   （只保留 experienceId / detail / count / reason），原先额外传的
      //   classifications / vetoReasons 会被**静默丢弃** ⇒ 事后无法回答
      //   "这次漏学是哪个故障类造成的"。故把分类与原因一并折进 detail
      //   （detail 会经 redactSecrets + 截断 500，足以承载）。
      const vetoedFailures = drained.filter((f) => f.vetoed);
      const classes = [...new Set(vetoedFailures.map((f) => f.classification).filter(Boolean))].join(',');
      const reasons = [...new Set(vetoedFailures.map((f) => f.vetoReason).filter(Boolean))].join(',');
      const withTel = tel(sid, 'GAP_VETOED', {
        detail: `auto-candidate suppressed: ${gate.reason} classes=[${classes}] vetoReasons=[${reasons}]`,
      });
      diag(`AUTO-PROPOSE-SUPPRESSED sid=${sid} ${gate.reason} classes=${classes}`);
      return withTel ?? null;
    }

    // 标题从**真实发言**派生（AC6：候选确实来自原始会话，不是凭空生成）
    const signalTurn = digest.turns.find((t) => sig.signals.some((s) => s.seq === t.seq)) ?? digest.turns[0];
    const title = oneLine(signalTurn.text, 120) || 'observed session signal';
    // 正文 = 真实片段 + 出处（脱敏已由 buildLearnDigest 完成）
    const kinds = sig.kinds ?? [...new Set(sig.signals.map((s) => s.kind))].sort();
    // R2：把"缺口资格"写实 —— 失败是否被后续发言解决，而不是只罗列命中的关键词。
    // 失败证据来自 P2.6 分类（sig.failureSeqs），不是关键词命中。
    const outcome = sig.failureSeqs.length > 0
      ? (sig.resolved ? 'resolved' : `unresolved-failure(seq ${sig.unresolvedFailureSeqs.join(',')})`)
      : 'no-classified-failure';
    const body = [
      `signal: ${kinds.join('+')}`,
      `outcome: ${outcome}`,
      `origin: session ${sid}, turns=${digest.turnCount}, window seq ${digest.firstSeq}-${digest.lastSeq}`,
      '',
      ...digest.turns.map((t) => `[${t.seq}] ${t.role}: ${oneLine(t.text, 300)}`),
    ].join('\n').slice(0, 4000);

    // ── P4 R2 CONTRACT COMPLETION：把合同【Experience Store】字段**写实** ──
    // 关键点：verificationEvidence 是**从官方原始事件现场取证**得到的事实包
    // （窗口内工具调用/成功/失败的 seq 与确定性指纹），不是模型自述、也不是结论。
    // 后续 learn_review / learn_verify 会用**同一个提取器**从原始事件复算并与它比对，
    // 不一致即判 FAIL（详见 recomputeOutcome）。
    const winLo = digest.firstSeq;
    const winHi = digest.lastSeq;
    const rawOut = extractToolOutcomes(session.events, [winHi]);
    const inWin = (arr) => arr.filter((o) => o.seq >= winLo && o.seq <= winHi);
    const winCalls = inWin(rawOut.calls);
    const winSuccesses = inWin(rawOut.successes);
    const winFailures = inWin(rawOut.failures);
    const evidence = normEvidence({
      class: 'session_outcome',
      sessionId: sid,
      sessionName: oneLine(String(session.surface?.name ?? session.name ?? sid), 80) || sid,
      window: [winLo, winHi],
      anchors: digest.sourceEventSeqs,
      toolCalls: winCalls.length,
      toolSuccesses: winSuccesses.length,
      toolFailures: winFailures.length,
      factsDigest: outcomeFactsDigest(winLo, winHi, digest.sourceEventSeqs, winCalls, winSuccesses, winFailures),
      observedAt: Date.now(),
    });
    const env = environmentDescriptor();
    const unresolved = sig.failureSeqs.length > 0 && !sig.resolved;
    // failed_or_unsafe_methods / rollback 只写**可证实**的内容；无法证实就留空，
    // 绝不用模板凑数（空数组在验证器里是合法值，不是"缺字段"）。
    const failedMethods = sig.failureSeqs.length > 0
      ? [`window seq ${winLo}-${winHi} 内出现被 P2.6 分类的失败（seq ${sig.failureSeqs.join(',')}），该路径在复用前须先排除`]
      : [];

    const res = propose(getStore(sid), {
      // 全字段提案：走核心的 contractFieldsFromDraft 归一化（缺字段/格式不合法一律拒绝）
      title,
      body,
      tags: kinds,
      taskType: kinds[0] ?? 'observed-signal',
      trigger: oneLine(`会话中出现 ${kinds.join('+')} 信号且窗口内确有工具成功结果`, 200),
      symptoms: unresolved
        ? [`窗口内存在未解决失败（seq ${sig.unresolvedFailureSeqs.join(',')}）`]
        : [],
      applicableVersions: { dsh: env.dshVersion, node: env.nodeVersion, plugin: env.pluginVersion },
      applicableEnvironment: { platform: env.platform, arch: env.arch },
      rootCause: oneLine(outcome, 400),
      successfulMethod: oneLine(`按窗口 ${winLo}-${winHi} 内已成功执行的工具路径完成（成功 ${winSuccesses.length}/${winCalls.length}）`, 400),
      failedOrUnsafeMethods: failedMethods,
      verificationEvidence: evidence,
      rollback: '',
      sourceLinks: [`session:${sid}#seq=${winLo}-${winHi}`],
      sourceCommit: null,
      staleConditions: [],
      expiresAt: null,
      sourceEventSeqs: digest.sourceEventSeqs,
      originSessionId: sid,
      createdAt: Date.now(),
    });
    if (!res.ok) { warn(`auto-propose rejected: ${res.error}`); return null; }
    if (res.deduped) return null;  // 同一证据重复 → 不产生新条目、不记遥测噪声
    const committed = commit(sid, res.value);
    const withTel = tel(sid, 'PROPOSED', { experienceId: res.experience.id, detail: `auto-candidate (${kinds.join('+')})` });
    diag(`AUTO-PROPOSED sid=${sid} id=${res.experience.id} signals=${kinds.join('+')} turns=${digest.turnCount} (state=PROPOSED, not recallable)`);
    return withTel ?? committed;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // R2 STAGE 8.5：**能力缺口**路径（与经验提案路径**分离**）
  //
  // 为什么必须分开（AC5_SEMANTIC_GATE = FAIL 的根因）：
  //   · 经验（Experience）：由**已解决**的过程提炼，须人工批准才可召回；
  //   · 能力缺口（Capability Gap）：由**未解决**、且可归因于我们**自身能力**
  //     的**重复**失败聚合而来，通向候选（Candidate），**不是**经验。
  // 旧实现把两者绑在同一把闸门上——而那条闸门只接 P2.6（provider/网络/环境域），
  // 于是一切失败都被无差别否决：真实能力缺口无处表达，经验路径也被顺带压死。
  //
  // 本路径的**唯一**失败来源是官方 `tool/result` 的**结构化**事实
  // （isError / error.code / tool.name），零关键词。绝不修改会话/上下文，
  // 绝不重试/选模型，绝不写经验库——它只产出**候选（PROPOSED）**。
  //
  // 有界（§15）：水位、待累计观测、候选，全部有硬上限。
  // ─────────────────────────────────────────────────────────────────────────
  const gapWatermarks = new Map();     // sid -> 能力缺口路径自己的水位（与经验路径互不干扰）
  const gapObservedKeys = new Map();    // sid -> Set<dedupKey>：已记为"证据"但尚未达阈值的缺口
  const gapVetoedKeys = new Map();      // sid -> Set<dedupKey>：已留痕的"被否决的能力缺口"（STAGE 2）
  const candidateStores = new Map();   // sid -> 候选 store（复用 learn-candidate.mjs）
  const MAX_TRACKED_SESSIONS = MAX_IN_MEMORY_SESSIONS; // 与 stores/watermarks 同一 per-session 口径
  const MAX_SESSION_OBSERVATIONS = 64; // 每会话最多考虑的能力失败观测数
  const MAX_GAP_SIGNATURES = 16;       // 每会话最多跟踪的能力缺口签名数

  function maybeQualifyCapabilityGap(session) {
    if (!session || !session.surface?.nodes || !Array.isArray(session.events)) return null;
    const sid = session.id;
    if (!sid) return null;
    const nodes = [...session.surface.nodes];
    if (nodes.length === 0) return null;

    const wm = gapWatermarks.get(sid);
    if (wm === undefined) {
      // 首见会话只记水位，不回填历史（与经验路径同一纪律）
      gapWatermarks.set(sid, nodes[nodes.length - 1]);
      evictLRU(gapWatermarks, MAX_TRACKED_SESSIONS, activeSessions);
      return null;
    }
    const fresh = nodes.filter((q) => Number.isInteger(q) && q > wm);
    gapWatermarks.set(sid, nodes[nodes.length - 1]);
    evictLRU(gapWatermarks, MAX_TRACKED_SESSIONS, activeSessions);
    if (fresh.length === 0) return null;

    // ① 结构化事实（零关键词）——在**整会话规范节点**上求值。
    //    ⚠ 关键：解决判定必须看**全会话**。若只看本窗口，后续窗口的成功就无法
    //    回溯解除早先的失败，被解决的能力失败会照样堆成候选（本实现首版就踩了这个坑，
    //    由 POSITIVE 2 孪生测试暴露）。观察面 = 全会话；触发面 = 本窗口新增。
    const outcomes = extractToolOutcomes(session.events, nodes);
    const unresolved = unresolvedToolFailures(outcomes).slice(0, MAX_SESSION_OBSERVATIONS);
    // 本步是否有**新增**的结构化事实（只决定是否重记"证据"遥测；**不**决定是否做解除）
    // ⚠ 触发面判据必须是 **seq 水位**，不能是"是否落在 surface 节点集里"：工具事件
    //   （tool/call、tool/result）永不落在节点 seq 上（节点只有 user/assistant 消息），
    //   用节点集判定会恒为 false ⇒ 遥测永不记录（2026-09-25 实测修正）。
    const hasFresh = unresolved.some((f) => Number.isInteger(f.seq) && f.seq > wm);
    // 当前仍可复现（仍未解决）的缺口签名集合。
    // ⚠ 刻意**不**用 groups 的键：groups 受 MAX_GAP_SIGNATURES 上限裁剪，
    //   用它会误判"已解除"并错误撤销候选。
    const liveKeys = new Set();
    for (const f of unresolved) liveKeys.add(`tool:${f.toolName}::${capabilitySignature(f.capability)}`);

    // ② 按**结构化签名**分组（同一底层能力缺失 = 同一组）
    const groups = new Map();
    for (const f of unresolved) {
      const taskType = `tool:${f.toolName}`;
      const dedupKey = `${taskType}::${capabilitySignature(f.capability)}`;
      let g = groups.get(dedupKey);
      if (!g) {
        if (groups.size >= MAX_GAP_SIGNATURES) continue;   // 有界：新签名超限则丢弃
        g = {
          dedupKey,
          taskType,
          capability: f.capability,
          // 缺口的**结构化描述符**（不是从自由文本里抄来的关键词）：
          // 同一 (tool, errorCode) 对 ⇒ 同一个底层能力缺失。
          deficiency: `tool ${f.toolName} fails with ${f.errorCode || f.errorName || 'uncoded error'}`,
          seqs: [],
        };
        groups.set(dedupKey, g);
      }
      g.seqs.push(f.seq);
    }

    // ③ 资格判定 + 候选产出。
    //    幂等：proposeCandidate 按 dedupKey 去重，重复步骤不会重复建候选，遥测也只在
    //    真正新建时记录 ⇒ 这里每步都安全执行（解除逻辑 ⑤ 需要每步都算，不能加 early-return）。
    const produced = [];
    const underThreshold = [];
    for (const [dedupKey, g] of groups) {
      if (g.seqs.length < REPEAT_THRESHOLD) { underThreshold.push({ dedupKey, count: g.seqs.length }); continue; }
      const observations = g.seqs.map((seq) => ({
        taskType: g.taskType,
        capability: g.capability,
        capabilityDeficiency: g.deficiency,
        seq,
      }));
      const gap = qualifyGap(observations);
      if (!gap.qualified) {
        diag(`CAPABILITY-GAP-NOT-QUALIFIED key=${dedupKey} reason=${gap.reason}`);
        // ★ R2 STAGE 2（2026-09-25）：**被否决的能力失败必须留痕**。
        //   码级否决（NON_CAPABILITY_CODE / MISSING_ERROR_CODE）一旦误杀真实能力缺口，
        //   若不留痕，外界只会看到"什么都没发生"——那正是本阶段要消灭的**静默死路径**。
        //   注意 telemetryEvent() 是**字段白名单**（仅 experienceId/detail/count/reason），
        //   额外字段会被静默丢弃 ⇒ 原因码一并折进 detail/reason。
        //   同一 dedupKey 只留痕一次（与 ④ 的 gapObservedKeys 同一防刷惯用法）。
        if (gap.vetoedCount > 0) {
          let vkeys = gapVetoedKeys.get(sid);
          if (!vkeys) {
            // B2：改为 LRU（保留最近/活跃会话），不再整表 clear()（整表清空会丢活跃会话状态）
            evictLRU(gapVetoedKeys, MAX_TRACKED_SESSIONS, activeSessions);
            vkeys = new Set();
            gapVetoedKeys.set(sid, vkeys);
          }
          if (!vkeys.has(dedupKey)) {
            if (vkeys.size < MAX_GAP_SIGNATURES) vkeys.add(dedupKey);
            const reasons = (gap.vetoReasons ?? []).join(',');
            tel(sid, 'CAPABILITY_GAP_VETOED', {
              detail: `capability gap vetoed (${gap.vetoedCount}/${observations.length}) key=${dedupKey} vetoReasons=[${reasons}]`,
              count: gap.vetoedCount,
              reason: `adapter=v${CAPABILITY_ADAPTER_VERSION} ${reasons}`,
            });
          }
        }
        continue;
      }
      let cstore = candidateStores.get(sid);
      if (!cstore) {
        // B2：LRU 淘汰（保留活跃会话），不再整表 clear()
        evictLRU(candidateStores, MAX_TRACKED_SESSIONS, activeSessions);
        cstore = emptyCandidateStore(sid);
      }
      const res = proposeCandidate(cstore, gap, { at: Date.now() });
      if (!res.ok) { warn(`capability candidate propose rejected: ${res.error}`); continue; }
      candidateStores.set(sid, res.value);
      if (res.deduped) continue;
      produced.push(res.candidate.id);
      // 遥测：候选由**合格缺口**建立（CANDIDATE_PROPOSED 由 proposeCandidate 内部记录，
      // 这里额外记录缺口自身的资格事实，使"这次学习为什么发生"可事后回答）
      tel(sid, 'CAPABILITY_GAP_QUALIFIED', {
        experienceId: res.candidate.id,
        detail: `origin=${gap.origin} taskType=${gap.taskType} sig=${gap.normalizedSignature}`,
        count: gap.count,
        reason: `adapter=v${gap.adapterVersion}`,
      });
      diag(`CAPABILITY-GAP-QUALIFIED sid=${sid} id=${res.candidate.id} origin=${gap.origin} taskType=${gap.taskType} observations=${gap.count} (state=PROPOSED, not promoted)`);
    }

    // ④ 仅作为**证据**的观测（未达阈值）：记遥测，使运维能回答"为什么还没建立候选"。
    //    只在**本步有新事实**时记，避免每一步重复刷同一条证据。
    if (hasFresh && produced.length === 0 && underThreshold.length > 0) {
      for (const o of underThreshold) {
        let keys = gapObservedKeys.get(sid);
        if (!keys) {
          // B2：LRU 淘汰（保留活跃会话），不再整表 clear()
          evictLRU(gapObservedKeys, MAX_TRACKED_SESSIONS, activeSessions);
          keys = new Set();
          gapObservedKeys.set(sid, keys);
        }
        if (keys.size < MAX_GAP_SIGNATURES) keys.add(o.dedupKey);
      }
      tel(sid, 'CAPABILITY_GAP_OBSERVED', {
        detail: `unresolved capability failures observed, no candidate yet: ${underThreshold.map((o) => `${o.dedupKey}#${o.count}`).join(' ').slice(0, 380)}`,
        count: underThreshold.length,
        reason: `below repeat threshold (${REPEAT_THRESHOLD})`,
      });
      diag(`CAPABILITY-GAP-OBSERVED sid=${sid} ${underThreshold.map((o) => `${o.dedupKey}#${o.count}`).join(' ')} (no candidate: below repeat threshold ${REPEAT_THRESHOLD})`);
    }

    // ⑤ **解除**：先前观测/建立过、而现在已经不再可复现的缺口必须被撤销。
    //    这是"只有成功才解除失败"的落地处——瞬时错误被重试解决后，不得留下悬空证据，
    //    也不得留下永久伪缺口。每步都做（成功发生在哪一步，就在哪一步解除）。
    const observedKeys = gapObservedKeys.get(sid);
    if (observedKeys) {
      for (const k of [...observedKeys]) {
        if (liveKeys.has(k)) continue;
        observedKeys.delete(k);
        tel(sid, 'CAPABILITY_GAP_RESOLVED', {
          detail: `capability gap no longer reproducible: ${k}`.slice(0, 300),
          reason: 'unresolved_failure_cleared_by_success',
        });
        diag(`CAPABILITY-GAP-RESOLVED sid=${sid} key=${k} (withdrawn; was not a permanent gap)`);
      }
    }
    const cstoreNow = candidateStores.get(sid);
    if (cstoreNow) {
      for (const c of [...cstoreNow.candidates]) {
        if (c.state !== 'PROPOSED') continue;    // 只撤销仍在提案态的候选（终态不复活）
        if (liveKeys.has(c.dedupKey)) continue;  // 仍可复现 ⇒ 保留
        const rr = rejectCandidate(cstoreNow, c.id, {
          at: Date.now(), reason: 'capability_gap_resolved_by_success',
        });
        if (rr.ok) {
          candidateStores.set(sid, rr.value);
          diag(`CAPABILITY-CANDIDATE-WITHDRAWN sid=${sid} id=${c.id} (underlying gap resolved by success)`);
        } else {
          warn(`candidate withdraw failed id=${c.id}: ${rr.error}`);
        }
      }
    }
    return produced;
  }

  // ── 钩子：被动观察（只读会话，绝不修改会话/上下文）──
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      // B2：先登记"活跃会话"——它同时保护内存缓存（LRU protect）与磁盘会话文件（清理豁免）。
      touchActive(agent?.session?.id);
      // 官方会话观察面：无论是否产出候选都要留观察面，否则后续确定性验证
      // 会因"拿不到官方原始事件"而 fail-closed（宁可拒绝，也不凭经验自述放行）。
      rememberSession(agent?.session);
    } catch { /* fail-open：观察面缓存失败不影响任务 */ }
    try {
      maybeLearn(agent?.session);
    } catch (e) {
      // fail-open：学习失败绝不影响任务
      warn(`maybeLearn error (ignored): ${e && e.message ? e.message : String(e)}`);
    }
    try {
      // R2 STAGE 8.5：能力缺口路径独立于经验路径，互不阻塞
      maybeQualifyCapabilityGap(agent?.session);
    } catch (e) {
      // fail-open：观测失败绝不影响任务
      warn(`maybeQualifyCapabilityGap error (ignored): ${e && e.message ? e.message : String(e)}`);
    }
    return next();
  });

  // ── R2 AC5：真实失败观测（与 P2.6 同一事件 `agent/request-error`）──
  // 本钩子**只读** payload、只把分类结果记入内存缓冲，绝不修改 payload.failure，
  // 绝不追加 session event，绝不重试/选模型 —— 与 P2.6 的观测契约完全一致。
  // 链式顺序无关：本插件独立调用同一分类器，不依赖 P2.6 是否已处理。
  ctx.on('agent/request-error', async (payload, next) => {
    try {
      recordFailure(payload);
    } catch (e) {
      // fail-open：观测失败绝不影响任务链
      warn(`recordFailure error (ignored): ${e && e.message ? e.message : String(e)}`);
    }
    return next();
  });

  // ── 工具面 ──
  const sidOf = (exec) => exec?.agent?.session?.id;
  // 工具定义收集器：即使 dsh-tools 在 repo 直连场景下不可用，也把**真实的 execute 函数**
  // 收集下来并随 apply() 返回，使 E2E 能驱动与生产完全相同的工具实现（不是复制品）。
  const TOOL_SPECS = [];
  const reg = (spec) => {
    TOOL_SPECS.push(spec);
    if (defineTool && ctx.tools && typeof ctx.tools.register === 'function') {
      ctx.tools.register(defineTool(spec));
    }
  };
  {
    reg({
      name: 'learn_propose',
      description: 'Propose a reusable experience derived from the CURRENT raw session. The result is always state=PROPOSED and is NEVER recallable until a human approves it via learn_review. Provenance (sourceEventSeqs) is mandatory and must point at real session event seqs — an experience without provenance is rejected. Metadata only: this tool never activates, promotes, or applies anything.',
      parameters: {
        title: { type: 'string', description: 'Short reusable lesson title (<=200 chars).', required: true },
        body: { type: 'string', description: 'The lesson body: what happened, what to do instead, and why (<=4000 chars).', required: true },
        tags: { type: 'array', description: 'Optional tags (<=16).' },
        sourceEventSeqs: { type: 'array', description: 'REQUIRED provenance: real session event seq numbers this lesson was derived from.', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, experienceId: { type: 'string' }, state: { type: 'string' }, deduped: { type: 'boolean' } } },
        render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
      },
      async execute(args, exec) {
        const sid = sidOf(exec);
        if (!sid) throw new Error('learn_propose: no session context (exec.agent missing)');
        const res = propose(getStore(sid), {
          title: args.title,
          body: args.body,
          tags: args.tags,
          sourceEventSeqs: args.sourceEventSeqs,
          originSessionId: sid,
          createdAt: Date.now(),
        });
        if (!res.ok) throw new Error(`learn_propose rejected: ${res.error}`);
        if (!res.deduped) {
          commit(sid, res.value);
          tel(sid, 'PROPOSED', { experienceId: res.experience.id, detail: 'explicit proposal' });
        }
        diag(`PROPOSE sid=${sid} id=${res.experience.id} state=${res.experience.state} deduped=${res.deduped}`);
        return { ok: true, experienceId: res.experience.id, state: res.experience.state, deduped: res.deduped };
      },
    });

    reg({
      name: 'learn_review',
      description: 'HUMAN APPROVAL BOUNDARY. Approve or reject a PROPOSED experience. Approval is decided by the HOST human-approval channel (a real human decision requested through the harness approval tool) and is recorded in a persistent, append-only host approval ledger; a caller-supplied name or evidence NEVER grants approval by itself. Evidence is still required for an approve call, and evidence containing a secret-shaped value is rejected outright. Rejection is terminal (a rejected experience can never be revived — propose a new one instead).',
      parameters: {
        experienceId: { type: 'string', description: 'Target experience id.', required: true },
        action: { type: 'string', description: '"approve" or "reject".', required: true },
        approver: { type: 'string', description: 'For reject: who rejects (identity string). Ignored for approve — self-reported identity never grants authority.' },
        evidence: { type: 'string', description: 'For approve: concrete evidence the lesson is correct and reusable (required).' },
        reason: { type: 'string', description: 'For reject: why it is not reusable (required).' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            experienceId: { type: 'string' },
            state: { type: 'string' },
            verified: { type: 'boolean' },
            verificationStatus: { type: 'string' },
            publication: { type: 'string' },
          },
        },
        render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
      },
      async execute(args, exec) {
        const sid = sidOf(exec);
        if (!sid) throw new Error('learn_review: no session context (exec.agent missing)');
        const isApprove = String(args.action).toLowerCase() === 'approve';
        let store = getStore(sid);
        let vr = null;

        // ── 顺序铁律：**先**确定性验证，**后**人工批准 ──
        // 理由（合同 §1/§11）：人工批准表达"这条经验对不对"，机器验证表达"证据是否真的成立"。
        // 两者都必须过；验证在批准之前跑，避免"先批准再补验证"这种可被绕过的顺序。
        if (isApprove) {
          const target = store.experiences.find((e) => e.id === args.experienceId);
          if (!target) throw new Error('learn_review rejected: not_found');
          const pre = await preResolveSystemApi(target.verificationEvidence);
          vr = applyVerification(store, args.experienceId, target.verificationEvidence,
            { ...makeResolvers(), ...pre }, Date.now());
          if (vr.value) store = commit(sid, vr.value);
          if (vr.ok) {
            tel(sid, 'VERIFIED', {
              experienceId: args.experienceId,
              detail: `deterministic re-derivation from official session PASS (method=${vr.method}) before approval`,
            });
            diag(`VERIFIED sid=${sid} id=${args.experienceId} method=${vr.method}`);
          } else {
            // 验证失败**不**阻断人工批准（人可能另有依据），但必须留痕且**不得**跨会话发表。
            tel(sid, 'VERIFICATION_FAILED', {
              experienceId: args.experienceId, reason: vr.error,
              detail: `deterministic verification FAILED: ${vr.error}`,
            });
            diag(`VERIFICATION-FAILED sid=${sid} id=${args.experienceId} error=${vr.error}`);
          }
        }

        // ★ 引用刷新（2026-09-25 实测修正）：上面 tel() 内部走的是
        //   `commit(sid, appendTelemetry(getStore(sid), ...))`，会产出**新的** store 对象；
        //   而本函数的局部 `store` 仍指向 tel() 之前的那一份。若不刷新，随后的
        //   approve/reject 会基于旧快照派生并 commit，**把刚写下的验证遥测覆盖掉**
        //   （实测现象：验证失败的 VERIFICATION_FAILED 在最终库里凭空消失，导致
        //    "验证失败"这件事不可审计）。故此处必须重新取一次最新快照。
        store = getStore(sid);

        // ── F1：人类批准边界（**唯一**授权来源 = 宿主审批通道的真实人类作答）──────────
        // 位置刻意放在"确定性验证之后、状态迁移之前"：验证表达"证据是否成立"，
        // 批准表达"人是否授权"。两者都必须过，且**批准必须在状态变更之前**取得——
        // 否则会出现"先改成 APPROVED，再去补一次批准"的可绕过窗口。
        let approvalRef = null;
        if (isApprove) {
          const target = store.experiences.find((e) => e.id === args.experienceId);
          if (!target) throw new Error('learn_review rejected: not_found');
          // ── 前置校验（复用 learn-core 的**唯一口径**）：证据缺失/含密钥的批准请求
          //    在被拒绝前**绝不**去打断人类 —— 不给人类弹一个注定失败的批准请求。
          const preEv = validateApprovalEvidence(args.evidence);
          if (!preEv.ok) {
            tel(sid, 'HUMAN_APPROVAL_DENIED', {
              experienceId: args.experienceId, reason: `precondition:${preEv.error}`,
              detail: 'rejected before any human request (approval precondition failed)',
            });
            diag(`APPROVAL-PRECONDITION-FAILED sid=${sid} id=${args.experienceId} error=${preEv.error}`);
            throw new Error(`learn_review rejected: ${preEv.error}`);
          }
          // 送进宿主审计日志的只有**内容摘要**（不含正文/证据全文），避免经验正文或
          // 潜在敏感内容进入宿主日志；摘要即绑定"被批准的是这一版内容"。
          const digest = candidateDigest(target);
          tel(sid, 'HUMAN_APPROVAL_REQUESTED', {
            experienceId: args.experienceId,
            detail: `channel=${HUMAN_APPROVAL_CHANNEL} tool=${HUMAN_APPROVAL_HOST_TOOL} digest=${digest}`,
          });
          const host = await requestHumanApproval(exec, {
            toolName: HUMAN_APPROVAL_HOST_TOOL,
            reason: `${HUMAN_APPROVAL_HOST_TOOL}: approve experience ${args.experienceId} digest=${digest}`,
          });
          if (!host.ok) {
            // 留痕：拒绝/取消/不可用/无宿主事实，一律记 HUMAN_APPROVAL_DENIED（不留静默死路径）。
            const kind = host.outcome === 'unavailable' ? 'HUMAN_APPROVAL_UNAVAILABLE' : 'HUMAN_APPROVAL_DENIED';
            tel(sid, kind, { experienceId: args.experienceId, reason: host.error, detail: `outcome=${host.outcome}` });
            diag(`HUMAN-APPROVAL ${host.outcome} sid=${sid} id=${args.experienceId} error=${host.error}`);
            throw new Error(`learn_review rejected: ${host.error}`);
          }
          approvalRef = host.approvalRef;
          tel(sid, 'HUMAN_APPROVAL_GRANTED', {
            experienceId: args.experienceId,
            detail: `ref=${approvalRef} digest=${digest}`,
          });
        }

        // ★ 引用刷新（同 P4 R2 已记录的"tel() 换新快照"坑）：上面 HUMAN_APPROVAL_* 的
        //   tel() 走的是 `commit(sid, appendTelemetry(getStore(sid), ...))`，会产出**新的**
        //   store 对象；不重新取一次，随后的 approve()/reject() 就会基于旧快照 commit，
        //   把刚写下的批准遥测覆盖掉（现象：授权留痕凭空消失 ⇒ 不可审计）。
        store = getStore(sid);

        const res = isApprove
          ? approve(store, args.experienceId, {
            evidence: args.evidence, at: Date.now(), session: exec.agent.session, approvalRef,
            ledger: approvalLedger,
          })
          : reject(store, args.experienceId, { approver: args.approver, reason: args.reason, at: Date.now() });
        if (!res.ok) throw new Error(`learn_review rejected: ${res.error}`);
        commit(sid, res.value);
        tel(sid, isApprove ? 'APPROVED' : 'REJECTED', {
          experienceId: res.experience.id,
          detail: isApprove ? `by ${HUMAN_APPROVAL_ACTOR} ref=${approvalRef}` : `by ${args.approver}`,
        });

        // ── §11 发表闸门：只有"已人工批准 + 已确定性验证 + 审批来源完整"才可能进入 ──
        // Layer B 并被**其它会话**看到。注意审批 ≠ 验证：仅有 APPROVED（未 VERIFIED）
        // 仍只是本会话可召回（Layer A），publishToGlobal 会拒绝并留 DENY 痕迹 —— 这是
        // "多会话隔离"与"跨会话复用"两条款的唯一兼容方式：跨会话通道只放
        // 「人工授权**且**机器验证**且**审批痕迹完整」的经验。
        let publication = null;
        let pubDetail = 'not_applicable';
        if (isApprove) {
          const pub = publishExperience(sid, res.experience);
          if (pub.ok) {
            publication = pub.idempotent ? 'idempotent' : pub.deduplicated ? 'deduplicated' : 'published';
            pubDetail = publication;
          } else {
            publication = `denied:${pub.reason}`;
            pubDetail = publication;
          }
        }
        diag(`REVIEW sid=${sid} id=${res.experience.id} action=${isApprove ? 'approve' : 'reject'} -> ${res.experience.state} verified=${vr ? vr.ok : 'n/a'} publish=${pubDetail}`);
        return {
          ok: true,
          experienceId: res.experience.id,
          state: res.experience.state,
          verified: isApprove ? (vr ? vr.ok === true : false) : false,
          verificationStatus: res.experience.verification?.status ?? 'UNVERIFIED',
          publication: pubDetail,
        };
      },
    });

    reg({
      name: 'learn_recall',
      description: 'Deterministically recall APPROVED experiences relevant to a query. Only APPROVED entries are ever visible — proposals and rejections are invisible. Results are stable for the same input and always carry sourceEventSeqs so any recalled lesson can be traced back to the raw session it came from. Read-only.',
      parameters: {
        query: { type: 'string', description: 'What you are about to do; the recall matches this against approved lessons.', required: true },
        limit: { type: 'number', description: 'Max results (default 5, max 20).' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            items: { type: 'array' },
            considered: { type: 'number' },
            excluded: { type: 'number' },
            blocked: { type: 'array' },
          },
        },
        render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
      },
      async execute(args, exec) {
        const sid = sidOf(exec);
        if (!sid) throw new Error('learn_recall: no session context (exec.agent missing)');
        const store = getStore(sid);
        // Layer B 参与 + **适用性检查**：跨会话召回必须先过 isApplicableNow
        // （版本 / 平台 / 过期 / 重新验证失败都会被拦下并计入 blocked，绝不盲用）。
        const res = recall(store, args.query, {
          limit: args.limit,
          global: loadGlobalStore(),
          env: environmentDescriptor(),
          now: Date.now(),
          ledger: approvalLedger,
        });
        if (res.items.length > 0) {
          const fromGlobal = res.items.filter((i) => i.scope === 'global').length;
          commit(sid, recordRecall(store, res.items.map((i) => i.id), Date.now()));
          tel(sid, 'RECALLED', {
            count: res.items.length,
            detail: `${oneLine(args.query, 100)} (global=${fromGlobal}, blocked=${Array.isArray(res.blocked) ? res.blocked.length : 0})`,
          });
        }
        diag(`RECALL sid=${sid} q="${oneLine(args.query, 40)}" hits=${res.items.length} excluded=${res.excluded} blocked=${Array.isArray(res.blocked) ? res.blocked.length : 0}`);
        return {
          ok: true,
          items: res.items,
          considered: res.considered,
          excluded: res.excluded,
          blocked: res.blocked ?? [],
        };
      },
    });

    reg({
      name: 'learn_promote',
      description: 'EXPLICIT promotion of an APPROVED experience into the durable long-term set. Eligibility (approved + has approval evidence + has been recalled at least once) is only a PRECONDITION — promotion never happens automatically and always requires explicit promotion evidence. Returns not_eligible with a reason when the precondition is unmet.',
      parameters: {
        experienceId: { type: 'string', description: 'Target experience id.', required: true },
        evidence: { type: 'string', description: 'Why this lesson has earned durable status (required).', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, experienceId: { type: 'string' }, promotion: { type: 'string' } } },
        render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
      },
      async execute(args, exec) {
        const sid = sidOf(exec);
        if (!sid) throw new Error('learn_promote: no session context (exec.agent missing)');
        const res = promote(getStore(sid), args.experienceId, { evidence: args.evidence });
        if (!res.ok) {
          tel(sid, 'PROMOTION_BLOCKED', { experienceId: args.experienceId, reason: res.error });
          throw new Error(`learn_promote rejected: ${res.error}`);
        }
        commit(sid, res.value);
        tel(sid, 'PROMOTION_ELIGIBLE', { experienceId: res.experience.id, detail: 'promoted' });
        diag(`PROMOTE sid=${sid} id=${res.experience.id} -> PROMOTED`);
        return { ok: true, experienceId: res.experience.id, promotion: res.experience.promotion };
      },
    });

    // ── P4 R2 CONTRACT COMPLETION：显式确定性验证入口 ──────────────────────
    // 与 learn_review(approve) 内置的验证**共用同一实现**（verifyEvidenceRecord +
    // applyVerification，本插件不建第二套验证器）：这里只是把"验证"单独暴露成可独立调用、
    // 可重复复验的入口（首次验证 / 环境变化后的重新验证）。
    // 验证失败**不抛异常**——那是一个真实结果（附可读原因），调用方据此决定是否继续复用。
    reg({
      name: 'learn_verify',
      description: 'Deterministically (re-)verify ONE experience against its own machine-checkable evidence, freshly re-derived from the official session / real filesystem / real local endpoint. This is not a self-report check: session_outcome evidence is re-extracted from the official raw session events and compared field by field, so a tampered or drifted record FAILS. PASS is required (together with human approval) before the experience can be published to the cross-session global store. Returns ok:false with a machine-readable reason when verification cannot be established; it never marks anything verified on a best-effort basis.',
      parameters: {
        experienceId: { type: 'string', description: 'Target experience id.', required: true },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            experienceId: { type: 'string' },
            state: { type: 'string' },
            verificationStatus: { type: 'string' },
            method: { type: 'string' },
            error: { type: 'string' },
            publication: { type: 'string' },
          },
        },
        render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
      },
      async execute(args, exec) {
        const sid = sidOf(exec);
        if (!sid) throw new Error('learn_verify: no session context (exec.agent missing)');
        let store = getStore(sid);
        const target = store.experiences.find((e) => e.id === args.experienceId);
        if (!target) throw new Error('learn_verify rejected: not_found');
        const pre = await preResolveSystemApi(target.verificationEvidence);
        const res = applyVerification(store, args.experienceId, target.verificationEvidence,
          { ...makeResolvers(), ...pre }, Date.now());
        if (res.value) store = commit(sid, res.value);
        const after = res.experience ?? target;

        if (res.ok) {
          tel(sid, 'VERIFIED', {
            experienceId: args.experienceId,
            detail: `deterministic verification PASS (method=${res.method})`,
          });
          diag(`VERIFY sid=${sid} id=${args.experienceId} PASS method=${res.method}`);
        } else {
          tel(sid, 'VERIFICATION_FAILED', {
            experienceId: args.experienceId, reason: res.error,
            detail: `deterministic verification FAILED: ${res.error}`,
          });
          diag(`VERIFY sid=${sid} id=${args.experienceId} FAIL error=${res.error}`);
        }

        // ★ B1（R2 外部评审 BLOCKER-1）：验证通过**不再**自动获得跨会话传播权。
        //   这里仍然调用 publishExperience，是为了让"被拒"留下**可审计**痕迹
        //   （GLOBAL_PUBLISH_DENIED 遥测 + 可读原因），而不是静默跳过；
        //   真正的授权判定收敛在唯一 authority `canPublish()` 一处：
        //   APPROVED + VERIFIED + 完整审批来源，缺任一项即 DENY。
        //   故"仅 VERIFIED 未审批"的路径必定 publication=denied:not_human_approved:…
        let publication = 'not_applicable';
        if (res.ok) {
          const pub = publishExperience(sid, after);
          publication = pub.ok ? (pub.idempotent ? 'idempotent' : pub.deduplicated ? 'deduplicated' : 'published') : `denied:${pub.reason}`;
        }
        return {
          ok: res.ok === true,
          experienceId: args.experienceId,
          state: after.state,
          verificationStatus: after.verification?.status ?? 'UNVERIFIED',
          method: res.method ?? null,
          error: res.ok ? undefined : (res.error ?? 'verification_failed'),
          publication,
        };
      },
    });

    reg({
      name: 'learn_status',
      description: 'Read-only learning status: experience counts by state, promotion count, and structured telemetry (PROPOSED/APPROVED/REJECTED/RECALLED/PROMOTION_BLOCKED/STORE_REBUILT/WRITE_DENIED). Use it to confirm that proposals are being recorded, that nothing was auto-activated, and that no store corruption occurred. Never mutates anything.',
      parameters: {},
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            summary: { type: 'object', additionalProperties: true },
            experiences: { type: 'array' },
            global: { type: 'object', additionalProperties: true },
          },
        },
        render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
      },
      async execute(_args, exec) {
        const sid = sidOf(exec);
        if (!sid) throw new Error('learn_status: no session context (exec.agent missing)');
        const store = getStore(sid);
        const summary = telemetrySummary(store);
        const experiences = store.experiences.map((e) => ({
          id: e.id, state: e.state, promotion: e.promotion, title: e.title,
          recallCount: e.recallCount, sourceEventSeqs: e.sourceEventSeqs,
          approvedBy: e.approvedBy, eligible: promotionEligibility(e).eligible,
          verificationStatus: e.verification?.status ?? 'UNVERIFIED',
          verified: e.verification?.status === 'VERIFIED',
          lastVerifiedAt: e.lastVerifiedAt ?? null,
        }));
        // Layer B（跨会话全局已验证库）的**只读**视图：本条会话能看到全局库规模与条目，
        // 但看不到任何未验证内容——因为全局库里按定义只可能存已验证条目（fail-closed 校验）。
        const g = loadGlobalStore();
        const global = {
          schemaVersion: g.schemaVersion,
          version: g.version,
          count: g.experiences.length,
          updatedAt: g.updatedAt,
          publishEnabled: cfg.allowGlobalPublish !== false,
          experiences: g.experiences.map((e) => ({
            id: e.id, title: e.title, taskType: e.taskType,
            lastVerifiedAt: e.lastVerifiedAt, state: e.state,
            verificationMethod: e.verification?.method ?? null,
            originSessionId: e.originSessionId ?? null,
          })),
        };
        return { ok: true, summary, experiences, global };
      },
    });
  }
  if (TOOL_SPECS.length !== 6) warn(`expected 6 tool specs, collected ${TOOL_SPECS.length}`);
  if (!(defineTool && ctx.tools && typeof ctx.tools.register === 'function')) {
    warn('tool surface unavailable (defineTool missing or no tools service) — hooks and store unaffected');
  }

  diag(`registered (stateDir=${cfg.stateDir}, autoPropose=${cfg.autoPropose}, minTurns=${cfg.minTurnsForLearning}, minNewNodes=${cfg.minNewNodes})`);

  // ── B2：启动时执行一次保留策略 ──
  // 长期运行后重启时 stateDir 可能已堆积（上次运行未达节流阈值 / TTL 已到期），故在 apply
  // 末尾（所有 per-session 结构均已初始化）执行一次，使"重启后 bounded 依然成立"。
  // 绝不载入全部会话库：getStore 仍是惰性的；这里只 readdir + 按 mtime 决策，不解析文件内容。
  try {
    const pr = pruneSessionStore();
    if (pr.removed > 0) diag(`RETENTION startup prune removed=${pr.removed} scanned=${pr.scanned}`);
  } catch { /* fail-open：保留策略失败绝不影响任务 */ }

  // 只读快照 + 真实工具实现（供 E2E / 诊断脚本直接驱动，不经 dsh-tools 包装）
  return {
    getStore,
    storePath,
    // R2 STAGE 8.5：能力缺口候选库的**只读快照**（与 getStore 同一纪律；测试/诊断用）
    candidateStoreFor: (sid) => candidateStores.get(sid) ?? null,
    // —— P4 R2 CONTRACT COMPLETION：召回面与工具面**共用同一实现** ——
    // 关键：recallFor 与 learn_recall 的 opts 必须一致（global + env + now），否则
    // "测试走的路径"和"生产走的路径"会漂移（那正是上一轮口径断裂的成因）。
    recallFor: (sid, q, opts) => recall(getStore(sid), q, {
      ...(opts ?? {}),
      global: loadGlobalStore(),
      env: environmentDescriptor(),
      now: Date.now(),
      // 与 learn_recall 同源：默认用本实例的持久台账；测试可显式注入自己的台账句柄。
      ledger: (opts && 'ledger' in opts) ? opts.ledger : approvalLedger,
    }),
    /** Layer B（跨会话全局已验证库）的只读快照 —— 只读，绝不外泄写句柄。 */
    globalStore: () => loadGlobalStore(),
    globalStorePath: () => globalPath,
    environment: () => environmentDescriptor(),
    summaryFor: (sid) => telemetrySummary(getStore(sid)),
    schemaVersion: LEARN_SCHEMA_VERSION,
    /** 工具名 → 真实 spec（含 execute）；与生产注册的是同一批函数对象。 */
    toolSpecs: Object.fromEntries(TOOL_SPECS.map((s) => [s.name, s])),
    toolNames: TOOL_SPECS.map((s) => s.name),
    /** 直接调用某个工具的真实 execute（E2E 用；参数与生产调用完全一致）。 */
    invokeTool: (toolName, args, exec) => {
      const s = TOOL_SPECS.find((x) => x.name === toolName);
      if (!s) throw new Error(`unknown tool: ${toolName}`);
      return s.execute(args, exec);
    },
    /** 测试用：直接注入一条已构造好的 store（不写盘）。 */
    _setStoreForTest: (sid, store) => { rememberStore(sid, store); },
    /** 测试用：读取内存水位（诊断用）。 */
    _watermarkFor: (sid) => watermarks.get(sid),
    // ── B2：保留策略的**可观测 + 可测试**面（只读快照，不外泄内部 Map 句柄）──
    /** 进程内 per-session 结构的**真实**大小（用于断言 bounded 成立，不是投影）。 */
    _memoryFootprint: () => memoryFootprint(),
    /** 内存上限（= MAX_IN_MEMORY_SESSIONS）。 */
    _memoryLimit: () => MAX_IN_MEMORY_SESSIONS,
    /** 磁盘保留策略的实际取值（config/env 归一化后的结果）。 */
    retentionPolicy: () => ({ maxFiles: cfg.sessionStoreMaxFiles, ttlDays: cfg.sessionStoreTtlDays }),
    // ── F2：配置校验面（只读快照）────────────────────────────────────────────
    // 存在的理由：配置无效时**必须可取证**。若只有一个 no-op logger，运维就看不到
    // "你配的 63 被拒绝了"——那正是 F2 的原始缺陷（静默）。故把逐条诊断同时暴露成 API。
    /** 逐条配置校验失败诊断（每行都含 `minimum supported sessionStoreMaxFiles is 64` 锚点）。 */
    configValidationLog: () => configValidationLog.slice(),
    /** 配置校验摘要：`ok` 为真 ⇔ 本次载入没有任何校验失败。 */
    configValidation: () => ({
      ok: configValidationLog.length === 0,
      failures: configValidationLog.length,
      diagnostics: configValidationLog.slice(),
      minimumSupportedSessionStoreMaxFiles: MIN_SESSION_STORE_MAX_FILES,
      minimumDiagnosticAnchor: SESSION_STORE_MAX_FILES_MIN_DIAGNOSTIC,
      effective: { sessionStoreMaxFiles: cfg.sessionStoreMaxFiles, sessionStoreTtlDays: cfg.sessionStoreTtlDays },
    }),
    /**
     * 显式执行一次会话文件保留策略（返回可审计报告）。
     * 生产路径由 saveStore 节流自动触发；此入口供测试/运维手动核对，语义完全一致。
     */
    pruneSessionStore: (now) => pruneSessionStore(now),
    /** 测试用：把某会话标记为活跃（等价于它刚跑过 pre-step）。 */
    _touchActiveForTest: (sid) => touchActive(sid),
    // ── F1 R1：审批台账的**只读诊断面**（测试/运维用；不外泄任何写路径之外的秘密）──
    /**
     * 本实例的审批台账句柄。台账是**落盘**的追加式记录（无进程内密钥），因此把它交给
     * 测试并不削弱安全性——真正的防线是"记录必须与对象/内容/来源/消费标记逐字段自洽"，
     * 而记录的内容本就写在 stateDir 下的明文 JSONL 里（agent 有 fs 权限即可读；见 KNOWN_ISSUES）。
     */
    approvalLedger: () => approvalLedger,
    approvalLedgerFile: () => approvalLedgerFile,
    /** 台账现状摘要（只读；用于断言跨进程重启后授权仍成立）。 */
    approvalLedgerStatus: () => {
      // ★ F1 R1：**信任锚是否真的在岗**必须可观测——否则"复验器被摘掉"这类回归
      //   只会表现为"合法批准突然发不出去"（或更糟：被判成 flaky 而放宽闸门）。
      const hostFactVerification = !approvalLedger
        ? 'unavailable'
        : (!sessionsServiceAvailable
          ? 'service_absent'
          : (typeof approvalLedger.verifyHostFact === 'function' ? 'ctx.sessions' : 'absent'));
      if (!approvalLedger) {
        return { available: false, file: approvalLedgerFile, records: 0, chainOk: false, error: 'approval_ledger_unavailable', hostFactVerification };
      }
      let records = [];
      let chainOk = false;
      let error = null;
      try {
        records = approvalLedger.records() ?? [];
        // 句柄方法名以适配层为准（integrity()）；缺失时退回纯函数链校验。
        const v = typeof approvalLedger.integrity === 'function'
          ? approvalLedger.integrity()
          : verifyApprovalLedgerChain(records);
        chainOk = v.ok === true;
        if (!chainOk) error = v.reason ?? null;
      } catch (err) {
        error = String(err?.message ?? err);
      }
      return { available: true, file: approvalLedgerFile, records: records.length, chainOk, error, hostFactVerification };
    },
    /** 用**本实例的**台账判定一条经验的 live 授权（避免测试各自导入 core 副本导致口径漂移）。 */
    validHumanApprovalFor: (exp) => validHumanApproval(exp, approvalLedger),
    /** 用**本实例的**台账判定可否发布（同上）。 */
    canPublishFor: (exp) => canPublish(exp, approvalLedger),
    /** 用**本实例的**台账判定可否召回（同上）。 */
    isRecallableFor: (exp) => isRecallable(exp, approvalLedger),
  };
}

// 供单测/诊断复用的纯导出（不经过 apply）
export { containsSecret, redactSecrets, MAX_TITLE_LEN };
