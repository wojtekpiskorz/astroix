import { expect, type Locator, type Page } from '@playwright/test';
import {
  BOOT_BUDGET_MS,
  LOAD_BUDGET_MS,
  SETTLE_BUDGET_MS,
} from '../../../../../e2e/web/spec-helpers.ts';

/**
 * The K3 scenario editor locals (#256): the two verticals' shared
 * open-the-editor spellings, scenario-scoped. These are the #425
 * battery-local spellings (the issue counts this lane's copies and
 * owns their absorption into `e2e/web/spec-helpers.ts` — the fifth
 * spelling stays scenario-local here, disclosed in the lane's PR, and
 * #425's single-homing proceeds as filed).
 */

/** Opens the CSS editor on the first GLOBAL row and returns the font-size input, waited to the served value. */
export async function openGlobalEditor(page: Page, servedValue: string): Promise<Locator> {
  await expect(page.getByTestId('css-rule-list')).toBeVisible({ timeout: BOOT_BUDGET_MS });
  await expect(page.locator('[data-testid="css-rule"]')).toHaveCount(4, {
    timeout: LOAD_BUDGET_MS,
  });
  await page.locator('[data-testid="css-rule-edit"]').nth(1).click();
  await expect(page.getByTestId('css-rule-editor')).toBeVisible({ timeout: BOOT_BUDGET_MS });
  const input = page.locator('[data-testid="css-decl-input"][data-css-prop="font-size"]');
  await expect(input).toHaveValue(servedValue, { timeout: LOAD_BUDGET_MS });
  return input;
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
