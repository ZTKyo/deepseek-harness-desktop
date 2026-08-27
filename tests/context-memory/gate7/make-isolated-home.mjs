#!/usr/bin/env node
// Gate-7 drill: build an isolated DSH_HOME for one leg of the kill-switch drill.
// Usage: node make-isolated-home.mjs <baseline|cfg-off|env-off|missing|corrupt> [enabled:true|false]
//
// Isolation guarantees (see RUNBOOK.md):
// - Whole home tree isolated via DSH_HOME override (F9).
// - context-memory stateDir explicitly overridden to <leg>/state so we NEVER touch
//   the production store dir %LOCALAPPDATA%\DSHHarness\state\context-memory (F10).
// - No secrets copied into any file: settings.yaml is a byte copy of production
//   (env-name indirection only, verified zero literal credentials); real values are
//   injected as process env by runner.mjs at spawn time.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME_ROOT = process.env.USERPROFILE || os.homedir();
const PROD_PRESET_DIR = path.join(HOME_ROOT, '.dsh', '.agent-presets', 'autonomous');
const PROD_SETTINGS = path.join(HOME_ROOT, '.dsh', 'settings.yaml');
const PROD_HEADLESS_PROFILE = path.join(HOME_ROOT, '.dsh', 'profiles', 'headless');
const PROD_WEB_PROFILE = path.join(HOME_ROOT, '.dsh', 'profiles', 'web');

const LEG = process.argv[2];
if (!LEG) throw new Error('usage: node make-isolated-home.mjs <legId> [enabled]');
const ENABLED = (process.argv[3] || 'true') === 'true';

const legDir = (rel) => path.join(HERE, 'legs', LEG, rel);

// --- clean slate ----------------------------------------------------------
fs.rmSync(path.join(HERE, 'legs', LEG), { recursive: true, force: true });
for (const d of [
  'home/profiles/headless',
  'home/profiles/web',
  'home/.agent-presets/cm-drill',
  'home/sessions',
  'state',
  'workdir',
]) fs.mkdirSync(legDir(d), { recursive: true });

const copy = (from, to) => {
  fs.copyFileSync(from, to);
  return to;
};

// --- home root: byte-copy production settings.yaml (no literals inside) ----
copy(PROD_SETTINGS, legDir('home/settings.yaml'));

// --- headless profile shell (mirrors production profiles/headless) --------
copy(path.join(PROD_HEADLESS_PROFILE, 'package.json'), legDir('home/profiles/headless/package.json'));
copy(path.join(PROD_HEADLESS_PROFILE, 'pnpm-workspace.yaml'), legDir('home/profiles/headless/pnpm-workspace.yaml'));
fs.writeFileSync(legDir('home/profiles/headless/cordis.yml'), '[]\n');

// web plugin files referenced with '../web/...' from the profile patch.
// Copy the full relative-import closure so sibling/core modules come along.
const WEB_ENTRIES = ['openrouter-router.mjs', 'agentrouter-wire.mjs', 'tool-output-offload.mjs']
  .map((f) => path.join(PROD_WEB_PROFILE, f));
const IMPORT_RE = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
function collectWebClosure(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const f = path.normalize(queue.pop());
    if (seen.has(f)) continue;
    if (!fs.existsSync(f)) continue;
    seen.add(f);
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const resolved = path.normalize(path.resolve(path.dirname(f), m[1]));
      if (resolved.startsWith(path.normalize(PROD_WEB_PROFILE))) queue.push(resolved);
    }
  }
  return [...seen];
}
for (const src of collectWebClosure(WEB_ENTRIES)) {
  const rel = path.relative(PROD_WEB_PROFILE, src);
  const dst = legDir(path.join('home/profiles/web', rel));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// profile patch: same three inserts production headless uses + preset selector
const patch = `# gate7 isolated leg "${LEG}" — generated
- insert:
    - id: openrouter-router
      name: '../web/openrouter-router.mjs'
      config:
        diagnostics: false
- insert:
    - id: agentrouter-wire
      name: '../web/agentrouter-wire.mjs'
      config: {}
- insert:
    - id: tool-output-offload
      name: '../web/tool-output-offload.mjs'
      config: {}
- id: agent-presets
  config:
    default: cm-drill
`;
fs.writeFileSync(legDir('home/profiles/headless/cordis.patch.yml'), patch);

// --- cm-drill agent preset -------------------------------------------------
fs.writeFileSync(
  legDir('home/.agent-presets/cm-drill/preset.yml'),
  'name: CM 演练\ndescription: context-memory kill-switch drill preset\norder: 90\n'
);
for (const f of ['context-memory.mjs', 'context-memory-core.mjs', 'tool-output-offload.mjs']) {
  copy(path.join(PROD_PRESET_DIR, f), legDir(`home/.agent-presets/cm-drill/${f}`));
}

// composition: byte-copy production autonomous composition, then override ONLY
// the context-memory config block (line-based so source EOL/BOM stay intact).
let comp = fs.readFileSync(path.join(PROD_PRESET_DIR, 'agent.cordis.yml'), 'utf8');
const stateDirAbs = path.join(legDir('state')).replaceAll('\\', '/');
const WANT = [
  '    - id: context-memory',
  "      name: './context-memory.mjs'",
  '      config:',
];
const NEW_LINES = [
  `        enabled: ${ENABLED}`,
  '        activationThresholdTokens: 10',
  '        recentWindowNodes: 1',
  '        minNewNodes: 1',
  `        stateDir: '${stateDirAbs}'`,
];
const lines = comp.split(/\r?\n/);
const at = lines.findIndex((l) => l === WANT[0]);
const bad = () => {
  throw new Error('context-memory block not found/shape-mismatched in production composition — aborting before writing anything half-built');
};
if (at < 0 || at + 3 >= lines.length
  || lines[at + 1] !== WANT[1] || lines[at + 2] !== WANT[2]
  || lines[at + 3] !== '        enabled: true') bad();
lines.splice(at + 3, 1, ...NEW_LINES);
comp = lines.join(comp.includes('\r\n') ? '\r\n' : '\n');
fs.writeFileSync(legDir('home/.agent-presets/cm-drill/agent.cordis.yml'), comp);

// manifest for verify step
fs.writeFileSync(
  legDir('manifest.json'),
  JSON.stringify(
    { leg: LEG, enabled: ENABLED, stateDir: stateDirAbs,
      createdAt: new Date().toISOString() },
    null,
    2
  )
);

console.log(`[make] leg=${LEG} enabled=${ENABLED} stateDir=${stateDirAbs}`);
console.log('[make] OK');
