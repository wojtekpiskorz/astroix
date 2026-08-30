/**
 * Route resolution — the URL↔entry bridge (wayfinder #47 ruling, issue #69).
 *
 * A pure heuristic over Astro route patterns × content-collection entry ids:
 * nothing instruments entries at runtime (`data-astro-source-*` is a stub on
 * astro@7.2.7 and only reaches components anyway), so pattern shape is the
 * only mapping there is. Doctrine: a unique hit — or a plurality whose every
 * candidate resolves to the same entry (#109) — selects, taking the most
 * specific pattern; any other ambiguity or no match selects nothing — the
 * heuristic never picks wrong, it picks nothing.
 *
 * Core-first (owner ruling on PR #77): the route arrives with Astro's own
 * parse — `segments` (`RoutePart[][]`, `{content, dynamic, spread}`) and
 * `params` from `astro:routes:resolved` — so no grammar is re-derived here.
 * Only patterns with exactly one param participate: a single segment param
 * (`/blog/[slug]`, the id must be one segment) or a trailing rest param
 * (`/blog/[...slug]`, glob-loader ids are slugified paths, so `2024/post.md`
 * → id `2024/post` matches a catch-all). Patterns with more params cannot
 * isolate the id (and reverse navigation could not build their URL), a
 * mid-pattern rest (`/pages/[...slug]/edit`) and embedded params
 * (`/pages/v-[id]`, multi-part segments) are not extracted — all stay
 * silent.
 *
 * Contract: callers pass page routes — the routes payload filters out
 * `endpoint`/`redirect`/`fallback` route types before serving (#68).
 */

/** One part of a route segment — Astro's own parse (`RoutePart` from `astro:routes:resolved`). */
export interface RouteSegmentPart {
  content: string;
  dynamic: boolean;
  spread: boolean;
}

/** Minimal projection of one `astro:routes:resolved` route (page routes only). */
export interface RouteInfo {
  /** Astro route pattern — identity and display; resolution reads `segments`. */
  pattern: string;
  /** Astro's parse of the pattern: parts per segment. */
  segments: ReadonlyArray<ReadonlyArray<RouteSegmentPart>>;
  /** Param names as Astro reports them (`...slug` for a rest param); resolution reads `segments` — `params` rides through for the routes payload's consumers (#68). */
  params: ReadonlyArray<string>;
}

/** The entry a canvas URL plausibly renders — the chrome's active entry. */
export interface ActiveEntry {
  collection: string;
  entryId: string;
}

/** Collection name → entry ids (glob-loader ids are slugified paths: `2024/post`). */
export type CollectionsIndex = Readonly<Record<string, ReadonlyArray<string>>>;

type FlatSegment = { kind: 'static'; text: string } | { kind: 'param' } | { kind: 'rest' };

interface StaticRoute {
  kind: 'static';
  segments: FlatSegment[];
}

interface SingleParamRoute {
  kind: 'single-param';
  segments: FlatSegment[];
  /** Position of the one param among `segments` — the invariant `kind` carries. */
  paramAt: number;
}

/** A route flattened from Astro's parse: zero params, or exactly one (single or rest) — anything else stays silent. */
type FlatRoute = StaticRoute | SingleParamRoute;

/** A candidate with the specificity facts the picking rule reads. */
interface RankedCandidate {
  url: string;
  /** The param is a trailing catch-all — less specific than a segment param. */
  rest: boolean;
  /** Pattern depth in segments — shallower is more specific. */
  segments: number;
}

const CANVAS_URL_BASE = 'http://astroix.canvas/';

/**
 * Forward resolution (canvas URL → active entry): the URL must match exactly
 * one single-param route pattern whose captured value is an entry id held by
 * exactly one collection. The same entry reached via overlapping patterns is
 * still one hit; different entries, an id in two collections, a static page
 * rendering the URL, or no match at all — null.
 */
