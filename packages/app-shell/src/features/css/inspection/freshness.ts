import type { BoundStylesPayload } from './bind-styles.ts';

/**
 * The styles slice's revision freshness law (#249, I1 — "queries reject
 * stale revisions"): the converged styles payload carries a monotonic
 * resource revision (E3's convergence stamp — it advances only on
 * published passes), so a payload that arrives LATER on the wire but
 * carries an EARLIER revision than the one already served for the same
 * route is stale by the runtime's own truth, never a downgrade the
 * panel should render. The decision is pure; the caller (the feature's
 * query fetch) holds the memory.
 */

/** What the freshness belt remembers: the highest revision served for one route. */
export interface ServedRevision {
  readonly route: string;
  readonly revision: number;
}

/**
 * True when `payload` is stale against the remembered `served` — a
 * different route never compares (each route's payload is its own
 * resource), and only a STRICTLY lower revision on the same route is a
 * downgrade. An equal revision is idempotent freshness (a refetch the
 * invalidation bridge triggered that converged at the same pass), and
 * a higher one advances the belt.
 */
export function isStaleStylesPayload(
  served: ServedRevision | null,
  route: string,
  payload: BoundStylesPayload,
): boolean {
  if (served === null || served.route !== route) return false;
  return payload.revision < served.revision;
}
