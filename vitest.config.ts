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
    // packages/app-shell tests run here but stay OUT of coverage.include —
    // the UI foundation is a CC-only watchlist tier (metric honesty, #218)
    include: [
      'src/**/*.test.{ts,tsx}',
      'packages/core/src/**/*.test.{ts,tsx}',
      'packages/protocol/src/**/*.test.{ts,tsx}',
      'packages/app-shell/src/**/*.test.{ts,tsx}',
      // packages/runtime (#221, #222): tests live under test/<seam>/ per
      // the tickets' owned paths — deterministic real-filesystem unit tests
      // (temp dirs, real fsync/rename, real SQLite lease files), plus the
      // lease/boot process lanes (#222): real forked children over real
      // private IPC channels, asserted on messages and exit events, never
      // timing. No servers yet. The adapter-certification legs (#225) are
      // NOT here by design: they are *.certify.ts (real installs,
      // minutes-scale) behind `npm run certify:adapter` with their own
      // config — the root run must stay deterministic and network-free.
      'packages/runtime/test/**/*.test.{ts,tsx}',
      // Behavior-contract schema validators (#217, directive from B1's
      // review): the schemas are pure zod over frozen fixtures — the unit
      // doctrine's home, no browser needed. The corpus bytes stay owned by
      // the frozen standard itself.
      'e2e/behavior-contracts/schema/**/*.test.ts',
      // The retirement-readiness serverless legs (#214; retained past the
      // gate by #215, lane A6): corpora validation, retained-UI coupling
      // scan, fixture plainness + zero-byte build, counts, and the
      // deletion inventory — plus the presentation mounts, folded into
      // the same root run (advisory round 1 on #291: the mounts had a
      // dedicated spawned config only because a Playwright aggregate
      // couldn't host vitest; the aggregate is vitest now). Mount
      // failures fail npm test directly; the counts leg's non-empty
      // mount row is the vacuity tripwire.
      'e2e/retirement-readiness/readiness.test.ts',
      'e2e/retirement-readiness/presentation-mount.test.tsx',
    ],
    coverage: {
      // The CRAP coverage term is honest only where per-function unit coverage
      // is real: the pure editing modules (packages/core since #212), the
      // protocol schemas (packages/protocol since #220 — pure zod + pure
      // helpers with colocated unit tests) plus the CRAP tooling layer
      // itself (src/core — complexity + crap, the only src/ survivors of
      // the retirement gate), the registry persistence
      // (packages/runtime/registry since #221), the kernel-lease +
      // private-boot seams (packages/runtime/{kernel-lease,private-boot}
      // since #222 — deterministic unit tests over real temp SQLite files
      // and a real in-memory private-IPC channel; the forked process-lane
      // children assert the cross-process semantics on top of the same
      // modules), and the AstroProjectAdapter's pure seams
      // (packages/runtime/astro-project-adapter root modules since #225 —
      // pair gate, resolution, seam probes, runner accounting, unit-tested
      // with resolution-layer stubs; composition.ts stays watchlist — its
      // truth is the real-install certification suite — and certification/
      // is evidence machinery, not product) — metric honesty,
      // wayfinder #55. The integration tiers (src/node, src/client) are
      // deleted; no watchlist tier exists under src/ anymore.
      provider: 'v8',
      include: [
        'src/core/**',
        'packages/core/**',
        'packages/protocol/**',
        'packages/runtime/registry/**',
        'packages/runtime/kernel-lease/**',
        'packages/runtime/private-boot/**',
        'packages/runtime/astro-project-adapter/*.ts',
        // The adapter's content-inspection seams (#228, additive to the
        // E1 root glob, which covers root modules only): probes, schema
        // loading, entry baselines, revisions, and the pass assembly —
        // deterministic unit tests with runner stand-ins and real temp
        // files, same covered-tier decision as E1's pure seams.
        'packages/runtime/astro-project-adapter/content/*.ts',
      ],
      reporter: ['json'],
      reportsDirectory: 'coverage',
    },
  },
});
