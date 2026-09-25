// test-learn-r2-f2-store-min.mjs —— R2 外部评审 **F2** 回归门（sessionStoreMaxFiles 下限是真实校验）
//
// ── 这个套件锁死的命题 ──────────────────────────────────────────────────────
//   F2 的缺陷不是"数字写小了"，而是**静默**：`LEARN_SESSION_STORE_MAX_FILES=63` 被当作合法值
//   接受，于是运维拿到一句不可能被兑现的承诺（limit<64 时磁盘占用是 max(limit, 活跃数)，
//   活跃集本身 LRU 上限 64 ⇒ 那个 63 永远不会成为硬约束）。
//   故本套件锁死三件事，缺一不可：
//     ① 63 ⇒ **被拒绝**：存在**真实**的 config validation 失败（诊断文本逐字含规范锚点），
//        且请求值没有被当成生效值（不是静默接受）；
//     ② 64 / 65 ⇒ **被接受**：合法值不得被误伤（防"把闸门焊死"式假通过：如果实现把一切都
//        判非法，① 会绿而 ② 会红，故②是①的反-空断言对照）；
//     ③ 边界之外的非法形态（0 / 负数 / 小数 / 非数字文本 / 布尔 / null）同样必须是失败，
//        且失败**可取证**（诊断进入 logger.warn 与本实例的 configValidationLog()）。
//
// ── 为什么必须真插件真路径（不是只测纯函数）────────────────────────────────
//   静默发生的**位置**在 config 载入层（`apply()` 的归一化），纯函数层全绿也证明不了
//   "载入层真的接了这道闸"。故本套件每个取值都走：设 env → import 真实 plugins/learn.mjs
//   → apply() → 读真实可观测面（retentionPolicy / configValidationLog / logger.warn）。
//   stateDir / globalStorePath 一律 os.tmpdir()，**绝不触碰生产**（~/.dsh、LOCALAPPDATA）。
//
// ── 数值口径的**取值依据**（不是新造的数字）────────────────────────────────
//   最小受支持值 64 = 本插件既有的 per-session 内存口径 `MAX_IN_MEMORY_SESSIONS = 64`
//   （learn.mjs §B2；§15 的 `MAX_TRACKED_SESSIONS` 复用同一数字）。磁盘上限低于该口径时
//   两个口径互相矛盾，故以它为下限。锚点常量由 learn-core 导出，测试逐字比对（不硬编码副本）。
//
// 运行：node tests/learn/test-learn-r2-f2-store-min.mjs
// 变异敏感度（实测证据见报告 §F2）：把 learn-core 的 MIN_SESSION_STORE_MAX_FILES 改回 1
//   ⇒ 本套件 RED（A1/A2/A5 失败），恢复后 GREEN。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  MIN_SESSION_STORE_MAX_FILES,
  SESSION_STORE_MAX_FILES_MIN_DIAGNOSTIC,
  validateSessionStoreMaxFiles,
} from '../../plugins/learn-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_URL = pathToFileURL(join(HERE, '..', '..', 'plugins', 'learn.mjs')).href;
const ENV_KEY = 'LEARN_SESSION_STORE_MAX_FILES';

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

// 本套件独占 env 键：起点必须是"未设置"，否则测试会测到别人的环境。
const ENV_SAVED = process.env[ENV_KEY];
// 注意：`undefined` 与 `''` 在本插件的归一化语义里**都**等于"未设置"，故用哨兵值区分。
const ENV_WAS_UNSET = ENV_SAVED === undefined || ENV_SAVED === '';
delete process.env[ENV_KEY];
if (!ENV_WAS_UNSET) { console.log(`（注意：本套件启动时 ${ENV_KEY} 已被外层设为 ${JSON.stringify(ENV_SAVED)}，已临时清除，结束后恢复）`); }

let gen = 0;
/** 本套件自建的全部临时 stateDir —— 收尾时逐一删除，不给 %TEMP% 留垃圾。 */
const createdDirs = [];
/**
 * 装载**真实**插件（每个场景一个全新模块实例，避免模块级状态串味）。
 * envValue === null ⇒ 显式不设置该 env（测 config/默认路径）。
 */
