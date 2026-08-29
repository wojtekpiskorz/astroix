import { expect, test } from '@playwright/test';

// The navigation bridge (#71): reactive selection canvas→entry (route
// resolution over the canvas URL, reported on every iframe load), entry→canvas
// reverse navigation gated on a single candidate and verified by forward
// match, and ambiguity = silence — the form opens, the canvas stays put.

/** Drives an in-canvas navigation — the load event is the signal under test, the initiator is not. */
async function navigateCanvas(page: import('@playwright/test').Page, path: string): Promise<void> {
  await page.locator('#astroix-canvas').evaluate((frame: HTMLIFrameElement, target: string) => {
    frame.contentWindow?.location.assign(target);
  }, `${path}?builder=0`);
}

test('canvas→entry: a dynamic-route canvas marks the entry active in the Content tab', async ({
  page,
}) => {
  await page.goto('/blog/2024/post');
  await page.getByRole('tab', { name: 'Content' }).click();

  const list = page.locator('[data-astroix-entries="ready"]');
  await expect(list).toBeVisible();

  // the two-level list: collections → entries (entry id as label)
  await expect(page.locator('[data-astroix-collection="blog"]')).toBeVisible();
  await expect(page.locator('[data-astroix-collection="homepage"]')).toBeVisible();
  await expect(page.locator('[data-astroix-collection="blog"] [data-astroix-entry]')).toHaveCount(
    3,
  );

  // route resolution from the canvas URL picked the nested-id entry
  const entry = page.locator('[data-astroix-entry="2024/post"]');
  await expect(entry).toHaveAttribute('data-active', 'true');
  await expect(entry).toHaveAttribute('aria-current', 'true');

  // the editor pane follows the active entry
  const pane = page.locator('[data-astroix-content-pane="body"]');
  await expect(pane).toBeVisible();
  await expect(pane.locator('code')).toHaveText('blog/2024/post');
});

test('canvas navigation while Content is inactive marks quietly — no tab yank', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.frameLocator('#astroix-canvas').locator('.hero-title')).toBeVisible();

  // the CSS tab stays active while the canvas navigates to the dynamic route
  await navigateCanvas(page, '/blog/2024/post');
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.blog-title')).toHaveText('Nested post');
  await expect(page.getByRole('tab', { name: 'CSS' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-astroix-index="ready"]')).toBeVisible();

  // entering the Content tab shows the entry open — resolution caught up
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible();
  await expect(page.locator('[data-astroix-entry="2024/post"]')).toHaveAttribute(
    'data-active',
    'true',
  );
});

test('entry→canvas: a unique candidate navigates and the forward match reselects it', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible();

  // one candidate route (/blog/[...slug]; [slug] cannot take a nested id)
  await page.locator('[data-astroix-entry="2024/post"]').click();
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.blog-title')).toHaveText('Nested post');

  // the post-navigation forward match reselects the same entry
  const entry = page.locator('[data-astroix-entry="2024/post"]');
  await expect(entry).toHaveAttribute('data-active', 'true');
  await expect(page.locator('[data-astroix-content-pane="body"] code')).toHaveText(
    'blog/2024/post',
  );

  // a plain navigation away resolves silent (static home) — the selection clears
  await navigateCanvas(page, '/');
  await expect(canvas.locator('.hero-title')).toBeVisible();
  await expect(page.locator('[data-astroix-entries="ready"] [data-active="true"]')).toHaveCount(0);
  await expect(page.locator('[data-astroix-content-pane="empty"]')).toBeVisible();
});

test('ambiguity is silence: two candidate routes open the form without navigating', async ({
  page,
}) => {
  await page.goto('/');
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.hero-title')).toBeVisible();

  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible();

  // hello-builder fills both /blog/[...slug] and /blog/[slug] — no navigation
  await page.locator('[data-astroix-entry="hello-builder"]').click();
  await expect(page.locator('[data-astroix-entry="hello-builder"]')).toHaveAttribute(
    'data-active',
    'true',
  );

  // the canvas never left the home page
  await expect(canvas.locator('.hero-title')).toBeVisible();
  await expect(canvas.locator('.blog-title')).toHaveCount(0);
});
