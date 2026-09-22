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
  redactSecrets,
  containsSecret,
  stableHash,
  MAX_TITLE_LEN,
} from './learn-core.mjs';

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
};

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

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const diag = (m) => { try { ctx.logger?.info?.(`[learn] ${m}`); } catch {} };
  const warn = (m) => { try { ctx.logger?.warn?.(`[learn] ${m}`); } catch {} };

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
      return true;
    } catch {
      return false; // 持久化失败不影响内存态，更不阻塞任务
    }
  }
  function getStore(sid) {
    let s = stores.get(sid);
    if (!s) {
      const loaded = loadStore(sid);
      if (loaded) {
        s = loaded;
      } else {
        s = emptyStore(sid);
        // 只有在"文件存在但判废"时才记 STORE_REBUILT（首次创建不算重建）
        if (fs.existsSync(storePath(sid))) {
          s = appendTelemetry(s, telemetryEvent('STORE_REBUILT', { reason: 'invalid_or_corrupt_store' }, Date.now()).value);
          diag(`STORE-REBUILT sid=${sid} (corrupt/invalid store discarded, fail-closed)`);
        }
      }
      stores.set(sid, s);
    }
    return s;
  }
  function commit(sid, next) {
    const withVersion = { ...next, version: (next.version ?? 0) + 1, updatedAt: Date.now() };
    stores.set(sid, withVersion);
    saveStore(withVersion);
    return withVersion;
  }
  function tel(sid, kind, payload) {
    const ev = telemetryEvent(kind, payload, Date.now());
    if (!ev.ok) return stores.get(sid);
    return commit(sid, appendTelemetry(getStore(sid), ev.value));
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
    if (wm === undefined) { watermarks.set(sid, nodes[nodes.length - 1]); return null; }
    const fresh = nodes.filter((q) => Number.isInteger(q) && q > wm);
    if (fresh.length < cfg.minNewNodes) return null;

    // 只取最近 maxDigestTurns 个新节点（bounded）
    const window = fresh.slice(-cfg.maxDigestTurns);
    // 抽取走 P2.5 官方提取器（默认参数即 P25_EXTRACTORS，无第二个 parser）
    const built = buildLearnDigest(session.events, window);
    watermarks.set(sid, nodes[nodes.length - 1]);
    if (!built.ok) { warn(`digest failed: ${built.error}`); return null; }
    const digest = built.digest;
    if (digest.turnCount < cfg.minTurnsForLearning) return null;

    const sig = learningSignals(digest);
    if (!sig.hasSignal) return null;

    // 标题从**真实发言**派生（AC6：候选确实来自原始会话，不是凭空生成）
    const signalTurn = digest.turns.find((t) => sig.signals.some((s) => s.seq === t.seq)) ?? digest.turns[0];
    const title = oneLine(signalTurn.text, 120) || 'observed session signal';
    // 正文 = 真实片段 + 出处（脱敏已由 buildLearnDigest 完成）
    const kinds = sig.kinds ?? [...new Set(sig.signals.map((s) => s.kind))].sort();
    // R2：把"缺口资格"写实 —— 失败是否被后续发言解决，而不是只罗列命中的关键词
    const outcome = sig.signals.some((s) => s.kind === 'failure')
      ? (sig.resolved ? 'resolved' : `unresolved-failure(seq ${sig.unresolvedFailureSeqs.join(',')})`)
      : 'no-failure';
    const body = [
      `signal: ${kinds.join('+')}`,
      `outcome: ${outcome}`,
      `origin: session ${sid}, turns=${digest.turnCount}, window seq ${digest.firstSeq}-${digest.lastSeq}`,
      '',
      ...digest.turns.map((t) => `[${t.seq}] ${t.role}: ${oneLine(t.text, 300)}`),
    ].join('\n').slice(0, 4000);

    const res = propose(getStore(sid), {
      title,
      body,
      tags: kinds,
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

  // ── 钩子：被动观察（只读会话，绝不修改会话/上下文）──
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      maybeLearn(agent?.session);
    } catch (e) {
      // fail-open：学习失败绝不影响任务
      warn(`maybeLearn error (ignored): ${e && e.message ? e.message : String(e)}`);
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
      description: 'HUMAN APPROVAL BOUNDARY. Approve or reject a PROPOSED experience. Approval requires BOTH an approver identity AND non-empty evidence, and is the ONLY way an experience becomes recallable. Rejection is terminal (a rejected experience can never be revived — propose a new one instead). Evidence containing a secret-shaped value is rejected outright.',
      parameters: {
        experienceId: { type: 'string', description: 'Target experience id.', required: true },
        action: { type: 'string', description: '"approve" or "reject".', required: true },
        approver: { type: 'string', description: 'Who approves/rejects (identity string).', required: true },
        evidence: { type: 'string', description: 'For approve: concrete evidence the lesson is correct and reusable (required).' },
        reason: { type: 'string', description: 'For reject: why it is not reusable (required).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, experienceId: { type: 'string' }, state: { type: 'string' } } },
        render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
      },
      async execute(args, exec) {
        const sid = sidOf(exec);
        if (!sid) throw new Error('learn_review: no session context (exec.agent missing)');
        const store = getStore(sid);
        const isApprove = String(args.action).toLowerCase() === 'approve';
        const res = isApprove
          ? approve(store, args.experienceId, { approver: args.approver, evidence: args.evidence, at: Date.now() })
          : reject(store, args.experienceId, { approver: args.approver, reason: args.reason, at: Date.now() });
        if (!res.ok) throw new Error(`learn_review rejected: ${res.error}`);
        commit(sid, res.value);
        tel(sid, isApprove ? 'APPROVED' : 'REJECTED', { experienceId: res.experience.id, detail: `by ${args.approver}` });
        diag(`REVIEW sid=${sid} id=${res.experience.id} action=${isApprove ? 'approve' : 'reject'} -> ${res.experience.state}`);
        return { ok: true, experienceId: res.experience.id, state: res.experience.state };
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
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, items: { type: 'array' }, considered: { type: 'number' }, excluded: { type: 'number' } } },
        render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
      },
      async execute(args, exec) {
        const sid = sidOf(exec);
        if (!sid) throw new Error('learn_recall: no session context (exec.agent missing)');
        const store = getStore(sid);
        const res = recall(store, args.query, { limit: args.limit });
        if (res.items.length > 0) {
          commit(sid, recordRecall(store, res.items.map((i) => i.id), Date.now()));
          tel(sid, 'RECALLED', { count: res.items.length, detail: oneLine(args.query, 120) });
        }
        diag(`RECALL sid=${sid} q="${oneLine(args.query, 40)}" hits=${res.items.length} excluded=${res.excluded}`);
        return { ok: true, items: res.items, considered: res.considered, excluded: res.excluded };
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

    reg({
      name: 'learn_status',
      description: 'Read-only learning status: experience counts by state, promotion count, and structured telemetry (PROPOSED/APPROVED/REJECTED/RECALLED/PROMOTION_BLOCKED/STORE_REBUILT/WRITE_DENIED). Use it to confirm that proposals are being recorded, that nothing was auto-activated, and that no store corruption occurred. Never mutates anything.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, summary: { type: 'object', additionalProperties: true }, experiences: { type: 'array' } } },
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
        }));
        return { ok: true, summary, experiences };
      },
    });
  }
  if (TOOL_SPECS.length !== 5) warn(`expected 5 tool specs, collected ${TOOL_SPECS.length}`);
  if (!(defineTool && ctx.tools && typeof ctx.tools.register === 'function')) {
    warn('tool surface unavailable (defineTool missing or no tools service) — hooks and store unaffected');
  }

  diag(`registered (stateDir=${cfg.stateDir}, autoPropose=${cfg.autoPropose}, minTurns=${cfg.minTurnsForLearning}, minNewNodes=${cfg.minNewNodes})`);

  // 只读快照 + 真实工具实现（供 E2E / 诊断脚本直接驱动，不经 dsh-tools 包装）
  return {
    getStore,
    storePath,
    recallFor: (sid, q, opts) => recall(getStore(sid), q, opts),
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
    _setStoreForTest: (sid, store) => { stores.set(sid, store); },
    /** 测试用：读取内存水位（诊断用）。 */
    _watermarkFor: (sid) => watermarks.get(sid),
  };
}

// 供单测/诊断复用的纯导出（不经过 apply）
export { containsSecret, redactSecrets, MAX_TITLE_LEN };
