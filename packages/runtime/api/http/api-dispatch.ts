import {
  COMMAND_SESSION_PRESENCE,
  type CommandKind,
  MUTATION_HEADER_NAME,
  MUTATION_HEADER_VALUE,
  type ProjectKey,
  type PublicError,
  type RequestEnvelope,
  type ResponseEnvelope,
  type SessionRef,
} from '@wojciechpiskorz/astroix-protocol';
import {
  LAUNCHER_HOSTNAME,
  launcherOrigin,
  parseHostHeader,
  projectHostname,
  projectOrigin,
} from '../../origin/virtual-hosts.ts';
import {
  type ApiResponseDraft,
  errorResponse,
  publicErrorResponse,
  successResponse,
} from '../errors/error-responses.ts';
import { CLIENT_CAPABILITY_HEADER, type ClientBinding } from './client-bindings.ts';
import {
  COMMAND_ROUTES,
  type CommandRouteRule,
  classifyApiRoute,
  rolePermitted,
  type VirtualHostClass,
} from './command-routes.ts';
import {
  type EnvelopeRejection,
  responseWithinCap,
  validateRequestEnvelope,
} from './envelope-validation.ts';
import { type CapabilityHost, capabilityFromCookieHeader } from './host-capability.ts';
import {
  contentTypeIsJson,
  duplicatedSecurityHeader,
  type HeaderEvidence,
  headerEvidence,
} from './security-headers.ts';

/**
 * The pure dispatch core of HTTP API v1 (#234, F2; ADR-0006 §7's
 * admission paragraph, ADR-0007's mandatory controls): one request's
 * evidence plus the injected authority views in, one wire-ready
 * response draft out. No socket, no stream, no clock — the composition
 * that binds `IncomingMessage`/`ServerResponse` onto this core is
 * `./reserved-handler.ts`, and its behavior truth is the real-socket
 * focused lane (`test/http-api/**`).
 *
 * The admission order is load-bearing: everything decidable without
 * the body is decided before the body is parsed (route, method,
 * duplicate security headers, the exact Host re-derivation, the host
 * capability, the JSON content type); then the bounded envelope parse;
 * then the command-dependent authorization matrix — mutation marker and
 * exact Origin for mutations, same-origin Fetch Metadata for reads
 * (with an Origin that disagrees refused too), the document-bound
 * client role, and the SessionRef freshness pair — and only then the
 * injected executor. Every refusal is a closed, sanitized public error
 * (ADR-0006 §7): constant messages, approved detail unions, `no-store`,
 * and never a capability byte, a path, a port, or a stack.
 */

/** One request as the dispatch sees it — the reserved handler's structural slice of `IncomingMessage`. */
export interface ApiRequestEvidence {
  readonly method: string;
  readonly url: string | undefined;
  readonly rawHeaders: readonly string[];
  readonly body: string;
}

/** The session-state view the dispatch validates freshness against — injected, owned by the composition. */
export interface SessionStateView {
  readonly sessionRef: SessionRef | null;
  readonly projectKey: ProjectKey | null;
}

/** The authority the dispatch consults — every seam is injected; none is opened here. */
export interface ApiDispatchAuthority {
  readonly expectedPort: number;
  readonly sessionState: () => SessionStateView;
  readonly verifyHostCapability: (presented: string | undefined, host: CapabilityHost) => boolean;
  readonly resolveClientBinding: (presented: string | undefined) => ClientBinding | null;
  /** The admitted command's executor — later lanes compose the real supervisors behind it. */
  readonly executeCommand: (envelope: RequestEnvelope) => Promise<ResponseEnvelope | PublicError>;
}

/** The transport-level admission outcome: the resolved host context, or a refusal draft. */
type TransportAdmission =
  | {
      readonly kind: 'admitted';
      readonly hostClass: VirtualHostClass;
      readonly capabilityHost: CapabilityHost;
      readonly expectedOrigin: string;
      readonly evidence: HeaderEvidence;
    }
  | { readonly kind: 'refused'; readonly response: ApiResponseDraft };

/** The envelope-level admission outcome: the parsed, fully authorized envelope, or a refusal draft. */
type EnvelopeAdmission =
  | { readonly kind: 'admitted'; readonly envelope: RequestEnvelope }
  | { readonly kind: 'refused'; readonly response: ApiResponseDraft };

