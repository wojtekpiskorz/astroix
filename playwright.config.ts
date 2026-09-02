import { defineConfig, devices } from '@playwright/test';

// No-E2E interval (ADR-0010, amended 2026-09-01 by owner ruling on #197):
// between the plain-fixture conversion (#213) and the first web-host slice
// (#240) there is NO product E2E, and CI never presents this lane as one.
// The retirement gate (#215, lane A6) deleted every spec that booted the
// oracle world (the freeze suites, the retained-UI regression, the
// Playwright readiness aggregate); the one surviving spec —
// e2e/plain-build.spec.ts — is the serverless plain-fixture build smoke,
// the named no-product-E2E lane. It launches no browser, so the runner
// needs no installed browser binaries. The web-host lanes rebuild product
// E2E here when #240 lands.
//
// testMatch is pinned to *.spec.ts because the behavior-contract schema
// validators (#217) and the retirement-readiness legs live as vitest
// *.test.ts files — Playwright's default (*.test.ts too) would load them
// as specs and die at their vitest imports.
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
