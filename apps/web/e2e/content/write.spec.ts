import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, type Request, test } from '@playwright/test';
import { activateButton, PROJECT_APP_URL, restoreIdle } from '../../../../e2e/web/spec-helpers.ts';
import { parseEntryDraft, serializeEntry } from '../../../../packages/core/src/entry-writer.ts';
import { stagedCopyRoot } from '../../src/stage-e2e.ts';

/**
 * The Content vertical's grant-bound write battery (#253, J3): the
 * write loop against the REAL control-plane composition — the enriched
 * content inspection carrying opaque grants and raw truth, the D4
 * planning boundary, the F5 fence, and the REAL D5 write-executor child
 * writing the STAGED copy's bytes (the canonical fixture itself is
 * never touched — the staged copies are disposable and restored by the
 * lane's teardown).
 *
 * The byte-exactness law: every written file's bytes are compared
 * against the SAME pure oracle the frozen edit contracts were derived
 * through (core's entry-writer over the inspected raw baseline), so a
 * drift from the corpus's behavior is a defect, not a diff.
 *
 * The wire law: every apply-edit the battery dispatches carries an
 * opaque grant and no filesystem path (the plan's display path is the
 * UI-only project-relative form).
 *
 * SERIAL like the lane's other batteries: one control plane, one
 * supervisor-global active session.
 */

/** The staged copy the battery writes into (registered first — position 0). */
const PROJECT_A = stagedCopyRoot('project-a');
/** The entry file the battery edits. */
const ENTRY_FILE = join(PROJECT_A, 'src/content/blog/hello-builder.md');

/** The pane's root. */
function pane(page: Page) {
  return page.locator('[data-astroix-entry-form]');
}

/** The sidebar's entry row. */
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

/** The write gesture and its state surface. */
function writeButton(page: Page) {
  return page.getByTestId('write-entry');
}

function writeState(page: Page) {
  return page.getByTestId('write-state');
}

/** One captured api command. */
interface CapturedCommand {
  readonly kind: string;
  readonly body: string;
}

/** Installs the wire listener: every api POST's command kind and body. */
function captureCommands(page: Page): () => {
  inspects: (family: string) => number;
  writes: readonly CapturedCommand[];
} {
  const commands: CapturedCommand[] = [];
  page.on('request', (request: Request) => {
    if (!request.url().endsWith('/__astroix/api/v1')) return;
    if (request.method() !== 'POST') return;
    const body = request.postData() ?? '';
    const kind = (request.postDataJSON() as { command?: { kind?: string } } | null)?.command?.kind;
    if (typeof kind === 'string') commands.push({ kind, body });
  });
  return () => ({
    inspects: (family: string) =>
      commands.filter((command) => command.body.includes(`"kind":"${family}"`)).length,
    writes: commands.filter((command) => command.kind === 'apply-edit'),
  });
}

/** Activates the first staged fixture copy and lands the project document. */
async function activateProject(page: Page): Promise<void> {
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);
}

/** Opens the entry and waits for the pane's ready state. */
async function openEntry(page: Page, entryId: string): Promise<void> {
  await entryRow(page, entryId).click();
  await expect(pane(page)).toHaveAttribute('data-form-status', 'ready', { timeout: 60_000 });
}

/** The file's current bytes — the staged copy's truth. */
async function entryBytes(): Promise<string> {
  return await readFile(ENTRY_FILE, 'utf8');
}

/** The pure oracle's expected bytes for one title edit over the inspected raw baseline. */
function expectedTitleWrite(raw: string, nextTitle: string): string {
  const baseline = parseEntryDraft(raw);
  if (baseline === null) throw new Error('the fixture baseline did not parse');
  return serializeEntry({
    raw,
    baseline,
    draft: { data: { ...(baseline.data as object), title: nextTitle }, body: baseline.body },
    protectedPaths: [],
  });
}

test.describe.configure({ mode: 'serial' });

