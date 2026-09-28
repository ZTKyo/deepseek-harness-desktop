// _ac10-registry-mutation-proof.mjs —— AC10 登记表门的**突变验证**（反空转证明）
//
// 为什么必须有这个文件（与 _ac2-mutation-proof.mjs 同一课）：
//   "门跑起来了"不等于"门能拦住东西"。一个只会打印 PASS 的校验器，和没有校验器是一样的。
//   本文件把校验器指向一份**临时副本**，逐条注入真实缺陷，并断言**对应的那一条检查**变红：
//     M1 套件未登记（门悄悄消失）        ⇒ 检查 3 变红
//     M2 数据依赖门被谎报成 CI 门        ⇒ 检查 8 变红（登记为门却没接线）
//     M3 排除理由被清空                  ⇒ 检查 6 变红（静默排除）
//     M4 STAGE_DELEGATION 指向不跑该门的航道 ⇒ 检查 10b 变红（假绿灯指针）
//     M5 workflow YAML 被写坏            ⇒ 检查 7 变红（带病 YAML 进 CI）
//     M6 workflow 里接了未登记的套件      ⇒ 检查 9 变红（偷偷接线）
//     M7 CI-safe 车道里混入依赖宿主包的套件 ⇒ 检查 11 变红（= 2026-09-29 真实红门事故的复现）
//     M8 ci 条目的证据字段被清空          ⇒ 检查 12 变红（拿不出实测证据却声称在 CI 跑）
//     M9 被 run 脚本真实调用的套件改成"未进 CI" ⇒ 检查 9 变红（谎报排除 —— 2026-09-29 摘除 b1 时
//                                              真实存在过的不一致：注释与登记表都写"已接入/未接入"，
//                                              而 workflow 的 run 脚本说的是另一回事）
//   第 0 步先证明**未突变的副本**是全绿的 —— 否则上面的"变红"可能只是副本本身有问题（恒真式）。
//
// 用法：node tests/learn/_ac10-registry-mutation-proof.mjs
// 退出码：0 = 基线绿且 9 种突变全部被抓；1 = 有突变没被抓（门是摆设）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const VALIDATOR = path.join(HERE, 'validate-gate-registry.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ac10-regproof-'));

