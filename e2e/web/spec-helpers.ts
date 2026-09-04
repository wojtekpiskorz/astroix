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

/**
 * The batteries' load-shaped expect budget (#392 review round 1): one
 * convergence point (a poll, a text settle, a generation read) on a
 * loaded CI runner. Single-homed here so a future resize is one line,
 * not another fleet-wide literal diff.
 */
export const LOAD_BUDGET_MS = 30_000;

/**
 * The batteries' boot-shaped budget (#392 review round 1): a plane boot —
 * child spawn, dev-server readiness, first document — under CI load.
 */
export const BOOT_BUDGET_MS = 120_000;

/**
 * The batteries' restore tail: deactivate, land on the launcher, pin the
 * idle state for whatever follows. Sized for a loaded CI runner (#392):
 * the deactivation's commit-side work (fence drain, revocation, launcher
 * readiness) and the launcher's first render are load-shaped waits.
 */
export async function restoreIdle(page: Page): Promise<void> {
  await page.getByTestId('deactivate').click();
  await page.waitForURL(LAUNCHER_APP_URL, { timeout: BOOT_BUDGET_MS });
  await expect(page.getByTestId('session-label')).toHaveText('idle', {
    timeout: LOAD_BUDGET_MS,
  });
}
