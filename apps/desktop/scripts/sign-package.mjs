import { resolve } from 'node:path';
import { adHocSignApp } from '../src/forge/codesign.ts';

/**
 * The ad-hoc signing stage CLI (#245, H3): signs the packaged `.app`
 * with identity `-` — nested executable code first (deepest targets
 * first: the framework, the helpers, the bundled Node executable), the
 * outer app LAST so its resource seal covers final bytes only.
 * `npm run package` drives this stage itself; this standalone form
 * exists for re-signing an already-packaged app during local
 * qualification work. Run under the desktop package's raw-Node register
 * (see the root `package` script).
 */

const appPath = process.argv[2];
if (appPath === undefined || !appPath.endsWith('.app')) {
  console.error('sign-package: usage: sign-package.mjs <path-to-packaged-.app>');
  process.exit(1);
}

const signed = await adHocSignApp(resolve(appPath));

console.log(`sign-package: ad-hoc signed (identity '-') — nested first, outer app last:`);
for (const target of signed) {
  console.log(`  [nested ${target.kind}] ${target.relPath}`);
}
console.log('  [outer app] <the .app bundle>');