async function newInstance(tag, envValue) {
  for (const k of Object.keys(process.env)) if (k.startsWith('LEARN_')) delete process.env[k];
  if (envValue !== null) process.env[ENV_KEY] = String(envValue);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `f2-${tag}-`));
  createdDirs.push(dir);
  const warned = [];
  const infos = [];
  const hooks = new Map();
  const mod = await import(`${PLUGIN_URL}?f2=${++gen}`);
  const api = mod.apply({
    logger: { info: (m) => infos.push(String(m)), warn: (m) => warned.push(String(m)) },
    on: (e, f) => { if (!hooks.has(e)) hooks.set(e, []); hooks.get(e).push(f); },
    tools: { register: () => {} },
    // 不注入 approval / sessions：本套件测的是 config 面，不应依赖宿主批准边界。
  }, { stateDir: dir, globalStorePath: path.join(dir, '_global-verified.json') });
  return { api, dir, warned, infos, hooks };
}

/** logger.warn 捕获面 ∪ API 暴露面 —— 两个面任一为真即"诊断真实存在"。 */
function diagnosticsOf(inst) {
  const fromLogger = inst.warned.filter((m) => m.includes(SESSION_STORE_MAX_FILES_MIN_DIAGNOSTIC)
    || /config validation failure/.test(m));
  const fromApi = inst.api.configValidationLog?.() ?? [];
  return { union: [...new Set([...fromApi, ...fromLogger])], fromLogger, fromApi };
}

console.log('='.repeat(74));
console.log('F2 回归门：sessionStoreMaxFiles 下限 = 真实 config validation（63 拒绝 / 64,65 接受）');
console.log(`最小受支持值 = ${MIN_SESSION_STORE_MAX_FILES}｜规范锚点 = ${JSON.stringify(SESSION_STORE_MAX_FILES_MIN_DIAGNOSTIC)}`);
console.log('='.repeat(74));

// ═══ A. 纯函数层：校验语义本身 ═══════════════════════════════════════════════
console.log('\n[A] 纯函数层（validateSessionStoreMaxFiles；无副作用，config 载入层与测试共用）');

check('A1 锚点常量与最小受支持值自洽（64 与诊断文本同源，不得各写一份）', () => {
  assert.equal(MIN_SESSION_STORE_MAX_FILES, 64, '最小受支持值必须是 64（= MAX_IN_MEMORY_SESSIONS 口径）');
  assert.equal(SESSION_STORE_MAX_FILES_MIN_DIAGNOSTIC, `minimum supported sessionStoreMaxFiles is ${MIN_SESSION_STORE_MAX_FILES}`,
    '锚点文本必须由常量派生');
});

check('A2 63 判为失败（below_minimum）且诊断逐字含锚点', () => {
  const v = validateSessionStoreMaxFiles(63);
  assert.equal(v.ok, false, '63 必须被拒绝');
  assert.equal(v.reason, 'session_store_max_files_below_minimum', '稳定错误码必须可断言');
  assert.equal(v.value, null, '被拒绝时不得回传"修正后的值"冒充接受');
  assert.ok(v.diagnostic.includes(SESSION_STORE_MAX_FILES_MIN_DIAGNOSTIC),
    `诊断必须逐字含锚点；实际 = ${JSON.stringify(v.diagnostic)}`);
});

check('A3 64 / 65 判为通过（合法值不得被误伤）', () => {
  for (const n of [64, 65, 200]) {
    const v = validateSessionStoreMaxFiles(n);
    assert.equal(v.ok, true, `${n} 必须被接受`);
    assert.equal(v.value, n, `${n} 必须原样采用（不得被改写）`);
    assert.equal(v.reason, null, `${n} 合法时不得携带错误码`);
    assert.equal(v.diagnostic, null, `${n} 合法时不得产生诊断（否则校验成了"永远失败"）`);
  }
});

