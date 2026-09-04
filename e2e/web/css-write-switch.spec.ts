import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, type Request, test } from '@playwright/test';
import { stagedCopyRoot } from '../../apps/web/src/stage-e2e.ts';
import { spliceText } from '../../packages/core/src/splice-writer.ts';
import {
  activateButton,
  BOOT_BUDGET_MS,
  LAUNCHER_APP_URL,
  LOAD_BUDGET_MS,
  PROJECT_APP_URL,
  restoreIdle,
} from './spec-helpers.ts';

/**
 * The CSS vertical's pending-write-during-switch battery (#250, I2):
 * what happens to the edit side of the CSS loop when the session
 * transitions underneath it — the AC's two switch truths:
 *
 * - a NORMAL switch drains accepted edits: a write the server
 *   accepted before the deactivation began lands through the F5
 *   fence's drain, and the NEW generation serves the written truth —
 *   never a lost edit, never a stale pane.
 * - an UNRESOLVED write at the switch reports nothing false and
 *   grants no overlapping authority: a response held past the
 *   transition delivers nothing anywhere (the document that asked is
 *   gone), the new generation's editor starts from the served truth
 *   alone, and no client state resumes the dead session's pending
 *   work — the forced path's client-side face (the server-side forced
 *   mechanics are F5/F6's own lanes).
 *
 * SERIAL like the lane's other batteries: one control plane, one
 * supervisor-global active session — every leg restores the idle state.
 */

const PROJECT_A = stagedCopyRoot('project-a');
const CSS_FILE = join(PROJECT_A, 'src', 'pages', 'home.css');

const CANVAS_FRAME = '[data-astroix-canvas] iframe';

/** The write settle budget: the first accepted edit forks the real write-executor child. */
const WRITE_SETTLE_MS = 90_000;

/** The file's current bytes — the staged copy's truth. */
async function cssBytes(): Promise<string> {
  return await readFile(CSS_FILE, 'utf8');
}

/** Counts the apply-edit requests that crossed. */
function captureWriteCount(page: Page): () => number {
  let count = 0;
  page.on('request', (request: Request) => {
    if (!request.url().endsWith('/__astroix/api/v1')) return;
    if (request.method() !== 'POST') return;
    const kind = (request.postDataJSON() as { command?: { kind?: string } } | null)?.command?.kind;
    if (kind === 'apply-edit') count += 1;
  });
  return () => count;
}

/** The batteries' shared activation prefix (the inspection lane's own discipline). */
async function activateSettled(page: Page): Promise<void> {
  const frameNavigations: string[] = [];
  const onNavigated = (frame: import('@playwright/test').Frame): void => {
    if (frame.parentFrame() !== null) frameNavigations.push(frame.url());
  };
  page.on('framenavigated', onNavigated);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle', {
    timeout: LOAD_BUDGET_MS,
  });
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL, { timeout: BOOT_BUDGET_MS });
  await expect(page.getByTestId('canvas-origin-state')).toHaveText('project', {
    timeout: LOAD_BUDGET_MS,
  });
  await expect
    .poll(() => frameNavigations.length, { timeout: LOAD_BUDGET_MS })
    .toBeGreaterThanOrEqual(2);
  frameNavigations.length = 0;
  await page.waitForTimeout(1500);
  expect(frameNavigations).toEqual([]);
  page.removeListener('framenavigated', onNavigated);
}

/** Clicks one canvas element until the selection lands. */
async function canvasSelect(page: Page, selector: string): Promise<void> {
  await expect(async () => {
    await page.frameLocator(CANVAS_FRAME).locator(selector).click();
    await expect(page.getByTestId('selection-tag')).not.toHaveText('none', { timeout: 2_000 });
  }).toPass({ timeout: LOAD_BUDGET_MS * 3 });
}

/** Opens the editor on the first GLOBAL row and returns the font-size input. */
async function openGlobalEditor(page: Page, servedValue = '3rem') {
  await expect(page.getByTestId('css-rule-list')).toBeVisible({ timeout: BOOT_BUDGET_MS });
  await expect(page.locator('[data-testid="css-rule"]')).toHaveCount(4, {
    timeout: LOAD_BUDGET_MS,
  });
  await page.locator('[data-testid="css-rule-edit"]').nth(1).click();
  await expect(page.getByTestId('css-rule-editor')).toBeVisible({ timeout: LOAD_BUDGET_MS });
  const input = page.locator('[data-testid="css-decl-input"][data-css-prop="font-size"]');
  await expect(input).toHaveValue(servedValue, { timeout: LOAD_BUDGET_MS });
  return input;
}

/** The oracle's expected bytes: the first global font-size declaration spliced to the next value. */
function expectedFontSizeWrite(before: string, fromValue: string, nextValue: string): string {
  const replaced = `font-size: ${fromValue};`;
  const start = before.indexOf(replaced);
  if (start === -1) throw new Error(`the staged sheet lost "font-size: ${fromValue};"`);
  return spliceText(before, {
    start,
    end: start + replaced.length,
    replacement: `font-size: ${nextValue};`,
  });
}

