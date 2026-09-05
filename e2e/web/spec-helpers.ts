import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, type Frame, type Page, type Route } from '@playwright/test';
import { stagedCopyRoot, WEB_E2E_SCRATCH_ENV } from '../../apps/web/src/stage-e2e.ts';
import { spliceText } from '../../packages/core/src/splice-writer.ts';

/**
 * The web lane's shared spec helpers (#242 review round 2: the
 * batteries' carried duplication — the activate button, the two
 * document-URL shapes, and the restore-idle tail — absorbed into one
 * small module per tier; this is the spec tier). #250's write
 * batteries and #249's inspection battery grew the same way: the
 * settled-activation prefix, the canvas selection retry, the staged
 * sheet's bytes, the write-settle budget, and the pure splice oracle.
 * #423's review homed the #393 freeze/abort ordering-proof pair here
 * as well — the K2 harness had copied the app-shell battery's locals
 * line-for-line, and the discipline has a recorded history of needing
 * revision under load. Test-only, imported by the lane's specs; no
 * product code touches it.
 */

/** The list item whose staged copy is at `position` (0 and 1 are the fixture copies; 2 is broken). */
export function activateButton(page: Page, position: number) {
  return page.getByTestId('project-list').locator('li').nth(position).getByTestId('activate');
}

/** The project-app document URL on any active project host. */
export const PROJECT_APP_URL = /^http:\/\/(?!launcher)[a-z2-7]+\.localhost:\d+\/__astroix\/app\/$/;

/** The launcher document URL. */
export const LAUNCHER_APP_URL = /launcher\.localhost:\d+\/__astroix\/app\//;

/**
 * The batteries' load-shaped expect budget (#392 review round 1): one
 * convergence point (a poll, a text settle, a generation read) on a
 * loaded CI runner. Single-homed here so a future resize is one line,
 * not another fleet-wide literal diff.
 */
export const LOAD_BUDGET_MS = 30_000;

/**
 * The batteries' boot-shaped budget (#392 review round 1): a plane boot —
 * child spawn, dev-server readiness, first document — under CI load.
 */
export const BOOT_BUDGET_MS = 120_000;

/**
 * The batteries' settle budget (#396, folding #395's recorded rider):
 * the young managed dev server converging under CI load — the frame's
 * post-connect self-reload settle (activateSettled's navigation poll,
 * previously the unnamed `LOAD_BUDGET_MS * 2`), and the content
 * battery's settles over the freshly-booted plane: the first
 * inspection's fresh runner and the canvas's first route compile
 * (write settles carry their own #250 budget below). Sized between
 * the landing and plane-boot budgets; single-homed here so a future
 * resize is one line, not another fleet-wide literal diff.
 */
export const SETTLE_BUDGET_MS = 60_000;

/** The canvas select's toPass retry ceiling — three load-budget windows for the interactive retry loop (named: the last multiplier in the file). */
export const CANVAS_SELECT_RETRY_MS = LOAD_BUDGET_MS * 3;

/**
 * The write batteries' settle budget (#250): the first accepted edit
 * forks the real write-executor child, and the settle spans the fork,
 * the executor's commit, and the post-commit refresh convergence.
 */
export const WRITE_SETTLE_MS = 90_000;

/** The staged copy the write batteries edit (registered first — position 0). */
export const STAGED_CSS_FILE = join(stagedCopyRoot('project-a'), 'src', 'pages', 'home.css');

/** The staged sheet's current bytes — the write batteries' disk truth. */
export async function cssBytes(): Promise<string> {
  return await readFile(STAGED_CSS_FILE, 'utf8');
}

/** Activates the first staged fixture copy and lands the project document (the content batteries' shared opening). */
export async function activateProject(page: Page): Promise<void> {
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle', {
    timeout: LOAD_BUDGET_MS,
  });
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL, { timeout: BOOT_BUDGET_MS });
  // #422 (trap b): this landing records its session for the
  // warm-activation memo too — a content leg that fails mid-test
  // leaves the session active, and the next battery's settled
  // activation over that warm shape must recognize it (the memo's
  // law lives with activateSettled below).
  await recordLandedSession(page);
}

/**
 * The batteries' restore tail: deactivate, land on the launcher, pin the
 * idle state for whatever follows. Sized for a loaded CI runner (#392):
 * the deactivation's commit-side work (fence drain, revocation, launcher
 * readiness) and the launcher's first render are load-shaped waits.
 */
export async function restoreIdle(page: Page): Promise<void> {
  await page.getByTestId('deactivate').click();
  await page.waitForURL(LAUNCHER_APP_URL, { timeout: BOOT_BUDGET_MS });
  await expect(page.getByTestId('session-label')).toHaveText('idle', {
    timeout: LOAD_BUDGET_MS,
  });
}

