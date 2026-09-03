import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compareCandidateManifests } from '../src/forge/inventory.ts';
import {
  describePackageVerification,
  verifyPackagedApp,
} from '../src/forge/package-verification.ts';

/**
 * The verification stage CLI (#245, H3; ADR-0008): the ONE law, twice —
 * `verify-package.mjs <path-to-Astroix.app>` runs the full packaged-app
 * verification (strict nested+outer codesign with adhoc signatures, the
 * packaged-asset adapter over Contents/Resources, fuse-state inspection
 * off the real binary, identity facts, single-arch executables) on any
 * packaged or EXTRACTED app; `verify-package.mjs --compare <a.json>
 * <b.json>` compares two candidate manifests by normalized payload
 * inventory + immutable hashes (never ZIP bytes — version 1 makes no
 * byte-identical-ZIP claim).
 *
 * Accepted residual (the #245 carry-note): verification proves the
 * bytes at check time; the window between it and any later spawn is a
 * TOCTOU accepted under ADR-0008's threat model, revisited only by a
 * future signed-bundle lane.
 */

const args = process.argv.slice(2);

if (args[0] === '--compare') {
  const manifestA = await readManifest(args[1], 'A');
  const manifestB = await readManifest(args[2], 'B');
  const comparison = compareCandidateManifests(manifestA, manifestB);
  console.log(
    `verify-package: candidate comparison — inventories ${
      comparison.inventoriesMatch ? 'MATCH' : 'DIFFER'
    }, immutable hashes ${comparison.immutableHashesMatch ? 'MATCH' : 'DIFFER'}, identity ${
      comparison.identityMatches ? 'MATCH' : 'DIFFERS'
    } (ZIP bytes are never compared: no byte-identical-ZIP claim)`,
  );
  for (const diff of comparison.inventoryDiffs) console.error(`  inventory: ${diff}`);
  for (const diff of comparison.immutableHashDiffs) console.error(`  immutable hash: ${diff}`);
  for (const diff of comparison.identityDiffs) console.error(`  identity: ${diff}`);
  const passed =
    comparison.inventoriesMatch && comparison.immutableHashesMatch && comparison.identityMatches;
  process.exit(passed ? 0 : 1);
}

const appPath = args[0];
if (appPath === undefined || !appPath.endsWith('.app')) {
  console.error(
    'verify-package: usage: verify-package.mjs <path-to-.app> | --compare <manifest-a.json> <manifest-b.json>',
  );
  process.exit(1);
}

const report = await verifyPackagedApp(resolve(appPath));
for (const line of describePackageVerification(report)) console.log(line);
process.exit(report.ok ? 0 : 1);

async function readManifest(path, label) {
  if (path === undefined) {
    console.error(`verify-package: manifest ${label} path missing`);
    process.exit(1);
  }
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}
