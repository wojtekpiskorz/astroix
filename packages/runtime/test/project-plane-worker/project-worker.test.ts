import { findDisclosure } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import {
  createProjectWorker,
  mergeSignals,
  type ProjectWorker,
} from '../../project-plane/worker/project-worker.ts';
import type { WorkerEvent } from '../../project-plane/worker/worker-events.ts';
import { WorkerRejectionError } from '../../project-plane/worker/worker-failure.ts';
import { type FakePlane, fakePlane } from './plane-fakes.ts';

/**
 * The project-plane worker state machine (#230 focused tests): typed
 * four-family dispatch with revision layering, cancellation, adapter
 * branch failure propagation, revisioned invalidation publication behind
 * the worker-owned debounce timer, shutdown rejection, and terminal
 * cleanup ownership — all over the dispatch-boundary fake (the recorded
 * stand-in level; no third fake composition/runner pair).
 */

function workerWith(
  plane: FakePlane,
  options: { debounceMs?: number; stopTimeoutMs?: number } = {},
) {
  return createProjectWorker({
    plane: plane.plane,
    invalidationDebounceMs: options.debounceMs ?? 200,
    stopTimeoutMs: options.stopTimeoutMs,
  });
}

function captureEvents(worker: ProjectWorker): WorkerEvent[] {
  const events: WorkerEvent[] = [];
  worker.subscribe((event) => events.push(event));
  return events;
}

function rejectionOf(promise: Promise<unknown>): Promise<WorkerRejectionError> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => {
      if (!(error instanceof WorkerRejectionError))
        throw new Error(`unstructured rejection: ${String(error)}`);
      return error;
    },
  );
}

function preAborted(): { signal: AbortSignal; reason: Error } {
  const reason = new Error('the caller abandoned this inspection');
  const controller = new AbortController();
  controller.abort(reason);
  return { signal: controller.signal, reason };
}

/** Waits for a published event matching the predicate, with a deadline. */
async function waitForEvent(
  worker: ProjectWorker,
  predicate: (event: WorkerEvent) => boolean,
  timeoutMs = 2000,
): Promise<WorkerEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the event')), timeoutMs);
    const unsubscribe = worker.subscribe((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('typed dispatch over the four families', () => {
  it('dispatches each family to its branch and wraps the payload with kind and revision', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane);

    expect(await worker.dispatch({ kind: 'project' })).toEqual({
      kind: 'project',
      revision: 1,
      payload: plane.payloads.project,
    });
    expect(await worker.dispatch({ kind: 'content' })).toEqual({
      kind: 'content',
      revision: 1,
      payload: plane.payloads.content,
    });
    expect(await worker.dispatch({ kind: 'routes' })).toEqual({
      kind: 'routes',
      revision: 1,
      payload: plane.payloads.routes,
    });
    const styles = await worker.dispatch({
      kind: 'styles',
      routeComponent: 'src/pages/index.astro',
    });
    expect(styles.kind).toBe('styles');
    expect(styles.payload).toEqual(plane.payloads.styles);

    expect(plane.calls.project).toBe(1);
    expect(plane.calls.content).toBe(1);
    expect(plane.calls.styles[0]?.routeComponent).toBe('src/pages/index.astro');
    expect(plane.calls.routes).toHaveLength(1);
  });

  it('threads the styles request inputs (routeComponent, attempts) to the branch', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane);
    await worker.dispatch({
      kind: 'styles',
      routeComponent: 'src/pages/blog/[slug].astro',
      attempts: 3,
    });
    expect(plane.calls.styles[0]?.routeComponent).toBe('src/pages/blog/[slug].astro');
    expect(plane.calls.styles[0]?.attempts).toBe(3);
  });

  it('layers monotonic worker-side revisions (content, project) and passes the adapter counters through (styles, routes)', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane);

    expect((await worker.dispatch({ kind: 'content' })).revision).toBe(1);
    expect((await worker.dispatch({ kind: 'project' })).revision).toBe(1);
    expect((await worker.dispatch({ kind: 'content' })).revision).toBe(2);
    expect(
      (await worker.dispatch({ kind: 'styles', routeComponent: 'src/pages/index.astro' })).revision,
    ).toBe(1);
    expect(
      (await worker.dispatch({ kind: 'styles', routeComponent: 'src/pages/index.astro' })).revision,
    ).toBe(2);
    expect((await worker.dispatch({ kind: 'routes' })).revision).toBe(1);
    expect((await worker.dispatch({ kind: 'routes' })).revision).toBe(2);
  });

  it('a failed pass never mints a revision — the next served pass takes the next number', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane);
    expect((await worker.dispatch({ kind: 'content' })).revision).toBe(1);

    plane.behaviors.content = 'adapter';
    await rejectionOf(worker.dispatch({ kind: 'content' }));

    plane.behaviors.content = 'ok';
    expect((await worker.dispatch({ kind: 'content' })).revision).toBe(2);
  });

  it('rejects a request outside the closed families before any branch runs', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane);
    const rejection = await rejectionOf(
      worker.dispatch({
        kind: 'project',
        extra: 'field',
      } as unknown as Parameters<ProjectWorker['dispatch']>[0]),
    );
    expect(rejection.failure.code).toBe('malformed-request');
    expect(plane.calls.project).toBe(0);
  });
});

