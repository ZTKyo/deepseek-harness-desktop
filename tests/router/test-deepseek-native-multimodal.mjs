// test-deepseek-native-multimodal.mjs
// DeepSeek Native Multimodal Migration — deterministic unit tests (T1-T7).
//
// Verifies the legacy "image -> Xiaomi/MiMo -> DeepSeek text-only" bridge is lifted
// ONLY for verified vision-capable DeepSeek models, while:
//   - text-only DeepSeek (OpenRouter deepseek/deepseek-v4-flash-0731, bai/deepseek-v4-flash) stays text-only
//     (image still goes to MiMo via router / caption via bridge)  [T4]
//   - MiMo explicit selection still works                          [T5]
//   - audio/video still route to MiMo (DeepSeek unsupported)        [T6]
//   - explicit concrete model id passthrough (exact-model invariant) preserved [T7]
//
// Run: node tests/router/test-deepseek-native-multimodal.mjs (from repo root)
// Imports REPO CANONICAL source only. No ~/.dsh, no credentials required.

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginsDir = path.resolve(__dirname, "../../docs/execution-economy/plugins");

const vision = await import("file:///" + path.join(pluginsDir, "vision-bridge.mjs").split("\\").join("/"));
const {
  canPassThroughNativeImage, isDeepseek, isDeepseekNativeVision, baseModelId, DEFAULT_DEEPSEEK_NATIVE_IMAGE_MODELS,
} = vision;
const core = await import("file:///" + path.join(pluginsDir, "openrouter-router-core.mjs").split("\\").join("/"));
const { route, resolveConfig, aliasSupportsModality, VERIFIED_VISION_DEEPSEEK_IDS, DEFAULT_MODEL_IDS, KNOWN_ROUTING_MODES } = core;

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log("PASS  " + name + (detail ? "  " + detail : "")); pass++; }
  else { console.log("FAIL  " + name + (detail ? "  " + detail : "")); fail++; }
}

const VISION_MODEL = "deepseek-v4-flash-vision-exp";
const TEXTONLY_DEEPSEEK = ["deepseek-v4-flash", "deepseek/deepseek-v4-flash-0731", "deepseek-v4-pro"];
const allowlist = DEFAULT_DEEPSEEK_NATIVE_IMAGE_MODELS;

console.log("=== vision-bridge: canPassThroughNativeImage (native vs text-only) ===");
// T1: verified vision DeepSeek -> native pass-through (no MiMo pre-call)
for (const id of ["deepseek-v4-flash-vision-exp", "deepseek/deepseek-v4-flash-vision-exp"]) {
  check(`T1 native-image deepseek passthrough: ${id}`, canPassThroughNativeImage({ inputModalities: ["text", "image"] }, id, allowlist) === true, "nativeImage=true");
}
// T4: text-only DeepSeek -> still caption via MiMo (nativeImage=false)
for (const id of TEXTONLY_DEEPSEEK) {
  check(`T4 text-only deepseek stays bridged: ${id}`, canPassThroughNativeImage({ inputModalities: ["text", "image"] }, id, allowlist) === false, "nativeImage=false");
}
// T4b: deepseek with NO image declaration -> caption
check("T4b deepseek without image modality -> bridged", canPassThroughNativeImage({ inputModalities: ["text"] }, VISION_MODEL, allowlist) === false, "nativeImage=false");
// T5: non-deepseek native multimodal (mimo/qwen) -> passthrough (never captioned)
check("T5 mimo native passthrough", canPassThroughNativeImage({ inputModalities: ["text", "image"] }, "mimo-v2.5", allowlist) === true, "nativeImage=true");
check("T5 xiaomi/mimo-v2.5 native passthrough", canPassThroughNativeImage({ inputModalities: ["text", "image"] }, "xiaomi/mimo-v2.5", allowlist) === true, "nativeImage=true");
// resolveModelInfo failure (null info) -> conservative false
check("T1b resolveModelInfo null -> conservative bridged", canPassThroughNativeImage(null, VISION_MODEL, allowlist) === false, "nativeImage=false");

console.log("=== vision-bridge helpers ===");
check("isDeepseek('deepseek-v4-flash-vision-exp')", isDeepseek(VISION_MODEL) === true);
check("isDeepseek('xiaomi/mimo-v2.5')", isDeepseek("xiaomi/mimo-v2.5") === false);
check("baseModelId('deepseek/deepseek-v4-flash-vision-exp')==deepseek-v4-flash-vision-exp", baseModelId("deepseek/deepseek-v4-flash-vision-exp") === VISION_MODEL);
check("isDeepseekNativeVision base match", isDeepseekNativeVision("deepseek/deepseek-v4-flash-vision-exp", allowlist) === true);
check("isDeepseekNativeVision no match", isDeepseekNativeVision("deepseek/deepseek-v4-flash", allowlist) === false);

