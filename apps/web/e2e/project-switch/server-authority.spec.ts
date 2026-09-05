import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  BOOT_BUDGET_MS,
  canvasSelect,
  captureWriteCount,
  holdApplyEditResponses,
  LOAD_BUDGET_MS,
  restoreWritten,
  WRITE_SETTLE_MS,
} from '../../../../e2e/web/spec-helpers.ts';
import { WEB_LANE_PORT } from '../../src/stage-e2e.ts';
import {
  type AbaCapture,
  abaActivate,
  abaDeactivate,
  abaEntryBytes,
  abaRetiredHostStatus,
  abaSheetBytes,
  abaStalePairStatus,
} from './harness/aba.ts';

/**
 * The K1 server-authority proof — the web slice (#254): both verticals'
 * write operations driven through the SHARED A-B-A harness
 * (`./harness/aba.ts`, the K-family's browser-tier API) against the
 * LIVE host: the staged-activation supervisor, the switch coordinator,
 * the origin leases, and a real managed `astro dev` child per
 * activation — all observed from the client side, with the server's
 * own truths read off the wire and the staged disk.
 *
 * The runtime-integration tier
 * (`packages/runtime/test/project-switch/server-authority.test.ts`)
 * owns the full stale-authority matrix over the raw wire; this battery
 * carries the CLIENT-OBSERVED faces K2 will inherit: the deterministic
 * switch sequence through the shell's own gestures, the served truth
 * of drained writes in the returning generation, and the
 * delayed-response face of a write crossing the transition boundary.
 *
 * SERIAL like the lane's other batteries: one control plane, one
 * supervisor-global active session — every leg restores the idle state
 * and the staged bytes it touched.
 */

/** The staged copy this battery writes (registered first — position 0); project B (position 1) is never touched. */
const WRITTEN = 'project-a' as const;
const UNTOUCHED = 'project-b' as const;

/**
 * Opens the CSS editor on the first GLOBAL row and returns the
 * font-size input WITHOUT waiting it to a served value — the
 * read-then-derive variant #425's shared options-form home
 * (`e2e/web/spec-helpers.ts` `openGlobalEditor`) deliberately cannot
 * serve: this battery's first leg reads the served truth off the input
 * before any value could be known (the sheet's state at battery start
 * is order-dependent), so the open hands back the locator raw.
 */
async function openGlobalEditor(page: Page): Promise<Locator> {
  await expect(page.getByTestId('css-rule-list')).toBeVisible({ timeout: BOOT_BUDGET_MS });
  await expect(page.locator('[data-testid="css-rule"]')).toHaveCount(4, {
    timeout: LOAD_BUDGET_MS,
  });
  await page.locator('[data-testid="css-rule-edit"]').nth(1).click();
  await expect(page.getByTestId('css-rule-editor')).toBeVisible({ timeout: BOOT_BUDGET_MS });
  return page.locator('[data-testid="css-decl-input"][data-css-prop="font-size"]');
}

/** The Content pane's root. */
function pane(page: Page): Locator {
  return page.locator('[data-astroix-entry-form]');
}

/** Opens the blog entry and waits for the pane's ready state. */
async function openEntry(page: Page, entryId: string): Promise<void> {
  await page.locator(`[data-astroix-entry="${entryId}"]`).click();
  await expect(pane(page)).toHaveAttribute('data-form-status', 'ready', { timeout: 60_000 });
}

/** The title widget's input inside the form. */
function titleInput(page: Page): Locator {
  return pane(page).locator('[data-astroix-form-field="title"] input');
}

test.describe.configure({ mode: 'serial' });

