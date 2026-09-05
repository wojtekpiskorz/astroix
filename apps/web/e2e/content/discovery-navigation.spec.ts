import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, type Request, test } from '@playwright/test';
import {
  activateProject,
  LOAD_BUDGET_MS,
  restoreIdle,
  SETTLE_BUDGET_MS,
} from '../../../../e2e/web/spec-helpers.ts';
import { stagedCopyRoot } from '../../src/stage-e2e.ts';

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
 * booted control plane; no file outside the STAGED copy is ever
 * touched — the #387 leg (the fifth) writes into the staged copy
 * itself, out-of-band, and its tail restores the staged bytes (the
 * css battery's disclosure idiom) — and the restore tail returns
 * the host to the idle state for whatever follows.
 *
 * SERIAL like the lane's other batteries: one control plane, one
 * supervisor-global active session.
 *
 * Every landing/transition wait is load-shaped (#396, the #392 pass
 * extended to this battery): the launcher's first render and the
 * project-document landings carry the 30s landing budget, the
 * activation transition the 120s plane-boot budget, and the settles
 * over the young managed dev server (the first inspection's fresh
 * runner, the canvas's first route compile) the 60s settle budget.
 * The asserted values never change.
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

  // The panel's data source is the wire: one content inspection and one
  // routes inspection under the bound pair — E4 and E5, nothing else.
  // The listener attaches BEFORE activation: the shell mounts with the
  // project document, so the queries may fire the moment it lands.
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

  await activateProject(page);

  // First content inspection boots a fresh runner over the managed dev
  // server — generous bound, then the settled ready state.
  await expect
    .poll(() => discoveryPanel(page).getAttribute('data-discovery-status'), {
      timeout: SETTLE_BUDGET_MS,
    })
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
  await activateProject(page);
  const origin = new URL(page.url()).origin;
  await expect(discoveryPanel(page)).toHaveAttribute('data-discovery-status', 'ready', {
    timeout: SETTLE_BUDGET_MS,
  });
  await expect(page.getByTestId('canvas-url')).toHaveText(`${origin}/`, {
    timeout: LOAD_BUDGET_MS,
  });

  // The frozen resolution contract's candidate for the nested id: the
  // catch-all spelling /blog/2024/post — resolved from E5's payload,
  // never composed from the entry's source path.
  await discoveryPanel(page).locator('[data-astroix-entry="2024/post"]').click();
  await expect(page.getByTestId('canvas-url')).toHaveText(`${origin}/blog/2024/post`, {
    timeout: SETTLE_BUDGET_MS,
  });
  // The canvas rendered the entry's own page — the project's own route,
  // on the shared project origin, the gate still open.
  await expect(page.getByTestId('canvas-origin-state')).toHaveText('project', {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.frameLocator('[data-testid="canvas-frame"]').locator('.blog-title')).toHaveText(
    'Nested post',
    { timeout: LOAD_BUDGET_MS },
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
  await activateProject(page);
  const origin = new URL(page.url()).origin;
  await expect(discoveryPanel(page)).toHaveAttribute('data-discovery-status', 'ready', {
    timeout: SETTLE_BUDGET_MS,
  });

  // The plurality rule: hello-builder fills both patterns; the picker
  // takes the more specific segment param — /blog/hello-builder.
  await discoveryPanel(page).locator('[data-astroix-entry="hello-builder"]').click();
  await expect(page.getByTestId('canvas-url')).toHaveText(`${origin}/blog/hello-builder`, {
    timeout: SETTLE_BUDGET_MS,
  });
  await expect(page.frameLocator('[data-testid="canvas-frame"]').locator('.blog-title')).toHaveText(
    'Hello builder',
    { timeout: LOAD_BUDGET_MS },
  );

  // Restore the idle state for the next leg.
  await restoreIdle(page);
});

test('an unrouted entry click navigates nothing and reports the legend', async ({ page }) => {
  test.setTimeout(180_000);
  await activateProject(page);
  const origin = new URL(page.url()).origin;
  await expect(discoveryPanel(page)).toHaveAttribute('data-discovery-status', 'ready', {
    timeout: SETTLE_BUDGET_MS,
  });
  await expect(page.getByTestId('canvas-url')).toHaveText(`${origin}/`, {
    timeout: LOAD_BUDGET_MS,
  });

  // notes/scratch has no route in E5's payload: the click selects the
  // row, reports the legend, and the canvas stays exactly where it was.
  await discoveryPanel(page).locator('[data-astroix-entry="scratch"]').click();
  await expect(page.getByTestId('navigation-feedback')).toHaveText('no route renders scratch');
  await expect(page.getByTestId('canvas-url')).toHaveText(`${origin}/`, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.getByTestId('canvas-origin-state')).toHaveText('project', {
    timeout: LOAD_BUDGET_MS,
  });

  // Restore the idle state for whatever follows the battery.
  await restoreIdle(page);
});

test('an out-of-band content edit refreshes the open panel — the content-family invalidation push (#387)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  // The battery's one write to the staged copy — the css battery's
  // invalidation-leg idiom, on the content truth: a NEW entry file
  // lands out-of-band (no client gesture anywhere), the worker's
  // widened raw stream mints it, the published frame carries the
  // content family, and the SSE→query bridge refetches the content
  // and routes keys. Before #387 the same edit published a styles-only
  // family set and NO content-family refetch ever crossed the wire
  // (the #253 write loop's polling covered only the app's OWN writes).
  const entryPath = join(stagedCopyRoot('project-a'), 'src/content/notes/out-of-band.md');
  const inspectionCounts: Record<string, number> = { content: 0, routes: 0, styles: 0 };
  page.on('request', (request: Request) => {
    if (!request.url().endsWith('/__astroix/api/v1')) return;
    const body = request.postDataJSON() as {
      command?: { kind?: string; request?: { kind?: string } };
    };
    const family = body?.command?.request?.kind;
    if (body?.command?.kind === 'inspect' && typeof family === 'string') {
      inspectionCounts[family] = (inspectionCounts[family] ?? 0) + 1;
    }
  });
  await activateProject(page);
  await expect(discoveryPanel(page)).toHaveAttribute('data-discovery-status', 'ready', {
    timeout: SETTLE_BUDGET_MS,
  });
  await expect(discoveryPanel(page).locator('[data-astroix-entry="out-of-band"]')).toHaveCount(0);
  const contentBefore = inspectionCounts.content ?? 0;
  const routesBefore = inspectionCounts.routes ?? 0;

  // The notes collection is schema-less: minimal frontmatter serves.
  // The push is the assertion's first half: the content AND routes
  // families refetch over the wire after the edit — the frame's exact
  // family set, red the moment the styles-only fallback returns.
  await writeFile(entryPath, '---\nkind: out-of-band\n---\n\nAn out-of-band note.\n');
  try {
    await expect
      .poll(() => (inspectionCounts.content ?? 0) - contentBefore, { timeout: SETTLE_BUDGET_MS })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => (inspectionCounts.routes ?? 0) - routesBefore, { timeout: SETTLE_BUDGET_MS })
      .toBeGreaterThanOrEqual(1);

    // The second half — the refreshed panel — rides the SAME cadence
    // the write loop documents for its own landing gate: the served
    // projection trails the file write by the content layer's own
    // watcher sync, so the first push's refetch can read the pre-edit
    // listing (a torn truth the loop never reopens on). A settle
    // window — fixed, because the layer's sync has no observable this
    // side of the wire — then a second out-of-band nudge to the same
    // file mints another content-family push over the settled layer,
    // and its refetch lands the row: convergence under repeated
    // pushes, the honest product promise today (per-push
    // convergence-retry is not a landed mechanism).
    await page.waitForTimeout(2000);
    await writeFile(
      entryPath,
      '---\nkind: out-of-band\npinned: true\n---\n\nAn out-of-band note.\n',
    );
    await expect(discoveryPanel(page).locator('[data-astroix-entry="out-of-band"]')).toHaveCount(
      1,
      { timeout: SETTLE_BUDGET_MS },
    );
  } finally {
    await rm(entryPath, { force: true });
  }

  // Restore the idle state for the next battery.
  await restoreIdle(page);
});
