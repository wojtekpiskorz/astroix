import { expect, test } from '@playwright/test';

// The navigation bridge (#71, #109): reactive selection canvas→entry (route
// resolution over the canvas URL, reported on every iframe load), entry→canvas
// reverse navigation on a benign route plurality (candidates that all render
// the clicked entry, most specific first) verified by forward match, and
// ambiguity = silence — the form opens, the canvas stays put.

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

  // the list: collections → entries (entry id as the key, basename as the label, #111)
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
  const pane = page.locator('[data-astroix-content-pane="form"]');
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
  await expect(page.locator('[data-astroix-content-pane="form"] code')).toHaveText(
    'blog/2024/post',
  );

  // a plain navigation away resolves silent (static home) — the selection clears
  await navigateCanvas(page, '/');
  await expect(canvas.locator('.hero-title')).toBeVisible();
  await expect(page.locator('[data-astroix-entries="ready"] [data-active="true"]')).toHaveCount(0);
  await expect(page.locator('[data-astroix-content-pane="empty"]')).toBeVisible();
});

test('entry→canvas: a benign route plurality navigates and the forward match reselects', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible();

  // hello-builder fills both /blog/[slug] and /blog/[...slug] — two patterns
  // rendering the same entry (#109's benign plurality): the click navigates
  // through the segment-param spelling
  await page.locator('[data-astroix-entry="hello-builder"]').click();
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.blog-title')).toHaveText('Hello builder');
  const pathname = await page
    .locator('#astroix-canvas')
    .evaluate((frame: HTMLIFrameElement) => frame.contentWindow?.location.pathname);
  expect(pathname).toBe('/blog/hello-builder');

  // the post-navigation forward match reselects the same entry
  const entry = page.locator('[data-astroix-entry="hello-builder"]');
  await expect(entry).toHaveAttribute('data-active', 'true');
  await expect(page.locator('[data-astroix-content-pane="form"] code')).toHaveText(
    'blog/hello-builder',
  );
});

test('ambiguity is silence: an id held by two collections opens the form without navigating', async ({
  page,
}) => {
  await page.goto('/');
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.hero-title')).toBeVisible();

  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible();

  // `index` lives in homepage and notes (the two-collection holder fixture)
  // — the shared-id class stays silent
  const entry = page.locator('[data-astroix-collection="homepage"] [data-astroix-entry="index"]');
  await entry.click();
  await expect(entry).toHaveAttribute('data-active', 'true');

  // the canvas never left the home page
  await expect(canvas.locator('.hero-title')).toBeVisible();
  await expect(canvas.locator('.blog-title')).toHaveCount(0);
});

test('a form-only pick survives a tab roundtrip — no navigation, no re-resolution', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible();

  // the two-collection-holder entry opens form-only (no navigation happened)
  const entry = page.locator('[data-astroix-collection="homepage"] [data-astroix-entry="index"]');
  await entry.click();
  await expect(entry).toHaveAttribute('data-active', 'true');

  // a tab roundtrip unmounts and remounts the tracker, but the canvas URL
  // never changed — no load fired, so the manual pick must survive it
  await page.getByRole('tab', { name: 'CSS' }).click();
  await expect(page.locator('[data-astroix-index="ready"]')).toBeVisible();
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(entry).toHaveAttribute('data-active', 'true');
  await expect(page.locator('[data-astroix-content-pane="form"] code')).toHaveText(
    'homepage/index',
  );
});

test('re-clicking the entry the canvas already shows consumes the arm on the reload', async ({
  page,
}) => {
  await page.goto('/blog/2024/post');
  await page.getByRole('tab', { name: 'Content' }).click();
  const entry = page.locator('[data-astroix-entry="2024/post"]');
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible();
  await expect(entry).toHaveAttribute('data-active', 'true');

  // the click navigates to the URL the canvas already shows — the reload is
  // a new load (bumped seq), its forward match re-verifies the same entry
  await entry.click();
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.blog-title')).toHaveText('Nested post');
  await expect(entry).toHaveAttribute('data-active', 'true');

  // the arm was consumed by that reload — the next plain navigation adopts
  // freely instead of being eaten by a stale arm
  await navigateCanvas(page, '/');
  await expect(canvas.locator('.hero-title')).toBeVisible();
  await expect(page.locator('[data-astroix-entries="ready"] [data-active="true"]')).toHaveCount(0);
});

// --- #111: the tree sidebar ---

