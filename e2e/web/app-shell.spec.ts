import { expect, type Page, type Route, test } from '@playwright/test';
import { activateButton, LAUNCHER_APP_URL, PROJECT_APP_URL } from './spec-helpers.ts';

/**
 * The rebuilt app shell's product E2E (#241, G2): the project document
 * IS the React app shell now — composed over the ONE AppClient at the
 * document's exact `SessionRef`, its session queries generation-scoped,
 * its transition-commit reset ORDERED. The legs pin the AC's live
 * truths: the shell lands bound at the fresh generation with live
 * session state and stable feature slots; deactivation's commit-time
 * reset removes state BEFORE the top-level replacement (the navigation
 * request is intercepted and the still-alive old document's
 * `shell-state` marker is read — the ordering proof); and a repeated
 * generation change with a DELAYED fetch proves the reset's abort step
 * real (the held old-generation inspect dies aborted) and the fresh
 * generation's cache unpolluted.
 *
 * SSE disclosure (#330, reads-law alignment — merged): a live
 * same-origin GET stream presents `Sec-Fetch-Site: same-origin` and no
 * `Origin` (a forbidden header on same-origin GET in real browsers),
 * and SSE admission now verifies `Origin` only when present — the
 * browser's own shape is admitted. Live-wire SSE delivery legs ride the
 * I/J/K lanes (unblocked by #330); what IS asserted here is the pages'
 * honest `stream-state` surface, and delayed SSE-frame delivery is
 * pinned at the unit tier (`shell-provider.test.tsx`).
 *
 * SERIAL like the activation battery: one control plane, one supervisor-
 * global active session — the legs walk one coherent session history and
 * restore the idle state for whatever follows.
 */

/**
 * Aborts the next launcher-document navigation so the OLD document
 * SURVIVES with the replacement already attempted — the honest ordering
 * proof shape: the navigation request demonstrably went out (the abort
 * saw it), and the still-alive document's `shell-state` marker is read
 * afterwards, directly. (Intercept-and-continue with an in-handler
 * `page.evaluate` deadlocks: the renderer suspends during the pending
 * provisional navigation.)
 */
async function abortNextLauncherNavigation(page: Page): Promise<void> {
  let observed = false;
  await page.route(/launcher\.localhost/, async (route: Route) => {
    if (!observed && route.request().resourceType() === 'document') {
      observed = true;
      await route.abort('aborted');
      return;
    }
    await route.continue().catch(() => {});
  });
}

test.describe.configure({ mode: 'serial' });

test('activation lands the rebuilt shell at a fresh generation with live session state and stable slots', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);

  // The shell is bound at the committed pair: the retained identity
  // surfaces, the generation-scoped inspection, and the honest stream
  // state (never a silent 'connecting'; under #330's reads law the live
  // browser stream is admitted, so the state settles 'open').
  await expect(page.getByTestId('session-generation')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('inspect-revision')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('stream-state')).not.toHaveText('connecting');

  // The shell-state marker reports live session state: the query cached
  // under its key, no reset yet.
  await expect(page.getByTestId('shell-state')).toContainText('queries=1');
  await expect(page.getByTestId('shell-state')).toContainText('reset=none');

  // The stable feature slots exist. The sidebar slot carries the
  // Content vertical's discovery panel (J1, #251 — the first landed
  // vertical); the editor-dock slot stays a placeholder until its
  // vertical; the canvas slot carries #242's natural-route same-origin
  // canvas — the plain iframe on the project origin (its own battery
  // pins the canvas's behavior; this leg pins only that the slot is
  // filled by it).
  await expect(page.locator('[data-slot="editor-dock"]')).toContainText('slot: editor-dock');
  await expect(page.locator('[data-slot="sidebar"] [data-astroix-content-discovery]')).toHaveCount(
    1,
  );
  await expect(page.locator('[data-slot="canvas"] [data-testid="canvas-frame"]')).toHaveCount(1);

  // Restore the idle state for the next leg.
  await page.getByTestId('deactivate').click();
  await page.waitForURL(LAUNCHER_APP_URL);
  await expect(page.getByTestId('session-label')).toHaveText('idle');
});

