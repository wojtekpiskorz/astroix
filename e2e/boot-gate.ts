import { expect, type Locator, type Page } from '@playwright/test';

// The first slice the gate waits before its recovery hop; healthy boots land
// in single-digit seconds, so this is already generous for slow-but-live.
const FIRST_SLICE = 45_000;

/**
 * Cold-boot gate with one recovery hop (#158, of #129's boot-contention
 * family). The first chrome-module / canvas-page request can stall
 * request-scoped under CPU contention: it never resolves on its own, but it
 * clears the moment the waiting page tears down and cancels it — the
 * re-request then lands in seconds (observed: the spec after every gate
 * failure boots chrome in 3.8-3.9 s, across 45/60/105 s gate budgets). No
 * fixed budget out-waits such a stall, so the gate spends its first slice
 * waiting, reloads once to cancel a stalled request, and spends the rest of
 * the budget on the re-request. A genuinely hung boot fails at the budget
 * with the boot-naming error — the reload does not rescue it.
 *
 * A budget that cannot fund the recovery hop is a single-shot wait: a zero
 * remainder would read as "no deadline" to playwright and a negative one
 * would fail instantly after a reload that cancelled a live boot.
 */
export async function expectVisibleWithBootRecovery(
  page: Page,
  marker: Locator,
  message: string,
  budget: number,
): Promise<void> {
  if (budget <= FIRST_SLICE) {
    await expect(marker, message).toBeVisible({ timeout: budget });
    return;
  }
  try {
    await expect(marker, message).toBeVisible({ timeout: FIRST_SLICE });
    return;
  } catch {
    // recovery hop below — the marker may simply be slow-but-live and the
    // reload is harmless (the URL, and thus the canvas position, is kept)
  }
  await page.reload();
  await expect(marker, message).toBeVisible({ timeout: budget - FIRST_SLICE });
}
