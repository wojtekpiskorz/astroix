import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  IDLE_WRITE,
  reduceWrite,
  type WriteLoopEvent,
  type WriteLoopState,
} from './write-loop-state.ts';

/**
 * The seam's write-loop store factory (ADR-0002 amendment 5): the pure
 * reducer plus the dispatch sequence's mint — a counter that is strictly
 * monotonic for the STORE's whole lifetime, so a post-reset dispatch can
 * never collide with a pre-reset one's stale settles. One instance per
 * consuming feature loop (Content's serializer loop, CSS's splice
 * loop): each feature creates its own store through this factory and
 * keeps it feature-local, never shared — the MACHINE is the shared
 * truth, the instance is the loop's.
 */

/** One feature write loop's store — the machine plus its mint. */
export interface WriteLoopStoreState {
  /** The machine's state. */
  readonly write: WriteLoopState;
  /** The monotonic mint — never reset, never reused. */
  seqMint: number;
  /** Mints the next dispatch sequence. */
  nextSeq(): number;
  /** Applies one event to the machine (the reducer's sequence guard decides). */
  dispatch(event: WriteLoopEvent): void;
  /**
   * The commit-time reset's clear (#372's registration law): the
   * machine through its own unconditional `reset` event — it goes
   * quiet ("session teardown" is that event's documented case) while
   * the MINT survives (its monotonic law outlives the session: a
   * post-reset dispatch mints strictly past every pre-reset one).
   */
  reset(): void;
}

export type UseWriteLoopStore = UseBoundStore<StoreApi<WriteLoopStoreState>>;

/** Creates one feature's write-loop store — the seam's own mint discipline. */
export function createWriteLoopStore(): UseWriteLoopStore {
  return create<WriteLoopStoreState>((set) => ({
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
}
