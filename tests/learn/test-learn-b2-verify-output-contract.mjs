// test-learn-b2-verify-output-contract.mjs —— P4 FINAL CLOSURE A2（B2）回归门
//
// ── 这个套件锁死的**唯一**命题 ──────────────────────────────────────────────
//   `learn_verify` 的**返回值本身**必须能通过宿主的输出契约校验，两条路径都不例外：
//     · 成功 ⇒ `ok:true` + 真方法名（string），且**不存在** `error` 键；
//     · 失败 ⇒ `ok:false` + `error`（string），且**不存在** `method` 键；
//   **绝不**用 null / undefined 占位，也**绝不**为了迎合 schema 伪造方法名。
//
// ── 为什么必须有这个门（生产实证，2026-09-27，均为真实宿主原话）────────────
//   旧写法在两条路径上各产出一个"非 JSON 值"，逐次让**整条工具结果被判非法**——
//   调用方连 ok 与真实原因都拿不到，而插件自身却以为"我返回了 ok:false"：
//     ① 成功路径 `error: res.ok ? undefined : …` ⇒ 返回值里存在值为 undefined 的键
//        ⇒ 宿主抛 `tool "learn_verify" returned invalid output: value is not lossless JSON`
//        （实证 exp-8a2fd284：确定性验证**实际已成功**，结果却被整条丢弃）
//     ② 失败路径 `method: res.method ?? null` ⇒ schema 已声明 method 为 string
//        ⇒ 宿主抛 `… returned invalid output: "value.method" must be a string`
//        （实证 exp-01ce61ab：ok:false 与失败原因完全丢失）
//
// ── 为什么既有套件集体漏掉它（本套件存在的核心理由）────────────────────────
//   仓库内所有 learn 测试一律经 `api.invokeTool(...)` 直接调用**真实 execute**，
//   这条路径**绕过宿主出口校验**：`assert.equal(res.ok, true/false)` 照样绿，
//   而"这个对象宿主根本收不到"完全隐身（真实用户路径 = dsh-tools 包装）。
//   故本套件把宿主校验器（dsh-tools/lib/index.js）的判定**忠实复刻**并对返回值施加，
//   同时**必须**用负控证明复刻版能抓到那两个旧形态 —— 否则测试就是空转。
//
// 对应宿主源码锚点（复刻依据，全部逐行读过）：
//   · L2468 `if (detached === void 0) throw new ToolOutputError(toolName, ["value is not lossless JSON"])`
//   · L457  `if (!Object.hasOwn(frame.value, key) || frame.value[key] === undefined) continue;`
//           ⇒ "schema 已声明但键缺省"是**合法**形态（跳过校验），而 null/undefined 是非法值
//   · L465-466 `additionalProperties === false` 只遍历**实际存在**的键
//   · L494-508 标量类型不符 ⇒ `"<path>" must be a <type>`
//
// 运行：node tests/learn/test-learn-b2-verify-output-contract.mjs
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
// 宿主输出契约校验器（忠实复刻 dsh-tools/lib/index.js；只复刻**读过源码**的判定）
// ═══════════════════════════════════════════════════════════════════════════

/** 宿主 `isJsonValue` 口径：undefined / 函数 / symbol / bigint / 非有限数 / 类实例 都非法。 */
function isJsonValue(v) {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(v);
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') return false;
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x));           // 稀疏/含 undefined ⇒ false
  if (t === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;      // 只接受 plain object
    return Object.keys(v).every((k) => isJsonValue(v[k]));               // **值为 undefined 的键 ⇒ false**
  }
  return false;
}

/** 宿主出口处的整体判定（L2468 原话）。 */
function losslessViolations(value) {
  return isJsonValue(value) ? [] : ['value is not lossless JSON'];
}

/**
 * 按工具自己声明的 output.schema 校验（复刻 L454/L457/L465-466/L494-508）。
 * 注意：**不**复刻 per-property `required: true`（宿主对该写法的执行语义未能从源码确证），
 * 故调用方另行显式断言 `ok` 存在——只断言"我确实读到过的规则"，不假装知道更多。
 */
