import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { stageWebLane, WEB_LANE_PORT } from './apps/web/src/stage-e2e.ts';

// Product E2E is BACK (#240, G1 — the no-E2E interval of ADR-0010 ends
// here): the web-host lane is the live browser host — a real Chromium
// against the real control-plane composition (the real origin listener,
// HTTP admission, SSE hub, staged-activation supervisor, switch
// coordinator, and managed `astro dev` children) over the isolated test
// registry. The plain-fixture build smoke stays as its own project; the
// frozen B-contracts remain the behavioral judge, these specs the live
// host.
//
// testMatch stays pinned to *.spec.ts because the behavior-contract
// schema validators (#217) and the retirement-readiness legs live as
// vitest *.test.ts files — Playwright's default (*.test.ts too) would
// load them as specs and die at their vitest imports.

// ——— the shared nonzero-discovery guard (#240's AC: a project "cannot
// pass with zero tests") ———
// The web, content, and project-switch families name their expected
// spec sets here — a spec missing, emptied, or landed unlisted fails
// EVERY playwright run at config load — the plain-build project alone
// can never green the lane. plain-build carries no enumeration (its
// nonzero guard is its spec's own); the project-switch family rides
// the chromium-content project's match today — its enumeration is
// correct under every answer to #427's open scoping ruling.
// One idiom for every project since #408 folded #374's rider: the web
// project's dir scan and the content project's onetime single-file
// check were two hand-rolled shapes, and they drifted — the second and
// third content specs (#252, #253) had landed unguarded.
const MINIMUM_TESTS_PER_SPEC = 1;

