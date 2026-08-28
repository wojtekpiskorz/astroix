import { expect, test } from '@playwright/test';

interface CollectionEntryRecord {
  id: string;
  filePath: string | null;
  data: Record<string, unknown>;
  body: string | null;
}

interface CollectionRecord {
  name: string;
  hasSchema: boolean;
  entries: CollectionEntryRecord[];
}

interface RouteRecord {
  pattern: string;
  entrypoint: string;
  params: string[];
  type: string;
  isPrerendered: boolean;
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

  expect(payload.map((collection) => collection.name)).toEqual(['blog', 'homepage']);
  expect(payload.every((collection) => collection.hasSchema)).toBe(true);

  const blog = payload.find((collection) => collection.name === 'blog');
  // ids are slugified source paths — nested files keep the nested-path id
  expect(blog?.entries.map((entry) => entry.id)).toEqual([
    '2024/post',
    '2025/release-notes',
    'hello-builder',
  ]);

  const nested = blog?.entries.find((entry) => entry.id === '2024/post');
  expect(nested?.filePath).toBe('src/content/blog/2024/post.md');
  expect(nested?.data).toEqual({
    title: 'Nested post',
    date: '2024-06-01T00:00:00.000Z',
    tags: ['nested'],
  });
  expect(nested?.body).toContain('route-resolution substrate');

  const homepage = payload.find((collection) => collection.name === 'homepage');
  expect(homepage?.entries).toHaveLength(1);
  expect(homepage?.entries[0]?.id).toBe('index');
  expect(homepage?.entries[0]?.data.lead).toBe(
    'A synthetic Astro 7 project exercising the builder e2e loop.',
  );
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
  const routes = (await (await page.request.get('/__astroix/routes')).json()) as RouteRecord[];

  const home = routes.find((route) => route.pattern === '/');
  expect(home?.entrypoint).toBe('src/pages/index.astro');
  expect(home?.params).toEqual([]);
  expect(home?.type).toBe('page');
  expect(home?.isPrerendered).toBe(true);

  const blog = routes.find((route) => route.pattern === '/blog/[...slug]');
  expect(blog?.entrypoint).toBe('src/pages/blog/[...slug].astro');
  expect(blog?.params).toEqual(['...slug']);
});

test('the fixture dynamic route renders a nested-id entry through the chrome canvas', async ({
  page,
}) => {
  await page.goto('/blog/2024/post');
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.blog-title')).toHaveText('Nested post');
  await expect(canvas.locator('.blog-body')).toContainText('route-resolution substrate');
});