function validateToolOutput(schema, value, label = 'value') {
  const out = losslessViolations(value);
  if (out.length > 0) return out;                                        // 宿主先判整体 lossless
  const walk = (node, v, p) => {
    if (!node || typeof node !== 'object' || v === null || typeof v !== 'object') return;
    const props = node.properties ?? {};
    for (const [k, child] of Object.entries(props)) {
      if (!Object.hasOwn(v, k) || v[k] === undefined) continue;          // ★ L457：缺省 ⇒ 跳过
      const p2 = `${p}.${k}`;
      const t = child?.type;
      const val = v[k];
      if (t === 'string' && typeof val !== 'string') out.push(`"${p2}" must be a string`);   // L495 原话
      if (t === 'number' && typeof val !== 'number') out.push(`"${p2}" must be a number`);
      if (t === 'integer' && !Number.isInteger(val)) out.push(`"${p2}" must be an integer`);
      if (t === 'boolean' && typeof val !== 'boolean') out.push(`"${p2}" must be a boolean`);
      if (t === 'array' && !Array.isArray(val)) out.push(`"${p2}" must be an array`);
      if (t === 'object' && (val === null || typeof val !== 'object' || Array.isArray(val))) out.push(`"${p2}" must be an object`);
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) walk(child, val, p2);
    }
    if (node.additionalProperties === false) {                           // L465-466：只看实际存在的键
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `b2-${tag}-`));
  const gpath = path.join(dir, '_global-verified.json');
  const host = mkCtx({});
  const mod = await import(`${PLUGIN_URL}?b2=${++gen}`);
  const api = mod.apply(host.ctx, {
    stateDir: dir,
    globalStorePath: gpath,
    autoPropose: false,
    minTurnsForLearning: 4,
    minNewNodes: 4,
    maxDigestTurns: 40,
    // 打开全局发表闸门，使 DENY 的原因**只能**来自"缺人工审批"（而不是配置关闸）
    allowGlobalPublish: true,
    ...opts,
  });
  return { api, hooks: host.hooks, dir, gpath };
}

/** 造一条带 `file_hash` 机器可验证证据的经验（哈希由本测试对**真实文件**独立复算）。 */
function mkFileHashExperience(target, digest) {
  const made = makeExperience({
    title: 'B2 契约测试：file_hash 机器可验证证据',
    body: '本条目仅用于验证 learn_verify 输出契约；证据指向本次测试创建的真实文件。',
    tags: ['p4', 'b2'],
    sourceEventSeqs: [101, 103],
    originSessionId: 'b2-session',
    createdAt: 1_760_000_000_000,
  });
  assert.equal(made.ok, true, 'makeExperience 失败：' + made.error);
  const exp = made.value;
  exp.verificationEvidence = { class: 'file_hash', path: target, sha256: digest, note: 'b2 fixture' };
  return exp;
}

/** 造一条**没有**机器可验证证据的经验（确定性验证必须拒绝，不得伪造 VERIFIED）。 */
function mkNoEvidenceExperience() {
  const made = makeExperience({
    title: 'B2 契约测试：无机器可验证证据',
    body: '本条目携带非机器可验证证据，确定性验证必须 ok:false，绝不 VERIFIED。',
    tags: ['p4', 'b2'],
    sourceEventSeqs: [201, 203],
    originSessionId: 'b2-session',
    createdAt: 1_760_000_000_001,
  });
  assert.equal(made.ok, true, 'makeExperience 失败：' + made.error);
  const exp = made.value;
  exp.verificationEvidence = null;
  return exp;
}

console.log('=== P4 FINAL CLOSURE A2（B2）：learn_verify 输出契约回归门 ===');
console.log('  插件 = ' + PLUGIN_URL);
console.log('');

// ── 夹具：真实文件 + 真实 sha256 ────────────────────────────────────────────
const fixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-evidence-'));
const targetFile = path.join(fixDir, 'evidence-target.txt');
fs.writeFileSync(targetFile, 'P4 FINAL CLOSURE B2 evidence file\n', 'utf8');
const realDigest = createHash('sha256').update(fs.readFileSync(targetFile)).digest('hex');
console.log(`  证据文件 = ${targetFile}  sha256=${realDigest.slice(0, 16)}…`);
console.log('');

const SID = 'b2-contract-session';

