import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { PACK_PORT } from './ports';
import { settleWrites } from './settle-writes';

/**
 * npm-pack smoke lane (ADR-0001): the exact shipped artifact, not the
 * `file:`-linked checkout. The second playwright webServer packs the repo,
 * installs the tarball into the pack fixture and boots it (canonical :4313,
 * per-lane override via the shared ports module — #120). Catches
 * `files`/`exports`/package-shape regressions source mode can never see.
 */
// This file drives the pack lane's server, not the config-wide baseURL
// (that one belongs to the main fixture) — same ports module either way.
test.use({ baseURL: `http://localhost:${PACK_PORT}` });
const FIXTURE = join('e2e', 'pack-fixture');

test('chrome loads from the shipped artifact (prebuilt mode)', async ({ page }) => {
  const chromeSourceRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/src/client')) chromeSourceRequests.push(request.url());
  });

  await page.goto('/');
  // the chrome mounting at all proves the artifact executed; source mode is
  // structurally impossible here (the tarball ships no src/client)
  await expect(page.getByText('Select: off')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#astroix-canvas')).toBeVisible();
  await expect(page.frameLocator('#astroix-canvas').locator('.hero-title')).toHaveText(
    'Pack smoke',
  );

  expect(chromeSourceRequests).toEqual([]);
});

test('minimal loop against the artifact: select → list → edit → canvas reflects', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.hero-title')).toHaveCSS('color', 'rgb(30, 41, 59)');

  await page.getByText('Select: off').click();
  await canvas.locator('.hero-title').click();
  await expect(page.locator('[data-astroix-selection]')).toContainText('hero-title');

  // scoped winner + the global rule from pack.css
  const rules = page.locator('[data-astroix-rule]');
  await expect(rules).toHaveCount(2);
  await expect(page.locator('[data-astroix-winner="true"]')).toHaveCount(1);
  await expect(rules.first()).toContainText('index.astro');

  await page.locator('[data-astroix-winner="true"]').click();
  const editor = page.locator('[data-astroix-editor="view"]');
  await expect(editor.locator('.cm-content')).toBeVisible();

  const filePath = join(FIXTURE, 'src', 'pages', 'index.astro');
  const original = readFileSync(filePath, 'utf8');
  try {
    await editor.locator('.cm-content').evaluate((el) => {
      const view = (el.closest('.cm-editor') as (HTMLElement & { __astroixView?: unknown }) | null)
        ?.__astroixView as {
        state: { doc: { toString: () => string } };
        dispatch: (spec: { changes: { from: number; to: number; insert: string } }) => void;
      };
      if (view === undefined) throw new Error('editor view not stashed');
      const from = view.state.doc.toString().indexOf('#1e293b');
      view.dispatch({ changes: { from, to: from + '#1e293b'.length, insert: '#b91c1c' } });
    });

    await expect(editor.locator('[data-astroix-write-status]')).toHaveAttribute(
      'data-astroix-write-status',
      'saved',
      { timeout: 5_000 },
    );
    const at = original.indexOf('#1e293b');
    expect(readFileSync(filePath, 'utf8')).toBe(
      `${original.slice(0, at)}#b91c1c${original.slice(at + '#1e293b'.length)}`,
    );
    await expect(canvas.locator('.hero-title')).toHaveCSS('color', 'rgb(185, 28, 28)', {
      timeout: 10_000,
    });
  } finally {
    // #128: the rule editor carries the same armed-debounce/echo-re-arm
    // window as the content loop (#114) — a bare writeFileSync could be
    // overtaken by a late splice with no later restore on this tracked page.
    // The settle oracle is the page alone: the pack fixture has no content
    // collections, so no data-store mirrors the write to watch.
    await settleWrites([filePath]);
    writeFileSync(filePath, original);
  }
});
