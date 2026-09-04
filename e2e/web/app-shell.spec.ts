import { expect, type Page, type Route, test } from '@playwright/test';
import {
  activateButton,
  BOOT_BUDGET_MS,
  LAUNCHER_APP_URL,
  LOAD_BUDGET_MS,
  PROJECT_APP_URL,
} from './spec-helpers.ts';

/** The complete four-step reset trace the marker carries once the sequencer finished (#393 capture). */
const COMPLETE_RESET_TRACE = 'reset=abort-fetches,close-sse,remove-queries,clear-stores';

/** The spec-injected snapshot slot on the app-shell document (page.evaluate context; zero-injection untouched). */
interface E2eResetWindow {
  __astroixE2eResetState?: string;
}

/**
 * The rebuilt app shell's product E2E (#241, G2): the project document
 * IS the React app shell now — composed over the ONE AppClient at the
 * document's exact `SessionRef`, its session queries generation-scoped,
 * its transition-commit reset ORDERED. The legs pin the AC's live
 * truths: the shell lands bound at the fresh generation with live
 * session state and stable feature slots; deactivation's commit-time
 * reset removes state BEFORE the top-level replacement (the navigation
 * request is intercepted and the still-alive old document's
 * `shell-state` marker is read — captured at the reset's own
 * synchronous completion, #393 — the ordering proof); and a repeated
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
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL, { timeout: BOOT_BUDGET_MS });

  // The shell is bound at the committed pair: the retained identity
  // surfaces, the generation-scoped inspection, and the honest stream
  // state (never a silent 'connecting'; under #330's reads law the live
  // browser stream is admitted, so the state settles 'open').
  // Load-shaped waits sized for a loaded CI runner (#392): these land
  // with the document's first React commits over a just-booted plane.
  await expect(page.getByTestId('session-generation')).toHaveText(/^\d+$/, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.getByTestId('inspect-revision')).toHaveText(/^\d+$/, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.getByTestId('stream-state')).not.toHaveText('connecting', {
    timeout: LOAD_BUDGET_MS,
  });

  // The shell-state marker reports live session state: the queries
  // cached under their keys, no reset yet. Three at the G2 truth: the
  // shell's own project inspection plus the Content vertical's two
  // discovery queries (content + routes, J1 #251 — generation-scoped
  // like every session query, so they die with the cache at reset).
  await expect(page.getByTestId('shell-state')).toContainText('queries=3', {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.getByTestId('shell-state')).toContainText('reset=none', {
    timeout: LOAD_BUDGET_MS,
  });

  // The stable feature slots exist. The sidebar slot carries the
  // Content vertical's discovery panel (J1, #251) and the editor-dock
  // slot its entry-form pane (J2, #252 — the honest no-entry state
  // until an entry opens; its own battery pins the pane's behavior);
  // the canvas slot carries #242's natural-route same-origin canvas —
  // the plain iframe on the project origin (its own battery pins the
  // canvas's behavior; this leg pins only that the slot is filled by
  // it).
  await expect(page.locator('[data-slot="sidebar"] [data-astroix-content-discovery]')).toHaveCount(
    1,
    { timeout: LOAD_BUDGET_MS },
  );
  await expect(page.locator('[data-slot="editor-dock"] [data-astroix-entry-form]')).toHaveCount(1, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.locator('[data-slot="canvas"] [data-testid="canvas-frame"]')).toHaveCount(1, {
    timeout: LOAD_BUDGET_MS,
  });

  // Restore the idle state for the next leg.
  await page.getByTestId('deactivate').click();
  await page.waitForURL(LAUNCHER_APP_URL, { timeout: BOOT_BUDGET_MS });
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
});

test('deactivation removes shell state BEFORE the location replacement', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL, { timeout: BOOT_BUDGET_MS });
  await expect(page.getByTestId('inspect-revision')).toHaveText(/^\d+$/, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.getByTestId('shell-state')).toContainText('queries=3', {
    timeout: LOAD_BUDGET_MS,
  });

  await abortNextLauncherNavigation(page);

  // Pin the reset's OWN completion state before the click can race the
  // dying document's later renders (#393, per the disposition): the
  // reset writes the marker synchronously as each step completes (the
  // direct DOM write — React state cannot commit synchronously ahead of
  // `location.replace`), so a page-side observer capturing the FIRST
  // marker text that carries the complete trace holds exactly the
  // post-`clear-stores` truth, whatever renders follow. Still-mounted
  // observers can re-subscribe their session queries in the async
  // window between this synchronous reset and the aborted replacement's
  // document teardown, re-minting session-scoped cache entries the
  // dying document's marker then counts (observed on loaded runners as
  // `queries=2` after a complete trace — they persist until the
  // document dies; nothing in the kept-alive document re-removes them).
  // That transient is out of the sequencer's jurisdiction; the fresh
  // replacement document's across-session truth is K2's reset-safety
  // battery's. The previous one-shot read raced that window (#392).
  await page.evaluate(() => {
    new MutationObserver(() => {
      const holder = window as unknown as E2eResetWindow;
      if (holder.__astroixE2eResetState !== undefined) return;
      const text = document.querySelector('[data-testid="shell-state"]')?.textContent;
      // literal, not the module const: page.evaluate callbacks close over nothing
      if (text?.includes('reset=abort-fetches,close-sse,remove-queries,clear-stores')) {
        holder.__astroixE2eResetState = text;
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });

  await page.getByTestId('deactivate').click();

  // The ordering proof: the location replacement was ATTEMPTED (the
  // aborted navigation request went out) and the still-alive document
  // shows the reset had ALREADY completed — every clearing step traced,
  // the query cache emptied, the stores cleared — before that request.
  // The live trace poll is safe across the re-subscription transient
  // (the trace persists in every later render); the counters are
  // asserted on the captured post-reset state. The captured snapshot is
  // frozen at capture, so the read after the truthiness poll is exact.
  await expect(page.getByTestId('shell-state')).toContainText(COMPLETE_RESET_TRACE, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as E2eResetWindow).__astroixE2eResetState), {
      timeout: LOAD_BUDGET_MS,
    })
    .toBeTruthy();
  const cleared = await page.evaluate(
    () => (window as unknown as E2eResetWindow).__astroixE2eResetState ?? '',
  );
  expect(cleared).toContain('queries=0');
  expect(cleared).toContain('selection=0');
  expect(cleared).toContain('grants=0');
  expect(cleared).toContain('undo=0');
  // The document stayed: the replacement died at the abort, state still cleared.
  await expect(page).toHaveURL(PROJECT_APP_URL);

  // Restore the idle state for the next leg.
  await page.unroute(/launcher\.localhost/);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
});

test('a repeated generation change with a delayed old-generation fetch aborts it and never pollutes the fresh generation', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL, { timeout: BOOT_BUDGET_MS });
  await expect(page.getByTestId('inspect-revision')).toHaveText(/^\d+$/, {
    timeout: LOAD_BUDGET_MS,
  });
  // Converge the generation text before the one-shot numeric read (#392:
  // a one-shot read of rendered state races the first commits under load).
  await expect(page.getByTestId('session-generation')).toHaveText(/^\d+$/, {
    timeout: LOAD_BUDGET_MS,
  });
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
    timeout: LOAD_BUDGET_MS,
  });

  // The repeated ordering proof: the same reset clears state before the
  // replacement on this generation change too.
  await abortNextLauncherNavigation(page);

  await page.getByTestId('deactivate').click();
  await expect(page.getByTestId('shell-state')).toContainText(COMPLETE_RESET_TRACE, {
    timeout: LOAD_BUDGET_MS,
  });

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
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL, { timeout: BOOT_BUDGET_MS });
  await expect(page.getByTestId('session-generation')).toHaveText(/^\d+$/, {
    timeout: LOAD_BUDGET_MS,
  });
  const freshGeneration = Number(await page.getByTestId('session-generation').textContent());
  expect(freshGeneration).toBeGreaterThan(generation);
  await expect(page.getByTestId('inspect-revision')).toHaveText(/^\d+$/, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.getByTestId('shell-state')).toContainText('queries=3', {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.getByTestId('shell-state')).toContainText('reset=none', {
    timeout: LOAD_BUDGET_MS,
  });

  // Restore the idle state for whatever follows the battery.
  await page.getByTestId('deactivate').click();
  await page.waitForURL(LAUNCHER_APP_URL, { timeout: BOOT_BUDGET_MS });
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
});
