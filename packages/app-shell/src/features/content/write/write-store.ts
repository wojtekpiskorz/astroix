import { create } from 'zustand';
import { registerFeatureStoreReset } from '../../../state/feature-store-registry.ts';
import {
  IDLE_WRITE,
  reduceWrite,
  type WriteLoopEvent,
  type WriteLoopState,
} from './write-state.ts';

/**
 * The write loop's feature-local store (#253, J3): the pure reducer plus
 * the dispatch sequence's mint — a counter that is strictly monotonic
 * for the store's whole lifetime, so a post-reset dispatch can never
 * collide with a pre-reset one's stale settles. Feature-local by
 * charter (the shared edit drain/fence seam is born at its SECOND
 * consumer, ADR-0002 amendment 5; the CSS vertical's write loop is the
 * other one): admission, sequencing, and conflict reporting here stay
 * Content-specific in vocabulary and shared only in law with the
 * runtime's own fence (the server's serialized queue).
 *
 * Registered with the shell's commit-time reset registry (#372, ruled
 * 2026-09-04): the ordered clear-stores step runs the reducer's own
 * unconditional `reset` event — the machine goes quiet ("session
 * teardown" is that event's documented case) while the MINT survives
 * (its monotonic law outlives the session: a post-reset dispatch mints
 * strictly past every pre-reset one).
 */

interface WriteStoreState {
  /** The machine's state. */
  readonly write: WriteLoopState;
  /** The monotonic mint — never reset, never reused. */
  seqMint: number;
  /** Mints the next dispatch sequence. */
  nextSeq(): number;
  /** Applies one event to the machine (the reducer's sequence guard decides). */
  dispatch(event: WriteLoopEvent): void;
  /**
   * The commit-time reset's clear — the machine through its own reset
   * event; the mint is NEVER reset (its law outlives the session).
   */
  reset(): void;
}

export const useContentWriteStore = create<WriteStoreState>((set) => ({
  write: IDLE_WRITE,
  seqMint: 0,
  nextSeq: () => {
    let minted = 0;
    set((state) => {
      minted = state.seqMint + 1;
      return { seqMint: minted };
    });
    return minted;
  },
  dispatch: (event) => set((state) => ({ write: reduceWrite(state.write, event) })),
  reset: () => set((state) => ({ write: reduceWrite(state.write, { type: 'reset' }) })),
}));

// The #372 registration: module scope, beside the store's creation —
// the sequencer's clear-stores step clears this store at every commit.
registerFeatureStoreReset('content:write', () => useContentWriteStore.getState().reset());
