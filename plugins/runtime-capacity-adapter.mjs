// runtime-capacity-adapter.mjs — Phase 02 R7 (R6-3) + R8: thin adapter that wires
// the Harness OFFICIAL exact route capacity resolver (Adapter resolveModel() /
// Runtime resolveModelInfo(provider, model)) into the router capacity
// resolution path. createCapacityResolver({ runtimeResolve }) already fails
// CLOSED when the runtime path exists but cannot resolve — this adapter finds
// that runtime path from the live ctx (realm services) with graceful fallback.
//
// It is intentionally tiny: it only LOCATES the official resolver; the capacity
// decision logic lives in capacity-resolver.mjs.

export function makeRuntimeCapacityResolver(ctx) {
  let runtimeResolve = null;
  try {
    // Official Harness runtime: ctx.get("runtime") / ctx.runtime exposes
    // resolveModelInfo(provider, model) -> Promise<{ context: { contextWindow } }>.
    const runtime = (ctx && (ctx.get ? ctx.get("runtime") : null)) || (ctx && ctx.runtime) || null;
    if (runtime && typeof runtime.resolveModelInfo === "function") {
      // Phase 02 R7 adversarial fix: the official method is ASYNC — await it.
      // A synchronous resolver (tests/mocks) still works because await on a
      // plain value is a no-op.
      runtimeResolve = async (provider, model) => {
        try {
          const info = await runtime.resolveModelInfo(provider, model);
          const w = info && info.context && info.context.contextWindow;
          return typeof w === "number" && w > 0 ? w : null;
        } catch { return null; }
      };
    }
  } catch { runtimeResolve = null; }
  return { runtimeResolve, wired: typeof runtimeResolve === "function" };
}

// Best-effort: try ctx services via common keys, then the runtime property.
export function makeRuntimeCapacityResolverLoose(ctx) {
  let runtimeResolve = null;
  for (const key of ["runtime", "adapterRegistry", "modelRegistry", "llm"]) {
    let svc = null;
    // Phase 02 R8 adversarial fix: ctx.get(key) can THROW for unknown keys on
    // some hosts — previously ONE throw aborted the WHOLE loop (wired=false
    // even though ctx.llm.resolveModelInfo exists, as diagnosed via CTX-LLM:
    // type=LlmRuntime resolveModelInfo=function). Isolate each key lookup.
    try { svc = ctx && typeof ctx.get === "function" ? ctx.get(key) : null; } catch { svc = null; }
    if (!svc && ctx) { try { svc = ctx[key]; } catch { svc = null; } }
    if (!svc) continue;
    const fn = svc.resolveModelInfo || (svc.models && typeof svc.models.resolveModelInfo === "function" && svc.models.resolveModelInfo);
    if (typeof fn === "function") {
      runtimeResolve = async (provider, model) => {
        try {
          const info = await fn.call(svc, provider, model);
          const w = info && info.context && info.context.contextWindow;
          return typeof w === "number" && w > 0 ? w : null;
        } catch { return null; }
      };
      break;
    }
  }
  return { runtimeResolve, wired: typeof runtimeResolve === "function" };
}
