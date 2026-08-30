import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// #119's invalidation contract, pinned end-to-end: a content change must
// reach `renders` without a restart. The chain the spec walks: the srcDir
// file event re-arms the debounced enumeration pass (fresh module runner —
// the shared runner's cached bindings never see content commits), and
// because the pass races the loader's data commit, follow-up passes re-read
// until the `renders` delta lands. Advisory review on PR #126 challenged
// exactly this — a permanently-stale marker on a newly-added entry — so the
// spec asserts the payload truth against the live fixture, both directions
// (add and remove). The chrome-side half lives in the second test (#133):
// the same external edit must live-refresh the Content sidebar — the
// `astroix:content-synced` push (srcDir signal + the loader's post-commit
// data-store write; the loader leg's invalidation sequenced on the
// canvas's next load, #155) invalidates the chrome's collections cache
// without a reload or a tab roundtrip; astro's own content event rides the
// ssr hot channel and never reaches the client chrome.

interface RouteInfo {
  pattern: string;
  renders?: string[];
}

async function catchAllRenders(page: import('@playwright/test').Page): Promise<string[] | null> {
  const routes = (await (await page.request.get('/__astroix/routes')).json()) as RouteInfo[];
  return routes.find((route) => route.pattern === '/blog/[...slug]')?.renders ?? null;
}

test('a content change re-enumerates renders without a restart — add and remove converge', async ({
  page,
}) => {
  const entryPath = join('e2e', 'fixture', 'src', 'content', 'blog', 'new-entry.md');
  if (existsSync(entryPath)) {
    throw new Error('stale probe entry already on disk — restore it before re-running');
  }

  await page.goto('/');
  try {
    writeFileSync(
      entryPath,
      `---\ntitle: Enumeration probe\ndate: 2026-08-30\n---\n\nA body for the enumeration probe.\n`,
    );
    await expect
      .poll(() => catchAllRenders(page), {
        timeout: 20_000,
        message: 'content add never re-enumerated the catch-all renders',
      })
      .toContain('new-entry');
  } finally {
    rmSync(entryPath, { force: true });
  }

  // the unlink is the same signal class — the payload converges back, and
  // the collections payload with it (later specs pin exact entry lists, so
  // the fixture must be fully restored before the suite proceeds)
  await expect
    .poll(() => catchAllRenders(page), {
      timeout: 20_000,
      message: 'content removal never re-enumerated the catch-all renders',
    })
    .not.toContain('new-entry');
  await expect
    .poll(
      async () => {
        const collections = (await (
          await page.request.get('/__astroix/collections')
        ).json()) as Array<{ name: string; entries: Array<{ id: string }> }>;
        return (
          collections.find((collection) => collection.name === 'blog')?.entries.map((e) => e.id) ??
          null
        );
      },
      { timeout: 20_000, message: 'collections payload never dropped the removed entry' },
    )
    .toEqual(['2024/post', '2025/release-notes', 'hello-builder']);
});

// #133's live-refresh contract: the chrome's collections list picks up an
// external content edit with no reload and no tab roundtrip. The signal
// chain: the srcDir file event pushes immediately (pre-commit — the loader's
// store write is debounced 500 ms), then the data-store write itself fires
// the post-commit push whose invalidation waits out the canvas's full-reload
// load before refetching (#155) — the poll budget must cover both legs plus
// the loader sync and the reload render.
test('an external content edit live-refreshes the chrome collections list — add and remove', async ({
  page,
}) => {
  const entryPath = join('e2e', 'fixture', 'src', 'content', 'blog', 'new-entry.md');
  if (existsSync(entryPath)) {
    throw new Error('stale probe entry already on disk — restore it before re-running');
  }

  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  const blog = page.locator('[data-astroix-collection="blog"]');
  await expect(blog.locator('[data-astroix-entry="hello-builder"]')).toBeVisible();

  const probe = page.locator('[data-astroix-entry="new-entry"]');
  try {
    writeFileSync(
      entryPath,
      `---\ntitle: Enumeration probe\ndate: 2026-08-30\n---\n\nA body for the enumeration probe.\n`,
    );
    // no reload, no remount — the pushed invalidation is the only refresh
    // path this assertion allows
    await expect(probe, 'external add never live-refreshed the sidebar').toBeVisible({
      timeout: 20_000,
    });
  } finally {
    rmSync(entryPath, { force: true });
  }

  await expect(probe, 'external removal never live-refreshed the sidebar').toHaveCount(0, {
    timeout: 20_000,
  });
  // the fixture must be fully restored before the suite proceeds
  await expect(blog.locator('[data-astroix-entry]')).toHaveCount(3);
});
