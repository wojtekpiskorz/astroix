import { expect, test } from '@playwright/test';
import { rawExchange, rawStatus } from '../../apps/web/src/e2e-wire.ts';
import { WEB_LANE_PORT } from '../../apps/web/src/stage-e2e.ts';
import {
  activateButton,
  BOOT_BUDGET_MS,
  LOAD_BUDGET_MS,
  recordLandedSession,
} from './spec-helpers.ts';

/**
 * The activation battery of the web host's product E2E (#240): the
 * launcher's activate button drives the settled transition protocol
 * (ADR-0006 §4) through the ONE AppClient against the real control
 * plane — a real managed `astro dev` child per activation, the real
 * supervisor and switch coordinator, the real origin leases. The legs:
 * the committed activation (navigate to the project app, inspect under
 * the fresh pair), the deactivation (back to the launcher), the failed
 * activation (the broken root's sanitized failure, launcher kept), and
 * the stale-session rejection after an A-to-B-to-A cycle — the exact
 * pair the old tab still holds is refused while its hostname serves
 * the current generation (ADR-0006 §3/§5).
 *
 * The suite is SERIAL BY NATURE, not by convenience: one control plane,
 * one supervisor-global active session (ADR-0004) — the battery walks
 * one coherent session history, and every leg restores the idle state
 * for the next one (the launcher label at each boundary is the state
 * machine's own derivation, pinned along the way).
 *
 * Every landing/transition wait in this battery is load-shaped (#392):
 * an activation commit spawns a whole dev-server plane and the
 * deactivation runs the fence/revocation pass before the launcher
 * serves — under shared-runner load the expect default (the library's
 * 5s before #459 pinned it to 30s at the config level) and the 30s
 * navigation default trip on machine load alone. The budgets grow
 * (120s per transition wait, 30s per landing expect); the asserted
 * values never change.
 */

test.describe.configure({ mode: 'serial' });

test('activation commits through the settled transition and lands on the project app', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
  await activateButton(page, 0).click();
  await page.waitForURL(/^http:\/\/(?!launcher)[a-z2-7]+\.localhost:\d+\/__astroix\/app\/$/, {
    timeout: BOOT_BUDGET_MS,
  });
  await recordLandedSession(page);
  // The project document is bound at the committed pair: generation 1
  // (the epoch's first attempt) and a live inspection revision.
  await expect(page.getByTestId('session-generation')).toHaveText('1', { timeout: LOAD_BUDGET_MS });
  await expect(page.getByTestId('inspect-revision')).toHaveText(/^\d+$/, {
    timeout: LOAD_BUDGET_MS,
  });

  // Restore the idle state for the next leg.
  await page.getByTestId('deactivate').click();
  await page.waitForURL(/launcher\.localhost:\d+\/__astroix\/app\//, { timeout: BOOT_BUDGET_MS });
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
});

test('deactivation completes the transition back to the launcher', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
  await activateButton(page, 1).click();
  await page.waitForURL(/^http:\/\/(?!launcher)[a-z2-7]+\.localhost:\d+\/__astroix\/app\/$/, {
    timeout: BOOT_BUDGET_MS,
  });
  await recordLandedSession(page);
  await page.getByTestId('deactivate').click();
  await page.waitForURL(/launcher\.localhost:\d+\/__astroix\/app\//, { timeout: BOOT_BUDGET_MS });
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
});

test('a failed activation reports the sanitized failure and keeps the launcher', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
  await activateButton(page, 2).click(); // the broken root: no installation to resolve
  await expect(page.getByTestId('last-failure')).toBeVisible({ timeout: LOAD_BUDGET_MS });
  await expect(page.getByTestId('last-failure')).toContainText('activation:', {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.getByTestId('session-label')).toHaveText('failed', { timeout: LOAD_BUDGET_MS });
  await expect(page).toHaveURL(/launcher\.localhost:\d+\/__astroix\/app\//, {
    timeout: LOAD_BUDGET_MS,
  });

  // Restore the idle state: a successful activation clears the failure,
  // its deactivation returns the neutral label.
  await activateButton(page, 0).click();
  await page.waitForURL(/^http:\/\/(?!launcher)[a-z2-7]+\.localhost:\d+\/__astroix\/app\/$/, {
    timeout: BOOT_BUDGET_MS,
  });
  await recordLandedSession(page);
  await page.getByTestId('deactivate').click();
  await page.waitForURL(/launcher\.localhost:\d+\/__astroix\/app\//, { timeout: BOOT_BUDGET_MS });
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
});

