import { create } from 'zustand';
import { registerFeatureStoreReset } from '../../../state/feature-store-registry.ts';

/**
 * The discovery panel's feature-local UI store (#251, J1): the entry
 * tree's collapsed-folder set — presentation-only state (ADR-0002 prop
 * class 4), keyed by the tree's collection-scoped folder paths. The
 * panel rehydrates it per document, and the store is registered with
 * the shell's commit-time reset registry (#372, ruled 2026-09-04): the
 * ordered clear-stores step empties it, so a same-document session
 * switch cannot inherit the dead session's collapsed folders — the set
 * dies with the session by the sequencer's hand, exactly like the
 * generation-scoped query cache beside it.
 */

interface DiscoveryUiState {
  /** Tree folders rendered collapsed, keyed by collection-scoped path (`blog/2024`). */
  collapsedFolders: ReadonlySet<string>;
  toggleFolder(key: string): void;
  /** The commit-time reset's clear — an empty collapsed set. */
  reset(): void;
}

export const useDiscoveryStore = create<DiscoveryUiState>((set) => ({
  collapsedFolders: new Set<string>(),
  toggleFolder: (key) =>
    set((state) => {
      const next = new Set(state.collapsedFolders);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { collapsedFolders: next };
    }),
  reset: () => set({ collapsedFolders: new Set<string>() }),
}));

// The #372 registration: module scope, beside the store's creation —
// the sequencer's clear-stores step clears this store at every commit.
registerFeatureStoreReset('content:discovery', () => useDiscoveryStore.getState().reset());