// ═══════════════════════════════════════════════════════════════════════════
// 0 组：先证明"校验器本身有牙齿"（否则后面全绿毫无意义）
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- 0 组：校验器自检（不空转）---');
check('0.1 复刻版能抓到类型不符（"a" must be a string）', () => {
  const v = validateToolOutput({ type: 'object', properties: { a: { type: 'string' } } }, { a: 1 });
  assert.equal(v.length, 1, JSON.stringify(v));
  assert.match(v[0], /"value\.a" must be a string/);
});
check('0.2 复刻版能抓到 undefined 值键 ⇒ value is not lossless JSON（宿主 L2468 原话）', () => {
  const v = validateToolOutput({ type: 'object', properties: { a: { type: 'string' } } }, { a: 'x', b: undefined });
  assert.ok(v.some((x) => x === 'value is not lossless JSON'), JSON.stringify(v));
});
check('0.3 复刻版**不**误杀"声明但缺省"的字段（宿主 L457，本修复的合法形态）', () => {
  const v = validateToolOutput({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' }, b: { type: 'string' } } }, { a: 'x' });
  assert.deepEqual(v, [], JSON.stringify(v));
});
check('0.4 复刻版能抓到未声明字段（additionalProperties:false）', () => {
  const v = validateToolOutput({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }, { a: 'x', z: 1 });
  assert.ok(v.some((x) => /is not a declared property/.test(x)), JSON.stringify(v));
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// A 组：成功路径 —— 真实 file_hash 验证 PASS，返回值必须能被宿主接受
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- A 组：成功路径（error 键必须不存在，method 必须是真方法名）---');
const A = await newInstance('pass');
const expPass = mkFileHashExperience(targetFile, realDigest);
const expFail = mkNoEvidenceExperience();
{
  const st = emptyStore(SID);
  st.experiences = [expPass, expFail];
  A.api._setStoreForTest(SID, st);
}
const schema = A.api.toolSpecs.learn_verify.output.schema;
assert.ok(schema && schema.properties && schema.properties.method, '未取到 learn_verify 的 output schema（前置不成立）');

let okRes = null;
await acheck('A1 成功路径：ok:true + method 为真实方法名 file_hash', async () => {
  okRes = await A.api.invokeTool('learn_verify', { experienceId: expPass.id }, mkExec(SID));
  assert.equal(okRes.ok, true, 'verify 未通过（error=' + (okRes.error ?? '-') + '）—— 本组前提不成立');
  assert.equal(okRes.method, 'file_hash', 'method=' + JSON.stringify(okRes.method));
  assert.equal(okRes.verificationStatus, 'VERIFIED', 'verificationStatus=' + okRes.verificationStatus);
  assert.equal(okRes.state, 'VERIFIED_EXPERIENCE', 'state=' + okRes.state);
});
await acheck('A2 成功路径：**不存在** error 键（旧写法 error:undefined ⇒ 整条结果被判非法）', async () => {
  // 注意：不能用 `assert.equal(okRes.error, undefined)`——那正是旧写法的形态。
  // 唯一正确的判据是"键是否存在"（宿主 L2468 对**值为 undefined 的键**判非 lossless JSON）。
  assert.equal(Object.hasOwn(okRes, 'error'), false, 'error 键存在，值=' + JSON.stringify(okRes.error));
});
check('A3 成功路径：返回值通过宿主契约校验（lossless JSON + 类型 + 未声明字段）', () => {
  const v = validateToolOutput(schema, okRes, 'value');
  assert.deepEqual(v, [], '宿主会拒绝：' + JSON.stringify(v));
});
check('A4 成功路径：ok 键存在且为 boolean（per-property required 由调用方显式断言）', () => {
  assert.equal(Object.hasOwn(okRes, 'ok'), true);
  assert.equal(typeof okRes.ok, 'boolean');
});
await acheck('A5 成功路径：无人工审批 ⇒ 发布必须 DENY（原因指向 not_human_approved）', async () => {
  assert.equal(typeof okRes.publication, 'string', 'publication=' + JSON.stringify(okRes.publication));
  assert.match(okRes.publication, /^denied:.*not_human_approved/, 'publication=' + okRes.publication);
  assert.equal(A.api.globalStore().experiences.length, 0, '未经人工审批不得进入跨会话全局库');
});
check('A6 成功路径：render 产出合法 JSON 文本（调用方读到的是结构化结果，不是 null）', () => {
  const rendered = A.api.toolSpecs.learn_verify.output.render(null, okRes);
  assert.equal(Array.isArray(rendered) && rendered[0].type, 'text');
  const parsed = JSON.parse(rendered[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.method, 'file_hash');
  assert.equal(Object.hasOwn(parsed, 'error'), false, '渲染文本里也不得出现 error 键');
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// B 组：失败路径 —— 无机器可验证证据 ⇒ ok:false，且**不伪造** method
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- B 组：失败路径（method 键必须不存在，error 必须是真原因）---');
let failRes = null;
await acheck('B1 失败路径：ok:false + error 为真原因（不冒充 VERIFIED）', async () => {
  failRes = await A.api.invokeTool('learn_verify', { experienceId: expFail.id }, mkExec(SID));
  assert.equal(failRes.ok, false, 'verify 竟通过了（ok=' + failRes.ok + '）');
  assert.equal(failRes.error, 'invalid_or_non_machine_checkable_evidence', 'error=' + JSON.stringify(failRes.error));
  assert.equal(failRes.verificationStatus, 'UNVERIFIED', 'verificationStatus=' + failRes.verificationStatus);
  assert.equal(failRes.publication, 'not_applicable', 'publication=' + failRes.publication);
});
await acheck('B2 失败路径：**不存在** method 键（旧写法 method:null ⇒ 整条结果被判非法）', async () => {
  assert.equal(Object.hasOwn(failRes, 'method'), false, 'method 键存在，值=' + JSON.stringify(failRes.method));
  assert.notEqual(failRes.method, null, 'null 是非法占位（宿主：must be a string）');
});
check('B3 失败路径：返回值通过宿主契约校验', () => {
  const v = validateToolOutput(schema, failRes, 'value');
  assert.deepEqual(v, [], '宿主会拒绝：' + JSON.stringify(v));
});
await acheck('B4 失败路径：绝不落盘为 VERIFIED，也绝不进入跨会话全局库', async () => {
  const stored = A.api.getStore(SID).experiences.find((e) => e.id === expFail.id);
  assert.ok(stored, '经验条目应当仍在库里（失败不等于删除）');
  assert.equal(stored.verification?.status, 'UNVERIFIED', 'status=' + stored.verification?.status);
  assert.equal(stored.state, 'PROPOSED', 'state=' + stored.state);
  assert.equal(A.api.globalStore().experiences.length, 0, '失败路径不得污染全局库');
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// C 组：负控 —— 把两个旧形态喂给同一个校验器，必须**逐字**复现生产报错
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- C 组：负控（旧形态必须被同一校验器拒绝，否则本门是空转）---');
check('C1 旧成功形态 {…, error: undefined} ⇒ value is not lossless JSON（= 生产原话）', () => {
  const oldShape = { ...okRes, error: undefined };
  const v = validateToolOutput(schema, oldShape, 'value');
  assert.ok(v.includes('value is not lossless JSON'), JSON.stringify(v));
});
check('C2 旧失败形态 {…, method: null} ⇒ "value.method" must be a string（= 生产原话）', () => {
  const oldShape = { ok: false, experienceId: expFail.id, state: 'PROPOSED', verificationStatus: 'UNVERIFIED', method: null, error: 'invalid_or_non_machine_checkable_evidence', publication: 'not_applicable' };
  const v = validateToolOutput(schema, oldShape, 'value');
  assert.ok(v.includes('"value.method" must be a string'), JSON.stringify(v));
});
check('C3 对照组：同一对象去掉 null 字段（本修复形态）⇒ 校验通过', () => {
  const fixed = { ok: false, experienceId: expFail.id, state: 'PROPOSED', verificationStatus: 'UNVERIFIED', error: 'invalid_or_non_machine_checkable_evidence', publication: 'not_applicable' };
  assert.deepEqual(validateToolOutput(schema, fixed, 'value'), []);
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// D 组：同族工具的 lossless 面（防止"修一处、漏一族"）
// ═══════════════════════════════════════════════════════════════════════════
console.log('--- D 组：同族工具返回值同样必须 lossless（propose / recall / status / review）---');
await acheck('D1 learn_propose 返回值通过其自身 output 契约', async () => {
  const r = await A.api.invokeTool('learn_propose', {
    title: 'B2 契约测试：同族工具 lossless 面',
    body: '本条目用于确认 learn_propose 的返回值同样是 host-safe 的 lossless JSON。',
    tags: ['p4', 'b2'],
    sourceEventSeqs: [301, 303],
  }, mkExec(SID));
  assert.deepEqual(validateToolOutput(A.api.toolSpecs.learn_propose.output.schema, r, 'value'), []);
  assert.equal(typeof r.ok, 'boolean');
});
await acheck('D2 learn_recall 返回值通过其自身 output 契约', async () => {
  const r = await A.api.invokeTool('learn_recall', { query: 'b2 契约 lossless', limit: 5 }, mkExec(SID));
  assert.deepEqual(validateToolOutput(A.api.toolSpecs.learn_recall.output.schema, r, 'value'), []);
  assert.equal(Array.isArray(r.items), true);
});
await acheck('D3 learn_status 返回值通过其自身 output 契约', async () => {
  const r = await A.api.invokeTool('learn_status', {}, mkExec(SID));
  assert.deepEqual(validateToolOutput(A.api.toolSpecs.learn_status.output.schema, r, 'value'), []);
  assert.equal(typeof r.ok, 'boolean');
});
await acheck('D4 learn_review 返回值通过其自身 output 契约（reject 路径，不需宿主批准通道）', async () => {
  const r = await A.api.invokeTool('learn_review', {
    experienceId: expFail.id, action: 'reject', approver: 'b2-test', reason: 'b2 契约测试用拒收，非真实业务判定',
  }, mkExec(SID));
  assert.deepEqual(validateToolOutput(A.api.toolSpecs.learn_review.output.schema, r, 'value'), []);
  assert.equal(typeof r.ok, 'boolean');
});
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== 汇总 ===');
console.log(`  ${pass} PASS / ${fail} FAIL`);
if (fail > 0) {
  console.log('  失败清单：');
  for (const f of failures) console.log('    · ' + f);
  process.exit(1);
}
process.exit(0);
