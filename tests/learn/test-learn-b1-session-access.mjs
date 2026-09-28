// test-learn-b1-session-access.mjs —— P4 FINAL CLOSURE A1（B1）回归门
//
// ── 这个套件锁死的**唯一**命题 ──────────────────────────────────────────────
//   「人工审批凭据的**唯一事实来源**是宿主会话服务里真实发生过的 approval/asked+decided 事件对」
//   而这条链在任何部署形态下都必须**要么成立、要么安全失败（fail-closed）**，绝不允许：
//     · 访问未注入的 `ctx.sessions` 直接把插件打崩（部署面崩溃）；
//     · 会话服务缺失时把审批"降级为自述"（授权面放水）。
//
// ── 为什么必须有这个门（真实缺陷，不是假想）────────────────────────────────
//   宿主 Cordis 的 `ctx.sessions` 是 **accessor-only 的 guard 属性**：服务未注入时**读取该属性
//   本身**就抛 `session "sessions" not found: service not found`（不是返回 undefined）。
//   旧实现（生产 P4 R2 之前）在挂载期直接 `ctx.sessions...` ⇒ 在某些部署形态下插件在 apply
//   阶段就崩，整个 learn 面消失。B1 的修复把访问口径统一为
//     `ctx.get('sessions')`（服务未注入 ⇒ 返回 undefined）+ 显式 fail-closed 判定。
//   因此本门锁两件事：
//     ① **部署安全**：`ctx.sessions` 缺失/未注入时，插件能正常挂载且**从不裸读**该属性；
//     ② **授权安全**：会话服务缺失时，任何"批准 → 发表/召回"判定一律 DENY，且原因必须指向
//        **宿主事实不可复验**（而不是被降级成"自我声明就通过"）。
//
// ── 防"假通过"（本套件最重要的设计）────────────────────────────────────────
//   只断言"缺服务时被拒"是不够的——把 publish 一律拒掉也能让它变绿。故：
//     · T2 证明**合法路径依然通**：真实宿主 ApprovalService 上人类点"允许一次" ⇒ 批准 + 发表成功；
//       T2-负控证明这条成功**依赖真实的人类应答**（答"拒绝"⇒ 不批准、不发表）。
//     · T4c 证明闸门挡的是**信任锚缺失**而不是"随便拦"：构造一本**链式摘要完全自洽**的伪造台账
//       （用 core 的 makeApprovalRecord 生成 ⇒ 能过 verifyApprovalLedgerChain），
//       但宿主会话里**没有**对应事件对 ⇒ 必须 DENY，且原因**只能**是 approval_host_fact_*。
//       没有这条，T3 的"被拒"无法区分于"台账本身就读不出来"。
//
// 运行：node tests/learn/test-learn-b1-session-access.mjs
// 纪律：一切 stateDir / globalStorePath 指向 os.tmpdir()，绝不触碰生产 ~/.dsh。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  mkCtx, mkExec, mkHostApproval, mkTurnSession, registerHostSession,
} from './_real-session-harness.mjs';
import {
  emptyStore, makeExperience, candidateDigest, validHumanApproval, canPublish,
  makeApprovalRecord, serializeApprovalRecord, verifyApprovalLedgerChain,
  APPROVAL_LEDGER_FILE, HUMAN_APPROVAL_SCHEMA, HUMAN_APPROVAL_CHANNEL, HUMAN_APPROVAL_ACTOR,
  HUMAN_APPROVAL_GRANT, HUMAN_APPROVAL_LEDGER_SCHEMA,
} from '../../plugins/learn-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_URL = pathToFileURL(join(HERE, '..', '..', 'plugins', 'learn.mjs')).href;

