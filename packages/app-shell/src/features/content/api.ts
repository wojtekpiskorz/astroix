import type { ResourceGrant } from '@wojciechpiskorz/astroix-protocol';
import {
  type CollectionsIndex,
  hasCandidateRoutes,
  type RouteInfo,
} from '../../../../core/src/route-resolver.ts';
import { useShell } from '../../app-shell/shell-context.ts';
import { useSessionQuery } from '../../app-shell/use-session-query.ts';
import { asRecord, bindGrantClaim, nonEmptyString } from '../../editor/edit-drain/grant-claim.ts';
import type { CollectionListingView } from '../../presentation/types.ts';

/**
 * The Content vertical's server-data slice (#251, J1): the read-only
 * discovery queries — the E4 content inspection (collections, entries,
 * compatibility diagnostics) and the E5 routes inspection (route
 * patterns + enumeration) — through the ONE AppClient's typed
 * `inspect`, under the shell's generation-scoped query discipline.
 *
 * Laws this module owns:
 *
 * - **One transport** — every exchange rides `session.inspect` off the
 *   shell context (`useShell()`, the one-AppClient law #332): no fetch
 *   helper, no second client, no direct endpoint exists here.
 * - **Generation-scoped keys** — both queries mint their keys through
 *   `useSessionQuery` (`['astroix', runtimeEpoch, generation, 'content' |
 *   'routes']`, ADR-0006 §5), so the cache dies with the session at
 *   commit by construction. The pair IS the project binding: one
 *   active session exists per control plane and the document is served
 *   on that project's host (ADR-0006 §3) — keying by ProjectKey beyond
 *   the pair would be a second name for the same identity, so the pair
 *   is the whole scope. The scope names deliberately equal the
 *   protocol's inspection-family discriminants, so the provider's
 *   SSE→query invalidation bridge (revisioned `invalidation` frames)
 *   refetches exactly these keys.
 * - **Fail-closed payload binding** — the protocol keeps inspection
 *   payload interiors opaque (`z.unknown()` — contract-owned shapes);
 *   the server-side truth is the runtime's typed `ContentInspectionResult`
 *   / `RoutesInspectionResult`. This module binds that opaque interior
 *   to the projection the discovery UI consumes, structurally, and a
 *   drifted payload binds to `null` — the diagnostic state, never a
 *   heuristic parse (a seam drift is a compatibility event).
 * - **No raw paths** — the binding projects collection names, entry
 *   ids, and diagnostic codes only; `filePath` and entry interiors the
 *   UI never reads never enter the projected shape at all.
 */

/** One discovered collection — the name plus its entry ids in served order. */
export interface DiscoveredCollection {
  readonly name: string;
  readonly entryIds: readonly string[];
}

/**
 * One E4 compatibility diagnostic — a declared collection outside the
 * certified categories. Sanitized by contract: `observed` is a
 * structural shape description, never a value or a path.
 */
export interface UnsupportedCollectionDiagnostic {
  readonly code: string;
  readonly collection: string;
  readonly expected: string;
  readonly observed: string;
}

/** The E4 content inspection as the discovery UI consumes it. */
export interface ContentDiscoveryData {
  readonly collections: readonly DiscoveredCollection[];
  readonly diagnostics: readonly UnsupportedCollectionDiagnostic[];
}

/**
 * The panel's structured state vocabulary (#251's AC): `loading` while
 * either inspection is in flight, `ready` with at least one supported
 * collection, `empty` when the project honestly declares no content at
 * all, `unsupported` when every declared collection failed a certified
 * category, `diagnostic` for refused exchanges and drifted payloads.
 */
export type DiscoveryStatus = 'loading' | 'ready' | 'empty' | 'unsupported' | 'diagnostic';

/** The derived discovery view the panel and the navigation slice consume. */
export interface ContentDiscoveryQuery {
  readonly status: DiscoveryStatus;
  /** The listing view (the presentation `EntryTree`'s prop) — nonempty in `ready`. */
  readonly listing: readonly CollectionListingView[];
  /** Entry ids positively no route renders — the unrouted marker's truth (E5-derived). */
  readonly unroutedIds: ReadonlySet<string>;
  /** The collections index the pure resolver reads (core `route-resolver`). */
  readonly collectionsIndex: CollectionsIndex;
  /** The E5 route patterns — the ONLY route truth navigation resolves through. */
  readonly routes: readonly RouteInfo[] | null;
  /** The unsupported collections' diagnostics — surfaced in `unsupported` and beside `ready`. */
  readonly diagnostics: readonly UnsupportedCollectionDiagnostic[];
  /** The diagnostic state's sanitized reason — `null` in every other state. */
  readonly diagnosticMessage: string | null;
}

