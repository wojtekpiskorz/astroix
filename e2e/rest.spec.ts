import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// Serial: the edit test rewrites a fixture source file on disk and restores it.
test.describe.configure({ mode: 'serial' });

interface PayloadRecord {
  selector: string;
  file: string;
  range: { start: number; end: number };
  media: string | null;
  scoped: boolean;
  styleBlockIndex: number | null;
  effectiveSelector: string | null;
}

test('GET /__astroix/index serves the payload with module-graph effective selectors', async ({
  page,
}) => {
  // Load the page first: the scoped style module enters the client module
  // graph only once a document has requested it (cold graph → null, by design).
  await page.goto('/');
  const canvas = page.frameLocator('#astroix-canvas');
  const cid = await canvas.locator('.hero-title').evaluate((el) => {
    const name = el
      .getAttributeNames()
      .find((attribute) => attribute.startsWith('data-astro-cid-'));
    return name?.slice('data-astro-cid-'.length) ?? null;
  });
  expect(cid).toBeTruthy();

  let scoped: PayloadRecord[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const payload = (await (await page.request.get('/__astroix/index')).json()) as PayloadRecord[];

    if (attempt === 0) {
      // global rules from home.css, including the @media place
      const global = payload.filter((r) => r.file === 'src/pages/home.css');
      expect(global.map((r) => r.selector)).toEqual([
        '.hero',
        '.hero-title',
        '.hero-title',
        '.hero-title',
        '.hero-lead',
        '.hero-cta',
      ]);
      expect(global.filter((r) => r.media === '(max-width: 640px)')).toHaveLength(1);
    }

    scoped = payload.filter((r) => r.scoped && r.selector === '.hero-title');
    if (scoped[0]?.effectiveSelector) break;
    await page.waitForTimeout(250);
  }

  expect(scoped).toHaveLength(1);
  expect(scoped[0]?.file).toBe('src/pages/index.astro');
  expect(scoped[0]?.styleBlockIndex).toBe(0);
  expect(scoped[0]?.effectiveSelector).toMatch(/\.hero-title\[data-astro-cid-[a-z0-9]+\]/);
  expect(scoped[0]?.effectiveSelector).toContain(`data-astro-cid-${cid}`);
});

test('POST /__astroix/edit splices bytes on disk and host HMR picks it up', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto('/');
  const canvas = page.frameLocator('#astroix-canvas');
  // 600px viewport: the @media rule is active (2rem = 32px).
  await expect(canvas.locator('.hero-title')).toHaveCSS('font-size', '32px');

  const payload = (await (await page.request.get('/__astroix/index')).json()) as PayloadRecord[];
  const mediaRule = payload.find(
    (r) => r.file === 'src/pages/home.css' && r.media === '(max-width: 640px)',
  );
  if (mediaRule === undefined) throw new Error('media rule missing from the index payload');

  const filePath = join('e2e', 'fixture', 'src', 'pages', 'home.css');
  const original = readFileSync(filePath, 'utf8');
  const windowText = original.slice(mediaRule.range.start, mediaRule.range.end);
  expect(windowText).toContain('2rem');
  const at = mediaRule.range.start + windowText.indexOf('2rem');

  try {
    const edit = await page.request.post('/__astroix/edit', {
      data: {
        file: 'src/pages/home.css',
        range: { start: at, end: at + '2rem'.length },
        replacement: '2.25rem',
      },
    });
    expect(edit.status()).toBe(200);
    expect(await edit.json()).toEqual({ ok: true });

    // bytes: exactly one change on disk, computed over the same window
    expect(readFileSync(filePath, 'utf8')).toBe(
      `${original.slice(0, at)}2.25rem${original.slice(at + '2rem'.length)}`,
    );

    // host HMR reflects in the canvas without a reload
    await expect(canvas.locator('.hero-title')).toHaveCSS('font-size', '36px', { timeout: 10_000 });
  } finally {
    writeFileSync(filePath, original);
  }
});

test('POST /__astroix/edit rejects invalid ranges without touching the file', async ({ page }) => {
  const response = await page.request.post('/__astroix/edit', {
    data: { file: 'src/pages/home.css', range: { start: 0, end: 10_000_000 }, replacement: 'x' },
  });
  expect(response.status()).toBe(400);
  const body = (await response.json()) as { error?: string };
  expect(body.error).toContain('Invalid splice range');
});

test('POST /__astroix/edit rejects paths outside the project root', async ({ page }) => {
  const response = await page.request.post('/__astroix/edit', {
    data: { file: '../outside.css', range: { start: 0, end: 1 }, replacement: 'x' },
  });
  expect(response.status()).toBe(400);
});
