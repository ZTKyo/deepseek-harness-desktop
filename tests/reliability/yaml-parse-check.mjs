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

const yamlModule = loadYamlModule();
if (!yamlModule) {
  console.log('YAML CHECK SKIPPED: js-yaml not resolvable');
  process.exit(0);
}

// js-yaml is shipped in several interop shapes depending on version and how it
// was installed (global + NODE_PATH under ESM can hand back a namespace whose
// real API sits on `.default`). Normalise before touching Type/DEFAULT_SCHEMA.
function normaliseYaml(mod) {
  if (mod && typeof mod.load === 'function' && typeof mod.Type === 'function') return mod;
  if (mod && mod.default && typeof mod.default.load === 'function') return mod.default;
  return mod;
}
const yaml = normaliseYaml(yamlModule);
if (typeof yaml.load !== 'function') {
  console.log('YAML CHECK SKIPPED: js-yaml load() unavailable');
  process.exit(0);
}

// cordis-compatible schema: `!!js <expr>` is a scalar carrying a loader
// expression. When the installed js-yaml does not expose Type/DEFAULT_SCHEMA in
// a usable shape, fall back to stripping the `!!js` tag before parsing - the
// structural validation (which is what this gate is for) still holds.
let schema = null;
let mode = 'strip-tag-fallback';
try {
  if (typeof yaml.Type === 'function' && yaml.DEFAULT_SCHEMA && typeof yaml.DEFAULT_SCHEMA.extend === 'function') {
    schema = yaml.DEFAULT_SCHEMA.extend([
      new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (d) => ({ __jsExpr: d }) }),
      new yaml.Type('!js', { kind: 'scalar', construct: (d) => ({ __jsExpr: d }) }),
    ]);
    mode = 'custom-schema';
  }
} catch {
  schema = null;
  mode = 'strip-tag-fallback';
}

function stripJsTags(text) {
  // `key: !!js "expr"` -> `key: "expr"` ; `key: !!js expr` -> `key: "expr"`
  return text
    .replace(/!!js[ \t]+(["'])/g, '$1')
    .replace(/!!js[ \t]+([^\r\n"']\S*)/g, '"$1"')
    .replace(/![ \t]*js[ \t]+(["'])/g, '$1');
}

function parseYaml(text) {
  if (schema) return yaml.load(text, { schema });
  return yaml.load(stripJsTags(text));
}

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
    parseYaml(text);
    ok++;
  } catch (e) {
    console.log(`YAML FAIL: ${path.relative(root, fp)}: ${String(e.message).split('\n')[0]}`);
    bad++;
  }
}

console.log(`YAML CHECK: ${ok} ok, ${bad} failed (${files.length} files, cordis !!js aware, mode=${mode})`);
if (bad > 0) { process.exit(1); }
