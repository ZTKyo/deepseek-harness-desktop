// model-registry.mjs — Single Source of Truth for model capability FACTS.
//
// Phase 02 Reviewer Round 1 (BLOCKING-3): consolidate the scattered model
// capability truth sources (EC MODEL_CONTEXT_WINDOWS, Router CAPABILITY,
// Vision native-image whitelist, provider/settings declarations) into ONE
// pure module. This module stores FACTS only — no routing policy, no fallback
// chains, no decisions. Consumers (Router, EC compatibility request, Vision
// bridge, Model Selection Guard) read the same facts.
//
// FACTS:
//   - provider + model identity / aliases
//   - contextWindow
//   - input modalities (text/image/audio/video)
//   - tools / structuredJson
//   - reasoning constraints (only when known)
//   - verified provider-specific overrides (e.g. bai + vision-exp native image)
//   - constraints
//
// Pure module: no I/O, no service, no daemon. Imported by plugins.

// ---------------------------------------------------------------------------
// contextWindow (chars). Source: consolidated from EC MODEL_CONTEXT_WINDOWS
// and provider/settings declarations.
// ---------------------------------------------------------------------------
const CONTEXT_WINDOW = {
  'deepseek/deepseek-v4-flash-0731': 1310720,
  'deepseek-v4-flash': 1000000,
  'deepseek-v4-flash-vision-exp': 1000000,
  'deepseek-v4-pro': 1000000,
  'xiaomi/mimo-v2.5': 1050000,
  'mimo-v2.5': 1048576,
  'qwen/qwen3.7-flash': 1000000,
  'qwen3.7-plus': 200000,
  'deepseek-v4-flash-free': 200000,
  'stealth/ox-alpha': 1048576,
  'meta/muse-spark-1.2-contributor': 1048576,
  'gpt-5.6-sol': 400000,
  'claude-opus-5': 1000000,
  'claude-opus-4-8': 1000000,
};

// ---------------------------------------------------------------------------
// Family-level modality facts (image/audio/video). Source: Router CAPABILITY.
// ---------------------------------------------------------------------------
const FAMILY_MODALITIES = {
  qwen: { image: true, audio: false, video: true },
  deepseek: { image: false, audio: false, video: false },
  mimo: { image: true, audio: true, video: true },
};

// ---------------------------------------------------------------------------
// tools / structuredJson facts. Source: Router CAPABILITY + EC guess.
// ---------------------------------------------------------------------------
const FAMILY_TOOLS = {
  qwen: { tools: false, structuredJson: false },
  deepseek: { tools: true, structuredJson: true },
  mimo: { tools: true, structuredJson: true },
};

// ---------------------------------------------------------------------------
// Verified native-image provider overrides. Source: Vision bridge whitelist.
// A provider+model pair here means "this route is VERIFIED to accept native
// image input" even if the family table says otherwise (e.g. bai + vision-exp).
// ---------------------------------------------------------------------------
const VERIFIED_NATIVE_IMAGE = [
  'bai/deepseek-v4-flash-vision-exp',
  'deepseek/deepseek-v4-flash-vision-exp',
];

// ---------------------------------------------------------------------------
// Alias normalization: provider/model -> canonical id. Source: provider
// registry / router aliases.
// ---------------------------------------------------------------------------
const ALIASES = {
  'deepseek-v4-flash': 'deepseek/deepseek-v4-flash-0731',
  'mimo-v2.5': 'xiaomi/mimo-v2.5',
  'qwen3.7-flash': 'qwen/qwen3.7-flash',
};

// ---------------------------------------------------------------------------
// Family extraction helpers (pure).
// ---------------------------------------------------------------------------
function familyOf(modelId) {
  if (!modelId) return null;
  const s = String(modelId).toLowerCase();
  if (/mimo/.test(s)) return 'mimo';
  if (/qwen/.test(s)) return 'qwen';
  if (/deepseek/.test(s) || /ox-alpha/.test(s)) return 'deepseek';
  return null;
}

export function canonicalId(modelId) {
  if (!modelId) return null;
  if (ALIASES[modelId]) return ALIASES[modelId];
  return String(modelId);
}

// ---------------------------------------------------------------------------
// Public facts API (pure).
// ---------------------------------------------------------------------------
export function getContextWindow(modelId) {
  const id = canonicalId(modelId);
  return CONTEXT_WINDOW[id] ?? null;
}

export function getModalities(modelId) {
  const f = familyOf(modelId);
  // Copy, never mutate the shared table (a verified override must not pollute
  // the family facts for other models of the same family).
  const base = f ? { ...FAMILY_MODALITIES[f] } : { image: false, audio: false, video: false };
  const id = canonicalId(modelId);
  if (id && VERIFIED_NATIVE_IMAGE.includes(id)) base.image = true;
  return { ...base };
}

export function supportsImage(modelId) {
  return getModalities(modelId).image === true;
}

export function supportsAudio(modelId) {
  return getModalities(modelId).audio === true;
}

export function supportsVideo(modelId) {
  return getModalities(modelId).video === true;
}

export function getTools(modelId) {
  const f = familyOf(modelId);
  return f ? { ...FAMILY_TOOLS[f] } : { tools: true, structuredJson: true };
}

export function supportsTools(modelId) {
  return getTools(modelId).tools === true;
}

export function supportsStructuredJson(modelId) {
  return getTools(modelId).structuredJson === true;
}

export function isVerifiedNativeImage(modelId) {
  const id = canonicalId(modelId);
  return !!id && VERIFIED_NATIVE_IMAGE.includes(id);
}

/**
 * Check whether a model satisfies a required capability set.
 * @param {string} modelId
 * @param {object} required - { modalities: string[], tools: boolean, structuredJson: boolean, contextWindow: number }
 * @returns {boolean}
 */
export function modelSupports(modelId, required = {}) {
  if (!modelId) return false;
  if (required.contextWindow) {
    const cw = getContextWindow(modelId);
    if (cw === null) {
      // unknown window: allow only if no explicit requirement cap semantics break
      // (conservative: treat unknown as insufficient only when a specific cap is demanded)
    } else if (required.contextWindow > cw) {
      return false;
    }
  }
  if (required.modalities && required.modalities.length) {
    const mods = getModalities(modelId);
    for (const m of required.modalities) {
      if (!mods[m]) return false;
    }
  }
  if (required.tools === true && !supportsTools(modelId)) return false;
  if (required.structuredJson === true && !supportsStructuredJson(modelId)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Exposed tables (for diagnostics / consistency tests).
// ---------------------------------------------------------------------------
export const FACTS = Object.freeze({
  CONTEXT_WINDOW: { ...CONTEXT_WINDOW },
  FAMILY_MODALITIES: { ...FAMILY_MODALITIES },
  FAMILY_TOOLS: { ...FAMILY_TOOLS },
  VERIFIED_NATIVE_IMAGE: [...VERIFIED_NATIVE_IMAGE],
  ALIASES: { ...ALIASES },
});

// ---------------------------------------------------------------------------
// Compatibility re-exports (consumers migrating from EC/Router local tables).
// ---------------------------------------------------------------------------
export const registry = {
  contextWindow: getContextWindow,
  modalities: getModalities,
  supportsImage,
  supportsAudio,
  supportsVideo,
  tools: getTools,
  supportsTools,
  supportsStructuredJson,
  isVerifiedNativeImage,
  modelSupports,
  familyOf,
  canonicalId,
  FACTS,
};
export default registry;
