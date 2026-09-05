import { expect, type Page, test } from '@playwright/test';
import type { RequestEnvelope } from '@wojciechpiskorz/astroix-protocol';
import {
  canvasSelect,
  captureWriteCount,
  expectedDeclarationWrite,
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
  abaSheetBytes,
  abaShellState,
} from './harness/aba.ts';
import {
  firstFontSize,
  frontmatterTitle,
  nextFontSize,
  openEntry,
  openGlobalEditor,
  titleInput,
} from './scenarios/editors.ts';
import {
  armSwAttack,
  claimHostileWorker,
  delayedCallbackOutcome,
  plantDelayedCallback,
  type SwReport,
  stageHostileWorker,
  swReports,
} from './scenarios/hostile-sw.ts';
import { openHeldBodyMutation, stylesWriteFactOf } from './scenarios/wire.ts';

/**
 * The K3 pending-write and diagnostic-role proof — the web slice
 * (#256): pending CSS and Content writes, forced transition timing,
 * postcommit response loss, and hostile Service Worker conditions
 * across the A-B-A switch, all over the SHARED read-only A-B-A
 * harness (`./harness/aba.ts`, the K-family's browser-tier API) plus
 * this lane's scenario drivers (`./scenarios/` — the raw-wire held
 * body, the hostile worker, the editor locals; the ONLY new surface).
 *
 * What this battery proves, per the ticket's ACs:
 * - pending COOPERATIVE writes (both verticals in flight at the
 *   transition) drain exactly once, and the returning generation
 *   serves them with the pending-state presentation cleared;
 * - a NONCOOPERATIVE write (a held mutation body over the live wire)
 *   is fenced — the deferred admission refuses it closed, nothing
 *   reaches the executor, and the transition forces past it inside
 *   its settled deadlines (the switch commits while the body stays
 *   held);
 * - the LOST postcommit response recovers as the committed receipt
 *   in the correct returning generation;
 * - no old capability, Service Worker replay, delayed callback, or
 *   pending mutation crosses into B or the new A generation: replays
 *   die at the retired origin, tampered headers are refused and the
 *   failure SURFACES on the write line, a spoofed stale success is
 *   dropped by the AppClient's session-scoped pairing (#436, fixed
 *   as #438) — the envelope's dead-pair session never echoes the
 *   live exchange's requesting pair, however its request id collides
 *   — so the write settles the honest never-committed terminal (the
 *   machine's `irreversible-postcommit`, badge `uncertain`, the
 *   refresh-landed reconcile back to quiet) and the disk truth never
 *   moves, and B's origin is never even reachable by A's worker.
 *   The captured-bytes replay family is closed with it: SessionRef
 *   is correlation, not auth (#438's recorded boundary).
 *
 * The diagnostic-role limits (one editor, three diagnostics) and the
 * Electron document rebinding / CDP-bypass-failure law are the
 * DESKTOP leg's (`apps/desktop/e2e/project-switch/`); the web host
 * mints no diagnostic documents — disclosed in the lane's PR.
 *
 * SERIAL like the lane's other batteries: one control plane, one
 * supervisor-global active session — every leg restores the idle
 * state and the staged bytes it touched.
 */

/** The staged copy this battery writes (registered first — position 0); project B (position 1) is never written. */
const WRITTEN = 'project-a' as const;
const UNTOUCHED = 'project-b' as const;

/** Resolves when the next apply-edit REQUEST crosses — the in-flight dispatch's observable. */
function waitForMutationCrossed(page: Page): Promise<void> {
  return page
    .waitForRequest(
      (request) =>
        request.url().endsWith('/__astroix/api/v1') &&
        request.method() === 'POST' &&
        (request.postDataJSON() as { command?: { kind?: string } } | null)?.command?.kind ===
          'apply-edit',
      { timeout: LOAD_BUDGET_MS },
    )
    .then(() => undefined);
}

/** The error envelope's code — every refusal assertion reads the closed vocabulary. */
function errorCode(body: string): string {
  return (JSON.parse(body) as { error?: { code?: string } }).error?.code ?? 'none';
}

