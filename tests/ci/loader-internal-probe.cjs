/*
 * AC10 release gate diagnostic: would dsh's loader.internal be AVAILABLE on this
 * host, using the exact two paths cordis-plugin-loader/lib/index.js uses?
 *
 * cordis-plugin-loader decides with:
 *   if (process.execArgv.includes("--expose-internals")) try { return require(id) } catch {}
 *   try { return require("node-addon-require-builtin").requireBuiltin(id) } catch {}
 * then asks for "internal/modules/esm/loader".getOrInitializeCascadedLoader().
 *
 * The HMR plugin refuses to register its service without that loader:
 *   if (!this.ctx.loader.internal) throw new Error("--expose-internals is required for HMR service")
 * and dsh's profile boot then dies with
 *   "user patch-layer watching requires the Cordis HMR service".
 *
 * The native path is an OPTIONAL platform package
 * (node-addon-require-builtin-win32-x64-msvc). When npm skips optional
 * dependencies that package is absent, requireBuiltin() throws, loader.internal
 * stays undefined, and the boot fails with the HMR error — which is exactly why
 * this probe prints the resolved package/binary, not just a boolean.
 *
 * Usage: node tests/ci/loader-internal-probe.cjs <cordis-plugin-loader/lib/index.js path>
 * Exit code 0 when loader.internal would be available, 1 otherwise (never throws).
 */
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const INTERNAL_ID = 'internal/modules/esm/loader';

function firstLine(error) {
  return String(error && error.message ? error.message : error).split('\n')[0];
}

function main() {
  const anchor = process.argv[2];
  if (!anchor) {
    console.log('usage: node loader-internal-probe.cjs <cordis-plugin-loader/lib/index.js path>');
    return 2;
  }
  const req = createRequire(anchor);

  console.log(`node            = ${process.version} (arch ${process.arch}, ABI ${process.versions.modules})`);
  console.log(`anchor          = ${anchor}`);
  console.log(`execArgv        = ${JSON.stringify(process.execArgv)}`);
  console.log(`--expose-internals present = ${process.execArgv.includes('--expose-internals')}`);

  let byExpose;
  if (process.execArgv.includes('--expose-internals')) {
    try {
      byExpose = req(INTERNAL_ID);
      console.log(`path A (--expose-internals require) => OK (has getOrInitializeCascadedLoader: ${typeof (byExpose && byExpose.getOrInitializeCascadedLoader) === 'function'})`);
    } catch (error) {
      console.log(`path A (--expose-internals require) => FAIL ${error.code ?? '?'} ${firstLine(error)}`);
    }
  } else {
    console.log('path A (--expose-internals require) => skipped (flag absent, exactly as dsh runs it)');
  }

  let addonPackageJson;
  try {
    addonPackageJson = req.resolve('node-addon-require-builtin/package.json');
    console.log(`addon package   = ${addonPackageJson}`);
  } catch (error) {
    console.log(`addon package   = UNRESOLVABLE ${firstLine(error)}`);
  }

  if (addonPackageJson) {
    const addonDir = path.dirname(addonPackageJson);
    for (const entry of fs.readdirSync(path.dirname(addonDir))) {
      if (entry.startsWith('node-addon-require-builtin-')) {
        const prebuilt = path.join(path.dirname(addonDir), entry, 'prebuilt');
        let files = [];
        try {
          files = fs.readdirSync(prebuilt);
        } catch {
          /* platform package present but no prebuilt dir */
        }
        console.log(`platform package= ${entry} (prebuilt: ${files.length > 0 ? files.join(', ') : 'none'})`);
      }
    }
  }

  let byAddon;
  try {
    const mod = req('node-addon-require-builtin');
    byAddon = mod.requireBuiltin(INTERNAL_ID);
    console.log(`path B (native addon requireBuiltin) => OK (has getOrInitializeCascadedLoader: ${typeof (byAddon && byAddon.getOrInitializeCascadedLoader) === 'function'})`);
  } catch (error) {
    console.log(`path B (native addon requireBuiltin) => FAIL ${error.code ?? '?'} ${firstLine(error)}`);
  }

  // The loader does NOT stop at "the function exists" — it CALLS it:
  //   const raw = requireInternal('internal/modules/esm/loader')?.getOrInitializeCascadedLoader()
  //   if (raw) return Object.assign(raw, { version: 'v1' })
  // A getter that exists but THROWS (or returns undefined) on this Node build
  // leaves loader.internal undefined in the real boot, so the probe must make the
  // same call instead of only probing the property.
  const loader = byAddon ?? byExpose;
  let cascaded;
  let callOutcome = 'not attempted';
  if (typeof (loader && loader.getOrInitializeCascadedLoader) === 'function') {
    try {
      cascaded = loader.getOrInitializeCascadedLoader();
      callOutcome = cascaded ? `RETURNED (${typeof cascaded}, keys: ${Object.keys(cascaded).slice(0, 10).join(',')})` : 'RETURNED undefined/null';
      console.log(`call getOrInitializeCascadedLoader() => ${callOutcome}`);
    } catch (error) {
      callOutcome = `THREW ${error.code ?? '?'} ${firstLine(error)}`;
      console.log(`call getOrInitializeCascadedLoader() => ${callOutcome}`);
      const line2 = String(error.stack ?? '').split('\n')[1];
      if (line2) console.log(`  at ${line2.trim()}`);
    }
  } else {
    console.log('call getOrInitializeCascadedLoader() => skipped (not a function)');
  }

  const available = Boolean(cascaded);
  console.log(`VERDICT: loader.internal would be ${available ? 'AVAILABLE' : 'UNDEFINED'} on this host (${callOutcome})`);
  console.log(`VERDICT: HMR service can register = ${available}`);
  return available ? 0 : 1;
}

process.exitCode = main();
