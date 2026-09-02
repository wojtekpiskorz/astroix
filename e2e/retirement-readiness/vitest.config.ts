import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The readiness presentation lane's own config (#214, AC-3): the mount
// tests live under e2e/retirement-readiness/ — a directory the root
// vitest config's include patterns deliberately do not cover. The
// readiness SPEC spawns this config (one aggregate entry), so the mounts
// run inside the readiness proof rather than silently joining `npm test`'s
// unit lanes. `root` is pinned to this directory because vitest resolves
// include patterns against the process cwd (the repo root) otherwise.
// Environment parity with the root config: happy-dom.
export default defineConfig({
  test: {
    root: dirname(fileURLToPath(import.meta.url)),
    environment: 'happy-dom',
    include: ['presentation-mount.test.tsx'],
  },
});
