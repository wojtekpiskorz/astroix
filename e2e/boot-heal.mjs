// Runs ahead of the fixture dev server (playwright's webServer command): a
// previous run's leaked auto-write can leave fixture content dirty, and a
// suite booted on that dirt fails early on stale titles and leaks them
// further (#114). Anything dirty under the fixture's content dir is healed
// with a loud log naming the file, so the boot erases cross-run
// contamination instead of inheriting it.
//
// Heals only the playwright-driven path: the config always exports
// ASTROIX_E2E_PORT on that path, while a manual `bun run dev` here (the
// dogfood server on the smoke port) must keep whatever the developer typed.

import { execFileSync } from 'node:child_process';

const CONTENT_DIR = 'e2e/fixture/src/content';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

if (process.env.ASTROIX_E2E_PORT) {
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const status = git(['-C', root, 'status', '--porcelain', '--', CONTENT_DIR]);
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
