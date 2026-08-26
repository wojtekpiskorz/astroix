import { expect, test } from '@playwright/test';

test('fixture dev server renders the hero from the content collection', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.hero-title')).toHaveText('Astroix fixture');
  await expect(page.locator('.hero-lead')).toBeVisible();
});
