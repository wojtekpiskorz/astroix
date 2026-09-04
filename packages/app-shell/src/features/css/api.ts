import { isObservedPathname } from '@wojciechpiskorz/astroix-protocol';
import { useShell } from '../../app-shell/shell-context.ts';
import { useSessionQuery } from '../../app-shell/use-session-query.ts';
import { type BoundStylesPayload, bindStylesInspection } from './inspection/bind-styles.ts';
import { isStaleStylesPayload } from './inspection/freshness.ts';
import { useCssInspectionStore } from './store.ts';

/**
 * The CSS vertical's server-data slice (#249, I1): the read-only styles
 * inspection — the converged payload for the OBSERVED CANVAS ROUTE (the
 * settled #370/#376 wire shape: `{kind: 'styles', route}` — the route is
 * the canvas's observed URL pathname, resolved to the active route's
 * component BEHIND the runtime; the renderer never sees a component, a
 * module-graph shape, or a filesystem absolute).
 *
 * Laws this module owns:
 *
 * - **One transport** — the exchange rides `session.inspect` off the
 *   shell context (`useShell()`, the one-AppClient law #332); the query
 *   is the shell's own `useSessionQuery` discipline with the
 *   generation-scoped key `['astroix', runtimeEpoch, generation,
 *   'styles', route]`, so the SSE→query bridge's family invalidation
 *   refetches it and the whole cache dies with the session at commit.
 * - **The settle-poll is the honest client** — E3's contract: a young
 *   dev server's watcher churn can refuse a pass (the executor's closed
 *   catch-all), and the retry is ALWAYS a later fresh inspection. The
 *   fetch settles by polling — bounded, abort-aware — instead of
 *   surfacing the young-server refusal as a diagnostic (#376's live
 *   battery polls identically). The one short-lived selection cache the
 *   re-dispatch left to this lane's call is exactly this: the in-flight
 *   settle loop, never a persisted payload.
 * - **Freshness** — a payload whose revision is lower than the one
 *   already served for the same route is stale by the runtime's own
 *   truth: the loop keeps polling past it (the belt lives in the
 *   feature store), never renders a downgrade.
 * - **Fail-closed binding** — the payload interior binds structurally
 *   (`inspection/bind-styles.ts`); a drifted interior is the diagnostic
 *   state, never a heuristic parse.
 */

/** The settle-poll bounds — the #376 battery's own patience, knobs for tests plus the abort. */
export interface SettleOptions {
  readonly deadlineMs?: number;
  readonly tickMs?: number;
  /** Aborts the settle at every boundary — the session and query signals chain here. */
  readonly signal?: AbortSignal;
}

/** The default patience: young dev servers settle inside this, CI load included. */
const SETTLE_DEADLINE_MS = 90_000;
const SETTLE_TICK_MS = 2_000;

/**
 * The observed canvas route as the styles inspection carries it: the
 * canvas's observed URL's pathname, when it is an observed pathname by
 * the protocol's own grammar — `null` otherwise (no canvas observation,
 * or a URL the wire law refuses; the panel's no-route state).
 */
export function observedRouteOf(canvasUrl: string | null): string | null {
  if (canvasUrl === null) return null;
  let pathname: string | null = null;
  try {
    pathname = new URL(canvasUrl).pathname;
  } catch {
    return null;
  }
  return isObservedPathname(pathname) ? pathname : null;
}

/** The panel's structured state vocabulary — loading, ready, the honest negatives. */
export type StylesInspectionStatus =
  | 'loading'
  | 'ready'
  /** The observed route resolves to no project route — the route-shaped 404's panel face. */
  | 'unresolved-route'
  /** A refused exchange or a drifted payload — the sanitized reason only. */
  | 'diagnostic';

/** The derived styles query the panel consumes. */
export interface StylesInspectionQuery {
  readonly status: StylesInspectionStatus;
  readonly payload: BoundStylesPayload | null;
  /** The diagnostic state's sanitized reason — `null` in every other state. */
  readonly diagnosticMessage: string | null;
}

/** One inspection attempt's answer shape the settle loop consumes. */
type StylesExchange =
  | { readonly kind: 'served'; readonly payload: BoundStylesPayload }
  | { readonly kind: 'retryable' }
  | { readonly kind: 'refused'; readonly code: string };

/** Extracts a protocol error's sanitized code — the J1 `api.ts` idiom, never a typed import of the error class. */
function protocolErrorCode(error: unknown): string | null {
  const envelope = (error as { envelope?: { error?: { code?: string } } } | undefined)?.envelope;
  return typeof envelope?.error?.code === 'string' ? envelope.error.code : null;
}

/** Classifies one exchange's error — retryable churn, or a terminal refusal with its code. */
function classifyError(error: unknown): StylesExchange {
  const code = protocolErrorCode(error);
  if (code === null) return { kind: 'retryable' };
  // The terminal truths: the unresolvable route's 404, and the refusals
  // no later inspection can change. Everything else (the executor's
  // catch-all above all) is churn the next fresh pass may clear.
  if (code === 'resource-not-found') return { kind: 'refused', code };
  if (code === 'stale-session') return { kind: 'refused', code };
  if (code === 'malformed-request') return { kind: 'refused', code };
  return { kind: 'retryable' };
}

