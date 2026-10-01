#!/usr/bin/env node
// tests/roadmap/test-finding-c-number-pinning.mjs
//
// Finding C（External Review §9.2 C：权威文档自述数字陈旧，**且没有任何门钉住这些数字**）
// 的**负控测试**：证明校验器 §I 的 I2 / I3 真的会被"数字过期"这一类缺陷弄红，
// 而不是永远打印 PASS 的装饰门。
//
// 做法（与 Finding E 的负控同构，**绝不修改仓库任何文件**）：
//   ① 把整棵树复制到临时目录（跳过 .git / node_modules / 外部证据目录），在副本里
//      `git init` + 提交一次，使副本成为自洽仓库（历史保全门需要 `git show HEAD:` 可用）；
//   ② 基线：在副本里跑校验器 → exit 0，且 I1/I2/I3 三条都 PASS；
//   ③ 注入 A（Finding C 的原始缺陷形态：断言数过期）：把副本文档「数字口径」行的
//      `断言数 N` 改成 N+1 → 校验器必须 exit 1 且 **I2** 由 PASS 翻成 FAIL；
//   ④ 注入 B（历史数字过期）：把同一行的 `HEAD 行 M` 改成 M+1 → **I3** 由 PASS 翻成 FAIL；
//   ⑤ 注入 C（形状缺失：有人"清理"了这行）：删掉整行数字口径行 → **I1** 与 **I2/I3** 同时翻红
//      （fail-closed：形状不在就不猜）；
//   ⑥ 每次注入后立刻还原副本文件，并在末尾确认**真实仓库文件 sha256 前后完全一致**。
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
const REAL_FILES = [path.join(ROOT, GATE_REL), path.join(ROOT, STATUS_REL)];
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-finding-c-negctl-'));
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
    const m = line.match(/^(PASS|FAIL)\s+(I\d)\b/);
    if (m) verdict[m[2]] = m[1] === 'PASS';
  }
  return { status: r.status, out, verdict };
};

const mirrorStatus = path.join(tmp, STATUS_REL);
const pristine = fs.readFileSync(mirrorStatus);