/** Binds one collection record — the name plus its entry ids in served order. */
function bindCollection(value: unknown): DiscoveredCollection | null {
  const record = asRecord(value);
  if (record === null) return null;
  const name = nonEmptyString(record.name);
  if (name === null || !Array.isArray(record.entries)) return null;
  const entryIds: string[] = [];
  for (const entry of record.entries) {
    const entryRecord = asRecord(entry);
    const id = entryRecord === null ? null : nonEmptyString(entryRecord.id);
    if (id === null) return null;
    entryIds.push(id);
  }
  return { name, entryIds };
}

/** Binds one compatibility-diagnostic record — the sanitized vocabulary, structurally. */
function bindDiagnostic(value: unknown): UnsupportedCollectionDiagnostic | null {
  const record = asRecord(value);
  if (record === null) return null;
  const code = nonEmptyString(record.code);
  const collection = nonEmptyString(record.collection);
  const expected = nonEmptyString(record.expected);
  const observed = nonEmptyString(record.observed);
  if (code === null || collection === null || expected === null || observed === null) return null;
  return { code, collection, expected, observed };
}

/**
 * Binds one opaque content-inspection payload to the discovery
 * projection — `null` on any drift (fail closed, never a heuristic
 * parse). Validates exactly the fields the UI consumes: collection
 * names, entry ids, and the diagnostics' sanitized vocabulary.
 */
export function bindContentInspection(payload: unknown): ContentDiscoveryData | null {
  const record = asRecord(payload);
  if (record === null) return null;
  if (!Array.isArray(record.collections) || !Array.isArray(record.diagnostics)) return null;
  const collections: DiscoveredCollection[] = [];
  for (const candidate of record.collections) {
    const collection = bindCollection(candidate);
    if (collection === null) return null;
    collections.push(collection);
  }
  const diagnostics: UnsupportedCollectionDiagnostic[] = [];
  for (const candidate of record.diagnostics) {
    const diagnostic = bindDiagnostic(candidate);
    if (diagnostic === null) return null;
    diagnostics.push(diagnostic);
  }
  return { collections, diagnostics };
}

/** One route segment part as the pure resolver reads it — Astro's own parse. */
interface BoundSegmentPart {
  readonly content: string;
  readonly dynamic: boolean;
  readonly spread: boolean;
}

/** Binds one route segment part — structural, `null` on drift. */
function bindSegmentPart(value: unknown): BoundSegmentPart | null {
  const record = asRecord(value);
  if (record === null) return null;
  if (typeof record.content !== 'string') return null;
  if (typeof record.dynamic !== 'boolean' || typeof record.spread !== 'boolean') return null;
  return { content: record.content, dynamic: record.dynamic, spread: record.spread };
}

/** Binds the segments array — parts per segment, `null` on any drift. */
function bindSegments(value: unknown): readonly (readonly BoundSegmentPart[])[] | null {
  if (!Array.isArray(value)) return null;
  const segments: BoundSegmentPart[][] = [];
  for (const segment of value) {
    if (!Array.isArray(segment)) return null;
    const parts: BoundSegmentPart[] = [];
    for (const part of segment) {
      const bound = bindSegmentPart(part);
      if (bound === null) return null;
      parts.push(bound);
    }
    segments.push(parts);
  }
  return segments;
}

/** Binds a plain string array — `null` when not one. */
function bindStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item !== 'string') return null;
  }
  return [...value];
}

/** Binds one route record — every field structural, one drift rejects the pass. */
function bindRoute(value: unknown): RouteInfo | null {
  const record = asRecord(value);
  if (record === null) return null;
  const pattern = nonEmptyString(record.pattern);
  if (pattern === null || !pattern.startsWith('/')) return null;
  const segments = bindSegments(record.segments);
  const params = bindStringArray(record.params);
  if (segments === null || params === null) return null;
  if (record.rendering !== 'prerendered' && record.rendering !== 'on-demand') return null;
  if (record.renders === undefined) {
    return { pattern, segments, params, rendering: record.rendering };
  }
  const renders = bindStringArray(record.renders);
  if (renders === null) return null;
  return { pattern, segments, params, rendering: record.rendering, renders };
}

