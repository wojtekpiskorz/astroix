import type { CompositionServer } from '../composition';
import { withFreshRunner } from '../fresh-runner';
import { bounded, DEFAULT_WAIT_TIMEOUT_MS } from './route-enumeration';
import {
  type RouteMetadataEntry,
  type RouteSegmentPart,
  readRouteMetadata,
} from './route-metadata';
import { isProjectPageRoute } from './routes-payload';

/**
 * The route-selection resolution seam (#370, the ruling's direction
 * (b) + pathname): maps the wire-carried observed canvas PATHNAME to
 * the active route's COMPONENT — the one fact the routes seam already
 * reads (`RouteMetadataEntry.component`) and deliberately never serves
 * (the no-disclosure law: no component path enters any payload, and
 * the frozen routes contract stays untouched). The answer is
 * control-plane currency alone: the executor consumes it to dispatch
 * the styles inspection (`{ kind: 'styles', routeComponent }`); the
 * renderer never sees it.
 *
 * The matching is Astro's own, re-implemented over the seam's PUBLIC
 * segments parse rather than reusing the module graph's live `RegExp`
 * (which the metadata reader drops by law — plain data only). The
 * certified pair's pattern builder (`astro/dist/core/routing/pattern.js`
 * at astro@7.2.10) is the semantics of record:
 *
 * - a static part matches its content literally (both sides Unicode
 *   normalized);
 * - a dynamic part (`[param]`) matches one non-empty run without `/`;
 * - a segment that is exactly one spread part (`[...rest]`) is an
 *   OPTIONAL tail — `(?:\/(.*?))?` — matching zero or more remaining
 *   segments (`/blog/[...slug]` matches `/blog` too);
 * - parts join within one segment (`/post-[id]` is static `post-`
 *   plus dynamic `id`);
 * - the first matching route in SEAM ORDER wins — the export's array
 *   order is Astro's own sorted match order (its router sorts then
 *   `find`s), so resolution and the dev server cannot disagree.
 *
 * Membership follows the routes payload's own law
 * (`isProjectPageRoute`) plus the styles request's typed contract (a
 * project-relative `.astro` page path): served patterns, enumerated
 * patterns, and RESOLVED selections cannot drift. A pathname that
 * matches no such route is unresolvable — fail-closed, never a
 * filesystem guess (the adapter never guesses a route from the
 * filesystem; routes exist because the certified seam said so).
 *
 * Static literals carrying percent-encoded forms (`%3F` for a literal
 * `?`) are a known fail-closed edge: the seam compares DECODED
 * segments, so such a route simply never matches — never a heuristic
 * parse of drifted output.
 */

/** One resolved route selection — the matched project page route's identity and the styles request's component. */
export interface RouteSelection {
  /** The matched route's pattern — the same identity the routes payload serves. */
  readonly pattern: string;
  /** The route's project-relative `.astro` page path — control-plane currency, never a payload field. */
  readonly component: string;
}

/** One resolution pass's result: the monotonic revision and the selection valid at it (null = unresolvable). */
export interface RouteSelectionResult {
  readonly revision: number;
  readonly selection: RouteSelection | null;
}

/** The per-project-plane route-selection resolver — one composition, many fresh passes. */
export interface RouteSelectionResolver {
  resolve(input: {
    readonly route: string;
    readonly signal?: AbortSignal;
  }): Promise<RouteSelectionResult>;
}

/** Whether an entry is a resolvable selection's candidate: a project page route with an `.astro` component. */
function isResolvableRoute(entry: RouteMetadataEntry): boolean {
  return isProjectPageRoute(entry) && entry.component.endsWith('.astro');
}

/**
 * The pure matcher: the observed canvas pathname against the seam's
 * metadata, first project-page match in seam order. Returns `null` for
 * a non-pathname shape (not `/`-rooted, empty or undecodable segments),
 * an inner empty segment, or no matching route — every fail path is
 * unresolvable, never an error: the caller answers the client's 404.
 */
export function matchRouteSelection(
  entries: readonly RouteMetadataEntry[],
  route: string,
): RouteSelection | null {
  const pathname = pathnameSegments(route);
  if (pathname === null) return null;
  for (const entry of entries) {
    if (isResolvableRoute(entry) && routeMatches(entry.segments, pathname)) {
      return { pattern: entry.pattern, component: entry.component };
    }
  }
  return null;
}

/**
 * Splits and decodes one observed pathname into its segment values —
 * `null` when the shape is not a pathname the canvas could observe:
 * not `/`-rooted, an empty inner segment, or a segment that does not
 * decode (the wire layer refuses these first; this is the seam's own
 * fail-closed re-validation, defense in depth).
 */