function assertNonVacuousDiscovery(options: {
  project: string;
  specDir: string;
  expectedSpecs: readonly string[];
  rationale: string;
}): void {
  const { project, specDir, expectedSpecs, rationale } = options;
  // Recursive, matching the runner's `e2e/**/*.spec.ts` scope: the guard's
  // floor AND ceiling cover every spec the lane would run, subdirectories
  // included — `harness/` stays outside by holding `.ts` files, not by the
  // scan's shape. (The string-narrowing predicate: recursive reads can
  // surface Buffers for non-UTF-8 paths — those are never specs.)
  const specFiles = existsSync(specDir)
    ? readdirSync(specDir, { recursive: true }).filter(
        (name): name is string => typeof name === 'string' && name.endsWith('.spec.ts'),
      )
    : [];
  const missing = expectedSpecs.filter((name) => !specFiles.includes(name));
  const emptied = specFiles.filter(
    (name) =>
      (readFileSync(join(specDir, name), 'utf8').match(/^\s*test\(/gm) ?? []).length <
      MINIMUM_TESTS_PER_SPEC,
  );
  // `unexpected` is the derived ceiling over the enumeration's floor —
  // the vitest sibling's principle: no hand-maintained list to forget.
  const unexpected = specFiles.filter((name) => !expectedSpecs.includes(name));
  if (missing.length > 0 || emptied.length > 0 || unexpected.length > 0) {
    throw new Error(
      `playwright config: the ${project} E2E project's discovery is vacuous (missing: ${missing.join(', ') || 'none'}; ` +
        `specs with no tests: ${emptied.join(', ') || 'none'}; ` +
        `unexpected: ${unexpected.join(', ') || 'none'}) — ${rationale}`,
    );
  }
}

// The web project's expected spec set.
// `app-shell.spec.ts` joined at #241 (G2): the rebuilt shell's own legs.
// `canvas.spec.ts` + `zero-injection.spec.ts` joined at #242 (G3): the
// natural-route same-origin canvas's battery and the managed-project
// zero-injection snapshots.
// `styles-inspection.spec.ts` joined at #370: the wire-carried styles
// route selection's battery over the live host.
// `css-inspection.spec.ts` joined at #249 (I1): the CSS vertical's
// read-only inspection battery over the live host.
// `css-write.spec.ts` + `css-write-switch.spec.ts` joined at #250 (I2):
// the CSS vertical's grant-bound auto-write battery (byte-exact
// splices, HMR reflection, conflict, undo, renewed grants, tampered
// replays) and its pending-write-during-switch battery.
const WEB_SPEC_DIR = join('e2e', 'web');
const EXPECTED_WEB_SPECS = [
  'activation.spec.ts',
  'app-shell.spec.ts',
  'canvas.spec.ts',
  'css-inspection.spec.ts',
  'css-write-switch.spec.ts',
  'css-write.spec.ts',
  'launcher.spec.ts',
  'styles-inspection.spec.ts',
  'zero-injection.spec.ts',
] as const;
assertNonVacuousDiscovery({
  project: 'web',
  specDir: WEB_SPEC_DIR,
  expectedSpecs: EXPECTED_WEB_SPECS,
  rationale: 'the restored product-E2E lane must discover its expected tests (#240)',
});

// The content vertical's battery lives at the vertical's owned path
// under apps/web (J1, #251, and #252/#253 after it) — same guard idiom,
// so its project can never pass with zero tests either; #408's fold
// pinned the set after the later specs had drifted in unguarded.
const CONTENT_SPEC_DIR = join('apps', 'web', 'e2e', 'content');
const EXPECTED_CONTENT_SPECS = [
  'discovery-navigation.spec.ts',
  'forms-raw-validation.spec.ts',
  'write.spec.ts',
] as const;
assertNonVacuousDiscovery({
  project: 'content',
  specDir: CONTENT_SPEC_DIR,
  expectedSpecs: EXPECTED_CONTENT_SPECS,
  rationale: 'the Content vertical lane must discover its expected tests (#251)',
});

// The project-switch family's battery (the K-family) lives at the
// vertical's owned path under apps/web, riding the chromium-content
// project's e2e/** match today — the mechanical half of #427 (PR #435)
// closed the same vacuity drift #408 closed for the content family, one
// family further. The `harness/` subdir stays outside the enumeration
// (it holds `.ts` files, not specs — and the recursive scan now guards
// subdirectories too), and the enumeration is correct under every answer
// to #427's open scoping ruling, which stays with the owner.
// `client-reset.spec.ts` joined at #255 (K2): the client-reset proof
// across A-B-A switching — the returning-A generation starts empty and
// stale client authority is refused.
// `server-authority.spec.ts` joined at #254 (K1): the server
// stale-authority proof across A-B-A switching.
// `pending-diagnostics.spec.ts` joined at #256 (K3): the pending-write
// and hostile-Service-Worker proof across A-B-A switching (this lane's
// registration-only edit — the enumeration's creation stays #427/#435's).
const PROJECT_SWITCH_SPEC_DIR = join('apps', 'web', 'e2e', 'project-switch');
const EXPECTED_PROJECT_SWITCH_SPECS = [
  'client-reset.spec.ts',
  'pending-diagnostics.spec.ts',
  'server-authority.spec.ts',
] as const;
assertNonVacuousDiscovery({
  project: 'project-switch',
  specDir: PROJECT_SWITCH_SPEC_DIR,
  expectedSpecs: EXPECTED_PROJECT_SWITCH_SPECS,
  rationale: 'the project-switch family must discover its expected tests (#254/#255/#256)',
});

// The whole-tree ceiling: `chromium-content` matches `e2e/**/*.spec.ts`
// under apps/web — including zero-directory `**/` matches directly in
// `e2e/` — so a spec ANYWHERE in that tree runs in the lane. This call
// derives its expected set from the two family arrays (subdir-prefixed,
// the recursive scan's relative-path shape — no new hand-maintained
// list), so a new family directory or a stray top-level spec fails
// config load until it is enumerated. The per-family calls above stay:
// they attribute failures to the family better than one parent error
// would.
const EXPECTED_APPS_WEB_E2E_SPECS = [
  ...EXPECTED_CONTENT_SPECS.map((name) => `content/${name}`),
  ...EXPECTED_PROJECT_SWITCH_SPECS.map((name) => `project-switch/${name}`),
] as const;
assertNonVacuousDiscovery({
  project: 'apps/web e2e tree',
  specDir: join('apps', 'web', 'e2e'),
  expectedSpecs: EXPECTED_APPS_WEB_E2E_SPECS,
  rationale:
    "every spec in the web host's e2e tree belongs to an enumerated family (#240/#408 — the tree cannot grow a silent family)",
});

// The lane's test-owned staging runs at CONFIG LOAD (ahead of the
// webServer spawn, order guaranteed): two staged fixture copies, one
// broken root, the isolated registry, and the env file the host boots
// from. Teardown removes the whole scratch root. The root is
// per-invocation by default (a fresh nonce #350 — a second concurrent
// lane can never stage into, or delete, a live lane's root) and both it
// and the port take an explicit env override for exclusive lane
// steering (`ASTROIX_WEB_E2E_SCRATCH` / `ASTROIX_WEB_E2E_PORT`); the
// defaults keep CI untouched.
//
// WORKERS SKIP THE STAGING (#422): Playwright re-evaluates the config
// in every worker process, and a worker's `stageWebLane()` would WIPE
// the scratch root mid-invocation — observed after any failed leg,
// where Playwright retires the worker and the replacement worker's
// re-stage deleted the staged copies under the still-active session's
// live plane (the plane crashes, the staged bytes reset, and the next
// battery inherits a doomed cascade instead of the honest warm shape).
// Only the runner's own evaluation stages; workers inherit the
// published `ASTROIX_WEB_E2E_SCRATCH` and never spawn the webServer,
// so they need none of the staging's outputs.
const stage = process.env.TEST_WORKER_INDEX === undefined ? await stageWebLane() : null;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  globalTeardown: './apps/web/src/teardown-e2e.ts',
  use: {
    baseURL: `http://launcher.localhost:${WEB_LANE_PORT}`,
  },
  // Undefined in worker evaluations (#422 — see the staging note above):
  // only the runner's own evaluation staged, and only it spawns the
  // web server.
  webServer:
    stage === null
      ? undefined
      : {
          command: `node --experimental-transform-types --import ./apps/web/raw-node-register.mjs --env-file=${stage.envFile} apps/web/src/main.ts`,
          url: `http://launcher.localhost:${WEB_LANE_PORT}/__astroix/app/`,
          // NEVER reuse (#350, CI included): a second concurrent lane hitting
          // a busy port must fail loudly on its own spawn instead of silently
          // driving the first lane's control plane (observed: a fresh epoch
          // answering generation 3 — the other suite's burned attempts).
          reuseExistingServer: false,
          timeout: 120_000,
        },
  projects: [
    {
      name: 'chromium',
      testMatch: 'web/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    // The content vertical's battery (J1, #251) at the ticket's owned
    // path — its own testDir under apps/web, the same booted webServer
    // and control plane as the chromium project above.
    {
      name: 'chromium-content',
      testDir: 'apps/web',
      testMatch: 'e2e/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'plain-build',
      testMatch: 'plain-build.spec.ts',
    },
  ],
});