test('both verticals persist across A-B-A — the returning generation serves them, the other project never moves', async ({
  context,
  page,
}) => {
  test.setTimeout(480_000);
  const sheetBefore = await abaSheetBytes(WRITTEN);
  const entryBefore = await abaEntryBytes(WRITTEN);
  const bSheetBefore = await abaSheetBytes(UNTOUCHED);
  const bEntryBefore = await abaEntryBytes(UNTOUCHED);

  // A1 commits; capture its authority for the stale probes.
  const a1: AbaCapture = await abaActivate(page, 0);

  // the CSS vertical's write settles server-side.
  await canvasSelect(page, '.hero-title');
  const input = await openGlobalEditor(page);
  const current = await input.inputValue();
  const target = current === '3.5rem' ? '3.75rem' : '3.5rem';
  await input.fill(target);
  await expect
    .poll(async () => await abaSheetBytes(WRITTEN), { timeout: WRITE_SETTLE_MS })
    .toContain(`font-size: ${target};`);

  // the Content vertical's write settles server-side.
  await openEntry(page, 'hello-builder');
  await titleInput(page).fill('Hello builder (k1)');
  await page.getByTestId('write-entry').click();
  await expect(page.getByTestId('write-state')).toHaveAttribute('data-write-state', 'idle', {
    timeout: WRITE_SETTLE_MS,
  });
  await expect
    .poll(async () => await abaEntryBytes(WRITTEN), { timeout: WRITE_SETTLE_MS })
    .toContain('Hello builder (k1)');

  // the switch: a second tab of the SAME context activates project B.
  const switchTab = await context.newPage();
  const b1: AbaCapture = await abaActivate(switchTab, 1);
  expect(b1.host).not.toBe(a1.host);

  // A's origin is retired for the whole listener lifetime: 421, and
  // the stale pair is refused under B's LIVE authority.
  expect(await abaRetiredHostStatus(WEB_LANE_PORT, a1.host)).toBe(421);
  const stalePair = await abaStalePairStatus(WEB_LANE_PORT, a1, b1);
  expect(stalePair.status).toBe(409);
  expect(stalePair.code).toBe('stale-session');

  // back to A: a NEW generation — never a revival of A1's authority.
  const a2: AbaCapture = await abaActivate(switchTab, 0);
  expect(a2.generation).toBeGreaterThan(a1.generation);

  // the returning generation SERVES both drained writes: the fresh CSS
  // editor opens on the written value, the fresh entry pane on the
  // written title — never a resumed old-generation state.
  await canvasSelect(switchTab, '.hero-title');
  const returnedInput = await openGlobalEditor(switchTab);
  await expect(returnedInput).toHaveValue(target, { timeout: LOAD_BUDGET_MS });
  await openEntry(switchTab, 'hello-builder');
  await expect(titleInput(switchTab)).toHaveValue('Hello builder (k1)', {
    timeout: LOAD_BUDGET_MS,
  });

  // the bytes oracle: exactly A's two intended writes; B never moved.
  expect(await abaSheetBytes(WRITTEN)).toContain(`font-size: ${target};`);
  expect(await abaEntryBytes(WRITTEN)).toContain('Hello builder (k1)');
  expect(await abaSheetBytes(UNTOUCHED)).toBe(bSheetBefore);
  expect(await abaEntryBytes(UNTOUCHED)).toBe(bEntryBefore);

  // restore the staged bytes and the idle state for whatever follows.
  await restoreWritten(sheetBefore, entryBefore);
  await abaDeactivate(switchTab);
});

test('a held write response crossing the switch delivers nothing — the returning generation serves the committed truth alone', async ({
  context,
  page,
}) => {
  test.setTimeout(480_000);
  const writeCount = captureWriteCount(page);
  const sheetBefore = await abaSheetBytes(WRITTEN);
  const entryBefore = await abaEntryBytes(WRITTEN);
  const a1: AbaCapture = await abaActivate(page, 0);
  await openEntry(page, 'hello-builder');

  // delay every apply-edit RESPONSE far past the transition: the
  // REQUEST crosses immediately (the server accepts it, the executor
  // commits the bytes), and only the fulfilled response trails.
  await holdApplyEditResponses(page);

  await titleInput(page).fill('Hello builder (held)');
  await page.getByTestId('write-entry').click();
  await expect
    .poll(async () => await abaEntryBytes(WRITTEN), { timeout: WRITE_SETTLE_MS })
    .toContain('Hello builder (held)');

  // the switch happens while the response is still held: A's origin
  // retires (421) for B's whole lifetime.
  const staleHost = new URL(page.url()).host;
  const switchTab = await context.newPage();
  await abaActivate(switchTab, 1);
  expect(await abaRetiredHostStatus(WEB_LANE_PORT, staleHost)).toBe(421);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const a2: AbaCapture = await abaActivate(switchTab, 0);
  expect(a2.generation).toBeGreaterThan(a1.generation);

  // the returning generation's served truth is the COMMITTED write —
  // complete and quiet, with no resumed pending work and exactly the
  // one mutation ever dispatched.
  await openEntry(switchTab, 'hello-builder');
  await expect(titleInput(switchTab)).toHaveValue('Hello builder (held)', {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(switchTab.getByTestId('write-state')).toHaveAttribute('data-write-state', 'idle', {
    timeout: LOAD_BUDGET_MS,
  });
  expect(writeCount()).toBe(1);
  expect(await abaEntryBytes(WRITTEN)).toContain('Hello builder (held)');

  // restore the staged bytes and the idle state.
  await restoreWritten(sheetBefore, entryBefore);
  await abaDeactivate(switchTab);
});
