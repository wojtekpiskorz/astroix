import { create } from 'zustand';

/**
 * The discovery panel's feature-local UI store (#251, J1): the entry
 * tree's collapsed-folder set — presentation-only state (ADR-0002 prop
 * class 4), keyed by the tree's collection-scoped folder paths. The
 * panel rehydrates it per document; a session change is a top-level
 * replacement (the reset), so the set dies with the document exactly
 * like the generation-scoped query cache beside it.
 */

interface DiscoveryUiState {
  /** Tree folders rendered collapsed, keyed by collection-scoped path (`blog/2024`). */
  collapsedFolders: ReadonlySet<string>;
  toggleFolder(key: string): void;
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
}));
