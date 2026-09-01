import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { SRC_PORT } from './ports';

/**
 * Source-mode lane (ADR-0001, #150): the src-fixture consumes the src-ful
 * staging (`.astroix-local-src` — dist copy + `src` symlink), so the chrome
 * boots from this checkout's source with fast-refresh. The main lane has
 * been publish-shaped (prebuilt chrome) since #123; this lane is the only
 * live runtime for the HMR promise that is ADR-0001's raison d'être, and
 * doubles as the owner's dogfood vehicle (`bun run dev` in e2e/src-fixture).
 */
// This file drives the source lane's server, not the config-wide baseURL —
// same ports module as the config (pack.spec.ts precedent).
test.use({ baseURL: `http://localhost:${SRC_PORT}` });

test("boots the chrome from this checkout's source (source mode)", async ({ page }) => {
  const chromeSourceRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/src/client')) chromeSourceRequests.push(request.url());
  });

  await page.goto('/');
  // the mode discriminator injected via the virtual chrome module: this lane
  // exists to keep this attribute honest ("source" here, "prebuilt" in the
  // main and pack lanes)
  await expect(page.locator('#astroix-root')).toHaveAttribute('data-astroix-chrome-mode', 'source');

  // the chrome document actually requested source modules (the /@fs import
  // chain from the virtual module through the staging layout), not a
  // prebuilt bundle — the pack lane asserts the exact inverse
  await expect(page.getByText('Select: off')).toBeVisible({ timeout: 15_000 });
  expect(chromeSourceRequests.length).toBeGreaterThan(0);

  // canvas unaffected by the delivery mode: the iframe loads host pages
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.hero-title')).toHaveText('Astroix fixture');
});

test('chrome sources fast-refresh without a document reload', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  const badge = page.locator('[data-astroix-header] strong');
  await expect(badge).toHaveText('astroix');
  // no-reload oracle (builder.spec hot-swap precedent): a document reload
  // wipes the marker; fast-refresh keeps it
  await page.evaluate(() => {
    (window as { __astroixLoadedAt?: number }).__astroixLoadedAt = performance.now();
  });

  const sourcePath = join('src', 'client', 'features', 'css', 'chrome-header.tsx');
  const original = readFileSync(sourcePath, 'utf8');
  try {
    writeFileSync(sourcePath, original.replace('astroix</strong>', 'astroix-hmr</strong>'));
    await expect(badge).toHaveText('astroix-hmr', { timeout: 15_000 });

    expect(
      await page.evaluate(() => (window as { __astroixLoadedAt?: number }).__astroixLoadedAt),
    ).toBeDefined();
  } finally {
    writeFileSync(sourcePath, original);
  }
});

test('chrome css hot-swaps in both adoption contexts without a canvas reload', async ({ page }) => {
  // migrated from builder.spec.ts with the source lane (#150): on the
  // publish-shaped main lane chrome sources have no live runtime, so the
  // adoption-context swap assertions live here
  test.setTimeout(60_000);
  await page.goto('/');
  await page.evaluate(() => {
    (window as { __astroixLoadedAt?: number }).__astroixLoadedAt = performance.now();
  });
  const canvasTitle = page.frameLocator('#astroix-canvas').locator('.hero-title');
  await canvasTitle.evaluate((el) => {
    const win = el.ownerDocument.defaultView as { __astroixCanvasLoadedAt?: number };
    win.__astroixCanvasLoadedAt = performance.now();
  });

  // the theme entry moved to packages/app-shell (#218); the hot-swap writes
  // target it there — styles.ts accepts the same module path
  const cssPath = join('packages', 'app-shell', 'src', 'chrome.css');
  const original = readFileSync(cssPath, 'utf8');
  const strong = page.locator('[data-astroix-header] strong');
  try {
    writeFileSync(
      cssPath,
      `${original}\n[data-astroix-header] strong { text-transform: lowercase; }\n`,
    );
    await expect(strong).toHaveCSS('text-transform', 'lowercase', { timeout: 15_000 });

    const topMarker = await page.evaluate(
      () => (window as { __astroixLoadedAt?: number }).__astroixLoadedAt,
    );
    const canvasMarker = await canvasTitle.evaluate(
      (el) =>
        (el.ownerDocument.defaultView as { __astroixCanvasLoadedAt?: number })
          .__astroixCanvasLoadedAt,
    );
    expect(topMarker).toBeDefined();
    expect(canvasMarker).toBeDefined();
  } finally {
    writeFileSync(cssPath, original);
  }
});

test('a single React instance serves the chrome (guard silent through an interaction)', async ({
  page,
}) => {
  const guardWarnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning') guardWarnings.push(message.text());
  });
  page.on('pageerror', (error) => guardWarnings.push(error.message));

  // hooks exercised end-to-end: the Content tab enumerates collections
  // (TanStack Query) and navigates the canvas to an entry
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible();
  await page.locator('[data-astroix-entry="2024/post"]').click();
  await expect(page.frameLocator('#astroix-canvas').locator('.blog-title')).toBeVisible();

  // dual-React symptoms: the ADR-0001 warn-only version guard firing, or
  // React's invalid-hook-call error reaching the console — source mode
  // must resolve this checkout's own React 19 through the staging layout
  expect(
    guardWarnings.filter((text) => /astroix: chrome loaded React|Invalid hook call/.test(text)),
  ).toEqual([]);
});
