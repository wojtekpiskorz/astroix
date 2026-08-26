import { expect, test } from '@playwright/test';

test('fixture dev server renders the hero from the content collection', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.hero-title')).toHaveText('Astroix fixture');
  await expect(page.locator('.hero-lead')).toBeVisible();
});

test('dev server boots clean with the astroix integration registered', async ({ page }) => {
  // astro.config.mjs imports the local package via file:../.. and registers
  // astroix(); a broken link or a failing integration would kill boot before
  // the webServer became ready. Serving the chrome itself lands with #12.
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
});
