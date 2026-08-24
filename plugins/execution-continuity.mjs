// execution-continuity.mjs —— Durable Execution Continuity（Bootstrap v1）
//
// 目标：把「模型/API/网络/Server 异常后任务永久停住、必须人工输入'继续'」变成
//       「系统自动分类 → 有界恢复 → 继续当前 Goal」。
//
// 机制（全部在 Plugin 层，不改官方 Core）：
//   1) Durable Execution Intent：每个会话一条持久记录（%LOCALAPPDATA%\DSHHarness\state\
//      execution-intents.json），记录 state / autoResume / 计数器 / lastFailure /
//      lastActivity，原子写入。这是恢复的唯一真源（Single Authority）。
//   2) agent/request-error（链尾）：官方 llm-retry + openrouter-router 放弃后，本插件
//      分类剩余错误：
//        - RETRYABLE_TRANSIENT / RATE_LIMIT（含 Retry-After）→ 有界退避后 {kind:"retry"}
//        - CONTEXT_OVERFLOW → ctx.compaction.compactNow() 压缩后同模型重试（有上限）；
//          压缩不可用/仍超限 → 标记 pendingFallback 到更大 context 的兼容模型
//        - PROVIDER_OUTAGE / QUOTA_EXHAUSTED / MODEL_UNAVAILABLE → 能力兼容 fallback
//          （compatibleFallback 校验 modalities/tools/context），下次 agent/request 改写
//        - AUTH / INVALID_REQUEST(不可修复) / UNKNOWN → FAILED_FATAL，绝不自动重放
//      每次都写诊断日志（requested vs actual model，fallback reason，retry count）。
//   3) agent/request：应用 pendingFallback（一次性，经 modelSupports 校验，不制造非法 pair）。
//   4) agent/error：记录失败状态。
//   5) 恢复执行（resumeViaApi）：通过本服务 loopback HTTP API（与 goal-recovery.mjs 同路径，
//      /api/goal.resume + /api/session.prompt mode:queue）恢复会话——该路径经 ensureSession
//      正确组合 agent 预设，避免进程内裸 resume 产出残缺 agent。触发时机：
//        - 服务就绪后：扫描 intent store 中可恢复状态（RUNNING / RETRYING /
//          WAITING_NETWORK / WAITING_PROVIDER / RECOVERY_QUEUED / INTERRUPTED_BY_RESTART），
//          多任务逐个恢复（最多 maxConcurrentResume 并发，其余 RECOVERY_QUEUED 延迟重试）；
//        - 定时器：WAITING_PROVIDER / WAITING_NETWORK / RECOVERY_QUEUED 到期重试。
//      60 秒 anti-double-kick guard（与 goal-recovery.mjs 共存不互踢）。
//   6) 用户意图安全：USER_PAUSED / USER_CANCELLED / WAITING_USER / COMPLETED /
//      FAILED_FATAL 一律不自动恢复；未回答提问（ask_user_question 无 tool/result）→ WAITING_USER。
//   7) 危险副作用：恢复提示明确要求 agent "先验证上次操作是否已完成再决定继续"，
//      不重复执行删除/发送/支付类操作（真实判定依赖 agent 校验，v1 提供安全默认+可见诊断）。
//
// 配置（环境变量/插件 config，均可缺省）：
//   EC_BUDGET_SAME_MODEL_RETRIES / EC_BUDGET_FALLBACK / EC_BUDGET_CONTEXT_RECOVERY
//   EC_BUDGET_AUTO_RESUME_CYCLES / EC_MAX_CONCURRENT_RESUME / EC_STATE_DIR
//   EC_API_PORT（loopback API 端口，默认 3080）
//   EC_DISABLED=true 时插件不注册任何 hook（用于快速回退）。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  classifyFailure,
  createCircuitBreaker,
  backoffDelay,
  hasBudget,
  compatibleFallback,
  modelSupports,
  CATEGORY,
  DEFAULT_BUDGETS,
} from "./execution-continuity-core.mjs";
import { evaluateCompletion } from "./completion-truth-core.mjs";

export const name = "execution-continuity";

// ─── Crash-Safe Dependency Declaration（P0 fix 2026-08-23）───────────────
// 历史事故：inject 曾声明 "compaction" 为 boot 期硬依赖。web profile 的 host
// 组合树不挂载 compaction service（compaction-basic 位于 dsh-base 的 agent
// preset 层，web-app 层把宿主行移入 preset realm），导致 Cordis
// assertEntriesActivated 发现 entry 永远 pending（waiting for service:
// compaction）→ 整个 Host boot throw → DSH Server crash-loop。
// 修复：compaction 不再作为 inject 依赖声明；改为运行时通过 getCompaction()
// 惰性探测（ctx.get 优先、属性访问兜底），缺失 → contextOverflowRecovery
// DEGRADED，Host 照常启动（fail-open）。agents/goals/sessions 是 web host
// 平面真实存在的服务，保留声明。
export const inject = ["agents", "goals", "sessions"];

// ─── 可恢复状态集（自动恢复白名单）───────────────────────────────────────────
export const RECOVERABLE_STATES = Object.freeze([
  "RUNNING",
  "RETRYING",
  "WAITING_NETWORK",
  "WAITING_PROVIDER",
  "RECOVERY_QUEUED",
  "INTERRUPTED_BY_RESTART",
]);
// 禁止自动恢复
export const NON_RECOVERABLE_STATES = Object.freeze([
  "USER_PAUSED",
  "USER_CANCELLED",
  "WAITING_USER",
  "COMPLETED",
  "FAILED_FATAL",
]);

const STATE = {
  RUNNING: "RUNNING",
  RETRYING: "RETRYING",
  WAITING_NETWORK: "WAITING_NETWORK",
  WAITING_PROVIDER: "WAITING_PROVIDER",
  RECOVERY_QUEUED: "RECOVERY_QUEUED",
  INTERRUPTED_BY_RESTART: "INTERRUPTED_BY_RESTART",
  USER_PAUSED: "USER_PAUSED",
  USER_CANCELLED: "USER_CANCELLED",
  WAITING_USER: "WAITING_USER",
  COMPLETED: "COMPLETED",
  FAILED_FATAL: "FAILED_FATAL",
  NEEDS_VERIFICATION: "NEEDS_VERIFICATION",
};

function envNum(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ─── 惰性 Compaction 探测（P0 fix 2026-08-23 + P1-B fix 2026-08-23）──────
// compaction 是 optional 能力：web host 平面没有该 service（compaction-basic
// 位于 agent preset 的 isolated realm），但 **每个真实 agent 的 scoped ctx 有
// 自己的 compaction service**（CompactionEngine extends Service，preset 挂载）。
// P1-B 修复：不再只用 host ctx.get 探测（那永远返回 undefined → 假 DEGRADED），
// 而是优先从 agent 的 scoped ctx 惰性获取；且**移除模块级全局缓存**（host 层
// 探测到 null 不应污染所有 agent 的判断——per-agent 可用性各不相同）。
// 保持 fail-open：任何路径失败 → 视为缺失 → 降级，绝不抛错、绝不成为 boot 依赖。
function getCompaction(ctx, agent) {
  let comp = null;
  // 1) 优先 agent scoped ctx（真实 compaction 所在）
  try {
    const actx = agent && (agent.ctx || agent.context);
    if (actx) {
      if (typeof actx.get === "function") comp = actx.get("compaction", false);
      if (!comp && typeof actx.read === "function") comp = actx.read("compaction");
      if (!comp && actx.compaction !== undefined) comp = actx.compaction;
      // 属性访问可能 throw（proxy "cannot get property without inject"）
      if (!comp && actx.compaction) comp = actx.compaction;
    }
  } catch { comp = null; }
  // 2) 回退 host ctx（某些部署可能 host 层也有）
  if (!comp) {
    try {
      if (typeof ctx.get === "function") comp = ctx.get("compaction", false);
      if (!comp && typeof ctx.read === "function") comp = ctx.read("compaction");
      if (!comp && ctx.compaction) comp = ctx.compaction;
    } catch { comp = null; }
  }
  if (comp && typeof comp !== "object" && typeof comp !== "function") comp = null;
  return comp;
}
function compactionAvailable(ctx, agent) {
  const c = getCompaction(ctx, agent);
  return !!(c && typeof c.compactNow === "function");
}

function defaultStateDir() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "DSHHarness", "state");
}