check('A4 边界外非法形态一律失败（0 / 负数 / 小数 / 文本 / 布尔 / null / undefined）', () => {
  for (const raw of [0, -1, 1, 63.5, 'abc', '', '  ', true, false, null, undefined]) {
    const v = validateSessionStoreMaxFiles(raw);
    assert.equal(v.ok, false, `${JSON.stringify(raw)} 必须被判失败，实际 ok=${v.ok}`);
    assert.ok(v.diagnostic.includes(SESSION_STORE_MAX_FILES_MIN_DIAGNOSTIC),
      `${JSON.stringify(raw)} 的诊断也必须含锚点`);
  }
});

check('A5 字符串数字 "63" 同样被拒（env 来的值本来就是字符串，不得漏判）', () => {
  const v = validateSessionStoreMaxFiles('63');
  assert.equal(v.ok, false, 'env 形态的 "63" 必须与数字 63 得到同一判定');
  assert.equal(v.reason, 'session_store_max_files_below_minimum', '错误码必须与数字 63 一致');
});

// ═══ B. 插件真实路径：env 三值（63 / 64 / 65）═════════════════════════════════
console.log('\n[B] 插件真实路径（设 env → 真实 apply() → 真实可观测面）');

const cases = {};
await acheck('B1-装载 LEARN_SESSION_STORE_MAX_FILES=63', async () => { cases[63] = await newInstance('63', 63); });
await acheck('B2-装载 LEARN_SESSION_STORE_MAX_FILES=64', async () => { cases[64] = await newInstance('64', 64); });
await acheck('B3-装载 LEARN_SESSION_STORE_MAX_FILES=65', async () => { cases[65] = await newInstance('65', 65); });

check('B4 【核心】63 ⇒ 存在真实 config validation 失败（不是静默接受）', () => {
  const inst = cases[63];
  assert.ok(inst, '63 场景必须已装载');
  const d = diagnosticsOf(inst);
  assert.ok(d.union.length > 0, '63 必须产生至少一条可取证诊断；实际为 0 条（= 静默接受，F2 未修复）');
  assert.ok(d.union.every((x) => x.includes(SESSION_STORE_MAX_FILES_MIN_DIAGNOSTIC)),
    '每条诊断都必须逐字含规范锚点');
  assert.ok(d.union.some((x) => /not supported|rejected/.test(x)), '诊断必须写明"该值不被支持/请求值被拒绝"');
  assert.equal(inst.api.configValidation().ok, false, 'configValidation().ok 必须为 false');
  assert.ok(inst.api.configValidation().failures >= 1, 'failures 计数必须 ≥1');
});

check('B5 【核心】63 ⇒ 请求值未被当作生效值（拒绝 ≠ 悄悄钳制）', () => {
  const inst = cases[63];
  assert.equal(inst.api.retentionPolicy().maxFiles, MIN_SESSION_STORE_MAX_FILES,
    '生效值必须落到最小受支持值 64');
  assert.notEqual(inst.api.retentionPolicy().maxFiles, 63, '63 绝不能成为生效值');
  // 诊断里必须**写明**这件事，否则运维无法解释"我配了 63，为什么是 64"。
  const d = diagnosticsOf(inst);
  assert.ok(d.union.some((x) => x.includes('effective sessionStoreMaxFiles = 64')),
    '诊断必须显式给出生效值（可解释性，防"说了失败却不说结果"）');
});

check('B6 63 ⇒ 诊断真的进入了 ctx.logger.warn（生产日志面也看得到，不只在 API 里）', () => {
  const d = diagnosticsOf(cases[63]);
  assert.ok(d.fromLogger.length > 0,
    '日志面为空 ⇒ 生产只有 no-op logger 时该失败不可见，F2 就退化回"静默"');
  assert.ok(d.fromLogger.every((x) => x.startsWith('[learn] ')), '日志必须带插件前缀 [learn]（与其他诊断同格式）');
});

check('B7 【反-空断言对照】64 ⇒ 被接受：无诊断、生效值 = 64', () => {
  const inst = cases[64];
  assert.equal(inst.api.retentionPolicy().maxFiles, 64, '64 必须原样生效');
  assert.equal(diagnosticsOf(inst).union.length, 0,
    '64 是合法值，不得产生任何 config validation 失败（否则校验变成"一律拒绝"的假通过）');
  assert.equal(inst.api.configValidation().ok, true, '64 时 configValidation().ok 必须为 true');
});

