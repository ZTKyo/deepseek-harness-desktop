// ac10-entry-diag.mjs — DIAGNOSTIC ONLY (removed before the final gate change).
// Prints the cordis loader entry tree, the HMR fallback path, and fiber states into the
// boot's stdout, so a host where `dsh web` fails with
//   "user patch-layer watching requires the Cordis HMR service"
// reports WHY ctx.get('hmr') is still undefined after profile-boot's create() call.
export const name = 'ac10-entry-diag';

export function apply(ctx) {
  const log = (...args) => {
    try { console.log('[ac10-diag]', ...args); } catch {}
  };
  const summarize = (entry) => {
    try {
      const state = entry?.fiber?.state;
      const error = entry?.fiber?.error;
      const msg = error ? String(error.message || error) : '';
      return `state=${state}${entry?.options?.disabled ? ' DISABLED' : ''}${msg ? ` ERR=${msg}` : ''}`;
    } catch (e) {
      return `state? (${String(e && e.message)})`;
    }
  };
  try {
    const loader = ctx.get('loader');
    log('apply: loader=', !!loader, ' hmr=', !!ctx.get('hmr'), ' timer=', !!ctx.get('timer'), ' node=', process.version);
    log('apply: execArgv=', JSON.stringify(process.execArgv), ' argv1=', process.argv[1]);
    if (!loader) { log('apply: no loader service - cannot diag'); return; }
    log('apply: loader.internal =', !!loader.internal);
    log('apply: loader.tree.store keys =', JSON.stringify(Object.keys(loader.tree?.store ?? {})));

    // Observe profile-boot's HMR fallback: it calls loader.create() right after the tree
    // is up, so wrapping create here shows both the call and the resulting service state.
    const original = loader.create.bind(loader);
    loader.create = async (options) => {
      log('create ->', JSON.stringify(options));
      try {
        const result = await original(options);
        log('create resolved: ret=', String(result),
            ' hmrNow=', !!ctx.get('hmr'),
            ' timerNow=', !!ctx.get('timer'));
        const store = loader.tree?.store ?? {};
        for (const key of Object.keys(store)) {
          const entry = store[key];
          const rowName = String(entry?.options?.id ?? '');
          const pluginName = String(entry?.options?.name ?? '');
          if (/hmr|timer|diag/i.test(key + rowName + pluginName)) {
            log(`  entry[${key}] id=${rowName} name=${pluginName} ${summarize(entry)}`);
          }
        }
        return result;
      } catch (error) {
        log('create THREW:', String(error && (error.stack || error.message || error)));
        throw error;
      }
    };

    // Keep watching while the boot continues (and through shutdown) so a late
    // activation or a late fiber failure is still recorded.
    let tick = 0;
    const poll = () => {
      tick += 1;
      try {
        log(`tick#${tick}: hmr=${!!ctx.get('hmr')} timer=${!!ctx.get('timer')} rootFiberState=${ctx.fiber?.state}`);
      } catch (e) {
        log(`tick#${tick}: poll failed ${String(e && e.message)}`);
      }
      if (tick < 14) setTimeout(poll, 250);
    };
    setTimeout(poll, 250);
  } catch (error) {
    log('apply threw:', String(error && (error.stack || error.message || error)));
  }
}