try {
  // ── ② baseline ───────────────────────────────────────────────────────────────────────────
  const base = runMirrorGate();
  check('baseline mirror gate exits 0 (a red baseline would make the differential meaningless)',
    base.status === 0, `exit=${base.status}`);
  check('baseline I1 + I2 + I3 are PASS (the three assertions under test start green)',
    base.verdict.I1 === true && base.verdict.I2 === true && base.verdict.I3 === true,
    `I1=${base.verdict.I1} I2=${base.verdict.I2} I3=${base.verdict.I3}`);
  const baseOut = base.out;
  check('baseline mirror gate reports a non-empty assertion total (the pinned number is real, not absent)',
    /ASSERTIONS:\s*\d+\s+PASS:\s*\d+\s+FAIL:\s*0/.test(baseOut),
    (baseOut.match(/ASSERTIONS:[^\n]*/) || ['no ASSERTIONS line'])[0]);

  // ── ③ injection A: stale ASSERTION COUNT (Finding C's literal defect) ─────────────────────
  const doc = pristine.toString('utf8');
  const declLine = (doc.match(/【数字口径·机器可核】[^\n]*/) || [null])[0];
  check('A0 the machine-checkable declaration line exists exactly once (targeted injection)',
    declLine !== null && doc.split('【数字口径·机器可核】').length - 1 === 1,
    `occurrences=${doc.split('【数字口径·机器可核】').length - 1}`);
  const declCount = declLine === null ? null : Number((declLine.match(/断言数 (\d+)/) || [])[1]);
  check('A1 the declaration carries a parseable assertion count',
    Number.isInteger(declCount), `count=${declCount}`);
  fs.writeFileSync(mirrorStatus, doc.replace(`断言数 ${declCount}`, `断言数 ${declCount + 1}`), 'utf8');
  const a = runMirrorGate();
  check('A2 gate goes RED when the declared assertion count goes stale (N → N+1)',
    a.status === 1, `exit=${a.status}`);
  check('A3 the RED is attributable to I2 flipping PASS→FAIL (not an unrelated failure)',
    a.verdict.I2 === false, `I2=${a.verdict.I2}`);
  fs.writeFileSync(mirrorStatus, pristine);
  const aRestore = runMirrorGate();
  check('A4 restoring the file turns I2 back to PASS (injection was the cause, not noise)',
    aRestore.status === 0 && aRestore.verdict.I2 === true,
    `exit=${aRestore.status} I2=${aRestore.verdict.I2}`);

  // ── ④ injection B: stale HISTORY numbers (the other half of Finding C) ────────────────────
  const histLines = declLine === null ? null : Number((declLine.match(/HEAD 行 (\d+)/) || [])[1]);
  check('B0 the declaration carries a parseable HEAD-line count',
    Number.isInteger(histLines), `lines=${histLines}`);
  fs.writeFileSync(mirrorStatus, doc.replace(`HEAD 行 ${histLines}`, `HEAD 行 ${histLines + 1}`), 'utf8');
  const b = runMirrorGate();
  check('B1 gate goes RED when the declared HEAD-line count goes stale (M → M+1)',
    b.status === 1, `exit=${b.status}`);
  check('B2 the RED is attributable to I3 flipping PASS→FAIL (not an unrelated failure)',
    b.verdict.I3 === false, `I3=${b.verdict.I3}`);
  fs.writeFileSync(mirrorStatus, pristine);
  const bRestore = runMirrorGate();
  check('B3 restoring the file turns I3 back to PASS (injection was the cause, not noise)',
    bRestore.status === 0 && bRestore.verdict.I3 === true,
    `exit=${bRestore.status} I3=${bRestore.verdict.I3}`);

  // ── ⑤ injection C: the declaration line is removed entirely (fail-closed shape) ───────────
  const stripped = doc.split(/\r?\n/).filter((l) => !l.includes('【数字口径·机器可核】')).join('\n');
  check('C0 the injection actually removed the line (targeted deletion)',
    !stripped.includes('【数字口径·机器可核】'),
    `occurrencesAfterDeletion=${stripped.split('【数字口径·机器可核】').length - 1}`);
  fs.writeFileSync(mirrorStatus, stripped, 'utf8');
  const c = runMirrorGate();
  check('C1 gate goes RED when the numeric declaration line disappears (fail-closed, no guessing)',
    c.status === 1, `exit=${c.status}`);
  check('C2 the RED is attributable to I1 (and I2/I3) flipping PASS→FAIL',
    c.verdict.I1 === false && c.verdict.I2 === false && c.verdict.I3 === false,
    `I1=${c.verdict.I1} I2=${c.verdict.I2} I3=${c.verdict.I3}`);
  fs.writeFileSync(mirrorStatus, pristine);
  const cRestore = runMirrorGate();
  check('C3 restoring the file turns I1 back to PASS (injection was the cause, not noise)',
    cRestore.status === 0 && cRestore.verdict.I1 === true,
    `exit=${cRestore.status} I1=${cRestore.verdict.I1}`);
} finally {
  // ── ⑥ real-repo safety: the control must never have touched the real tree ────────────────
  const afterReal = new Map(REAL_FILES.map((p) => [p, sha(p)]));
  check('real repo files are byte-identical before/after this control (zero side effects)',
    REAL_FILES.every((p) => beforeReal.get(p) === afterReal.get(p)),
    REAL_FILES.filter((p) => beforeReal.get(p) !== afterReal.get(p)).map((p) => path.relative(ROOT, p)).join(',') || 'all identical');
  fs.rmSync(tmp, { recursive: true, force: true });
}

const fail = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
console.log(`\nFINDING C NEGATIVE CONTROL: ${results.length} assertions  PASS: ${results.length - fail.length}  FAIL: ${fail.length}`);
if (fail.length > 0) {
  console.log('FAILURES:');
  for (const f of fail) console.log('  - ' + f.name + (f.detail ? ' — ' + f.detail : ''));
  process.exit(1);
}
console.log('VERDICT: the number-pinning assertions (I1/I2/I3) are falsifiable.');