check('B8 65 ⇒ 被接受：无诊断、生效值 = 65（上限方向不受影响）', () => {
  const inst = cases[65];
  assert.equal(inst.api.retentionPolicy().maxFiles, 65, '65 必须原样生效（不得被压到 64）');
  assert.equal(diagnosticsOf(inst).union.length, 0, '65 合法，不得产生诊断');
});

// ═══ C. 非回归：默认值 / TTL / 形态 ══════════════════════════════════════════
console.log('\n[C] 非回归（默认值、TTL 语义、非法形态的插件层行为）');

const defInst = await newInstance('default', null);
const ttlInst = await newInstance('ttl', null);
// TTL 语义必须与既有一致：LEARN_SESSION_STORE_TTL_DAYS=30 生效；非法文本回落到 config 默认。
const ttlEnv = await (async () => {
  for (const k of Object.keys(process.env)) if (k.startsWith('LEARN_')) delete process.env[k];
  process.env.LEARN_SESSION_STORE_TTL_DAYS = '30';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-ttl-env-'));
  createdDirs.push(dir);
  const mod = await import(`${PLUGIN_URL}?f2=${++gen}`);
  const api = mod.apply({ logger: { info: () => {}, warn: () => {} }, on: () => {}, tools: { register: () => {} } },
    { stateDir: dir, globalStorePath: path.join(dir, '_g.json') });
  delete process.env.LEARN_SESSION_STORE_TTL_DAYS;
  return api.retentionPolicy().ttlDays;
})();

check('C1 默认（不设 env）仍是 200，且不产生任何校验失败', () => {
  assert.equal(defInst.api.retentionPolicy().maxFiles, 200, '既有默认值 200 不得被本次改动带偏');
  assert.equal(diagnosticsOf(defInst).union.length, 0, '默认路径不得产生诊断');
});

check('C2 TTL 语义未被本次改动影响（env=30 生效）', () => {
  assert.equal(ttlInst.api.retentionPolicy().ttlDays, 30, '默认 TTL 30 天');
  assert.equal(ttlEnv, 30, 'LEARN_SESSION_STORE_TTL_DAYS=30 必须生效（本次只动 maxFiles，不动 TTL）');
});

check('C3 非法形态在插件层同样 fail-loud 且生效值落到 64', async () => {
  for (const raw of ['abc', '0', '-5', '63.5']) {
    const inst = await newInstance(`bad-${raw}`, raw);
    const d = diagnosticsOf(inst);
    assert.ok(d.union.length > 0, `${JSON.stringify(raw)} 必须产生诊断`);
    assert.equal(inst.api.retentionPolicy().maxFiles, MIN_SESSION_STORE_MAX_FILES,
      `${JSON.stringify(raw)} 生效值必须落到 ${MIN_SESSION_STORE_MAX_FILES}`);
  }
});

check('C4 校验面是**只读快照**：外部改不动内部状态', () => {
  const inst = cases[63];
  const before = inst.api.configValidationLog().length;
  const snap = inst.api.configValidationLog();
  snap.push('被外部塞进来的假诊断');
  const after = inst.api.configValidationLog();
  assert.equal(after.length, before, 'configValidationLog() 必须返回副本：外部 push 不得改变内部记录条数');
  assert.equal(after.includes('被外部塞进来的假诊断'), false, '外部改动的元素不得出现在后续快照里');
  assert.equal(inst.api.configValidation().minimumSupportedSessionStoreMaxFiles, MIN_SESSION_STORE_MAX_FILES,
    '摘要里必须暴露最小受支持值（运维自解释）');
});

// ═══ D. 磁盘面：生效值真的被保留策略执行（**值敏感**断言）════════════════════
console.log('\n[D] 磁盘面（生效值真的被保留策略执行，而不是只写在报告里）');
//
// 为什么必须做"值敏感"断言：prune 的语义是「一批**非活跃**会话文件多于 limit 时，
// 保留下来的就是 limit 个」。故 `report.kept` 直接等于**当时生效的 limit**——
// 这让我们能区分 63/64/65/200，而不是只断言一句含糊的"文件数有上界"。
// 对照设计：env=63（应被拒 → 64，kept 必须是 64）vs env=65（合法 → kept 必须是 65）。
// 若实现把 63 静默接受，kept 会是 63；若实现整段被摘掉，kept 会是别处默认值 200 —— 两种都会被抓住。

