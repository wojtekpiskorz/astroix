import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { LIMITS } from '@wojciechpiskorz/astroix-protocol';
import { errorResponse } from '../errors/error-responses.ts';
import {
  type ApiDispatchAuthority,
  type ApiRequestEvidence,
  dispatchApiRequest,
} from './api-dispatch.ts';

/**
 * The reserved-namespace composition of HTTP API v1 (#234, F2): the
 * `handleReserved` hook F1's origin listener calls for every request
 * classified into `/__astroix/` (ADR-0005 "the reserved namespace is
 * routed, never proxied"). This adapter is the only real-IO file of the
 * surface — it reads one bounded body off the socket and writes one
 * response draft back — so its behavior truth is the real-socket
 * focused lane (`test/http-api/**`, through the REAL origin listener on
 * OS-assigned loopback ports); every decision lives in the pure core
 * (`./api-dispatch.ts`) and its covered-tier peers.
 *
 * The body read is bounded by the transport pre-read cap — the largest
 * envelope byte cap the protocol defines (`editRequestBytes`, ADR-0006
 * §7) — enforced on the raw bytes BEFORE parsing, so an oversized
 * payload is refused without ever being materialized; a lying
 * `Content-Length` is caught by the same count, and a chunked body is
 * cut the moment it crosses the cap.
 */

/**
 * The pre-read transport bound: no request body larger than the
 * protocol's largest envelope cap can ever be admissible, so it is
 * refused before parsing (ADR-0006 §7; D1's note — caps are enforced by
 * the transport).
 */
export const TRANSPORT_BODY_CAP_BYTES = LIMITS.editRequestBytes;

export interface ReservedApiHandlerOptions {
  /** The full dispatch authority — port, session state, capability verification, bindings, executor. */
  readonly authority: ApiDispatchAuthority;
}

/** The `handleReserved` composition shape F1's origin listener installs (`origin-listener.ts`). */
export type ReservedHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  track: (socket: Duplex) => void,
) => void;

/**
 * The deferred binding surface: the listener acquires its port only at
 * `listening`, and the authority binds to that port (Host/Origin
 * evidence), so real compositions mount the handler FIRST and bind the
 * authority once the port exists. Before binding, every request fails
 * closed with the catch-all error — never a bypass, never a guess.
 */
export interface ReservedApiSurface {
  readonly handler: ReservedHandler;
  setAuthority(authority: ApiDispatchAuthority): void;
}

/** Builds the reserved-namespace API surface with deferred authority binding — the composition point the hosts mount. */
export function createReservedApiSurface(): ReservedApiSurface {
  let bound: ApiDispatchAuthority | null = null;
  return {
    handler: (request, response, track) => {
      // The exchange's socket is launcher-owned tracking: it survives
      // project-lease revocations and dies with the listener (F1's law).
      track(request.socket);
      if (bound === null) {
        writeDraft(response, errorResponse({ code: 'internal-error' }));
        return;
      }
      void handle(request, response, bound);
    },
    setAuthority: (authority) => {
      bound = authority;
    },
  };
}

/** Builds the handler with its authority bound immediately — the static case (authority already port-aware). */
export function createReservedApiHandler(options: ReservedApiHandlerOptions): ReservedHandler {
  const surface = createReservedApiSurface();
  surface.setAuthority(options.authority);
  return surface.handler;
}

/** One exchange: bounded body read, pure dispatch, draft write — fail-closed on any internal throw. */
async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  authority: ApiDispatchAuthority,
): Promise<void> {
  try {
    const declared = declaredLength(request);
    if (declared !== null && declared > TRANSPORT_BODY_CAP_BYTES) {
      // A lying-or-honest oversized declaration is refused unread — no
      // byte of it is ever materialized.
      respondOversized(response, request, declared);
      return;
    }
    const body = await readBoundedBody(request);
    if (body.kind === 'oversized') {
      respondOversized(response, request, body.receivedBytes);
      return;
    }
    const evidence: ApiRequestEvidence = {
      method: request.method ?? '',
      url: request.url,
      rawHeaders: request.rawHeaders,
      body: body.text,
    };
    writeDraft(response, await dispatchApiRequest(evidence, authority));
  } catch {
    // Never raw detail on an internal failure: the closed catch-all is
    // the whole answer, and a half-written exchange is severed, not continued.
    if (!response.headersSent) {
      writeDraft(response, errorResponse({ code: 'internal-error' }));
    } else {
      response.destroy();
    }
  }
}

