import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, type Request, test } from '@playwright/test';
import {
  activateProject,
  activateSettled,
  holdApplyEditResponses,
  LOAD_BUDGET_MS,
  restoreIdle,
  SETTLE_BUDGET_MS,
  WRITE_SETTLE_MS,
} from '../../../../e2e/web/spec-helpers.ts';
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
 * supervisor-global active session — and the battery's exit restores
 * the staged entry bytes it touched (#422): the legs chain their
 * writes inside this file by design, the stale-response leg's tail is
 * the green path's restore, and the file's `afterAll` (#433 round 2)
 * is the failure-path tooth — it runs on failures and serial skips
 * alike, the paths a leg-local `finally` could never reach — so
 * whatever battery follows inherits the canonical fixture's own truth.
 *
 * Every landing/transition wait is load-shaped (#396, the #392 pass
 * extended to this battery): the shared activation prefix carries the
 * 30s landing and 120s plane-boot budgets, the pane's first inspection
 * and the canvas convergences the 60s settle budget, and the write
 * settles (the dispatch observation, the terminal quiet state, the
 * server-side disk settlement) the #250 write budget. The asserted
 * values never change.
 */

/** The staged copy the battery writes into (registered first — position 0). */
const PROJECT_A = stagedCopyRoot('project-a');
/** The entry file the battery edits. */
const ENTRY_FILE = join(PROJECT_A, 'src/content/blog/hello-builder.md');
/**
 * The canonical fixture's own entry bytes — the battery's restore
 * target (#422): the staged copy is returned to the fixture's truth at
 * the battery's exit, so whatever battery follows inherits pristine
 * staged bytes, never this battery's writes. Read from the tracked
 * fixture (the staging's immutable source), the same workspace-root
 * path idiom as the frozen corpus below.
 */
const PRISTINE_ENTRY_BYTES = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'e2e',
    'fixture',
    'src',
    'content',
    'blog',
    'hello-builder.md',
  ),
  'utf8',
);

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

/** Opens the entry and waits for the pane's ready state. */
async function openEntry(page: Page, entryId: string): Promise<void> {
  await entryRow(page, entryId).click();
  await expect(pane(page)).toHaveAttribute('data-form-status', 'ready', {
    timeout: SETTLE_BUDGET_MS,
  });
}

/** The file's current bytes — the staged copy's truth. */
async function entryBytes(): Promise<string> {
  return await readFile(ENTRY_FILE, 'utf8');
}

/** The inspected values the draft began from — the frozen collections fixture's own projection. */
function inspectedHelloValues(): Record<string, unknown> {
  const corpus = JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        '..',
        'e2e',
        'behavior-contracts',
        'inspection',
        'collections.json',
      ),
      'utf8',
    ),
  ) as { collections: { name: string; entries: { id: string; data: unknown }[] }[] };
  const entry = corpus.collections
    .find((collection) => collection.name === 'blog')
    ?.entries.find((candidate) => candidate.id === 'hello-builder');
  if (entry === undefined) throw new Error('the frozen collections corpus lost hello-builder');
  return entry.data as Record<string, unknown>;
}

/** The served projection the current raw's draft began from — the corpus projection, its title moved to the raw's own. */
function servedProjectionOf(raw: string): Record<string, unknown> {
  const baseline = parseEntryDraft(raw);
  if (baseline === null) throw new Error('the fixture baseline did not parse');
  const title = (baseline.data as { title?: unknown }).title;
  if (typeof title !== 'string') throw new Error('the fixture baseline lost its title');
  return { ...inspectedHelloValues(), title };
}

/** The pure oracle's expected bytes for one title edit over the inspected raw baseline. */
function expectedTitleWrite(raw: string, nextTitle: string): string {
  const baseline = parseEntryDraft(raw);
  if (baseline === null) throw new Error('the fixture baseline did not parse');
  // The DIFF space is the draft's own: the served projection of the
  // CURRENT raw — the corpus projection with its title moved to
  // whatever the raw now carries (the serial battery's earlier
  // writes), the title edited — untouched keys never reach the
  // Document (the zod defaults the file never carries are
  // equal-in-projection, never a write).
  const served = servedProjectionOf(raw);
  return serializeEntry({
    raw,
    baseline: { data: served, body: baseline.body },
    draft: { data: { ...served, title: nextTitle }, body: baseline.body },
    protectedPaths: [],
  });
}

test.describe.configure({ mode: 'serial' });

