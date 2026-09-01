import { defineConfig, devices } from '@playwright/test';

// No-E2E interval (ADR-0010, amended 2026-09-01 by owner ruling on #197):
// the legacy-chrome regression suite was deleted with the interval's start
// at the plain-fixture conversion (#213), not at retirement. During the
// interval the only spec is the serverless plain-fixture build smoke; the
// B-lane behavior-contract capture suites (over the disposable oracles,
// e2e/oracle.mjs) and the web-host lanes rebuild product E2E here. Port
// ownership rules (e2e/ports.ts, #120) survive for the capture suites.
//
// testMatch is pinned to *.spec.ts because the behavior-contract schema
// validators (#217) live as vitest *.test.ts files under
// e2e/behavior-contracts/schema/ — Playwright's default (*.test.ts too)
// would load them as specs and die at their vitest imports.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