/**
 * The invocation-scoped warm-activation memo (#422, trap b): every
 * (runtime epoch, generation) pair a battery helper's landing has
 * served, kept as one JSON file keyed by the invocation's scratch root
 * but living OUTSIDE it (see settleMemoPath), so the record crosses the
 * project/worker boundaries of the serial run (one control plane, one
 * scratch root, one worker at a time). Its law rests on two supervisor
 * truths: every activation attempt — committed, failed, or cancelled —
 * consumes a FRESH generation, and the idempotent re-activation
 * (#413/#419) returns the CURRENT session's pair. So a pair the memo
 * already knows is the SAME live session — never a fresh plane — and
 * its dev server has been up since the first landing: the canvas has
 * no young-server post-connect self-reload pending, and ONE navigation
 * is the settled truth. An unknown pair is a session this invocation
 * never landed: a young plane whose one self-reload the settle
 * discipline must still wait for.
 */

/** The landed document's session identity — the bootstrap metas every served project document carries. */
interface LandedSession {
  readonly epoch: string;
  readonly generation: number;
}

/** Reads the landed project document's session identity off its own served metas (the K harness's proven surface). */
async function landedSession(page: Page): Promise<LandedSession> {
  const epoch = await page.locator('meta[name="astroix-epoch"]').getAttribute('content');
  const generation = await page.locator('meta[name="astroix-generation"]').getAttribute('content');
  if (epoch === null || generation === null || !/^\d+$/.test(generation)) {
    throw new Error('the landed project document did not carry its session identity metas');
  }
  return { epoch, generation: Number.parseInt(generation, 10) };
}

/**
 * The memo file's path OUTSIDE the scratch root, keyed by it — the
 * invocation identity without the wiped directory. The root is
 * disposable by design: the staging wipes it on every real (re)stage,
 * and Playwright re-evaluates the config in every worker — before the
 * config's worker guard (#422), a replacement worker's re-evaluation
 * wiped the root MID-INVOCATION after any failed leg (the observed
 * cascade doom: the memo died exactly when the warm shape needed it,
 * and the live plane's staged files vanished under it). Outside the
 * root the memo survives every wipe, and its keys are epoch-scoped, so
 * a stale file from a previous invocation over an explicit (reused)
 * scratch root can never match the new control plane's epoch. Fails
 * loudly when no staging has run.
 */
function settleMemoPath(): string {
  const root = process.env[WEB_E2E_SCRATCH_ENV];
  if (root === undefined || root === '') {
    throw new Error(
      `spec-helpers: ${WEB_E2E_SCRATCH_ENV} is unset — the warm-activation memo is keyed by the staging's scratch root (#422)`,
    );
  }
  const tag = root.split(/[\\/]/).filter(Boolean).pop();
  if (tag === undefined) throw new Error(`spec-helpers: malformed scratch root "${root}" (#422)`);
  return join(dirname(root), `.astroix-${tag}-settle-generations.json`);
}

/** Records one landed session and answers whether it was already known — the warm/cold discriminator. */
async function recordLandedSession(page: Page): Promise<boolean> {
  const session = await landedSession(page);
  const key = `${session.epoch}#${session.generation}`;
  const path = settleMemoPath();
  let known: string[];
  try {
    known = JSON.parse(await readFile(path, 'utf8')) as string[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      known = [];
    } else {
      throw error;
    }
  }
  const warm = known.includes(key);
  if (!warm) {
    await writeFile(path, `${JSON.stringify([...known, key], undefined, 2)}\n`, 'utf8');
  }
  return warm;
}

/**
 * The batteries' shared activation prefix: land on the launcher,
 * activate, and WAIT FOR THE CANVAS TO SETTLE — the initial load plus,
 * on a COLD activation, the young dev server's one post-connect
 * self-reload (the canvas battery's own HMR-leg discipline; a click
 * racing that rebuild lands on a document whose capture listener is
 * between epochs and is lost). Event-ordered: the baseline navigations
 * complete BEFORE the settle clock starts, and the settle window
 * proves no further navigation is in flight. `position` selects the
 * staged copy to activate (the A-B-A switch harness reaches 1; every
 * other battery takes the default 0) — the ONE spelling of this
 * settle discipline, never re-derived (#254 review: the copy had
 * already drifted at birth).
 *
 * #422 (trap b): the settle is WARM-TOLERANT. The navigation count is
 * a proxy for "the young server's one post-connect reload happened",
 * and that proxy is simply wrong for the idempotent re-activation
 * (#413/#419's law): activating an already-active project answers the
 * CURRENT session over a warm plane, which legitimately settles with
 * ONE canvas navigation — a fixed ≥ 2 baseline reds the NEXT battery's
 * first settle after any upstream leg failed mid-test and left the
 * session active, pointing at this helper instead of the real failure.
 * The warm/cold discriminator is the landed session's memo membership
 * (see the memo above): a known pair settles on ≥ 1 navigation, an
 * unknown pair — a fresh plane — keeps the cold ≥ 2 reload guard. The
 * pair is recorded BEFORE the poll so a settle that fails still seeds
 * the memo: the battery that follows a failed leg settles honestly.
 */