test('nested ids render as folders with basename labels, flat ids stay bare', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible();

  // each '/'-prefix of a nested id is a folder, open by default — the tree
  // must never hide an entry from a click that used to work flat
  const folder2024 = page.locator('[data-astroix-tree-folder="blog/2024"]');
  const folder2025 = page.locator('[data-astroix-tree-folder="blog/2025"]');
  await expect(folder2024).toBeVisible();
  await expect(folder2024).toHaveAttribute('aria-expanded', 'true');
  await expect(folder2025).toHaveAttribute('aria-expanded', 'true');
  await expect(folder2024).toHaveText('2024');

  // entries stay full-id keyed (the click contract) but show the basename
  await expect(page.locator('[data-astroix-entry="2024/post"]')).toHaveText('post');
  await expect(page.locator('[data-astroix-entry="2025/release-notes"]')).toHaveText(
    'release-notes',
  );
  await expect(page.locator('[data-astroix-collection="blog"] [data-astroix-entry]')).toHaveCount(
    3,
  );

  // a flat collection renders no wrapper folder — the id is the label
  await expect(
    page.locator('[data-astroix-collection="homepage"] [data-astroix-tree-folder]'),
  ).toHaveCount(0);
  await expect(page.locator('[data-astroix-entry="index"]')).toHaveText('index');
  await expect(page.locator('[data-astroix-entry="hello-builder"]')).toHaveText('hello-builder');
});

test('folders collapse on toggle and the choice survives a tab roundtrip', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible();

  // collapsing unmounts the folder's entries
  const folder2024 = page.locator('[data-astroix-tree-folder="blog/2024"]');
  await folder2024.click();
  await expect(folder2024).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-astroix-entry="2024/post"]')).toHaveCount(0);

  // the sibling folder is untouched
  await expect(page.locator('[data-astroix-tree-folder="blog/2025"]')).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.locator('[data-astroix-entry="2025/release-notes"]')).toBeVisible();

  // the collapsed set lives in the content store — a tab roundtrip keeps it
  await page.getByRole('tab', { name: 'CSS' }).click();
  await expect(page.locator('[data-astroix-index="ready"]')).toBeVisible();
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-tree-folder="blog/2024"]')).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.locator('[data-astroix-entry="2024/post"]')).toHaveCount(0);

  // and re-expands
  await page.locator('[data-astroix-tree-folder="blog/2024"]').click();
  await expect(page.locator('[data-astroix-entry="2024/post"]')).toBeVisible();
});

// The marker's ruled semantics: zero candidate routes → dimmed marker
// (#111, grilling Q4). Against the real fixture payload NO entry qualifies —
// every flat id fills /blog/[slug], /blog/[...slug] and /_server-islands/[name]
// (3 candidates), so the silence of showcase/scratch/index clicks is
// ambiguity, not unroutedness. The ticket's "marker on showcase, scratch,
// index" expectation does not hold against the shipped fixture; surfaced to
// the owner on the PR — this spec pins the real behavior instead.
test('no fixture entry has zero candidate routes — the marker stays absent', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible();

  await expect(page.locator('[data-astroix-entry-unrouted]')).toHaveCount(0);
});

// Marker mechanics under a controlled routes payload: intercepting the
// sidebar's own query input (the fetch is real, the payload is ours) makes
// every entry zero-candidate — the marker renders, explains itself, and
// disables nothing. The tree, store, and click path all stay live.
test('zero-candidate entries carry the marker and stay fully openable', async ({ page }) => {
  await page.route('**/__astroix/routes', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible();

  // every entry is unrouted against an empty route set
  for (const id of ['showcase', 'scratch', 'index', 'hello-builder', '2024/post']) {
    const entry = page.locator(`[data-astroix-entry="${id}"]`);
    await expect(entry).toHaveAttribute('data-astroix-entry-unrouted', 'true');
    await expect(entry).toHaveAttribute('title', 'no route renders this entry');
  }

  // the marker never disables: the entry opens its form, and with zero
  // candidates the click navigates nowhere — the canvas stays home
  await page.locator('[data-astroix-entry="showcase"]').click();
  await expect(page.locator('[data-astroix-entry="showcase"]')).toHaveAttribute(
    'data-active',
    'true',
  );
  await expect(page.locator('[data-astroix-content-pane="form"] code')).toHaveText(
    'gallery/showcase',
  );
  await expect(page.frameLocator('#astroix-canvas').locator('.hero-title')).toBeVisible();
});
