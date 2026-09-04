import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { activateButton, PROJECT_APP_URL, restoreIdle } from './spec-helpers.ts';

/**
 * The wire-carried styles route selection (#370): a REAL styles
 * inspection over protocol v1 against the live control-plane
 * composition — the proof the ruled seam exists end-to-end (and #249
 * I1's unblocking evidence). The document-side exchanges ride the LIVE
 * binding exactly as the app shell's own traffic would: the browser
 * attaches the host capability cookie, and the client capability and
 * the session pair come from the project document's bootstrap metas.
 *
 * The battery covers the issue's focused matrix: the served converged
 * payload (records + revisions) for the active route, the unresolvable
 * route's route-shaped 404, the absent selection's malformed refusal,
 * the malformed selection's admission refusal, the stale session's
 * refusal, and the disclosure sweep (the resolved component never
 * enters a response; the routes payload still carries no component).
 *
 * SERIAL like the lane's other batteries: one control plane, one
 * supervisor-global active session — the leg restores the idle state.
 */

/** One inspection request over the live binding — returns the parsed response body. */
async function inspectOver(
  page: Page,
  request: unknown,
  sessionOverride?: { runtimeEpoch: string; generation: number },
): Promise<{
  protocolVersion?: number;
  result?: { kind: string; result?: unknown };
  error?: { code: string; message: string };
}> {
  return await page.evaluate(
    async ({ payload, session }) => {
      const capability = document
        .querySelector('meta[name="astroix-client"]')
        ?.getAttribute('content');
      const epoch =
        session?.runtimeEpoch ??
        document.querySelector('meta[name="astroix-epoch"]')?.getAttribute('content');
      const generation =
        session?.generation ??
        document.querySelector('meta[name="astroix-generation"]')?.getAttribute('content');
      if (
        capability === undefined ||
        capability === null ||
        epoch === undefined ||
        epoch === null ||
        generation === undefined ||
        generation === null
      ) {
        throw new Error('the project document carries incomplete bootstrap metas');
      }
      const envelope = {
        protocolVersion: 1,
        requestId: `styles-leg-${Math.random().toString(36).slice(2, 10)}`,
        session: {
          runtimeEpoch: epoch,
          generation: typeof generation === 'number' ? generation : Number.parseInt(generation, 10),
        },
        command: { kind: 'inspect', request: payload },
      };
      const response = await fetch('/__astroix/api/v1', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-astroix-client': capability },
        credentials: 'same-origin',
        body: JSON.stringify(envelope),
      });
      return await response.json();
    },
    { payload: request, session: sessionOverride },
  );
}

/**
 * Retries one styles inspection until it settles with the converged
 * payload — the young dev server's initial watcher churn can race a
 * pass (E3's contract: the retry is ALWAYS a later fresh inspection),
 * so the honest client polls. The last body is the answer on success;
 * the deadline surfaces the last refusal, never a silent hang.
 */
async function servedStyles(
  page: Page,
  route: string,
  timeoutMs = 90_000,
): Promise<NonNullable<Awaited<ReturnType<typeof inspectOver>>>> {
  const deadline = Date.now() + timeoutMs;
  let last: Awaited<ReturnType<typeof inspectOver>> | undefined;
  for (;;) {
    last = await inspectOver(page, { kind: 'styles', route });
    if (last.error === undefined && last.result?.kind === 'inspection') {
      const inspection = last.result.result as { kind?: string };
      if (inspection.kind === 'styles') return last;
    }
    if (Date.now() >= deadline) {
      throw new Error(`the styles inspection never settled: ${JSON.stringify(last)}`);
    }
    await page.waitForTimeout(2_000);
  }
}

test.describe.configure({ mode: 'serial' });

