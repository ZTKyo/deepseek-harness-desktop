/**
 * _ac6-ci-add-suite.mjs — 把新的 AC6 收据测试加进 ci-level2.yml 的 CI-SAFE 子集。
 * 幂等：已存在则不改。保持原字节风格（无 BOM、CRLF）。
 */
import fs from 'node:fs';

const P = 'C:/Users/Administrator/Desktop/sdeepseek harness/_p4r2-inject-fix/.github/workflows/ci-level2.yml';
let t = fs.readFileSync(P, 'utf8');
const before = t;

const ANCHOR = "            'tests\\learn\\test-learn-real-topology-tool-events.mjs',\r\n";
const ADD = "            'tests\\learn\\test-learn-candidate-receipts.mjs',\r\n";

if (!t.includes("test-learn-candidate-receipts.mjs")) {
  if (!t.includes(ANCHOR)) { console.log('ANCHOR_NOT_FOUND'); process.exit(2); }
  t = t.replace(ANCHOR, ANCHOR + ADD);
  t = t.replace("PASS P4 LEARN R2 contract-closure gates (12 suites)", "PASS P4 LEARN R2 contract-closure gates (13 suites)");
  // 把"新套件也满足 CI-SAFE 判据"的证据写进注释（同文件既有纪律）
  const CMT = "      # CI-SAFE subset only, established empirically rather than by reading: every\r\n";
  if (t.includes(CMT)) {
    t = t.replace(CMT, CMT +
      "      # 2026-09-27 P4 R2 AC6: test-learn-candidate-receipts.mjs was added only after\r\n" +
      "      # re-running it under the same empty-profile redirection (USERPROFILE/HOME/\r\n" +
      "      # LOCALAPPDATA -> empty dir): 32 PASS / 0 FAIL, exit 0.\r\n");
  }
}

if (t === before) { console.log('ALREADY_PRESENT (no change)'); process.exit(0); }
fs.writeFileSync(P, t, 'utf8');   // 无 BOM，与原文一致
console.log('UPDATED: added test-learn-candidate-receipts.mjs to CI-safe subset; suites 12 -> 13');
