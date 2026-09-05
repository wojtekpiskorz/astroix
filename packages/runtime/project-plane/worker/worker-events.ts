import type { InspectionKind } from '@wojciechpiskorz/astroix-protocol';

/**
 * The worker's public event stream (#230, ADR-0005 `subscribe()` emits
 * revisioned invalidations and structured diagnostics): the two event
 * shapes mirror the protocol's SSE frames (`packages/protocol/src/events.ts`)
 * — the control-plane lane lifts them onto the wire envelope unchanged.
 * Like the protocol's own doctrine, the primary hygiene control here is
 * STRUCTURAL: the events are closed typed shapes, and every message the
 * worker composes is a fixed template interpolated only with values from
 * closed enumerations (family kinds, adapter/outcome/category codes) —
 * no free text ever enters, so no disclosure shape can leave. The
 * focused tests verify the emitted messages against the protocol's own
 * `findDisclosure` guard from the test side (the worker keeps no
 * runtime dependency on the protocol package — its modules must stay
 * loadable by raw forked Node children, the kernel-lease/private-boot
 * discipline).
 */

/** The four closed inspection families (the protocol's `InspectionKind`). */
export type InspectionFamily = InspectionKind;

/** A published revisioned invalidation: which families went stale, at which raw revision. */
export interface WorkerInvalidationEvent {
  readonly type: 'invalidation';
  /** The inspection families whose cached results are stale (at least one). */
  readonly families: readonly InspectionFamily[];
  /** The raw invalidation stream's monotonic revision this publication caught up to. */
  readonly revision: number;
}

/** The diagnostic levels the worker publishes (the protocol SSE diagnostic frame's set). */
export type WorkerDiagnosticLevel = 'info' | 'warn' | 'error';

/** A structured diagnostic: level plus a sanitized fixed-template message — no stacks, no handles, no paths. */
export interface WorkerDiagnosticEvent {
  readonly type: 'diagnostic';
  readonly level: WorkerDiagnosticLevel;
  readonly message: string;
}

/** One worker event — a revisioned invalidation or a structured diagnostic. */
export type WorkerEvent = WorkerInvalidationEvent | WorkerDiagnosticEvent;

/** Page components live under `src/pages/` — project-relative posix. */
const PAGES_PREFIX = 'src/pages/';
/** The canonical content subtree — the glob loaders' certified fixture bases. */
const CONTENT_PREFIX = 'src/content/';
/**
 * The content config's certified fixture location (the E4 pass's one fixed
 * import). This literal is the SAME truth as `CONTENT_CONFIG_MODULE` in
 * `../../astro-project-adapter/content/content-probes.ts` (imported by the
 * source filter) — worker modules stay minimal-dep for raw forked-Node
 * loading, so the mapping carries the literal with this cross-reference
 * instead of the import; a drift between the two is a seam-drift event.
 */
const CONTENT_CONFIG = 'src/content.config.ts';

/**
 * Which inspection families one observed truth change can stale (#387:
 * the mapping is per TRUTH, not a styles fallback). The raw stream
 * carries style truth and content truth:
 *
 * - content truth (the config module, the `src/content/` subtree) stales
 *   `content` — the E4 pass's own inputs — and `routes`: a dynamic page's
 *   `getStaticPaths` enumerates collections (the fixture's own
 *   `[slug].astro` over `getCollection`), so an entry change can move
 *   the routes payload's `renders`. Over-wide in the uncertain cases,
 *   never under — the same doctrine as pages, and the same pair the
 *   content write loop itself invalidates client-side after every
 *   commit (#253 J3 refreshes content AND routes).
 * - style truth (`\`.astro\`/\`.css\`) always stales `styles` — the
 *   index payload's truth. A `.astro` under `src/pages/` additionally
 *   implicates `routes`: page additions and removals change route
 *   patterns, and a changed page can change `getStaticPaths`
 *   enumeration.
 *
 * A file under `src/content/` ending `.astro` is BOTH truths (a content
 * entry carrying scoped styles) and implicates all three families. The
 * empty set names a file no family reads — a shape the widened source
 * filter never emits; the worker drops it rather than publish an
 * empty-family event.
 */
export function invalidationFamiliesFor(changedFile: string): readonly InspectionFamily[] {
  const families = new Set<InspectionFamily>();
  if (changedFile === CONTENT_CONFIG || changedFile.startsWith(CONTENT_PREFIX)) {
    families.add('content');
    families.add('routes');
  }
  if (changedFile.endsWith('.astro') || changedFile.endsWith('.css')) {
    families.add('styles');
  }
  if (changedFile.endsWith('.astro') && changedFile.startsWith(PAGES_PREFIX)) {
    families.add('routes');
  }
  return orderedFamilies(families);
}

/** The canonical family order for published events — the protocol enum's order, deterministic. */
export function orderedFamilies(families: Iterable<InspectionFamily>): readonly InspectionFamily[] {
  const order: readonly InspectionFamily[] = ['project', 'content', 'routes', 'styles'];
  const present = new Set(families);
  return order.filter((family) => present.has(family));
}
