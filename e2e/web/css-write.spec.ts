import { writeFile } from 'node:fs/promises';
import { expect, type Page, type Request, type Response, test } from '@playwright/test';
import {
  activateSettled,
  BOOT_BUDGET_MS,
  CANVAS_FRAME,
  canvasSelect,
  cssBytes,
  expectedDeclarationWrite,
  LOAD_BUDGET_MS,
  restoreIdle,
  STAGED_CSS_FILE,
  UNDO_SETTLE_MS,
  WRITE_SETTLE_MS,
} from './spec-helpers.ts';

/**
 * The CSS vertical's grant-bound auto-write battery (#250, I2): the
 * write loop against the REAL control-plane composition — the enriched
 * styles inspection carrying per-file opaque css grants and raw truth,
 * the D4 planning boundary, the F5 fence, the REAL D5 write-executor
 * child writing the STAGED copy's bytes, and the project's OWN vite
 * HMR carrying the splice to the live canvas (through the origin's
 * upgrade tunnel — nothing synthetic).
 *
 * The byte-exactness law: every written file's bytes are compared
 * against the SAME pure oracle the frozen edit contracts were derived
 * through (core's splice-writer over the inspected raw baseline), so a
 * drift from the corpus's behavior is a defect, not a diff.
 *
 * The wire law: every apply-edit the battery dispatches carries an
 * opaque grant and no absolute path (the plan's display path is the
 * UI-only project-relative form the grant schema itself carries).
 *
 * SERIAL like the lane's other batteries: one control plane, one
 * supervisor-global active session — every leg restores the idle state.
 */

/** One captured api mutation. */
interface CapturedWrite {
  readonly body: string;
  readonly headers: Record<string, string>;
}

/** Installs the wire listeners: every apply-edit request plus its settled response body. */
function captureWrites(page: Page): () => {
  writes: readonly CapturedWrite[];
  responses: readonly string[];
} {
  const writes: CapturedWrite[] = [];
  const responses: string[] = [];
  page.on('request', (request: Request) => {
    if (!request.url().endsWith('/__astroix/api/v1')) return;
    if (request.method() !== 'POST') return;
    const kind = (request.postDataJSON() as { command?: { kind?: string } } | null)?.command?.kind;
    if (kind === 'apply-edit') {
      writes.push({
        body: request.postData() ?? '',
        headers: { ...request.headers() },
      });
    }
  });
  page.on('response', async (response: Response) => {
    if (!response.url().endsWith('/__astroix/api/v1')) return;
    if (response.request().method() !== 'POST') return;
    const kind = (response.request().postDataJSON() as { command?: { kind?: string } } | null)
      ?.command?.kind;
    if (kind === 'apply-edit') {
      try {
        responses.push(await response.text());
      } catch {
        // a response whose body died with a replaced document — the
        // switch battery's own law, not this capture's concern
      }
    }
  });
  return () => ({ writes, responses });
}

/**
 * The batteries' shared activation prefix, the canvas selection, the
 * staged sheet's bytes, the settle budget, and the font-size oracle all
 * live in `spec-helpers.ts` (the lane's established home for the
 * batteries' carried duplication).
 */

/** Waits for the panel's ready list. */
async function readyRows(page: Page) {
  await expect(page.getByTestId('css-rule-list')).toBeVisible({ timeout: BOOT_BUDGET_MS });
  return page.locator('[data-testid="css-rule"]');
}

/** Opens the editor on one GLOBAL row and returns one declaration's value input. */
async function openGlobalEditor(
  page: Page,
  options: { readonly row?: number; readonly prop?: string; readonly served?: string } = {},
) {
  const row = options.row ?? 1;
  const prop = options.prop ?? 'font-size';
  const rows = await readyRows(page);
  await expect(rows).toHaveCount(4, { timeout: LOAD_BUDGET_MS });
  await page.locator('[data-testid="css-rule-edit"]').nth(row).click();
  await expect(page.getByTestId('css-rule-editor')).toBeVisible({ timeout: LOAD_BUDGET_MS });
  const input = page.locator(`[data-testid="css-decl-input"][data-css-prop="${prop}"]`);
  await expect(input).toHaveValue(options.served ?? '3rem', { timeout: LOAD_BUDGET_MS });
  return input;
}

/** The write badge's state word. */
function writeState(page: Page) {
  return page.getByTestId('css-write-status');
}

test.describe.configure({ mode: 'serial' });

