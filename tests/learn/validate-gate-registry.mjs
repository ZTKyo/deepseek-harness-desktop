// validate-gate-registry.mjs —— P4 LEARN AC10：门禁登记表 fail-closed 校验器
//
// 为什么需要它（A10『假绿灯』教训的直接产物）：
//   前几轮的问题不是"门变红"，而是门**悄悄消失**：
//     · 套件就在 tests/learn/ 里，却没有任何 CI 步骤跑它，报告里却写"要求门"；
//     · 或者反过来：workflow 里写着一个套件路径、登记表里查不到，谁也不知道它算不算门；
//     · 或者把数据依赖门塞进 CI，裸 runner 上因缺数据而"红"，于是有人把整条门删掉——门就没了。
//   本校验器把"门的存在性"变成机器可判的事实，而不是文档里的一句话：
//     ① 覆盖性：tests/learn/*.mjs 里的每个文件都必须登记，登记表里的每个路径都必须真实存在（双向，防漏登记/防幽灵条目）；
//     ② 排除必有据：不进 CI 的条目必须写明 requires（缺什么真实数据/环境）+ exclusionReason（为什么）+ localCommand（在哪跑）；
//     ③ 声明必须落地：登记为 CI 门的条目，其 workflow 必须真实存在、step 名必须真实存在、step 的 run 脚本里必须真实调用该套件；
//     ④ 不许有未登记接线：任何 workflow 的 run 里出现的 tests/learn 套件都必须在登记表里（防"偷偷接上/偷偷摘掉"）；
//     ⑤ 委派指针必须指向真跑得起来的那条航道：STAGE_DELEGATION 里声明 file 的阶段，
//        其 file 必须等于登记表里对应套件的 ci.workflow（历史缺陷：ISOLATED_TESTS 指向了并不跑隔离面的 workflow = 假绿灯指针）。
//   YAML 一律用 js-yaml 真解析（fail-closed：解析器不可用即红，绝不静默跳过）。
//
// 用法：
//   node tests/learn/validate-gate-registry.mjs
//   node tests/learn/validate-gate-registry.mjs --repo-root <dir> [--registry <json>] [--candidate-module <mjs>]
// 退出码：0 = 全部通过；1 = 至少一条校验失败（并逐条打印原因）。
//
// 反空转证明见 tests/learn/_ac10-registry-mutation-proof.mjs（6 种突变必须逐条被抓）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

const REPO = path.resolve(opt('repo-root', path.resolve(HERE, '..', '..')));
const REGISTRY_PATH = path.resolve(opt('registry', path.join(REPO, 'tests', 'learn', 'gate-registry.json')));
const CANDIDATE_MODULE = path.resolve(opt('candidate-module', path.join(REPO, 'plugins', 'learn-candidate.mjs')));
const SUITES_DIR = path.join(REPO, 'tests', 'learn');

let pass = 0; let fail = 0; const failures = [];
const ok = (name, detail = '') => { pass += 1; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); };
const bad = (name, why) => { fail += 1; failures.push(`${name}: ${why}`); console.log(`  FAIL  ${name} — ${why}`); };
const check = (name, fn) => { try { const d = fn(); ok(name, typeof d === 'string' ? d : ''); } catch (e) { bad(name, e?.message ?? String(e)); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ─── js-yaml（fail-closed；解析链与 tests/reliability/yaml-parse-check.mjs 同口径）───
const require = createRequire(import.meta.url);
function loadYaml() {
  try { return require('js-yaml'); } catch { /* fall through */ }
  const cands = [];
  if (process.env.NODE_PATH) cands.push(...process.env.NODE_PATH.split(path.delimiter).map((p) => path.join(p, 'js-yaml')));
  if (process.env.DSH_GLOBAL_ROOT) cands.push(path.join(process.env.DSH_GLOBAL_ROOT, 'js-yaml'));
  if (process.env.APPDATA) {
    cands.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'js-yaml'));
    cands.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'js-yaml'));
  }
  cands.push(path.join(REPO, 'node_modules', 'js-yaml'));
  for (const c of cands) { try { return require(c); } catch { /* next */ } }
  return null;
}
const yamlModRaw = loadYaml();
const yaml = (yamlModRaw && typeof yamlModRaw.load === 'function') ? yamlModRaw : (yamlModRaw?.default ?? yamlModRaw);

console.log('=== P4 LEARN AC10 gate registry validation ===');
console.log(`  repo        : ${REPO}`);
console.log(`  registry    : ${REGISTRY_PATH}`);
console.log(`  candidate   : ${CANDIDATE_MODULE}`);

