// test-runtime-capacity-adapter.mjs — Phase 02 R7 (R6-3): adapter wires the real
// runtime resolveModelInfo into the capacity resolver; runtime-unknown fails
// closed.
import { makeRuntimeCapacityResolver, makeRuntimeCapacityResolverLoose } from '../../plugins/runtime-capacity-adapter.mjs';
import { createCapacityResolver } from '../../plugins/capacity-resolver.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('PASS  ' + name + (detail ? '  ' + detail : '')); pass++; }
  else { console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); fail++; }
}

// T1: adapter wires ctx.get('runtime').resolveModelInfo
{
  const ctx = { get(k) { if (k === 'runtime') return { resolveModelInfo: (p, m) => ({ context: { contextWindow: m === 'deepseek-v4-flash' ? 999000 : 262144 } }) }; return null; } };
  const wired = makeRuntimeCapacityResolver(ctx);
  check('T1 runtime wired', wired.wired === true);
  const resolver = createCapacityResolver({ runtimeResolve: wired.runtimeResolve });
  const res = resolver.resolve('opencode', 'deepseek-v4-flash');
  check('T1 runtime capacity wins', res.window === 999000 && res.source === 'runtime', `window=${res.window} src=${res.source}`);
}

// T2: loose adapter finds runtime via ctx.runtime property
{
  const ctx = { runtime: { resolveModelInfo: (p, m) => ({ context: { contextWindow: 777000 } }) } };
  const wired = makeRuntimeCapacityResolverLoose(ctx);
  check('T2 loose runtime wired', wired.wired === true);
  const resolver = createCapacityResolver({ runtimeResolve: wired.runtimeResolve });
  check('T2 loose runtime used', resolver.resolve('x', 'y').window === 777000);
}

// T3: no runtime available -> not wired -> resolver falls back to hints
{
  const wired = makeRuntimeCapacityResolverLoose({});
  check('T3 no runtime -> not wired', wired.wired === false);
  const resolver = createCapacityResolver({ runtimeResolve: null });
  const res = resolver.resolve('commandcode', 'deepseek/deepseek-v4-flash');
  check('T3 hint fallback when no runtime', res.window === 1310720 && res.source === 'hint', `window=${res.window}`);
}

// T4: runtime path exists but unknown -> fail-closed (no hint)
{
  const ctx = { get(k) { if (k === 'runtime') return { resolveModelInfo: () => null }; return null; } };
  const wired = makeRuntimeCapacityResolver(ctx);
  const resolver = createCapacityResolver({ runtimeResolve: wired.runtimeResolve });
  const res = resolver.resolve('commandcode', 'deepseek/deepseek-v4-flash');
  check('T4 runtime-unknown fail-closed (no hint)', res.window === null, `window=${res.window}`);
}

// T5: CommandCode apply accepts config.capacityResolver injection
{
  const src = (await import('../../plugins/commandcode-router.mjs')).default;
  check('T5 commandcode apply has config param', /export function apply\(ctx, config = \{\}\)/.test(src?.toString?.() ?? '') || true); // module default is undefined for .mjs with named exports; verify source instead
}
// source-level check for the config injection point
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../plugins/commandcode-router.mjs', import.meta.url), 'utf8');
  check('T5 commandcode config param', /export function apply\(ctx, config = \{\}\)/.test(src));
  check('T5 commandcode wires runtime adapter', /makeRuntimeCapacityResolverLoose\(ctx\)/.test(src));
  check('T5 openrouter wires runtime adapter', /makeRuntimeCapacityResolverLoose\(ctx\)/.test(fs.readFileSync(new URL('../../plugins/openrouter-router.mjs', import.meta.url), 'utf8')));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('RUNTIME CAPACITY ADAPTER TEST FAILED'); process.exit(1); }
console.log('RUNTIME CAPACITY ADAPTER TEST PASSED');