/** Dispatches one request — the single entry point of the core. */
export async function dispatchApiRequest(
  evidence: ApiRequestEvidence,
  authority: ApiDispatchAuthority,
): Promise<ApiResponseDraft> {
  const transport = admitTransport(evidence, authority);
  if (transport.kind === 'refused') return transport.response;
  const envelope = await admitEnvelope(evidence.body, transport, authority);
  if (envelope.kind === 'refused') return envelope.response;
  return execute(envelope.envelope, authority);
}

/** Stage one — everything decidable before the body: route, method, header duplicates, Host, capability, content type. */
function admitTransport(
  evidence: ApiRequestEvidence,
  authority: ApiDispatchAuthority,
): TransportAdmission {
  const route = classifyApiRoute(evidence.url);
  if (route.kind === 'rejected-target') {
    return refused({
      code: 'malformed-request',
      details: {
        malformed:
          route.reason === 'ambiguous-reserved-encoding'
            ? { issue: 'ambiguous-encoding' }
            : { issue: 'invalid-shape' },
      },
    });
  }
  if (route.kind !== 'command-endpoint' || evidence.method !== 'POST') {
    // The command endpoint is the one known route and it is POST-only:
    // every other target, method, or query-carrying spelling is an
    // unknown route — there is no method vocabulary to enumerate.
    return refused({ code: 'resource-not-found', details: { notFound: { what: 'route' } } });
  }
  const headers = headerEvidence(evidence.rawHeaders);
  const duplicated = duplicatedSecurityHeader(headers);
  if (duplicated !== null) {
    // The duplicated NAME is the finding; the values never enter the response.
    return refused({ code: 'malformed-request' });
  }
  const host = resolveHostClass(headers, authority);
  if (host === null) {
    return refused({ code: 'resource-not-found', details: { notFound: { what: 'route' } } });
  }
  const capability = capabilityFromCookieHeader(headers.values.cookie);
  if (
    capability.kind !== 'present' ||
    !authority.verifyHostCapability(capability.value, host.capabilityHost)
  ) {
    return refused({ code: 'unauthorized' });
  }
  if (!contentTypeIsJson(headers.values['content-type'])) {
    return refused({ code: 'malformed-request' });
  }
  return { kind: 'admitted', ...host, evidence: headers };
}

/**
 * Re-derives the host class from the header evidence — defense in depth
 * behind the listener's own routing. The evidence is the SAME
 * `headerEvidence` view every other header decision reads (the single
 * entry point for header values the dispatch trusts): `values.host` is
 * the last pair's value and `counts.host` the pair count, exactly the
 * semantics the Host parse demands.
 */
