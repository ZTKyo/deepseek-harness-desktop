// _real-session-harness.mjs —— P4 LEARN 真实会话 E2E 的共享驱动器
//
// 存在理由（合同 §四「强制复用条款」）：真实会话 E2E 需要一套**同一口径**的
//   ① 真实会话加载（共享解码器 cm-r4-log-decoder.mjs）
//   ② 伪 ctx / 伪 exec / 钩子驱动
//   ③ 按真实生长方式逐节点推进 pre-step
// 若每个 E2E 各抄一份，就会出现"多个真实会话加载器"——正是合同禁止的第二套实现。
// 故提取到本模块，run-learn-real-e2e.mjs（E1–E4）与 run-learn-real-gap-e2e.mjs
// （AC5 能力缺口真实闭环）共用。
//
// 纪律：只读真实会话；调用方负责把状态目录指向 os.tmpdir()。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { decodeLines } from '../../docs/roadmap/evidence/cm-r4-log-decoder.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ─── 真实会话加载（复用共享解码器，不新建第二套解析）──────────────────────
export function loadRealSession(file) {
  const { lines, frames } = decodeLines(file);
  const events = [];
  const nodes = [];
  let parseErrors = 0;
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { parseErrors++; continue; }
    if (!o || o.type === 'session') continue;
    if (!Number.isInteger(o.seq)) continue;
    events[o.seq] = o;
    if (o.type === 'user/message' || o.type === 'assistant/message') nodes.push(o.seq);
  }
  nodes.sort((a, b) => a - b);
  return { file, frames, events, nodes, parseErrors };
}

// 真实会话语料目录。默认 = 本机生产会话库（只读）；可用 `DSH_SESSIONS_DIR` 指向
// **播种语料**（CI runner 必需：裸 runner 上没有 ~/.dsh/sessions，真实门会因缺数据而
// 假红——这正是 ci-level2.yml 当初把这些门排除出 CI 的原因）。此覆盖只改**来源**，
// 不改任何断言语义：门仍然必须读到"真实会话"才可能通过。
export const SESSIONS_DIR = process.env.DSH_SESSIONS_DIR
  ? path.resolve(process.env.DSH_SESSIONS_DIR)
  : path.join(os.homedir(), '.dsh', 'sessions');

/** 真实会话候选清单（按体积升序）。 */
export function listRealSessions(minBytes = 500_000) {
  const out = [];
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'session.jsonl.zstd') { try { out.push({ p, size: fs.statSync(p).size }); } catch {} }
    }
  };
  walk(SESSIONS_DIR);
  out.sort((a, b) => a.size - b.size);
  return out.filter((c) => c.size > minBytes);
}

