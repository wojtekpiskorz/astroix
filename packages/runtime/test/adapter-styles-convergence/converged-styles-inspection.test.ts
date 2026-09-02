import { afterEach, describe, expect, it } from 'vitest';
import { createConvergedStylesInspection } from '../../astro-project-adapter/styles/convergence/converged-styles-inspection';
import { createStylesInvalidationSource } from '../../astro-project-adapter/styles/convergence/invalidation-source';
import {
  type ConvergenceHarness,
  convergenceHarness,
  FIXTURE_SCOPE_TOKEN,
  FIXTURE_SCOPED_SELECTOR,
  fixtureCompiledCss,
  ROUTE_COMPONENT,
} from './convergence-harness';

/**
 * The converged styles inspection (#227 focused tests): the convergence
 * protocol over the fixture's real disk bytes and injected runner/client
 * stand-ins — every pass a fresh runner closed with the #206 cleanup
 * proof on every exit path (success, mismatch, hard failure, abort),
 * watcher invalidation driving the transient mismatch → converged retry
 * loop, and every mismatch category failing closed with no payload
 * publication and no revision advance. Real Astro/Vite behavior behind
 * the seams stays the certification suite's truth (#225).
 */

const harnesses: ConvergenceHarness[] = [];

async function harness(
  options?: Parameters<typeof convergenceHarness>[0],
): Promise<ConvergenceHarness> {
  const created = await convergenceHarness(options);
  harnesses.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((created) => created.dispose()));
});

function scopedRule(selector: string): string {
  return `${selector}[${FIXTURE_SCOPE_TOKEN}] { color: #1e293b; }`;
}

