// redteam-r3-quality.mjs —— PHASE 04 LEARN R3 质量基线测量（只测量，不改逻辑）
//
// 回答：LEARN 抓到的 signals 里，有多少是真的应该学习的？
//
// 输出：
//   1. 真实会话全量 signal 抽取（复现 161→769 的 769）
//   2. 分层样本集（stratified）导出为 JSON，供人工逐条打标
//   3. duplicate 分析（exact / normalized / same-event）
//   4. candidate volume（signals per window、max、median、p95）
//   5. 污染面扫描（injection / transient / temporary-state / secret 形状）
//
// 只读真实会话；只在 os.tmpdir() 与 stdout 写结果；不触碰任何生产状态。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decodeLines } from '../../docs/roadmap/evidence/cm-r4-log-decoder.mjs';
import { buildLearnDigest, learningSignals, stripInjectedContent, redactSecrets, containsSecret } from '../../plugins/learn-core.mjs';

function section(t) { console.log(`\n=== ${t} ===`); }
const J = (o) => JSON.stringify(o);

// ─── 真实会话加载（与 E2E 同一解码器）────────────────────────────────────
function loadRealSession(file) {
  const { lines } = decodeLines(file);
  const events = [];
  const nodes = [];
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.type === 'session') continue;
    if (!Number.isInteger(o.seq)) continue;
    events[o.seq] = o;
    if (o.type === 'user/message' || o.type === 'assistant/message') nodes.push(o.seq);
  }
  nodes.sort((a, b) => a - b);
  return { file, events, nodes };
}

const SESSIONS_DIR = path.join(os.homedir(), '.dsh', 'sessions');
function listRealSessions() {
  const out = [];
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'session.jsonl.zstd') { try { out.push({ p, size: fs.statSync(p).size }); } catch {} }
    }
  };
  walk(SESSIONS_DIR);
  out.sort((a, b) => b.size - a.size);   // 最大优先（真实主会话）
  return out;
}

const MAIN = process.argv[2] || null;
const candidates = listRealSessions();
console.log(`real session candidates: ${candidates.length}`);
const target = MAIN || candidates[0].p;
console.log(`main real session: ${target}`);

const S = loadRealSession(target);
console.log(`surface nodes: ${S.nodes.length}, events: ${S.events.filter(Boolean).length}`);

// ─────────────────────────────────────────────────────────────
section("1. 全量 digest（复现 769 口径）");
const built = buildLearnDigest(S.events, S.nodes);
if (!built.ok) { console.error('digest failed: ' + built.error); process.exit(1); }
const D = built.digest;
console.log(`turnCount=${D.turnCount} injectedSkipped=${D.injectedSkipped} seqRange=${D.firstSeq}-${D.lastSeq}`);

const sig = learningSignals(D);
console.log(`signals=${sig.signals.length}  (R2 声明 769)`);
console.log(`kinds=${J(sig.kinds)}  resolved=${sig.resolved} unresolvedFailureSeqs=${sig.unresolvedFailureSeqs.length}`);

