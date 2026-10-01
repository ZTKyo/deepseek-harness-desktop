#!/usr/bin/env node
// tests/roadmap/test-anchor-gate-negative-control.mjs
//
// D 回归锁的**负控测试**：证明 tools/check-doc-anchors.mjs 的行号禁令真的会 FAIL，
// 而不是"永远打印 PASS 的装饰门"（本项目已有教训：门必须能被证伪）。
//
// 做法：临时目录造一个 fixture 文档 + 临时 registry（--registry 指过去），
//       registry 里的 ban 指向该 fixture（绝对路径，不碰仓库任何真实文档）。
//   用例 1：fixture 里写一条**裸行号指针** → 期望 exit 1（门必须抓到）
//   用例 2：同一条改成**带锚点引用** → 期望 exit 0（锚点豁免路径有效）
//   用例 3：把行号指针移出被禁区块 → 期望 exit 0（区块作用域有效，不是全文件乱杀）
//
// 只写临时目录，不修改仓库文件；退出码 0 = 三条负控全部符合预期。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const TOOL = path.join(ROOT, 'tools', 'check-doc-anchors.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-anchor-negctl-'));

const fixture = path.join(tmp, 'fixture.md');
const registry = path.join(tmp, 'registry.json');

const BLOCK_START = '## NEGCTL BLOCK START';
const BLOCK_END = '## NEGCTL BLOCK END';

function writeFixture(blockLines, afterLines = []) {
  const body = [
    '# NEGCTL fixture',
    '',
    BLOCK_START,
    'placeholder line',
    ...blockLines,
    BLOCK_END,
    ...afterLines,
    '',
  ].join('\n');
  fs.writeFileSync(fixture, body, 'utf8');
}

// registry 必须声明至少一个锚点：门在"没有锚点可检"时会 fail-closed（空注册表 = 不是门）。
// 这里顺便覆盖「绝对路径 fixture 的标题锚点」这条解析路径。
fs.writeFileSync(registry, JSON.stringify({
  docAnchors: [{
    id: 'negctl.heading',
    file: fixture,
    kind: 'heading',
    value: BLOCK_START,
    note: 'negative control fixture heading',
  }],
  linePointerBans: [{
    id: 'negctl.bareLinePointer',
    file: fixture,
    fromHeading: BLOCK_START,
    toHeading: BLOCK_END,
    banPattern: '\\bL\\d{2,3}\\b',
    requireAnchorPattern: '锚点|`[A-Za-z][A-Za-z0-9_]*\\.[A-Za-z]',
    note: 'negative control',
  }],
}, null, 2), 'utf8');

function run() {
  const r = spawnSync(process.execPath, [TOOL, '--registry', registry], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const results = [];
function expect(name, actualExit, wantExit, out, extra = '') {
  const ok = actualExit === wantExit && (extra === '' || out.includes(extra));
  results.push({ name, ok, detail: `exit=${actualExit} want=${wantExit}${extra ? ` contains="${extra}"` : ''}` });
}

// 用例 1：裸行号指针（新写入、无锚点）必须 FAIL
writeFixture(['a bare pointer L999 with no anchor at all']);
{
  const r = run();
  expect('negctl-1 bare new line pointer is caught', r.code, 1, r.out, 'negctl.bareLinePointer');
}

// 用例 2：同样含 L999，但同处给出锚点引用 → 允许（锚点豁免）
writeFixture(['a pointer L999 together with 锚点 fixture.someAnchor']);
{
  const r = run();
  expect('negctl-2 anchor-bearing line pointer is allowed', r.code, 0, r.out);
}

// 用例 3：行号指针在**被禁区块之外** → 允许（作用域正确，不是全文件乱杀）
writeFixture(['clean line'], ['## NEGCTL OUTSIDE', 'outside pointer L999 is out of scope']);
{
  const r = run();
  expect('negctl-3 pointer outside the banned block is not flagged', r.code, 0, r.out);
}

// 清理
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }

let failed = 0;
console.log('=== D negative control: can the line-pointer ban actually fail? ===');
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`);
  if (!r.ok) failed++;
}
console.log(`\nNEGATIVE CONTROLS: ${results.length}  PASS: ${results.length - failed}  FAIL: ${failed}`);
console.log(failed === 0
  ? 'ANCHOR GATE NEGATIVE CONTROL: PASSED (the ban is falsifiable, not decorative)'
  : 'ANCHOR GATE NEGATIVE CONTROL: FAILED');
process.exit(failed === 0 ? 0 : 1);