/**
 * Binds one opaque routes-inspection payload to the pure resolver's
 * `RouteInfo` shape (the frozen routes contract's own record) — `null`
 * on any drift (fail closed). The bound routes are plain data: pattern,
 * Astro's own segments parse, params, rendering mode, and — where
 * enumeration positively succeeded — the renders space.
 */
export function bindRoutesInspection(payload: unknown): readonly RouteInfo[] | null {
  const record = asRecord(payload);
  if (record === null) return null;
  if (!Array.isArray(record.routes)) return null;
  const routes: RouteInfo[] = [];
  for (const candidate of record.routes) {
    const route = bindRoute(candidate);
    if (route === null) return null;
    routes.push(route);
  }
  return routes;
}

/** The one sanitized message a refused exchange or a drifted payload surfaces. */
export function diagnosticMessageOf(error: unknown): string {
  if (error instanceof Error && error.name === 'StaleSessionResultError') {
    return 'the session moved before the response arrived';
  }
  const envelope = (error as { envelope?: { error?: { code?: string } } } | undefined)?.envelope;
  if (typeof envelope?.error?.code === 'string')
    return `inspection refused: ${envelope.error.code}`;
  return 'inspection could not be completed';
}

/**
 * The E4 content inspection under its generation-scoped key — the
 * feature's ONE content-family subscription, shared by every panel that
 * binds the payload (discovery's listing, J2's entry truth): the
 * house-checklist home for server-derived queries is the owning
 * feature's `api.ts`, and one fetch serves all consumers through it
 * (the SSE invalidation bridge refetches exactly this key).
 */
export function useContentInspection() {
  const { session } = useShell();
  return useSessionQuery(['content'], (signal) => session.inspect({ kind: 'content' }, signal));
}

/**
 * The discovery queries — both inspection families under their
 * generation-scoped keys, derived into the panel's state vocabulary.
 * Read-only: no mutation command exists on this surface.
 */
export function useContentDiscovery(): ContentDiscoveryQuery {
  const content = useContentInspection();
  const { session } = useShell();
  const routes = useSessionQuery(['routes'], (signal) =>
    session.inspect({ kind: 'routes' }, signal),
  );

  // Loading until BOTH families settled: the panel's unit is discovery
  // (listing + route truth), and a listing without its routes would
  // render unrouted markers it cannot honestly compute.
  if (content.isPending || routes.isPending) {
    return EMPTY_QUERY;
  }
  if (content.error !== null) return diagnosticQuery(diagnosticMessageOf(content.error));
  if (routes.error !== null) return diagnosticQuery(diagnosticMessageOf(routes.error));

  const discovered = bindContentInspection(content.data?.payload);
  const boundRoutes = bindRoutesInspection(routes.data?.payload);
  // A drifted interior is a compatibility event, never a heuristic parse.
  if (discovered === null) return diagnosticQuery('the content inspection payload drifted');
  if (boundRoutes === null) return diagnosticQuery('the routes inspection payload drifted');

  const listing: CollectionListingView[] = discovered.collections.map((collection) => ({
    name: collection.name,
    entryIds: collection.entryIds,
  }));
  const collectionsIndex: CollectionsIndex = Object.fromEntries(
    discovered.collections.map((collection) => [collection.name, collection.entryIds]),
  );
  // The unrouted marker fires only on POSITIVE no-route truth (core's
  // render-aware predicate over E5's payload — unknown keeps the marker off).
  const unroutedIds = new Set<string>();
  for (const collection of discovered.collections) {
    for (const entryId of collection.entryIds) {
      if (!hasCandidateRoutes(entryId, boundRoutes)) unroutedIds.add(entryId);
    }
  }

  if (discovered.collections.length === 0) {
    // No supported collection: every declared one failed a certified
    // category (unsupported), or the project declares none at all (empty).
    return {
      status: discovered.diagnostics.length > 0 ? 'unsupported' : 'empty',
      listing: [],
      unroutedIds,
      collectionsIndex,
      routes: boundRoutes,
      diagnostics: discovered.diagnostics,
      diagnosticMessage: null,
    };
  }
  return {
    status: 'ready',
    listing,
    unroutedIds,
    collectionsIndex,
    routes: boundRoutes,
    diagnostics: discovered.diagnostics,
    diagnosticMessage: null,
  };
}