// ─────────────────────────────────────────────────────────────
section("2. signal 明细（每条：seq/role/kind/text）");
const bySeq = new Map(D.turns.map((t) => [t.seq, t]));
const ROWS = sig.signals.map((s) => {
  const t = bySeq.get(s.seq) || { text: '', role: '?' };
  const text = t.text || '';
  const stripped = stripInjectedContent(text);
  return {
    seq: s.seq,
    role: t.role || s.role,
    kind: s.kind,
    text,
    len: text.length,
    // 污染面标记（只标记，不判定）
    wasInjectionStripped: stripped.length !== text.length,
    looksTransient: /\b(ETIMEDOUT|ECONNRESET|429|500|502|503|504|rate.?limit|timeout|overload|DNS|EAI_AGAIN|socket hang up)\b/i.test(text),
    looksTemporaryState: /\b(pid\s*\d{2,}|port\s*\d{2,}|:\d{4,5}\b|[0-9a-f]{7,40}\b|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})/i.test(text),
    hasSecretShape: containsSecret(text),
    redactionChanged: redactSecrets(text) !== text,
  };
});
console.log(`rows=${ROWS.length}`);
const roleCount = {};
for (const r of ROWS) roleCount[r.role] = (roleCount[r.role] || 0) + 1;
console.log(`role 分布: ${J(roleCount)}`);
const kindCount = {};
for (const r of ROWS) kindCount[r.kind] = (kindCount[r.kind] || 0) + 1;
console.log(`kind 分布: ${J(kindCount)}`);
console.log(`污染面(只标记): transient=${ROWS.filter(r=>r.looksTransient).length} temporaryState=${ROWS.filter(r=>r.looksTemporaryState).length} secretShape=${ROWS.filter(r=>r.hasSecretShape).length} injectionStripped=${ROWS.filter(r=>r.wasInjectionStripped).length}`);

// ─────────────────────────────────────────────────────────────
section("3. Duplicate 分析");
const exact = new Map();
for (const r of ROWS) exact.set(r.text, (exact.get(r.text) || 0) + 1);
const exactDup = [...exact.entries()].filter(([, n]) => n > 1);
// normalized：去空白/大小写/标点后的文本
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[。，、！？；：“”‘’（）【】.,!?;:"'()\[\]]/g, '').trim();
const normMap = new Map();
for (const r of ROWS) { const k = norm(r.text); normMap.set(k, (normMap.get(k) || 0) + 1); }
const normDup = [...normMap.entries()].filter(([, n]) => n > 1);
// 同 kind + 同 normalized 文本（同语义事件重复）
const kindNorm = new Map();
for (const r of ROWS) { const k = r.kind + '||' + norm(r.text); kindNorm.set(k, (kindNorm.get(k) || 0) + 1); }
const kindDup = [...kindNorm.entries()].filter(([, n]) => n > 1);

console.log(`raw signals          : ${ROWS.length}`);
console.log(`unique exact text    : ${exact.size}   (exact-dup groups=${exactDup.length}, 冗余条数=${ROWS.length - exact.size})`);
console.log(`unique normalized    : ${normMap.size}   (norm-dup groups=${normDup.length}, 冗余条数=${ROWS.length - normMap.size})`);
console.log(`unique kind+norm     : ${kindNorm.size}   (kind-norm-dup groups=${kindDup.length}, 冗余条数=${ROWS.length - kindNorm.size})`);
console.log(`exact duplicate rate    : ${((1 - exact.size / ROWS.length) * 100).toFixed(1)}%`);
console.log(`normalized duplicate rate: ${((1 - normMap.size / ROWS.length) * 100).toFixed(1)}%`);
console.log(`semantic(kind+norm) dup rate: ${((1 - kindNorm.size / ROWS.length) * 100).toFixed(1)}%`);
if (exactDup.length) {
  console.log(`\n  top exact-dup 文本:`);
  exactDup.sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([t, n]) => console.log(`    x${n}  ${J(t.slice(0, 70))}`));
}

// ─────────────────────────────────────────────────────────────
section("4. Candidate volume（按插件的窗口口径模拟）");
// 插件口径：每批新节点（minNewNodes..maxDigestTurns）产出一条候选
const cfgWindows = [8, 16, 32, 64];
for (const w of cfgWindows) {
  let windows = 0, totalSig = 0, maxSig = 0;
  const per = [];
  for (let i = 0; i + w <= S.nodes.length; i += w) {
    const win = S.nodes.slice(i, i + w);
    const b = buildLearnDigest(S.events, win);
    if (!b.ok) continue;
    const s = learningSignals(b.digest);
    windows++;
    per.push(s.signals.length);
    totalSig += s.signals.length;
    if (s.signals.length > maxSig) maxSig = s.signals.length;
  }
  if (!windows) continue;
  per.sort((a, b) => a - b);
  const median = per[Math.floor(per.length / 2)];
  const p95 = per[Math.min(per.length - 1, Math.floor(per.length * 0.95))];
  console.log(`window=${String(w).padStart(3)}  windows=${String(windows).padStart(4)}  signals/session=${String(totalSig).padStart(5)}  candidates/session=${windows}  sig/window: max=${maxSig} median=${median} p95=${p95}`);
}

