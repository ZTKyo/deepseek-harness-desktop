// redteam-r3-metrics.mjs —— 由人工标签计算 R3 真实质量指标（可复算）
//
// 输入：_r3/r3_quality_sample.json（分层样本，由 redteam-r3-quality.mjs 产出）
//       tests/learn/redteam-r3-labels.mjs（人工 ground truth）
// 输出：precision / per-label precision / language precision / contamination / duplicate

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LABELS } from './redteam-r3-labels.mjs';

const SAMPLE = path.join(os.homedir(), 'Desktop', 'sdeepseek harness', '_r3', 'r3_quality_sample.json');
const p = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
const rows = p.sample;

const pct = (n, d) => d === 0 ? 'N/A' : `${((n / d) * 100).toFixed(1)}%`;
function section(t) { console.log(`\n=== ${t} ===`); }

// 完整性检查：每条样本都必须有标签
const missing = rows.map((_, i) => i).filter((i) => !LABELS[i]);
if (missing.length) { console.error(`FATAL: 未打标样本下标 ${missing.join(',')}`); process.exit(1); }
const extra = Object.keys(LABELS).map(Number).filter((i) => i >= rows.length);
if (extra.length) { console.error(`FATAL: 标签下标越界 ${extra.join(',')}`); process.exit(1); }

console.log(`sample size      : ${rows.length}`);
console.log(`labels present   : ${Object.keys(LABELS).length} / ${rows.length}`);
console.log(`session nodes    : ${p.sessionNodes}`);
console.log(`total signals    : ${p.totalSignals}`);

const L = (i) => LABELS[i];

// ─────────────────────────────────────────────────────────────
section("1. Overall precision");
const yes = rows.map((_, i) => i).filter((i) => L(i).should_learn === 'yes');
const unc = rows.map((_, i) => i).filter((i) => L(i).should_learn === 'uncertain');
const no = rows.map((_, i) => i).filter((i) => L(i).should_learn === 'no');
console.log(`should_learn=yes       : ${yes.length}  -> precision(严格) = ${yes.length}/${rows.length} = ${pct(yes.length, rows.length)}`);
console.log(`should_learn=uncertain : ${unc.length}`);
console.log(`should_learn=no        : ${no.length}`);
console.log(`precision(宽口径, yes+uncertain) = ${yes.length + unc.length}/${rows.length} = ${pct(yes.length + unc.length, rows.length)}`);
console.log(`false-positive rate(严格, 判为 no 的比例) = ${pct(no.length, rows.length)}`);

// ─────────────────────────────────────────────────────────────
section("2. Per-label precision（预测标签 vs 人工正确标签）");
const kinds = [...new Set(rows.map((r) => r.predicted_label))].sort();
for (const k of kinds) {
  const idx = rows.map((_, i) => i).filter((i) => rows[i].predicted_label === k);
  const ok = idx.filter((i) => L(i).correct_label === k);
  const learnable = idx.filter((i) => L(i).should_learn === 'yes');
  console.log(`\n  predicted=${k}  样本 ${idx.length}`);
  console.log(`    标签正确(correct_label===${k}) : ${ok.length}/${idx.length} = ${pct(ok.length, idx.length)}`);
  console.log(`    值得学习(should_learn=yes)    : ${learnable.length}/${idx.length} = ${pct(learnable.length, idx.length)}`);
  // 混淆：人工认为实际是什么
  const dist = {};
  for (const i of idx) { const c = L(i).correct_label; dist[c] = (dist[c] || 0) + 1; }
  console.log(`    人工实际标签分布: ${JSON.stringify(dist)}`);
}

// ─────────────────────────────────────────────────────────────
section("3. Language precision（中文召回提升后，精度是否下降？）");
for (const lg of ['cjk', 'latin', 'mixed']) {
  const idx = rows.map((_, i) => i).filter((i) => rows[i].lang === lg);
  if (!idx.length) { console.log(`  ${lg.padEnd(6)} : 样本不足 (0) — NOT ENOUGH EVIDENCE`); continue; }
  const ok = idx.filter((i) => L(i).should_learn === 'yes');
  const okU = idx.filter((i) => L(i).should_learn !== 'no');
  console.log(`  ${lg.padEnd(6)} n=${String(idx.length).padStart(3)}  precision(严格)=${pct(ok.length, idx.length).padStart(6)}  precision(宽)=${pct(okU.length, idx.length).padStart(6)}`);
}
// 会话整体语言分布（加权，回答"中文恢复后精度"）
section("3b. 语言分布（全量 signals，非样本）");

// ─────────────────────────────────────────────────────────────
section("4. Contamination rate");
const contam = rows.map((_, i) => i).filter((i) => L(i).contamination === 'yes');
console.log(`contamination=yes : ${contam.length}/${rows.length} = ${pct(contam.length, rows.length)}`);
const cdist = {};
for (const i of contam) cdist[rows[i].role] = (cdist[rows[i].role] || 0) + 1;
console.log(`  污染条目 role 分布: ${JSON.stringify(cdist)}`);
console.log(`  污染下标: ${contam.join(',')}`);

// ─────────────────────────────────────────────────────────────
section("5. Duplicate rate（人工判定：同语义事件重复）");
const dup = rows.map((_, i) => i).filter((i) => L(i).duplicate === 'yes');
console.log(`duplicate=yes(人工) : ${dup.length}/${rows.length} = ${pct(dup.length, rows.length)}`);
console.log(`  重复下标: ${dup.join(',')}`);
console.log(`\n  脚本侧（全量 signals 口径）: raw=${p.duplicate.raw} uniqueExact=${p.duplicate.uniqueExact} uniqueNormalized=${p.duplicate.uniqueNormalized} uniqueKindNorm=${p.duplicate.uniqueKindNormalized}`);
console.log(`  exact-dup rate=${pct(p.duplicate.raw - p.duplicate.uniqueExact, p.duplicate.raw)}  normalized-dup rate=${pct(p.duplicate.raw - p.duplicate.uniqueNormalized, p.duplicate.raw)}`);

// ─────────────────────────────────────────────────────────────
section("6. Role-based quality（assistant 自污染）");
for (const role of ['user', 'assistant']) {
  const idx = rows.map((_, i) => i).filter((i) => rows[i].role === role);
  if (!idx.length) { console.log(`  ${role}: 0`); continue; }
  const ok = idx.filter((i) => L(i).should_learn === 'yes');
  const cu = idx.filter((i) => L(i).contamination === 'yes');
  console.log(`  ${role.padEnd(9)} n=${String(idx.length).padStart(3)}  precision=${pct(ok.length, idx.length).padStart(6)}  contamination=${pct(cu.length, idx.length).padStart(6)}`);
}

// ─────────────────────────────────────────────────────────────
section("7. 污染面交叉（transient / temporary-state 标记的样本其质量）");
for (const flag of ['looksTransient', 'looksTemporaryState']) {
  const idx = rows.map((_, i) => i).filter((i) => rows[i][flag]);
  const ok = idx.filter((i) => L(i).should_learn === 'yes');
  console.log(`  ${flag.padEnd(20)} n=${String(idx.length).padStart(3)}  should_learn=yes ${ok.length} (${pct(ok.length, idx.length)})`);
}

console.log("\n=== R3 metrics complete ===");