test('auto-write lands the frozen splice bytes byte-exact, HMR reflects them, and the grant renews', async ({
  page,
}) => {
  test.setTimeout(360_000);
  const capture = captureWrites(page);
  await activateSettled(page);

  // the canvas element the HMR reflection reads — the same document the loop edits
  const canvasTitle = page.frameLocator(CANVAS_FRAME).locator('h1.hero-title');

  // SERIAL battery discipline: the staged copy's bytes restore in the
  // finally, whatever this leg leaves behind
  const pristine = await cssBytes();
  try {
    await canvasSelect(page, '.hero-title');
    await expect(page.getByTestId('selection-tag')).toHaveText('h1', {
      timeout: LOAD_BUDGET_MS,
    });
    const input = await openGlobalEditor(page);
    const before = await cssBytes();

    // the edit schedules the settled pause — the badge says so before any wire traffic
    await input.fill('3.5rem');
    await expect(writeState(page)).toHaveAttribute('data-write-state', 'scheduled', {
      timeout: LOAD_BUDGET_MS,
    });

    // the pause fires exactly ONE apply-edit; the machine goes writing
    await expect
      .poll(() => capture().writes.length, { timeout: LOAD_BUDGET_MS })
      .toBeGreaterThanOrEqual(1);
    await expect(writeState(page)).toHaveAttribute('data-write-state', /writing|saved/, {
      timeout: LOAD_BUDGET_MS,
    });

    // BYTE-EXACT: the staged sheet's bytes are the pure oracle's bytes
    await expect
      .poll(async () => await cssBytes(), { timeout: WRITE_SETTLE_MS })
      .toBe(expectedDeclarationWrite(before, 'font-size', '3rem', '3.5rem'));

    // the loop converged: the refresh landed, the badge went quiet, the
    // editor re-opened on the served truth (the written value)
    await expect(writeState(page)).toHaveAttribute('data-write-state', 'quiet', {
      timeout: WRITE_SETTLE_MS,
    });
    await expect(
      page.locator('[data-testid="css-decl-input"][data-css-prop="font-size"]'),
    ).toHaveValue('3.5rem', { timeout: WRITE_SETTLE_MS });

    // NOTE: the canvas pane sits inside the fixture's own
    // `@media (max-width: 640px)` breakpoint, whose `font-size: 2rem`
    // shadows the edited declaration in the live cascade — so the
    // computed-style HMR reflection rides the SAME rule's
    // `letter-spacing` (never media-shadowed, em-relative), while the
    // font-size splice's own proof stays the byte-exact law above.
    const spacingInput = page.locator(
      '[data-testid="css-decl-input"][data-css-prop="letter-spacing"]',
    );
    await expect(spacingInput).toHaveValue('-0.02em', { timeout: WRITE_SETTLE_MS });

    // the inspection renewed: the second edit from ONE pane, through the
    // RENEWED grant (the follow-on or the fresh facts' — either way the
    // chain moved), lands byte-exact and HMR-reflects
    await spacingInput.fill('0.3em');
    const afterFirst = expectedDeclarationWrite(before, 'font-size', '3rem', '3.5rem');
    await expect
      .poll(async () => await cssBytes(), { timeout: WRITE_SETTLE_MS })
      .toBe(expectedDeclarationWrite(afterFirst, 'letter-spacing', '-0.02em', '0.3em'));
    await expect(writeState(page)).toHaveAttribute('data-write-state', 'quiet', {
      timeout: WRITE_SETTLE_MS,
    });
    // the em resolves against the element's own live font-size — read it
    // from the same document, never a hardcoded cascade assumption
    const liveFontPx = await canvasTitle.evaluate((element) =>
      Number.parseFloat(window.getComputedStyle(element).fontSize),
    );
    await expect
      .poll(
        async () =>
          Number.parseFloat(
            await canvasTitle.evaluate((element) => window.getComputedStyle(element).letterSpacing),
          ),
        { timeout: WRITE_SETTLE_MS },
      )
      .toBeCloseTo(0.3 * liveFontPx, 2);

    // the wire law: every mutation carried an opaque css grant, never an
    // absolute path; every settled response renewed the grant
    const writes = capture().writes;
    expect(writes.length).toBe(2);
    for (const write of writes) {
      expect(write.body).toContain('"kind":"css"');
      expect(write.body).not.toMatch(/\/(Users|home|private)\//);
      expect(write.body).not.toMatch(/file:\/\//);
    }
    expect(writes[0]?.body).not.toBe(writes[1]?.body);
    await expect
      .poll(() => capture().responses.length, { timeout: LOAD_BUDGET_MS })
      .toBeGreaterThanOrEqual(2);
    for (const response of capture().responses) {
      expect(response).toContain('nextGrant');
    }
    // the renewal chain: the second dispatch never re-presented the first's token
    const firstToken = /"token":"([^"]+)"/.exec(writes[0]?.body ?? '')?.[1];
    const secondToken = /"token":"([^"]+)"/.exec(writes[1]?.body ?? '')?.[1];
    expect(firstToken).toBeTruthy();
    expect(secondToken).toBeTruthy();
    expect(secondToken).not.toBe(firstToken);
  } finally {
    await writeFile(STAGED_CSS_FILE, pristine);
  }

  await restoreIdle(page);
});

