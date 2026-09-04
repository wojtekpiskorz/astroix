import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { stagedCopyRoot } from '../../apps/web/src/stage-e2e.ts';
import { activateButton, PROJECT_APP_URL, restoreIdle } from './spec-helpers.ts';

/**
 * The CSS vertical's read-only inspection battery (#249, I1): the
 * feature-local sidebar's live truths against the real control-plane
 * composition — the joined source/effective list for the selection on
 * the OBSERVED canvas route (the settled #370 wire shape: the panel's
 * styles inspection carries `{kind: 'styles', route}` and the executor
 * resolves the component behind the runtime), the deterministic match
 * order with the cascade winner, media metadata, and sanitized
 * project-relative locations — plus the selection lifecycle: the
 * re-match after a style invalidation (SSE frame → query refetch), the
 * clear on a missing element (an HMR rebuild that drops it), the route
 * change on canvas navigation (the empty truth on a route nothing
 * styles), the route-shaped 404's own state, and the generation reset.
 *
 * The read-only law is pinned live: no edit control renders anywhere in
 * the panel, and no module-graph or filesystem shape ever enters it.
 *
 * Scoped-style strategy coverage: the live host runs the fixture's
 * default `attribute` strategy (the `[data-astro-cid-*]` effective
 * forms); the `where` strategy's `:where(.astro-*)` forms are pinned at
 * the feature-unit tier over the frozen `css-index.where.json` corpus —
 * the canonical fixture (the strategy knob's owner) is not this lane's
 * to reconfigure.
 *
 * File mutations touch the DISPOSABLE staged copy only and restore the
 * original bytes in a `finally` (the canvas lane's discipline).
 *
 * SERIAL like the lane's other batteries: one control plane, one
 * supervisor-global active session — every leg restores the idle state.
 *
 * The landing/selection waits inherit the 5s expect default and are
 * load-shaped on a shared CI runner (#392); the panel's own settle
 * polls already carry 120s budgets — the rest grow to 30s, the asserted
 * values never change.
 */

/** The CSS panel's state word. */
function panelState(page: Page) {
  return page.getByTestId('css-rules-state').getAttribute('data-state');
}

/** Waits for the panel's ready list and returns its row locators. */
async function readyRows(page: Page) {
  await expect(page.getByTestId('css-rule-list')).toBeVisible({ timeout: 120_000 });
  return page.locator('[data-testid="css-rule"]');
}

/** The staged copy's home sheet and page template — the mutation legs' targets. */
function stagedSheetPaths(): { cssPath: string; astroPath: string } {
  return {
    cssPath: join(stagedCopyRoot('project-a'), 'src', 'pages', 'home.css'),
    astroPath: join(stagedCopyRoot('project-a'), 'src', 'pages', 'index.astro'),
  };
}

/**
 * The batteries' shared activation prefix: land on the launcher,
 * activate, and WAIT FOR THE CANVAS TO SETTLE — the initial load plus
 * the young dev server's one post-connect self-reload (the canvas
 * battery's own HMR-leg discipline; a click racing that rebuild lands
 * on a document whose capture listener is between epochs and is lost).
 * Event-ordered: the two baseline navigations complete BEFORE the
 * settle clock starts, and the settle window proves no third navigation
 * is in flight.
 */
async function activateSettled(page: Page): Promise<void> {
  const frameNavigations: string[] = [];
  const onNavigated = (frame: import('@playwright/test').Frame): void => {
    if (frame.parentFrame() !== null) frameNavigations.push(frame.url());
  };
  page.on('framenavigated', onNavigated);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: 30_000 });
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL, { timeout: 120_000 });
  await expect(page.getByTestId('canvas-origin-state')).toHaveText('project', { timeout: 30_000 });
  await expect.poll(() => frameNavigations.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  frameNavigations.length = 0;
  await page.waitForTimeout(1500);
  expect(frameNavigations).toEqual([]);
  page.removeListener('framenavigated', onNavigated);
}

