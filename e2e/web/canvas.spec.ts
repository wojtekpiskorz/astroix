import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Frame, type Page, test } from '@playwright/test';
import { stagedCopyRoot } from '../../apps/web/src/stage-e2e.ts';

/**
 * The natural-route same-origin canvas's product E2E (#242, G3): the
 * canvas slot's live truths against the real control-plane composition
 * — the plain iframe on the project's own origin (direct
 * `contentDocument` access from the shell document), natural URLs only
 * (the resolved base's root and the project's own routes; never a
 * synthetic canvas path, builder query, or reserved-namespace path),
 * navigation observed on every load, direct DOM selection matched
 * through `Element.matches` against the document's runtime effective
 * selectors (the scoped `[data-astro-cid-*]` forms verbatim), selection
 * persistence across eligible reloads and HMR-driven rule changes, the
 * stock Vite HMR websocket on the proxied native path (no Astroix
 * bridge), and the fail-closed off-origin gate.
 *
 * File mutations (the HMR leg) touch the DISPOSABLE staged copy only
 * (#242's migration policy: the canonical fixture stays plain) and
 * restore the original bytes in a `finally` — the zero-injection spec
 * that follows re-proves the restore with its own byte snapshot.
 *
 * SSE disclosure (#330, owner ruling pending): nothing here needs the
 * events stream — the canvas observes the page itself; the HMR leg
 * proves the native websocket path directly.
 *
 * SERIAL like the lane's other batteries: one control plane, one
 * supervisor-global active session — every leg restores the idle state
 * for what follows.
 */

/** The list item whose staged copy is at `position` (0 and 1 are the fixture copies; 2 is broken). */
function activateButton(page: Page, position: number) {
  return page.getByTestId('project-list').locator('li').nth(position).getByTestId('activate');
}

const PROJECT_APP_URL = /^http:\/\/(?!launcher)[a-z2-7]+\.localhost:\d+\/__astroix\/app\/$/;
const LAUNCHER_APP_URL = /launcher\.localhost:\d+\/__astroix\/app\//;

/** The canvas's frame locator — the plain iframe itself. */
function canvas(page: Page) {
  return page.frameLocator('[data-testid="canvas-frame"]');
}

/** The canvas's live Frame object — for the page-native navigation legs. */
function canvasFrame(page: Page): Frame {
  const frame = page.frames().find((candidate) => candidate.parentFrame() !== null);
  if (frame === undefined) throw new Error('the canvas frame is not live');
  return frame;
}

test.describe.configure({ mode: 'serial' });

test('the canvas shares the project origin with direct contentDocument access at the natural root', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);
  // The canvas observed its first project document: the gate opens.
  await expect(page.getByTestId('canvas-origin-state')).toHaveText('project');
  await expect(page.getByTestId('canvas-inspection')).toHaveText('enabled');

  const origin = new URL(page.url()).origin;

  // The canvas URL is the project origin's own natural root — read
  // DIRECTLY through same-origin contentWindow access from the shell
  // document (the AC's exact access proof, not a Playwright mirror).
  const canvasUrl = await page.evaluate(() => {
    const frame = document.querySelector(
      '[data-testid="canvas-frame"]',
    ) as HTMLIFrameElement | null;
    return frame?.contentWindow?.location.href ?? null;
  });
  expect(canvasUrl).toBe(`${origin}/`);

  // Natural-URL law: no synthetic canvas path, no reserved namespace, no query.
  const parsed = new URL(canvasUrl ?? '');
  expect(parsed.pathname).toBe('/');
  expect(parsed.pathname).not.toContain('__astroix');
  expect(parsed.search).toBe('');

  // Direct same-origin DOM access into the live document — the fixture's own content.
  const heroTitle = await page.evaluate(() => {
    const frame = document.querySelector(
      '[data-testid="canvas-frame"]',
    ) as HTMLIFrameElement | null;
    return frame?.contentDocument?.querySelector('.hero-title')?.textContent ?? null;
  });
  expect(heroTitle).toBe('Astroix fixture');

  // The shell surfaces the same observed URL.
  await expect(page.getByTestId('canvas-url')).toHaveText(`${origin}/`);
  await expect(canvas(page).locator('.hero-title')).toHaveText('Astroix fixture');

  // Restore the idle state for the next leg.
  await page.getByTestId('deactivate').click();
  await page.waitForURL(LAUNCHER_APP_URL);
  await expect(page.getByTestId('session-label')).toHaveText('idle');
});

