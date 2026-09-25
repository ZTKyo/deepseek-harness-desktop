// mutation-proof-b2.mjs —— B2 测试的变异敏感度证明（外部证据）
//
// 目的：证明 test-learn-r2-b2-bounds.mjs **真的锁住了** B2 的两条语义
//       ① 磁盘有界（pruneSessionStore 生效）  ② 内存有界（evictLRU 生效）。
// 做法：临时对 plugins/learn.mjs 做**单点语义破坏**，跑测试，要求其 RED，然后**逐字节还原**。
// 安全：先备份 pristine 并记录 sha256；每次变异后强制从 pristine 还原并核对 sha256。
//
// 用法：node _p4r2-evidence/mutations/mutation-proof-b2.mjs
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');                  // _p4r2/
const PLUGIN = path.join(ROOT, 'plugins', 'learn.mjs');
const TEST = path.join(ROOT, 'tests', 'learn', 'test-learn-r2-b2-bounds.mjs');
const PRISTINE = path.join(HERE, 'learn.mjs.pristine');
const EVIDENCE = path.join(HERE, '..', 'B2-mutation-proof-20260925.txt');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pristine = fs.readFileSync(PRISTINE, 'utf8');
const PRISTINE_SHA = sha256(pristine);

const MUTATIONS = [
  {
    name: 'MUT-18a 关闭磁盘保留策略（pruneSessionStore 立即返回 no-op）',
    expectGroup: 'A',
    find: 'function pruneSessionStore(now = Date.now()) {',
    replace: "function pruneSessionStore(now = Date.now()) {\n    return { ok: true, reason: 'MUTATED_noop', scanned: 0, removed: 0, kept: 0, removedIds: [] };",
  },
  {
    name: 'MUT-18b 关闭内存淘汰（evictLRU 立即返回 0）',
    expectGroup: 'M',
    find: 'function evictLRU(map, limit, protect) {',
    replace: 'function evictLRU(map, limit, protect) {\n    return 0;',
  },
];

const out = [];
const say = (s) => { out.push(s); console.log(s); };

say('B2 变异敏感度证明（独立核对用外部证据）');
say(`被测文件 : ${PLUGIN}`);
say(`被测套件 : ${TEST}`);
say(`pristine sha256 = ${PRISTINE_SHA}`);
say(`pristine 还原源 : ${PRISTINE}`);
say('');

// 前置：确认线上文件当前等于 pristine（否则先还原，避免在未知状态下做变异）
const current = fs.readFileSync(PLUGIN, 'utf8');
say(`变异前线上文件 sha256 = ${sha256(current)}（应等于 pristine）`);
if (sha256(current) !== PRISTINE_SHA) {
  fs.writeFileSync(PLUGIN, pristine, 'utf8');
  say('⚠ 线上文件与 pristine 不一致 → 已先还原为 pristine（并核对下述 sha256）');
  say(`还原后 sha256 = ${sha256(fs.readFileSync(PLUGIN, 'utf8'))}`);
}
say('');

let allOk = true;
for (const m of MUTATIONS) {
  say('─'.repeat(74));
  say(m.name);
  say(`  破坏点 : ${m.find}`);
  if (!pristine.includes(m.find)) { say('  ✗ 找不到破坏点字符串 → 变异无法施加（视为证明失败）'); allOk = false; continue; }
  const mutated = pristine.replace(m.find, m.replace);
  if (mutated === pristine) { say('  ✗ 变异未改变文件内容 → 证明失败'); allOk = false; continue; }
  fs.writeFileSync(PLUGIN, mutated, 'utf8');
  const mutatedSha = sha256(fs.readFileSync(PLUGIN, 'utf8'));
  say(`  变异后 sha256 = ${mutatedSha}`);
  let exitCode = 0; let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [TEST], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    exitCode = e.status ?? -1;
    stdout = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  const resultLine = (stdout.match(/RESULT: .*/) ?? ['(未产出 RESULT 行)'])[0];
  const groupFails = stdout.split(/\r?\n/).filter((l) => l.includes('FAIL  ') && l.includes(`FAIL  ${m.expectGroup}`));
  const wandered = stdout.split(/\r?\n/).filter((l) => l.includes('FAIL  ')).slice(0, 6);
  say(`  测试 exit code = ${exitCode}`);
  say(`  ${resultLine}`);
  say(`  期望组(${m.expectGroup}) 转 RED 的断言数 = ${groupFails.length}`);
  for (const l of groupFails.slice(0, 3)) say(`    · ${l.trim()}`);
  const red = exitCode !== 0 && groupFails.length > 0;
  say(`  判定 : ${red ? '✔ 变异被测试捕获（RED，符合预期）' : '✗ 变异未被捕获（测试对这次破坏不敏感）'}`);
  if (!red) { allOk = false; say('  所有 FAIL 行：'); for (const l of wandered) say(`    · ${l.trim()}`); }
  // 强制还原 + 逐字节核对
  fs.writeFileSync(PLUGIN, pristine, 'utf8');
  const restoredSha = sha256(fs.readFileSync(PLUGIN, 'utf8'));
  say(`  还原后 sha256 = ${restoredSha}  ${restoredSha === PRISTINE_SHA ? '✔ 逐字节等于 pristine' : '✗ 还原失败'}`);
  if (restoredSha !== PRISTINE_SHA) allOk = false;
  say('');
}

say('─'.repeat(74));
const finalSha = sha256(fs.readFileSync(PLUGIN, 'utf8'));
say(`作业结束：plugins/learn.mjs sha256 = ${finalSha}`);
say(`字节还原 = ${finalSha === PRISTINE_SHA ? 'YES（未被变异污染）' : 'NO（请立即处置）'}`);
say(`总判定：${allOk ? 'PASS —— 两处单点破坏均被测试捕获，且线下文件已逐字节还原' : 'FAIL —— 见上'}`);

fs.writeFileSync(EVIDENCE, out.join('\n') + '\n', 'utf8');
console.log('\n证据已写入：' + EVIDENCE);
process.exit(allOk ? 0 : 1);