/** The canvas frame locator — the product-attribute form (#374 ruling), never a test id. */
const CANVAS_FRAME = '[data-astroix-canvas] iframe';

/**
 * Clicks one canvas element until the selection lands — bounded
 * retry over a possibly-reloading document (a mid-navigation click is
 * retried, never assumed).
 */
async function canvasSelect(page: Page, selector: string): Promise<void> {
  await expect(async () => {
    await page.frameLocator(CANVAS_FRAME).locator(selector).click();
    await expect(page.getByTestId('selection-tag')).not.toHaveText('none', { timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
}

test.describe.configure({ mode: 'serial' });

test('the joined list renders the live truth: scoped effective form, global source forms, media, locations, winner', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await activateSettled(page);

  // Select the fixture's doubly-styled element: the scoped compiled form
  // plus the three global occurrences join into one deterministic list.
  await canvasSelect(page, '.hero-title');
  await expect(page.getByTestId('selection-tag')).toHaveText('h1', { timeout: 30_000 });
  const rows = await readyRows(page);
  await expect(rows).toHaveCount(4, { timeout: 30_000 });

  // The scoped compiled form leads as the cascade winner: the effective
  // selector rides verbatim (the compiler's cid attribute, never a
  // synthesis), from the page template's own scoped block.
  const winner = rows.first();
  await expect(winner).toHaveAttribute('data-css-winner', 'true');
  await expect(winner).toHaveAttribute('data-css-selector', '.hero-title');
  await expect(winner).toHaveAttribute(
    'data-css-effective',
    /^\.hero-title\[data-astro-cid-[a-z0-9]+\]$/,
  );
  await expect(winner).toHaveAttribute('data-css-file', 'src/pages/index.astro');
  await expect(winner).toHaveAttribute('data-css-line', '24');

  // The three global occurrences follow in payload order — two plain,
  // one media-conditioned, all from the imported sheet, sanitized.
  const globals = rows.nth(1);
  await expect(globals).toHaveAttribute('data-css-file', 'src/pages/home.css');
  await expect
    .poll(
      async () =>
        await rows.evaluateAll((nodes) =>
          nodes.map((node) => (node as HTMLElement).getAttribute('data-css-file')),
        ),
      { timeout: 30_000 },
    )
    .toEqual([
      'src/pages/index.astro',
      'src/pages/home.css',
      'src/pages/home.css',
      'src/pages/home.css',
    ]);
  const mediaRows = page.locator('[data-testid="css-rule"][data-css-media="(max-width: 640px)"]');
  await expect(mediaRows).toHaveCount(1, { timeout: 30_000 });
  await expect(mediaRows.first()).toHaveAttribute('data-css-selector', '.hero-title');

  // Exactly one winner; the effective form never renders for globals.
  await expect(page.locator('[data-testid="css-rule"][data-css-winner="true"]')).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(rows.nth(1)).toHaveAttribute('data-css-effective', '');

  // The disclosure sweep: nothing the module graph or the filesystem
  // owns ever enters the panel — sanctioned project-relative page/sheet
  // paths ARE the frozen contract's own truth, absolutes never are.
  const panelText = (await page.getByTestId('css-panel').textContent()) ?? '';
  expect(panelText).not.toContain('node_modules');
  expect(panelText).not.toContain('routeComponent');
  expect(panelText).not.toContain('virtual:astro');
  expect(panelText).not.toMatch(/\/(Users|home|srv|mnt|private)\//);

  // The read-only law, live: no edit control exists in the panel.
  const editableCount = await page
    .getByTestId('css-panel')
    .locator('input, textarea, select, [contenteditable="true"]')
    .count();
  expect(editableCount).toBe(0);

  // Restore the idle state for the next leg.
  await restoreIdle(page);
});

test('the read-only rule detail discloses, and a global-only element shows its single source row', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await activateSettled(page);

  // The detail is a disclosure of source truth — never an editor.
  await canvasSelect(page, '.hero-title');
  const rows = await readyRows(page);
  await rows.first().getByTestId('css-rule-detail-toggle').click();
  const detail = page.getByTestId('css-rule-detail').first();
  await expect(detail).toBeVisible({ timeout: 30_000 });
  await expect(detail).toContainText('scoped style block 0', { timeout: 30_000 });
  await expect(detail).toContainText('source range:', { timeout: 30_000 });

  // A global-only element: one row, no effective form, its own place.
  await canvasSelect(page, '.hero-lead');
  const leadRows = await readyRows(page);
  await expect(leadRows).toHaveCount(1, { timeout: 30_000 });
  await expect(leadRows.first()).toHaveAttribute('data-css-selector', '.hero-lead');
  await expect(leadRows.first()).toHaveAttribute('data-css-effective', '');
  await expect(leadRows.first()).toHaveAttribute('data-css-file', 'src/pages/home.css');

  // Restore the idle state for the next leg.
  await restoreIdle(page);
});

test('a canvas navigation changes the observed route — a route that styles nothing shows the honest empty state', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await activateSettled(page);

  // The canvas's own address control navigates a natural route; the
  // panel follows the OBSERVED route (never a client-selected one).
  await page.getByTestId('canvas-address').fill('/blog/hello-builder');
  await page.getByTestId('canvas-navigate').click();
  await expect(page.getByTestId('canvas-url')).toContainText('/blog/hello-builder', {
    timeout: 30_000,
  });

  // The blog component imports no sheet and carries no scoped block:
  // its title is styled by nothing — the honest empty state.
  await canvasSelect(page, '.blog-title');
  // A fresh route's inspection settles on its own clock (the young
  // dev server's churn rides the panel's settle-poll) — wait it out.
  await expect.poll(async () => await panelState(page), { timeout: 120_000 }).toBe('empty');
  await expect(page.getByTestId('css-rules-state')).toContainText('no matching rules', {
    timeout: 30_000,
  });

  // An unroutable observed pathname (the dev server's own 404 page is a
  // same-origin document): the selection lands, the inspection answers
  // the route-shaped 404, and the panel surfaces its own state.
  await page.getByTestId('canvas-address').fill('/no/such/route');
  await page.getByTestId('canvas-navigate').click();
  await expect(page.getByTestId('canvas-url')).toContainText('/no/such/route', {
    timeout: 30_000,
  });
  await canvasSelect(page, 'h1');
  await expect
    .poll(async () => await panelState(page), { timeout: 120_000 })
    .toBe('unresolved-route');
  await expect(page.getByTestId('css-rules-state')).toContainText('resolves to no route', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('css-rule-list')).toHaveCount(0, { timeout: 30_000 });

  // Restore the idle state for the next leg.
  await restoreIdle(page);
});

test('a style invalidation re-matches: the SSE refetch grows the list for the same live selection', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await activateSettled(page);
  await canvasSelect(page, '.hero-title');
  const rows = page.locator('[data-testid="css-rule"]');
  await expect(rows).toHaveCount(4, { timeout: 30_000 });

  // Mutate the DISPOSABLE copy's imported sheet: the invalidation rides
  // the worker's revisioned event → SSE frame → the provider's family
  // invalidation → the query refetch → the panel re-matches over the
  // fresh records — the selection never moved.
  const { cssPath } = stagedSheetPaths();
  const original = await readFile(cssPath, 'utf8');
  try {
    await writeFile(cssPath, `${original}\n.hero-title { text-decoration: underline; }\n`);
    await expect(rows).toHaveCount(5, { timeout: 120_000 });
    await expect(page.getByTestId('selection-tag')).toHaveText('h1', { timeout: 30_000 });
    // the new occurrence joins as a global source row from the same sheet
    const lastRow = rows.nth(4);
    await expect(lastRow).toHaveAttribute('data-css-selector', '.hero-title');
    await expect(lastRow).toHaveAttribute('data-css-file', 'src/pages/home.css');
  } finally {
    await writeFile(cssPath, original);
  }

  // Restore the idle state for the next leg.
  await restoreIdle(page);
});

test('a DOM rebuild that drops the selected element clears the list — the missing-element truth', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await activateSettled(page);
  await canvasSelect(page, '.hero-title');
  await expect(page.locator('[data-testid="css-rule"]')).toHaveCount(4, { timeout: 30_000 });

  // Rename the element's class in the staged template: vite's full
  // reload rebuilds the document without the selected element — the
  // re-match finds nothing and the panel clears to its honest state.
  const { astroPath } = stagedSheetPaths();
  const original = await readFile(astroPath, 'utf8');
  try {
    await writeFile(astroPath, original.replace('class="hero-title"', 'class="hero-title-gone"'));
    await expect
      .poll(async () => await panelState(page), { timeout: 120_000 })
      .toBe('missing-element');
    await expect(page.getByTestId('css-rule-list')).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await writeFile(astroPath, original);
  }

  // Restore the idle state for the next leg.
  await restoreIdle(page);
});

