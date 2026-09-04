import { afterEach, describe, expect, it } from 'vitest';
import { observedRouteOf, type StylesInspectionStatus, settleStylesInspection } from './api.ts';
import { useCssInspectionStore } from './store.ts';
import { stylesPayload } from './test-wire.ts';

/**
 * The styles query's pure halves (#249's focused units): the observed
 * route derivation (the protocol's own pathname grammar) and the settle
 * loop — E3's honest-client contract (churn retries as later fresh
 * passes, the 404 is terminal, a stale revision never renders), over a
 * scripted exchange sequence. The provider-mounted wire-shape and state
 * legs live in `css-sidebar.test.tsx`.
 */

const SETTLE = { deadlineMs: 250, tickMs: 5 };

/** One inspectOne answering the given sequence — a throwing exchange still advances the sequence. */
function scripted(exchanges: Array<() => unknown>): () => Promise<{
  kind?: string;
  payload?: unknown;
}> {
  let call = 0;
  return async () => {
    const index = Math.min(call, exchanges.length - 1);
    call += 1;
    const answer = exchanges[index]?.() ?? null;
    // the session client answers the typed inspection result — the
    // payload rides inside it
    return { kind: 'styles', payload: answer };
  };
}

afterEach(() => {
  useCssInspectionStore.setState({ served: null, openRowKey: null });
});

describe('the observed route derivation', () => {
  it('answers the canvas URL pathname when it is an observed pathname', () => {
    expect(observedRouteOf('http://project.localhost:4458/')).toBe('/');
    expect(observedRouteOf('http://project.localhost:4458/blog/hello-builder')).toBe(
      '/blog/hello-builder',
    );
  });

  it('answers null for no observation and for pathnames the wire law refuses', () => {
    expect(observedRouteOf(null)).toBeNull();
    expect(observedRouteOf('not a url')).toBeNull();
    // the query and the fragment live OUTSIDE the pathname — the route is
    // the pathname the grammar governs, and '/' is a valid one
    expect(observedRouteOf('http://project.localhost:4458/?q=1')).toBe('/');
    // a pathname the grammar refuses (an empty segment) never rides the wire
    expect(observedRouteOf('http://project.localhost:4458//doubled')).toBeNull();
  });
});

describe('the settle loop', () => {
  it('settles with the first fresh bound payload', async () => {
    const payload = stylesPayload({ revision: 2, records: [{ selector: '.a', file: 'a.css' }] });
    await expect(
      settleStylesInspection('/', scripted([() => payload]), SETTLE),
    ).resolves.toMatchObject({ revision: 2, invalidationRevision: 0 });
  });

  it('retries the young-server churn as later fresh passes — the executor catch-all and the transport never surface early', async () => {
    const churn = () => {
      throw Object.assign(new Error('protocol'), {
        envelope: { error: { code: 'internal-error', message: 'sanitized' } },
      });
    };
    const payload = stylesPayload({ revision: 1, records: [] });
    await expect(
      settleStylesInspection('/', scripted([churn, churn, () => payload]), SETTLE),
    ).resolves.toMatchObject({ revision: 1 });
  });

  it('refuses the unresolvable route terminally — never a retried 404', async () => {
    const notFound = () => {
      throw Object.assign(new Error('protocol'), {
        envelope: { error: { code: 'resource-not-found', message: 'sanitized' } },
      });
    };
    await expect(settleStylesInspection('/', scripted([notFound]), SETTLE)).rejects.toThrow(
      'refused:resource-not-found',
    );
  });

  it('polls past a stale revision — a late older payload never renders', async () => {
    useCssInspectionStore.getState().noteServed('/', 7);
    const stale = stylesPayload({ revision: 5, records: [] });
    const fresh = stylesPayload({ revision: 8, records: [] });
    await expect(
      settleStylesInspection('/', scripted([() => stale, () => fresh]), SETTLE),
    ).resolves.toMatchObject({ revision: 8 });
    // the belt advanced: the fresh revision is the served truth now
    expect(useCssInspectionStore.getState().served).toEqual({ route: '/', revision: 8 });
  });

  it('fails honestly when the passes never settle inside the bound', async () => {
    const churn = () => {
      throw new TypeError('network shape');
    };
    await expect(settleStylesInspection('/', scripted([churn]), SETTLE)).rejects.toThrow(
      'deadline',
    );
  });

  it('aborts at the boundary — a settled signal never starts an exchange', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await settleStylesInspection('/', scripted([]), {
      ...SETTLE,
      signal: controller.signal,
    }).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
  });
});

/** The state vocabulary is closed — a compile-time pin against accidental widening. */
const STATES: readonly StylesInspectionStatus[] = [
  'loading',
  'ready',
  'unresolved-route',
  'diagnostic',
];
expect(STATES).toHaveLength(4);