// ─── Intent store（原子写，Single Authority）────────────────────────────────
export class IntentStore {
  constructor(stateDir = null, logger = null) {
    this.dir = stateDir || defaultStateDir();
    this.file = path.join(this.dir, "execution-intents.json");
    this.logger = logger;
    this.data = { version: 1, intents: {} };
    this.load();
  }
  load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") this.data = { version: 1, ...parsed };
      }
    } catch (e) {
      this._warn(`intent store load failed: ${e.message}`);
    }
  }
  _warn(msg) {
    try { this.logger?.warn(`[execution-continuity] ${msg}`); } catch { /* noop */ }
  }
  persist() {
    try {
      const tmp = this.file + ".tmp";
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) {
      this._warn(`intent store persist failed: ${e.message}`);
      return false;
    }
  }
  get(sessionId) { return this.data.intents[sessionId] || null; }
  ensure(sessionId) {
    let it = this.data.intents[sessionId];
    if (!it) {
      it = {
        sessionId,
        goalId: null,
        state: "RUNNING",
        autoResume: true,
        retryCount: 0,
        fallbackCount: 0,
        contextRecoveryCount: 0,
        autoResumeCycles: 0,
        lastFailure: null,
        lastFailureAt: null,
        lastActivity: Date.now(),
        createdAt: Date.now(),
        resumedAt: null,
        lastResumeAt: null,
        pendingFallback: null,
        nextRetryAt: null,
        // Phase 02 R5 Refinement: schema version + completion-verification kind.
        // verificationKind distinguishes a REAL unresolved side-effect
        // (UNRESOLVED_SIDE_EFFECT — permanent, fail-closed) from legacy
        // evidence-unavailable states written by older code
        // (LEGACY_EVIDENCE_UNAVAILABLE) and the current transient defer
        // (EVIDENCE_DEFER). Boot reconcile uses this to migrate only exact
        // legacy signatures.
        schemaVersion: 2,
        verificationKind: null,
        ctUnresolvedCall: null, // persisted exact {callId, tool} if known
        goalRoundsObserved: null, // last observed goal roundsStarted (goal liveness)
        // Phase 02 R6 (R5-B4): goal-scoped liveness identity + bounded recheck
        // state — server generation seen, goal id/revision, observation time and
        // consecutive liveness-unknown count.
        serverGenerationSeen: null,
        goalIdObserved: null,
        goalRevisionObserved: null,
        goalObservedAt: null,
        livenessUnknownCount: 0,
      };
      this.data.intents[sessionId] = it;
    }
    return it;
  }
  setState(sessionId, state, extra = {}) {
    const it = this.ensure(sessionId);
    it.state = state;
    it.lastActivity = Date.now();
    Object.assign(it, extra);
    this.persist();
    return it;
  }
  touch(sessionId) {
    const it = this.ensure(sessionId);
    it.lastActivity = Date.now();
    this.persist();
  }
  // Phase 02 R5 Refinement: raw iteration over ALL intents (including
  // non-recoverable states like NEEDS_VERIFICATION) for legacy reconcile.
  all() {
    return Object.values(this.data.intents);
  }
  listRecoverable() {
    return Object.values(this.data.intents).filter((it) =>
      // P0 fix 2026-08-23：排除 RETRYING —— 该状态表示 handler 已接管、正在退避重试，
      // boot scan / timer 不应并发 resume（避免与 handler 的 retry 竞态）。
      it.autoResume !== false &&
      it.state !== STATE.RETRYING &&
      RECOVERABLE_STATES.includes(it.state));
  }
  listDue(now) {
    return Object.values(this.data.intents).filter((it) =>
      it.autoResume !== false &&
      (it.state === STATE.WAITING_PROVIDER || it.state === STATE.WAITING_NETWORK || it.state === STATE.RECOVERY_QUEUED) &&
      it.nextRetryAt && it.nextRetryAt <= now &&
      (it.autoResumeCycles || 0) < 0 + 999); // 预算检查在调用处做
  }
}

// ─── 未回答提问检测（WAITING_USER 保护）────────────────────────────────────
export function hasPendingQuestion(session) {
  try {
    if (!session || !session.events) return false;
    const events = session.events;
    let askedTurn = null;
    let askedCallId = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      const data = ev.data || {};
      if (ev.type === "assistant/message") {
        const content = data.message?.content;
        if (Array.isArray(content)) {
          const q = content.find((b) => b && (b.type === "tool-call" || b.type === "function_call") && String(b.name || b.function?.name || "").includes("ask_user_question"));
          if (q) {
            askedTurn = data.turn;
            // tool-call id 可能存在于不同字段（id / tool_call_id / call_id / function.call_id）
            askedCallId = q.id || q.tool_call_id || q.call_id || q.function?.call_id || null;
            break;
          }
        }
      }
    }
    if (askedTurn === null) return false;
    // 匹配 tool/result：优先按 call id，其次按 turn。任何匹配都说明问题已回答。
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type !== "tool/result") continue;
      const d = ev.data || {};
      if (askedCallId) {
        // 真实 DSH 结构：assistant/message tool-call 块用 block.id；tool/result 用
        // event.data.message.source.callId（repair.js / invariant.js 同源）。
        const rid = d.tool_call_id || d.toolCallId || d.call_id || d.id ||
          (d.message && d.message.source && d.message.source.callId) ||
          (d.result && (d.result.tool_call_id || d.result.call_id));
        if (rid && String(rid) === String(askedCallId)) return false;
      }
      if (d.turn === askedTurn) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ─── 插件主体 ───────────────────────────────────────────────────────────────
