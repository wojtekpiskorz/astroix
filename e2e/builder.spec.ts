import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// Serial: several tests edit chrome sources on disk (restoring in finally);
// the build test mutates fixture build output.
test.describe.configure({ mode: 'serial' });

test('builder chrome renders the shell and wraps the page by default', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#astroix-root')).toBeVisible();
  await expect(page.locator('#astroix-canvas')).toBeVisible();

  // shell inside the shadow tree: header + sidebar + canvas area
  await expect(page.getByText('Select: off')).toBeVisible();
  await expect(page.locator('[data-astroix-index="ready"]')).toBeVisible();

  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.hero-title')).toHaveText('Astroix fixture');
});

test('Tailwind styles work inside the shadow tree (dual adoption)', async ({ page }) => {
  await page.goto('/');
  const header = page.locator('[data-astroix-header]');
  await expect(header).toBeVisible();
  // a plain utility: header has a real slate background, not the UA default
  const background = await header.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(background).not.toBe('rgba(0, 0, 0, 0)');
  // an @property-dependent utility: translate-x-2 compiles to
  // `translate: var(--tw-translate-x)` — the custom property only resolves
  // when @property registrations survive (shadow-only adoption kills them)
  const transform = await page
    .locator('[data-astroix-header] strong')
    .evaluate((el) => getComputedStyle(el).translate);
  expect(transform).not.toBe('none');
});

test('shadcn theme tokens resolve inside the shadow tree (select toggle is themed)', async ({
  page,
}) => {
  await page.goto('/');
  const toggle = page.getByText('Select: off');
  await expect(toggle).toBeVisible();
  // the toggle is a shadcn Button (data-slot marks the component), off state
  // styled by variant=secondary → var(--secondary)
  expect(await toggle.getAttribute('data-slot')).toBe('button');
  const background = await toggle.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(background).not.toBe('rgba(0, 0, 0, 0)');
  // dark-scoped --secondary is oklch(0.269 0 0) ≈ rgb(43 43 43); the light
  // value (0.97) would mean the `.dark` block is not applying in the shadow
  // tree — i.e. the theming plumbing is broken, not just a shade off
  const channels = background.match(/[\d.]+/g)?.map(Number) ?? [];
  expect(channels.length).toBeGreaterThanOrEqual(3);
  expect(channels[0]).toBeLessThan(100);
});

test('escape hatch: ?builder=0 returns the untouched page', async ({ request }) => {
  const response = await request.get('/?builder=0');
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain('hero-title');
  expect(html).not.toContain('astroix-root');
  expect(html).not.toContain('virtual:astroix/chrome');
});

// #110: the chrome URL carries the canvas position (?canvas=) — refresh and
// share re-boot the canvas where it was. Entry-click navigation, the
// self-assembling invariant and the no-reload guarantee all ride the same
// canvas-load signal the reactive resolution listens to.
test('the chrome URL carries the canvas position and updates without reloads', async ({ page }) => {
  await page.goto('/');
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.hero-title')).toBeVisible();
  const canvasParam = (): string | null => new URL(page.url()).searchParams.get('canvas');

  // boot without the param: today's derivation (the chrome page's own path),
  // then the invariant self-assembles — the first load writes canvas=/
  await expect.poll(canvasParam).toBe('/');

  // the chrome document must not reload when the param updates (prior art:
  // the __astroixLoadedAt marker from the hot-swap tests below)
  await page.evaluate(() => {
    (window as { __astroixLoadedAt?: number }).__astroixLoadedAt = performance.now();
  });
  const historyLength = await page.evaluate(() => history.length);

  // entry→canvas navigation (single candidate) mirrors into the param — and
  // the builder's clean-page marker never leaks into the carried position.
  // Position is proven by the URL param + the blog-page marker (other specs
  // mutate the title text — the chrome seam stays content-agnostic).
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible();
  await page.locator('[data-astroix-entry="2024/post"]').click();
  await expect(canvas.locator('.blog-title')).toBeVisible();
  await expect.poll(canvasParam).toBe('/blog/2024/post');
  expect(canvasParam()).not.toContain('builder');

  // replaceState only: the entry-click navigation itself appends one joint
  // session-history entry (the iframe's own — browser behavior, unchanged);
  // a pushState-based mirror would make this +2
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  expect(
    await page.evaluate(() => (window as { __astroixLoadedAt?: number }).__astroixLoadedAt),
  ).toBeDefined();
});

test('a chrome refresh restores the canvas from the carried position', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible();
  await page.locator('[data-astroix-entry="2024/post"]').click();
  await expect(page.frameLocator('#astroix-canvas').locator('.blog-title')).toBeVisible();

  // the refresh re-boots the chrome with the canvas already at the position —
  // and the reactive resolution re-arms the matching entry over the restored load
  await page.reload();
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.blog-title')).toBeVisible();
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entry="2024/post"]')).toHaveAttribute(
    'data-active',
    'true',
  );
});

test('a shared URL with the param boots the canvas at the carried position', async ({ page }) => {
  // boot precedence: the param wins over deriving from the chrome page's own
  // path (/) — another session opens the builder pre-positioned
  await page.goto('/?canvas=/blog/2024/post');
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.blog-title')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('canvas')).toBe('/blog/2024/post');
});

test('dev toolbar is hidden inside the canvas iframe', async ({ page }) => {
  await page.goto('/');
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('astro-dev-toolbar')).toBeHidden();
});

test('select mode is off by default — canvas interaction passes through untouched', async ({
  page,
}) => {
  await page.goto('/');
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(page.getByText('Select: off')).toBeVisible();
  await expect(page.locator('[data-astroix-selection]')).toHaveText('no selection');

  await canvas.locator('.hero-title').click();
  await expect(page.locator('[data-astroix-selection]')).toHaveText('no selection');
  expect(await canvas.locator('.astroix-selected').count()).toBe(0);
});

test('select mode on: hover outline, click selects and highlights', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Select: off').click();
  await expect(page.getByText('Select: on')).toBeVisible();

  const canvas = page.frameLocator('#astroix-canvas');
  await canvas.locator('.hero-title').hover();
  await expect(canvas.locator('.hero-title')).toHaveClass(/astroix-hover/);

  await canvas.locator('.hero-title').click();
  await expect(page.locator('[data-astroix-selection]')).toContainText('hero-title');
  await expect(canvas.locator('.hero-title')).toHaveClass(/astroix-selected/);

  // toggling off removes the hover/selection machinery from the canvas
  await page.getByText('Select: on').click();
  await expect(page.getByText('Select: off')).toBeVisible();
  expect(await canvas.locator('.astroix-selected').count()).toBe(0);
});

test('chrome components hot-swap without a document reload', async ({ page }) => {
  await page.goto('/');
  const badge = page.locator('[data-astroix-header] strong');
  // the badge is uppercased by CSS; textContent stays lowercase
  await expect(badge).toHaveText('astroix');
  await page.evaluate(() => {
    (window as { __astroixLoadedAt?: number }).__astroixLoadedAt = performance.now();
  });

  const sourcePath = join('src', 'client', 'features', 'css', 'chrome-header.tsx');
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

test('chrome css hot-swaps in both adoption contexts without a canvas reload', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    (window as { __astroixLoadedAt?: number }).__astroixLoadedAt = performance.now();
  });
  const canvasTitle = page.frameLocator('#astroix-canvas').locator('.hero-title');
  await canvasTitle.evaluate((el) => {
    const win = el.ownerDocument.defaultView as { __astroixCanvasLoadedAt?: number };
    win.__astroixCanvasLoadedAt = performance.now();
  });

  const cssPath = join('src', 'client', 'chrome.css');
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
