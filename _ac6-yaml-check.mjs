/**
 * _ac6-yaml-check.mjs — 校验 ci-level2.yml 语法 + 新套件已进入 CI-SAFE 列表。
 * 复用 dsh 自带 js-yaml（ESM），不新增依赖。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('file:///C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json');
let yaml;
try {
  yaml = await import('file:///C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/js-yaml/dist/js-yaml.mjs');
} catch (e) {
  console.log('js-yaml import failed: ' + e.message);
  process.exit(3);
}
const P = 'C:/Users/Administrator/Desktop/sdeepseek harness/_p4r2-inject-fix/.github/workflows/ci-level2.yml';
const raw = fs.readFileSync(P, 'utf8');
let doc;
try { doc = yaml.load(raw); } catch (e) { console.log('YAML FAIL: ' + e.message); process.exit(1); }
const jobs = Object.keys(doc.jobs || {});
const s = JSON.stringify(doc.jobs);
console.log('YAML OK; jobs=' + jobs.join(','));
console.log('has_new_suite=' + s.includes('test-learn-candidate-receipts.mjs'));
console.log('suite_count_in_block=' + (s.match(/test-learn-|redteam-r3-/g) || []).length);