test('a styles inspection over the wire settles with the converged payload for the active route', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);

  // The converged payload may need a later fresh pass while the young
  // dev server settles its initial watcher churn (E3's contract: the
  // retry is ALWAYS a later inspection) — poll like the honest client.
  const served = await servedStyles(page, '/');

  expect(served.error).toBeUndefined();
  expect(served.protocolVersion).toBe(1);
  expect(served.result?.kind).toBe('inspection');
  const inspection = served.result?.result as {
    kind: string;
    revision: number;
    payload: { revision: number; invalidationRevision: number; records: unknown[] };
  };
  expect(inspection.kind).toBe('styles');
  expect(inspection.revision).toBeGreaterThanOrEqual(1);
  expect(inspection.payload.revision).toBe(inspection.revision);
  expect(inspection.payload.invalidationRevision).toBeGreaterThanOrEqual(0);

  // The records are the frozen css-index family's shapes: the full key
  // set, project-relative posix files, and the fixture's own truth (the
  // global .hero-title rules and the scoped effective form).
  expect(inspection.payload.records.length).toBeGreaterThan(0);
  const selectors = new Set<string>();
  for (const record of inspection.payload.records as Array<
    Record<string, unknown> & { file?: unknown }
  >) {
    expect(Object.keys(record).sort()).toEqual([
      'effectiveSelector',
      'file',
      'line',
      'media',
      'range',
      'scoped',
      'selector',
      'styleBlockIndex',
    ]);
    expect(typeof record.file).toBe('string');
    expect(record.file).not.toMatch(/(^\/|\.\.|\\)/);
    if (typeof record.selector === 'string') selectors.add(record.selector);
  }
  expect(selectors.has('.hero-title')).toBe(true);
  const heroRecords = (inspection.payload.records as Array<Record<string, unknown>>).filter(
    (record) => record.selector === '.hero-title',
  );
  // The global sheet's plain form …
  expect(heroRecords.some((record) => record.effectiveSelector === null)).toBe(true);
  // … and the scoped effective form the compiler emitted (the certified
  // attribute strategy's `[data-astro-cid-*]`).
  expect(
    heroRecords.some(
      (record) =>
        typeof record.effectiveSelector === 'string' &&
        record.effectiveSelector.includes('[data-astro-cid-'),
    ),
  ).toBe(true);

  // A second route resolves through the dynamic pattern and serves too.
  const blog = await servedStyles(page, '/blog/hello-builder');
  expect(blog.error).toBeUndefined();
  const blogInspection = blog.result?.result as { kind: string; payload: { records: unknown[] } };
  expect(blogInspection.kind).toBe('styles');
  expect(blogInspection.payload.records.length).toBeGreaterThan(0);

  // The disclosure sweep: neither served envelope carries the resolved
  // COMPONENT, the route-selection family, or any module-graph shape —
  // the component is control-plane currency alone (#370's law).
  for (const body of [served, blog]) {
    const text = JSON.stringify(body);
    expect(text).not.toContain('index.astro');
    expect(text).not.toContain('[slug].astro');
    expect(text).not.toContain('[...slug].astro');
    expect(text).not.toContain('route-selection');
    expect(text).not.toContain('virtual:astro');
    expect(text).not.toContain('node_modules');
  }

  // The routes payload is unchanged by the seam: the frozen corpus's
  // patterns, and no component key anywhere.
  const routes = await inspectOver(page, { kind: 'routes' });
  expect(routes.error).toBeUndefined();
  const routesPayload = routes.result?.result as {
    payload: { routes: Array<Record<string, unknown>> };
  };
  const corpus = JSON.parse(
    await readFile(
      join(process.cwd(), 'e2e', 'behavior-contracts', 'inspection', 'routes.json'),
      'utf8',
    ),
  ) as { routes: Array<{ pattern: string }> };
  expect(routesPayload.payload.routes.map((route) => route.pattern).sort()).toEqual(
    corpus.routes.map((route) => route.pattern).sort(),
  );
  for (const route of routesPayload.payload.routes) {
    expect(Object.keys(route)).not.toContain('component');
  }

  // Restore the idle state for whatever follows the battery.
  await restoreIdle(page);
});

test('the negatives: unresolvable route, absent selection, malformed selection, stale session', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);

  // An unresolvable route — well-formed, served by nothing: the honest
  // route-shaped 404, never a component or a guess.
  const unresolvable = await inspectOver(page, { kind: 'styles', route: '/no/such/route' });
  expect(unresolvable.error?.code).toBe('resource-not-found');
  expect(JSON.stringify(unresolvable)).not.toContain('src/pages');

  // An absent selection: the additive envelope parses, but the
  // executor refuses — a styles inspection cannot be served without one.
  const absent = await inspectOver(page, { kind: 'styles' });
  expect(absent.error?.code).toBe('malformed-request');

  // A malformed selection (not a pathname): refused at admission by the
  // protocol's own schema — F2 never lets it reach the executor.
  const malformed = await inspectOver(page, { kind: 'styles', route: 'not-a-pathname' });
  expect(malformed.error?.code).toBe('malformed-request');

  // A stale session: refused before any resolution runs.
  const epoch = await page.locator('meta[name="astroix-epoch"]').getAttribute('content');
  expect(epoch).toBeTruthy();
  const stale = await inspectOver(
    page,
    { kind: 'styles', route: '/' },
    { runtimeEpoch: epoch ?? '', generation: 9_999 },
  );
  expect(stale.error?.code).toBe('stale-session');

  // Restore the idle state for whatever follows the battery.
  await restoreIdle(page);
});
