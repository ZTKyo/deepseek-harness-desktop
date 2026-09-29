// ac10-entry-diag.mjs — DIAGNOSTIC ONLY (removed before the final gate change).
// v4 (2026-09-29). Facts the gate established so far:
//   * Same dsh 0.1.1-rc.2, same node minor, same profile manifest: `dsh web` boots
//     fine locally but on the CI runner dies with
//       "dsh: user patch-layer watching requires the Cordis HMR service"
//   * profile-boot auto-creates the HMR entry; on the runner that create() RESOLVES
//     while ctx.get('hmr') stays undefined, and a re-enabled row produced a service
//     WITHOUT registerConfig. Locally the very same create() yields a real Hmr object
//     (ctor=Hmr, registerConfig=function). So on the runner the HMR plugin's own
//     apply/init does not complete — this plugin records the reason.
// What v4 records on the runner:
//   * every unhandled rejection / uncaught exception / process warning (full stacks),
//   * ctx.get('hmr') identity (ctor, registerConfig, own keys) at each step,
//   * the loader's FULL entry list via loader.entries() (nested group subtrees
//     included) with per-entry disabled flag, fiber uid/state and fiber error,
//   * optionally (config.earlyHmr = true) its own awaited HMR create with a full
//     try/catch — the most direct possible capture of the failing init.
export const name = 'ac10-entry-diag';

export async function apply(ctx, config) {
  const log = (...args) => {
    try { console.log('[ac10-diag]', ...args); } catch {}
  };
  const desc = (v) => {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    const t = typeof v;
    if (t !== 'object' && t !== 'function') return `${t}:${String(v)}`;
    let ctor = '?', keys = '?';
    try { ctor = (v.constructor && v.constructor.name) || '?'; } catch {}
    try { keys = Object.keys(v).slice(0, 14).join(','); } catch {}
    return `object ctor=${ctor} typeofRegisterConfig=${typeof v.registerConfig} ownKeys=[${keys}]`;
  };
  const one = (e) => {
    let fiber = 'none';
    if (e?.fiber) {
      const err = e.fiber.error;
      fiber = `uid=${e.fiber.uid} state=${e.fiber.state} err=${err ? String(err.stack || err.message || err) : '-'}`;
    }
    let kids = 0;
    try { kids = e?.subtree ? Object.keys(e.subtree.store).length : 0; } catch {}
    return `entry[${e?.options?.id}] name=${e?.options?.name} disabled=${e?.disabled} fiber=${fiber} subStore=${kids}`;
  };
  const dumpEntries = (tag) => {
    try {
      const loader = ctx.get('loader');
      const all = [];
      try { for (const e of loader.entries()) all.push(e); } catch (e) { log(`${tag}: entries() failed ${String(e && e.message)}`); }
      log(`${tag}: hmr=${desc(ctx.get('hmr'))} entries(${all.length}) rootStoreKeys(${Object.keys(loader.store ?? {}).length})`);
      for (const e of all) {
        const name = String(e?.options?.name ?? '');
        const id = String(e?.options?.id ?? '');
        if (/hmr|diag|timer/i.test(id + name) || e?.fiber?.error) log('  ' + one(e));
      }
    } catch (e) {
      log(`${tag}: dump failed ${String(e && e.message)}`);
    }
  };

  try {
    process.on('unhandledRejection', (e) => log('UNHANDLED-REJECTION:', String((e && e.stack) || e)));
    process.on('uncaughtException', (e) => log('UNCAUGHT-EXCEPTION:', String((e && e.stack) || e)));
    process.on('warning', (w) => log('PROCESS-WARNING:', String(w && (w.name + ': ' + w.message))));

    const loader = ctx.get('loader');
    log('apply: loader=', !!loader, ' hmr=', !!ctx.get('hmr'), ' timer=', !!ctx.get('timer'), ' node=', process.version);
    log('apply: execArgv=', JSON.stringify(process.execArgv), ' argv1=', process.argv[1]);
    log('apply: cwd=', process.cwd(), ' DSH_HOME=', process.env.DSH_HOME);
    log('apply: config=', JSON.stringify(config), ' loaderCtor=', loader && loader.constructor && loader.constructor.name);
    if (!loader) { log('apply: no loader service - cannot diag'); return; }
    dumpEntries('apply');
    try {
      const req = (await import('node:module')).createRequire(import.meta.url);
      log('resolve probe: require.resolve(@deepseek-ai/cordis-plugin-hmr) =', req.resolve('@deepseek-ai/cordis-plugin-hmr'));
    } catch (e) { log('resolve probe FAILED:', String(e && (e.message || e))); }

    // Observe profile-boot's HMR fallback AND capture any failure of its create().
    const original = loader.create.bind(loader);
    loader.create = async (options) => {
      log('create ->', JSON.stringify(options));
      let result, thrown;
      try { result = await original(options); } catch (error) { thrown = error; }
      if (thrown) log('create THREW:', String(thrown && (thrown.stack || thrown.message || thrown)));
      else log('create resolved: ret=', String(result));
      dumpEntries('after-create');
      setTimeout(() => dumpEntries('after-create+300ms'), 300);
      if (thrown) throw thrown;
      return result;
    };

    // Most direct capture: create the HMR entry ourselves (awaited, inside this
    // plugin's own apply, i.e. before profile-boot reaches its HMR check).
    if (config?.earlyHmr) {
      try {
        log('EARLY: creating HMR entry (root ["."]) …');
        const ret = await original({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: ['.'] } });
        log('EARLY: create OK ret=', String(ret), ' hmr=', desc(ctx.get('hmr')));
        dumpEntries('EARLY-ok');
      } catch (e) {
        log('EARLY: create FAILED:', String(e && (e.stack || e.message || e)));
        dumpEntries('EARLY-failed');
      }
    }

    let tick = 0;
    const poll = () => {
      tick += 1;
      try { log(`tick#${tick}: hmr=${!!ctx.get('hmr')} timer=${!!ctx.get('timer')} rootFiberState=${ctx.fiber?.state}`); } catch (e) { log(`tick#${tick}: poll failed ${String(e && e.message)}`); }
      if (tick < 20) setTimeout(poll, 300);
    };
    setTimeout(poll, 300);
  } catch (error) {
    log('apply threw:', String(error && (error.stack || error.message || error)));
  }
}