test('a stale session is refused after an A-to-B-to-A cycle while the hostname serves the current pair', async ({
  context,
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
  await activateButton(page, 0).click(); // generation 1 on project A
  await page.waitForURL(/^http:\/\/(?!launcher)[a-z2-7]+\.localhost:\d+\/__astroix\/app\/$/, {
    timeout: BOOT_BUDGET_MS,
  });
  await recordLandedSession(page);
  const projectAOrigin = new URL(page.url()).origin;
  const staleTab = page;

  // The switch: a second page of the SAME context (shared cookie jar)
  // activates project B from the launcher — generation 2, project A's
  // lease revoked.
  const switchTab = await context.newPage();
  await switchTab.goto('/__astroix/app/');
  await activateButton(switchTab, 1).click();
  await switchTab.waitForURL(/^http:\/\/(?!launcher)[a-z2-7]+\.localhost:\d+\/__astroix\/app\/$/, {
    timeout: BOOT_BUDGET_MS,
  });
  await recordLandedSession(switchTab);
  const projectBOrigin = new URL(switchTab.url()).origin;
  expect(projectBOrigin).not.toBe(projectAOrigin);

  // While B holds the lease, A's hostname is retired: 421, the whole
  // listener lifetime (ADR-0006 §5 / F1's routing law).
  const aHost = new URL(projectAOrigin).host;
  const retired = await rawStatus(
    WEB_LANE_PORT,
    `GET /__astroix/app/ HTTP/1.1\r\nHost: ${aHost}\r\nConnection: close\r\n\r\n`,
  );
  expect(retired).toBe(421);

  // Back to A: a fresh generation (every attempt consumes one — the
  // battery's earlier legs have too), fresh authority, and the shared
  // jar now holds the new project-A capability.
  await switchTab.goto('/__astroix/app/');
  await activateButton(switchTab, 0).click();
  await switchTab.waitForURL(`${projectAOrigin}/__astroix/app/`, { timeout: BOOT_BUDGET_MS });
  await recordLandedSession(switchTab);
  // Converge the generation text before the one-shot numeric read (#392:
  // a one-shot read of rendered state races the first commits under load).
  await expect(switchTab.getByTestId('session-generation')).toHaveText(/^\d+$/, {
    timeout: LOAD_BUDGET_MS,
  });
  const freshGeneration = Number(await switchTab.getByTestId('session-generation').textContent());
  expect(freshGeneration).toBeGreaterThan(1);

  // The stale tab still holds generation 1's pair AND generation 1's
  // client capability — and authority never outlives its session: the
  // dead binding is refused before any session question is asked.
  await staleTab.getByTestId('reinspect').click();
  await expect(staleTab.getByTestId('command-error')).toBeVisible({ timeout: LOAD_BUDGET_MS });
  await expect(staleTab.getByTestId('command-error')).toHaveText('unauthorized', {
    timeout: LOAD_BUDGET_MS,
  });

  // The stale-session refusal itself, over the raw wire with LIVE
  // authority and a STALE pair (the F2 admission's own law, observed
  // against the live host): the fresh document's capability and cookie
  // with generation 1's envelope pair.
  const liveClient = await switchTab.locator('meta[name="astroix-client"]').getAttribute('content');
  const liveCookie = (await context.cookies(projectAOrigin)).find(
    (cookie) => cookie.name === '__astroix_host',
  );
  const epoch = await switchTab.locator('meta[name="astroix-epoch"]').getAttribute('content');
  expect(liveClient).toBeTruthy();
  expect(liveCookie).toBeTruthy();
  expect(epoch).toBeTruthy();
  const envelope = JSON.stringify({
    protocolVersion: 1,
    requestId: 'stale-probe',
    session: { runtimeEpoch: epoch, generation: 1 },
    command: { kind: 'inspect', request: { kind: 'project' } },
  });
  const stale = await rawExchange(
    WEB_LANE_PORT,
    [
      'POST /__astroix/api/v1 HTTP/1.1',
      `Host: ${aHost}`,
      `Cookie: __astroix_host=${liveCookie?.value ?? ''}`,
      `X-Astroix-Client: ${liveClient ?? ''}`,
      'Content-Type: application/json',
      'Sec-Fetch-Site: same-origin',
      `Content-Length: ${Buffer.byteLength(envelope, 'utf8')}`,
      'Connection: close',
      '',
      envelope,
    ].join('\r\n'),
  );
  expect(stale.status).toBe(409);
  expect(stale.body).toContain('"stale-session"');

  // Restore the idle state for whatever follows the battery.
  await switchTab.getByTestId('deactivate').click();
  await switchTab.waitForURL(/launcher\.localhost:\d+\/__astroix\/app\//, {
    timeout: BOOT_BUDGET_MS,
  });
  await expect(switchTab.getByTestId('session-label')).toHaveText('idle', {
    timeout: LOAD_BUDGET_MS,
  });
});