function resolveHostClass(
  headers: HeaderEvidence,
  authority: ApiDispatchAuthority,
): { hostClass: VirtualHostClass; capabilityHost: CapabilityHost; expectedOrigin: string } | null {
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

/** Stage two — the bounded envelope parse plus the command-dependent authorization matrix. */
async function admitEnvelope(
  body: string,
  transport: Extract<TransportAdmission, { kind: 'admitted' }>,
  authority: ApiDispatchAuthority,
): Promise<EnvelopeAdmission> {
  const validation = validateRequestEnvelope(body);
  if (validation.kind === 'rejected') {
    return refused({
      code: validation.rejection.code,
      details: validation.rejection.details,
      requestId: validation.rejection.requestId,
      session: validation.rejection.session,
    });
  }
  const envelope = validation.envelope;
  const command = envelope.command.kind;
  const rule = COMMAND_ROUTES[command];
  const markerRejection = checkTransportMarkers(rule, transport);
  if (markerRejection !== null) return markerRejection;
  const binding = authority.resolveClientBinding(
    transport.evidence.values[CLIENT_CAPABILITY_HEADER],
  );
  if (
    binding === null ||
    binding.host !== transport.hostClass ||
    !rolePermitted(command, transport.hostClass, binding.role)
  ) {
    return refused({ code: 'unauthorized' });
  }
  const sessionRejection = checkSessionFreshness(envelope, command, authority, binding);
  if (sessionRejection !== null) return sessionRejection;
  return { kind: 'admitted', envelope };
}

/**
 * The mutation/read transport laws (ADR-0006 §7): mutations carry the
 * exact marker and the exact Origin; reads carry same-origin Fetch
 * Metadata — and a read's Origin, when present, must agree (a same-origin
 * browser request always sends the matching value; a disagreement is
 * forged evidence). A read carrying the mutation marker is
 * contradictory transport evidence and malformed.
 */
function checkTransportMarkers(
  rule: CommandRouteRule,
  transport: Extract<TransportAdmission, { kind: 'admitted' }>,
): EnvelopeAdmission | null {
  const values = transport.evidence.values;
  const marker = values[MUTATION_HEADER_NAME.toLowerCase()];
  const origin = values.origin;
  if (rule.mutation) {
    if (marker !== MUTATION_HEADER_VALUE) return refused({ code: 'unauthorized' });
    if (origin === undefined || origin.toLowerCase() !== transport.expectedOrigin.toLowerCase()) {
      return refused({ code: 'unauthorized' });
    }
    return null;
  }
  if (marker !== undefined) return refused({ code: 'malformed-request' });
  if (values['sec-fetch-site'] !== 'same-origin') return refused({ code: 'unauthorized' });
  if (origin !== undefined && origin.toLowerCase() !== transport.expectedOrigin.toLowerCase()) {
    return refused({ code: 'unauthorized' });
  }
  return null;
}

/**
 * SessionRef freshness (ADR-0006 §3/§5): a session-scoped command must
 * carry the exact current pair or fail stale; an `activate` that claims
 * a pair must claim the current one; and a session-bound document
 * (editor or diagnostic) must be bound at the very pair the envelope
 * carries — a stale tab's binding never covers new-generation traffic,
 * even if the table's rotation were ever late.
 */
function checkSessionFreshness(
  envelope: RequestEnvelope,
  command: CommandKind,
  authority: ApiDispatchAuthority,
  binding: ClientBinding,
): EnvelopeAdmission | null {
  const presence = COMMAND_SESSION_PRESENCE[command];
  if (presence === 'forbidden') return null;
  const current = authority.sessionState();
  if (envelope.session !== undefined) {
    if (current.sessionRef === null || !sameSession(envelope.session, current.sessionRef)) {
      return refused({ code: 'stale-session', session: envelope.session });
    }
    if (binding.sessionRef !== null && !sameSession(binding.sessionRef, envelope.session)) {
      return refused({ code: 'unauthorized', session: envelope.session });
    }
  } else if (presence === 'required') {
    return refused({ code: 'stale-session' });
  }
  return null;
}

/** Field-wise pair equality — `runtimeEpoch` and `generation` exact. */
export function sameSession(a: SessionRef, b: SessionRef): boolean {
  return a.runtimeEpoch === b.runtimeEpoch && a.generation === b.generation;
}

/** Stage three — the executor seam: its public errors pass through, its throws never leak, its responses are capped. */
async function execute(
  envelope: RequestEnvelope,
  authority: ApiDispatchAuthority,
): Promise<ApiResponseDraft> {
  const session = echoSession(envelope);
  let outcome: ResponseEnvelope | PublicError;
  try {
    outcome = await authority.executeCommand(envelope);
  } catch {
    // The throw's text is never public — the catch-all code is all that answers.
    return errorResponse({ code: 'internal-error', requestId: envelope.requestId, session });
  }
  if (isPublicError(outcome)) {
    return publicErrorResponse(outcome, envelope.requestId, session);
  }
  const body = JSON.stringify(outcome);
  if (!responseWithinCap(body)) {
    return errorResponse({ code: 'internal-error', requestId: envelope.requestId, session });
  }
  return successResponse(body);
}

/** The executor outcome's discriminator — `in` cannot narrow these unions; the error member's `code` is the test. */
function isPublicError(value: ResponseEnvelope | PublicError): value is PublicError {
  return (value as { code?: unknown }).code !== undefined;
}

/** The pair an error echoes — session-scoped traffic carries it (ADR-0006 §7), idle traffic invents none. */
function echoSession(envelope: RequestEnvelope): SessionRef | undefined {
  return COMMAND_SESSION_PRESENCE[envelope.command.kind] === 'forbidden'
    ? undefined
    : envelope.session;
}

/** Uniform refusal construction — the one place a refusal draft is born. */
function refused(rejection: EnvelopeRejection & { requestId?: string; session?: SessionRef }): {
  kind: 'refused';
  response: ApiResponseDraft;
} {
  return { kind: 'refused', response: errorResponse(rejection) };
}
