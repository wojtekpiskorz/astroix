import {
  COMMAND_SESSION_PRESENCE,
  type CommandKind,
  MUTATION_HEADER_NAME,
  MUTATION_HEADER_VALUE,
  type PublicError,
  type RequestEnvelope,
  type ResponseEnvelope,
  type SessionRef,
} from '@wojciechpiskorz/astroix-protocol';
import {
  type ApiResponseDraft,
  errorResponse,
  publicErrorResponse,
  successResponse,
} from '../errors/error-responses.ts';
import {
  type AdmissionAuthority,
  admitHeadersAndHost,
  checkReadTransportMarkers,
  type HeadersHostAdmission,
  malformedTargetRefusal,
} from './admission-spine.ts';
import { CLIENT_CAPABILITY_HEADER, type ClientBinding } from './client-bindings.ts';
import {
  COMMAND_ROUTES,
  type CommandRouteRule,
  classifyApiRoute,
  rolePermitted,
} from './command-routes.ts';
import {
  type EnvelopeRejection,
  responseWithinCap,
  validateRequestEnvelope,
} from './envelope-validation.ts';
import { contentTypeIsJson } from './security-headers.ts';

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

// The session-state view (and the spine authority slice behind it) live
// in the shared admission spine since #321 — re-exported here so the
// dispatch's consumers name them from its surface unchanged.
export type { AdmissionAuthority, SessionStateView } from './admission-spine.ts';

/** The authority the dispatch consults — every seam is injected; none is opened here. */
export interface ApiDispatchAuthority extends AdmissionAuthority {
  readonly resolveClientBinding: (presented: string | undefined) => ClientBinding | null;
  /** The admitted command's executor — later lanes compose the real supervisors behind it. */
  readonly executeCommand: (envelope: RequestEnvelope) => Promise<ResponseEnvelope | PublicError>;
}

/** The transport-level admission outcome: the shared spine's headers-and-host stage, or its refusal draft. */
type TransportAdmission = HeadersHostAdmission;

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

/** Stage one — everything decidable before the body: route, method, then the spine's headers/Host/capability, then the content type. */
function admitTransport(
  evidence: ApiRequestEvidence,
  authority: ApiDispatchAuthority,
): TransportAdmission {
  const route = classifyApiRoute(evidence.url);
  if (route.kind === 'rejected-target') {
    return malformedTargetRefusal(route.reason);
  }
  if (route.kind !== 'command-endpoint' || evidence.method !== 'POST') {
    // The command endpoint is the one known route and it is POST-only:
    // every other target, method, or query-carrying spelling is an
    // unknown route — there is no method vocabulary to enumerate.
    return refused({ code: 'resource-not-found', details: { notFound: { what: 'route' } } });
  }
  const headersHost = admitHeadersAndHost(evidence.rawHeaders, authority);
  if (headersHost.kind === 'refused') return headersHost;
  if (!contentTypeIsJson(headersHost.evidence.values['content-type'])) {
    return refused({ code: 'malformed-request' });
  }
  return headersHost;
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
    binding.host !== transport.host.hostClass ||
    !rolePermitted(command, transport.host.hostClass, binding.role)
  ) {
    return refused({ code: 'unauthorized' });
  }
  const sessionRejection = checkSessionFreshness(envelope, command, authority, binding);
  if (sessionRejection !== null) return sessionRejection;
  return { kind: 'admitted', envelope };
}

/**
 * The mutation/read transport laws (ADR-0006 §7): mutations carry the
 * exact marker and the exact Origin — this surface's own half, stated
 * here; reads carry the spine's reads law (`checkReadTransportMarkers`,
 * the same law the events stream admits under — same-origin Fetch
 * Metadata, no mutation marker, an Origin that agrees when present).
 */
function checkTransportMarkers(
  rule: CommandRouteRule,
  transport: Extract<TransportAdmission, { kind: 'admitted' }>,
): EnvelopeAdmission | null {
  const values = transport.evidence.values;
  if (rule.mutation) {
    const marker = values[MUTATION_HEADER_NAME.toLowerCase()];
    const origin = values.origin;
    if (marker !== MUTATION_HEADER_VALUE) return refused({ code: 'unauthorized' });
    if (
      origin === undefined ||
      origin.toLowerCase() !== transport.host.expectedOrigin.toLowerCase()
    ) {
      return refused({ code: 'unauthorized' });
    }
    return null;
  }
  return checkReadTransportMarkers(transport.evidence, transport.host.expectedOrigin);
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
