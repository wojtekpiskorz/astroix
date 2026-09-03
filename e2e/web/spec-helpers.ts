import { expect, type Page } from '@playwright/test';

/**
 * The web lane's shared spec helpers (#242 review round 2: the
 * batteries' carried duplication — the activate button, the two
 * document-URL shapes, and the restore-idle tail — absorbed into one
 * small module per tier; this is the spec tier). Test-only, imported
 * by the lane's specs; no product code touches it.
 */

/** The list item whose staged copy is at `position` (0 and 1 are the fixture copies; 2 is broken). */
export function activateButton(page: Page, position: number) {
  return page.getByTestId('project-list').locator('li').nth(position).getByTestId('activate');
}

/** The project-app document URL on any active project host. */
export const PROJECT_APP_URL = /^http:\/\/(?!launcher)[a-z2-7]+\.localhost:\d+\/__astroix\/app\/$/;

/** The launcher document URL. */
export const LAUNCHER_APP_URL = /launcher\.localhost:\d+\/__astroix\/app\//;

/** The batteries' restore tail: deactivate, land on the launcher, pin the idle state for whatever follows. */
export async function restoreIdle(page: Page): Promise<void> {
  await page.getByTestId('deactivate').click();
  await page.waitForURL(LAUNCHER_APP_URL);
  await expect(page.getByTestId('session-label')).toHaveText('idle');
}
