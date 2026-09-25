// mutation-proof-17-b1.mjs —— 变异证明 17（B1 授权门）：canPublish() 恒 true ⇒ B1 门套件必须 RED
//
// 目的：证明 test-learn-r2-b1-approval-gate.mjs 真的锁住了「未人工审批 ⇒ 不得跨会话发布/召回」。
// 做法：临时把 learn-core.mjs 的 canPublish() 改成恒 true（单点语义破坏），跑 B1 套件，
//       要求它 RED（尤其 A 组「未审批不得发布」与「不得跨会话召回」断言），然后逐字节还原并核 sha256。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CORE = path.join(ROOT, 'plugins', 'learn-core.mjs');
const TEST = path.join(ROOT, 'tests', 'learn', 'test-learn-r2-b1-approval-gate.mjs');
const PRISTINE_PATH = path.join(HERE, 'learn-core.mjs.pristine');
const EVIDENCE = path.join(HERE, '..', 'B1-mutation-proof-17-20260925.txt');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

if (!fs.existsSync(PRISTINE_PATH)) fs.copyFileSync(CORE, PRISTINE_PATH);
const pristine = fs.readFileSync(PRISTINE_PATH, 'utf8');
const PRISTINE_SHA = sha256(pristine);

const FIND = 'export function canPublish(exp) {';
const REPLACE = "export function canPublish(exp) {\n  return { ok: true, reason: 'MUTATED_always_true' };";

const out = [];
const say = (s) => { out.push(s); console.log(s); };

say('变异证明 17 —— B1 人工审批授权门（独立核对用外部证据）');
say(`被测文件 : ${CORE}`);
say(`被测套件 : ${TEST}`);
say(`pristine sha256 = ${PRISTINE_SHA}`);
say(`还原源   : ${PRISTINE_PATH}`);
say('');

const current = fs.readFileSync(CORE, 'utf8');
say(`变异前线上文件 sha256 = ${sha256(current)}（应等于 pristine）`);
if (sha256(current) !== PRISTINE_SHA) {
  fs.writeFileSync(CORE, pristine, 'utf8');
  say('⚠ 线上文件与 pristine 不一致 → 已先还原为 pristine');
}
say('');

say('─'.repeat(74));
say('MUT-17 把 canPublish() 改成恒 true（关掉人工审批授权门）');
say(`  破坏点 : ${FIND}`);
let allOk = true;
if (!pristine.includes(FIND)) {
  say('  ✗ 找不到破坏点 → 无法施加变异（判定失败）'); allOk = false;
} else {
  const mutated = pristine.replace(FIND, REPLACE);
  fs.writeFileSync(CORE, mutated, 'utf8');
  say(`  变异后 sha256 = ${sha256(fs.readFileSync(CORE, 'utf8'))}`);
  let exitCode = 0; let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [TEST], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { exitCode = e.status ?? -1; stdout = String(e.stdout ?? '') + String(e.stderr ?? ''); }
  const resultLine = (stdout.match(/RESULT: .*/) ?? ['(未产出 RESULT 行)'])[0];
  const fails = stdout.split(/\r?\n/).filter((l) => l.includes('FAIL  '));
  say(`  测试 exit code = ${exitCode}`);
  say(`  ${resultLine}`);
  say(`  RED 断言数 = ${fails.length}`);
  for (const l of fails.slice(0, 8)) say(`    · ${l.trim()}`);
  // 关键：确认「未审批 ⇒ 拒」与「跨会话不得召回」这两类断言确实红了
  const deniedFail = fails.some((l) => /not_human_approved|publication/i.test(l));
  const recallFail = fails.some((l) => /召回|recall|cross|跨会话/i.test(l));
  const red = exitCode !== 0 && fails.length > 0 && deniedFail;
  say(`  含「发布授权被绕过」类断言变红 = ${deniedFail}；含「跨会话召回/隔离」类断言变红 = ${recallFail}`);
  say(`  判定 : ${red ? '✔ 变异被 B1 门套件捕获（RED，符合预期）' : '✗ 变异未被捕获'}`);
  if (!red) allOk = false;
  fs.writeFileSync(CORE, pristine, 'utf8');
  const restored = sha256(fs.readFileSync(CORE, 'utf8'));
  say(`  还原后 sha256 = ${restored}  ${restored === PRISTINE_SHA ? '✔ 逐字节等于 pristine（回到正式哈希）' : '✗ 还原失败'}`);
  if (restored !== PRISTINE_SHA) allOk = false;
}

say('─'.repeat(74));
const finalSha = sha256(fs.readFileSync(CORE, 'utf8'));
say(`作业结束：plugins/learn-core.mjs sha256 = ${finalSha}`);
say(`总判定：${allOk ? 'PASS —— 变异被捕获，文件已逐字节还原' : 'FAIL'}`);
fs.writeFileSync(EVIDENCE, out.join('\n') + '\n', 'utf8');
console.log('\n证据已写入：' + EVIDENCE);
process.exit(allOk ? 0 : 1);
