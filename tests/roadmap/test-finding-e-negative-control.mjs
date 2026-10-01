#!/usr/bin/env node
// tests/roadmap/test-finding-e-negative-control.mjs
//
// Finding E（External Review §9.2 E：D12 括号内描述过宽）的**负控测试**：
// 证明校验器 §H 的 H2 / H5 真的会被 E 所描述的那类缺陷弄红，而不是永远打印 PASS 的装饰门。
//
// 做法（**绝不修改仓库任何文件**）：
//   ① 把整棵树复制到临时目录（跳过 .git / node_modules），在副本里 `git init` + 提交一次，
//      使副本成为一个自洽的仓库（锚点门对"冻结历史行"的豁免需要 `git show HEAD:` 可用）；
//   ② 基线：在副本里跑校验器 → H2/H5 必须 PASS（副本自身必须先是绿的，否则差分无意义）；
//   ③ 注入 A（E 的原始缺陷形态）：删掉副本 CURRENT_STATUS.md 里「点值、非常量」的**非常量**限定
//      → 校验器必须 exit 1 且 **H5** 由 PASS 翻成 FAIL；
//   ④ 注入 B（E 的根因：桶逻辑没被真正断言）：把副本普查工具里的 fixture 期望 4 改成 5
//      → 普查工具 `--self-test` 必须 exit 1，且校验器 **H2** 由 PASS 翻成 FAIL；
//   ⑤ 注入 C（收官轮发现的第二类缺陷：控制套件"无归宿"）：删掉副本 ci-level1.yml 里对本控制的
//      调用行 → 校验器 **H7** 必须由 PASS 翻成 FAIL（证明"每个控制套件都必须被某条 CI 航道真实调用"
//      这条断言本身可被证伪，不是装饰）；
//   ⑥ 每次注入后立刻还原副本文件，并在末尾确认**真实仓库文件 sha256 前后完全一致**。
//
// 为什么用"临时副本 + 差分"而不是直接在仓库里改一行：注入式负控如果被 Ctrl-C/超时打断，
// 会把仓库留在"被改过"的状态，CI 之后会莫名其妙变红。副本方案零仓库副作用，且差分
// （同一副本、只改一个变量）比"红不红"更能定位因果。
//
// 退出码：0 = 全部符合预期；1 = 有断言不符。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const GATE_REL = path.join('tests', 'roadmap', 'validate-p4-status-consistency.mjs');
const STATUS_REL = path.join('docs', 'roadmap', 'CURRENT_STATUS.md');
const CENSUS_REL = path.join('tools', 'learn-store-census.mjs');
const CI_REL = path.join('.github', 'workflows', 'ci-level1.yml');
const REAL_FILES = [path.join(ROOT, GATE_REL), path.join(ROOT, STATUS_REL), path.join(ROOT, CENSUS_REL), path.join(ROOT, CI_REL)];
const SKIP_TOP = new Set(['.git', 'node_modules', '_p4r2-evidence']);

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const beforeReal = new Map(REAL_FILES.map((p) => [p, sha(p)]));

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_TOP.has(ent.name)) continue;
    const src = path.join(from, ent.name);
    const dst = path.join(to, ent.name);
    if (ent.isDirectory()) copyTree(src, dst);
    else if (ent.isFile()) fs.copyFileSync(src, dst);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-finding-e-negctl-'));
copyTree(ROOT, tmp);
const git = (args) => spawnSync('git', args, { cwd: tmp, encoding: 'utf8' });
git(['init', '-q']);
git(['add', '-A']);
git(['-c', 'user.email=negctl@local', '-c', 'user.name=negctl', 'commit', '-q', '-m', 'mirror baseline']);

const runMirrorGate = () => {
  const r = spawnSync(process.execPath, [GATE_REL], { cwd: tmp, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const verdict = {};
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^(PASS|FAIL)\s+(H\d)\b/);
    if (m) verdict[m[2]] = m[1] === 'PASS';
  }
  return { status: r.status, out, verdict };
};

const mirrorStatus = path.join(tmp, STATUS_REL);
const mirrorCensus = path.join(tmp, CENSUS_REL);
const mirrorCi = path.join(tmp, CI_REL);
const pristine = new Map([
  [mirrorStatus, fs.readFileSync(mirrorStatus)],
  [mirrorCensus, fs.readFileSync(mirrorCensus)],
  [mirrorCi, fs.readFileSync(mirrorCi)],
]);

