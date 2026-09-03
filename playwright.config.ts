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

// ——— the nonzero-discovery guard (#240's AC: the web project "cannot
// pass with zero tests") ———
// The web project's expected spec set is named here; deleting a spec,
// emptying one, or breaking its discovery fails EVERY playwright run at
// config load — the plain-build project alone can never green the lane.
const WEB_SPEC_DIR = join('e2e', 'web');
// `app-shell.spec.ts` joined at #241 (G2): the rebuilt shell's own legs.
// `canvas.spec.ts` + `zero-injection.spec.ts` joined at #242 (G3): the
// natural-route same-origin canvas's battery and the managed-project
// zero-injection snapshots.
const EXPECTED_WEB_SPECS = [
  'activation.spec.ts',
  'app-shell.spec.ts',
  'canvas.spec.ts',
  'launcher.spec.ts',
  'zero-injection.spec.ts',
] as const;
const MINIMUM_TESTS_PER_SPEC = 1;
const specFiles = existsSync(WEB_SPEC_DIR)
  ? readdirSync(WEB_SPEC_DIR).filter((name) => name.endsWith('.spec.ts'))
  : [];
const missing = EXPECTED_WEB_SPECS.filter((name) => !specFiles.includes(name));
const emptied = specFiles.filter(
  (name) =>
    (readFileSync(join(WEB_SPEC_DIR, name), 'utf8').match(/^\s*test\(/gm) ?? []).length <
    MINIMUM_TESTS_PER_SPEC,
);
if (specFiles.length === 0 || missing.length > 0 || emptied.length > 0) {
  throw new Error(
    `playwright config: the web E2E project's discovery is vacuous (missing: ${missing.join(', ') || 'none'}; ` +
      `specs with no tests: ${emptied.join(', ') || 'none'}) — the restored product-E2E lane must discover its expected tests (#240)`,
  );
}

// The lane's test-owned staging runs at CONFIG LOAD (ahead of the
// webServer spawn, order guaranteed): two staged fixture copies, one
// broken root, the isolated registry, and the env file the host boots
// from. Teardown removes the whole scratch root. The root is
// per-invocation by default (a fresh nonce #350 — a second concurrent
// lane can never stage into, or delete, a live lane's root) and both it
// and the port take an explicit env override for exclusive lane
// steering (`ASTROIX_WEB_E2E_SCRATCH` / `ASTROIX_WEB_E2E_PORT`); the
// defaults keep CI untouched.
const stage = await stageWebLane();

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
  webServer: {
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
    {
      name: 'plain-build',
      testMatch: 'plain-build.spec.ts',
    },
  ],
});