test('a form write lands byte-exact through the grant, refreshes the pane, and the canvas follows', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const commands = captureCommands(page);
  const routesBefore = { count: -1 };
  await activateProject(page);
  await openEntry(page, 'hello-builder');

  // the canvas rides the entry's own route — the title it renders is
  // the write's observable downstream (Vite HMR reloads it natively);
  // the canvas is the same-origin plain iframe (G3's law), reached
  // through the frame locator
  const canvasTitle = page.frameLocator('[data-testid="canvas-frame"]').locator('h1.blog-title');
  await expect(page.getByTestId('canvas-url')).toHaveText(/\/blog\/hello-builder$/, {
    timeout: 30_000,
  });
  await expect(canvasTitle).toHaveText('Hello builder', { timeout: 30_000 });

  // the untouched draft has nothing to write: the gesture is honestly
  // disabled until an edit makes the intent ready
  const before = await entryBytes();
  await expect(writeButton(page)).toBeDisabled();
  routesBefore.count = commands().inspects('routes');

  await titleInput(page).fill('Hello builder (edited)');
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'ready');
  await expect(writeButton(page)).toBeEnabled();
  await writeButton(page).click();

  // pending → the refresh banner (committed) → the refreshed truth lands
  await expect(writeState(page)).toHaveAttribute('data-write-state', /pending|refresh-required/);
  await expect(writeState(page)).toHaveAttribute('data-write-state', 'refresh-required', {
    timeout: 30_000,
  });
  await expect(writeState(page)).toHaveAttribute('data-write-state', 'idle', { timeout: 30_000 });

  // BYTE-EXACT: the staged file's bytes are the pure oracle's bytes
  const after = await entryBytes();
  expect(after).toBe(expectedTitleWrite(before, 'Hello builder (edited)'));

  // the pane reopened on the served truth: the written title, nothing to write
  await expect(titleInput(page)).toHaveValue('Hello builder (edited)');
  await expect(page.getByTestId('entry-revision')).not.toHaveText(/revision: none/);
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'none');

  // the canvas followed through the project's own HMR
  await expect(canvasTitle).toHaveText('Hello builder (edited)', { timeout: 30_000 });

  // the routes family refetched after the commit (the loop's invalidation)
  expect(commands().inspects('routes')).toBeGreaterThan(routesBefore.count);

  // the wire law: the one write carried a grant, never a path
  const writes = commands().writes;
  expect(writes.length).toBe(1);
  expect(writes[0]?.body).toContain('"grant"');
  expect(writes[0]?.body).not.toMatch(/"(\/Users\/|\/private\/|\/tmp\/|file:\/\/)/);

  await restoreIdle(page);
});

test('a raw write lands through the same grant-bound loop', async ({ page }) => {
  test.setTimeout(300_000);
  const commands = captureCommands(page);
  await activateProject(page);
  await openEntry(page, 'hello-builder');
  const before = await entryBytes();

  // into raw mode: the whole draft as YAML, edited there, written there
  await pane(page).locator('[data-astroix-form-mode-button="raw"]').click();
  await expect(pane(page)).toHaveAttribute('data-form-mode', 'raw');
  const text = await rawText(page).inputValue();
  await rawText(page).fill(
    text.replace('title: Hello builder (edited)', 'title: Raw-written title'),
  );
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'ready');
  await writeButton(page).click();
  await expect(writeState(page)).toHaveAttribute('data-write-state', 'idle', { timeout: 30_000 });

  // BYTE-EXACT: the oracle over the same raw baseline
  const after = await entryBytes();
  const baseline = parseEntryDraft(before);
  if (baseline === null) throw new Error('the fixture baseline did not parse');
  const rawValues = baseline.data as Record<string, unknown>;
  expect(after).toBe(
    serializeEntry({
      raw: before,
      baseline,
      draft: { data: { ...rawValues, title: 'Raw-written title' }, body: baseline.body },
      protectedPaths: [],
    }),
  );
  // back in form mode the served truth shows
  await pane(page).locator('[data-astroix-form-mode-button="form"]').click();
  await expect(titleInput(page)).toHaveValue('Raw-written title');
  expect(commands().writes).toHaveLength(1);

  await restoreIdle(page);
});

test('a stale response cannot overwrite the committed server result across a session switch', async ({
  page,
}) => {
  test.setTimeout(360_000);
  const commands = captureCommands(page);
  await activateProject(page);
  await openEntry(page, 'hello-builder');
  const before = await entryBytes();

  // delay EVERY apply-edit RESPONSE past the transition: the write
  // crosses the wire, the drain settles it server-side, and the
  // response never reaches the (now dead) document
  await page.route('**/__astroix/api/v1', async (route) => {
    const body = route.request().postDataJSON() as { command?: { kind?: string } } | null;
    if (body?.command?.kind === 'apply-edit') {
      await page.waitForTimeout(2500);
    }
    await route.fallback();
  });

  await titleInput(page).fill('Delayed write title');
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'ready');
  await writeButton(page).click();
  await expect(writeState(page)).toHaveAttribute('data-write-state', /pending|refresh-required/);

  // deactivate while the response is still held: the transition drains
  // the accepted write (the server commits it), the document is reset
  // and replaced — the stale response cannot deliver anything anywhere
  await page.getByTestId('deactivate').click();
  await page.waitForURL(/launcher\.localhost:\d+\/__astroix\/app\//);
  await expect(page.getByTestId('session-label')).toHaveText('idle');

  await page.unroute('**/__astroix/api/v1');
  await activateProject(page);
  await openEntry(page, 'hello-builder');

  // the NEW generation's server truth IS the committed result — the
  // drained write's bytes, the written title, a live revision
  await expect(titleInput(page)).toHaveValue('Delayed write title');
  await expect(page.getByTestId('entry-revision')).not.toHaveText(/revision: none/);
  await expect(writeState(page)).toHaveAttribute('data-write-state', 'idle');
  expect(await entryBytes()).toBe(expectedTitleWrite(before, 'Delayed write title'));
  expect(commands().writes).toHaveLength(1);

  await restoreIdle(page);
});
