#!/usr/bin/env node
/**
 * P4 LEARN R2 / STAGE 8b —— 第二轮突变：**层破除**（layer-defeating）
 *
 * 背景：第一轮（stage8-mutation-proof.mjs）显示 M3/M4/M5/M6 未被任何套件捕获。
 * 但"未被捕获"有两种截然不同的原因，必须区分，否则结论会是错的：
 *   (a) 真覆盖缺口 —— 代码有防线，但没有任何测试证明它会开火；
 *   (b) 等价突变   —— 该防线在别处还有第二层兜底，停用单层不改变外部行为。
 * 第一轮的突变是"单行弱化"，无法区分二者。本轮改用**层破除**突变（直接让整层失效），
 * 并在进程内做行为探针，得到确定答案。
 *
 * 本轮不含任何永久改动：每条突变均在 try/finally 中从原始字节还原。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '_p4r2');
const PRISTINE = join(HERE, 'pristine');
const SUFFIX = process.env.OUT_SUFFIX || '';
const OUT_JSON = join(HERE, `stage8b-mutation-round2${SUFFIX}.json`);
const OUT_TXT = join(HERE, `stage8b-mutation-round2${SUFFIX}.txt`);
mkdirSync(PRISTINE, { recursive: true });

const sha = (b) => createHash('sha256').update(b).digest('hex');
const abs = (rel) => join(ROOT, rel);
const readRaw = (rel) => readFileSync(abs(rel));
const nlOf = (t) => (t.includes('\r\n') ? '\r\n' : '\n');
const hasBom = (b) => b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;

function applyEdits(text, edits, nl) {
  let t = text;
  for (const e of edits) {
    const from = e.from.join('\n');
    const to = e.to.join('\n');
    const n = t.split(from).length - 1;
    if (n !== 1) return { ok: false, why: `anchor_occurrences_${n}`, anchor: from.slice(0, 60) };
    t = t.replace(from, to);
  }
  return { ok: true, text: nl === '\r\n' ? t.replace(/\r?\n/g, '\r\n') : t.replace(/\r\n/g, '\n') };
}

function runSuite(rel) {
  const r = spawnSync(process.execPath, [rel], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const tail = out.split(/\r?\n/).filter((l) => /FAIL|失败|Error/.test(l)).slice(-2).join(' | ').trim();
  return { exit: r.status, tail: tail.slice(0, 200) };
}

/** 进程内行为探针：绕开 ESM 缓存，直接看突变后的真实行为。 */
async function probe(rel, code) {
  const url = `${pathToFileURL(abs(rel)).href}?v=${Date.now()}`;
  const script = `
    import * as m from ${JSON.stringify(url)};
    ${code}
  `;
  const tmp = join(HERE, `_probe-${Date.now()}.mjs`);
  writeFileSync(tmp, script, 'utf8');
  const r = spawnSync(process.execPath, [tmp], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  try { spawnSync(process.execPath, ['-e', 'require("fs").unlinkSync(process.argv[1])', tmp]); } catch {}
  try { writeFileSync(tmp, ''); } catch {}
  return `${(r.stdout || '').trim()}${(r.stderr || '').trim() ? ' ERR:' + (r.stderr || '').trim().split('\n')[0] : ''}`;
}

const GATES = [
  'tests/learn/test-learn-core.mjs',
  'tests/learn/test-learn-r3-secrets.mjs',
  'tests/learn/redteam-r3-contamination.mjs',
  'tests/learn/redteam-r3-isolation.mjs',
  'tests/learn/test-learn-ac5-gap-veto.mjs',
];

// ── 层破除突变（每条 = 让一整层防线失效）───────────────────────────────────
const MUTATIONS = [
  {
    id: 'M3b',
    invariant: 'AC：未 VERIFIED 的经验不得进全局库（发布闸门 canPublish 整层失效）',
    file: 'plugins/learn-core.mjs',
    edits: [{
      from: ['export function canPublish(exp) {'],
      to: ["export function canPublish(exp) {", "  return { ok: true, reason: 'mutant_layer_defeated' };"],
    }],
    probe: `
      const exp = { id:'x1', state:'PROPOSED', verification:{ status:'UNVERIFIED' }, lastVerifiedAt:0, sourceEventSeqs:[] };
      console.log('canPublish(PROPOSED/UNVERIFIED).ok = ' + m.canPublish(exp).ok + '  reason=' + m.canPublish(exp).reason);
    `,
  },
  {
    id: 'M4b',
    invariant: '密钥安全：密钥扫描整层失效（containsSecret 永远返回 false）',
    file: 'plugins/learn-core.mjs',
    edits: [{
      from: ['export function containsSecret(text) {'],
      to: ['export function containsSecret(text) {', '  return false;'],
    }],
    probe: `
      const fake = { id:'x1', state:'VERIFIED_EXPERIENCE', title:'t', successfulMethod:'m',
        verification:{ status:'VERIFIED', method:'TEST', evidence:{} }, lastVerifiedAt:1, sourceEventSeqs:[1],
        body: 'sk-' + 'live_' + 'A'.repeat(24) };
      console.log('canPublish(经验体含假密钥).ok = ' + m.canPublish(fake).ok + '  reason=' + m.canPublish(fake).reason);
      console.log('containsSecret(假密钥) = ' + m.containsSecret(fake.body));
    `,
  },
  {
    id: 'M5b',
    invariant: '跨会话隔离：全局库校验整层失效（validateGlobalStore 直接放行）',
    file: 'plugins/learn-core.mjs',
    edits: [{
      from: ['export function validateGlobalStore(raw) {'],
      to: ['export function validateGlobalStore(raw) {', '  return raw;'],
    }],
    probe: `
      const bad = { schemaVersion: 999, kind: 'wrong', version: 1, experiences: [{ id:'a', state:'PROPOSED' }], telemetry: [] };
      console.log('validateGlobalStore(坏库) !== null = ' + (m.validateGlobalStore(bad) !== null));
      const unver = { schemaVersion: 2, kind: 'dsh-learn-global', version: 1, experiences: [{ id:'u', state:'APPROVED', verification:{ status:'UNVERIFIED' }, lastVerifiedAt:1, sourceEventSeqs:[1] }], telemetry: [] };
      console.log('validateGlobalStore(含未验证条目) !== null = ' + (m.validateGlobalStore(unver) !== null));
    `,
  },
  {
    id: 'M6b',
    invariant: 'Failure Classification 权威唯一：伪造分类不得进入资格判定（两处防线同时破除）',
    file: 'plugins/learn-gap-veto.mjs',
    edits: [
      { from: ['  if (!KNOWN_CLASSES.includes(classification)) {'], to: ['  if (false && !KNOWN_CLASSES.includes(classification)) {'] },
      {
        from: ['  // 理论上不可达（KNOWN_CLASSES 已穷尽）；保守起见仍否决', '  return base(true, VETO_REASON.UNKNOWN_CLASS, classification, signature, tv);'],
        to: ['  // 理论上不可达（KNOWN_CLASSES 已穷尽）；保守起见仍否决', '  return base(false, VETO_REASON.NOT_VETOED, classification, signature, tv);'],
      },
    ],
    probe: `
      const r = m.evaluateClassifiedRecord({ classification: 'TOTALLY_FORGED_CLASS', normalizedSignature:'s', taxonomyVersion: 1 }, {});
      console.log('伪造分类 vetoed = ' + r.vetoed + '  reason=' + r.reason);
    `,
  },
];

const log = [];
const say = (s) => { console.log(s); log.push(s); };

say('==== P4 LEARN R2 / STAGE 8b 第二轮突变（层破除）====');
say(`ROOT = ${ROOT}`);
say(`HEAD = ${spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()}`);
say('');
say('--- 基线 ---');
const baseline = {};
for (const g of GATES) { baseline[g] = runSuite(g).exit; say(`  ${baseline[g] === 0 ? 'GREEN' : 'RED!!'} exit=${baseline[g]}  ${g}`); }

const results = [];
for (const m of MUTATIONS) {
  say('');
  say(`--- ${m.id}  ${m.invariant}`);
  const raw = readRaw(m.file);
  const before = sha(raw);
  const bom = hasBom(raw);
  const text0 = raw.toString('utf8').replace(/^\uFEFF/, '');
  const nl = nlOf(text0);
  const res = applyEdits(text0, m.edits, nl);
  if (!res.ok) { say(`    !! 锚点问题：${res.why} (${res.anchor}) → 跳过`); results.push({ id: m.id, ok: false, reason: res.why }); continue; }

  const rec = { id: m.id, invariant: m.invariant, file: m.file, gates: [] };
  try {
    writeFileSync(abs(m.file), Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(res.text, 'utf8')]));
    rec.bytesChanged = sha(readRaw(m.file)) !== before;
    say(`    植入（层破除）：字节已变 = ${rec.bytesChanged}`);
    if (m.probe) {
      const out = await probe(m.file, m.probe);
      rec.probeOutput = out;
      say(`    行为探针：${out.replace(/\n/g, ' || ')}`);
    }
    for (const g of GATES) {
      const r = runSuite(g);
      rec.gates.push({ gate: g, mutatedExit: r.exit, tail: r.tail });
      say(`    [突变后] ${r.exit !== 0 ? 'RED ✓' : 'green'}  exit=${r.exit}  ${g.split('/').pop()}`);
    }
  } finally {
    writeFileSync(abs(m.file), raw);
  }
  const restored = sha(readRaw(m.file));
  rec.restoredIdentical = restored === before;
  say(`    还原：逐字节一致 = ${rec.restoredIdentical}`);
  for (const g of GATES) {
    const r = runSuite(g);
    rec.gates.find((x) => x.gate === g).restoredExit = r.exit;
  }
  rec.caughtBy = rec.gates.filter((x) => x.mutatedExit !== 0).map((x) => x.gate);
  rec.behaviorChanged = /vetoed = false|\.ok = true|!== null = true|containsSecret\(假密钥\) = false/.test(rec.probeOutput || '');
  rec.verdict = rec.caughtBy.length > 0
    ? 'CAUGHT（门禁真实开火）'
    : (rec.behaviorChanged ? 'GAP（行为确实被破坏，但无任何套件发现）' : 'EQUIVALENT（行为未变 ⇒ 该层有第二层兜底）');
  say(`    ⇒ ${m.id}：${rec.verdict}${rec.caughtBy.length ? ' 被捕获于 ' + rec.caughtBy.map((s) => s.split('/').pop()).join(', ') : ''}`);
  results.push(rec);
}

