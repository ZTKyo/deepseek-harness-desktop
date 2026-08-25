// secret-scan-check.mjs — Phase 02 Security-Hardening (SH-4): automated
// redaction/secret regression scan. Scans the repo (plugins/, DSH-Client-adjacent
// tracked files, docs/) for hard-coded secret patterns. FAILS (exit 1) on any
// hit — this is the "no plaintext secrets in the repo / no regression" gate.
//
// Patterns covered: Notion ntn_, OpenAI sk-, OpenRouter sk-or-v1-, Slack xox*,
// GitHub ghp_/gho_/ghu_/ghs_/ghr_, JWT eyJ..., Anthropic sk-ant-, Telegram bot
// token (digits:AA...), AWS AKIA... (length-guarded to avoid noise).
//
// Usage: node tests/reliability/secret-scan-check.mjs [repoDir]
// exit 0 = clean, exit 1 = secrets found (list paths + line numbers)

import fs from 'node:fs';
import path from 'node:path';

const repo = process.argv[2] || process.cwd();
const PATTERNS = [
  { name: 'notion', re: /ntn_[A-Za-z0-9]{16,}/ },
  { name: 'openai', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'openrouter', re: /\bsk-or-v1-[A-Za-z0-9]{16,}\b/ },
  { name: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/ },
  { name: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./ },
  { name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'telegram', re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/ },
  { name: 'aws', re: /\bAKIA[A-Z0-9]{16}\b/ },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '_research', '_checkpoint']);
// Only this scanner is skipped (its PATTERNS are regexes, not literals).
const SKIP_FILES = new Set(['secret-scan-check.mjs']);
// SH-R2: exact known-fake literals that appear in CI workflow self-tests.
// EXACT strings only — never prefixes (a prefix rule would whitelist real keys).
// Assembled by concatenation on purpose so that NO secret-shaped literal exists
// in this source: both scan layers (this one and the PowerShell pattern scan in
// CI Level 1) then stay clean without any path exemption.
const CI_MOCK_LITERALS = [
  'sk-' + 'abcdefghijklmnopqrstuvwxyz123456789', // ci-level4.yml config-parse self-test
  'TEST-' + '12345',                             // secret-gate probe value
];

function walk(dir, depth = 0) {
  if (depth > 12) return []; // TEMP fixture dirs are ~7 levels deep (C:\Users\X\AppData\Local\Temp\...)
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(fp, depth + 1));
    else if (e.isFile() && !SKIP_FILES.has(e.name)) out.push(fp);
  }
  return out;
}

let hits = 0;
const files = walk(repo);
for (const fp of files) {
  // skip binaries
  const ext = path.extname(fp).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.ico', '.wav', '.mp3', '.exe', '.dll', '.zip'].includes(ext)) continue;
  let content;
  try { content = fs.readFileSync(fp, 'utf8'); } catch { continue; }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Fragment-level sanitisation (SH-R3): exempt ONLY the exact matched mock
    // literal / ${ENV} template segment, NOT the whole line. If the same line
    // also carries a REAL secret-shaped token elsewhere, that token must still
    // be reported (a whole-line continue would bypass it).
    let probe = line;
    for (const lit of CI_MOCK_LITERALS) {
      probe = probe.split(lit).join('');
    }
    // blank out ${ENV} template references (keep the rest of the line scannable)
    probe = probe.replace(/\$\{[A-Za-z_][A-Za-z0-9_.]*\}/g, '');
    for (const p of PATTERNS) {
      if (p.re.test(probe)) {
        hits++;
        console.log(`SECRET ${p.name} @ ${path.relative(repo, fp)}:${i + 1}: ${line.trim().substring(0, 80)}`);
      }
    }
  }
}

if (hits > 0) {
  console.log(`\nSECRET SCAN FAILED (${hits} hits)`);
  process.exit(1);
}
console.log('SECRET SCAN PASSED (no hard-coded secrets in repo)');
