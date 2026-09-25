// test-learn-ac5-e2e.mjs —— P4 LEARN R2 AC5 端到端验收（Fake Gap Guard 真的拦得住）
//
// 这个套件回答的唯一问题：
//   **守卫是否通过「真实插件路径」阻止了错误学习？**
//
// 与 test-learn-ac5-gap-veto.mjs 的分工：
//   - ac5-gap-veto.mjs  = 单元层（直接调守卫函数，证明判定正确）
//   - 本文件            = 端到端层（装载 plugins/learn.mjs 真实 apply()，触发真实钩子，
//                         证明「候选确实没被产出」而不是「函数返回了 true」）
//
// 为什么必须两层都有：单元层通过但端到端没接线，是本仓库已经踩过的坑
// （P2.6 自身实证过 "evidence-only plugin 装上了但没人消费"）。AC5 的价值全在
// 「错误学习被阻止」，所以必须有端到端证据。
//
// 关键对照（防止"把闸门焊死"这种假通过）：
//   A 组 有 P2.6 硬否决失败      → **不得**产出候选 + 必须记 GAP_VETOED
//   B 组 无任何分类失败（对照）  → **必须**产出候选（证明闸门不是一律拒绝）
//   C 组 失败对象缺失（fail-closed）→ 不得产出候选
//   D 组 同输入走 P2.6 权威       → 分类与 A 组一致（证明决策来自 Authority，不是本地逻辑）
//
// 运行：node tests/learn/test-learn-ac5-e2e.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { evaluateGapVeto } from '../../plugins/learn-gap-veto.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_URL = pathToFileURL(join(HERE, '..', '..', 'plugins', 'learn.mjs')).href;

let pass = 0; let fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; failures.push(name + ' :: ' + e.message); console.log('  FAIL  ' + name + ' — ' + e.message); }
}

// ── 假宿主：只实现 learn.mjs 实际用到的 ctx 面 ────────────────────────────────
function makeCtx() {
  const handlers = new Map();
  const logs = [];
  return {
    handlers,
    logs,
    ctx: {
      on(event, fn) {
        const arr = handlers.get(event) ?? [];
        arr.push(fn);
        handlers.set(event, arr);
        return () => {};
      },
      logger: {
        info: (m) => logs.push('info:' + m),
        warn: (m) => logs.push('warn:' + m),
      },
      // 不提供 tools 服务 ⇒ 走 fail-open 分支，工具面禁用，钩子照常（这正是 E2E 要测的面）
    },
  };
}

async function fire(handlers, event, payload) {
  const arr = handlers.get(event) ?? [];
  for (const h of arr) await h(payload, async () => undefined);
}

// ── 真实会话形状（events 走 P2.5 提取器可识别的形态）──────────────────────────
// ⚠ 关键：surface.nodes 里的 seq 必须落在 events 下标范围内，否则 buildLearnDigest
//   抽不到任何轮次 ⇒ 对照组也不学习 ⇒ "没产出候选"会变成假通过（本套件首轮就是这样
//   抓到这个陷阱的）。故 events 长度按 max(nodes)+1 生成。
const TURN_TEXTS = [
  ['user', 'deploy 时 502 bad gateway'],
  ['assistant', 'instead you should retry with backoff'],
  ['user', 'still failing after retry'],
  ['user', 'fixed now, it works now'],
  ['user', 'now the config value is wrong'],
  ['assistant', 'you should change the timeout setting'],
  ['user', 'the build is green again'],
  ['user', 'resolved, tests are passing'],
];

function makeSession(id, nodes) {
  const n = Math.max(...nodes) + 1;
  const events = [];
  for (let i = 0; i < n; i++) {
    const [role, text] = TURN_TEXTS[i % TURN_TEXTS.length];
    events.push(role === 'user'
      ? { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } }
      : { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } });
  }
  return { id, surface: { nodes: [...nodes] }, events };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-ac5-e2e-'));
const mod = await import(PLUGIN_URL);

console.log('=== 装载真实插件 plugins/learn.mjs ===');
console.log('  stateDir = ' + TMP);

const host = makeCtx();
const api = mod.apply(host.ctx, {
  stateDir: TMP,
  autoPropose: true,
  minTurnsForLearning: 4,
  minNewNodes: 4,
  maxDigestTurns: 40,
});

check('E0 插件暴露真实工具面（合同闭环 6 个）且钩子已注册', () => {
  // P4 R2 合同完成：合同【实现原则 3】要求"机器可复算的验证"存在可执行入口，
  // 故在 R1 的 5 个工具之上新增 learn_verify（确定性验证）。
  // 断言升级为**精确集合**（比仅比较个数更强）：个数相同但换了名字也必须失败。
  const want = ['learn_promote', 'learn_propose', 'learn_recall', 'learn_review', 'learn_status', 'learn_verify'];
  assert.equal(JSON.stringify([...api.toolNames].sort()), JSON.stringify(want),
    'toolNames = ' + JSON.stringify(api.toolNames));
  assert.ok(host.handlers.has('agent/pre-step'), 'agent/pre-step 未注册');
  assert.ok(host.handlers.has('agent/request-error'), 'agent/request-error 未注册（AC5 失败观测入口）');
});

