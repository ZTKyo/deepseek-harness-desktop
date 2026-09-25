// test-learn-r3-hardening.mjs —— PHASE 04 LEARN R3 加固回归（幂等 / 畸形输入 / 会话隔离）
//
// 规格 §27-3 要求"最终验证"包含：determinism、idempotency、malformed input、
// duplicate ingestion、session isolation。本套件补齐此前缺失的三项：
//   H1 幂等（idempotency）
//   H2 畸形输入（malformed input）
//   H3 会话隔离（session isolation）
// duplicate ingestion / ordering determinism 由 redteam-r3-probe.mjs E 段与 test-learn-core C16+ 覆盖。
//
// 隔离用例来自真实缺陷：redteam-r3-isolation.mjs 实证 —— sanitizeFileId 会把
// 'probe session X' 与 'probe_session_X' 映射到同一文件，且 loadStore 不校验载入库的
// sessionId 是否等于请求方，导致静默跨会话污染。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { apply } from '../../plugins/learn.mjs';
import {
  propose, approve, reject, retire, emptyStore, makeExperience, sanitizeExperience, validateStore,
  recall, recordRecall, stableHash, normalizeSourceSeqs, buildLearnDigest,
  learningSignals, redactSecrets, containsSecret, tokenize, stripInjectedContent,
  normalizeTags, MAX_TITLE_LEN, MAX_BODY_LEN, MAX_TAGS, MAX_SOURCE_SEQS, MAX_EXPERIENCES,
  MAX_RECALL_LIMIT,
} from '../../plugins/learn-core.mjs';

let PASS = 0, FAIL = 0;
const FAILURES = [];
let PENDING = 0;
async function check(name, fn) {
  PENDING++;
  try { await fn(); PASS++; console.log(`  PASS  ${name}`); }
  catch (e) { FAIL++; FAILURES.push(`${name}: ${e.message}`); console.log(`  FAIL  ${name}\n          ${e.message}`); }
  finally { PENDING--; }
}
function section(t) { console.log(`\n=== ${t} ===`); }

// ── 真实插件驱动（与 E2E 同一路径）──
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
  type: 'user/message', seq, time: 1700000000000 + seq,
  data: { role: 'user', content: [{ type: 'text', text }] },
});
async function drive(stateDir, sid, texts) {
  const { ctx, hooks, logs } = mkCtx();
  const api = apply(ctx, { stateDir, minNewNodes: 4, minTurnsForLearning: 4, maxDigestTurns: 40 });
  const fire = async (session) => {
    const fns = hooks.get('agent/pre-step') ?? [];
    if (!fns.length) throw new Error('no agent/pre-step hook registered');
    for (const fn of fns) await fn({ agent: { session } }, () => {});
  };
  const events = texts.map((t, i) => mkEvent(i, t));
  await fire({ id: sid, events, surface: { nodes: events.map((e) => e.seq) } });   // 水位
  for (let i = texts.length; i < texts.length + 4; i++) events.push(mkEvent(i, texts[i % texts.length]));
  await fire({ id: sid, events, surface: { nodes: events.map((e) => e.seq) } });   // 学习
  return { api, logs, storePath: api.storePath(sid), store: api.getStore(sid) };
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const TEXTS_A = ['这里报错了', '已经修好了', '又崩了', '现在跑通了'];
const TEXTS_B = ['数据库连接超时了', '已经修复了', '服务崩溃了', '现在跑通了'];
const draft = (over = {}) => ({
  title: '构建失败后改用 pnpm 解决',
  body: 'signal: failure\noutcome: resolved\norigin: test',
  tags: ['failure', 'resolution'],
  sourceEventSeqs: [3, 1, 2, 1],
  originSessionId: 'sess-h1',
  createdAt: 1700000000000,
  ...over,
});

// ═════════════════════════════════════════════════════════════
section('H1 幂等 / 确定性（idempotency & determinism）');

await check('H1.1 同一 draft 连续提案 3 次 → 只产生 1 条，id 稳定', () => {
  let s = emptyStore('sess-h1');
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = propose(s, draft());
    assert.equal(r.ok, true, `propose 应成功: ${r.error}`);
    s = r.value;
    ids.push(r.experience.id);
  }
  assert.equal(s.experiences.length, 1, `应去重为 1 条，实际 ${s.experiences.length}`);
  assert.equal(new Set(ids).size, 1, `id 应稳定，实际 ${JSON.stringify(ids)}`);
});

