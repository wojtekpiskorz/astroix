import {
  type InspectionRequest,
  type InspectionResult,
  type SessionRef,
  type SseEventEnvelope,
  sessionQueryKey,
} from '@wojciechpiskorz/astroix-protocol';

/**
 * The session-scoped half of the one AppClient (#240, G1; ADR-0006 §9
 * `SessionClient`, ADR-0002 amendment 4's transport tier): every renderer
 * host — the web host today, the Electron renderer later — reaches the
 * active project's inspection surface and event stream through exactly
 * this client, never through a per-host transport copy.
 *
 * The client is deliberately authority-deaf: the `SessionRef` it carries
 * is correlation and freshness data (ADR-0006 §3), never authentication —
 * the host capability rides the `HttpOnly` cookie the browser attaches,
 * and the per-document client capability rides the header the AppClient
 * injects. A stale pair surfaces as the protocol's `stale-session`
 * error, not as transport magic.
 *
 * Server-derived data through this surface is TanStack Query territory
 * (ADR-0006 §5): `queryKey()` mints the generation-scoped key pair the
 * doctrine requires — `['astroix', runtimeEpoch, generation, ...]` — so
 * the whole cache dies with the session at commit by construction. The
 * host owns the QueryClient; this client owns the keys' shape and the
 * transport underneath.
 */

/** One parsed SSE event envelope off the events stream (the protocol's frame). */
export type SessionEventCallback = (event: SseEventEnvelope) => void;

/** The transport slice a session client drives — implemented by the AppClient, never by hosts. */
export interface SessionTransport {
  /** Dispatches one session-scoped `inspect` command and settles its typed result. */
  inspect(
    ref: SessionRef,
    request: InspectionRequest,
    signal?: AbortSignal,
  ): Promise<InspectionResult>;
  /**
   * Opens the session-scoped events stream at the exact pair — the
   * reconnect gate is the transport's (`reconnects only for the current
   * session`, #240's AC): once the AppClient's notion of the current
   * session has moved on, this stream never reopens.
   */
  openSessionEvents(ref: SessionRef, handlers: SseHandlers, options?: SseOptions): SseSubscription;
}

/** Why an events subscription settled — the honest terminal vocabulary. */
export type SseCloseReason = 'ended' | 'aborted' | 'stale' | 'failed';

/** The stream callbacks a subscriber installs; `onEvent` is the only required one. */
export interface SseHandlers {
  /** Every parsed event envelope, in delivery order. */
  onEvent: SessionEventCallback;
  /**
   * The transport established an admitted stream — fires on each
   * (re)connection, before any frame is delivered; symmetric with the
   * other ungated stream-level callbacks (`onStale`, `onTransportError`):
   * it describes the STREAM, not a pair.
   */
  onOpen?: () => void;
  /** The stream was refused or ended as stale — it will not reconnect. */
  onStale?: () => void;
  /** A sanitized transport-level failure (fetch/network shape); the subscription's policy decides the tail. */
  onTransportError?: () => void;
}

/** Stream options: cancellation and the (test-injectable) reconnect delay. */
export interface SseOptions {
  /** Aborts the stream and any pending reconnect — settles `closed` as `aborted`. */
  readonly signal?: AbortSignal;
  /** The wait before a reconnect attempt; the production default is a short fixed backoff. */
  readonly reconnectDelayMs?: number;
}

/** One live events subscription — the stream's only public control surface. */
export interface SseSubscription {
  /** Settles once with the terminal reason; never rejects. */
  readonly closed: Promise<SseCloseReason>;
  /** Closes the stream and settles `closed` as `aborted`; idempotent. */
  close(): void;
}

/** The session-scoped client every renderer host consumes (ADR-0006 §9). */
export interface SessionClient {
  /** The exact pair this client carries on every request and stream (ADR-0006 §3). */
  readonly ref: SessionRef;
  /** Dispatches one typed inspection; carries the pair and aborts with `signal`. */
  inspect(request: InspectionRequest, signal?: AbortSignal): Promise<InspectionResult>;
  /**
   * Opens the session-scoped events stream. The stream closes when the
   * server revokes the pair and reconnects only while this pair is still
   * the AppClient's current session (#240's SSE law).
   */
  events(handlers: SseHandlers, options?: SseOptions): SseSubscription;
  /**
   * The generation-scoped TanStack Query key for this session —
   * `['astroix', runtimeEpoch, generation, ...scope]` (ADR-0006 §5): the
   * whole cache dies with the session at commit, by construction.
   */
  queryKey(...scope: (string | number)[]): (string | number)[];
}

/** Builds one session client over the AppClient's transport — hosts never call this directly. */
export function createSessionClient(ref: SessionRef, transport: SessionTransport): SessionClient {
  return {
    ref,
    inspect: (request, signal) => transport.inspect(ref, request, signal),
    events: (handlers, options) => transport.openSessionEvents(ref, handlers, options),
    queryKey: (...scope) => sessionQueryKey(ref, ...scope),
  };
}
