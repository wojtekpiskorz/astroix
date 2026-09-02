/**
 * Wire constants of protocol v1 (ADR-0006 §5, §7; ADR-0005 "Origin and
 * proxy contract"; ADR-0009 "Editor transport"): the reserved namespace,
 * the control endpoint prefix, the SSE event path, the mutation marker
 * header, and the no-store cache directive. Constants only — the listener
 * that enforces them belongs to `packages/runtime` (a later lane); this
 * package never opens a socket (#220: no transport listener here).
 */

/**
 * `/__astroix/` is Astroix's reserved namespace (ADR-0005): app assets,
 * control requests, and events. A managed project claiming it fails
 * compatibility validation.
 */
export const RESERVED_NAMESPACE = '/__astroix';

/** Control traffic lives below this prefix (ADR-0006 §7). */
export const API_V1_PREFIX = '/__astroix/api/v1';

/** Server-to-renderer events are SSE at this path (ADR-0006 §7; ADR-0009). */
export const EVENTS_PATH = '/__astroix/events';

/**
 * Mutations carry this exact header/value pair (ADR-0006 §7): JSON
 * content and `X-Astroix-Request: 1`.
 */
export const MUTATION_HEADER_NAME = 'X-Astroix-Request';
export const MUTATION_HEADER_VALUE = '1';

/**
 * App shell, API, and event responses use `Cache-Control: no-store`
 * (ADR-0006 §5) — a stale cache must never outlive a session.
 */
export const CACHE_CONTROL_NO_STORE = 'no-store';