test('a canvas navigation with a SURVIVING selection re-derives at the load epoch — never rows against the detached document', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await activateSettled(page);
  await canvasSelect(page, '.hero-title');
  await expect(page.locator('[data-testid="css-rule"]')).toHaveCount(4, { timeout: 30_000 });

  // The canvas's own address control navigates a natural route; the
  // SELECTION SURVIVES (it is a descriptor, the new document stays on
  // the project origin) — and the blog document carries no .hero-title,
  // so the honest truth at the load epoch is missing-element. The load
  // ALONE must re-derive: the new document may never mutate again, and
  // rows matched against the DETACHED previous document's element must
  // never render while waiting for one.
  await page.getByTestId('canvas-address').fill('/blog/hello-builder');
  await page.getByTestId('canvas-navigate').click();
  await expect(page.getByTestId('canvas-url')).toContainText('/blog/hello-builder', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('selection-tag')).toHaveText('h1', { timeout: 30_000 });
  await expect
    .poll(async () => await panelState(page), { timeout: 120_000 })
    .toBe('missing-element');
  await expect(page.getByTestId('css-rule-list')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('css-rules-state')).toContainText('no longer in the canvas', {
    timeout: 30_000,
  });

  // Restore the idle state for the next leg.
  await restoreIdle(page);
});

