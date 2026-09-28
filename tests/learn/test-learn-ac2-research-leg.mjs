// test-learn-ac2-research-leg.mjs —— P4 FINAL CLOSURE R3 · **AC2 自主研究腿**专项回归门
//
// ── 本套件锁死的**唯一**命题（合同 AC2 / AC8）────────────────────────────────
//   AC2：「**无经验覆盖**的低风险陌生任务 ⇒ 自主研究，而不是第一时间失败」；
//        研究必须有**可执行计划**（不是一句"应该研究"），且高风险的**动作**仍走人工门。
//   AC8：研究**有界**（禁无限重试 / 禁刷）、跑在**隔离测试腿**、**不新增常驻 daemon**，
//        并且**复用**既有唯一来源（候选面的 MAX_RESEARCH_ATTEMPTS / 阶梯 / 风险分级 / 委托去处），
//        绝不新建第二套研究机制（合同【复用规则】）。
//
// ── 关键教训（A10 药丸 2 的缺陷，本套件存在的直接理由）──────────────────────
//   上一次"实现"AC2 的写法是：**字面常量存在、真实执行点缺失**——
//   `RESEARCH_BOUNDED_EXHAUSTED` 等字面量在源码里查得到，但 openResearchLeg 从未被赋值调用
//   （`researchPlan(gap)` 只出现在字面量断言里，真实路径上**无人调用**）⇒ 静态断言全绿，
//   生产行为等于零。所以本套件**一律走 api.invokeTool(...) 的真实 execute**
//   （= 宿主注册的同一批函数对象），并且**每个正向断言都配一个负控**，
//   确保测试不会在"功能被摘掉"的情况下继续变绿（防真空）。
//
// ── 覆盖的两个真实触发点（都是事实，不是启发式猜测）────────────────────────
//   ① 任务级：`learn_recall` **无命中**（= 无经验覆盖）⇒ 打开研究腿并返回可执行指令；
//   ② 缺口级：合格能力缺口 → 候选时**真实调用** `researchPlan(gap)` —— 由静态接线锁锁定
//      （0.5/0.6/D2 组：函数名真实出现在调用位，且无定时器/无子进程/无第二套引擎）。
//
// 运行：node tests/learn/test-learn-ac2-research-leg.mjs
// 纪律：一切 stateDir / globalStorePath 指向 os.tmpdir()，绝不触碰生产 ~/.dsh。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { mkCtx, mkExec } from './_real-session-harness.mjs';
import { emptyStore, makeExperience } from '../../plugins/learn-core.mjs';
import {
  MAX_RESEARCH_ATTEMPTS, researchPlan, classifyResearchRisk, STAGE_DELEGATION,
  candidateIdOf, chooseCandidateKind, CANDIDATE_KINDS,
} from '../../plugins/learn-candidate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 默认打真实插件；`AC2_LEARN_MJS` 可指向一份**变异副本**，用于证明本套门不是空转
// （突变验证：把能力摘掉后本套件必须变红，否则"全绿"毫无意义）。
const PLUGIN_SRC = process.env.AC2_LEARN_MJS
  ? path.resolve(process.env.AC2_LEARN_MJS)
  : join(HERE, '..', '..', 'plugins', 'learn.mjs');
const PLUGIN_URL = pathToFileURL(PLUGIN_SRC).href;
const LEARN_SRC = fs.readFileSync(PLUGIN_SRC, 'utf8');

// ★静态锁必须打在**代码**上，绝不能打在注释上。
//   这是本套件自己的突变验证（M1）抓出来的真缺陷：源码注释里恰好写了 `researchPlan(gap)`
//   这句说明文字，于是"真实调用点被删除"后锁**依旧全绿** —— 与 A10 药丸 2 完全同一形态。
//   所以这里先剥掉注释再做断言：注释不再是"证据"，只有代码算数。
const LEARN_CODE = LEARN_SRC
  .replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, ' '))  // 块注释 → 空白（保留换行，行号不变）
  .replace(/\/\/[^\n]*/g, '');                                    // 行注释 → 删除

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
// 宿主输出契约校验器（忠实复刻 dsh-tools/lib/index.js；与 B2 套件同口径）
//   宿主出口处两道判定：L2468 lossless JSON + L454/L457/L465-466/L494-508 字段类型。
//   本套件复用它的理由与 B2 相同：真实用户路径经宿主校验，测试若只用
//   `assert.equal(res.ok,true)` 就看不见"这个对象宿主根本收不到"。
// ═══════════════════════════════════════════════════════════════════════════
function isJsonValue(v) {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(v);
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') return false;
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x));
  if (t === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.keys(v).every((k) => isJsonValue(v[k]));
  }
  return false;
}
function validateToolOutput(schema, value, label = 'value') {
  const out = isJsonValue(value) ? [] : ['value is not lossless JSON'];
  if (out.length > 0) return out;
  const walk = (node, v, p) => {
    if (!node || typeof node !== 'object' || v === null || typeof v !== 'object') return;
    const props = node.properties ?? {};
    for (const [k, child] of Object.entries(props)) {
      if (!Object.hasOwn(v, k) || v[k] === undefined) continue;
      const p2 = `${p}.${k}`;
      const t = child?.type;
      const val = v[k];
      if (t === 'string' && typeof val !== 'string') out.push(`"${p2}" must be a string`);
      if (t === 'number' && typeof val !== 'number') out.push(`"${p2}" must be a number`);
      if (t === 'integer' && !Number.isInteger(val)) out.push(`"${p2}" must be an integer`);
      if (t === 'boolean' && typeof val !== 'boolean') out.push(`"${p2}" must be a boolean`);
      if (t === 'array' && !Array.isArray(val)) out.push(`"${p2}" must be an array`);
      if (t === 'object' && (val === null || typeof val !== 'object' || Array.isArray(val))) out.push(`"${p2}" must be an object`);
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) walk(child, val, p2);
    }
    if (node.additionalProperties === false) {
      for (const k of Object.keys(v)) {
        if (!Object.hasOwn(props, k)) out.push(`"${p}.${k}" is not a declared property (additionalProperties: false)`);
      }
    }
  };
  walk(schema, value, label);
  return out;
}

