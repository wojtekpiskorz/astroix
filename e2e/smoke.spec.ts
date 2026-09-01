import { expect, test } from '@playwright/test';

// The builder chrome wraps every top-level URL by default (integration slice);
// these specs are about the page itself, so they load it through the escape
// hatch. The chrome side is covered by builder.spec.ts.
const CANVAS_URL = '/?builder=0';

test('fixture dev server renders the hero from the content collection', async ({ page }) => {
  await page.goto(CANVAS_URL);
  await expect(page.locator('.hero-title')).toHaveText('Astroix fixture');
  await expect(page.locator('.hero-lead')).toBeVisible();
});

test('dev server boots clean with the astroix integration registered', async ({ page }) => {
  // the main lane's disposable oracle copy (#213) registers astroix() through
  // the publish-shaped staging dir (.astroix-local, #123); a broken link or
  // a failing integration would kill boot before the webServer became
  // ready. The chrome assertions live in builder.spec.ts.
  const response = await page.goto(CANVAS_URL);
  expect(response?.status()).toBe(200);
});

test('hero-title carries the CSS surface the POC loop edits', async ({ page }) => {
  await page.goto(CANVAS_URL);
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