// ─── 0) 解析器可用性（fail-closed：绝不 SKIP）────────────────────────────────
if (typeof yaml?.load !== 'function') {
  console.log('  FAIL  0 js-yaml 不可解析（fail-closed，不跳过）');
  console.log('\nAC10 gate registry: 0 PASS / 1 FAIL');
  process.exit(1);
}
ok('0 js-yaml 可用（workflow YAML 真解析，非文本猜测）');

// ─── 1) 登记表本身可解析 + 结构完整 ─────────────────────────────────────────
let REG = null;
check('1 登记表 JSON 可解析', () => {
  assert(fs.existsSync(REGISTRY_PATH), `登记表不存在: ${REGISTRY_PATH}`);
  REG = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  assert(Array.isArray(REG.suites) && REG.suites.length > 0, 'suites 必须是非空数组');
  assert(Array.isArray(REG.workflows) && REG.workflows.length > 0, 'workflows 必须是非空数组');
  return `${REG.suites.length} 个条目 / ${REG.workflows.length} 条航道`;
});
if (!REG) { console.log('\nAC10 gate registry: ' + pass + ' PASS / ' + fail + ' FAIL'); process.exit(1); }

// 登记字段规范
const KINDS = new Set(['gate', 'mutation-proof', 'registry-gate', 'tool', 'runner', 'helper']);
check('2 每个条目字段完整且合法（suite/kind/requires/localCommand/lastVerified）', () => {
  const problems = [];
  for (const s of REG.suites) {
    if (typeof s.suite !== 'string' || !s.suite.startsWith('tests/learn/')) problems.push(`suite 路径非法: ${JSON.stringify(s.suite)}`);
    if (!KINDS.has(s.kind)) problems.push(`${s.suite}: kind 非法 (${s.kind})`);
    if (!Array.isArray(s.requires)) problems.push(`${s.suite}: requires 必须是数组`);
    if (typeof s.localCommand !== 'string' || !s.localCommand) problems.push(`${s.suite}: 缺 localCommand`);
    if (typeof s.lastVerified !== 'string' || !s.lastVerified) problems.push(`${s.suite}: 缺 lastVerified`);
  }
  assert(problems.length === 0, problems.join(' | '));
  return `${REG.suites.length} 个条目字段合法`;
});

// ─── 2) 双向覆盖：文件 ↔ 登记表 ─────────────────────────────────────────────
const diskFiles = fs.readdirSync(SUITES_DIR).filter((n) => n.endsWith('.mjs'));
const registered = new Set(REG.suites.map((s) => s.suite));
check('3 覆盖性：tests/learn/*.mjs 全部登记（防"门悄悄消失"）', () => {
  const missing = diskFiles.filter((n) => !registered.has(`tests/learn/${n}`));
  assert(missing.length === 0, `未登记（无 CI 记录也无人知道该不该跑）: ${missing.join(', ')}`);
  return `${diskFiles.length} 个文件全部在登记表内`;
});
check('4 无幽灵条目：登记表里的每个路径都真实存在', () => {
  const ghost = REG.suites.filter((s) => !fs.existsSync(path.join(REPO, s.suite)));
  assert(ghost.length === 0, `登记了不存在的文件: ${ghost.map((s) => s.suite).join(', ')}`);
  return `${REG.suites.length} 个条目均指向真实文件`;
});
check('5 无重复登记', () => {
  const seen = new Map();
  for (const s of REG.suites) seen.set(s.suite, (seen.get(s.suite) ?? 0) + 1);
  const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  assert(dup.length === 0, `重复登记: ${dup.join(', ')}`);
  return '唯一';
});

