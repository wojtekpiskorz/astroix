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

/**
 * Which inspection families one observed style-truth change can stale.
 * The landed raw stream (E3's invalidation source) carries only
 * `.astro`/`.css` files, so `styles` is always implicated — the index
 * payload's truth. A `.astro` under `src/pages/` additionally implicates
 * `routes`: page additions and removals change route patterns, and a
 * changed page can change `getStaticPaths` enumeration — over-wide in
 * the uncertain cases, never under (the same direction E3 chose for its
 * filter width).
 */
export function invalidationFamiliesFor(changedFile: string): readonly InspectionFamily[] {
  const isPage = changedFile.endsWith('.astro') && changedFile.startsWith(PAGES_PREFIX);
  return isPage ? ['routes', 'styles'] : ['styles'];
}

/** The canonical family order for published events — the protocol enum's order, deterministic. */
export function orderedFamilies(families: Iterable<InspectionFamily>): readonly InspectionFamily[] {
  const order: readonly InspectionFamily[] = ['project', 'content', 'routes', 'styles'];
  const present = new Set(families);
  return order.filter((family) => present.has(family));
}