describe('adapter branch failure propagation', () => {
  it('an AdapterError becomes a structured failure carrying the closed adapter code and details, plus an error diagnostic', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane);
    const events = captureEvents(worker);

    plane.behaviors.routes = 'adapter';
    const rejection = await rejectionOf(worker.dispatch({ kind: 'routes' }));
    expect(rejection.failure).toEqual({
      code: 'inspection-failed',
      message: 'the routes inspection failed at the project adapter (seam-rejected)',
      adapterCode: 'seam-rejected',
      details: {
        seam: 'vite root export createServer()',
        seamClass: 'public',
        expected: 'a function createServer',
        observed: 'typeof undefined',
      },
    });
    expect(events).toEqual([
      {
        type: 'diagnostic',
        level: 'error',
        message: 'the routes inspection failed at the project adapter (seam-rejected)',
      },
    ]);
  });

  it('an unexpected branch error becomes the generic failure — the raw message never crosses', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane);
    plane.behaviors.content = 'raw-throw';

    const rejection = await rejectionOf(worker.dispatch({ kind: 'content' }));
    expect(rejection.failure.code).toBe('inspection-failed');
    expect(rejection.failure.message).toBe('the content inspection failed unexpectedly');
    expect(JSON.stringify(rejection.failure)).not.toContain('/Users/secret');
    expect(JSON.stringify(rejection.failure)).not.toContain('pid');
  });

  it('unconverged styles outcomes (mismatch, raced) reject with no payload, no revision, and warn diagnostics', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane);
    const events = captureEvents(worker);

    plane.stylesOutcomeOverride = 'mismatch';
    const mismatch = await rejectionOf(
      worker.dispatch({ kind: 'styles', routeComponent: 'src/pages/index.astro' }),
    );
    expect(mismatch.failure.code).toBe('inspection-unconverged');
    if (mismatch.failure.code !== 'inspection-unconverged') return;
    expect(mismatch.failure.outcome).toBe('mismatch');
    expect(mismatch.failure.category).toBe('module-presence');

    plane.stylesOutcomeOverride = 'raced';
    const raced = await rejectionOf(
      worker.dispatch({ kind: 'styles', routeComponent: 'src/pages/index.astro' }),
    );
    if (raced.failure.code !== 'inspection-unconverged') return;
    expect(raced.failure.outcome).toBe('raced');
    expect(raced.failure.category).toBeNull();

    plane.stylesOutcomeOverride = null;
    expect(
      (await worker.dispatch({ kind: 'styles', routeComponent: 'src/pages/index.astro' })).revision,
    ).toBe(1);
    const diagnostics = events.filter((event) => event.type === 'diagnostic');
    expect(diagnostics).toHaveLength(2);
    expect(
      diagnostics.every((event) => event.type === 'diagnostic' && event.level === 'warn'),
    ).toBe(true);
  });
});

