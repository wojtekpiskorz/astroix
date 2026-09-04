import { expect, type Page, type Request, test } from '@playwright/test';
import {
  activateButton,
  BOOT_BUDGET_MS,
  LOAD_BUDGET_MS,
  PROJECT_APP_URL,
  restoreIdle,
  SETTLE_BUDGET_MS,
} from '../../../../e2e/web/spec-helpers.ts';

/**
 * The Content vertical's forms-raw-validation product E2E (#252, J2):
 * the editor dock's entry-form pane against the REAL control-plane
 * composition — the live E4 content inspection carrying the fixture's
 * own walked schema trees and inspected values, the retained form
 * widgets rendering them, the explicit raw representation beside them,
 * and the deterministic validation report — all WITHOUT writing.
 *
 * The pane's truth is the frozen behavior contracts' corpus for the
 * same fixture (collections + content-schemas): the blog walk's widget
 * kinds, the projection's inspected values, the schema-less notes
 * degradation. The wire listener pins the migration policy's law for
 * the whole battery: every POST the pane ever dispatches is an inspect
 * — no write endpoint exists, none is invented.
 *
 * The canonical fixture is READ-ONLY here: no file is touched, no
 * mutation command crosses the wire, and the restore tail returns the
 * host to the idle state for whatever follows.
 *
 * SERIAL like the lane's other batteries: one control plane, one
 * supervisor-global active session.
 *
 * Every landing/transition wait is load-shaped (#396, the #392 pass
 * extended to this battery): the shared activation prefix carries the
 * 30s landing and 120s plane-boot budgets, the pane's first inspection
 * the 60s settle budget, and the render/wire-shaped expects (the
 * no-entry landing, the widget counts, the revision, the intent
 * states) the 30s landing budget. The asserted values never change.
 */

/** The entry-form pane's root, at a given derived state. */
function pane(page: Page) {
  return page.locator('[data-astroix-entry-form]');
}

/** The sidebar's entry row (the navigation slice's selection gesture). */
function entryRow(page: Page, entryId: string) {
  return page.locator(`[data-astroix-entry="${entryId}"]`);
}

/** The title widget's input inside the form. */
function titleInput(page: Page) {
  return pane(page).locator('[data-astroix-form-field="title"] input');
}

/** The raw pane's textarea. */
function rawText(page: Page) {
  return pane(page).locator('[data-astroix-raw-text]');
}

/**
 * Installs the battery's wire listener: captures every api POST's
 * command kind. The legal set is the read/lifecycle vocabulary
 * (`inspect`, `activate`, `deactivate`, `list-projects` — the page's
 * own session machinery); the write vocabulary (`apply-edit` and
 * anything else the protocol might grow) is the migration policy's
 * law: the pane NEVER dispatches it.
 */
function captureCommands(page: Page): () => { inspects: number; writes: string[] } {
  const legal = new Set(['inspect', 'activate', 'deactivate', 'list-projects']);
  const commandKinds: string[] = [];
  page.on('request', (request: Request) => {
    if (!request.url().endsWith('/__astroix/api/v1')) return;
    if (request.method() !== 'POST') return;
    const body = request.postDataJSON() as { command?: { kind?: string } };
    if (typeof body?.command?.kind === 'string') commandKinds.push(body.command.kind);
  });
  return () => ({
    inspects: commandKinds.filter((kind) => kind === 'inspect').length,
    writes: commandKinds.filter((kind) => !legal.has(kind)),
  });
}

/** Activates the first staged fixture copy and lands the project document. */
async function activateProject(page: Page): Promise<void> {
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL, { timeout: BOOT_BUDGET_MS });
}

test.describe.configure({ mode: 'serial' });