test('navigation follows natural routes and every load is observed', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);
  const origin = new URL(page.url()).origin;
  await expect(page.getByTestId('canvas-url')).toHaveText(`${origin}/`);

  // The canvas's own address control navigates a natural route.
  await page.getByTestId('canvas-address').fill('/blog/hello-builder');
  await page.getByTestId('canvas-navigate').click();
  await expect(page.getByTestId('canvas-url')).toHaveText(`${origin}/blog/hello-builder`);
  await expect(canvas(page).locator('.blog-title')).toHaveText('Hello builder');

  // The observed URL is still the project's own: natural path, no query.
  const observed = new URL((await page.getByTestId('canvas-url').textContent()) ?? '');
  expect(observed.pathname).toBe('/blog/hello-builder');
  expect(observed.search).toBe('');

  // A page-native navigation (the page's own location API — the same
  // path an in-page link takes) is observed too.
  await canvasFrame(page).evaluate(() => {
    location.assign('/');
  });
  await expect(page.getByTestId('canvas-url')).toHaveText(`${origin}/`);
  await expect(canvas(page).locator('.hero-title')).toHaveText('Astroix fixture');

  // Restore the idle state for the next leg.
  await page.getByTestId('deactivate').click();
  await page.waitForURL(LAUNCHER_APP_URL);
  await expect(page.getByTestId('session-label')).toHaveText('idle');
});

test('selection matches scoped runtime selectors through Element.matches and survives reloads', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);
  await expect(page.getByTestId('canvas-origin-state')).toHaveText('project');
  await expect(page.getByTestId('canvas-selection-mode')).toHaveText('selection: on');

  // Click the scoped-styled element inside the canvas: the click is
  // captured (no navigation), the identity lands, and the matched list
  // carries the SCOPED effective form the compiler emitted verbatim.
  await canvas(page).locator('.hero-title').click();
  await expect(page.getByTestId('selection-tag')).toHaveText('h1');
  await expect(
    page
      .getByTestId('selection-matches')
      .locator("li[data-match-selector^='.hero-title[data-astro-cid-']"),
  ).toHaveCount(1);
  // …the GLOBAL form from the imported sheet: two plain occurrences
  // plus the media-conditioned one (same selector string, its condition
  // carried by the media attribute).
  await expect(
    page.getByTestId('selection-matches').locator('li[data-match-selector=".hero-title"]'),
  ).toHaveCount(3);
  await expect(
    page
      .getByTestId('selection-matches')
      .locator('li[data-match-selector=".hero-title"][data-match-media=""]'),
  ).toHaveCount(2);
  // …and the media-conditioned occurrence, its condition surfaced.
  const media = page
    .getByTestId('selection-matches')
    .locator('li[data-match-media="(max-width: 640px)"]');
  await expect(media).toHaveCount(1);
  await expect(media).toHaveAttribute('data-match-selector', '.hero-title');

  // A differently-shaped element matches through the same law: the
  // global .hero-lead rule matches, no foreign scoped form does.
  await canvas(page).locator('.hero-lead').click();
  await expect(page.getByTestId('selection-tag')).toHaveText('p');
  await expect(
    page.getByTestId('selection-matches').locator('li[data-match-selector=".hero-lead"]'),
  ).toHaveCount(1);
  await expect(
    page.getByTestId('selection-matches').locator("li[data-match-selector*='data-astro-cid']"),
  ).toHaveCount(0);

  // Persistence: reselect the title, then RELOAD the canvas document —
  // the identity re-finds the element in the rebuilt DOM and the
  // runtime selectors re-match (the reload was eligible).
  await canvas(page).locator('.hero-title').click();
  await expect(page.getByTestId('selection-tag')).toHaveText('h1');
  await canvasFrame(page).evaluate(() => {
    location.reload();
  });
  await expect(page.getByTestId('canvas-url')).toHaveText(/\/$/);
  await expect(page.getByTestId('selection-tag')).toHaveText('h1');
  await expect(
    page
      .getByTestId('selection-matches')
      .locator("li[data-match-selector^='.hero-title[data-astro-cid-']"),
  ).toHaveCount(1);
  await expect(
    page.getByTestId('selection-matches').locator('li[data-match-selector=".hero-title"]'),
  ).toHaveCount(3);

  // Restore the idle state for the next leg.
  await page.getByTestId('deactivate').click();
  await page.waitForURL(LAUNCHER_APP_URL);
  await expect(page.getByTestId('session-label')).toHaveText('idle');
});

