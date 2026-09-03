import { defineConfig } from 'vitest/config';

/**
 * The desktop smoke lane's own vitest config (#243): NOT part of `npm
 * test` — it launches the real Electron binary (like `certify:adapter`,
 * a locally-run lane gate, `npm run test:desktop`), so the deterministic
 * CI gates stay biome/tsc/vitest. Node environment: the tests spawn and
 * observe processes; no DOM.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/desktop/smoke/desktop-smoke.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    teardownTimeout: 15_000,
    fileParallelism: false,
    reporters: 'default',
  },
});