// ─── 伪 ctx（只提供插件真正使用的两个能力 + 可选宿主批准通道）──────────────
// F1：`opts.approval` = 宿主 ApprovalService（见 mkHostApproval()）。不传 ⇒
// `ctx.get('approval')` 返回 undefined，与"部署中没有该通道"完全同形，
// 插件据此必须 fail-closed（这正是 approval_unavailable 的真实触发条件）。
export function mkCtx(opts = {}) {
  const hooks = new Map();
  const logs = [];
  // 宿主会话服务（F1 R1 授权判定的信任锚）：缺它 ⇒ 插件 fail-closed 拒绝一切授权。
  // opts.sessions 可显式覆盖（例如测"宿主服务缺失时的降级行为"）。
  const sessionsService = 'sessions' in opts ? opts.sessions : hostSessionsService();
  const ctx = {
    logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) },
    on: (ev, fn) => { if (!hooks.has(ev)) hooks.set(ev, []); hooks.get(ev).push(fn); },
    // repo 直连场景下 defineTool 不可解析 → 插件不得走 ctx.tools.register（这里设成陷阱）
    tools: { register: () => { throw new Error('ctx.tools.register must not be used in repo E2E (defineTool unresolved)'); } },
    // ★ 保真修复（2026-09-27，P4 FINAL CLOSURE B1 真因）：真实宿主的 `ctx.get(name)` 是
    //   **通用服务解析器**，不是"只认 approval 的白名单" —— DSH 宿主自身 20+ 处就是
    //   `ctx.get('sessions')`（dsh-workspace / dsh-session-persistence / dsh-headless /
    //   dsh-subagent / dsh-host-apiproxy…），`dsh-session` 以 `super(ctx,'sessions')` 注册为服务；
    //   `mount-gate.mjs` 的 A3 探针也实测过**同形上下文里 `ctx.get('sessions')` 可解析**。
    //   旧写法 `name === 'approval' ? opts.approval : undefined` 让插件走 `ctx.get('sessions')`
    //   的正路径在夹具体里永远取不到服务 ⇒ 假的 `approval_host_fact_session_unavailable`
    //   （B1 的真实来源），而不是插件接线缺陷。
    //   注意：直取属性 `ctx.sessions` 仍然保留（= "宿主把服务注入进本上下文"形状，供
    //   execution-continuity 同口径用例使用）；两种形状取到的是**同一个**服务对象，
    //   且 `opts.sessions` 显式覆盖（含 null / 形状不对）在两条路径上语义一致 ⇒
    //   "服务缺失/形状不对 ⇒ service_absent + fail-closed"的负例锁不受影响。
    get: (name) => (name === 'approval' ? opts.approval : (name === 'sessions' ? sessionsService : undefined)),
    sessions: sessionsService,
  };
  return { ctx, hooks, logs };
}

// ─── 假宿主会话服务（ctx.sessions）─────────────────────────────────────────────
// 生产里 `ctx.sessions.get(sid)` 由**宿主**提供（返回真实会话对象，含 events；与
// execution-continuity 的 WAIT-GATE 同一读取口径）。插件用它对台账 grant 做宿主事实复验，
// 因此测试必须等价提供：本注册表就是"宿主会话存储"的替身。
//
// 合并语义：同一 sid 可能被多个夹具对象复用（重启/多实例夹具各自造新会话对象），
// 而真实世界里"一次会话只有一条事件流"，所以按 sid **取事件并集**（按事件对象标识去重），
// 而不是"最后一次注册覆盖"——否则一个后造的、不含批准事实的同 sid 对象会把已批准事实"抹掉"。
const HOST_SESSIONS = new Map(); // sid -> { sessions: object[] }

/** 把会话对象登记进"宿主会话存储"（构造器/驱动处自动调用；也可显式调用）。 */
export function registerHostSession(session) {
  try {
    const sid = session && typeof session.id === 'string' ? session.id : null;
    if (!sid) return session;
    if (!HOST_SESSIONS.has(sid)) HOST_SESSIONS.set(sid, { sessions: [] });
    const reg = HOST_SESSIONS.get(sid);
    if (!reg.sessions.includes(session)) reg.sessions.push(session);
  } catch {}
  return session;
}

/**
 * 宿主会话读取器（生产：`ctx.sessions.get`）。未知 sid ⇒ null（插件据此 fail-closed）。
 * 每次读取**实时**取事件并集（而不是登记时快照）：批准事实是在登记之后 append 上去的，
 * 快照式视图会看不到它 —— 那才是"测试夹具假货"，不是生产语义。
 */
export function getHostSession(sid) {
  const reg = typeof sid === 'string' ? HOST_SESSIONS.get(sid) : null;
  if (!reg) return null;
  const events = [];
  const seen = new Set();
  for (const s of reg.sessions) {
    if (!Array.isArray(s.events)) continue;
    for (const ev of s.events) {
      if (seen.has(ev)) continue;
      seen.add(ev);
      events.push(ev);
    }
  }
  return { id: sid, events, surface: reg.sessions[reg.sessions.length - 1]?.surface ?? {} };
}

/** `ctx.sessions` 服务替身。 */
export function hostSessionsService() {
  return { get: (sid) => getHostSession(sid) };
}

