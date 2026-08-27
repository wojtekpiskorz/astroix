import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// Serial: the tests rewrite a fixture source on disk (restoring in finally).
test.describe.configure({ mode: 'serial' });

const FILE_PATH = join('e2e', 'fixture', 'src', 'pages', 'home.css');

async function openHomeCssEditor(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByText('Select: off').click();
  await page.frameLocator('#astroix-canvas').locator('.hero-title').click();
  await page.locator('[data-astroix-rule]', { hasText: 'home.css' }).first().click();
  const editor = page.locator('[data-astroix-editor="view"]');
  await expect(editor.locator('.cm-content')).toContainText('font-weight: 800');
}

test('IDE edit reflects live in the open chrome editor (file→chrome sync)', async ({ page }) => {
  await openHomeCssEditor(page);
  const editor = page.locator('[data-astroix-editor="view"]');
  const original = readFileSync(FILE_PATH, 'utf8');

  try {
    // simulate the IDE: external write to the file the editor is showing
    writeFileSync(FILE_PATH, original.replace('font-weight: 800;', 'font-weight: 700;'));

    await expect(editor.locator('.cm-content')).toContainText('font-weight: 700;', {
      timeout: 10_000,
    });
    // the external change was ACCEPTED, not treated as a pending local write
    await expect(editor.locator('[data-astroix-editor-status]')).toHaveAttribute(
      'data-astroix-editor-status',
      'idle',
    );
  } finally {
    writeFileSync(FILE_PATH, original);
  }
});

test('stale write guard: a chrome edit based on outdated disk content is refused, never spliced', async ({
  page,
}) => {
  const original = readFileSync(FILE_PATH, 'utf8');
  try {
    // direct REST probe of the optimistic-write check: an `expected` hash
    // that cannot match disk → 409 with the current contents, file untouched
    const at = original.indexOf('font-weight: 800');
    const response = await page.request.post('/__astroix/edit', {
      data: {
        file: 'src/pages/home.css',
        range: { start: at, end: at + 1 },
        replacement: 'X',
        expected: '0'.repeat(64),
      },
    });
    expect(response.status()).toBe(409);
    const body = (await response.json()) as { contents?: string };
    expect(body.contents).toContain('font-weight: 800');
    expect(readFileSync(FILE_PATH, 'utf8')).toBe(original);
  } finally {
    writeFileSync(FILE_PATH, original);
  }
});