export function apply(ctx, config = {}) {
  if (process.env.EC_DISABLED === "true") {
    ctx.logger?.info("[execution-continuity] disabled (EC_DISABLED=true)");
    return {};
  }
  const logger = ctx.logger || { info() {}, warn() {}, error() {} };
  // Phase 02 R8 (R8-1): server generation = the REAL per-boot identity. The
  // canonical helper Get-DshGenerationId (dsh-generation.ps1) is
  // `${StartTime.Ticks}_${PID}` — new value on every server boot, unchanged on
  // plugin reload. The launcher runtime ledger records the same server process
  // via childPid + startedAt, so we construct the IDENTICAL identity from it:
  // `${childPid}_${Date.parse(startedAt)}` (PID + boot timestamp = per-boot,
  // reload-invariant). entryHash is an executable-PATH identity (SHA256 of the
  // DSH entry path) — it does NOT change per boot and must NOT be used as
  // generation. When the ledger is unreadable we FAIL-CLOSED to null (liveness
  // unknown) — never Date.now()/plugin-start (plugin reload would fake a new
  // generation).
  let serverGeneration = null;
  try {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const runtimePath = path.join(local, "DSHHarness", "logs", `dsh-runtime-${process.env.EC_API_PORT || 3080}.json`);
    if (fs.existsSync(runtimePath)) {
      const rt = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
      if (rt && rt.childPid && rt.startedAt) {
        const bootMs = Date.parse(rt.startedAt);
        if (Number.isFinite(bootMs) && bootMs > 0) {
          serverGeneration = `boot:${rt.childPid}_${bootMs}`;
        }
      }
    }
  } catch { serverGeneration = null; }
  // No processStartMs fallback: null generation -> liveness unknown (fail-closed).
  const store = new IntentStore(config.stateDir || null, logger);
  const budgets = {
    ...DEFAULT_BUDGETS,
    sameModelRetries: envNum("EC_BUDGET_SAME_MODEL_RETRIES", config.sameModelRetries ?? DEFAULT_BUDGETS.sameModelRetries),
    providerFallbackCount: envNum("EC_BUDGET_FALLBACK", config.fallbackCount ?? DEFAULT_BUDGETS.providerFallbackCount),
    contextRecoveryCount: envNum("EC_BUDGET_CONTEXT_RECOVERY", config.contextRecoveryCount ?? DEFAULT_BUDGETS.contextRecoveryCount),
    autoResumeCycles: envNum("EC_BUDGET_AUTO_RESUME_CYCLES", config.autoResumeCycles ?? DEFAULT_BUDGETS.autoResumeCycles),
  };
  const maxConcurrentResume = envNum("EC_MAX_CONCURRENT_RESUME", config.maxConcurrentResume ?? 2);
  const apiPort = envNum("EC_API_PORT", config.apiPort ?? 3080);
  // ─── Safe Mode（P0 fix 2026-08-23）───────────────────────────────────────
  // 第一轮 Runtime 注册默认只启用被动能力：错误分类 + 有界 retry/fallback 决策
  // + 诊断日志。自动 resume / 恢复扫描（主动回踢会话）默认关闭，由
  // config.enableAutoResume 或环境变量 EC_ENABLE_AUTO_RESUME=true 显式开启。
  // 目标：先证明插件可以安全存在于 Host 中（fail-open 第一原则）。
  const enableAutoResume = process.env.EC_ENABLE_AUTO_RESUME === "true"
    ? true
    : config.enableAutoResume === true;
  // 能力矩阵（capability-level degradation）：compaction 缺失只影响
  // contextOverflowRecovery（compact 环节降级），其余能力不受牵连。
  const capability = {
    retryRecovery: true,
    providerFallback: true,
    goalResume: enableAutoResume,
    restartRecovery: enableAutoResume,
    contextOverflowRecovery: true, // compact 子环节单独看 compaction 可用性
    reasoningProtocolRecovery: true,
  };
  const breaker = createCircuitBreaker(
    envNum("EC_BREAKER_COOLDOWN_MS", config.breakerCooldownMs ?? 60000),
    envNum("EC_BREAKER_THRESHOLD", config.breakerThreshold ?? 3),
  );
  const logPath = path.join(store.dir, "execution-continuity.log");
  const resumeCooldownMs = 60000; // anti-double-kick with goal-recovery.mjs

  // ─── Retry Policy Guard（P0 fix 2026-08-23）────────────────────────────
  // 官方 dsh-llm-retry 的 mode:'always' 语义 = 永久重试（invariant 强制省略
  // maxRetries），若未来某 provider 被误配成 always 且无配套防护，可导致
  // 对永久性错误无限重试。本 Guard 在 boot 时扫描 provider 注册表：
  //   - 发现 mode:'always' → 记录 warning + 建议显式 maxRetries 或改 normal；
  //   - 不改官方引擎、不拦截请求（任务书：config guard / warning 优先）。
  function checkRetryPolicyGuard() {
    try {
      const providers = ctx.llm?.providers || {};
      for (const p of Object.keys(providers)) {
        const conf = providers[p];
        const rp = conf && (conf.retryPolicy || (conf.llm && conf.llm.retryPolicy));
        if (rp && rp.mode === "always") {
          diag(`RETRY-GUARD provider=${p} retryPolicy.mode=always (unbounded retry) -> recommend maxRetries or mode:normal`);
          try { logger.warn(`[execution-continuity] retry guard: provider "${p}" uses unbounded retry mode 'always'; consider maxRetries or mode:normal`); } catch { /* noop */ }
        }
      }
    } catch { /* 注册表不可用时跳过（fail-open） */ }
  }

  function diag(line) {
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch { /* noop */ }
    try { logger.info(`[execution-continuity] ${line}`); } catch { /* noop */ }
  }

  // Phase 02 R2 (BLOCKING-1): EC no longer constructs model candidate pools or
  // picks fallback providers/models. Model selection is the Router's sole
  // authority; EC records recovery requirements (see agent/request-error) that
  // the Router's next capability-aware route() decision honors.

  // loopback API（与 goal-recovery.mjs 同协议；经 ensureSession 正确组合 agent）
  let rpcSeq = 0;
  async function apiRpc(method, payload) {
    const rpcId = `ec-${Date.now()}-${++rpcSeq}`;
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${method}`);
    const body = await res.json();
    const result = body && body.result;
    if (!result || result.ok !== true) {
      throw new Error(result && result.error ? `${method}: ${result.error.message}` : `${method} failed`);
    }
    return result.value;
  }

  async function waitForApi(tries = 20, delayMs = 1000) {
    for (let i = 1; i <= tries; i++) {
      try { await apiRpc("host.describe", {}); return true; } catch { if (i < tries) await sleep(delayMs); }
    }
    return false;
  }

  // ── 恢复执行：goal.resume + session.prompt(queue)（loopback API）─────────

  // ─── WAITING_USER 安全 Gate（P1-A fix 2026-08-23）─────────────────────
  // 上一轮审计（HARNESS_PRODUCTION_SELF_AUDIT_20260823 P1-2）确认：
  //   hasPendingQuestion() 存在但从未接入生产恢复路径，导致"存在未回答
  //   ask_user_question 的 goal 在重启后可能被当作 RUNNING 自动恢复"。
  // 本 Gate 是所有"准备自动恢复"入口的统一安全检查（fail-closed）：
  //   - 通过 ctx.sessions 服务读取真实 session（含 events，不依赖 HTTP API）；
  //   - hasPendingQuestion(session) 为 true（存在未回答提问）→ state=WAITING_USER，
  //     跳过自动恢复；
  //   - 无法获取 session / 无法判断（fail-closed）→ 保守跳过本次恢复，
  //     宁可等待用户，不越过用户确认边界。
  // 目标：无论 execution-continuity 还是 goal-recovery 哪套先运行，都不能
  // 恢复等待用户输入的 Goal。
  async function checkUserWaitGate(sessionId, it, reason) {
    try {
      if (!ctx.sessions || typeof ctx.sessions.get !== "function") {
        // 服务不可用：fail-closed —— 保守跳过恢复（不确定用户状态就不动）
        diag(`WAIT-GATE sid=${sessionId} sessions service unavailable -> fail-closed skip (${reason})`);
        return true;
      }
      const session = ctx.sessions.get(sessionId);
      if (!session) {
        // session 不存在于 store：让后续 session.list 检查处理（可能已删）
        return false;
      }
      if (hasPendingQuestion(session)) {
        it.state = STATE.WAITING_USER;
        it.autoResume = false;
        it.lastFailure = { category: "waiting-user", message: "pending user question; auto-resume blocked" };
        store.persist();
        diag(`WAIT-GATE sid=${sessionId} pending user question -> WAITING_USER, resume skipped (${reason})`);
        return true;
      }
      return false;
    } catch (e) {
      // fail-closed：判断失败视为"不确定用户状态"，保守跳过
      diag(`WAIT-GATE sid=${sessionId} check error (${String(e.message).slice(0, 80)}) -> fail-closed skip (${reason})`);
      return true;
    }
  }

  // Phase 02 R1 (BLOCKING-6): Completion Truth — deterministic side-effect
  // idempotency check over real session events. Returns one of:
  //   "clean"               - no outstanding side-effecting tool-call; safe to resume
  //   "completed"           - side-effecting tool-call HAS a matching result; do not replay
  //   "needs_verification"  - side-effecting tool-call WITHOUT result (outcome unknown);
  //                           never blind-replay -> caller must fail-closed
  // Phase 02 R2 (BLOCKING-5): the deterministic completion-truth decision lives
  // in completion-truth-core.mjs (pure module, imported by BOTH production and
  // tests — no duplicated algorithm). This wrapper only feeds it the live event
  // log; fail-closed when events are unavailable.
  async function completionTruth(sessionId, it) {
    try {
      const session = ctx.sessions?.get ? ctx.sessions.get(sessionId) : null;
      if (!session || !Array.isArray(session.events)) {
        // Phase 02 R5 Addendum (transient CT evidence defer): events temporarily
        // unavailable is NOT the same as "we read events and found an unresolved
        // side-effect call". Return a TRANSIENT marker so the caller defers with
        // backoff instead of pinning the session to permanent NEEDS_VERIFICATION.
        diag(`CT sid=${sessionId} session events unavailable -> evidence_defer (transient, bounded)`);
        return { state: "evidence_unavailable", detail: "session events unavailable" };
      }
      const res = evaluateCompletion(session.events);
      diag(`CT sid=${sessionId} -> ${res.state}${res.detail ? " " + res.detail : ""}`);
      return res;
    } catch (e) {
      diag(`CT sid=${sessionId} events check error (${String(e.message).slice(0, 80)}) -> evidence_defer (transient)`);
      return { state: "evidence_unavailable", detail: "completion-truth check error" };
    }
  }

  // Phase 02 R7 (R6-2): run the Completion Truth gate. Returns true when the
  // state is CLEAN (safe to continue recovery/resume); false when the gate
  // already wrote a terminal/defer state (evidence_unavailable -> bounded
  // WAITING_NETWORK defer; needs_verification -> permanent NEEDS_VERIFICATION).
  // This is the SINGLE CT decision used by both the normal resume path and the
  // liveness (zombie/no-progress) recovery path — no duplicated algorithm.
  async function runCtGate(sessionId, it) {
    const ct = await completionTruth(sessionId, it);
    if (ct.state === "evidence_unavailable") {
      const ctCap = 5;
      it.ctDeferCount = (it.ctDeferCount || 0) + 1;
      if (it.ctDeferCount > ctCap) {
        store.setState(sessionId, STATE.NEEDS_VERIFICATION, {
          reason: `completion-evidence unavailable beyond ${ctCap} defers (${ct.detail || "events unavailable"}); manual review required`,
          schemaVersion: 2,
          verificationKind: "LEGACY_EVIDENCE_UNAVAILABLE",
        });
        diag(`CT sid=${sessionId} evidence defer cap exceeded (${it.ctDeferCount} > ${ctCap}) -> NEEDS_VERIFICATION (manual review)`);
      } else {
        const retryAt = Date.now() + Math.max(10000, backoffDelay(it.ctDeferCount, budgets, 0));
        store.setState(sessionId, STATE.WAITING_NETWORK, {
          reason: `CT-evidence-defer: ${ct.detail || "events unavailable"} (${it.ctDeferCount}/${ctCap})`,
          nextRetryAt: retryAt,
          ctDeferCount: it.ctDeferCount,
          schemaVersion: 2,
          verificationKind: "EVIDENCE_DEFER",
        });
        diag(`CT sid=${sessionId} evidence unavailable -> bounded defer #${it.ctDeferCount} nextRetryAt=${retryAt}`);
      }
      return false;
    }
    if (ct.state === "needs_verification") {
      store.setState(sessionId, STATE.NEEDS_VERIFICATION, {
        reason: `completion-unknown: side-effect tool-call without result (${ct.detail || "outcome unknown"})`,
        schemaVersion: 2,
        verificationKind: "UNRESOLVED_SIDE_EFFECT",
        ctUnresolvedCall: ct.detail ? String(ct.detail).slice(0, 200) : null,
      });
      diag(`CT sid=${sessionId} side-effect tool-call w/o result -> NEEDS_VERIFICATION (no blind replay)`);
      return false;
    }
    // clean
    if (it.ctDeferCount) { it.ctDeferCount = 0; }
    return true;
  }

  // Phase 02 R8 (R8-2): SINGLE shared "resume after CT clean" helper used by BOTH
  // the normal resume path and the liveness (zombie/no-progress) recovery path.
  // Contract (Reviewer): only a REAL goal.resume OR queue-kick SUCCESS evidence
  // writes RUNNING/RESUME-OK; any failure writes a DURABLE due-state
  // (RECOVERY_QUEUED/WAITING_PROVIDER) + nextRetryAt + bounded budget, so the
  // timer re-drives it. There is exactly ONE recovery tail — no second half-baked
  // path that silently returns RUNNING on failure.
  async function resumeAfterCtClean(sessionId, it, reason) {
    // goal.resume with current revision (same source as goal-recovery.mjs)
    let goalActive = false;
    let goalRef = it.goalId ? { id: it.goalId } : null;
    try {
      const goalList = await apiRpc("session.list", {});
      const items2 = (goalList && goalList.items) || [];
      const found2 = items2.find((i) => i.sessionId === sessionId);
      const gv = found2 && found2.projections && found2.projections.values && found2.projections.values.goal;
      const g = gv && gv.goal;
      if (g && g.id && typeof g.revision === "number") {
        goalRef = { id: g.id, revision: g.revision };
        if (it.goalId !== g.id) { it.goalId = g.id; }
      }
    } catch { /* projection unavailable -> fall back to intent goalId */ }
    if (goalRef && goalRef.id) {
      try {
        await apiRpc("goal.resume", { sessionId, ref: goalRef });
        goalActive = true;
        diag(`RESUME-CT-CLEAN sid=${sessionId} goal re-armed (${reason})`);
      } catch (e) {
        diag(`RESUME-CT-CLEAN sid=${sessionId} goal.resume failed: ${String(e.message).slice(0, 120)} (prompt fallback)`);
      }
    } else {
      diag(`RESUME-CT-CLEAN sid=${sessionId} no goalRef -> prompt-only fallback`);
    }
    const message = "[execution-continuity] The local DSH server restarted / the task was interrupted. Inspect the current session state and workspace, verify the last operation's outcome before repeating any write/delete/send/payment action, then continue the task. Do not re-run the whole task from scratch.";
    try {
      await apiRpc("session.prompt", { sessionId, mode: "queue", content: [{ type: "text", text: message }] });
      it.lastResumeAt = Date.now();
      it.autoResumeCycles = (it.autoResumeCycles || 0) + 1;
      it.resumedAt = Date.now();
      if (it.resumeRetryCount) { it.resumeRetryCount = 0; }
      // R8-2: RUNNING ONLY after the kick was ACCEPTED (goal.resume OK or queue
      // accepted). Reset the liveness baseline so the resumed goal gets a fresh
      // grace window and the bounded counter does not accumulate.
      it.goalObservedAt = Date.now();
      it.livenessUnknownCount = 0;
      store.setState(sessionId, STATE.RUNNING, {
        note: `resume-after-ct-clean (${reason}): kick accepted`,
        goalObservedAt: it.goalObservedAt,
        livenessUnknownCount: 0,
      });
      diag(`RESUME-OK sid=${sessionId} goalActive=${goalActive} cycles=${it.autoResumeCycles} (${reason})`);
      return STATE.RUNNING;
    } catch (e) {
      // DURABLE due-state: the timer re-drives via listDue (WAITING_PROVIDER is
      // a due-state). Never return RUNNING on failure.
      diag(`RESUME-FAILED sid=${sessionId} kick failed: ${String(e.message).slice(0, 160)}`);
      const retryAt = Date.now() + 30000;
      store.setState(sessionId, STATE.WAITING_PROVIDER, { nextRetryAt: retryAt, reason: `kick failed: ${String(e.message).slice(0, 120)}` });
      diag(`RESUME-DUE sid=${sessionId} durable WAITING_PROVIDER nextRetryAt=${retryAt}`);
      return STATE.WAITING_PROVIDER;
    }
  }

  // Phase 02 R7 (R6-2) + R8 (R8-2): CT-gated recovery for LIVENESS_UNKNOWN —
  // Completion Truth decides, never blind-resume. clean -> resumeAfterCtClean
  // (the SAME tail as normal resume); evidence unavailable / unresolved ->
  // handled by runCtGate (defer / NEEDS_VERIFICATION). Returns the state written.
  async function ctGatedRecovery(sessionId, it, why) {
    const proceed = await runCtGate(sessionId, it);
    if (!proceed) return it.state; // defer / needs_verification already written
    return await resumeAfterCtClean(sessionId, it, why);
  }

  async function resumeViaApi(sessionId, reason) {
    const it = store.get(sessionId);
    if (!it) return;
    // anti-double-kick
    if (it.lastResumeAt && Date.now() - it.lastResumeAt < resumeCooldownMs) {
      diag(`RESUME-SKIP sid=${sessionId} within cooldown (${reason})`);
      return;
    }
    if (!hasBudget("auto-resume", it, budgets)) {
      store.setState(sessionId, STATE.FAILED_FATAL, { fatalReason: "auto-resume budget exhausted" });
      diag(`RESUME-BUDGET-EXHAUSTED sid=${sessionId} -> FAILED_FATAL`);
      return;
    }
    // Phase 02 R1 (BLOCKING-6): Completion Truth — deterministic idempotency
    // guard before ANY resume. Phase 02 R7 (R6-2): single CT decision shared
    // with the liveness recovery path (runCtGate); clean -> continue, else the
    // gate already wrote defer/NEEDS_VERIFICATION.
    {
      const proceed = await runCtGate(sessionId, it);
      if (!proceed) return;
      // clean: continue to the WAITING_USER gate + goal.resume below.
    }
    // P1-A：WAITING_USER 安全 Gate（fail-closed）。所有恢复入口（boot scan /
    // timer / turn-end 补位）最终都汇聚到这里，因此在此统一拦截。
    if (await checkUserWaitGate(sessionId, it, reason)) return;
    // 先通过 session.list 确认会话存在（避免对不存在会话误操作）。
    // P0 fix 2026-08-23：API 失败与"session 不存在"必须区分——API 暂时不可用时
    // 不能把 session 误标 COMPLETED（否则 handler 处理错误期间 boot scan 并发
    // resume 会把活跃会话标记为已结束）。API 失败 → 本次跳过，留待 timer 重试。
    try {
      const list = await apiRpc("session.list", {});
      const items = (list && list.items) || [];
      const found = items.find((i) => i.sessionId === sessionId);
      if (!found) {
        store.setState(sessionId, STATE.COMPLETED, { note: "session no longer exists" });
        diag(`RESUME sid=${sessionId} session missing -> COMPLETED`);
        return;
      }
      // Anti-double-kick（P0 fix 2026-08-23）+ Phase 02 R6 (R5-B4):
      // goal-scoped liveness state machine. `running===true` alone proves
      // nothing about the target Goal. We persist the server generation seen,
      // goal id/revision, observed rounds, observation time and a bounded
      // liveness-unknown count. ONLY same-generation + same-goal + progress
      // after a grace window justifies SKIP. No progress => persist
      // LIVENESS_UNKNOWN/RECOVERY_QUEUED + nextRetryAt + bounded count and
      // return WITHOUT kicking — the timer re-checks later (never kick in the
      // same call).
      if (found.running === true) {
        // --- goal projection (official truth from session.list) ---
        let goal = null;
        try {
          const gv = found.projections && found.projections.values && found.projections.values.goal;
          if (gv && gv.goal && gv.goal.id) {
            goal = {
              id: gv.goal.id,
              revision: typeof gv.goal.revision === "number" ? gv.goal.revision : null,
              phase: gv.goal.phase || null,
              roundsStarted: typeof gv.roundsStarted === "number" ? gv.roundsStarted : null,
            };
          }
        } catch { goal = null; }
        // R8-1: generation unavailable -> sameGen=false -> LIVENESS_UNKNOWN
        // (fail-closed). Never fabricate a generation from plugin start time.
        const sameGen = !!serverGeneration && it.serverGenerationSeen === serverGeneration;
        const sameGoal = !!(goal && it.goalIdObserved && goal.id === it.goalIdObserved && goal.revision !== null && goal.revision === it.goalRevisionObserved);
        const goalProgressed = sameGoal && goal.roundsStarted !== null && it.goalRoundsObserved !== null && goal.roundsStarted > it.goalRoundsObserved;
        const graceMs = 60000; // 60s grace before declaring liveness unknown
        // Phase 02 R7 (R6-2): goal projection MISSING — must NOT silently loop
        // in RUNNING (one-shot dead-end: timer only drives WAITING_*/QUEUED).
        // Treat as LIVENESS_UNKNOWN with a bounded nextRetryAt recheck.
        if (!goal) {
          it.livenessUnknownCount = (it.livenessUnknownCount || 0) + 1;
          const livenessCap = 6;
          if (it.livenessUnknownCount > livenessCap) {
            // no goal identity at all after cap -> CT-gated recovery (safe:
            // Completion Truth decides; never blind-resume)
            diag(`RESUME-LIVENESS sid=${sessionId} goal projection missing beyond cap -> CT-gated recovery`);
            return await ctGatedRecovery(sessionId, it, `goal projection missing (${it.livenessUnknownCount} rechecks)`);
          }
          const nextRetry = Date.now() + Math.min(120000, 15000 * it.livenessUnknownCount);
          store.setState(sessionId, STATE.RECOVERY_QUEUED, {
            note: `liveness-unknown (no goal projection) recheck #${it.livenessUnknownCount}`,
            nextRetryAt: nextRetry,
            serverGenerationSeen: serverGeneration,
            livenessUnknownCount: it.livenessUnknownCount,
          });
          diag(`RESUME-LIVENESS-UNKNOWN sid=${sessionId} goal projection missing -> RECOVERY_QUEUED recheck #${it.livenessUnknownCount} nextRetryAt=${nextRetry}`);
          return;
        }
        // 1) FIRST observation in this generation (or goal changed): record
        //    identity + observedAt, SKIP this round (grace) — do NOT kick.
        // R8-1: with NO authoritative generation we cannot claim a stable
        // identity — treat as liveness unknown (bounded recheck below), never
        // the grace-RUNNING branch (that would recreate the one-shot dead-end).
        if (!serverGeneration) {
          it.livenessUnknownCount = (it.livenessUnknownCount || 0) + 1;
          if (it.livenessUnknownCount > 6) {
            diag(`RESUME-LIVENESS sid=${sessionId} no authoritative generation beyond cap -> CT-gated recovery`);
            return await ctGatedRecovery(sessionId, it, `no server generation (${it.livenessUnknownCount} rechecks)`);
          }
          const nextRetry = Date.now() + Math.min(120000, 15000 * it.livenessUnknownCount);
          store.setState(sessionId, STATE.RECOVERY_QUEUED, {
            note: `liveness-unknown (no server generation) recheck #${it.livenessUnknownCount}`,
            nextRetryAt: nextRetry,
            serverGenerationSeen: null,
            livenessUnknownCount: it.livenessUnknownCount,
          });
          diag(`RESUME-LIVENESS-UNKNOWN sid=${sessionId} no authoritative generation -> RECOVERY_QUEUED #${it.livenessUnknownCount} nextRetryAt=${nextRetry}`);
          return;
        }
        if (!sameGen || !it.goalIdObserved || goal.id !== it.goalIdObserved) {
          store.setState(sessionId, STATE.RUNNING, {
            note: `liveness grace: observed goal ${goal ? goal.id.slice(0, 12) : "none"} (new generation/identity)`,
            serverGenerationSeen: serverGeneration,
            goalIdObserved: goal ? goal.id : null,
            goalRevisionObserved: goal ? goal.revision : null,
            goalRoundsObserved: goal && goal.roundsStarted !== null ? goal.roundsStarted : it.goalRoundsObserved,
            goalObservedAt: Date.now(),
            livenessUnknownCount: 0,
          });
          diag(`RESUME-GRACE sid=${sessionId} new generation/goal observed -> SKIP (grace, no kick)`);
          return;
        }
        // 2) goal changed revision (new goal revision) -> re-observe (grace)
        if (goal && goal.revision !== null && it.goalRevisionObserved !== null && goal.revision !== it.goalRevisionObserved) {
          store.setState(sessionId, STATE.RUNNING, {
            note: `liveness grace: goal revision changed ${it.goalRevisionObserved}->${goal.revision}`,
            goalRevisionObserved: goal.revision,
            goalRoundsObserved: goal.roundsStarted,
            goalObservedAt: Date.now(),
            livenessUnknownCount: 0,
          });
          diag(`RESUME-GRACE sid=${sessionId} goal revision changed -> SKIP (re-observe)`);
          return;
        }
        // 3) same generation + same goal + progress -> genuine SKIP
        if (goalProgressed) {
          store.setState(sessionId, STATE.RUNNING, {
            note: `already running; goal rounds progressed ${it.goalRoundsObserved}->${goal.roundsStarted}`,
            goalRoundsObserved: goal.roundsStarted,
            goalObservedAt: Date.now(),
            livenessUnknownCount: 0,
          });
          diag(`RESUME-SKIP sid=${sessionId} goal progress (rounds ${it.goalRoundsObserved}->${goal.roundsStarted}) (${reason})`);
          return;
        }
        // 4) same generation + same goal but NO progress: bounded recheck.
        //    If within grace since observation -> SKIP (give it time).
        //    If grace elapsed -> persist RECOVERY_QUEUED + nextRetryAt +
        //    bounded count and RETURN (no kick now; timer re-checks).
        const elapsed = Date.now() - (it.goalObservedAt || 0);
        if (elapsed < graceMs) {
          store.setState(sessionId, STATE.RUNNING, {
            note: `liveness grace: goal ${goal.id.slice(0, 12)} observed ${Math.round(elapsed / 1000)}s ago, no progress yet`,
            goalObservedAt: it.goalObservedAt || Date.now(),
          });
          diag(`RESUME-GRACE sid=${sessionId} no progress within grace (${Math.round(elapsed / 1000)}s/${graceMs / 1000}s) -> SKIP`);
          return;
        }
        // grace elapsed, no progress -> LIVENESS_UNKNOWN (bounded, no kick now).
        // Phase 02 R7 (R6-2): after the bounded recheck cap, enter CT-GATED
        // recovery — Completion Truth decides (clean -> resume; evidence
        // unavailable -> bounded defer; exact unresolved mutating ->
        // NEEDS_VERIFICATION). NEVER just park at FAILED_FATAL (manual backstop
        // only), and never blind-resume.
        const livenessCap = 6;
        it.livenessUnknownCount = (it.livenessUnknownCount || 0) + 1;
        if (it.livenessUnknownCount > livenessCap) {
          diag(`RESUME-LIVENESS sid=${sessionId} no goal progress beyond cap -> CT-gated recovery`);
          return await ctGatedRecovery(sessionId, it, `no goal progress (${it.livenessUnknownCount} rechecks)`);
        }
        const nextRetry = Date.now() + Math.min(120000, 15000 * it.livenessUnknownCount);
        store.setState(sessionId, STATE.RECOVERY_QUEUED, {
          note: `liveness-unknown recheck #${it.livenessUnknownCount}: goal ${goal.id.slice(0, 12)} no progress in ${Math.round(elapsed / 1000)}s`,
          nextRetryAt: nextRetry,
          livenessUnknownCount: it.livenessUnknownCount,
        });
        diag(`RESUME-LIVENESS-UNKNOWN sid=${sessionId} no progress after grace -> RECOVERY_QUEUED recheck #${it.livenessUnknownCount} nextRetryAt=${nextRetry} (no kick now)`);
        return;
      }
    } catch (e) {
      // Phase 02 R1 (BLOCKING-5): RESUME-DEFER must be DURABLE. We persist a
      // WAITING_NETWORK state with reason + nextRetryAt + budget count so the
      // timer only resumes when nextRetryAt <= now AND budget allows.
      // Phase 02 R2 (BLOCKING-4): resumeRetryCount is a REAL bounded budget —
      // it increments per defer and, at the cap, fail-closes to FAILED_FATAL
      // (no infinite 15s/backoff defer loop). Reset happens on a successful
      // RESUME-OK (see below).
      const deferCap = 8; // conservative: 8 consecutive session.list failures
      it.resumeRetryCount = (it.resumeRetryCount || 0) + 1;
      if (it.resumeRetryCount > deferCap) {
        store.setState(sessionId, STATE.FAILED_FATAL, {
          fatalReason: `RESUME-DEFER budget exhausted (${deferCap} retries); manual review required`,
          resumeRetryCount: it.resumeRetryCount,
        });
        store.persist();
        diag(`RESUME-DEFER sid=${sessionId} budget exhausted (${it.resumeRetryCount} > ${deferCap}) -> FAILED_FATAL (fail-closed)`);
        return;
      }
      const retryAt = Date.now() + Math.max(5000, backoffDelay(it.resumeRetryCount, budgets, 0));
      store.setState(sessionId, STATE.WAITING_NETWORK, {
        reason: `RESUME-DEFER: session.list unavailable (${String(e.message).slice(0, 80)})`,
        nextRetryAt: retryAt,
        lastFailure: String(e.message).slice(0, 200),
        resumeRetryCount: it.resumeRetryCount,
      });
      store.persist();
      diag(`RESUME-DEFER sid=${sessionId} durable state=WAITING_NETWORK nextRetryAt=${retryAt} retry=${it.resumeRetryCount}`);
      return;
    }

    let goalActive = false;
    try {
      // 重武装 goal：ref 必须携带当前 revision（goal.resume 校验 stale ref）。
      // 从 session.list 的 goal 投影读取最新 { id, revision }（与 goal-recovery.mjs 同源），
      // 避免 intent store 中的旧 goalId 无 revision 导致 invalid payload。
      let goalRef = it.goalId ? { id: it.goalId } : null;
      try {
        const goalList = await apiRpc("session.list", {});
        const items2 = (goalList && goalList.items) || [];
        const found2 = items2.find((i) => i.sessionId === sessionId);
        const gv = found2 && found2.projections && found2.projections.values && found2.projections.values.goal;
        const g = gv && gv.goal;
        if (g && g.id && typeof g.revision === "number") {
          goalRef = { id: g.id, revision: g.revision };
          if (it.goalId !== g.id) { it.goalId = g.id; }
        }
      } catch { /* 投影不可用时回退到 intent store 的 goalId */ }
      if (goalRef && goalRef.id) {
        try {
          await apiRpc("goal.resume", { sessionId, ref: goalRef });
          goalActive = true;
          diag(`RESUME sid=${sessionId} goal re-armed (${reason})`);
        } catch (e) {
          // 非 active / 未知 goal → 仍可用 prompt 兜底
          diag(`RESUME sid=${sessionId} goal.resume skipped: ${String(e.message).slice(0, 120)}`);
        }
      }
    } catch { /* noop */ }

    const message = reason === "restart"
      ? "[execution-continuity] The local DSH server restarted while this task was running. Inspect the current session state and workspace, verify the last operation's outcome before repeating any write/delete/send/payment action, then continue the task. Do not re-run the whole task from scratch."
      : "[execution-continuity] A recoverable provider/network interruption occurred. Inspect current state, verify the last operation completed before repeating side-effect actions, then continue the task. Do not re-run the whole task from scratch.";

    try {
      await apiRpc("session.prompt", { sessionId, mode: "queue", content: [{ type: "text", text: message }] });
      it.lastResumeAt = Date.now();
      it.autoResumeCycles = (it.autoResumeCycles || 0) + 1;
      it.resumedAt = Date.now();
      // Phase 02 R2 (BLOCKING-4): successful resume resets the durable defer
      // budget so the next network outage starts from a clean slate.
      if (it.resumeRetryCount) { it.resumeRetryCount = 0; }
      store.setState(sessionId, goalActive ? STATE.RUNNING : STATE.RUNNING);
      diag(`RESUME-OK sid=${sessionId} goalActive=${goalActive} cycles=${it.autoResumeCycles} (${reason})`);
    } catch (e) {
      diag(`RESUME-FAILED sid=${sessionId} ${String(e.message).slice(0, 160)}`);
      store.setState(sessionId, STATE.WAITING_PROVIDER, { nextRetryAt: Date.now() + 30000 });
    }
  }

  // ── Hook 1: agent/request —— Phase 02 R2 (BLOCKING-1) ─────────────────────
  // EC no longer rewrites provider/model. Model/provider selection is the sole
  // responsibility of the Router (openrouter-router agent/request, which reads
  // its own CAPABILITY/CHAINS + explicit-model preservation). EC only records
  // recovery REQUIREMENTS (above) that the Router's next routing decision honors
  // via its capability-aware route(). This hook is intentionally a pass-through.
  const disposeRequest = ctx.on("agent/request", async (payload, next) => {
    try {
      return await next();
    } catch (e) {
      diag(`agent/request next() threw (isolated): ${e && e.message ? e.message : String(e)}`);
      throw e;
    }
  });

  // ── Hook 2: agent/request-error —— 分类 + 有界恢复 ───────────────────────
  const disposeRequestError = ctx.on("agent/request-error", async (payload, next) => {
    let action;
    try {
      action = await next();
    } catch (e) {
      // 上层链路异常不应逃逸：记录并原样重抛（由上层错误处理接管）。
      diag(`agent/request-error next() threw (isolated): ${e && e.message ? e.message : String(e)}`);
      throw e;
    }
    if (action && action.kind === "retry") return action; // 官方链已接管
    try {
      const agent = payload?.agent;
      const sid = agent?.session?.id;
      const failure = payload?.failure;
      if (!sid || !failure) return action;
      const provider = payload?.provider || "";
      const model = payload?.model || payload?.resolved?.model || "";
      const cls = classifyFailure(failure);
      const it = store.ensure(sid);
      it.lastFailure = { category: cls.category, code: String(failure.code || ""), message: String(failure.message || "").slice(0, 300) };
      it.lastFailureAt = Date.now();
      it.retryCount = (it.retryCount || 0) + 1;

      const record = (msg) => diag(`${msg} sid=${sid} provider=${provider} model=${model} code=${failure.code} category=${cls.category} retry=${it.retryCount} fallback=${it.fallbackCount} ctxRec=${it.contextRecoveryCount}`);

      breaker.recordFailure(provider, model);

      switch (cls.category) {
        case CATEGORY.REASONING_PROTOCOL_ERROR: {
          // P0: reasoning_content protocol error — deterministic 400 if assistant history lost its reasoning_content.
          // Do NOT blind retry same bad request; attempt repair/retry once, then compatible fallback/disable thinking.
          breaker.recordFailure(provider, model);
          // First attempt: retry same model (session already contains reasoning block with thinkingSignature;
          // pi-ai may fill reasoning_content="" on retry when compat requires it; or history already repaired).
          if (hasBudget("retry", it, budgets)) {
            // Inspect: was original reasoning present? session history has it (even if whitespace). We log diagnosis.
            store.setState(sid, STATE.RETRYING);
            record(`REASONING_PROTOCOL_ERROR -> RETRY (repair attempt)`);
            await sleep(backoffDelay(it.retryCount, budgets, 0));
            return { kind: "retry" };
          }
          // Fallback: Phase 02 R2 (BLOCKING-1) — EC does NOT pick the fallback
          // model. It only records a recovery REQUIREMENT (reason + needed
          // capabilities). The Router (openrouter-router agent/request) is the
          // sole authority that decides provider/model on the next request.
          if (hasBudget("fallback", it, budgets) && !it.pendingFallback) {
            it.pendingFallback = {
              requirement: true, // marker: EC no longer supplies provider/model
              reason: "reasoning_protocol: router-decided compatible fallback",
              modalities: it.lastModalities || [],
              tools: true,
              used: false,
            };
            // Phase 02 R4 (Step 3): typed bridge — tell the Router (the sole
            // model authority) that this session needs a capability-compatible
            // fallback. Router consumes + acks on the next agent/request.
            try { ctx.emit("ec/recovery-requirement", { sessionId: sid, requirement: { ...it.pendingFallback } }); } catch (e) { diag(`bridge emit failed: ${e.message}`); }
            store.setState(sid, STATE.RETRYING);
            record(`REASONING_PROTOCOL_ERROR -> RECOVERY-REQUIREMENT (router decides model)`);
            await sleep(backoffDelay(it.retryCount, budgets, 0));
            return { kind: "retry" };
          }
          // Section 15: thinking disabled is emergency fallback, must be explicit, not silent
          diag(`REASONING_PROTOCOL_ERROR sid=${sid} Protocol recovery unavailable -> thinking disabled for recovery (budgets exhausted) category=${cls.category}`);
          store.setState(sid, STATE.WAITING_PROVIDER, { nextRetryAt: Date.now() + backoffDelay(it.retryCount, budgets, 0) });
          record(`REASONING_PROTOCOL_ERROR -> WAITING_PROVIDER (budgets exhausted)`);
          return action;
        }
        case CATEGORY.RETRYABLE_TRANSIENT:
        case CATEGORY.RATE_LIMIT: {
          if (breaker.canUse(provider, model) && hasBudget("retry", it, budgets)) {
            const delay = backoffDelay(it.retryCount, budgets, cls.providerRetryAfterMs);
            store.setState(sid, STATE.RETRYING);
            record(`RETRY`);
            await sleep(delay);
            return { kind: "retry" };
          }
          store.setState(sid, STATE.WAITING_PROVIDER, { nextRetryAt: Date.now() + backoffDelay(it.retryCount, budgets, cls.providerRetryAfterMs) });
          record(`RETRY-BUDGET-EXHAUSTED -> WAITING_PROVIDER`);
          return action;
        }
        case CATEGORY.CONTEXT_OVERFLOW: {
          // Phase 02 R4 (Step 5): official compaction-basic OWNS the
          // context-overflow -> compact -> retry layer (it listens on
          // agent/request-error with a real AbortSignal and only retries when
          // surface replacement progressed). EC no longer hand-calls
          // compactNow(agent, undefined) — that violated the official contract
          // (signal.throwIfAborted on undefined) and duplicated the recovery
          // authority. EC only: (a) records durable incident state, and
          // (b) if a budget remains, emits a needLargerContext recovery
          // REQUIREMENT to the Router as the fallback path.
          it.contextRecoveryCount = (it.contextRecoveryCount || 0) + 1;
          store.persist();
          if (hasBudget("fallback", it, budgets) && !it.pendingFallback) {
            // Router decides the larger-context model; EC only records the need.
            it.pendingFallback = {
              requirement: true,
              reason: "context-overflow: router-decided larger-context fallback",
              modalities: it.lastModalities || [],
              needLargerContext: true,
              used: false,
            };
            try { ctx.emit("ec/recovery-requirement", { sessionId: sid, requirement: { ...it.pendingFallback } }); } catch (e) { diag(`bridge emit failed: ${e.message}`); }
            store.setState(sid, STATE.RETRYING);
            record(`CONTEXT-OVERFLOW -> RECOVERY-REQUIREMENT (router decides model; official compaction owns compact)`);
            await sleep(backoffDelay(it.retryCount, budgets, 0));
            return { kind: "retry" };
          }
          store.setState(sid, STATE.FAILED_FATAL, { fatalReason: "context-overflow: budgets exhausted, no compatible fallback" });
          record(`CONTEXT-OVERFLOW -> FAILED_FATAL (no budget/fallback; official compaction handled compact)`);
          return action;
        }
        case CATEGORY.PROVIDER_OUTAGE:
        case CATEGORY.QUOTA_EXHAUSTED:
        case CATEGORY.MODEL_UNAVAILABLE: {
          if (hasBudget("fallback", it, budgets) && !it.pendingFallback) {
            // Router decides the compatible provider/model; EC only records need.
            it.pendingFallback = {
              requirement: true,
              reason: `${cls.category.toLowerCase()}: router-decided compatible fallback`,
              modalities: it.lastModalities || [],
              used: false,
            };
            try { ctx.emit("ec/recovery-requirement", { sessionId: sid, requirement: { ...it.pendingFallback } }); } catch (e) { diag(`bridge emit failed: ${e.message}`); }
            store.setState(sid, STATE.RETRYING);
            record(`RECOVERY-REQUIREMENT (router decides model) category=${cls.category}`);
            await sleep(backoffDelay(it.retryCount, budgets, cls.providerRetryAfterMs));
            return { kind: "retry" };
          }
          store.setState(sid, STATE.WAITING_PROVIDER, { nextRetryAt: Date.now() + backoffDelay(it.retryCount, budgets, cls.providerRetryAfterMs) });
          record(`FALLBACK-UNAVAILABLE -> WAITING_PROVIDER`);
          return action;
        }
        case CATEGORY.AUTH:
          store.setState(sid, STATE.FAILED_FATAL, { fatalReason: "auth failure: do not retry same credential" });
          record(`AUTH -> FAILED_FATAL`);
          return action;
        case CATEGORY.INVALID_REQUEST:
          store.setState(sid, STATE.FAILED_FATAL, { fatalReason: "invalid request (400): no blind retry" });
          record(`INVALID_REQUEST -> FAILED_FATAL (no blind retry)`);
          return action;
        default:
          store.setState(sid, STATE.FAILED_FATAL, { fatalReason: `unclassified failure: ${cls.category}` });
          record(`UNKNOWN -> FAILED_FATAL`);
          return action;
      }
    } catch (e) {
      diag(`request-error handler error: ${e.message}`);
      return action;
    }
  });

  // ── Hook 3: agent/error —— 记录 + P0 可恢复类做 session/event turn/end 的二层补位 ─────
  const disposeAgentError = ctx.on("agent/error", ({ agent, turn, step, error }) => {
    try {
      const sid = agent?.session?.id;
      if (!sid) return;
      const it = store.ensure(sid);
      it.lastFailure = { category: "agent-error", message: String((error && error.message) || error || "").slice(0, 300) };
      it.lastFailureAt = Date.now();
      store.persist();
      diag(`AGENT-ERROR sid=${sid} turn=${turn} step=${step}`);
    } catch { /* noop */ }
  });

  // 二层兜底：session/event 中 turn/end reason=error（agent/request 链未返回 retry 时的终态）。
  // 官方 llm-retry + openrouter-router 之后仍有未被上层 retry 的可恢复错误，最终以 turn/end error 出现。
  // execution-continuity 在 request-error 已接管的错误不再重复处理；此钩子只处理 request-error 未拦截的 recoverable turn error。
  const disposeSessionTurnError = ctx.on("session/event", (payload) => {
    try {
      const ev = payload && payload.event;
      if (!ev || ev.type !== "turn/end" || !ev.data || !ev.data.reason || ev.data.reason.kind !== "error") return;
      const err = ev.data.reason.error;
      const cls = classifyFailure({ code: String(err.code || ""), message: String(err.message || "") });
      if (cls.category !== CATEGORY.REASONING_PROTOCOL_ERROR && cls.category !== CATEGORY.CONTEXT_OVERFLOW) return;
      const sid = payload.sessionId || payload.session?.id || (typeof payload.sessionId === "string" ? payload.sessionId : null);
      if (!sid) return;
      const it = store.ensure(sid);
      // 若刚由 request-error 处理过并置为 RETRYING / WAITING_PROVIDER，不再重复调度
      if (it.state === STATE.RETRYING || it.state === STATE.WAITING_PROVIDER || it.state === STATE.RECOVERY_QUEUED) return;
      // Goal 已完成/取消/等待用户时不自动踢
      if (it.state === STATE.COMPLETED || it.state === STATE.USER_PAUSED || it.state === STATE.USER_CANCELLED || it.state === STATE.WAITING_USER) return;
      const hasComp = compactionAvailable(ctx);
      const recovered = cls.category === CATEGORY.CONTEXT_OVERFLOW ? (hasBudget("context-recovery", it, budgets) || hasBudget("fallback", it, budgets))
        : hasBudget("retry", it, budgets) || hasBudget("fallback", it, budgets);
      if (!recovered) return;
      // P0 有界预算：overflow → compact + retry；reasoning → retry
      // 使用 durable resume 路径，与 request-error 恢复一致
      if (cls.category === CATEGORY.CONTEXT_OVERFLOW && hasBudget("context-recovery", it, budgets)) {
        it.contextRecoveryCount = (it.contextRecoveryCount || 0) + 1;
      } else {
        it.retryCount = (it.retryCount || 0) + 1;
      }
      store.setState(sid, STATE.RECOVERY_QUEUED, { nextRetryAt: Date.now() + backoffDelay(it.retryCount || it.contextRecoveryCount || 1, budgets, cls.providerRetryAfterMs) });
      store.persist();
      diag(`TURN-ERROR-RECOVERABLE sid=${sid} category=${cls.category} -> RECOVERY_QUEUED (phase=turn/end补位)${enableAutoResume ? "" : " [Safe Mode: auto-resume suppressed]"}`);
      if (enableAutoResume) {
        setTimeout(() => {
          try {
            if (store.listDue(Date.now()).some((x) => x.sessionId === sid)) {
              resumeViaApi(sid, "turn-error-followup").catch(() => {});
            }
          } catch { /* noop */ }
        }, Math.min(3000, backoffDelay(1, budgets, 2000)));
      }
    } catch { /* noop */ }
  });

  // ── Hook 4: 会话/Goal 状态追踪 ────────────────────────────────────────────
  const disposers = [
    disposeRequest,
    disposeRequestError,
    disposeAgentError,
    disposeSessionTurnError,
    ctx.on("goal/changed", ({ agent }) => {
      try {
        const sid = agent?.session?.id;
        if (!sid) return;
        const it = store.ensure(sid);
        const goal = ctx.goals?.get(agent);
        if (goal) {
          it.goalId = goal.id;
          if (goal.phase === "paused") { it.state = STATE.USER_PAUSED; it.autoResume = false; }
          else if (goal.phase === "active") {
            // P1-A：goal active 但有未回答提问 → WAITING_USER（不自动恢复）
            if (hasPendingQuestion(agent?.session)) {
              it.state = STATE.WAITING_USER; it.autoResume = false;
              diag(`GOAL-CHANGED sid=${sid} pending user question -> WAITING_USER`);
            } else {
              it.state = STATE.RUNNING; it.autoResume = true;
            }
          }
          else if (goal.phase === "complete" || goal.phase === "completed" || goal.phase === "blocked") { it.state = STATE.COMPLETED; it.autoResume = false; }
          store.persist();
        }
      } catch { /* noop */ }
    }),
  ];

  // ── 恢复扫描（boot + 定时） ──────────────────────────────────────────────
  let resuming = new Set();
  // Phase 02 R5 Refinement (① legacy NEEDS_VERIFICATION reason-aware
  // migration): only EXACT legacy signatures (old schema + evidence-unavailable
  // reason + no persisted unresolved call identity) may be revalidated by a
  // fresh Completion Truth. REAL UNRESOLVED_SIDE_EFFECT / unknown/incomplete
  // states stay fail-closed forever. Returns true if the intent was migrated
  // (revalidated), false otherwise.
  async function reconcileLegacyVerification(sessionId, it) {
    try {
      if (it.state !== STATE.NEEDS_VERIFICATION) return false;
      // Phase 02 R6 (R5-B4): migration is ONLY for legacy schema (<2) intents or
      // one-shot explicit legacy markers. schemaVersion===2 states (including
      // cap-exhausted LEGACY_EVIDENCE_UNAVAILABLE manual-review) are NEVER
      // auto-migrated on boot — a manual-review state must stay manual across
      // restarts.
      if (it.schemaVersion === 2) return false;
      // 1) real unresolved side effect -> never migrate
      if (it.verificationKind === "UNRESOLVED_SIDE_EFFECT") return false;
      // 2) has a persisted exact unresolved call identity -> never migrate
      if (it.ctUnresolvedCall) return false;
      // 3) reason must match the legacy evidence-unavailable signature
      const reason = String(it.reason || "");
      const legacyReason = /session events unavailable|no session events|completion-unknown: side-effect tool-call without result \(session events unavailable\)/i.test(reason);
      if (!legacyReason) return false;
      // 4) unknown/absent kind with a NON-legacy reason -> fail-closed, no guess
      if (it.schemaVersion !== undefined && it.schemaVersion !== 1 && it.schemaVersion !== 0 && it.verificationKind === null && !legacyReason) return false;
      // ---- exact legacy signature confirmed: re-run current Completion Truth ----
      diag(`RECONCILE-LEGACY sid=${sessionId} legacy NEEDS_VERIFICATION (reason='${String(it.reason).slice(0, 80)}') -> revalidate`);
      const ct = await completionTruth(sessionId, it);
      if (ct.state === "clean") {
        store.setState(sessionId, STATE.RUNNING, { note: "legacy revalidation: CT clean -> recoverable", schemaVersion: 2, verificationKind: null, ctUnresolvedCall: null, reason: null });
        diag(`RECONCILE-LEGACY sid=${sessionId} CT clean -> RUNNING (recoverable)`);
        return true;
      }
      if (ct.state === "evidence_unavailable") {
        const retryAt = Date.now() + Math.max(10000, backoffDelay(it.ctDeferCount || 1, budgets, 0));
        store.setState(sessionId, STATE.WAITING_NETWORK, {
          reason: `CT-evidence-defer (migrated legacy): ${ct.detail || "events unavailable"}`,
          nextRetryAt: retryAt,
          ctDeferCount: (it.ctDeferCount || 0) + 1,
          schemaVersion: 2,
          verificationKind: "EVIDENCE_DEFER",
          ctUnresolvedCall: null,
        });
        diag(`RECONCILE-LEGACY sid=${sessionId} CT evidence unavailable -> bounded defer`);
        return true;
      }
      if (ct.state === "needs_verification") {
        store.setState(sessionId, STATE.NEEDS_VERIFICATION, {
          reason: `completion-unknown: side-effect tool-call without result (${ct.detail || "outcome unknown"})`,
          schemaVersion: 2,
          verificationKind: "UNRESOLVED_SIDE_EFFECT",
          ctUnresolvedCall: ct.detail ? String(ct.detail).slice(0, 200) : null,
        });
        diag(`RECONCILE-LEGACY sid=${sessionId} CT unresolved side effect -> stay NEEDS_VERIFICATION (fail-closed)`);
        return false;
      }
      return false;
    } catch (e) {
      diag(`RECONCILE-LEGACY sid=${sessionId} error (${String(e.message).slice(0, 80)}) -> no migration (fail-closed)`);
      return false;
    }
  }

  async function recoverableScan(reason) {
    // Phase 02 R5 Refinement: before scanning recoverable intents, reconcile
    // legacy NEEDS_VERIFICATION states (dead-end escape hatch with strict
    // signature matching). Revalidation may promote them into the recoverable
    // set; REAL unresolved side effects are never touched.
    try {
      const all = store.all();
      for (const it of all) {
        if (it.state === STATE.NEEDS_VERIFICATION) {
          await reconcileLegacyVerification(it.sessionId, it);
        }
      }
    } catch (e) { diag(`RECONCILE-LEGACY scan error: ${e.message}`); }
    const recoverable = store.listRecoverable();
    if (recoverable.length === 0) return;
    diag(`SCAN ${reason}: ${recoverable.length} recoverable intent(s): ${recoverable.map((i) => `${i.sessionId}[${i.state}]`).join(", ")}`);
    let active = 0;
    let queued = 0;
    for (const it of recoverable) {
      if (resuming.has(it.sessionId)) continue;
      // P1-A：scan 队列预检 WAITING_USER（fail-closed）——避免把等待用户的
      // session 设成 RECOVERY_QUEUED。resumeViaApi 内还有同一 Gate 兜底。
      if (await checkUserWaitGate(it.sessionId, it, reason)) continue;
      if (active >= maxConcurrentResume) {
        store.setState(it.sessionId, STATE.RECOVERY_QUEUED, { nextRetryAt: Date.now() + 30000 });
        queued += 1;
        diag(`SCAN QUEUED sid=${it.sessionId} (concurrency limit)`);
        continue;
      }
      resuming.add(it.sessionId);
      active += 1;
      resumeViaApi(it.sessionId, reason).catch((e) => diag(`SCAN-RESUME FAILED sid=${it.sessionId}: ${e.message}`)).finally(() => resuming.delete(it.sessionId));
    }
    if (queued > 0) setTimeout(() => recoverableScan(reason), 30000);
  }

  let recoveryTimer = null;
  function scheduleRecoveryLoop() {
    recoveryTimer = setInterval(() => {
      try {
        const now = Date.now();
        const due = store.listDue(now).filter((it) => hasBudget("auto-resume", it, budgets));
        for (const it of due) {
          if (resuming.has(it.sessionId)) continue;
          resuming.add(it.sessionId);
          resumeViaApi(it.sessionId, "timer").catch((e) => diag(`TIMER-RESUME FAILED sid=${it.sessionId}: ${e.message}`)).finally(() => resuming.delete(it.sessionId));
        }
      } catch (e) {
        diag(`recovery loop error: ${e.message}`);
      }
    }, 15000);
    recoveryTimer.unref?.();
  }

  // ── 生命周期 ─────────────────────────────────────────────────────────────
  function boot() {
    // 等待服务就绪后启动恢复扫描（async 函数，不从 generator 内 await）。
    // P0 fix 2026-08-23：整个 IIFE 包 try/catch —— 任何内部异常只记录，绝不
    // 让 unhandled rejection 逃逸到 Host 顶层。
    (async () => {
      try {
        let ready = false;
        for (let i = 0; i < 30; i++) {
          try {
            if (ctx.agents && ctx.goals && ctx.sessions) { ready = true; break; }
          } catch { /* noop */ }
          await sleep(1000);
        }
        if (!ready) {
          diag("plugin could not obtain services; recovery skipped");
          return;
        }
        const apiOk = await waitForApi(10, 1000);
        const compAvail = compactionAvailable(ctx);
        diag(`plugin ready; apiOk=${apiOk} compaction=${compAvail ? "available" : "UNAVAILABLE -> contextOverflowRecovery DEGRADED"} safeMode=${!enableAutoResume} enableAutoResume=${enableAutoResume} budgets=${JSON.stringify(budgets)} maxConcurrent=${maxConcurrentResume} capability=${JSON.stringify(capability)}`);
        // Phase 02 R7 (R6-4): record the LOADED release manifest at plugin boot —
        // server generation/boot identity + the ACTUAL plugin files this process
        // loaded (path + sha256), persisted for source/deployed/loaded
        // attestation. This is written from the plugin lifecycle itself (no new
        // service); a restart rewrites it with the new generation.
        try {
          const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
          const profileWeb = path.join(os.homedir(), ".dsh", "profiles", "web");
          const loadedManifest = {
            serverGeneration: serverGeneration, // R8-1: true per-boot identity or null
            loadedAt: new Date().toISOString(),
            pid: process.pid,
            plugins: {},
          };
          for (const p of ["execution-continuity.mjs", "openrouter-router.mjs", "commandcode-router.mjs", "model-registry.mjs", "completion-truth-core.mjs", "capacity-resolver.mjs", "runtime-capacity-adapter.mjs", "vision-bridge.mjs"]) {
            const fp = path.join(profileWeb, p);
            try {
              loadedManifest.plugins[p] = { sha256: crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex") };
            } catch { loadedManifest.plugins[p] = { sha256: null }; }
          }
          // Phase 02 R8 (R8-3): LIVE exact-route capacity probe — wire the
          // official ctx.llm.resolveModelInfo (async) via the adapter and record
          // the REAL runtime capacity for the active route + candidates. This is
          // evidence that the runtime path is genuinely wired (source=runtime),
          try {
            // diagnostic: what does ctx expose for llm?
            let llmKeys = "none", llmType = "n/a", llmHasResolve = "n/a";
            try {
              const llm = (ctx && typeof ctx.get === "function" ? ctx.get("llm") : null) || (ctx && ctx.llm) || null;
              llmKeys = llm ? Object.keys(llm).slice(0, 12).join(",") : "none";
              llmType = llm ? (llm.constructor && llm.constructor.name) : "null";
              llmHasResolve = llm ? String(typeof llm.resolveModelInfo) : "null";
            } catch (e) { llmKeys = "err:" + e.message; }
            diag(`CTX-LLM keys=${llmKeys} type=${llmType} resolveModelInfo=${llmHasResolve}`);
          } catch (e) { diag(`CTX-LLM diag error: ${String(e.message).slice(0, 80)}`); }
          // not registry hints.
          loadedManifest.capacity = { source: "none", entries: [] };
          try {
            const { makeRuntimeCapacityResolverLoose } = await import("./runtime-capacity-adapter.mjs");
            const wired = makeRuntimeCapacityResolverLoose(ctx);
            const resolver = (await import("./capacity-resolver.mjs")).createCapacityResolver({ runtimeResolve: wired.wired ? wired.runtimeResolve : null });
            const routes = [
              { provider: "commandcode", model: "deepseek/deepseek-v4-flash" },
              { provider: "opencode", model: "deepseek-v4-flash" },
              { provider: "openrouter", model: "qwen/qwen3.7-flash" },
            ];
            const entries = [];
            for (const rt of routes) {
              try {
                const r = await resolver.resolve(rt.provider, rt.model);
                entries.push({ provider: rt.provider, model: rt.model, contextWindow: r.window, source: r.source });
              } catch { entries.push({ provider: rt.provider, model: rt.model, contextWindow: null, source: "error" }); }
            }
            loadedManifest.capacity = { source: wired.wired ? "runtime" : "hint", wired: wired.wired, entries };
            diag(`LIVE-CAPACITY wired=${wired.wired} ${JSON.stringify(entries)}`);
          } catch (e) { diag(`LIVE-CAPACITY error: ${String(e.message).slice(0, 120)}`); }
          const mf = path.join(local, "DSHHarness", "state", "loaded-release.json");
          fs.mkdirSync(path.dirname(mf), { recursive: true });
          const tmp = mf + ".tmp";
          fs.writeFileSync(tmp, JSON.stringify(loadedManifest, null, 2));
          fs.renameSync(tmp, mf);
          diag(`LOADED-MANIFEST serverGeneration=${loadedManifest.serverGeneration} pid=${process.pid} -> ${mf}`);
        } catch (e) { diag(`LOADED-MANIFEST error: ${String(e.message).slice(0, 80)}`); }
        checkRetryPolicyGuard();
        if (apiOk) {
          if (enableAutoResume) {
            setTimeout(() => recoverableScan("restart"), 5000);
            scheduleRecoveryLoop();
          } else {
            diag("Safe Mode: auto resume / recovery scan DISABLED (passive classification only)");
          }
        } else {
          diag("API not reachable; recovery scan deferred");
          if (enableAutoResume) {
            setTimeout(async () => {
              try {
                const ok = await waitForApi(30, 2000);
                if (ok) { recoverableScan("restart-late"); scheduleRecoveryLoop(); }
              } catch (e) { diag(`deferred recovery scan error: ${e.message}`); }
            }, 30000);
          }
        }
      } catch (e) {
        diag(`boot error (isolated): ${e && e.message ? e.message : String(e)}`);
      }
    })();
  }

  ctx.effect(function* () {
    boot();
    yield async () => {
      for (const d of disposers) { try { d(); } catch { /* noop */ } }
      if (recoveryTimer) clearInterval(recoveryTimer);
      store.persist();
    };
  }, "execution-continuity lifecycle");

  return {
    diagnostics: () => ({
      ready: true,
      apiPort,
      budgets,
      capability,
      safeMode: !enableAutoResume,
      compactionAvailable: compactionAvailable(ctx),
      intents: Object.fromEntries(Object.entries(store.data.intents).map(([k, v]) => [k, { state: v.state, autoResume: v.autoResume, retryCount: v.retryCount, fallbackCount: v.fallbackCount, contextRecoveryCount: v.contextRecoveryCount, lastFailure: v.lastFailure }])),
      breaker: breaker.diagnostics(),
    }),
    _test: { store, classifyFailure, hasBudget, backoffDelay, compatibleFallback, modelSupports, hasPendingQuestion, checkUserWaitGate, CATEGORY, STATE, RECOVERABLE_STATES, getCompaction, compactionAvailable, enableAutoResume, resumeAfterCtClean, runCtGate, ctGatedRecovery },
  };
}