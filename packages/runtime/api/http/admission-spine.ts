import {
  MUTATION_HEADER_NAME,
  type ProjectKey,
  type SessionRef,
} from '@wojciechpiskorz/astroix-protocol';
import {
  classifyRequestTarget,
  LAUNCHER_HOSTNAME,
  launcherOrigin,
  parseHostHeader,
  projectHostname,
  projectOrigin,
  type TargetRejectionReason,
} from '../../origin/virtual-hosts.ts';
import {
  type ApiResponseDraft,
  type ErrorParts,
  errorResponse,
} from '../errors/error-responses.ts';
import type { VirtualHostClass } from './command-routes.ts';
import { type CapabilityHost, capabilityFromCookieHeader } from './host-capability.ts';
import {
  duplicatedSecurityHeader,
  type HeaderEvidence,
  headerEvidence,
} from './security-headers.ts';

/**
 * The shared HTTP admission spine (#321; extracted from F2's dispatch
 * core #234, which F3's SSE admission #235 re-implemented behind the
 * after-F2 read-only fence on `api/http/**`): the admission stages
 * every reserved-namespace surface — the command endpoint and the
 * events stream alike — decides identically, stated once here so the
 * surfaces cannot drift: the reserved-route claim head (the listener's
 * target classification re-run as defense in depth, plus the literal
 * pre-query path slice), the rejected-target refusal mapping, the
 * header-evidence + duplicate-header + strict-Host re-derivation +
 * host-capability admission, and the reads transport law (same-origin
 * Fetch Metadata, no mutation marker, an Origin that must agree when
 * present). The mutation transport law (exact marker AND exact Origin)
 * is the command surface's own and stays in `api-dispatch.ts`; the
 * SSE-strict deltas (the GET-only events route, the query-string
 * SessionRef pair with its closed two-key vocabulary) are the events
 * surface's own and stay in `sse/`. Refusal vocabularies are exactly
 * the ones the focused lanes landed — this module unifies, it never
 * re-litigates them.
 *
 * Pure: no socket, no stream, no clock. The admission order over these
 * stages is load-bearing the same way in both consumers — everything
 * decidable from the request line and headers before any consult of
 * the binding or session state.
 */

/** The session-state view every admission consults freshness and host against — injected, owned by the composition. */
export interface SessionStateView {
  readonly sessionRef: SessionRef | null;
  readonly projectKey: ProjectKey | null;
}

/** The authority slice the spine consults — the shared subset of each surface's full authority. */
export interface AdmissionAuthority {
  readonly expectedPort: number;
  readonly sessionState: () => SessionStateView;
  readonly verifyHostCapability: (presented: string | undefined, host: CapabilityHost) => boolean;
}

/** One admission-stage refusal — the wire-ready draft both surfaces answer with. */
export interface AdmissionRefusal {
  readonly kind: 'refused';
  readonly response: ApiResponseDraft;
}

/** The outcome of claiming one raw request target against the reserved namespace. */
export type ReservedPathClaim =
  | { readonly kind: 'rejected-target'; readonly reason: TargetRejectionReason }
  | { readonly kind: 'not-reserved' }
  | { readonly kind: 'reserved-path'; readonly path: string; readonly hasQuery: boolean };

/**
 * Claims the reserved namespace for one raw request target — the shared
 * head of every route classification: the listener's own target
 * classification re-run as defense in depth (absolute-form and
 * ambiguous encodings rejected here), then the literal pre-query path
 * slice. Literal on the raw bytes: no percent-decoding, no backslash
 * or dot normalization — an encoded lookalike simply is not the route
 * (fail closed, never interpretively matched). Whether a query is
 * legal on the claimed path is the caller's route law: the command
 * endpoint refuses one (the envelope is the whole request), the events
 * endpoint requires its vocabulary.
 */
export function claimReservedPath(rawTarget: string | undefined): ReservedPathClaim {
  const target = classifyRequestTarget(rawTarget);
  if (target.kind === 'rejected') return { kind: 'rejected-target', reason: target.reason };
  if (target.kind !== 'reserved') return { kind: 'not-reserved' };
  const queryAt = (rawTarget ?? '').indexOf('?');
  const path = queryAt === -1 ? (rawTarget ?? '') : (rawTarget ?? '').slice(0, queryAt);
  const hasQuery = queryAt !== -1 && (rawTarget ?? '').slice(queryAt + 1).length > 0;
  return { kind: 'reserved-path', path, hasQuery };
}

/** The host context every later admission stage reads — re-derived, never trusted from the routing. */
export interface AdmissionHost {
  readonly hostClass: VirtualHostClass;
  readonly capabilityHost: CapabilityHost;
  readonly expectedOrigin: string;
}

