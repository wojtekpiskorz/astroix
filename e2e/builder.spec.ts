import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// Serial: the HMR test edits chrome source on disk; the build test mutates
// fixture build output. Neither may race the plain rendering assertions.
test.describe.configure({ mode: 'serial' });

test('builder chrome wraps the page by default', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#astroix-root')).toBeVisible();
  await expect(page.locator('#astroix-canvas')).toBeVisible();

  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.hero-title')).toHaveText('Astroix fixture');
});

test('escape hatch: ?builder=0 returns the untouched page', async ({ request }) => {
  const response = await request.get('/?builder=0');
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain('hero-title');
  expect(html).not.toContain('astroix-root');
  expect(html).not.toContain('virtual:astroix/chrome');
});

test('dev toolbar is hidden inside the canvas iframe', async ({ page }) => {
  await page.goto('/');
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('astro-dev-toolbar')).toBeHidden();
});

test('chrome mounts from source and hot-swaps React components without a reload', async ({
  page,
}) => {
  await page.goto('/');
  const badge = page.locator('#astroix-root strong');
  await expect(badge).toHaveText('astroix');

  // Marker that survives only if the document never reloads.
  await page.evaluate(() => {
    (window as { __astroixLoadedAt?: number }).__astroixLoadedAt = performance.now();
  });

  const sourcePath = join('src', 'client', 'placeholder.tsx');
  const original = readFileSync(sourcePath, 'utf8');
  try {
    writeFileSync(sourcePath, original.replace('astroix</strong>', 'astroix-hmr</strong>'));
    await expect(badge).toHaveText('astroix-hmr', { timeout: 15_000 });

    const marker = await page.evaluate(
      () => (window as { __astroixLoadedAt?: number }).__astroixLoadedAt,
    );
    expect(marker).toBeDefined();
  } finally {
    writeFileSync(sourcePath, original);
  }
});

test('dev-only guarantee: the fixture production build contains no astroix bytes', () => {
  const fixtureDist = join('e2e', 'fixture', 'dist');
  execSync('bunx astro build', { cwd: 'e2e/fixture', stdio: 'pipe' });

  const files: string[] = [];
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) collect(full);
      else files.push(full);
    }
  };
  collect(fixtureDist);
  expect(files.length).toBeGreaterThan(0);

  // Case-sensitive: the fixture hero says "Astroix fixture" (capital A) —
  // injected chrome markup is the only lowercase-'astroix' producer.
  const offenders = files.filter((file) => readFileSync(file, 'utf8').includes('astroix'));
  expect(offenders).toEqual([]);
});
