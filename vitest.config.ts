import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      // The CRAP coverage term is honest only where per-function unit coverage
      // is real: src/core pure modules (metric honesty, wayfinder #55).
      // src/node and src/client stay a CC-only watchlist — their truth is
      // e2e coverage, which is fog on the map.
      provider: 'v8',
      include: ['src/core/**'],
      reporter: ['json'],
      reportsDirectory: 'coverage',
    },
  },
});
