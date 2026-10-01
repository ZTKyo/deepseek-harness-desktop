#!/usr/bin/env node
// check-doc-anchors.mjs — D 门：把"手写行号指针"换成**可机检锚点**。
//
// 背景（P4 External Review R1 Finding D，2026-10-01）：
//   文档里的 `L33` / `A10_CONTRACT_MATRIX.md:33` 这类**手写行号指针**会随文档改动整体偏移
//   （实测：A10 更正表标注的行号整体 +34），而没有任何门能发现 —— 指针"看着还在"，
//   却已经不指向所引原文。行号是**派生数据**，不该由人手写。
//
// 本门做两件事：
//   1. **解析锚点**：注册表 `docs/roadmap/P4_STATUS.json` 的 `docAnchors` 里，每条锚点用
//      「文档 + 标题/行内唯一文本/代码标识」定位，由本工具**当场算出真实行号**并打印。
//      锚点缺失或不再唯一 ⇒ FAIL（fail-closed），防止"删了原文锚点却没人发现"。
//   2. **禁回手写行号**：`linePointerBans` 指定"某区块/某一行不得再出现行号指针"，
//      命中即 FAIL —— 这是把 D 的修复**锁住**（否则下次有人又写 L33，门不会响）。
//
// 用法：
//   node tools/check-doc-anchors.mjs           # 人类可读
//   node tools/check-doc-anchors.mjs --json    # 机读
//   node tools/check-doc-anchors.mjs --census  # 追加"全仓行号指针普查"（只报告，不改变退出码）
// 退出码：0 = 全过；1 = 有 FAIL（fail-closed）。
//
// 安全：只读文件；不写任何东西；不联网；不打印文件内容以外的敏感值。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const INDEX_PATH = path.isAbsolute(argOf('--registry', ''))
  ? argOf('--registry', '')
  : path.join(ROOT, argOf('--registry', 'docs/roadmap/P4_STATUS.json'));
const AS_JSON = process.argv.includes('--json');
const CENSUS = process.argv.includes('--census');
// 冻结行判据：HEAD 行必须是新行的**严格前缀**才算"历史文本"。极短前缀会让判据失真
// （一个孤立的 `>`/`---` 曾把负控注入的新行误判为历史 —— 见 tests/roadmap 的负控测试）。
const MIN_FROZEN_PREFIX_LEN = 8;

const die = (msg) => {
  console.log(`DOC ANCHORS: FAILED\n  - ${msg}`);
  process.exit(1);
};

if (!fs.existsSync(INDEX_PATH)) die(`registry missing: ${path.relative(ROOT, INDEX_PATH)}`);
let idx;
try {
  idx = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
} catch (e) {
  die(`registry is not valid JSON: ${e.message}`);
}

const anchors = Array.isArray(idx.docAnchors) ? idx.docAnchors : [];
const bans = Array.isArray(idx.linePointerBans) ? idx.linePointerBans : [];
if (anchors.length === 0) die('registry declares no docAnchors (nothing to check = not a gate)');

const results = [];
const banResults = [];

function readLines(rel) {
  // 相对路径按仓库根解析；绝对路径原样使用（负控测试用临时 fixture 走这条路）
  const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8').split(/\r?\n/);
}