// ─────────────────────────────────────────────────────────────
section("5. 分层抽样（stratified sampling）");
// 分层维度：kind × 语言 × 长度 × role × 污染标记 × 重复性
function langOf(t) {
  const hasCJK = /[\u4e00-\u9fff]/.test(t);
  const hasLatin = /[A-Za-z]{3,}/.test(t);
  if (hasCJK && hasLatin) return 'mixed';
  if (hasCJK) return 'cjk';
  if (hasLatin) return 'latin';
  return 'other';
}
for (const r of ROWS) {
  r.lang = langOf(r.text);
  r.lenBucket = r.len < 60 ? 'short' : r.len < 300 ? 'medium' : 'long';
  r.dupCount = exact.get(r.text);
  r.isDup = r.dupCount > 1;
}
const strata = new Map();
for (const r of ROWS) {
  const k = `${r.kind}|${r.lang}|${r.lenBucket}|${r.role}|${r.isDup ? 'dup' : 'uniq'}`;
  if (!strata.has(k)) strata.set(k, []);
  strata.get(k).push(r);
}
console.log(`strata 数: ${strata.size}`);
const keys = [...strata.keys()].sort();
for (const k of keys) console.log(`  ${String(strata.get(k).length).padStart(4)}  ${k}`);

// 每层最多取 N 条，尽量覆盖全部层 → 分层样本
const PER_STRATUM = Number(process.env.R3_PER_STRATUM || 6);
const TARGET_N = Number(process.env.R3_SAMPLE_N || 120);
const sample = [];
// 轮转取样，保证小层也能进入
const sorted = keys.map((k) => ({ k, arr: [...strata.get(k)].sort((a, b) => a.seq - b.seq) }));
let round = 0;
while (sample.length < TARGET_N && round < PER_STRATUM) {
  for (const s of sorted) {
    if (sample.length >= TARGET_N) break;
    if (s.arr[round]) sample.push({ stratum: s.k, ...s.arr[round] });
  }
  round++;
}
sample.sort((a, b) => a.seq - b.seq);
console.log(`\n分层样本数: ${sample.length} (target=${TARGET_N}, perStratum<=${PER_STRATUM})`);
console.log(`样本覆盖层数: ${new Set(sample.map((s) => s.stratum)).size} / ${strata.size}`);

// ─────────────────────────────────────────────────────────────
section("6. 导出样本集（供人工打标）");
const outDir = path.join(os.homedir(), 'Desktop', 'sdeepseek harness', '_r3');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'r3_quality_sample.json');
const payload = {
  generatedAt: new Date().toISOString(),
  session: target,
  sessionNodes: S.nodes.length,
  digestTurnCount: D.turnCount,
  totalSignals: ROWS.length,
  strataCount: strata.size,
  sampleSize: sample.length,
  duplicate: {
    raw: ROWS.length,
    uniqueExact: exact.size,
    uniqueNormalized: normMap.size,
    uniqueKindNormalized: kindNorm.size,
  },
  sample: sample.map((s) => ({
    seq: s.seq,
    role: s.role,
    predicted_label: s.kind,
    stratum: s.stratum,
    lang: s.lang,
    lenBucket: s.lenBucket,
    isDup: s.isDup,
    dupCount: s.dupCount,
    looksTransient: s.looksTransient,
    looksTemporaryState: s.looksTemporaryState,
    hasSecretShape: s.hasSecretShape,
    text: s.text.slice(0, 600),
  })),
};
fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
console.log(`written: ${outFile}  (${sample.length} rows)`);

console.log("\n=== R3 quality measurement complete ===");
