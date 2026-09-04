import { create } from 'zustand';
import type { ActiveEntryView } from '../../../presentation/types.ts';
import { registerFeatureStoreReset } from '../../../state/feature-store-registry.ts';

/**
 * The navigation slice's feature-local UI store (#251, J1; ADR-0002:
 * "Server-derived data goes through TanStack Query … Shell-only UI
 * state goes zustand"): the open entry (selection state, not data) and
 * the last navigation attempt's feedback. Feature-local by the
 * checklist — the one cross-vertical slot (`activeEntry` in the shell's
 * app store) is mirrored by the navigation hook at the same gesture —
 * and registered with the shell's commit-time reset registry (#372,
 * ruled 2026-09-04): the ordered clear-stores step drops the highlight
 * and the feedback, so a same-document session switch cannot show the
 * dead session's open entry, exactly like the queries'
 * generation-scoped cache beside it.
 */

/** The last entry-open gesture's outcome — the panel's feedback surface. */
export type NavigationFeedback =
  | { readonly kind: 'none' }
  | { readonly kind: 'no-route'; readonly entryId: string }
  | { readonly kind: 'canvas-unavailable' }
  | { readonly kind: 'navigated'; readonly entryId: string; readonly url: string };

interface ContentNavigationState {
  /** The entry whose row highlights — selection state, never server data. */
  activeEntry: ActiveEntryView | null;
  feedback: NavigationFeedback;
  setActiveEntry(active: ActiveEntryView): void;
  reportNoRoute(entryId: string): void;
  reportCanvasUnavailable(): void;
  reportNavigated(entryId: string, url: string): void;
  /** The commit-time reset's clear — no open entry, no stale feedback. */
  reset(): void;
}

export const useContentNavigationStore = create<ContentNavigationState>((set) => ({
  activeEntry: null,
  feedback: { kind: 'none' },
  setActiveEntry: (activeEntry) => set({ activeEntry, feedback: { kind: 'none' } }),
  reportNoRoute: (entryId) => set({ feedback: { kind: 'no-route', entryId } }),
  reportCanvasUnavailable: () => set({ feedback: { kind: 'canvas-unavailable' } }),
  reportNavigated: (entryId, url) => set({ feedback: { kind: 'navigated', entryId, url } }),
  reset: () => set({ activeEntry: null, feedback: { kind: 'none' } }),
}));

// The #372 registration: module scope, beside the store's creation —
// the sequencer's clear-stores step clears this store at every commit.
registerFeatureStoreReset('content:navigation', () => useContentNavigationStore.getState().reset());