test('a generation reset clears the selection — the fresh session serves fresh rows only', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await activateSettled(page);
  await canvasSelect(page, '.hero-title');
  await expect(page.locator('[data-testid="css-rule"]')).toHaveCount(4, { timeout: 30_000 });
  // Converge the generation text before the one-shot numeric read (#392:
  // a one-shot read of rendered state races the first commits under load).
  await expect(page.getByTestId('session-generation')).toHaveText(/^\d+$/, { timeout: 30_000 });
  const generation = await page.getByTestId('session-generation').textContent();

  // The transition's commit-time reset: the old generation's selection
  // dies with its stores and query cache; the fresh document starts at
  // no-selection and serves only after a FRESH selection.
  await restoreIdle(page);
  await activateSettled(page);
  await expect(page.getByTestId('session-generation')).toHaveText(/^\d+$/, { timeout: 30_000 });
  const freshGeneration = await page.getByTestId('session-generation').textContent();
  expect(Number(freshGeneration)).toBeGreaterThan(Number(generation));
  await expect.poll(async () => await panelState(page), { timeout: 30_000 }).toBe('no-selection');
  await page.frameLocator(CANVAS_FRAME).locator('.hero-title').click();
  const rows = await readyRows(page);
  await expect(rows).toHaveCount(4, { timeout: 30_000 });

  // Restore the idle state for whatever follows the battery.
  await restoreIdle(page);
});
