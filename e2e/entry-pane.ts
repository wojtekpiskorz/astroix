import { expect, type Locator, type Page } from '@playwright/test';
import { expectVisibleWithBootRecovery } from './boot-gate';

/**
 * The content-pane helpers shared by the specs that drive the auto-write
 * loop (auto-write.spec.ts on the main lane, live-refresh.spec.ts on the
 * source lane — same helpers, either fixture, baseURL per file via
 * `test.use`). Entry-restore/settle-writes precedent: one helper module
 * beats byte-copies that drift.
 */

/** The stashed CM6 view handle shared by the editor-driving specs. */
export interface CmView {
  state: { doc: { toString: () => string; length: number } };
  dispatch: (spec: { selection?: { anchor: number; head?: number } }) => void;
  focus: () => void;
}

export async function openEntry(page: Page, entry: string): Promise<Locator> {
  await page.goto('/');
  // chrome-boot gate (#158, of #129's boot-contention family — RUN 9 in that
  // issue's triage record): on the first chrome-boot-sensitive test of a
  // run, the initial chrome-module request can stall under CPU contention
  // for longer than any honest fixed budget — every interaction below would
  // then time out with errors that never name the cause. The canvas iframe
  // only exists once the chrome shell mounts, so this gate fails at the
  // cold-boot budget with a boot-naming error instead (the helper's reload
  // hop recovers a request-scoped stall; a genuinely hung boot still fails
  // named). It extends — never replaces — the entries-ready wait below
  // (mount vs data). Consumer files house this envelope with a file-level
  // test.setTimeout at or above 105 s — never combined with test.slow(),
  // whose annotation silently triples any declared timeout.
  await expectVisibleWithBootRecovery(
    page,
    page.locator('#astroix-canvas'),
    'chrome boot: the builder shell never mounted',
    105_000,
  );
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
