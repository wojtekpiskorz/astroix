import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  COMPLETE_RESET_TRACE,
  canvasSelect,
  LOAD_BUDGET_MS,
  openGlobalEditor,
  PROJECT_APP_URL,
  restoreWritten,
  SETTLE_BUDGET_MS,
  WRITE_SETTLE_MS,
} from '../../../../e2e/web/spec-helpers.ts';
import {
  type AbaCapture,
  type AbaShellState,
  abaAbortNextLauncherNavigation,
  abaActivate,
  abaDeactivate,
  abaEntryBytes,
  abaFreezeResetState,
  abaReactivateIdempotent,
  abaSheetBytes,
  abaShellState,
} from './harness/aba.ts';

/**
 * The K2 client-reset proof — the web slice (#255): the returning-A
 * generation starts with EMPTY client state, the reset sequencer's
 * ordered clearing holds under the REAL switch, and stale client
 * surfaces cannot observe B or dead-A data — all over the SHARED A-B-A
 * harness (`./harness/aba.ts`, the K-family's browser-tier API,
 * extended by this lane with the client-state readers, the frozen
 * reset capture, the navigation abort, and the idempotent
 * re-activation landing).
 *
 * The #393 lesson is the battery's spine: the FRESH document's zero
 * state is the truth pinned at every switch — never the dying
 * document's transient (its post-reset re-subscriptions are out of the
 * sequencer's jurisdiction and die with the document). The same-document
 * face rides the frozen capture at the navigation boundary instead.
 *
 * SERIAL like the lane's other batteries: one control plane, one
 * supervisor-global active session — every leg restores the idle state
 * and the staged bytes it touched.
 */

/** The staged copy this battery writes (registered first — position 0); project B (position 1) is never written. */
const WRITTEN = 'project-a' as const;
const UNTOUCHED = 'project-b' as const;

/** The Content pane's root. */
function pane(page: Page): Locator {
  return page.locator('[data-astroix-entry-form]');
}

/** Opens the blog entry and waits for the pane's ready state. */
async function openEntry(page: Page, entryId: string): Promise<void> {
  await page.locator(`[data-astroix-entry="${entryId}"]`).click();
  await expect(pane(page)).toHaveAttribute('data-form-status', 'ready', {
    timeout: SETTLE_BUDGET_MS,
  });
}

/** The title widget's input inside the form. */
function titleInput(page: Page): Locator {
  return pane(page).locator('[data-astroix-form-field="title"] input');
}

/** The entry frontmatter's title — the served truth a fresh form must carry. */
function frontmatterTitle(entry: string): string {
  const title = /^title: (.+)$/m.exec(entry)?.[1];
  if (title === undefined) throw new Error('the staged entry carries no title');
  return title;
}

/** The sheet's first font-size declaration — the editor's served value. */
function firstFontSize(sheet: string): string {
  const size = /font-size: ([^;]+);/.exec(sheet)?.[1];
  if (size === undefined) throw new Error('the staged sheet carries no font-size');
  return size;
}

/** The zero-state the FRESH destination document must show before any of its own gestures (the #393 lesson). */
const FRESH_ZERO: Partial<AbaShellState> = {
  selection: false,
  activeEntry: false,
  grants: 0,
  undo: 0,
  reset: 'none',
};

/** Polls a fresh document's marker to its settled zero-plus-first-queries state. */
async function awaitFreshZero(page: Page): Promise<void> {
  await expect
    .poll(async () => await abaShellState(page), { timeout: LOAD_BUDGET_MS })
    .toEqual(expect.objectContaining({ ...FRESH_ZERO, queries: 3 }));
}

test.describe.configure({ mode: 'serial' });