/**
 * Re-derives the host class from the header evidence — defense in depth
 * behind the listener's own routing. The evidence is the SAME
 * `headerEvidence` view every other header decision reads (the single
 * entry point for header values the surfaces trust): `values.host` is
 * the last pair's value and `counts.host` the pair count, exactly the
 * semantics the Host parse demands. The launcher hostname or the one
 * exact active project-key hostname — anything else admits nothing.
 */
export function resolveAdmissionHost(
  headers: HeaderEvidence,
  authority: AdmissionAuthority,
): AdmissionHost | null {
  const parsed = parseHostHeader({
    value: headers.values.host,
    count: headers.counts.host ?? 0,
    expectedPort: authority.expectedPort,
  });
  if (parsed.kind === 'rejected') return null;
  if (parsed.hostname === LAUNCHER_HOSTNAME) {
    return {
      hostClass: 'launcher',
      capabilityHost: { host: 'launcher' },
      expectedOrigin: launcherOrigin(authority.expectedPort),
    };
  }
  const { projectKey } = authority.sessionState();
  if (projectKey !== null && parsed.hostname === projectHostname(projectKey)) {
    return {
      hostClass: 'project',
      capabilityHost: { host: 'project', projectKey },
      expectedOrigin: projectOrigin(projectKey, authority.expectedPort),
    };
  }
  return null;
}

/** The header-level admission outcome: the admitted host context plus the evidence, or a refusal draft. */
export type HeadersHostAdmission =
  | { readonly kind: 'admitted'; readonly host: AdmissionHost; readonly evidence: HeaderEvidence }
  | AdmissionRefusal;

/**
 * The header-and-host admission stage both surfaces run identically,
 * in the same order: the header evidence and its duplicate-security
 * header law (a duplicated NAME is the finding; the values never enter
 * the response), the strict Host re-derivation, and the host
 * capability (the cookie-presented grant verified against the derived
 * host). Everything decidable here is decided before any surface
 * consults its own transport laws, the binding, or the session state.
 */
export function admitHeadersAndHost(
  rawHeaders: readonly string[],
  authority: AdmissionAuthority,
): HeadersHostAdmission {
  const headers = headerEvidence(rawHeaders);
  const duplicated = duplicatedSecurityHeader(headers);
  if (duplicated !== null) {
    // The duplicated NAME is the finding; the values never enter the response.
    return refusal({ code: 'malformed-request' });
  }
  const host = resolveAdmissionHost(headers, authority);
  if (host === null) {
    return refusal({ code: 'resource-not-found', details: { notFound: { what: 'route' } } });
  }
  const capability = capabilityFromCookieHeader(headers.values.cookie);
  if (
    capability.kind !== 'present' ||
    !authority.verifyHostCapability(capability.value, host.capabilityHost)
  ) {
    return refusal({ code: 'unauthorized' });
  }
  return { kind: 'admitted', host, evidence: headers };
}

/**
 * The reads transport law (ADR-0006 §7, the reads-law alignment #330):
 * browser read traffic carries same-origin Fetch Metadata — and a
 * mutation marker is contradictory evidence, malformed. The request's
 * `Origin`, when present, must agree (a same-origin browser request
 * always sends the matching value; a disagreement is forged evidence);
 * its ABSENCE is no refusal, because a real browser never sends
 * `Origin` on a same-origin GET (`Origin` is a forbidden header for
 * fetch and `EventSource` alike).
 */
export function checkReadTransportMarkers(
  evidence: HeaderEvidence,
  expectedOrigin: string,
): AdmissionRefusal | null {
  if (evidence.values[MUTATION_HEADER_NAME.toLowerCase()] !== undefined) {
    return refusal({ code: 'malformed-request' });
  }
  if (evidence.values['sec-fetch-site'] !== 'same-origin') return refusal({ code: 'unauthorized' });
  const origin = evidence.values.origin;
  if (origin !== undefined && origin.toLowerCase() !== expectedOrigin.toLowerCase()) {
    return refusal({ code: 'unauthorized' });
  }
  return null;
}

/** The rejected-target refusal — the shared malformed mapping for both ambiguous and invalid shapes. */
export function malformedTargetRefusal(reason: TargetRejectionReason): AdmissionRefusal {
  return refusal({
    code: 'malformed-request',
    details: {
      malformed:
        reason === 'ambiguous-reserved-encoding'
          ? { issue: 'ambiguous-encoding' }
          : { issue: 'invalid-shape' },
    },
  });
}

/** Uniform refusal construction — the one place this module's refusal drafts are born. */
function refusal(rejection: ErrorParts): AdmissionRefusal {
  return { kind: 'refused', response: errorResponse(rejection) };
}