let pass = 0; let fail = 0;
const check = (name, fn) => {
  try { const d = fn(); pass += 1; console.log(`  PASS  ${name}${d ? ' — ' + d : ''}`); }
  catch (e) { fail += 1; console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

// ─── 0) 搭一份"真仓库结构"的临时副本（不是只放登记表：validator 会读 workflow/插件/套件）──
const ROOT = path.join(TMP, 'repo');
const copy = (rel) => {
  const src = path.join(REPO, rel);
  const dst = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return dst;
};
for (const f of fs.readdirSync(path.join(REPO, 'tests', 'learn'))) {
  if (f.endsWith('.mjs') || f.endsWith('.json')) copy(path.join('tests', 'learn', f));
}
for (const f of fs.readdirSync(path.join(REPO, '.github', 'workflows'))) copy(path.join('.github', 'workflows', f));
for (const f of fs.readdirSync(path.join(REPO, 'plugins'))) {
  if (f.endsWith('.mjs')) copy(path.join('plugins', f));
}
// validator 还会核验 STAGE_DELEGATION 指针指向的文件是否真实存在（仓库根下的 dsh-*.ps1 等）。
// 这里按**候选模块自己声明的指针**动态拷贝，而不是硬编码一份文件名清单——
// 指针改了、这里没跟着改，基线就会红（正是我们要防的"指到不存在的门"）。
{
  const { STAGE_DELEGATION } = await import(pathToFileURL(path.join(REPO, 'plugins', 'learn-candidate.mjs')).href);
  const referenced = new Set();
  for (const stage of Object.values(STAGE_DELEGATION)) {
    for (const v of Object.values(stage)) {
      if (typeof v !== 'string') continue;
      for (const m of v.matchAll(/[\w./-]+\.(?:ps1|mjs|js|yml|yaml)/g)) referenced.add(m[0]);
    }
  }
  for (const rel of referenced) {
    const abs = path.join(REPO, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) copy(rel);
  }
  // package.json 里的 scripts/依赖不参与本门，但有的 .ps1 会读它——有就带上（缺也无妨）。
  if (fs.existsSync(path.join(REPO, 'cordis.patch.yml'))) copy('cordis.patch.yml');
}
fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify({ name: 'ac10-regproof', private: true }, null, 2) + '\n');

const REG_REL = path.join('tests', 'learn', 'gate-registry.json');
const CAND_REL = path.join('plugins', 'learn-candidate.mjs');
const WF2_REL = path.join('.github', 'workflows', 'ci-level2.yml');
const PRISTINE = new Map();
for (const rel of [REG_REL, CAND_REL, WF2_REL]) PRISTINE.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const restore = (rel) => fs.writeFileSync(path.join(ROOT, rel), PRISTINE.get(rel), 'utf8');

function runValidator() {
  const r = spawnSync(process.execPath, [VALIDATOR, '--repo-root', ROOT], { encoding: 'utf8', cwd: REPO, maxBuffer: 1 << 26 });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
// 断言：整体必须红，且**指定编号的那条检查**必须是 FAIL（避免"因为别的原因红"而蒙混过关）
function expectRed(checkNo, label) {
  for (const rel of [REG_REL, CAND_REL, WF2_REL]) restore(rel);
  const mutate = label();
  const { status, out } = runValidator();
  if (status === 0) throw new Error(`突变未被抓住（校验器仍 exit 0）：${mutate.because}`);
  const re = new RegExp(`FAIL\\s+${checkNo}[a-z]?\\s`);
  if (!re.test(out)) {
    const seen = out.split('\n').filter((l) => l.includes('FAIL')).slice(0, 6).join('\n        ');
    throw new Error(`红是红了，但不是检查 ${checkNo} 变红（突变要能定位到具体缺陷）：${mutate.because}\n        实际 FAIL 行:\n        ${seen}`);
  }
  for (const rel of [REG_REL, CAND_REL, WF2_REL]) restore(rel);
  return `${mutate.because} ⇒ 检查 ${checkNo} 变红`;
}
const readReg = () => JSON.parse(fs.readFileSync(path.join(ROOT, REG_REL), 'utf8'));
const writeReg = (o) => fs.writeFileSync(path.join(ROOT, REG_REL), JSON.stringify(o, null, 2) + '\n', 'utf8');

console.log('=== AC10 登记表门：突变验证（反空转）===');
console.log(`  校验器 : ${path.relative(REPO, VALIDATOR)}`);
console.log(`  临时副本: ${ROOT}`);

// ─── 0) 基线：未突变副本必须全绿 ────────────────────────────────────────────
check('0 基线：未突变时校验器全绿（否则下面的"变红"是恒真式）', () => {
  for (const rel of [REG_REL, CAND_REL, WF2_REL]) restore(rel);
  const { status, out } = runValidator();
  const m = out.match(/AC10 gate registry: (\d+) PASS \/ (\d+) FAIL/);
  assert(status === 0, `基线必须 exit 0，实际 ${status}\n${out.split('\n').filter((l) => l.includes('FAIL')).join('\n')}`);
  assert(!!m, '未打印汇总行');
  return `校验器 ${m[1]} PASS / ${m[2]} FAIL`;
});

// ─── M1：套件未登记（门悄悄消失）────────────────────────────────────────────
check('M1 突变被抓住（套件从登记表里消失）', () => expectRed(3, () => {
  const reg = readReg();
  const victim = 'tests/learn/redteam-r3-probe.mjs';
  reg.suites = reg.suites.filter((s) => s.suite !== victim);
  writeReg(reg);
  return { because: `${victim} 未登记（历史上正是"门还在、没人跑、报告却写要求门"）` };
}));

// ─── M2：数据依赖门被谎报成 CI 门 ───────────────────────────────────────────
check('M2 突变被抓住（把数据依赖门谎报成 CI 门）', () => expectRed(8, () => {
  const reg = readReg();
  const victim = reg.suites.find((s) => s.suite === 'tests/learn/redteam-r3-quality.mjs');
  victim.ci = { workflow: '.github/workflows/ci-level2.yml', step: 'P4 LEARN R2 contract-closure gates (CI-safe subset)' };
  writeReg(reg);
  return { because: 'redteam-r3-quality 登记为 CI 门，但 step 的 run 里根本没有它（声明与事实不符）' };
}));

// ─── M3：静默排除 ──────────────────────────────────────────────────────────
check('M3 突变被抓住（排除理由被清空）', () => expectRed(6, () => {
  const reg = readReg();
  const victim = reg.suites.find((s) => s.ci === null && s.kind === 'gate');
  victim.exclusionReason = '';
  writeReg(reg);
  return { because: `${victim.suite} 的 exclusionReason 被清空（静默排除）` };
}));

// ─── M4：假绿灯指针（STAGE_DELEGATION 指向不跑该门的航道）─────────────────────
check('M4 突变被抓住（STAGE_DELEGATION.ISOLATED_TESTS 指向不跑隔离面的 workflow）', () => expectRed('10b', () => {
  const p = path.join(ROOT, CAND_REL);
  const src = fs.readFileSync(p, 'utf8');
  const marker = "ISOLATED_TESTS: Object.freeze({";
  assert(src.includes(marker), '未找到 ISOLATED_TESTS 定义（突变注入点变了，需同步更新本门）');
  let hit = false;
  const out = src.replace(/ISOLATED_TESTS: Object\.freeze\(\{([\s\S]*?)\}\)/, (m, body) => {
    hit = true;
    return 'ISOLATED_TESTS: Object.freeze({' + body.replace(/file:\s*'[^']*'/, "file: '.github/workflows/ci-level1.yml'") + '})';
  });
  assert(hit, '替换未生效');
  fs.writeFileSync(p, out, 'utf8');
  return { because: 'ISOLATED_TESTS.file 被改成并不运行隔离真实实例的 ci-level1.yml（正是历史缺陷形态）' };
}));