test('deactivation removes shell state BEFORE the location replacement', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);
  await expect(page.getByTestId('inspect-revision')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('shell-state')).toContainText('queries=1');

  await abortNextLauncherNavigation(page);

  await page.getByTestId('deactivate').click();

  // The ordering proof: the location replacement was ATTEMPTED (the
  // aborted navigation request went out) and the still-alive document
  // shows the reset had ALREADY completed — every clearing step traced,
  // the query cache emptied, the stores cleared — before that request.
  await expect(page.getByTestId('shell-state')).toContainText(
    'reset=abort-fetches,close-sse,remove-queries,clear-stores',
  );
  const cleared = await page.getByTestId('shell-state').textContent();
  expect(cleared).toContain('queries=0');
  expect(cleared).toContain('selection=0');
  expect(cleared).toContain('grants=0');
  expect(cleared).toContain('debounces=0');
  expect(cleared).toContain('pending=0');
  // The document stayed: the replacement died at the abort, state still cleared.
  await expect(page).toHaveURL(PROJECT_APP_URL);

  // Restore the idle state for the next leg.
  await page.unroute(/launcher\.localhost/);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
});

test('a repeated generation change with a delayed old-generation fetch aborts it and never pollutes the fresh generation', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);
  await expect(page.getByTestId('inspect-revision')).toHaveText(/^\d+$/);
  const generation = Number(await page.getByTestId('session-generation').textContent());

  // Hold EVERY inspect of the old generation at the wire: the response
  // would arrive only after the transition — if it were allowed to.
  let releaseHeld: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  await page.route('**/__astroix/api/v1', async (route) => {
    const body = route.request().postDataJSON() as {
      command?: { kind?: string };
      session?: { generation?: number };
    };
    if (body?.command?.kind === 'inspect' && body?.session?.generation === generation) {
      await held;
    }
    // The held request may already have been cancelled at the browser
    // (the reset's abort) — continuing it then rejects, which is fine.
    await route.continue().catch(() => {});
  });

  // The old generation's inspect goes out and is held in flight.
  await page.getByTestId('reinspect').click();
  const failedInspect = page.waitForEvent('requestfailed', {
    predicate: (request) =>
      request.url().endsWith('/__astroix/api/v1') && request.method() === 'POST',
    timeout: 30_000,
  });

  // The repeated ordering proof: the same reset clears state before the
  // replacement on this generation change too.
  await abortNextLauncherNavigation(page);

  await page.getByTestId('deactivate').click();
  await expect(page.getByTestId('shell-state')).toContainText(
    'reset=abort-fetches,close-sse,remove-queries,clear-stores',
  );

  // The held old-generation fetch DIED ABORTED — the reset's first step
  // (abort old fetches) is real at the wire, not a UI gesture.
  const failed = await failedInspect;
  expect(failed.failure()).toBeTruthy();

  // The fresh generation's document: a NEW generation, a live inspection
  // under its own key, and a cache that never saw the old pair's data.
  releaseHeld?.();
  await page.unroute('**/__astroix/api/v1');
  await page.unroute(/launcher\.localhost/);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);
  const freshGeneration = Number(await page.getByTestId('session-generation').textContent());
  expect(freshGeneration).toBeGreaterThan(generation);
  await expect(page.getByTestId('inspect-revision')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('shell-state')).toContainText('queries=1');
  await expect(page.getByTestId('shell-state')).toContainText('reset=none');

  // Restore the idle state for whatever follows the battery.
  await page.getByTestId('deactivate').click();
  await page.waitForURL(LAUNCHER_APP_URL);
  await expect(page.getByTestId('session-label')).toHaveText('idle');
});
