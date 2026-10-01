#!/usr/bin/env node
/**
 * verify-release-artifact.mjs — 交付物完整性校验（只读）
 *
 * 目的：确保「发布命名版」`P4_REMEDIATION_CLOSURE_<timestamp>.md` 与「权威正文」
 * `EXTERNAL_REVIEW_REMEDIATION_CLOSURE_R1.md` 的**语义正文一致**，防止两份内容各自漂移，
 * 或"改了权威正文却忘了重新生成命名版"。
 *
 * R2（2026-10-01）—— 外部评审 Finding B：
 *   本工具原先用**原始字节**做比较与哈希，于是同一份正文在 LF 检出下判 IDENTICAL/exit 0、
 *   在 CRLF 检出下判 DRIFT/exit 1 —— 结论取决于检出环境，而不是内容。这是 blocker。
 *   现在明确区分两种身份，且**只有一种参与判定**：
 *
 *   1) 语义正文身份（content identity，**唯一判定依据**）
 *      比较前规范化行尾：CRLF → LF、单独 CR → LF。**其余字节一律不动**（空格、制表符、
 *      行内空白、BOM、任意其它字符仍参与比较），因此"真实内容变化"依旧会判 DRIFT。
 *      行尾风格（LF / CRLF / CR / mixed）**不影响**判定。
 *      → 字段 `canonicalBodySha256` = 对规范化后的正文计算的 SHA256。
 *   2) 原始字节身份（forensic identity，**仅供参考，不参与判定**）
 *      → 字段 `rawFileSha256` = 文件原始字节的 SHA256（会随检出的换行风格变化）。
 *
 * 头部约定：命名版 = 开头的**连续 HTML 注释行**（每行一个 `<!-- … -->`；行数由解析器推导，
 *          不再硬编码 4 行）+ 权威正文（逐字节保留）。
 *          正文起点 = 第一行非注释行。权威文档自身开头的注释行同样不计入其正文
 *          （该文件通常没有注释头，此时其正文 = 整个文件）。
 *   注释块里记录的哈希 = `canonicalBodySha256`。字段名两种都接受：
 *     - `CANONICAL_BODY_SHA256 = <64hex>`（明确写法，新产物建议使用）
 *     - `SHA256 = <64hex>`（**legacy 别名**，语义相同；R1 产物使用该写法）
 *   两者同时存在且互相冲突 ⇒ 判 DRIFT（不自洽）。
 *
 * 用法：  node tools/verify-release-artifact.mjs [--json]
 * 判定：  exit 0 = IDENTICAL（规范化正文一致 且 头部 canonical 哈希同步）
 *         exit 1 = DRIFT（正文漂移 / 头部哈希过期或缺失 / 头部形状非法 / 找不到文件）
 * 本脚本只读文件，不写任何东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '..', 'docs', 'roadmap', 'reports', 'PHASE_04_LEARNING', 'R3_FINAL_CLOSURE');
const AUTHORITATIVE = 'EXTERNAL_REVIEW_REMEDIATION_CLOSURE_R1.md';
const RELEASE_PREFIX = 'P4_REMEDIATION_CLOSURE_';
const MAX_HEADER_LINES = 16;   // fail-closed upper bound for the comment header block

const json = process.argv.includes('--json');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase();
const sha256Bytes = (buf) => crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();

/** The ONE normalization used for verdicts: line endings only. Nothing else is touched. */
const canonicalize = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

function eolStyleOf(s) {
  const crlf = (s.match(/\r\n/g) || []).length;
  const cr = (s.match(/\r(?!\n)/g) || []).length;
  const lf = (s.match(/\n/g) || []).length - crlf;
  const kinds = [crlf > 0 ? 'CRLF' : null, cr > 0 ? 'CR' : null, lf > 0 ? 'LF' : null].filter(Boolean);
  if (kinds.length === 0) return 'NONE';
  return kinds.length > 1 ? `MIXED(${kinds.join('+')})` : kinds[0];
}

/** Number of leading consecutive HTML-comment lines (0 when the first line is not a comment). */
function leadingCommentRun(lines) {
  let n = 0;
  while (n < lines.length && lines[n].trim().startsWith('<!--')) n++;
  return n;
}

/**
 * Header = the consecutive run of leading HTML-comment lines; body = everything after it.
 * The R1 artifact writes FOUR such lines (one `<!-- … -->` per line) and does NOT close the
 * block with a single trailing marker, so the run is delimited by "the first non-comment line"
 * — never by the first `-->` occurrence (every one of those lines carries its own close marker).
 * The line count is derived, not hard-coded. Returns null when the shape is non-compliant.
 */
function splitHeaderAndBody(rawText) {
  const lines = canonicalize(rawText).split('\n');
  const n = leadingCommentRun(lines);
  if (n === 0 || n > MAX_HEADER_LINES) return null;
  const header = lines.slice(0, n);
  if (!header.some((l) => l.includes('-->'))) return null;   // header must close at least once
  return { header, body: lines.slice(n).join('\n') };
}

function fail(reason, detail) {
  if (json) console.log(JSON.stringify({ ok: false, verdict: 'DRIFT', reason, detail }, null, 2));
  else {
    console.log(`RELEASE ARTIFACT INTEGRITY: DRIFT (${reason})`);
    if (detail) console.log(`  ${detail}`);
  }
  process.exit(1);
}

if (!fs.existsSync(DIR)) fail('dir-missing', DIR);