test('stock Vite HMR rides the proxied native websocket, updates the canvas without a reload, and selection survives', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const websockets: string[] = [];
  page.on('websocket', (socket) => {
    websockets.push(socket.url());
  });
  const frameNavigations: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame.parentFrame() !== null) frameNavigations.push(frame.url());
  });

  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);
  const origin = new URL(page.url()).origin;
  await expect(page.getByTestId('canvas-url')).toHaveText(`${origin}/`);

  // Settle past the fresh dev server's one post-connect self-reload
  // (its initial content-scan invalidation lands right after the first
  // client connect — the project's own behavior, nothing to do with the
  // mutation below) so the no-navigation assertion measures only the
  // HMR leg.
  await page.waitForTimeout(3000);
  frameNavigations.length = 0;

  // The canvas page's own HMR websocket: vite's native path on the
  // PROJECT origin (the transparent proxy tunnels it — never the dev
  // server's internal port), vite's own handshake query intact, and no
  // Astroix bridge anywhere: no socket the page opens touches the
  // reserved namespace.
  await expect
    .poll(
      () => websockets.filter((url) => url.startsWith(`ws://${new URL(origin).host}/`)).length,
      {
        timeout: 30_000,
      },
    )
    .toBeGreaterThan(0);
  const hmrSocket = websockets.find((url) => url.startsWith(`ws://${new URL(origin).host}/`));
  expect(hmrSocket).toBeDefined();
  expect(hmrSocket).toMatch(/token=/);
  expect(websockets.some((url) => url.includes('__astroix'))).toBe(false);

  // Select before the mutation.
  await canvas(page).locator('.hero-title').click();
  await expect(page.getByTestId('selection-tag')).toHaveText('h1');

  const heroTitleRows = page
    .getByTestId('selection-matches')
    .locator('li[data-match-selector=".hero-title"]');
  await expect(heroTitleRows).toHaveCount(3);

  // Mutate the DISPOSABLE copy's imported sheet (restored in finally):
  // stock vite CSS HMR lands the new declaration as a hot style update.
  const cssPath = join(stagedCopyRoot('project-a'), 'src', 'pages', 'home.css');
  const originalCss = await readFile(cssPath, 'utf8');
  try {
    await writeFile(cssPath, `${originalCss}\n.hero-title { text-decoration: underline; }\n`);
    await expect(canvas(page).locator('.hero-title')).toHaveCSS(
      'text-decoration-line',
      'underline',
    );
    // No document load happened — the update was hot, not a reload.
    expect(frameNavigations).toEqual([]);
    // The selection survived the reindex-shaped change and the matched
    // list re-ran against the document's updated rules: the new
    // occurrence of the global selector is matched now.
    await expect(page.getByTestId('selection-tag')).toHaveText('h1');
    await expect(heroTitleRows).toHaveCount(4);

    // A template edit is vite's FULL-reload path — the vite-driven
    // eligible reload: the probe appears, and the selection survives it too.
    const astroPath = join(stagedCopyRoot('project-a'), 'src', 'pages', 'index.astro');
    const originalAstro = await readFile(astroPath, 'utf8');
    await writeFile(
      astroPath,
      originalAstro.replace(
        '<section class="hero">',
        '<section class="hero"><p data-hmr-probe>probe</p>',
      ),
    );
    await expect(canvas(page).locator('[data-hmr-probe]')).toHaveCount(1);
    await expect(page.getByTestId('selection-tag')).toHaveText('h1');
    await expect(
      page
        .getByTestId('selection-matches')
        .locator("li[data-match-selector^='.hero-title[data-astro-cid-']"),
    ).toHaveCount(1);
    await writeFile(astroPath, originalAstro);
  } finally {
    // The canonical bytes go back — the zero-injection spec that
    // follows re-proves it with its own snapshot.
    await writeFile(cssPath, originalCss);
  }

  // Restore the idle state for the next leg.
  await page.getByTestId('deactivate').click();
  await page.waitForURL(LAUNCHER_APP_URL);
  await expect(page.getByTestId('session-label')).toHaveText('idle');
});

