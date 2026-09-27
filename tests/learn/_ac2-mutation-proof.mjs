// _ac2-mutation-proof.mjs —— AC2 研究腿门的**突变验证**（反空转证明）
//
// 为什么必须有这个文件（A10 药丸 2 的直接教训）：
//   上一轮"实现 AC2"的失败形态是——**字面常量存在、真实执行点缺失**。
//   静态断言全绿，生产行为为零。所以"测试全绿"本身不是证据；**能被打红的测试才是证据**。
//
// 本脚本的做法（真突变、真运行、真断言）：
//   ① 把 plugins/ 整目录复制到临时目录（生产文件零改动）；
//   ② 对副本里的 learn.mjs 施加一处**定点突变**（每次只改一处，等价于把某项能力摘掉）；
//   ③ 用 AC2_LEARN_MJS 指向该副本，真实运行 AC2 专项门；
//   ④ 断言：门必须**退出码≠0**，且**指定的那条检查必须变红**。
//   若某处突变后门仍然全绿 ⇒ 说明该检查是空转（假门）⇒ 本脚本判 FAIL 并以 exit 1 结束。
//
// 运行：node tests/learn/_ac2-mutation-proof.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SUITE = join(HERE, 'test-learn-ac2-research-leg.mjs');

const MUTATIONS = [
  {
    id: 'M1',
    what: '★A10 药丸 2 场景：researchPlan 的**真实调用点**被删除（字面量还在，执行点没了）',
    from: '      const planRes = researchPlan(gap);',
    to: "      const planRes = null; // MUTATED: real researchPlan call site deleted",
    expectFail: ['0.7'],
  },
  {
    id: 'M2',
    what: 'AC2 主能力被摘掉：研究腿永不打开（openResearchLeg 直接失能）',
    from: 'function openResearchLeg(sid, { subject, source, at } = {}) {',
    to: "function openResearchLeg(sid, { subject, source, at } = {}) {\n    return { ok: false, error: 'mutated_leg_disabled' };",
    expectFail: ['A1'],
  },
  {
    id: 'M3',
    what: '有界被换成自留硬编码上限：研究腿上报 maxAttempts=999（不再复用候选面唯一权威）',
    from: '^[ \\t]*maxAttempts: MAX_RESEARCH_ATTEMPTS,[ \\t]*$',
    to: '        maxAttempts: 999, // MUTATED: hardcoded, no longer the single authority',
    expectFail: ['D2'],
    isRegex: true,
  },
  {
    id: 'M4',
    what: '输出契约被破坏：schema 不再声明 researchDirective（宿主会整条拒绝该工具输出）',
    from: "researchDirective: { type: 'object', additionalProperties: true },",
    to: "learnRecapDirective: { type: 'object', additionalProperties: true }, // MUTATED",
    expectFail: ['A2'],
  },
  {
    id: 'M5',
    what: '可审计性被摘掉：无覆盖请求不再记 EXPERIENCE_LOOKUP_MISS 遥测',
    from: "tel(sid, 'EXPERIENCE_LOOKUP_MISS', {",
    to: "void (0) && tel(sid, 'EXPERIENCE_LOOKUP_MISS', { // MUTATED: telemetry suppressed",
    expectFail: ['B4'],
  },
  {
    id: 'M6',
    what: '★假接线（比 M1 更隐蔽）：researchPlan 照样被调用，但返回值被丢弃、不再并入账本',
    from: '      const planRes = researchPlan(gap);',
    to: '      researchPlan(gap); const planRes = { ok: false, error: "mutated_discarded" };',
    expectFail: ['0.7'],
  },
];

let pass = 0; let fail = 0;
const bad = [];

console.log('=== AC2 研究腿门 · 突变验证（反空转证明）===');
console.log('  门 = ' + SUITE);
console.log('  基线对照：未突变时该门必须全绿（下面第 0 步先证）');
console.log('');

