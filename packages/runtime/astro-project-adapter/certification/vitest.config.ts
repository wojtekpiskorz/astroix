import { defineConfig } from 'vitest/config';

/**
 * The adapter-certification run config (#225): real `astro@7.2.10 +
 * vite@8.2.2` installs in disposable temp projects, so it is a dedicated
 * lane — `npm run certify:adapter` — never part of `npm test` (network,
 * minutes-scale installs, real servers). The legs live as `*.certify.ts`
 * under `packages/runtime/test/adapter-certification/certification/`,
 * which the root vitest include (`*.test.ts`) deliberately does not
 * match. Sequential, one fork, node environment, generous budgets —
 * bounded by construction (temp dirs, guaranteed cleanup).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/runtime/test/adapter-certification/certification/**/*.certify.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    pool: 'forks',
    reporters: 'default',
  },
});
