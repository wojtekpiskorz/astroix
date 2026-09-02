import {
  byteLength,
  CACHE_CONTROL_NO_STORE,
  ERROR_HTTP_STATUS,
  type ErrorEnvelope,
  errorEnvelopeSchema,
  type GrantRejectedDetails,
  type MalformedRequestDetails,
  type PayloadTooLargeDetails,
  type PublicError,
  type PublicErrorCode,
  publicErrorSchema,
  type ResourceNotFoundDetails,
  type RevisionConflictDetails,
  type SessionRef,
  type UnsupportedProtocolVersionDetails,
} from '@wojciechpiskorz/astroix-protocol';
import { ASTROIX_GENERATED_HEADER } from '../../origin/virtual-hosts.ts';

/**
 * Sanitized public-error responses for the HTTP control surface (#234,
 * F2; ADR-0006 §7 "Errors use a stable envelope", ADR-0007 "Limits and
 * output hygiene"): one closed, constant message per public error code —
 * never a received value, never an implementation detail, never a
 * capability byte — wrapped in the protocol's error envelope and
 * answered with the code's HTTP status, `Cache-Control: no-store`, and
 * the generated marker. The message table is the whole free-text
 * surface; the per-code detail payloads are the protocol's closed
 * unions, and this module never invents a field.
 *
 * Pure construction only — no socket, no stream; the composition that
 * writes these drafts onto a `ServerResponse` lives in
 * `../http/reserved-handler.ts`, and the dispatch decisions that choose
 * the codes live in `../http/api-dispatch.ts`.
 */

/**
 * The one message each public error code answers with — constant per
 * code, disclosure-clean by construction (verified over the whole table
 * in the focused lane's hygiene legs). Nothing request-derived ever
 * enters a public message.
 */
export const PUBLIC_ERROR_MESSAGES: Readonly<Record<PublicErrorCode, string>> = {
  'malformed-request': 'the request is not a well-formed protocol v1 request',
  'unsupported-protocol-version': 'the request carries an unsupported protocol version',
  'payload-too-large': 'the request payload exceeds its protocol limit',
  unauthorized: 'the request does not carry the authority this resource requires',
  'resource-not-found': 'the requested resource does not exist',
  'misdirected-request': 'the host no longer serves the referenced session',
  'stale-session': 'the request carries a session that is not the current one',
  'concurrent-activation': 'another activation attempt is already in flight',
  'grant-rejected': 'the edit grant was rejected without writing',
  'revision-conflict': 'the resource changed since the revision the request carried',
  'internal-error': 'the request could not be completed',
};

/** The approved per-code detail payloads — the closed protocol unions, nothing else. */
export interface ErrorDetails {
  readonly malformed?: MalformedRequestDetails;
  readonly unsupportedVersion?: UnsupportedProtocolVersionDetails;
  readonly tooLarge?: PayloadTooLargeDetails;
  readonly notFound?: ResourceNotFoundDetails;
  readonly grantRejected?: GrantRejectedDetails;
  readonly revision?: RevisionConflictDetails;
}

/** One error response under construction — parts in, envelope + HTTP draft out. */
export interface ErrorParts {
  readonly code: PublicErrorCode;
  /** The requester's correlation id when it was safely echoable, else the placeholder. */
  readonly requestId?: string;
  /** The pair when the failing traffic was session-scoped (ADR-0006 §7). */
  readonly session?: SessionRef;
  readonly retryable?: boolean;
  readonly details?: ErrorDetails;
}

/**
 * The HTTP shape every API response carries: JSON content, no-store (a
 * stale cache must never outlive a session), and the marker that says
 * Astroix synthesized this response — never present on a proxied
 * upstream response. No CORS header exists on this surface by law
 * (ADR-0006 §7 "No CORS grant").
 */
export function apiResponseHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'cache-control': CACHE_CONTROL_NO_STORE,
    [ASTROIX_GENERATED_HEADER]: '1',
  };
}

/** The correlation id malformed traffic gets — no request-derived text is ever echoed unvalidated. */
export const UNAVAILABLE_REQUEST_ID = 'unavailable';

/** The approved detail payloads' union — exactly the protocol's per-code detail schemas. */
export type PublicErrorDetails =
  | MalformedRequestDetails
  | UnsupportedProtocolVersionDetails
  | PayloadTooLargeDetails
  | ResourceNotFoundDetails
  | GrantRejectedDetails
  | RevisionConflictDetails;

/** The one detail payload `parts` carries, or none — a discriminated `details` is single-valued by shape. */
function pickDetails(details: ErrorDetails | undefined): PublicErrorDetails | undefined {
  if (details === undefined) return undefined;
  const candidates: readonly (PublicErrorDetails | undefined)[] = [
    details.malformed,
    details.unsupportedVersion,
    details.tooLarge,
    details.notFound,
    details.grantRejected,
    details.revision,
  ];
  return candidates.find((candidate) => candidate !== undefined);
}

/** Builds the closed error envelope from sanitized parts — the single error construction point. */
export function buildErrorEnvelope(parts: ErrorParts): ErrorEnvelope {
  const details = pickDetails(parts.details);
  // Constructed THROUGH the protocol's closed unions: a code/detail
  // pairing outside the approved set cannot become an envelope at all —
  // closure is enforced at construction, not hoped for at the wire.
  return errorEnvelopeSchema.parse({
    protocolVersion: 1,
    requestId: parts.requestId ?? UNAVAILABLE_REQUEST_ID,
    ...(parts.session !== undefined ? { session: parts.session } : {}),
    error: publicErrorSchema.parse({
      code: parts.code,
      message: PUBLIC_ERROR_MESSAGES[parts.code],
      retryable: parts.retryable ?? false,
      ...(details !== undefined ? { details } : {}),
    }),
  });
}

/** The wire draft of one API response — status, headers, and the serialized envelope body. */
export interface ApiResponseDraft {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Drafts one sanitized public-error response: the code's status, the API header set, the envelope body. */
export function errorResponse(parts: ErrorParts): ApiResponseDraft {
  const envelope = buildErrorEnvelope(parts);
  return withBody(ERROR_HTTP_STATUS[parts.code], JSON.stringify(envelope));
}

/**
 * Drafts the response for one executor-returned public error (ADR-0006
 * §7): the error object is already a member of the protocol's closed
 * union — it answers as itself, echoed under the request's correlation
 * id and session.
 */
export function publicErrorResponse(
  error: PublicError,
  requestId: string,
  session?: SessionRef,
): ApiResponseDraft {
  const envelope: ErrorEnvelope = {
    protocolVersion: 1,
    requestId,
    ...(session !== undefined ? { session } : {}),
    error,
  };
  return withBody(ERROR_HTTP_STATUS[error.code], JSON.stringify(envelope));
}

/** Drafts one success response: 200, the API header set, the serialized response envelope. */
export function successResponse(envelopeBody: string): ApiResponseDraft {
  return withBody(200, envelopeBody);
}

/** Assembles one materialized draft — explicit UTF-8 content length, never chunked framing. */
function withBody(status: number, body: string): ApiResponseDraft {
  return {
    status,
    headers: { ...apiResponseHeaders(), 'content-length': String(byteLength(body)) },
    body,
  };
}
