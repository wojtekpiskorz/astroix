import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import {
  activateSettled,
  LOAD_BUDGET_MS,
  restoreIdle,
} from '../../../../../e2e/web/spec-helpers.ts';
import { rawExchange } from '../../../src/e2e-wire.ts';
import { stagedCopyRoot } from '../../../src/stage-e2e.ts';

/**
 * The K1 A-B-A switch harness — the web tier (#254): the deterministic
 * switch sequence over the LIVE host, driven the way the product drives
 * it (the shell's own activate gesture), with the capture/probe halves
 * the server-authority spec needs. It is the browser-tier half of the
 * K-family's stable API — the runtime tier's harness lives at
 * `packages/runtime/test/project-switch/harness.ts`, and K2/K3 build
 * their web legs on THIS module, never on a re-derived sequence.
 *
 * Stable surface (the K-family contract):
 * - `abaActivate(page, position)` — the settled deterministic
 *   activation (initial load, the young dev server's self-reload
 *   settle, the captured authority set of the committed document).
 * - `abaDeactivate(page)` — the deterministic exit back to idle.
 * - `abaCapture(page)` — the CURRENT document's authority set (origin,
 *   host, pair, capabilities) — the stale-authority replays' input.
 * - `abaStalePairStatus(port, stale, live)` — the raw-wire stale-pair
 *   probe under LIVE authority (the F2 admission's own law).
 * - `abaRetiredHostStatus(port, host)` — the retired-host 421 probe.
 * - `abaSheetBytes` / `abaEntryBytes` — the staged copies' bytes
 *   (the wrong-project oracle, disk truth).
 */

/** One captured document authority set — what a live tab holds. */
export interface AbaCapture {
  readonly origin: string;
  readonly host: string;
  readonly runtimeEpoch: string;
  readonly generation: number;
  readonly clientCapability: string;
  readonly hostCapability: string | undefined;
}

/** The staged copy's sheet bytes — the CSS vertical's disk truth. */
export async function abaSheetBytes(project: 'project-a' | 'project-b'): Promise<string> {
  return await readFile(join(stagedCopyRoot(project), 'src', 'pages', 'home.css'), 'utf8');
}

/** The staged copy's blog-entry bytes — the Content vertical's disk truth. */
export async function abaEntryBytes(project: 'project-a' | 'project-b'): Promise<string> {
  return await readFile(
    join(stagedCopyRoot(project), 'src', 'content', 'blog', 'hello-builder.md'),
    'utf8',
  );
}

/**
 * The settled deterministic activation, position-parameterized for the
 * switch: the web lane's ONE settle discipline (`activateSettled`,
 * imported — never re-derived; #254 review caught the copy already
 * drifting at birth), then the generation wait and the committed
 * document's captured authority set.
 */
export async function abaActivate(page: Page, position: 0 | 1): Promise<AbaCapture> {
  await activateSettled(page, position);
  await expect(page.getByTestId('session-generation')).toHaveText(/^\d+$/, {
    timeout: LOAD_BUDGET_MS,
  });
  return await abaCapture(page);
}

/** The deterministic exit — deactivate and land on the idle launcher. */
export async function abaDeactivate(page: Page): Promise<void> {
  await restoreIdle(page);
}

/** The current document's authority set — read off the served page itself. */
export async function abaCapture(page: Page): Promise<AbaCapture> {
  const url = new URL(page.url());
  const runtimeEpoch = await page.locator('meta[name="astroix-epoch"]').getAttribute('content');
  const generationText = await page
    .locator('meta[name="astroix-generation"]')
    .getAttribute('content');
  const clientCapability = await page
    .locator('meta[name="astroix-client"]')
    .getAttribute('content');
  const cookies = await page.context().cookies(url.origin);
  const hostCapability = cookies.find((cookie) => cookie.name === '__astroix_host')?.value;
  if (
    runtimeEpoch === null ||
    generationText === null ||
    clientCapability === null ||
    hostCapability === undefined
  ) {
    throw new Error('the active document did not carry its bootstrap authority');
  }
  return {
    origin: url.origin,
    host: url.host,
    runtimeEpoch,
    generation: Number.parseInt(generationText, 10),
    clientCapability,
    hostCapability,
  };
}

/**
 * The raw-wire stale-pair probe under LIVE authority: the live
 * document's cookie and client carrying the STALE capture's pair. The
 * honest refusal is the admission's own (409 stale-session), observed
 * against the live host — never a shell-mediated answer.
 */
export async function abaStalePairStatus(
  port: number,
  stale: AbaCapture,
  live: AbaCapture,
): Promise<{ status: number; code: string }> {
  const body = JSON.stringify({
    protocolVersion: 1,
    requestId: 'aba-stale-pair',
    session: { runtimeEpoch: stale.runtimeEpoch, generation: stale.generation },
    command: { kind: 'inspect', request: { kind: 'project' } },
  });
  const response = await rawExchange(
    port,
    [
      'POST /__astroix/api/v1 HTTP/1.1',
      `Host: ${live.host}`,
      `Cookie: __astroix_host=${live.hostCapability}`,
      `X-Astroix-Client: ${live.clientCapability}`,
      'Content-Type: application/json',
      'Sec-Fetch-Site: same-origin',
      `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n'),
  );
  const code = (JSON.parse(response.body) as { error?: { code?: string } }).error?.code ?? 'none';
  return { status: response.status, code };
}

/** The retired-host probe — a bare GET on a host whose lease died. */
export async function abaRetiredHostStatus(port: number, host: string): Promise<number> {
  const response = await rawExchange(
    port,
    [`GET /__astroix/app/ HTTP/1.1`, `Host: ${host}`, 'Connection: close', '', ''].join('\r\n'),
  );
  return response.status;
}