const allPristine = ['plugins/learn-core.mjs', 'plugins/learn-gap-veto.mjs'].every((f) => {
  const p = join(PRISTINE, f.split('/').pop());
  return !existsSync(p) || sha(readRaw(f)) === sha(readFileSync(p));
});
const gs = spawnSync('git', ['status', '--porcelain', '--', 'plugins'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();

say('');
say('==== 第二轮汇总 ====');
for (const r of results) say(`  ${r.id}  ${r.verdict || r.reason}${r.caughtBy && r.caughtBy.length ? '  ← ' + r.caughtBy.map((s) => s.split('/').pop()).join(',') : ''}`);
say(`  源文件字节无损=${allPristine}  plugins 工作树干净=${gs === ''}`);
say(`  结论：${results.filter((r) => /GAP/.test(r.verdict || '')).length} 条为真覆盖缺口，`
  + `${results.filter((r) => /EQUIVALENT/.test(r.verdict || '')).length} 条为等价突变（有多层兜底），`
  + `${results.filter((r) => /CAUGHT/.test(r.verdict || '')).length} 条已被现有门禁捕获`);
say('==== END ====');

writeFileSync(OUT_JSON, JSON.stringify({ at: new Date().toISOString(), root: ROOT, baseline, results, allPristine, gitPluginsClean: gs === '' }, null, 2), 'utf8');
writeFileSync(OUT_TXT, log.join('\r\n'), 'utf8');
console.log(`\nEVIDENCE_JSON = ${OUT_JSON}\nEVIDENCE_TXT  = ${OUT_TXT}`);
