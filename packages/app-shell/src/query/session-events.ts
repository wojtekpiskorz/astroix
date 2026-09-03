import type { SseEventEnvelope } from '@wojciechpiskorz/astroix-protocol';
import type { SseHandlers } from '../app-client.ts';
import type { SessionGate } from '../state/session-gate.ts';

/**
 * The stale-event belt over the session events stream (#241, G2;
 * ADR-0006 §3/§7: session-scoped frames carry the exact `SessionRef`).
 * A frame whose pair is not the gate's current pair — a late frame from
 * a moved-past generation, or one with no pair at all (the session
 * stream's frames always carry one; absence is fail-closed, never
 * assumed fresh) — never reaches the subscriber's dispatch. The
 * stream-level callbacks (`onOpen`, `onStale`, `onTransportError`) pass
 * through un-gated: they describe the STREAM, not a pair.
 */

/** The subscriber's dispatched callbacks — what a gated handler may invoke. */
export interface GatedEventCallbacks {
  onEvent(envelope: SseEventEnvelope): void;
  onOpen?(): void;
  onStale?(): void;
  onTransportError?(): void;
}

/** Wraps the subscriber's callbacks in the gate's pair check. */
export function gatedSseHandlers(gate: SessionGate, callbacks: GatedEventCallbacks): SseHandlers {
  return {
    onEvent: (envelope) => {
      gate.whileCurrent(envelope.session, () => callbacks.onEvent(envelope));
    },
    onOpen: () => callbacks.onOpen?.(),
    onStale: () => callbacks.onStale?.(),
    onTransportError: () => callbacks.onTransportError?.(),
  };
}
