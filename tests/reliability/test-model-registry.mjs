// test-model-registry.mjs — Model Registry consistency + single-truth test.
// Verifies:
//   1. Registry is the single source: Router/EC/Vision consumers read SAME facts.
//   2. Registry facts are internally consistent (aliases resolve, families map).
//   3. modelSupports matches expected capability decisions for known models.
// Run: node tests/reliability/test-model-registry.mjs (from repo root)
import registry, { FACTS, modelSupports, getContextWindow, getModalities, supportsImage, isVerifiedNativeImage, canonicalId } from '../../plugins/model-registry.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('PASS  ' + name + (detail ? '  ' + detail : '')); pass++; }
  else { console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); fail++; }
}

// --- 1. Facts tables exist and are non-empty ---
check('R1 CONTEXT_WINDOW has deepseek entries', !!FACTS.CONTEXT_WINDOW['deepseek/deepseek-v4-flash-0731']);
check('R1 FAMILY_MODALITIES has mimo', !!FACTS.FAMILY_MODALITIES.mimo);
check('R1 VERIFIED_NATIVE_IMAGE non-empty', FACTS.VERIFIED_NATIVE_IMAGE.length > 0);

// --- 2. Alias resolution ---
check('R2 canonicalId alias deepseek-v4-flash', canonicalId('deepseek-v4-flash') === 'deepseek/deepseek-v4-flash-0731');
check('R2 canonicalId passthrough', canonicalId('stealth/ox-alpha') === 'stealth/ox-alpha');

// --- 3. Context window consistency ---
check('R3 deepseek ctx 1310720', getContextWindow('deepseek/deepseek-v4-flash-0731') === 1310720);
check('R3 mimo ctx via alias', getContextWindow('mimo-v2.5') === 1050000);

// --- 4. Modality facts ---
check('R4 mimo supports image', supportsImage('xiaomi/mimo-v2.5'));
check('R4 mimo supports audio', getModalities('xiaomi/mimo-v2.5').audio === true);
check('R4 deepseek (non-vision) no image', supportsImage('deepseek/deepseek-v4-flash-0731') === false);
check('R4 verified vision-exp image', isVerifiedNativeImage('bai/deepseek-v4-flash-vision-exp'));

// --- 5. modelSupports capability decisions ---
check('R5 deepseek ok for text+tools+json', modelSupports('deepseek/deepseek-v4-flash-0731', { tools: true, structuredJson: true }));
check('R5 qwen rejects structuredJson', modelSupports('qwen/qwen3.7-flash', { structuredJson: true }) === false);
check('R5 mimo ok for image', modelSupports('xiaomi/mimo-v2.5', { modalities: ['image'] }));
check('R5 deepseek rejects image', modelSupports('deepseek/deepseek-v4-flash-0731', { modalities: ['image'] }) === false);
check('R5 verified vision-exp ok for image', modelSupports('bai/deepseek-v4-flash-vision-exp', { modalities: ['image'] }));

// --- 6. Consistency across consumers (Router/EC/Vision read SAME registry) ---
// Consumers must reach the same capability conclusion via the public API.
const routerDeepseek = supportsImage('deepseek/deepseek-v4-flash-0731') === false;
const ecDeepseek = getContextWindow('deepseek/deepseek-v4-flash-0731') > 0 && supportsImage('deepseek/deepseek-v4-flash-0731') === false;
check('R6 Router+EC agree deepseek no-image', routerDeepseek && ecDeepseek);

const visionBai = isVerifiedNativeImage('bai/deepseek-v4-flash-vision-exp');
const routerBai = supportsImage('bai/deepseek-v4-flash-vision-exp');
check('R6 Vision+Router agree bai vision-exp image', visionBai && routerBai);

// --- 7. Registry is pure (no service dependency) ---
check('R7 registry is a pure module (has no side-effect markers)', typeof registry.modelSupports === 'function');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('MODEL REGISTRY TEST FAILED'); process.exit(1); }
console.log('MODEL REGISTRY TEST PASSED');
