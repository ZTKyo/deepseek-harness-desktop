#!/usr/bin/env node
/**
 * verify-release-artifact.mjs — 交付物完整性校验（只读）
 *
 * 目的：确保「发布命名版」`P4_REMEDIATION_CLOSURE_<timestamp>.md` 与「权威正文」
 * `EXTERNAL_REVIEW_REMEDIATION_CLOSURE_R1.md` 的**正文逐字节相同**，防止两份内容各自漂移，
 * 或"改了权威正文却忘了重新生成命名版"。
 *
 * 用法：  node tools/verify-release-artifact.mjs [--json]
 * 判定：  exit 0 = IDENTICAL（命名版正文 == 权威正文）
 *         exit 1 = DRIFT（不一致 / 找不到命名版 / 头部缺少 SHA256 记录）
 *
 * 约定：命名版 = 前 4 行注释头（`<!-- ... -->`，其中第 3 行记录权威正文 SHA256）+ 权威正文全文。
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
const HEADER_LINES = 4;

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase();
const json = process.argv.includes('--json');

function fail(reason, detail) {
  if (json) console.log(JSON.stringify({ ok: false, reason, detail }, null, 2));
  else {
    console.log(`RELEASE ARTIFACT INTEGRITY: DRIFT (${reason})`);
    if (detail) console.log(`  ${detail}`);
  }
  process.exit(1);
}

if (!fs.existsSync(DIR)) fail('dir-missing', DIR);

const authPath = path.join(DIR, AUTHORITATIVE);
if (!fs.existsSync(authPath)) fail('authoritative-missing', authPath);
const authoritative = fs.readFileSync(authPath, 'utf8');
const authSha = sha256(authoritative);

const releases = fs.readdirSync(DIR).filter((f) => f.startsWith(RELEASE_PREFIX) && f.endsWith('.md')).sort();
if (releases.length === 0) fail('release-file-missing', `no file matching ${RELEASE_PREFIX}*.md in ${DIR}`);

const results = [];
for (const name of releases) {
  const raw = fs.readFileSync(path.join(DIR, name), 'utf8');
  const lines = raw.split('\n');
  const header = lines.slice(0, HEADER_LINES);
  const body = lines.slice(HEADER_LINES).join('\n');

  const headerRecorded = (header.join('\n').match(/SHA256\s*=\s*([0-9A-Fa-f]{64})/) || [])[1] || null;
  const bodySha = sha256(body);
  const problems = [];
  if (!header.every((l) => l.startsWith('<!--') || l.trim() === '')) problems.push('header-shape');
  if (!headerRecorded) problems.push('header-hash-missing');
  else if (headerRecorded.toUpperCase() !== authSha) problems.push('header-hash-stale');
  if (body !== authoritative) problems.push('body-drift');

  results.push({ name, ok: problems.length === 0, problems, headerRecorded, bodySha, identical: body === authoritative });
}

const bad = results.filter((r) => !r.ok);
if (json) {
  console.log(JSON.stringify({ ok: bad.length === 0, authoritative: AUTHORITATIVE, authoritativeSha256: authSha, headerLines: HEADER_LINES, releases: results }, null, 2));
} else {
  console.log(`authoritative  = ${AUTHORITATIVE}`);
  console.log(`  sha256       = ${authSha}`);
  for (const r of results) {
    console.log(`release        = ${r.name}`);
    console.log(`  body sha256  = ${r.bodySha}`);
    console.log(`  header says  = ${r.headerRecorded || '(missing)'}`);
    console.log(`  body == authoritative : ${r.identical ? 'YES' : 'NO'}`);
    if (r.problems.length) console.log(`  problems     : ${r.problems.join(', ')}`);
  }
  console.log(bad.length === 0
    ? `RELEASE ARTIFACT INTEGRITY: IDENTICAL (${results.length} release file(s), body byte-identical, header hash in sync)`
    : `RELEASE ARTIFACT INTEGRITY: DRIFT (${bad.length}/${results.length} release file(s) inconsistent)`);
}
process.exit(bad.length === 0 ? 0 : 1);
