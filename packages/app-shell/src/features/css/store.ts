import { create } from 'zustand';
import type { ServedRevision } from './inspection/freshness.ts';

/**
 * The CSS panel's feature-local store (#249, I1; the Content vertical's
 * `discovery-store.ts` discipline, J1 #251 — the #372 ruling is open,
 * so the landed precedent governs): presentation-only state plus the
 * freshness belt's memory, nothing else. A session change is a
 * top-level replacement (the one ordered reset navigates the document),
 * so this state dies with the document exactly like the
 * generation-scoped query cache beside it — no registration into the
 * shell reset's clearing list is needed or wanted.
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
}));
