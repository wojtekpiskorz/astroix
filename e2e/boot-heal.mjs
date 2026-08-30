// Runs ahead of a fixture's dev server (playwright's webServer command): a
// previous run's leaked auto-write can leave fixture sources dirty, and a
// suite booted on that dirt fails early on stale titles and leaks them
// further (#114, #128). Anything dirty under the healed dir is restored with
// a loud log naming the file, so the boot erases cross-run contamination
// instead of inheriting it.
//
// Heals only the playwright-driven path: the config always exports the
// lane's port var on that path, while a manual `bun run dev` in a fixture
// (the dogfood server on the smoke port) must keep whatever the developer
// typed. Usage, with per-lane defaults for the main fixture's content dir:
//   node boot-heal.mjs [tracked-dir] [gate-env-var]
// the pack lane passes its pages dir + ASTROIX_E2E_PACK_PORT.

import { execFileSync } from 'node:child_process';

const [trackedDir = 'e2e/fixture/src/content', gate = 'ASTROIX_E2E_PORT'] = process.argv.slice(2);

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

if (process.env[gate]) {
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const status = git(['-C', root, 'status', '--porcelain', '--', trackedDir]);
  for (const line of status.split('\n').filter(Boolean)) {
    // porcelain: two status chars, a space, then the path (no renames here)
    const file = line.slice(3);
    if (line.startsWith('??')) {
      git(['-C', root, 'clean', '-fd', '--', file]);
    } else {
      git(['-C', root, 'restore', '--', file]);
    }
    console.log(
      `[astroix-e2e] boot heal: ${line.startsWith('??') ? 'removed' : 'restored'} dirty fixture content: ${file}`,
    );
  }
}