/** One abort-aware settle tick — resolves on abort, rejects never. */
function waitTick(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Settles one styles inspection by polling fresh passes — the honest
 * client over E3's convergence contract. `inspectOne` is the session
 * client's `inspect` (answering the typed inspection result — `{kind:
 * 'styles', revision, payload}`); the payload interior binds here.
 * Resolves with the first fresh bound payload; rejects with the
 * terminal refusal's code when the route honestly does not resolve,
 * and with `deadline` when the passes never settled inside the bound.
 * `signal` aborts the settle at every boundary.
 */
export async function settleStylesInspection(
  route: string,
  inspectOne: (
    signal?: AbortSignal,
  ) => Promise<{ readonly kind?: string; readonly payload?: unknown }>,
  options: SettleOptions = {},
): Promise<BoundStylesPayload> {
  const deadlineMs = options.deadlineMs ?? SETTLE_DEADLINE_MS;
  const tickMs = options.tickMs ?? SETTLE_TICK_MS;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    let exchange: StylesExchange;
    try {
      const result = await inspectOne(options.signal);
      const bound = result.kind === 'styles' ? bindStylesInspection(result.payload) : null;
      exchange = bound === null ? { kind: 'retryable' } : { kind: 'served', payload: bound };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      exchange = classifyError(error);
    }
    if (exchange.kind === 'refused') throw new Error(`refused:${exchange.code}`);
    if (exchange.kind === 'served') {
      const served = useCssInspectionStore.getState().served;
      if (!isStaleStylesPayload(served, route, exchange.payload)) {
        useCssInspectionStore.getState().noteServed(route, exchange.payload.revision);
        return exchange.payload;
      }
      // A stale payload means a fresher pass exists — keep polling (the
      // loop's own retry, never a rendered downgrade).
    }
    if (Date.now() >= deadline) throw new Error('deadline');
    await waitTick(tickMs, options.signal);
  }
}

/**
 * The one sanitized message a terminal refusal or settle timeout
 * surfaces. The session-moved truth is matched by the error NAME — the
 * J1 `api.ts` idiom, never a typed import of the error class — and it
 * IS reachable here: `useSessionQuery` wraps the whole settle loop in
 * the stale-response belt, whose pre/post-fetch gate checks reject
 * with `StaleSessionResultError` (the settle loop itself classifies
 * wire rejections internally, so only the belt's own rejection carries
 * that name).
 */
function diagnosticOf(error: unknown): string {
  if (error instanceof Error && error.name === 'StaleSessionResultError') {
    return 'the session moved before the response arrived';
  }
  const code = protocolErrorCode(error) ?? refusalCodeOf(error);
  if (code === 'resource-not-found') return 'the observed canvas route resolves to no route';
  if (code !== null) return `inspection refused: ${code}`;
  return 'the styles inspection could not settle';
}

/** Recovers a settle-loop terminal-refusal code (`refused:<code>`) — `null` for anything else. */
function refusalCodeOf(error: unknown): string | null {
  return error instanceof Error && error.message.startsWith('refused:')
    ? error.message.slice('refused:'.length)
    : null;
}

const LOADING_QUERY: StylesInspectionQuery = {
  status: 'loading',
  payload: null,
  diagnosticMessage: null,
};

/** One diagnostic-state query — the sanitized reason plus nothing derived. */
function diagnosticQuery(message: string): StylesInspectionQuery {
  return { ...LOADING_QUERY, status: 'diagnostic', diagnosticMessage: message };
}

/**
 * The styles inspection query for one observed route — settled by the
 * poll, derived into the panel's state vocabulary. The route-shape 404
 * is its own honest state (`unresolved-route`), never a generic
 * failure.
 */
export function useStylesInspection(route: string): StylesInspectionQuery {
  const { session } = useShell();
  const query = useSessionQuery(['styles', route], (signal) =>
    settleStylesInspection(route, (inner) => session.inspect({ kind: 'styles', route }, inner), {
      signal,
    }),
  );
  if (query.isPending) return LOADING_QUERY;
  if (query.error !== null) {
    const code = refusalCodeOf(query.error) ?? protocolErrorCode(query.error);
    if (code === 'resource-not-found') {
      return { ...LOADING_QUERY, status: 'unresolved-route', diagnosticMessage: null };
    }
    return diagnosticQuery(diagnosticOf(query.error));
  }
  // The fetch only resolves with a bound payload — the belt and the
  // binder are inside it; the belt's stale case never reaches here.
  const payload = query.data ?? null;
  if (payload === null) return diagnosticQuery('the styles inspection payload drifted');
  return { status: 'ready', payload, diagnosticMessage: null };
}