try {
  // ── ② baseline ───────────────────────────────────────────────────────────────────────────
  const base = runMirrorGate();
  check('baseline mirror gate exits 0 (a red baseline would make the differential meaningless)',
    base.status === 0, `exit=${base.status}`);
  check('baseline H2 + H5 are PASS (the two assertions under test start green)',
    base.verdict.H2 === true && base.verdict.H5 === true,
    `H2=${base.verdict.H2} H5=${base.verdict.H5}`);

  // ── ③ injection A: the E defect class — point value quoted without the "not a constant" qualifier
  const doc = pristine.get(mirrorStatus).toString('utf8');
  const occurrences = (doc.match(/、非常量/g) || []).length;
  check('A0 the injected phrase exists exactly once in the document (targeted injection)',
    occurrences === 1, `occurrences=${occurrences}`);
  fs.writeFileSync(mirrorStatus, doc.replace('、非常量', ''), 'utf8');
  const a = runMirrorGate();
  check('A1 gate goes RED when the "not a constant" qualification is deleted',
    a.status === 1, `exit=${a.status}`);
  check('A2 the RED is attributable to H5 flipping PASS→FAIL (not an unrelated failure)',
    a.verdict.H5 === false, `H5=${a.verdict.H5}`);
  fs.writeFileSync(mirrorStatus, pristine.get(mirrorStatus));
  const aRestore = runMirrorGate();
  check('A3 restoring the file turns H5 back to PASS (injection was the cause, not noise)',
    aRestore.status === 0 && aRestore.verdict.H5 === true,
    `exit=${aRestore.status} H5=${aRestore.verdict.H5}`);

  // ── ④ injection B: bucket logic that is not actually asserted (E's root-cause class) ──────
  const tool = pristine.get(mirrorCensus).toString('utf8');
  const needle = "out.categories['schemaVersion=1 (ALL files)'] === 4";
  const toolHits = tool.split(needle).length - 1;
  check('B0 the fixture expectation to be falsified exists exactly once (targeted injection)',
    toolHits === 1, `occurrences=${toolHits}`);
  fs.writeFileSync(mirrorCensus, tool.replace(needle, "out.categories['schemaVersion=1 (ALL files)'] === 5"), 'utf8');
  const selfRun = spawnSync(process.execPath, [CENSUS_REL, '--self-test'], { cwd: tmp, encoding: 'utf8' });
  const selfOut = `${selfRun.stdout || ''}${selfRun.stderr || ''}`;
  check('B1 census self-test goes RED under the broken expectation (exit 1, FAIL counted)',
    selfRun.status === 1 && /FAIL: [1-9]/.test(selfOut), `exit=${selfRun.status}`);
  const b = runMirrorGate();
  check('B2 gate goes RED when the census self-test fails (H2 flips PASS→FAIL)',
    b.status === 1 && b.verdict.H2 === false, `exit=${b.status} H2=${b.verdict.H2}`);
  fs.writeFileSync(mirrorCensus, pristine.get(mirrorCensus));
  const bRestore = runMirrorGate();
  check('B3 restoring the tool turns H2 back to PASS (injection was the cause, not noise)',
    bRestore.status === 0 && bRestore.verdict.H2 === true,
    `exit=${bRestore.status} H2=${bRestore.verdict.H2}`);

  // ── ⑤ injection C: a control suite with no owner (no CI lane invokes it) ───────────────────
  // 上一轮实测过这一类缺陷：A/B 两个控制当时**没有任何 workflow 调用**（tests/roadmap 也不在
  // ci-level3 的 paths 过滤内），于是"控制存在"这件事在 CI 侧不可见。H7 就是为它写的断言；
  // 这里证明 H7 真的会红 —— 否则"必须有归宿"也只是一句装饰。
  const ciDoc = pristine.get(mirrorCi).toString('utf8');
  const ciNeedle = 'node tests\\roadmap\\test-finding-e-negative-control.mjs';
  const ciHits = ciDoc.split(ciNeedle).length - 1;
  check('C1 the CI wiring line to be removed exists exactly once (targeted injection)',
    ciHits === 1, `occurrences=${ciHits}`);
  fs.writeFileSync(mirrorCi, ciDoc.split(/\r?\n/).filter((l) => !l.includes(ciNeedle)).join(ciDoc.includes('\r\n') ? '\r\n' : '\n'), 'utf8');
  const c = runMirrorGate();
  check('C2 gate goes RED when the control suite loses its CI owner (H7 flips PASS→FAIL)',
    c.status === 1 && c.verdict.H7 === false, `exit=${c.status} H7=${c.verdict.H7}`);
  fs.writeFileSync(mirrorCi, pristine.get(mirrorCi));
  const cRestore = runMirrorGate();
  check('C3 restoring the wiring turns H7 back to PASS (injection was the cause, not noise)',
    cRestore.status === 0 && cRestore.verdict.H7 === true,
    `exit=${cRestore.status} H7=${cRestore.verdict.H7}`);
} finally {
  // ⑤ 仓库零副作用：真实文件必须逐字节未变（副本里怎么改都不影响仓库）
  const drifted = REAL_FILES.filter((p) => sha(p) !== beforeReal.get(p));
  check('C0 the real repository files are byte-identical (sha256) — this test never mutates them',
    drifted.length === 0, drifted.map((p) => path.relative(ROOT, p)).join(', '));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  — ' + r.detail}`);
const fail = results.filter((r) => !r.ok).length;
console.log(`\nFINDING E NEGATIVE CONTROL: ${results.length} assertions  PASS: ${results.length - fail}  FAIL: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
