import { expect, test } from '@playwright/test';

// The vertical tabs (issue #70): the sidebar and the editor dock swap on
// `activeVertical`, and select mode — a property of the CSS vertical — is
// suspended on the canvas while Content is active and restored on return.

test('tabs render at the top of the sidebar, CSS active by default', async ({ page }) => {
  await page.goto('/');

  const cssTab = page.getByRole('tab', { name: 'CSS' });
  const contentTab = page.getByRole('tab', { name: 'Content' });
  await expect(cssTab).toBeVisible();
  await expect(contentTab).toBeVisible();

  // tablist sits inside the sidebar, above the CSS body — visibility first so
  // a detached locator fails there, and the box comparison fails with numbers
  const tablist = page.getByRole('tablist');
  const index = page.locator('[data-astroix-index="ready"]');
  await expect(tablist).toBeVisible();
  await expect(index).toBeVisible();
  const tablistBox = await tablist.boundingBox();
  const indexBox = await index.boundingBox();
  expect(tablistBox?.y ?? -1).toBeLessThan(indexBox?.y ?? Number.POSITIVE_INFINITY);

  // the absolute-over-fixed override holds: the sidebar column starts below
  // the header — if a regeneration breaks the merge, the column goes
  // viewport-fixed over the header and this comparison fails with numbers
  const headerBox = await page.locator('[data-astroix-header]').boundingBox();
  const columnBox = await page.locator('[data-sidebar="sidebar"]').boundingBox();
  expect(columnBox?.y ?? -1).toBeGreaterThanOrEqual(
    (headerBox?.y ?? 0) + (headerBox?.height ?? 0) - 1,
  );

  await expect(cssTab).toHaveAttribute('aria-selected', 'true');
  await expect(contentTab).toHaveAttribute('aria-selected', 'false');

  // the Content slice is not mounted yet (Base UI panels unmount when hidden)
  await expect(page.locator('[data-astroix-entries]')).toHaveCount(0);
  await expect(page.locator('[data-astroix-content-form]')).toHaveCount(0);
});

test('switching to Content swaps the sidebar body and the editor dock', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();

  // shell swap: content placeholders in, CSS workbench out
  await expect(page.locator('[data-astroix-entries="pending"]')).toBeVisible();
  await expect(page.locator('[data-astroix-content-form="pending"]')).toBeVisible();
  await expect(page.locator('[data-astroix-index]')).toHaveCount(0);
  await expect(page.locator('[data-astroix-editor]')).toHaveCount(0);

  // the canvas keeps rendering the page under both verticals
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.hero-title')).toHaveText('Astroix fixture');

  // and back: the CSS body remounts and refetches the index
  await page.getByRole('tab', { name: 'CSS' }).click();
  await expect(page.locator('[data-astroix-index="ready"]')).toBeVisible();
  await expect(page.locator('[data-astroix-content-form]')).toHaveCount(0);
  await expect(page.locator('[data-astroix-editor="empty"]')).toBeVisible();
});

test('an open rule editor survives a Content roundtrip', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Select: off').click();
  const canvas = page.frameLocator('#astroix-canvas');
  await canvas.locator('.hero-title').click();
  await page.locator('[data-astroix-rule]').first().click();
  const editor = page.locator('[data-astroix-editor="view"]');
  await expect(editor).toBeVisible();
  const file = await editor.locator('code').first().textContent();
  expect(file).toBeTruthy();

  // the dock swap unmounts the rule editor; the css store keeps the spec
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-content-form="pending"]')).toBeVisible();

  await page.getByRole('tab', { name: 'CSS' }).click();
  await expect(editor).toBeVisible();
  await expect(editor.locator('code').first()).toHaveText(file as string);
});