/** The declared `Content-Length`, or null when absent or unparseable. */
function declaredLength(request: IncomingMessage): number | null {
  const declared = Number.parseInt(request.headers['content-length'] ?? '', 10);
  return Number.isNaN(declared) ? null : declared;
}

/** Answers one over-cap body: the 413 first (it must reach the client), then the upload is cut. */
function respondOversized(
  response: ServerResponse,
  request: IncomingMessage,
  receivedBytes: number,
): void {
  writeDraft(
    response,
    errorResponse({
      code: 'payload-too-large',
      details: { tooLarge: { limit: 'editRequestBytes', receivedBytes } },
    }),
  );
  // finish means the refusal left; destroy bounds a sender that would keep streaming.
  response.once('finish', () => request.destroy());
}

/** The bounded read's outcome: the body text, or the observed byte count at refusal. */
type BodyRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'oversized'; readonly receivedBytes: number };

/** Reads the request body as UTF-8 text; refuses the moment the raw bytes cross the transport cap. */
function readBoundedBody(request: IncomingMessage): Promise<BodyRead> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let refused = false;
    request.on('data', (chunk: Buffer) => {
      if (refused) return;
      received += chunk.length;
      if (received > TRANSPORT_BODY_CAP_BYTES) {
        // Stop consuming without severing the socket: the refusal must
        // still be writable. Pausing halts the flow; destroy follows the flush.
        refused = true;
        request.pause();
        resolve({ kind: 'oversized', receivedBytes: received });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () =>
      resolve({ kind: 'text', text: Buffer.concat(chunks).toString('utf8') }),
    );
    request.on('error', reject);
  });
}

/** Writes one draft: status, headers, body — the single place a response leaves the surface. */
function writeDraft(
  response: ServerResponse,
  draft: { status: number; headers: Record<string, string>; body: string },
): void {
  response.writeHead(draft.status, draft.headers);
  response.end(draft.body);
}

export {
  type ApiResponseDraft,
  apiResponseHeaders,
  buildErrorEnvelope,
  type ErrorDetails,
  type ErrorParts,
  errorResponse,
  PUBLIC_ERROR_MESSAGES,
  publicErrorResponse,
  successResponse,
  UNAVAILABLE_REQUEST_ID,
} from '../errors/error-responses.ts';
// The composition entry's own contract (the #305 re-export idiom): a
// consumer of the API surface names the whole public vocabulary here,
// without reaching around the exports map.
export type { ApiDispatchAuthority, ApiRequestEvidence, SessionStateView } from './api-dispatch.ts';
export { dispatchApiRequest, sameSession } from './api-dispatch.ts';
export {
  type ForwardedHeaders,
  stripCapabilityCookie,
  stripControlAuthority,
} from './authority-strip.ts';
export {
  type BindingRefusalReason,
  CLIENT_CAPABILITY_HEADER,
  type ClientBinding,
  type ClientBindings,
  createClientBindings,
} from './client-bindings.ts';
export {
  type ClientRole,
  COMMAND_ENDPOINT_PATHS,
  COMMAND_ROUTES,
  type CommandRouteRule,
  classifyApiRoute,
  rolePermitted,
  type VirtualHostClass,
} from './command-routes.ts';
export {
  type EnvelopeRejection,
  type EnvelopeValidation,
  requestByteCap,
  responseWithinCap,
  validateRequestEnvelope,
} from './envelope-validation.ts';
export {
  CAPABILITY_COOKIE_NAME,
  type CapabilityExtraction,
  type CapabilityHost,
  type CookieJar,
  capabilityFromCookieHeader,
  createHostCapabilityGrants,
  type HostCapabilityGrants,
  hostCapabilitySetCookie,
  mintHostCapability,
  parseCookieHeader,
} from './host-capability.ts';
export {
  contentTypeIsJson,
  duplicatedSecurityHeader,
  type HeaderEvidence,
  headerEvidence,
  SECURITY_RELEVANT_HEADERS,
} from './security-headers.ts';