describe('cancellation', () => {
  it('a pre-aborted caller signal rejects with the caller reason before the branch runs', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane);
    const { signal, reason } = preAborted();
    await expect(worker.dispatch({ kind: 'content' }, signal)).rejects.toBe(reason);
    expect(plane.calls.content).toBe(0);
  });

  it('an un-aborted merged signal reaches the signal-taking branches (styles, routes)', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane);
    await worker.dispatch({ kind: 'styles', routeComponent: 'src/pages/index.astro' });
    await worker.dispatch({ kind: 'routes' });
    expect(plane.stylesSignals[0]?.aborted).toBe(false);
    expect(plane.routesSignals[0]?.aborted).toBe(false);
  });

  it('an in-flight signal-taking branch rejects with the caller reason when the caller aborts', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane);
    const controller = new AbortController();
    plane.behaviors.styles = 'hang';

    const pending = worker.dispatch(
      { kind: 'styles', routeComponent: 'src/pages/index.astro' },
      controller.signal,
    );
    const reason = new Error('abandoned mid-pass');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('a signal-less branch (content) rejects promptly on abort; its abandoned result never mints a revision', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane);
    const controller = new AbortController();
    plane.behaviors.content = 'hang';

    const pending = worker.dispatch({ kind: 'content' }, controller.signal);
    const reason = new Error('abandoned content pass');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);

    plane.release.content(); // the abandoned pass settles; its result is discarded
    plane.behaviors.content = 'ok';
    await tick(10);
    expect((await worker.dispatch({ kind: 'content' })).revision).toBe(1);
  });

  it('mergeSignals merges caller and lifecycle: either firing aborts with its own reason', () => {
    const caller = new AbortController();
    const lifecycle = new AbortController();
    const merged = mergeSignals([caller.signal, lifecycle.signal]);
    expect(merged.aborted).toBe(false);
    const reason = new Error('lifecycle stop');
    lifecycle.abort(reason);
    expect(merged.aborted).toBe(true);
    expect(merged.reason).toBe(reason);
  });
});

describe('revisioned invalidation publication', () => {
  it('accumulates raw events behind the debounce timer and publishes one union event at the latest revision', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane, { debounceMs: 30 });
    const events = captureEvents(worker);

    plane.fireInvalidation('src/styles/main.css'); // revision 1
    plane.fireInvalidation('src/pages/index.astro'); // revision 2
    plane.fireInvalidation('src/components/Header.astro'); // revision 3

    const published = await waitForEvent(worker, (event) => event.type === 'invalidation');
    expect(published).toEqual({
      type: 'invalidation',
      families: ['routes', 'styles'],
      revision: 3,
    });
    expect(events).toHaveLength(1); // one window, one publication
    await worker.stop();
  });

  it('debounce 0 publishes each raw event immediately, revisions monotonic', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane, { debounceMs: 0 });
    const events = captureEvents(worker);

    plane.fireInvalidation('src/styles/main.css');
    plane.fireInvalidation('src/styles/other.css');
    expect(events).toEqual([
      { type: 'invalidation', families: ['styles'], revision: 1 },
      { type: 'invalidation', families: ['styles'], revision: 2 },
    ]);
  });

  it('published events are plain serializable data, clean under the protocol disclosure guard', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane, { debounceMs: 0 });
    const events = captureEvents(worker);

    plane.fireInvalidation('src/styles/main.css');
    plane.behaviors.content = 'adapter';
    await rejectionOf(worker.dispatch({ kind: 'content' }));
    plane.fireInvalidation('src/pages/index.astro');
    await tick(5);

    const snapshot = events.map((event) => JSON.parse(JSON.stringify(event)) as WorkerEvent);
    expect(snapshot).toEqual([
      { type: 'invalidation', families: ['styles'], revision: 1 },
      {
        type: 'diagnostic',
        level: 'error',
        message: 'the content inspection failed at the project adapter (seam-rejected)',
      },
      { type: 'invalidation', families: ['routes', 'styles'], revision: 2 },
    ]);
    for (const event of snapshot) {
      expect(findDisclosure(JSON.stringify(event))).toBeNull();
    }
  });
});

