import { expect, type Locator, type Page } from '@playwright/test';
import {
  openGlobalEditor as openGlobalEditorShared,
  SETTLE_BUDGET_MS,
} from '../../../../../e2e/web/spec-helpers.ts';

/**
 * The K3 scenario editor locals (#256): the two verticals' shared
 * open-the-editor spelling plus the entry-pane and served-truth
 * derivations, scenario-scoped. #425's single-homing absorbed the
 * open-editor local into `e2e/web/spec-helpers.ts` (the options-form
 * home); this module consumes it under the scenario's
 * positional-served vocabulary — the `abaFreezeResetState` alias
 * precedent — so the battery's call sites keep their derived-served
 * discipline unchanged.
 */

/**
 * Opens the CSS editor on the first GLOBAL row and returns the font-size
 * input, waited to the served value — the shared options-form spelling
 * (#425, homed in `e2e/web/spec-helpers.ts`) under this module's
 * positional-served shape.
 */
export function openGlobalEditor(page: Page, servedValue: string): Promise<Locator> {
  return openGlobalEditorShared(page, { served: servedValue });
}

/** The Content pane's root. */
export function pane(page: Page): Locator {
  return page.locator('[data-astroix-entry-form]');
}

/** Opens the blog entry and waits for the pane's ready state. */
export async function openEntry(page: Page, entryId: string): Promise<void> {
  await page.locator(`[data-astroix-entry="${entryId}"]`).click();
  await expect(pane(page)).toHaveAttribute('data-form-status', 'ready', {
    timeout: SETTLE_BUDGET_MS,
  });
}

/** The title widget's input inside the form. */
export function titleInput(page: Page): Locator {
  return pane(page).locator('[data-astroix-form-field="title"] input');
}

/** The entry frontmatter's title — the served truth a fresh form must carry. */
export function frontmatterTitle(entry: string): string {
  const title = /^title: (.+)$/m.exec(entry)?.[1];
  if (title === undefined) throw new Error('the staged entry carries no title');
  return title;
}

/** The sheet's first font-size declaration — the editor's served value. */
export function firstFontSize(sheet: string): string {
  const size = /font-size: ([^;]+);/.exec(sheet)?.[1];
  if (size === undefined) throw new Error('the staged sheet carries no font-size');
  return size;
}

/** The next toggle value for the font-size oracle — derived from the served value, never hardcoded. */
export function nextFontSize(served: string): string {
  return served === '3.5rem' ? '3rem' : '3.5rem';
}