test('form writes land byte-exact through the grant — TWICE from one pane — and the canvas follows', async ({
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
    timeout: LOAD_BUDGET_MS,
  });
  await expect(canvasTitle).toHaveText('Hello builder', { timeout: LOAD_BUDGET_MS });

  // the untouched draft has nothing to write: the gesture is honestly
  // disabled until an edit makes the intent ready
  const before = await entryBytes();
  await expect(writeButton(page)).toBeDisabled();
  routesBefore.count = commands().inspects('routes');

  await titleInput(page).fill('Hello builder (edited)');
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'ready', {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(writeButton(page)).toBeEnabled();
  await writeButton(page).click();

  // dispatched (pending observed), then the refresh lands the new
  // truth — the intermediate refresh-required window can close inside
  // one poll tick when the dev server converges fast, so the terminal
  // quiet state is the assertion that carries the flow
  await expect(writeState(page)).toHaveAttribute('data-write-state', /pending|refresh-required/, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(writeState(page)).toHaveAttribute('data-write-state', 'idle', {
    timeout: WRITE_SETTLE_MS,
  });

  // BYTE-EXACT: the staged file's bytes are the pure oracle's bytes
  const after = await entryBytes();
  expect(after).toBe(expectedTitleWrite(before, 'Hello builder (edited)'));

  // the pane reopened on the served truth: the written title, nothing to write
  await expect(titleInput(page)).toHaveValue('Hello builder (edited)', {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.getByTestId('entry-revision')).not.toHaveText(/revision: none/, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'none', {
    timeout: LOAD_BUDGET_MS,
  });

  // the canvas followed through the project's own HMR
  await expect(canvasTitle).toHaveText('Hello builder (edited)', {
    timeout: WRITE_SETTLE_MS,
  });

  // the routes family refetched after the commit (the loop's invalidation)
  expect(commands().inspects('routes')).toBeGreaterThan(routesBefore.count);

  // THE double write from ONE pane: the landing cleared the committed
  // draft, and the pane must have REOPENED on the served truth — the
  // next edit is admissible again (a pane that stayed cleared would
  // swallow the report and never arm the gesture), and the refreshed
  // inspection's grant at the new revision authorizes the dispatch
  const afterFirst = after;
  await titleInput(page).fill('Hello builder (twice)');
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'ready', {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(writeButton(page)).toBeEnabled();
  await writeButton(page).click();
  await expect(writeState(page)).toHaveAttribute('data-write-state', /pending|refresh-required/, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(writeState(page)).toHaveAttribute('data-write-state', 'idle', {
    timeout: WRITE_SETTLE_MS,
  });

  // BYTE-EXACT twice over: the oracle over the FIRST write's bytes
  const afterTwice = await entryBytes();
  expect(afterTwice).toBe(expectedTitleWrite(afterFirst, 'Hello builder (twice)'));
  await expect(titleInput(page)).toHaveValue('Hello builder (twice)', {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'none', {
    timeout: LOAD_BUDGET_MS,
  });

  // the wire law: the two writes each carried a grant, never a path
  const writes = commands().writes;
  expect(writes.length).toBe(2);
  for (const write of writes) {
    expect(write.body).toContain('"grant"');
    expect(write.body).not.toMatch(/"(\/Users\/|\/private\/|\/tmp\/|file:\/\/)/);
  }

  await restoreIdle(page);
});

test('a raw write lands through the same grant-bound loop', async ({ page }) => {
  test.setTimeout(300_000);
  const commands = captureCommands(page);
  await activateProject(page);
  await openEntry(page, 'hello-builder');
  const before = await entryBytes();

  // into raw mode: the whole draft as YAML, edited there, written there
  // (the mode expect is the convergence guard for the one-shot
  // inputValue read that follows it — the textarea's value renders
  // with the mode, never assumed)
  await pane(page).locator('[data-astroix-form-mode-button="raw"]').click();
  await expect(pane(page)).toHaveAttribute('data-form-mode', 'raw', {
    timeout: LOAD_BUDGET_MS,
  });
  const text = await rawText(page).inputValue();
  await rawText(page).fill(
    text.replace('title: Hello builder (twice)', 'title: Raw-written title'),
  );
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'ready', {
    timeout: LOAD_BUDGET_MS,
  });
  await writeButton(page).click();
  await expect(writeState(page)).toHaveAttribute('data-write-state', 'idle', {
    timeout: WRITE_SETTLE_MS,
  });

  // BYTE-EXACT: the oracle over the same raw baseline, in the draft's
  // own diff space (the served projection of the current raw — the
  // previous test's title carried — the raw edit applied)
  const after = await entryBytes();
  const baseline = parseEntryDraft(before);
  if (baseline === null) throw new Error('the fixture baseline did not parse');
  const served = servedProjectionOf(before);
  expect(after).toBe(
    serializeEntry({
      raw: before,
      baseline: { data: served, body: baseline.body },
      draft: {
        data: { ...served, title: 'Raw-written title' },
        body: baseline.body,
      },
      protectedPaths: [],
    }),
  );
  // back in form mode the served truth shows
  await pane(page).locator('[data-astroix-form-mode-button="form"]').click();
  await expect(titleInput(page)).toHaveValue('Raw-written title', {
    timeout: LOAD_BUDGET_MS,
  });
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

  // delay every apply-edit RESPONSE far past the transition: the
  // REQUEST crosses immediately (`route.fetch` re-issues it while the
  // session is live — the server accepts it, the executor commits the
  // bytes, and the disk-poll below PROVES the settlement before the
  // deactivation begins), and only the fulfilled response trails. It
  // arrives after the document is replaced, and a fulfilled response
  // into a dead request delivers nothing anywhere — fulfilling then
  // throws "Route is already handled", which is exactly the leg's
  // law observed, so it is swallowed. (Holding the REQUEST instead
  // would starve the write: the old session retires before the plan
  // crosses, the server refuses it as stale, and nothing commits —
  // a different leg, not this one.)
  await holdApplyEditResponses(page);

  // SERIAL battery hygiene (#422, trap a): the leg's writes leave the
  // staged entry at the committed title, and the tail statement below
  // returns it to the canonical fixture's own truth — the GREEN path's
  // restore, feeding the hygiene leg. The FAILURE paths (this leg or
  // the ones above dying mid-write, and every serial skip they cause)
  // are the file's `afterAll` tooth (#433 round 2): the `finally` that
  // used to live here only ran on paths that reached it — legs 1-2
  // dying mid-write skipped this leg entirely and handed the successor
  // battery dirty bytes.
  await titleInput(page).fill('Delayed write title');
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'ready', {
    timeout: LOAD_BUDGET_MS,
  });
  await writeButton(page).click();
  await expect(writeState(page)).toHaveAttribute('data-write-state', /pending|refresh-required/, {
    timeout: LOAD_BUDGET_MS,
  });

  // the write crossed and SETTLED server-side before any transition:
  // the staged file's bytes are the committed result (the executor's
  // fork+commit is the write-settle shape — the #250 budget)
  await expect
    .poll(async () => (await entryBytes()).includes('Delayed write title'), {
      timeout: WRITE_SETTLE_MS,
    })
    .toBe(true);

  // deactivate while the response is still held: the transition sees
  // an already-settled write (nothing to drain), the document is reset
  // and replaced — the stale response cannot deliver anything anywhere
  await restoreIdle(page);

  // the still-held handler must not outlive the test as an error: the
  // lingering fulfill belongs to a dead request and is ignored here
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await activateProject(page);
  await openEntry(page, 'hello-builder');

  // the NEW generation's server truth IS the committed result — the
  // drained write's bytes, the written title, a live revision
  await expect(titleInput(page)).toHaveValue('Delayed write title', {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.getByTestId('entry-revision')).not.toHaveText(/revision: none/, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(writeState(page)).toHaveAttribute('data-write-state', 'idle');
  expect(await entryBytes()).toBe(expectedTitleWrite(before, 'Delayed write title'));
  expect(commands().writes).toHaveLength(1);

  // the green path's restore (the failure paths are the afterAll's)
  await writeFile(ENTRY_FILE, PRISTINE_ENTRY_BYTES);

  await restoreIdle(page);
});

test('the battery leaves the staged entry at the fixture bytes — serial hygiene', async () => {
  test.setTimeout(60_000);
  // #422's trap-(a) proof, green case: the legs' writes restored at the
  // stale-response leg's tail, so the staged copy the battery leaves
  // behind equals the canonical fixture's own bytes — a serial battery
  // that failed before its restore tail used to hand every later
  // battery a project-a whose hello-builder title was `Delayed write
  // title`. The leg itself only ever runs all-green (a serial failure
  // skips it) — the FAILURE-path tooth is the file's `afterAll` below,
  // which runs on failures and skips alike; this assertion reds the
  // moment a green-path restore regresses.
  expect(await entryBytes()).toBe(PRISTINE_ENTRY_BYTES);
});

test.afterAll(async () => {
  // #422 trap (a)'s failure-path tooth (#433 round 2): the `finally`
  // this replaced lived inside the stale-response leg, so serial
  // skipping meant it only ever ran in the all-green case — legs 1-2
  // dying mid-write (the paths that actually dirty the bytes) never
  // reached it, and the successor battery inherited the dirty title.
  // `afterAll` runs on failures and skips alike and returns the staged
  // entry to the fixture canonical whatever happened above; the hygiene
  // leg keeps the green case's proof.
  await writeFile(ENTRY_FILE, PRISTINE_ENTRY_BYTES);
});

test('an idempotent re-activation over the already-active project settles through the shared discipline', async ({
  page,
}) => {
  test.setTimeout(300_000);
  // #422's trap-(b) teeth, asserted directly on the warm shape: the
  // #413/#419 idempotent law — activating the already-active project
  // answers the CURRENT session, never a fresh plane — and the shared
  // settle discipline must hold HONESTLY over it: ≥ 1 canvas
  // navigation, with the re-attached canvas's one trailing post-connect
  // reload absorbed by the warm quiescence (CI run 33932953309 caught
  // that reload inside the old zero-window) — never a misleading
  // `>= 2, Received: 1` red, and never a zero-navigations quiescence
  // red on the legitimate trailing reload, either of which would point
  // the next battery at the settle helper instead of the real upstream
  // failure that left the session active.
  await activateProject(page);
  await activateSettled(page);
  await restoreIdle(page);
});
