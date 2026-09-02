import type { ContentInspectionResult } from '../../astro-project-adapter/content/content-result.ts';
import type { RoutesInspectionResult } from '../../astro-project-adapter/routes/routes-inspection.ts';
import type { ConvergedStylesPayload } from '../../astro-project-adapter/styles/convergence/converged-styles-inspection.ts';
import { isProjectRelativePath } from '../../astro-project-adapter/styles/convergence/invalidation-source.ts';
import type { ProjectDescriptor } from './inspection-branches.ts';

/**
 * The typed inspection request/result contracts at the worker's dispatch
 * boundary (#230, ADR-0005: `inspect()` accepts ONLY typed `project`,
 * `content`, `routes`, and `styles` requests). The unions mirror the
 * protocol's closed inspection families (`packages/protocol/src/inspection.ts`)
 * — the worker layer adds the per-family typed inputs the landed adapter
 * surfaces require (`routeComponent` for styles) and the typed payload
 * interiors the protocol deliberately keeps opaque.
 *
 * The validator is the boundary guard: only these four closed shapes
 * enter dispatch. There is no generic request kind, no module/import
 * field, no filesystem-path field, and no extra-field tolerance — an
 * unknown or over-carrying request is rejected before any branch runs
 * (the ticket's migration policy, and the #199 negative surface at this
 * seam).
 */

/**
 * The upper bound on immediate fresh re-passes a single styles request
 * may ask for (E3's `attempts`): bounded work per request — retries
 * beyond it are later inspections, never a wider blast radius here.
 */
export const MAX_STYLES_ATTEMPTS = 10;

/** A route component's typed contract: a project-relative posix `.astro` page path. */
function isRouteComponent(value: unknown): value is string {
  return typeof value === 'string' && value.endsWith('.astro') && isProjectRelativePath(value);
}

/** One typed inspection request — exactly the four ADR-0005 families, nothing else. */
export type WorkerInspectionRequest =
  | { readonly kind: 'project' }
  | { readonly kind: 'content' }
  | { readonly kind: 'routes' }
  | {
      readonly kind: 'styles';
      /** The active route's component (`src/pages/…`, a `.astro` page path). */
      readonly routeComponent: string;
      /** Total fresh passes for this inspection (E3 `attempts`); default 1. */
      readonly attempts?: number;
    };

/**
 * Whether `value` is one of the four typed inspection requests: the
 * closed `kind` discriminant, no extra fields, and the styles family's
 * `routeComponent`/`attempts` fields shape-valid. Strict on unknown
 * fields by design — an over-carrying request is a protocol drift, not
 * data to forward.
 */
export function isWorkerInspectionRequest(value: unknown): value is WorkerInspectionRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind === 'project' || kind === 'content' || kind === 'routes') {
    return Object.keys(record).length === 1;
  }
  if (kind !== 'styles') return false;
  const keys = Object.keys(record);
  const hasAttempts = 'attempts' in record;
  if (keys.length !== (hasAttempts ? 3 : 2)) return false;
  if (!isRouteComponent(record.routeComponent)) return false;
  return (
    !hasAttempts ||
    (typeof record.attempts === 'number' &&
      Number.isInteger(record.attempts) &&
      record.attempts >= 1 &&
      record.attempts <= MAX_STYLES_ATTEMPTS)
  );
}

/**
 * One served inspection: the closed family discriminant, the monotonic
 * resource revision the payload is valid at (ADR-0005/0006 §6 — the
 * freshness contract behind grants), and the family's typed payload.
 */
export type WorkerInspectionResult =
  | { readonly kind: 'project'; readonly revision: number; readonly payload: ProjectDescriptor }
  | {
      readonly kind: 'content';
      readonly revision: number;
      readonly payload: ContentInspectionResult;
    }
  | { readonly kind: 'routes'; readonly revision: number; readonly payload: RoutesInspectionResult }
  | {
      readonly kind: 'styles';
      readonly revision: number;
      readonly payload: ConvergedStylesPayload;
    };
