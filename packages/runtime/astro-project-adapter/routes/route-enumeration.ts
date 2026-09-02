import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModuleRunnerLike } from '../seam-readers';
import type { RouteMetadataEntry } from './route-metadata';
import { isEnumeratable } from './routes-payload';

/**
 * Dynamic-route enumeration (#229): for every route in the payload's
 * renders space (prerendered single-param project pages, discovered by the
 * certified seam — never guessed from the filesystem), the pass loads the
 * route's own entrypoint through the fresh module runner and runs its
 * `getStaticPaths`, the managed route behavior the supported fixture
 * contract needs (`getCollection`-backed static paths). The rendered param
 * values become that route's `renders`.
 *
 * Failure containment is the frozen contract's unknown discipline: any
 * per-route failure — a missing or throwing `getStaticPaths`, a garbage
 * result, a hang past the per-wait bound, route behavior outside the
 * supported contract (pagination) — drops that route's `renders` to
 * unknown. Unknown never fires the unrouted marker and never serves a
 * wrong value (#119's silent-never-wrong, restated).
 *
 * Abort is the exception: cancellation belongs to the surrounding runtime
 * lifecycle, not to one route's truth — an aborted signal rejects the
 * whole pass with the caller's reason (the runner still closes; the
 * fresh-runner wrapper owns that path).
 *
 * This module also owns the lane's per-wait bound (`bounded`): every
 * runner read an inspection pass awaits — the metadata read included
 * (review round 1: a hung composition must never mean an unbounded
 * inspect) — races its work against the lifecycle signal and this bound.
 */

/** Per-wait bound on one runner read (an import, then a static-paths call). */
export const DEFAULT_WAIT_TIMEOUT_MS = 5_000;

/** Rejects a bounded wait on timeout unless the caller supplies its own reason. */
const WAIT_TIMEOUT = Symbol('routes-inspection-wait-timeout');

/** What one enumeration pass needs: the project root (entrypoint key) and the lifecycle bounds. */
export interface EnumerationOptions {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  /** Defaults to {@link DEFAULT_WAIT_TIMEOUT_MS}; overridable so tests bound hangs tightly. */
  readonly waitTimeoutMs?: number;
}

/**
 * Runs `getStaticPaths` for every enumeratable route through the runner,
 * returning pattern → rendered param values. Absent from the map = that
 * route's enumeration did not positively succeed (unknown). Rejects with
 * the signal's reason the moment cancellation is observed.
 */
export async function enumerateRenders(
  runner: ModuleRunnerLike,
  metadata: readonly RouteMetadataEntry[],
  options: EnumerationOptions,
): Promise<Map<string, readonly string[]>> {
  const results = new Map<string, readonly string[]>();
  for (const entry of metadata) {
    if (!isEnumeratable(entry)) continue;
    options.signal?.throwIfAborted();
    try {
      results.set(entry.pattern, await enumerateRoute(runner, entry, options));
    } catch (rejection) {
      // Cancellation is pass-level truth, never a route's unknown: if the
      // signal fired, whatever we caught is superseded — reject the pass.
      if (options.signal?.aborted) throw rejection;
    }
  }
  return results;
}

async function enumerateRoute(
  runner: ModuleRunnerLike,
  entry: RouteMetadataEntry,
  options: EnumerationOptions,
): Promise<readonly string[]> {
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const entrypoint = pathToFileURL(join(options.projectRoot, entry.component)).href;
  const moduleExports = (await bounded(runner.import(entrypoint), options.signal, waitTimeoutMs)) as
    | { getStaticPaths?: unknown }
    | null
    | undefined;
  const getStaticPaths = moduleExports?.getStaticPaths;
  if (typeof getStaticPaths !== 'function') {
    // Astro core throws GetStaticPathsRequired for this shape at render;
    // enumeration contains it the same way — unknown, not an error.
    throw new Error('the route entrypoint exports no getStaticPaths');
  }
  const result = await bounded(
    Promise.resolve(getStaticPaths({ paginate: unsupportedPaginate, routePattern: entry.pattern })),
    options.signal,
    waitTimeoutMs,
  );
  if (!Array.isArray(result)) {
    throw new Error('the route getStaticPaths returned no array');
  }
  return extractRenders(result, paramKeyOf(entry));
}

/** The param values a `getStaticPaths` result actually renders — first-occurrence order, non-strings skipped. */
export function extractRenders(
  staticPaths: readonly unknown[],
  paramKey: string,
): readonly string[] {
  const seen = new Set<string>();
  for (const staticPath of staticPaths) {
    const value = (staticPath as { params?: Record<string, unknown> } | null)?.params?.[paramKey];
    if (typeof value === 'string') seen.add(value);
  }
  return [...seen];
}

/** The `getStaticPaths` params key for a rest param drops the dots (`...slug` → `slug`). */
export function paramKeyOf(entry: RouteMetadataEntry): string {
  return entry.params[0]?.replace(/^\.\.\./, '') ?? '';
}

/**
 * Paginated routes are outside the supported fixture contract: core does
 * not export its paginate helper through a usable seam, and the frozen
 * corpus knows none. A route that paginates fails its enumeration —
 * contained to unknown — instead of the adapter vendoring core semantics
 * no certified route exercises.
 */
function unsupportedPaginate(): never {
  throw new Error('paginated routes are outside the supported enumeration contract');
}

/**
 * Bounds one runner read: timeout rejects with `timeoutReason` (the
 * internal sentinel by default — enumeration contains it; the metadata
 * read supplies a rejection that crosses the pass boundary), abort
 * rejects with the signal's reason (pass-level, always). The losing
 * promise's rejection is deliberately swallowed — abandoned work must
 * not surface as an unhandled rejection after the pass moved on.
 */
export async function bounded<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  waitTimeoutMs: number,
  timeoutReason: unknown = WAIT_TIMEOUT,
): Promise<T> {
  if (signal?.aborted) throw signal.reason;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectBail: ((reason: unknown) => void) | undefined;
  const onAbort = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    rejectBail?.(signal?.reason);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const bail = new Promise<never>((_, reject) => {
    rejectBail = reject;
    timer = setTimeout(() => reject(timeoutReason), waitTimeoutMs);
  });
  try {
    return await Promise.race([work, bail]);
  } catch (rejection) {
    void work.then(
      () => {},
      () => {},
    );
    throw rejection;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (timer !== undefined) clearTimeout(timer);
  }
}
