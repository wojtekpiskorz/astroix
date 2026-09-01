// npm-pack smoke lane + pack oracle (ADR-0001, #213): build the exact
// shipped artifact, pack it, and install the tarball into
// `e2e/.oracle-pack`, a disposable copy of the tracked pack input
// (e2e/pack-fixture — minimal content-only oracle input; its config and
// manifest are generated here, never tracked). Installing the real tarball
// is the lane's essence: it catches `files`/`exports`/package-shape
// regressions the farmed source lane can never see.
//
// The oracle's node_modules deliberately persists across local runs (only
// the integration dir + lockfile are evicted so the fresh artifact always
// lands); the whole dir stays disposable — rm it and the next pass
// regenerates everything. Cleanup is regenerate-on-setup, never git (#213
// AC).

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertOracleLink,
  copyOracleSources,
  ensureFreshDist,
  oraclePack,
  packInput,
  resetOracleSources,
  root,
  writeOracleMeta,
} from './oracle.mjs';

const tarballName = 'astroix-pack.tgz';

// 1. Build + pack the repo, stage the tarball under the stable name the
// generated manifest references (`file:./astroix-pack.tgz`). The build rides
// the shared serialized gate (a fresh dist is the exact shipped artifact; a
// stale one rebuilds single-flight — never two concurrent `npm run build`
// at the root while the farmed lanes boot beside this one).
ensureFreshDist();
rmSync(join(root, tarballName), { force: true });
const packed = execSync('npm pack --json', { cwd: root, encoding: 'utf8' });
const fileName = JSON.parse(packed)[0]?.filename;
if (typeof fileName !== 'string' || !fileName.endsWith('.tgz')) {
  throw new Error(`npm pack produced no tarball: ${packed}`);
}
mkdirSync(oraclePack, { recursive: true });
cpSync(join(root, fileName), join(oraclePack, tarballName));
rmSync(join(root, fileName));
if (!existsSync(join(oraclePack, tarballName))) {
  throw new Error('tarball copy failed');
}

// 2. Regenerate the oracle's tracked surface: fresh input bytes, generated
// config + manifest (node_modules is kept — step 3 refreshes what matters).
resetOracleSources(oraclePack);
copyOracleSources(oraclePack, packInput);
writeOracleMeta(oraclePack, {
  name: 'astroix-pack-oracle',
  scripts: {
    dev: 'astro dev --port ${ASTROIX_E2E_PACK_PORT:-4313}',
  },
  dependencies: {
    '@wojciechpiskorz/astroix': 'file:./astroix-pack.tgz',
    astro: '^7.2.7',
  },
});

// 3. A same-named file: tarball does not re-install on its own: npm's
// lockfile pins the recorded resolution and its cache serves the old
// extraction — drop both the installed package and the lock so the fresh
// artifact always lands; both are no-ops on a clean CI checkout.
rmSync(join(oraclePack, 'node_modules', '@wojciechpiskorz'), { recursive: true, force: true });
rmSync(join(oraclePack, 'package-lock.json'), { force: true });
execSync('npm install', { cwd: oraclePack, stdio: 'inherit' });

// 4. Guard: the tarball install must be publish-shaped.
assertOracleLink(oraclePack);
console.log(`pack oracle ready (${tarballName} = ${fileName})`);