test.describe.configure({ mode: 'serial' });

test('an accepted CSS write drains through the normal switch — the new generation serves it', async ({
  page,
}) => {
  test.setTimeout(420_000);
  const writeCount = captureWriteCount(page);
  await activateSettled(page);
  await canvasSelect(page, '.hero-title');
  const input = await openGlobalEditor(page);
  const before = await cssBytes();

  // the write crosses AND SETTLES server-side before any transition:
  // the staged bytes are the committed result
  await input.fill('3.5rem');
  await expect
    .poll(async () => await cssBytes(), { timeout: WRITE_SETTLE_MS })
    .toBe(expectedFontSizeWrite(before, '3rem', '3.5rem'));
  await expect(page.getByTestId('css-write-status')).toHaveAttribute('data-write-state', 'quiet', {
    timeout: WRITE_SETTLE_MS,
  });
  expect(writeCount()).toBe(1);

  // the normal switch: deactivate (the drain sees an already-settled
  // write — nothing to wait for), the document resets and replaces
  await page.getByTestId('deactivate').click();
  await page.waitForURL(LAUNCHER_APP_URL, { timeout: BOOT_BUDGET_MS });
  await expect(page.getByTestId('session-label')).toHaveText('idle', {
    timeout: LOAD_BUDGET_MS,
  });

  // the NEW generation's served truth IS the drained write: the bytes
  // persist and the fresh editor opens on the written value with a
  // live quiet loop — never a resumed old-generation state
  await activateSettled(page);
  await canvasSelect(page, '.hero-title');
  await openGlobalEditor(page, '3.5rem');
  await expect(page.getByTestId('css-write-status')).toHaveAttribute('data-write-state', 'quiet', {
    timeout: LOAD_BUDGET_MS,
  });
  expect(await cssBytes()).toBe(expectedFontSizeWrite(before, '3rem', '3.5rem'));
  // exactly the one mutation — the new generation wrote nothing
  expect(writeCount()).toBe(1);

  // restore the fixture bytes for whatever follows the battery
  const { writeFile } = await import('node:fs/promises');
  await writeFile(CSS_FILE, before);
  await restoreIdle(page);
});

test('an unresolved CSS write at the switch reports nothing false and grants no overlapping authority', async ({
  page,
}) => {
  test.setTimeout(420_000);
  const writeCount = captureWriteCount(page);
  await activateSettled(page);
  await canvasSelect(page, '.hero-title');
  const input = await openGlobalEditor(page);
  const before = await cssBytes();

  // delay every apply-edit RESPONSE far past the transition: the
  // REQUEST crosses immediately (the server accepts it, the executor
  // commits the bytes, and the disk-poll below PROVES the settlement
  // before the deactivation begins), and only the fulfilled response
  // trails — it arrives after the document is replaced, and a
  // fulfilled response into a dead request delivers nothing anywhere.
  await page.route('**/__astroix/api/v1', async (route) => {
    const body = route.request().postDataJSON() as { command?: { kind?: string } } | null;
    if (body?.command?.kind === 'apply-edit') {
      const response = await route.fetch();
      await page.waitForTimeout(10_000);
      try {
        await route.fulfill({ response });
      } catch {
        // the request died with the replaced document — the stale
        // response could not deliver anything, which is the point
      }
      return;
    }
    await route.fallback();
  });

  await input.fill('3.5rem');
  await expect
    .poll(async () => await cssBytes(), { timeout: WRITE_SETTLE_MS })
    .toBe(expectedFontSizeWrite(before, '3rem', '3.5rem'));

  // deactivate while the response is still held: the transition sees
  // an already-settled write (nothing to drain), the document is reset
  // and replaced — the unresolved response cannot deliver anything
  await page.getByTestId('deactivate').click();
  await page.waitForURL(LAUNCHER_APP_URL, { timeout: BOOT_BUDGET_MS });
  await expect(page.getByTestId('session-label')).toHaveText('idle', {
    timeout: LOAD_BUDGET_MS,
  });

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await activateSettled(page);
  await canvasSelect(page, '.hero-title');
  // the NEW generation's served truth is authoritative and COMPLETE:
  // the written value (the helper's own settle), a quiet loop, a
  // disabled undo (the old generation's undo state died with its
  // document — nothing of the dead session resumed here), and no
  // second mutation ever crossed
  await openGlobalEditor(page, '3.5rem');
  await expect(page.getByTestId('css-write-status')).toHaveAttribute('data-write-state', 'quiet', {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.getByTestId('css-undo')).toBeDisabled();
  expect(writeCount()).toBe(1);
  expect(await cssBytes()).toBe(expectedFontSizeWrite(before, '3rem', '3.5rem'));

  // restore the fixture bytes for whatever follows the battery
  const { writeFile } = await import('node:fs/promises');
  await writeFile(CSS_FILE, before);
  await restoreIdle(page);
});