/**
 * The worker's FIRST report of one kind — polled until it exists and
 * returned by the same poll, so no site fetches the reports a second
 * time (and no report assertion needs the optional chain).
 */
async function swReportOf(page: Page, kind: string): Promise<SwReport> {
  let found: SwReport | undefined;
  await expect
    .poll(
      async () => {
        found = (await swReports(page)).find((report) => report.kind === kind);
        return found !== undefined;
      },
      { timeout: LOAD_BUDGET_MS },
    )
    .toBe(true);
  if (found === undefined) throw new Error(`the worker never reported "${kind}"`);
  return found;
}

/**
 * Installs the CSS write line's badge recorder (#256/#436→#438): a
 * MutationObserver capturing EVERY `data-write-state` value the badge
 * ever expresses. The write loops render a settle's terminal phase
 * for exactly one deterministic macrotask before the post-settlement
 * refresh begins (the shared act boundary the loops' own tests rely
 * on), so a sampling poll can race straight past the honest terminal
 * — the observer cannot: every attribute mutation is recorded,
 * transient or not.
 */
async function recordCssWriteStates(tab: Page): Promise<void> {
  await tab.evaluate(() => {
    const badge = document.querySelector('[data-testid="css-write-status"]');
    const holder = window as unknown as { __k3WriteStates?: Set<string> };
    if (badge === null) throw new Error('the CSS write line is not mounted');
    const seen = new Set<string>();
    const record = () => {
      const value = badge.getAttribute('data-write-state');
      if (value !== null) seen.add(value);
    };
    record();
    new MutationObserver(record).observe(badge, {
      attributes: true,
      attributeFilter: ['data-write-state'],
    });
    holder.__k3WriteStates = seen;
  });
}

/** The distinct `data-write-state` values recorded since the recorder installed. */
async function recordedCssWriteStates(tab: Page): Promise<string[]> {
  return await tab.evaluate(() => {
    const holder = window as unknown as { __k3WriteStates?: Set<string> };
    return [...(holder.__k3WriteStates ?? [])];
  });
}

test.describe.configure({ mode: 'serial' });

