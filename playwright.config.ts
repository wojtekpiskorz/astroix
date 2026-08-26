import { defineConfig, devices } from '@playwright/test';

const PORT = 4312;

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
  webServer: {
    command: 'bun run dev',
    cwd: 'e2e/fixture',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
