import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectVisibleWithBootRecovery } from './boot-gate';

// Serial: the build test mutates fixture build output. (The chrome-source
// hot-swap tests moved to source-mode.spec.ts with the source lane — this
// lane boots the publish-shaped artifact, where chrome sources have no
// live runtime; #150.)
test.describe.configure({ mode: 'serial' });

test('builder chrome renders the shell and wraps the page by default', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#astroix-root')).toBeVisible();
  await expect(page.locator('#astroix-canvas')).toBeVisible();

  // the main lane is publish-shaped since #123: the chrome must boot the
  // prebuilt bundle here (source mode lives in its own lane — source-mode.spec)
  await expect(page.locator('#astroix-root')).toHaveAttribute(
    'data-astroix-chrome-mode',
    'prebuilt',
  );

  // shell inside the shadow tree: header + sidebar + canvas area
  await expect(page.getByText('Select: off')).toBeVisible();
  await expect(page.locator('[data-astroix-index="ready"]')).toBeVisible();

  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.hero-title')).toHaveText('Astroix fixture');
});

test('the prebuilt chrome module serves without the inline dev sourcemap (#171)', async ({
  page,
}) => {
  await page.goto('/');
  const response = await page.request.get('/virtual:astroix/chrome');
  expect(response.status()).toBe(200);
  const body = await response.text();
  // vite dev inlines a module's transform sourcemap as a base64 data URL
  // unless the final map is empty — for the prebuilt bundle that map is
  // unreadable dead weight (it maps back onto the shipped bundle) and it
  // tripled the boot payload (7.85 MB served vs 2.2 MB of code), widening
  // the renderer-starvation window the #158/#129 boot-stall family rides.
  // The payload guard (src/node/vite-plugin.ts) returns an empty-mappings
  // map; this pins the property against vite upgrades re-inlining it.
  expect(body).not.toContain('sourceMappingURL=data:');
  expect(body.length).toBeLessThan(3_000_000);
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
  // houses the post-reload cold-boot budget below: the default 30 s test
  // timeout would cut that budget off and re-produce the exact wrong error
  // shape this test guards against (#158 / #129)
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible();
  await page.locator('[data-astroix-entry="2024/post"]').click();
  await expect(page.frameLocator('#astroix-canvas').locator('.blog-title')).toBeVisible();

  // the refresh re-boots the chrome with the canvas already at the position —
  // and the reactive resolution re-arms the matching entry over the restored load
  await page.reload();
  const canvas = page.frameLocator('#astroix-canvas');
  // cold-boot gate, not a hot-path assertion (#158, of #129's boot-contention
  // family — RUN 5 in that issue's body: chrome up, iframe still empty at the
  // 5 s budget end; also observed >60 s once under load): the reload
  // re-parses the chrome module and re-boots the full canvas page at the
  // carried position. The helper's budget bounds the wait and its reload hop
  // recovers a request-scoped stall; the carried position rides the URL, so
  // the reload keeps testing exactly this behavior. A page that never lands
  // fails at the budget with the named error. If #155's canvas-load marker
  // lands, keying this wait on it beats the blanket budget — rebase-
  // coordinate then.
  await expectVisibleWithBootRecovery(
    page,
    canvas.locator('.blog-title'),
    'canvas cold boot: the reloaded page never landed in the iframe',
    75_000,
  );
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

test('a Canvas re-render after navigation never reloads the iframe', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible();
  await page.locator('[data-astroix-entry="2024/post"]').click();

  // advisory round 1: with the chrome URL carrying the position, a re-derived
  // boot src drifts on the next Canvas render (the select-mode subscription
  // flip is that render). The drift is masked today by the compiler's prop
  // memoization (verified green against the unfixed code) — CANVAS_BOOT_SRC
  // makes the no-reload invariant hold by construction; this guards it.
  const canvasTitle = page.frameLocator('#astroix-canvas').locator('.blog-title');
  await expect(canvasTitle).toBeVisible();
  await canvasTitle.evaluate((el) => {
    const win = el.ownerDocument.defaultView as { __astroixCanvasLoadedAt?: number };
    win.__astroixCanvasLoadedAt = performance.now();
  });

  await page.getByRole('tab', { name: 'CSS' }).click();
  await page.getByText('Select: off').click();
  await expect(page.getByText('Select: on')).toBeVisible();
  // settle before the read (rest.spec.ts precedent): the old document stays
  // queryable until a replacement navigation commits — an in-flight reload
  // would answer from the old window and coin-flip the guard green
  await page.waitForTimeout(250);
  expect(
    await canvasTitle.evaluate(
      (el) =>
        (el.ownerDocument.defaultView as { __astroixCanvasLoadedAt?: number })
          .__astroixCanvasLoadedAt,
    ),
  ).toBeDefined();
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