// ── 1. 锚点解析 ─────────────────────────────────────────────────────────────
for (const a of anchors) {
  const label = a.id || '(missing id)';
  const rec = { id: label, file: a.file, kind: a.kind, value: a.value, ok: false, line: null, detail: '' };
  if (!a.file || !a.value || !a.kind) {
    rec.detail = 'anchor must declare file + kind + value';
    results.push(rec);
    continue;
  }
  const lines = readLines(a.file);
  if (lines === null) {
    rec.detail = 'file missing';
    results.push(rec);
    continue;
  }
  const hits = [];
  lines.forEach((ln, i) => {
    if (a.kind === 'heading') {
      // 标题锚点：允许被引用块包裹（`> ### 标题` 也是合法标题——本仓库历史文档大量这样写）
      if (/^\s*(>\s*)*#{1,6}\s/.test(ln) && ln.includes(a.value)) hits.push(i + 1);
    } else if (a.kind === 'line') {
      if (ln.includes(a.value)) hits.push(i + 1);
    } else if (a.kind === 'code') {
      if (ln.includes(a.value)) hits.push(i + 1);
    }
  });
  if (hits.length === 0) {
    rec.detail = `anchor does not resolve (${a.kind}: "${a.value}")`;
  } else if (hits.length > 1 && a.unique !== false) {
    rec.detail = `anchor is not unique: ${hits.length} matches at L${hits.join(', L')}`;
  } else {
    rec.ok = true;
    rec.line = hits[0];
    rec.detail = hits.length > 1 ? `${hits.length} matches (unique:false allowed)` : 'resolved';
  }
  results.push(rec);
}

// ── 2. 手写行号指针禁令（只罚**新写入**的行号；历史冻结行豁免） ──────────────
// 判据（三段式，缺一即 FAIL）：
//   命中 banPattern  且  不是 git HEAD 的冻结文本（append-only：HEAD 行 + 行尾追加 = 冻结）
//   且  没有同时给出锚点（requireAnchorPattern）
// 这样既能锁住"今后不许再手写行号"，又不逼着人改写历史（D1 纪律：只标注、不改写）。
function frozenLines(rel) {
  const r = spawnSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  return r.stdout.split(/\r?\n/).filter((l) => l.length > 0);
}

function blockSlice(lines, fromHeading, toHeading) {
  const start = lines.findIndex((ln) => ln.includes(fromHeading));
  if (start < 0) return null;
  let end = lines.length;
  if (toHeading) {
    const e = lines.findIndex((ln, i) => i > start && ln.includes(toHeading));
    if (e > start) end = e;
  }
  return { start: start + 1, end, lines: lines.slice(start, end) };
}

for (const b of bans) {
  const label = b.id || '(missing id)';
  const rec = { id: label, file: b.file, ok: false, detail: '', hits: [], frozen: 0, exempt: 0 };
  if (!b.file || !b.banPattern) {
    rec.detail = 'ban must declare file + banPattern';
    banResults.push(rec);
    continue;
  }
  const lines = readLines(b.file);
  if (lines === null) {
    rec.detail = 'file missing';
    banResults.push(rec);
    continue;
  }
  let re;
  let anchorRe = null;
  try {
    re = new RegExp(b.banPattern);
    if (b.requireAnchorPattern) anchorRe = new RegExp(b.requireAnchorPattern);
  } catch (e) {
    rec.detail = `invalid pattern: ${e.message}`;
    banResults.push(rec);
    continue;
  }
  const frozen = b.frozenExempt ? frozenLines(b.file) : null;
  if (b.frozenExempt && frozen === null) {
    rec.detail = 'frozenExempt requested but `git show HEAD:<file>` failed (cannot prove what is history)';
    banResults.push(rec);
    continue;
  }
  const isFrozen = (ln) => Array.isArray(frozen)
    && frozen.some((h) => h.length >= MIN_FROZEN_PREFIX_LEN && ln.startsWith(h));
  let scan = null;
  if (b.fromHeading) {
    scan = blockSlice(lines, b.fromHeading, b.toHeading);
    if (scan === null) {
      rec.detail = `block heading not found: "${b.fromHeading}"`;
      banResults.push(rec);
      continue;
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    if (scan) {
      if (lineNo < scan.start || lineNo > scan.end) continue;
    } else if (b.containing && !lines[i].includes(b.containing)) continue;
    if (!re.test(lines[i])) continue;
    if (isFrozen(lines[i])) { rec.frozen++; continue; }
    if (anchorRe && anchorRe.test(lines[i])) { rec.exempt++; continue; }
    rec.hits.push({ line: lineNo, text: lines[i].trim().slice(0, 160) });
  }
  rec.ok = rec.hits.length === 0;
  rec.detail = rec.ok
    ? `no new hand-written line pointer (frozen history lines exempted: ${rec.frozen}, anchor-bearing: ${rec.exempt})`
    : `${rec.hits.length} new hand-written line pointer(s) without an anchor`;
  banResults.push(rec);
}

// ── 2.5 可选普查（--census）：全仓"手写行号指针"候选统计 ─────────────────────
// 目的：**衡量 D 的真实范围**，而不是把范围缩小到"只剩两处禁令"就算完。
// 本段是启发式只读统计，**永远不参与判定、不改变退出码**（判定仍由上面的锚点/禁令负责）。
const censusRows = [];
let censusTotal = 0;
let censusScanned = 0;
if (CENSUS) {
  const ls = spawnSync('git', ['ls-files', 'docs/**/*.md'], { cwd: ROOT, encoding: 'utf8' });
  const files = (ls.stdout || '').split(/\r?\n/).filter(Boolean);
  const CENSUS_RE = /\bL\d{2,4}\b|`[^`\s]*\.(?:md|mjs|js|json|ya?ml|ps1|csv|txt):\d+|第\s*\d{1,4}\s*行/g;
  censusScanned = files.length;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    const m = text.match(CENSUS_RE);
    if (m && m.length) { censusRows.push({ file: f, n: m.length }); censusTotal += m.length; }
  }
  censusRows.sort((a, b) => b.n - a.n);
}

