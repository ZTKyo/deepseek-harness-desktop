// test-learn-ac6-candidate-durability.mjs —— AC6 Tier-1：**待人工审批条目不得被容量静默淘汰**
//
// 存在理由（实测缺陷，不是假想）：
//   Layer A（会话本地经验库）上限 MAX_EXPERIENCES=200；原 `withExperience()` 一律按 createdAt
//   升序 `slice(-200)`，**不区分 state**。于是一条「机器已验证、只差人工点一下」的
//   VERIFIED_EXPERIENCE 会在此后 200 条新经验到来时被静默丢掉（实测约 18.7h 后
//   exp-2ed0f0c9 真的消失）——而人工审批步（host-only，agent 无权代替）需要那条记录**还在**，
//   于是整个 AC6 循环永远无法被走完。这类条目的证据**不可重建**（人已离开那个时刻，
//   重跑不会再造出同一份 success evidence）。
//
// 本套件同时锁三件事（缺一即为"假绿"）：
//   ① 正向（真路径）：库满 + 存在待审批条目时，经**生产函数 `propose()`** 再写入，
//      待审批条目必须仍在库中，且容量上限仍被保持、恰好淘汰 1 条非待审批条目。
//   ② 负控（证明本测试能真正失败）：把**原实现**逐字复刻成 oracle 跑同一输入，
//      断言它**确实会丢掉**待审批条目 —— 若某天有人把修复回退，① 会红、② 的对照仍成立。
//   ③ 反"焊死"（合法路径仍然通过）：全库皆待审批时，写入仍必须淘汰（容量绝对有界），
//      且 R-6 的"刚写入这条必须在库"不变量不得被破坏；连续写入 60 次仍恒 ≤ 上限。
//
// 纪律：零子进程 / 零网络 / 零真实会话数据（全部合成）；不写任何生产目录。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  MAX_EXPERIENCES,
  emptyStore,
  makeExperience,
  propose,
  applyVerification,
  validateStore,
} from '../../plugins/learn-core.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, error: e?.message ?? String(e) });
    console.log(`  FAIL  ${name} — ${e?.message ?? e}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// ── 合成夹具（确定性；无真实会话内容；全部临时状态在 os.tmpdir()） ───────────────
const SID = 'sess-ac6-durability';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ac6-durability-'));
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function entry(seq, { state = 'PROPOSED', createdAt } = {}) {
  const made = makeExperience({
    title: `durability fixture ${seq}`,
    body: `synthetic body ${seq} — capacity/eviction fixture (no real session content)`,
    sourceEventSeqs: [seq],
    originSessionId: SID,
    createdAt,
  });
  assert(made.ok === true, `fixture makeExperience failed: ${made.error}`);
  return { ...made.value, state };
}

/**
 * 走**真实验证路径** `applyVerification()`（file_hash + 真文件真哈希）造一条
 * VERIFIED_EXPERIENCE —— 即"机器已验证、正等人工审批"的那一条。
 * 刻意不用手工拼 state/verification 字段：手拼的条目会被 sanitizeExperience 以
 * verified_state_without_verification 拒绝（fail-closed），那样测的就不是生产路径。
 */
let verifiedBuilt = false;
// 证据文件**只建一次**并复用：夹具必须确定性（同输入 → 同输出），否则 P4 测的是夹具不是规则。
const EVIDENCE_FILE = path.join(TMP, 'evidence-stable.txt');
fs.writeFileSync(EVIDENCE_FILE, 'synthetic evidence — no real session content\n', 'utf8');
const EVIDENCE_SHA = sha256(EVIDENCE_FILE);
function verifiedStore() {
  verifiedBuilt = true;
  let s = propose(emptyStore(SID), {
    title: 'verified fixture stable',
    body: 'synthetic verified body — stable fixture (no real session content)',
    sourceEventSeqs: [11],
    originSessionId: SID,
    createdAt: 1000,
  });
  assert(s.ok === true, `fixture propose failed: ${s.error}`);
  const id = s.experience.id;
  const r = applyVerification(
    s.value,
    id,
    { class: 'file_hash', path: EVIDENCE_FILE, sha256: EVIDENCE_SHA, note: 'synthetic durability fixture' },
    { fileHash: (f) => sha256(f) },
    1100,
  );
  assert(r.ok === true, `fixture applyVerification failed: ${r.error}`);
  const exp = r.value.experiences.find((e) => e.id === id);
  assertEq(exp.state, 'VERIFIED_EXPERIENCE', '夹具前置：应处于 VERIFIED_EXPERIENCE');
  assert(validateStore(r.value) !== null, '夹具前置：真实验证路径产物应通过 validateStore');
  return { store: r.value, pending: exp };
}

/** 造一个已满（MAX_EXPERIENCES 条）的库：终态条目 + 1 条待审批（且最旧）。 */
function fullStoreWithPending({ pendingKind = 'verified' } = {}) {
  let base;
  let pending;
  if (pendingKind === 'verified') {
    const v = verifiedStore();
    base = v.store;
    pending = v.pending;
  } else {
    base = false;
    pending = entry(1, { state: 'PROPOSED', createdAt: 1000 });
    base = { ...emptyStore(SID), experiences: [pending] };
  }
  const pendingCreatedAt = pending.createdAt;
  const rest = [];
  for (let i = 0; i < MAX_EXPERIENCES - 1; i += 1) {
    // 终态条目 createdAt 一律**更新**于待审批条目 ⇒ 旧实现"淘汰最旧"必然先杀待审批那条
    rest.push(entry(1000 + i, { state: 'REJECTED', createdAt: pendingCreatedAt + 1 + i }));
  }
  return { store: { ...base, experiences: [pending, ...rest] }, pending };
}

// ── ② 负控 oracle：**逐字复刻原实现**（回退即红） ──────────────────────────────
// 原实现（commit cee7197 plugins/learn-core.mjs:616-629）：
//   const next = store.experiences.filter(e => e.id !== exp.id); next.push(exp);
//   next.sort(byCreatedThenId); let kept = next.slice(-MAX_EXPERIENCES);
//   if (kept.length >= MAX_EXPERIENCES && !kept.some(e => e.id === exp.id)) {
//     kept = next.slice(-(MAX_EXPERIENCES - 1)).concat(exp).sort(byCreatedThenId); }
// 不区分 state —— 这正是缺陷本身。
const byCreatedThenId = (a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function legacyWithExperience(store, exp) {
  const next = store.experiences.filter((e) => e.id !== exp.id);
  next.push(exp);
  next.sort(byCreatedThenId);
  let kept = next.slice(-MAX_EXPERIENCES);
  if (kept.length >= MAX_EXPERIENCES && !kept.some((e) => e.id === exp.id)) {
    kept = next.slice(-(MAX_EXPERIENCES - 1)).concat(exp).sort(byCreatedThenId);
  }
  return { ...store, experiences: kept };
}

console.log('=== AC6 Tier-1：待人工审批条目的容量持久性（正向 / 负控 / 反焊死）===');
assertEq(MAX_EXPERIENCES, 200, '前置：容量上限口径与本用例前提一致');

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n--- ① 正向：真路径 propose() 在库满时保住待审批条目 ---');
check('P1 前置：夹具确实已满，且待审批条目是最旧的一条', () => {
  const { store, pending } = fullStoreWithPending();
  assertEq(store.experiences.length, MAX_EXPERIENCES, '库应为满');
  const oldest = [...store.experiences].sort(byCreatedThenId)[0];
  assertEq(oldest.id, pending.id, '待审批条目应是最旧（旧实现必然先淘汰它）');
  assertEq(store.experiences.filter((e) => e.state === 'VERIFIED_EXPERIENCE').length, 1, '恰 1 条待审批');
});

check('P2 ★ 真路径：库满 → propose 新条目后，待审批 VERIFIED_EXPERIENCE 仍在库中', () => {
  const { store, pending } = fullStoreWithPending();
  const before = new Set(store.experiences.map((e) => e.id));
  const r = propose(store, {
    title: 'new experience after capacity',
    body: 'synthetic — must evict a terminal entry, never the pending one',
    sourceEventSeqs: [9001],
    originSessionId: 'sess-ac6-durability',
    createdAt: 99_999_999,
  });
  assert(r.ok === true, `propose 应成功，实际 ${r.error}`);
  const after = r.value.experiences;
  assertEq(after.length, MAX_EXPERIENCES, '容量上限必须保持');
  assert(after.some((e) => e.id === pending.id), '待审批条目被静默淘汰 ⇒ AC6 循环无法完成');
  assert(after.some((e) => e.id === r.experience.id), 'R-6：刚写入的条目必须在库中');
  const gone = [...before].filter((id) => !after.some((e) => e.id === id));
  assertEq(gone.length, 1, `应恰好淘汰 1 条，实际 ${gone.length}`);
  const evicted = store.experiences.find((e) => e.id === gone[0]);
  assertEq(evicted.state, 'REJECTED', '被淘汰的应是非待审批（可重建）条目');
});

check('P3 待审批的 PROPOSED 同样受保护（两种待人工处置状态都覆盖）', () => {
  const { store, pending } = fullStoreWithPending({ pendingKind: 'proposed' });
  const r = propose(store, {
    title: 'another new experience', body: 'synthetic fixture body', sourceEventSeqs: [9002],
    originSessionId: 'sess-ac6-durability', createdAt: 88_888_888,
  });
  assert(r.ok === true, `propose 应成功，实际 ${r.error}`);
  assert(r.value.experiences.some((e) => e.id === pending.id), 'PROPOSED 待审批条目被静默淘汰');
});

check('P4 确定性：同输入 → 同输出（逐字节一致）', () => {
  const build = () => {
    const { store } = fullStoreWithPending();
    return propose(store, {
      title: 'determinism probe', body: 'synthetic fixture body', sourceEventSeqs: [9003],
      originSessionId: 'sess-ac6-durability', createdAt: 77_777_777,
    }).value;
  };
  assertEq(JSON.stringify(build()), JSON.stringify(build()), '淘汰规则破坏确定性');
});

check('P5 修复后的库仍通过 validateStore（不得产出畸形库）', () => {
  const { store } = fullStoreWithPending();
  const r = propose(store, {
    title: 'validate store probe', body: 'synthetic fixture body', sourceEventSeqs: [9004],
    originSessionId: 'sess-ac6-durability', createdAt: 66_666_666,
  });
  assert(validateStore(r.value) !== null, 'validateStore 拒绝了 propose 的产物');
});

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n--- ② 负控：证明"旧规则真的会丢掉待审批条目"（本测试能失败）---');
check('N1 ★ 旧实现（逐字复刻）在**同一输入**下丢掉了待审批条目', () => {
  const { store, pending } = fullStoreWithPending();
  const r = propose(store, {
    title: 'new experience after capacity', body: 'synthetic — same input as P2', sourceEventSeqs: [9001],
    originSessionId: 'sess-ac6-durability', createdAt: 99_999_999,
  });
  assert(r.ok === true, 'precondition: propose ok');
  // 用旧算法重放**同一组**输入（旧库 + 同一条新经验）
  const legacy = legacyWithExperience(store, r.experience);
  assertEq(legacy.experiences.length, MAX_EXPERIENCES, '旧实现容量上限同样是 200');
  assert(!legacy.experiences.some((e) => e.id === pending.id),
    '负控失效：旧实现竟然也保住了待审批条目 ⇒ 本用例无法证明缺陷存在');
  // 同一输入下新实现必须给出相反结论（修复真实生效，不是"两边一样绿"）
  assert(r.value.experiences.some((e) => e.id === pending.id), '新实现未保住待审批条目');
  console.log(`        INFO 旧实现淘汰了 ${pending.id}（${pending.state}，createdAt=${pending.createdAt}）⇒ 缺陷可复现`);
});

check('N2 旧的"createdAt=0 兜底分支"也不区分 state（第二条独立负控）', () => {
  const { store, pending } = fullStoreWithPending();
  const r = propose(store, {
    title: 'no-timestamp write hits the R-6 branch', body: 'synthetic', sourceEventSeqs: [9005],
    originSessionId: 'sess-ac6-durability', createdAt: undefined,
  });
  assertEq(r.experience.createdAt, 0, '前置：本用例必须命中 createdAt=0 的 R-6 分支');
  const legacy = legacyWithExperience(store, r.experience);
  assert(legacy.experiences.some((e) => e.id === r.experience.id), '旧实现的 R-6 分支应保住刚写入那条');
  assert(!legacy.experiences.some((e) => e.id === pending.id),
    '负控失效：旧实现的 R-6 分支保住了刚写入那条，但应同时丢掉最旧的待审批条目');
});

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n--- ③ 反"焊死"：容量必须绝对有界（合法路径仍然通过）---');
check('A1 全库皆待审批时，写入仍必须淘汰（不得变成"永不淘汰"）', () => {
  const store = emptyStore('sess-ac6-all-pending');
  const all = [];
  for (let i = 0; i < MAX_EXPERIENCES; i += 1) {
    all.push(entry(2000 + i, { state: 'PROPOSED', createdAt: 5000 + i }));
  }
  const full = { ...store, experiences: all };
  const oldest = [...all].sort(byCreatedThenId)[0];
  const r = propose(full, {
    title: 'over capacity when everything is pending', body: 'synthetic', sourceEventSeqs: [9006],
    originSessionId: 'sess-ac6-all-pending', createdAt: 600_000,
  });
  assert(r.ok === true, `propose 应成功，实际 ${r.error}`);
  assertEq(r.value.experiences.length, MAX_EXPERIENCES, '容量上限被突破（待审批保护不得导致无界增长）');
  assert(!r.value.experiences.some((e) => e.id === oldest.id), '全待审批时应退回"淘汰最旧"（否则库无法有界）');
});

check('A2 连续写入 60 次（全待审批库）后仍恒 ≤ MAX_EXPERIENCES', () => {
  const store = emptyStore('sess-ac6-loop');
  let s = store;
  for (let i = 0; i < MAX_EXPERIENCES; i += 1) {
    s = propose(s, {
      title: `loop fill ${i}`, body: `synthetic fill ${i}`, sourceEventSeqs: [3000 + i],
      originSessionId: 'sess-ac6-loop', createdAt: 7000 + i,
    }).value;
  }
  for (let k = 0; k < 60; k += 1) {
    const r = propose(s, {
      title: `loop push ${k}`, body: `synthetic push ${k}`, sourceEventSeqs: [4000 + k],
      originSessionId: 'sess-ac6-loop', createdAt: 800_000 + k,
    });
    assert(r.ok === true, `第 ${k} 次写入失败: ${r.error}`);
    s = r.value;
    assert(s.experiences.length <= MAX_EXPERIENCES, `第 ${k} 次写入后越界: ${s.experiences.length}`);
    assert(s.experiences.some((e) => e.id === r.experience.id), `第 ${k} 次写入的条目不在库中（R-6）`);
  }
});

check('A3 既有不变量未被削弱：R-6（H2.15 场景）仍淘汰"最旧一条"且恰好 1 条', () => {
  // 与 test-learn-r3-hardening.mjs H2.15 同场景（全 PROPOSED、createdAt 缺省）
  let s = emptyStore('sess-r6');
  for (let i = 0; i < MAX_EXPERIENCES; i += 1) {
    const r = propose(s, {
      title: `填充条目 ${i}`, body: `synthetic fill ${i}`, sourceEventSeqs: [5000 + i],
      originSessionId: 'sess-r6', createdAt: 1_700_000_000_000 + i,
    });
    assert(r.ok === true, `填充第 ${i} 条失败: ${r.error}`);
    s = r.value;
  }
  const beforeIds = new Set(s.experiences.map((e) => e.id));
  const r2 = propose(s, {
    title: 'createdAt 缺失的新提案', body: 'synthetic', sourceEventSeqs: [6000],
    originSessionId: 'sess-r6', createdAt: undefined,
  });
  assert(r2.ok === true, `新提案失败: ${r2.error}`);
  assertEq(r2.value.experiences.length, MAX_EXPERIENCES, '容量上限应保持');
  assert(r2.value.experiences.some((e) => e.id === r2.experience.id), 'R-6：新提案不在库中');
  const evicted = [...beforeIds].filter((id) => !r2.value.experiences.some((e) => e.id === id));
  assertEq(evicted.length, 1, `应恰好淘汰 1 条，实际 ${evicted.length}`);
  const evictedExp = s.experiences.find((e) => e.id === evicted[0]);
  const minCreated = Math.min(...s.experiences.map((e) => e.createdAt));
  assertEq(evictedExp.createdAt, minCreated, '被淘汰的应是最旧（createdAt 最小）的一条');
});

console.log(`\n${'='.repeat(60)}`);
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
if (fail > 0) {
  console.log('失败清单：');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exitCode = 1;
}
