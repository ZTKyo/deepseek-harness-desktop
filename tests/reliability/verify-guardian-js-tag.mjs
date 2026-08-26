// verify-guardian-js-tag.mjs — P2.5 R2-8: Guardian !!js-tag YAML regression (behavioral).
//
// Background: cordis patch layers legitimately use the `!!js` scalar tag for
// loader expressions (e.g. NOTION_TOKEN via env injection). Before the P2.5 fix,
// guardian's Test-YamlFile parsed with the DEFAULT js-yaml schema, which treats
// `!!js` as an UNKNOWN tag -> INVALID -> guardian restored the last-good mirror
// and could roll a hardened config back to an old plaintext-token version.
// R2-8 requires a regression that proves:
//   1) guardian's Test-YamlFile code STILL strips `!!js` before loading
//      (source-integrity guard), and
//   2) executing guardian's EXACT probe (extracted from the real source, not a
//      re-implementation) returns VALID for a !!js-tagged config, INVALID for a
//      genuinely broken YAML, VALID for a plain config.
// Isolated: uses temp fixtures only; never touches ~/.dsh. On a dev machine it
// additionally cross-checks the real deployed profile configs if present.
//
// Usage: node tests/reliability/verify-guardian-js-tag.mjs [repoRoot]
// exit 0 = PASS, 1 = FAIL.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(process.argv[2] || process.cwd());
const GUARDIAN = path.join(root, 'dsh-guardian.ps1');
const jsyamlCandidates = [
  // npm_config_prefix（GH Actions setup-node 在 Windows runner 显式设为
  // C:\npm\prefix）：它是 prefix 根，npm 全局模块根 = <prefix>/node_modules
  // （与 install-plugin.mjs npmGlobalModulesRoot 同策略；少拼 node_modules
  // 会找不到 js-yaml —— CI 实测踩坑）。
  ...(() => {
    const prefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX;
    return prefix ? [path.join(prefix, 'node_modules', 'js-yaml', 'index.js')] : [];
  })(),
  // `npm root -g` spawn 兜底：不依赖任何环境变量，CI 实测最可靠
  // （install-plugin 门禁正是靠这条在 Windows runner 找到 js-yaml）。
  // 输出即 <prefix>/node_modules；Windows 上需 npm.cmd + shell:true。
  // 注意：npmrc 的 prefix 常写成 `${APPDATA}\npm` 这类 env 占位符，npm root
  // 会原样输出字面量，必须手动展开 ${VAR}/$VAR 才能得到真实路径。
  ...(() => {
    try {
      const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const r = spawnSync(cmd, ['root', '-g'],
        { encoding: 'utf8', shell: process.platform === 'win32' });
      const out = (r.stdout || '').trim();
      if (!out) return [];
      // expand ${APPDATA} / $APPDATA env placeholders (npmrc prefix style)
      const expanded = out.replace(/\$\{(\w+)\}/g, (m, k) => process.env[k] || m)
                          .replace(/\$(\w+)/g, (m, k) => process.env[k] || m);
      return [path.join(expanded, 'js-yaml', 'index.js')];
    } catch { return []; }
  })(),
  // NODE_PATH 多路径（Windows 分号 / Unix 冒号，path.delimiter 处理）
  ...(process.env.NODE_PATH
    ? process.env.NODE_PATH.split(path.delimiter).map((p) => p.trim()).filter(Boolean)
        .map((p) => path.join(p, 'js-yaml', 'index.js'))
    : []),
  // 常规 npm 全局安装点（本机 dsh 安装点）
  path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'js-yaml', 'index.js'),
  path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'js-yaml', 'index.js'),
];
let jsyaml = jsyamlCandidates.find((p) => fs.existsSync(p));
if (!jsyaml && process.env.LOCALAPPDATA) {
  // npx cache scan (same strategy as guardian Find-JsYaml)
  const npxRoot = path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx');
  if (fs.existsSync(npxRoot)) {
    const found = findFile(npxRoot, 'index.js', 6);
    if (found && /js-yaml/i.test(found)) jsyaml = found;
  }
}

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
}