function pathnameSegments(route: string): readonly string[] | null {
  if (!route.startsWith('/') || route.includes('\\') || route.includes('//')) return null;
  const trimmed = route.length > 1 && route.endsWith('/') ? route.slice(0, -1) : route;
  if (trimmed === '/') return [];
  const decoded: string[] = [];
  for (const raw of trimmed.slice(1).split('/')) {
    if (raw.length === 0) return null;
    try {
      decoded.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  return decoded;
}

/** Whether the pattern's segments parse matches the decoded pathname segments (the certified builder's semantics). */
function routeMatches(
  segments: readonly (readonly RouteSegmentPart[])[],
  pathname: readonly string[],
): boolean {
  return matchFrom(segments, 0, pathname, 0);
}

function matchFrom(
  segments: readonly (readonly RouteSegmentPart[])[],
  segmentIndex: number,
  pathname: readonly string[],
  pathIndex: number,
): boolean {
  if (segmentIndex === segments.length) return pathIndex === pathname.length;
  const segment = segments[segmentIndex];
  const first = segment?.[0];
  if (segment === undefined || first === undefined) return false;
  if (segment.length === 1 && first.spread) {
    // Astro's grammar emits a spread part only as a lone FINAL segment;
    // a drifted shape (mid-pattern spread) matches nothing here — fail
    // closed, never a heuristic parse.
    return segmentIndex + 1 === segments.length;
  }
  const value = pathname[pathIndex];
  if (value === undefined) return false;
  return (
    segmentMatches(segment, value) && matchFrom(segments, segmentIndex + 1, pathname, pathIndex + 1)
  );
}

/** Whether one segment's parts concatenate to exactly `value` (dynamic parts are non-empty runs). */
function segmentMatches(parts: readonly RouteSegmentPart[], value: string): boolean {
  return partsMatchFrom(parts, 0, value, 0);
}

function partsMatchFrom(
  parts: readonly RouteSegmentPart[],
  partIndex: number,
  value: string,
  start: number,
): boolean {
  if (partIndex === parts.length) return start === value.length;
  const part = parts[partIndex];
  if (part === undefined) return false;
  if (part.spread) {
    // Only the lone-final-segment spread reaches the segment level as a
    // pattern-level tail; a mixed-in spread part is a drifted shape and
    // matches nothing (fail closed).
    return false;
  }
  if (!part.dynamic) {
    const content = part.content.normalize();
    if (!value.startsWith(content, start)) return false;
    return partsMatchFrom(parts, partIndex + 1, value, start + content.length);
  }
  // `([^/]+?)` — a non-empty run without `/`; the value carries no `/`
  // by construction (it is one decoded segment), so any non-empty span
  // ending at a viable continuation matches.
  for (let end = start + 1; end <= value.length; end += 1) {
    if (partsMatchFrom(parts, partIndex + 1, value, end)) return true;
  }
  return false;
}

const VIRTUAL_ROUTES_MODULE = 'virtual:astro:routes';

/**
 * Creates the resolver over a booted composition server — the same
 * fresh-runner discipline as the routes inspection: one bounded,
 * abortable `virtual:astro:routes` read per resolve, the runner closed
 * on every exit path, no runner held between passes. The revision is
 * the resolution resource's own monotonic counter — a version, not a
 * diff signal: it ticks once per completed pass (resolved or not) and
 * never for a pass that rejected. The composition is borrowed, never
 * owned; its teardown stays with the runtime lifecycle that booted it.
 */
export function createRouteSelectionResolver(input: {
  readonly composition: CompositionServer;
  /** Per-wait bound on the metadata read; defaults to `DEFAULT_WAIT_TIMEOUT_MS`. */
  readonly waitTimeoutMs?: number;
}): RouteSelectionResolver {
  let revision = 0;
  return {
    resolve: async (pass) => {
      pass.signal?.throwIfAborted();
      const waitTimeoutMs = input.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const outcome = await withFreshRunner(
        {
          createServerModuleRunner: input.composition.seams.vite.createServerModuleRunner,
          ssrEnvironment: input.composition.server.environments.ssr,
        },
        async (runner) =>
          matchRouteSelection(
            readRouteMetadata(
              await bounded(
                runner.import(VIRTUAL_ROUTES_MODULE),
                pass.signal,
                waitTimeoutMs,
                new Error('the virtual routes module read exceeded its per-wait bound'),
              ),
            ),
            pass.route,
          ),
      );
      revision += 1;
      return { revision, selection: outcome.result };
    },
  };
}
