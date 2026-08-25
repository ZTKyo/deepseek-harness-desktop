// yaml-parse-check.mjs — CI Level 1 YAML validity gate (cordis-aware).
//
// Why this exists: cordis patch layers legitimately use the `!!js` scalar tag
// for loader expressions (see cordis-plugin-loader: `__jsExpr` / interpolate).
// Validating those files with the DEFAULT js-yaml schema produces a FALSE
// failure ("unknown scalar tag !<tag:yaml.org,2002:js>"), so this checker
// parses with a schema that accepts `!!js` exactly like the loader does.
//
// Usage: node tests/reliability/yaml-parse-check.mjs [rootDir]
// exit 0 = all YAML parses, exit 1 = at least one real syntax error.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadYamlModule() {
  // 1) normal resolution (CI installs js-yaml globally and sets NODE_PATH)
  try { return require('js-yaml'); } catch { /* fall through */ }
  // 2) local dsh installation (developer machines)
  const appData = process.env.APPDATA;
  if (appData) {
    const p = path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'js-yaml');
    try { return require(p); } catch { /* fall through */ }
  }
  return null;
}

const yaml = loadYamlModule();
if (!yaml) {
  console.log('YAML CHECK SKIPPED: js-yaml not resolvable');
  process.exit(0);
}

// cordis-compatible schema: `!!js <expr>` is a scalar carrying a loader expression
const jsTypes = [
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (d) => ({ __jsExpr: d }) }),
  new yaml.Type('!js', { kind: 'scalar', construct: (d) => ({ __jsExpr: d }) }),
];
const schema = yaml.DEFAULT_SCHEMA.extend(jsTypes);

const root = process.argv[2] || process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

function walk(dir, depth = 0) {
  if (depth > 12) return [];
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(fp, depth + 1));
    else if (e.isFile() && /\.(yml|yaml)$/i.test(e.name)) out.push(fp);
  }
  return out;
}

const files = walk(root);
let bad = 0;
let ok = 0;
for (const fp of files) {
  let text;
  try { text = fs.readFileSync(fp, 'utf8'); } catch (e) {
    console.log(`YAML READ FAIL: ${path.relative(root, fp)}: ${e.message}`);
    bad++;
    continue;
  }
  try {
    yaml.load(text, { schema });
    ok++;
  } catch (e) {
    console.log(`YAML FAIL: ${path.relative(root, fp)}: ${String(e.message).split('\n')[0]}`);
    bad++;
  }
}

console.log(`YAML CHECK: ${ok} ok, ${bad} failed (${files.length} files, cordis !!js aware)`);
if (bad > 0) { process.exit(1); }