function findFile(dir, target, maxDepth) {
  if (maxDepth <= 0) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findFile(fp, target, maxDepth - 1); if (r) return r; }
    else if (e.isFile() && e.name === target) return fp;
  }
  return null;
}

if (!fs.existsSync(GUARDIAN)) {
  console.log('RESULT: SKIP (dsh-guardian.ps1 not found in repo root)');
  process.exit(0);
}

// --- extract guardian's exact YAML probe code string from source ---
const src = fs.readFileSync(GUARDIAN, 'utf8');
check('R2-8.1 Test-YamlFile 函数存在', src.includes('function Test-YamlFile'),
  'guardian 源码无 Test-YamlFile');
check('R2-8.2 !!js 剥离正则存在（P2.5 修复未丢失）', /replace\(\/!!js\(\\s\+\)\/g/g.test(src),
  'guardian 源码丢失 !!js 剥离逻辑');

const codeMatch = src.match(/\$code = '((?:[^']|'')*)'/);
check('R2-8.3 提取到 $code 探针源码', !!codeMatch, '未匹配 $code = \'...\'');
if (!codeMatch) { console.log(`结果: FAIL（${pass} 通过，${fail} 失败）`); process.exit(1); }
// PowerShell 单引号字符串里 '' 是转义的单引号 -> 还原为 JS 源码中的 '
const code = codeMatch[1].replace(/''/g, "'");

if (!jsyaml) {
  console.log('RESULT: FAIL (js-yaml not resolvable — guardian probe cannot run)');
  process.exit(1);
}

// --- run guardian's probe against isolated fixtures ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-r28-'));
const fixtureOkJs = path.join(tmp, 'ok-js.yml');
const fixtureOkPlain = path.join(tmp, 'ok-plain.yml');
const fixtureBad = path.join(tmp, 'bad.yml');
// representative cordis-patch-style config with !!js env-injected scalars
fs.writeFileSync(fixtureOkJs, [
  'insert:',
  '  - id: mcp-notion',
  "    env:",
  "      NOTION_TOKEN: !!js process.env.NOTION_TOKEN || 'x'",
  "    mount:",
  "      - name: './notion.mjs'",
  "        config:",
  "          apiKey: !!js process.env.NOTION_TOKEN",
].join('\n'), 'utf8');
fs.writeFileSync(fixtureOkPlain, 'settings:\n  a: 1\n  b:\n    - c\n', 'utf8');
fs.writeFileSync(fixtureBad, 'a: : : [[[\n  - ]\n', 'utf8');

function runProbe(yamlPath) {
  // mirrors guardian: & $node -e $code $jsyaml $path
  const r = spawnSync('node', ['-e', code, jsyaml, yamlPath], { encoding: 'utf8', timeout: 30000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  return { ok: /OK/.test(out) && !/ERR/.test(out), out: out.slice(-200) };
}

const t1 = runProbe(fixtureOkJs);
check('R2-8.4 !!js 标签配置 -> guardian 判 VALID', t1.ok, `probe=${t1.out}`);
const t2 = runProbe(fixtureOkPlain);
check('R2-8.5 普通有效配置 -> VALID', t2.ok, `probe=${t2.out}`);
const t3 = runProbe(fixtureBad);
check('R2-8.6 真损坏 YAML -> 判 INVALID（非 VALID）', !t3.ok, `probe=${t3.out}`);

// --- dev machine: cross-check REAL deployed profile configs (guardian guard target) ---
const realConfigs = [
  path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'web', 'cordis.patch.yml'),
  path.join(process.env.USERPROFILE || '', '.dsh', '.agent-presets', 'autonomous', 'agent.cordis.yml'),
];
const existing = realConfigs.filter((p) => fs.existsSync(p));
for (const p of existing) {
  const r = runProbe(p);
  check(`R2-8.7 真实部署配置通过 guardian 守卫: ${path.basename(p)}`, r.ok, `probe=${r.out}`);
}
if (existing.length === 0) {
  console.log('  SKIP  R2-8.7 本机无 ~/.dsh 部署配置（CI 环境），跨检查跳过');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`结果: ${fail === 0 ? 'PASS' : 'FAIL'}（${pass} 通过，${fail} 失败）`);
process.exit(fail === 0 ? 0 : 1);