await check('H1.2 重复提案标记 deduped=true（不产生新条目）', () => {
  const s1 = propose(emptyStore('sess-h1'), draft()).value;
  const r2 = propose(s1, draft());
  assert.equal(r2.deduped, true, '第二次应 deduped');
  assert.equal(r2.value.experiences.length, 1, '条目数不应增长');
});

await check('H1.3 sourceEventSeqs 乱序/重复不影响 id（规范化幂等）', () => {
  const a = makeExperience(draft({ sourceEventSeqs: [3, 1, 2, 1] })).value;
  const b = makeExperience(draft({ sourceEventSeqs: [1, 2, 3] })).value;
  assert.equal(a.id, b.id, '同一证据集应派生同一 id');
  assert.deepEqual(a.sourceEventSeqs, [1, 2, 3], `应规范化去重升序，实际 ${JSON.stringify(a.sourceEventSeqs)}`);
});

await check('H1.4 提案顺序不影响最终库内容（顺序无关）', () => {
  const d1 = draft({ title: 'A 教训', sourceEventSeqs: [1] });
  const d2 = draft({ title: 'B 教训', sourceEventSeqs: [2] });
  const s1 = propose(propose(emptyStore('s'), d1).value, d2).value;
  const s2 = propose(propose(emptyStore('s'), d2).value, d1).value;
  const ids = (s) => s.experiences.map((e) => e.id).sort();
  assert.deepEqual(ids(s1), ids(s2), '两种顺序应得到同一集合');
});

await check('H1.5 stableHash 确定性（1000 次同输入同输出）', () => {
  const h = new Set();
  for (let i = 0; i < 1000; i++) h.add(stableHash('session|1,2,3|标题'));
  assert.equal(h.size, 1, `应恒等，实际 ${h.size} 种`);
});

await check('H1.6 recordRecall 同一批 id 应用两次 → recallCount 精确为 2', () => {
  let s = propose(emptyStore('s'), draft()).value;
  const id = s.experiences[0].id;
  s = recordRecall(s, [id], 1000);
  s = recordRecall(s, [id], 2000);
  assert.equal(s.experiences[0].recallCount, 2, `应为 2，实际 ${s.experiences[0].recallCount}`);
  assert.equal(s.experiences[0].lastRecalledAt, 2000, 'lastRecalledAt 应取最后一次');
});

