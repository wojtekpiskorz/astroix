import { defineConfig, devices } from '@playwright/test';

// The e2e lanes own their ports: main :4314, npm-pack :4313. The owner's
// manual smoke lives on :4312 — structural separation, never shared servers
// (PR #36 debugged a "broken" suite that was actually playwright adopting
// the owner's orphaned smoke server with a stale dist).
const PORT = 4314;

export default defineConfig({
  testDir: 'e2e',
  // The whole suite shares one dev server; several specs edit fixture sources
  // (restoring in finally) and those writes invalidate astro style modules,
  // which can briefly null the module-graph join other specs read. One
  // worker, serial files — determinism over wall-clock.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `ASTROIX_E2E_PORT=${PORT} bun run dev`,
      cwd: 'e2e/fixture',
      url: `http://localhost:${PORT}`,
      // CI parity — no zombie adoption, ever; the boot cost is seconds
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // npm-pack smoke lane (ADR-0001): build + pack the repo, install the
      // tarball into the pack fixture, boot it. Managed as a webServer so
      // playwright owns the lifecycle and the generous cold-install timeout.
      command: 'node ../../scripts/prepare-pack-fixture.mjs && bun run dev',
      cwd: 'e2e/pack-fixture',
      url: 'http://localhost:4313',
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
