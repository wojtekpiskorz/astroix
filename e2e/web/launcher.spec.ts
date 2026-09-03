import { expect, test } from '@playwright/test';
import { rawStatus } from '../../apps/web/src/e2e-wire.ts';
import { WEB_LANE_PORT } from '../../apps/web/src/stage-e2e.ts';

/**
 * The launcher legs of the web host's product E2E (#240): a real
 * Chromium against the real control plane — the launcher document
 * loads on the neutral launcher origin, consumes the ONE AppClient
 * over protocol v1, and lists the registered projects out of the
 * isolated test registry the staging registered. The registry carries
 * two staged fixture copies plus the deliberately-broken root; nothing
 * about listing spawns a plane.
 */

test('the launcher document lists the registered projects over protocol v1', async ({ page }) => {
  await page.goto('/__astroix/app/');
  const list = page.getByTestId('project-list');
  await expect(list).toBeVisible();
  // Two healthy staged copies plus the broken root — every record the
  // test-owned registration created, availability included (the broken
  // root still exists on disk, so it reads available; its breakage is
  // the activation lane's cause, not the registry's).
  await expect(list.locator('li')).toHaveCount(3);
  await expect(list.locator('li').first()).toContainText('available');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
});

test('the launcher listener refuses unregistered hostnames before any upstream byte moves', async () => {
  // The listener's routing law (ADR-0007 / F1): only the neutral
  // launcher host and the ONE exact active project hostname exist; a
  // foreign subdomain never reaches routing state — pinned over the raw
  // socket, where the exact Host evidence is writable.
  const status = await rawStatus(
    WEB_LANE_PORT,
    `GET /__astroix/app/ HTTP/1.1\r\nHost: foreign.localhost:${WEB_LANE_PORT}\r\nConnection: close\r\n\r\n`,
  );
  expect(status).toBe(404);
});
