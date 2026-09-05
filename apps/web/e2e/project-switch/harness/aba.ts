import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import {
  abortNextLauncherNavigation,
  activateButton,
  activateSettled,
  BOOT_BUDGET_MS,
  freezeResetState,
  LOAD_BUDGET_MS,
  PROJECT_APP_URL,
  type ResetFreeze,
  recordLandedSession,
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
 * - `abaReactivateIdempotent(page, position)` — the same-project
 *   re-activation's landing (K2 #255's member: the #413/#419 client
 *   contract's double-click shape, landing the CURRENT pair).
 * - `abaDeactivate(page)` — the deterministic exit back to idle.
 * - `abaCapture(page)` — the CURRENT document's authority set (origin,
 *   host, pair, capabilities) — the stale-authority replays' input.
 * - `abaStalePairStatus(port, stale, live)` — the raw-wire stale-pair
 *   probe under LIVE authority (the F2 admission's own law).
 * - `abaRetiredHostStatus(port, host)` — the retired-host 421 probe.
 * - `abaSheetBytes` / `abaEntryBytes` — the staged copies' bytes
 *   (the wrong-project oracle, disk truth).
 * - `abaShellState(page)` / `parseShellStateLine(text)` — the served
 *   document's `shell-state` marker, parsed (K2 #255's member: the
 *   client-reset proofs' zero-state observable, one spelling of the
 *   marker contract for every K leg).
 * - `abaFreezeResetState(page)` — the #393 frozen capture of the first
 *   complete-reset marker text (K2 #255's member: the ordering proof's
 *   capture discipline, immune to the dying document's re-render
 *   transient) — the shared `e2e/web/spec-helpers.ts` spelling under
 *   the K-family name (#423 review: the pair is single-homed there,
 *   one spelling for every ordering proof).
 * - `abaAbortNextLauncherNavigation(page)` — the one-shot launcher
 *   navigation abort that keeps the old document alive past its
 *   replacement attempt (K2 #255's member: the ordering proof's
 *   interception half) — the shared `spec-helpers.ts` spelling under
 *   the K-family name.
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

/**
 * The idempotent same-project re-activation's landing (K2 #255's
 * member — the #413/#419 client contract): the launcher's double-click
 * shape, activating the ALREADY-ACTIVE project. The composition
 * answers the CURRENT pair's activation envelope with no generation
 * bump (#419's wired law), and the launcher navigates exactly as on
 * any committed activation — so this lands a document bound at the
 * SAME pair the active session already holds, which is the whole
 * point: the caller asserts the pair did not move.
 *
 * No `activateSettled` here, deliberately: this landing's proofs (the
 * marker, the capture, serving) ride the served document, never the
 * canvas — nothing here needs the canvas settled at all (#433 round 2:
 * the former "waiting for two would hang" justification died with the
 * warm-tolerant settle; the bypass stays right for this reason alone).
 * The landing still records its pair for the warm-activation memo —
 * the lane-wide law covers every landing, raw clicks included.
 */
export async function abaReactivateIdempotent(page: Page, position: 0 | 1): Promise<AbaCapture> {
  await page.goto('/__astroix/app/');
  await activateButton(page, position).click();
  await page.waitForURL(PROJECT_APP_URL, { timeout: BOOT_BUDGET_MS });
  await recordLandedSession(page);
  await expect(page.getByTestId('session-generation')).toHaveText(/^\d+$/, {
    timeout: LOAD_BUDGET_MS,
  });
  return await abaCapture(page);
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

// ——— the K2 client-reset members (#255) ———

/** The shell-state marker's parsed line — the reset-clearable client state's observable. */
export interface AbaShellState {
  readonly queries: number;
  readonly selection: boolean;
  readonly canvas: boolean;
  readonly activeEntry: boolean;
  readonly grants: number;
  readonly undo: number;
  /** `none`, or the ordered trace of completed clearing steps. */
  readonly reset: string;
}

/**
 * Parses one `shell-state` marker line into its fields — the marker
 * contract's one reader (a K leg never hand-greps the line). A
 * malformed or absent field reads as its zero value, never a throw:
 * the batteries assert the FRESH document's state, so a half-rendered
 * line must fail an assertion, not the parse.
 */
export function parseShellStateLine(text: string): AbaShellState {
  const fields = new Map<string, string>();
  for (const token of text.split(/\s+/)) {
    const split = token.indexOf('=');
    if (split > 0) fields.set(token.slice(0, split), token.slice(split + 1));
  }
  return {
    queries: Number.parseInt(fields.get('queries') ?? '0', 10),
    selection: fields.get('selection') === '1',
    canvas: fields.get('canvas') === '1',
    activeEntry: fields.get('entry') === '1',
    grants: Number.parseInt(fields.get('grants') ?? '0', 10),
    undo: Number.parseInt(fields.get('undo') ?? '0', 10),
    reset: fields.get('reset') ?? 'none',
  };
}

/** The CURRENT document's shell-state marker, parsed — the fresh document's zero-state probe. */
export async function abaShellState(page: Page): Promise<AbaShellState> {
  const text = await page.getByTestId('shell-state').textContent();
  return parseShellStateLine(text ?? '');
}

/**
 * The #393 frozen capture of the first complete-reset marker text
 * (K2 #255's member: the ordering proof's capture discipline, immune
 * to the dying document's re-render transient) — the SHARED spelling
 * homed in `e2e/web/spec-helpers.ts` (#423 review: this harness's
 * former local copy was line-for-line the app-shell battery's),
 * consumed under the K-family name. The discipline's rationale and
 * history (#392's race, #393's capture shape) live at the home.
 */
export const abaFreezeResetState = freezeResetState;

/** The frozen capture's read half — the shared home's type under the K-family name. */
export type AbaResetFreeze = ResetFreeze;

/**
 * The one-shot launcher navigation abort that keeps the old document
 * alive past its replacement attempt (K2 #255's member: the ordering
 * proof's interception half) — the shared `e2e/web/spec-helpers.ts`
 * spelling under the K-family name.
 */
export const abaAbortNextLauncherNavigation = abortNextLauncherNavigation;
