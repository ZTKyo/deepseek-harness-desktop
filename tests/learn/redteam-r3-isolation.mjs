// redteam-r3-isolation.mjs —— PHASE 04 LEARN R3 会话隔离红队（PASS = 隔离成立）
//
// 规格 §27-3 要求 "session isolation" 真实数据。本探针用**真实插件实例**（apply + 真钩子 +
// 真 api.storePath）驱动学习路径，测量：
//   A. 正常两个 sessionId 是否真的互不污染
//   B. sanitizeFileId 撞名是否已消除（R3 根因修复验证）+ 归属守卫 fail-closed 直测
//   C. 超长 sessionId（>120）截断撞名是否已消除
//   D. 结论汇总
//
// 判定极性（2026-08-19 修正）：本脚本 PASS = 隔离成立（期望态），FAIL = 缺陷出现。
// 修复前 B/C 段 FAIL（撞名可达 → 后跑方继承先跑方经验）；修复后应全 PASS。
//
// 纪律：不复制任何生产逻辑 —— 文件名一律通过 api.storePath(sid) 观测，不重写 sanitizeFileId。
// 事件形状：events[seq] 按数组下标索引（learn-core buildLearnDigest 的真实契约）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../plugins/learn.mjs';

let PASS = 0, FAIL = 0;
const ROWS = [];
function obs(name, detail, verdict) {
  ROWS.push({ name, detail, verdict });
  if (verdict === 'PASS') PASS++; else if (verdict === 'FAIL') FAIL++;
  console.log(`  [${verdict}] ${name}\n         ${detail}`);
}
function section(t) { console.log(`\n=== ${t} ===`); }

function mkCtx() {
  const hooks = new Map();
  const logs = [];
  const ctx = {
    logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) },
    on: (ev, fn) => { if (!hooks.has(ev)) hooks.set(ev, []); hooks.get(ev).push(fn); },
    tools: { register: () => { throw new Error('ctx.tools.register must not be used (defineTool unresolved)'); } },
  };
  return { ctx, hooks, logs };
}

const mkEvent = (seq, text) => ({
  type: 'user/message',
  seq,
  time: 1700000000000 + seq,
  data: { role: 'user', content: [{ type: 'text', text }] },
});

/**
 * 用真实插件驱动一个会话直到产出候选。
 * events[seq] 按数组下标索引 ⇒ seq 必须等于数组下标。
 */