// ─── 会话对象：真实宿主 ApprovalService 需要 events + append（且 turn-enclosed）──
/**
 * 可被宿主 ApprovalService 使用的会话对象（最小真实形状）。
 * `turn/start` 是硬前提：宿主只在**开启的轮次内**接受审批请求（否则 throw），
 * 因为裸事件在重放时与崩溃尾巴无法区分。
 */
export function mkTurnSession(sid, seed = []) {
  const events = [{ type: 'turn/start', data: {} }, ...seed];
  return registerHostSession({
    id: sid,
    events,
    append: (type, data) => { const e = { type, data }; events.push(e); return e; },
  });
}

export function mkExec(sid, session) { return { agent: { session: registerHostSession(session ?? mkTurnSession(sid)) } }; }

// ─── F1：宿主人类批准通道（真实 ApprovalService，不是自造替身）──────────────
// 解析已安装 Harness 的包：优先常规 node 解析，失败则按 APPDATA 下的 npm 全局安装位
// （与 tests/reliability/coldstart-gate-worker.ps1 同一口径）。解析不到 ⇒ 返回 null，
// 调用方必须**显式 SKIP 并说明原因**，绝不允许"跳过也算通过"。
export function resolveHarnessPackage(rel) {
  const candidates = [];
  try {
    const req = createRequire(import.meta.url);
    candidates.push(req.resolve(rel));
  } catch {}
  const appdata = process.env.APPDATA;
  if (appdata) {
    candidates.push(path.join(appdata, 'npm', 'node_modules', '@deepseek-ai', 'dsh',
      'node_modules', '@deepseek-ai', ...rel.split('/')) + '/lib/index.js');
  }
  for (const c of candidates) { try { if (fs.existsSync(c)) return pathToFileURL(c).href; } catch {} }
  return null;
}

/**
 * 起一个**真实**宿主 ApprovalService（cordis + @deepseek-ai/dsh-user-approval）。
 *
 * 为什么必须用真货（F1 的证据强度）：本轮的命题是"授权只能来自宿主人类批准通道"。
 * 若测试自己往日志里塞事件对，那证明的只是"核心读了日志"，不证明"日志只能由宿主写"。
 * 真服务在场 ⇒ asked/decided 事件对由宿主代码写入，测试只负责"当人类"作答。
 *
 * @param {{policy?:'ask'|'never', answerer?:'allowed-once'|'rejected'|'cancelled'|null|((req,next)=>any)}} o
 *        answerer=null ⇒ 注册的 answerer 直接 next()（等价"没有可用 answerer"→ 宿主 fail-closed）；
 *        不传 ⇒ 完全不注册 answerer（同一效果，两条路径都值得测）。
 * @returns {Promise<{svc:any, app:any, seen:any[], decided:string[], available:boolean}>}
 */
export async function mkHostApproval(o = {}) {
  const cordisUrl = resolveHarnessPackage('cordis');
  const approvalUrl = resolveHarnessPackage('dsh-user-approval');
  if (!cordisUrl || !approvalUrl) return { svc: null, app: null, seen: [], decided: [], available: false };
  const { Context } = await import(cordisUrl);
  const { ApprovalService } = await import(approvalUrl);
  const app = new Context();
  app.plugin(ApprovalService, { policy: o.policy ?? 'ask' });
  await new Promise((r) => setTimeout(r, 60));   // 服务注册是异步的（probe 同口径）
  const seen = [];
  const decided = [];
  if ('answerer' in o) {
    app.on('approval/request', (req, next) => {
      seen.push({ toolName: req.toolName, reason: req.reason, callId: req.callId ?? null });
      if (o.answerer === null) return next();                       // 声明"无 answerer"
      if (typeof o.answerer === 'function') return o.answerer(req, next);
      decided.push(o.answerer);
      return o.answerer;
    });
  }
  const svc = app.get('approval');
  return { svc, app, seen, decided, available: typeof svc?.request === 'function' };
}