test('the pane builds form state from the live schema and inspected values', async ({ page }) => {
  test.setTimeout(240_000);
  const commands = captureCommands(page);
  await activateProject(page);

  // no entry open: the honest empty state, then the first content
  // inspection boots a fresh runner over the managed dev server
  await expect(pane(page)).toHaveAttribute('data-form-status', 'no-entry', {
    timeout: LOAD_BUDGET_MS,
  });
  await entryRow(page, 'hello-builder').click();
  await expect(pane(page)).toHaveAttribute('data-form-status', 'ready', {
    timeout: SETTLE_BUDGET_MS,
  });
  await expect(pane(page)).toHaveAttribute('data-form-mode', 'form');

  // the frozen blog walk over the live inspection: every widget kind
  // renders from the inspected values (the projection)
  await expect(titleInput(page)).toHaveValue('Hello builder');
  await expect(pane(page).locator('[data-astroix-form-field="tone"]')).toHaveCount(1, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(pane(page).locator('[data-astroix-form-field="priority"] input')).toHaveCount(1, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(pane(page).locator('[data-astroix-form-field="featured"]')).toHaveCount(1, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(pane(page).locator('[data-astroix-form-field="tags.0"]')).toHaveCount(1, {
    timeout: LOAD_BUDGET_MS,
  });
  // the unsupported shapes ride the raw-field convention (date, aside)
  await expect(
    pane(page).locator('[data-astroix-raw-field="date"][data-astroix-raw-reason="date"]'),
  ).toHaveCount(1, { timeout: LOAD_BUDGET_MS });
  await expect(
    pane(page).locator('[data-astroix-raw-field="aside"][data-astroix-raw-reason="union"]'),
  ).toHaveCount(1, { timeout: LOAD_BUDGET_MS });
  // the inspected revision carries into the header (a live SHA-256)
  await expect(page.getByTestId('entry-revision')).toHaveText(/^revision: [0-9a-f]{12}…$/, {
    timeout: LOAD_BUDGET_MS,
  });

  // the untouched draft has nothing to write
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'none', {
    timeout: LOAD_BUDGET_MS,
  });

  // the gallery entry renders its image metadata read-only (the
  // contract-backed image widget over the projection)
  await entryRow(page, 'showcase').click();
  await expect(pane(page).locator('[data-astroix-image-field="meta"]')).toHaveCount(1, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(pane(page).locator('[data-astroix-image-field="meta"]')).toContainText('pixel', {
    timeout: LOAD_BUDGET_MS,
  });

  // the wire law: everything the pane dispatched was an inspection
  const report = commands();
  expect(report.inspects).toBeGreaterThan(0);
  expect(report.writes).toEqual([]);

  await restoreIdle(page);
});

test('form and raw switch preserves everything, and validation reports without writing', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const commands = captureCommands(page);
  await activateProject(page);
  await entryRow(page, 'hello-builder').click();
  await expect(pane(page)).toHaveAttribute('data-form-status', 'ready', {
    timeout: SETTLE_BUDGET_MS,
  });

  // a form edit, then into raw: the text is the CURRENT values
  await titleInput(page).fill('Form edit');
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'ready', {
    timeout: LOAD_BUDGET_MS,
  });
  await pane(page).locator('[data-astroix-form-mode-button="raw"]').click();
  await expect(pane(page)).toHaveAttribute('data-form-mode', 'raw');
  await expect(rawText(page)).toHaveValue(/title: Form edit/);
  await expect(rawText(page)).toHaveValue(/tone: bold/);

  // a raw edit of a known key AND an unknown key, then back to form
  await rawText(page).fill(
    'title: Raw edit\ndate: 2026-08-26T00:00:00.000Z\ntags:\n  - meta\ntone: bold\npriority: 0\nfeatured: false\nfromRaw: true\n',
  );
  await pane(page).locator('[data-astroix-form-mode-button="form"]').click();
  await expect(titleInput(page)).toHaveValue('Raw edit');
  // the raw-added unknown key rides the explicit unknown-fields section
  await expect(pane(page).locator('[data-astroix-unknown-fields]')).toHaveCount(1);
  await expect(pane(page).locator('[data-astroix-raw-field="__unknown__"]')).toContainText(
    'fromRaw: true',
  );

  // the validated intent is READY and carries the inspected baseline
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'ready', {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.getByTestId('edit-intent')).toContainText('"revision"');

  // a parse break: the diagnostic reports, the draft keeps its values,
  // the intent blocks — and nothing ever leaves the document
  await pane(page).locator('[data-astroix-form-mode-button="raw"]').click();
  await rawText(page).fill('title: "unterminated');
  await expect(pane(page).locator('[data-issue-kind="parse"]')).toHaveCount(1);
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'invalid', {
    timeout: LOAD_BUDGET_MS,
  });
  // recovery: a complete document (the required title and date present)
  await rawText(page).fill('title: fixed\ndate: 2026-08-26T00:00:00.000Z');
  await expect(pane(page).locator('[data-issue-kind="parse"]')).toHaveCount(0);
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'ready', {
    timeout: LOAD_BUDGET_MS,
  });

  const report = commands();
  expect(report.writes).toEqual([]);

  await restoreIdle(page);
});

test('drafts reset on entry change and on a new session — never on the server', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const commands = captureCommands(page);
  await activateProject(page);
  await entryRow(page, 'hello-builder').click();
  await expect(pane(page)).toHaveAttribute('data-form-status', 'ready', {
    timeout: SETTLE_BUDGET_MS,
  });

  // edit the draft, then change the ENTRY: the edit dies with the selection
  await titleInput(page).fill('DOOMED EDIT');
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'ready', {
    timeout: LOAD_BUDGET_MS,
  });
  await entryRow(page, '2024/post').click();
  await expect(titleInput(page)).toHaveValue('Nested post');
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'none', {
    timeout: LOAD_BUDGET_MS,
  });
  // back to the first entry: the inspected truth, never the dead draft
  await entryRow(page, 'hello-builder').click();
  await expect(titleInput(page)).toHaveValue('Hello builder');
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'none', {
    timeout: LOAD_BUDGET_MS,
  });

  // a NEW SESSION (deactivate + activate = a fresh generation): the new
  // document's pane opens on the inspected truth, inheriting nothing
  await restoreIdle(page);
  await activateProject(page);
  await entryRow(page, 'hello-builder').click();
  await expect(pane(page)).toHaveAttribute('data-form-status', 'ready', {
    timeout: SETTLE_BUDGET_MS,
  });
  await expect(titleInput(page)).toHaveValue('Hello builder');
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'none', {
    timeout: LOAD_BUDGET_MS,
  });

  // the whole battery wrote nothing: every exchange was an inspection
  const report = commands();
  expect(report.inspects).toBeGreaterThan(0);
  expect(report.writes).toEqual([]);

  await restoreIdle(page);
});