// ── 3. 输出 ─────────────────────────────────────────────────────────────────
const resolved = results.filter((r) => r.ok).length;
const anchorFail = results.length - resolved;
const banFail = banResults.filter((b) => !b.ok).length;
const totalFail = anchorFail + banFail;

if (AS_JSON) {
  console.log(JSON.stringify({
    anchors: results, bans: banResults, resolved, anchorFail, banFail,
    ...(CENSUS ? { census: { scanned: censusScanned, total: censusTotal, files: censusRows } } : {}),
  }, null, 2));
} else {
  console.log('=== D. 文档锚点（行号由本门当场算出，禁止手写） ===');
  console.log(`  注册表: ${path.relative(ROOT, INDEX_PATH)}`);
  console.log('  id'.padEnd(34) + 'kind'.padEnd(10) + 'line'.padEnd(8) + 'status');
  for (const r of results) {
    console.log('  ' + String(r.id).padEnd(32) + String(r.kind).padEnd(10)
      + String(r.line === null ? '—' : 'L' + r.line).padEnd(8) + (r.ok ? 'OK' : `FAIL :: ${r.detail}`));
  }
  console.log('\n=== D2. 手写行号指针禁令（D 的回归锁） ===');
  for (const b of banResults) {
    console.log('  ' + String(b.id).padEnd(32) + (b.ok ? `OK :: ${b.detail}` : `FAIL :: ${b.detail}`));
    for (const h of b.hits.slice(0, 6)) console.log(`      L${h.line} :: ${h.text}`);
  }
  console.log(`\nDOC ANCHORS: ${results.length}  RESOLVED: ${resolved}  BANS: ${banResults.length}  FAIL: ${totalFail}`);
  if (CENSUS) {
    console.log('\n=== D-census. 全仓手写行号指针普查（启发式；只报告，不改变本门判定） ===');
    console.log(`  扫描文档 ${censusScanned} 个，候选命中 ${censusTotal} 处，涉及文件 ${censusRows.length} 个`);
    for (const r of censusRows.slice(0, 15)) console.log(`    ${String(r.n).padStart(4)}  ${r.file}`);
    if (censusRows.length > 15) console.log(`    … 另有 ${censusRows.length - 15} 个文件（完整清单用 --json）`);
    console.log('  说明：候选 = 疑似行号式定位（`L33` / `文件.md:33` / 「第 33 行」）；多数属历史文本或命令输出示例。');
    console.log('        本普查用于**如实衡量 D 的范围**（不是声称"全仓已无行号指针"）；判定仍由 docAnchors / linePointerBans 负责。');
  }
  if (totalFail > 0) {
    console.log('FAILURES:');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - anchor ${r.id}: ${r.detail}`);
    for (const b of banResults.filter((x) => !x.ok)) console.log(`  - ban ${b.id}: ${b.detail}`);
    console.log('DOC ANCHOR GATE: FAILED');
  } else {
    console.log('DOC ANCHOR GATE: PASSED');
  }
}
process.exit(totalFail > 0 ? 1 : 0);
