import type { SessionGate } from '../state/session-gate.ts';

/**
 * The stale-response belt over a session fetch (#241, G2; ADR-0006 §5):
 * a fetch that resolves after its session moved past — the reset closed
 * the gate, or a later generation was bound — never delivers its value
 * anywhere, not even into the dead key's cache entry. The AppClient
 * disciplines its own engine (its session currency); this is the state
 * layer's second belt, applied where query results enter the shell.
 */

/** The deterministic rejection a gated fetch settles with when its session moved under it. */
export class StaleSessionResultError extends Error {
  constructor() {
    super('the session moved before the response arrived');
    this.name = 'StaleSessionResultError';
  }
}

/** One session fetch under the gate — the queryFn wrapper the shell's session hooks use. */
export function gatedSessionFetch<T>(
  gate: SessionGate,
  fetch: (signal?: AbortSignal) => Promise<T>,
): (signal?: AbortSignal) => Promise<T> {
  return async (signal?: AbortSignal): Promise<T> => {
    if (!gate.isCurrent()) throw new StaleSessionResultError();
    const result = await fetch(signal);
    if (!gate.isCurrent()) throw new StaleSessionResultError();
    return result;
  };
}
