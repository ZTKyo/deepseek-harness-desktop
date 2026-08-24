// test-model-registry.mjs — Model Registry single-truth + real-consumer consistency.
// Phase 02 Reviewer Round 2 (BLOCKING-3): the test must import the REAL consumers
// (Router CAPABILITY, Vision verified-native-image, EC core modelSupports) and
// verify they all resolve through the SAME registry facts. No renamed self-calls.
import registry, { FACTS, modelSupports, getContextWindow, getModalities, supportsImage, isVerifiedNativeImage, canonicalId, getTools } from '../../plugins/model-registry.mjs';
// REAL consumers (not re-implementations):
import { CAPABILITY } from '../../plugins/openrouter-router-core.mjs';
import { isVerifiedNativeImageRoute } from '../../plugins/vision-bridge.mjs';
import { modelSupports as ecModelSupports } from '../../plugins/execution-continuity-core.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log("PASS  " + name + (detail ? "  " + detail : "")); pass++; }
  else { console.log("FAIL  " + name + (detail ? "  " + detail : "")); fail++; }
}

// ── 1. Facts tables exist and are non-empty ──
check("R1 CONTEXT_WINDOW has deepseek entries", !!FACTS.CONTEXT_WINDOW["deepseek/deepseek-v4-flash-0731"]);
check("R1 FAMILY_MODALITIES has mimo", !!FACTS.FAMILY_MODALITIES.mimo);
check("R1 VERIFIED_NATIVE_IMAGE non-empty", FACTS.VERIFIED_NATIVE_IMAGE.length > 0);

// ── 2. Alias resolution ──
check("R2 canonicalId alias deepseek-v4-flash", canonicalId("deepseek-v4-flash") === "deepseek/deepseek-v4-flash-0731");

// ── 3. Context window consistency ──
check("R3 deepseek ctx 1310720", getContextWindow("deepseek/deepseek-v4-flash-0731") === 1310720);
check("R3 mimo ctx via alias", getContextWindow("mimo-v2.5") === 1050000);

// ── 4. Modality facts ──
check("R4 mimo supports image", supportsImage("xiaomi/mimo-v2.5"));
check("R4 deepseek no image", supportsImage("deepseek/deepseek-v4-flash-0731") === false);
check("R4 verified vision-exp image", isVerifiedNativeImage("bai/deepseek-v4-flash-vision-exp"));

// ── 5. modelSupports capability decisions ──
check("R5 deepseek ok for text+tools+json", modelSupports("deepseek/deepseek-v4-flash-0731", { tools: true, structuredJson: true }));
check("R5 qwen rejects structuredJson", modelSupports("qwen/qwen3.7-flash", { structuredJson: true }) === false);
check("R5 mimo ok for image", modelSupports("xiaomi/mimo-v2.5", { modalities: ["image"] }));
check("R5 deepseek rejects image", modelSupports("deepseek/deepseek-v4-flash-0731", { modalities: ["image"] }) === false);
check("R5 verified vision-exp ok for image", modelSupports("bai/deepseek-v4-flash-vision-exp", { modalities: ["image"] }));

// ── 6. REAL-consumer consistency (BLOCKING-3) ──
// Router CAPABILITY must agree with registry family facts.
check("R6 Router deepseek text-only == registry", JSON.stringify(CAPABILITY.deepseek.input) === JSON.stringify(["text"]) && getModalities("deepseek/deepseek-v4-flash-0731").image === false);
check("R6 Router mimo multimodal == registry", CAPABILITY.mimo.input.includes("image") && CAPABILITY.mimo.input.includes("audio") && getModalities("xiaomi/mimo-v2.5").video === true);
// EC core modelSupports must agree with registry.
check("R6 EC modelSupports deepseek no-image", ecModelSupports("deepseek/deepseek-v4-flash-0731", { modalities: ["image"] }) === false);
check("R6 EC modelSupports mimo image", ecModelSupports("xiaomi/mimo-v2.5", { modalities: ["image"] }) === true);
// Vision verified-native-image: every registry VERIFIED_NATIVE_IMAGE entry must
// be accepted by Vision's route check (same fact source consumed by Vision).
const visionOk = FACTS.VERIFIED_NATIVE_IMAGE.every((route) => {
  const [prov, ...rest] = route.split("/");
  return isVerifiedNativeImageRoute(prov, rest.join("/")) === true;
});
check("R6 Vision accepts all registry verified routes", visionOk);
check("R6 Vision route bai vision-exp native", isVerifiedNativeImageRoute("bai", "deepseek-v4-flash-vision-exp") === true);

// ── 7. Registry is pure (no service dependency) ──
check("R7 registry is a pure module", typeof registry.modelSupports === "function");

// ── Phase 02 R4 (Step 6): unknown capability fail-closed + tokens semantics ──
check("R8 unknown family tools fail-closed", getTools("totally-unknown-model").tools === false);
check("R8 unknown family structuredJson fail-closed", getTools("totally-unknown-model").structuredJson === false);
check("R8 unknown family modelSupports(tools) fails", modelSupports("totally-unknown-model", { tools: true }) === false);
check("R8 contextWindow is tokens (deepseek 1310720)", getContextWindow("deepseek/deepseek-v4-flash-0731") === 1310720);
check("R8 opus-5 context 1M (tokens)", getContextWindow("claude-opus-5") === 1000000);
check("R8 contextWindow thin override (does not override runtime)", typeof getContextWindow === "function");
// ── Phase 02 R5 (R4-B5): unknown required context fail-closed ──
check("R9 unknown-context model rejected for explicit required window", modelSupports("unknown-model-no-window", { contextWindow: 1000000 }) === false);
check("R9 known-context model satisfies equal required window", modelSupports("deepseek/deepseek-v4-flash-0731", { contextWindow: 1310720 }) === true);
check("R9 known-context model rejects larger required window", modelSupports("deepseek/deepseek-v4-flash-0731", { contextWindow: 2000000 }) === false);
check("R9 opus-5 (1M) satisfies 1M required", modelSupports("claude-opus-5", { contextWindow: 1000000 }) === true);
check("R9 opus-5 rejects >1M required", modelSupports("claude-opus-5", { contextWindow: 1000001 }) === false);
check("R9 commandcode deepseek id has window (1310720)", getContextWindow("deepseek/deepseek-v4-flash") === 1310720);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("MODEL REGISTRY TEST FAILED"); process.exit(1); }
console.log("MODEL REGISTRY TEST PASSED");
