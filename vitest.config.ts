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
//   - a module in packages/core/src has no sibling test file (a deleted
//     test, a module shipped untested, or the whole test set gone — the
//     derived invariant covers all three without a hand-maintained list).
// The invariant is doctrine-consistent, not new doctrine: every pure module
// in the editing domain is unit-tested over fixtures (AGENTS.md, testing
// doctrine). Modules without a test file need an explicit exemption here:
// the barrel and the types-only collections contract, which never had a
// test on main (#212 inventory note). Empty test FILES need no guard —
// vitest already fails a matched file that contains no tests.
const CORE_SRC = join(ROOT, 'packages/core/src');
const TEST_EXEMPT_MODULES = new Set(['index.ts', 'collections.ts']);

const coreFiles = existsSync(CORE_SRC) ? readdirSync(CORE_SRC) : [];
const coreModules = coreFiles.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
const coreTests = coreFiles.filter((name) => name.endsWith('.test.ts'));
const untested = coreModules.filter(
  (name) =>
    !TEST_EXEMPT_MODULES.has(name) && !coreTests.includes(`${name.replace(/\.ts$/, '')}.test.ts`),
);
if (!existsSync(CORE_SRC) || coreModules.length === 0 || untested.length > 0) {
  const detail = !existsSync(CORE_SRC)
    ? 'packages/core/src does not exist'
    : coreModules.length === 0
      ? 'no modules found under packages/core/src'
      : `modules without a sibling test file: ${untested.join(', ')}`;
  throw new Error(
    `vitest config: vacuous packages/core test discovery (${detail}) — discovery must cover every editing-domain module moved in #212; restore the tests, or extend the exemption set in vitest.config.ts in the PR that changes the module set`,
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
