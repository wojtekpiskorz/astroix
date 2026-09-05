import type { QueryClient } from '@tanstack/react-query';
import type { SessionGate } from '../state/session-gate.ts';

/**
 * The content-family convergence retry belt (#451, owner ruling option 2,
 * over #387/#450's disclosed torn truth): the first refetch a
 * content-family invalidation push causes can read the PRE-edit listing —
 * the served content projection trails the file write by the content
 * layer's own watcher sync, and no "the layer synced" observable exists
 * this side of the wire (option 3 would touch Astro-internal paths and
 * stays ruled out). The belt is client-side convergence over the
 * observable the wire ALREADY carries: the content inspection payload's
 * own `revision` marker — the adapter's deterministic pass revision
 * (identical served truth ⇒ identical revision, changed truth ⇒ changed
 * revision), NOT the protocol envelope's integer revision (a per-serve
 * counter that advances on every inspection and carries no truth).
 *
 * The convergence predicate, honestly: the served payload has converged
 * when its marker has MOVED OFF the pre-push value — the cached content
 * payload's marker at the moment the push was admitted. While the
 * refetched marker still equals that baseline, the projection has not
 * advanced past the push, and the belt re-fetches the generation-scoped
 * content key on a short bounded backoff (250 ms → 500 ms → 1 s → 2 s —
 * low single-digit seconds total), stopping at the first converged
 * payload or at the budget. The budget's give-up is honest: the served
 * truth stands and the next push re-arms the belt.
 *
 * Laws this module owns:
 *
 * - **No new transport** — the belt drives the host's QueryClient only
 *   (re-fetches the one generation-scoped content key the SSE→query
 *   bridge already invalidates; the one-AppClient law #332 is untouched).
 * - **Generation-scoped** — the belt dies with the session: every retry
 *   is cancelled by the session abort (the reset's `abort-fetches` step
 *   and the provider's unmount) or a closed gate, and the query key it
 *   re-fetches is the frozen session's — never a retry across
 *   generations, never a poll that outlives the belt.
 * - **Never cancel the in-flight fetch** — retries ride
 *   `refetchQueries({ cancelRefetch: false })`, deduping onto any
 *   in-flight content inspection instead of stacking concurrent
 *   fresh-runner passes server-side (the write loop's #253 lesson).
 * - **Fail-safe disarm** — no cached payload, or a payload carrying no
 *   readable marker, means there is nothing to converge against: the
 *   belt arms to nothing, never a spin on an unobservable.
 */

/** The bounded backoff schedule — four retries, low single-digit seconds total. */
const RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000];

/** The session-facing slice the belt needs — the provider passes its full SessionClient. */
export interface ContentRetryBeltSession {
  /** The generation-scoped query key minter (ADR-0006 §5) — the belt re-fetches `('content')`. */
  queryKey(...scope: (string | number)[]): (string | number)[];
}

/** The belt's fixed inputs — one per content-family push. */
export interface ContentRetryBeltDeps {
  /** The host's QueryClient — the one cache the belt re-fetches from. */
  readonly queryClient: QueryClient;
  /** The frozen session whose content key the belt targets. */
  readonly session: ContentRetryBeltSession;
  /** The session gate — a closed gate (the reset) cancels any pending retry. */
  readonly gate: SessionGate;
  /** The session abort signal — the reset's fetch abort and unmount cancel any pending retry. */
  readonly signal: AbortSignal;
  /** The backoff schedule; the production default is the chartered belt, tests inject their own. */
  readonly retryDelaysMs?: readonly number[];
}

/** One armed belt — `cancel` is the provider's only control surface (a re-arming push, the reset). */
export interface ContentRetryBelt {
  cancel(): void;
}

const SETTLED_BELT: ContentRetryBelt = { cancel: () => {} };

/**
 * Reads the convergence marker off one content inspection payload — the
 * deterministic pass `revision` the served truth carries. `null` when the
 * payload carries no readable marker (absent, not a string, or no payload
 * at all): no observable, never a spin.
 */
function contentMarker(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const revision = (payload as { readonly revision?: unknown }).revision;
  return typeof revision === 'string' && revision.length > 0 ? revision : null;
}

/** The cached content inspection's payload — `undefined` when the query holds no data. */
function cachedContentPayload(deps: ContentRetryBeltDeps): unknown {
  const data: unknown = deps.queryClient.getQueryData(deps.session.queryKey('content'));
  if (data === undefined) return undefined;
  return (data as { readonly payload?: unknown }).payload;
}

/** The belt's one step decision — pure over the cached truth. */
type BeltStep = 'converged' | 'retry' | 'closed';

/** Decides one step: converged (stop), retry (the backoff continues), closed (the session moved). */
function beltStep(deps: ContentRetryBeltDeps, baseline: string): BeltStep {
  if (deps.signal.aborted || !deps.gate.isCurrent()) return 'closed';
  const payload = cachedContentPayload(deps);
  if (payload === undefined) return 'closed'; // the query is gone — a reset raced the belt
  const served = contentMarker(payload);
  if (served === null) return 'closed'; // no observable — fail-safe, never a spin
  return served === baseline ? 'retry' : 'converged';
}

/** Sleeps the backoff hop; resolves `'cancelled'` the moment the signal aborts. */
function beltSleep(ms: number, signal: AbortSignal): Promise<'slept' | 'cancelled'> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve('cancelled');
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve('slept');
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve('cancelled');
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Awaits one exchange without ever propagating its failure — a failed fetch is one more not-yet-converged attempt. */
async function quietly(exchange: Promise<unknown>): Promise<void> {
  try {
    await exchange;
  } catch {
    // the budget bounds the belt; the next attempt observes whatever landed
  }
}

/**
 * Arms the belt for one content-family push. `firstRefetch` is the
 * SSE→query bridge's own content invalidation — the belt observes its
 * settle (never a second invalidation of its own: `invalidateQueries`
 * defaults would CANCEL the in-flight refetch, stacking server-side
 * passes), then re-fetches on the backoff while the served marker still
 * reads the pre-push baseline. Returns the belt handle; a payload with
 * no marker at push time disarms (fail-safe).
 */
export function armContentRetryBelt(
  deps: ContentRetryBeltDeps,
  firstRefetch: Promise<unknown>,
): ContentRetryBelt {
  const baseline = contentMarker(cachedContentPayload(deps));
  if (baseline === null) return SETTLED_BELT;
  const cancelController = new AbortController();
  const chained = AbortSignal.any([deps.signal, cancelController.signal]);
  void (async () => {
    await quietly(firstRefetch);
    if (beltStep(deps, baseline) !== 'retry') return;
    for (const delay of deps.retryDelaysMs ?? RETRY_DELAYS_MS) {
      if ((await beltSleep(delay, chained)) !== 'slept') return;
      if (beltStep(deps, baseline) === 'closed') return;
      await quietly(
        deps.queryClient.refetchQueries(
          { queryKey: deps.session.queryKey('content') },
          { cancelRefetch: false },
        ),
      );
      if (beltStep(deps, baseline) !== 'retry') return;
    }
    // budget exhausted — the honest give-up: the served truth stands; the next push re-arms.
  })();
  return {
    cancel: () => {
      cancelController.abort();
    },
  };
}
