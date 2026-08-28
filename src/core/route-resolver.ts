/**
 * Route resolution — the URL↔entry bridge (wayfinder #47 ruling, issue #69).
 *
 * A pure heuristic over Astro route patterns × content-collection entry ids:
 * nothing instruments entries at runtime (`data-astro-source-*` is a stub on
 * astro@7.2.7 and only reaches components anyway), so pattern shape is the
 * only mapping there is. Doctrine: a unique hit selects; ambiguity or no
 * match selects nothing — the heuristic never picks wrong, it picks nothing.
 *
 * Only patterns with exactly one param participate: a single segment param
 * (`/blog/[slug]`, the id must be one segment) or a rest param
 * (`/blog/[...slug]`, glob-loader ids are slugified paths, so `2024/post.md`
 * → id `2024/post` matches a catch-all). Patterns with more params cannot
 * isolate the id (and reverse navigation could not build their URL), embedded
 * params like `/pages/v-[id]` are not extracted — both stay silent.
 */

/** Minimal projection of one `astro:routes:resolved` route: its pattern string. */
export interface RouteInfo {
  /** Astro route pattern: `/`, `/about`, `/blog/[slug]`, `/blog/[...slug]`. */
  pattern: string;
}

/** The entry a canvas URL plausibly renders — the chrome's active entry. */
export interface ActiveEntry {
  collection: string;
  entryId: string;
}

/** A route that plausibly renders a given entry, and the canvas URL to navigate to. */
export interface RouteCandidate {
  pattern: string;
  url: string;
}

/** Collection name → entry ids (glob-loader ids are slugified paths: `2024/post`). */
export type CollectionsIndex = Readonly<Record<string, ReadonlyArray<string>>>;

type PatternSegment = { kind: 'static'; text: string } | { kind: 'param' } | { kind: 'rest' };

interface ParsedPattern {
  segments: PatternSegment[];
  /** Number of param/rest segments; only `1` participates in resolution. */
  paramCount: number;
}

const CANVAS_URL_BASE = 'http://astroix.canvas/';
const REST_DOTS = '...';

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
 * Reverse resolution (entry id → candidate routes): every single-param
 * pattern the id could fill, with the canvas URL it produces. Order follows
 * the routes input; plurality is the caller's ambiguity call (#71 navigates
 * only on a single candidate, then re-verifies by forward match).
 */
export function candidateRoutes(
  entryId: string,
  routes: ReadonlyArray<RouteInfo>,
): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];
  for (const route of routes) {
    const pattern = parsePattern(route.pattern);
    if (pattern === null || pattern.paramCount !== 1) continue;
    const url = buildCandidateUrl(pattern, entryId);
    if (url === null) continue;
    candidates.push({ pattern: route.pattern, url });
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
    const pattern = parsePattern(route.pattern);
    if (pattern === null || pattern.paramCount !== 0) continue;
    if (patternMatchesUrl(pattern, urlSegments)) return true;
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
    const pattern = parsePattern(route.pattern);
    if (pattern === null || pattern.paramCount !== 1) continue;
    const entryId = captureParamValue(pattern, urlSegments);
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

function parsePattern(pattern: string): ParsedPattern | null {
  const raw = pattern.split('/').filter((part) => part !== '');
  const segments: PatternSegment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const segment = parseSegment(raw[i] ?? '', i === raw.length - 1);
    if (segment === null) return null;
    segments.push(segment);
  }
  return { segments, paramCount: countParams(segments) };
}

/** Static text, a `[param]`, or a trailing `[...rest]`; anything else (embedded params, stray brackets) is unsupported. */
function parseSegment(text: string, isLast: boolean): PatternSegment | null {
  if (!text.includes('[')) return { kind: 'static', text };
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  const inner = text.slice(1, -1);
  if (inner.startsWith(REST_DOTS)) {
    return isLast && inner.length > REST_DOTS.length ? { kind: 'rest' } : null;
  }
  return inner === '' ? null : { kind: 'param' };
}

function countParams(segments: ReadonlyArray<PatternSegment>): number {
  return segments.filter((segment) => segment.kind !== 'static').length;
}

function patternMatchesUrl(pattern: ParsedPattern, urlSegments: ReadonlyArray<string>): boolean {
  const { segments } = pattern;
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

/** The captured value of the pattern's single param (`2024/post` for a rest param); null when the URL doesn't fit. */
function captureParamValue(
  pattern: ParsedPattern,
  urlSegments: ReadonlyArray<string>,
): string | null {
  if (!patternMatchesUrl(pattern, urlSegments)) return null;
  const paramAt = pattern.segments.findIndex((segment) => segment.kind !== 'static');
  if (paramAt === -1) return null;
  return pattern.segments[paramAt]?.kind === 'rest'
    ? urlSegments.slice(paramAt).join('/')
    : (urlSegments[paramAt] ?? null);
}

function buildCandidateUrl(pattern: ParsedPattern, entryId: string): string | null {
  const idParts = entryId.split('/');
  const takesEntryId = pattern.segments.some((segment) => segment.kind === 'rest')
    ? idParts.every((part) => part !== '')
    : idParts.length === 1 && idParts[0] !== '';
  if (!takesEntryId) return null;

  const pathParts: string[] = [];
  for (const segment of pattern.segments) {
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
