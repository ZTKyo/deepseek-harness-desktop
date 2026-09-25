#!/usr/bin/env node
/**
 * P4 LEARN R2 / STAGE 8 —— 突变证明（mutation proof）
 *
 * 目的：证明「关键路径的门禁**真的在把关**」，而不是碰巧全绿。
 * 方法（每条不变量）：
 *   1) 在**源仓库**插件里植入一个最小缺陷（单行弱化）
 *   2) 跑该不变量对应的门禁套件 → 必须变红（否则门禁是空门禁）
 *   3) 从原始字节还原 → 校验 sha256 与突变前**逐字节一致**
 *   4) 再跑同一门禁 → 必须恢复全绿
 *
 * 安全：本脚本只改 _p4r2/plugins/*.mjs（源仓库副本），不触碰活服务已部署的
 *       ~/.dsh/profiles/web/*.mjs（独立文件，非硬链接）。每条突变均在
 *       try/finally 中还原，并在结束时做全局哈希自检。
 *
 * 用法：node stage8-mutation-proof.mjs
 * 退出码：0 = 全部突变均「植入即红、还原即绿」；1 = 有突变未被门禁捕获（真问题）
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '_p4r2');
const PRISTINE = join(HERE, 'pristine');
const OUT_JSON = join(HERE, 'stage8-mutation-proof.json');
const OUT_TXT = join(HERE, 'stage8-mutation-proof.txt');

mkdirSync(PRISTINE, { recursive: true });

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const readRaw = (rel) => readFileSync(join(ROOT, rel));
const hasBom = (buf) => buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

function writeRaw(rel, text, bom) {
  const body = Buffer.from(text, 'utf8');
  const out = bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  writeFileSync(join(ROOT, rel), out);
}

function runSuite(rel) {
  const r = spawnSync(process.execPath, [rel], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000,
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const lines = out.split(/\r?\n/);
  const verdict = lines.filter((l) => /FAIL|失败|Error|error|通过|PASS/.test(l)).slice(-3).join(' | ').trim();
  return { exit: r.status === null ? 'TIMEOUT/NULL' : r.status, tail: verdict.slice(0, 260) };
}

// ── 5 条关键不变量 + 6 个突变 ────────────────────────────────────────────────
const MUTATIONS = [
  {
    id: 'M1',
    invariant: 'AC5 假缺口守卫：Provider/网络/环境类失败不得生成 Candidate',
    file: 'plugins/learn-gap-veto.mjs',
    from: '  if (HARD_VETO_CLASSES.includes(classification)) {',
    to: '  if (false && HARD_VETO_CLASSES.includes(classification)) {',
    note: '停用硬否决集 → 网络/限流/额度类失败将不再被否决',
    gates: ['tests/learn/test-learn-ac5-gap-veto.mjs', 'tests/learn/test-learn-stage85-twins.mjs', 'tests/learn/run-learn-contract-scenarios.mjs'],
  },
  {
    id: 'M2',
    invariant: 'AC7 Stable 覆盖守卫：Candidate 永远不能直接写 Stable',
    file: 'plugins/learn-candidate.mjs',
    from: "    return { allowed: false, reason: 'ac7_direct_stable_overwrite_forbidden' };",
    to: "    return { allowed: true, reason: 'ac7_direct_stable_overwrite_forbidden' };",
    note: 'direct 模式改为放行 → 候选可直接覆盖 Stable',
    gates: ['tests/learn/test-learn-candidate.mjs', 'tests/learn/run-learn-contract-scenarios.mjs'],
  },
  {
    id: 'M3',
    invariant: 'Official Core 写保护：未 VERIFIED 的经验不得进入全局库（发布闸门）',
    file: 'plugins/learn-core.mjs',
    from: "  if (!ver || ver.status !== 'VERIFIED') return { ok: false, reason: `not_verified:${ver ? ver.status : 'missing'}` };",
    to: "  if (false) return { ok: false, reason: 'not_verified_disabled' };",
    note: '停用发布闸门的 VERIFIED 校验 → 未验证经验可发布',
    gates: ['tests/learn/test-learn-core.mjs', 'tests/learn/redteam-r3-contamination.mjs', 'tests/learn/run-learn-contract-scenarios.mjs'],
  },
  {
    id: 'M4',
    invariant: '密钥安全：含密钥的经验不得入库',
    file: 'plugins/learn-core.mjs',
    from: "  if (containsSecret(json)) return { ok: false, reason: 'contains_secret' };",
    to: "  if (false) return { ok: false, reason: 'contains_secret' };",
    note: '停用发布路径的密钥扫描 → 含 sk-/token 的经验可入库',
    gates: ['tests/learn/test-learn-r3-secrets.mjs', 'tests/learn/test-learn-core.mjs'],
  },
  {
    id: 'M5',
    invariant: '跨会话隔离：全局库校验必须 fail-closed（坏条目/未验证条目整体判废）',
    file: 'plugins/learn-core.mjs',
    from: '      if (!isPublishable(e)) return null;          // ★ 全局库**只**含已验证条目',
    to: '      if (false) return null;          // ★ 全局库**只**含已验证条目',
    note: '停用全局库逐条校验 → 未验证/外部条目可被接受',
    gates: ['tests/learn/test-learn-core.mjs', 'tests/learn/redteam-r3-isolation.mjs', 'tests/learn/redteam-r3-contamination.mjs'],
  },
  {
    id: 'M6',
    invariant: 'Failure Classification 权威唯一：分类值必须属于本 taxonomy，不得被绕过',
    file: 'plugins/learn-gap-veto.mjs',
    from: '  if (!KNOWN_CLASSES.includes(classification)) {',
    to: '  if (false && !KNOWN_CLASSES.includes(classification)) {',
    note: '停用未知分类否决 → 伪造/漂移的分类值可进入资格判定',
    gates: ['tests/learn/test-learn-ac5-gap-veto.mjs', 'tests/learn/test-learn-stage85-twins.mjs'],
  },
];

// ── 0. 固化 pristine 快照 + 基线全绿 ────────────────────────────────────────
const files = [...new Set(MUTATIONS.map((m) => m.file))];
const base = new Map();
for (const f of files) {
  const raw = readRaw(f);
  base.set(f, { hash: sha(raw), bom: hasBom(raw) });
  copyFileSync(join(ROOT, f), join(PRISTINE, f.split('/').pop()));
}

const log = [];
const say = (s) => { console.log(s); log.push(s); };

say('==== P4 LEARN R2 / STAGE 8 突变证明 ====');
say(`ROOT      = ${ROOT}`);
say(`PRISTINE  = ${PRISTINE}`);
say(`HEAD      = ${spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()}`);
say('');
say('--- 0. 基线：每条门禁在未突变时必须是绿的 ---');
const allGates = [...new Set(MUTATIONS.flatMap((m) => m.gates))];
const baseline = new Map();
for (const g of allGates) {
  const r = runSuite(g);
  baseline.set(g, r.exit);
  say(`  baseline ${r.exit === 0 ? 'GREEN' : 'RED!!'}  exit=${r.exit}  ${g}`);
}
const baseRed = allGates.filter((g) => baseline.get(g) !== 0);
if (baseRed.length) {
  say('');
  say(`!! 基线不是全绿（${baseRed.length} 个）：${baseRed.join(', ')} —— 突变证明的前提不成立，先修基线。`);
}

// ── 1..N 逐条突变 ───────────────────────────────────────────────────────────
const results = [];
for (const m of MUTATIONS) {
  say('');
  say(`--- ${m.id}  ${m.invariant}`);
  say(`    file=${m.file}  note=${m.note}`);
  const raw = readRaw(m.file);
  const before = sha(raw);
  const bom = hasBom(raw);
  const text = raw.toString('utf8').replace(/^\uFEFF/, '');
  const occurrences = text.split(m.from).length - 1;
  if (occurrences !== 1) {
    say(`    !! 突变锚点出现 ${occurrences} 次（应为 1）→ 跳过该突变`);
    results.push({ id: m.id, ok: false, reason: `anchor_occurrences_${occurrences}` });
    continue;
  }
  const rec = { id: m.id, invariant: m.invariant, file: m.file, note: m.note, anchorOccurrences: occurrences, gates: [] };
  try {
    writeRaw(m.file, text.replace(m.from, m.to), bom);
    const after = sha(readRaw(m.file));
    say(`    植入缺陷：sha ${before.slice(0, 12)} → ${after.slice(0, 12)}（字节已变 = ${before !== after}）`);
    for (const g of m.gates) {
      const r = runSuite(g);
      rec.gates.push({ gate: g, mutatedExit: r.exit, mutatedTail: r.tail });
      say(`    [突变后] ${r.exit !== 0 ? 'RED ✓' : 'GREEN ✗(门禁未捕获!)'}  exit=${r.exit}  ${g}`);
      if (r.exit !== 0) say(`              ↳ ${r.tail}`);
    }
  } finally {
    writeRaw(m.file, text, bom);
  }
  const restored = sha(readRaw(m.file));
  rec.restoredIdentical = restored === before;
  say(`    还原：sha ${restored.slice(0, 12)}（与突变前逐字节一致 = ${rec.restoredIdentical}）`);
  for (const g of m.gates) {
    const r = runSuite(g);
    const entry = rec.gates.find((x) => x.gate === g);
    entry.restoredExit = r.exit;
    entry.restoredTail = r.tail;
    say(`    [还原后] ${r.exit === 0 ? 'GREEN ✓' : 'RED ✗'}  exit=${r.exit}  ${g}`);
  }
  rec.caughtBy = rec.gates.filter((x) => x.mutatedExit !== 0).map((x) => x.gate);
  rec.allGreenAfterRestore = rec.gates.every((x) => x.restoredExit === 0);
  rec.ok = rec.caughtBy.length > 0 && rec.allGreenAfterRestore && rec.restoredIdentical;
  say(`    ⇒ ${m.id} ${rec.ok ? 'PASS（植入即红、还原即绿、字节无损）' : 'FAIL'}`);
  results.push(rec);
}

// ── 全局自检：所有被改文件必须与 pristine 一致 ──────────────────────────────
say('');
say('--- 全局字节自检（所有源文件必须回到 pristine 状态）---');
let allPristine = true;
for (const f of files) {
  const now = sha(readRaw(f));
  const same = now === base.get(f).hash;
  if (!same) allPristine = false;
  say(`  ${same ? 'OK  ' : 'DRIFT!!'} ${f}  ${now.slice(0, 12)}`);
}
const gitStatus = spawnSync('git', ['status', '--porcelain', '--', 'plugins'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
say(`  git status -- plugins = ${gitStatus === '' ? '(clean)' : gitStatus}`);

const okAll = results.every((r) => r.ok) && allPristine && gitStatus === '' && baseRed.length === 0;
say('');
say('==== 汇总 ====');
for (const r of results) {
  say(`  ${r.id}  ${r.ok ? 'PASS' : 'FAIL'}  被捕获于=${(r.caughtBy || []).map((s) => s.split('/').pop()).join(', ') || '(无)'}  还原后全绿=${r.allGreenAfterRestore}`);
}
say(`  突变总数=${MUTATIONS.length}  通过=${results.filter((r) => r.ok).length}  失败=${results.filter((r) => !r.ok).length}`);
say(`  源文件字节无损=${allPristine}  plugins 工作树干净=${gitStatus === ''}`);
say(`  结论 = ${okAll ? 'PASS：每条关键不变量都有真实门禁把关（植入缺陷必红）' : 'FAIL：存在未被门禁捕获的突变或还原不完整'}`);
say('==== END ====');

writeFileSync(OUT_JSON, JSON.stringify({
  at: new Date().toISOString(),
  root: ROOT,
  head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
  baseline: Object.fromEntries(baseline),
  results,
  allPristine,
  gitStatusClean: gitStatus === '',
  ok: okAll,
}, null, 2), 'utf8');
writeFileSync(OUT_TXT, log.join('\r\n'), 'utf8');

console.log(`\nEVIDENCE_JSON = ${OUT_JSON}`);
console.log(`EVIDENCE_TXT  = ${OUT_TXT}`);
process.exit(okAll ? 0 : 1);
