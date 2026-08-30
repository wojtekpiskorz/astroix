import { expect, test } from '@playwright/test';
import type { CollectionRecord } from '../src/core/collections';

interface RouteSegmentPart {
  content: string;
  dynamic: boolean;
  spread: boolean;
}

/** The RouteInfo contract served by `GET /__astroix/routes` (src/core/route-resolver). */
interface RouteInfo {
  pattern: string;
  segments: RouteSegmentPart[][];
  params: string[];
  rendering: 'prerendered' | 'on-demand';
  renders?: string[];
}

async function getCollections(page: import('@playwright/test').Page): Promise<CollectionRecord[]> {
  // Boot race: content sync can land after the server starts listening —
  // poll until the blog collection is fully in the store.
  await expect
    .poll(
      async () => {
        const response = await page.request.get('/__astroix/collections');
        const payload = (await response.json()) as CollectionRecord[];
        return payload.find((collection) => collection.name === 'blog')?.entries.length ?? 0;
      },
      { timeout: 10_000, message: 'collections payload never filled up (blog × 3 entries)' },
    )
    .toBeGreaterThanOrEqual(3);
  const response = await page.request.get('/__astroix/collections');
  return (await response.json()) as CollectionRecord[];
}

test('GET /__astroix/collections serves core-parsed entries with schema presence', async ({
  page,
}) => {
  const payload = await getCollections(page);

  expect(payload.map((collection) => collection.name)).toEqual([
    'blog',
    'gallery',
    'homepage',
    'notes',
  ]);
  expect(payload.find((c) => c.name === 'blog')?.hasSchema).toBe(true);
  expect(payload.find((c) => c.name === 'homepage')?.hasSchema).toBe(true);
  expect(payload.find((c) => c.name === 'notes')?.hasSchema).toBe(false);
  expect(payload.find((c) => c.name === 'gallery')?.hasSchema).toBe(true);

  const blog = payload.find((collection) => collection.name === 'blog');
  // ids are slugified source paths — nested files keep the nested-path id
  expect(blog?.entries.map((entry) => entry.id)).toEqual([
    '2024/post',
    '2025/release-notes',
    'hello-builder',
  ]);

  const nested = blog?.entries.find((entry) => entry.id === '2024/post');
  expect(nested?.filePath).toBe('src/content/blog/2024/post.md');
  // zod output carries the #72 schema additions' defaults
  expect(nested?.data).toEqual({
    title: 'Nested post',
    date: '2024-06-01T00:00:00.000Z',
    tags: ['nested'],
    tone: 'bold',
    priority: 0,
    featured: false,
  });
  expect(nested?.body).toContain('for route resolution');

  const homepage = payload.find((collection) => collection.name === 'homepage');
  expect(homepage?.entries).toHaveLength(1);
  expect(homepage?.entries[0]?.id).toBe('index');
  // the payload's `data` is the schema's zod output — unknown to the contract
  const homepageData = homepage?.entries[0]?.data as { lead?: string } | undefined;
  expect(homepageData?.lead).toBe('A synthetic Astro 7 project exercising the builder e2e loop.');
});

test('raw entry loading reuses GET /__astroix/file on the payload filePath', async ({ page }) => {
  const payload = await getCollections(page);
  const nested = payload
    .find((collection) => collection.name === 'blog')
    ?.entries.find((entry) => entry.id === '2024/post');
  if (nested?.filePath === undefined || nested.filePath === null) {
    throw new Error('nested entry has no filePath');
  }

  const response = await page.request.get(`/__astroix/file`, {
    params: { file: nested.filePath },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { file: string; contents: string };
  expect(body.file).toBe(nested.filePath);
  expect(body.contents).toContain('title: Nested post');
});

test('GET /__astroix/routes serves the hook-captured route array', async ({ page }) => {
  // Routes come from the astro:routes:resolved hook (boot-time here); the
  // payload exists as soon as the server does.
  const routes = (await (await page.request.get('/__astroix/routes')).json()) as RouteInfo[];

  const home = routes.find((route) => route.pattern === '/');
  expect(home?.params).toEqual([]);

  // The resolver contract (#77): Astro's own segments parse travels with the
  // pattern — the rest param carrying nested glob-loader ids.
  const blog = routes.find((route) => route.pattern === '/blog/[...slug]');
  expect(blog?.params).toEqual(['...slug']);
  expect(blog?.segments).toEqual([
    [{ content: 'blog', dynamic: false, spread: false }],
    [{ content: '...slug', dynamic: true, spread: true }],
  ]);

  // Astro-core internal routes stay out of the payload (#109): the dev
  // server-islands route is a same-shape candidate that would navigate to a 404
  expect(routes.some((route) => route.pattern.startsWith('/_server-islands'))).toBe(false);
});

test('GET /__astroix/routes carries rendering mode and the getStaticPaths enumeration (#119)', async ({
  page,
}) => {
  // `rendering` is the hook's synchronous projection — served on the first
  // request, never waiting for the background pass (static-output fixture:
  // every page prerendered by default)
  const routes = (await (await page.request.get('/__astroix/routes')).json()) as RouteInfo[];
  expect(routes.find((route) => route.pattern === '/')?.rendering).toBe('prerendered');
  expect(routes.find((route) => route.pattern === '/blog/[slug]')?.rendering).toBe('prerendered');

  // `renders` is the background enumeration (debounced, ms-scale here) —
  // poll until the pass lands on the payload
  await expect
    .poll(
      async () => {
        const payload = (await (await page.request.get('/__astroix/routes')).json()) as RouteInfo[];
        return payload.find((route) => route.pattern === '/blog/[slug]')?.renders ?? null;
      },
      { timeout: 10_000, message: 'enumeration never landed on /blog/[slug]' },
    )
    .toEqual(['hello-builder']);

  const payload = (await (await page.request.get('/__astroix/routes')).json()) as RouteInfo[];
  // the catch-all renders every blog id, nested included — order is the
  // collection's, membership is the contract
  const catchAll = payload.find((route) => route.pattern === '/blog/[...slug]');
  expect(catchAll?.renders).toHaveLength(3);
  expect(new Set(catchAll?.renders)).toEqual(
    new Set(['hello-builder', '2024/post', '2025/release-notes']),
  );
  // static routes are not the `renders` space — the field stays absent
  expect(payload.find((route) => route.pattern === '/')?.renders).toBeUndefined();
});

test('the fixture dynamic route renders a nested-id entry through the chrome canvas', async ({
  page,
}) => {
  await page.goto('/blog/2024/post');
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.blog-title')).toHaveText('Nested post');
  await expect(canvas.locator('.blog-body')).toContainText('for route resolution');
});
