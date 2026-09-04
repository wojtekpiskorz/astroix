import { EVENTS_PATH, type SessionRef, sessionRefSchema } from '@wojciechpiskorz/astroix-protocol';
import {
  type ApiResponseDraft,
  type ErrorParts,
  errorResponse,
} from '../api/errors/error-responses.ts';
import {
  type AdmissionAuthority,
  type AdmissionHost,
  admitHeadersAndHost,
  checkReadTransportMarkers,
  claimReservedPath,
  malformedTargetRefusal,
} from '../api/http/admission-spine.ts';
import { sameSession } from '../api/http/api-dispatch.ts';
import { CLIENT_CAPABILITY_HEADER, type ClientBinding } from '../api/http/client-bindings.ts';
import type { ClientRole, VirtualHostClass } from '../api/http/command-routes.ts';
import type { CapabilityHost } from '../api/http/host-capability.ts';
import type { HeaderEvidence } from '../api/http/security-headers.ts';
import type { TargetRejectionReason } from '../origin/virtual-hosts.ts';

/**
 * The SSE admission core (#235, F3; ADR-0006 §7's SSE sentence as
 * amended by the reads-law alignment #330): the pure decision layer
 * that admits or refuses one `GET /__astroix/events` request. It sits
 * ON F2's admission spine — single-homed in `api/http/admission-spine.ts`
 * since #321 — calling the same {@link admitHeadersAndHost} stage
 * (the header-evidence entry point, the duplicate-header law, the
 * strict Host re-derivation, the timing-safe host capability) and the
 * same {@link checkReadTransportMarkers} reads law, so the two
 * surfaces' shared admission logic cannot drift. The SSE-strict deltas
 * are this module's own: the GET-only events route, the CURRENT
 * `SessionRef` required of every session-bound stream (the pair rides
 * the query string because an `EventSource` carries no body; a
 * launcher document's stream — the idle-registry consumer — must not
 * invent one), and the closed two-key query vocabulary. The transport
 * laws are the reads law verbatim (#330): same-origin Fetch Metadata
 * REQUIRED, `Origin` verified only when present — a real browser never
 * sends `Origin` on a same-origin GET, so its absence is the honest
 * same-origin shape, never a refusal.
 *
 * The admission order mirrors `api-dispatch.ts` and is load-bearing the
 * same way: everything decidable from the request line and headers —
 * route, method, duplicate security headers, Host, capability, Fetch
 * Metadata, Origin — is decided before any consult of the binding or
 * session state; then the binding and role; then the SessionRef
 * freshness pair. Every refusal is a closed, sanitized public error
 * (constant messages, no-store, never a capability byte, a port, or a
 * header value). Pure: no socket, no stream; the `ServerResponse`
 * composition behind F1's `handleReserved` hook is
 * {@link ./sse-surface.ts}, and its behavior truth is the real-socket
 * focused lane (`test/sse/**`).
 */

/** One request as the admission sees it — the reserved handler's structural slice of `IncomingMessage`. */
export interface SseRequestEvidence {
  readonly method: string;
  readonly url: string | undefined;
  readonly rawHeaders: readonly string[];
}

/**
 * The authority the admission consults — the shared admission spine's
 * authority slice plus the client-binding resolution, minus the
 * executor (a stream admits or refuses; it executes nothing). A real
 * `ApiDispatchAuthority` is a structural superset and binds here
 * unchanged.
 */
export interface SseAuthority extends AdmissionAuthority {
  readonly resolveClientBinding: (presented: string | undefined) => ClientBinding | null;
}

/**
 * The SSE events-route role matrix (ADR-0006 §3/§7, §5's read set): the
 * launcher host serves the launcher document's idle-registry stream; the
 * active project host serves the one authoritative editor and the
 * read-only diagnostics — the same permitted set `inspect` carries, the
 * SSE shape of the server-enforced one-plus-three client law.
 */
export const SSE_ROUTE_ROLES: Readonly<Record<VirtualHostClass, readonly ClientRole[]>> = {
  launcher: ['launcher'],
  project: ['editor', 'diagnostic'],
};

