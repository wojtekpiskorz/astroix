import type { AdapterErrorDetails, SeamClass } from '../adapter-error';
import { AdapterError, observedShape } from '../adapter-error';

/**
 * The route-metadata seam probe (#229, extending #225's
 * `readRouteEntries` idiom): the `virtual:astro:routes` export's
 * `routeData` carries more than the three strings E1 certified — Astro's
 * own route parse (`segments`), the param names, the prerender flag, and
 * the route origin. This reader verifies that richer metadata against the
 * certified shape and returns deep-copied plain data: the export's
 * `routeData` also holds live `RegExp` patterns and `URL` arrays owned by
 * the module graph, and the adapter never holds those between passes.
 *
 * Like every seam probe: an unknown shape is a compatibility event —
 * `seam-rejected` naming the seam, its class, the expected shape, and a
 * structural observed description. The adapter never guesses a route from
 * the filesystem; routes exist here because the certified seam said so,
 * or they do not exist.
 */

/** The seam this probe guards — the same export E1's `readRouteEntries` probes. */
const SEAM_ROUTES_EXPORT = 'virtual:astro:routes export';

/** Astro's `RouteType` literals at the certified pin — a value outside the set is drift. */
const ROUTE_TYPES = ['page', 'endpoint', 'redirect', 'fallback'] as const;

/** Astro's route `origin` literals at the certified pin — a value outside the set is drift. */
const ROUTE_ORIGINS = ['internal', 'external', 'project'] as const;

/** One part of one segment of Astro's own route-pattern parse. */
export interface RouteSegmentPart {
  readonly content: string;
  readonly dynamic: boolean;
  readonly spread: boolean;
}

/**
 * One route from the certified seam, as plain data: everything route
 * inspection needs and nothing the module graph owns. `component` is the
 * project-relative entrypoint Astro reports — the enumeration pass's only
 * import key, never a returned field.
 */
export interface RouteMetadataEntry {
  readonly pattern: string;
  readonly component: string;
  readonly type: (typeof ROUTE_TYPES)[number];
  readonly origin: (typeof ROUTE_ORIGINS)[number];
  readonly prerender: boolean;
  readonly params: readonly string[];
  readonly segments: readonly (readonly RouteSegmentPart[])[];
}

/**
 * Reads and validates the `virtual:astro:routes` export's route metadata.
 * Fails closed on every drift: a missing `routes` array, an entry whose
 * `routeData` misses a certified field, a `type` or `origin` outside the
 * known literals, or a repeated pattern (a pattern is route identity —
 * the frozen contract refuses duplicates, so the seam refusing them first
 * keeps the payload honest).
 */
export function readRouteMetadata(moduleExports: unknown): readonly RouteMetadataEntry[] {
  const routes = (moduleExports as { routes?: unknown })?.routes;
  if (!Array.isArray(routes)) {
    throw seamRejected('an array routes export', observedShape(moduleExports));
  }
  const entries = routes.map(readEntry);
  assertUniquePatterns(entries);
  return entries;
}

function readEntry(route: unknown, index: number): RouteMetadataEntry {
  const data = (route as { routeData?: unknown })?.routeData as
    | {
        route?: unknown;
        component?: unknown;
        type?: unknown;
        origin?: unknown;
        prerender?: unknown;
        params?: unknown;
        segments?: unknown;
      }
    | null
    | undefined;
  if (typeof data?.route !== 'string' || data.route.length === 0) {
    throw seamRejected(
      `route ${index} with a non-empty string routeData.route`,
      observedShape(route),
    );
  }
  if (typeof data.component !== 'string' || data.component.length === 0) {
    throw seamRejected(
      `route ${index} with a non-empty string routeData.component`,
      observedShape(route),
    );
  }
  if (typeof data.type !== 'string' || !isRouteType(data.type)) {
    throw seamRejected(
      `route ${index} with routeData.type one of ${ROUTE_TYPES.join(' | ')}`,
      observedShape(route),
    );
  }
  if (typeof data.origin !== 'string' || !isRouteOrigin(data.origin)) {
    throw seamRejected(
      `route ${index} with routeData.origin one of ${ROUTE_ORIGINS.join(' | ')}`,
      observedShape(route),
    );
  }
  if (typeof data.prerender !== 'boolean') {
    throw seamRejected(`route ${index} with a boolean routeData.prerender`, observedShape(route));
  }
  if (!isStringArray(data.params)) {
    throw seamRejected(
      `route ${index} with an array of string routeData.params`,
      observedShape(route),
    );
  }
  const segments = readSegments(data.segments, index, route);
  return {
    pattern: data.route,
    component: data.component,
    type: data.type,
    origin: data.origin,
    prerender: data.prerender,
    params: [...data.params],
    segments,
  };
}

function readSegments(
  segments: unknown,
  index: number,
  route: unknown,
): readonly (readonly RouteSegmentPart[])[] {
  if (!Array.isArray(segments)) {
    throw seamRejected(`route ${index} with an array routeData.segments`, observedShape(route));
  }
  return segments.map((segment, segmentIndex) => {
    if (!Array.isArray(segment)) {
      throw seamRejected(
        `route ${index} segment ${segmentIndex} as an array of parts`,
        observedShape(route),
      );
    }
    return segment.map((part, partIndex) => {
      const candidate = part as { content?: unknown; dynamic?: unknown; spread?: unknown } | null;
      if (
        typeof candidate?.content !== 'string' ||
        typeof candidate.dynamic !== 'boolean' ||
        typeof candidate.spread !== 'boolean'
      ) {
        throw seamRejected(
          `route ${index} segment ${segmentIndex} part ${partIndex} with string content and boolean dynamic, spread`,
          observedShape(route),
        );
      }
      return { content: candidate.content, dynamic: candidate.dynamic, spread: candidate.spread };
    });
  });
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRouteType(value: string): value is (typeof ROUTE_TYPES)[number] {
  return ROUTE_TYPES.includes(value as never);
}

function isRouteOrigin(value: string): value is (typeof ROUTE_ORIGINS)[number] {
  return ROUTE_ORIGINS.includes(value as never);
}

function assertUniquePatterns(entries: readonly RouteMetadataEntry[]): void {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const entry of entries) {
    if (seen.has(entry.pattern)) duplicates += 1;
    seen.add(entry.pattern);
  }
  if (duplicates > 0) {
    throw seamRejected(
      `routes with unique patterns (${duplicates} duplicate${duplicates === 1 ? '' : 's'} observed)`,
      `${duplicates} repeated pattern${duplicates === 1 ? '' : 's'}`,
    );
  }
}

function seamRejected(expected: string, observed: string): AdapterError {
  const details: AdapterErrorDetails = {
    seam: SEAM_ROUTES_EXPORT,
    seamClass: 'fail-closed private' as SeamClass,
    expected,
    observed,
  };
  return new AdapterError(
    'seam-rejected',
    `AstroProjectAdapter seam rejection at ${SEAM_ROUTES_EXPORT}: expected ${expected}; observed ${observed}`,
    details,
  );
}