// ── 每个场景一个全新模块实例（cache-busting）：per-session 结构是模块级状态 ──
let gen = 0;
async function newInstance(tag, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ac2-${tag}-`));
  const gpath = path.join(dir, '_global-verified.json');
  const host = mkCtx({});
  const mod = await import(`${PLUGIN_URL}?ac2=${++gen}`);
  const api = mod.apply(host.ctx, {
    stateDir: dir,
    globalStorePath: gpath,
    autoPropose: false,          // 本套件只测研究腿：不让自动候选干扰计数
    minTurnsForLearning: 4,
    minNewNodes: 4,
    maxDigestTurns: 40,
    ...opts,
  });
  return { api, hooks: host.hooks, dir, gpath };
}

const recall = (api, sid, args) => api.invokeTool('learn_recall', args, mkExec(sid));
const status = (api, sid) => api.invokeTool('learn_status', {}, mkExec(sid));
const verify = (api, sid, args) => api.invokeTool('learn_verify', args, mkExec(sid));

/** 造一条带 `file_hash` 机器可验证证据的经验（哈希由本测试对**真实文件**独立复算）。 */
function mkFileHashExperience({ title, seqs, createdAt, target, digest }) {
  const made = makeExperience({
    title, body: `${title}（仅用于 AC2 研究腿闭环验证；证据指向本次测试创建的真实文件）`,
    tags: ['p4', 'ac2'],
    sourceEventSeqs: seqs,
    originSessionId: 'ac2-session',
    createdAt,
  });
  assert.equal(made.ok, true, 'makeExperience 失败：' + made.error);
  const exp = made.value;
  exp.verificationEvidence = { class: 'file_hash', path: target, sha256: digest, note: 'ac2 fixture' };
  return exp;
}

/** 造一条**可召回**的经验（state=VERIFIED_EXPERIENCE ⇒ isRecallable 为真，无需审批台账）。 */
function mkRecallableExperience({ title, seqs, createdAt }) {
  const made = makeExperience({
    title, body: `${title} —— 用于负控：有经验覆盖时**绝不**打开研究腿。`,
    tags: ['p4', 'ac2', 'coverage'],
    sourceEventSeqs: seqs,
    originSessionId: 'ac2-session',
    createdAt,
  });
  assert.equal(made.ok, true, 'makeExperience 失败：' + made.error);
  const exp = made.value;
  exp.state = 'VERIFIED_EXPERIENCE';   // 机器验证过的经验在本会话内可召回（Layer A 口径）
  return exp;
}

console.log('=== P4 FINAL CLOSURE R3 · AC2 自主研究腿 专项回归门 ===');
console.log('  插件 = ' + PLUGIN_URL);
console.log('  候选面唯一权威：MAX_RESEARCH_ATTEMPTS = ' + MAX_RESEARCH_ATTEMPTS);
console.log('');

// ── 夹具：真实文件 + 真实 sha256（闭环验证用）───────────────────────────────
const fixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-evidence-'));
const targetFile = path.join(fixDir, 'ac2-evidence-target.txt');
fs.writeFileSync(targetFile, 'P4 FINAL CLOSURE R3 AC2 evidence file\n', 'utf8');
const realDigest = createHash('sha256').update(fs.readFileSync(targetFile)).digest('hex');
console.log(`  证据文件 = ${targetFile}  sha256=${realDigest.slice(0, 16)}…`);
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// 0 组：校验器自检 + 静态接线锁（先证明"工具本身有牙齿"，否则后面全绿无意义）
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- 0 组：校验器自检 + 接线锁（不空转）---');
check('0.1 复刻版能抓到类型不符（"value.a" must be a string）', () => {
  const v = validateToolOutput({ type: 'object', properties: { a: { type: 'string' } } }, { a: 1 });
  assert.equal(v.length, 1, JSON.stringify(v));
});
check('0.2 复刻版能抓到 undefined 值键 ⇒ value is not lossless JSON', () => {
  const v = validateToolOutput({ type: 'object', properties: { a: { type: 'string' } } }, { a: 'x', b: undefined });
  assert.ok(v.some((x) => x === 'value is not lossless JSON'), JSON.stringify(v));
});
check('0.3 复刻版能抓到未声明字段（additionalProperties:false）', () => {
  const v = validateToolOutput({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }, { a: 'x', zz: 1 });
  assert.ok(v.some((x) => /zz.*not a declared property/.test(x)), JSON.stringify(v));
});
check('0.4 风险分级：普通陌生任务 = LOW（AC2 授权的正是这一类）', () => {
  const r = classifyResearchRisk('按 RTK Query 官方文档核对 useQuery 的缓存失效时机');
  assert.equal(r.riskClass, 'LOW', JSON.stringify(r));
});
check('0.5 风险分级：破坏性/凭据类文本 = HIGH（保守方向，宁可误判为高）', () => {
  const a = classifyResearchRisk('在生产环境执行 DROP TABLE users 完成迁移');
  const b = classifyResearchRisk('读取 credentials 里的 api key 并重启 Windows Service');
  assert.equal(a.riskClass, 'HIGH', JSON.stringify(a));
  assert.equal(b.riskClass, 'HIGH', JSON.stringify(b));
});
check('0.6 风险分级：非字符串输入不抛异常，且保守判为 LOW 之外的确定值', () => {
  const r = classifyResearchRisk(undefined);
  assert.equal(typeof r.riskClass, 'string');
  assert.equal(r.riskClass, 'LOW');
});
check('0.7 ★接线锁（A10 药丸 2 的真因）：learn.mjs 里 researchPlan **真的被调用且结果被用上**', () => {
  // 锁打在**剥掉注释后的代码**上（LEARN_CODE）：注释里出现这个字面量不算证据。
  //   —— 这个坑是本套件自己的突变验证抓出来的：真调用点被删除后，源码里那句说明性注释
  //      仍然让 /researchPlan\(gap\)/ 匹配成功，锁依旧全绿（= 假锁）。现在注释不再是证据。
  const callSites = LEARN_CODE.match(/researchPlan\(gap\)/g) || [];
  assert.ok(callSites.length >= 1, 'learn.mjs 代码里未在真实路径上调用 researchPlan(gap)（只有常量/注释不算）');
  // 双齿：不仅"被调用"，返回值还必须被**接住并使用**（防"调了但结果被丢掉"的假接线）。
  assert.match(LEARN_CODE, /const\s+planRes\s*=\s*researchPlan\(gap\)/, 'researchPlan 的返回值未被接住');
  assert.match(LEARN_CODE, /planRes\.ok/, '接住的返回值未被使用（假接线）');
  assert.match(LEARN_CODE, /researchPlans\.push\(/, '研究计划未被并入上报账本');
  assert.equal(typeof researchPlan, 'function');
  const qualifiedGap = {
    qualified: true, dedupKey: 'ac2-static-lock', taskType: 'RESEARCH',
    normalizedSignature: 'sig', classification: 'CAPABILITY_GAP', count: 3,
  };
  const p = researchPlan(qualifiedGap);
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.plan.daemon, false);
  assert.equal(p.plan.maxAttempts, MAX_RESEARCH_ATTEMPTS);
});
check('0.8 ★AC8 接线锁：learn.mjs 无定时器 / 无子进程 / 无第二套研究引擎', () => {
  for (const bad of ['setInterval', 'setTimeout', 'child_process', 'spawn(', 'setImmediate']) {
    assert.ok(!LEARN_CODE.includes(bad), `learn.mjs 代码里出现 ${bad}（AC8 禁止常驻/后台机制）`);
  }
  // 有界权威**只**来自候选面：learn.mjs 不得自留一份字面上限
  assert.ok(!/MAX_RESEARCH_ATTEMPTS\s*=\s*\d/.test(LEARN_CODE), 'learn.mjs 私自定义研究次数上限（违反复用规则）');
  assert.match(LEARN_CODE, /maxAttempts:\s*MAX_RESEARCH_ATTEMPTS/, '研究腿上限未引用候选面唯一权威');
  assert.equal(MAX_RESEARCH_ATTEMPTS, 3, '候选面上限发生变化，本套件需重新评估');
});

// ═══════════════════════════════════════════════════════════════════════════
// A 组：任务级触发点（learn_recall 无命中 ⇒ 无经验覆盖 ⇒ 自主研究指令）
// ═══════════════════════════════════════════════════════════════════════════
console.log('');
console.log('--- A 组：无经验覆盖 ⇒ 可执行研究指令（真实 execute 路径）---');

const SID_A = 'ac2-task-leg-session';
const A = await newInstance('task-leg');
const Q_LOW = 'P4AC2 陌生任务 alpha：核对某框架的官方推荐做法';

let a1 = null;
await acheck('A1 无经验覆盖 ⇒ ok:true + items 空 + researchDirective.state=OPEN（AC2 主场景）', async () => {
  a1 = await recall(A.api, SID_A, { query: Q_LOW });
  assert.equal(a1.ok, true, JSON.stringify(a1));
  assert.deepEqual(a1.items, [], '无覆盖场景下不应召回任何经验');
  const d = a1.researchDirective;
  assert.ok(d, '缺少 researchDirective：AC2 在真实路径上等于零');
  assert.equal(d.state, 'OPEN');
  assert.equal(d.trigger, 'task_no_experience_coverage');
  assert.equal(d.riskClass, 'LOW');
  assert.equal(d.autonomy, 'autonomous_research_apply_low_risk');
  assert.equal(d.noExperienceCoverage, true);
  assert.equal(d.bounded, true);
  assert.equal(d.maxAttempts, MAX_RESEARCH_ATTEMPTS);
  assert.equal(d.attemptsUsed, 1);
  assert.equal(d.remaining, MAX_RESEARCH_ATTEMPTS - 1);
  assert.equal(d.daemon, false, 'AC8：研究腿不得引入常驻进程');
  assert.equal(d.delegatesTo, STAGE_DELEGATION.ISOLATED_TESTS.system, 'AC8：必须委托到隔离测试腿（既有系统）');
  assert.ok(Array.isArray(d.steps) && d.steps.length >= 4, '指令必须是可执行步骤，不是一句话');
  assert.match(d.verificationRequirement, /file_hash|system_api|session_outcome/);
  assert.match(d.closure, /RESEARCH_FULFILLED/);
  // legId 必须是**确定性派生**（同一 subject 永远同一腿；可审计、不随机、不随时间漂移）——
  // 判据 = 与候选面同一派生函数 candidateIdOf 的结果逐字相等（不允许另起一套 id 生成）。
  assert.equal(d.legId, 'leg_' + String(candidateIdOf(Q_LOW)).replace(/^cand_/, ''),
    'legId 未复用候选面的确定性 id 派生（candidateIdOf）');
  assert.match(d.legId, /^leg_[0-9a-f]{8,64}$/);
});

await acheck('A2 该返回值能通过宿主输出契约校验（lossless + 声明字段）', async () => {
  const spec = A.api.toolSpecs.learn_recall;
  const v = validateToolOutput(spec.output.schema, a1, 'value');
  assert.deepEqual(v, [], JSON.stringify(v));
  // 静态锁：schema **必须**声明 researchDirective，否则 additionalProperties:false 会整条拒绝
  assert.ok(Object.hasOwn(spec.output.schema.properties, 'researchDirective'),
    'learn_recall output schema 未声明 researchDirective ⇒ 生产路径整条被宿主拒绝');
});

await acheck('A3 同一陌生任务重复触发 ⇒ 同一 legId 续用 + 尝试计数递增（不是新开一条腿）', async () => {
  const again = await recall(A.api, SID_A, { query: Q_LOW });
  assert.equal(again.researchDirective.legId, a1.researchDirective.legId, '同一 subject 必须复用同一条腿');
  assert.equal(again.researchDirective.attemptsUsed, 2);
  assert.equal(again.researchDirective.remaining, MAX_RESEARCH_ATTEMPTS - 2);
  const st = await status(A.api, SID_A);
  assert.equal(st.summary.researchLegs.length, 1, '不应产生第二条腿');
  assert.equal(st.summary.researchLegs[0].attemptsUsed, 2);
  assert.equal(st.summary.researchLegs[0].source, 'task_no_experience_coverage');
  // 阶梯必须**复用**候选面的唯一阶梯实现（合同 §七）：取值来自 CANDIDATE_KINDS，
  // 且与同一入参下 chooseCandidateKind 的结果逐字相等 —— 锁死"没有第二套阶梯逻辑"。
  assert.ok(CANDIDATE_KINDS.includes(st.summary.researchLegs[0].candidateKind),
    'candidateKind 不是候选面阶梯的合法取值：' + st.summary.researchLegs[0].candidateKind);
  assert.equal(st.summary.researchLegs[0].candidateKind,
    chooseCandidateKind({}).kind,
    '研究腿的阶梯未复用候选面唯一的 chooseCandidateKind');
  // ★ P0-2 回归锁（对抗式评审 round 1，2026-09-29）：研究腿的主体只是一条召回未命中的查询文本，
  // 不是 `qualifyGap` 的合格缺口 ⇒ **没有**阶梯依据，不能宣称走过阶梯判断，更不能声称"不存在既有 skill"。
  // 锁两处：① 腿的 reason 必须是"无依据 ⇒ 保守"这一分支；② 指令里必须把它带给调用方（不能藏起来）。
  assert.equal(st.summary.researchLegs[0].candidateKindReason,
    'no_qualification_basis_conservative_new_skill',
    '研究腿谎称走过阶梯判断：' + st.summary.researchLegs[0].candidateKindReason);
  assert.equal(a1.researchDirective.candidateKindReason,
    'no_qualification_basis_conservative_new_skill',
    '研究指令未把阶梯依据如实交给调用方');
});

await acheck('A4 高风险文本 ⇒ 仍可研究，但 autonomy 收紧为人工门（AC2 只授权低风险自主）', async () => {
  const res = await recall(A.api, SID_A, { query: 'AC2HIGH 陌生任务：在生产环境执行 drop table 迁移' });
  const d = res.researchDirective;
  assert.ok(d, '高风险场景同样应给出研究指令（不是直接失败）');
  assert.equal(d.riskClass, 'HIGH');
  assert.equal(d.autonomy, 'research_only_actions_human_gated');
  assert.notEqual(d.legId, a1.researchDirective.legId, '不同 subject 必须是不同腿');
  assert.equal(d.state, 'OPEN');
});

await acheck('A5 learn_status 暴露研究腿账本 + 有界事实（可审计 + 防刷）', async () => {
  const st = await status(A.api, SID_A);
  const b = st.summary.researchBounded;
  assert.equal(b.maxAttemptsPerLeg, MAX_RESEARCH_ATTEMPTS);
  assert.equal(b.daemon, false, 'AC8：无常驻 daemon');
  assert.equal(b.persistence, 'in_memory_only', 'AC8：纯内存、随会话淘汰，不新增持久进程/服务');
  assert.ok(Number.isInteger(b.maxLegsPerSession) && b.maxLegsPerSession > 0, '必须有会话级防刷上限');
  // ★ P0-5：有界的**真实语义**必须一并暴露，不能只给一个数字让人以为它约束的是"研究动作次数"。
  assert.equal(b.boundSemantics, 'per_session_leg_opens_not_research_actions',
    '有界语义未声明：上限约束的是"打开腿的次数"而非研究动作次数');
  assert.equal(b.boundConsumedBy, 'recall_miss', '未声明计数由什么消耗（召回未命中）');
  assert.equal(st.summary.researchLegs.length, 2);
  for (const l of st.summary.researchLegs) {
    assert.equal(l.fulfilledAt, null, '未闭环的腿 fulfilledAt 必须为 null');
    assert.equal(l.maxAttempts, MAX_RESEARCH_ATTEMPTS);
    assert.equal(typeof l.riskClass, 'string');
  }
});

await acheck('A6 无经验覆盖的召回**不改经验库**：不自动提案、不自动审批、全局库仍空', async () => {
  const st = await status(A.api, SID_A);
  assert.deepEqual(st.experiences, [], '研究腿绝不自动写入经验库');
  assert.ok(!st.global || (Array.isArray(st.global.experiences) ? st.global.experiences.length === 0 : true),
    '研究腿绝不自动发表全局经验');
  const counts = st.summary.counts ?? {};
  assert.equal(counts.RESEARCH_REQUESTED >= 2, true,
    '每次开腿都要有 RESEARCH_REQUESTED 留痕（可审计）');
});

// ── 负控：**有**经验覆盖 ⇒ 不得产生 researchDirective（防滥用/防噪声）─────────
console.log('');
console.log('--- A 组负控：有经验覆盖 ⇒ 绝不打开研究腿 ---');

const SID_NEG = 'ac2-coverage-session';
const NEG = await newInstance('coverage');
const RARE = 'zetaquux7';
await acheck('A7 负控：有经验覆盖（可召回命中）⇒ **不存在** researchDirective 键、腿数 0', async () => {
  const st0 = emptyStore(SID_NEG);
  st0.experiences.push(mkRecallableExperience({
    title: `AC2 负控：${RARE} 的标准做法已经验证过`,
    seqs: [701, 703], createdAt: 1_760_000_000_000,
  }));
  NEG.api._setStoreForTest(SID_NEG, st0);

  const res = await recall(NEG.api, SID_NEG, { query: `按 ${RARE} 的已验证做法执行` });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.items.length, 1, '负控前提：必须真的命中了经验（否则测试空转）');
  assert.equal(Object.hasOwn(res, 'researchDirective'), false,
    '有覆盖时不得给出研究指令（键必须完全省略，不能是 null 占位）');
  const st = await status(NEG.api, SID_NEG);
  assert.equal(st.summary.researchLegs.length, 0, '有覆盖时不得打开任何研究腿');
  assert.deepEqual(validateToolOutput(NEG.api.toolSpecs.learn_recall.output.schema, res, 'value'), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// B 组：AC8 有界（禁无限重试 + 会话级防刷）
// ═══════════════════════════════════════════════════════════════════════════
console.log('');
console.log('--- B 组：有界（禁无限重试 / 会话级防刷）---');

const SID_B = 'ac2-bounded-session';
const B = await newInstance('bounded');
const Q_B = 'P4AC2 有界测试 beta：一个始终无人研究出结论的陌生任务';

const bSeq = [];
await acheck(`B1 同一 subject 连续触发 ${MAX_RESEARCH_ATTEMPTS} 次 ⇒ 第 ${MAX_RESEARCH_ATTEMPTS} 次即 EXHAUSTED`, async () => {
  for (let i = 1; i <= MAX_RESEARCH_ATTEMPTS; i++) {
    const res = await recall(B.api, SID_B, { query: Q_B });
    bSeq.push(res.researchDirective);
  }
  assert.equal(bSeq[0].state, 'OPEN');
  assert.equal(bSeq[1].state, 'OPEN');
  const last = bSeq[MAX_RESEARCH_ATTEMPTS - 1];
  assert.equal(last.state, 'EXHAUSTED', '达上限必须显式 EXHAUSTED');
  assert.equal(last.attemptsUsed, MAX_RESEARCH_ATTEMPTS);
  assert.equal(last.remaining, 0);
  assert.equal(last.bounded, true);
});

await acheck('B2 达上限后继续触发 ⇒ 明确拒绝 + 不再增长（AC8 禁无限重试）', async () => {
  const before = (await status(B.api, SID_B)).summary;
  const res = await recall(B.api, SID_B, { query: Q_B });
  const d = res.researchDirective;
  assert.equal(d.state, 'EXHAUSTED');
  assert.equal(d.error, 'research_bounded_exhausted', '必须给出结构化的停止原因');
  assert.equal(d.attemptsUsed, MAX_RESEARCH_ATTEMPTS, '不得越过上限累计');
  assert.match(d.note, /停止|上限/);
  // 连打 3 次：腿数 / 计数 / 遥测都不得继续增长（这条就是"禁无限重试"的机器判据）
  for (let i = 0; i < 3; i++) await recall(B.api, SID_B, { query: Q_B });
  const after = (await status(B.api, SID_B)).summary;
  assert.equal(after.researchLegs.length, before.researchLegs.length, '不得再新开腿');
  assert.equal(after.researchLegs[0].attemptsUsed, MAX_RESEARCH_ATTEMPTS, 'attemptsUsed 必须冻结在上限');
  assert.equal(after.researchLegs[0].exhausted, true);
  const evDelta = (after.counts.RESEARCH_BOUNDED_EXHAUSTED ?? 0) - (before.counts.RESEARCH_BOUNDED_EXHAUSTED ?? 0);
  assert.ok(evDelta >= 1, '达上限必须留痕 RESEARCH_BOUNDED_EXHAUSTED（可审计）');
  // 上限之后**不得**再产生新的"可执行研究指令"（只能给停止说明）
  assert.equal(Object.hasOwn(d, 'steps'), false, 'EXHAUSTED 指令不得再给出研究步骤');
  assert.equal(Object.hasOwn(d, 'autonomy'), false);
});

const SID_CAP = 'ac2-capacity-session';
const CAP = await newInstance('capacity');
await acheck('B3 会话级防刷：第 (maxLegsPerSession+1) 个不同任务被拒绝，腿数恰好等于上限', async () => {
  const st0 = await status(CAP.api, SID_CAP);
  const cap = st0.summary.researchBounded.maxLegsPerSession;
  assert.ok(Number.isInteger(cap) && cap > 0 && cap <= 128, '上限值需是合理整数：' + cap);
  for (let i = 1; i <= cap; i++) {
    const r = await recall(CAP.api, SID_CAP, { query: `P4AC2 容量测试 subject #${i}` });
    assert.equal(r.researchDirective.state, 'OPEN', `第 ${i} 个任务应能开腿：` + JSON.stringify(r.researchDirective));
  }
  const full = await status(CAP.api, SID_CAP);
  assert.equal(full.summary.researchLegs.length, cap, '腿数必须恰好等于上限（防刷生效）');
  const over = await recall(CAP.api, SID_CAP, { query: `P4AC2 容量测试 subject #${cap + 1}` });
  // 与"同一条腿达尝试上限"是**两种不同的有界**，状态名必须可区分（可审计）：
  //   EXHAUSTED = 同一 subject 重试次数用尽；CAPACITY_EXHAUSTED = 会话腿数达上限（防刷）。
  assert.equal(over.researchDirective.state, 'CAPACITY_EXHAUSTED');
  assert.equal(over.researchDirective.error, 'research_leg_capacity_exhausted');
  assert.equal(over.researchDirective.bounded, true);
  assert.equal(over.researchDirective.daemon, false);
  assert.equal(over.researchDirective.maxLegsPerSession, cap,
    '会话级拒绝必须报出**是哪条上限**挡住的（可审计），此处应为会话腿数上限');
  assert.equal(Object.hasOwn(over.researchDirective, 'maxAttempts'), false,
    '会话级拒绝与"单腿重试上限"是两条不同的有界，不得混用字段（否则误导审计）');
  assert.equal(Object.hasOwn(over.researchDirective, 'steps'), false, '被拒绝时不得再给研究步骤');
  const after = await status(CAP.api, SID_CAP);
  assert.equal(after.summary.researchLegs.length, cap, '超限后不得再开腿');
  assert.ok((after.summary.counts.RESEARCH_BOUNDED_EXHAUSTED ?? 0) >= 1, '超限必须留痕');
});