describe('shutdown rejection and cleanup ownership', () => {
  it('rejects new inspection work the moment stop begins, without touching a branch', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane);

    plane.behaviors.styles = 'hang';
    const inFlight = worker.dispatch({ kind: 'styles', routeComponent: 'src/pages/index.astro' });
    const settled = inFlight.then(
      () => 'resolved',
      (error) => `rejected: ${String(error)}`,
    );
    const stopping = worker.stop();
    expect(worker.state).toBe('stopping');

    const rejection = await rejectionOf(worker.dispatch({ kind: 'content' }));
    expect(rejection.failure.code).toBe('shutdown');
    expect(plane.calls.content).toBe(0);

    expect(await settled).toContain('rejected'); // the lifecycle abort reached the in-flight pass
    await stopping;
  });

  it('a stopped worker closes everything it owns — complete report, terminal state, plane closed once', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane);
    const events = captureEvents(worker);
    expect(plane.sourceListenerCount()).toBe(1);

    plane.behaviors.routes = 'hang';
    const inFlight = worker.dispatch({ kind: 'routes' });
    const settled = inFlight.then(
      () => 'resolved',
      (error) => `rejected: ${String(error)}`,
    );
    await tick(5);

    const report = await worker.stop();
    expect(report).toEqual({
      reason: 'stopped',
      outcome: 'complete',
      failures: [],
      accounting: { inFlightSettled: true, unsubscribed: true, planeClosed: true },
    });
    expect(worker.state).toBe('closed');
    expect(plane.close.calls).toBe(1);
    expect(plane.sourceListenerCount()).toBe(0);
    await expect(worker.closed).resolves.toBe(report);
    expect(events.some((event) => event.type === 'diagnostic')).toBe(false);
    expect(await settled).toContain('rejected');
  });

  it('a pending debounce window dies with the run — no publication after stop begins', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane, { debounceMs: 400 });
    const events = captureEvents(worker);

    plane.fireInvalidation('src/styles/main.css');
    await worker.stop();
    await tick(30);
    expect(events).toHaveLength(0);
  });

  it('a pathological in-flight pass (signal-deaf) is outlived by the stop bound — honest incomplete report', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane, { debounceMs: 0, stopTimeoutMs: 25 });

    plane.behaviors.styles = 'hang-deaf';
    const inFlight = worker.dispatch({ kind: 'styles', routeComponent: 'src/pages/index.astro' });
    const settled = inFlight.then(
      () => 'resolved',
      () => 'rejected',
    );
    await tick(5);

    const report = await worker.stop();
    expect(report.outcome).toBe('incomplete');
    expect(report.failures).toEqual(['in-flight-drain']);
    expect(report.accounting.planeClosed).toBe(true);
    expect(plane.close.calls).toBe(1);

    plane.release.styles();
    expect(await settled).toBe('resolved'); // abandoned, not lost: the pass settles after the report
  });

  it('a plane close failure is reported, diagnosed, and still settles closed', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane);
    const events = captureEvents(worker);
    plane.close.behavior = 'fail';

    const report = await worker.stop();
    expect(report.outcome).toBe('incomplete');
    expect(report.failures).toEqual(['plane-close']);
    expect(report.accounting.planeClosed).toBe(false);
    expect(events).toEqual([
      { type: 'diagnostic', level: 'error', message: 'project plane cleanup failed (plane-close)' },
    ]);
    await expect(worker.closed).resolves.toBe(report);
  });

  it('stop is idempotent: every call settles with the one report, one plane close', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane);
    const first = worker.stop();
    const second = worker.stop('crash');
    await expect(worker.stop()).resolves.toBe(await first);
    await expect(second).resolves.toBe(await first);
    expect(plane.close.calls).toBe(1);
  });

  it('dispatch after closed rejects with the shutdown failure', async () => {
    const plane = fakePlane();
    const worker = workerWith(plane);
    await worker.stop();
    const rejection = await rejectionOf(worker.dispatch({ kind: 'project' }));
    expect(rejection.failure.code).toBe('shutdown');
  });
});