test('the returning generation starts at zero — B and A2 carry nothing of A1, and A2 serves fresh server truth', async ({
  context,
  page,
}) => {
  test.setTimeout(600_000);
  const sheetBefore = await abaSheetBytes(WRITTEN);
  const entryBefore = await abaEntryBytes(WRITTEN);
  const bSheetBefore = await abaSheetBytes(UNTOUCHED);
  const bEntryBefore = await abaEntryBytes(UNTOUCHED);

  // A1 commits; capture its authority.
  const a1: AbaCapture = await abaActivate(page, 0);

  // A1's rich client state: a canvas selection, an open CSS editor row,
  // one committed CSS write (a held grant and one undo entry on the
  // session), and an open entry carrying an UNWRITTEN draft. The served
  // truths are DERIVED, never hardcoded: in the full battery the
  // content-write spec legitimately leaves A's entry written and the
  // css-write specs' restores are their own — this leg must hold
  // wherever in the battery order it runs, and the bytes it captures
  // at entry are exactly what it restores at exit.
  await canvasSelect(page, '.hero-title');
  const input = await openGlobalEditor(page, { served: firstFontSize(sheetBefore) });
  const servedValue = await input.inputValue();
  const target = servedValue === '3.5rem' ? '3.75rem' : '3.5rem';
  await input.fill(target);
  await expect
    .poll(async () => await abaSheetBytes(WRITTEN), { timeout: WRITE_SETTLE_MS })
    .toContain(`font-size: ${target};`);
  await expect
    .poll(async () => await abaShellState(page), { timeout: WRITE_SETTLE_MS })
    .toEqual(
      expect.objectContaining({
        selection: true,
        activeEntry: false,
        grants: 1,
        undo: 1,
        reset: 'none',
      }),
    );
  await openEntry(page, 'hello-builder');
  const servedTitle = await titleInput(page).inputValue();
  await titleInput(page).fill(`${servedTitle} (stale a1 draft)`);

  // The switch: a second tab of the SAME context activates project B.
  const switchTab = await context.newPage();
  const b1: AbaCapture = await abaActivate(switchTab, 1);
  expect(b1.generation).toBeGreaterThan(a1.generation);
  expect(b1.host).not.toBe(a1.host);

  // B's FRESH document starts at zero (the #393 lesson: the fresh
  // document's state — never the dying tab's transient): no selection,
  // no open entry, no grants, no undo, no reset trace, and its own
  // three first queries under ITS generation-scoped keys.
  await awaitFreshZero(switchTab);
  await expect(switchTab.getByTestId('selection-tag')).toHaveText('none');
  await expect(switchTab.getByTestId('css-rule-editor')).toHaveCount(0);
  await expect(pane(switchTab)).toHaveAttribute('data-form-status', 'no-entry');

  // B observes its OWN truths, never A1's: the editor opens on B's
  // served sheet (A1's write never crossed projects), and the entry
  // form carries B's server truth — not A1's unwritten draft.
  await canvasSelect(switchTab, '.hero-title');
  await openGlobalEditor(switchTab, { served: firstFontSize(bSheetBefore) });
  await openEntry(switchTab, 'hello-builder');
  await expect(titleInput(switchTab)).toHaveValue(frontmatterTitle(bEntryBefore), {
    timeout: LOAD_BUDGET_MS,
  });

  // Back to A: a NEW generation — never a revival of A1's authority.
  const a2: AbaCapture = await abaActivate(switchTab, 0);
  expect(a2.generation).toBeGreaterThan(a1.generation);
  expect(a2.clientCapability).not.toBe(a1.clientCapability);

  // A2's FRESH document starts at zero too — A1's selection, open
  // editor row, grants, and undo did not survive the round trip.
  await awaitFreshZero(switchTab);
  await expect(switchTab.getByTestId('selection-tag')).toHaveText('none');
  await expect(switchTab.getByTestId('css-rule-editor')).toHaveCount(0);

  // A2 loads FRESH SERVER TRUTH: the drained CSS write is the served
  // value (K1's law), while the undo stack is generation-local —
  // EMPTY on arrival despite A1 having landed one undoable write.
  await canvasSelect(switchTab, '.hero-title');
  await openGlobalEditor(switchTab, { served: target });
  await expect(switchTab.getByTestId('css-undo')).toBeDisabled();

  // And A1's draft never survived either: the returning entry form
  // carries the server truth alone.
  await openEntry(switchTab, 'hello-builder');
  await expect(titleInput(switchTab)).toHaveValue(servedTitle, { timeout: LOAD_BUDGET_MS });

  // The bytes oracle: exactly A's one intended write; B never moved.
  expect(await abaSheetBytes(WRITTEN)).toContain(`font-size: ${target};`);
  expect(await abaSheetBytes(UNTOUCHED)).toBe(bSheetBefore);
  expect(await abaEntryBytes(UNTOUCHED)).toBe(bEntryBefore);

  // ——— the same-document face: A2 holds live client state (selection,
  // an open editor row, an open entry) and the deactivate gesture runs
  // the one ordered reset IN this document. The navigation is aborted
  // so the document survives its replacement attempt; the frozen
  // capture pins the cleared state AT the boundary (#393's discipline).
  const freeze = await abaFreezeResetState(switchTab);
  await abaAbortNextLauncherNavigation(switchTab);
  await switchTab.getByTestId('deactivate').click();
  await expect(switchTab.getByTestId('shell-state')).toContainText(COMPLETE_RESET_TRACE, {
    timeout: LOAD_BUDGET_MS,
  });
  // The captured snapshot is frozen at capture (the #393 discipline),
  // so the read after this truthiness poll is exact.
  await expect.poll(async () => await freeze.read(), { timeout: LOAD_BUDGET_MS }).toBeTruthy();
  const cleared = await freeze.read();
  expect(cleared).toContain('queries=0');
  expect(cleared).toContain('selection=0');
  expect(cleared).toContain('canvas=0');
  expect(cleared).toContain('entry=0');
  expect(cleared).toContain('grants=0');
  expect(cleared).toContain('undo=0');
  // The session-live boundary unmounted the query-holding surfaces in
  // the still-alive document (#399): the editor pane is gone.
  await expect(switchTab.getByTestId('css-rule-editor')).toHaveCount(0);
  await expect(switchTab).toHaveURL(PROJECT_APP_URL);

  // Restore the staged bytes and land the idle launcher (the
  // deactivated session's successor state) for whatever follows.
  await restoreWritten(sheetBefore, entryBefore);
  await switchTab.unroute(/launcher\.localhost/);
  await switchTab.goto('/__astroix/app/');
  await expect(switchTab.getByTestId('session-label')).toHaveText('idle', {
    timeout: LOAD_BUDGET_MS,
  });
});

