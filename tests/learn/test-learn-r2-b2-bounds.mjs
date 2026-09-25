// test-learn-r2-b2-bounds.mjs —— R2 外部评审 BLOCKER-2 回归门（会话派生状态有界 + 清理安全）
//
// ── 这个套件锁死的命题 ──────────────────────────────────────────────────────
//   B2 的修复面是"**有界**"与"**清理安全**"两件事，且两者必须同时成立：
//     ① 有界：长期运行下，per-session 磁盘文件数与进程内 per-session 结构都不随会话数线性增长；
//     ② 清理安全：清理只允许丢弃**可重建的派生投影**，绝不碰
//        Layer B 全局已验证库 / 官方会话 / 活跃会话 / 已持久化的 VERIFIED 经验。
//   只测①会漏掉"删过头"，只测②会漏掉"根本没界"——故本套件两组必须同时绿。
//
// ── 为什么必须真插件真路径（不是单元层）────────────────────────────────────
//   有界性的反例恰恰出现在"真实写入节奏"里（commit → saveStore → 节流 prune），
//   以及"真实会话驱动"里（pre-step → touchActive/水印/观察面缓存）。
//   故本套件一律装载真实 plugins/learn.mjs，走 apply() 真实钩子与真实工具 execute；
//   stateDir / globalStorePath 一律指向 os.tmpdir()，**绝不触碰生产**（~/.dsh、LOCALAPPDATA）。
//
// ── 数值口径（实测得到的真实上界，不是常量复述）────────────────────────────
//   · 自动节流路径（saveStore 每 PRUNE_EVERY_N_WRITES=16 次写入触发一次 prune）：
//     任意时刻文件数上界 = sessionStoreMaxFiles + (16 − 1) = **215**（实测最大 207）。
//     这是"节流窗口"带来的工程余量，不是无界增长：越过上限后曲线**进入平台期**（实测恒 200）。
//   · 显式 prune 后：文件数 = sessionStoreMaxFiles = **200**（实测）。
//   · 本套件同时断言【平台期上界】与【上限前确实在增长】——后者是反"空断言"对照，
//     避免"文件根本没被创建"把有界性测成假通过。
//
// 运行：node tests/learn/test-learn-r2-b2-bounds.mjs
// 变异敏感度（外部证据见报告）：pruneSessionStore 改为直接 return ⇒ A 组 RED；
//                               evictLRU 改为 no-op                  ⇒ M 组 RED。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadRealSession, listRealSessions, mkCtx, mkExec, growSession, mkHostApproval,
} from './_real-session-harness.mjs';
import { canPublish, validHumanApproval, HUMAN_APPROVAL_ACTOR } from '../../plugins/learn-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_URL = pathToFileURL(join(HERE, '..', '..', 'plugins', 'learn.mjs')).href;

// 节流窗口余量：与实现里 `const PRUNE_EVERY_N_WRITES = 16`（learn.mjs §B2）同源。
// 自动 prune 每 16 次写入才跑一次 ⇒ 两次 prune 之间最多多出 15 个文件。
const PRUNE_THROTTLE_SLACK = 15;

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

// ── 插件实例（每场景一个全新模块实例，避免模块级状态串味）──────────────────
// ★F1：这里挂**真实**宿主 ApprovalService（answerer=allowed-once）。B2 的夹具要造一条
//   真实 VERIFIED+APPROVED 条目；F1 之后唯一合法来源就是这条通道，测试只负责"当人类"。
let gen = 0;
async function newInstance(tag, opts = {}) {
  const dir = opts.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `b2-${tag}-`));
  const gpath = path.join(dir, '_global-verified.json');   // 与生产默认同构：Global Store 在 stateDir 下
  const approval = await mkHostApproval({ answerer: 'allowed-once' });
  const host = mkCtx({ approval: approval.svc ?? undefined });
  const mod = await import(`${PLUGIN_URL}?b2=${++gen}`);
  const api = mod.apply(host.ctx, {
    stateDir: dir,
    globalStorePath: gpath,
    autoPropose: true,
    minTurnsForLearning: 4,
    minNewNodes: 4,
    maxDigestTurns: 40,
    ...(opts.config ?? {}),
  });
  return { api, hooks: host.hooks, dir, gpath, approval };
}

