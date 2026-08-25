// test-secret-scan-fixtures.mjs — Phase 02 Security-Hardening SH-R2-3.
// Proves the secret scanner actually blocks: a REAL-looking secret pattern must
// FAIL (exit 1), a normal ${ENV} template must PASS (exit 0), and the exemption
// list must be exact-literal only (a prefix rule would whitelist real keys).
//
// Run: node tests/reliability/test-secret-scan-fixtures.mjs
// exit 0 = scanner behaves correctly, exit 1 = gate is broken.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const scanner = path.join(process.cwd(), 'tests', 'reliability', 'secret-scan-check.mjs');
if (!fs.existsSync(scanner)) {
  console.log(`FIXTURE FAIL: scanner not found at ${scanner}`);
  process.exit(1);
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`); }
}

function runScanner(dir) {
  try {
    const out = execFileSync(process.execPath, [scanner, dir], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function fixtureDir(name, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `secret-fx-${name}-`));
  for (const [fname, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, fname), content, 'utf8');
  }
  return dir;
}

const dirs = [];
try {
  // 1) NEGATIVE fixture: a real-looking key must be caught (exit 1)
  const badDir = fixtureDir('bad', { 'conf.txt': 'api_key = "sk-Zq7Xw2Lp9Kd4Mn8Rt6Vb3Yc5Ha1Ju"\n' });
  dirs.push(badDir);
  const bad = runScanner(badDir);
  check('bad fixture (real-looking sk- key) FAILS', bad.code === 1 && /SECRET SCAN FAILED/.test(bad.out), `exit=${bad.code}`);

  // 2) POSITIVE fixture: env template must pass (exit 0)
  const goodDir = fixtureDir('good', { 'patch.yml': 'NOTION_TOKEN: ${NOTION_TOKEN}\n' });
  dirs.push(goodDir);
  const good = runScanner(goodDir);
  check('good fixture (${ENV} template) PASSES', good.code === 0 && /SECRET SCAN PASSED/.test(good.out), `exit=${good.code}`);

  // 3) Notion-shaped literal must be caught (the exact class this gate exists for)
  const ntnDir = fixtureDir('ntn', { 'deployed.yml': 'NOTION_TOKEN: ntn_9f3k2m8x7q1w5e4r6t8y0u2i5o7p3a\n' });
  dirs.push(ntnDir);
  const ntn = runScanner(ntnDir);
  check('notion literal token FAILS', ntn.code === 1 && /SECRET SCAN FAILED/.test(ntn.out), `exit=${ntn.code}`);

  // 4) Exemption must be exact-literal: a key that merely SHARES A PREFIX with
  //    the CI mock must still FAIL (guards against prefix-based whitelisting).
  const prefixDir = fixtureDir('prefix', { 'sneaky.txt': 'key = "sk-abcdefghijklmnopqrstuvwxyz999999999REAL"\n' });
  dirs.push(prefixDir);
  const prefixed = runScanner(prefixDir);
  check('prefix-sharing key still FAILS (exemption is exact-literal)', prefixed.code === 1, `exit=${prefixed.code}`);

  // 5) The exact CI mock literal is exempt (keeps ci-level4 self-test green)
  const mockDir = fixtureDir('mock', { 'ci.yml': "Set-Content -Value 'api_key = \"sk-abcdefghijklmnopqrstuvwxyz123456789\"'\n" });
  dirs.push(mockDir);
  const mock = runScanner(mockDir);
  check('exact CI mock literal is exempt', mock.code === 0, `exit=${mock.code}`);
} finally {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('SECRET SCAN FIXTURE TEST FAILED'); process.exit(1); }
console.log('SECRET SCAN FIXTURE TEST PASSED');