/** True when `role` may open an events stream on `host` — one matrix lookup, no other rule exists. */
export function sseRolePermitted(host: VirtualHostClass, role: ClientRole): boolean {
  return SSE_ROUTE_ROLES[host].includes(role);
}

/** The outcome of claiming the events route for one request target. */
export type EventsRouteClaim =
  | { readonly kind: 'events-endpoint' }
  | { readonly kind: 'other-reserved' }
  | { readonly kind: 'rejected-target'; readonly reason: TargetRejectionReason };

/**
 * Claims the events route for one raw request target — the composition's
 * "is this mine" check, decided before anything delegates to the API
 * fallback. Literal path match on the shared spine's pre-query claim
 * (no percent-decoded matching, no normalization — an encoded lookalike
 * simply is not the route), behind the same reserved-boundary ambiguity
 * re-check every reserved surface performs. A query is legal here,
 * unlike the command endpoint: the session pair's vocabulary is parsed
 * downstream.
 */
export function classifyEventsRoute(rawTarget: string | undefined): EventsRouteClaim {
  const claim = claimReservedPath(rawTarget);
  if (claim.kind === 'rejected-target') return { kind: 'rejected-target', reason: claim.reason };
  if (claim.kind === 'not-reserved') return { kind: 'other-reserved' };
  return claim.path === EVENTS_PATH ? { kind: 'events-endpoint' } : { kind: 'other-reserved' };
}

/** What the events query string said about the session pair — the only parameter vocabulary this route has. */
export type EventsQuerySession =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly session: SessionRef }
  | { readonly kind: 'malformed' };

/**
 * Parses the session pair off the events query string. `EventSource`
 * carries no body and cannot set headers, so the freshness pair rides
 * the URL (`?runtimeEpoch=<epoch>&generation=<n>`); the pair is public
 * correlation data, never authority (ADR-0006 §3), which is precisely
 * why it may sit in a URL where the capability cookies never may. The
 * vocabulary is closed: exactly these two keys, each once, both or
 * neither — any other key, duplicate, lone half, undecodable value, or
 * non-schema shape is malformed.
 */
export function parseEventsQuerySession(rawTarget: string | undefined): EventsQuerySession {
  const queryAt = (rawTarget ?? '').indexOf('?');
  if (queryAt === -1) return { kind: 'absent' };
  const query = (rawTarget ?? '').slice(queryAt + 1);
  if (query.length === 0) return { kind: 'absent' };
  const values = new Map<string, string>();
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    const name = eq === -1 ? part : part.slice(0, eq);
    const encoded = eq === -1 ? '' : part.slice(eq + 1);
    if (name !== 'runtimeEpoch' && name !== 'generation') return { kind: 'malformed' };
    if (values.has(name)) return { kind: 'malformed' };
    let value: string;
    try {
      value = decodeURIComponent(encoded);
    } catch {
      return { kind: 'malformed' };
    }
    values.set(name, value);
  }
  const epoch = values.get('runtimeEpoch');
  const generationText = values.get('generation');
  if (epoch === undefined || generationText === undefined) return { kind: 'malformed' };
  // Strict decimal for the generation — the monotonic counter is a
  // plain integer; `0x1f`, `1e2`, `1.0`, and `+1` are not its spellings.
  if (!/^\d+$/.test(generationText)) return { kind: 'malformed' };
  const parsed = sessionRefSchema.safeParse({
    runtimeEpoch: epoch,
    generation: Number.parseInt(generationText, 10),
  });
  return parsed.success ? { kind: 'present', session: parsed.data } : { kind: 'malformed' };
}

/** The admission outcome: everything the stream registry needs, or a wire-ready refusal draft. */
export type SseAdmission =
  | {
      readonly kind: 'admitted';
      readonly role: ClientRole;
      readonly host: CapabilityHost;
      readonly hostClass: VirtualHostClass;
      /** The exact pair this stream is bound at — `null` only for the session-spanning launcher role. */
      readonly session: SessionRef | null;
      /** The client capability the stream was admitted under — the binding-revocation key. */
      readonly clientCapability: string;
    }
  | { readonly kind: 'refused'; readonly response: ApiResponseDraft };

