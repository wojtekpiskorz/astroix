// Publish-shaped local link + main-lane oracle (#123, #213): the canonical
// e2e/fixture is a plain Astro project — no Astroix import, no dependency —
// and the chrome specs boot `e2e/.oracle-fixture`, a disposable copy
// generated here: canonical content bytes copied verbatim, a generated
// config that registers astroix(), and a node_modules view farmed from the
// canonical fixture's install plus `@wojciechpiskorz/astroix` linked at the
// `.astroix-local/` staging dir (dist + publish meta only — the staging
// shape #123 introduced to keep the repo itself out of node_modules).
// Regenerated wholesale on every pass: cleanup is rm-and-recreate, never
// git, so cross-run contamination cannot survive (#213 AC, replacing the
// boot-heal git restore).

import { join } from 'node:path';
import {
  assertOracleLink,
  copyOracleSources,
  ensureFreshDist,
  ensurePlainFixtureInstall,
  evictStaleFixtureIntegration,
  farmNodeModules,
  oracleMain,
  resetOracle,
  root,
  syncStaging,
  writeOracleMeta,
} from './oracle.mjs';

const staging = join(root, '.astroix-local');

// 1. Build gate + staging sync: dist must postdate every build input, then
// the publish surface is re-copied (always — a full re-copy of ~2 MB beats
// reasoning about partial staleness between dist and meta).
ensureFreshDist();
syncStaging(staging);

// 2. The canonical fixture's install feeds the farm: ensure it exists on a
// cold local checkout (CI `npm ci`s it before the lanes run) and evict the
// pre-#213 installed integration no oracle consumes anymore.
ensurePlainFixtureInstall();
evictStaleFixtureIntegration();

// 3. Generate the disposable oracle: fresh dir, canonical bytes (tsconfig
// included), generated config + manifest, farmed node_modules, staged link.
resetOracle(oracleMain);
copyOracleSources(oracleMain, join(root, 'e2e', 'fixture'));
writeOracleMeta(oracleMain, {
  name: 'astroix-e2e-oracle',
  scripts: {
    dev: 'astro dev --ignore-lock --port ${ASTROIX_E2E_PORT:-4312}',
    build: 'astro build',
  },
});
farmNodeModules(oracleMain, staging);
assertOracleLink(oracleMain);
console.log(`[astroix] main-lane oracle ready at ${oracleMain}`);