/**
 * **仅供核心单元测试**：直接伪造"宿主日志里的事件对"。
 * 用于验证 learn-core 的**判定逻辑**（缺 asked / 缺 decided / 工具名不符 / 未授予 /
 * 摘要不符 …）。它不是"人类批准"的证据面——证据面见 mkHostApproval()。
 *
 * `digest` = 真实链路里发起方写进请求 reason 的 `candidateDigest`（宿主原样落进
 * `approval/asked.reason`）。核心据此判定"人类当时批的就是这份内容"，
 * 所以夹具必须像真实链路一样带上它；不传 ⇒ 造出一条"无法绑定对象"的事实，
 * 正好用于测 `approval_reason_not_content_bound`。
 */
export function appendHostApprovalFact(session, { ref, toolName = 'learn_review', outcome = 'allowed-once', callId, digest, reason } = {}) {
  const reasonText = reason !== undefined
    ? reason
    : (digest ? `${toolName}: approve experience fixture digest=${digest}` : undefined);
  session.append('approval/asked', {
    id: ref,
    toolName,
    ...(callId !== undefined ? { callId } : {}),
    ...(reasonText !== undefined ? { reason: reasonText } : {}),
  });
  session.append('approval/decided', { id: ref, outcome });
  return ref;
}

/** 把一次真实会话推进插件的全部 pre-step 钩子。 */
export async function driveHook(hooks, session) {
  registerHostSession(session);
  const fns = hooks.get('agent/pre-step') ?? [];
  if (!fns.length) throw new Error('plugin registered no agent/pre-step hook');
  for (const fn of fns) await fn({ agent: { session } }, () => {});
}

/**
 * 按真实生长方式驱动一次会话：先建立水位，再逐节点推进 pre-step。
 * @param {object} api        插件 apply() 返回的 API
 * @param {Map}    hooks      钩子表
 * @param {object} real       loadRealSession() 结果
 * @param {string} sid        会话 id
 * @param {number} startAt    建立水位的节点数
 * @param {(api:object,n:number)=>boolean} [stopWhen] 提前停止判据（默认：出现经验即停）
 * @param {(api:object,n:number)=>void}    [onStep]   每步回调（用于观测遥测）
 */
export async function growSession(api, hooks, real, sid, startAt = 24, stopWhen, onStep) {
  const N = real.nodes.length;
  const sess = (n) => ({ id: sid, events: real.events, surface: { nodes: real.nodes.slice(0, n) } });
  await driveHook(hooks, sess(Math.min(startAt, N)));
  const stop = stopWhen ?? ((a) => a.getStore(sid).experiences.length > 0);
  let steps = 0;
  let stopped = false;
  for (let n = Math.min(startAt, N) + 1; n <= N; n++) {
    await driveHook(hooks, sess(n));
    steps++;
    if (onStep) onStep(api, n);
    if (stop(api, n)) { stopped = true; break; }
  }
  return { steps, stopped, store: api.getStore(sid) };
}

/**
 * 证据驱动的**真实会话选择**（2026-09-29 修复：把"体积最小"换成"能否真的喂出经验"）。
 *
 * 为什么必须换（真实缺陷，实测）：
 *   旧写法 `loadRealSession(listRealSessions(500_000)[0].p)` 按**体积升序**取第一个。
 *   会话库是持续增长的：新增的 subagent 会话（如 4cd1facf，503KB / 34 nodes）体积刚好最小，
 *   但它的工具事实喂不出任何经验 ⇒ auto-propose 前置不成立 ⇒ `test-learn-r2-b1-approval-gate`
 *   报 **15 FAIL**、`test-learn-r2-b2-bounds` 直接崩在缺 `_global-verified.json`。
 *   那 15 个 FAIL 不是产品缺陷，而是**选错了语料**——门把"环境前置"误报成了"产品失败"。
 *   实测（`_overnight/corpus-probe.mjs`，119 个候选）：idx0 经验=0；idx1/2/3/9/10/13 经验=1。
 *
 * 现在判据 = 客观事实：**重放该会话是否真的产出 ≥1 条经验**。
 *   - 顺序确定（体积升序），结果可复现；
 *   - `LEARN_REAL_SESSION=<path>` 可显式钉住某个会话（CI / 复现用）；
 *   - 全部候选都不满足 ⇒ 返回 ok:false，调用方必须走**环境前置**退出（见 envPreconditionExit），
 *     绝不把"没有语料"降级成"产品坏了"，也不允许"跳过即通过"。
 *
 * @returns {Promise<{ok:true,cand:object,real:object,scanned:object[]}
 *                  |{ok:false,reason:string,scanned:object[]}>}
 */