/**
 * Admits or refuses one events request — the single entry point of the
 * core. The composition calls this only after {@link
 * classifyEventsRoute} claimed the endpoint; a non-GET method and every
 * malformed target still fail closed here (the composition may not have
 * checked).
 */
export function admitSseStream(
  evidence: SseRequestEvidence,
  authority: SseAuthority,
): SseAdmission {
  const route = classifyEventsRoute(evidence.url);
  if (route.kind === 'rejected-target') {
    return malformedTargetRefusal(route.reason);
  }
  if (route.kind !== 'events-endpoint' || evidence.method !== 'GET') {
    // The events endpoint is the one route this surface owns and it is
    // GET-only: every other target or method is an unknown route —
    // there is no method vocabulary to enumerate (the command
    // endpoint's law, verbatim).
    return refused({ code: 'resource-not-found', details: { notFound: { what: 'route' } } });
  }
  const headersHost = admitHeadersAndHost(evidence.rawHeaders, authority);
  if (headersHost.kind === 'refused') return headersHost;
  const transport = checkReadTransportMarkers(
    headersHost.evidence,
    headersHost.host.expectedOrigin,
  );
  if (transport !== null) return transport;
  const query = parseEventsQuerySession(evidence.url);
  if (query.kind === 'malformed') {
    return refused({
      code: 'malformed-request',
      details: { malformed: { issue: 'invalid-shape', pointer: 'query' } },
    });
  }
  return admitBinding(headersHost.evidence, headersHost.host, query, authority);
}

/**
 * The binding, role, and SessionRef laws (ADR-0006 §3/§5/§7): the
 * presented client capability must resolve to a live document binding
 * of this host under a role the events matrix permits; a session-bound
 * stream (editor or diagnostic) must carry the exact CURRENT pair —
 * missing or stale fails `stale-session`, and a binding minted at a
 * different pair never covers the stream (a stale tab's binding never
 * upgrades, the dispatch's `checkSessionFreshness` law); the launcher
 * stream spans sessions — it must NOT claim a pair (the idle-registry
 * rule: `registry-changed` is its one event family and must not invent
 * one).
 */
function admitBinding(
  headers: HeaderEvidence,
  host: AdmissionHost,
  query: EventsQuerySession,
  authority: SseAuthority,
): SseAdmission {
  const presented = headers.values[CLIENT_CAPABILITY_HEADER];
  const binding = authority.resolveClientBinding(presented);
  if (
    presented === undefined ||
    binding === null ||
    binding.host !== host.hostClass ||
    !sseRolePermitted(host.hostClass, binding.role)
  ) {
    return refused({ code: 'unauthorized' });
  }
  if (binding.role === 'launcher') {
    if (query.kind !== 'absent') {
      // The launcher stream is the idle-registry consumer; a session
      // pair on it is contradictory evidence, malformed like a read
      // carrying the mutation marker.
      return refused({
        code: 'malformed-request',
        details: { malformed: { issue: 'invalid-shape', pointer: 'query' } },
      });
    }
    return {
      kind: 'admitted',
      role: binding.role,
      host: host.capabilityHost,
      hostClass: host.hostClass,
      session: null,
      clientCapability: presented,
    };
  }
  if (query.kind !== 'present') {
    // Absent here; malformed is unreachable (refused upstream) but
    // fails closed the same way — a session-bound stream without the
    // exact CURRENT pair is stale (the dispatch's `required` law).
    return refused({ code: 'stale-session' });
  }
  const current = authority.sessionState();
  if (current.sessionRef === null || !sameSession(query.session, current.sessionRef)) {
    return refused({ code: 'stale-session', session: query.session });
  }
  if (binding.sessionRef === null || !sameSession(binding.sessionRef, query.session)) {
    return refused({ code: 'unauthorized', session: query.session });
  }
  return {
    kind: 'admitted',
    role: binding.role,
    host: host.capabilityHost,
    hostClass: host.hostClass,
    session: query.session,
    clientCapability: presented,
  };
}

/** Uniform refusal construction — the one place a refusal draft is born. */
function refused(rejection: ErrorParts): { kind: 'refused'; response: ApiResponseDraft } {
  return { kind: 'refused', response: errorResponse(rejection) };
}
