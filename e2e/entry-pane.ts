import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The content-pane helpers shared by the specs that drive the auto-write
 * loop (auto-write.spec.ts on the main lane, live-refresh.spec.ts on the
 * source lane — same helpers, either fixture, baseURL per file via
 * `test.use`). Entry-restore/settle-writes precedent: one helper module
 * beats byte-copies that drift.
 */

/** The stashed CM6 view handle (body-editor.spec's CmView, body-append slice). */
export interface CmView {
  state: { doc: { toString: () => string; length: number } };
  dispatch: (spec: { selection?: { anchor: number } }) => void;
  focus: () => void;
}

export async function openEntry(page: Page, entry: string): Promise<Locator> {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible({ timeout: 10_000 });
  await page.locator(`[data-astroix-entry="${entry}"]`).click();
  const pane = page.locator('[data-astroix-content-pane="form"]');
  await expect(pane).toBeVisible();
  // the loop's raw baseline must be loaded before any edit can schedule
  await expect(pane.locator('[data-astroix-write-status]')).toHaveAttribute(
    'data-astroix-write-status',
    'idle',
    { timeout: 10_000 },
  );
  return pane;
}

/** The loop came to rest without conflict or failure. */
export async function expectSettled(pane: Locator): Promise<void> {
  await expect(pane.locator('[data-astroix-write-status]')).toHaveAttribute(
    'data-astroix-write-status',
    /(idle|saved)/,
    { timeout: 15_000 },
  );
}
