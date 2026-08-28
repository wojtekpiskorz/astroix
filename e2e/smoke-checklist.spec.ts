import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

import { SMOKE_STEPS } from '../src/client/features/smoke/smoke-steps.ts';

// The in-chrome smoke checklist (issue #61): gated on a top-level
// `?astroix_smoke=1` — nothing renders without it. With the gate open, the
// hint pill renders and `S` summons the wizard dialog (variant B of the #46
// prototype). Clipboard permissions so the Copy-report assertion can read
// what was actually written.
const GATED_URL = '/?astroix_smoke=1';
const SMOKE_TOTAL = SMOKE_STEPS.length;

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('SMOKE_STEPS mirror the step ids of docs/manual-smoke.md', () => {
  // The module is a hand-maintained mirror of the doc (its update path) —
  // this keeps the drift loud on either side. Ids only: the module's titles
  // are deliberately condensed. Here, not in unit tests: reading the real
  // doc is an fs read, and the unit doctrine stays pure-modules-over-
  // fixtures (grilling ruling 2026-08-29).
  const doc = readFileSync(join('docs', 'manual-smoke.md'), 'utf8');
  const docIds = [...doc.matchAll(/^\s*(\d+[a-z]?)\./gm)].map((match) => match[1]);
  expect(docIds).toEqual(SMOKE_STEPS.map((step) => step.id));
});

test('gate closed: normal builder use renders no checklist DOM', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#astroix-root')).toBeVisible();
  await expect(page.locator('[data-astroix-smoke]')).toHaveCount(0);
});

test('gate open: the pill renders and S opens the wizard', async ({ page }) => {
  await page.goto(GATED_URL);

  const pill = page.locator('[data-astroix-smoke="pill"]');
  await expect(pill).toBeVisible();
  // the hint pill stays small — the fold-in shrank the prototype's (#61)
  const width = (await pill.boundingBox())?.width ?? 999;
  expect(width).toBeLessThan(140);

  await page.keyboard.press('s');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`Step 1 of ${SMOKE_TOTAL} — 1. One command boots everything`);

  // Escape closes the Base UI dialog
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('a verified step with a note flows into the copy report', async ({ page }) => {
  await page.goto(GATED_URL);
  await page.keyboard.press('s');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // walk to step 3, verify it and leave a note
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog).toContainText('Step 3 of');
  await dialog.getByRole('checkbox', { name: 'Step 3 verified' }).click();
  await dialog.getByPlaceholder('note (optional)').fill('checked from e2e');

  // step 3 is the third screen: five more Next presses reach step 8, whose
  // forward button is labelled Summary
  for (let i = 0; i < SMOKE_TOTAL - 3; i++) {
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  }
  await dialog.getByRole('button', { name: 'Summary', exact: true }).click();
  await expect(dialog).toContainText(`Smoke summary — 1/${SMOKE_TOTAL} verified`);

  await dialog.getByRole('button', { name: 'Copy report' }).click();
  const report = dialog.locator('[data-astroix-smoke="report"]');
  await expect(report).toBeVisible();
  await expect(report).toContainText('- [x] 3 — Select mode: hover + click the hero title');
  await expect(report).toContainText('- note: checked from e2e');
  await expect(report).toContainText('outstanding: 1, 2, 4, 5, 6, 6b, 7.');

  // the clipboard received the same payload as the preview
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain('- [x] 3 —');
  expect(clipboard).toContain('- note: checked from e2e');
});

test('S typed into the shadow-rooted CodeMirror editor does not summon the wizard', async ({
  page,
}) => {
  // regression (advisory round 1): the guard must read the keydown target
  // from the composed path — document.activeElement is the shadow host
  // while CodeMirror holds focus, and the wizard would swallow every
  // plain `s` typed in the raw editor
  const filePath = join('e2e', 'fixture', 'src', 'pages', 'index.astro');
  const original = readFileSync(filePath, 'utf8');
  try {
    await page.goto(GATED_URL);
    await page.getByText('Select: off').click();
    await page.frameLocator('#astroix-canvas').locator('.hero-title').click();
    await page.locator('[data-astroix-winner="true"]').click();
    const editor = page.locator('[data-astroix-editor="view"]');
    await expect(editor.locator('.cm-content')).toBeVisible();
    await editor.locator('.cm-content').click();

    await page.keyboard.press('s');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // the keystroke went to the editor and wrote through — wait for the
    // bytes on disk before the finally restores the file, or the debounced
    // write races the restore and a stray `s` survives. Disk, not the
    // editor's `saved` badge: editing a page file triggers a full Astro
    // reload that can unmount the chrome before the badge flips.
    await expect
      .poll(async () => readFileSync(filePath, 'utf8'), { timeout: 10_000 })
      .not.toBe(original);
  } finally {
    // the keystroke went to the editor and wrote through — restore the file
    writeFileSync(filePath, original);
  }
});
