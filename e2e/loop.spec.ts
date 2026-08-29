import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The POC definition of done, executable: the whole CSS editing loop in one
 * deterministic test — builder (default-on) → select mode → rule list →
 * CodeMirror edit → bytes on disk + canvas reflection via HMR. Piecewise
 * behavior lives in the other specs; this vertical is the contract.
 */
test('the full CSS editing loop', async ({ page }) => {
  test.setTimeout(60_000);

  // 1. builder chrome is default-on; the canvas shows the live page
  await page.goto('/');
  await expect(page.locator('#astroix-root')).toBeVisible();
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.hero-title')).toHaveText('Astroix fixture');
  await expect(canvas.locator('.hero-title')).toHaveCSS('color', 'rgb(30, 41, 59)');

  // 2. select mode: hover outline, click selects
  await page.getByText('Select: off').click();
  await expect(page.getByText('Select: on')).toBeVisible();
  await canvas.locator('.hero-title').hover();
  await expect(canvas.locator('.hero-title')).toHaveClass(/astroix-hover/);
  await canvas.locator('.hero-title').click();
  await expect(page.locator('[data-astroix-selection]')).toContainText('hero-title');

  // 3. rule list: scoped winner (hash hidden) + ≥2 global + @media badge
  const rules = page.locator('[data-astroix-rule]');
  await expect(rules).toHaveCount(4);
  const panelText = await page.locator('[data-astroix-rules]').innerText();
  expect(panelText).not.toContain('data-astro-cid');
  expect(panelText.split('home.css').length - 1).toBeGreaterThanOrEqual(2);
  await expect(page.locator('[data-astroix-media="(max-width: 640px)"]')).toHaveCount(1);
  await expect(page.locator('[data-astroix-winner="true"]')).toHaveCount(1);
  await expect(rules.first()).toContainText('index.astro');

  // 4. winner click → editor at the range, highlighted
  await page.locator('[data-astroix-winner="true"]').click();
  const editor = page.locator('[data-astroix-editor="view"]');
  await expect(editor).toContainText('index.astro');
  await expect(editor.locator('.astroix-rule-highlight').first()).toBeVisible();

  // 5. raw-text edit: the canvas must NOT reload (HMR, not refresh)
  const filePath = join('e2e', 'fixture', 'src', 'pages', 'index.astro');
  const original = readFileSync(filePath, 'utf8');
  await canvas.locator('.hero-title').evaluate((el) => {
    (el.ownerDocument.defaultView as { __astroixLoopMarker?: number }).__astroixLoopMarker =
      performance.now();
  });
  try {
    await editor.locator('.cm-content').evaluate((el) => {
      const view = (el.closest('.cm-editor') as (HTMLElement & { __astroixView?: unknown }) | null)
        ?.__astroixView as {
        state: { doc: { toString: () => string } };
        dispatch: (spec: { changes: { from: number; to: number; insert: string } }) => void;
      };
      if (view === undefined) throw new Error('editor view not stashed');
      const from = view.state.doc.toString().indexOf('#1e293b');
      if (from === -1) throw new Error('scoped color not found');
      view.dispatch({ changes: { from, to: from + '#1e293b'.length, insert: '#b91c1c' } });
    });

    // 6. debounce (~300 ms) → written through the splice endpoint
    await expect(editor.locator('[data-astroix-write-status]')).toHaveAttribute(
      'data-astroix-write-status',
      'saved',
      { timeout: 5_000 },
    );

    // 7. bytes on disk: exactly one range changed
    const at = original.indexOf('#1e293b');
    const expected = `${original.slice(0, at)}#b91c1c${original.slice(at + '#1e293b'.length)}`;
    expect(readFileSync(filePath, 'utf8')).toBe(expected);

    // 8. canvas reflects via HMR — no document reload
    await expect(canvas.locator('.hero-title')).toHaveCSS('color', 'rgb(185, 28, 28)', {
      timeout: 10_000,
    });
    const marker = await canvas
      .locator('.hero-title')
      .evaluate(
        (el) =>
          (el.ownerDocument.defaultView as { __astroixLoopMarker?: number }).__astroixLoopMarker,
      );
    expect(marker).toBeDefined();
  } finally {
    writeFileSync(filePath, original);
  }

  // 9. escape hatch: the clean page, untouched
  const clean = await page.request.get('/?builder=0');
  expect(clean.status()).toBe(200);
  const html = await clean.text();
  expect(html).toContain('hero-title');
  expect(html).not.toContain('astroix-root');
});