// ── A 组：有 P2.6 硬否决失败 → 候选必须被拦 ─────────────────────────────────
console.log('');
console.log('=== A 组：硬否决失败必须阻止候选产出（AC5 核心）===');

const SID_A = 'session-ac5-veto';
const sessA1 = makeSession(SID_A, [0, 1, 2, 3]);
const sessA2 = makeSession(SID_A, [0, 1, 2, 3, 4, 5, 6, 7]);

await fire(host.handlers, 'agent/pre-step', { agent: { session: sessA1 } });   // 首次：只设水位
check('E1 首次进入只记录水位、不学习（基线）', () => {
  assert.equal(api.getStore(SID_A).experiences.length, 0, '首次进入不应产出候选');
});

// 真实失败：502（P2.6 硬否决类 NETWORK_TIMEOUT_5XX）
await fire(host.handlers, 'agent/request-error', {
  agent: { session: { id: SID_A } },
  provider: 'opencode',
  model: 'deepseek-v4.1-flash',
  failure: { status: 502, message: 'bad gateway' },
});

await fire(host.handlers, 'agent/pre-step', { agent: { session: sessA2 } });   // 第二次：有新鲜节点

check('E2 ★ 硬否决失败后**没有**产出任何候选（AC5 主断言）', () => {
  const store = api.getStore(SID_A);
  assert.equal(store.experiences.length, 0,
    '候选被错误产出！experiences = ' + JSON.stringify(store.experiences.map((e) => e.title)));
});

check('E3 ★ 必须记录 GAP_VETOED 遥测（可观测，不是静默丢弃）', () => {
  const store = api.getStore(SID_A);
  const vetoed = store.telemetry.filter((t) => t.kind === 'GAP_VETOED');
  assert.ok(vetoed.length >= 1, 'GAP_VETOED 遥测缺失；实际 kinds = ' + JSON.stringify(store.telemetry.map((t) => t.kind)));
  const d = vetoed[0].detail ?? '';
  assert.match(d, /auto-candidate suppressed/, 'detail = ' + d);
  // 关键：分类必须真的可观测（telemetryEvent 是字段白名单，自定义字段会被丢弃 ⇒ 折进 detail）
  assert.match(d, /classes=\[NETWORK_TIMEOUT_5XX\]/, 'detail 未含分类 = ' + d);
  assert.match(d, /vetoReasons=\[HARD_VETO_CLASS\]/, 'detail 未含否决原因 = ' + d);
});

check('E4 否决后**不得**出现 PROPOSED 遥测（证明真的没学）', () => {
  const store = api.getStore(SID_A);
  assert.equal(store.telemetry.filter((t) => t.kind === 'PROPOSED').length, 0,
    '出现了 PROPOSED，说明候选真的产出了');
});

// ── B 组：对照组，证明闸门不是"一律拒绝" ────────────────────────────────────
console.log('');
console.log('=== B 组：无分类失败时**必须**正常学习（防闸门焊死）===');

const SID_B = 'session-ac5-control';
const sessB1 = makeSession(SID_B, [0, 1, 2, 3]);
const sessB2 = makeSession(SID_B, [0, 1, 2, 3, 4, 5, 6, 7]);

await fire(host.handlers, 'agent/pre-step', { agent: { session: sessB1 } });
// 注意：**不**发送任何 agent/request-error
await fire(host.handlers, 'agent/pre-step', { agent: { session: sessB2 } });

check('E5 ★ 对照组：无 P2.6 失败证据时正常产出候选（闸门非焊死）', () => {
  const store = api.getStore(SID_B);
  assert.equal(store.experiences.length, 1,
    '对照组也没学到 ⇒ 闸门把一切焊死了，这是假通过。experiences = ' + store.experiences.length);
  assert.equal(store.experiences[0].state, 'PROPOSED', '候选状态必须是 PROPOSED（永不可召回）');
});

check('E6 对照组候选仍带真实出处（AC6 未被本次改动破坏）', () => {
  const e = api.getStore(SID_B).experiences[0];
  assert.ok(Array.isArray(e.sourceEventSeqs) && e.sourceEventSeqs.length > 0,
    'sourceEventSeqs 缺失：' + JSON.stringify(e.sourceEventSeqs));
  assert.equal(e.originSessionId, SID_B, 'originSessionId = ' + e.originSessionId);
});

check('E7 对照组不得出现 GAP_VETOED（否决必须只由真实失败触发）', () => {
  const store = api.getStore(SID_B);
  assert.equal(store.telemetry.filter((t) => t.kind === 'GAP_VETOED').length, 0,
    '无失败却记了 GAP_VETOED ⇒ 否决逻辑与真实证据脱钩');
});

// ── C 组：fail-closed（失败对象缺失）────────────────────────────────────────
console.log('');
console.log('=== C 组：失败对象缺失时 fail-closed ===');

const SID_C = 'session-ac5-failclosed';
const sessC1 = makeSession(SID_C, [0, 1, 2, 3]);
const sessC2 = makeSession(SID_C, [0, 1, 2, 3, 4, 5, 6, 7]);