let pass = 0; let fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; failures.push(name + ' :: ' + e.message); console.log('  FAIL  ' + name + ' — ' + e.message); }
}
async function acheck(name, fn) {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; failures.push(name + ' :: ' + e.message); console.log('  FAIL  ' + name + ' — ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════
// 宿主 guard 的忠实模拟（依据：Cordis accessor-only 服务属性）
// ═══════════════════════════════════════════════════════════════════════════
/**
 * 安装一个"未注入"的 sessions 服务形态：
 *   · `ctx.get('sessions')` ⇒ undefined（服务确实没被注入）；
 *   · **裸读** `ctx.sessions` ⇒ 抛错（宿主 guard 的真实行为），并计数。
 * 计数是 T1 的核心断言：修复后插件**一次都不应**裸读它。
 */
function installUninjectedSessions(ctx) {
  const state = { bareReads: 0 };
  const origGet = ctx.get.bind(ctx);
  Object.defineProperty(ctx, 'get', {
    configurable: true,
    writable: true,
    value: (name) => (name === 'sessions' ? undefined : origGet(name)),
  });
  Object.defineProperty(ctx, 'sessions', {
    configurable: true,
    get() {
      state.bareReads += 1;
      throw new Error('session "sessions" not found: service not found');
    },
  });
  return state;
}

let gen = 0;
/**
 * 起一个插件实例。
 * @param tag 场景标签（临时目录前缀）
 * @param opts.sessions 'host'（真实宿主会话服务）| 'uninjected'（未注入：get⇒undefined + 裸读抛错）
 * @param opts.dir 复用已有 stateDir（跨"重启"场景）
 * @param opts.gpath 复用已有全局库路径（跨"重启"场景）
 * @param opts.answerer 真实宿主 ApprovalService 上"人类"的应答（allowed-once|rejected）
 */
async function boot(tag, opts = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `b1-${tag}-`));
  const gpath = opts.gpath ?? path.join(dir, '_global-verified.json');
  const approval = await mkHostApproval({ answerer: opts.answerer ?? 'allowed-once' });
  const host = mkCtx({ approval: approval.svc ?? undefined });
  let guard = null;
  if (opts.sessions === 'uninjected') guard = installUninjectedSessions(host.ctx);
  const mod = await import(`${PLUGIN_URL}?b1=${++gen}`);
  const api = mod.apply(host.ctx, {
    stateDir: dir,
    globalStorePath: gpath,
    autoPropose: true,
    minTurnsForLearning: 4,
    minNewNodes: 4,
    maxDigestTurns: 40,
    ...(opts.plugin ?? {}),
  });
  return { api, hooks: host.hooks, ctx: host.ctx, dir, gpath, approval, guard };
}

// ── 夹具：可被 file_hash 机器验证的经验（哈希由本测试对真实文件独立复算）──
function mkFixture(sid, { title, body, seqs = [11, 12, 13, 14] } = {}) {
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1-evidence-'));
  const target = path.join(tdir, 'evidence-target.txt');
  fs.writeFileSync(target, 'B1 evidence for ' + title + '\n', 'utf8');
  const sha = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  const made = makeExperience({
    originSessionId: sid,
    sourceEventSeqs: seqs,
    title,
    body,
  });
  assert.equal(made.ok, true, 'makeExperience 失败：' + JSON.stringify(made));
  const exp = { ...made.value };
  exp.verificationEvidence = { class: 'file_hash', path: target, sha256: sha, note: 'b1 fixture' };
  // ★ 底座必须是 emptyStore（makeExperience 只返回 {ok, value}，**不含 store**）：
  //   用错底座会造出没有 telemetry 数组的畸形 store，插件在首个判定点就抛非预期异常——
  //   那会把"判定点被拒"与"夹具自身畸形"混为一谈，正是本门最该避免的假信号。
  const store = { ...emptyStore(sid), experiences: [exp] };
  return { exp, store, target, sha };
}

/**
 * 从磁盘直读全局库（判"是否落盘 / 是否被污染"用，不依赖插件内存态）。
 * ★ 读不到时**必须带诊断**：早先版本静默返回 null，导致"文件读错路径"被误读成
 *   "插件把库清空了"（一次真实的假信号）。诊断让失败原因自己说话。
 */