async function driveSession(stateDir, sid, texts) {
  const { ctx, hooks, logs } = mkCtx();
  const api = apply(ctx, { stateDir, minNewNodes: 4, minTurnsForLearning: 4, maxDigestTurns: 40 });
  const drive = async (session) => {
    const fns = hooks.get('agent/pre-step') ?? [];
    if (!fns.length) throw new Error('plugin registered no agent/pre-step hook');
    for (const fn of fns) await fn({ agent: { session } }, () => {});
  };

  const events = texts.map((t, i) => mkEvent(i, t));
  // 第一次：只建立水位
  await drive({ id: sid, events, surface: { nodes: events.map((e) => e.seq) } });
  // 追加 4 个新节点（>= minNewNodes）触发学习
  for (let i = texts.length; i < texts.length + 4; i++) events.push(mkEvent(i, texts[i % texts.length]));
  await drive({ id: sid, events, surface: { nodes: events.map((e) => e.seq) } });

  return { api, logs, storePath: api.storePath(sid), store: api.getStore(sid) };
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const TEXTS_A = ['这里报错了', '已经修好了', '又崩了', '现在跑通了'];
const TEXTS_B = ['数据库连接超时了', '已经修复了', '服务崩溃了', '现在跑通了'];

// ─────────────────────────────────────────────────────────────
section('A. 正常会话隔离（真实 DSH 形状 sessionId）');

const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-r3-iso-'));
const SID_A = 'session-04ecc1a4-fae9-4eb9-9a08-89b79128bcd4';
const SID_B = 'session-11112222-3333-4444-5555-666677778888';

const rA = await driveSession(dirA, SID_A, TEXTS_A);
const rB = await driveSession(dirA, SID_B, TEXTS_B);

obs('A0 真实插件确实产出了候选（前置条件）',
  `A=${rA.store.experiences.length} B=${rB.store.experiences.length} logs=${rA.logs.length}`,
  rA.store.experiences.length > 0 && rB.store.experiences.length > 0 ? 'PASS' : 'FAIL');

obs('A1 两个会话映射到两个不同文件',
  `storePath(A)=${path.basename(rA.storePath)}  storePath(B)=${path.basename(rB.storePath)}`,
  rA.storePath !== rB.storePath ? 'PASS' : 'FAIL');

const filesA = fs.readdirSync(dirA).filter((f) => f.endsWith('.json'));
obs('A2 磁盘上确实两个库文件', `files=[${filesA.join(', ')}]`, filesA.length === 2 ? 'PASS' : 'FAIL');

const dA = readJson(rA.storePath), dB = readJson(rB.storePath);
obs('A3 两库各自归属正确 sessionId',
  `A=${dA?.sessionId?.slice(0, 30) ?? 'null'}  B=${dB?.sessionId?.slice(0, 30) ?? 'null'}`,
  dA?.sessionId === SID_A && dB?.sessionId === SID_B ? 'PASS' : 'FAIL');

if (dA && dB) {
  const tA = dA.experiences.map((e) => e.title);
  const tB = dB.experiences.map((e) => e.title);
  const inter = tA.filter((t) => tB.includes(t));
  obs('A4 A/B 候选标题无交集', `A=${tA.length} B=${tB.length} 交集=${inter.length}`, inter.length === 0 ? 'PASS' : 'FAIL');
  const bleed = tB.some((t) => t.includes('报错') || t.includes('崩了'));
  obs('A5 B 库无 A 的语料痕迹', `B=[${tB.map((t) => t.slice(0, 14)).join(' | ')}]`, bleed ? 'FAIL' : 'PASS');
}

// ─────────────────────────────────────────────────────────────
section('B. sanitizeFileId 撞名（R3 根因修复验证：撞名应已消除）');

const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-r3-coll-'));
const SID_X = 'probe session X';     // 含空格 → 清洗会改动原 sid
const SID_Y = 'probe_session_X';     // 下划线形态 → 修复前与 X 的清洗结果同名
const rX = await driveSession(dirB, SID_X, TEXTS_A);
const rY = await driveSession(dirB, SID_Y, TEXTS_B);

obs('B1 两个不同 sid 不再映射到同一文件（撞名已消除）',
  `storePath(X)=${path.basename(rX.storePath)}  storePath(Y)=${path.basename(rY.storePath)}`,
  rX.storePath !== rY.storePath ? 'PASS' : 'FAIL');

const filesB = fs.readdirSync(dirB).filter((f) => f.endsWith('.json'));
obs('B2 磁盘上两个独立库文件', `files=[${filesB.join(', ')}]`, filesB.length === 2 ? 'PASS' : 'FAIL');

const dX = readJson(rX.storePath), dY = readJson(rY.storePath);
obs('B3 两库各自归属正确 sessionId（无顶替）',
  `X="${dX?.sessionId}"  Y="${dY?.sessionId}"`,
  dX?.sessionId === SID_X && dY?.sessionId === SID_Y ? 'PASS' : 'FAIL');

const ySeesX = rY.store.experiences.some((e) => TEXTS_A.some((t) => e.title.includes(t.slice(0, 3))));
const xSeesY = rX.store.experiences.some((e) => TEXTS_B.some((t) => e.title.includes(t.slice(0, 3))));
obs('B4 无跨会话污染（后跑方不继承先跑方经验）',
  `Y 看到 X 语料=${ySeesX}; X 看到 Y 语料=${xSeesY}; X exps=${rX.store.experiences.length}; Y exps=${rY.store.experiences.length}`,
  !ySeesX && !xSeesY ? 'PASS' : 'FAIL');

// B5：归属守卫直测。撞名已由根因修复消除，故此处**手工伪造**一个"归属他人的库文件"，
// 验证 loadStore 的 fail-closed 兜底仍然生效（纵深防御不能只是纸面存在）。
const dirG = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-r3-guard-'));
const GSID = 'probe session X';
const rG = await driveSession(dirG, GSID, TEXTS_A);
const gPath = rG.storePath;
const forged = readJson(gPath);
if (forged) { forged.sessionId = 'some-other-session'; fs.writeFileSync(gPath, JSON.stringify(forged), 'utf8'); }
await driveSession(dirG, GSID, TEXTS_A);
const gAfter = readJson(gPath);
obs('B5 守卫直测：伪造他人归属的库必须被拒绝载入并重建',
  `伪造后 sessionId="some-other-session" → 再驱动后 sessionId="${gAfter?.sessionId}" telemetry=[${[...new Set((gAfter?.telemetry ?? []).map((e) => e.kind))].join(',')}]`,
  gAfter?.sessionId === GSID && (gAfter?.telemetry ?? []).some((e) => e.kind === 'STORE_REBUILT') ? 'PASS' : 'FAIL');

// ─────────────────────────────────────────────────────────────
section('C. 超长 sessionId（>120 字符）截断撞名应已消除');

const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-r3-trunc-'));
const LONG_A = 'session-' + 'a'.repeat(200) + '-tailONE';
const LONG_B = 'session-' + 'a'.repeat(200) + '-tailTWO';
const rLA = await driveSession(dirC, LONG_A, TEXTS_A);
const rLB = await driveSession(dirC, LONG_B, TEXTS_B);
const filesC = fs.readdirSync(dirC).filter((f) => f.endsWith('.json'));
obs('C1 超长 sid 不再撞名（两个独立文件）',
  `storePath 相同=${rLA.storePath === rLB.storePath}  文件数=${filesC.length}`,
  rLA.storePath !== rLB.storePath && filesC.length === 2 ? 'PASS' : 'FAIL');

const dLA = readJson(rLA.storePath), dLB = readJson(rLB.storePath);
obs('C2 超长 sid 两库各自归属正确（无互相覆盖）',
  `A 归属正确=${dLA?.sessionId === LONG_A}  B 归属正确=${dLB?.sessionId === LONG_B}`,
  dLA?.sessionId === LONG_A && dLB?.sessionId === LONG_B ? 'PASS' : 'FAIL');

// ─────────────────────────────────────────────────────────────
section('D. 结论');

const contamination = ROWS.some((r) => /跨会话污染|归属正确/.test(r.name) && r.verdict === 'FAIL');
console.log(`\n  PASS=${PASS}  FAIL=${FAIL}`);
console.log(`  正常 DSH sessionId 形状下隔离 = ${rA.storePath !== rB.storePath ? 'HOLDS' : 'BROKEN'}`);
console.log(`  撞名是否仍可达 = ${rX.storePath === rY.storePath ? 'YES' : 'NO（根因已消除）'}`);
console.log(`  归属守卫（fail-closed 兜底）= ${ROWS.find((r) => r.name.startsWith('B5'))?.verdict === 'PASS' ? 'YES' : 'NO'}`);
console.log(`  跨会话污染 = ${contamination ? 'CONFIRMED' : 'NOT CONFIRMED'}`);

for (const d of [dirA, dirB, dirC, dirG]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
process.exit(FAIL ? 2 : 0);