const authPath = path.join(DIR, AUTHORITATIVE);
if (!fs.existsSync(authPath)) fail('authoritative-missing', authPath);
const authRawBuf = fs.readFileSync(authPath);
const authText = authRawBuf.toString('utf8');
// The authority's own leading comment lines (usually none) are not part of its body either.
const authLines = canonicalize(authText).split('\n');
const authHeaderCount = leadingCommentRun(authLines);
if (authHeaderCount > MAX_HEADER_LINES) {
  fail('authoritative-header-shape', `authority leading comment block exceeds ${MAX_HEADER_LINES} lines`);
}
const authCanonicalBody = authLines.slice(authHeaderCount).join('\n');
const authCanonicalSha = sha256(authCanonicalBody);

const releases = fs.readdirSync(DIR).filter((f) => f.startsWith(RELEASE_PREFIX) && f.endsWith('.md')).sort();
if (releases.length === 0) fail('release-file-missing', `no file matching ${RELEASE_PREFIX}*.md in ${DIR}`);

const results = [];
for (const name of releases) {
  const abs = path.join(DIR, name);
  const rawBuf = fs.readFileSync(abs);
  const rawText = rawBuf.toString('utf8');
  const split = splitHeaderAndBody(rawText);
  const problems = [];

  const headerText = split ? split.header.join('\n') : '';
  const canonMatches = [...headerText.matchAll(/CANONICAL_BODY_SHA256\s*=\s*([0-9A-Fa-f]{64})/g)]
    .map((m) => m[1].toUpperCase());
  const legacyMatches = [...headerText.matchAll(/[^_A-Z0-9]SHA256\s*=\s*([0-9A-Fa-f]{64})/g)]
    .map((m) => m[1].toUpperCase());
  const headerRecorded = canonMatches[0] || legacyMatches[0] || null;
  const headerField = canonMatches.length > 0
    ? (legacyMatches.length > 0 ? 'CANONICAL_BODY_SHA256 (+SHA256 alias)' : 'CANONICAL_BODY_SHA256')
    : (legacyMatches.length > 0 ? 'SHA256 (legacy alias)' : null);
  // Any two recorded hashes that disagree make the header self-contradictory ⇒ DRIFT.
  const distinctRecorded = new Set([...canonMatches, ...legacyMatches]);

  const bodyCanonical = split ? split.body : canonicalize(rawText);
  const canonicalBodySha = sha256(bodyCanonical);
  const rawFileSha = sha256Bytes(rawBuf);
  const contentIdentical = bodyCanonical === authCanonicalBody;
  const rawByteIdentical = rawBuf.equals(authRawBuf);

  if (!split) problems.push('header-shape');
  if (distinctRecorded.size > 1) problems.push('header-hash-self-conflict');
  if (!headerRecorded) problems.push('header-hash-missing');
  else if (headerRecorded.toUpperCase() !== authCanonicalSha) problems.push('header-hash-stale');
  if (!contentIdentical) problems.push('body-drift');

  results.push({
    name,
    ok: problems.length === 0,
    problems,
    headerRecorded,
    headerField,
    canonicalBodySha256: canonicalBodySha,
    rawFileSha256: rawFileSha,
    eolStyle: eolStyleOf(rawText),
    contentIdentical,
    rawByteIdentical,
    headerLines: split ? split.header.length : null,
  });
}

const bad = results.filter((r) => !r.ok);
if (json) {
  console.log(JSON.stringify({
    ok: bad.length === 0,
    verdict: bad.length === 0 ? 'CONTENT_IDENTICAL' : 'DRIFT',
    identitySemantics: 'verdict = EOL-normalized (CRLF/CR -> LF) content identity; rawFileSha256 is forensic only',
    authoritative: AUTHORITATIVE,
    authoritativeCanonicalBodySha256: authCanonicalSha,
    authoritativeRawFileSha256: sha256Bytes(authRawBuf),
    authoritativeEolStyle: eolStyleOf(authText),
    authoritativeHeaderLines: authHeaderCount,
    releases: results,
  }, null, 2));
} else {
  console.log(`authoritative  = ${AUTHORITATIVE}`);
  console.log(`  canonicalBodySha256 = ${authCanonicalSha}   (行尾规范化后；判定依据)`);
  console.log(`  rawFileSha256       = ${sha256Bytes(authRawBuf)}   (原始字节；仅取证)`);
  console.log(`  eolStyle            = ${eolStyleOf(authText)}`);
  for (const r of results) {
    console.log(`release        = ${r.name}`);
    console.log(`  canonicalBodySha256 = ${r.canonicalBodySha256}  match=${r.contentIdentical ? 'YES' : 'NO'}`);
    console.log(`  rawFileSha256       = ${r.rawFileSha256}   (eolStyle=${r.eolStyle}; raw-bytes match=${r.rawByteIdentical ? 'YES' : 'NO'} — forensic only)`);
    console.log(`  header says         = ${r.headerRecorded || '(missing)'}${r.headerField ? `  [${r.headerField}]` : ''}`);
    console.log(`  header canonical hash match = ${r.headerRecorded && r.headerRecorded.toUpperCase() === authCanonicalSha ? 'YES' : 'NO'}`);
    console.log(`  content identical (EOL-normalized) = ${r.contentIdentical ? 'YES' : 'NO'}`);
    if (r.problems.length) console.log(`  problems     : ${r.problems.join(', ')}`);
  }
  console.log(bad.length === 0
    ? `RELEASE ARTIFACT INTEGRITY: IDENTICAL (${results.length} release file(s); content-identical after EOL normalization, header canonical hash in sync)`
    : `RELEASE ARTIFACT INTEGRITY: DRIFT (${bad.length}/${results.length} release file(s) inconsistent)`);
}
process.exit(bad.length === 0 ? 0 : 1);