await fire(host.handlers, 'agent/pre-step', { agent: { session: sessC1 } });
await fire(host.handlers, 'agent/request-error', {
  agent: { session: { id: SID_C } },
  provider: 'opencode', model: 'deepseek-v4.1-flash',
  failure: null,   // 无失败对象
});
await fire(host.handlers, 'agent/pre-step', { agent: { session: sessC2 } });

check('E8 ★ 失败对象缺失 → fail-closed 否决（宁可漏学不可误学）', () => {
  const store = api.getStore(SID_C);
  assert.equal(store.experiences.length, 0, '无分类证据却学了 ⇒ fail-closed 被破坏');
  const vetoed = store.telemetry.filter((t) => t.kind === 'GAP_VETOED');
  assert.ok(vetoed.length >= 1, 'GAP_VETOED 缺失');
  assert.match(vetoed[0].detail ?? '', /CONDITIONAL_VETO_NO_EVIDENCE/, 'detail = ' + vetoed[0].detail);
});

// ── D 组：决策确实来自 P2.6 Authority（不是本地第二套逻辑）──────────────────
console.log('');
console.log('=== D 组：决策来自 P2.6 Authority（非第二套分类逻辑）===');

check('E9 ★ 插件记录的分类 == P2.6 权威对同一 failure 的分类（单源一致）', () => {
  const store = api.getStore(SID_A);
  const d = store.telemetry.filter((t) => t.kind === 'GAP_VETOED')[0].detail ?? '';
  // 用**同一输入**直接问权威
  const authority = evaluateGapVeto({ status: 502, message: 'bad gateway' }, { provider: 'opencode', model: 'deepseek-v4.1-flash' });
  assert.ok(d.includes(`classes=[${authority.classification}]`),
    `插件记 "${d}"，权威给 ${authority.classification} ⇒ 存在第二套分类逻辑`);
  assert.ok(d.includes(`vetoReasons=[${authority.reason}]`),
    `插件记 "${d}"，权威给 ${authority.reason}`);
});

check('E12 telemetryEvent 字段白名单事实被锁（防再有人加字段被静默丢弃）', () => {
  const coreSrc = fs.readFileSync(join(HERE, '..', '..', 'plugins', 'learn-core.mjs'), 'utf8');
  const m = coreSrc.match(/export function telemetryEvent[\s\S]*?\n\}/);
  assert.ok(m, '未找到 telemetryEvent');
  // 白名单必须仍然存在（这是有意的安全设计：防任意字段灌进遥测）
  for (const f of ['experienceId', 'detail', 'count', 'reason']) {
    assert.ok(m[0].includes(f), `telemetryEvent 白名单缺 ${f}`);
  }
  // 而 learn.mjs 不得再依赖会被丢弃的自定义字段
  const learnSrc = fs.readFileSync(join(HERE, '..', '..', 'plugins', 'learn.mjs'), 'utf8');
  assert.equal(/tel\([^)]*GAP_VETOED[^)]*classifications\s*:/.test(learnSrc), false,
    'learn.mjs 仍向遥测传会被白名单丢弃的 classifications 字段');
});

check('E10 ★ learn-core 中不存在任何 failure 关键词（单一 Failure Authority 静态锁）', () => {
  const coreSrc = fs.readFileSync(join(HERE, '..', '..', 'plugins', 'learn-core.mjs'), 'utf8');
  // 只检查 SIGNAL_PATTERNS 声明块内是否残留 failure kind
  const m = coreSrc.match(/export const SIGNAL_PATTERNS\s*=\s*Object\.freeze\(\[[\s\S]*?\n\]\);/);
  assert.ok(m, '未找到 SIGNAL_PATTERNS 声明');
  assert.equal(/kind:\s*['"]failure['"]/.test(m[0]), false,
    'SIGNAL_PATTERNS 里仍有 failure kind ⇒ 第二 Failure Authority 被加回来了');
});

check('E11 learn.mjs 的失败观测与 P2.6 使用同一事件名', () => {
  const learnSrc = fs.readFileSync(join(HERE, '..', '..', 'plugins', 'learn.mjs'), 'utf8');
  assert.match(learnSrc, /ctx\.on\(\s*['"]agent\/request-error['"]/, 'learn.mjs 未监听 agent/request-error');
  const p26Src = fs.readFileSync(join(HERE, '..', '..', 'plugins', 'failure-classifier.mjs'), 'utf8');
  assert.match(p26Src, /ctx\.on\(\s*['"]agent\/request-error['"]/, 'P2.6 未监听 agent/request-error');
});

// ── 收尾 ────────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log('');
console.log('=== 汇总 ===');
console.log('  AC5 E2E: ' + pass + ' PASS / ' + fail + ' FAIL');
if (fail) {
  console.log('  失败项：');
  for (const f of failures) console.log('    - ' + f);
  console.log('  ⇒ AC5 END-TO-END GATE FAILED');
  process.exit(1);
}
console.log('  PASS AC5 end-to-end gate (wrong learning is actually blocked)');
process.exit(0);
