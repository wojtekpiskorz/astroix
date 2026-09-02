import { type ByteLimitName, envelopeBytes, LIMITS } from '@wojciechpiskorz/astroix-protocol';

/**
 * The bounded page contract (#235, F3; ADR-0006 §7 "Per-resource,
 * per-response, per-event limits — list and inspection APIs paginate
 * before their cap"): the generic page math every list- or
 * inspection-shaped response assembly goes through, so a response
 * envelope is built page by page and NEVER breaches its byte cap —
 * pagination happens BEFORE the cap, by construction, not as a refusal
 * after the fact (the transport's `responseWithinCap` gate in
 * `api/http` stays as the final defense and becomes unreachable for
 * paginated surfaces).
 *
 * Pure and deterministic: the page is a function of the items, the
 * offset cursor, the optional page-size ceiling, the byte budget, and
 * the envelope constructor — counted in UTF-8 bytes over the SERIALIZED
 * envelope (the protocol's `envelopeBytes` unit, not JS string length,
 * so multi-byte content counts honestly). A requested page size that
 * would breach the budget is CLAMPED down to what fits — the page size
 * is a server-side hint under protocol v1's closed request envelopes,
 * and bounded delivery outranks the hint; a page that cannot carry even
 * ONE more item without breaching ends short with a continuation, and a
 * collection whose single first item cannot fit at all is refused
 * honestly (`single-item-over-budget`) — never silently truncated.
 */

/** One page's honest accounting, or the refusal the caller must answer with. */
export type BoundedPage<T> =
  | {
      readonly kind: 'page';
      readonly items: readonly T[];
      /** The serialized envelope's UTF-8 byte size — at or under the budget. */
      readonly pageBytes: number;
      /** The offset cursor the next page starts at — `null` when this page completed the collection. */
      readonly continuation: number | null;
    }
  | BoundedPageRefusal;

/** The refusal legs: pagination cannot meet the cap, and the reason is sanitized. */
export interface BoundedPageRefusal {
  readonly kind: 'refused';
  readonly reason: 'empty-envelope-over-budget' | 'single-item-over-budget';
  readonly limit: ByteLimitName;
  readonly receivedBytes: number;
}

/** The generic page input: the collection, the cursor, the ceiling, the budget, and the envelope constructor. */
export interface BoundedPageInput<T> {
  /** The whole ordered collection, from the caller's own snapshot. */
  readonly items: readonly T[];
  /** The offset cursor a previous page returned — negative values clamp to 0. */
  readonly offset: number;
  /**
   * The page-size ceiling (a server-side choice; protocol v1 requests
   * carry no page parameters). Clamped down when the budget cannot
   * carry the requested count; omitted means "as many as fit".
   */
  readonly requestedPageSize?: number;
  /** The byte budget this API paginates under — a `LIMITS` byte-cap name. */
  readonly budget: ByteLimitName;
  /** Builds the response envelope object that would carry `page` — called repeatedly by the search; must be pure. */
  readonly envelopeFor: (page: readonly T[]) => unknown;
}

/**
 * The byte-count form of the protocol's `withinByteLimit` — inclusive
 * at the boundary, over already-counted `envelopeBytes` (no second
 * serialization).
 */
function fitsBudget(bytes: number, budget: ByteLimitName): boolean {
  return bytes <= LIMITS[budget];
}

/**
 * Computes the largest prefix (from `offset`, under the ceiling) whose
 * envelope fits the budget, by binary search over the item count —
 * `O(log n)` serializations of a bounded envelope, deterministic. At
 * least one item is carried whenever one fits; the continuation is the
 * next offset or `null` at completion.
 */
export function boundedPage<T>(input: BoundedPageInput<T>): BoundedPage<T> {
  const offset = Math.max(0, Math.floor(input.offset));
  const available = input.items.length - offset;
  const emptyBytes = envelopeBytes(input.envelopeFor([]));
  if (available <= 0) {
    // Past the end (or an empty collection): the empty page completes —
    // unless even the empty envelope cannot fit, which is a
    // construction defect the caller must learn about, not truncate.
    if (!fitsBudget(emptyBytes, input.budget)) {
      return refused('empty-envelope-over-budget', emptyBytes, input.budget);
    }
    return { kind: 'page', items: [], pageBytes: emptyBytes, continuation: null };
  }
  const firstBytes = envelopeBytes(input.envelopeFor(pageOf(input.items, offset, 1)));
  if (!fitsBudget(firstBytes, input.budget)) {
    // Not even one item fits: if the empty envelope does, the first
    // item alone is over budget; if it does not, the envelope
    // construction itself is.
    if (!fitsBudget(emptyBytes, input.budget)) {
      return refused('empty-envelope-over-budget', emptyBytes, input.budget);
    }
    return refused('single-item-over-budget', firstBytes, input.budget);
  }
  const ceiling =
    input.requestedPageSize !== undefined && input.requestedPageSize > 0
      ? Math.min(Math.floor(input.requestedPageSize), available)
      : available;
  const count = ceiling === 1 ? 1 : largestFittingCount(input, offset, ceiling);
  return page(input, offset, count);
}

/**
 * Binary search for the largest count in [1, ceiling] whose envelope
 * fits the budget — the invariant is `lo` always fits, `hi` always does
 * not; `hi` fitting outright short-circuits the walk.
 */
function largestFittingCount<T>(
  input: BoundedPageInput<T>,
  offset: number,
  ceiling: number,
): number {
  let lo = 1;
  let hi = ceiling;
  if (fitsBudget(envelopeBytes(input.envelopeFor(pageOf(input.items, offset, hi))), input.budget)) {
    return hi;
  }
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (
      fitsBudget(envelopeBytes(input.envelopeFor(pageOf(input.items, offset, mid))), input.budget)
    ) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** Materializes the winning page — the count is known to fit; the continuation is derived, not searched. */
function page<T>(
  input: BoundedPageInput<T>,
  offset: number,
  count: number,
): Extract<BoundedPage<T>, { kind: 'page' }> {
  const items = pageOf(input.items, offset, count);
  return {
    kind: 'page',
    items,
    pageBytes: envelopeBytes(input.envelopeFor(items)),
    continuation: offset + count < input.items.length ? offset + count : null,
  };
}

function pageOf<T>(items: readonly T[], offset: number, count: number): readonly T[] {
  return items.slice(offset, offset + count);
}

function refused(
  reason: BoundedPageRefusal['reason'],
  receivedBytes: number,
  limit: ByteLimitName,
): BoundedPageRefusal & { kind: 'refused' } {
  return { kind: 'refused', reason, limit, receivedBytes };
}

// The composition entry's own contract (the #305 re-export idiom): a
// consumer of the pagination surface names the whole public vocabulary
// here, without reaching around the exports map.
export {
  INSPECTION_PAGE_BUDGET,
  LIST_PAGE_BUDGET,
  type PagedEnvelope,
  pagedInspection,
  pagedProjectList,
} from './paged-envelopes.ts';
