import { defineConfig, devices } from '@playwright/test';
import { MAIN_PORT, PACK_PORT } from './e2e/ports';

// The e2e lanes own their ports: main :4314, npm-pack :4313 (canonical for
// CI). Parallel local lanes override the pair via ASTROIX_E2E_PORT /
// ASTROIX_E2E_PACK_PORT (#120) so sibling worktrees never share a server.
// The owner's manual smoke lives on :4312 — structural separation, never
// shared servers (PR #36 debugged a "broken" suite that was actually
// playwright adopting the owner's orphaned smoke server with a stale
// dist).

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
    baseURL: `http://localhost:${MAIN_PORT}`,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `ASTROIX_E2E_PORT=${MAIN_PORT} bun run dev`,
      cwd: 'e2e/fixture',
      url: `http://localhost:${MAIN_PORT}`,
      // CI parity — no zombie adoption, ever; the boot cost is seconds
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // npm-pack smoke lane (ADR-0001): build + pack the repo, install the
      // tarball into the pack fixture, boot it. Managed as a webServer so
      // playwright owns the lifecycle and the generous cold-install timeout.
      command: `node ../../scripts/prepare-pack-fixture.mjs && ASTROIX_E2E_PACK_PORT=${PACK_PORT} bun run dev`,
      cwd: 'e2e/pack-fixture',
      url: `http://localhost:${PACK_PORT}`,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
