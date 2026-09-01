import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { ORACLE_MAIN } from './oracle.mjs';

// #119's invalidation contract, pinned end-to-end: a content change must
// reach `renders` without a restart. The chain the spec walks: the srcDir
// file event re-arms the debounced enumeration pass (fresh module runner —
// the shared runner's cached bindings never see content commits), and
// because the pass races the loader's data commit, follow-up passes re-read
// until the `renders` delta lands. Advisory review on PR #126 challenged
// exactly this — a permanently-stale marker on a newly-added entry — so the
// spec asserts the payload truth against the live fixture, both directions
// (add and remove). The chrome-side half — the same external edit
// live-refreshing the Content sidebar through the `astroix:content-synced`
// push — moved to live-refresh.spec.ts on the source lane (#150): the push
// rides the vite hot channel, which the prebuilt chrome this lane boots
// cannot subscribe to (#166).

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
  const entryPath = join(ORACLE_MAIN, 'src', 'content', 'blog', 'new-entry.md');
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