export async function pickLearnableRealSession({
  minBytes = 500_000, maxScan = 14, pluginUrl, pluginOpts = {}, minNodes = 28, sid = 'select-probe',
} = {}) {
  const scanned = [];
  let cands = listRealSessions(minBytes);
  const pin = process.env.LEARN_REAL_SESSION;
  if (pin) {
    const p = path.resolve(pin);
    if (!fs.existsSync(p)) return { ok: false, reason: `LEARN_REAL_SESSION 指向的文件不存在：${p}`, scanned };
    cands = [{ p, size: fs.statSync(p).size }, ...cands.filter((c) => c.p !== p)];
  }
  if (!cands.length) {
    return { ok: false, reason: `在 ${SESSIONS_DIR} 下找不到 >${minBytes}B 的真实会话（语料缺失）`, scanned };
  }
  let gen = 0;
  for (const c of cands.slice(0, maxScan)) {
    let real;
    try { real = loadRealSession(c.p); }
    catch (e) { scanned.push({ p: c.p, err: 'load: ' + e.message }); continue; }
    if (real.nodes.length < minNodes) {
      scanned.push({ p: c.p, nodes: real.nodes.length, skip: `nodes<${minNodes}` });
      continue;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsel-'));
    const mod = await import(`${pluginUrl}?sel=${++gen}`);
    const host = mkCtx({});
    const api = mod.apply(host.ctx, {
      stateDir: dir,
      globalStorePath: path.join(dir, '_global-verified.json'),
      autoPropose: true, minTurnsForLearning: 4, minNewNodes: 4, maxDigestTurns: 40,
      ...pluginOpts,
    });
    let experiences = -1;
    try { const g = await growSession(api, host.hooks, real, sid); experiences = g.store.experiences.length; }
    catch (e) { scanned.push({ p: c.p, nodes: real.nodes.length, err: 'grow: ' + e.message }); continue; }
    scanned.push({ p: c.p, nodes: real.nodes.length, experiences });
    if (experiences > 0) return { ok: true, cand: c, real, scanned };
  }
  return { ok: false, reason: `扫描 ${scanned.length} 个真实会话候选，没有一个能喂出经验（auto-propose 前置不成立）`, scanned };
}

/**
 * **环境前置未满足**的统一退出（不是产品失败）。
 *
 * 约定（与 tests/learn/run-learn-all-tests.mjs:129-137 的 ENV 分类同口径）：
 * `exit 2` + `[env error]` 字样 ⇒ 回归器单列 ENV，既不算通过也不算产品失败，
 * 且在报告里显式可见（不静默吞掉）。
 */
export function envPreconditionExit(reason, scanned = []) {
  console.log(`[env error] 环境不满足：${reason}`);
  console.log(`[env error] 语料目录 = ${SESSIONS_DIR}（可用 DSH_SESSIONS_DIR 覆盖；可用 LEARN_REAL_SESSION 钉住单文件）`);
  for (const s of scanned) {
    const id = path.basename(path.dirname(s.p));
    console.log(`[env error]   - ${id} nodes=${s.nodes ?? '-'} experiences=${s.experiences ?? s.skip ?? s.err ?? '-'}`);
  }
  console.log('[env error] 这是**真实语料缺失/不合格**导致的环境前置，不是产品缺陷；断言语义未被放宽。');
  process.exit(2);
}

export const harnessDir = HERE;