// ─── M5：workflow YAML 被写坏 ──────────────────────────────────────────────
check('M5 突变被抓住（workflow YAML 语法被写坏）', () => expectRed(7, () => {
  const p = path.join(ROOT, WF2_REL);
  fs.appendFileSync(p, '\n  broken: [unclosed\n', 'utf8');
  return { because: 'ci-level2.yml 追加了未闭合的 YAML 流式序列（带病 YAML 不许进 CI）' };
}));

// ─── M6：偷偷接线（workflow 里接了未登记的套件）───────────────────────────────
check('M6 突变被抓住（workflow 里接了未登记的套件）', () => expectRed(9, () => {
  const p = path.join(ROOT, WF2_REL);
  const src = fs.readFileSync(p, 'utf8');
  // 锚点只取不含量词的那半句，避免"套件个数一变、本门就自己坏掉"这种人造脆性。
  const anchorLine = src.split(/\r?\n/).find((l) => l.includes("PASS P4 LEARN R2 contract-closure gates"));
  assert(anchorLine, '未找到注入锚点（ci-level2 结构变了，需同步更新本门）');
  fs.writeFileSync(p, src.replace(anchorLine, '          node tests\\learn\\test-learn-ghost.mjs\n' + anchorLine), 'utf8');
  return { because: 'ci-level2 多出一条 tests/learn/test-learn-ghost.mjs 调用但登记表里没有它' };
}));

// ─── M7：CI-safe 车道里混入依赖宿主包的套件（本次真实红门事故的机制复现）─────────
check('M7 突变被抓住（CI-safe 车道套件里出现宿主包解析调用）', () => {
  const p = path.join(ROOT, 'tests', 'learn', 'test-learn-core.mjs');
  const pristine = fs.readFileSync(p, 'utf8');
  try {
    return expectRed(11, () => {
      fs.writeFileSync(p, pristine + "\nvoid resolveHarnessPackage('@deepseek-ai/dsh');\n", 'utf8');
      return { because: 'test-learn-core.mjs（登记在 ci-level2 CI-safe 车道）出现 resolveHarnessPackage/@deepseek-ai/dsh 调用 —— 正是 b1 在 runner 上 exit 1 的机制' };
    });
  } finally { fs.writeFileSync(p, pristine, 'utf8'); }
});

// ─── M8：ci 条目的证据字段被清空（拿不出实测证据却声称在 CI 跑）─────────────────
check('M8 突变被抓住（ci 条目的 ciSafeEvidence 被清空）', () => expectRed(12, () => {
  const reg = readReg();
  const victim = reg.suites.find((s) => s.ci && s.ciSafeEvidence);
  assert(victim, '登记表里没有任何带证据的 ci 条目（突变注入点变了，需同步更新本门）');
  delete victim.ciSafeEvidence;
  writeReg(reg);
  return { because: `${victim.suite} 的 ciSafeEvidence 被删除（声称在 CI 跑，却拿不出"CI 实证/本地实测"级证据）` };
}));

// ─── M9：谎报排除（workflow 的 run 脚本真实调用，登记表却说"未进 CI"）─────────────
// 这是 2026-09-29 摘除 b1 时**真实出现过的**不一致形态：注释与登记表都写着"已接入"或"未接入"，
// 而 run 脚本说的是另一回事。旧版检查 9 只查"未登记"，查不出这一半，所以必须单独证明它能抓。
check('M9 突变被抓住（被 run 脚本真实调用的套件被标成"未进 CI"）', () => expectRed(9, () => {
  const reg = readReg();
  const victim = reg.suites.find(
    (s) => s.ci && /ci-level2\.yml$/.test(s.ci.workflow) && s.ci.step.includes('CI-safe subset'),
  );
  assert(victim, 'ci-level2 CI-safe 子集里找不到已登记的套件（突变注入点变了，需同步更新本门）');
  const name = victim.suite;
  victim.ci = null;
  writeReg(reg);
  return { because: `${name} 仍挂在 ci-level2 的 run 脚本里，却被改成"未进 CI"（排除声明与事实不符）` };
}));

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n══════════════════════════════════════════');
console.log(`突变验证：PASS=${pass}  FAIL=${fail}`);
console.log('══════════════════════════════════════════');
process.exit(fail === 0 ? 0 : 1);