export async function activateSettled(page: Page, position = 0): Promise<void> {
  const frameNavigations: string[] = [];
  const onNavigated = (frame: Frame): void => {
    if (frame.parentFrame() !== null) frameNavigations.push(frame.url());
  };
  page.on('framenavigated', onNavigated);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
  await activateButton(page, position).click();
  await page.waitForURL(PROJECT_APP_URL, { timeout: BOOT_BUDGET_MS });
  await expect(page.getByTestId('canvas-origin-state')).toHaveText('project', {
    timeout: LOAD_BUDGET_MS,
  });
  const warm = await recordLandedSession(page);
  await expect
    .poll(() => frameNavigations.length, { timeout: SETTLE_BUDGET_MS })
    .toBeGreaterThanOrEqual(warm ? 1 : 2);
  frameNavigations.length = 0;
  await page.waitForTimeout(1500);
  expect(frameNavigations).toEqual([]);
  page.removeListener('framenavigated', onNavigated);
}

/** The canvas frame locator — the product-attribute form (#374 ruling), never a test id. */
export const CANVAS_FRAME = '[data-astroix-canvas] iframe';

/**
 * Clicks one canvas element until the selection lands — bounded retry
 * over a possibly-reloading document (a mid-navigation click is
 * retried, never assumed).
 */
export async function canvasSelect(page: Page, selector: string): Promise<void> {
  await expect(async () => {
    await page.frameLocator(CANVAS_FRAME).locator(selector).click();
    await expect(page.getByTestId('selection-tag')).not.toHaveText('none', { timeout: 2_000 });
  }).toPass({ timeout: CANVAS_SELECT_RETRY_MS });
}

/**
 * The frozen splice's own oracle — the first global font-size
 * declaration spliced to its next value: the SAME pure core
 * splice-writer the frozen edit contracts were derived through, so a
 * drift from the corpus's behavior is a defect, not a diff.
 */
export function expectedDeclarationWrite(
  before: string,
  property: string,
  fromValue: string,
  nextValue: string,
): string {
  const replaced = `${property}: ${fromValue};`;
  const start = before.indexOf(replaced);
  if (start === -1) throw new Error(`the staged sheet lost "${replaced}"`);
  return spliceText(before, {
    start,
    end: start + replaced.length,
    replacement: `${property}: ${nextValue};`,
  });
}

/**
 * The complete four-step reset trace the marker carries once the
 * sequencer finished (#393 capture) — the ordering proofs' shared
 * assertion constant. Inside `page.evaluate` callbacks the literal
 * stays INLINE (evaluate callbacks close over nothing); every
 * node-side assertion reads this one spelling.
 */
export const COMPLETE_RESET_TRACE = 'reset=abort-fetches,close-sse,remove-queries,clear-stores';

/** The frozen capture's read half — empty until the complete reset trace was observed. */
export interface ResetFreeze {
  read(): Promise<string>;
}

/**
 * The #393 frozen capture — ONE spelling for every ordering proof (the
 * app-shell battery's leg and the K-family's; #423 review: the K2
 * harness's copy of the battery's local was line-for-line): a page-side
 * MutationObserver freezing the FIRST marker text that carries the
 * complete reset trace — exactly the post-`clear-stores` truth,
 * whatever renders the dying document attempts afterwards. Still-mounted
 * observers can re-subscribe session queries in the async window
 * between the reset's synchronous completion (the direct DOM write —
 * React state cannot commit synchronously ahead of `location.replace`)
 * and the replacement's document teardown, re-minting session-scoped
 * cache entries the dying document's marker then counts (observed on
 * loaded runners); that transient is out of the sequencer's
 * jurisdiction, and the frozen snapshot is the honest capture
 * discipline around it — the previous one-shot read raced that window
 * (#392).
 */
export async function freezeResetState(page: Page): Promise<ResetFreeze> {
  await page.evaluate(() => {
    new MutationObserver(() => {
      const holder = window as unknown as { __astroixResetFreeze?: string };
      if (holder.__astroixResetFreeze !== undefined) return;
      const text = document.querySelector('[data-testid="shell-state"]')?.textContent;
      // literal, not a module const: page.evaluate callbacks close over nothing
      if (text?.includes('reset=abort-fetches,close-sse,remove-queries,clear-stores')) {
        holder.__astroixResetFreeze = text;
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  return {
    read: async () =>
      await page.evaluate(
        () => (window as unknown as { __astroixResetFreeze?: string }).__astroixResetFreeze ?? '',
      ),
  };
}

/**
 * Aborts the next launcher-document navigation so the OLD document
 * SURVIVES with the replacement already attempted — the ordering
 * proof's interception half: the navigation request demonstrably went
 * out (the abort saw it), and the still-alive document's state is
 * readable afterwards, directly. (Intercept-and-continue with an
 * in-handler `page.evaluate` deadlocks: the renderer suspends during
 * the pending provisional navigation.)
 */
export async function abortNextLauncherNavigation(page: Page): Promise<void> {
  let observed = false;
  await page.route(/launcher\.localhost/, async (route: Route) => {
    if (!observed && route.request().resourceType() === 'document') {
      observed = true;
      await route.abort('aborted');
      return;
    }
    await route.continue().catch(() => {});
  });
}
