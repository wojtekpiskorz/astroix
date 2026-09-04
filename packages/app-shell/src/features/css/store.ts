import { create } from 'zustand';
import { registerFeatureStoreReset } from '../../state/feature-store-registry.ts';
import type { ServedRevision } from './inspection/freshness.ts';

/**
 * The CSS panel's feature-local store (#249, I1; the Content vertical's
 * `discovery-store.ts` discipline, J1 #251): presentation-only state plus the
 * freshness belt's memory, nothing else. Registered with the shell's
 * commit-time reset registry (#372, ruled 2026-09-04 — supersedes I1's
 * landed "dies with the document" precedent): the ordered clear-stores
 * step drops the open row and the belt's memory, so a same-document
 * session switch cannot inherit the dead session's inspection state —
 * exactly like the generation-scoped query cache beside it.
 */

interface CssInspectionState {
  /** The read-only detail's open row, by row key — `null` when collapsed. */
  openRowKey: string | null;
  /**
   * The freshness belt's memory: the highest styles revision served for
   * the current route (the stale-revision rejection law's caller side).
   */
  served: ServedRevision | null;
  /** Opens one row's read-only detail (replacing any open one). */
  openRow(key: string): void;
  closeRow(): void;
  /**
   * Notes a served payload — accepted only when it advances the belt
   * (a strictly lower revision for the same route is the stale answer
   * the caller rejects). A different route resets the belt to it.
   */
  noteServed(route: string, revision: number): void;
  /** The commit-time reset's clear — no open row, no belt memory. */
  reset(): void;
}

export const useCssInspectionStore = create<CssInspectionState>((set) => ({
  openRowKey: null,
  served: null,
  openRow: (key) => set({ openRowKey: key }),
  closeRow: () => set({ openRowKey: null }),
  noteServed: (route, revision) =>
    set((state) => {
      if (state.served !== null && state.served.route === route) {
        if (revision <= state.served.revision) return state;
        return { served: { route, revision } };
      }
      return { served: { route, revision } };
    }),
  reset: () => set({ openRowKey: null, served: null }),
}));

// The #372 registration: module scope, beside the store's creation —
// the sequencer's clear-stores step clears this store at every commit.
registerFeatureStoreReset('css:inspection', () => useCssInspectionStore.getState().reset());
