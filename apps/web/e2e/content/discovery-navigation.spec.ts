import { expect, type Page, type Request, test } from '@playwright/test';
import { activateButton, PROJECT_APP_URL, restoreIdle } from '../../../../e2e/web/spec-helpers.ts';

/**
 * The Content vertical's discovery-navigation product E2E (#251, J1):
 * the sidebar's discovery panel and the navigation slice against the
 * REAL control-plane composition — the live E4 content inspection (the
 * staged plain fixture's own collections), the live E5 routes
 * inspection (its own route patterns and enumeration), and the canvas
 * navigated to the natural project URLs those payloads resolve.
 *
 * The panel's truth is the frozen behavior contracts' own corpus for
 * this same fixture (collections, routes, route-resolution): the four
 * served collections, the nested-id folders, the unrouted markers on
 * exactly showcase/index/scratch, and the candidate spellings — the
 * nested id through the catch-all, the flat id through the segment
 * param. Raw source paths never surface anywhere in the panel.
 *
 * The canonical fixture is READ-ONLY here (the ticket's migration
 * policy): every leg reads the staged disposable copy through the
 * booted control plane; no file is touched, and the restore tail
 * returns the host to the idle state for whatever follows.
 *
 * SERIAL like the lane's other batteries: one control plane, one
 * supervisor-global active session.
 */

/** The discovery panel's root, at a given derived state. */
function discoveryPanel(page: Page) {
  return page.locator('[data-astroix-content-discovery]');
}

test.describe.configure({ mode: 'serial' });

test('discovery lists the fixture collections and entries from the live content and routes inspections', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);

  // The panel's data source is the wire: one content inspection and one
  // routes inspection under the bound pair — E4 and E5, nothing else.
  const inspectionFamilies = new Set<string>();
  page.on('request', (request: Request) => {
    if (!request.url().endsWith('/__astroix/api/v1')) return;
    const body = request.postDataJSON() as {
      command?: { kind?: string; request?: { kind?: string } };
    };
    if (body?.command?.kind === 'inspect' && body.command.request?.kind) {
      inspectionFamilies.add(body.command.request.kind);
    }
  });

  // First content inspection boots a fresh runner over the managed dev
  // server — generous bound, then the settled ready state.
  await expect
    .poll(() => discoveryPanel(page).getAttribute('data-discovery-status'), { timeout: 60_000 })
    .toBe('ready');
  expect(inspectionFamilies.has('content')).toBe(true);
  expect(inspectionFamilies.has('routes')).toBe(true);

  // The frozen collections corpus's served truth: name-sorted sections,
  // nested ids under year folders, flat ids bare.
  const sections = discoveryPanel(page).locator('[data-astroix-collection]');
  await expect(sections).toHaveCount(4);
  const servedNames = ['blog', 'gallery', 'homepage', 'notes'];
  for (const [index, name] of servedNames.entries()) {
    await expect(sections.nth(index)).toHaveAttribute('data-astroix-collection', name);
  }

  const blog = sections.nth(0);
  await expect(blog.locator('[data-astroix-entry="2024/post"]')).toHaveCount(1);
  await expect(blog.locator('[data-astroix-entry="2025/release-notes"]')).toHaveCount(1);
  await expect(blog.locator('[data-astroix-entry="hello-builder"]')).toHaveCount(1);
  await expect(blog.locator('[data-astroix-tree-folder="blog/2024"]')).toHaveCount(1);

  // The unrouted markers — exactly the frozen route-resolution corpus's
  // unrouted rows (gallery/showcase, homepage+notes/index, notes/scratch).
  const panelText = await discoveryPanel(page).textContent();
  for (const entryId of ['showcase', 'index', 'scratch']) {
    const row = discoveryPanel(page).locator(`[data-astroix-entry="${entryId}"]`);
    await expect(row).toHaveCount(entryId === 'index' ? 2 : 1);
    await expect(row.first()).toHaveAttribute('data-astroix-entry-unrouted', 'true');
  }
  await expect(
    discoveryPanel(page).locator('[data-astroix-entry="2024/post"]'),
  ).not.toHaveAttribute('data-astroix-entry-unrouted');

  // Raw source paths never surface — ids and collection names only.
  expect(panelText).not.toContain('src/content');
  expect(panelText).not.toContain('.md');

  // Restore the idle state for the next leg.
  await restoreIdle(page);
});

test('selecting a nested-id entry navigates the canvas to its natural route', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);
  const origin = new URL(page.url()).origin;
  await expect(discoveryPanel(page)).toHaveAttribute('data-discovery-status', 'ready');
  await expect(page.getByTestId('canvas-url')).toHaveText(`${origin}/`);

  // The frozen resolution contract's candidate for the nested id: the
  // catch-all spelling /blog/2024/post — resolved from E5's payload,
  // never composed from the entry's source path.
  await discoveryPanel(page).locator('[data-astroix-entry="2024/post"]').click();
  await expect(page.getByTestId('canvas-url')).toHaveText(`${origin}/blog/2024/post`, {
    timeout: 60_000,
  });
  // The canvas rendered the entry's own page — the project's own route,
  // on the shared project origin, the gate still open.
  await expect(page.getByTestId('canvas-origin-state')).toHaveText('project');
  await expect(page.frameLocator('[data-testid="canvas-frame"]').locator('.blog-title')).toHaveText(
    'Nested post',
  );

  // The navigation feedback and the active-entry highlight.
  await expect(page.getByTestId('navigation-feedback')).toHaveText('navigated to /blog/2024/post');
  await expect(discoveryPanel(page).locator('[data-astroix-entry="2024/post"]')).toHaveAttribute(
    'data-active',
    'true',
  );

  // Restore the idle state for the next leg.
  await restoreIdle(page);
});

test('the flat blog id takes the segment-param spelling over the catch-all', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);
  const origin = new URL(page.url()).origin;
  await expect(discoveryPanel(page)).toHaveAttribute('data-discovery-status', 'ready');

  // The plurality rule: hello-builder fills both patterns; the picker
  // takes the more specific segment param — /blog/hello-builder.
  await discoveryPanel(page).locator('[data-astroix-entry="hello-builder"]').click();
  await expect(page.getByTestId('canvas-url')).toHaveText(`${origin}/blog/hello-builder`, {
    timeout: 60_000,
  });
  await expect(page.frameLocator('[data-testid="canvas-frame"]').locator('.blog-title')).toHaveText(
    'Hello builder',
  );

  // Restore the idle state for the next leg.
  await restoreIdle(page);
});

test('an unrouted entry click navigates nothing and reports the legend', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);
  const origin = new URL(page.url()).origin;
  await expect(discoveryPanel(page)).toHaveAttribute('data-discovery-status', 'ready');
  await expect(page.getByTestId('canvas-url')).toHaveText(`${origin}/`);

  // notes/scratch has no route in E5's payload: the click selects the
  // row, reports the legend, and the canvas stays exactly where it was.
  await discoveryPanel(page).locator('[data-astroix-entry="scratch"]').click();
  await expect(page.getByTestId('navigation-feedback')).toHaveText('no route renders scratch');
  await expect(page.getByTestId('canvas-url')).toHaveText(`${origin}/`);
  await expect(page.getByTestId('canvas-origin-state')).toHaveText('project');

  // Restore the idle state for whatever follows the battery.
  await restoreIdle(page);
});
