import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';

/**
 * The session pair's client-side currency gate (#241, G2; ADR-0006 §3:
 * the `SessionRef` pair is "correlation and freshness data"). Every
 * session-scoped write into shell state — a query result landing, an SSE
 * event dispatching, a store setter firing — passes a gate check, so a
 * response or frame carrying a pair the shell has moved past can never
 * repopulate current-generation state (the AC's second belt; the
 * AppClient disciplines its own engine, this disciplines the state
 * layer).
 *
 * A gate is minted at one pair, may be explicitly `move`d (the reset
 * moves it to `null` — closed — before navigation), and answers pair
 * questions only. It never authenticates: authority is server-side
 * capability, never a client-side notion.
 */

/** Field-wise pair equality — currency is value equality, never identity. */
export function sameSessionPair(a: SessionRef | null | undefined, b: SessionRef | null): boolean {
  if (a === null || a === undefined || b === null) return false;
  return a.runtimeEpoch === b.runtimeEpoch && a.generation === b.generation;
}

/** The pair-currency gate every session-scoped state write passes. */
export interface SessionGate {
  /** The pair the gate was minted at (its identity, not its liveness). */
  readonly ref: SessionRef;
  /**
   * With a candidate: field-wise equality against the gate's current
   * notion. Without: whether the gate is still open at all (no reset
   * has closed it).
   */
  isCurrent(candidate?: SessionRef | null): boolean;
  /**
   * Runs `write` only when `candidate` is the gate's current pair —
   * the stale-rejection belt's one shape: a dropped write returns
   * `undefined`, an accepted one returns the write's own result.
   */
  whileCurrent<T>(candidate: SessionRef | null | undefined, write: () => T): T | undefined;
  /**
   * Moves the gate's current notion. The reset moves it to `null`
   * (closed): after that no candidate passes and `isCurrent()` is
   * false until a fresh gate is minted for the next session.
   */
  move(ref: SessionRef | null): void;
}

/** Mints one gate at `ref` — the provider creates one per session adoption. */
export function createSessionGate(ref: SessionRef): SessionGate {
  let current: SessionRef | null = ref;
  return {
    ref,
    isCurrent: (candidate) =>
      candidate === undefined ? current !== null : sameSessionPair(candidate, current),
    whileCurrent: (candidate, write) => (sameSessionPair(candidate, current) ? write() : undefined),
    move: (next) => {
      current = next;
    },
  };
}
