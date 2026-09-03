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
      // apps/desktop (#243, H1): the thin Electron host's main-process
      // units — deterministic fakes at the injected Electron seams, plus
      // the real-forked control-plane child process lane (the #222 idiom:
      // temp dirs, real lease files, no network). The real-Electron smoke
      // (security prefs, denials, second launch) is NOT here by design: it
      // launches the Electron binary behind `npm run test:desktop` with
      // its own config, like certify:adapter — the root run stays
      // deterministic and network-free.
      'apps/desktop/src/main/**/*.test.{ts,tsx}',
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
      // modules), the AstroProjectAdapter's pure seams
      // (packages/runtime/astro-project-adapter root modules since #225 —
      // pair gate, resolution, seam probes, runner accounting, unit-tested
      // with resolution-layer stubs; plus the routes inspection seams
      // (astro-project-adapter/routes since #229 — metadata probe, typed
      // projection, enumeration, inspector, unit-tested over seam-layer
      // fakes; composition.ts stays watchlist — its
      // truth is the real-install certification suite — and certification/
      // is evidence machinery, not product), and the styles join's pure
      // seams (astro-project-adapter/styles/join since #226 — the
      // correspondence join, the source walk, and the shared rejection
      // helper are deterministic units; the client-environment IO
      // composition files are watchlist-tiered in crap.ts) — metric
      // honesty, wayfinder #55. The integration tiers (src/node,
      // src/client) are deleted; no watchlist tier exists under src/
      // anymore.
      provider: 'v8',
      include: [
        'src/core/**',
        'packages/core/**',
        'packages/protocol/**',
        'packages/runtime/registry/**',
        'packages/runtime/kernel-lease/**',
        'packages/runtime/private-boot/**',
        'packages/runtime/astro-project-adapter/*.ts',
        'packages/runtime/astro-project-adapter/styles/join/**',
        // The adapter's content-inspection seams (#228, additive to the
        // E1 root glob, which covers root modules only): probes, schema
        // loading, entry baselines, revisions, and the pass assembly —
        // deterministic unit tests with runner stand-ins and real temp
        // files, same covered-tier decision as E1's pure seams.
        'packages/runtime/astro-project-adapter/content/*.ts',
        'packages/runtime/astro-project-adapter/routes/**',
        // The styles convergence seams (#227, additive to the join glob):
        // the parity classifier and the invalidation source are
        // deterministic units; the IO composition file
        // (converged-styles-inspection.ts) is watchlist-tiered in crap.ts
        // but stays collected here like the join's composition files —
        // metric honesty lives in the tier decision, not the collection.
        'packages/runtime/astro-project-adapter/styles/convergence/**',
        // The edit-authority grant and planning seams (#223): pure grant
        // lifecycle + planning logic with its filesystem truth over real
        // temp roots — same covered-tier decision as the registry seam
        // (#221), recorded in crap.ts.
        'packages/runtime/edit-authority/**',
        // The project-plane worker seams (#230, additive): the worker's
        // dispatch/revision/invalidation/cleanup state machine, its typed
        // request/failure/event contracts, and the IPC serving loop are
        // deterministic units (dispatch-boundary fakes + real forked
        // children — the #222 process-lane idiom), same covered-tier
        // decision as kernel-lease/private-boot. The real IO glue
        // (composition-runtime.ts, worker-child.ts) is watchlist-tiered in
        // crap.ts but stays collected here like the adapter's composition
        // files — metric honesty lives in the tier decision, not the
        // collection.
        'packages/runtime/project-plane/**',
        // The project-runtime facade seams (#232, additive): the
        // sequencing/redaction state machine and the declared proxy-health
        // prerequisite are deterministic units over supervisor/wire fakes —
        // same covered-tier decision as the worker seams. The real IO glue
        // (plane-launch.ts) is watchlist-tiered in crap.ts but stays
        // collected here like the plane's other composition files —
        // metric honesty lives in the tier decision, not the collection.
        'packages/runtime/project-runtime/**',
        // The origin/proxy seams (#233, F1, additive): the virtual-host
        // vocabulary and Host/target classification, the routing grant/
        // revoke state machine, and the upgrade admission + handshake
        // reconstruction are deterministic pure units (covered tier). The
        // real IO — the listener composition, the HTTP stream proxy, the
        // raw upgrade tunnel, and the proxy-health prober — is
        // watchlist-tiered in crap.ts but stays collected here like the
        // plane's other composition files: its behavior truth is the
        // real-socket focused lane under test/proxy (loopback stand-in
        // upstreams, OS-assigned ports).
        'packages/runtime/origin/**',
        'packages/runtime/proxy/**',
        // The HTTP API v1 seams (#234, F2, additive): the pure dispatch
        // core, the command permission matrix, the security-header
        // evidence, the host-capability grants, the client-binding
        // table, the authority strip, and the bounded envelope
        // validation are deterministic pure units (covered tier). The
        // real IO — the reserved-handler composition that reads one
        // bounded body and writes one response draft behind F1's
        // handleReserved hook — is watchlist-tiered in crap.ts but
        // stays collected here like the plane's other composition
        // files: its behavior truth is the real-socket focused lane
        // under test/http-api (through the REAL origin listener,
        // OS-assigned loopback ports).
        'packages/runtime/api/**',
        // The SSE seams (#235, F3, additive): the admission core, the
        // stream hub, and the frame writer are deterministic pure
        // units (covered tier) — the hub over recorder sinks, the
        // admission over the same real grants/binding tables F2's lane
        // composes. The real IO — the surface composition that mounts
        // the events route beside the F2 fallback behind F1's
        // handleReserved hook — is watchlist-tiered in crap.ts but
        // stays collected here like the plane's other composition
        // files: its behavior truth is the real-socket focused lane
        // under test/sse (through the REAL origin listener, OS-assigned
        // loopback ports, open streams over raw sockets).
        'packages/runtime/sse/**',
        // The session-supervisor staging + client seams (#236, F4,
        // additive): the staged activation state machine (generation
        // reservation, private candidate readiness, rollback, the commit
        // linearization's state side, crash observation) and the
        // document-bound client registry (one editor, three diagnostics,
        // navigation/renderer/session revocation, the menu-action
        // currency envelope) are deterministic units over run fakes —
        // same covered-tier decision as the facade seams. The fence (F5
        // #237) and commit/revocation (F6 #238) subtrees land their own
        // globs below.
        'packages/runtime/session-supervisor/staging/**',
        'packages/runtime/session-supervisor/clients/**',
        // The session-supervisor fence seams (#237, F5, additive): the
        // edit fence and bounded transition drain (synchronous admission
        // closure, the pending-debounce flush into the one serialized
        // queue, the five-second deadline, the drained/failed/timed-out
        // verdicts, the no-silent-work tracking, resume legality) are
        // deterministic units over injected clock and queue seams — the
        // deadline never waits on a real timer (manual or fake clocks,
        // both sides of the boundary pinned).
        'packages/runtime/session-supervisor/fence/**',
        // The session-supervisor commit + revocation seams (#238, F6,
        // additive): the one-use switch-preparation receipt and its
        // ledger, the normal/forced preparations (the sealed terminal
        // drain verdict; the observed exact write-executor exit raced
        // against the protocol's forced-reap bound on an injected
        // clock), the receipt-consuming commit linearization, and the
        // ordered old-authority revocation (streams, awaited lease,
        // edit grants, both client-binding truths, host capability —
        // before the candidate grant) are deterministic units over
        // injected seams and journaling wrappers around the REAL landed
        // surfaces; the real-socket 421 legs ride the REAL origin
        // listener on OS-assigned loopback ports.
        'packages/runtime/session-supervisor/commit/**',
        'packages/runtime/session-supervisor/revocation/**',
        // The session-supervisor completion + tombstone seams (#239, F7,
        // additive): the host-observed replacement completion (the exact
        // main-frame ready handshake, launcher readiness, and the quit
        // close without navigation — observed-promise seams the Electron
        // host lanes satisfy), the irreversible post-revocation failure
        // aftermath (revoke and reap the granted candidate, show the
        // launcher when a target remains, report the failed no-active
        // state, never resume the old session), the incomplete-reap tail
        // (tombstone persisted first, candidate rolled back, blocked
        // no-active state), and the boot-scoped tombstone (the
        // versioned-JSON atomic store, same-boot activation denial, the
        // exclusive edit-writer-lease recovery over an injected D3 proof
        // seam, later-boot stale-by-construction clearing) are
        // deterministic units over injected seams and real temp
        // directories (the registry-store discipline).
        'packages/runtime/session-supervisor/completion/**',
        'packages/runtime/session-supervisor/tombstone/**',
      ],
      reporter: ['json'],
      reportsDirectory: 'coverage',
    },
  },
});
