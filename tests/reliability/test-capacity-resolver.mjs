// test-capacity-resolver.mjs — Phase 02 R6 (R5-B5): exact route capacity resolver.
import { createCapacityResolver, defaultCapacityResolver } from '../../plugins/capacity-resolver.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('PASS  ' + name + (detail ? '  ' + detail : '')); pass++; }
  else { console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); fail++; }
}

// T1: runtime resolver is AUTHORITY when it returns a number
{
  const r = createCapacityResolver({ runtimeResolve: (p, m) => (m === 'deepseek-v4-flash' ? 999000 : null) });
  const res = r.resolve('opencode', 'deepseek-v4-flash');
  check('T1 runtime wins over hint', res.window === 999000 && res.source === 'runtime', `window=${res.window} src=${res.source}`);
}

// T2: runtime path EXISTS but returns null -> FAIL-CLOSED (no hint fabrication)
{
  const r = createCapacityResolver({ runtimeResolve: () => null });
  const res = r.resolve('commandcode', 'deepseek/deepseek-v4-flash');
  check('T2 runtime-unknown fails closed (no hint)', res.window === null, `window=${res.window}`);
}

// T3: no runtime path configured -> registry hint (tests/legacy)
{
  const r = createCapacityResolver({});
  const res = r.resolve('commandcode', 'deepseek/deepseek-v4-flash');
  check('T3 hint fallback when no runtime', res.window === 1310720 && res.source === 'hint', `window=${res.window} src=${res.source}`);
}

// T4: unknown model with no runtime -> null (fail-closed)
{
  const r = createCapacityResolver({});
  const res = r.resolve('x', 'totally-unknown-model');
  check('T4 unknown model -> null', res.window === null, `window=${res.window}`);
}

// T5: defaultCapacityResolver behaves like registry-hint
{
  const r = defaultCapacityResolver();
  const res = r.resolve('commandcode', 'deepseek/deepseek-v4-flash');
  check('T5 default resolver hint works', res.window === 1310720, `window=${res.window}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('CAPACITY RESOLVER TEST FAILED'); process.exit(1); }
console.log('CAPACITY RESOLVER TEST PASSED');