test('select mode suspends on Content and restores on return', async ({ page }) => {
  await page.goto('/');
  const canvas = page.frameLocator('#astroix-canvas');

  // arm select mode and select an element (amber outline painted)
  await page.getByText('Select: off').click();
  await canvas.locator('.hero-title').click();
  await expect(canvas.locator('.hero-title')).toHaveClass(/astroix-selected/);
  await expect(page.locator('[data-astroix-selection]')).toContainText('hero-title');

  // switching to Content suspends the machinery: overlay classes stripped,
  // hover paints nothing, and the toggle is inert — selection itself stays
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(canvas.locator('.astroix-selected')).toHaveCount(0);
  await canvas.locator('.hero-title').hover();
  await expect(canvas.locator('.astroix-hover')).toHaveCount(0);
  const selectToggle = page.getByText('Select: on');
  await expect(selectToggle).toBeDisabled();
  await expect(page.locator('[data-astroix-selection]')).toContainText('hero-title');

  // switching back restores it: still armed, hover outlines again
  await page.getByRole('tab', { name: 'CSS' }).click();
  await expect(selectToggle).toBeEnabled();
  await canvas.locator('.hero-title').hover();
  await expect(canvas.locator('.hero-title')).toHaveClass(/astroix-hover/);
});

test('sidebar collapses offcanvas and expands with state preserved', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.locator('[data-slot="sidebar"]');
  await expect(sidebar).toHaveAttribute('data-state', 'expanded');

  // make the vertical state meaningful, then capture the dock's edge before
  // collapsing via the rail (fully reachable while expanded)
  await page.getByRole('tab', { name: 'Content' }).click();
  const dock = page.locator('[data-astroix-content-form="pending"]');
  await expect(dock).toBeVisible();
  const dockXExpanded = (await dock.boundingBox())?.x;
  await page.getByRole('button', { name: 'Toggle Sidebar' }).click();

  // offcanvas collapse: the state flips and the column is reclaimed — the
  // dock's left edge moves in by the sidebar width. The gap div animates
  // its width (~200ms), so poll for the settled geometry instead of
  // sampling once; a gap stuck at 18rem would never satisfy the poll
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
  await expect
    .poll(async () => (await dock.boundingBox())?.x ?? Number.NaN)
    .toBeLessThan((dockXExpanded ?? 0) - 250);
  await expect(page.frameLocator('#astroix-canvas').locator('.hero-title')).toBeVisible();

  // the keyboard shortcut expands; the active vertical survived the roundtrip
  await page.keyboard.press('Meta+b');
  await expect(sidebar).toHaveAttribute('data-state', 'expanded');
  await expect(page.locator('[data-astroix-entries="pending"]')).toBeVisible();
  await expect(page.locator('[data-astroix-index]')).toHaveCount(0);

  // the shell seeds the provider from the primitive's cookie: the collapsed
  // state survives a full reload (memory state like the vertical resets —
  // the CSS body is back as the default)
  await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
  await page.reload();
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
  await page.keyboard.press('Meta+b');
  await expect(sidebar).toHaveAttribute('data-state', 'expanded');
  await expect(page.locator('[data-astroix-index="ready"]')).toBeVisible();
});

test('theme preset b1Z6BvKCW resolves: sidebar token surface + blue primary', async ({ page }) => {
  await page.goto('/');

  // the sidebar surface styles itself from --sidebar, not the UA default
  const sidebarBackground = await page
    .locator('[data-sidebar="sidebar"]')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(sidebarBackground).not.toBe('rgba(0, 0, 0, 0)');

  // the preset's signature read from the cascade itself — the toggle's
  // computed background sits behind its color transition, so mid-flight
  // reads race; the custom property echoes the token text deterministically.
  // --primary is a saturated blue (chroma ~0.2, hue ~265), unlike the
  // neutral nova default
  const primary = await page
    .locator('[data-astroix-header]')
    .evaluate((el) => getComputedStyle(el).getPropertyValue('--primary'));
  const numbers = (primary.match(/[\d.]+/g) ?? []).map(Number);
  expect(numbers.length).toBeGreaterThanOrEqual(3);
  const [chroma = 0, hue = 0] = numbers.slice(1);
  expect(chroma).toBeGreaterThan(0.15);
  expect(hue).toBeGreaterThanOrEqual(250);
  expect(hue).toBeLessThanOrEqual(280);
});
