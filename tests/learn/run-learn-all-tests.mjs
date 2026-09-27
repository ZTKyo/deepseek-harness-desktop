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
const REPO = path.resolve(HERE, '..', '..');
// ★ 2026-09-27 修复：个别套件需要显式参数。此前一刀切不带参数 ⇒ mount-gate 报
//   "ENV_ERROR: 缺少 --plugin"，被汇总判成**产品失败**（假警报，掩盖真实门槛）。
// ★ 2026-09-28 修复（同类假警报，第三例）：deploy-preflight 必须显式给 --deploy 列表，
//   否则 exit 2 "[env error] 缺少 --deploy" 被汇总判成**产品失败**。本轮部署集合固定为
//   下列 4 个 learn 插件文件（与生产部署逐字节一致）。
const DEPLOY_SET = 'learn.mjs,learn-core.mjs,learn-candidate.mjs,learn-gap-veto.mjs';
const extraArgsFor = (f) => {
  if (f === 'mount-gate.mjs') return ['--plugin', path.join(REPO, 'plugins', 'learn.mjs')];
  if (f === 'deploy-preflight.mjs') return ['--deploy', DEPLOY_SET];
  return [];
};
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
  const r = spawnSync(process.execPath, [path.join(HERE, f), ...extraArgsFor(f)], {
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
  //   本仓库实测存在**四种**摘要格式（全部都要认，否则全绿套件被判 NO-SUMMARY）：
  //     ① "59 PASS / 0 FAIL"            （run-learn-real-e2e、test-learn-core…）
  //     ② "44 pass, 0 fail"             （test-learn-ac5-gap-veto、stage85-twins…）
  //     ③ "PASS = 8  FAIL = 0"          （test-learn-plugin-contract）
  //     ④ "结果：PASS 22 / FAIL 0"       （test-learn-b1-session-access —— 2026-09-27 补，
  //        此前该套件本体 exit 0 且 22P/0F，却因格式未识别被判 NO-SUMMARY，属**回归器假警报**）
  //   统一用一条交替正则，取**最后一条**摘要（多套件会在中途打印阶段性摘要）。
  const sumRe = /(?:(\d+)\s*PASS\s*\/\s*(\d+)\s*FAIL)|(?:(\d+)\s*pass\s*,\s*(\d+)\s*fail)|(?:PASS\s*=\s*(\d+)\s+FAIL\s*=\s*(\d+))|(?:结果[：:]\s*PASS\s*(\d+)\s*\/\s*FAIL\s*(\d+))/gi;
  let m2, last = null;
  while ((m2 = sumRe.exec(out)) !== null) last = m2;
  const isObs = /^redteam-/.test(f);
  let p = 0, fl = 0, kind = 'gated', summary = '';
  if (last) {
    p = Number(last[1] ?? last[3] ?? last[5] ?? last[7]);
    fl = Number(last[2] ?? last[4] ?? last[6] ?? last[8]);
    summary = last[0].trim();
  } else if (isObs) {
    kind = 'OBS';
  } else if (/VERDICT=(NEW_CODE_LOADED|OLD_CODE_STILL_LOADED)/.test(out)) {
    // ⑥ 装载判定套件（production-load-probe）：真实裁决行是 `VERDICT=NEW_CODE_LOADED`
    //    （无数字摘要）→ 折算 1/0。**这是真断言，不是放宽**：OLD_CODE_STILL_LOADED 仍判 FAIL。
    const loaded = /VERDICT=NEW_CODE_LOADED/.test(out);
    p = loaded ? 1 : 0; fl = loaded ? 0 : 1;
    kind = 'gated'; summary = `VERDICT=${loaded ? 'NEW_CODE_LOADED' : 'OLD_CODE_STILL_LOADED'}`;
  } else if (/verdict:\s*(PASS|FAIL)/i.test(out)) {
    // ⑤ 门套件以**文本裁决行**收尾（mount-gate：`--- verdict: PASS (expect=pass) ---`，
    //   无数字摘要）→ 用裁决词折算 1/0。仅在无数字摘要时启用（数字摘要是更强的口径），
    //   否则会把"某子项 verdict: PASS"误当整套件结论。
    const vm = out.match(/verdict:\s*(PASS|FAIL)/i);
    const passed = /^pass$/i.test(vm[1]);
    p = passed ? 1 : 0; fl = passed ? 0 : 1;
    kind = 'gated'; summary = `verdict=${vm[1].toUpperCase()}`;
  } else {
    kind = 'NO-SUMMARY';
    summary = 'no PASS/FAIL summary found in any known format';
  }
  if (r.error && r.error.code === 'ETIMEDOUT') { summary = `TIMEOUT after ${timeoutMs}ms`; fl = Math.max(fl, 1); }

  // ⑦ 环境前置未满足（exit 2 + env 字样）：既不是产品失败，也不能算通过 → 单列 ENV，
  //    退出码不受它影响，但报告里必须显式列出（不许静默吞掉）。
  //    实测两种字样：① deploy-preflight `[env error] 缺少 --deploy`（已在 extraArgsFor 修掉）；
  //    ② ac6-real-promotion-e2e `仓库有未提交改动，本测试要求先提交：`（真 git worktree 前置）。
  const envRe = /\[env error\]|环境不满足|ENV_ERROR|仓库有未提交改动|未提交改动，本测试要求/;
  if (code === 2 && envRe.test(out)) {
    kind = 'ENV'; fl = 0;
    summary = (out.match(/(?:\[env error\]|环境不满足|ENV_ERROR|仓库有未提交改动)[^\n]*/) ?? ['env precondition unmet'])[0].trim().slice(0, 200);
  }

  const ok = code === 0 && fl === 0 && kind !== 'NO-SUMMARY';
  results.push({ f, code, p, fl, ms, ok, kind, summary, tail: out.trim().split('\n').slice(-3).join(' | ') });
  console.log(`${ok ? '  PASS' : kind === 'ENV' ? '   ENV' : '  FAIL'}  ${f.padEnd(44)} ${String(p).padStart(4)}P/${String(fl).padStart(3)}F  exit=${String(code).padStart(4)}  ${kind.padEnd(11)} ${(ms / 1000).toFixed(1)}s`);
  if (!ok) console.log(`        ↳ ${summary || r.error?.message || ''}\n        ↳ ${results.at(-1).tail.slice(0, 300)}`);
}

const okAll = results.filter((r) => r.ok).length;
// ENV（环境前置未满足）单列：不计入"新失败"，也不计入"全绿"——报告里必须显式可见。
const env = results.filter((r) => r.kind === 'ENV');
const bad = results.filter((r) => !r.ok && r.kind !== 'ENV');
const gated = results.filter((r) => r.kind === 'gated');
const obs = results.filter((r) => r.kind === 'OBS');
const totP = gated.reduce((a, r) => a + r.p, 0);
const totF = gated.reduce((a, r) => a + r.fl, 0);
console.log('');
console.log('='.repeat(78));
console.log(`套件：${okAll}/${results.length} 全绿    （门槛套件 ${gated.length} 个 / 观测套件 ${obs.length} 个 / 环境前置未满足 ${env.length} 个）`);
console.log(`门槛断言：${totP} PASS / ${totF} FAIL   观测套件仅按退出码判定（无 pass/fail 门槛）`);
if (env.length) console.log(`环境前置未满足（非产品失败，需在满足前置的时机单独跑）：${env.map((r) => `${r.f}[${r.summary.slice(0, 60)}]`).join(' , ')}`);
if (bad.length) console.log(`失败套件：${bad.map((r) => r.f).join(' , ')}`);
console.log('='.repeat(78));
process.exit(bad.length ? 1 : 0);
