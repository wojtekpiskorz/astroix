import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// Serial: the write test edits a fixture source on disk and restores it.
test.describe.configure({ mode: 'serial' });

async function selectHeroTitle(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByText('Select: off').click();
  await page.frameLocator('#astroix-canvas').locator('.hero-title').click();
}

test('rule click opens the editor scrolled to the range with chips for every place', async ({
  page,
}) => {
  await selectHeroTitle(page);

  // winner row (index.astro) — single range
  await page.locator('[data-astroix-winner="true"]').click();
  const editor = page.locator('[data-astroix-editor="view"]');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('index.astro');
  await expect(editor.locator('.cm-content')).toContainText('.hero-title');
  // the mark decoration splits per line — at least one highlighted span
  await expect(editor.locator('.astroix-rule-highlight').first()).toBeVisible();

  // a home.css row — three places → three jump chips, active = clicked
  const homeRow = page.locator('[data-astroix-rule]', { hasText: 'home.css' }).first();
  await homeRow.click();
  await expect(editor).toContainText('home.css');
  await expect(editor.locator('[data-astroix-range-chip]')).toHaveCount(3);

  await editor.locator('[data-astroix-range-chip="1"]').click();
  await expect(editor.locator('[data-astroix-range-chip="1"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(editor.locator('.astroix-rule-highlight').first()).toBeVisible();
});

test('typing writes through the splice loop: disk bytes, format preserved, canvas via HMR', async ({
  page,
}) => {
  await selectHeroTitle(page);

  // open the scoped rule (index.astro): its color change is observable at any
  // viewport, so the canvas-HMR reflection is assertable without layout tricks
  const canvas = page.frameLocator('#astroix-canvas');
  await expect(canvas.locator('.hero-title')).toHaveCSS('color', 'rgb(30, 41, 59)');
  await page.locator('[data-astroix-winner="true"]').click();
  const editor = page.locator('[data-astroix-editor="view"]');
  await expect(editor.locator('.cm-content')).toBeVisible();

  const filePath = join('e2e', 'fixture', 'src', 'pages', 'index.astro');
  const original = readFileSync(filePath, 'utf8');
  try {
    // dispatch a real CM transaction — the same change path as typing
    await editor.locator('.cm-content').evaluate((el) => {
      const view = (el.closest('.cm-editor') as (HTMLElement & { __astroixView?: unknown }) | null)
        ?.__astroixView as {
        state: { doc: { toString: () => string } };
        dispatch: (spec: { changes: { from: number; to: number; insert: string } }) => void;
      };
      if (view === undefined) throw new Error('editor view not stashed');
      const text = view.state.doc.toString();
      const from = text.indexOf('#1e293b');
      if (from === -1) throw new Error('scoped color not found in editor');
      view.dispatch({ changes: { from, to: from + '#1e293b'.length, insert: '#b91c1c' } });
    });

    await expect(editor.locator('[data-astroix-editor-status]')).toHaveAttribute(
      'data-astroix-editor-status',
      'saved',
      { timeout: 5_000 },
    );

    // disk: exactly the edited range changed, everything else byte-identical
    const at = original.indexOf('#1e293b');
    const expected = `${original.slice(0, at)}#b91c1c${original.slice(at + '#1e293b'.length)}`;
    expect(readFileSync(filePath, 'utf8')).toBe(expected);

    // canvas reflects the write through host HMR without a manual reload
    await expect(canvas.locator('.hero-title')).toHaveCSS('color', 'rgb(185, 28, 28)', {
      timeout: 10_000,
    });
  } finally {
    writeFileSync(filePath, original);
  }
});