// ─── 3) 排除必有据 ─────────────────────────────────────────────────────────
// helper（纯夹具模块，本身无独立断言）是唯一可以 requires 为空的类别——但**不是免检**：
// 它必须写明排除理由 + 使用说明，并且真的被某个已登记的门 import（下面逐字核对），
// 否则"helper"就成了"把门藏起来"的后门——那正是本门要防的事。
const IMPORT_RE = (base) => new RegExp('[\'"][^\'"]*' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]');
function importersOf(suiteRel, all) {
  const base = path.basename(suiteRel);
  const re = IMPORT_RE(base);
  const out = [];
  for (const other of all) {
    if (other.suite === suiteRel) continue;
    const abs = path.join(REPO, other.suite);
    if (!fs.existsSync(abs)) continue;
    if (re.test(fs.readFileSync(abs, 'utf8'))) out.push(other.suite);
  }
  return out;
}
check('6 未进 CI 的条目必须写明 requires + exclusionReason + localCommand（helper 必须被真实 import）', () => {
  const problems = [];
  for (const s of REG.suites) {
    if (s.ci) continue;
    const isHelper = s.kind === 'helper';
    if (!isHelper && (!Array.isArray(s.requires) || s.requires.length === 0)) problems.push(`${s.suite}: 缺 requires（它到底缺什么真实数据/环境）`);
    if (isHelper && (!Array.isArray(s.requires))) problems.push(`${s.suite}: requires 必须是数组`);
    if (typeof s.exclusionReason !== 'string' || s.exclusionReason.length < 40) problems.push(`${s.suite}: exclusionReason 过短/缺失（必须说明为什么不能进 CI，而不是一句"跳过"）`);
    if (s.kind === 'gate' && !/node tests/.test(s.localCommand ?? '')) problems.push(`${s.suite}: 数据依赖门必须给出可执行的 localCommand`);
    if (isHelper) {
      if (typeof s.localCommand !== 'string' || s.localCommand.length < 10) problems.push(`${s.suite}: helper 必须写明使用说明（localCommand）`);
      const imp = importersOf(s.suite, REG.suites);
      if (imp.length === 0) problems.push(`${s.suite}: 登记为 helper 却没有任何已登记的门 import 它（"helper"不能是隐藏门的后门）`);
    }
  }
  assert(problems.length === 0, problems.join(' | '));
  const excluded = REG.suites.filter((s) => !s.ci).length;
  const helpers = REG.suites.filter((s) => !s.ci && s.kind === 'helper').length;
  return `${excluded} 个未进 CI 条目均写明原因（${helpers} 个 helper 已核实被真实 import；0 个静默排除）`;
});

// ─── 4) workflow / step / 真实调用 三连校验 ──────────────────────────────────
const wfCache = new Map();
function wfText(rel) {
  const abs = path.join(REPO, rel);
  if (!wfCache.has(rel)) wfCache.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);
  return wfCache.get(rel);
}
function wfDoc(rel) {
  const t = wfText(rel);
  if (t === null) throw new Error(`workflow 不存在: ${rel}`);
  return yaml.load(t);
}
function stepNames(rel) {
  const doc = wfDoc(rel);
  const out = [];
  for (const job of Object.values(doc?.jobs ?? {})) for (const st of job?.steps ?? []) if (st?.name) out.push(String(st.name));
  return out;
}
function stepRun(rel, name) {
  const doc = wfDoc(rel);
  for (const job of Object.values(doc?.jobs ?? {})) for (const st of job?.steps ?? []) {
    if (String(st?.name ?? '') === name) return String(st?.run ?? '');
  }
  return null;
}
const norm = (s) => s.replace(/\\/g, '/');

check('7 登记表里声明的每条 workflow 都能被 js-yaml 解析（YAML 改动不会带病进 CI）', () => {
  const badOnes = [];
  for (const w of REG.workflows) {
    try { wfDoc(w.file); } catch (e) { badOnes.push(`${w.file}: ${e.message}`); }
  }
  assert(badOnes.length === 0, badOnes.join(' | '));
  return `${REG.workflows.length} 条航道 YAML 合法`;
});

check('8 CI 门：workflow 存在 + step 名真实存在 + run 里真实调用该套件', () => {
  const problems = [];
  for (const s of REG.suites) {
    if (!s.ci) continue;
    const { workflow, step } = s.ci;
    if (!fs.existsSync(path.join(REPO, workflow))) { problems.push(`${s.suite}: workflow 不存在 ${workflow}`); continue; }
    const names = stepNames(workflow);
    if (!names.includes(step)) { problems.push(`${s.suite}: ${workflow} 里没有 step「${step}」（现存 step: ${names.length} 个）`); continue; }
    const run = stepRun(workflow, step) ?? '';
    if (!norm(run).includes(s.suite)) problems.push(`${s.suite}: step「${step}」的 run 脚本里没有真实调用它（登记为门却没接线）`);
  }
  assert(problems.length === 0, problems.join(' | '));
  const ciGates = REG.suites.filter((s) => s.ci).length;
  return `${ciGates} 个 CI 门均经"workflow+step+run 调用"三连核验`;
});

