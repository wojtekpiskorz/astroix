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
