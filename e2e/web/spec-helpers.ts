import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Frame, type Page, type Route } from '@playwright/test';
import { settleMemoPath, stagedCopyRoot } from '../../apps/web/src/stage-e2e.ts';
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

/**
 * The undo settle budget (#439): the same grant-bound write loop as the
 * forward write — the debounce dispatch, the retained executor's
 * commit, and the post-commit refresh convergence — over a pipeline
 * that stalled PAST WRITE_SETTLE_MS twice under heavy local machine
 * load (load average 20-47; solo green ~29 s, calm-machine full green,
 * CI green — a pure load stall, the file still at the written value at
 * 90 s with no error), so the undo's settle span gets its own budget
 * sized past the observed stall class (2x the red'd ceiling, the
 * family's decisive-resize idiom) rather than inheriting the forward
 * write's first-edit budget. Single-homed here so a future resize is
 * one line, not another fleet-wide literal diff.
 */
export const UNDO_SETTLE_MS = 180_000;

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
 * (runtime epoch, generation) pair the lane's landings have served —
 * the helper landings below AND every raw `activateButton` landing
 * (#433 round 2: five raw-click specs and the A-B-A harness's
 * idempotent landing used to fall outside the record, so a mid-test
 * failure there still handed the next battery the misleading cold red
 * this memo exists to kill) — kept as one JSON file keyed by the
 * invocation's scratch root but living OUTSIDE it (the derivation is
 * homed in `stage-e2e.ts` beside the root contract, and the lane's
 * teardown removes the file with the root), so the record crosses the
 * project/worker boundaries of the serial run (one control plane, one
 * scratch root, one worker at a time). Its law rests on two supervisor
 * truths: every activation attempt — committed, failed, or cancelled —
 * consumes a FRESH generation, and the idempotent re-activation
 * (#413/#419) returns the CURRENT session's pair. So a pair the memo
 * already knows is the SAME live session — never a fresh plane, never
 * a boot to wait through — but its RE-ATTACHED canvas iframe is a
 * fresh client connect: the plane's one post-connect reload may fire
 * on it again and TRAIL the settle threshold (the CI-observed warm
 * shape), which the warm quiescence absorbs (see activateSettled). An
 * unknown pair is a session this invocation never landed: a young
 * plane whose one self-reload the settle discipline must still wait
 * for.
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
 * Records one landed session and answers whether it was already known —
 * the warm/cold discriminator. Called by EVERY landing the lane serves:
 * the two helpers below, and — since #433 round 2 — every raw
 * `activateButton` landing directly (the raw-click specs and the A-B-A
 * harness's idempotent landing discard the answer; recording alone is
 * their job, so a mid-test failure ANYWHERE in the lane leaves the
 * next battery's first settle warm-classified).
 */
export async function recordLandedSession(page: Page): Promise<boolean> {
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
    // The repo's atomic-write idiom (the fixed-file-store's, test-infra
    // sized): same-directory temp + rename, so a crash mid-write leaves
    // the previous whole file — never a truncated JSON the next read
    // fails on with a confusing non-ENOENT parse error.
    const tempPath = `${path}.tmp`;
    await writeFile(tempPath, `${JSON.stringify([...known, key], undefined, 2)}\n`, 'utf8');
    await rename(tempPath, path);
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
 * warm law does NOT promise zero trailing navigations: the re-attached
 * canvas iframe is a fresh client connect, so the plane's one
 * post-connect reload may fire on it again and land AFTER the ≥ 1
 * threshold (CI run 33932953309 caught exactly that inside the old
 * zero-window). Warm quiescence therefore tolerates AT MOST that one
 * trailing reload — the window re-anchors on it and absorbs it inside
 * the settle budget — and reds on a second. The pair is recorded
 * BEFORE the poll so a settle that fails still seeds the memo: the
 * battery that follows a failed leg settles honestly.
 */

/** The post-threshold quiescence window — cold planes prove zero further navigations; warm planes tolerate the re-attached canvas's one trailing reload and re-anchor the window on it. */
const QUIESCENCE_MS = 1500;
export async function activateSettled(page: Page, position = 0): Promise<void> {
  const frameNavigations: string[] = [];
  let lastNavigationAt = performance.now();
  const onNavigated = (frame: Frame): void => {
    if (frame.parentFrame() !== null) {
      frameNavigations.push(frame.url());
      lastNavigationAt = performance.now();
    }
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
  if (!warm) {
    // COLD: the ≥ 2 threshold already counted the post-connect reload
    // — the window proves NO further navigation.
    await page.waitForTimeout(QUIESCENCE_MS);
    expect(frameNavigations).toEqual([]);
  } else {
    // WARM: the one trailing reload is absorbed, not leaked — the
    // window re-anchors on every navigation and only a SECOND one
    // ("never more") can red.
    await expect
      .poll(() => performance.now() - lastNavigationAt, { timeout: SETTLE_BUDGET_MS })
      .toBeGreaterThanOrEqual(QUIESCENCE_MS);
    expect(
      frameNavigations.length,
      'the warm plane fired more than its one post-connect reload',
    ).toBeLessThanOrEqual(1);
  }
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