test('undo restores the exact bytes through the same grant-bound loop', async ({ page }) => {
  // #439: the undo's settle span carries UNDO_SETTLE_MS (sized past the
  // twice-observed >90 s load stall), so the leg's total ceiling grows
  // with it — the same per-leg headroom idiom the switch battery's
  // heavier legs use (420 s there).
  test.setTimeout(540_000);
  const capture = captureWrites(page);
  await activateSettled(page);
  await canvasSelect(page, '.hero-title');
  const input = await openGlobalEditor(page);
  const before = await cssBytes();

  await input.fill('3.5rem');
  await expect
    .poll(async () => await cssBytes(), { timeout: WRITE_SETTLE_MS })
    .toBe(expectedDeclarationWrite(before, 'font-size', '3rem', '3.5rem'));
  await expect(writeState(page)).toHaveAttribute('data-write-state', 'quiet', {
    timeout: WRITE_SETTLE_MS,
  });

  // the undo gesture is armed and dispatches the inverse splice — the
  // arming render is load-shaped like every other inner expect (#392's
  // sweep class), never the 5 s default
  await expect(page.getByTestId('css-undo')).toBeEnabled({ timeout: LOAD_BUDGET_MS });
  await page.getByTestId('css-undo').click();
  // #439: the inverse write rides the same debounced loop over the
  // retained executor child, and that span is the one observed stalling
  // past WRITE_SETTLE_MS under heavy load — the undo's settle gets its
  // own named budget, the asserted bytes never change
  await expect.poll(async () => await cssBytes(), { timeout: UNDO_SETTLE_MS }).toBe(before);
  await expect(writeState(page)).toHaveAttribute('data-write-state', 'quiet', {
    timeout: UNDO_SETTLE_MS,
  });
  // the undo consumed the stack — the gesture is honestly disabled now
  await expect(page.getByTestId('css-undo')).toBeDisabled({ timeout: LOAD_BUDGET_MS });
  // two mutations total: the write and its inverse
  expect(capture().writes.length).toBe(2);

  await restoreIdle(page);
});

test('coalesced typing dispatches ONE write and the badge settles back to quiet', async ({
  page,
}) => {
  test.setTimeout(360_000);
  const capture = captureWrites(page);
  await activateSettled(page);
  await canvasSelect(page, '.hero-title');
  const input = await openGlobalEditor(page);
  const before = await cssBytes();

  try {
    // COALESCED INPUT: every keystroke inside the settled ~300 ms window
    // schedules again (the pause extends; the key's pending schedule is
    // REPLACED, never stacked), so the whole burst must cross the wire
    // exactly once — and the badge, whose pending-pause count is DERIVED
    // from the scheduler's pending keys, must settle back to quiet after
    // the landing (a count that incremented per keystroke would read
    // scheduled forever with no path back to zero).
    await input.fill('');
    await input.pressSequentially('3.5rem', { delay: 60 });

    await expect
      .poll(async () => await cssBytes(), { timeout: WRITE_SETTLE_MS })
      .toBe(expectedDeclarationWrite(before, 'font-size', '3rem', '3.5rem'));
    await expect(writeState(page)).toHaveAttribute('data-write-state', 'quiet', {
      timeout: WRITE_SETTLE_MS,
    });
    // exactly ONE mutation crossed — the burst coalesced into one pause
    expect(capture().writes.length).toBe(1);
  } finally {
    await writeFile(STAGED_CSS_FILE, before);
  }

  await restoreIdle(page);
});

