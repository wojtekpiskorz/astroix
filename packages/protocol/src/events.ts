import { z } from 'zod';
import { type SessionPresence, sessionPresenceError } from './commands';
import { inspectionKindSchema, resourceRevisionSchema } from './inspection';
import { sanitizedTextSchema } from './sanitization';
import { sessionRefSchema } from './session';
import { sessionSnapshotSchema } from './session-state';
import { protocolVersionSchema } from './version';

/**
 * SSE event frames (ADR-0006 §7: events are SSE at `/__astroix/events` —
 * the only transparent WebSocket is Vite HMR, per ADR-0009; ADR-0005
 * `subscribe()` emits revisioned invalidations and structured diagnostics;
 * lifecycle progress is the session snapshot).
 *
 * Session-scoped frames (`session-state`, `invalidation`, `diagnostic`)
 * carry the exact `SessionRef` (ADR-0006 §3); `registry-changed` is the
 * launcher-scope nudge and must not invent one (§7: the idle-registry
 * rule).
 */
export const sseEventSchema = z.discriminatedUnion('type', [
  /** Lifecycle progress: the snapshot is the source of truth, not a flat enum (ADR-0006 §4). */
  z.strictObject({ type: z.literal('session-state'), snapshot: sessionSnapshotSchema }),
  /** Revisioned invalidations of inspection families (ADR-0005). */
  z.strictObject({
    type: z.literal('invalidation'),
    families: z.array(inspectionKindSchema).min(1),
    revision: resourceRevisionSchema,
  }),
  /** Structured diagnostics: level + sanitized message; no ports, PIDs, or stacks. */
  z.strictObject({
    type: z.literal('diagnostic'),
    level: z.enum(['info', 'warn', 'error']),
    message: sanitizedTextSchema,
  }),
  /** The registry changed while idle — refetch; no summary is pushed. */
  z.strictObject({ type: z.literal('registry-changed') }),
]);

export type SseEvent = z.infer<typeof sseEventSchema>;
export type SseEventType = SseEvent['type'];

export const EVENT_SESSION_PRESENCE: Record<SseEventType, SessionPresence> = {
  'session-state': 'required',
  invalidation: 'required',
  diagnostic: 'required',
  'registry-changed': 'forbidden',
};

export const sseEventEnvelopeSchema = z
  .strictObject({
    protocolVersion: protocolVersionSchema,
    session: sessionRefSchema.optional(),
    event: sseEventSchema,
  })
  .superRefine((envelope, ctx) => {
    const error = sessionPresenceError(
      EVENT_SESSION_PRESENCE[envelope.event.type],
      envelope.session,
    );
    if (error !== null) {
      ctx.addIssue({ code: 'custom', path: ['session'], message: error });
    }
  });

export type SseEventEnvelope = z.infer<typeof sseEventEnvelopeSchema>;