test('pending CSS and Content writes drain once through cooperative switches — the returning generation serves both, presentation cleared', async ({
  context,
  page,
}) => {
  test.setTimeout(600_000);
  const mutationCount = captureWriteCount(page);
  const sheetBefore = await abaSheetBytes(WRITTEN);
  const entryBefore = await abaEntryBytes(WRITTEN);
  const bSheetBefore = await abaSheetBytes(UNTOUCHED);
  const bEntryBefore = await abaEntryBytes(UNTOUCHED);
  const servedTitle = frontmatterTitle(entryBefore);
  const servedSize = firstFontSize(sheetBefore);

  // ROUND 1 — the CONTENT vertical's pending write: A1 commits, one
  // warm-up write settles (the session's write executor is forked and
  // retained — the fork is not this proof's race), then the probe
  // write dispatches, its request crosses, and the response is NOT
  // waited for. A short absorption beat lets the admitted write reach
  // the F5 fence's queue before the switch fires: the transition's
  // drain is then over genuinely ACCEPTED work (a submit racing past
  // the drain closure is the fence's own retryable refusal — the
  // noncooperative face, not this round's). (The shell's editing pane
  // is exclusive: one vertical's editor at a time, so each round races
  // its own vertical's write.)
  const a1: AbaCapture = await abaActivate(page, 0);
  await openEntry(page, 'hello-builder');
  await titleInput(page).fill(`${servedTitle} (k3 warm)`);
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'ready', {
    timeout: LOAD_BUDGET_MS,
  });
  await page.getByTestId('write-entry').click();
  // the warm-up write settles COMPLETELY — the pane reopens on the
  // served truth with a clean intent — before the probe write arms.
  await expect(page.getByTestId('write-state')).toHaveAttribute('data-write-state', 'idle', {
    timeout: WRITE_SETTLE_MS,
  });
  await expect(titleInput(page)).toHaveValue(`${servedTitle} (k3 warm)`, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'none', {
    timeout: LOAD_BUDGET_MS,
  });
  const contentCrossed = waitForMutationCrossed(page);
  await titleInput(page).fill(`${servedTitle} (k3 drain)`);
  await expect(page.getByTestId('intent-state')).toHaveAttribute('data-intent-state', 'ready', {
    timeout: LOAD_BUDGET_MS,
  });
  await page.getByTestId('write-entry').click();
  await contentCrossed;
  await page.waitForTimeout(1_500);

  // the switch fires with the write still unsettled: the transition's
  // drain is the fence's window — the launcher landing AFTER the drain
  // is the drain's own observable.
  await abaDeactivate(page);

  // the pending write DRAINED — settled on disk despite the
  // transition, exactly once (no re-dispatch, no double write).
  await expect
    .poll(async () => await abaEntryBytes(WRITTEN), { timeout: WRITE_SETTLE_MS })
    .toContain('(k3 drain)');
  expect(mutationCount()).toBe(2);

  // ROUND 2 — the CSS vertical's pending write over a fresh
  // generation of the same project, the same warm-then-probe shape.
  const a1b: AbaCapture = await abaActivate(page, 0);
  expect(a1b.generation).toBeGreaterThan(a1.generation);
  await canvasSelect(page, '.hero-title');
  const input = await openGlobalEditor(page, servedSize);
  const drainedSize = '3.125rem';
  await input.fill(nextFontSize(servedSize));
  // the warm-up write settles COMPLETELY (the loop quiet on the
  // committed value) before the probe write arms.
  await expect(page.getByTestId('css-write-status')).toHaveAttribute(
    'data-write-state',
    /quiet|saved/,
    { timeout: WRITE_SETTLE_MS },
  );
  await expect
    .poll(async () => await abaSheetBytes(WRITTEN), { timeout: WRITE_SETTLE_MS })
    .toContain(`font-size: ${nextFontSize(servedSize)};`);
  const cssCrossed = waitForMutationCrossed(page);
  await input.fill(drainedSize);
  await cssCrossed;
  await page.waitForTimeout(1_500);
  await abaDeactivate(page);

  await expect
    .poll(async () => await abaSheetBytes(WRITTEN), { timeout: WRITE_SETTLE_MS })
    .toContain(`font-size: ${drainedSize};`);
  expect(mutationCount()).toBe(4);

  // the A-B-A crossing: B is a FRESH document at zero (K2's law holds
  // under pending writes), and B's project never moved.
  const switchTab = await context.newPage();
  const b1: AbaCapture = await abaActivate(switchTab, 1);
  expect(b1.generation).toBeGreaterThan(a1b.generation);
  await expect
    .poll(async () => await abaShellState(switchTab), { timeout: LOAD_BUDGET_MS })
    .toEqual(
      expect.objectContaining({
        selection: false,
        activeEntry: false,
        grants: 0,
        undo: 0,
        reset: 'none',
        queries: 3,
      }),
    );
  expect(await abaSheetBytes(UNTOUCHED)).toBe(bSheetBefore);
  expect(await abaEntryBytes(UNTOUCHED)).toBe(bEntryBefore);

  // A2: the returning generation SERVES both drained truths, the
  // pending-state presentation CLEARED — a quiet write line, an idle
  // entry pane, an empty undo stack (nothing of the dead generations'
  // pending work resumed), and no new mutation crossed.
  const a2: AbaCapture = await abaActivate(switchTab, 0);
  expect(a2.generation).toBeGreaterThan(a1b.generation);
  const a2Mutations = captureWriteCount(switchTab);
  await canvasSelect(switchTab, '.hero-title');
  await openGlobalEditor(switchTab, drainedSize);
  await expect(switchTab.getByTestId('css-write-status')).toHaveAttribute(
    'data-write-state',
    'quiet',
    { timeout: LOAD_BUDGET_MS },
  );
  await expect(switchTab.getByTestId('css-undo')).toBeDisabled();
  await openEntry(switchTab, 'hello-builder');
  await expect(titleInput(switchTab)).toHaveValue(`${servedTitle} (k3 drain)`, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(switchTab.getByTestId('write-state')).toHaveAttribute('data-write-state', 'idle', {
    timeout: LOAD_BUDGET_MS,
  });
  expect(a2Mutations()).toBe(0);

  // restore the staged bytes and the idle state for whatever follows.
  await restoreWritten(sheetBefore, entryBefore);
  await abaDeactivate(switchTab);
});