test('an external interference conflicts: no bytes written, the stable conflict state, undo cleared', async ({
  page,
}) => {
  test.setTimeout(360_000);
  const capture = captureWrites(page);
  await activateSettled(page);
  await canvasSelect(page, '.hero-title');
  const input = await openGlobalEditor(page);
  const before = await cssBytes();

  // Hold the styles refetch so the interference cannot re-arm the
  // grant before the debounced dispatch: the conflict leg needs the
  // STALE grant to reach the server deterministically.
  await page.route('**/__astroix/api/v1', async (route) => {
    const body = route.request().postDataJSON() as {
      command?: { kind?: string; request?: { kind?: string } };
    } | null;
    if (body?.command?.kind === 'inspect' && body.command.request?.kind === 'styles') {
      const response = await route.fetch();
      await page.waitForTimeout(5_000);
      try {
        await route.fulfill({ response });
      } catch {
        // the document moved on — the held refetch died with it
      }
      return;
    }
    await route.fallback();
  });

  // the frozen conflict corpus's own interference: another
  // declaration's bytes change on disk under our stale grant
  const interference = before.replace('gap: 1rem;', 'gap: 1.5rem;');
  try {
    await writeFile(STAGED_CSS_FILE, interference);

    await input.fill('3.5rem');
    await expect
      .poll(() => capture().writes.length, { timeout: LOAD_BUDGET_MS })
      .toBeGreaterThanOrEqual(1);
    // the stable conflict state with the disk-truth handback
    await expect(writeState(page)).toHaveAttribute('data-write-state', 'conflict', {
      timeout: WRITE_SETTLE_MS,
    });
    await expect(writeState(page)).toHaveAttribute('data-write-conflict', /^[0-9a-f]{64}$/, {
      timeout: LOAD_BUDGET_MS,
    });

    // NO bytes of ours: the sheet carries the interference alone
    expect(await cssBytes()).toBe(interference);
    // the conflict did not stack a second dispatch
    await page.waitForTimeout(1_000);
    expect(capture().writes.length).toBe(1);

    // the held refetch is released by the unroute; the conflict state
    // STAYS until the next edit re-arms it (the stable refusal)
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await expect(writeState(page)).toHaveAttribute('data-write-state', 'conflict', {
      timeout: LOAD_BUDGET_MS,
    });
    // undo cleared: the stack's baselines died with the conflicted world
    await expect(page.getByTestId('css-undo')).toBeDisabled({ timeout: LOAD_BUDGET_MS });
  } finally {
    await writeFile(STAGED_CSS_FILE, before);
  }

  await restoreIdle(page);
});

test('tampered replays are refused grant-bound: wrong kind, cross-session, stale grant', async ({
  page,
}) => {
  test.setTimeout(360_000);
  const capture = captureWrites(page);
  await activateSettled(page);
  await canvasSelect(page, '.hero-title');
  const input = await openGlobalEditor(page);
  const before = await cssBytes();

  // one honest write to mint a real request shape
  await input.fill('3.5rem');
  await expect
    .poll(async () => await cssBytes(), { timeout: WRITE_SETTLE_MS })
    .toBe(expectedDeclarationWrite(before, 'font-size', '3rem', '3.5rem'));
  const honest = capture().writes[0];
  if (honest === undefined) throw new Error('no honest write captured');
  const envelope = JSON.parse(honest.body) as {
    requestId: string;
    session: { runtimeEpoch: string; generation: number };
    command: { kind: string; plan: { grant: { token: string; kind: string } } };
  };

  // the replay vehicle: the page's own fetch, the captured mutation
  // headers, a tampered body — the real admission path, never a bypass
  const replay = async (mutate: (body: string) => string): Promise<{ code: string }> => {
    return await page.evaluate(
      async ({
        url,
        headers,
        body,
      }: {
        url: string;
        headers: Record<string, string>;
        body: string;
      }) => {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body,
        });
        const parsed = (await response.json()) as { error?: { code?: string } };
        return { code: parsed.error?.code ?? 'none' };
      },
      { url: '/__astroix/api/v1/', headers: honest.headers, body: mutate(honest.body) },
    );
  };

  // WRONG KIND: the css splice presented under a content claim — the
  // species matrix refuses before any table state
  const wrongKind = await replay((body) => body.replace('"kind":"css"', '"kind":"content"'));
  expect(wrongKind.code).toBe('grant-rejected');

  // CROSS-SESSION: the honest plan under a dead generation — the
  // admission refuses the stale pair outright
  const crossSession = await replay((body) =>
    body.replace(
      `"generation":${envelope.session.generation}`,
      `"generation":${envelope.session.generation - 1}`,
    ),
  );
  expect(crossSession.code).toBe('stale-session');

  // STALE GRANT: the verbatim replay after the world moved — the token
  // is superseded and the baseline changed; either truth refuses
  const stale = await replay((body) => body);
  expect(['grant-rejected', 'revision-conflict']).toContain(stale.code);

  // none of the replays wrote: the sheet is the honest write's bytes
  expect(await cssBytes()).toBe(expectedDeclarationWrite(before, 'font-size', '3rem', '3.5rem'));

  await restoreIdle(page);
});