function readGlobalFile(gpath) {
  if (!gpath) return { __diag: 'gpath_undefined' };
  if (!fs.existsSync(gpath)) return { __diag: `file_missing:${gpath}` };
  const raw = fs.readFileSync(gpath, 'utf8');
  try { return JSON.parse(raw); } catch (e) { return { __diag: `parse_error:${e.message}`, __bytes: raw.length, __head: raw.slice(0, 240) }; }
}
/** 读失败诊断串（无诊断 = 读成功）。 */
const gdiag = (g) => (g && g.__diag ? ` diag=${g.__diag}${g.__head ? ` head=${g.__head}` : ''}` : '');
const pubReason = (res) => String(res?.publication ?? '');
/** 从 stateDir 直接读会话 store（判"是否留痕/是否落盘"用，不依赖插件内存态）。 */
function readStoreFile(api, sid) {
  const f = path.join(api.approvalLedgerFile ? path.dirname(api.approvalLedgerFile()) : '', `${sid}.json`);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
const telHas = (store, kind) => (store?.telemetry ?? []).some((t) => t.kind === kind);
const telReasons = (store, kind) => (store?.telemetry ?? []).filter((t) => t.kind === kind).map((t) => t.reason);

console.log('=== P4 FINAL CLOSURE A1（B1）：宿主会话访问与审批信任锚 ===');
console.log('  插件 = ' + PLUGIN_URL);

// ═══════════════════════════════════════════════════════════════════════════
// T1 部署安全：sessions 未注入 ⇒ 插件正常挂载，且**从不裸读** ctx.sessions
// ═══════════════════════════════════════════════════════════════════════════
const SID1 = 'b1-t1-session';
let A1 = null;
await acheck('T1.0 未注入 sessions 的部署形态下，apply 必须不抛（旧实现在此崩）', async () => {
  A1 = await boot('t1', { sessions: 'uninjected' });
  assert.ok(A1.api, 'apply 未返回 API');
});
await acheck('T1.1 修复后：挂载期对 ctx.sessions 的**裸读次数 = 0**（B1 根因锁）', () => {
  assert.equal(A1.guard.bareReads, 0,
    `插件在挂载期裸读 ctx.sessions ${A1.guard.bareReads} 次 —— B1 未修复（宿主 guard 会直接抛错）`);
});
// ── 夹具自证：若"裸读"根本不抛错，则 T1.1 的 0 次毫无意义（空转）──
check('T1.2 夹具自证：裸读 ctx.sessions 确实抛宿主 guard 错并计数 +1', () => {
  const before = A1.guard.bareReads;
  assert.throws(() => { void A1.ctx.sessions; }, /service not found/,
    '夹具未能模拟宿主 guard（裸读不抛错 ⇒ T1.1 是空转）');
  assert.equal(A1.guard.bareReads, before + 1, 'guard 计数未推进（前置不成立）');
});
await acheck('T1.3 sessions 缺失时必须判为 service_absent（而不是"已验证"）', () => {
  const st = A1.api.approvalLedgerStatus();
  assert.equal(st.available, true, '台账本体应可用：' + JSON.stringify(st));
  assert.equal(st.hostFactVerification, 'service_absent', JSON.stringify(st));
});
await acheck('T1.4 sessions 缺失时插件仍可服务（learn_status 可调用，未变砖）', async () => {
  const res = await A1.api.invokeTool('learn_status', {}, mkExec(SID1));
  assert.ok(res && typeof res === 'object', 'learn_status 未返回对象：' + JSON.stringify(res));
});

// ═══════════════════════════════════════════════════════════════════════════
// T2 合法路径必须**真的通**：真实宿主 ApprovalService + 真人"允许一次"
// ═══════════════════════════════════════════════════════════════════════════
const SID2 = 'b1-t2-session';
let T2 = null; let t2Fixture = null; let t2Review = null; let t2Verified = null;
await acheck('T2.0 真实宿主 ApprovalService 可用（否则本门无意义 ⇒ 明确失败而非静默跳过）', async () => {
  T2 = await boot('t2', { sessions: 'host' });
  assert.equal(T2.approval.available, true,
    'SKIP-REASON: 未能起真实宿主 ApprovalService（需 @deepseek-ai/dsh-user-approval）');
});
await acheck('T2.1 真实验证：file_hash 证据 PASS ⇒ VERIFIED_EXPERIENCE', async () => {
  t2Fixture = mkFixture(SID2, { title: 'B1 门测试：真实审批链路', body: '本条目用于证明合法审批路径真的能通。' });
  T2.api._setStoreForTest(SID2, t2Fixture.store);
  t2Verified = await T2.api.invokeTool('learn_verify', { experienceId: t2Fixture.exp.id }, mkExec(SID2));
  assert.equal(t2Verified.ok, true, JSON.stringify(t2Verified));
  assert.equal(t2Verified.method, 'file_hash', JSON.stringify(t2Verified));
});
await acheck('T2.2 人类在宿主通道答"允许一次" ⇒ 批准 + 发表成功（宿主事实为唯一依据）', async () => {
  t2Review = await T2.api.invokeTool('learn_review', {
    experienceId: t2Fixture.exp.id, action: 'approve', evidence: 'B1 门：真实宿主通道人工批准',
  }, mkExec(SID2));
  assert.equal(t2Review.ok, true, JSON.stringify(t2Review));
  assert.equal(t2Review.state, 'APPROVED', JSON.stringify(t2Review));
  assert.equal(t2Review.publication, 'published', JSON.stringify(t2Review));
  assert.ok(T2.approval.seen.length >= 1, '宿主通道未记录到审批请求：' + JSON.stringify(T2.approval.seen));
});
await acheck('T2.3 台账落账 + 信任锚在岗 + 全局库真的收到这条（跨会话通道打开）', () => {
  const st = T2.api.approvalLedgerStatus();
  assert.equal(st.chainOk, true, JSON.stringify(st));
  assert.equal(st.hostFactVerification, 'ctx.sessions', JSON.stringify(st));
  assert.ok(st.records >= 2, 'grant+consume 至少两条：' + JSON.stringify(st));
  const g = readGlobalFile(T2.gpath);
  const items = g?.experiences ?? [];
  assert.equal(items.length, 1, '全局库条目数=' + items.length + ' file=' + T2.gpath);
  assert.equal(items[0].id, t2Fixture.exp.id);
  // 用**本实例的**台账口径复核（避免测试与生产口径漂移）
  assert.equal(T2.api.validHumanApprovalFor(items[0]).ok, true, JSON.stringify(T2.api.validHumanApprovalFor(items[0])));
  assert.equal(T2.api.canPublishFor(items[0]).ok, true);
});
await acheck('T2.4 留痕可审计：APPROVED + HUMAN_APPROVAL_GRANTED 都在会话遥测里', () => {
  const st = readStoreFile(T2.api, SID2);
  assert.ok(st, '未找到会话 store 文件（留痕不可审计）');
  assert.ok(telHas(st, 'APPROVED'), '缺少 APPROVED 遥测');
  assert.ok(telHas(st, 'HUMAN_APPROVAL_GRANTED'), '缺少 HUMAN_APPROVAL_GRANTED 遥测：' + JSON.stringify(st.telemetry?.slice(-6)));
});

// ── T2 负控：人类答"拒绝" ⇒ 不批准、不发表（证明 T2.2 依赖真实人类应答，不是恒真）──
const SID2N = 'b1-t2n-session';
await acheck('T2− 负控：人类答"拒绝" ⇒ 不批准、不发表（T2.2 非恒真）', async () => {
  const N = await boot('t2n', { sessions: 'host', answerer: 'rejected' });
  const fx = mkFixture(SID2N, { title: 'B1 负控：人类拒绝', body: '人类拒绝时不得产生任何授权。' });
  N.api._setStoreForTest(SID2N, fx.store);
  await N.api.invokeTool('learn_verify', { experienceId: fx.exp.id }, mkExec(SID2N));
  let denied = false; let errText = '';
  try {
    const r = await N.api.invokeTool('learn_review', {
      experienceId: fx.exp.id, action: 'approve', evidence: '负控：人类拒绝',
    }, mkExec(SID2N));
    denied = r?.ok !== true || r?.state !== 'APPROVED' || String(r?.publication ?? '') !== 'published';
    errText = JSON.stringify(r);
  } catch (e) { denied = true; errText = String(e?.message ?? e); }
  assert.equal(denied, true, '人类拒绝却仍然授权成功：' + errText);
  const g = readGlobalFile(N.gpath);
  assert.equal((g?.experiences ?? []).length, 0, '被拒绝的候选进入了全局库');
});

// ═══════════════════════════════════════════════════════════════════════════
// T3 判定点 fail-closed：台账在、链完整，但宿主会话服务不可用 ⇒ DENY
//     （★ 必须发生在 **publish 判定点**，而不是"根本没跑"）
// ═══════════════════════════════════════════════════════════════════════════
let T3 = null;
await acheck('T3.0 以 T2 的 stateDir / 全局库起"第二个部署形态"（sessions 未注入）', async () => {
  T3 = await boot('t3', { sessions: 'uninjected', dir: T2.dir, gpath: T2.gpath });
  const st = T3.api.approvalLedgerStatus();
  assert.equal(st.hostFactVerification, 'service_absent', JSON.stringify(st));
  assert.equal(st.records >= 2, true, '共享 stateDir 未读到 T2 写下的台账：' + JSON.stringify(st));
});
await acheck('T3.1 该实例确实看得到那条已批准经验（前置：不是"看不见所以拒绝"）', () => {
  const stored = readStoreFile(T3.api, SID2);
  assert.ok(stored, 'T3 实例未读到 T2 的会话 store');
  const found = (stored.experiences ?? []).find((e) => e.id === t2Fixture.exp.id);
  assert.ok(found, '未找到已批准经验：' + JSON.stringify((stored.experiences ?? []).map((e) => e.id)));
  assert.equal(found.state, 'APPROVED', 'T2 的批准状态未落盘（前置不成立）');
});
await acheck('T3.2 判定点 DENY，且原因指向**宿主事实不可复验**（绝不降级放行）', async () => {
  const r = await T3.api.invokeTool('learn_verify', { experienceId: t2Fixture.exp.id }, mkExec(SID2));
  const reason = pubReason(r);
  assert.notEqual(reason, 'published', 'sessions 不可用却仍然发表：' + JSON.stringify(r));
  assert.match(reason, /^denied:/, '发表结论不是 denied：' + reason);
  // ★ canPublish 的两种 fail-closed 形状（learn-core L2449 / L2469）：
  //   ① state !== APPROVED ⇒ `not_human_approved:<state>`（审批根本没到位）；
  //   ② state === APPROVED 但 live 授权失效 ⇒ **直接透传 live 授权原因**。
  //   本条经验属于 ②（APPROVED 痕迹在、失效的是"宿主事实复验"），所以要求的是 host_fact 归因，
  //   而不是 ① 的 not_human_approved 前缀——两者都是"拒"，只是归因层级不同。
  assert.match(reason, /approval_host_fact_(session_unavailable|unverifiable)/,
    '拒绝原因未指向宿主事实不可复验：' + reason);
  assert.doesNotMatch(reason, /published/);
});
await acheck('T3.3 全局库未被这条写入/污染，且留下 GLOBAL_PUBLISH_DENIED 取证', () => {
  const g = readGlobalFile(T3.gpath);
  assert.ok(g && !g.__diag, '读不到全局库文件' + gdiag(g));
  const items = g?.experiences ?? [];
  assert.equal(items.length, 1, `T3 实例改动了全局库条目数：${items.length}${gdiag(g)}`);
  assert.equal(items[0].id, t2Fixture.exp.id);
  // ★ 取证位置：GLOBAL_* 遥测由 telGlobal 写进**全局库文件**（commitGlobal→globalPath），
  //   不在会话 store 里——早先在这里读会话 store 属于找错文件（"没留痕"的假信号）。
  const denied = (g.telemetry ?? []).filter((t) => t.kind === 'GLOBAL_PUBLISH_DENIED');
  assert.ok(denied.some((t) => /approval_host_fact_/.test(String(t.reason))),
    '未留下 GLOBAL_PUBLISH_DENIED(approval_host_fact_*) 取证：' + JSON.stringify(denied.map((t) => t.reason)));
  // 会话 Layer A 侧：拒绝不得顺手改写状态（更不得把 entry 改成"已验证"）
  const st = readStoreFile(T3.api, SID2);
  assert.ok(st, 'T3 会话 store 不可读');
  const e2 = (st.experiences ?? []).find((x) => x.id === t2Fixture.exp.id);
  assert.ok(e2, 'T3 会话 store 里条目不见了');
  assert.equal(e2.state, 'APPROVED', '拒绝路径改写了 Layer A 状态：' + e2.state);
});

// ═══════════════════════════════════════════════════════════════════════════
// T4 伪造数据不能成为宿主真值（三条独立伪证路径，全部 DENY）
// ═══════════════════════════════════════════════════════════════════════════
const SID4 = 'b1-t4-session';
let T4 = null;
await acheck('T4.0 起实例（sessions 正常可用 ⇒ 拒绝只能来自"事实不足"，不能归因于服务缺失）', async () => {
  T4 = await boot('t4', { sessions: 'host' });
  assert.equal(T4.api.approvalLedgerStatus().hostFactVerification, 'ctx.sessions');
});

// (a) 自述字段：proposed/approved 全靠插件侧自由文本 ⇒ 结构性判废
await acheck('T4a 自述审批（无宿主 attestation）⇒ live 授权为假 + 发表判定点被拒', async () => {
  const fx = mkFixture(SID4, { title: 'B1 T4a：自述审批', body: '仅凭自述字段声称被批准。' });
  const now = Date.now();
  // 自述 APPROVED：痕迹齐全、**无宿主 attestation**（= 手写文件 / 自述字段的形态）。
  // 同时补上 machine-checkable 的 verification，让 canPublish 能**走到审批权威那一步**——
  // 否则会先被 not_verified 拦下，就测不到"审批权威"这一层（测点漂移）。
  const fake = {
    ...fx.exp,
    state: 'APPROVED',
    approvedAt: now,
    approvedBy: HUMAN_APPROVAL_ACTOR,
    approvalEvidence: '我自己说人类批准了',
    lastVerifiedAt: now,
    verification: {
      status: 'VERIFIED',
      method: 'file_hash',
      evidence: { class: 'file_hash', path: fx.target, sha256: fx.sha, note: 'b1 t4a' },
      verifiedAt: now,
      reverifyCount: 0,
      lastReverifiedAt: now,
      lastReverifyResult: 'PASS',
      lastReverifyError: null,
    },
  };
  const v = T4.api.validHumanApprovalFor(fake);
  assert.equal(v.ok, false, '自述审批被判为有效授权（放水）：' + JSON.stringify(v));
  assert.match(String(v.reason), /approval_missing_host_attestation/, JSON.stringify(v));
  // ★ 发表判定点：结构/验证/回源锚点齐备，唯独审批权威不认 ⇒ 必须拒
  const cp = T4.api.canPublishFor(fake);
  assert.equal(cp.ok, false, '自述审批通过了发表判定点：' + JSON.stringify(cp));
  assert.equal(String(cp.reason), 'approval_missing_host_attestation', JSON.stringify(cp));
  assert.equal(T4.api.isRecallableFor(fake), false, '自述审批的条目被允许召回'); // 该 API 返回布尔
  T4.api._setStoreForTest(SID4, { ...fx.store, experiences: [fake] });
  const r = await T4.api.invokeTool('learn_verify', { experienceId: fake.id }, mkExec(SID4));
  assert.notEqual(pubReason(r), 'published', '自述审批的候选被发表：' + JSON.stringify(r));
  // 该条目 state=APPROVED（非 PROPOSED），verify 对它不适用 ⇒ publication=not_applicable。
  // 这不是放行：下面直接核验全局库**没有被写入**（人工通道才是唯一出口）。
  const g = readGlobalFile(T4.gpath);
  assert.ok(!g?.__diag || /^file_missing:/.test(g.__diag), '全局库文件不可读' + gdiag(g));
  assert.equal((g?.experiences ?? []).length, 0, '自述审批的条目进了全局库');
  assert.equal((g?.telemetry ?? []).filter((t) => t.kind === 'GLOBAL_PUBLISHED').length, 0,
    '自述审批留下了 GLOBAL_PUBLISHED 痕迹');
});

// (b) 批准后改内容：内容摘要必须在**判定点重新推导** ⇒ 授权自动失效
await acheck('T4b 批准后篡改内容 ⇒ live 授权失效（判定点重算摘要，不信任缓存字段）', () => {
  const g = readGlobalFile(T2.gpath);
  const entry = (g?.experiences ?? []).find((e) => e.id === t2Fixture.exp.id);
  assert.ok(entry, '取不到已批准条目（前置不成立）');
  assert.equal(T2.api.validHumanApprovalFor(entry).ok, true, '原条目本应有效');
  const tampered = { ...entry, body: String(entry.body) + ' —— 事后偷改的内容' };
  const v = T2.api.validHumanApprovalFor(tampered);
  assert.equal(v.ok, false, '内容已变却仍判有效：' + JSON.stringify(v));
  assert.match(String(v.reason), /approval_content_changed/, JSON.stringify(v));
  assert.equal(T2.api.canPublishFor(tampered).ok, false, '被篡改的内容仍可发表');
});

// (c) ★ 链式自洽的伪造台账 + 宿主会话无对应事件对 ⇒ **必须**被信任锚拒绝
const SID4C = 'b1-t4c-session';
const FORGED_HOST_SID = 'b1-t4c-forged-host-session';
await acheck('T4c 伪造台账（链式完全自洽）+ 宿主无事件对 ⇒ DENY 且原因只能是 approval_host_fact_*', async () => {
  // ① 造一份内容摘要确定的候选，并按**真实形状**给它挂上 attestation
  const fx = mkFixture(SID4C, { title: 'B1 T4c：伪造台账洗白', body: '凭一本自己写的台账声称人类批准过。' });
  const digest = candidateDigest(fx.exp);
  const ref = 'forged-approval-ref-0001';
  const at = Date.now();
  // ② 用 core 自己的构造函数生成 grant+consume ⇒ 伪造记录能过 verifyApprovalLedgerChain
  const space = mkTurnSession(FORGED_HOST_SID);
  registerHostSession(space); // 该会话**存在**，但里面从未发生任何审批事件对
  const g1 = makeApprovalRecord([], {
    type: 'grant',
    schemaVersion: HUMAN_APPROVAL_LEDGER_SCHEMA,
    candidateId: fx.exp.id,
    digest,
    approvedAt: at,
    trustedSource: HUMAN_APPROVAL_CHANNEL,
    hostActor: HUMAN_APPROVAL_ACTOR,
    approvalRef: ref,
    hostSessionId: FORGED_HOST_SID,
  });
  assert.equal(g1.ok, true, JSON.stringify(g1));
  const g2 = makeApprovalRecord([g1.record], {
    type: 'consume', recordId: g1.record.recordId, candidateId: fx.exp.id, digest, consumedAt: at,
  });
  assert.equal(g2.ok, true, JSON.stringify(g2));
  const forgedRecords = [g1.record, g2.record];
  // ★ 非空转的关键前提：伪造台账必须**通过链校验**（否则拒绝可以归因于断链，测不出信任锚）
  const chain = verifyApprovalLedgerChain(forgedRecords);
  assert.equal(chain.ok, true, '伪造台账未通过链校验，本用例无法证明信任锚：' + JSON.stringify(chain));

  const forgedExp = {
    ...fx.exp,
    state: 'APPROVED',
    approvedAt: at,
    approvedBy: HUMAN_APPROVAL_ACTOR,
    approvalEvidence: '伪造：台账里有人类批准记录',
    approval: {
      schema: HUMAN_APPROVAL_SCHEMA,
      channel: HUMAN_APPROVAL_CHANNEL,
      actor: HUMAN_APPROVAL_ACTOR,
      outcome: HUMAN_APPROVAL_GRANT,
      ref,
      candidateId: fx.exp.id,
      candidateDigest: digest,
      approvedAt: at,
      ledgerRecordId: g1.record.recordId,
    },
  };
  // 结构与内容绑定都成立（摘要一致）⇒ 只剩宿主事实这一道能挡它
  assert.equal(candidateDigest(forgedExp), digest, '内容摘要不稳定（前置不成立）');

  // ③ 把伪造台账写进**全新 stateDir**（挂载期即会加载），再起实例
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1-t4c-'));
  fs.writeFileSync(path.join(dir, APPROVAL_LEDGER_FILE),
    forgedRecords.map((r) => serializeApprovalRecord(r)).join(''), 'utf8');
  const gpath = path.join(dir, '_global-verified.json');
  const C = await boot('t4c', { sessions: 'host', dir, gpath });
  const st = C.api.approvalLedgerStatus();
  assert.equal(st.chainOk, true, '伪造台账在实例内被判断链（本用例失去区分度）：' + JSON.stringify(st));
  assert.equal(st.hostFactVerification, 'ctx.sessions', '信任锚不在岗：' + JSON.stringify(st));

  // ④ 判定点：结构/台账/内容全过，**只有宿主事实**能拒
  const v = C.api.validHumanApprovalFor(forgedExp);
  assert.equal(v.ok, false, '链式自洽的伪造台账被当成授权（信任锚失效）：' + JSON.stringify(v));
  assert.match(String(v.reason), /^approval_host_fact_/,
    '拒绝必须归因于宿主事实（不能是链/台账结构原因）：' + JSON.stringify(v));
  assert.doesNotMatch(String(v.reason), /chain_broken|unreadable|not_consumed|digest_mismatch/,
    '拒绝原因落在台账结构层，未证明信任锚：' + JSON.stringify(v));

  // ⑤ 插件面同样必须拒（不能只在 core 纯函数层成立）
  C.api._setStoreForTest(SID4C, { ...emptyStore(SID4C), experiences: [forgedExp] });
  const r = await C.api.invokeTool('learn_verify', { experienceId: forgedExp.id }, mkExec(SID4C));
  assert.notEqual(pubReason(r), 'published', '伪造台账的经验被发表：' + JSON.stringify(r));
  const g = readGlobalFile(gpath);
  assert.equal((g?.experiences ?? []).length, 0, '伪造条目污染了全局库');
});

// ═══════════════════════════════════════════════════════════════════════════
// T5 跨进程重启后：台账链完整 + 信任锚在岗 + 授权语义不变 + 跨会话复用仍成立
// ═══════════════════════════════════════════════════════════════════════════
const SID5B = 'b1-t5-other-session';
let T5 = null;
await acheck('T5.0 同一 stateDir / 全局库起第三个实例（= 进程重启；sessions 正常可用）', async () => {
  T5 = await boot('t5', { sessions: 'host', dir: T2.dir, gpath: T2.gpath });
  const st = T5.api.approvalLedgerStatus();
  assert.equal(st.available, true, JSON.stringify(st));
  assert.equal(st.chainOk, true, '重启后台账链不完整：' + JSON.stringify(st));
  assert.equal(st.hostFactVerification, 'ctx.sessions', '重启后信任锚未在岗：' + JSON.stringify(st));
  assert.ok(st.records >= 2, '重启后台账记录丢失：' + JSON.stringify(st));
});
await acheck('T5.1 重启后：已批准经验的 live 授权与可发布性保持不变（A/C 条款）', () => {
  const g = readGlobalFile(T5.gpath);
  const entry = (g?.experiences ?? []).find((e) => e.id === t2Fixture.exp.id);
  assert.ok(entry, '重启后全局库条目丢失');
  assert.equal(T5.api.validHumanApprovalFor(entry).ok, true,
    '重启后合法批准失效：' + JSON.stringify(T5.api.validHumanApprovalFor(entry)));
  assert.equal(T5.api.canPublishFor(entry).ok, true, JSON.stringify(T5.api.canPublishFor(entry)));
  // ★ isRecallableFor 返回**布尔**（与 validHumanApprovalFor / canPublishFor 的 {ok,reason} 形状不同）
  assert.equal(T5.api.isRecallableFor(entry), true, '重启后该条目不可召回（跨会话复用被打断）');
});
await acheck('T5.2 重启后**另一个会话**仍能召回到该条目（跨会话复用未被重启打断）', async () => {
  const rec = await T5.api.invokeTool('learn_recall', { query: '真实审批链路 合法审批路径' }, mkExec(SID5B));
  const ids = Array.isArray(rec?.items) ? rec.items.map((i) => i.id) : [];
  assert.ok(ids.includes(t2Fixture.exp.id), '另一会话召回到的条目 = ' + JSON.stringify(ids) + ' 期望含 ' + t2Fixture.exp.id);
});

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log('');
console.log(`=== 结果：PASS ${pass} / FAIL ${fail} ===`);
if (failures.length > 0) {
  console.log('失败明细：');
  for (const f of failures) console.log('  · ' + f);
  process.exitCode = 1;
} else {
  console.log('B1 门：部署安全（不裸读 + 可挂载）与授权安全（信任锚每次复验 + fail-closed）同时成立。');
}
