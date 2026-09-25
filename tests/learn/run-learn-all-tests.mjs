// run-learn-all-tests.mjs —— P4 LEARN 全量回归 runner
//
// 一次跑完 tests/learn 下全部测试（含真实会话 E2E、真实拓扑回归、redteam 套件），
// 逐个收集 PASS/FAIL 与退出码，输出汇总表 + 总体判定。
//
// 用法：node tests/learn/run-learn-all-tests.mjs [--filter=<substr>] [--timeout=<ms>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const filter = (args.find((a) => a.startsWith('--filter=')) ?? '').split('=')[1] ?? '';
const timeoutMs = Number((args.find((a) => a.startsWith('--timeout=')) ?? '').split('=')[1] ?? 900_000);

// 顺序固定：先核心/契约，再 AC5，再真实数据，最后 redteam（信息量最大）
const ORDER = [
  'test-learn-core.mjs',
  'test-learn-candidate.mjs',
  'test-learn-plugin-contract.mjs',
  'test-learn-ac5-e2e.mjs',
  'test-learn-ac5-gap-veto.mjs',
  'test-learn-stage85-twins.mjs',
  'test-learn-real-topology-tool-events.mjs',
  // R2 STAGE 2：Ground Truth Schema 锁（真实会话字段路径漂移即失败）+ 负例/正例锁
  // （工具成功/provider 中断/网络超时/凭据失败不得成为能力候选；真能力缺口必须成为候选）
  'test-learn-stage2-schema-and-negative-lock.mjs',
  'run-learn-real-e2e.mjs',
  'run-learn-real-gap-e2e.mjs',
  'test-learn-r3-fixes.mjs',
  'test-learn-r3-hardening.mjs',
  'test-learn-r3-secrets.mjs',
  // F1 R1 §6：approval authority **不可自铸** —— 手写链自洽台账 / 复制真实 grant 改锚点 /
  // 摘掉宿主服务 / 手写全局库 hydration 全部必须 DENY（含正例对照，防止"把闸门焊死"假通过）
  'test-learn-r3-approval-forgery.mjs',
  // F2：config 载入层下限**必须是真实校验**（LEARN_SESSION_STORE_MAX_FILES=63 必须 fail-loud，
  // 64/65 必须被接受；含 kept===64/65 的值敏感磁盘面断言与反-空断言对照）
  'test-learn-r2-f2-store-min.mjs',
  'redteam-r3-contamination.mjs',
  'redteam-r3-injection-positions.mjs',
  'redteam-r3-isolation.mjs',
  'redteam-r3-labels.mjs',
  'redteam-r3-metrics.mjs',
  'redteam-r3-probe.mjs',
  'redteam-r3-quality.mjs',
];

const present = ORDER.filter((f) => fs.existsSync(path.join(HERE, f)));
const extra = fs.readdirSync(HERE)
  .filter((f) => f.endsWith('.mjs') && !f.startsWith('_') && f !== 'run-learn-all-tests.mjs' && !ORDER.includes(f))
  .sort();
const files = [...present, ...extra].filter((f) => !filter || f.includes(filter));

console.log('='.repeat(78));
console.log(`P4 LEARN 全量回归：${files.length} 个套件`);
console.log('='.repeat(78));

const results = [];
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, f)], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const ms = Date.now() - t0;
  const code = r.status;

  // ── 判定口径（曾出错，已修正）──────────────────────────────────────────
  // ⚠ 首版用全文计数 \bPASS\b / \bFAIL\b ⇒ 把**标题里的 FAIL 字样**算成失败
  //   （如 "F4 R2 既有锁定用例仍成立"、"FAIL = 0"），导致全绿套件被误报 FAIL。
  //   正确口径：
  //     · 有门槛套件（test-learn-*、run-*e2e）：取**最后一条** "N PASS / M FAIL" 摘要
  //     · 观测模式套件（redteam-r3-*）：本身无 pass/fail 门槛（探针/度量/打标导出），
  //       只以退出码判定，标记 OBS，不参与断言计数
  //   exit code 始终是权威信号。
  //   本仓库实测存在**三种**摘要格式（全部都要认，否则全绿套件被判 NO-SUMMARY）：
  //     ① "59 PASS / 0 FAIL"            （run-learn-real-e2e、test-learn-core…）
  //     ② "44 pass, 0 fail"             （test-learn-ac5-gap-veto、stage85-twins…）
  //     ③ "PASS = 8  FAIL = 0"          （test-learn-plugin-contract）
  //   统一用一条交替正则，取**最后一条**摘要（多套件会在中途打印阶段性摘要）。
  const sumRe = /(?:(\d+)\s*PASS\s*\/\s*(\d+)\s*FAIL)|(?:(\d+)\s*pass\s*,\s*(\d+)\s*fail)|(?:PASS\s*=\s*(\d+)\s+FAIL\s*=\s*(\d+))/gi;
  let m2, last = null;
  while ((m2 = sumRe.exec(out)) !== null) last = m2;
  const isObs = /^redteam-/.test(f);
  let p = 0, fl = 0, kind = 'gated', summary = '';
  if (last) {
    p = Number(last[1] ?? last[3] ?? last[5]);
    fl = Number(last[2] ?? last[4] ?? last[6]);
    summary = last[0].trim();
  } else if (isObs) {
    kind = 'OBS';
  } else {
    kind = 'NO-SUMMARY';
    summary = 'no PASS/FAIL summary found in any known format';
  }
  if (r.error && r.error.code === 'ETIMEDOUT') { summary = `TIMEOUT after ${timeoutMs}ms`; fl = Math.max(fl, 1); }

  const ok = code === 0 && fl === 0 && kind !== 'NO-SUMMARY';
  results.push({ f, code, p, fl, ms, ok, kind, summary, tail: out.trim().split('\n').slice(-3).join(' | ') });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${f.padEnd(44)} ${String(p).padStart(4)}P/${String(fl).padStart(3)}F  exit=${String(code).padStart(4)}  ${kind.padEnd(11)} ${(ms / 1000).toFixed(1)}s`);
  if (!ok) console.log(`        ↳ ${summary || r.error?.message || ''}\n        ↳ ${results.at(-1).tail.slice(0, 300)}`);
}

const okAll = results.filter((r) => r.ok).length;
const bad = results.filter((r) => !r.ok);
const gated = results.filter((r) => r.kind === 'gated');
const obs = results.filter((r) => r.kind === 'OBS');
const totP = gated.reduce((a, r) => a + r.p, 0);
const totF = gated.reduce((a, r) => a + r.fl, 0);
console.log('');
console.log('='.repeat(78));
console.log(`套件：${okAll}/${results.length} 全绿    （门槛套件 ${gated.length} 个 / 观测套件 ${obs.length} 个）`);
console.log(`门槛断言：${totP} PASS / ${totF} FAIL   观测套件仅按退出码判定（无 pass/fail 门槛）`);
if (bad.length) console.log(`失败套件：${bad.map((r) => r.f).join(' , ')}`);
console.log('='.repeat(78));
process.exit(bad.length ? 1 : 0);