test('a held-body write is fenced while the switch forces past it — the lost postcommit response recovers as the committed receipt', async ({
  context,
  page,
}) => {
  test.setTimeout(600_000);
  const mutationCount = captureWriteCount(page);
  const sheetBefore = await abaSheetBytes(WRITTEN);
  const entryBefore = await abaEntryBytes(WRITTEN);
  const bSheetBefore = await abaSheetBytes(UNTOUCHED);

  // A1 commits; capture its authority for the wire drivers.
  const a1: AbaCapture = await abaActivate(page, 0);
  await openEntry(page, 'hello-builder');
  const servedTitle = frontmatterTitle(entryBefore);

  // hold every apply-edit RESPONSE far past the transition: the
  // request crosses immediately (the server accepts it, the executor
  // commits the bytes), and only the fulfilled response trails — the
  // POSTCOMMIT RESPONSE LOSS.
  await holdApplyEditResponses(page);

  // the Content write commits server-side while its response is held.
  await titleInput(page).fill(`${servedTitle} (k3 held)`);
  await page.getByTestId('write-entry').click();
  await expect
    .poll(async () => await abaEntryBytes(WRITTEN), { timeout: WRITE_SETTLE_MS })
    .toContain('(k3 held)');

  // the NONCOOPERATIVE CSS mutation: a held BODY over the live grant
  // — the head and half the body cross, the rest waits for finish().
  const fact = await stylesWriteFactOf(WEB_LANE_PORT, a1);
  const servedSize = firstFontSize(fact.raw);
  const anchor = `font-size: ${servedSize};`;
  const start = fact.raw.indexOf(anchor);
  if (start === -1) throw new Error(`the served sheet lost the anchor "${anchor}"`);
  const envelope: RequestEnvelope = {
    protocolVersion: 1,
    requestId: 'k3-held-body',
    session: { runtimeEpoch: a1.runtimeEpoch, generation: a1.generation },
    command: {
      kind: 'apply-edit',
      plan: {
        operation: 'splice',
        grant: fact.grant,
        range: { start, end: start + anchor.length },
        replacement: `font-size: ${nextFontSize(servedSize)};`,
      },
    },
  };
  const held = openHeldBodyMutation(
    WEB_LANE_PORT,
    envelope,
    a1,
    Math.floor(JSON.stringify(envelope).length / 2),
  );

  // the switch forces past BOTH: B commits while the body stays held
  // and the content response stays lost — the transition was not held
  // hostage by either.
  const switchTab = await context.newPage();
  const b1: AbaCapture = await abaActivate(switchTab, 1);
  expect(b1.generation).toBeGreaterThan(a1.generation);

  // the held body's deferred admission is FENCED: it never reached
  // the executor, the deferred host re-derivation refuses it closed,
  // and A's sheet bytes never moved.
  const finished = await held.finish();
  expect(finished.status, finished.body).toBe(404);
  expect(errorCode(finished.body)).toBe('resource-not-found');
  expect(await abaSheetBytes(WRITTEN)).toBe(sheetBefore);
  expect(await abaSheetBytes(UNTOUCHED)).toBe(bSheetBefore);

  // the LOST postcommit response recovers in the CORRECT generation:
  // A2 — a fresh generation of the same project — serves the
  // committed receipt (the written title, a live idle pane), while
  // the held CSS write stays unfired (the pristine served size).
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const a2: AbaCapture = await abaActivate(switchTab, 0);
  expect(a2.generation).toBeGreaterThan(a1.generation);
  await canvasSelect(switchTab, '.hero-title');
  await openGlobalEditor(switchTab, firstFontSize(sheetBefore));
  await openEntry(switchTab, 'hello-builder');
  await expect(titleInput(switchTab)).toHaveValue(`${servedTitle} (k3 held)`, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(switchTab.getByTestId('write-state')).toHaveAttribute('data-write-state', 'idle', {
    timeout: LOAD_BUDGET_MS,
  });

  // the attribution: exactly the one content mutation ever dispatched
  // (A1's generation), and the sheet byte-identical to its pristine
  // truth throughout.
  expect(mutationCount()).toBe(1);
  expect(await abaSheetBytes(WRITTEN)).toBe(sheetBefore);

  // restore the staged bytes and the idle state.
  await restoreWritten(sheetBefore, entryBefore);
  await abaDeactivate(switchTab);
});

test('a hostile Service Worker cannot cross generations — replays die at the retired origin, tampered headers surface, stale successes never bind', async ({
  context,
  page,
}) => {
  test.setTimeout(600_000);
  const sheetBefore = await abaSheetBytes(WRITTEN);
  const entryBefore = await abaEntryBytes(WRITTEN);
  const served = firstFontSize(sheetBefore);
  const committed = nextFontSize(served);

  // the worker's script is staged BEFORE the activation (vite's public
  // middleware gates on the dev server's boot-time listing), then A1
  // commits and the hostile worker claims the project origin.
  await stageHostileWorker();
  const a1: AbaCapture = await abaActivate(page, 0);
  await claimHostileWorker(page);

  // one committed CSS write — the worker CAPTURES the mutation and
  // its success response (its replay and spoofing material).
  await canvasSelect(page, '.hero-title');
  const input = await openGlobalEditor(page, served);
  await input.fill(committed);
  await expect
    .poll(async () => await abaSheetBytes(WRITTEN), { timeout: WRITE_SETTLE_MS })
    .toBe(expectedDeclarationWrite(sheetBefore, 'font-size', served, committed));
  await expect(page.getByTestId('css-write-status')).toHaveAttribute(
    'data-write-state',
    /quiet|saved/,
    { timeout: WRITE_SETTLE_MS },
  );

  // the dying document's DELAYED callback: a hostile session-scoped
  // mutation left pending in the dying document — planted there, it
  // fires once the successor holds the stage and the old origin is
  // retired.
  const switchTab = await context.newPage();
  const b1: AbaCapture = await abaActivate(switchTab, 1);
  expect(b1.host).not.toBe(a1.host);
  await expect
    .poll(async () => await abaShellState(switchTab), { timeout: LOAD_BUDGET_MS })
    .toEqual(
      expect.objectContaining({
        selection: false,
        activeEntry: false,
        grants: 0,
        undo: 0,
        reset: 'none',
        queries: 3,
      }),
    );
  await plantDelayedCallback(page, 5_000);

  // the delayed callback FIRED during B: the dying document's own
  // mutation attempt died at its retired origin — never the admission.
  await expect
    .poll(async () => await delayedCallbackOutcome(page), { timeout: LOAD_BUDGET_MS })
    .toBeDefined();
  expect((await delayedCallbackOutcome(page))?.status).toBe(421);

  // the REPLAY: the worker re-issues the captured A1 mutation — the
  // retired origin refuses it, and the bytes stay the exact single
  // committed write (no double write, no revived authority).
  await armSwAttack(page, { cmd: 'arm-replay' });
  const replay = await swReportOf(page, 'replay');
  expect(replay.status).toBe(421);
  expect(await abaSheetBytes(WRITTEN)).toBe(
    expectedDeclarationWrite(sheetBefore, 'font-size', served, committed),
  );

  // A2: the returning generation lands on the SAME origin the worker
  // still controls — its document is served through the hostile
  // worker from the first byte, with a FRESH capability.
  const a2: AbaCapture = await abaActivate(switchTab, 0);
  expect(a2.generation).toBeGreaterThan(a1.generation);
  expect(a2.clientCapability).not.toBe(a1.clientCapability);
  await canvasSelect(switchTab, '.hero-title');
  const liveInput = await openGlobalEditor(switchTab, committed);

  // the STALE SUCCESS — the closed family, proven end to end
  // (#436→#438): the worker answers A2's live write with A1's captured
  // SUCCESS envelope, and the AppClient's session-scoped pairing drops
  // it — the envelope's `session` is A1's dead pair, and request ids
  // are per-document counters (an id collision alone was the #436
  // gap; the pair check is what closes it) — so the exchange settles
  // on the unmatched path as a transport failure. The write loop
  // classifies it UNCERTAIN: the machine's `irreversible-postcommit`
  // terminal, badge `uncertain`, then the refresh-landed reconcile
  // converges it quiet. The recorder proves the badge's full history:
  // the saved phantom can never be expressed, and the honest terminal
  // must be.
  await recordCssWriteStates(switchTab);
  await armSwAttack(page, { cmd: 'arm-stale-mutation' });
  await liveInput.fill(served);
  await swReportOf(page, 'stale-delivered');
  // the disk truth is the byte oracle: the server never saw the
  // write, so the bytes stay the exact single committed A1 write.
  await expect
    .poll(async () => await abaSheetBytes(WRITTEN), { timeout: WRITE_SETTLE_MS })
    .toBe(expectedDeclarationWrite(sheetBefore, 'font-size', served, committed));
  // the loop settles the honest terminal and reconciles: the badge
  // converges quiet — NEVER having expressed the saved phantom — and
  // the record carries the `uncertain` terminal (the one-macrotask
  // render the observer alone can guarantee catching).
  await expect(switchTab.getByTestId('css-write-status')).toHaveAttribute(
    'data-write-state',
    'quiet',
    { timeout: WRITE_SETTLE_MS },
  );
  const observed = await recordedCssWriteStates(switchTab);
  expect(observed, 'the badge expressed these states').not.toContain('saved');
  expect(observed, 'the badge expressed these states').toContain('uncertain');

  // the recovery (the loop's retry-recovery law): a fresh, DIFFERENT
  // edit through the passthrough COMMITS — the loop was never wedged
  // by the spoofed exchange (a same-as-served fill is the loop's own
  // honest no-change refusal, not a wedge).
  const recoveredSize = '3.125rem';
  await liveInput.fill(recoveredSize);
  await expect
    .poll(async () => await abaSheetBytes(WRITTEN), { timeout: WRITE_SETTLE_MS })
    .toContain(`font-size: ${recoveredSize};`);
  await expect(switchTab.getByTestId('css-write-status')).toHaveAttribute(
    'data-write-state',
    /quiet|saved/,
    { timeout: WRITE_SETTLE_MS },
  );

  // the HEADER TAMPER: the live write's capability is replaced by the
  // DEAD A1 one — the server refuses the exchange and the write line
  // surfaces the refusal; the bytes never move.
  await armSwAttack(page, { cmd: 'arm-rewrite', value: a1.clientCapability });
  await liveInput.fill(served);
  await expect(switchTab.getByTestId('css-write-status')).toHaveAttribute(
    'data-write-state',
    'rejected',
    { timeout: WRITE_SETTLE_MS },
  );
  const tamper = await swReportOf(page, 'rewrite-outcome');
  expect(tamper.status).toBe(403);
  expect(await abaSheetBytes(WRITTEN)).toContain(`font-size: ${recoveredSize};`);

  // and the worker NEVER saw B's origin — origin isolation held for
  // the whole battery: B's generation was unreachable by A's worker.
  await armSwAttack(page, { cmd: 'dump' });
  const dump = await swReportOf(page, 'dump');
  expect(dump.log?.origins).not.toContain(`http://${b1.host}`);

  // restore the staged bytes and the idle state.
  await restoreWritten(sheetBefore, entryBefore);
  await abaDeactivate(switchTab);
});
