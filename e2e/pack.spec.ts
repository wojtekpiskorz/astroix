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
  // structurally impossible here (the tarball ships no src/client) — pinned
  // on the discriminator too, so every lane asserts its delivery mode (#150)
  await expect(page.locator('#astroix-root')).toHaveAttribute(
    'data-astroix-chrome-mode',
    'prebuilt',
  );
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

// #166: every push flow in the shipped artifact was silently dead — the
// chrome's hot-channel subscriptions and its `astroix:chrome` announce were
// dead-code-eliminated from the lib bundle, so this lane (the only one
// booting the exact tarball) asserted boot and a write loop but never a
// push. The hot→window bridge in the virtual chrome module rebuilt those
// flows on window CustomEvents; these specs pin both halves so the hole can
// never silently reopen.
test.describe('#166 push flows in the prebuilt chrome', () => {
  const PACK_CSS = join(FIXTURE, 'src', 'pages', 'pack.css');
  const PACK_PAGE = join(FIXTURE, 'src', 'pages', 'index.astro');

  // the source lane's live-refresh twin (live-refresh.spec.ts), run against
  // the exact shipped artifact: an external fixture edit must cross the
  // hot→window bridge inside dist/chrome.js and replace the open editor doc
  test('external edit reflects live in the prebuilt chrome editor', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await page.getByText('Select: off').click();
    await page.frameLocator('#astroix-canvas').locator('.hero-title').click();
    await page.locator('[data-astroix-rule]', { hasText: 'pack.css' }).first().click();
    const editor = page.locator('[data-astroix-editor="view"]');
    await expect(editor.locator('.cm-content')).toContainText('font-weight: 800');

    const original = readFileSync(PACK_CSS, 'utf8');
    try {
      // simulate the IDE: external write to the file the editor is showing
      writeFileSync(PACK_CSS, original.replace('font-weight: 800;', 'font-weight: 700;'));
      await expect(editor.locator('.cm-content')).toContainText('font-weight: 700;', {
        timeout: 10_000,
      });
      // accepted as external truth, not scheduled as a pending local write
      await expect(editor.locator('[data-astroix-write-status]')).toHaveAttribute(
        'data-astroix-write-status',
        'idle',
      );
    } finally {
      writeFileSync(PACK_CSS, original);
    }
  });

  // the announce's whole job (spec #13/#74): the shield must know the chrome
  // before Astro's next broadcast `full-reload`, or every canvas reload takes
  // the stateful chrome with it. Proof in two halves: the announce leaves the
  // prebuilt chrome on the hot WebSocket, and a broadcast full-reload (an
  // external page edit vite cannot hot-update) then reloads the canvas while
  // the chrome document survives it.
  test('the announce arms the reload shield: a full-reload broadcast spares the chrome', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const customFrames: string[] = [];
    page.on('websocket', (ws) => {
      ws.on('framesent', (frame) => {
        if (typeof frame.payload === 'string' && frame.payload.includes('astroix')) {
          customFrames.push(frame.payload);
        }
      });
    });

    await page.goto('/');
    await expect(page.locator('#astroix-root')).toHaveAttribute(
      'data-astroix-chrome-mode',
      'prebuilt',
    );
    await expect(page.getByText('Select: off')).toBeVisible({ timeout: 15_000 });
    // wire proof: the announce left the prebuilt chrome on the hot channel
    // (the reload shield's channel listener is its only consumer)
    await expect
      .poll(() => customFrames.join('\n'), { timeout: 10_000 })
      .toContain('"astroix:chrome"');

    // a document-scope marker: a chrome reload destroys it, a spared chrome
    // keeps it — the discriminator the shield assertion turns on
    await page.evaluate(() => {
      (window as { __astroixShieldProbe?: string }).__astroixShieldProbe = 'alive';
    });

    const original = readFileSync(PACK_PAGE, 'utf8');
    try {
      // external page edit: vite has no accepting boundary for it, so the
      // dev server broadcasts `full-reload` to every connected client
      writeFileSync(PACK_PAGE, original.replace('Pack smoke', 'Pack reloaded'));
      const canvas = page.frameLocator('#astroix-canvas');
      // the broadcast happened and was not swallowed for everyone: the
      // canvas (an unannounced client) reloaded onto the edited page
      await expect(canvas.locator('.hero-title')).toHaveText('Pack reloaded', {
        timeout: 15_000,
      });
      // the same broadcast must NOT have reloaded the chrome: the marker
      // survived past the canvas's reload settling
      await page.waitForTimeout(1_000);
      expect(
        await page.evaluate(
          () => (window as { __astroixShieldProbe?: string }).__astroixShieldProbe,
        ),
      ).toBe('alive');
    } finally {
      writeFileSync(PACK_PAGE, original);
    }
  });
});
