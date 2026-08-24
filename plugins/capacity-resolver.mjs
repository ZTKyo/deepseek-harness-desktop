// capacity-resolver.mjs — Phase 02 R6 (R5-B5): EXACT route capacity resolver.
// The Authority for {provider, model} context capacity is the Harness Adapter/
// Runtime resolveModelInfo(provider, model). This module exposes an INJECTABLE
// resolver: production wires it to the runtime official path; when the runtime
// cannot resolve (or is unavailable in tests), it falls back to the registry's
// provenance-backed STATIC hint — but only as a hint, and unknown runtime
// capacity fails CLOSED (never claims a capacity it cannot prove).
//
// API:
//   createCapacityResolver({ runtimeResolve, hintWindow })
//     runtimeResolve(provider, model) -> number|null   (official runtime path)
//     hintWindow(provider, model)     -> number|null   (registry static hint)
//   returns resolve(provider, model) -> { window, source: 'runtime'|'hint'|null }
import { getContextWindow } from './model-registry.mjs';

export function createCapacityResolver(opts = {}) {
  const runtimeResolve = opts.runtimeResolve || null;
  const hintWindow = opts.hintWindow || ((provider, model) => {
    // registry getContextWindow is modelId-based; try model first, then
    // provider/model composite
    try {
      const w = getContextWindow(model);
      if (w !== null && w !== undefined) return w;
      const composite = model.startsWith(provider + '/') ? model : provider + '/' + model;
      return getContextWindow(composite) ?? null;
    } catch { return null; }
  });

  // Phase 02 R7 adversarial fix: resolve() is ASYNC because the official Harness
  // runtime resolveModelInfo(provider, model) is an async method — treating its
  // return value synchronously would read a Promise (context always undefined ->
  // permanent fail-closed, i.e. the "wiring" silently never fires). We await the
  // runtime result; a synchronous resolver (tests) still works.
  async function resolve(provider, model) {
    // 1) runtime official path is the AUTHORITY
    if (typeof runtimeResolve === 'function') {
      try {
        const w = await runtimeResolve(provider, model);
        if (typeof w === 'number' && Number.isFinite(w) && w > 0) {
          return { window: w, source: 'runtime' };
        }
      } catch { /* runtime unavailable -> fall through */ }
    }
    // 2) runtime unknown -> FAIL-CLOSED: do NOT fabricate a capacity from the
    //    static hint when the runtime path exists but could not resolve.
    if (typeof runtimeResolve === 'function') {
      return { window: null, source: null }; // fail-closed (runtime authoritative)
    }
    // 3) no runtime path configured (tests / legacy) -> registry hint only
    try {
      const w = hintWindow(provider, model);
      if (typeof w === 'number' && Number.isFinite(w) && w > 0) return { window: w, source: 'hint' };
    } catch {}
    return { window: null, source: null };
  }

  return { resolve, hintWindow, runtimeResolve };
}

// Default resolver: no runtime path (tests) -> registry hint.
export function defaultCapacityResolver() {
  return createCapacityResolver({});
}
