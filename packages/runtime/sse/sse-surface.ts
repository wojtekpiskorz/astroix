import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { errorResponse } from '../api/errors/error-responses.ts';
import type { ReservedHandler } from '../api/http/reserved-handler.ts';
import {
  admitSseStream,
  classifyEventsRoute,
  type SseAdmission,
  type SseAuthority,
  type SseRequestEvidence,
} from './sse-admission.ts';
import { SSE_PENDING_WRITE_TOLERANCE_BYTES, sseStreamHeaders } from './sse-frames.ts';
import { createSseHub, type SseHub, type SseStreamRecord } from './sse-hub.ts';

/**
 * The SSE surface composition (#235, F3): the reserved-namespace mount
 * that serves `GET /__astroix/events` as a long-lived event stream and
 * delegates every other reserved request to the F2 API handler — the
 * `handleReserved` hook F1's origin listener calls carries both, because
 * the hook's `(request, response, track)` shape is exactly a
 * per-request decision with a launcher-owned socket tracker: a stream
 * request registers its socket there (`track`) and then simply never
 * ends its response, so the connection survives project-lease
 * revocations (launcher-owned, F1's law) and dies with the listener —
 * while the hub's revocation scopes are what end a stream mid-life.
 *
 * This adapter is the surface's only real-IO file — it writes one
 * refusal draft or one SSE head plus frames onto a `ServerResponse` —
 * so it is watchlist-tier like the plane's other IO glue; every
 * decision lives in the pure core (`./sse-admission.ts`), the registry
 * (`./sse-hub.ts`), and the frame writer (`./sse-frames.ts`), and the
 * behavior truth is the real-socket focused lane (`test/sse/**`,
 * through the REAL origin listener on OS-assigned loopback ports).
 *
 * Backpressure is bounded per stream: a sink whose consumer is not
 * reading may buffer at most one event cap of pending bytes
 * (`SSE_PENDING_WRITE_TOLERANCE_BYTES`) before the stream is ended —
 * an honest disconnect, never an unbounded buffer.
 */

export interface EventsSurfaceOptions {
  /** The reserved handler every non-events request delegates to — the F2 API surface's handler. */
  readonly fallback: ReservedHandler;
  /** The hub that owns stream admission, delivery, and revocation. */
  readonly hub: SseHub;
}

/** The deferred-binding surface: mount first, bind the authority once the listener's port exists. */
export interface EventsApiSurface {
  readonly handler: ReservedHandler;
  setAuthority(authority: SseAuthority): void;
}

/**
 * Builds the events surface with deferred authority binding — the
 * composition point the hosts mount (the listener's port exists only
 * after `listening`, and the authority's Host/Origin evidence binds to
 * it; the same window F2's `createReservedApiSurface` serves). Before
 * binding, every request fails closed with the catch-all error — never
 * a bypass, never a guess.
 */
export function createEventsApiSurface(options: EventsSurfaceOptions): EventsApiSurface {
  let bound: SseAuthority | null = null;
  return {
    handler: (request, response, track) => {
      if (bound === null) {
        // Launcher-owned tracking still applies — the refusal exchange
        // is a real connection the listener must be able to reap.
        track(request.socket);
        writeDraft(response, errorResponse({ code: 'internal-error' }));
        return;
      }
      serve(request, response, track, options.fallback, options.hub, bound);
    },
    setAuthority: (authority) => {
      bound = authority;
    },
  };
}

/** Builds the handler with its authority bound immediately — the static case (authority already port-aware). */
export function mountEventsRoute(
  options: EventsSurfaceOptions & { readonly authority: SseAuthority },
): ReservedHandler {
  const surface = createEventsApiSurface({ fallback: options.fallback, hub: options.hub });
  surface.setAuthority(options.authority);
  return surface.handler;
}

/**
 * One reserved exchange: the events route claims GET `/__astroix/events`
 * and becomes a stream (its socket registered as launcher-owned — it
 * survives project-lease revocations and dies with the listener, F1's
 * law); everything else delegates to the fallback with the listener's
 * own tracker passed through, so the API surface registers its
 * exchanges exactly as it would mounted alone.
 */
function serve(
  request: IncomingMessage,
  response: ServerResponse,
  track: (socket: Duplex) => void,
  fallback: ReservedHandler,
  hub: SseHub,
  authority: SseAuthority,
): void {
  if (classifyEventsRoute(request.url).kind === 'other-reserved') {
    fallback(request, response, track);
    return;
  }
  try {
    track(request.socket);
    const evidence: SseRequestEvidence = {
      method: request.method ?? '',
      url: request.url,
      rawHeaders: request.rawHeaders,
    };
    const admission = admitSseStream(evidence, authority);
    if (admission.kind === 'refused') {
      writeDraft(response, admission.response);
      return;
    }
    openStream(response, hub, admission);
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

/**
 * Opens the admitted stream: hub admission (caps, supersede), the SSE
 * head, and the sink/close record — the response stays open until a
 * revocation ends it or the connection dies.
 */
function openStream(
  response: ServerResponse,
  hub: SseHub,
  admission: Extract<SseAdmission, { kind: 'admitted' }>,
): void {
  const record: SseStreamRecord = {
    role: admission.role,
    host: admission.host,
    session: admission.session,
    clientCapability: admission.clientCapability,
    sink: (text) => {
      if (response.writableEnded || response.destroyed) return;
      response.write(text);
      if (response.writableLength > SSE_PENDING_WRITE_TOLERANCE_BYTES) {
        // The consumer is not reading: bound the buffer by ending the
        // stream rather than holding an unbounded queue.
        response.end();
      }
    },
    close: () => {
      if (!response.writableEnded) response.end();
    },
  };
  const granted = hub.admit(record);
  if (granted.kind === 'refused') {
    writeDraft(response, errorResponse({ code: 'unauthorized' }));
    return;
  }
  // The head must leave immediately: Node buffers a written head until
  // the first body byte, and a stream with no frame yet would look
  // silently unopened to its client (an `EventSource` never fires
  // `onopen`). `flushHeaders` sends exactly the head, nothing more.
  response.writeHead(200, sseStreamHeaders());
  response.flushHeaders();
  response.once('close', () => {
    hub.drop(granted.id);
  });
}

/** Writes one draft: status, headers, body — the single place a refusal leaves the surface. */
function writeDraft(
  response: ServerResponse,
  draft: { status: number; headers: Record<string, string>; body: string },
): void {
  response.writeHead(draft.status, draft.headers);
  response.end(draft.body);
}

// The composition entry's own contract (the #305 re-export idiom): a
// consumer of the SSE surface names the whole public vocabulary here,
// without reaching around the exports map.
export type {
  EventsQuerySession,
  EventsRouteClaim,
  SseAdmission,
  SseAuthority,
  SseRequestEvidence,
} from './sse-admission.ts';
export {
  classifyEventsRoute,
  parseEventsQuerySession,
  SSE_ROUTE_ROLES,
  sseRolePermitted,
} from './sse-admission.ts';
export type {
  IdleEvent,
  SessionScopedEvent,
  SessionScopedEventType,
  SseFrame,
  SsePublication,
} from './sse-frames.ts';
export {
  SSE_PENDING_WRITE_TOLERANCE_BYTES,
  sseFrame,
  ssePublication,
  sseStreamHeaders,
} from './sse-frames.ts';
export type {
  SseAdmitRefusalReason,
  SseHub,
  SsePublishOutcome,
  SseStreamRecord,
} from './sse-hub.ts';
export {
  LAUNCHER_STREAM_EVENTS,
  SESSION_STREAM_EVENTS,
} from './sse-hub.ts';
export { createSseHub };
