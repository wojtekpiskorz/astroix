import type { ContentInspectionResult } from '../../astro-project-adapter/content/content-result.ts';
import type { RouteSelectionResult } from '../../astro-project-adapter/routes/route-selection.ts';
import type { RoutesInspectionResult } from '../../astro-project-adapter/routes/routes-inspection.ts';
import type {
  StylesInspectionInput,
  StylesInspectionOutcome,
} from '../../astro-project-adapter/styles/convergence/converged-styles-inspection.ts';
import type { StylesInvalidation } from '../../astro-project-adapter/styles/convergence/invalidation-source.ts';

/**
 * The inspection seam the project-plane worker consumes (#230, ADR-0005
 * `inspect()`): the four typed families as plain async functions over
 * plain-data results, plus the control-plane-only route-selection
 * resolution (#370). The worker defines the seam; the composition
 * runtime (`project-plane/composition/composition-runtime.ts`) implements
 * it by wiring the landed adapter surfaces — E1's composition seams (the
 * `project` family), E4's `inspectContent`, E5's
 * `createRoutesInspector`, #370's `createRouteSelectionResolver`, and
 * E3's convergence-gated styles inspection
 * (`createConvergedStylesInspection` — the ONE styles entry this lane
 * wires; `route-styles.ts` stays the join's internal leg).
 *
 * Everything crossing this seam is typed and plain: no Vite handle, no
 * runner, no watcher, no module, no absolute path (the payloads are the
 * adapter's already-sanitized result shapes — project-relative posix
 * files, closed diagnostic codes, revisioned counters). The fresh-runner
 * discipline stays inside the branches: each call constructs, uses, and
 * closes its own runner (`withFreshRunner`, #206) — the worker holds no
 * runner between dispatches.
 */

/**
 * The `project` family payload: the certified exact Astro/Vite pair the
 * composition booted against (ADR-0005 compatibility contract). The
 * richer ADR-0005 descriptor fields (resolved base, source directory,
 * scoped-style strategy) have no landed adapter seam yet — they join
 * through the adapter when their lane lands one, never by reaching
 * around it.
 */
export interface ProjectDescriptor {
  /** The exact certified pair this project run booted against. */
  readonly certified: { readonly astro: string; readonly vite: string };
}

/** The four typed inspection branches — one per request family — plus the control-plane-only route-selection resolution. */
export interface InspectionBranches {
  /** The `project` family: certified-pair descriptor, fresh per call. */
  project(): Promise<ProjectDescriptor>;
  /**
   * The `styles` family: the convergence-gated inspection — one call is
   * one or more complete fresh passes; only a converged outcome carries
   * a payload (E3's freshness contract).
   */
  styles(input: StylesInspectionInput): Promise<StylesInspectionOutcome>;
  /** The `content` family: one fresh-runner pass over the composition (E4). */
  content(): Promise<ContentInspectionResult>;
  /** The `routes` family: one bounded, abortable fresh pass (E5). */
  routes(input: { readonly signal?: AbortSignal }): Promise<RoutesInspectionResult>;
  /**
   * The route-selection resolution (#370): the observed canvas pathname
   * to the active route's component — control-plane currency the
   * executor consumes to dispatch the styles family; its answer never
   * rides the wire (the no-disclosure law).
   */
  routeSelection(input: {
    readonly route: string;
    readonly signal?: AbortSignal;
  }): Promise<RouteSelectionResult>;
}

/**
 * The raw revisioned invalidation stream the worker accumulates: E3's
 * invalidation source over the composition watcher (monotonic
 * revisions, project-relative style-truth files). The worker subscribes
 * to this stream and owns its subscription; the plane owns the source's
 * own watcher bindings and disposes them in `close()`.
 */
export interface RawInvalidationSource {
  /** The latest observed invalidation revision (0 — none observed yet). */
  readonly revision: number;
  /** Registers a listener for future invalidation events; the return unbinds it. */
  subscribe(listener: (event: StylesInvalidation) => void): () => void;
}

/**
 * One disposable project plane's owned resources as the worker consumes
 * them (ADR-0005: the worker owns composition runtime, fresh runners,
 * watcher subscriptions, and timers as ONE failure boundary). The
 * composition runtime implements this; tests fake it at exactly this
 * typed dispatch boundary (the sanctioned stand-in level for #230 — no
 * third fake composition/runner pair).
 */
export interface ProjectWorkerPlane {
  readonly inspections: InspectionBranches;
  readonly invalidations: RawInvalidationSource;
  /**
   * Closes the plane's owned resources — the invalidation source's
   * watcher bindings and the composition Vite server. Idempotent by the
   * underlying seams' contract; a rejection is a cleanup failure the
   * worker reports, never swallows.
   */
  close(): Promise<void>;
}
