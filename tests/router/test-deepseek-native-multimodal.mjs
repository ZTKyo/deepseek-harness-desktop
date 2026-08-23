// test-deepseek-native-multimodal.mjs
// DeepSeek Native Multimodal Migration — deterministic unit tests.
//
// Verifies the legacy "image -> Xiaomi/MiMo -> DeepSeek text-only" bridge is lifted
// ONLY for VERIFIED (provider+model) native-vision DeepSeek routes, while:
//   - same model name on an UNVERIFIED provider is NOT auto-allowed      [T4]
//   - text-only DeepSeek (bai/deepseek-v4-flash, openrouter/...0731) stays bridged [T4]
//   - non-deepseek native multimodal (mimo) still passes through          [T5]
//   - audio/video still route to MiMo (DeepSeek unsupported, main behavior) [T6]
//   - explicit concrete model id passthrough (exact-model invariant) preserved [T7]
//
// Run: node tests/router/test-deepseek-native-multimodal.mjs (from repo root)
// Imports REPO CANONICAL source only. No ~/.dsh, no credentials required.

import { fileURLToPath } from "node:url";
import path from "node:path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginsDir = path.resolve(__dirname, "../../plugins");

const vision = await import("file:///" + path.join(pluginsDir, "vision-bridge.mjs").split("\\").join("/"));
const {
  canPassThroughNativeImage, isDeepseek, isVerifiedNativeImageRoute, normalizeProvider,
  baseModelId, DEFAULT_VERIFIED_NATIVE_IMAGE,
} = vision;
const core = await import("file:///" + path.join(pluginsDir, "openrouter-router-core.mjs").split("\\").join("/"));
const { route, KNOWN_ROUTING_MODES } = core;

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log("PASS  " + name + (detail ? "  " + detail : "")); pass++; }
  else { console.log("FAIL  " + name + (detail ? "  " + detail : "")); fail++; }
}

const allowlist = DEFAULT_VERIFIED_NATIVE_IMAGE; // ["bai/deepseek-v4-flash-vision-exp"]
const imgInfo = { inputModalities: ["text", "image"] };

console.log("=== T1/T3: VERIFIED provider+model -> native passthrough (image preserved, no MiMo pre-call) ===");
check("T1 bai/deepseek-v4-flash-vision-exp native", canPassThroughNativeImage(imgInfo, "bai", "deepseek-v4-flash-vision-exp", allowlist) === true, "nativeImage=true");
check("T1 provider case-insensitive (BAI)", canPassThroughNativeImage(imgInfo, "BAI", "deepseek-v4-flash-vision-exp", allowlist) === true, "nativeImage=true");
check("T1 model id with provider prefix", canPassThroughNativeImage(imgInfo, "bai", "deepseek/deepseek-v4-flash-vision-exp", allowlist) === true, "nativeImage=true");
check("T3 image modality preserved (native decision true)", canPassThroughNativeImage(imgInfo, "bai", "deepseek-v4-flash-vision-exp", allowlist) === true, "-> passthrough decision unchanged");

console.log("=== T4: text-only / unverified providers stay bridged (old safety fallback kept) ===");
check("T4 bai/deepseek-v4-flash (text-only) bridged", canPassThroughNativeImage(imgInfo, "bai", "deepseek-v4-flash", allowlist) === false, "nativeImage=false");
check("T4 openrouter/deepseek/deepseek-v4-flash-0731 bridged", canPassThroughNativeImage(imgInfo, "openrouter", "deepseek/deepseek-v4-flash-0731", allowlist) === false, "nativeImage=false");
check("T4 opencode/deepseek-v4-flash-vision-exp SAME NAME unverified provider -> bridged", canPassThroughNativeImage(imgInfo, "opencode", "deepseek-v4-flash-vision-exp", allowlist) === false, "nativeImage=false");
check("T4 openrouter/deepseek-v4-flash-vision-exp SAME NAME unverified provider -> bridged", canPassThroughNativeImage(imgInfo, "openrouter", "deepseek-v4-flash-vision-exp", allowlist) === false, "nativeImage=false");
check("T4 commandcode/deepseek-v4-flash-vision-exp SAME NAME unverified provider -> bridged", canPassThroughNativeImage(imgInfo, "commandcode", "deepseek-v4-flash-vision-exp", allowlist) === false, "nativeImage=false");
check("T4b verified model WITHOUT image declaration -> bridged", canPassThroughNativeImage({ inputModalities: ["text"] }, "bai", "deepseek-v4-flash-vision-exp", allowlist) === false, "nativeImage=false");
check("T4c resolveModelInfo null (info) -> conservative bridged", canPassThroughNativeImage(null, "bai", "deepseek-v4-flash-vision-exp", allowlist) === false, "nativeImage=false");

console.log("=== T5: non-deepseek native multimodal (mimo/qwen) passthrough regardless of provider ===");
check("T5 opencode/mimo-v2.5 native", canPassThroughNativeImage(imgInfo, "opencode", "mimo-v2.5", allowlist) === true, "nativeImage=true");
check("T5 xiaomi/mimo-v2.5 native", canPassThroughNativeImage(imgInfo, "xiaomi", "mimo-v2.5", allowlist) === true, "nativeImage=true");
check("T5 bai/mimo-v2.5 native", canPassThroughNativeImage(imgInfo, "bai", "mimo-v2.5", allowlist) === true, "nativeImage=true");

console.log("=== helpers ===");
check("isDeepseek('deepseek-v4-flash-vision-exp')", isDeepseek("deepseek-v4-flash-vision-exp") === true);
check("isDeepseek('xiaomi/mimo-v2.5')", isDeepseek("xiaomi/mimo-v2.5") === false);
check("baseModelId('deepseek/deepseek-v4-flash-vision-exp')", baseModelId("deepseek/deepseek-v4-flash-vision-exp") === "deepseek-v4-flash-vision-exp");
check("normalizeProvider(' BAI ') -> bai", normalizeProvider(" BAI ") === "bai");
check("isVerifiedNativeImageRoute exact match", isVerifiedNativeImageRoute("bai", "deepseek-v4-flash-vision-exp", allowlist) === true);
check("isVerifiedNativeImageRoute wrong provider", isVerifiedNativeImageRoute("opencode", "deepseek-v4-flash-vision-exp", allowlist) === false);
check("isVerifiedNativeImageRoute wrong model", isVerifiedNativeImageRoute("bai", "deepseek-v4-flash", allowlist) === false);

console.log("=== T6: router (reverted to main) audio/video -> MiMo (DeepSeek unsupported) ===");
const audio = route({ requestedMode: "auto", modalities: ["audio"], text: "x" }, {});
check("T6 audio -> mimo", audio.selected_model === "mimo", "rule=" + audio.rule_id);
const video = route({ requestedMode: "auto", modalities: ["video"], text: "x" }, {});
check("T6 video -> mimo", video.selected_model === "mimo", "rule=" + video.rule_id);

console.log("=== T7: explicit concrete model id passthrough (exact-model invariant, main) ===");
const ox = route({ requestedMode: "stealth/ox-alpha" }, {});
check("T7 explicit stealth/ox-alpha preserved", ox.selected_model_id === "stealth/ox-alpha" && ox.rule_id === "explicit_model_passthrough", ox.selected_model_id);
check("T7 KNOWN_ROUTING_MODES unchanged", KNOWN_ROUTING_MODES.has("auto") && KNOWN_ROUTING_MODES.has("deepseek") && KNOWN_ROUTING_MODES.has("mimo") && KNOWN_ROUTING_MODES.has("qwen") && !KNOWN_ROUTING_MODES.has("stealth/ox-alpha"));

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