// 只扫**真实执行**的部分：解析 YAML → 取每个 step 的 run 脚本体 → 剥掉 PowerShell 注释行。
// （历史教训：按整份 workflow 文本做正则，会把 YAML/PowerShell 注释里提到的套件也当成"已接线"，
//   于是 2026-09-29 出现"注释说 b1 已接入、登记表也照抄，而 runner 上它 exit 1"的双重不一致。）
function wiredSuites(rel) {
  const doc = wfDoc(rel);
  const out = new Set();
  for (const job of Object.values(doc?.jobs ?? {})) {
    for (const st of job?.steps ?? []) {
      const run = String(st?.run ?? '');
      if (!run) continue;
      const body = run.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
      for (const m of body.matchAll(/tests[\\/]learn[\\/]([\w.-]+\.mjs)/g)) out.add(`tests/learn/${m[1]}`);
    }
  }
  return out;
}

check('9 接线双向为真：run 脚本里真实出现的套件必须登记，且登记的车道必须与事实相符（防"偷偷接线"/"谎报排除"）', () => {
  const problems = [];
  const wiredBy = new Map();
  for (const w of REG.workflows) {
    if (wfText(w.file) === null) continue;
    for (const s of wiredSuites(w.file)) {
      if (!wiredBy.has(s)) wiredBy.set(s, new Set());
      wiredBy.get(s).add(w.file);
    }
  }
  for (const [s, lanes] of wiredBy) {
    const laneText = [...lanes].join(' / ');
    if (!registered.has(s)) { problems.push(`${s}（被 ${laneText} 的 run 脚本调用但未登记）`); continue; }
    const entry = REG.suites.find((x) => x.suite === s);
    if (!entry.ci) {
      problems.push(`${s}: 被 ${laneText} 的 run 脚本真实调用，却登记为"未进 CI"（排除声明与事实不符——2026-09-29 红门事故后正是这样被发现 b1 仍挂在 CI-safe 子集里）`);
      continue;
    }
    if (!lanes.has(entry.ci.workflow)) {
      problems.push(`${s}: run 脚本出现在 ${laneText}，但登记表说它跑在 ${entry.ci.workflow}（跨车道错标）`);
    }
  }
  assert(wiredBy.size > 0, '任何 workflow 的 run 脚本里都没有 tests/learn 套件（车道结构变了？本检查会静默失效）');
  assert(problems.length === 0, problems.join(' | '));
  return `${wiredBy.size} 条接线与登记表双向一致`;
});

// ─── 5) STAGE_DELEGATION 指针必须指向真跑得起来的那条航道 ────────────────────
check('10 候选模块存在且可 import（STAGE_DELEGATION 指针核验的前提）', () => {
  assert(fs.existsSync(CANDIDATE_MODULE), `候选模块不存在: ${CANDIDATE_MODULE}`);
  return path.relative(REPO, CANDIDATE_MODULE);
});
const mod = await import(pathToFileURL(CANDIDATE_MODULE).href);
const STAGE_DELEGATION = mod.STAGE_DELEGATION;
check('10a 候选模块导出 STAGE_DELEGATION 且每个阶段都有 system/entry/file', () => {
  assert(STAGE_DELEGATION && typeof STAGE_DELEGATION === 'object', 'STAGE_DELEGATION 未导出');
  const problems = [];
  for (const [k, v] of Object.entries(STAGE_DELEGATION)) {
    if (!v || typeof v !== 'object') { problems.push(`${k}: 不是对象`); continue; }
    for (const f of ['system', 'entry', 'file']) if (typeof v[f] !== 'string' || !v[f]) problems.push(`${k}: 缺 ${f}`);
    if (v.file && !fs.existsSync(path.join(REPO, v.file))) problems.push(`${k}: file 指向不存在的文件 ${v.file}`);
  }
  assert(problems.length === 0, problems.join(' | '));
  return `${Object.keys(STAGE_DELEGATION).length} 个阶段`;
});
check('10b 每个登记了 stage 的门，其 ci.workflow 必须与该阶段声明的 file 逐字一致（防假绿灯指针）', () => {
  const problems = [];
  const staged = REG.suites.filter((s) => s.stage);
  assert(staged.length > 0, '登记表里没有任何 stage 绑定（无法核验委派指针）');
  for (const s of staged) {
    const decl = STAGE_DELEGATION[s.stage];
    if (!decl) { problems.push(`${s.suite}: 登记的阶段 ${s.stage} 在 STAGE_DELEGATION 里不存在`); continue; }
    if (!s.ci) { problems.push(`${s.suite}: 登记了 stage=${s.stage} 却没登记 ci 航道`); continue; }
    if (decl.file !== s.ci.workflow) {
      problems.push(`${s.stage}: STAGE_DELEGATION.file=${decl.file} 但该阶段的门实际跑在 ${s.ci.workflow}（指针与真实航道不符）`);
    }
  }
  assert(problems.length === 0, problems.join(' | '));
  return staged.map((s) => `${s.stage} -> ${s.ci.workflow}`).join(', ');
});