console.log("=== router-core: capability distinction & routing ===");
const defaultCfg = resolveConfig({});
// Default openrouter deepseek alias is text-only -> image routes to MiMo (T4)
const autoImgDefault = route({ requestedMode: "auto", modalities: ["image"], text: "describe" }, {});
check("T4 default (text-only deepseek) auto+image -> mimo", autoImgDefault.selected_model === "mimo", "rule=" + autoImgDefault.rule_id);
check("T4 default deepseek alias id is text-only openrouter model", defaultCfg.modelIds.deepseek === DEFAULT_MODEL_IDS.deepseek && DEFAULT_MODEL_IDS.deepseek === "deepseek/deepseek-v4-flash-0731", defaultCfg.modelIds.deepseek);

// With deepseek alias configured to a VERIFIED vision model -> image routes to deepseek (T1/T2/T3)
const visionEnv = { OPENROUTER_DEEPSEEK_MODEL: "deepseek/deepseek-v4-flash-vision-exp" };
const visionCfg = resolveConfig(visionEnv);
check("aliasSupportsModality deepseek(image) true when alias=vision model", aliasSupportsModality("deepseek", "image", visionCfg) === true, visionCfg.modelIds.deepseek);
check("aliasSupportsModality deepseek(image) false when default text-only", aliasSupportsModality("deepseek", "image", defaultCfg) === false, defaultCfg.modelIds.deepseek);
const autoImgVision = route({ requestedMode: "auto", modalities: ["image"], text: "describe" }, visionEnv);
check("T1 vision-deepseek auto+image -> deepseek (not mimo)", autoImgVision.selected_model === "deepseek" && autoImgVision.selected_model_id === "deepseek/deepseek-v4-flash-vision-exp", "rule=" + autoImgVision.rule_id + " id=" + autoImgVision.selected_model_id);
check("T2 decision reports provider/model id", autoImgVision.selected_model_id === "deepseek/deepseek-v4-flash-vision-exp", autoImgVision.selected_model_id);
check("T3 fallback_modalities preserves image", JSON.stringify(autoImgVision.fallback_modalities) === JSON.stringify(["image"]), JSON.stringify(autoImgVision.fallback_modalities));
check("T3 vision-deepseek fallback chain includes deepseek", autoImgVision.fallback_chain.includes("deepseek"), JSON.stringify(autoImgVision.fallback_chain));

// T6: audio always MiMo; video always MiMo (DeepSeek unsupported)
const audio = route({ requestedMode: "auto", modalities: ["audio"], text: "x" }, visionEnv);
check("T6 audio -> mimo (even with vision-deepseek)", audio.selected_model === "mimo", "rule=" + audio.rule_id);
const video = route({ requestedMode: "auto", modalities: ["video"], text: "x" }, visionEnv);
check("T6 video -> mimo (even with vision-deepseek)", video.selected_model === "mimo", "rule=" + video.rule_id);

// T5: explicit MiMo still works with image
const mimoExplicit = route({ requestedMode: "mimo", modalities: ["image"] }, {});
check("T5 explicit mimo + image -> mimo", mimoExplicit.selected_model === "mimo" && mimoExplicit.selected_model_id === "xiaomi/mimo-v2.5", mimoExplicit.selected_model_id);

// T7: explicit concrete model id passthrough (exact-model invariant)
const ox = route({ requestedMode: "stealth/ox-alpha" }, {});
check("T7 explicit stealth/ox-alpha preserved", ox.selected_model_id === "stealth/ox-alpha" && ox.rule_id === "explicit_model_passthrough", ox.selected_model_id + " rule=" + ox.rule_id);
const vendor = route({ requestedMode: "vendor/future-model" }, {});
check("T7 explicit vendor/future-model preserved", vendor.selected_model_id === "vendor/future-model" && vendor.rule_id === "explicit_model_passthrough", vendor.selected_model_id);
check("T7 KNOWN_ROUTING_MODES unchanged", KNOWN_ROUTING_MODES.has("auto") && KNOWN_ROUTING_MODES.has("deepseek") && KNOWN_ROUTING_MODES.has("mimo") && KNOWN_ROUTING_MODES.has("qwen") && !KNOWN_ROUTING_MODES.has("stealth/ox-alpha"));

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