// ── 0 步：基线（未突变 ⇒ 全绿）─────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-mut-'));
function runSuite(pluginPath, tag) {
  const outFile = path.join(tmpRoot, `out-${tag}.txt`);
  const fd = fs.openSync(outFile, 'w');
  const r = spawnSync(process.execPath, [SUITE], {
    cwd: ROOT,
    env: { ...process.env, AC2_LEARN_MJS: pluginPath },
    stdio: ['ignore', fd, fd],   // 写文件而不走管道：不受受限模式的命名管道限制
    windowsHide: true,
  });
  fs.closeSync(fd);
  return { code: r.status, out: fs.readFileSync(outFile, 'utf8') };
}

function copyPluginsTo(tag) {
  const dst = path.join(tmpRoot, `plugins-${tag}`);
  fs.cpSync(join(ROOT, 'plugins'), dst, { recursive: true });
  return dst;
}

const baselinePlugins = copyPluginsTo('baseline');
const base = runSuite(join(baselinePlugins, 'learn.mjs'), 'baseline');
const baseLine = (base.out.match(/AC2 研究腿专项门：PASS=\d+\s+FAIL=\d+/) || ['(未解析到汇总行)'])[0];
if (base.code === 0 && /FAIL=0/.test(base.out)) {
  pass++; console.log(`  PASS  0 基线：未突变时门全绿（${baseLine}）`);
} else {
  fail++; bad.push('0 基线应全绿但未通过');
  console.log(`  FAIL  0 基线：${baseLine} exit=${base.code}`);
  console.log(base.out.split('\n').filter((l) => l.includes('FAIL')).slice(0, 12).join('\n'));
}

// ── 逐个突变 ───────────────────────────────────────────────────────────────
for (const m of MUTATIONS) {
  const dir = copyPluginsTo(m.id);
  const file = join(dir, 'learn.mjs');
  const before = fs.readFileSync(file, 'utf8');

  let after; let hits;
  if (m.isRegex) {
    const re = new RegExp(m.from, 'm');
    hits = (before.match(new RegExp(m.from, 'gm')) || []).length;
    after = before.replace(re, m.to);
  } else {
    hits = before.split(m.from).length - 1;
    after = before.split(m.from).join(m.to);
  }

  if (hits !== 1) {
    fail++; bad.push(`${m.id} 突变锚点不唯一/未命中（hits=${hits}）——突变验证本身失效`);
    console.log(`  FAIL  ${m.id} 突变锚点问题：hits=${hits}（需恰好 1）`);
    continue;
  }
  fs.writeFileSync(file, after, 'utf8');

  const r = runSuite(file, m.id);
  const failedChecks = [...r.out.matchAll(/^\s+FAIL\s+(\S+)/gm)].map((x) => x[1]);
  const line = (r.out.match(/AC2 研究腿专项门：PASS=\d+\s+FAIL=\d+/) || ['(未解析到汇总行)'])[0];
  const caught = r.code !== 0 && m.expectFail.every((id) => failedChecks.includes(id));

  if (caught) {
    pass++;
    console.log(`  PASS  ${m.id} 突变被抓住（${line}）`);
    console.log(`        ${m.what}`);
    console.log(`        变红检查（部分）：${failedChecks.slice(0, 8).join('、')}${failedChecks.length > 8 ? ` …共 ${failedChecks.length} 条` : ''}`);
  } else {
    fail++;
    bad.push(`${m.id} 突变**未被**抓住（expectFail=${m.expectFail.join(',')} 实际红=${failedChecks.join(',') || '无'}）`);
    console.log(`  FAIL  ${m.id} 突变未被抓住 ⇒ 该检查是空转（假门）！`);
    console.log(`        ${m.what}`);
    console.log(`        exit=${r.code} ${line} 期望变红=${m.expectFail.join(',')} 实际变红=${failedChecks.join('、') || '无'}`);
  }
}

console.log('');
console.log('══════════════════════════════════════════');
console.log(`突变验证：PASS=${pass}  FAIL=${fail}`);
if (bad.length) { console.log('问题：'); for (const b of bad) console.log('  · ' + b); }
console.log('══════════════════════════════════════════');
process.exit(fail > 0 ? 1 : 0);
