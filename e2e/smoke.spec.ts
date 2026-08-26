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

test('hero-title carries the CSS surface the POC loop edits', async ({ page }) => {
  await page.goto('/');
  const title = page.locator('.hero-title');

  // scoped block in index.astro → bare [data-astro-cid-*] under the default
  // `attribute` scopedStyleStrategy (verified vs locked astro@7.2.7, T2)
  const cid = await title.evaluate((el) =>
    el.getAttributeNames().find((name) => name.startsWith('data-astro-cid-')),
  );
  expect(cid).toBeTruthy();

  // home.css styles the same element in multiple places (multi-range case):
  // the base block and the second font-weight block both apply — the
  // @media block is surfaced by the rule list, not evaluated here
  const styles = await title.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { fontSize: cs.fontSize, fontWeight: cs.fontWeight };
  });
  expect(styles.fontSize).toBe('48px'); // 3rem from the base block
  expect(styles.fontWeight).toBe('800'); // second block, same file
});
