import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Non-vacuous packages/core discovery (#212, AC-5): the editing-domain tests
// moved to packages/core/src, and a partial move or a later deletion must
// fail, not pass with reduced discovery. The guard runs at config load, so
// every vitest mode (run, watch, coverage) fails fast when:
//   - the packages/core/src directory is missing, or
//   - it holds no test file at all (every test deleted), or
//   - any inventoried module test file is gone (reduced discovery).
// The inventory is the explicit record of what moved in #212; a module
// gaining its first test (collections is types-only today) updates it in the
// same PR that adds the test. Empty test FILES need no guard here — vitest
// already fails a matched file that contains no tests.
const CORE_SRC = join(ROOT, 'packages/core/src');
const MOVED_CORE_TESTS = [
  'entry-writer.test.ts',
  'form-tree.test.ts',
  'indexer.test.ts',
  'matcher.test.ts',
  'route-resolver.test.ts',
  'splice-writer.test.ts',
] as const;

const coreTests = existsSync(CORE_SRC)
  ? readdirSync(CORE_SRC).filter((name) => name.endsWith('.test.ts'))
  : [];
const missing = MOVED_CORE_TESTS.filter((name) => !coreTests.includes(name));
if (!existsSync(CORE_SRC) || coreTests.length === 0 || missing.length > 0) {
  const detail = !existsSync(CORE_SRC)
    ? 'packages/core/src does not exist'
    : coreTests.length === 0
      ? 'no test files found under packages/core/src'
      : `missing inventoried test files: ${missing.join(', ')}`;
  throw new Error(
    `vitest config: vacuous packages/core test discovery (${detail}) — discovery must cover the editing-domain tests moved in #212; restore them or update the inventory in vitest.config.ts in the PR that moves them.`,
  );
}

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}', 'packages/core/src/**/*.test.{ts,tsx}'],
    coverage: {
      // The CRAP coverage term is honest only where per-function unit coverage
      // is real: the pure editing modules (packages/core since #212, plus the
      // src/core compatibility shims and the CRAP tooling layer that stayed)
      // — metric honesty, wayfinder #55. src/node and src/client stay a
      // CC-only watchlist — their truth is e2e coverage, which is fog on the
      // map.
      provider: 'v8',
      include: ['src/core/**', 'packages/core/**'],
      reporter: ['json'],
      reportsDirectory: 'coverage',
    },
  },
});
