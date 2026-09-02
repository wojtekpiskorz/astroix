import {
  byteLength,
  LIMITS,
  type SessionRef,
  type SseEvent,
  type SseEventEnvelope,
  type SseEventType,
  sseEventEnvelopeSchema,
  withinByteLimit,
} from '@wojciechpiskorz/astroix-protocol';
import { ASTROIX_GENERATED_HEADER } from '../origin/virtual-hosts.ts';

/**
 * SSE wire frames and the event-cap enforcement (#235, F3; ADR-0006 §7
 * "Events are SSE at `/__astroix/events`", "256 KiB per SSE event";
 * ADR-0009 "server-to-renderer events are same-origin SSE"). Pure
 * serialization only — no socket, no stream state; the stream registry
 * that moves these frames onto admitted connections is
 * {@link ./sse-hub.ts} and the `ServerResponse` composition is
 * {@link ./sse-surface.ts}.
 *
 * Every frame is one `data:` line carrying the protocol's own SSE event
 * envelope, constructed THROUGH `sseEventEnvelopeSchema` (the
 * `buildErrorEnvelope` idiom: closure is enforced at construction, not
 * hoped for at the wire), so a session-scoped event without its exact
 * `SessionRef` — or an idle `registry-changed` that invented one —
 * cannot become a frame at all. The envelope's JSON is compact by
 * construction (no newlines), which is what makes the single `data:`
 * line a legal SSE frame; the cap is counted in UTF-8 bytes over the
 * serialized envelope (the protocol's `envelopeBytes` unit, ADR-0006 §7)
 * and an over-cap event is refused — it never reaches any wire.
 */

/** The three session-scoped frame types — the ones that carry the exact pair (ADR-0006 §3). */
export type SessionScopedEventType = Extract<
  SseEventType,
  'session-state' | 'invalidation' | 'diagnostic'
>;

/** The event types whose frames are session-scoped — derived from the protocol's own presence table. */
export function isSessionScopedEventType(type: SseEventType): type is SessionScopedEventType {
  return type !== 'registry-changed';
}

/** A session-scoped event type's frames carry the exact pair (ADR-0006 §3); `null` means the idle frame. */
export type SessionScopedEvent = Extract<SseEvent, { readonly type: SessionScopedEventType }>;

/** The one idle frame type — the launcher-scope registry nudge (ADR-0006 §7 idle-registry rule). */
export type IdleEvent = Extract<SseEvent, { readonly type: 'registry-changed' }>;

/**
 * One publication offered to the streams: a session-scoped event under
 * the exact pair it was minted at, or the idle registry nudge. The scope
 * and the event type must agree — {@link ssePublication} is the only
 * constructor that can produce a consistent value.
 */
export type SsePublication =
  | { readonly scope: 'session'; readonly session: SessionRef; readonly event: SessionScopedEvent }
  | { readonly scope: 'idle'; readonly event: IdleEvent };

/**
 * Constructs one publication, or null when the input contradicts the
 * protocol's session-presence table: a session-scoped event needs its
 * pair, `registry-changed` must not invent one (EVENT_SESSION_PRESENCE,
 * ADR-0006 §3/§7). Null is a caller defect, never a wire answer.
 */
export function ssePublication(input: {
  readonly session?: SessionRef;
  readonly event: SseEvent;
}): SsePublication | null {
  const { event } = input;
  if (
    event.type === 'session-state' ||
    event.type === 'invalidation' ||
    event.type === 'diagnostic'
  ) {
    if (input.session === undefined) return null;
    return { scope: 'session', session: input.session, event };
  }
  if (input.session !== undefined) return null;
  return { scope: 'idle', event };
}

/** One serialized frame — or the honest refusal when the event breaches its cap. */
export type SseFrame =
  | { readonly kind: 'frame'; readonly text: string; readonly bytes: number }
  | { readonly kind: 'oversized'; readonly bytes: number };

/**
 * Serializes one publication into its SSE wire frame, enforcing the
 * 256 KiB per-event cap (ADR-0006 §7) over the serialized envelope: an
 * over-cap event answers `oversized` and the caller never writes it.
 * `data:`-only framing — the envelope's `event.type` is the
 * discriminator, so a consumer's default `onmessage` handler sees every
 * frame without per-type `addEventListener` registration.
 */
export function sseFrame(publication: SsePublication): SseFrame {
  const envelope: SseEventEnvelope = sseEventEnvelopeSchema.parse({
    protocolVersion: 1,
    ...(publication.scope === 'session' ? { session: publication.session } : {}),
    event: publication.event,
  });
  const json = JSON.stringify(envelope);
  const bytes = byteLength(json);
  if (!withinByteLimit(json, 'sseEventBytes')) return { kind: 'oversized', bytes };
  return { kind: 'frame', text: `data: ${json}\n\n`, bytes };
}

/**
 * The response head an admitted SSE stream answers with: the event
 * stream media type, no-store (a stale cache must never outlive a
 * session), and the generated marker. No CORS header exists on this
 * surface by law (ADR-0006 §7 "No CORS grant") and there is no
 * `Content-Length` — the body is the open frame stream itself.
 */
export function sseStreamHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    [ASTROIX_GENERATED_HEADER]: '1',
  };
}

/**
 * The per-stream pending-write tolerance: a stream whose consumer is not
 * reading may buffer at most one event cap of unwritten bytes before the
 * composition ends it — a bounded, honest disconnect, never an unbounded
 * buffer (ADR-0007 "Limits and output hygiene").
 */
export const SSE_PENDING_WRITE_TOLERANCE_BYTES = LIMITS.sseEventBytes;
