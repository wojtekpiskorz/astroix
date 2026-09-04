import { create } from 'zustand';
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
}));
