import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Frame, type Page } from '@playwright/test';
import { stagedCopyRoot } from '../../apps/web/src/stage-e2e.ts';
import { spliceText } from '../../packages/core/src/splice-writer.ts';

/**
 * The web lane's shared spec helpers (#242 review round 2: the
 * batteries' carried duplication — the activate button, the two
 * document-URL shapes, and the restore-idle tail — absorbed into one
 * small module per tier; this is the spec tier). #250's write
 * batteries and #249's inspection battery grew the same way: the
 * settled-activation prefix, the canvas selection retry, the staged
 * sheet's bytes, the write-settle budget, and the pure splice oracle.
 * Test-only, imported by the lane's specs; no product code touches it.
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
 * The batteries' settle budget (#396, folding #395's recorded rider):
 * the young managed dev server converging under CI load — the frame's
 * post-connect self-reload settle (activateSettled's navigation poll,
 * previously the unnamed `LOAD_BUDGET_MS * 2`), and the content
 * battery's settles over the freshly-booted plane: the first
 * inspection's fresh runner and the canvas's first route compile
 * (write settles carry their own #250 budget below). Sized between
 * the landing and plane-boot budgets; single-homed here so a future
 * resize is one line, not another fleet-wide literal diff.
 */
export const SETTLE_BUDGET_MS = 60_000;

/** The canvas select's toPass retry ceiling — three load-budget windows for the interactive retry loop (named: the last multiplier in the file). */
export const CANVAS_SELECT_RETRY_MS = LOAD_BUDGET_MS * 3;

/**
 * The write batteries' settle budget (#250): the first accepted edit
 * forks the real write-executor child, and the settle spans the fork,
 * the executor's commit, and the post-commit refresh convergence.
 */
export const WRITE_SETTLE_MS = 90_000;

/** The staged copy the write batteries edit (registered first — position 0). */
export const STAGED_CSS_FILE = join(stagedCopyRoot('project-a'), 'src', 'pages', 'home.css');

/** The staged sheet's current bytes — the write batteries' disk truth. */
export async function cssBytes(): Promise<string> {
  return await readFile(STAGED_CSS_FILE, 'utf8');
}

/** Activates the first staged fixture copy and lands the project document (the content batteries' shared opening). */
export async function activateProject(page: Page): Promise<void> {
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle', {
    timeout: LOAD_BUDGET_MS,
  });
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL, { timeout: BOOT_BUDGET_MS });
}

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

/**
 * The batteries' shared activation prefix: land on the launcher,
 * activate, and WAIT FOR THE CANVAS TO SETTLE — the initial load plus
 * the young dev server's one post-connect self-reload (the canvas
 * battery's own HMR-leg discipline; a click racing that rebuild lands
 * on a document whose capture listener is between epochs and is lost).
 * Event-ordered: the two baseline navigations complete BEFORE the
 * settle clock starts, and the settle window proves no third navigation
 * is in flight. `position` selects the staged copy to activate (the
 * A-B-A switch harness reaches 1; every other battery takes the default
 * 0) — the ONE spelling of this settle discipline, never re-derived
 * (#254 review: the copy had already drifted at birth).
 */
export async function activateSettled(page: Page, position = 0): Promise<void> {
  const frameNavigations: string[] = [];
  const onNavigated = (frame: Frame): void => {
    if (frame.parentFrame() !== null) frameNavigations.push(frame.url());
  };
  page.on('framenavigated', onNavigated);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
  await activateButton(page, position).click();
  await page.waitForURL(PROJECT_APP_URL, { timeout: BOOT_BUDGET_MS });
  await expect(page.getByTestId('canvas-origin-state')).toHaveText('project', {
    timeout: LOAD_BUDGET_MS,
  });
  await expect
    .poll(() => frameNavigations.length, { timeout: SETTLE_BUDGET_MS })
    .toBeGreaterThanOrEqual(2);
  frameNavigations.length = 0;
  await page.waitForTimeout(1500);
  expect(frameNavigations).toEqual([]);
  page.removeListener('framenavigated', onNavigated);
}

/** The canvas frame locator — the product-attribute form (#374 ruling), never a test id. */
export const CANVAS_FRAME = '[data-astroix-canvas] iframe';

/**
 * Clicks one canvas element until the selection lands — bounded retry
 * over a possibly-reloading document (a mid-navigation click is
 * retried, never assumed).
 */
export async function canvasSelect(page: Page, selector: string): Promise<void> {
  await expect(async () => {
    await page.frameLocator(CANVAS_FRAME).locator(selector).click();
    await expect(page.getByTestId('selection-tag')).not.toHaveText('none', { timeout: 2_000 });
  }).toPass({ timeout: CANVAS_SELECT_RETRY_MS });
}

/**
 * The frozen splice's own oracle — the first global font-size
 * declaration spliced to its next value: the SAME pure core
 * splice-writer the frozen edit contracts were derived through, so a
 * drift from the corpus's behavior is a defect, not a diff.
 */
export function expectedDeclarationWrite(
  before: string,
  property: string,
  fromValue: string,
  nextValue: string,
): string {
  const replaced = `${property}: ${fromValue};`;
  const start = before.indexOf(replaced);
  if (start === -1) throw new Error(`the staged sheet lost "${replaced}"`);
  return spliceText(before, {
    start,
    end: start + replaced.length,
    replacement: `${property}: ${nextValue};`,
  });
}