await check('H1.7 真实插件：同一会话重复驱动不重复学习（水位防抖）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-h1-'));
  const r = await drive(dir, 'sess-idem-1', TEXTS_A);
  const n1 = r.store.experiences.length;
  assert.ok(n1 >= 1, `前置条件：应产出候选，实际 ${n1}`);
  // 用同一 stateDir 再驱动一次同一会话 → 载入已有库，不应新增重复条目
  const r2 = await drive(dir, 'sess-idem-1', TEXTS_A);
  assert.equal(r2.store.experiences.length, n1, `不应新增条目：${n1} → ${r2.store.experiences.length}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('H1.8 确定性：两个独立 stateDir 同场景 → 除时间字段外逐字节一致', async () => {
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-h1a-'));
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-h1b-'));
  const a = await drive(d1, 'sess-det', TEXTS_A);
  const b = await drive(d2, 'sess-det', TEXTS_A);
  const strip = (s) => JSON.stringify({
    sessionId: s.sessionId,
    experiences: s.experiences.map((e) => ({
      id: e.id, state: e.state, title: e.title, body: e.body, tags: e.tags,
      sourceEventSeqs: e.sourceEventSeqs, promotion: e.promotion,
    })),
    telemetryKinds: s.telemetry.map((e) => e.kind),
  });
  assert.equal(strip(a.store), strip(b.store), '同场景应确定性等价');
  fs.rmSync(d1, { recursive: true, force: true });
  fs.rmSync(d2, { recursive: true, force: true });
});

// ═════════════════════════════════════════════════════════════
section('H2 畸形输入（malformed input，绝不抛出）');

const badInputs = [null, undefined, 0, 1, -1, NaN, Infinity, '', 'x', true, false, [], [1, 2], {}, { a: 1 },
  Symbol('s'), () => {}, new Date(), Buffer.from('x')];
const tryCall = (label, fn) => {
  try { return { ok: true, value: fn() }; }
  catch (e) { return { ok: false, error: `${label}: ${e && e.message ? e.message : String(e)}` }; }
};

await check('H2.1 buildLearnDigest 对任意畸形参数不抛异常', () => {
  const errs = [];
  for (const v of badInputs) {
    for (const [a, b] of [[v, v], [v, []], [[], v], [undefined, undefined]]) {
      const r = tryCall('buildLearnDigest', () => buildLearnDigest(a, b));
      if (!r.ok) errs.push(r.error);
      else assert.equal(typeof r.value.ok, 'boolean', '应返回结构化结果');
    }
  }
  assert.deepEqual(errs, [], errs.join(' | '));
});

await check('H2.2 learningSignals 对任意畸形 digest 不抛异常', () => {
  const errs = [];
  for (const v of badInputs) {
    const r = tryCall('learningSignals', () => learningSignals(v));
    if (!r.ok) errs.push(r.error);
  }
  for (const v of [{}, { turns: null }, { turns: [] }, { turns: [null, 1, 'x', {}] },
    { turns: [{ seq: NaN, role: null, text: null }] }, { turns: [{ seq: -1, role: {}, text: 123 }] }]) {
    const r = tryCall('learningSignals', () => learningSignals(v));
    if (!r.ok) errs.push(r.error);
  }
  assert.deepEqual(errs, [], errs.join(' | '));
});

await check('H2.3 propose / makeExperience 对畸形 draft 返回结构化错误', () => {
  const errs = [];
  for (const v of badInputs) {
    const r = tryCall('propose', () => propose(emptyStore('s'), v));
    if (!r.ok) errs.push(r.error);
    else if (r.value && r.value.ok === false) assert.equal(typeof r.value.error, 'string', '应给出错误码');
  }
  for (const v of [{}, { title: 'x' }, { body: 'y' }, { title: '', body: 'y' },
    { title: 'x', body: 'y' }, { title: 'x', body: 'y', sourceEventSeqs: [] },
    { title: 'x', body: 'y', sourceEventSeqs: [NaN, -1, 1.5, '2', null] }]) {
    const r = tryCall('makeExperience', () => makeExperience(v));
    if (!r.ok) errs.push(r.error);
  }
  assert.deepEqual(errs, [], errs.join(' | '));
});

await check('H2.4 propose 对畸形 store 不抛异常（返回 ok:false 或安全结果）', () => {
  const errs = [];
  for (const v of badInputs) {
    const r = tryCall('propose', () => propose(v, draft()));
    if (!r.ok) errs.push(r.error);
  }
  assert.deepEqual(errs, [], errs.join(' | '));
});

// ── R-5（独立 Release Gate 评审记录项）：approve/reject/retire 的畸形 store 硬化 ──
// 原状：R3 加固只做了 6 个函数中的 3 个（propose/recall/recordRecall 返回结构化
// invalid_store），approve/reject/retire 直接读 store.experiences → 抛 TypeError。
// 评审判定为「不可达」（getStore 保证 store 合法），但同类入参不应有两套行为。
await check('H2.13 approve/reject/retire 对畸形 store 返回结构化错误，绝不抛 TypeError', () => {
  const errs = [];
  for (const v of badInputs) {
    for (const fn of [approve, reject, retire]) {
      const r = tryCall(fn.name, () => fn(v, 'x', { approver: 'a', evidence: 'e', reason: 'r' }));
      if (!r.ok) errs.push(r.error);
      else {
        assert.equal(r.value.ok, false, `${fn.name} 对畸形 store 应返回 ok:false`);
        assert.equal(r.value.error, 'invalid_store', `${fn.name} 应返回 invalid_store，实际 ${r.value.error}`);
      }
    }
    // 半畸形：store 是对象但 experiences 不是数组
    for (const fn of [approve, reject, retire]) {
      const r = tryCall(fn.name, () => fn({ experiences: 'not-an-array' }, 'x', {}));
      if (!r.ok) errs.push(r.error);
      else assert.equal(r.value.error, 'invalid_store', `${fn.name} experiences 非数组时应返回 invalid_store`);
    }
  }
  assert.deepEqual(errs, [], errs.join(' | '));
});

await check('H2.14 approve/reject/retire 对合法 store 但 id 不存在 → experience_not_found（非抛错）', () => {
  const s = emptyStore('sess-r5');
  for (const fn of [approve, reject, retire]) {
    const r = tryCall(fn.name, () => fn(s, 'no-such-id', { approver: 'a', evidence: 'e', reason: 'r' }));
    assert.ok(r.ok, `${fn.name} 抛异常了: ${r.error}`);
    assert.equal(r.value.ok, false, `${fn.name} 应返回 ok:false`);
    assert.equal(r.value.error, 'experience_not_found', `${fn.name} 错误码应为 experience_not_found`);
  }
});

// ── R-6（独立 Release Gate 评审记录项）：库满时新写入不得被静默丢弃 ──
// 原状：withExperience 按 createdAt 升序排序后 slice(-MAX_EXPERIENCES)，而 makeExperience
// 在调用方未给时间戳时把 createdAt 落为 0 → 新提案排到最前被裁掉 → 「写成功但库里没有」。
await check('H2.15 库满 + createdAt 缺失时，新提案必须仍在库中（淘汰最旧而非丢弃最新）', () => {
  let s = emptyStore('sess-r6');
  for (let i = 0; i < MAX_EXPERIENCES; i++) {
    const r = propose(s, draft({ title: `填充条目 ${i}`, createdAt: 1700000000000 + i, originSessionId: 'sess-r6' }));
    assert.ok(r.ok, `填充第 ${i} 条失败: ${r.error}`);
    s = r.value;
  }
  assert.equal(s.experiences.length, MAX_EXPERIENCES, '库应已满');

  const beforeIds = new Set(s.experiences.map((e) => e.id));
  const r2 = propose(s, draft({ title: 'createdAt 缺失的新提案', createdAt: undefined, originSessionId: 'sess-r6' }));
  assert.ok(r2.ok, `新提案失败: ${r2.error}`);
  assert.equal(r2.experience.createdAt, 0, '前置：本用例必须命中 createdAt=0 这条路径');

  const after = r2.value.experiences;
  assert.equal(after.length, MAX_EXPERIENCES, '容量上限应保持');
  const afterIds = new Set(after.map((e) => e.id));
  assert.ok(afterIds.has(r2.experience.id), 'R-6：返回 ok:true 但新提案不在库中 —— 静默丢弃');

  const evicted = [...beforeIds].filter((id) => !afterIds.has(id));
  assert.equal(evicted.length, 1, `应恰好淘汰 1 条，实际 ${evicted.length}`);
  const evictedExp = s.experiences.find((e) => e.id === evicted[0]);
  const minCreated = Math.min(...s.experiences.map((e) => e.createdAt));
  assert.equal(evictedExp.createdAt, minCreated, '被淘汰的应是最旧（createdAt 最小）的一条');
});

await check('H2.16 R-6 修复后仍保持确定性（同输入 → 同输出，逐字节一致）', () => {
  const build = () => {
    let s = emptyStore('sess-r6d');
    for (let i = 0; i < MAX_EXPERIENCES; i++) {
      s = propose(s, draft({ title: `d${i}`, createdAt: 1700000000000 + i, originSessionId: 'sess-r6d' })).value;
    }
    return propose(s, draft({ title: 'new', createdAt: undefined, originSessionId: 'sess-r6d' })).value;
  };
  assert.equal(JSON.stringify(build()), JSON.stringify(build()), 'R-6 修复破坏了确定性');
});

await check('H2.5 sanitizeExperience / validateStore 拒绝畸形且不抛', () => {
  const errs = [];
  for (const v of [...badInputs, { id: 'x' }, { id: 'x', state: 'NOPE', title: 'a', body: 'b', tags: [], sourceEventSeqs: [1] },
    { id: '', state: 'PROPOSED', title: 'a', body: 'b', tags: [], sourceEventSeqs: [1] }]) {
    for (const fn of [sanitizeExperience, validateStore]) {
      const r = tryCall(fn.name, () => fn(v));
      if (!r.ok) errs.push(r.error);
    }
  }
  assert.deepEqual(errs, [], errs.join(' | '));
  assert.equal(validateStore({ schemaVersion: 1, sessionId: 'x', version: NaN, experiences: [], telemetry: [] }), null,
    'version=NaN 应判废');
  assert.equal(validateStore({ schemaVersion: 999, sessionId: 'x', version: 0, experiences: [], telemetry: [] }), null,
    'schemaVersion 不符应判废');
});

await check('H2.6 recall / tokenize 对畸形查询不抛异常', () => {
  const errs = [];
  const store = propose(emptyStore('s'), draft()).value;
  for (const v of badInputs) {
    for (const [s, q] of [[store, v], [v, 'q'], [v, v]]) {
      const r = tryCall('recall', () => recall(s, q));
      if (!r.ok) errs.push(r.error);
    }
    const t = tryCall('tokenize', () => tokenize(v));
    if (!t.ok) errs.push(t.error);
  }
  assert.deepEqual(errs, [], errs.join(' | '));
  const r = recall(store, null, { limit: -5 });
  assert.ok(Array.isArray(r.items), 'limit 非法应回退默认值');
});

await check('H2.7 脱敏函数对畸形输入不抛异常', () => {
  const errs = [];
  for (const v of badInputs) {
    const a = tryCall('redactSecrets', () => redactSecrets(v));
    if (!a.ok) errs.push(a.error);
    const b = tryCall('containsSecret', () => containsSecret(v));
    if (!b.ok) errs.push(b.error);
    const c = tryCall('stripInjectedContent', () => stripInjectedContent(v));
    if (!c.ok) errs.push(c.error);
    const d = tryCall('normalizeTags', () => normalizeTags(v));
    if (!d.ok) errs.push(d.error);
    const e = tryCall('normalizeSourceSeqs', () => normalizeSourceSeqs(v));
    if (!e.ok) errs.push(e.error);
  }
  assert.deepEqual(errs, [], errs.join(' | '));
});

await check('H2.8 超限输入被安全钳制（不产生超长/超量字段）', () => {
  const huge = 'x'.repeat(1_000_000);
  const e = makeExperience({ title: huge, body: huge, tags: Array.from({ length: 500 }, (_, i) => 't' + i), sourceEventSeqs: Array.from({ length: 500 }, (_, i) => i) });
  assert.equal(e.ok, true, '超长输入应被钳制而非拒绝');
  assert.ok(e.value.title.length <= MAX_TITLE_LEN, `title 应 ≤ ${MAX_TITLE_LEN}，实际 ${e.value.title.length}`);
  assert.ok(e.value.body.length <= MAX_BODY_LEN, `body 应 ≤ ${MAX_BODY_LEN}，实际 ${e.value.body.length}`);
  assert.ok(e.value.tags.length <= MAX_TAGS, `tags 应 ≤ ${MAX_TAGS}，实际 ${e.value.tags.length}`);
  assert.ok(e.value.sourceEventSeqs.length <= MAX_SOURCE_SEQS, `seqs 应 ≤ ${MAX_SOURCE_SEQS}，实际 ${e.value.sourceEventSeqs.length}`);
});

await check('H2.9 normalizeSourceSeqs 只接受非负整数（拒绝 NaN/负数/小数/字符串）', () => {
  assert.deepEqual(normalizeSourceSeqs([NaN, -1, 1.5, '2', null, undefined, Infinity, 3, 0]),
    [0, 3], '应只保留 0 与 3');
});

await check('H2.10 原型污染尝试不污染全局原型', () => {
  const before = Object.prototype.polluted;
  const evil = JSON.parse('{"__proto__":{"polluted":"yes"}}');
  try { propose(emptyStore('s'), { ...evil, title: 't', body: 'b', sourceEventSeqs: [1] }); } catch {}
  try { sanitizeExperience(evil); } catch {}
  try { validateStore(evil); } catch {}
  assert.equal(Object.prototype.polluted, before, 'Object.prototype 不应被污染');
  assert.equal({}.polluted, undefined, '新对象不应继承污染属性');
});

await check('H2.12 recordRecall 对畸形 store/ids 不抛异常（且正常路径仍递增）', () => {
  const errs = [];
  for (const v of badInputs) {
    for (const [s, i] of [[v, [1]], [emptyStore('s'), v], [v, v]]) {
      const r = tryCall('recordRecall', () => recordRecall(s, i, 1000));
      if (!r.ok) errs.push(r.error);
    }
  }
  assert.deepEqual(errs, [], errs.join(' | '));
  // 防回归：加了守卫后正常路径必须仍然真的递增
  const s1 = propose(emptyStore('s'), draft()).value;
  const s2 = recordRecall(s1, [s1.experiences[0].id], 1000);
  assert.equal(s2.experiences[0].recallCount, 1, '正常路径应仍递增 recallCount');
});

await check('H2.11 validateStore 拒绝超过 MAX_EXPERIENCES 的库', () => {
  const big = { schemaVersion: 1, sessionId: 'x', version: 0, telemetry: [],
    experiences: Array.from({ length: MAX_EXPERIENCES + 1 }, () => ({})) };
  assert.equal(validateStore(big), null, '超量库应判废');
});

// ═════════════════════════════════════════════════════════════
section('H3 会话隔离（session isolation）');

await check('H3.1 两个真实形状 sessionId → 两个独立库文件、各自归属正确', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-h3-'));
  const A = 'session-04ecc1a4-fae9-4eb9-9a08-89b79128bcd4';
  const B = 'session-11112222-3333-4444-5555-666677778888';
  const rA = await drive(dir, A, TEXTS_A);
  const rB = await drive(dir, B, TEXTS_B);
  assert.notEqual(rA.storePath, rB.storePath, 'storePath 应不同');
  assert.equal(readJson(rA.storePath)?.sessionId, A, 'A 库归属应为 A');
  assert.equal(readJson(rB.storePath)?.sessionId, B, 'B 库归属应为 B');
  const tA = rA.store.experiences.map((e) => e.title);
  const tB = rB.store.experiences.map((e) => e.title);
  assert.equal(tA.filter((t) => tB.includes(t)).length, 0, '标题不应有交集');
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('H3.2 跨会话召回不成立：B 的库召回不到 A 的经验', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-h3r-'));
  const rA = await drive(dir, 'sess-iso-A', TEXTS_A);
  const rB = await drive(dir, 'sess-iso-B', TEXTS_B);
  // 把 A 的经验激活，再确认 B 的库召回不到
  const aExp = rA.store.experiences[0];
  assert.ok(aExp, '前置条件：A 应有候选');
  // ★ F1（2026-09-25）：在内存里手写 `state:'APPROVED'` **不再**等于"已激活"——
  //   APPROVED 的召回资格必须由 live 人类授权（宿主通道事实 + 绑定 + 进程内签章）判定，
  //   伪造痕迹一律不可召回（这正是 BLOCKER-1 的修复语义）。本用例只考察**会话隔离**，
  //   因此走机器验证通道 VERIFIED_EXPERIENCE（Layer A 内合法可召回，不需要人类审批）。
  const storeA = { ...rA.store, experiences: rA.store.experiences.map((e) => ({ ...e, state: 'VERIFIED_EXPERIENCE' })) };
  const hitInA = recall(storeA, aExp.title, { limit: MAX_RECALL_LIMIT });
  assert.ok(hitInA.items.length >= 1, '前置条件：A 自己应能召回');
  const hitInB = recall(rB.store, aExp.title, { limit: MAX_RECALL_LIMIT });
  assert.equal(hitInB.items.length, 0, `B 不应召回 A 的经验，实际 ${hitInB.items.length}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('H3.3 撞名已消除：清洗会改变 sid 时文件名不再相撞，各自归属正确', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-h3c-'));
  const X = 'probe session X';       // 清洗会改动 → 追加短哈希
  const Y = 'probe_session_X';       // 未被改动 → 保持原名（零迁移影响）
  const rX = await drive(dir, X, TEXTS_A);
  assert.equal(rX.store.experiences.length >= 1, true, '前置条件：X 应产出候选');
  const rY = await drive(dir, Y, TEXTS_B);
  assert.notEqual(rX.storePath, rY.storePath, '两个不同 sid 必须映射到不同文件（撞名应已消除）');
  const yTitles = rY.store.experiences.map((e) => e.title);
  const xTitles = rX.store.experiences.map((e) => e.title);
  const leaked = yTitles.filter((t) => xTitles.includes(t));
  assert.equal(leaked.length, 0, `Y 不得读到 X 的经验，泄漏=${JSON.stringify(leaked)}`);
  assert.equal(rY.store.sessionId, Y, `Y 的库 sessionId 应为 Y，实际 ${rY.store.sessionId}`);
  // Y 的 sid 未被清洗改动 ⇒ 文件名必须原样（保证既有库文件零迁移）
  assert.equal(path.basename(rY.storePath), `${Y}.json`, '未改动的 sid 文件名必须保持不变');
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('H3.4 超长 sessionId 截断不再撞名：两个独立文件、无互相覆盖', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-h3t-'));
  const LA = 'session-' + 'a'.repeat(200) + '-tailONE';
  const LB = 'session-' + 'a'.repeat(200) + '-tailTWO';
  const rA = await drive(dir, LA, TEXTS_A);
  const rB = await drive(dir, LB, TEXTS_B);
  assert.ok(rA.store.experiences.length >= 1, '前置条件：A 应产出候选');
  assert.notEqual(rA.storePath, rB.storePath, '超长 sid 截断后不得撞名（否则两会话互相覆盖丢数据）');
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 2, '磁盘上应为两个库文件');
  const tA = rA.store.experiences.map((e) => e.title);
  const tB = rB.store.experiences.map((e) => e.title);
  assert.equal(tB.filter((t) => tA.includes(t)).length, 0, 'B 不得继承 A 的候选');
  assert.equal(rB.store.sessionId, LB, 'B 的库归属必须正确');
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('H3.5 归属守卫兜底直测：伪造他人归属的库必须被拒绝载入并记 STORE_REBUILT', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-h3l-'));
  const S = 'probe session X';
  const r1 = await drive(dir, S, TEXTS_A);
  // 撞名已被根因修复消除 ⇒ 手工伪造一个"归属他人"的库文件，验证 fail-closed 兜底真的生效
  const j = JSON.parse(fs.readFileSync(r1.storePath, 'utf8'));
  j.sessionId = 'some-other-session';
  fs.writeFileSync(r1.storePath, JSON.stringify(j), 'utf8');
  const r2 = await drive(dir, S, TEXTS_A);
  const kinds = r2.store.telemetry.map((e) => e.kind);
  assert.equal(r2.store.sessionId, S, `被拒绝载入后应重建为己方库，实际 ${r2.store.sessionId}`);
  assert.ok(kinds.includes('STORE_REBUILT'),
    `归属不一致被拒绝载入时必须记 STORE_REBUILT（fail-closed 且可观测），实际 telemetry=${JSON.stringify(kinds)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

await check('H3.6 会话隔离不受 store 版本号/遥测影响（重载后仍归属正确）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-h3v-'));
  const A = 'session-aaaa-1111';
  await drive(dir, A, TEXTS_A);
  const first = readJson(path.join(dir, 'session-aaaa-1111.json'));
  assert.equal(first?.sessionId, A, '首次落盘归属应正确');
  // 再驱动一次（走 loadStore 路径）
  const r2 = await drive(dir, A, TEXTS_A);
  assert.equal(r2.store.sessionId, A, '重载后归属仍应为 A');
  assert.ok(r2.store.version >= first.version, 'version 应单调不减');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ═════════════════════════════════════════════════════════════
if (PENDING !== 0) { FAIL++; FAILURES.push(`${PENDING} 个 check 未被 await（假绿风险）`); console.log(`  FAIL  未 await 的 check 数量=${PENDING}（假绿风险）`); }
console.log(`\n=== R3 加固回归: ${PASS} PASS / ${FAIL} FAIL ===`);
if (FAILURES.length) {
  console.log('\n失败明细:');
  for (const f of FAILURES) console.log('  - ' + f);
}
process.exit(FAIL > 0 ? 1 : 0);