/** 造 n 个非活跃会话文件（新鲜 mtime ⇒ 不触发 TTL 分支，只走数量上限分支）。 */
function seedIdleSessions(dir, n) {
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, `sess-${i}.json`), JSON.stringify({ i }));
}
const seededCount = await (async () => {
  const inst = await newInstance('prune63', 63);
  seedIdleSessions(inst.dir, 70);
  const report = inst.api.pruneSessionStore();
  const remaining = fs.readdirSync(inst.dir).filter((n) => /^sess-\d+\.json$/.test(n)).length;
  return { inst, report, remaining };
})();
const seeded65 = await (async () => {
  const inst = await newInstance('prune65', 65);
  seedIdleSessions(inst.dir, 70);
  const report = inst.api.pruneSessionStore();
  const remaining = fs.readdirSync(inst.dir).filter((n) => /^sess-\d+\.json$/.test(n)).length;
  return { inst, report, remaining };
})();

await acheck('D1 【核心】env=63 被拒后，prune 真的按 64 执行（kept === 64，而非 63/200）', async () => {
  const { report, remaining } = seededCount;
  assert.ok(report && typeof report === 'object', 'pruneSessionStore 必须返回可审计报告');
  assert.equal(report.ok, true, `prune 必须成功执行；实际 reason=${report.reason}`);
  assert.equal(report.scanned, 70, `反-空断言对照：70 个会话文件必须真的被扫到；实际 scanned=${report.scanned}`);
  assert.equal(report.kept, MIN_SESSION_STORE_MAX_FILES,
    `生效 limit 必须是 64（= 最小受支持值）；kept=${report.kept} 说明生效值是别的数字（63 = 静默接受 / 200 = 闸门被摘掉）`);
  assert.equal(remaining, MIN_SESSION_STORE_MAX_FILES, `磁盘剩余必须 = 64；实际 ${remaining}`);
  assert.ok(report.removed > 0, '必须真的裁掉了 70−64=6 个；removed=0 说明策略没跑');
});

await acheck('D2 对照：env=65（合法值）prune 按 65 执行（kept === 65）——证明 D1 的 64 是"被拒后的 64"而非硬编码', async () => {
  const { inst, report, remaining } = seeded65;
  assert.equal(diagnosticsOf(inst).union.length, 0, '65 合法：不得有诊断');
  assert.equal(report.kept, 65, `合法值 65 必须被真正使用；kept=${report.kept}`);
  assert.equal(remaining, 65, `磁盘剩余必须 = 65；实际 ${remaining}`);
  assert.equal(report.kept, seededCount.report.kept + 1,
    '两个场景只差 1 个文件 ⇒ 证明 kept 确实跟随"生效的 limit"，D1 的 64 不是巧合');
});

// ── 恢复 env（本套件独占该键，绝不把状态泄漏给后续）────────────────────────
if (ENV_WAS_UNSET) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = ENV_SAVED;

// ── 清理本套件自建的临时 stateDir（幂等：只删自己 mkdtemp 出来的、且在 os.tmpdir() 下的）──
let cleanedDirs = 0;
try {
  const tmpRoot = os.tmpdir();
  for (const d of createdDirs) {
    // 双保险：只删位于系统临时目录下、名字以 f2- 开头的目录，防误删
    if (!path.resolve(d).startsWith(path.resolve(tmpRoot)) || !path.basename(d).startsWith('f2-')) continue;
    fs.rmSync(d, { recursive: true, force: true });
    cleanedDirs++;
  }
} catch { /* 清理失败不影响测试结论 */ }

console.log('');
console.log('='.repeat(74));
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
console.log(`（临时目录自清理：${cleanedDirs}/${createdDirs.length} 个已删除，未在 %TEMP% 留垃圾）`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