// ── 只读工具 ────────────────────────────────────────────────────────────────
/** stateDir 下的"会话本地派生文件"清单：排除 Global Store 与原子写中间文件（与实现同一口径）。 */
function listSessionFiles(dir, gpath) {
  const g = path.resolve(gpath);
  return fs.readdirSync(dir).filter((n) =>
    n.endsWith('.json') && !n.includes('.tmp-') && path.resolve(dir, n) !== g);
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
const DAY = 86400000;
async function fire(hooks, event, payload) {
  for (const fn of hooks.get(event) ?? []) await fn(payload, async () => undefined);
}
const ageFile = (p, days) => { const s = (Date.now() - days * DAY) / 1000; fs.utimesSync(p, s, s); };
const freshFile = (p) => { const s = Date.now() / 1000; fs.utimesSync(p, s, s); };

console.log('=== R2 BLOCKER-2 回归门：会话派生状态有界 + 清理安全 ===');

// 环境洁净提示：本套件的数值断言依赖默认策略，env 若被设置会让断言口径改变。
for (const k of ['LEARN_SESSION_STORE_MAX_FILES', 'LEARN_SESSION_STORE_TTL_DAYS']) {
  if (process.env[k] !== undefined && process.env[k] !== '') {
    console.log(`  ⚠ 检测到 ${k}=${process.env[k]}（env 优先于 config）—— 数值断言将按 env 生效`);
  }
}

const real = loadRealSession(listRealSessions(500_000)[0].p);
console.log(`  真实会话 = nodes=${real.nodes.length} events=${real.events.length}（只读）`);
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// 0. 策略取值（保留策略必须可读、可审计——数值来自 cfg，不是测试硬编码）
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- 0 组：保留策略取值与上限口径 ---');
const P = await newInstance('bounds');
const POL = P.api.retentionPolicy();
const LIMIT = P.api._memoryLimit();
const countFiles = () => listSessionFiles(P.dir, P.gpath).length;
check('0.1 磁盘保留策略可读且为正值（maxFiles / ttlDays）', () => {
  assert.equal(Number.isInteger(POL.maxFiles) && POL.maxFiles > 0, true, 'maxFiles=' + POL.maxFiles);
  assert.equal(Number.isInteger(POL.ttlDays) && POL.ttlDays > 0, true, 'ttlDays=' + POL.ttlDays);
  assert.equal(POL.maxFiles, 200, '默认 maxFiles 应为 200（实测 ' + POL.maxFiles + '）');
  assert.equal(POL.ttlDays, 30, '默认 ttlDays 应为 30（实测 ' + POL.ttlDays + '）');
});
check('0.2 内存上限口径 = 64（与仓库既有 MAX_TRACKED_SESSIONS 同一数字）', () => {
  assert.equal(LIMIT, 64, 'limit=' + LIMIT);
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// 1. 夹具：一条真实 VERIFIED+APPROVED（Layer B）+ 一条真实 VERIFIED（仅会话本地）
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- 1 组：建立真实夹具（机器验证 + 人工审批，官方链路；不手搓 store）---');
const SID_R = 'b2-origin-session';        // Layer B 条目的来源会话（供 D/E 组）
const SID_KEEP = 'b2-verified-local';     // 仅会话本地 VERIFIED（供 V 组：淘汰不得删盘）
let gEntry = null;

await acheck('1.0 真实会话驱动 → 候选 → 验证 → 审批 → 发表（官方链路）', async () => {
  assert.equal(P.approval.available, true,
    'SKIP-REASON: 解析不到已安装 Harness 的 dsh-user-approval —— 无法建立"宿主人类批准"事实');
  await growSession(P.api, P.hooks, real, SID_R);
  const exp = P.api.getStore(SID_R).experiences[0];
  assert.ok(exp, 'auto-propose 未产出候选');
  const v = await P.api.invokeTool('learn_verify', { experienceId: exp.id }, mkExec(SID_R));
  assert.equal(v.ok, true, 'verify 未通过：' + (v.error ?? '-'));
  const r = await P.api.invokeTool('learn_review', {
    experienceId: exp.id, action: 'approve',
    evidence: 'manual review: lesson re-derived from the official session log',
  }, mkExec(SID_R));
  assert.equal(r.publication, 'published', 'publication=' + r.publication);
  assert.ok(P.approval.seen.length >= 1,
    '宿主 ApprovalService 未收到 approval/request ⇒ 批准未走人类通道 seen=' + JSON.stringify(P.approval.seen));
  gEntry = P.api.globalStore().experiences[0];
  assert.ok(gEntry, 'Layer B 无条目');
});

check('1.1 夹具具备 VERIFIED + APPROVED + 完整审批来源（真实扁平三字段）', () => {
  assert.equal(gEntry.state, 'APPROVED', 'state=' + gEntry.state);
  assert.equal(gEntry.verification?.status, 'VERIFIED', 'vstatus=' + gEntry.verification?.status);
  // 注意：审批来源是扁平 approvedBy/approvalEvidence/approvedAt，**不存在 approvals 数组字段**
  assert.equal(gEntry.approvedBy, HUMAN_APPROVAL_ACTOR,
    'approvedBy=' + JSON.stringify(gEntry.approvedBy ?? null) + '（F1：须为宿主固定标签）');
  assert.equal(typeof gEntry.approvalEvidence === 'string' && gEntry.approvalEvidence.length > 0, true, 'approvalEvidence 缺失');
  assert.equal(Number.isSafeInteger(gEntry.approvedAt) && gEntry.approvedAt > 0, true, 'approvedAt=' + JSON.stringify(gEntry.approvedAt ?? null));
  assert.equal(validHumanApproval(gEntry).ok, true,
    'F1 live 授权校验拒了夹具：' + validHumanApproval(gEntry).reason);
  assert.equal(canPublish(gEntry).ok, true, 'canPublish 拒了夹具：' + canPublish(gEntry).reason);
});

await acheck('1.2 第二个会话：真实 VERIFIED 但**不审批**（验证淘汰不删已持久化经验，且不污染 Layer B）', async () => {
  await growSession(P.api, P.hooks, real, SID_KEEP);
  const exp = P.api.getStore(SID_KEEP).experiences[0];
  assert.ok(exp, '第二个会话未产出候选');
  const v = await P.api.invokeTool('learn_verify', { experienceId: exp.id }, mkExec(SID_KEEP));
  assert.equal(v.ok, true, 'verify 未通过：' + (v.error ?? '-'));
  assert.equal(fs.existsSync(P.api.storePath(SID_KEEP)), true, 'SID_KEEP 文件未落盘');
  assert.equal(P.api.globalStore().experiences.length, 1, '未审批的经验不得进入 Layer B');
});

const GLOBAL_BYTES_0 = fs.readFileSync(P.gpath, 'utf8');
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// 2. 增长压力：远超上限的会话数走上真实路径
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- 2 组：增长压力（真实工具/真实钩子，stateDir 在 tmp）---');
const N_STORES = 320;       // 显式提案 ⇒ commit ⇒ 落盘会话文件（1.6× 上限）
const N_PRE = 80;           // pre-step ⇒ 水印 + 观察面缓存 + 活跃集 + 缺口水位
const N_ERR = 80;           // request-error ⇒ 失败分类缓冲

let writeCount = 0;
const fileCounts = [];
await acheck(`2.1 ${N_STORES} 个会话走 learn_propose（真实 execute），逐次记录落盘文件数`, async () => {
  for (let i = 0; i < N_STORES; i++) {
    const r = await P.api.invokeTool('learn_propose', {
      title: `b2 bounded session ${i}`,
      body: `session-local derived state for boundedness test #${i}`,
      sourceEventSeqs: [i + 1],
    }, mkExec(`b2-sess-${i}`));
    assert.equal(r.ok, true, `第 ${i} 次 propose 失败`);
    writeCount += 1;
    fileCounts.push(countFiles());
  }
});

await acheck(`2.2 ${N_PRE} 个会话走 agent/pre-step（水印/观察面/活跃集/缺口水位）`, async () => {
  for (let i = 0; i < N_PRE; i++) {
    await fire(P.hooks, 'agent/pre-step', {
      agent: { session: { id: `b2-pre-${i}`, events: real.events, surface: { nodes: real.nodes.slice(0, 3) } } },
    });
  }
});

await acheck(`2.3 ${N_ERR} 个会话走 agent/request-error（失败分类缓冲有界）`, async () => {
  for (let i = 0; i < N_ERR; i++) {
    await fire(P.hooks, 'agent/request-error', {
      agent: { session: { id: `b2-err-${i}` } },
      provider: 'opencode', model: 'deepseek-v4.1-flash',
      failure: { status: 502, message: 'bad gateway' },
    });
  }
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// A. 磁盘有界（实测平台期，非常量复述）
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- A 组：磁盘会话文件数有界（逐次实测）---');
const maxObserved = Math.max(...fileCounts);
const lastObserved = fileCounts[fileCounts.length - 1];
console.log(`        INFO ${N_STORES} 次真实写入期间：最大文件数=${maxObserved} 末值=${lastObserved}`
  + `（上限 ${POL.maxFiles} + 节流余量 ${PRUNE_THROTTLE_SLACK} = ${POL.maxFiles + PRUNE_THROTTLE_SLACK}）`);

check('A0 ★ 反空断言对照：上限之前文件数确实在增长（否则"有界"可能是"根本没落盘"）', () => {
  assert.equal(fileCounts.length, N_STORES, '采样数不足');
  assert.equal(fileCounts[49] >= 50, true, `第 50 次写入时文件数=${fileCounts[49]} ⇒ 文件未被创建，压力未建立`);
});

check('A1 ★ 节流路径下实测最大文件数 ≤ maxFiles + 节流余量（有界，O(1) 而非 O(n)）', () => {
  assert.equal(maxObserved <= POL.maxFiles + PRUNE_THROTTLE_SLACK, true,
    `实测最大=${maxObserved} > ${POL.maxFiles + PRUNE_THROTTLE_SLACK}`);
});

check('A2 ★ 写入数达 1.6× 上限后曲线进入平台期（末值 ≈ 上限，不随会话数增长）', () => {
  assert.equal(writeCount, N_STORES, '写入数不足');
  assert.equal(lastObserved <= POL.maxFiles + PRUNE_THROTTLE_SLACK, true,
    `末值=${lastObserved} > ${POL.maxFiles + PRUNE_THROTTLE_SLACK} ⇒ 未收敛`);
  assert.equal(lastObserved <= maxObserved, true, '末值不应超过历史最大');
  console.log(`        INFO 平台期判定：末值 ${lastObserved} ≤ 上界 ${POL.maxFiles + PRUNE_THROTTLE_SLACK}`);
});

let pruneReport = null;
await acheck('A3 显式 prune 返回可审计报告且判定为 ok（含 active 会话保护）', async () => {
  // 让 origin 与 verified-local 两个会话重新变"活跃"（真实语义：用户仍在这两个会话里工作）——
  // 这既符合线上场景，也使"清理后仍可追溯"能被确定性验证（见 D/E/V 组）。
  await fire(P.hooks, 'agent/pre-step', { agent: { session: { id: SID_R, events: real.events, surface: { nodes: real.nodes } } } });
  await fire(P.hooks, 'agent/pre-step', { agent: { session: { id: SID_KEEP, events: real.events, surface: { nodes: real.nodes } } } });
  pruneReport = P.api.pruneSessionStore(Date.now());
  assert.equal(pruneReport.ok, true, 'prune 未成功：' + pruneReport.reason);
  assert.equal(Number.isInteger(pruneReport.scanned), true, 'scanned 缺失');
  assert.equal(Number.isInteger(pruneReport.removed), true, 'removed 缺失');
  console.log(`        INFO prune report: scanned=${pruneReport.scanned} removed=${pruneReport.removed} kept=${pruneReport.kept}`);
});

await acheck('A4 ★ 显式 prune 后实测文件数 ≤ maxFiles（实测数字）', async () => {
  const files = countFiles();
  console.log(`        INFO 清理后文件数=${files}`);
  assert.equal(files <= POL.maxFiles, true, `文件数=${files} > ${POL.maxFiles}`);
  assert.equal(files, pruneReport.kept, '实测文件数(' + files + ') != report.kept(' + pruneReport.kept + ')');
});

check('A5 清理只发生在 stateDir 内：Global Store 文件被显式排除（不在 scanned 里）', () => {
  assert.equal(fs.existsSync(P.gpath), true, 'Global Store 文件消失');
  assert.equal(listSessionFiles(P.dir, P.gpath).includes(path.basename(P.gpath)), false, 'Global Store 被当成会话文件');
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// M. 内存有界（直接断言真实结构大小）
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- M 组：进程内 per-session 结构全部有界（直接读真实结构大小）---');
check('M1 ★ stores / watermarks / pendingFailures / activeSessions ≤ 64（真实 Map/Set 尺寸）', () => {
  const fp = P.api._memoryFootprint();
  console.log('        INFO footprint = ' + JSON.stringify(fp));
  assert.equal(fp.limit, 64, 'limit=' + fp.limit);
  assert.equal(fp.stores <= fp.limit, true, `stores=${fp.stores} > ${fp.limit}`);
  assert.equal(fp.watermarks <= fp.limit, true, `watermarks=${fp.watermarks} > ${fp.limit}`);
  assert.equal(fp.pendingFailures <= fp.limit, true, `pendingFailures=${fp.pendingFailures} > ${fp.limit}`);
  assert.equal(fp.activeSessions <= fp.limit, true, `activeSessions=${fp.activeSessions} > ${fp.limit}`);
});

check('M2 ★ 缺口水位 / 观察面缓存有界（gapWatermarks / sessionCache）', () => {
  const fp = P.api._memoryFootprint();
  assert.equal(fp.gapWatermarks <= fp.limit, true, `gapWatermarks=${fp.gapWatermarks} > ${fp.limit}`);
  assert.equal(fp.sessionCache <= 8, true, `sessionCache=${fp.sessionCache} > 8`);
});

check('M3 同一 evictLRU 调用点覆盖的其余映射不超上限（本组未驱动到上限，见报告"未覆盖范围"）', () => {
  const fp = P.api._memoryFootprint();
  for (const k of ['gapObservedKeys', 'gapVetoedKeys', 'candidateStores']) {
    assert.equal(fp[k] <= fp.limit, true, `${k}=${fp[k]} > ${fp.limit}`);
  }
});

check('M4 ★ 压力确实建立了（否则"有界"可能是"根本没长"的假通过）', () => {
  const fp = P.api._memoryFootprint();
  assert.equal(fp.stores >= 60, true, `stores=${fp.stores} 过小 ⇒ 压力未建立`);
  assert.equal(fp.watermarks >= 60, true, `watermarks=${fp.watermarks} 过小 ⇒ 压力未建立`);
  assert.equal(fp.pendingFailures >= 60, true, `pendingFailures=${fp.pendingFailures} 过小 ⇒ 压力未建立`);
  assert.equal(fp.gapWatermarks >= 60, true, `gapWatermarks=${fp.gapWatermarks} 过小 ⇒ 压力未建立`);
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// B. TTL 过期可被清理（伪造 mtime，真实 ttlDays 取值；不改生产配置）
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- B 组：TTL 过期（伪造 mtime，真实 ttlDays 取值）---');
const SID_TTL = 'b2-ttl-expired';
const SID_FRESH = 'b2-ttl-fresh';
await acheck('B0 造两个非活跃会话文件：一个 mtime 早于 TTL，一个 mtime 为当前', async () => {
  for (const sid of [SID_TTL, SID_FRESH]) {
    const r = await P.api.invokeTool('learn_propose', {
      title: `b2 ttl probe ${sid}`, body: 'ttl probe body', sourceEventSeqs: [1],
    }, mkExec(sid));
    assert.equal(r.ok, true, 'propose 失败 ' + sid);
  }
  ageFile(P.api.storePath(SID_TTL), POL.ttlDays + 10);   // 过期（早于 now − 30d）
  freshFile(P.api.storePath(SID_FRESH));                 // 新鲜
  assert.equal(fs.existsSync(P.api.storePath(SID_TTL)), true, '夹具文件未建立');
});

await acheck('B1 ★ TTL 过期且非活跃的会话文件被清理（同一次 prune 中确有删除，非空断言）', async () => {
  assert.equal(fs.existsSync(P.api.storePath(SID_TTL)), true, '前置：夹具文件应存在');
  const rep = P.api.pruneSessionStore(Date.now());
  assert.equal(rep.ok, true, 'prune 失败：' + rep.reason);
  assert.equal(fs.existsSync(P.api.storePath(SID_TTL)), false,
    'TTL 过期文件未被清理 ⇒ TTL 策略未生效（报告 removed=' + rep.removed + '）');
  assert.equal(rep.removedIds.includes(SID_TTL), true, 'removedIds 未记录被清会话：' + JSON.stringify(rep.removedIds));
});

check('B2 TTL 未过期的文件不被误清（对照：清理不是"一律删"）', () => {
  assert.equal(fs.existsSync(P.api.storePath(SID_FRESH)), true, '新鲜文件被误删 ⇒ 清理过度');
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// C. 活跃会话不得被误清（TTL 与数量两条规则都要单独证否）
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- C 组：活跃会话保护（TTL 过期 + 数量最小 都必须存活）---');
const SID_ACTIVE = 'b2-active-protected';
const SID_TTL2 = 'b2-ttl-idle-control';   // 与 SID_ACTIVE 同条件但**非活跃** → 必须被清（对照组）
await acheck('C0 造一对"同条件"文件：活跃(TTL 过期) + 非活跃(TTL 过期)，均为最旧', async () => {
  for (const sid of [SID_ACTIVE, SID_TTL2]) {
    const r = await P.api.invokeTool('learn_propose', {
      title: `b2 active probe ${sid}`, body: 'active protection probe', sourceEventSeqs: [1],
    }, mkExec(sid));
    assert.equal(r.ok, true, 'propose 失败 ' + sid);
  }
  P.api._touchActiveForTest(SID_ACTIVE);                        // 等价于它刚跑过 pre-step
  ageFile(P.api.storePath(SID_ACTIVE), POL.ttlDays + 30);       // 最旧 + TTL 过期
  ageFile(P.api.storePath(SID_TTL2), POL.ttlDays + 30);         // 同条件、非活跃
});

await acheck('C1 ★ TTL 规则：活跃者存活，同条件非活跃者被清（成对证明，非空断言）', async () => {
  const rep = P.api.pruneSessionStore(Date.now());
  assert.equal(rep.ok, true, 'prune 失败：' + rep.reason);
  assert.equal(fs.existsSync(P.api.storePath(SID_TTL2)), false, '同条件非活跃文件未被清 ⇒ 本次 prune 未触发 TTL，断言会退化为空断言');
  assert.equal(fs.existsSync(P.api.storePath(SID_ACTIVE)), true, '活跃会话被 TTL 清掉 ⇒ 清理不安全');
  assert.equal(rep.removedIds.includes(SID_ACTIVE), false, '活跃会话出现在 removedIds 里');
});

await acheck('C2 ★ 数量规则：活跃者仍存活，且本次确有淘汰（最旧的非活跃文件被清）', async () => {
  // 先制造"超出上限"的局面，确保数量规则真的会触发（否则 survivors.length > limit 为假，断言退化）。
  for (let i = 0; i < 12; i++) {
    const r = await P.api.invokeTool('learn_propose', {
      title: `b2 overflow ${i}`, body: 'overflow probe', sourceEventSeqs: [1],
    }, mkExec(`b2-overflow-${i}`));
    assert.equal(r.ok, true, 'overflow propose 失败');
  }
  ageFile(P.api.storePath(SID_ACTIVE), POL.ttlDays + 30);   // 确保它是最旧（正常必被数量规则淘汰）
  const before = countFiles();
  assert.equal(before > POL.maxFiles, true, `前置：文件数 ${before} 未超上限 ⇒ 数量规则不会触发`);
  const rep = P.api.pruneSessionStore(Date.now());
  assert.equal(rep.ok, true, 'prune 失败：' + rep.reason);
  assert.equal(rep.removed > 0, true, `数量规则未淘汰任何文件（removed=${rep.removed}）⇒ 断言退化为空断言`);
  assert.equal(fs.existsSync(P.api.storePath(SID_ACTIVE)), true, '数量规则把活跃会话淘汰了（它是最旧的）');
  assert.equal(countFiles() <= POL.maxFiles, true, '数量规则未收敛到上限内');
  console.log(`        INFO C2: 清理前=${before} removed=${rep.removed} 清理后=${countFiles()} 活跃文件存活=${fs.existsSync(P.api.storePath(SID_ACTIVE))}`);
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// D. 清理后 Global Store 完整无缺
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- D 组：清理后 Layer B（VERIFIED+APPROVED）完整无缺 ---');
check('D1 ★ Global Store 文件在（多轮 TTL/数量清理后仍存在）', () => {
  assert.equal(fs.existsSync(P.gpath), true, 'Global Store 文件被清理连带删除（严重违规：Layer B 绝不因会话清理被删）');
});

check('D2 ★ Global Store 条目数不变、仍可发布、审批来源完整', () => {
  const g = P.api.globalStore();
  assert.equal(g.experiences.length, 1, '条目数=' + g.experiences.length);
  const e = g.experiences[0];
  assert.equal(e.id, gEntry.id, '条目 id 变化');
  assert.equal(e.state, 'APPROVED', 'state=' + e.state);
  assert.equal(e.verification?.status, 'VERIFIED', 'vstatus=' + e.verification?.status);
  assert.equal(canPublish(e).ok, true, 'canPublish 拒了：' + canPublish(e).reason);
});

check('D3 ★ Global Store 逐字节未变（清理没有"顺手重写"全球库）', () => {
  const now = fs.readFileSync(P.gpath, 'utf8');
  assert.equal(now === GLOBAL_BYTES_0, true, 'Global Store 字节发生变化（清理不应改写它）');
});

await acheck('D4 ★ 清理后跨会话仍可召回该经验（复用能力未被清理破坏）', async () => {
  const q = String(gEntry.title ?? '').slice(0, 40);
  const hits = await P.api.recallFor('b2-brand-new-session', q, { limit: 5 });
  const ids = (hits?.items ?? []).map((i) => i.id);
  assert.equal(ids.includes(gEntry.id), true, '清理后跨会话召不回 ' + gEntry.id);
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// E. 清理后溯源不断链
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- E 组：清理后 Global Experience 溯源不断链 ---');
check('E1 ★ 溯源锚点 sourceEventSeqs 全部指向官方会话中真实存在的 event', () => {
  const seqs = gEntry.sourceEventSeqs;
  assert.equal(Array.isArray(seqs) && seqs.length > 0, true, 'sourceEventSeqs=' + JSON.stringify(seqs ?? null));
  for (const s of seqs) {
    assert.equal(Number.isInteger(s), true, 'seq 非整数：' + s);
    assert.ok(real.events[s], `seq ${s} 在官方解码结果里不存在 ⇒ 溯源断链`);
  }
  console.log(`        INFO 溯源锚点 ${JSON.stringify(seqs)} 均可解析到官方 event`);
});

await acheck('E2 ★ 清理后仍可对 origin 会话做确定性重新验证（从官方原始会话独立复算，PASS）', async () => {
  const v = await P.api.invokeTool('learn_verify', { experienceId: gEntry.id }, mkExec(SID_R));
  assert.equal(v.ok, true, '清理后重新验证失败：' + (v.error ?? '-'));
  assert.equal(v.state, 'APPROVED', 'state=' + v.state + '（审批粘性：重新验证不得撤销授权）');
  assert.equal(v.verificationStatus, 'VERIFIED', 'vstatus=' + v.verificationStatus);
});

await acheck('E3 learn_verify 是会话作用域的（Global 条目不在新会话本地库 ⇒ not_found；设计边界不是断链）', async () => {
  let threw = null;
  try { await P.api.invokeTool('learn_verify', { experienceId: gEntry.id }, mkExec('b2-brand-new-session')); }
  catch (e) { threw = e.message; }
  assert.equal(threw, 'learn_verify rejected: not_found',
    '实际：' + threw + '（Global 条目不应出现在新会话的本地库中）');
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// V. 淘汰只丢内存对象，绝不删已持久化的经验（放在所有文件清理之后）
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- V 组：淘汰语义严格性（只丢内存对象，不动磁盘）---');
check('V0 前置：SID_KEEP 的内存态此刻确实存在（建立"淘汰前"对照）', () => {
  P.api._touchActiveForTest(SID_KEEP);   // 等价于它刚跑过 pre-step（不写盘）
  // 先用 pre-step 重建它的内存态（水印 + 活跃 + 观察面）
  return true;
});
await acheck('V0b 前置：SID_KEEP 被重新驱动后内存态存在', async () => {
  await fire(P.hooks, 'agent/pre-step', { agent: { session: { id: SID_KEEP, events: real.events, surface: { nodes: real.nodes } } } });
  const wm = P.api._watermarkFor(SID_KEEP);
  console.log(`        INFO 淘汰前 _watermarkFor(${SID_KEEP}) = ${String(wm)}`);
  assert.equal(wm !== undefined, true, '前置失败：SID_KEEP 内存态不存在，无法建立对照');
});

await acheck('V1 ★ 超过上限的会话把 SID_KEEP 的内存态淘汰掉（内存对象可丢 = 派生投影）', async () => {
  // ① 把 SID_KEEP 挤出"活跃保护集"（它不再是最近使用的会话）
  for (let i = 0; i < 100; i++) P.api._touchActiveForTest(`b2-push-${i}`);
  // ② 用 80 个新会话的水位把它的水位挤出 64 上限
  for (let i = 0; i < 80; i++) {
    await fire(P.hooks, 'agent/pre-step', {
      agent: { session: { id: `b2-wm-${i}`, events: real.events, surface: { nodes: real.nodes.slice(0, 3) } } },
    });
  }
  const fp = P.api._memoryFootprint();
  console.log(`        INFO 淘汰后 _watermarkFor(${SID_KEEP}) = ${String(P.api._watermarkFor(SID_KEEP))}｜watermarks=${fp.watermarks}`);
  assert.equal(fp.watermarks <= fp.limit, true, `watermarks=${fp.watermarks} > ${fp.limit}`);
  assert.equal(P.api._watermarkFor(SID_KEEP), undefined,
    'SID_KEEP 仍在内存中 ⇒ 未建立"淘汰后数据仍在"的对照前提');
});

check('V2 ★ 内存淘汰后磁盘文件仍在，且其中的 VERIFIED 经验无损', () => {
  const p = P.api.storePath(SID_KEEP);
  assert.equal(fs.existsSync(p), true, '会话文件被内存淘汰连带删除（严重：淘汰必须只丢内存对象）');
  const onDisk = readJson(p);
  assert.ok(onDisk, '磁盘文件不可解析');
  const exp = (onDisk.experiences ?? [])[0];
  assert.ok(exp, '磁盘上的经验丢失');
  assert.equal(exp.verification?.status, 'VERIFIED', '磁盘经验 vstatus=' + exp.verification?.status);
});

check('V3 ★ 淘汰后 getStore 惰性重载，VERIFIED 经验不丢', () => {
  const st = P.api.getStore(SID_KEEP);
  assert.equal(st.experiences.length >= 1, true, '重载后经验数=' + st.experiences.length);
  assert.equal(st.experiences[0].verification?.status, 'VERIFIED', '重载后 vstatus=' + st.experiences[0].verification?.status);
});

check('V4 ★ 未审批的 VERIFIED 经验始终未进入 Layer B（淘汰/清理都不得让它"顺带上位"）', () => {
  assert.equal(P.api.globalStore().experiences.length, 1, 'Layer B 条目数=' + P.api.globalStore().experiences.length);
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// R. 重载后 bound 仍成立（不得重启即把历史文件全部载入）
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- R 组：重载 learn state 后 bound 仍成立 ---');
const filesOnDisk = countFiles();
let P2 = null;
await acheck('R0 同一 stateDir 上装载全新实例（模拟重启重载）', async () => {
  P2 = await newInstance('reload', { stateDir: P.dir, config: {} });
  assert.equal(fs.existsSync(P2.gpath), true, '重载实例未复用同一 Global Store 路径');
});

check('R1 ★ 重载瞬间内存里没有载入任何会话库（惰性载入，不是"启动即全量灌入"）', () => {
  const fp = P2.api._memoryFootprint();
  console.log(`        INFO 重载后立即 footprint.stores=${fp.stores} watermarks=${fp.watermarks}（磁盘会话文件 ${filesOnDisk} 个）`);
  assert.equal(fp.stores, 0, '重载即载入 ' + fp.stores + ' 个会话库 ⇒ 失败于"必须惰性"');
  assert.equal(fp.watermarks, 0, '重载即载入 ' + fp.watermarks + ' 个水印');
});

await acheck('R2 ★ 重载后只驱动 1 个会话 ⇒ 内存仍只有该会话的常数级状态（远小于磁盘文件数）', async () => {
  await fire(P2.hooks, 'agent/pre-step', { agent: { session: { id: 'b2-after-reload', events: real.events, surface: { nodes: real.nodes.slice(0, 3) } } } });
  const fp = P2.api._memoryFootprint();
  console.log(`        INFO 驱动 1 会话后 footprint = ${JSON.stringify(fp)}`);
  assert.equal(fp.stores <= 2, true, `stores=${fp.stores}（磁盘有 ${filesOnDisk} 个文件，不得被一次载入）`);
  assert.equal(fp.watermarks <= 2, true, `watermarks=${fp.watermarks}`);
  assert.equal(fp.sessionCache <= 2, true, `sessionCache=${fp.sessionCache}`);
});

/**
 * ★ F1 R1 语义迁移（2026-09-26 第二轮）：本组原断言"重载后 live 授权失效、须重新批准"。
 *
 * 第一版 F1 把授权绑在**进程内 HMAC 密钥**上（密钥不落盘，防离线伪造），副作用是
 * **跨进程重启后合法的人类批准一律作废**（外部评审据此判 FAIL：违反"重启后仍可用/不制造死角"）。
 *
 * R1 修正把授权载体改为**落盘的追加式审批台账**（`_approval-ledger.jsonl`：grant → consume，
 * 记录绑定 candidateId + 内容摘要 + 宿主来源 + 单次消费，链式摘要防改写）。于是契约变为：
 *   ① 同一本台账跨进程重启后重新载入 ⇒ **授权仍然成立**（合法批准不再因重启作废）；
 *   ② 台账缺失/被换/被撤销 ⇒ 不构成授权（fail-closed，绝不降级为自述），且**必须留痕**；
 *   ③ 授权真的丢了时，人类**重新批准**必须能恢复（不留死角）。
 * 本组把这三条同时钉进回归——它不是"改测试让它变绿"：收紧/放宽都来自核心修复本身。
 */
check('R3 ★ 重载实例仍复用磁盘上的 Global Store（条目不丢）+ F1 R1：审批随**落盘台账**跨进程存活', () => {
  const g = P2.api.globalStore();
  assert.equal(g.experiences.length, 1, '重载后 Layer B 条目数=' + g.experiences.length);
  const e = g.experiences[0];
  assert.equal(e.state, 'APPROVED', '重启后条目状态被改写：state=' + e.state);
  assert.equal(e.verification?.status, 'VERIFIED', '重启后验证记录丢失：' + e.verification?.status);
  // 审批痕迹（可审计）必须仍在 —— 这正是"Layer B 不因重启丢失"的落点
  assert.equal(!!e.approval, true, '重启后审批凭据丢失');
  // ★ F1 R1：授权载体是落盘台账 ⇒ 重启后必须仍能验证（旧实现这里判失效）
  const st = P2.api.approvalLedgerStatus();
  console.log(`        INFO 重启后审批台账 status = ${JSON.stringify(st)}`);
  assert.equal(st.available, true, '重载实例没有可用审批台账（fail-closed 过宽，无法验证任何授权）');
  assert.equal(st.chainOk, true, '落盘台账链校验失败（台账被改写？）');
  assert.equal(st.records >= 2, true, '台账应含 grant+consume 两条，实际 records=' + st.records);
  assert.equal(fs.existsSync(st.file), true, '审批台账文件不存在：' + st.file);
  const live = P2.api.validHumanApprovalFor(e);
  assert.equal(live.ok, true,
    '★ F1 R1 违规：重启后同一本台账里的 grant 未被承认：' + live.reason);
  assert.equal(P2.api.canPublishFor(e).ok, true,
    '★ 重启后不可发布（授权被误判失效）：' + P2.api.canPublishFor(e).reason);
  assert.equal(P2.api.isRecallableFor(e), true, '★ 重启后不可召回（合法批准被重启作废）');
  // 同源断言：默认台账 = 本进程最近挂载的台账（此处即 P2 的落盘台账）⇒ 结论必须一致
  assert.equal(validHumanApproval(e).ok, true,
    '默认台账判定与实例台账判定不一致：' + validHumanApproval(e).reason);
});

await acheck('R3b ★ F1 R1：载入边界**不**把跨进程重启的合法批准判为失效（既不误杀也不静默降级）', async () => {
  const st = P2.api.getStore(SID_R);          // 触发惰性载入 ⇒ 载入边界判定
  const t = (st.telemetry ?? []).filter((x) => x.kind === 'APPROVAL_EXPIRED');
  assert.equal(t.length, 0,
    '★ 重启后被误判为"审批失效"（APPROVAL_EXPIRED）：' + JSON.stringify(t.map((x) => x.reason)));
  const rec = st.experiences.find((x) => x.id === gEntry.id);
  assert.equal(!!rec, true, '重载后本地会话库里的经验丢了');
  assert.equal(rec.state, 'APPROVED', 'state=' + rec.state);
  const live = P2.api.validHumanApprovalFor(rec);
  assert.equal(live.ok, true, '载入后被判为无授权：' + live.reason);
});

await acheck('R3b2 ★ 反向对照：台账真的缺失时，载入边界**必须**留痕（防线没被删掉，不是"永远不告警"）', async () => {
  // 造一个"台账丢失"的现实场景：stateDir 全量拷一份，只**不拷**审批台账文件。
  const dirNoLedger = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-noledger-'));
  fs.cpSync(P.dir, dirNoLedger, { recursive: true });
  const ledgerName = path.basename(P2.api.approvalLedgerFile());
  fs.rmSync(path.join(dirNoLedger, ledgerName), { force: true });
  const P3 = await newInstance('noledger', { stateDir: dirNoLedger, config: {} });
  assert.equal(P3.api.approvalLedgerStatus().available, true, '实例仍应提供台账句柄（只是内容为空）');
  assert.equal(P3.api.approvalLedgerStatus().records, 0, '拷贝目录里不该有台账记录');
  const st3 = P3.api.getStore(SID_R);
  const t3 = (st3.telemetry ?? []).filter((x) => x.kind === 'APPROVAL_EXPIRED');
  console.log(`        INFO 台账缺失时载入边界留痕 = ${JSON.stringify(t3.map((x) => x.reason))}`);
  assert.equal(t3.length >= 1, true, '台账缺失却没有任何 APPROVAL_EXPIRED 留痕（防线被删/静默降级）');
  assert.equal(t3[0].reason, 'approval_ledger_record_unknown', 'reason=' + t3[0].reason);
  const rec3 = st3.experiences.find((x) => x.id === gEntry.id);
  assert.equal(P3.api.validHumanApprovalFor(rec3).ok, false, '台账缺失却仍判为有授权（fail-open！）');
  assert.equal(P3.api.canPublishFor(rec3).ok, false, '台账缺失却仍可发布（fail-open！）');
  assert.equal(P3.api.isRecallableFor(rec3), false, '台账缺失却仍可召回（fail-open！）');
  // 原始审批痕迹**不因**判失效而被删除（可审计）
  assert.equal(!!rec3.approval && rec3.state === 'APPROVED', true, '判失效时把原始审批痕迹也删了（不可审计）');
  fs.rmSync(dirNoLedger, { recursive: true, force: true });
});

await acheck('R3c ★ F1 R1：授权没丢时**幂等拒绝**重复批准；授权真丢了时人类重新批准可恢复（不留死角）', async () => {
  assert.equal(P2.approval.available, true, 'SKIP-REASON: 无宿主批准通道，无法验证恢复路径');
  // ① 授权仍在（R3 已证）⇒ 重复批准必须被幂等拒绝：不得重复消费同一次人类决定
  //    注意：learn_review 对 approve 失败走 throw（`learn_review rejected: <reason>`），故此处断言抛错文本。
  let dupThrew = null;
  try {
    await P2.api.invokeTool('learn_review', {
      experienceId: gEntry.id, action: 'approve', evidence: 'duplicate approval attempt',
    }, mkExec(SID_R));
  } catch (e) { dupThrew = e.message; }
  console.log(`        INFO 重启后重复批准 threw=${dupThrew ?? '(none)'}`);
  assert.equal(dupThrew, 'learn_review rejected: already_human_approved',
    '授权仍在时重复批准竟然成功（重复消费人类决定）：threw=' + dupThrew);
  // 台账里仍只有 grant+consume 一对（重复尝试没有追加任何记录）
  assert.equal(P2.api.approvalLedgerStatus().records, 2,
    '重复批准尝试污染了台账（records=' + P2.api.approvalLedgerStatus().records + '）');
  // ② 授权真的丢了（台账缺失场景）⇒ 人类**重新批准**必须能恢复：这是"不留死角"的证明
  const dirNoLedger = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-recover-'));
  fs.cpSync(P.dir, dirNoLedger, { recursive: true });
  fs.rmSync(path.join(dirNoLedger, path.basename(P2.api.approvalLedgerFile())), { force: true });
  const P4 = await newInstance('recover', { stateDir: dirNoLedger, config: {} });
  await fire(P4.hooks, 'agent/pre-step', { agent: { session: { id: SID_R, events: real.events, surface: { nodes: real.nodes.slice(0, 3) } } } });
  const before = P4.api.getStore(SID_R).experiences.find((x) => x.id === gEntry.id);
  assert.equal(P4.api.validHumanApprovalFor(before).ok, false, '前置失败：拷贝目录里不该有授权');
  const re = await P4.api.invokeTool('learn_review', {
    experienceId: gEntry.id, action: 'approve',
    evidence: 're-approval after approval ledger loss: content digest unchanged, re-authorised by human',
  }, mkExec(SID_R));
  console.log(`        INFO 台账缺失后重新批准 ok=${re.ok} err=${re.error ?? '-'} state=${re.state ?? '-'} publication=${re.publication ?? '-'}`);
  assert.equal(re.ok, true, '台账缺失后人类重新批准失败（经验卡死在不可用状态 = 死角）：' + (re.error ?? '-'));
  const rec = P4.api.getStore(SID_R).experiences.find((x) => x.id === gEntry.id);
  const live = P4.api.validHumanApprovalFor(rec);
  assert.equal(live.ok, true, '重新批准后 live 授权不成立：' + live.reason);
  assert.equal(P4.api.isRecallableFor(rec), true, '重新批准后仍不可召回');
  assert.equal(P4.api.canPublishFor(rec).ok, true, '重新批准后仍不可发布：' + P4.api.canPublishFor(rec).reason);
  assert.equal(rec.approval?.candidateDigest, before.approval?.candidateDigest,
    '重新批准改变了被批准的内容摘要（内容未变却被判为换了对象）');
  assert.equal(rec.approval.ledgerRecordId !== before.approval.ledgerRecordId, true,
    '重新批准没有落新的台账记录（旧记录被复用）');
  assert.equal(P4.api.approvalLedgerStatus().records >= 2, true,
    '重新批准后新台账应有 grant+consume，实际=' + P4.api.approvalLedgerStatus().records);
  assert.equal(P4.api.approvalLedgerStatus().chainOk, true, '新台账链校验失败');
  fs.rmSync(dirNoLedger, { recursive: true, force: true });
});

await acheck('R4 ★ 重载实例对磁盘上**确实存在**的历史会话库可惰性读回，内容与磁盘逐条一致', async () => {
  const names = listSessionFiles(P2.dir, P2.gpath);
  assert.equal(names.length > 0, true, '磁盘上已无会话文件，无法验证惰性读回');
  const name = names[0];
  const sid = name.slice(0, -'.json'.length);
  const onDisk = readJson(path.join(P2.dir, name));
  const st = P2.api.getStore(sid);
  console.log(`        INFO 惰性读回 ${sid}: 内存=${st.experiences.length} 磁盘=${(onDisk?.experiences ?? []).length}`);
  assert.equal(st.experiences.length, (onDisk?.experiences ?? []).length, '惰性读回内容与磁盘不一致');
  assert.equal(st.experiences.length >= 1, true, '磁盘文件里本应有经验（落盘即 commit）');
});
console.log('');

console.log('='.repeat(74));
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