export function resolveActiveEntry(
  routes: ReadonlyArray<RouteInfo>,
  url: string,
  collections: CollectionsIndex,
): ActiveEntry | null {
  const urlSegments = toUrlSegments(url);
  if (isStaticPage(routes, urlSegments)) return null;
  const hits = entryHitsFor(routes, urlSegments, collections);
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/**
 * Reverse resolution (entry id → the canvas URL to navigate): every
 * single-param pattern the id could fill, minus URLs a static route renders
 * (forward resolution would stay silent there, so the candidate could not
 * re-verify). Plurality is benign only when every candidate forward-resolves
 * to the same entry — the pick then takes the most specific pattern: a
 * single-segment param before a catch-all, then the shallowest pattern, then
 * route input order (the stable sort keeps it). Zero candidates, or a
 * candidate that does not forward-resolve to this entry — null; the
 * heuristic never picks wrong.
 */
export function pickNavigableCandidate(
  entryId: string,
  routes: ReadonlyArray<RouteInfo>,
  collections: CollectionsIndex,
): string | null {
  const candidates = rankedCandidates(entryId, routes);
  for (const candidate of candidates) {
    const hit = resolveActiveEntry(routes, candidate.url, collections);
    if (hit === null || hit.entryId !== entryId) return null;
  }
  const [best] = [...candidates].sort(
    (a, b) => Number(a.rest) - Number(b.rest) || a.segments - b.segments,
  );
  return best?.url ?? null;
}

/**
 * Whether any single-param pattern could render this entry — the sidebar's
 * unrouted marker (#111): zero candidates means no route follows the id.
 * Plurality and specificity are the picker's concern, not this predicate's.
 */
export function hasCandidateRoutes(entryId: string, routes: ReadonlyArray<RouteInfo>): boolean {
  return rankedCandidates(entryId, routes).length > 0;
}

function rankedCandidates(entryId: string, routes: ReadonlyArray<RouteInfo>): RankedCandidate[] {
  const candidates: RankedCandidate[] = [];
  for (const route of routes) {
    const flat = flattenRoute(route);
    if (flat === null || flat.kind !== 'single-param') continue;
    const url = buildCandidateUrl(flat, entryId);
    if (url === null) continue;
    if (isStaticPage(routes, toUrlSegments(url))) continue;
    candidates.push({
      url,
      rest: flat.segments[flat.paramAt]?.kind === 'rest',
      segments: flat.segments.length,
    });
  }
  return candidates;
}

/**
 * Astro serves static routes over dynamic ones: when a zero-param pattern
 * matches the URL, the page is static and a param-matched entry would be a
 * wrong pick — forward resolution stays silent.
 */
function isStaticPage(
  routes: ReadonlyArray<RouteInfo>,
  urlSegments: ReadonlyArray<string>,
): boolean {
  for (const route of routes) {
    const flat = flattenRoute(route);
    if (flat === null || flat.kind !== 'static') continue;
    if (patternMatchesUrl(flat.segments, urlSegments)) return true;
  }
  return false;
}

function entryHitsFor(
  routes: ReadonlyArray<RouteInfo>,
  urlSegments: ReadonlyArray<string>,
  collections: CollectionsIndex,
): ActiveEntry[] {
  const hits = new Map<string, ActiveEntry>();
  for (const route of routes) {
    const flat = flattenRoute(route);
    if (flat === null || flat.kind !== 'single-param') continue;
    const entryId = captureParamValue(flat, urlSegments);
    if (entryId === null) continue;
    for (const collection of collectionsWithEntry(entryId, collections)) {
      hits.set(`${collection}\u0000${entryId}`, { collection, entryId });
    }
  }
  return [...hits.values()];
}

function collectionsWithEntry(entryId: string, collections: CollectionsIndex): string[] {
  const names: string[] = [];
  for (const [collection, entryIds] of Object.entries(collections)) {
    if (entryIds.includes(entryId)) names.push(collection);
  }
  return names;
}

function flattenRoute(route: RouteInfo): FlatRoute | null {
  const segments: FlatSegment[] = [];
  let paramAt = -1;
  for (const [i, parts] of route.segments.entries()) {
    const segment = flattenSegment(parts);
    if (segment === null) return null;
    if (segment.kind === 'rest' && i !== route.segments.length - 1) {
      return null; // a mid-pattern rest captures only its prefix — not a shape we promise to resolve
    }
    if (segment.kind !== 'static') {
      if (paramAt !== -1) return null; // two params cannot isolate the entry id
      paramAt = segments.length;
    }
    segments.push(segment);
  }
  return paramAt === -1
    ? { kind: 'static', segments }
    : { kind: 'single-param', segments, paramAt };
}

/** A single-part segment is static text, a `[param]`, or a `[...rest]`; embedded params (multi-part segments) stay silent. */
function flattenSegment(parts: ReadonlyArray<RouteSegmentPart>): FlatSegment | null {
  const [part] = parts;
  if (part === undefined || parts.length !== 1) return null;
  if (part.spread) return { kind: 'rest' };
  if (part.dynamic) return { kind: 'param' };
  return { kind: 'static', text: part.content };
}

function patternMatchesUrl(
  segments: ReadonlyArray<FlatSegment>,
  urlSegments: ReadonlyArray<string>,
): boolean {
  const restAt = segments.findIndex((segment) => segment.kind === 'rest');
  if (restAt === -1) {
    return (
      segments.length === urlSegments.length &&
      segments.every((segment, i) => segment.kind !== 'static' || segment.text === urlSegments[i])
    );
  }
  // A rest param consumes at least one segment: the URL is never shorter than the pattern.
  if (urlSegments.length < segments.length) return false;
  for (let i = 0; i < restAt; i++) {
    const segment = segments[i];
    if (segment?.kind === 'static' && segment.text !== urlSegments[i]) return false;
  }
  return true;
}

/** The captured value of the route's single param (`2024/post` for a rest param); null when the URL doesn't fit. */
function captureParamValue(
  route: SingleParamRoute,
  urlSegments: ReadonlyArray<string>,
): string | null {
  if (!patternMatchesUrl(route.segments, urlSegments)) return null;
  return route.segments[route.paramAt]?.kind === 'rest'
    ? urlSegments.slice(route.paramAt).join('/')
    : (urlSegments[route.paramAt] ?? null);
}

function buildCandidateUrl(route: SingleParamRoute, entryId: string): string | null {
  const idParts = entryId.split('/');
  const takesEntryId =
    route.segments[route.paramAt]?.kind === 'rest'
      ? idParts.every((part) => part !== '')
      : idParts.length === 1 && idParts[0] !== '';
  if (!takesEntryId) return null;

  const pathParts: string[] = [];
  for (const segment of route.segments) {
    if (segment.kind === 'static') pathParts.push(segment.text);
    else if (segment.kind === 'param') pathParts.push(encodeSegment(idParts[0] ?? ''));
    else pathParts.push(...idParts.map(encodeSegment));
  }
  return `/${pathParts.join('/')}`;
}

/** The canvas reports its full URL (`?builder=0` and all); only the pathname segments matter. */
function toUrlSegments(url: string): string[] {
  let pathname: string;
  try {
    pathname = new URL(url, CANVAS_URL_BASE).pathname;
  } catch {
    return [];
  }
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map(decodeSegment);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function encodeSegment(part: string): string {
  return encodeURIComponent(part);
}
