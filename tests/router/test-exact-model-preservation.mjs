// test-exact-model-preservation.mjs
// OpenRouter Exact Model Preservation — deterministic unit tests.
//
// Verifies the EXPLICIT MODEL IDENTITY INVARIANT:
//   user explicitly requests a concrete provider-owned model id (e.g.
//   stealth/ox-alpha, vendor/future-model) -> Router must preserve it exactly,
//   NOT convert to auto and NOT silently substitute another model.
//
// Also regression-checks: auto unchanged, deepseek/mimo/qwen aliases unchanged.
//
// Run: node tests/router/test-exact-model-preservation.mjs (from repo root)
// Imports the REPO CANONICAL source (plugins/), NOT any
// machine-specific path. Clean checkout + no ~/.dsh + no credentials required.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const canonical = path.resolve(__dirname, '../../plugins/openrouter-router-core.mjs');
const { route, KNOWN_ROUTING_MODES } = await import('file:///' + canonical.split('\\').join('/'));

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('PASS  ' + name + '  ' + detail); pass++; }
  else { console.log('FAIL  ' + name + '  ' + detail); fail++; }
}

// --- routing modes allowlist ---
check('KNOWN_ROUTING_MODES has auto/qwen/deepseek/mimo', KNOWN_ROUTING_MODES.has('auto') && KNOWN_ROUTING_MODES.has('qwen') && KNOWN_ROUTING_MODES.has('deepseek') && KNOWN_ROUTING_MODES.has('mimo'), [...KNOWN_ROUTING_MODES].join(','));
check('KNOWN_ROUTING_MODES does not contain ox-alpha', !KNOWN_ROUTING_MODES.has('stealth/ox-alpha'));

const base = { modalities: [], strictJson: false, estimatedContextTokens: 1000, text: 'Reply exactly: OK', toolsActive: false };

// TEST 1: explicit ox-alpha preserved
const t1 = route({ ...base, requestedMode: 'stealth/ox-alpha' });
check('TEST1 explicit stealth/ox-alpha preserved', t1.selected_model_id === 'stealth/ox-alpha', t1.selected_model_id + ' rule=' + t1.rule_id);

// TEST 6: unknown explicit concrete model preserved (fail-closed, not auto)
const t6 = route({ ...base, requestedMode: 'vendor/future-model' });
check('TEST6 unknown explicit model preserved (not auto)', t6.selected_model_id === 'vendor/future-model', t6.selected_model_id + ' rule=' + t6.rule_id);

// TEST 2: auto unchanged (complex -> deepseek)
const t2 = route({ ...base, requestedMode: 'auto', text: 'write a complex multi-file feature' });
check('TEST2 auto complex -> deepseek (unchanged)', t2.selected_model === 'deepseek', t2.selected_model + ' rule=' + t2.rule_id);

// TEST 3: deepseek alias unchanged
const t3 = route({ ...base, requestedMode: 'deepseek' });
check('TEST3 deepseek alias unchanged', t3.selected_model_id === 'deepseek/deepseek-v4-flash-0731' && t3.selected_model === 'deepseek', t3.selected_model_id);

// TEST 4: mimo alias unchanged
const t4 = route({ ...base, requestedMode: 'mimo', modalities: ['image'] });
check('TEST4 mimo alias unchanged', t4.selected_model_id === 'xiaomi/mimo-v2.5' && t4.selected_model === 'mimo', t4.selected_model_id);

// TEST 5: qwen alias unchanged
const t5 = route({ ...base, requestedMode: 'qwen', text: 'summarize this' });
check('TEST5 qwen alias unchanged', t5.selected_model_id === 'qwen/qwen3.7-flash' && t5.selected_model === 'qwen', t5.selected_model_id);

// TEST 7: empty/undefined requestedMode -> auto default (unchanged default routing)
const t7 = route({ ...base, requestedMode: '' });
check('TEST7 empty requestedMode -> auto default routing', t7.requested_mode === 'auto', t7.requested_mode + '/' + t7.selected_model);

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