// ─── 6) CI-safe 车道的语义约束（2026-09-29 一次真实红门事故的直接产物）─────────
// 事故（不是假想）：tests/learn/test-learn-b1-session-access.mjs 曾按"空 profile 重定向实测
// 22 PASS / 0 FAIL"被接进 ci-level2 的 CI-safe 子集，但在 GitHub runner 上 exit 1：
// 它的 §T2.0 调 mkHostApproval() → resolveHarnessPackage()，需要宿主**已安装**的
// @deepseek-ai/dsh 包（cordis + dsh-user-approval）。"空 profile 重定向"只清掉了 ~/.dsh 下的
// 数据，清不掉『包不在 runner 上』这件事 ⇒ 判据（CI-SAFE 判据）本身选错了变量，
// 于是必需检查「Reliability state machine tests」变红、PR 卡死。
// 这两条把"该车道能跑什么"和"证据是什么级别"变成机器可判的事实：
//   11 车道语义：ci-level2（CI-safe 车道）上登记的门，不得静态出现宿主安装包解析调用；
//   12 证据分级：任何 ci 条目必须写明 ciSafeEvidence，并以「CI 实证」/「本地实测」标记级别，
//      防止"本地实测"被当成"CI 实证"——那正是上述事故的认知来源。
const CI_SAFE_LANES = ['.github/workflows/ci-level2.yml'];
const HOST_RESOLUTION_PATTERNS = [
  { re: /\bmkHostApproval\s*\(/, what: 'mkHostApproval(' },
  { re: /\bresolveHarnessPackage\s*\(/, what: 'resolveHarnessPackage(' },
  { re: /@deepseek-ai\/dsh/, what: '@deepseek-ai/dsh' },
];
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

check('11 CI-safe 车道语义：ci-level2 上的门不得依赖"宿主已安装包"（否则在 runner 上必红）', () => {
  const problems = [];
  const criterion = String(REG.eforEmptyProfileCriterion ?? '');
  assert(criterion.length > 0, '登记表缺 eforEmptyProfileCriterion（CI-SAFE 判据必须写明，否则本检查没有判据可依）');
  let scanned = 0;
  for (const s of REG.suites) {
    if (!s.ci || !CI_SAFE_LANES.includes(s.ci.workflow)) continue;
    const abs = path.join(REPO, s.suite);
    if (!fs.existsSync(abs)) continue;
    scanned += 1;
    const body = stripComments(fs.readFileSync(abs, 'utf8'));
    const hits = HOST_RESOLUTION_PATTERNS.filter((p) => p.re.test(body)).map((p) => p.what);
    if (hits.length) {
      problems.push(`${s.suite}: 静态出现宿主安装包解析（${hits.join(', ')}）—— CI-safe 车道判据是"空 profile + 无部署产物 + 无生产数据"，它清不掉"包不在 runner 上"，应改挂 ci-level3 或退回本地门`);
    }
  }
  assert(scanned > 0, 'ci-level2 车道上没有任何登记门（车道名变了？本检查会静默失效）');
  assert(problems.length === 0, problems.join(' | '));
  return `${scanned} 个 CI-safe 车道门均不含宿主安装包解析`;
});

check('12 证据分级：每个 ci 条目必须写明 ciSafeEvidence 且标记「CI 实证」/「本地实测」', () => {
  const problems = [];
  for (const s of REG.suites) {
    if (!s.ci) continue;
    const ev = s.ciSafeEvidence;
    if (typeof ev !== 'string' || ev.length < 20) {
      problems.push(`${s.suite}: 缺 ciSafeEvidence（不许用"应该能过"代替实测证据）`);
      continue;
    }
    if (!/CI 实证|本地实测/.test(ev)) {
      problems.push(`${s.suite}: ciSafeEvidence 未标记级别（必须显式写出「CI 实证」或「本地实测」，防止本地实测被当成 CI 实证）`);
    }
  }
  assert(problems.length === 0, problems.join(' | '));
  const ci = REG.suites.filter((s) => s.ci);
  const ciProven = ci.filter((s) => /CI 实证/.test(s.ciSafeEvidence ?? '')).length;
  return `${ci.length} 个 ci 条目证据齐全（${ciProven} 条 CI 实证 / ${ci.length - ciProven} 条本地实测）`;
});

// ─── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\nAC10 gate registry: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) { for (const f of failures) console.log('  · ' + f); }
if (fail === 0) console.log('  PASS AC10 gate registry (每个套件都有归宿：真跑 / 有据排除 / 元门)');
process.exit(fail === 0 ? 0 : 1);