const EMPTY_QUERY: ContentDiscoveryQuery = {
  status: 'loading',
  listing: [],
  unroutedIds: new Set<string>(),
  collectionsIndex: {},
  routes: null,
  diagnostics: [],
  diagnosticMessage: null,
};

/** One diagnostic-state query — the sanitized reason plus nothing derived. */
function diagnosticQuery(message: string): ContentDiscoveryQuery {
  return { ...EMPTY_QUERY, status: 'diagnostic', diagnosticMessage: message };
}

// --- The write loop's server-data slice (#253, J3) ---

/**
 * The write facts one entry carries (J3, #253): the server-issued opaque
 * grant for the entry's file at its inspected revision, plus the file's
 * raw text — the byte-exact serializer's anchor. Both arrive through the
 * SAME content-inspection payload every reader binds (the control
 * plane's write composition enriches the editor's content inspection
 * from its own discovery — ADR-0006 §6 "the server issues grants from
 * its own Content discovery"); neither is client-selected, and the raw
 * text is served truth, never a path the client may aim elsewhere.
 *
 * `grant` is bound structurally (the shared seam binder under the
 * content rules — either protocol kind, so the serializer's own
 * wrong-kind refusal stays the feature's law) and carried verbatim for
 * the echo: the server re-validates the whole table at execution (D4's
 * authorize + echo equality), so a drifted echo is a refused write,
 * never authority.
 */
export interface EntryWriteFacts {
  /** The opaque grant claim — the protocol's own `ResourceGrant` shape, echoed verbatim. */
  readonly grant: ResourceGrant;
  /** The entry file's raw text as inspected — the serializer's byte anchor. */
  readonly raw: string;
  /** The SHA-256 the grant binds (existing text); null on expected-absent creation. */
  readonly baselineSha256: string | null;
  /**
   * The entry's served projection — the same payload `data` the form
   * slice's truth binds (the reopen truth), carried here because the
   * write loop's post-commit landing gate reads it: the served
   * revision (a fresh disk read server-side) can move BEFORE the
   * content layer's projection converges (the managed dev server's
   * own watcher cadence), so "revision moved" alone is a torn truth —
   * the reopen waits until the projection itself has moved off the
   * pre-write one.
   */
  readonly servedValues: unknown;
}

/** The feature's grant-claim rules — either protocol kind (the serializer refuses a foreign one), creation included. */
const CONTENT_GRANT_RULES = { kind: null, expectedAbsent: true } as const;

/**
 * Binds one entry's write facts off the enriched content payload —
 * `null` when the entry carries no grant or raw text (an inspection the
 * write composition could not enrich: a read-only truth, never a
 * heuristic grant).
 */
export function bindEntryWriteFacts(entry: unknown): EntryWriteFacts | null {
  const record = asRecord(entry);
  if (record === null) return null;
  const grantRecord = asRecord(record.grant);
  if (grantRecord === null) return null;
  if (typeof record.raw !== 'string') return null;
  // The served projection must be PRESENT (the runtime serializes every
  // entry's `data`); its interior is a carried truth, never validated here.
  if (!('data' in record)) return null;
  const grant = bindGrantClaim(grantRecord, CONTENT_GRANT_RULES);
  if (grant === null) return null;
  return {
    grant,
    raw: record.raw,
    baselineSha256: grant.baseline.type === 'sha256' ? grant.baseline.sha256 : null,
    servedValues: record.data,
  };
}

/**
 * The active entry's write facts under the shared content inspection —
 * the write loop's one server-data source (the same generation-scoped
 * query the discovery and form slices ride; no second fetch, and the
 * SSE invalidation bridge refreshes it after every commit).
 */
export function useEntryWriteFacts(
  collection: string | null,
  entryId: string | null,
): EntryWriteFacts | null {
  const content = useContentInspection();
  if (collection === null || entryId === null || content.data === undefined) return null;
  const record = asRecord(content.data.payload);
  if (record === null || !Array.isArray(record.collections)) return null;
  const collectionRecord = record.collections.find(
    (candidate): candidate is Record<string, unknown> => asRecord(candidate)?.name === collection,
  );
  if (collectionRecord === undefined || !Array.isArray(collectionRecord.entries)) return null;
  const entry = collectionRecord.entries.find(
    (candidate): candidate is Record<string, unknown> => asRecord(candidate)?.id === entryId,
  );
  if (entry === undefined) return null;
  return bindEntryWriteFacts(entry);
}