test('an off-origin canvas stays visible with inspection disabled until it returns', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);
  await expect(page.getByTestId('canvas-origin-state')).toHaveText('project');

  // A live selection exists while on the project origin.
  await canvas(page).locator('.hero-title').click();
  await expect(page.getByTestId('selection-tag')).toHaveText('h1');
  await expect(page.getByTestId('canvas-inspection')).toHaveText('enabled');

  // The fixture's CTA points off-origin; fulfill it locally (no
  // network) — the canvas navigates to a genuinely foreign origin.
  await page.route(/astro\.build/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><p>external document</p></body></html>',
    }),
  );

  // Selection mode OFF so the link click navigates the canvas.
  await page.getByTestId('canvas-selection-mode').click();
  await expect(page.getByTestId('canvas-selection-mode')).toHaveText('selection: off');
  await canvas(page).locator('.hero-cta').click();

  // Off-origin: the foreign document stays VISIBLE, inspection and
  // editing are disabled, the selection is gone, and the selection
  // control is unusable until the canvas returns.
  await expect(page.getByTestId('canvas-origin-state')).toHaveText('external');
  await expect(page.getByTestId('canvas-inspection')).toHaveText('disabled');
  await expect(page.getByTestId('selection-tag')).toHaveText('none');
  await expect(page.getByTestId('selection-matches').locator('li')).toHaveCount(0);
  await expect(page.getByTestId('canvas-selection-mode')).toBeDisabled();
  await expect(canvas(page).locator('body')).toContainText('external document');

  // Return through the canvas's own navigation: the gate reopens, the
  // selection control becomes usable again, and selection works.
  await page.getByTestId('canvas-address').fill('/');
  await page.getByTestId('canvas-navigate').click();
  await expect(page.getByTestId('canvas-origin-state')).toHaveText('project');
  await expect(page.getByTestId('canvas-inspection')).toHaveText('enabled');
  await expect(page.getByTestId('canvas-selection-mode')).toBeEnabled();
  await page.getByTestId('canvas-selection-mode').click();
  await expect(page.getByTestId('canvas-selection-mode')).toHaveText('selection: on');
  await canvas(page).locator('.hero-title').click();
  await expect(page.getByTestId('selection-tag')).toHaveText('h1');

  await page.unroute(/astro\.build/);
  // Restore the idle state for whatever follows the battery.
  await page.getByTestId('deactivate').click();
  await page.waitForURL(LAUNCHER_APP_URL);
  await expect(page.getByTestId('session-label')).toHaveText('idle');
});