test('a same-project re-activation lands the SAME generation — no reset trigger, no cache flap, the active session untouched', async ({
  context,
  page,
}) => {
  test.setTimeout(420_000);
  const a1: AbaCapture = await abaActivate(page, 0);
  await expect(page.getByTestId('inspect-revision')).toHaveText(/^\d+$/, {
    timeout: LOAD_BUDGET_MS,
  });

  // The double-click shape: a second tab activates the ALREADY-ACTIVE
  // project through the launcher (#413's incident shape, #419's law).
  const againTab = await context.newPage();
  const idem: AbaCapture = await abaReactivateIdempotent(againTab, 0);

  // The landing answers the CURRENT pair — same epoch, same generation
  // (NO bump), same host, same editor capability: an idempotent
  // re-activation is not a session switch.
  expect(idem.runtimeEpoch).toBe(a1.runtimeEpoch);
  expect(idem.generation).toBe(a1.generation);
  expect(idem.host).toBe(a1.host);
  expect(idem.clientCapability).toBe(a1.clientCapability);

  // The landing document is a fresh shell at the SAME pair: no reset
  // trace, its own three live queries under the SAME generation-scoped
  // keys (the cache never flapped — nothing was evicted as stale, no
  // invalidation storm fired), and it serves.
  await awaitFreshZero(againTab);
  await expect(againTab.getByTestId('inspect-revision')).toHaveText(/^\d+$/, {
    timeout: LOAD_BUDGET_MS,
  });

  // The ORIGINAL document was never switched out from: no reset fired
  // there either, its stream stayed honest (never dropped to
  // 'unavailable'), and its next inspection still serves through the
  // unchanged seat — the idempotent 200 cost the active session
  // nothing.
  expect((await abaShellState(page)).reset).toBe('none');
  await expect(page.getByTestId('stream-state')).not.toHaveText('unavailable', {
    timeout: LOAD_BUDGET_MS,
  });
  const served = page.waitForResponse(
    (response) =>
      response.url().endsWith('/__astroix/api/v1') && response.request().method() === 'POST',
    { timeout: LOAD_BUDGET_MS },
  );
  await page.getByTestId('reinspect').click();
  expect((await served).status()).toBe(200);

  // Restore the idle state for whatever follows the battery.
  await abaDeactivate(againTab);
});