describe('createConvergedStylesInspection (fresh-runner discipline)', () => {
  it('returns a converged, revisioned, plain-data payload with the cleanup evidence attached', async () => {
    const h = await harness();
    const inspector = createConvergedStylesInspection({ server: h.server, seams: h.seams });
    const outcome = await inspector.inspect({ routeComponent: ROUTE_COMPONENT });

    expect(outcome.outcome).toBe('converged');
    if (outcome.outcome !== 'converged') return;
    expect(outcome.payload.revision).toBe(1);
    expect(outcome.payload.invalidationRevision).toBe(0);
    // The full static index of the fixture copy, in walk order, with the
    // scoped record joined from the compiler output and globals null.
    expect(outcome.payload.records).toHaveLength(7);
    const scoped = outcome.payload.records.filter((record) => record.scoped);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.selector).toBe(FIXTURE_SCOPED_SELECTOR);
    expect(scoped[0]?.effectiveSelector).toBe(`${FIXTURE_SCOPED_SELECTOR}[${FIXTURE_SCOPE_TOKEN}]`);
    expect(
      outcome.payload.records.filter((record) => record.effectiveSelector === null),
    ).toHaveLength(6);

    // Plain data only: no Vite handles, no compiler implementation objects.
    expect(structuredClone(outcome.payload)).toEqual(outcome.payload);

    // The pass closed its runner and restored the transport accounting.
    expect(outcome.evidence).toEqual([
      { sendListenersBefore: 0, sendListenersAfterClose: 0, closedAfterClose: true },
    ]);
    expect(h.runners[0]?.isClosed()).toBe(true);
    expect(h.hotEmitter.listenerCount('send')).toBe(0);
  });

  it('creates a fresh runner per request — no shared runner cache across inspections', async () => {
    const h = await harness();
    const inspector = createConvergedStylesInspection({ server: h.server, seams: h.seams });
    const first = await inspector.inspect({ routeComponent: ROUTE_COMPONENT });
    const second = await inspector.inspect({ routeComponent: ROUTE_COMPONENT });

    expect(first.outcome).toBe('converged');
    expect(second.outcome).toBe('converged');
    if (first.outcome !== 'converged' || second.outcome !== 'converged') return;
    expect(second.payload.revision).toBe(first.payload.revision + 1);
    // Two requests, two distinct runners, every one closed — nothing
    // survives a request and no request borrows the previous runner.
    expect(h.runners).toHaveLength(2);
    expect(h.runners[0]).not.toBe(h.runners[1]);
    for (const runner of h.runners) {
      expect(runner.isClosed()).toBe(true);
    }
    expect(h.hotEmitter.listenerCount('send')).toBe(0);
  });

  it('closes the runner in finally when a leg fails hard (a seam rejection)', async () => {
    const h = await harness();
    const inspector = createConvergedStylesInspection({ server: h.server, seams: h.seams });
    h.css.pagePrimeBroken = true;
    await expect(inspector.inspect({ routeComponent: ROUTE_COMPONENT })).rejects.toMatchObject({
      code: 'seam-rejected',
      details: { seam: 'vite client environment page prime (transformRequest of the route page)' },
    });
    expect(h.runners[0]?.isClosed()).toBe(true);
    expect(h.hotEmitter.listenerCount('send')).toBe(0);
  });

  it('rejects as runner-cleanup when the runner survives close — no payload, no revision', async () => {
    const h = await harness({ runnerBehavior: { surviveClose: true } });
    const inspector = createConvergedStylesInspection({ server: h.server, seams: h.seams });
    await expect(inspector.inspect({ routeComponent: ROUTE_COMPONENT })).rejects.toMatchObject({
      code: 'runner-cleanup',
      details: { residue: 'open-runner' },
    });
    expect(h.runners[0]?.isClosed()).toBe(false);
  });

  it('closes the runner and attaches the cleanup evidence on a mismatch outcome', async () => {
    const h = await harness();
    const inspector = createConvergedStylesInspection({ server: h.server, seams: h.seams });
    // Disk advances (a rename), the compiled css stays stale — the pass
    // must classify and close, never leak the runner on the sad path.
    await h.editScopedSelector('.hero-headline');
    h.fireWatcherChange(ROUTE_COMPONENT);
    const outcome = await inspector.inspect({ routeComponent: ROUTE_COMPONENT });
    expect(outcome.outcome).toBe('mismatch');
    if (outcome.outcome !== 'mismatch') return;
    expect(outcome.evidence).toEqual([
      { sendListenersBefore: 0, sendListenersAfterClose: 0, closedAfterClose: true },
    ]);
    expect(h.runners[0]?.isClosed()).toBe(true);
    expect(h.hotEmitter.listenerCount('send')).toBe(0);
  });

  it("rejects with the caller's reason on an aborted signal and still closes the runner", async () => {
    const h = await harness();
    const inspector = createConvergedStylesInspection({ server: h.server, seams: h.seams });
    const reason = new Error('lifecycle stop');
    const controller = new AbortController();
    controller.abort(reason);
    // Aborted before the pass: no runner is created at all.
    await expect(
      inspector.inspect({ routeComponent: ROUTE_COMPONENT, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(h.runners).toHaveLength(0);

    // Aborted mid-pass (during the client transform leg): the pass rejects
    // at its next boundary and the runner closes in finally.
    const midPass = new AbortController();
    h.css.onStyleTransform = () => midPass.abort(new Error('mid-pass stop'));
    await expect(
      inspector.inspect({ routeComponent: ROUTE_COMPONENT, signal: midPass.signal }),
    ).rejects.toMatchObject({ message: 'mid-pass stop' });
    expect(h.runners[0]?.isClosed()).toBe(true);
    expect(h.hotEmitter.listenerCount('send')).toBe(0);
  });
});

describe('createConvergedStylesInspection (the convergence protocol)', () => {
  it('a watcher edit causes a transient mismatch, then a later fresh retry converges', async () => {
    const h = await harness();
    const inspector = createConvergedStylesInspection({ server: h.server, seams: h.seams });
    const first = await inspector.inspect({ routeComponent: ROUTE_COMPONENT });
    expect(first.outcome).toBe('converged');
    if (first.outcome !== 'converged') return;
    expect(first.payload.revision).toBe(1);

    // The disk rename lands and the watcher invalidates — but the client
    // environment still serves the STALE compiled transform (the B2
    // divergence class). The pass verifies parity per pass: it classifies
    // the disagreement and publishes nothing.
    await h.editScopedSelector('.hero-headline');
    h.fireWatcherChange(ROUTE_COMPONENT);
    const stale = await inspector.inspect({ routeComponent: ROUTE_COMPONENT });
    expect(stale.outcome).toBe('mismatch');
    if (stale.outcome !== 'mismatch') return;
    expect(stale.mismatch.category).toBe('selector-identity');
    expect(stale.mismatch.block).toEqual({ file: ROUTE_COMPONENT, blockIndex: 0 });
    expect(stale.invalidationRevision).toBe(1);

    // The transformed graph catches up (a later pass's page prime re-serves
    // the module): a FRESH inspection now converges — only now does data
    // return, and the revision advanced exactly once.
    h.css.compiledCss = fixtureCompiledCss('.hero-headline');
    const converged = await inspector.inspect({ routeComponent: ROUTE_COMPONENT });
    expect(converged.outcome).toBe('converged');
    if (converged.outcome !== 'converged') return;
    expect(converged.payload.revision).toBe(2);
    expect(converged.payload.invalidationRevision).toBe(1);
    const scoped = converged.payload.records.filter((record) => record.scoped);
    expect(scoped[0]?.selector).toBe('.hero-headline');
    expect(scoped[0]?.effectiveSelector).toBe(`.hero-headline[${FIXTURE_SCOPE_TOKEN}]`);
    // Three passes, three fresh runners — the retry was never a cached one.
    expect(h.runners).toHaveLength(3);
    for (const runner of h.runners) {
      expect(runner.isClosed()).toBe(true);
    }
  });

  it('discards a converged-looking pass that raced a mid-pass invalidation', async () => {
    const h = await harness();
    const inspector = createConvergedStylesInspection({ server: h.server, seams: h.seams });
    const first = await inspector.inspect({ routeComponent: ROUTE_COMPONENT });
    expect(first.outcome).toBe('converged');
    if (first.outcome !== 'converged') return;

    // The disk and the compiled css agree throughout, but the watcher fires
    // DURING the pass: the pass observed a torn world and its records are
    // never served, however consistent they looked.
    h.css.onStyleTransform = () => h.fireWatcherChange(ROUTE_COMPONENT);
    const raced = await inspector.inspect({ routeComponent: ROUTE_COMPONENT });
    expect(raced.outcome).toBe('raced');
    if (raced.outcome !== 'raced') return;
    expect(raced.invalidationRevision).toBe(1);
    expect(raced.evidence).toEqual([
      { sendListenersBefore: 0, sendListenersAfterClose: 0, closedAfterClose: true },
    ]);

    h.css.onStyleTransform = undefined;
    const settled = await inspector.inspect({ routeComponent: ROUTE_COMPONENT });
    expect(settled.outcome).toBe('converged');
    if (settled.outcome !== 'converged') return;
    expect(settled.payload.revision).toBe(2);
    expect(settled.payload.invalidationRevision).toBe(1);
  });

  it('converges within one inspection when an immediate fresh re-pass finds parity (attempts bound)', async () => {
    const h = await harness();
    const inspector = createConvergedStylesInspection({ server: h.server, seams: h.seams });
    await h.editScopedSelector('.hero-headline');
    h.fireWatcherChange(ROUTE_COMPONENT);
    // Attempt 1 observes the stale transform; attempt 2 — a complete fresh
    // pass, new runner — re-transforms and finds parity.
    h.css.scheduled = [fixtureCompiledCss(), fixtureCompiledCss('.hero-headline')];

    const outcome = await inspector.inspect({ routeComponent: ROUTE_COMPONENT, attempts: 2 });
    expect(outcome.outcome).toBe('converged');
    if (outcome.outcome !== 'converged') return;
    expect(outcome.payload.revision).toBe(1);
    expect(outcome.evidence).toHaveLength(2);
    expect(h.runners).toHaveLength(2);
    for (const runner of h.runners) {
      expect(runner.isClosed()).toBe(true);
    }
  });

  it('returns the last unfinished outcome when the attempt bound is exhausted — never a stale accept', async () => {
    const h = await harness();
    const inspector = createConvergedStylesInspection({ server: h.server, seams: h.seams });
    await h.editScopedSelector('.hero-headline');
    h.fireWatcherChange(ROUTE_COMPONENT);
    // Both attempts observe the stale transform: the world never converged.
    h.css.scheduled = [fixtureCompiledCss(), fixtureCompiledCss()];

    const outcome = await inspector.inspect({ routeComponent: ROUTE_COMPONENT, attempts: 2 });
    expect(outcome.outcome).toBe('mismatch');
    if (outcome.outcome !== 'mismatch') return;
    expect(outcome.mismatch.category).toBe('selector-identity');
    expect(outcome.evidence).toHaveLength(2);
    expect(h.runners).toHaveLength(2);
    for (const runner of h.runners) {
      expect(runner.isClosed()).toBe(true);
    }
  });

  it('exposes its invalidation source — the revisioned stream the worker lane publishes', async () => {
    const h = await harness();
    const inspector = createConvergedStylesInspection({ server: h.server, seams: h.seams });
    const events: unknown[] = [];
    inspector.invalidations.subscribe((event) => events.push(event));
    h.fireWatcherChange(ROUTE_COMPONENT);
    h.fireWatcherChange('src/pages/home.css');
    expect(events).toEqual([
      { revision: 1, file: ROUTE_COMPONENT },
      { revision: 2, file: 'src/pages/home.css' },
    ]);
    expect(inspector.invalidations.revision).toBe(2);
  });

  it('accepts a caller-built invalidation source', async () => {
    const h = await harness();
    const invalidations = createStylesInvalidationSource(h.server, h.projectRoot);
    const inspector = createConvergedStylesInspection({
      server: h.server,
      seams: h.seams,
      invalidations,
    });
    const outcome = await inspector.inspect({ routeComponent: ROUTE_COMPONENT });
    expect(outcome.outcome).toBe('converged');
    if (outcome.outcome !== 'converged') return;
    expect(outcome.payload.invalidationRevision).toBe(invalidations.revision);
  });
});

describe('createConvergedStylesInspection (mismatch categories fail closed)', () => {
  it('classifies a dev-css import rejection as module-presence with the cause preserved', async () => {
    const h = await harness();
    const inspector = createConvergedStylesInspection({ server: h.server, seams: h.seams });
    h.setDevCssImport(() => Promise.reject(new Error('module not found')));
    const outcome = await inspector.inspect({ routeComponent: ROUTE_COMPONENT });
    expect(outcome.outcome).toBe('mismatch');
    if (outcome.outcome !== 'mismatch') return;
    expect(outcome.mismatch.category).toBe('module-presence');
    expect(outcome.mismatch.expected).toBe(
      'the active route component dev-css virtual module to import (the route compiled-CSS set)',
    );
    expect(outcome.mismatch.observed).toBe(
      'a module import rejection for the active route component',
    );
    expect(outcome.mismatch.cause).toBeInstanceOf(Error);
    expect(h.runners[0]?.isClosed()).toBe(true);
    expect(h.hotEmitter.listenerCount('send')).toBe(0);
  });

  it.each([
    {
      what: 'compiler-source (a scopeless compiled selector)',
      arrange: async (h: ConvergenceHarness) => {
        h.css.compiledCss = `${FIXTURE_SCOPED_SELECTOR} { color: #1e293b; }`;
      },
      category: 'compiler-source',
    },
    {
      what: 'rule-count (compiled serves two rules, the source has one)',
      arrange: async (h: ConvergenceHarness) => {
        h.css.compiledCss = `${scopedRule(FIXTURE_SCOPED_SELECTOR)}\n${scopedRule('.hero-lead')}`;
      },
      category: 'rule-count',
    },
    {
      what: 'order (the same two rules, swapped)',
      arrange: async (h: ConvergenceHarness) => {
        await h.replaceStyleBlock(['.alpha', '.beta']);
        h.css.compiledCss = `${scopedRule('.beta')}\n${scopedRule('.alpha')}`;
      },
      category: 'order',
    },
    {
      what: 'selector-identity (the source renamed, the transform stale)',
      arrange: async (h: ConvergenceHarness) => {
        await h.editScopedSelector('.hero-headline');
      },
      category: 'selector-identity',
    },
    {
      what: 'module-presence (the required block missing from the route CSS set)',
      arrange: async (h: ConvergenceHarness) => {
        h.setDevCssImport(async () => ({
          css: new Set([
            { id: '/abs/proj/src/pages/home.css', url: '/src/pages/home.css', content: '' },
          ]),
        }));
      },
      category: 'module-presence',
    },
  ])('rejects $what with no payload publication', async ({ arrange, category }) => {
    const h = await harness();
    const inspector = createConvergedStylesInspection({ server: h.server, seams: h.seams });
    await arrange(h);

    const outcome = await inspector.inspect({ routeComponent: ROUTE_COMPONENT });
    expect(outcome.outcome).toBe('mismatch');
    if (outcome.outcome !== 'mismatch') return;
    expect(outcome.mismatch.category).toBe(category);
    expect(outcome.evidence).toEqual([
      { sendListenersBefore: 0, sendListenersAfterClose: 0, closedAfterClose: true },
    ]);

    // Nothing was published: once the world converges again, the very
    // first published revision is 1 — no revision was minted mid-mismatch.
    h.setDevCssImport(async () => ({
      css: new Set([
        {
          id: `/abs/proj/${ROUTE_COMPONENT}?astro&type=style&index=0&lang.css`,
          url: `/${ROUTE_COMPONENT}?astro&type=style&index=0&lang.css`,
          content: 'never read',
        },
      ]),
    }));
    h.css.compiledCss = fixtureCompiledCss(
      category === 'selector-identity' ? '.hero-headline' : FIXTURE_SCOPED_SELECTOR,
    );
    if (category === 'order') await h.replaceStyleBlock([FIXTURE_SCOPED_SELECTOR]);
    const converged = await inspector.inspect({ routeComponent: ROUTE_COMPONENT });
    expect(converged.outcome).toBe('converged');
    if (converged.outcome !== 'converged') return;
    expect(converged.payload.revision).toBe(1);
    expect(h.hotEmitter.listenerCount('send')).toBe(0);
  });
});
