// Source-mode staging + src-lane oracle (#150, #213): the source lane boots
// `e2e/.oracle-src`, a disposable copy of the canonical plain fixture whose
// `@wojciechpiskorz/astroix` link points at `.astroix-local-src/` — dist
// copied byte-for-byte (the node side always runs from `dist/index.js`)
// plus `src` as a symlink to the repo's own `src/`, so chrome edits stay
// live in staging and the dev server serves them as source (ADR-0001 source
// mode: fast-refresh, the HMR loop this lane exists to catch). Kept a
// separate staging from the publish-shaped one on purpose — that one
// forbids `src`; this one requires it and must never feed the main lane.
//
// The `src` symlink is the realpath-vs-symlink-path edge this lane exists
// to catch (the fs.allow / plugin-react include regexes are built from
// clientEntryPath through this layout). The oracle link reproduces the
// exact single-symlink layout npm's directory `file:` linking materializes
// (verified #150, re-verified under npm), so node realpath-resolves the
// running `dist/index.js` into the staging, through the `src` symlink, to
// the repo's own source — what every downstream consumer (the /@fs URL,
// fs.allow, the include regex) operates on.
//
// Regenerated wholesale on every pass: cleanup is rm-and-recreate, never
// git (#213 AC).

import { cpSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertOracleLink,
  copyOracleSources,
  ensureFreshDist,
  ensurePlainFixtureInstall,
  farmNodeModules,
  oracleSrc,
  resetOracle,
  root,
  syncStaging,
  writeOracleMeta,
} from './oracle.mjs';

const staging = join(root, '.astroix-local-src');

// 1. Build gate + src-ful staging sync (dist bytes + meta, `src` symlinked).
ensureFreshDist();
syncStaging(staging, { withSrcSymlink: true });

// 2. The canonical fixture's install feeds the farm (cold local checkout
// guard; CI `npm ci`s it before the lanes run).
ensurePlainFixtureInstall();

// 3. Generate the disposable source-mode oracle.
resetOracle(oracleSrc);
copyOracleSources(oracleSrc, join(root, 'e2e', 'fixture'));
cpSync(join(root, 'e2e', 'fixture', 'tsconfig.json'), join(oracleSrc, 'tsconfig.json'));
writeOracleMeta(oracleSrc, {
  name: 'astroix-src-oracle',
  scripts: {
    dev: 'astro dev --ignore-lock --port ${ASTROIX_E2E_SRC_PORT:-4310}',
  },
});
farmNodeModules(oracleSrc, staging);
assertOracleLink(oracleSrc, { requireSrc: true });
console.log(`[astroix] src-lane oracle ready at ${oracleSrc}`);
