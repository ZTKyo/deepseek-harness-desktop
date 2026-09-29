/*
 * AC10 release gate diagnostic: reproduce Node's module-resolution walk from an
 * arbitrary anchor (typically a dsh profile's package.json) and report every
 * directory Node would search plus the concrete resolve() outcome.
 *
 * Why this exists: dsh's app boot maintains a flat module fallback
 * (`$DSH_HOME/profiles/node_modules`, one junction per package of the
 * installation's dependency closure) so that in-box plugins such as
 * `@deepseek-ai/cordis-plugin-hmr` resolve from any profile through the ordinary
 * parent-directory walk. When that fallback is missing or incomplete, the boot
 * starts its web server and then dies with
 * "user patch-layer watching requires the Cordis HMR service" — a cause that is
 * invisible unless the resolution walk itself is inspected on the failing host.
 *
 * Usage:
 *   node tests/ci/profile-module-resolution-probe.cjs <anchor-package.json> <package-name> [more names...]
 * Exit code: 0 when every name resolves, 1 when any name fails (probe-style,
 * never throws).
 */
const { createRequire } = require('node:module');

function main() {
  const [, , anchor, ...names] = process.argv;
  if (!anchor || names.length === 0) {
    console.log('usage: node profile-module-resolution-probe.cjs <anchor-package.json> <name> [name...]');
    return 2;
  }
  let failed = 0;
  for (const name of names) {
    console.log(`anchor = ${anchor}`);
    console.log(`name   = ${name}`);
    try {
      const req = createRequire(anchor);
      const paths = req.resolve.paths(name);
      console.log(`paths  = ${JSON.stringify(paths)}`);
      try {
        console.log(`RESOLVE_OK => ${req.resolve(name)}`);
      } catch (error) {
        failed++;
        console.log(`RESOLVE_FAIL => ${error.code ?? '?'} | ${String(error.message).split('\n')[0]}`);
      }
    } catch (error) {
      failed++;
      console.log(`PROBE_ERROR => ${String(error)}`);
    }
  }
  return failed === 0 ? 0 : 1;
}

process.exitCode = main();
