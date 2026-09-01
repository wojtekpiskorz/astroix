import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ORACLE_MAIN } from './oracle.mjs';

/** One-based lines of every occurrence of a needle in a text. */
function occurrenceLines(text: string, needle: string): number[] {
  const lines: number[] = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    lines.push(text.slice(0, index).split('\n').length);
    index = text.indexOf(needle, index + 1);
  }
  return lines;
}

test('rule list: matched rules with file+line, sorted, winner marked, hash hidden', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByText('Select: off').click();
  const canvas = page.frameLocator('#astroix-canvas');
  await canvas.locator('.hero-title').click();

  // scoped rule + the three home.css places (base, weight, @media)
  const rules = page.locator('[data-astroix-rule]');
  await expect(rules).toHaveCount(4);

  // exactly one winner, and it is the scoped rule (0,2,0 beats (0,1,0))
  await expect(page.locator('[data-astroix-winner="true"]')).toHaveCount(1);
  await expect(rules.first()).toContainText('index.astro');
  await expect(rules.first()).toContainText('.hero-title');

  // the @media place carries its badge (condition text, unevaluated)
  await expect(page.locator('[data-astroix-media="(max-width: 640px)"]')).toHaveCount(1);

  // multi-place hint: home.css styles the element in three places
  await expect(page.locator('[data-astroix-multi]')).toHaveCount(3);

  // presentation filter: raw cid hashes never appear
  const panelText = await page.locator('[data-astroix-rules]').innerText();
  expect(panelText).not.toContain('data-astro-cid');

  // file:line values match the real source, derived independently here
  const homeCss = readFileSync(`${ORACLE_MAIN}/src/pages/home.css`, 'utf8');
  const heroTitleLines = occurrenceLines(homeCss, '.hero-title {');
  expect(heroTitleLines).toHaveLength(3);
  for (const line of heroTitleLines) {
    expect(panelText).toContain(`src/pages/home.css:${line}`);
  }
  const astro = readFileSync(`${ORACLE_MAIN}/src/pages/index.astro`, 'utf8');
  const scopedLine = occurrenceLines(astro, '.hero-title {')[0];
  expect(panelText).toContain(`src/pages/index.astro:${scopedLine}`);

  // specificity order after the winner: source order for the (0,1,0) ties
  const orderText = await rules.allInnerTexts();
  const mediaIndex = orderText.findIndex((text) => text.includes('max-width'));
  expect(mediaIndex).toBe(3);
});

test('rule list: no matching rules → explicit empty state', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Select: off').click();
  // the document element: no rule targets it, so the matcher returns nothing
  await page.frameLocator('#astroix-canvas').locator('html').dispatchEvent('click');

  await expect(page.locator('[data-astroix-rules="empty"]')).toBeVisible();
});

// The #141 flake, pinned deterministically: a full canvas reload swaps the
// iframe's document (the live-preview full-reload family); the select
// handlers must re-attach to the new document, or its clicks pass through
// unselected — the store keeps the pre-reload selection, so the pin clicks
// a different element and requires its rules to render. Two monotone gates
// keep it off timing: the outgoing document is stamped and waited out (the
// swap), and the hover outline is polled for (the attach — it paints only
// through live listeners), so the click cannot land on a stale or
// listener-less document and pass for the wrong reason.
test('select mode survives a canvas reload — clicks in the new document still select (#141)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByText('Select: off').click();
  const canvas = page.frameLocator('#astroix-canvas');
  await canvas.locator('.hero-title').click();
  await expect(page.locator('[data-astroix-rule]')).toHaveCount(4);

  // gate 1 — the swap: stamp the outgoing document, reload, and wait for
  // the stamp to die (the old document stays queryable until the
  // replacement commits; builder.spec.ts:157 records the window)
  await page.locator('#astroix-canvas').evaluate((frame: HTMLIFrameElement) => {
    frame.contentDocument?.documentElement.setAttribute('data-astroix-pin-outgoing', '');
    frame.contentWindow?.location.reload();
  });
  await expect(canvas.locator('html[data-astroix-pin-outgoing]')).toHaveCount(0);

  // gate 2 — the attach: re-hover until the outline paints (the listeners
  // land one render after the load report)
  await expect
    .poll(
      async () => {
        await canvas.locator('.hero-lead').hover();
        return canvas
          .locator('.hero-lead')
          .evaluate((el) => el.classList.contains('astroix-hover'));
      },
      { timeout: 5_000 },
    )
    .toBe(true);

  // the new document's click selects its own target — a stale list still
  // showing the pre-reload selection's rows is exactly the #141 failure
  await canvas.locator('.hero-lead').click();
  await expect(page.locator('[data-astroix-selection]')).toContainText('hero-lead');
  await expect(page.locator('[data-astroix-rule]')).toHaveCount(1);
});