await acheck('B4 留痕口径精确：RESEARCH_REQUESTED = 真实开腿数；拒绝只记 RESEARCH_BOUNDED_EXHAUSTED', async () => {
  const st = await status(CAP.api, SID_CAP);
  const cap = st.summary.researchBounded.maxLegsPerSession;
  const c = st.summary.counts;
  // 插件语义（learn.mjs L1757-1772 逐行读过，测试按**事实**锁）：
  //   · 腿**真的开成** ⇒ RESEARCH_REQUESTED（count = 该腿的 attemptsUsed）
  //   · 同一腿达上限 / 会话腿数超限 ⇒ 只记 RESEARCH_BOUNDED_EXHAUSTED（**不算** REQUESTED）
  assert.equal(c.RESEARCH_REQUESTED, cap, `RESEARCH_REQUESTED=${c.RESEARCH_REQUESTED}，应等于真实开腿数 ${cap}`);
  assert.equal(st.summary.researchLegs.length, cap, 'RREQUESTED 必须与真实腿数一致（不得虚计）');
  assert.equal(c.RESEARCH_BOUNDED_EXHAUSTED, 1 + st.summary.researchLegs.filter((l) => l.exhausted).length,
    '有界停止留痕数应 = 超限拒绝 1 次 + 各条已耗时满的腿');
  // 每次无覆盖请求都留 EXPERIENCE_LOOKUP_MISS（cap 次开腿 + 1 次超限拒绝）
  assert.equal(c.EXPERIENCE_LOOKUP_MISS, cap + 1, `EXPERIENCE_LOOKUP_MISS=${c.EXPERIENCE_LOOKUP_MISS}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// C 组：闭环（研究腿由**通过确定性验证**的经验关闭；时间序是硬约束）
// ═══════════════════════════════════════════════════════════════════════════
console.log('');
console.log('--- C 组：闭环（确定性验证 ⇒ RESEARCH_FULFILLED）---');

const SID_D = 'ac2-closure-session';
const D = await newInstance('closure');
const Q_D = 'P4AC2 闭环测试 gamma：需要产出一条经验来闭环的陌生任务';

let openedAt = 0;
await acheck('C1 前置：无覆盖召回打开研究腿（并记录 openedAt）', async () => {
  const res = await recall(D.api, SID_D, { query: Q_D });
  assert.equal(res.researchDirective.state, 'OPEN');
  const st = await status(D.api, SID_D);
  openedAt = st.summary.researchLegs[0].openedAt;
  assert.ok(Number.isSafeInteger(openedAt) && openedAt > 0, 'openedAt 必须是真实时间戳');
  assert.equal(st.summary.researchLegs[0].fulfilledAt, null);
});

const oldExp = mkFileHashExperience({
  title: 'AC2 闭环负控：早于研究腿创建的旧经验',
  seqs: [801, 803], createdAt: openedAt - 60_000, target: targetFile, digest: realDigest,
});
const newExp = mkFileHashExperience({
  title: 'AC2 闭环正例：研究腿之后产出的经验',
  seqs: [805, 807], createdAt: Date.now(), target: targetFile, digest: realDigest,
});

await acheck('C2 负控：更早创建的经验即使验证通过也**不**闭环（时间序硬约束）', async () => {
  assert.equal(oldExp.createdAt, openedAt - 60_000, '夹具时间戳未按预期保留，负控将失真');
  const st0 = emptyStore(SID_D);
  st0.experiences.push(oldExp);
  D.api._setStoreForTest(SID_D, st0);
  const r = await verify(D.api, SID_D, { experienceId: oldExp.id });
  assert.equal(r.ok, true, '夹具必须真的验证成功（否则负控空转）：' + JSON.stringify(r));
  const st = await status(D.api, SID_D);
  assert.equal(st.summary.researchLegs[0].fulfilledAt, null, '旧经验不得闭环研究腿');
  assert.equal(st.summary.researchLegs[0].fulfilledBy, null);
  assert.equal(st.summary.counts.RESEARCH_FULFILLED ?? 0, 0, '不得产生闭环遥测');
});

await acheck('C3 正例：晚于研究腿的经验通过确定性验证 ⇒ 闭环 + **如实标注为 time_only**（P0-3 修复）', async () => {
  assert.ok(newExp.createdAt >= openedAt, '夹具时间戳必须晚于 openedAt');
  const st0 = emptyStore(SID_D);
  st0.experiences.push(oldExp, newExp);
  D.api._setStoreForTest(SID_D, st0);
  const r = await verify(D.api, SID_D, { experienceId: newExp.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.verificationStatus ?? r.status ?? r.method, r.verificationStatus ?? r.status ?? r.method);
  const st = await status(D.api, SID_D);
  const leg = st.summary.researchLegs[0];
  assert.equal(leg.fulfilledBy, newExp.id, '闭环必须记录是哪条经验闭的（可审计）');
  assert.ok(Number.isSafeInteger(leg.fulfilledAt) && leg.fulfilledAt > 0, 'fulfilledAt 必须是真实时间戳');
  // ★ P0-3（2026-09-29）：本夹具的经验标题与研究腿主体**毫不相干**（这正是评审 P0-3 的场景）。
  //   旧实现会把它记成 RESEARCH_FULFILLED ⇒ 多报因果。现在必须如实降级为 time_only。
  assert.equal(leg.binding, 'time_only',
    'P0-3：主题无关的经验只能标为 time_only 绑定（不得冒充因果证据）');
  assert.equal(st.summary.counts.RESEARCH_FULFILLED ?? 0, 0,
    'P0-3：主体未绑定 ⇒ 不得记 RESEARCH_FULFILLED（旧实现此处多报）');
  assert.equal(st.summary.counts.RESEARCH_LEG_CLOSED_TIME_ONLY ?? 0, 1,
    'P0-3：必须如实留痕 RESEARCH_LEG_CLOSED_TIME_ONLY（相关而非因果）');
  // 闭环后新任务仍可正常开腿（闭环不破坏后续研究能力）
  const again = await recall(D.api, SID_D, { query: 'P4AC2 闭环后新任务 delta：另一个陌生任务' });
  assert.equal(again.researchDirective.state, 'OPEN');
});

// ── C4（P0-3 修复配套）：**主体绑定**的闭环必须真的可达，且与 time_only 可区分 ──────────
const SID_E = 'ac2-subject-binding-session';
const E = await newInstance('closure-subject');
const Q_E = 'P4AC2 gamma 主体绑定';

await acheck('C4-1 前置：新会话无覆盖召回 ⇒ 打开研究腿（主体词可覆盖）', async () => {
  const res = await recall(E.api, SID_E, { query: Q_E });
  assert.equal(res.researchDirective.state, 'OPEN');
  const st = await status(E.api, SID_E);
  assert.equal(st.summary.researchLegs.length, 1);
  assert.equal(st.summary.researchLegs[0].binding, null, '未闭环的腿 binding 必须为 null');
});

const boundExp = mkFileHashExperience({
  title: 'P4AC2 gamma 主体绑定：研究腿产出并完整覆盖该主体词的经验',
  seqs: [901, 903], createdAt: Date.now(), target: targetFile, digest: realDigest,
});

await acheck('C4-2 正例：经验文本**完整覆盖**腿主体词 ⇒ binding=subject + RESEARCH_FULFILLED', async () => {
  const st0 = emptyStore(SID_E);
  st0.experiences.push(boundExp);
  E.api._setStoreForTest(SID_E, st0);
  const r = await verify(E.api, SID_E, { experienceId: boundExp.id });
  assert.equal(r.ok, true, '夹具必须真的验证成功（否则本门空转）：' + JSON.stringify(r));
  const st = await status(E.api, SID_E);
  const leg = st.summary.researchLegs[0];
  assert.equal(leg.fulfilledBy, boundExp.id);
  assert.equal(leg.binding, 'subject', '主体词被完整覆盖 ⇒ 必须标为 subject 绑定');
  assert.equal(st.summary.counts.RESEARCH_FULFILLED ?? 0, 1,
    '主体绑定必须留痕 RESEARCH_FULFILLED（否则该分支不可达 = 假门）');
  assert.equal(st.summary.counts.RESEARCH_LEG_CLOSED_TIME_ONLY ?? 0, 0,
    '主体绑定不得同时记 time_only（两个事实必须互斥）');
});

// ═══════════════════════════════════════════════════════════════════════════
// D 组：指令必须是**纯数据**（可 JSON 序列化 + 无函数）+ 复用唯一来源
// ═══════════════════════════════════════════════════════════════════════════
console.log('');
console.log('--- D 组：纯数据 + 唯一来源复用 ---');

check('D1 researchDirective 是纯 JSON 数据（round-trip 相等，无函数/类实例）', () => {
  const d = a1.researchDirective;
  assert.equal(isJsonValue(d), true, '指令含非 JSON 值（宿主会整条拒绝）');
  assert.deepEqual(JSON.parse(JSON.stringify(d)), d, 'JSON round-trip 必须相等');
  const hasFn = (o) => (o && typeof o === 'object')
    ? Object.values(o).some((v) => typeof v === 'function' || hasFn(v)) : false;
  assert.equal(hasFn(d), false, '指令里不得夹带函数（否则无法经宿主传输）');
});
check('D2 有界不是自称：指令上限 === 候选面唯一权威 MAX_RESEARCH_ATTEMPTS', () => {
  assert.equal(a1.researchDirective.maxAttempts, MAX_RESEARCH_ATTEMPTS);
  assert.equal(B.api ? MAX_RESEARCH_ATTEMPTS : 0, 3);
});
check('D3 委托去处 = 既有隔离测试腿（AC8：绝不新建第二套 CI/研究系统）', () => {
  assert.equal(a1.researchDirective.delegatesTo, STAGE_DELEGATION.ISOLATED_TESTS.system);
  const iso = STAGE_DELEGATION.ISOLATED_TESTS;
  assert.equal(typeof iso.system, 'string');
  // 事实锁：隔离测试腿**就是**仓库既有四层 CI（不新建第二套 CI）——逐字核对委托块的原文。
  // 2026-09-29 AC10 修正（缺陷不再放回）：这里曾锁死 ci-level1.yml，而 L1 只做静态 YAML 检查、
  // **不运行任何隔离真实实例**；真正跑隔离面的是 ci-level3.yml（已装 dsh 包的那条航道，
  // 现在由 tests/learn/test-learn-ac6-real-promotion-e2e.mjs 真实执行：真 worktree@commit +
  // 隔离宿主挂载 3099 + 真事务 COMMITTED）。锁的对象因此改成**真实航道**，而不是当年写错的名字。
  assert.equal(iso.file, '.github/workflows/ci-level3.yml');
  assert.match(iso.entry, /ci-level1\.yml.*ci-level4\.yml/);
  assert.match(iso.note, /禁建第二套 CI/, '委托块必须显式声明"禁建第二套 CI"（AC8 复用纪律）');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('');
console.log('══════════════════════════════════════════');
console.log(`AC2 研究腿专项门：PASS=${pass}  FAIL=${fail}`);
if (fail > 0) { console.log('失败明细：'); for (const f of failures) console.log('  · ' + f); }
console.log('══════════════════════════════════════════');
process.exit(fail > 0 ? 1 : 0);
